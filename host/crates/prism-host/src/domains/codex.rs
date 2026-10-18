//! `codex.*`: Codex chats and reads through `codex app-server`
//! (prism_agents::codex), in place of src/main/ipc/nativeCodex.ts and the
//! Codex parts of agentModels, agentCommands and providerUsage.
//!
//! Calls: `send`, `abort`, `permission`, `question` (a chat's turn, owned by
//! the client that sent it), `models`, `skills`, `details`, `reset` and
//! `profileChanged`. Notifications to the owner: `codex.event` (a
//! `CodexEvent`), `codex.permission` and `codex.question` (the payloads of
//! `agent:permission` / `agent:question`).

use std::path::PathBuf;
use std::sync::Arc;

use prism_agents::codex::{CodexError, CodexErrorKind, CodexEvent, CodexQueries, CodexSend, CodexSessions, CodexSink, Launcher, ProfileLauncher};
use prism_agents::profile_env::{ElectronProfiles, Profiles};
use prism_protocol::{ErrorCode, HostError};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::domain::{CallContext, ClientId, Domain, HandlerFuture, Notifier, params};

pub struct CodexDomain {
    sessions: Arc<CodexSessions>,
    queries: Arc<CodexQueries>,
}

impl CodexDomain {
    /// Profiles read in place from the Electron app's store (a host built
    /// without the host's own profiles: tests).
    pub fn new() -> Self {
        Self::with_profiles(Profiles::new(Arc::new(ElectronProfiles::new(app_user_data()))))
    }

    /// The host's profiles (T08: the host owns them).
    pub fn with_profiles(profiles: Profiles) -> Self {
        Self::with_launcher(Arc::new(ProfileLauncher::new(profiles)))
    }

    /// The one-shot reads (catalog, skills, limits, reset), shared with the accounts (T08).
    pub fn queries(&self) -> Arc<CodexQueries> {
        Arc::clone(&self.queries)
    }

    pub fn with_launcher(launcher: Arc<dyn Launcher>) -> Self {
        Self { sessions: CodexSessions::new(Arc::clone(&launcher)), queries: CodexQueries::new(launcher) }
    }

    /// The conversations, shared with the chats engine (T07).
    pub fn sessions(&self) -> Arc<CodexSessions> {
        Arc::clone(&self.sessions)
    }
}

impl Default for CodexDomain {
    fn default() -> Self {
        Self::new()
    }
}

/// The Electron app's userData (`paths::electron_user_data`), else its default.
fn app_user_data() -> PathBuf {
    crate::paths::electron_user_data().unwrap_or_else(ElectronProfiles::default_user_data)
}

struct NotifierSink(Notifier);

impl CodexSink for NotifierSink {
    fn event(&self, event: &CodexEvent) {
        self.0.send("codex.event", json!(event));
    }

    fn permission(&self, payload: Value) {
        self.0.send("codex.permission", payload);
    }

    fn question(&self, payload: Value) {
        self.0.send("codex.question", payload);
    }
}

