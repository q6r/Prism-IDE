//! Per-profile reads for the accounts screen and the model picker: limits and
//! plan (`details`), the model catalog (`models`), the `/` menu
//! (`commands`), the login status (`status`) and the CLI's version
//! (`available`), cached like the Electron app cached them.
//!
//! Ports, one to one: `profileUsage` and `claudeRateLimitTier`
//! (src/main/providerUsage.ts), `claudeDetails` and `claudePlanLabel`
//! (src/shared/providerUsage.ts), `claudeModels` (src/main/ipc/agentModels.ts)
//! with `claudeModelLabel` (src/shared/modelLabels.ts), `claudeCommands` and
//! `claudeSkillNames` (src/main/ipc/agentCommands.ts), and the
//! `providers:status` handler (src/main/ipc/providers.ts) with
//! `unprobedStatus` (src/main/ipc/providerProfiles.ts).
//!
//! Codex reads are `CodexQueries`' (converted and cached there). Claude's come
//! raw from the CLI's control protocol (`ClaudeAgents::catalog`) and are
//! converted and cached here. Inputs are raw JSON on purpose: like the
//! TypeScript, a field of the wrong type is skipped, never fatal.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use prism_agents::claude::{Catalog, ClaudeAgents, version};
use prism_agents::codex::convert::{js_string, num};
use prism_agents::codex::queries::{CATALOG_TTL, DETAILS_ERROR, DETAILS_ERROR_TTL, DETAILS_TTL};
use prism_agents::codex::{BoxFuture, CodexError, CodexErrorKind, CodexQueries};
use prism_agents::profile_env::{self, LinkState, ProfileEnv, ProfileError, ProfileErrorKind, Profiles, Provider, ProviderCommand};
use prism_protocol::providers::{AgentCommand, AgentCommandKind, CliAvailability};
use prism_protocol::{ErrorCode, HostError};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::io::AsyncReadExt;
use tokio::sync::watch;

const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
const VERSION_TIMEOUT: Duration = Duration::from_secs(6);

pub const BROKEN_LINK_STATUS: &str = "Conta vinculada ao Traycer indisponível: reative-a no Traycer ou desvincule.";
const INVALID_PROVIDER: &str = "Agente inválido.";
const MODELS_CLI_MISSING: &str = "Instale o Claude Code para consultar seus modelos.";
const COMMANDS_CLI_MISSING: &str = "Instale o Claude Code para consultar seus comandos.";
/// No `ClaudeAgents` on this host (`PRISM_CLAUDE_ENGINE=sdk`).
const CLAUDE_OFF: &str = "O Claude Code não está disponível neste host.";
const BAD_REPLY: &str = "O Claude Code respondeu num formato inesperado.";

/// What a CLI run printed; `code` is None when it could not start, was
/// killed or ran out of time.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Ran {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Finds and runs the provider CLIs for `status`, `available` and the
/// "is Claude installed" check. Tests swap in canned answers.
trait Cli: Send + Sync + 'static {
    /// The CLI a profile runs (None: the terminal account's), when installed.
    fn command<'a>(&'a self, provider: Provider, profile_id: Option<&'a str>) -> BoxFuture<'a, Option<ProviderCommand>>;
    /// Runs it once with `args` and the profile's environment, within `limit`.
    fn run(&self, command: ProviderCommand, args: Vec<String>, env: ProfileEnv, limit: Duration) -> BoxFuture<'_, Ran>;
}

/// The real one: `Profiles::command`, and a process tree per run.
struct ProcessCli {
    profiles: Profiles,
}

impl Cli for ProcessCli {
    fn command<'a>(&'a self, provider: Provider, profile_id: Option<&'a str>) -> BoxFuture<'a, Option<ProviderCommand>> {
        Box::pin(self.profiles.command(provider, profile_id))
    }

    fn run(&self, command: ProviderCommand, args: Vec<String>, env: ProfileEnv, limit: Duration) -> BoxFuture<'_, Ran> {
        Box::pin(run_cli(command, args, env, limit))
    }
}

async fn run_cli(command: ProviderCommand, args: Vec<String>, env: ProfileEnv, limit: Duration) -> Ran {
    let mut process = command.to_command();
    process.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    env.apply(&mut process);
    // Whatever is left of the tree goes when this returns, finished or not.
    let Ok(tree) = prism_proc::ProcessTree::new() else { return Ran::default() };
    let Ok(mut child) = tree.spawn(&mut process) else { return Ran::default() };
    let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else { return Ran::default() };
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let status = tokio::time::timeout(limit, async {
        let (_, _, status) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err), child.wait());
        status
    })
    .await;
    let code = match status {
        Ok(Ok(status)) => status.code(),
        _ => None,
    };
    Ran { code, stdout: String::from_utf8_lossy(&out).into_owned(), stderr: String::from_utf8_lossy(&err).into_owned() }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

type Shared = watch::Receiver<Option<Result<Value, HostError>>>;

enum Slot {
    Ready(Instant, Value),
    Pending(u64, Shared),
}

type Slots = Mutex<HashMap<String, (String, Slot)>>;

/// Reads cached per key for a while, each tagged with its profile.
/// Concurrent callers share one read, `refresh` starts a new one, and a
/// failure is not kept.
#[derive(Default)]
struct Memo {
    slots: Slots,
    generation: AtomicU64,
}

/// A read in flight. Dropped before it settles (its caller went away), it
/// frees the key so the next caller reads again.
struct Claim<'a> {
    slots: &'a Slots,
    key: &'a str,
    generation: u64,
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        let mut slots = lock(self.slots);
        if matches!(slots.get(self.key), Some((_, Slot::Pending(g, _))) if *g == self.generation) {
            slots.remove(self.key);
        }
    }
}

impl Memo {
    async fn get(&self, key: String, profile: &str, ttl: Duration, refresh: bool, read: impl Future<Output = Result<Value, HostError>>) -> Result<Value, HostError> {
        // One lock decides between the kept value, the read in flight and a
        // read of our own, so two first callers never start two CLIs.
        let (generation, tx) = loop {
            let mut waiting = {
                let mut slots = lock(&self.slots);
                match slots.get(&key) {
                    Some((_, Slot::Ready(expires, value))) if !refresh && *expires > Instant::now() => return Ok(value.clone()),
                    Some((_, Slot::Pending(_, rx))) if !refresh => rx.clone(),
                    _ => {
                        let generation = self.generation.fetch_add(1, Ordering::Relaxed);
                        let (tx, rx) = watch::channel(None);
                        slots.insert(key.clone(), (profile.to_string(), Slot::Pending(generation, rx)));
                        break (generation, tx);
                    }
                }
            };
            if let Ok(result) = waiting.wait_for(Option::is_some).await
                && let Some(result) = result.clone()
            {
                return result;
            }
            // Its reader went away (its claim freed the key): decide again.
        };
        let claim = Claim { slots: &self.slots, key: &key, generation };
        let result = read.await;
        if let Ok(value) = &result {
            let mut slots = lock(&self.slots);
            // A refresh or `forget` meanwhile wins: this read is not kept.
            if matches!(slots.get(&key), Some((_, Slot::Pending(g, _))) if *g == generation) {
                slots.insert(key.clone(), (profile.to_string(), Slot::Ready(Instant::now() + ttl, value.clone())));
            }
        }
        drop(claim);
        let _ = tx.send(Some(result.clone()));
        result
    }

    fn forget(&self, profile: &str) {
        lock(&self.slots).retain(|_, (owner, _)| owner != profile);
    }
}

/// Claude's last limits reading for a profile, and the read in flight.
#[derive(Default)]
struct DetailsEntry {
    expires: Option<Instant>,
    value: Option<Value>,
    pending: Option<watch::Receiver<Option<Value>>>,
}

type DetailsMap = Mutex<HashMap<String, DetailsEntry>>;

/// A limits read in flight; dropped before it settles, it lets the next caller read.
struct DetailsClaim<'a> {
    details: &'a DetailsMap,
    profile: &'a str,
    mine: watch::Receiver<Option<Value>>,
}

impl Drop for DetailsClaim<'_> {
    fn drop(&mut self) {
        let mut details = lock(self.details);
        if let Some(entry) = details.get_mut(self.profile)
            && entry.pending.as_ref().is_some_and(|p| p.same_channel(&self.mine))
        {
            entry.pending = None;
        }
    }
}

/// The catalog reads of every profile, Claude's and Codex's.
pub struct Catalogs {
    profiles: Profiles,
    claude: Option<ClaudeAgents>,
    codex: Arc<CodexQueries>,
    cli: Arc<dyn Cli>,
    /// The OS user's home: `~/.claude/skills`, and `~/.claude` for the terminal login.
    home: PathBuf,
    models: Memo,
    commands: Memo,
    details: DetailsMap,
}

impl Catalogs {
    /// `claude` is None when the host does not run Claude Code (`PRISM_CLAUDE_ENGINE=sdk`).
    pub fn new(profiles: Profiles, claude: Option<ClaudeAgents>, codex: Arc<CodexQueries>) -> Arc<Self> {
        let cli = Arc::new(ProcessCli { profiles: profiles.clone() });
        Self::build(profiles, claude, codex, cli, profile_env::home_dir())
    }

    fn build(profiles: Profiles, claude: Option<ClaudeAgents>, codex: Arc<CodexQueries>, cli: Arc<dyn Cli>, home: PathBuf) -> Arc<Self> {
        Arc::new(Self { profiles, claude, codex, cli, home, models: Memo::default(), commands: Memo::default(), details: Mutex::new(HashMap::new()) })
    }

    /// Limits, plan and resets (`ProfileDetails`). The profile is validated
    /// even when cached; a failed read keeps the last good one, marked stale.
    /// Cached 1 min (30 s after a failure).
    pub async fn details(&self, provider: &str, profile_id: &str, refresh: bool) -> Result<Value, HostError> {
        match parse_provider(provider)? {
            Provider::Codex => self.codex.details(profile_id, refresh).await.map_err(codex_error),
            Provider::Claude => self.claude_details(profile_id, refresh).await,
        }
    }

    /// The model picker's rows (`AgentModel[]`), in the CLI's order. Cached 5 min.
    pub async fn models(&self, provider: &str, profile_id: &str, refresh: bool) -> Result<Value, HostError> {
        match parse_provider(provider)? {
            Provider::Codex => self.codex.models(profile_id, refresh).await.map_err(codex_error),
            Provider::Claude => self.models.get(format!("claude:{profile_id}"), profile_id, CATALOG_TTL, refresh, self.read_claude_models(profile_id)).await,
        }
    }

    /// The `/` menu (`AgentCommand[]`) of an account in a folder. Cached 5 min.
    pub async fn commands(&self, provider: &str, profile_id: &str, cwd: &str, refresh: bool) -> Result<Value, HostError> {
        match parse_provider(provider)? {
            Provider::Codex => self.codex.skills(profile_id, cwd, refresh).await.map_err(codex_error),
            Provider::Claude => {
                let key = json!(["claude", profile_id, cwd]).to_string();
                self.commands.get(key, profile_id, CATALOG_TTL, refresh, self.read_claude_commands(profile_id, cwd)).await
            }
        }
    }

    /// Is the CLI installed, is the account logged in (`ProfileStatus`)?
    pub async fn status(&self, provider: &str, profile_id: &str) -> Result<Value, HostError> {
        let provider = parse_provider(provider)?;
        let (profiles, id) = (self.profiles.clone(), profile_id.to_string());
        let (profile, link) = blocking(move || {
            let profile = profiles.get(provider, &id)?;
            let link = profile_env::link_state(&profile);
            Ok((profile, link))
        })
        .await?;
        let command = self.cli.command(provider, Some(profile_id)).await;
        // Disabled, or a broken link (never probed: that would fall back to the profile's own stale copy).
        if let Some(answered) = unprobed_status(profile.enabled != Some(false), link, command.is_some()) {
            return Ok(answered);
        }
        let env = self.environment(provider, profile_id).await?;
        let Some(command) = command else {
            return Ok(json!({ "installed": false, "loggedIn": false, "detail": format!("{} não instalado.", cli_name(provider)) }));
        };
        let mut args: Vec<String> = match provider {
            Provider::Claude => vec!["auth".into(), "status".into()],
            Provider::Codex => vec!["login".into(), "status".into()],
        };
        if provider == Provider::Codex && !profile.ambient {
            args.extend(["-c".into(), "cli_auth_credentials_store=\"file\"".into()]);
        }
        let ran = self.cli.run(command, args, env, STATUS_TIMEOUT).await;
        Ok(probed_status(provider, link == LinkState::Linked, &ran))
    }

    /// The CLI the terminal account runs (the terminal's own, or Traycer's
    /// bundled one when newer) and its version (`CliAvailability`);
    /// `verified` and `warning` for Claude only. Looked up afresh every time,
    /// as the app did: a CLI just installed shows at once.
    pub async fn available(&self, provider: &str) -> Result<Value, HostError> {
        let provider = parse_provider(provider)?;
        self.profiles.forget_terminal(provider);
        if provider == Provider::Claude
            && let Some(agents) = &self.claude
        {
            return Ok(agents.available().await);
        }
        let unavailable = CliAvailability { available: false, version: String::new(), verified: None, warning: None };
        let Some(command) = self.cli.command(provider, None).await else { return Ok(json!(unavailable)) };
        let ran = self.cli.run(command, vec!["--version".into()], ProfileEnv::default(), VERSION_TIMEOUT).await;
        if ran.code != Some(0) {
            return Ok(json!(unavailable));
        }
        let output = ran.stdout.trim().to_string();
        let verified = (provider == Provider::Claude).then(|| version::parse(&output).is_some_and(|v| version::verified(&v)));
        let warning = (verified == Some(false)).then(|| version::UNVERIFIED_WARNING.to_string());
        Ok(json!(CliAvailability { available: true, version: output, verified, warning }))
    }

    /// Drops everything cached for a profile (its login or settings changed).
    pub fn forget(&self, profile_id: &str) {
        self.models.forget(profile_id);
        self.commands.forget(profile_id);
        lock(&self.details).remove(profile_id);
        self.codex.forget(profile_id);
    }

