//! Claude Code over its native stdio protocol (stream-json lines plus
//! `control_request`/`control_response`), without the TypeScript Agent SDK.
//! Port of src/main/ipc/claudeAgent.ts: one live CLI process per chat,
//! resumed with `--resume` when the route (profile, folder, model, effort,
//! mode, Fast) changes, emitting the same `agent:*` events. Plan:
//! `prism-rust-host/claude-native-protocol` in the Traycer epic; contracts
//! recorded from the SDK in `host/fixtures/claude/<cli version>/`.

mod json;
pub mod launch;
mod meta;
pub mod profiles;
mod session;
mod subagents;
pub mod transcript;
pub mod transport;
pub mod usage;
pub mod version;
mod wire;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{Value, json};

pub use launch::{CliCommand, LaunchEnv, LaunchSpec};
pub use meta::Catalog;
pub use profiles::ClaudeProfiles;
pub use session::{ClientKey, Emitter};
pub use transport::{Exit, Input, Launcher, ProcessLauncher, Spawned};

use launch::{Purpose, SessionOptions, launch_env, session_args};
use session::{NewState, Session, Shared};
use usage::NO_CLAUDE_TOTALS;

const BUSY: &str = "Este chat já está executando uma tarefa.";
const CLI_MISSING: &str = "O Claude Code não está instalado. Instale-o para usar o agente.";

/// `agentSend`'s payload (src/preload/index.ts).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SendPayload {
    pub id: String,
    /// The UnifiedChat being run; only its id matters here.
    pub chat: Option<Value>,
    pub profile_id: Option<String>,
    pub permission_scope: Option<String>,
    pub prompt: String,
    pub images: Vec<Value>,
    pub cwd: Option<String>,
    pub resume: Option<String>,
    pub model: String,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub service_tier: Option<String>,
    pub thinking: Option<bool>,
    pub context_note: Option<String>,
    /// The old SSH mode: never run by the host.
    pub remote: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionReply {
    pub id: String,
    pub perm_id: String,
    pub decision: String,
    #[serde(default)]
    pub updated_input: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionReply {
    pub id: String,
    pub dialog_id: String,
    #[serde(default)]
    pub cancelled: Option<bool>,
    #[serde(default)]
    pub answers: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindParams {
    pub session_id: String,
    pub user_message_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub dry_run: Option<bool>,
    /// Where the session's checkpoints live; the terminal account when absent.
    #[serde(default)]
    pub profile_id: Option<String>,
}

fn nonempty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|v| !v.is_empty())
}

/// Every live Claude session of the host.
#[derive(Clone)]
pub struct ClaudeAgents {
    inner: Arc<Inner>,
}

struct Inner {
    profiles: Arc<dyn ClaudeProfiles>,
    launcher: Arc<dyn Launcher>,
    shared: Arc<Shared>,
    /// Sends for one chat run one at a time (the TS registered synchronously).
    chat_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl ClaudeAgents {
    pub fn new(profiles: Arc<dyn ClaudeProfiles>, launcher: Arc<dyn Launcher>) -> Self {
        Self { inner: Arc::new(Inner { profiles, launcher, shared: Arc::new(Shared::default()), chat_locks: Mutex::new(HashMap::new()) }) }
    }

    fn session(&self, key: &str) -> Option<Arc<Session>> {
        self.inner.shared.sessions.lock().unwrap().get(key).cloned()
    }

    fn sessions(&self) -> Vec<Arc<Session>> {
        self.inner.shared.sessions.lock().unwrap().values().cloned().collect()
    }

    fn chat_lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(self.inner.chat_locks.lock().unwrap().entry(key.to_string()).or_default())
    }

    async fn environment(&self, profile_id: Option<String>) -> Result<LaunchEnv, String> {
        let profiles = Arc::clone(&self.inner.profiles);
        tokio::task::spawn_blocking(move || profiles.environment(profile_id.as_deref())).await.unwrap_or_else(|err| Err(err.to_string()))
    }

