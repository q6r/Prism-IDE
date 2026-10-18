//! `claude.*`: Claude Code chats over the CLI's native protocol
//! (prism_agents::claude), in place of src/main/ipc/claudeAgent.ts and the
//! Claude parts of agentModels, agentCommands and providerUsage.
//!
//! Calls: `send` (answers `{ started }`), `abort`, `interrupt`, `end`,
//! `permissionResponse`, `questionResponse` (owned by the client that sent the
//! turn), `available`, `checkpointIds`, `fork`, `rewind`, `models`,
//! `commands`, `usage`, `profileChanged`, `commitMessage`. Notification to the
//! owner: `claude.event` `{ channel, data }`, where channel/data are exactly
//! the `agent:*` IPC events the renderer consumes.
//!
//! `PRISM_CLAUDE_ENGINE=sdk` keeps the domain off (the UI then stays on the
//! TypeScript SDK backend), until the host owns the chats (T07).

use std::path::PathBuf;
use std::sync::Arc;

use prism_agents::claude::{Catalog, ClaudeAgents, Emitter, PermissionReply, ProcessLauncher, QuestionReply, RewindParams, SendPayload};
use prism_agents::profile_env::{ElectronProfiles, Profiles};
use prism_protocol::{ErrorCode, HostError};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::domain::{CallContext, ClientId, Domain, HandlerFuture, params};
use crate::domains::git::git;

pub struct ClaudeDomain {
    agents: ClaudeAgents,
}

impl ClaudeDomain {
    /// Profiles read in place from the Electron app's store (a host built
    /// without the host's own profiles: tests).
    pub fn new() -> Self {
        Self::with_profiles(Profiles::new(Arc::new(ElectronProfiles::new(app_user_data()))))
    }

    /// The host's profiles (T08: the host owns them).
    pub fn with_profiles(profiles: Profiles) -> Self {
        Self { agents: ClaudeAgents::new(Arc::new(profiles), Arc::new(ProcessLauncher)) }
    }

    /// Off when `PRISM_CLAUDE_ENGINE=sdk` asks for the TypeScript backend.
    pub fn enabled() -> bool {
        std::env::var("PRISM_CLAUDE_ENGINE").map(|v| !v.eq_ignore_ascii_case("sdk")).unwrap_or(true)
    }

    pub fn agents(&self) -> &ClaudeAgents {
        &self.agents
    }
}

