//! Which account and which CLI an agent runs with: the host's port of
//! `profileEnvironment` and `providerCommand` (src/main/providers.ts), shared
//! by the Codex (T05) and Claude (T06) sessions.
//!
//! - A profile is the terminal's own login (`ambient-<provider>`), a login
//!   Prism keeps in `provider-profiles/<id>`, or a Traycer-managed account
//!   used in place (`credentialLink`). A link that no longer resolves fails
//!   closed: it never falls back to the profile's own folder.
//! - The CLI is the newest of the terminal's install and Traycer's managed
//!   pack; a linked profile always runs Traycer's.
//! - Profiles come from a [`ProfileSource`]. Until T08 that is the Electron
//!   app's store, read only ([`ElectronProfiles`]).
//!
//! Typical use:
//!
//! ```ignore
//! let profiles = Profiles::new(Arc::new(ElectronProfiles::from_env()));
//! let env = profiles.environment(Provider::Codex, Some(profile_id))?;
//! let cli = profiles.command(Provider::Codex, Some(profile_id)).await.ok_or(..)?;
//! let mut command = cli.to_command();
//! env.apply(&mut command);
//! ```

use std::cmp::Ordering;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }

    /// The built-in profile that runs on the terminal's own login.
    pub fn ambient_id(self) -> &'static str {
        match self {
            Provider::Claude => "ambient-claude",
            Provider::Codex => "ambient-codex",
        }
    }

    /// Traycer's provider id (`provider-accounts.json`, `harness-accounts/`).
    pub fn traycer_id(self) -> &'static str {
        match self {
            Provider::Claude => "claude-code",
            Provider::Codex => "codex",
        }
    }

    /// The login file the CLI keeps in its config folder.
    pub fn credential_file(self) -> &'static str {
        match self {
            Provider::Claude => ".credentials.json",
            Provider::Codex => "auth.json",
        }
    }

    /// The config folder variable a profile points at its login.
    pub fn home_var(self) -> &'static str {
        match self {
            Provider::Claude => "CLAUDE_CONFIG_DIR",
            Provider::Codex => "CODEX_HOME",
        }
    }

    fn executable(self) -> &'static str {
        self.as_str()
    }

    /// The JS entry an npm install runs (next to its `.cmd` shim).
    fn npm_script(self) -> &'static str {
        match self {
            Provider::Claude => "@anthropic-ai/claude-code/cli.js",
            Provider::Codex => "@openai/codex/bin/codex.js",
        }
    }
}

/// A Prism profile that runs on a Traycer-managed account's own login, in
/// place. Copying a login would fork one rotating refresh token between two
/// apps; sharing the folder is what Traycer and the terminal already do.
/// Fields are optional because a malformed link still counts as a link (and
/// then as a broken one).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialLink {
    #[serde(default, deserialize_with = "string_or_none")]
    pub root: Option<String>,
    #[serde(default, deserialize_with = "string_or_none")]
    pub provider_id: Option<String>,
    #[serde(default, deserialize_with = "string_or_none")]
    pub profile_id: Option<String>,
}

/// A profile as the Electron store keeps it (`ProviderProfile & { credentialLink? }`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProfile {
    pub id: String,
    pub provider: Provider,
    #[serde(default, deserialize_with = "string_or_empty")]
    pub name: String,
    #[serde(default, deserialize_with = "truthy")]
    pub ambient: bool,
    /// `Some(false)` disables the profile; absent means enabled.
    #[serde(default, deserialize_with = "bool_or_none")]
    pub enabled: Option<bool>,
    #[serde(default, deserialize_with = "truthy")]
    pub tombstoned: bool,
    #[serde(default, deserialize_with = "link_or_none")]
    pub credential_link: Option<CredentialLink>,
}