    async fn environment(&self, provider: Provider, profile_id: &str) -> Result<ProfileEnv, HostError> {
        let (profiles, id) = (self.profiles.clone(), profile_id.to_string());
        blocking(move || profiles.environment(provider, Some(&id))).await
    }

    /// One raw Claude metadata read, after the profile and the CLI check out.
    async fn claude_catalog(&self, kind: Catalog, profile_id: &str, cwd: Option<&str>, missing: &str) -> Result<Value, HostError> {
        let agents = self.claude.as_ref().ok_or_else(|| HostError::new(ErrorCode::Internal, CLAUDE_OFF))?;
        // As agentModels/agentCommands: a missing CLI is said first, then the profile's refusal.
        if self.cli.command(Provider::Claude, Some(profile_id)).await.is_none() {
            return Err(HostError::new(ErrorCode::CliMissing, missing));
        }
        self.environment(Provider::Claude, profile_id).await?;
        agents.catalog(kind, Some(profile_id.to_string()), cwd.map(str::to_string)).await.map_err(|message| HostError::new(ErrorCode::Internal, message))
    }

    async fn read_claude_models(&self, profile_id: &str) -> Result<Value, HostError> {
        let rows = self.claude_catalog(Catalog::Models, profile_id, None, MODELS_CLI_MISSING).await?;
        let rows = rows.as_array().ok_or_else(bad_reply)?;
        Ok(Value::Array(claude_models(rows)))
    }

    async fn read_claude_commands(&self, profile_id: &str, cwd: &str) -> Result<Value, HostError> {
        let (home, folder) = (self.home.clone(), cwd.to_string());
        let (rows, skills) = tokio::join!(
            self.claude_catalog(Catalog::Commands, profile_id, Some(cwd), COMMANDS_CLI_MISSING),
            tokio::task::spawn_blocking(move || claude_skill_names(&home, &folder)),
        );
        let rows = rows?;
        let rows = rows.as_array().ok_or_else(bad_reply)?;
        Ok(json!(claude_commands(rows, &skills.unwrap_or_default())))
    }

    async fn claude_details(&self, profile_id: &str, refresh: bool) -> Result<Value, HostError> {
        // Validate routing and enabled state even when a cached snapshot exists.
        self.environment(Provider::Claude, profile_id).await?;
        let (tx, previous) = loop {
            let pending = {
                let mut details = lock(&self.details);
                let entry = details.entry(profile_id.to_string()).or_default();
                match (&entry.pending, &entry.value, entry.expires) {
                    (Some(pending), _, _) => pending.clone(),
                    (None, Some(value), Some(expires)) if !refresh && expires > Instant::now() => return Ok(value.clone()),
                    _ => {
                        let (tx, rx) = watch::channel(None);
                        entry.pending = Some(rx);
                        entry.expires = None;
                        break (tx, entry.value.clone());
                    }
                }
            };
            let mut pending = pending;
            if let Ok(value) = pending.wait_for(Option::is_some).await
                && let Some(value) = value.clone()
            {
                return Ok(value);
            }
            // Its reader went away (and cleared it): read here instead.
        };
        let claim = DetailsClaim { details: &self.details, profile: profile_id, mine: tx.subscribe() };
        let value = match self.read_claude_usage(profile_id).await {
            Ok(value) => value,
            Err(message) => {
                tracing::debug!(error = %message, "leitura dos limites do Claude falhou");
                let mut fallback = previous.clone().filter(Value::is_object).unwrap_or_else(|| json!({ "limits": [] }));
                fallback["stale"] = json!(previous.is_some());
                fallback["error"] = json!(DETAILS_ERROR);
                fallback
            }
        };
        let ttl = if value.get("error").is_some() { DETAILS_ERROR_TTL } else { DETAILS_TTL };
        {
            // A login or `forget` that dropped the entry meanwhile wins: this read is not kept.
            let mut details = lock(&self.details);
            if let Some(entry) = details.get_mut(profile_id)
                && entry.pending.as_ref().is_some_and(|p| p.same_channel(&claim.mine))
            {
                entry.value = Some(value.clone());
                entry.expires = Some(Instant::now() + ttl);
                entry.pending = None;
            }
        }
        drop(claim);
        let _ = tx.send(Some(value.clone()));
        Ok(value)
    }

    async fn read_claude_usage(&self, profile_id: &str) -> Result<Value, String> {
        let agents = self.claude.as_ref().ok_or(CLAUDE_OFF)?;
        let mut read = agents.catalog(Catalog::Usage, Some(profile_id.to_string()), None).await?;
        // Traycer's second attempt: a cold account directory can answer before its
        // login has loaded, which reads exactly like an account without a plan.
        if !truthy(read.pointer("/usage/rate_limits_available")) {
            read = agents.catalog(Catalog::Usage, Some(profile_id.to_string()), None).await?;
        }
        let usage = read.get("usage").filter(|u| u.is_object()).ok_or(BAD_REPLY)?;
        let account = read.get("account").filter(|a| a.is_object());
        let field = |key: &str| account.and_then(|a| a.get(key)).and_then(Value::as_str).filter(|s| !s.is_empty());
        let tier = self.rate_limit_tier(profile_id).await;
        Ok(claude_details(usage, field("email"), field("subscriptionType"), tier.as_deref(), now_ms()))
    }

    /// Which Max plan the OAuth login is ("default_claude_max_20x"): only
    /// that field is deserialized, the tokens beside it are skipped by the
    /// parser and never returned, logged or kept. Missing file or field (a
    /// keychain login) → None.
    async fn rate_limit_tier(&self, profile_id: &str) -> Option<String> {
        let (profiles, id, home) = (self.profiles.clone(), profile_id.to_string(), self.home.clone());
        tokio::task::spawn_blocking(move || {
            let env = profiles.environment(Provider::Claude, Some(&id)).ok()?;
            let dir = env.get("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".claude"));
            read_rate_limit_tier(&dir.join(".credentials.json"))
        })
        .await
        .ok()
        .flatten()
    }
}

#[derive(Deserialize)]
struct Login {
    #[serde(rename = "claudeAiOauth")]
    oauth: Option<OAuth>,
}

#[derive(Deserialize)]
struct OAuth {
    #[serde(rename = "rateLimitTier")]
    tier: Option<Value>,
}

/// `claudeAiOauth.rateLimitTier` of a login file, when it is `/^[a-z0-9_]{1,64}$/i`.
fn read_rate_limit_tier(file: &Path) -> Option<String> {
    let bytes = std::fs::read(file).ok()?;
    let login: Login = serde_json::from_slice(&bytes).ok()?;
    drop(bytes);
    let tier = login.oauth?.tier?;
    let tier = tier.as_str()?;
    ((1..=64).contains(&tier.len()) && tier.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')).then(|| tier.to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, ProfileError> + Send + 'static) -> Result<T, HostError> {
    tokio::task::spawn_blocking(f).await.map_err(|err| HostError::new(ErrorCode::Internal, err.to_string()))?.map_err(profile_error)
}

fn parse_provider(provider: &str) -> Result<Provider, HostError> {
    match provider {
        "claude" => Ok(Provider::Claude),
        "codex" => Ok(Provider::Codex),
        _ => Err(HostError::new(ErrorCode::Invalid, INVALID_PROVIDER)),
    }
}

fn profile_error(err: ProfileError) -> HostError {
    let code = match err.kind {
        ProfileErrorKind::NotFound => ErrorCode::NotFound,
        ProfileErrorKind::Disabled => ErrorCode::Invalid,
        ProfileErrorKind::BrokenLink => ErrorCode::CliAuth,
        ProfileErrorKind::Unreadable => ErrorCode::Internal,
    };
    HostError::new(code, err.message)
}

fn codex_error(err: CodexError) -> HostError {
    let code = match err.kind {
        CodexErrorKind::Invalid => ErrorCode::Invalid,
        CodexErrorKind::NotFound => ErrorCode::NotFound,
        CodexErrorKind::Busy => ErrorCode::Busy,
        CodexErrorKind::CliMissing => ErrorCode::CliMissing,
        CodexErrorKind::CliAuth => ErrorCode::CliAuth,
        CodexErrorKind::Failed => ErrorCode::Internal,
    };
    HostError::new(code, err.message)
}

fn bad_reply() -> HostError {
    HostError::new(ErrorCode::Internal, BAD_REPLY)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn cli_name(provider: Provider) -> &'static str {
    match provider {
        Provider::Claude => "Claude Code",
        Provider::Codex => "Codex",
    }
}

/* ---------------- Status ---------------- */

/// The status answered without running the CLI, or None when it must be
/// probed: a disabled profile, or a Traycer link that no longer resolves.
fn unprobed_status(enabled: bool, link: LinkState, installed: bool) -> Option<Value> {
    if !enabled {
        return Some(json!({ "installed": installed, "loggedIn": false, "detail": "Desativada" }));
    }
    if link == LinkState::Broken {
        return Some(json!({ "installed": installed, "loggedIn": false, "detail": BROKEN_LINK_STATUS }));
    }
    None
}

/// `claude auth status` (JSON) or `codex login status` (the exit code) as a `ProfileStatus`.
fn probed_status(provider: Provider, via_traycer: bool, ran: &Ran) -> Value {
    let mut logged_in = ran.code == Some(0);
    let (mut email, mut tier) = (None, None);
    if provider == Provider::Claude {
        let out = format!("{}{}", ran.stdout, ran.stderr);
        match serde_json::from_str::<Value>(&out) {
            Ok(Value::Null) | Err(_) => {
                let lower = out.to_ascii_lowercase();
                logged_in = ran.code == Some(0) && (lower.contains("logged in") || lower.contains("authenticated"));
            }
            Ok(auth) => {
                logged_in = auth.get("loggedIn") == Some(&Value::Bool(true));
                email = auth.get("email").cloned();
                tier = auth.get("subscriptionType").cloned();
            }
        }
    }
    let detail = match (via_traycer, logged_in) {
        (true, true) => "Conectada pelo login do Traycer",
        (true, false) => "Entre nesta conta pelo Traycer.",
        (false, true) => "Conectada",
        (false, false) => "Faça login nesta conta.",
    };
    let mut out = Map::new();
    out.insert("installed".into(), json!(true));
    out.insert("loggedIn".into(), json!(logged_in));
    if let Some(email) = email {
        out.insert("email".into(), email);
    }
    if let Some(tier) = tier {
        out.insert("tier".into(), tier);
    }
    out.insert("detail".into(), json!(detail));
    Value::Object(out)
}

/* ---------------- JS value helpers ---------------- */

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|f| f.is_finite())
}

/// JS `\s`: Unicode white space plus the BOM.
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars.as_str().to_lowercase().chars()).collect(),
        None => String::new(),
    }
}

/* ---------------- Limits and plan ---------------- */

/// The windows Traycer reads from the native usage response. Other keys are
/// provider codenames (credit grants, promotions, per-surface splits), not limits.
const CLAUDE_WINDOWS: [(&str, &str, Option<&str>, u32); 4] = [
    ("five_hour", "Sessão · 5h", None, 300),
    ("seven_day", "Todos os modelos · 7 dias", None, 10080),
    ("seven_day_opus", "Opus · 7 dias", Some("Opus"), 10080),
    ("seven_day_sonnet", "Sonnet · 7 dias", Some("Sonnet"), 10080),
];

/// `v.toLowerCase().replace(/[\s_-]+/g, '')`
fn squash(v: &str) -> String {
    v.to_lowercase().chars().filter(|c| !(js_space(*c) || *c == '_' || *c == '-')).collect()
}

fn title_case(v: &str) -> String {
    v.split(|c: char| js_space(c) || c == '_' || c == '-').filter(|w| !w.is_empty()).map(capitalize).collect::<Vec<_>>().join(" ")
}

/// "max" → "Max", "claude_max_20x"-style tiers → "Max 20x"; unknown tokens are title-cased.
fn claude_plan_name(raw: &str) -> String {
    match squash(raw).as_str() {
        "claudemaxsubscription" | "claudemax" | "max" | "maxplan" => "Max".into(),
        "claudemax5xsubscription" | "max5" => "Max 5x".into(),
        "claudemax20xsubscription" | "max20" => "Max 20x".into(),
        "claudeenterprisesubscription" | "enterprise" => "Enterprise".into(),
        "claudeteamsubscription" | "team" => "Team".into(),
        "claudeprosubscription" | "claudepro" | "pro" => "Pro".into(),
        "claudefreesubscription" | "free" => "Free".into(),
        _ => title_case(raw),
    }
}

/// `name.replace(/\s*subscription$/i, '')`
fn strip_subscription(name: &str) -> &str {
    let n = name.len();
    if n >= 12 && name.is_char_boundary(n - 12) && name[n - 12..].eq_ignore_ascii_case("subscription") {
        name[..n - 12].trim_end_matches(js_space)
    } else {
        name
    }
}