    /// Runs a chat message (`agent:send`). Returns whether the turn began:
    /// false means it was refused before starting (an `agent:error` was
    /// emitted and, like the TS, nothing is journaled for it).
    pub async fn send(&self, client: ClientKey, emit: Emitter, p: SendPayload) -> bool {
        let fail = |message: &str| emit("agent:error", json!({"id": p.id, "message": message}));
        if nonempty(&p.remote).is_some() {
            fail("O modo SSH antigo não roda no host.");
            return false;
        }
        let Some(chat_id) = p.chat.as_ref().and_then(|c| c.get("id")).and_then(Value::as_str).map(str::to_string) else {
            fail("O host só executa conversas do painel de agentes.");
            return false;
        };
        let env = match self.environment(p.profile_id.clone()).await {
            Ok(env) => env,
            Err(message) => {
                fail(&message);
                return false;
            }
        };
        let key = format!("unified:{chat_id}");
        let lock = self.chat_lock(&key);
        let _guard = lock.lock().await;
        if let Some(live) = self.session(&key) {
            let st = live.state.lock().unwrap();
            if st.owner != client || st.active_turn.is_some() {
                drop(st);
                fail(BUSY);
                return false;
            }
        }
        self.stream(client, emit.clone(), &p, key, env).await;
        true
    }

    /// `sendToStreamingSession`: push into the chat's live process when the
    /// route is unchanged and it continues the same session; else restart it.
    async fn stream(&self, client: ClientKey, emit: Emitter, p: &SendPayload, key: String, env: LaunchEnv) {
        let text = match nonempty(&p.context_note) {
            Some(note) => format!("{}\n\n{note}", p.prompt),
            None => p.prompt.clone(),
        };
        let signature = json!([p.profile_id, p.cwd, p.model, p.effort, p.permission_mode, p.service_tier.clone().unwrap_or_default()]).to_string();
        let resume = nonempty(&p.resume);
        if let Some(existing) = self.session(&key) {
            // Claim the new turn under the same lock that checks liveness:
            // process exit must not slip between the check and registration.
            let system = {
                let mut st = existing.state.lock().unwrap();
                if !st.closed && !st.closing && !st.aborted && !existing.input_closed()
                    && st.signature == signature && resume.is_some() && st.session_id.as_deref() == resume
                {
                    st.active_turn = Some(p.id.clone());
                    st.emit = emit.clone();
                    let mut system = json!({"id": p.id});
                    if let Some(sid) = &st.session_id {
                        system["sessionId"] = sid.clone().into();
                    }
                    system["model"] = st.model.clone().into();
                    Some(system)
                } else {
                    None
                }
            };
            if let Some(system) = system {
                emit("agent:system", system);
                existing.push(&text, &p.images);
                return;
            }
            existing.end();
            if tokio::time::timeout(session::EXIT_GRACE * 3, existing.closed()).await.is_err() {
                existing.kill();
                tracing::warn!(chat = %key, "claude: sessão anterior não confirmou encerramento a tempo");
                emit("agent:error", json!({"id": p.id, "message": "O Claude Code não encerrou a sessão anterior a tempo. Aguarde a interrupção e envie a mensagem novamente."}));
                return;
            }
        }

        let Some(cli) = self.inner.profiles.command(p.profile_id.as_deref()).await else {
            emit("agent:error", json!({"id": p.id, "message": CLI_MISSING, "code": "cli_missing"}));
            return;
        };
        self.warn_unverified(cli.clone());
        let options = SessionOptions::from_chat(&p.model, p.effort.as_deref(), p.thinking, p.permission_mode.as_deref(), resume, p.service_tier.as_deref());
        let spec = LaunchSpec { program: cli.program, prefix: cli.args, args: session_args(&options), cwd: nonempty(&p.cwd).map(PathBuf::from), env: launch_env(env, Purpose::Session) };
        let spawned = match self.inner.launcher.launch(&spec) {
            Ok(spawned) => spawned,
            Err(err) => {
                emit("agent:error", json!({"id": p.id, "message": format!("Não foi possível iniciar o Claude Code: {err}")}));
                return;
            }
        };
        let permissions_key = match nonempty(&p.permission_scope) {
            Some(scope) => format!("{scope}:{}", nonempty(&p.profile_id).unwrap_or("ambient-claude")),
            None => String::new(),
        };
        let usage_base = match resume {
            Some(resume) => self.inner.shared.totals.lock().unwrap().get(resume).copied(),
            None => Some(NO_CLAUDE_TOTALS),
        };
        let Spawned { input, output, exit, kill } = spawned;
        let session = Session::new(
            key.clone(),
            input,
            kill,
            NewState { owner: client, signature, profile_id: p.profile_id.clone(), permissions_key, active_turn: Some(p.id.clone()), model: p.model.clone(), emit, usage_base },
        );
        self.inner.shared.sessions.lock().unwrap().insert(key, Arc::clone(&session));
        session.request(wire::initialize());
        session.push(&text, &p.images);
        tokio::spawn(session::run(session, Arc::clone(&self.inner.shared), output, exit));
    }