impl StoredProfile {
    fn ambient(provider: Provider) -> Self {
        Self {
            id: provider.ambient_id().to_string(),
            provider,
            name: "Conta do terminal".to_string(),
            ambient: true,
            enabled: None,
            tombstoned: false,
            credential_link: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileErrorKind {
    /// Unknown, removed, or for another provider.
    NotFound,
    Disabled,
    /// Linked to a Traycer account that Traycer disabled or removed.
    BrokenLink,
    /// The profile store could not be read.
    Unreadable,
}

/// Why a profile cannot run; `message` is the pt-BR text the UI shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileError {
    pub kind: ProfileErrorKind,
    pub message: String,
}

impl ProfileError {
    fn new(kind: ProfileErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

impl std::fmt::Display for ProfileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProfileError {}

pub const NOT_FOUND_MESSAGE: &str = "Conta não encontrada para este agente. Selecione outra conta.";
pub const DISABLED_MESSAGE: &str = "Esta conta está desativada. Ative-a no gerenciador de contas.";
pub const BROKEN_LINK_MESSAGE: &str = "A conta vinculada ao Traycer está indisponível (desativada ou removida no Traycer). Reative-a no Traycer ou desvincule o perfil.";

/// Where profiles come from. T08 moves them into the host's own store; until
/// then the Electron app's store is read in place.
pub trait ProfileSource: Send + Sync {
    /// The saved profiles, without the two built-in terminal accounts.
    fn stored(&self) -> Result<Vec<StoredProfile>, ProfileError>;
    /// The folder a Prism-managed profile keeps its own login in.
    fn own_home(&self, profile_id: &str) -> PathBuf;
}

/// The Electron app's store, read only: `prism-agents.db` (SQLite,
/// `documents` rows of kind `profiles`) and `provider-profiles/<id>`.
#[derive(Debug, Clone)]
pub struct ElectronProfiles {
    user_data: PathBuf,
}

impl ElectronProfiles {
    pub fn new(user_data: impl Into<PathBuf>) -> Self {
        Self { user_data: user_data.into() }
    }

    /// `PRISM_APP_DATA_DIR` when set, else the app's default userData.
    pub fn from_env() -> Self {
        match std::env::var_os("PRISM_APP_DATA_DIR").filter(|v| !v.is_empty()) {
            Some(dir) => Self::new(dir),
            None => Self::new(Self::default_user_data()),
        }
    }

    /// Electron's `app.getPath('userData')` for the app named `prism-ide`.
    pub fn default_user_data() -> PathBuf {
        if cfg!(windows)
            && let Some(appdata) = std::env::var_os("APPDATA").filter(|v| !v.is_empty())
        {
            return PathBuf::from(appdata).join("prism-ide");
        }
        if cfg!(target_os = "macos") {
            return home_dir().join("Library").join("Application Support").join("prism-ide");
        }
        match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
            Some(config) => PathBuf::from(config).join("prism-ide"),
            None => home_dir().join(".config").join("prism-ide"),
        }
    }

    pub fn user_data(&self) -> &Path {
        &self.user_data
    }

    pub fn database(&self) -> PathBuf {
        self.user_data.join("prism-agents.db")
    }
}

impl ProfileSource for ElectronProfiles {
    fn stored(&self) -> Result<Vec<StoredProfile>, ProfileError> {
        let path = self.database();
        if !path.exists() {
            // A host without the desktop app (a VPS): terminal accounts only.
            return Ok(Vec::new());
        }
        read_profiles(&path).map_err(|err| {
            ProfileError::new(ProfileErrorKind::Unreadable, format!("Não foi possível ler as contas do Prism: {err}"))
        })
    }

    fn own_home(&self, profile_id: &str) -> PathBuf {
        self.user_data.join("provider-profiles").join(profile_id)
    }
}

/// Reads the `profiles` documents without ever writing the database. The
/// app keeps it in WAL mode; when no WAL is left (the app closed cleanly) an
/// immutable open works even where SQLite cannot create its `-shm` file.
fn read_profiles(path: &Path) -> rusqlite::Result<Vec<StoredProfile>> {
    use rusqlite::{Connection, OpenFlags};
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = match Connection::open_with_flags(path, flags) {
        Ok(conn) => conn,
        Err(err) => {
            let wal = path.with_file_name(format!("{}-wal", path.file_name().and_then(|n| n.to_str()).unwrap_or("")));
            if wal.exists() {
                return Err(err);
            }
            let uri = format!("file:{}?immutable=1", path.to_string_lossy().replace('\\', "/").replace('?', "%3f").replace('#', "%23"));
            Connection::open_with_flags(uri, flags | OpenFlags::SQLITE_OPEN_URI)?
        }
    };
    conn.busy_timeout(Duration::from_secs(5))?;
    let mut statement = match conn.prepare("SELECT body FROM documents WHERE kind='profiles'") {
        Ok(statement) => statement,
        // A database the app has not initialised yet.
        Err(rusqlite::Error::SqliteFailure(_, Some(message))) if message.contains("no such table") => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let bodies = statement.query_map([], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(bodies
        .iter()
        .filter_map(|body| match serde_json::from_str::<StoredProfile>(body) {
            Ok(profile) => Some(profile),
            Err(err) => {
                tracing::warn!(%err, "perfil ilegível no store do Prism ignorado");
                None
            }
        })
        .collect())
}

/// The live account folder Traycer runs a managed profile in. `home` is
/// Traycer's own `dirPath` spelling: Claude Code keys state on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedAccount {
    pub home: PathBuf,
    pub layout: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkState {
    None,
    Linked,
    Broken,
}

/// Traycer's account for a profile, or None when the profile is gone,
/// tombstoned, disabled, for another provider or outside Traycer's store.
pub fn traycer_account(root: &Path, provider: Provider, profile_id: &str) -> Option<LinkedAccount> {
    if profile_id.is_empty() || !profile_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    let data = read_json(&root.join("host").join("config").join("provider-accounts.json"))?;
    let profiles = data.get("profiles").and_then(Value::as_array)?;
    let p = profiles.iter().find(|p| {
        p.get("profileId").and_then(Value::as_str) == Some(profile_id) && p.get("providerId").and_then(Value::as_str) == Some(provider.traycer_id())
    })?;
    if p.get("kind").and_then(Value::as_str) != Some("managed") || js_truthy(p.get("tombstoned")) || p.get("enabled") == Some(&Value::Bool(false)) {
        return None;
    }
    let base = root.join("host").join("harness-accounts");
    let expected = base.join(provider.traycer_id()).join(profile_id);
    if !std::fs::symlink_metadata(&expected).map(|m| m.is_dir()).unwrap_or(false) || !within(&base, &expected) {
        return None;
    }
    let dir_path = p.get("dirPath").and_then(Value::as_str);
    if let Some(dir) = dir_path
        && !same_path(Path::new(dir), &expected)
    {
        return None;
    }
    Some(LinkedAccount {
        home: dir_path.map(PathBuf::from).unwrap_or(expected),
        layout: p.get("layout").and_then(Value::as_str).map(str::to_string),
    })
}

/// The linked Traycer account a profile currently runs in, if the link still resolves.
pub fn linked_account(p: &StoredProfile) -> Option<LinkedAccount> {
    let link = p.credential_link.as_ref()?;
    if p.ambient || link.provider_id.as_deref() != Some(p.provider.traycer_id()) {
        return None;
    }
    traycer_account(Path::new(link.root.as_deref()?), p.provider, link.profile_id.as_deref()?)
}

/// `Broken`: linked, but Traycer disabled or removed the account (or its store is unreadable).
pub fn link_state(p: &StoredProfile) -> LinkState {
    if p.credential_link.is_none() || p.ambient {
        LinkState::None
    } else if linked_account(p).is_some() {
        LinkState::Linked
    } else {
        LinkState::Broken
    }
}

/// Inherited variables a non-terminal profile drops: an API key or token must
/// not override the selected subscription, and a stray `CODEX_SQLITE_HOME`
/// must not point the profile at someone else's state.
pub const REMOVED_VARS: [&str; 11] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CODEX_SQLITE_HOME",
];

/// A profile's environment as changes over the host's own: the host's
/// environment is never modified, and a terminal profile changes nothing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProfileEnv {
    /// Dropped first (case-insensitively on Windows, like the OS).
    pub remove: Vec<&'static str>,
    /// Then set.
    pub set: Vec<(&'static str, OsString)>,
}

impl ProfileEnv {
    pub fn apply(&self, command: &mut tokio::process::Command) {
        for key in &self.remove {
            command.env_remove(key);
        }
        for (key, value) in &self.set {
            command.env(key, value);
        }
    }

    pub fn apply_std(&self, command: &mut std::process::Command) {
        for key in &self.remove {
            command.env_remove(key);
        }
        for (key, value) in &self.set {
            command.env(key, value);
        }
    }

    /// The value the spawned CLI will see.
    pub fn get(&self, key: &str) -> Option<OsString> {
        let same = |k: &str| if cfg!(windows) { k.eq_ignore_ascii_case(key) } else { k == key };
        if let Some((_, value)) = self.set.iter().rev().find(|(k, _)| same(k)) {
            return Some(value.clone());
        }
        if self.remove.iter().any(|k| same(k)) {
            return None;
        }
        std::env::var_os(key)
    }
}

/// How to start a provider CLI: `bin` alone, or `node <script>` for an npm install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderCommand {
    pub bin: PathBuf,
    pub args: Vec<OsString>,
}

impl ProviderCommand {
    pub fn to_command(&self) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(&self.bin);
        command.args(&self.args);
        command
    }

    /// The file whose version and identity count: the script, else the binary.
    fn target(&self) -> PathBuf {
        self.args.first().map(PathBuf::from).unwrap_or_else(|| self.bin.clone())
    }
}

const TERMINAL_TTL: Duration = Duration::from_secs(60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Profiles, their environments and their CLIs. Cheap to clone.
#[derive(Clone)]
pub struct Profiles {
    inner: Arc<Inner>,
}

struct Inner {
    source: Arc<dyn ProfileSource>,
    /// The OS user's home (`~/.codex`, `~/.local/bin`).
    home: PathBuf,
    /// Traycer's data (`~/.traycer`).
    traycer_root: PathBuf,
    terminals: Mutex<HashMap<Provider, (Instant, Option<ProviderCommand>)>>,
    versions: Mutex<HashMap<String, Option<String>>>,
}

impl Profiles {
    pub fn new(source: Arc<dyn ProfileSource>) -> Self {
        let home = home_dir();
        let traycer_root = home.join(".traycer");
        Self::with_roots(source, home, traycer_root)
    }

    /// Explicit home and Traycer folders (tests).
    pub fn with_roots(source: Arc<dyn ProfileSource>, home: PathBuf, traycer_root: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                source,
                home,
                traycer_root,
                terminals: Mutex::new(HashMap::new()),
                versions: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn source(&self) -> &Arc<dyn ProfileSource> {
        &self.inner.source
    }

    /// The two terminal accounts, then the saved ones.
    pub fn list(&self) -> Result<Vec<StoredProfile>, ProfileError> {
        let mut all = vec![StoredProfile::ambient(Provider::Claude), StoredProfile::ambient(Provider::Codex)];
        all.extend(self.inner.source.stored()?);
        Ok(all)
    }

    /// A usable profile for `provider`; removed ones are not found.
    pub fn get(&self, provider: Provider, id: &str) -> Result<StoredProfile, ProfileError> {
        match self.list()?.into_iter().find(|p| p.id == id && p.provider == provider) {
            Some(p) if !p.tombstoned => Ok(p),
            _ => Err(ProfileError::new(ProfileErrorKind::NotFound, NOT_FOUND_MESSAGE)),
        }
    }

    /// The environment a profile's CLI runs with (`id` None: the terminal
    /// account). Fails closed for disabled profiles and broken links. A
    /// profile's own folder is created when missing, as the app does.
    /// Blocking (small file reads); call from `spawn_blocking` on hot paths.
    pub fn environment(&self, provider: Provider, id: Option<&str>) -> Result<ProfileEnv, ProfileError> {
        let p = self.get(provider, id.unwrap_or(provider.ambient_id()))?;
        if p.enabled == Some(false) {
            return Err(ProfileError::new(ProfileErrorKind::Disabled, DISABLED_MESSAGE));
        }
        if p.ambient {
            return Ok(ProfileEnv::default());
        }
        // A linked profile never falls back to its own folder: that may hold
        // an old copy of the same login, and refreshing it would invalidate Traycer's.
        if link_state(&p) == LinkState::Broken {
            return Err(ProfileError::new(ProfileErrorKind::BrokenLink, BROKEN_LINK_MESSAGE));
        }
        let mut env = ProfileEnv { remove: REMOVED_VARS.to_vec(), set: Vec::new() };
        if let Some(linked) = linked_account(&p) {
            // Same variables Traycer sets for this account, so both apps share one login.
            env.set.push((provider.home_var(), linked.home.into_os_string()));
            if provider == Provider::Codex && linked.layout.as_deref() == Some("overlay") {
                let shared = self.inner.home.join(".codex");
                let sqlite = std::fs::canonicalize(&shared).map(simplified).unwrap_or(shared);
                env.set.push(("CODEX_SQLITE_HOME", sqlite.into_os_string()));
            }
            return Ok(env);
        }
        let home = self.inner.source.own_home(&p.id);
        create_private_dir(&home);
        env.set.push((provider.home_var(), home.into_os_string()));
        Ok(env)
    }

    /// The CLI Traycer itself runs for `provider`: its managed pack's
    /// `current` version. Only regular files inside the pack store count.
    pub fn managed_command(&self, provider: Provider) -> Option<(ProviderCommand, String)> {
        managed_command(&self.inner.traycer_root, provider)
    }

    /// The CLI to run. A profile linked to a Traycer account always runs
    /// Traycer's managed CLI: two versions in one account folder could migrate
    /// state the other cannot read. Otherwise the newest available: the
    /// terminal's install, or Traycer's when it is at least as new (or the
    /// terminal's version is unknown). Never downgrades a newer terminal CLI.
    /// The managed pack is re-read on every call, so a version Traycer swapped
    /// out is never returned.
    pub async fn command(&self, provider: Provider, profile_id: Option<&str>) -> Option<ProviderCommand> {
        let managed = self.managed_command(provider);
        if let (Some((command, _)), Some(id)) = (&managed, profile_id)
            && !id.starts_with("ambient-")
        {
            let source = Arc::clone(&self.inner.source);
            let id = id.to_string();
            let linked = tokio::task::spawn_blocking(move || {
                source.stored().ok().and_then(|all| all.into_iter().find(|p| p.id == id && p.provider == provider)).is_some_and(|p| p.credential_link.is_some())
            })
            .await
            .unwrap_or(false);
            if linked {
                return Some(command.clone());
            }
        }
        let terminal = self.terminal_command(provider).await;
        let Some((managed, managed_version)) = managed else { return terminal };
        let Some(terminal) = terminal else { return Some(managed) };
        match self.version(&terminal).await {
            Some(own) if compare_versions(&managed_version, &own) == Ordering::Less => Some(terminal),
            _ => Some(managed),
        }
    }

    /// Drops the terminal's CLI lookup, so the next one looks again (it was
    /// just installed, or removed).
    pub fn forget_terminal(&self, provider: Provider) {
        self.inner.terminals.lock().unwrap().remove(&provider);
    }

    /// The terminal's CLI (PATH, then `~/.local/bin`), looked up at most once a minute.
    pub async fn terminal_command(&self, provider: Provider) -> Option<ProviderCommand> {
        if let Some((at, command)) = self.inner.terminals.lock().unwrap().get(&provider).cloned()
            && at.elapsed() < TERMINAL_TTL
            && command.as_ref().is_none_or(|c| c.target().exists())
        {
            return command;
        }
        let command = lookup_terminal(provider, &self.inner.home).await;
        self.inner.terminals.lock().unwrap().insert(provider, (Instant::now(), command.clone()));
        command
    }

    /// A CLI's version, cached per file, mtime and size: an npm install's
    /// `package.json` is read in place, a binary is asked `--version`.
    pub async fn version(&self, command: &ProviderCommand) -> Option<String> {
        let target = command.target();
        let meta = std::fs::metadata(&target).ok()?;
        let key = format!("{}\0{:?}\0{}", target.display(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len());
        if let Some(version) = self.inner.versions.lock().unwrap().get(&key) {
            return version.clone();
        }
        let version = if command.args.is_empty() { probe_version(&command.bin).await } else { package_version(&target) };
        self.inner.versions.lock().unwrap().insert(key, version.clone());
        version
    }
}

fn managed_command(root: &Path, provider: Provider) -> Option<(ProviderCommand, String)> {
    let base = root.join("host").join("providers").join(provider.as_str()).join(platform_key());
    let current = read_json(&base.join("current.json"))?;
    let version = current.get("version").and_then(Value::as_str)?;
    if current.get("pack").and_then(Value::as_str) != Some(provider.as_str()) || !is_version(version) {
        return None;
    }
    let dir = base.join(version);
    let pack = read_json(&dir.join("pack.json"))?;
    let name = pack.get("executablePath").and_then(Value::as_str)?;
    let plain_name = !name.is_empty() && !name.contains('/') && !(cfg!(windows) && name.contains('\\'));
    if pack.get("pack").and_then(Value::as_str) != Some(provider.as_str()) || pack.get("version").and_then(Value::as_str) != Some(version) || !plain_name {
        return None;
    }
    let exe = dir.join(name);
    if !std::fs::symlink_metadata(&exe).map(|m| m.is_file()).unwrap_or(false) || !within(&base, &exe) {
        return None;
    }
    Some((ProviderCommand { bin: exe, args: Vec::new() }, version.to_string()))
}

/// Node's `${process.platform}-${process.arch}`, the name of Traycer's pack folders.
pub fn platform_key() -> String {
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    };
    format!("{os}-{arch}")
}

async fn lookup_terminal(provider: Provider, home: &Path) -> Option<ProviderCommand> {
    let name = provider.executable();
    let mut paths = which_all(name).await;
    paths.push(home.join(".local").join("bin").join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }));
    let needs_node = paths.iter().any(|p| matches!(candidate(provider, p), Candidate::Shim(Some(_))));
    let node = if needs_node { which_all("node").await.into_iter().find(|p| p.is_file()) } else { None };
    pick_terminal(provider, &paths, node.as_deref())
}

enum Candidate {
    Missing,
    Binary,
    /// An npm shim, with its package's JS entry when installed next to it.
    Shim(Option<PathBuf>),
}

fn candidate(provider: Provider, path: &Path) -> Candidate {
    if !path.exists() {
        return Candidate::Missing;
    }
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if matches!(ext.as_deref(), Some("cmd" | "bat" | "ps1")) || (cfg!(windows) && ext.as_deref() != Some("exe")) {
        let script = path.parent().unwrap_or(Path::new("")).join("node_modules").join(provider.npm_script());
        return Candidate::Shim(script.exists().then_some(script));
    }
    Candidate::Binary
}

/// The first usable PATH entry: a binary as is, an npm shim as `node <script>`
/// (the host has no Electron to run it with, so it needs Node on PATH).
fn pick_terminal(provider: Provider, paths: &[PathBuf], node: Option<&Path>) -> Option<ProviderCommand> {
    for path in paths {
        match candidate(provider, path) {
            Candidate::Missing | Candidate::Shim(None) => {}
            Candidate::Shim(Some(script)) => {
                if let Some(node) = node {
                    return Some(ProviderCommand { bin: node.to_path_buf(), args: vec![script.into_os_string()] });
                }
            }
            Candidate::Binary => return Some(ProviderCommand { bin: path.clone(), args: Vec::new() }),
        }
    }
    None
}

/// Every match on PATH, as `where.exe` / `command -v` list them.
async fn which_all(name: &str) -> Vec<PathBuf> {
    let mut command = if cfg!(windows) {
        let mut command = tokio::process::Command::new("where.exe");
        command.arg(name);
        command
    } else {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", &format!("command -v {name}")]);
        command
    };
    match run_quiet(&mut command).await {
        Some(out) => out.lines().map(str::trim).filter(|l| !l.is_empty()).map(PathBuf::from).collect(),
        None => Vec::new(),
    }
}

async fn probe_version(bin: &Path) -> Option<String> {
    let mut command = tokio::process::Command::new(bin);
    command.arg("--version");
    parse_version(&run_quiet(&mut command).await?)
}

/// stdout of a short helper, or None on failure or after the probe timeout.
async fn run_quiet(command: &mut tokio::process::Command) -> Option<String> {
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: the host has no console to lend.
    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output()).await.ok()?.ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn package_version(script: &Path) -> Option<String> {
    let dir = script.parent()?;
    for dir in [Some(dir), dir.parent()].into_iter().flatten() {
        let pkg = dir.join("package.json");
        if pkg.exists() {
            return read_json(&pkg).and_then(|v| v.get("version").and_then(Value::as_str).and_then(parse_version));
        }
    }
    None
}

/// The first `\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b` in a `--version` line.
fn parse_version(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let digits = |mut i: usize| {
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        (i > start).then_some(i)
    };
    let boundary_at = |end: usize| is_word(b[end - 1]) != (end < b.len() && is_word(b[end]));
    for start in 0..b.len() {
        if !b[start].is_ascii_digit() || (start > 0 && is_word(b[start - 1])) {
            continue;
        }
        let core = digits(start)
            .filter(|&i| b.get(i) == Some(&b'.'))
            .and_then(|i| digits(i + 1))
            .filter(|&i| b.get(i) == Some(&b'.'))
            .and_then(|i| digits(i + 1));
        let Some(core) = core else { continue };
        let mut ends = Vec::new();
        if b.get(core) == Some(&b'-') {
            let mut max = core + 1;
            while max < b.len() && is_pre(b[max]) {
                max += 1;
            }
            ends.extend((core + 2..=max).rev());
        }
        ends.push(core);
        if let Some(end) = ends.into_iter().find(|&end| boundary_at(end)) {
            let version = &text[start..end];
            return is_version(version).then(|| version.to_string());
        }
    }
    None
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn is_pre(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'.' || b == b'-'
}

/// `^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$`
pub fn is_version(v: &str) -> bool {
    let (core, rest) = match v.find(['-', '+']) {
        Some(i) => (&v[..i], Some(&v[i + 1..])),
        None => (v, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && rest.is_none_or(|r| !r.is_empty() && r.bytes().all(is_pre))
}

/// Numeric x.y.z order; a prerelease of the same core sorts first.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let parse = |v: &str| -> [u64; 3] {
        let core = v.split(['-', '+']).next().unwrap_or("");
        let mut out = [0; 3];
        for (slot, part) in out.iter_mut().zip(core.split('.')) {
            *slot = part.parse().unwrap_or(0);
        }
        out
    };
    parse(a).cmp(&parse(b)).then_with(|| (!a.contains('-')).cmp(&!b.contains('-')))
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// `path` resolves inside `root` (both real paths).
fn within(root: &Path, path: &Path) -> bool {
    match (std::fs::canonicalize(root), std::fs::canonicalize(path)) {
        (Ok(root), Ok(path)) => path.starts_with(root),
        _ => false,
    }
}

/// Node's `path.resolve` equality (lexical; case-insensitive on Windows).
fn same_path(a: &Path, b: &Path) -> bool {
    let (a, b) = (resolve(a), resolve(b));
    if cfg!(windows) { a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase() } else { a == b }
}

fn resolve(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// A canonical path without Windows' `\\?\` prefix, as Node's `realpathSync` spells it.
fn simplified(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\")
        && rest.as_bytes().get(1) == Some(&b':')
    {
        return PathBuf::from(rest);
    }
    path
}

fn create_private_dir(dir: &Path) {
    if dir.is_dir() {
        return;
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    if let Err(err) = builder.create(dir) {
        tracing::warn!(%err, dir = %dir.display(), "não foi possível criar a pasta da conta");
    }
}

/// The OS user's home folder.
pub fn home_dir() -> PathBuf {
    let keys: &[&str] = if cfg!(windows) { &["USERPROFILE", "HOME"] } else { &["HOME"] };
    keys.iter().find_map(|k| std::env::var_os(k).filter(|v| !v.is_empty())).map(PathBuf::from).unwrap_or_default()
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn truthy<'de, D: Deserializer<'de>>(de: D) -> Result<bool, D::Error> {
    Ok(js_truthy(Some(&Value::deserialize(de)?)))
}

fn bool_or_none<'de, D: Deserializer<'de>>(de: D) -> Result<Option<bool>, D::Error> {
    Ok(Value::deserialize(de)?.as_bool())
}

fn string_or_none<'de, D: Deserializer<'de>>(de: D) -> Result<Option<String>, D::Error> {
    Ok(Value::deserialize(de)?.as_str().map(str::to_string))
}

fn string_or_empty<'de, D: Deserializer<'de>>(de: D) -> Result<String, D::Error> {
    Ok(Value::deserialize(de)?.as_str().unwrap_or_default().to_string())
}

/// Any truthy `credentialLink` is a link; a malformed one resolves to nothing (broken).
fn link_or_none<'de, D: Deserializer<'de>>(de: D) -> Result<Option<CredentialLink>, D::Error> {
    let value = Value::deserialize(de)?;
    if !js_truthy(Some(&value)) {
        return Ok(None);
    }
    Ok(Some(serde_json::from_value(value).unwrap_or_default()))
}

#[cfg(test)]
#[path = "profile_env_tests.rs"]
mod tests;