impl Default for ClaudeDomain {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ClaudeDomain {
    fn drop(&mut self) {
        self.agents.shutdown();
    }
}

/// The Electron app's userData, where its profiles live
/// (`paths::electron_user_data`), else Electron's default.
fn app_user_data() -> PathBuf {
    crate::paths::electron_user_data().unwrap_or_else(ElectronProfiles::default_user_data)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnParams {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatParams {
    chat_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionParams {
    session_id: String,
    #[serde(default)]
    profile_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkParams {
    session_id: String,
    up_to_message_id: String,
    #[serde(default)]
    profile_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogParams {
    #[serde(default)]
    profile_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileParams {
    profile_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitParams {
    root: String,
}

const COMMIT_PROMPT: &str = "Escreva uma mensagem de commit git concisa para este diff. Use uma linha de título \
    no imperativo (máx. ~70 caracteres); adicione poucos bullet points só se a mudança \
    for não-trivial. Responda APENAS com a mensagem do commit, sem aspas, sem preâmbulo, \
    sem blocos de código.\n\n";

/// `git:aiCommitMessage` (src/main/ipc/git.ts): the staged diff, else the
/// diff against HEAD, else the working tree, plus untracked names, summarized
/// by Haiku with the terminal account.
async fn commit_message(agents: &ClaudeAgents, root: &str) -> Value {
    let mut diff = git(root, &["diff", "--staged"]).await.stdout;
    if diff.trim().is_empty() {
        diff = git(root, &["diff", "HEAD"]).await.stdout;
    }
    if diff.trim().is_empty() {
        diff = git(root, &["diff"]).await.stdout;
    }
    let untracked = git(root, &["ls-files", "--others", "--exclude-standard"]).await.stdout;
    if !untracked.trim().is_empty() {
        diff.push_str(&format!("\n\n# Novos arquivos (não rastreados):\n{}", untracked.trim()));
    }
    if diff.trim().is_empty() {
        return json!({"ok": false, "error": "Sem alterações para resumir."});
    }
    // `diff.slice(0, 12000)`: UTF-16 units in the TS, characters here.
    let prompt = format!("{COMMIT_PROMPT}{}", diff.chars().take(12000).collect::<String>());
    match agents.commit_message(PathBuf::from(root), prompt).await {
        Ok(message) => json!({"ok": true, "message": message}),
        Err(error) => json!({"ok": false, "error": error}),
    }
}

fn ok() -> Value {
    json!({})
}

fn failed(message: String) -> HostError {
    HostError::new(ErrorCode::Internal, message)
}

impl Domain for ClaudeDomain {
    fn name(&self) -> &'static str {
        "claude"
    }

    fn call(&self, method: &str, value: Value, ctx: CallContext) -> Option<HandlerFuture> {
        let agents = self.agents.clone();
        let client = ctx.notifier.client;
        Some(match method {
            "send" => Box::pin(async move {
                let payload: SendPayload = params(value)?;
                let notifier = ctx.notifier.clone();
                let emit: Emitter = Arc::new(move |channel: &str, data: Value| {
                    notifier.send("claude.event", json!({"channel": channel, "data": data}));
                });
                let started = agents.send(client, emit, payload).await;
                Ok(json!({"started": started}))
            }),
            "steer" => Box::pin(async move {
                let p: prism_protocol::chats::SteerParams = params(value)?;
                let text = p.context.filter(|s| !s.is_empty()).map_or_else(|| p.text.clone(), |c| format!("{}\n\n{c}", p.text));
                let images: Vec<Value> = p.images.unwrap_or_default().iter().map(|i| serde_json::to_value(i).unwrap()).collect();
                agents.steer(client, &p.turn_id, &text, &images).map_err(failed)?;
                Ok(ok())
            }),
            "abort" => Box::pin(async move {
                let p: TurnParams = params(value)?;
                agents.abort(client, &p.id);
                Ok(ok())
            }),
            "interrupt" => Box::pin(async move {
                let p: ChatParams = params(value)?;
                agents.interrupt(&p.chat_id);
                Ok(ok())
            }),
            "end" => Box::pin(async move {
                let p: ChatParams = params(value)?;
                agents.end(&p.chat_id);
                Ok(ok())
            }),
            "permissionResponse" => Box::pin(async move {
                agents.respond_permission(client, params::<PermissionReply>(value)?);
                Ok(ok())
            }),
            "questionResponse" => Box::pin(async move {
                agents.respond_question(client, params::<QuestionReply>(value)?);
                Ok(ok())
            }),
            "available" => Box::pin(async move { Ok(agents.available().await) }),
            "checkpointIds" => Box::pin(async move {
                let p: SessionParams = params(value)?;
                Ok(json!(agents.checkpoint_ids(&p.session_id, p.profile_id).await))
            }),
            "fork" => Box::pin(async move {
                let p: ForkParams = params(value)?;
                Ok(agents.fork(&p.session_id, &p.up_to_message_id, p.profile_id).await)
            }),
            "rewind" => Box::pin(async move { Ok(agents.rewind(params::<RewindParams>(value)?).await) }),
            "models" | "commands" | "usage" => {
                let kind = match method {
                    "models" => Catalog::Models,
                    "commands" => Catalog::Commands,
                    _ => Catalog::Usage,
                };
                Box::pin(async move {
                    let p: CatalogParams = params(value)?;
                    agents.catalog(kind, p.profile_id, p.cwd).await.map_err(failed)
                })
            }
            "profileChanged" => Box::pin(async move {
                let p: ProfileParams = params(value)?;
                agents.profile_changed(&p.profile_id);
                Ok(ok())
            }),
            "commitMessage" => Box::pin(async move {
                let p: CommitParams = params(value)?;
                Ok(commit_message(&agents, &p.root).await)
            }),
            _ => return None,
        })
    }

    /// The window that ran these chats is gone: they end with it, as before.
    fn disconnected(&self, client: ClientId) {
        self.agents.client_gone(client);
    }
}