    /// Logs (once per CLI) a version outside the verified ones; runs best effort anyway.
    fn warn_unverified(&self, cli: CliCommand) {
        let profiles = Arc::clone(&self.inner.profiles);
        tokio::spawn(async move {
            if let Some(v) = profiles.version(&cli).await
                && !version::verified(&v)
            {
                tracing::warn!(version = %v, "{}", version::UNVERIFIED_WARNING);
            }
        });
    }

    /// `agent:abort`: interrupts the turn (the session stays alive).
    pub fn abort(&self, client: ClientKey, turn: &str) {
        for s in self.sessions() {
            let hit = {
                let st = s.state.lock().unwrap();
                st.owner == client && st.active_turn.as_deref() == Some(turn)
            };
            if hit {
                s.interrupt();
            }
        }
    }

    /// `agent:interrupt`: interrupts a chat's current turn.
    pub fn interrupt(&self, chat_key: &str) {
        if let Some(s) = self.session(chat_key) {
            s.interrupt();
        }
    }

    /// Injects a follow-up into this owner's active turn, without interrupting it.
    pub fn steer(&self, client: ClientKey, turn: &str, text: &str, images: &[Value]) -> Result<(), String> {
        for s in self.sessions() {
            let st = s.state.lock().unwrap();
            if st.owner == client && st.active_turn.as_deref() == Some(turn) && !st.aborted && !st.closed {
                s.push_now(text, images);
                return Ok(());
            }
        }
        Err("O turno já terminou ou está sendo interrompido. A mensagem continua na fila.".into())
    }

    /// `agent:end`: tears a chat's process down.
    pub fn end(&self, chat_key: &str) {
        if let Some(s) = self.session(chat_key) {
            s.end();
        }
    }

    /// Switches a live chat's model without restarting it (`set_model`).
    pub fn set_model(&self, chat_key: &str, model: &str) {
        if let Some(s) = self.session(chat_key) {
            s.state.lock().unwrap().model = model.to_string();
            s.request(wire::set_model(model));
        }
    }

    /// Switches a live chat's permission mode (`set_permission_mode`).
    pub fn set_permission_mode(&self, chat_key: &str, mode: &str) {
        if let Some(s) = self.session(chat_key) {
            s.request(wire::set_permission_mode(mode));
        }
    }

    pub fn respond_permission(&self, client: ClientKey, reply: PermissionReply) {
        for s in self.sessions() {
            if s.answer_permission(&self.inner.shared, client, &reply.id, &reply.perm_id, &reply.decision, reply.updated_input.clone()) {
                return;
            }
        }
    }

    pub fn respond_question(&self, client: ClientKey, reply: QuestionReply) {
        for s in self.sessions() {
            if s.answer_question(client, &reply.id, &reply.dialog_id, reply.cancelled.unwrap_or(false), reply.answers.clone()) {
                return;
            }
        }
    }

    /// The client's window is gone: its sessions end, as they did with the window.
    pub fn client_gone(&self, client: ClientKey) {
        for s in self.sessions() {
            if s.state.lock().unwrap().owner == client {
                s.end();
            }
        }
    }

    /// A profile signed in again: its idle processes (old credentials) end
    /// and its "always allow" choices are forgotten.
    pub fn profile_changed(&self, profile_id: &str) {
        for s in self.sessions() {
            let idle = {
                let st = s.state.lock().unwrap();
                st.active_turn.is_none() && st.profile_id.as_deref() == Some(profile_id)
            };
            if idle {
                s.end();
            }
        }
        let suffix = format!(":{profile_id}");
        self.inner.shared.allowed.lock().unwrap().retain(|key, _| !key.ends_with(&suffix));
    }

    /// Host shutdown: every process tree goes.
    pub fn shutdown(&self) {
        for s in self.sessions() {
            s.kill();
        }
    }