/// Traycer's Claude identity tier in Prism's words ("Assinatura Claude Max
/// 20x"). The OAuth login's `rateLimitTier` says which Max it is.
fn claude_plan_label(subscription_type: Option<&str>, rate_limit_tier: Option<&str>) -> Option<String> {
    let raw = js_trim(subscription_type?);
    if raw.is_empty() {
        return None;
    }
    let mut name = claude_plan_name(raw);
    if name == "Max"
        && let Some(tier) = rate_limit_tier.filter(|t| !t.is_empty())
    {
        let tier = tier.to_ascii_lowercase();
        if tier.contains("max20x") || tier.contains("max_20x") {
            name = "Max 20x".into();
        } else if tier.contains("max5x") || tier.contains("max_5x") {
            name = "Max 5x".into();
        }
    }
    let product = strip_subscription(&name);
    Some(if squash(product).starts_with("claude") { format!("Assinatura {product}") } else { format!("Assinatura Claude {product}") })
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `Date.parse` in ms for the ISO 8601 times the CLI sends
/// ("2026-10-09T19:10:00.008710+00:00"; extra fraction digits are cut, as V8
/// does). A date alone is UTC midnight. None where JS reads NaN, and for a
/// date-time without an offset (local time in JS), which the CLI never sends.
fn iso_millis(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let n = |from: usize, len: usize| -> Option<i64> {
        let digits = b.get(from..from + len)?;
        digits.iter().all(u8::is_ascii_digit).then(|| digits.iter().fold(0, |acc, d| acc * 10 + i64::from(d - b'0')))
    };
    let (year, month, day) = (n(0, 4)?, n(5, 2)?, n(8, 2)?);
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month, day);
    if b.len() == 10 {
        return Some(days * 86_400_000);
    }
    if !matches!(b.get(10), Some(b'T' | b't' | b' ')) || b.get(13) != Some(&b':') {
        return None;
    }
    let (hour, minute) = (n(11, 2)?, n(14, 2)?);
    let (mut at, mut second, mut millis) = (16, 0, 0);
    if b.get(at) == Some(&b':') {
        second = n(17, 2)?;
        at = 19;
        if b.get(at) == Some(&b'.') {
            let start = at + 1;
            at = start;
            while b.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
            if at == start {
                return None;
            }
            let digits = &b[start..at];
            millis = (0..3).map(|k| digits.get(k).map_or(0, |d| i64::from(d - b'0'))).fold(0, |acc, d| acc * 10 + d);
        }
    }
    if hour > 24 || minute > 59 || second > 59 || (hour == 24 && (minute | second | millis) != 0) {
        return None;
    }
    let offset = match b.get(at) {
        Some(b'Z' | b'z') if at + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) => {
            let hours = n(at + 1, 2)?;
            let (minutes, end) = if b.get(at + 3) == Some(&b':') { (n(at + 4, 2)?, at + 6) } else { (n(at + 3, 2)?, at + 5) };
            if end != b.len() || hours > 23 || minutes > 59 {
                return None;
            }
            if *sign == b'-' { -(hours * 60 + minutes) } else { hours * 60 + minutes }
        }
        _ => return None,
    };
    Some((((days * 24 + hour) * 60 + minute) * 60 + second) * 1000 + millis - offset * 60_000)
}

/// `Date.parse(v) / 1000` for a string, else None.
fn reset_at(value: Option<&Value>) -> Option<f64> {
    iso_millis(value?.as_str()?).map(|ms| ms as f64 / 1000.0)
}

fn claude_limit(id: String, label: String, name: Value, used: f64, resets: Option<f64>, minutes: u32) -> Value {
    let mut limit = Map::new();
    limit.insert("id".into(), json!(id));
    limit.insert("label".into(), json!(label));
    limit.insert("name".into(), name);
    limit.insert("usedPercent".into(), num(used));
    if let Some(resets) = resets {
        limit.insert("resetsAt".into(), num(resets));
    }
    limit.insert("windowMinutes".into(), json!(minutes));
    Value::Object(limit)
}

/// `get_usage`'s reply plus the init's account as `ProfileDetails`.
fn claude_details(data: &Value, email: Option<&str>, subscription_type: Option<&str>, rate_limit_tier: Option<&str>, now_ms: i64) -> Value {
    let available = truthy(data.get("rate_limits_available"));
    let r = data.get("rate_limits").filter(|r| truthy(Some(r)));
    let mut limits = Vec::new();
    if available && let Some(r) = r {
        for (id, label, name, minutes) in CLAUDE_WINDOWS {
            let Some(w) = r.get(id).filter(|w| truthy(Some(w))) else { continue };
            let Some(used) = finite(w.get("utilization")) else { continue };
            limits.push(claude_limit(id.into(), label.into(), name.map_or(Value::Null, Value::from), used, reset_at(w.get("resets_at")), minutes));
        }
        let scoped = r.get("model_scoped").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        for (i, w) in scoped.iter().enumerate() {
            let Some(used) = finite(w.get("utilization")) else { continue };
            let display = w.get("display_name");
            let label = format!("{} · 7 dias", display.map_or_else(|| "undefined".to_string(), js_string));
            let name = display.filter(|d| truthy(Some(d))).cloned().unwrap_or(Value::Null);
            limits.push(claude_limit(format!("model:{i}"), label, name, used, reset_at(w.get("resets_at")), 10080));
        }
    }
    let mut extras = Vec::new();
    if let Some(extra) = r.and_then(|r| r.get("extra_usage")).filter(|e| truthy(Some(e))) {
        extras.push(json!({ "label": "Uso extra", "value": if truthy(extra.get("is_enabled")) { "Ativado" } else { "Desativado" } }));
        // Native protocol amounts retain their original units; do not assume dollars.
        if finite(extra.get("monthly_limit")).is_some() {
            let currency = extra.get("currency").filter(|c| truthy(Some(c))).map(|c| format!(" {}", js_string(c))).unwrap_or_default();
            extras.push(json!({ "label": "Limite mensal de créditos", "value": format!("{}{currency}", js_string(&extra["monthly_limit"])) }));
        }
        if finite(extra.get("used_credits")).is_some() {
            extras.push(json!({ "label": "Créditos utilizados", "value": js_string(&extra["used_credits"]) }));
        }
        if finite(extra.get("utilization")).is_some() {
            extras.push(json!({ "label": "Uso extra utilizado", "value": format!("{}%", js_string(&extra["utilization"])) }));
        }
    }
    let tier = data.get("subscription_type").filter(|t| truthy(Some(t)));
    // `data.subscription_type || account.subscriptionType`
    let plan_source = match tier {
        Some(tier) => tier.as_str(),
        None => subscription_type,
    };
    let unavailable = if !available {
        Some(if tier.is_some() {
            "Limites da assinatura indisponíveis nesta sessão (API, provedor externo ou login sem acesso ao uso)."
        } else {
            "Esta conta está sem login de assinatura ativo. Entre novamente para ver os limites."
        })
    } else if r.is_none() {
        Some("O provedor não retornou o uso desta conta agora. Atualize novamente em instantes.")
    } else if limits.is_empty() {
        Some("O provedor não informou janelas de uso para esta conta.")
    } else {
        None
    };
    let mut out = Map::new();
    if let Some(email) = email.filter(|e| !e.is_empty()) {
        out.insert("email".into(), json!(email));
    }
    if let Some(tier) = tier {
        out.insert("tier".into(), tier.clone());
    }
    if let Some(plan) = claude_plan_label(plan_source, rate_limit_tier) {
        out.insert("plan".into(), json!(plan));
    }
    out.insert("limits".into(), Value::Array(limits));
    out.insert("extras".into(), Value::Array(extras));
    out.insert("updatedAt".into(), json!(now_ms));
    if let Some(unavailable) = unavailable {
        out.insert("unavailable".into(), json!(unavailable));
    }
    Value::Object(out)
}

/* ---------------- Models ---------------- */

const LEVELS: [&str; 6] = ["low", "medium", "high", "xhigh", "max", "ultra"];

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `/\b(?:Claude\s+)?(Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)?)/i`: the family and
/// its version number. The optional "Claude " never changes the captures, so
/// the leftmost family at a word boundary is the match.
fn claude_family(text: &str) -> Option<(&'static str, &str)> {
    let b = text.as_bytes();
    for start in 0..b.len() {
        if start > 0 && is_word(b[start - 1]) {
            continue;
        }
        for family in ["Opus", "Sonnet", "Haiku"] {
            let end = start + family.len();
            if !b.get(start..end).is_some_and(|w| w.eq_ignore_ascii_case(family.as_bytes())) {
                continue;
            }
            let rest = &text[end..];
            let spaces: usize = rest.chars().take_while(|c| js_space(*c)).map(char::len_utf8).sum();
            if spaces == 0 {
                continue;
            }
            let number = &rest[spaces..];
            let whole = number.bytes().take_while(u8::is_ascii_digit).count();
            if whole == 0 {
                continue;
            }
            let fraction = match number.as_bytes().get(whole) {
                Some(b'.') => number[whole + 1..].bytes().take_while(u8::is_ascii_digit).count(),
                _ => 0,
            };
            let len = if fraction > 0 { whole + 1 + fraction } else { whole };
            return Some((family, &number[..len]));
        }
    }
    None
}

/// Traycer's Claude label: the CLI's display name, carrying the family version
/// its description (or id) names - "Default (recommended)" becomes
/// "Default (Opus 5.5)", "Opus (1M context)" becomes "Opus 5.5 (1M context)".
fn claude_model_label(value: &str, display_name: &str, description: &str) -> String {
    let Some((family, number)) = claude_family(description).or_else(|| claude_family(value)) else { return display_name.to_string() };
    let version = format!("{family} {number}");
    let lower = display_name.to_lowercase();
    if lower.contains(&version.to_lowercase()) {
        return display_name.to_string();
    }
    if lower.starts_with("default") {
        return format!("Default ({version})");
    }
    if lower.starts_with(&family.to_lowercase()) {
        return format!("{version}{}", display_name.chars().skip(family.len()).collect::<String>());
    }
    format!("{display_name} ({version})")
}