fn host_error(err: CodexError) -> HostError {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatParams {
    chat_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionParams {
    chat_id: String,
    request_id: String,
    decision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestionParams {
    chat_id: String,
    request_id: String,
    #[serde(default)]
    answers: Option<Map<String, Value>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileParams {
    profile_id: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    refresh: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetParams {
    #[serde(default)]
    profile_id: Value,
    #[serde(default)]
    idempotency_key: Value,
    #[serde(default)]
    credit_id: Value,
}

fn ok() -> Value {
    json!({})
}

impl Domain for CodexDomain {
    fn name(&self) -> &'static str {
        "codex"
    }

    fn call(&self, method: &str, value: Value, ctx: CallContext) -> Option<HandlerFuture> {
        let owner = ctx.notifier.client;
        match method {
            "send" => {
                let payload: CodexSend = match serde_json::from_value(value) {
                    Ok(payload) => payload,
                    Err(_) => return Some(Box::pin(async { Err(HostError::new(ErrorCode::Invalid, "Mensagem Codex inválida.")) })),
                };
                // Claimed here, in arrival order, so an abort sent right after finds the turn.
                let hold: prism_agents::codex::Hold = Box::new(ctx.state.activity.hold());
                let accepted = self.sessions.send(owner, Arc::new(NotifierSink(ctx.notifier.clone())), payload, Some(hold));
                Some(Box::pin(async move { accepted.await.map(|()| ok()).map_err(host_error) }))
            }
            "steer" => {
                let sessions = Arc::clone(&self.sessions);
                Some(Box::pin(async move {
                    let p: prism_protocol::chats::SteerParams = params(value)?;
                    let text = p.context.filter(|s| !s.is_empty()).map_or_else(|| p.text.clone(), |c| format!("{}\n\n{c}", p.text));
                    let images: Vec<Value> = p.images.unwrap_or_default().iter().map(|i| serde_json::to_value(i).unwrap()).collect();
                    sessions.steer(owner, &p.chat_id, &p.turn_id, text, images).await.map_err(|e| HostError::new(ErrorCode::Invalid, e))?;
                    Ok(ok())
                }))
            }
            "abort" => {
                let result = params::<ChatParams>(value).map(|p| {
                    self.sessions.abort(owner, &p.chat_id);
                    ok()
                });
                Some(Box::pin(async move { result }))
            }
            "permission" => {
                let result = params::<PermissionParams>(value).map(|p| {
                    self.sessions.permission(owner, &p.chat_id, &p.request_id, &p.decision);
                    ok()
                });
                Some(Box::pin(async move { result }))
            }
            "question" => {
                let result = params::<QuestionParams>(value).map(|p| {
                    self.sessions.question(owner, &p.chat_id, &p.request_id, p.answers.as_ref());
                    ok()
                });
                Some(Box::pin(async move { result }))
            }
            "profileChanged" => {
                let result = params::<ProfileParams>(value).map(|p| {
                    self.sessions.profile_changed(&p.profile_id);
                    self.queries.forget(&p.profile_id);
                    ok()
                });
                Some(Box::pin(async move { result }))
            }
            "models" | "skills" | "details" => {
                let queries = Arc::clone(&self.queries);
                let method = method.to_string();
                Some(Box::pin(async move {
                    let p = params::<ProfileParams>(value)?;
                    let result = match method.as_str() {
                        "models" => queries.models(&p.profile_id, p.refresh).await,
                        "skills" => queries.skills(&p.profile_id, &p.cwd, p.refresh).await,
                        _ => queries.details(&p.profile_id, p.refresh).await,
                    };
                    result.map_err(host_error)
                }))
            }
            // Spends a real Codex manual reset: the UI only sends it from the confirmed dialog.
            "reset" => {
                let queries = Arc::clone(&self.queries);
                Some(Box::pin(async move {
                    let p = params::<ResetParams>(value)?;
                    let outcome = queries.reset(&p.profile_id, &p.idempotency_key, &p.credit_id).await.map_err(host_error)?;
                    Ok(json!({ "outcome": outcome }))
                }))
            }
            _ => None,
        }
    }

    fn disconnected(&self, client: ClientId) {
        self.sessions.close_owner(client);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HostState;
    use crate::domain::next_client_id;
    use prism_agents::codex::{AppServer, BoxFuture};
    use prism_protocol::{Role, UserInfo};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::sync::mpsc;

    /// An app-server that starts a thread and a turn, asks one approval and
    /// completes the turn once the approval is answered.
    struct Scripted;

    impl Launcher for Scripted {
        fn check(&self, profile_id: String) -> BoxFuture<'_, Result<(), CodexError>> {
            Box::pin(async move {
                if profile_id == "missing" { Err(CodexError::new(CodexErrorKind::NotFound, "Conta não encontrada para este agente. Selecione outra conta.")) } else { Ok(()) }
            })
        }

        fn account(&self, _profile_id: String) -> BoxFuture<'_, Result<String, CodexError>> {
            Box::pin(async { Ok("ambient".to_string()) })
        }

        fn launch(&self, _profile_id: String, _cwd: Option<String>) -> BoxFuture<'_, Result<Arc<AppServer>, CodexError>> {
            Box::pin(async {
                let (client, server) = tokio::io::duplex(1 << 16);
                let (read, write) = tokio::io::split(client);
                let app = AppServer::from_io(read, write);
                tokio::spawn(async move {
                    let (server_read, mut server_write) = tokio::io::split(server);
                    let mut lines = BufReader::new(server_read).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let msg: Value = serde_json::from_str(&line).unwrap();
                        let replies = match (msg.get("method").and_then(Value::as_str), msg.get("id")) {
                            (Some("initialize"), Some(id)) => vec![json!({ "id": id, "result": {} })],
                            (Some("thread/start"), Some(id)) => vec![json!({ "id": id, "result": { "thread": { "id": "th" } } })],
                            (Some("turn/start"), Some(id)) => vec![
                                json!({ "id": id, "result": { "turn": { "id": "t1" } } }),
                                json!({ "id": 7, "method": "item/commandExecution/requestApproval", "params": { "threadId": "th", "turnId": "t1", "itemId": "c", "command": "ls" } }),
                            ],
                            (None, Some(_)) => vec![json!({ "method": "turn/completed", "params": { "threadId": "th", "turn": { "id": "t1", "status": "completed" } } })],
                            _ => vec![],
                        };
                        for reply in replies {
                            server_write.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
                        }
                    }
                });
                Ok(app)
            })
        }
    }

    struct Client {
        ctx: CallContext,
        notes: mpsc::UnboundedReceiver<String>,
    }

    fn client(state: &Arc<HostState>) -> Client {
        let (tx, notes) = mpsc::unbounded_channel();
        let ctx = CallContext {
            user: UserInfo { id: "owner".into(), name: "qa".into(), role: Role::Owner },
            notifier: Notifier::new(next_client_id(), tx),
            state: Arc::clone(state),
        };
        Client { ctx, notes }
    }

    impl Client {
        async fn note(&mut self) -> (String, Value) {
            let text = tokio::time::timeout(std::time::Duration::from_secs(10), self.notes.recv()).await.unwrap().unwrap();
            let note: Value = serde_json::from_str(&text).unwrap();
            (note["method"].as_str().unwrap().to_string(), note["params"].clone())
        }
    }

    fn send_params(id: &str, profile: &str) -> Value {
        json!({ "id": id, "chatId": "chat", "prompt": "oi", "cwd": "", "selection": { "provider": "codex", "profileId": profile, "model": "", "permissionMode": "default" }, "chat": { "id": "chat" } })
    }

    #[tokio::test]
    async fn a_turn_streams_to_its_owner_and_holds_the_host_while_it_runs() {
        let state = HostState::with_domains("t".into(), "h".into(), "Máquina".into(), "qa".into(), Vec::new());
        let domain = CodexDomain::with_launcher(Arc::new(Scripted));
        let mut owner = client(&state);
        let sent = domain.call("send", send_params("turn-1", "ambient-codex"), owner.ctx.clone()).unwrap().await.unwrap();
        assert_eq!(sent, json!({}));
        assert_eq!(state.activity.holds(), 1, "a running turn keeps the host alive");
        assert_eq!(owner.note().await, ("codex.event".to_string(), json!({ "id": "turn-1", "kind": "session", "sessionId": "th" })));
        let (method, permission) = owner.note().await;
        assert_eq!(method, "codex.permission");
        assert_eq!(permission["permId"], "codex:chat:7");
        assert_eq!(permission["toolName"], "Bash");

        // Another client cannot answer; the owner can.
        let stranger = client(&state);
        let answer = json!({ "chatId": "chat", "requestId": "codex:chat:7", "decision": "allow" });
        domain.call("permission", answer.clone(), stranger.ctx.clone()).unwrap().await.unwrap();
        domain.call("permission", answer, owner.ctx.clone()).unwrap().await.unwrap();
        assert_eq!(owner.note().await, ("codex.event".to_string(), json!({ "id": "turn-1", "kind": "done", "aborted": false })));
        assert_eq!(state.activity.holds(), 0);

        // The process stays for the next turn; the owner leaving closes it.
        domain.disconnected(owner.ctx.notifier.client);
        assert!(domain.call("nope", Value::Null, owner.ctx.clone()).is_none());
    }

    #[tokio::test]
    async fn refused_sends_answer_with_stable_codes() {
        let state = HostState::with_domains("t".into(), "h".into(), "Máquina".into(), "qa".into(), Vec::new());
        let domain = CodexDomain::with_launcher(Arc::new(Scripted));
        let owner = client(&state);
        let invalid = domain.call("send", json!({ "id": 5 }), owner.ctx.clone()).unwrap().await.unwrap_err();
        assert_eq!((invalid.code, invalid.message.as_str()), (ErrorCode::Invalid, "Mensagem Codex inválida."));
        let missing = domain.call("send", send_params("x", "missing"), owner.ctx.clone()).unwrap().await.unwrap_err();
        assert_eq!(missing.code, ErrorCode::NotFound);
        assert_eq!(state.activity.holds(), 0, "a refused send holds nothing");
        let bad_reset = domain.call("reset", json!({ "profileId": "p", "idempotencyKey": "x" }), owner.ctx.clone()).unwrap().await.unwrap_err();
        assert_eq!((bad_reset.code, bad_reset.message.as_str()), (ErrorCode::Invalid, "Chave de idempotência inválida."));
        let bad_abort = domain.call("abort", json!({}), owner.ctx.clone()).unwrap().await.unwrap_err();
        assert_eq!(bad_abort.code, ErrorCode::Invalid);
    }
}