    /// Processes still running.
    pub fn live(&self) -> usize {
        self.inner.shared.sessions.lock().unwrap().len()
    }

    /// Whether a turn is running (the idle timer keeps the host up meanwhile).
    pub fn busy(&self) -> bool {
        self.sessions().iter().any(|s| s.state.lock().unwrap().active_turn.is_some())
    }

    /// `agent:available`: is a Claude Code CLI installed, and is its version verified?
    pub async fn available(&self) -> Value {
        let Some(cli) = self.inner.profiles.command(None).await else {
            return json!({"available": false, "version": ""});
        };
        match meta::version_output(&cli).await {
            Some(output) => {
                let verified = version::parse(&output).is_some_and(|v| version::verified(&v));
                let mut out = json!({"available": true, "version": output, "verified": verified});
                if !verified {
                    out["warning"] = version::UNVERIFIED_WARNING.into();
                }
                out
            }
            None => json!({"available": false, "version": ""}),
        }
    }

    async fn config_dir(&self, profile_id: Option<String>) -> Option<PathBuf> {
        self.environment(profile_id).await.ok().map(|env| profiles::config_dir(&env))
    }

    /// `agent:checkpoint-ids`: the session's user prompts, in order.
    pub async fn checkpoint_ids(&self, session_id: &str, profile_id: Option<String>) -> Vec<String> {
        let Some(dir) = self.config_dir(profile_id).await else { return Vec::new() };
        let Some(file) = transcript::find_transcript(&dir, session_id) else { return Vec::new() };
        tokio::fs::read_to_string(file).await.map(|text| transcript::checkpoint_ids(&text)).unwrap_or_default()
    }

    /// `agent:fork`: a new session with the conversation up to a message.
    pub async fn fork(&self, session_id: &str, up_to: &str, profile_id: Option<String>) -> Value {
        let Some(dir) = self.config_dir(profile_id).await else { return json!({"ok": false, "error": "Conta indisponível."}) };
        let Some(source) = transcript::find_transcript(&dir, session_id) else {
            return json!({"ok": false, "error": format!("Sessão {session_id} não encontrada.")});
        };
        let (session_id, up_to) = (session_id.to_string(), up_to.to_string());
        match tokio::task::spawn_blocking(move || transcript::fork(&source, &session_id, Some(&up_to))).await {
            Ok(Ok((id, file))) => json!({"ok": true, "sessionId": id, "file": file}),
            Ok(Err(error)) => json!({"ok": false, "error": error}),
            Err(err) => json!({"ok": false, "error": err.to_string()}),
        }
    }

    /// `agent:rewind`: the working tree back to a message (destructive; the UI confirms).
    pub async fn rewind(&self, r: RewindParams) -> Value {
        let env = match self.environment(r.profile_id.clone()).await {
            Ok(env) => env,
            Err(error) => return json!({"ok": false, "error": error}),
        };
        let Some(cli) = self.inner.profiles.command(r.profile_id.as_deref()).await else { return json!({"ok": false, "error": CLI_MISSING}) };
        let request = meta::RewindRequest { session_id: r.session_id, user_message_id: r.user_message_id, cwd: nonempty(&r.cwd).map(PathBuf::from), dry_run: r.dry_run.unwrap_or(false) };
        meta::rewind(self.inner.launcher.as_ref(), cli, env, request).await
    }

    /// Models, commands or usage limits, as the profile's CLI reports them.
    pub async fn catalog(&self, kind: Catalog, profile_id: Option<String>, cwd: Option<String>) -> Result<Value, String> {
        let env = self.environment(profile_id.clone()).await?;
        let cli = self.inner.profiles.command(profile_id.as_deref()).await.ok_or(CLI_MISSING)?;
        meta::catalog(self.inner.launcher.as_ref(), cli, env, kind, nonempty(&cwd).map(PathBuf::from)).await
    }

    /// `git:aiCommitMessage`'s generation with the terminal account and Haiku.
    pub async fn commit_message(&self, cwd: PathBuf, prompt: String) -> Result<String, String> {
        let env = self.environment(None).await?;
        let cli = self.inner.profiles.command(None).await.ok_or(CLI_MISSING)?;
        meta::commit_message(cli, env, cwd, prompt).await
    }
}