fn known_efforts(ids: &[Value]) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for id in ids.iter().filter_map(Value::as_str) {
        if LEVELS.contains(&id) && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// Claude rows (`initialize`'s `models`) as `AgentModel`s, in CLI order.
fn claude_models(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .filter(|m| m.is_object())
        .map(|m| {
            let text = |key: &str| m.get(key).and_then(Value::as_str).unwrap_or_default();
            let efforts = m.get("supportedEffortLevels").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
            let mut out = Map::new();
            out.insert("provider".into(), json!("claude"));
            if let Some(id) = m.get("value") {
                out.insert("id".into(), id.clone());
            }
            out.insert("label".into(), json!(claude_model_label(text("value"), text("displayName"), text("description"))));
            if let Some(description) = m.get("description") {
                out.insert("description".into(), description.clone());
            }
            out.insert("efforts".into(), json!(known_efforts(efforts)));
            out.insert("defaultEffort".into(), json!("high"));
            out.insert("default".into(), json!(m.get("value").and_then(Value::as_str) == Some("default")));
            out.insert("fast".into(), if truthy(m.get("supportsFastMode")) { json!({ "id": "fast", "label": "Fast" }) } else { Value::Null });
            Value::Object(out)
        })
        .collect()
}

/* ---------------- Commands ---------------- */

/// Claude's `/` rows. The CLI marks its own commands (`builtin`) but does not
/// tell a skill from a custom command, so a non-built-in row whose name is a
/// skill folder on disk is a skill.
fn claude_commands(rows: &[Value], skills: &HashSet<String>) -> Vec<AgentCommand> {
    let mut out = Vec::new();
    for row in rows {
        let name = row.get("name").and_then(Value::as_str).map(js_trim).map(|n| n.strip_prefix('/').unwrap_or(n)).unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let builtin = row.get("builtin") == Some(&Value::Bool(true));
        let hint = row.get("argumentHint").and_then(Value::as_str).map(js_trim).unwrap_or_default();
        out.push(AgentCommand {
            name: name.to_string(),
            description: row.get("description").and_then(Value::as_str).unwrap_or_default().to_string(),
            argument_hint: (!hint.is_empty()).then(|| hint.to_string()),
            kind: if !builtin && skills.contains(name) { AgentCommandKind::Skill } else { AgentCommandKind::SlashCommand },
            builtin,
        });
    }
    out
}

/// Skill folders (`<name>/SKILL.md`) of the user (`~/.claude/skills`) and the
/// project (`<cwd>/.claude/skills`).
fn claude_skill_names(home: &Path, cwd: &str) -> HashSet<String> {
    let mut roots = vec![home.join(".claude").join("skills")];
    if !cwd.is_empty() {
        roots.push(Path::new(cwd).join(".claude").join("skills"));
    }
    let mut names = HashSet::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            if (kind.is_dir() || kind.is_symlink()) && entry.path().join("SKILL.md").exists() {
                names.insert(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicUsize;

    use prism_agents::claude::{ClaudeProfiles, CliCommand, Exit, Input, LaunchEnv, LaunchSpec, Launcher as ClaudeLauncher, Spawned};
    use prism_agents::codex::{AppServer, Launcher as CodexLauncher};
    use prism_agents::profile_env::{ProfileSource, StoredProfile};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::sync::{mpsc, oneshot};

    use super::*;

    /* ---------------- fakes ---------------- */

    fn profile(v: Value) -> StoredProfile {
        serde_json::from_value(v).unwrap()
    }

    /// The saved profiles, editable between calls.
    struct Source {
        root: PathBuf,
        profiles: Mutex<Vec<StoredProfile>>,
    }

    impl Source {
        fn disable(&self, id: &str) {
            for p in lock(&self.profiles).iter_mut().filter(|p| p.id == id) {
                p.enabled = Some(false);
            }
        }
    }

    impl ProfileSource for Source {
        fn stored(&self) -> Result<Vec<StoredProfile>, ProfileError> {
            Ok(lock(&self.profiles).clone())
        }
        fn own_home(&self, profile_id: &str) -> PathBuf {
            self.root.join("provider-profiles").join(profile_id)
        }
    }

    struct Call {
        bin: String,
        args: Vec<String>,
        env: ProfileEnv,
    }

    /// Canned CLI runs; remembers what it was asked.
    #[derive(Default)]
    struct FakeCli {
        installed: Mutex<HashSet<Provider>>,
        reply: Mutex<Ran>,
        calls: Mutex<Vec<Call>>,
    }

    impl FakeCli {
        fn install(&self, provider: Provider, installed: bool) {
            let mut all = lock(&self.installed);
            if installed {
                all.insert(provider);
            } else {
                all.remove(&provider);
            }
        }
        fn answer(&self, code: Option<i32>, stdout: &str) {
            *lock(&self.reply) = Ran { code, stdout: stdout.into(), stderr: String::new() };
        }
        fn runs(&self) -> usize {
            lock(&self.calls).len()
        }
        fn last(&self) -> (String, Vec<String>, ProfileEnv) {
            let calls = lock(&self.calls);
            let call = calls.last().expect("a CLI run");
            (call.bin.clone(), call.args.clone(), ProfileEnv { remove: call.env.remove.clone(), set: call.env.set.clone() })
        }
    }

    impl Cli for FakeCli {
        fn command<'a>(&'a self, provider: Provider, _profile_id: Option<&'a str>) -> BoxFuture<'a, Option<ProviderCommand>> {
            Box::pin(async move { lock(&self.installed).contains(&provider).then(|| ProviderCommand { bin: provider.as_str().into(), args: Vec::new() }) })
        }
        fn run(&self, command: ProviderCommand, args: Vec<String>, env: ProfileEnv, _limit: Duration) -> BoxFuture<'_, Ran> {
            Box::pin(async move {
                lock(&self.calls).push(Call { bin: command.bin.to_string_lossy().into_owned(), args, env });
                lock(&self.reply).clone()
            })
        }
    }

    /// What the scripted Claude CLI answers.
    struct Script {
        models: Value,
        commands: Value,
        account: Value,
        usages: VecDeque<Value>,
        fail: bool,
        delay: Duration,
        /// `initialize` answers without the `models` and `commands` keys.
        omit_lists: bool,
    }

    fn good_usage() -> Value {
        json!({ "subscription_type": "max", "rate_limits_available": true, "rate_limits": { "five_hour": { "utilization": 10, "resets_at": "2026-01-01T00:00:00Z" } } })
    }

    impl Default for Script {
        fn default() -> Self {
            Self {
                models: json!([{ "value": "default", "displayName": "Default (recommended)", "description": "Opus 5.5 · x" }]),
                commands: json!([]),
                account: json!({ "email": "e@x.invalid", "subscriptionType": "Claude Max" }),
                usages: VecDeque::from([good_usage()]),
                fail: false,
                delay: Duration::ZERO,
                omit_lists: false,
            }
        }
    }

    /// A Claude CLI that answers `initialize` and `get_usage` and counts its launches by kind.
    #[derive(Default)]
    struct ClaudeScript {
        script: Arc<Mutex<Script>>,
        reads: Mutex<Vec<&'static str>>,
    }

    impl ClaudeScript {
        fn set(&self, f: impl FnOnce(&mut Script)) {
            f(&mut lock(&self.script));
        }
        fn count(&self, kind: &str) -> usize {
            lock(&self.reads).iter().filter(|k| **k == kind).count()
        }
    }

    impl ClaudeLauncher for ClaudeScript {
        fn launch(&self, spec: &LaunchSpec) -> std::io::Result<Spawned> {
            let kind = if spec.args.iter().any(|a| a == "--setting-sources=user,project,local") {
                "commands"
            } else if spec.args.iter().any(|a| a == "--setting-sources=user") {
                "usage"
            } else {
                "models"
            };
            lock(&self.reads).push(kind);
            let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Input>();
            let (output_tx, output_rx) = mpsc::unbounded_channel::<String>();
            let (exit_tx, exit_rx) = oneshot::channel();
            let script = Arc::clone(&self.script);
            tokio::spawn(async move {
                while let Some(input) = input_rx.recv().await {
                    let Input::Line(line) = input else { break };
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                    let id = msg["request_id"].clone();
                    let (delay, reply) = {
                        let mut s = lock(&script);
                        let reply = if s.fail {
                            Err("SECRET boom".to_string())
                        } else {
                            match msg["request"]["subtype"].as_str() {
                                Some("initialize") if s.omit_lists => Ok(json!({ "account": s.account.clone() })),
                                Some("initialize") => Ok(json!({ "models": s.models.clone(), "commands": s.commands.clone(), "account": s.account.clone() })),
                                Some("get_usage") => {
                                    let usage = if s.usages.len() > 1 { s.usages.pop_front() } else { s.usages.front().cloned() };
                                    Ok(usage.unwrap_or(Value::Null))
                                }
                                other => Err(format!("unexpected {other:?}")),
                            }
                        };
                        (s.delay, reply)
                    };
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                    let response = match reply {
                        Ok(value) => json!({ "subtype": "success", "request_id": id, "response": value }),
                        Err(error) => json!({ "subtype": "error", "request_id": id, "error": error }),
                    };
                    let _ = output_tx.send(json!({ "type": "control_response", "response": response }).to_string());
                }
                let _ = exit_tx.send(Exit { code: Some(0) });
            });
            Ok(Spawned { input: input_tx, output: output_rx, exit: exit_rx, kill: Box::new(|| {}) })
        }
    }

    /// `ClaudeAgents`' own view of profiles: always runnable, always installed.
    struct AgentProfiles;

    impl ClaudeProfiles for AgentProfiles {
        fn environment(&self, _profile: Option<&str>) -> Result<LaunchEnv, String> {
            Ok(LaunchEnv::default())
        }
        fn command<'a>(&'a self, _profile: Option<&'a str>) -> BoxFuture<'a, Option<CliCommand>> {
            Box::pin(async { Some(CliCommand { program: "claude".into(), args: Vec::new() }) })
        }
        fn version<'a>(&'a self, _command: &'a CliCommand) -> BoxFuture<'a, Option<String>> {
            Box::pin(async { Some("2.1.289".into()) })
        }
    }

    /// Profiles named `e-<kind>` fail with that kind of Codex error.
    fn codex_failure(profile: &str) -> Option<CodexError> {
        let kind = match profile {
            "e-invalid" => CodexErrorKind::Invalid,
            "e-notfound" => CodexErrorKind::NotFound,
            "e-busy" => CodexErrorKind::Busy,
            "e-climissing" => CodexErrorKind::CliMissing,
            "e-cliauth" => CodexErrorKind::CliAuth,
            "e-failed" => CodexErrorKind::Failed,
            _ => return None,
        };
        Some(CodexError::new(kind, format!("mensagem {profile}")))
    }

    #[derive(Default)]
    struct CodexFake {
        launches: AtomicUsize,
    }

    impl CodexLauncher for CodexFake {
        fn check(&self, _profile_id: String) -> BoxFuture<'_, Result<(), CodexError>> {
            Box::pin(async { Ok(()) })
        }
        fn account(&self, profile_id: String) -> BoxFuture<'_, Result<String, CodexError>> {
            Box::pin(async move { codex_failure(&profile_id).map_or_else(|| Ok("ambient".to_string()), Err) })
        }
        fn launch(&self, profile_id: String, _cwd: Option<String>) -> BoxFuture<'_, Result<Arc<AppServer>, CodexError>> {
            Box::pin(async move {
                if let Some(err) = codex_failure(&profile_id) {
                    return Err(err);
                }
                self.launches.fetch_add(1, Ordering::SeqCst);
                let (client, server) = tokio::io::duplex(1 << 16);
                let (read, write) = tokio::io::split(client);
                let app = AppServer::from_io(read, write);
                tokio::spawn(async move {
                    let (server_read, mut server_write) = tokio::io::split(server);
                    let mut lines = BufReader::new(server_read).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let msg: Value = serde_json::from_str(&line).unwrap();
                        let (Some(method), Some(id)) = (msg.get("method").and_then(Value::as_str), msg.get("id")) else { continue };
                        let result = match method {
                            "initialize" => json!({}),
                            "model/list" => json!({ "data": [{ "model": "gpt-5.4", "displayName": "a", "description": "d", "supportedReasoningEfforts": [{ "reasoningEffort": "low" }], "defaultReasoningEffort": "low" }] }),
                            "skills/list" => json!({ "data": [{ "skills": [{ "name": "sk", "description": "d" }] }] }),
                            "account/read" => json!({ "account": { "email": "c@x.invalid", "planType": "plus" } }),
                            "account/rateLimits/read" => json!({ "rateLimits": { "limitId": "codex", "primary": { "usedPercent": 30, "windowDurationMins": 300, "resetsAt": 999 } } }),
                            _ => continue,
                        };
                        server_write.write_all(format!("{}\n", json!({ "id": id, "result": result })).as_bytes()).await.unwrap();
                    }
                });
                Ok(app)
            })
        }
    }

    struct Fx {
        dir: tempfile::TempDir,
        source: Arc<Source>,
        cli: Arc<FakeCli>,
        claude: Arc<ClaudeScript>,
        codex: Arc<CodexFake>,
        catalogs: Arc<Catalogs>,
    }

    impl Fx {
        fn new() -> Self {
            Self::build(true)
        }

        fn without_claude() -> Self {
            Self::build(false)
        }

        fn build(with_claude: bool) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let (home, traycer) = (dir.path().join("home"), dir.path().join("traycer"));
            // A Traycer-managed account `acc1`, so `linked` resolves.
            let account = traycer.join("host").join("harness-accounts").join("claude-code").join("acc1");
            std::fs::create_dir_all(&account).unwrap();
            std::fs::create_dir_all(&home).unwrap();
            let accounts = traycer.join("host").join("config");
            std::fs::create_dir_all(&accounts).unwrap();
            std::fs::write(
                accounts.join("provider-accounts.json"),
                json!({ "profiles": [{ "profileId": "acc1", "providerId": "claude-code", "kind": "managed", "dirPath": account.to_string_lossy() }] }).to_string(),
            )
            .unwrap();
            let link = |id: &str| json!({ "root": traycer.to_string_lossy(), "providerId": "claude-code", "profileId": id });
            let source = Arc::new(Source {
                root: dir.path().to_path_buf(),
                profiles: Mutex::new(vec![
                    profile(json!({ "id": "work", "provider": "claude", "name": "Work" })),
                    profile(json!({ "id": "off", "provider": "claude", "name": "Off", "enabled": false })),
                    profile(json!({ "id": "cwork", "provider": "codex", "name": "Codex" })),
                    profile(json!({ "id": "broken", "provider": "claude", "name": "Broken", "credentialLink": link("gone") })),
                    profile(json!({ "id": "linked", "provider": "claude", "name": "Linked", "credentialLink": link("acc1") })),
                ]),
            });
            let profiles = Profiles::with_roots(source.clone(), home.clone(), traycer);
            let cli = Arc::new(FakeCli::default());
            cli.install(Provider::Claude, true);
            cli.install(Provider::Codex, true);
            let claude = Arc::new(ClaudeScript::default());
            let codex = Arc::new(CodexFake::default());
            let agents = with_claude.then(|| ClaudeAgents::new(Arc::new(AgentProfiles), claude.clone()));
            let catalogs = Catalogs::build(profiles, agents, CodexQueries::new(codex.clone()), cli.clone(), home);
            Self { dir, source, cli, claude, codex, catalogs }
        }

        fn home(&self) -> PathBuf {
            self.dir.path().join("home")
        }

        fn linked_home(&self) -> PathBuf {
            self.dir.path().join("traycer").join("host").join("harness-accounts").join("claude-code").join("acc1")
        }

        /// Writes the login file of `work` (a profile's own folder).
        fn credentials(&self, text: &str) {
            let own = self.source.own_home("work");
            std::fs::create_dir_all(&own).unwrap();
            std::fs::write(own.join(".credentials.json"), text).unwrap();
        }
    }

    fn fail<T: std::fmt::Debug>(result: Result<T, HostError>) -> (ErrorCode, String) {
        let err = result.unwrap_err();
        (err.code, err.message)
    }

    /// The recorded reply of the real CLI (`host/fixtures/claude/2.1.289/metadata/expected.jsonl`).
    fn recorded(call: &str) -> Value {
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/claude/2.1.289/metadata/expected.jsonl"))
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|row| row["call"] == call)
            .map(|row| row["result"].clone())
            .expect("recorded call")
    }

    fn rows(v: &Value) -> &[Value] {
        v.as_array().unwrap()
    }

    /* ---------------- conversions ---------------- */

    #[test]
    fn claude_model_labels_match_the_traycer_ones_for_real_cli_rows() {
        let l = claude_model_label;
        // CLI 2.1.289
        assert_eq!(l("default", "Default (recommended)", "Opus 5.5 · Best for everyday, complex tasks"), "Default (Opus 5.5)");
        assert_eq!(l("opus", "Opus 5.5", "For complex work..."), "Opus 5.5");
        assert_eq!(l("fable", "Fable 5.1", "For your toughest challenges"), "Fable 5.1");
        assert_eq!(l("claude-sonnet-5", "Sonnet 5", "Efficient..."), "Sonnet 5");
        // CLI 2.1.281
        assert_eq!(l("opus[1m]", "Opus (1M context)", "Opus 5.5 with 1M context · ..."), "Opus 5.5 (1M context)");
        assert_eq!(l("claude-fable-5-1[1m]", "Fable", "Fable 5.1 · Most capable..."), "Fable");
        assert_eq!(l("sonnet", "Sonnet", "Sonnet 5 · Efficient..."), "Sonnet 5");
        assert_eq!(l("haiku", "Haiku", "Haiku 4.5 · Fastest..."), "Haiku 4.5");
        // A name without the family at the start, and a case-insensitive match.
        assert_eq!(l("custom", "Custom", "Opus 5.5 · something"), "Custom (Opus 5.5)");
        assert_eq!(l("default", "Default", "claude opus 4.8 is used"), "Default (Opus 4.8)");
        assert_eq!(l("x", "Plain", ""), "Plain");
        // The id names the version when the description does not.
        assert_eq!(l("Sonnet 4.6", "Mine", ""), "Mine (Sonnet 4.6)");
    }

    #[test]
    fn claude_models_keep_cli_order_filter_efforts_and_flag_default_and_fast() {
        let rows = [
            json!({ "value": "default", "displayName": "Default (recommended)", "description": "Opus 5.5 · x", "supportedEffortLevels": ["low", "bogus", "high", "high", "max"], "supportsFastMode": true }),
            json!({ "value": "haiku", "displayName": "Haiku", "description": "Haiku 4.5 · y" }),
            json!({ "value": "opus", "displayName": "Opus 5.5", "description": "z", "supportedEffortLevels": ["ultra", "medium"] }),
        ];
        let out = claude_models(&rows);
        let ids: Vec<_> = out.iter().map(|m| m["id"].clone()).collect();
        assert_eq!(ids, [json!("default"), json!("haiku"), json!("opus")]);
        assert_eq!(out[0]["efforts"], json!(["low", "high", "max"]));
        assert_eq!(out[1]["efforts"], json!([]));
        assert_eq!(out[2]["efforts"], json!(["ultra", "medium"]));
        let defaults: Vec<_> = out.iter().map(|m| m["default"].clone()).collect();
        assert_eq!(defaults, [json!(true), json!(false), json!(false)]);
        let fast: Vec<_> = out.iter().map(|m| m["fast"].clone()).collect();
        assert_eq!(fast, [json!({ "id": "fast", "label": "Fast" }), Value::Null, Value::Null]);
        assert!(out.iter().all(|m| m["provider"] == "claude" && m["defaultEffort"] == "high"));
        assert_eq!(out[0]["label"], "Default (Opus 5.5)");
        assert_eq!(out[0]["description"], "Opus 5.5 · x");
    }

    #[test]
    fn claude_models_skip_rows_that_are_not_objects_and_keep_a_row_without_id() {
        let out = claude_models(&[json!(5), Value::Null, json!({ "displayName": "Só nome" })]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["label"], "Só nome");
        assert!(out[0].get("id").is_none() && out[0].get("description").is_none());
        assert_eq!(out[0]["default"], false);
    }

    #[test]
    fn the_recorded_models_convert_with_their_real_labels() {
        let recorded = recorded("models");
        let out = claude_models(rows(&recorded));
        let labels: Vec<_> = out.iter().map(|m| m["label"].as_str().unwrap()).collect();
        assert_eq!(
            labels,
            ["Default (Opus 5.5)", "Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5", "Sonnet 5", "Opus 5", "Fable 5", "Opus 4.8", "Opus 4.7", "Opus 4.6", "Sonnet 4.6"]
        );
        let ids: Vec<_> = out.iter().take(5).map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["default", "opus", "fable", "sonnet", "haiku"]);
        assert_eq!(out.iter().filter(|m| m["default"] == true).count(), 1);
        assert_eq!(out[0]["fast"], json!({ "id": "fast", "label": "Fast" }));
        assert_eq!(out[1]["fast"], json!({ "id": "fast", "label": "Fast" }));
        assert_eq!(out[2]["fast"], Value::Null);
        assert_eq!(out[0]["efforts"], json!(["low", "medium", "high", "xhigh", "max"]));
        assert_eq!(out[4]["efforts"], json!([]));
    }

    #[test]
    fn plan_labels_name_max_tiers_other_plans_and_unknown_tokens() {
        let p = claude_plan_label;
        assert_eq!(p(Some("max"), Some("default_claude_max_20x")).as_deref(), Some("Assinatura Claude Max 20x"));
        assert_eq!(p(Some("max"), Some("default_claude_max_5x")).as_deref(), Some("Assinatura Claude Max 5x"));
        assert_eq!(p(Some("max"), None).as_deref(), Some("Assinatura Claude Max"));
        assert_eq!(p(Some("Claude Max"), Some("default_claude_max_20x")).as_deref(), Some("Assinatura Claude Max 20x"));
        assert_eq!(p(Some("pro"), Some("default_claude_max_20x")).as_deref(), Some("Assinatura Claude Pro"));
        assert_eq!(p(Some("team"), None).as_deref(), Some("Assinatura Claude Team"));
        assert_eq!(p(Some("enterprise"), None).as_deref(), Some("Assinatura Claude Enterprise"));
        assert_eq!(p(Some("free"), None).as_deref(), Some("Assinatura Claude Free"));
        assert_eq!(p(Some("max20"), None).as_deref(), Some("Assinatura Claude Max 20x"));
        assert_eq!(p(Some("some_new_plan"), None).as_deref(), Some("Assinatura Claude Some New Plan"));
        assert_eq!(p(Some("Claude Pro"), None).as_deref(), Some("Assinatura Claude Pro"));
        assert_eq!(p(Some(""), None), None);
        assert_eq!(p(None, None), None);
        assert_eq!(p(Some("  "), None), None);
    }

    #[test]
    fn details_keep_windows_scoped_models_zero_usage_and_extras_but_not_codenames() {
        let data = json!({ "subscription_type": "max", "rate_limits_available": true, "rate_limits": {
            "five_hour": { "utilization": 0, "resets_at": "2026-10-08T12:00:00Z" },
            "seven_day": { "utilization": 99, "resets_at": "invalid" },
            "seven_day_opus": null,
            "seven_day_sonnet": { "utilization": null },
            "seven_day_future": { "utilization": 20 },
            "model_scoped": [{ "display_name": "Fable", "utilization": 51, "resets_at": null }],
            "extra_usage": { "is_enabled": true, "monthly_limit": 1000, "used_credits": 45, "utilization": 4.5, "currency": "USD" } } });
        let r = claude_details(&data, None, None, None, 42);
        let limits = rows(&r["limits"]);
        assert_eq!(limits.len(), 3);
        assert_eq!(limits[0]["usedPercent"], 0);
        assert_eq!(limits[0]["resetsAt"], 1_791_460_800);
        assert_eq!(limits[1]["id"], "seven_day");
        assert!(limits[1].get("resetsAt").is_none());
        assert_eq!(limits[2]["label"], "Fable · 7 dias");
        assert!(limits.iter().all(|l| l["id"] != "seven_day_future"));
        assert_eq!(
            r["extras"],
            json!([
                { "label": "Uso extra", "value": "Ativado" },
                { "label": "Limite mensal de créditos", "value": "1000 USD" },
                { "label": "Créditos utilizados", "value": "45" },
                { "label": "Uso extra utilizado", "value": "4.5%" },
            ])
        );
        assert!(r.get("unavailable").is_none());
        assert_eq!((r["updatedAt"].clone(), r["tier"].clone(), r["plan"].clone()), (json!(42), json!("max"), json!("Assinatura Claude Max")));
    }

    #[test]
    fn details_name_the_windows_and_label_a_scoped_model_without_a_display_name() {
        let w = json!({ "utilization": 10, "resets_at": "2026-01-01T00:00:00Z" });
        let mut scoped = w.clone();
        scoped["display_name"] = json!("Haiku");
        let data = json!({ "rate_limits_available": true, "rate_limits": { "five_hour": w, "seven_day": w, "seven_day_opus": w, "seven_day_sonnet": w, "model_scoped": [scoped, w] } });
        let r = claude_details(&data, None, None, None, 0);
        let by = |id: &str| rows(&r["limits"]).iter().find(|l| l["id"] == id).unwrap().clone();
        assert_eq!((by("five_hour")["name"].clone(), by("five_hour")["windowMinutes"].clone()), (Value::Null, json!(300)));
        assert_eq!((by("seven_day")["name"].clone(), by("seven_day")["windowMinutes"].clone()), (Value::Null, json!(10080)));
        assert_eq!(by("seven_day_opus")["name"], "Opus");
        assert_eq!(by("seven_day_opus")["label"], "Opus · 7 dias");
        assert_eq!(by("seven_day_sonnet")["name"], "Sonnet");
        assert_eq!((by("model:0")["name"].clone(), by("model:0")["label"].clone()), (json!("Haiku"), json!("Haiku · 7 dias")));
        // Like `${undefined} · 7 dias` in the TypeScript.
        assert_eq!((by("model:1")["name"].clone(), by("model:1")["label"].clone()), (Value::Null, json!("undefined · 7 dias")));
        assert_eq!(by("five_hour")["resetsAt"], 1_767_225_600);
        assert_eq!(rows(&r["limits"]).len(), 6);
    }

    #[test]
    fn details_explain_why_there_are_no_limits() {
        const NO_LOGIN: &str = "Esta conta está sem login de assinatura ativo. Entre novamente para ver os limites.";
        const NO_SCOPE: &str = "Limites da assinatura indisponíveis nesta sessão (API, provedor externo ou login sem acesso ao uso).";
        const NO_REPLY: &str = "O provedor não retornou o uso desta conta agora. Atualize novamente em instantes.";
        const NO_WINDOWS: &str = "O provedor não informou janelas de uso para esta conta.";
        let unavailable = |data: Value| {
            let r = claude_details(&data, None, None, None, 0);
            assert_eq!(r["limits"], json!([]), "never an invented zero");
            r["unavailable"].as_str().unwrap().to_string()
        };
        assert_eq!(unavailable(json!({ "rate_limits_available": false, "rate_limits": null })), NO_LOGIN);
        assert_eq!(unavailable(json!({})), NO_LOGIN);
        assert_eq!(unavailable(json!({ "subscription_type": "max", "rate_limits_available": false })), NO_SCOPE);
        assert_eq!(unavailable(json!({ "subscription_type": "max", "rate_limits_available": false, "rate_limits": { "five_hour": { "utilization": 5 } } })), NO_SCOPE);
        assert_eq!(unavailable(json!({ "rate_limits_available": true, "rate_limits": null })), NO_REPLY);
        assert_eq!(unavailable(json!({ "rate_limits_available": true })), NO_REPLY);
        assert_eq!(unavailable(json!({ "rate_limits_available": true, "rate_limits": {} })), NO_WINDOWS);
        assert_eq!(unavailable(json!({ "rate_limits_available": true, "rate_limits": { "five_hour": { "utilization": "x" } } })), NO_WINDOWS);
    }

    #[test]
    fn details_combine_the_account_with_the_usage_reply() {
        let data = json!({ "subscription_type": "max", "rate_limits_available": false });
        let r = claude_details(&data, Some("e@x.invalid"), Some("Claude Max"), Some("default_claude_max_20x"), 0);
        assert_eq!((r["plan"].clone(), r["email"].clone(), r["tier"].clone()), (json!("Assinatura Claude Max 20x"), json!("e@x.invalid"), json!("max")));
        let n = claude_details(&data, None, None, None, 0);
        assert_eq!(n["plan"], "Assinatura Claude Max");
        assert!(n.get("email").is_none());
        // Without the usage reply's plan, the account's own is the plan.
        let account = claude_details(&json!({ "rate_limits_available": false }), Some(""), Some("pro"), None, 0);
        assert_eq!(account["plan"], "Assinatura Claude Pro");
        assert!(account.get("tier").is_none() && account.get("email").is_none());
        // The tier only refines a Max plan.
        assert!(claude_details(&json!({}), None, None, Some("default_claude_max_5x"), 0).get("plan").is_none());
    }

    #[test]
    fn the_recorded_usage_converts_to_the_windows_the_account_screen_shows() {
        let recorded = recorded("usage");
        let account = &recorded["account"];
        let r = claude_details(&recorded["usage"], account["email"].as_str(), account["subscriptionType"].as_str(), None, 7);
        let ids: Vec<_> = rows(&r["limits"]).iter().map(|l| l["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["five_hour", "seven_day", "model:0"], "the codename buckets are not limits");
        let five = &r["limits"][0];
        assert_eq!((five["usedPercent"].clone(), five["label"].clone(), five["windowMinutes"].clone()), (json!(59), json!("Sessão · 5h"), json!(300)));
        assert!((five["resetsAt"].as_f64().unwrap() - 1_791_573_000.008).abs() < 1e-6);
        assert_eq!(r["limits"][2]["label"], "Fable · 7 dias");
        assert_eq!(r["limits"][2]["resetsAt"], 1_792_152_000);
        assert_eq!(r["extras"], json!([{ "label": "Uso extra", "value": "Desativado" }]));
        assert_eq!((r["email"].clone(), r["tier"].clone(), r["plan"].clone()), (json!("user@example.com"), json!("max"), json!("Assinatura Claude Max")));
        assert!(r.get("unavailable").is_none());
    }

    #[test]
    fn commands_strip_the_slash_and_spaces_and_drop_nameless_rows() {
        let none = HashSet::new();
        let rows = [
            json!({ "name": "/review" }),
            json!({ "name": "  /spaced  " }),
            json!({ "name": " plain " }),
            json!({ "name": "" }),
            json!({ "name": "   " }),
            json!({ "name": "/" }),
            json!({ "name": 42 }),
            json!({ "name": null }),
            json!({}),
            Value::Null,
        ];
        let names: Vec<_> = claude_commands(&rows, &none).into_iter().map(|c| c.name).collect();
        assert_eq!(names, ["review", "spaced", "plain"]);
    }

    #[test]
    fn commands_builtin_wins_over_skills_and_skills_decide_the_rest() {
        let skills: HashSet<String> = ["both", "sk"].map(String::from).into();
        let out = claude_commands(&[json!({ "name": "both", "builtin": true }), json!({ "name": "sk" }), json!({ "name": "custom" }), json!({ "name": "/sk", "builtin": false })], &skills);
        let got: Vec<_> = out.iter().map(|c| (c.name.as_str(), c.kind, c.builtin)).collect();
        assert_eq!(
            got,
            [
                ("both", AgentCommandKind::SlashCommand, true),
                ("sk", AgentCommandKind::Skill, false),
                ("custom", AgentCommandKind::SlashCommand, false),
                ("sk", AgentCommandKind::Skill, false),
            ]
        );
    }

    #[test]
    fn commands_are_builtin_only_when_exactly_true() {
        let skills: HashSet<String> = ["a", "b"].map(String::from).into();
        let out = claude_commands(&[json!({ "name": "a", "builtin": "true" }), json!({ "name": "b", "builtin": 1 }), json!({ "name": "c", "builtin": true }), json!({ "name": "d" })], &skills);
        assert_eq!(out.iter().map(|c| c.builtin).collect::<Vec<_>>(), [false, false, true, false]);
        assert_eq!((out[0].kind, out[1].kind), (AgentCommandKind::Skill, AgentCommandKind::Skill));
    }

    #[test]
    fn commands_trim_the_argument_hint_and_null_the_empty_ones() {
        let rows = [
            json!({ "name": "a", "argumentHint": "  <file>  " }),
            json!({ "name": "b", "argumentHint": "" }),
            json!({ "name": "c", "argumentHint": "   " }),
            json!({ "name": "d" }),
            json!({ "name": "e", "argumentHint": 5 }),
        ];
        let hints: Vec<_> = claude_commands(&rows, &HashSet::new()).into_iter().map(|c| c.argument_hint).collect();
        assert_eq!(hints, [Some("<file>".to_string()), None, None, None, None]);
    }

    #[test]
    fn commands_turn_a_non_string_description_into_an_empty_one() {
        let rows = [json!({ "name": "a", "description": "desc" }), json!({ "name": "b", "description": 3 }), json!({ "name": "c", "description": null }), json!({ "name": "d" })];
        let descriptions: Vec<_> = claude_commands(&rows, &HashSet::new()).into_iter().map(|c| c.description).collect();
        assert_eq!(descriptions, ["desc", "", "", ""]);
    }

    #[test]
    fn the_recorded_commands_keep_their_skills_and_builtins() {
        let recorded = recorded("commands");
        let skills: HashSet<String> = ["agent-browser".to_string()].into();
        let out = claude_commands(rows(&recorded), &skills);
        assert_eq!(out.len(), 78);
        assert_eq!(out.iter().filter(|c| c.builtin).count(), 55);
        assert_eq!(out.iter().filter(|c| !c.builtin).count(), 23);
        let first = &out[0];
        assert_eq!((first.name.as_str(), first.kind, first.builtin, first.argument_hint.as_deref()), ("agent-browser", AgentCommandKind::Skill, false, None));
        assert!(first.description.starts_with("Browser automation CLI"));
        assert!(out.iter().skip(1).all(|c| c.kind == AgentCommandKind::SlashCommand));
    }

    #[test]
    fn skill_names_come_from_folders_with_a_skill_file_in_home_and_project() {
        let dir = tempfile::tempdir().unwrap();
        let (home, project) = (dir.path().join("home"), dir.path().join("project"));
        let user_skills = home.join(".claude").join("skills");
        let project_skills = project.join(".claude").join("skills");
        for (root, name, file) in [(&user_skills, "with-md", true), (&user_skills, "without-md", false), (&project_skills, "proj", true)] {
            std::fs::create_dir_all(root.join(name)).unwrap();
            if file {
                std::fs::write(root.join(name).join("SKILL.md"), "# skill").unwrap();
            }
        }
        std::fs::write(user_skills.join("loose.md"), "x").unwrap();
        std::fs::write(user_skills.join("SKILL.md"), "x").unwrap();
        let cwd = project.to_string_lossy().into_owned();
        let both = claude_skill_names(&home, &cwd);
        assert_eq!(both, HashSet::from(["with-md".to_string(), "proj".to_string()]));
        // No folder: only the user's skills; missing roots are fine.
        assert_eq!(claude_skill_names(&home, ""), HashSet::from(["with-md".to_string()]));
        assert!(claude_skill_names(&dir.path().join("nothing"), &dir.path().join("nowhere").to_string_lossy()).is_empty());
    }

    #[test]
    fn iso_times_parse_like_date_parse() {
        assert_eq!(iso_millis("2026-01-01T00:00:00Z"), Some(1_767_225_600_000));
        assert_eq!(iso_millis("2026-01-01T00:00:00z"), Some(1_767_225_600_000));
        assert_eq!(iso_millis("2026-10-09T19:10:00.008710+00:00"), Some(1_791_573_000_008), "extra fraction digits are cut");
        assert_eq!(iso_millis("2026-10-16T12:00:00.008730+00:00"), Some(1_792_152_000_008));
        assert_eq!(iso_millis("2026-01-01T00:00:00.5Z"), Some(1_767_225_600_500));
        assert_eq!(iso_millis("2026-01-01T03:00:00-03:00"), Some(1_767_247_200_000));
        assert_eq!(iso_millis("2026-01-01T12:30+01:30"), Some(1_767_265_200_000), "seconds are optional");
        assert_eq!(iso_millis("2026-01-01T00:00:00+0530"), Some(1_767_205_800_000), "an offset without the colon");
        assert_eq!(iso_millis("2026-01-01T00:00Z"), Some(1_767_225_600_000));
        assert_eq!(iso_millis("2026-01-01 00:00:00Z"), Some(1_767_225_600_000));
        assert_eq!(iso_millis("2026-01-01T24:00:00Z"), Some(1_767_312_000_000));
        assert_eq!(iso_millis("2026-01-01"), Some(1_767_225_600_000), "a date alone is UTC midnight");
        assert_eq!(iso_millis("1969-12-31"), Some(-86_400_000));
        for bad in [
            "",
            "garbage",
            "2026",
            "2026-13-01T00:00:00Z",
            "2026-00-10",
            "2026-01-32",
            "2026-01-01T25:00:00Z",
            "2026-01-01T24:01:00Z",
            "2026-01-01T00:60:00Z",
            "2026-01-01T00:00:60Z",
            "2026-01-01T00:00:00.Z",
            "2026-01-01T00:00:00+24:00",
            "2026-01-01T00:00:00+01:60",
            "2026-01-01T00:00:00Zjunk",
            "2026-01-01T00:00:00",
            "2026/01/01",
            "2026-01-01X00:00:00Z",
            "20x6-01-01",
        ] {
            assert_eq!(iso_millis(bad), None, "{bad:?}");
        }
        assert_eq!(reset_at(Some(&json!("2026-01-01T00:00:00Z"))), Some(1_767_225_600.0));
        assert_eq!(reset_at(Some(&json!(5))), None);
        assert_eq!(reset_at(None), None);
    }

    /* ---------------- rate limit tier ---------------- */

    fn creds(extra: Value) -> String {
        let mut oauth = json!({ "accessToken": "SECRET", "refreshToken": "SECRET" });
        oauth.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        json!({ "claudeAiOauth": oauth }).to_string()
    }

    #[test]
    fn the_tier_comes_only_from_the_oauth_login_and_only_when_it_looks_like_one() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(".credentials.json");
        let read = |text: &str| {
            std::fs::write(&file, text).unwrap();
            read_rate_limit_tier(&file)
        };
        let tier = read(&creds(json!({ "rateLimitTier": "default_claude_max_20x" })));
        assert_eq!(tier.as_deref(), Some("default_claude_max_20x"));
        assert!(!format!("{tier:?}").contains("SECRET"));
        assert_eq!(read(&creds(json!({ "rateLimitTier": "default-max" }))), None, "a dash is not in the pattern");
        assert_eq!(read(&creds(json!({ "rateLimitTier": "MAX_5X" }))).as_deref(), Some("MAX_5X"), "case-insensitive");
        assert_eq!(read(&creds(json!({ "rateLimitTier": "a".repeat(64) }))), Some("a".repeat(64)));
        assert_eq!(read(&creds(json!({ "rateLimitTier": "a".repeat(65) }))), None);
        assert_eq!(read(&creds(json!({ "rateLimitTier": "" }))), None);
        assert_eq!(read(&creds(json!({ "rateLimitTier": "max 20x; rm -rf" }))), None);
        assert_eq!(read(&creds(json!({ "rateLimitTier": 20 }))), None);
        assert_eq!(read(&creds(json!({ "rateLimitTier": null }))), None);
        assert_eq!(read(&creds(json!({}))), None);
        assert_eq!(read("{not json"), None);
        assert_eq!(read(&json!({ "other": 1 }).to_string()), None);
        assert_eq!(read(&json!({ "claudeAiOauth": "x" }).to_string()), None);
        std::fs::remove_file(&file).unwrap();
        assert_eq!(read_rate_limit_tier(&file), None);
    }

    #[tokio::test]
    async fn a_profiles_tier_is_read_from_its_own_folder_and_never_leaks_the_tokens() {
        let fx = Fx::new();
        assert_eq!(fx.catalogs.rate_limit_tier("work").await, None, "no login file");
        fx.credentials(&creds(json!({ "rateLimitTier": "default_claude_max_20x" })));
        let tier = fx.catalogs.rate_limit_tier("work").await;
        assert_eq!(tier.as_deref(), Some("default_claude_max_20x"));
        // It ends up in the plan, and nothing else of the file does.
        let details = fx.catalogs.details("claude", "work", false).await.unwrap();
        assert_eq!(details["plan"], "Assinatura Claude Max 20x");
        assert!(!details.to_string().contains("SECRET"));
        fx.credentials("{not json");
        assert_eq!(fx.catalogs.rate_limit_tier("work").await, None);
        assert_eq!(fx.catalogs.rate_limit_tier("off").await, None, "a disabled profile has no environment");
    }

    /* ---------------- models and commands ---------------- */

    #[tokio::test]
    async fn claude_models_are_read_once_and_again_on_refresh_and_forget() {
        let fx = Fx::new();
        let first = fx.catalogs.models("claude", "work", false).await.unwrap();
        assert_eq!(first[0]["label"], "Default (Opus 5.5)");
        assert_eq!(first[0]["provider"], "claude");
        assert_eq!(fx.catalogs.models("claude", "work", false).await.unwrap(), first);
        assert_eq!(fx.claude.count("models"), 1, "cached");
        fx.claude.set(|s| s.models = json!([{ "value": "opus", "displayName": "Opus 5.5", "description": "x" }]));
        assert_eq!(fx.catalogs.models("claude", "work", false).await.unwrap(), first, "still the cached one");
        let fresh = fx.catalogs.models("claude", "work", true).await.unwrap();
        assert_eq!((fx.claude.count("models"), fresh[0]["id"].clone()), (2, json!("opus")));
        assert_eq!(fx.catalogs.models("claude", "work", false).await.unwrap(), fresh, "the refresh is what is kept now");
        // Another profile has its own entry, and forgetting it leaves this one alone.
        fx.catalogs.models("claude", "linked", false).await.unwrap();
        assert_eq!(fx.claude.count("models"), 3);
        fx.catalogs.forget("linked");
        fx.catalogs.models("claude", "work", false).await.unwrap();
        assert_eq!(fx.claude.count("models"), 3);
        fx.catalogs.forget("work");
        fx.catalogs.models("claude", "work", false).await.unwrap();
        assert_eq!(fx.claude.count("models"), 4);
    }

    #[tokio::test]
    async fn a_failed_claude_read_is_not_cached() {
        let fx = Fx::new();
        fx.claude.set(|s| s.fail = true);
        let (code, message) = fail(fx.catalogs.models("claude", "work", false).await);
        assert_eq!((code, message.as_str()), (ErrorCode::Internal, "SECRET boom"));
        fx.claude.set(|s| s.fail = false);
        assert!(fx.catalogs.models("claude", "work", false).await.is_ok());
        assert_eq!(fx.claude.count("models"), 2);
        assert!(fx.catalogs.models("claude", "work", false).await.is_ok());
        assert_eq!(fx.claude.count("models"), 2);
    }

    #[tokio::test]
    async fn a_reply_that_is_not_a_list_is_an_unexpected_format() {
        let fx = Fx::new();
        fx.claude.set(|s| {
            s.models = json!({ "x": 1 });
            s.commands = json!("nope");
        });
        assert_eq!(fail(fx.catalogs.models("claude", "work", false).await), (ErrorCode::Internal, BAD_REPLY.to_string()));
        assert_eq!(fail(fx.catalogs.commands("claude", "work", "", false).await), (ErrorCode::Internal, BAD_REPLY.to_string()));
    }

    #[tokio::test]
    async fn concurrent_claude_models_reads_share_one_launch() {
        let fx = Fx::new();
        fx.claude.set(|s| s.delay = Duration::from_millis(100));
        let (a, b) = tokio::join!(fx.catalogs.models("claude", "work", false), fx.catalogs.models("claude", "work", false));
        assert_eq!(a.unwrap(), b.unwrap());
        assert_eq!(fx.claude.count("models"), 1);
    }

    #[tokio::test]
    async fn claude_commands_are_cached_per_folder_and_mark_skills_found_on_disk() {
        let fx = Fx::new();
        let skill = fx.home().join(".claude").join("skills").join("sk");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "# sk").unwrap();
        fx.claude.set(|s| s.commands = json!([{ "name": "sk", "description": "d", "argumentHint": " <x> " }, { "name": "/review", "builtin": true }, { "name": "custom" }]));
        let a = fx.catalogs.commands("claude", "work", "/a", false).await.unwrap();
        assert_eq!(a[0], json!({ "name": "sk", "description": "d", "argumentHint": "<x>", "kind": AgentCommandKind::Skill, "builtin": false }));
        assert_eq!((a[1]["name"].clone(), a[1]["builtin"].clone(), a[1]["kind"].clone()), (json!("review"), json!(true), json!(AgentCommandKind::SlashCommand)));
        assert_eq!(a[2]["kind"], json!(AgentCommandKind::SlashCommand));
        assert_eq!(fx.catalogs.commands("claude", "work", "/a", false).await.unwrap(), a);
        assert_eq!(fx.claude.count("commands"), 1);
        fx.catalogs.commands("claude", "work", "/b", false).await.unwrap();
        assert_eq!(fx.claude.count("commands"), 2, "another folder, another entry");
        fx.catalogs.commands("claude", "work", "/a", true).await.unwrap();
        assert_eq!(fx.claude.count("commands"), 3);
        fx.catalogs.commands("claude", "linked", "/a", false).await.unwrap();
        assert_eq!(fx.claude.count("commands"), 4, "another profile, another entry");
        fx.catalogs.forget("work");
        fx.catalogs.commands("claude", "work", "/a", false).await.unwrap();
        fx.catalogs.commands("claude", "work", "/b", false).await.unwrap();
        assert_eq!(fx.claude.count("commands"), 6, "forget drops every folder of the profile");
        fx.catalogs.commands("claude", "linked", "/a", false).await.unwrap();
        assert_eq!(fx.claude.count("commands"), 6);
    }

    #[tokio::test]
    async fn the_recorded_catalogs_flow_through_the_cli_protocol() {
        let fx = Fx::new();
        let (models, commands, usage) = (recorded("models"), recorded("commands"), recorded("usage"));
        fx.claude.set(|s| {
            s.models = models.clone();
            s.commands = commands.clone();
            s.account = usage["account"].clone();
            s.usages = VecDeque::from([usage["usage"].clone()]);
        });
        let got = fx.catalogs.models("claude", "work", false).await.unwrap();
        assert_eq!(got, Value::Array(claude_models(rows(&models))));
        let got = fx.catalogs.commands("claude", "work", "", false).await.unwrap();
        assert_eq!((rows(&got).len(), got[0]["name"].clone()), (78, json!("agent-browser")));
        let got = fx.catalogs.details("claude", "work", false).await.unwrap();
        assert_eq!((got["email"].clone(), got["limits"].as_array().unwrap().len()), (json!("user@example.com"), 3));
        assert_eq!(got["plan"], "Assinatura Claude Max");
        assert!(got["updatedAt"].as_i64().unwrap() > 1_700_000_000_000);
        assert_eq!(fx.claude.count("usage"), 1, "this account has a plan: one read is enough");
    }

    /* ---------------- details ---------------- */

    #[tokio::test]
    async fn claude_details_are_cached_and_refresh_reads_again() {
        let fx = Fx::new();
        let first = fx.catalogs.details("claude", "work", false).await.unwrap();
        assert_eq!(first["limits"].as_array().unwrap().len(), 1);
        assert_eq!(fx.catalogs.details("claude", "work", false).await.unwrap(), first);
        assert_eq!(fx.claude.count("usage"), 1);
        fx.claude.set(|s| s.usages = VecDeque::from([json!({ "subscription_type": "max", "rate_limits_available": true, "rate_limits": { "seven_day": { "utilization": 70 } } })]));
        let fresh = fx.catalogs.details("claude", "work", true).await.unwrap();
        assert_eq!((fx.claude.count("usage"), fresh["limits"][0]["id"].clone()), (2, json!("seven_day")));
        assert_eq!(fx.catalogs.details("claude", "work", false).await.unwrap(), fresh);
        assert_eq!(fx.claude.count("usage"), 2);
        fx.catalogs.forget("work");
        fx.catalogs.details("claude", "work", false).await.unwrap();
        assert_eq!(fx.claude.count("usage"), 3, "forget drops the snapshot");
    }

    #[tokio::test]
    async fn a_usage_reply_without_the_plan_flag_is_read_twice() {
        let fx = Fx::new();
        fx.claude.set(|s| s.usages = VecDeque::from([json!({ "rate_limits_available": false }), good_usage()]));
        let r = fx.catalogs.details("claude", "work", false).await.unwrap();
        assert_eq!(fx.claude.count("usage"), 2, "a cold account can answer before its login loads");
        assert_eq!(r["limits"].as_array().unwrap().len(), 1);
        assert!(r.get("unavailable").is_none() && r.get("error").is_none());
        // Still without a plan on the second read: that is the answer.
        let fx = Fx::new();
        fx.claude.set(|s| s.usages = VecDeque::from([json!({ "rate_limits_available": false })]));
        let r = fx.catalogs.details("claude", "work", false).await.unwrap();
        assert_eq!(fx.claude.count("usage"), 2);
        assert_eq!(r["limits"], json!([]));
        assert!(r["unavailable"].is_string() && r.get("error").is_none());
    }

    #[tokio::test]
    async fn a_failed_details_read_keeps_the_last_snapshot_stale_without_leaking_the_error() {
        let fx = Fx::new();
        let good = fx.catalogs.details("claude", "work", false).await.unwrap();
        fx.claude.set(|s| s.fail = true);
        let stale = fx.catalogs.details("claude", "work", true).await.unwrap();
        assert_eq!((stale["stale"].clone(), stale["error"].clone()), (json!(true), json!(DETAILS_ERROR)));
        assert_eq!(stale["limits"], good["limits"]);
        assert_eq!(stale["updatedAt"], good["updatedAt"]);
        assert!(!stale.to_string().contains("SECRET") && !stale.to_string().contains("boom"));
        // The failure is kept for a short while (30 s), not re-read at once.
        assert_eq!(fx.catalogs.details("claude", "work", false).await.unwrap(), stale);
        assert_eq!(fx.claude.count("usage"), 2);
        // The next good read replaces it.
        fx.claude.set(|s| s.fail = false);
        let back = fx.catalogs.details("claude", "work", true).await.unwrap();
        assert!(back.get("stale").is_none() && back.get("error").is_none());
    }

    #[tokio::test]
    async fn a_failed_details_read_with_nothing_before_is_an_empty_snapshot() {
        let fx = Fx::new();
        fx.claude.set(|s| s.fail = true);
        let r = fx.catalogs.details("claude", "work", false).await.unwrap();
        assert_eq!(r, json!({ "limits": [], "stale": false, "error": DETAILS_ERROR }));
        // A reply without a usage object is a failure too.
        let fx = Fx::new();
        fx.claude.set(|s| s.usages = VecDeque::from([Value::Null]));
        let r = fx.catalogs.details("claude", "work", false).await.unwrap();
        assert_eq!(r, json!({ "limits": [], "stale": false, "error": DETAILS_ERROR }));
        assert_eq!(fx.claude.count("usage"), 2, "a reply that says nothing about the plan is asked again");
    }

    #[tokio::test]
    async fn concurrent_details_calls_make_one_read() {
        let fx = Fx::new();
        fx.claude.set(|s| s.delay = Duration::from_millis(100));
        let (a, b, c) = tokio::join!(fx.catalogs.details("claude", "work", false), fx.catalogs.details("claude", "work", false), fx.catalogs.details("claude", "work", false));
        let a = a.unwrap();
        assert_eq!((&b.unwrap(), &c.unwrap()), (&a, &a));
        assert_eq!(fx.claude.count("usage"), 1);
    }

    #[tokio::test]
    async fn the_profile_is_checked_even_when_the_details_are_cached() {
        let fx = Fx::new();
        fx.catalogs.details("claude", "work", false).await.unwrap();
        fx.source.disable("work");
        let (code, message) = fail(fx.catalogs.details("claude", "work", false).await);
        assert_eq!((code, message.as_str()), (ErrorCode::Invalid, profile_env::DISABLED_MESSAGE));
        assert_eq!(fx.claude.count("usage"), 1);
    }

    #[tokio::test]
    async fn codex_reads_are_routed_cached_and_forgotten_by_the_codex_queries() {
        let fx = Fx::new();
        let models = fx.catalogs.models("codex", "cwork", false).await.unwrap();
        assert_eq!((models[0]["id"].clone(), models[0]["provider"].clone()), (json!("gpt-5.4"), json!("codex")));
        fx.catalogs.models("codex", "cwork", false).await.unwrap();
        assert_eq!(fx.codex.launches.load(Ordering::SeqCst), 1);
        let skills = fx.catalogs.commands("codex", "cwork", "/proj", false).await.unwrap();
        assert_eq!(skills[0]["name"], "sk");
        assert_eq!(fx.codex.launches.load(Ordering::SeqCst), 2);
        let details = fx.catalogs.details("codex", "cwork", false).await.unwrap();
        assert_eq!((details["email"].clone(), details["limits"].as_array().unwrap().len()), (json!("c@x.invalid"), 1));
        assert_eq!(fx.codex.launches.load(Ordering::SeqCst), 3);
        fx.catalogs.forget("cwork");
        fx.catalogs.models("codex", "cwork", false).await.unwrap();
        fx.catalogs.commands("codex", "cwork", "/proj", false).await.unwrap();
        fx.catalogs.details("codex", "cwork", false).await.unwrap();
        assert_eq!(fx.codex.launches.load(Ordering::SeqCst), 6);
        assert_eq!(fx.claude.count("models") + fx.claude.count("usage") + fx.claude.count("commands"), 0, "Codex never touches Claude");
        fx.catalogs.models("codex", "cwork", true).await.unwrap();
        assert_eq!(fx.codex.launches.load(Ordering::SeqCst), 7);
    }

    /* ---------------- errors ---------------- */

    #[tokio::test]
    async fn an_unknown_provider_is_invalid_everywhere() {
        let fx = Fx::new();
        let expected = (ErrorCode::Invalid, "Agente inválido.".to_string());
        assert_eq!(fail(fx.catalogs.details("gemini", "work", false).await), expected);
        assert_eq!(fail(fx.catalogs.models("gemini", "work", false).await), expected);
        assert_eq!(fail(fx.catalogs.commands("gemini", "work", "", false).await), expected);
        assert_eq!(fail(fx.catalogs.status("gemini", "work").await), expected);
        assert_eq!(fail(fx.catalogs.available("gemini").await), expected);
        assert_eq!(fail(fx.catalogs.models("", "work", false).await), expected);
        assert_eq!(fail(fx.catalogs.models("Claude", "work", false).await), expected);
    }

    #[tokio::test]
    async fn claude_profiles_that_cannot_run_fail_with_stable_codes() {
        let fx = Fx::new();
        let gone = fail(fx.catalogs.models("claude", "nope", false).await);
        assert_eq!((gone.0, gone.1.as_str()), (ErrorCode::NotFound, profile_env::NOT_FOUND_MESSAGE));
        assert_eq!(fail(fx.catalogs.models("claude", "cwork", false).await).0, ErrorCode::NotFound, "a Codex profile is not a Claude one");
        let off = fail(fx.catalogs.models("claude", "off", false).await);
        assert_eq!((off.0, off.1.as_str()), (ErrorCode::Invalid, profile_env::DISABLED_MESSAGE));
        let broken = fail(fx.catalogs.models("claude", "broken", false).await);
        assert_eq!((broken.0, broken.1.as_str()), (ErrorCode::CliAuth, profile_env::BROKEN_LINK_MESSAGE));
        assert_eq!(fail(fx.catalogs.commands("claude", "nope", "", false).await).0, ErrorCode::NotFound);
        assert_eq!(fail(fx.catalogs.commands("claude", "off", "", false).await).0, ErrorCode::Invalid);
        assert_eq!(fail(fx.catalogs.commands("claude", "broken", "", false).await).0, ErrorCode::CliAuth);
        assert_eq!(fail(fx.catalogs.details("claude", "nope", false).await).0, ErrorCode::NotFound);
        assert_eq!(fail(fx.catalogs.details("claude", "off", false).await).0, ErrorCode::Invalid);
        assert_eq!(fail(fx.catalogs.details("claude", "broken", false).await).0, ErrorCode::CliAuth);
        assert_eq!(fx.claude.count("models") + fx.claude.count("usage") + fx.claude.count("commands"), 0, "nothing launched for a refused profile");
    }

    #[tokio::test]
    async fn claude_without_its_cli_asks_to_install_it() {
        let fx = Fx::new();
        fx.cli.install(Provider::Claude, false);
        assert_eq!(fail(fx.catalogs.models("claude", "work", false).await), (ErrorCode::CliMissing, "Instale o Claude Code para consultar seus modelos.".to_string()));
        assert_eq!(fail(fx.catalogs.commands("claude", "work", "", false).await), (ErrorCode::CliMissing, "Instale o Claude Code para consultar seus comandos.".to_string()));
        assert_eq!(fx.claude.count("models") + fx.claude.count("commands"), 0);
    }

    #[tokio::test]
    async fn a_host_without_claude_answers_internal_and_an_error_snapshot() {
        let fx = Fx::without_claude();
        assert_eq!(fail(fx.catalogs.models("claude", "work", false).await), (ErrorCode::Internal, CLAUDE_OFF.to_string()));
        assert_eq!(fail(fx.catalogs.commands("claude", "work", "", false).await), (ErrorCode::Internal, CLAUDE_OFF.to_string()));
        let r = fx.catalogs.details("claude", "work", false).await.unwrap();
        assert_eq!(r, json!({ "limits": [], "stale": false, "error": DETAILS_ERROR }));
        // Codex is unaffected.
        assert!(fx.catalogs.models("codex", "cwork", false).await.is_ok());
    }

    #[tokio::test]
    async fn codex_errors_map_to_their_host_codes() {
        let fx = Fx::new();
        let cases = [
            ("e-invalid", ErrorCode::Invalid),
            ("e-notfound", ErrorCode::NotFound),
            ("e-busy", ErrorCode::Busy),
            ("e-climissing", ErrorCode::CliMissing),
            ("e-cliauth", ErrorCode::CliAuth),
            ("e-failed", ErrorCode::Internal),
        ];
        for (profile, code) in cases {
            let message = format!("mensagem {profile}");
            assert_eq!(fail(fx.catalogs.models("codex", profile, false).await), (code, message.clone()), "models {profile}");
            assert_eq!(fail(fx.catalogs.commands("codex", profile, "", false).await), (code, message.clone()), "commands {profile}");
            assert_eq!(fail(fx.catalogs.details("codex", profile, false).await), (code, message), "details {profile}");
        }
    }

    /* ---------------- status ---------------- */

    #[tokio::test]
    async fn a_disabled_profile_is_answered_without_running_the_cli() {
        let fx = Fx::new();
        assert_eq!(fx.catalogs.status("claude", "off").await.unwrap(), json!({ "installed": true, "loggedIn": false, "detail": "Desativada" }));
        fx.cli.install(Provider::Claude, false);
        assert_eq!(fx.catalogs.status("claude", "off").await.unwrap(), json!({ "installed": false, "loggedIn": false, "detail": "Desativada" }));
        assert_eq!(fx.cli.runs(), 0);
    }

    #[tokio::test]
    async fn a_broken_traycer_link_is_answered_without_running_the_cli() {
        let fx = Fx::new();
        fx.cli.answer(Some(0), r#"{"loggedIn":true}"#);
        assert_eq!(fx.catalogs.status("claude", "broken").await.unwrap(), json!({ "installed": true, "loggedIn": false, "detail": BROKEN_LINK_STATUS }));
        assert_eq!(fx.cli.runs(), 0);
    }

    #[tokio::test]
    async fn claude_status_reads_the_auth_json_with_the_profiles_environment() {
        let fx = Fx::new();
        fx.cli.answer(Some(0), r#"{"loggedIn":true,"email":"e@x.invalid","subscriptionType":"max","other":1}"#);
        let status = fx.catalogs.status("claude", "work").await.unwrap();
        assert_eq!(status, json!({ "installed": true, "loggedIn": true, "email": "e@x.invalid", "tier": "max", "detail": "Conectada" }));
        let (bin, args, env) = fx.cli.last();
        assert_eq!((bin.as_str(), args), ("claude", vec!["auth".to_string(), "status".to_string()]));
        assert_eq!(env.get("CLAUDE_CONFIG_DIR"), Some(fx.source.own_home("work").into_os_string()));
        assert_eq!(env.get("ANTHROPIC_API_KEY"), None);
        // `loggedIn: false` wins over a zero exit code.
        fx.cli.answer(Some(0), r#"{"loggedIn":false}"#);
        assert_eq!(fx.catalogs.status("claude", "work").await.unwrap(), json!({ "installed": true, "loggedIn": false, "detail": "Faça login nesta conta." }));
    }

    #[tokio::test]
    async fn claude_status_falls_back_to_the_text_and_the_exit_code() {
        let fx = Fx::new();
        let logged = |status: Value| status["loggedIn"].as_bool().unwrap();
        fx.cli.answer(Some(0), "Logged in as someone");
        assert!(logged(fx.catalogs.status("claude", "work").await.unwrap()));
        fx.cli.answer(Some(0), "Authenticated");
        assert!(logged(fx.catalogs.status("claude", "work").await.unwrap()));
        fx.cli.answer(Some(1), "Logged in");
        assert!(!logged(fx.catalogs.status("claude", "work").await.unwrap()));
        fx.cli.answer(Some(0), "Not signed in");
        assert!(!logged(fx.catalogs.status("claude", "work").await.unwrap()));
        fx.cli.answer(Some(0), "");
        assert!(!logged(fx.catalogs.status("claude", "work").await.unwrap()));
        fx.cli.answer(Some(0), "null");
        assert!(!logged(fx.catalogs.status("claude", "work").await.unwrap()));
        fx.cli.answer(None, "Logged in");
        assert!(!logged(fx.catalogs.status("claude", "work").await.unwrap()), "a CLI that was killed is not logged in");
        let status = fx.catalogs.status("claude", "work").await.unwrap();
        assert_eq!(status, json!({ "installed": true, "loggedIn": false, "detail": "Faça login nesta conta." }));
    }

    #[tokio::test]
    async fn codex_status_follows_the_exit_code() {
        let fx = Fx::new();
        fx.cli.answer(Some(0), "Logged in using ChatGPT");
        assert_eq!(fx.catalogs.status("codex", "cwork").await.unwrap(), json!({ "installed": true, "loggedIn": true, "detail": "Conectada" }));
        let (bin, args, env) = fx.cli.last();
        assert_eq!(bin, "codex");
        assert_eq!(args, ["login", "status", "-c", "cli_auth_credentials_store=\"file\""]);
        assert_eq!(env.get("CODEX_HOME"), Some(fx.source.own_home("cwork").into_os_string()));
        fx.cli.answer(Some(1), "Not logged in");
        assert_eq!(fx.catalogs.status("codex", "cwork").await.unwrap(), json!({ "installed": true, "loggedIn": false, "detail": "Faça login nesta conta." }));
        // The terminal account keeps the CLI's own credential store setting and environment.
        fx.cli.answer(Some(0), "Logged in");
        assert_eq!(fx.catalogs.status("codex", "ambient-codex").await.unwrap()["detail"], "Conectada");
        let (_, args, env) = fx.cli.last();
        assert_eq!(args, ["login", "status"]);
        assert_eq!(env, ProfileEnv::default());
    }

    #[tokio::test]
    async fn status_without_the_cli_says_it_is_not_installed() {
        let fx = Fx::new();
        fx.cli.install(Provider::Claude, false);
        fx.cli.install(Provider::Codex, false);
        assert_eq!(fx.catalogs.status("claude", "work").await.unwrap(), json!({ "installed": false, "loggedIn": false, "detail": "Claude Code não instalado." }));
        assert_eq!(fx.catalogs.status("codex", "cwork").await.unwrap(), json!({ "installed": false, "loggedIn": false, "detail": "Codex não instalado." }));
        assert_eq!(fx.cli.runs(), 0);
    }

    #[tokio::test]
    async fn a_linked_profile_says_the_login_comes_from_traycer() {
        let fx = Fx::new();
        fx.cli.answer(Some(0), r#"{"loggedIn":true,"email":"t@x.invalid"}"#);
        let status = fx.catalogs.status("claude", "linked").await.unwrap();
        assert_eq!(status, json!({ "installed": true, "loggedIn": true, "email": "t@x.invalid", "detail": "Conectada pelo login do Traycer" }));
        let (_, _, env) = fx.cli.last();
        assert_eq!(env.get("CLAUDE_CONFIG_DIR").map(PathBuf::from), Some(fx.linked_home()), "the account is used in place");
        fx.cli.answer(Some(1), "");
        assert_eq!(fx.catalogs.status("claude", "linked").await.unwrap(), json!({ "installed": true, "loggedIn": false, "detail": "Entre nesta conta pelo Traycer." }));
    }

    #[tokio::test]
    async fn status_of_a_missing_profile_is_not_found() {
        let fx = Fx::new();
        assert_eq!(fail(fx.catalogs.status("claude", "nope").await).0, ErrorCode::NotFound);
        assert_eq!(fail(fx.catalogs.status("claude", "cwork").await).0, ErrorCode::NotFound);
        assert_eq!(fail(fx.catalogs.status("codex", "work").await).0, ErrorCode::NotFound);
        assert_eq!(fx.cli.runs(), 0);
    }

    /* ---------------- available ---------------- */

    #[tokio::test]
    async fn codex_availability_comes_from_its_version_output() {
        let fx = Fx::new();
        fx.cli.answer(Some(0), " codex-cli 0.9.1\n");
        let v = fx.catalogs.available("codex").await.unwrap();
        assert_eq!((v["available"].clone(), v["version"].clone()), (json!(true), json!("codex-cli 0.9.1")));
        assert!(v.get("verified").is_none_or(Value::is_null) && v.get("warning").is_none_or(Value::is_null));
        let (bin, args, env) = fx.cli.last();
        assert_eq!((bin.as_str(), args), ("codex", vec!["--version".to_string()]));
        assert_eq!(env, ProfileEnv::default());
    }

    #[tokio::test]
    async fn claude_availability_checks_the_version_against_the_verified_ones() {
        let fx = Fx::without_claude();
        fx.cli.answer(Some(0), "2.1.289 (Claude Code)\n");
        let v = fx.catalogs.available("claude").await.unwrap();
        assert_eq!((v["available"].clone(), v["version"].clone(), v["verified"].clone()), (json!(true), json!("2.1.289 (Claude Code)"), json!(true)));
        assert!(v.get("warning").is_none_or(Value::is_null));
        let (bin, args, _) = fx.cli.last();
        assert_eq!((bin.as_str(), args), ("claude", vec!["--version".to_string()]));
        fx.cli.answer(Some(0), "2.2.0 (Claude Code)");
        let v = fx.catalogs.available("claude").await.unwrap();
        assert_eq!((v["available"].clone(), v["verified"].clone(), v["warning"].clone()), (json!(true), json!(false), json!(version::UNVERIFIED_WARNING)));
        fx.cli.answer(Some(0), "Claude Code");
        let v = fx.catalogs.available("claude").await.unwrap();
        assert_eq!((v["verified"].clone(), v["warning"].clone()), (json!(false), json!(version::UNVERIFIED_WARNING)), "no version number is not a verified one");
    }

    #[tokio::test]
    async fn availability_is_false_without_the_cli_or_with_a_failing_one() {
        let fx = Fx::without_claude();
        let off = |v: Value| (v["available"].clone(), v["version"].clone());
        fx.cli.answer(Some(1), "2.1.289 (Claude Code)");
        assert_eq!(off(fx.catalogs.available("claude").await.unwrap()), (json!(false), json!("")));
        assert_eq!(off(fx.catalogs.available("codex").await.unwrap()), (json!(false), json!("")));
        fx.cli.answer(None, "2.1.289 (Claude Code)");
        assert_eq!(off(fx.catalogs.available("claude").await.unwrap()), (json!(false), json!("")), "killed or timed out");
        fx.cli.install(Provider::Claude, false);
        fx.cli.install(Provider::Codex, false);
        fx.cli.answer(Some(0), "1.0.0");
        let runs = fx.cli.runs();
        assert_eq!(off(fx.catalogs.available("claude").await.unwrap()), (json!(false), json!("")));
        assert_eq!(off(fx.catalogs.available("codex").await.unwrap()), (json!(false), json!("")));
        assert_eq!(fx.cli.runs(), runs, "not installed: nothing to run");
        assert!(fx.catalogs.available("claude").await.unwrap().get("verified").is_none_or(Value::is_null));
    }

    /* ---------------- shape ---------------- */

    #[tokio::test]
    async fn the_public_futures_are_send_and_the_catalogs_are_shared_safely() {
        fn assert_send<T: Send>(_: &T) {}
        let fx = Fx::new();
        let catalogs = Arc::clone(&fx.catalogs);
        assert_send(&catalogs);
        assert_send(&catalogs.details("claude", "p", false));
        assert_send(&catalogs.models("claude", "p", false));
        assert_send(&catalogs.commands("claude", "p", "", false));
        assert_send(&catalogs.status("claude", "p"));
        assert_send(&catalogs.available("claude"));
        let boxed: std::pin::Pin<Box<dyn Future<Output = Result<Value, HostError>> + Send + '_>> = Box::pin(catalogs.details("claude", "work", false));
        assert!(boxed.await.is_ok());
    }

    /* ---------------- review fixes ---------------- */

    /// Eight callers on real threads at once: the first requests must share one read.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn many_simultaneous_first_requests_launch_one_cli() {
        for round in 0..5 {
            let fx = Fx::new();
            fx.claude.set(|s| s.delay = Duration::from_millis(150));
            let profile = if round % 2 == 0 { "work" } else { "linked" };
            let models: Vec<_> = (0..8)
                .map(|_| {
                    let catalogs = Arc::clone(&fx.catalogs);
                    tokio::spawn(async move { catalogs.models("claude", profile, false).await })
                })
                .collect();
            let commands: Vec<_> = (0..8)
                .map(|_| {
                    let catalogs = Arc::clone(&fx.catalogs);
                    tokio::spawn(async move { catalogs.commands("claude", profile, "", false).await })
                })
                .collect();
            let mut answers = Vec::new();
            for task in models.into_iter().chain(commands) {
                answers.push(task.await.unwrap().unwrap());
            }
            assert!(answers[..8].iter().all(|a| *a == answers[0]) && answers[8..].iter().all(|a| *a == answers[8]));
            assert_eq!((fx.claude.count("models"), fx.claude.count("commands")), (1, 1), "round {round}");
        }
    }

    #[tokio::test]
    async fn availability_looks_the_terminal_cli_up_afresh_every_time() {
        // A real `Profiles` over an empty home: its lookup is cached for a minute
        // (a `None` too) unless `available` makes it forget first.
        let fx = Fx::without_claude();
        let profiles = fx.catalogs.profiles.clone();
        let before = profiles.terminal_command(Provider::Codex).await;
        if before.is_some() {
            // This machine has a Codex on PATH: a found CLI is never the stale answer
            // (it is checked against the disk), so there is nothing to tell apart.
            // `Profiles::forget_terminal` itself is covered in prism-agents.
            return;
        }
        let bin = fx.home().join(".local").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let file = bin.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        std::fs::write(&file, b"not a real cli").unwrap();
        assert_eq!(profiles.terminal_command(Provider::Codex).await, None, "the lookup that found nothing is still cached");
        fx.cli.answer(Some(0), "codex-cli 0.9.1");
        fx.catalogs.available("codex").await.unwrap();
        let found = profiles.terminal_command(Provider::Codex).await.expect("available() made the next lookup look again");
        assert_eq!(found.bin, file);
    }

    #[tokio::test]
    async fn a_missing_cli_is_said_before_the_profiles_own_refusal() {
        let fx = Fx::new();
        fx.cli.install(Provider::Claude, false);
        // Disabled account, no CLI: the install message, not "account disabled".
        assert_eq!(fail(fx.catalogs.models("claude", "off", false).await), (ErrorCode::CliMissing, MODELS_CLI_MISSING.to_string()));
        assert_eq!(fail(fx.catalogs.commands("claude", "off", "", false).await), (ErrorCode::CliMissing, COMMANDS_CLI_MISSING.to_string()));
        assert!(MODELS_CLI_MISSING.starts_with("Instale o Claude Code") && COMMANDS_CLI_MISSING.starts_with("Instale o Claude Code"));
        // The same for a broken link.
        assert_eq!(fail(fx.catalogs.models("claude", "broken", false).await).0, ErrorCode::CliMissing);
        // With the CLI back, the profile's own refusal shows.
        fx.cli.install(Provider::Claude, true);
        assert_eq!(fail(fx.catalogs.models("claude", "off", false).await), (ErrorCode::Invalid, profile_env::DISABLED_MESSAGE.to_string()));
        assert_eq!(fx.claude.count("models") + fx.claude.count("commands"), 0);
    }

    #[tokio::test]
    async fn an_initialize_without_models_or_commands_is_an_unexpected_format_and_not_cached() {
        let fx = Fx::new();
        fx.claude.set(|s| s.omit_lists = true);
        let unexpected = (ErrorCode::Internal, BAD_REPLY.to_string());
        assert_eq!(fail(fx.catalogs.models("claude", "work", false).await), unexpected);
        assert_eq!(fail(fx.catalogs.models("claude", "work", false).await), unexpected);
        assert_eq!(fx.claude.count("models"), 2, "the failure was not kept: the second call read again");
        assert_eq!(fail(fx.catalogs.commands("claude", "work", "", false).await), unexpected);
        assert_eq!(fail(fx.catalogs.commands("claude", "work", "", false).await), unexpected);
        assert_eq!(fx.claude.count("commands"), 2);

        // Not an empty list kept for five minutes: once the CLI answers properly it shows.
        fx.claude.set(|s| s.omit_lists = false);
        assert_eq!(fx.catalogs.models("claude", "work", false).await.unwrap()[0]["label"], "Default (Opus 5.5)");
        assert!(fx.catalogs.commands("claude", "work", "", false).await.is_ok());
    }
}
