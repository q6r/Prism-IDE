//! `chats.*`: the host owns the agent chats (T07). Plan:
//! `prism-rust-host/tickets/t07-host-dono-dos-chats/desenho` in the Traycer
//! epic; contract in `prism_protocol::chats`.
//!
//! One engine (an actor on a thread of its own) holds every command, every
//! provider event and every subscription in one order: it starts turns on
//! Claude or Codex (sessions owned by the engine, not by a connection, so a
//! turn outlives the window), records what they report in the journal and
//! publishes each change to the subscribers as `chats.delta`. The renderer's
//! `send`/`finish`/`editTurn` live here now.

mod engine;
pub(crate) mod image_references;
mod port;
mod presentation;
mod runners;
#[cfg(test)]
mod tests;

use std::future::Future;
use std::pin::Pin;
use std::sync::mpsc::Sender;
use std::sync::{Arc, OnceLock};

use prism_protocol::chats::{methods, ChatRuntime};
use prism_protocol::{ErrorCode, HostError, UserInfo};
use serde_json::{Map, Value};
use tokio::sync::oneshot;

use crate::activity::Activity;
use crate::domain::{CallContext, ClientId, Domain, HandlerFuture, Notifier};
use crate::domains::store::SharedStore;

pub use runners::{ClaudeRunner, CodexRunner};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// What a provider reports about a running turn, from Claude's `agent:*`
/// events or Codex's `CodexEvent`s and prompts.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnEvent {
    /// Native child activity, owned by the root turn that spawned it.
    Subagent(Value),
    /// The native session to resume next time.
    Session(String),
    /// Whether Fast serves the session (`fastModeOf`).
    Fast { state: String, reason: Option<String> },
    Text(String),
    Thinking(String),
    /// A Claude tool call starts (a `running` tool segment).
    Tool { tool_id: String, name: Value, input: Option<Value> },
    /// A Claude tool call's result.
    ToolResult { tool_id: String, content: Option<Value>, is_error: bool },
    /// A whole segment (Codex sends each item as a snapshot).
    Segment(Value),
    /// The `agent:permission` payload.
    Permission(Value),
    /// The `agent:question` payload.
    Question(Value),
    /// The turn's `RunMetrics`.
    Metrics(Value),
    Done { aborted: bool },
    /// Why the turn is about to fail (`cli_auth`: the login is gone), ahead
    /// of its `Error`; kept as the turn's `errorCode`.
    ErrorCode(String),
    Error(String),
}

/// Where one running turn reports. Events of other turns are the sender's
/// to filter out.
#[derive(Clone)]
pub struct TurnSink {
    tx: Sender<Msg>,
    pub chat_id: String,
    pub turn_id: String,
}

impl TurnSink {
    pub fn send_to_turn(&self, origin: &str, event: TurnEvent) {
        let _ = self.tx.send(Msg::Turn { chat_id: self.chat_id.clone(), turn_id: origin.to_string(), event });
    }
    pub fn send(&self, event: TurnEvent) {
        let _ = self.tx.send(Msg::Turn { chat_id: self.chat_id.clone(), turn_id: self.turn_id.clone(), event });
    }
}

impl std::fmt::Debug for TurnSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TurnSink").field("chat_id", &self.chat_id).field("turn_id", &self.turn_id).finish()
    }
}

/// What a provider needs to run one turn of a chat.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnStart {
    pub chat_id: String,
    pub turn_id: String,
    pub prompt: String,
    pub images: Vec<Value>,
    pub cwd: String,
    /// The native session to continue (same route), if any.
    pub resume: Option<String>,
    /// The chat's `AgentSelection`.
    pub selection: Value,
    /// The tier this turn may use (the client's catalog decides, until T08).
    pub service_tier: Option<String>,
}

/// A provider the engine runs turns on.
pub trait Runner: Send + Sync + 'static {
    /// Starts the turn; its events go to `sink`. `Err` (pt-BR) means it was
    /// refused before starting and reported nothing.
    fn start(&self, turn: TurnStart, sink: TurnSink) -> BoxFuture<Result<(), String>>;
    fn abort(&self, chat_id: &str, turn_id: &str);
    fn configure(&self, _chat_id: &str, _selection: &Value) {}
    fn steer(&self, _chat_id: String, _turn_id: String, _text: String, _images: Vec<Value>) -> BoxFuture<Result<(), String>> {
        Box::pin(async { Err("Este provedor não suporta envio durante o turno.".into()) })
    }
    fn message_subagent(&self, _root_chat: String, _root_turn: String, _agent_id: String, _text: String) -> BoxFuture<Result<Value, String>> {
        Box::pin(async { Err("Este provedor não suporta mensagens para subagentes.".into()) })
    }
    /// `decision`: `allow`, `allow_always` or `deny`.
    fn permission(&self, chat_id: &str, turn_id: &str, perm_id: &str, decision: &str, updated_input: Option<Value>);
    /// `answers` maps question text to the chosen answer; `None` cancels.
    fn question(&self, chat_id: &str, turn_id: &str, dialog_id: &str, answers: Option<Map<String, Value>>, response: Option<String>);
}

/// The providers this host runs (`claude` is off with `PRISM_CLAUDE_ENGINE=sdk`).
#[derive(Clone, Default)]
pub struct Runners {
    pub claude: Option<Arc<dyn Runner>>,
    pub codex: Option<Arc<dyn Runner>>,
}

impl Runners {
    fn get(&self, provider: &str) -> Option<&Arc<dyn Runner>> {
        match provider {
            "claude" => self.claude.as_ref(),
            "codex" => self.codex.as_ref(),
            _ => None,
        }
    }
}

/// What an account change does to the chats before its own work runs
/// (`ChatsDomain::exclusive`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hold {
    /// Nothing besides the work (the account is turned off).
    Nothing,
    /// The chats resuming the account's native sessions start new ones (its
    /// login changes).
    ForgetSessions,
    /// The account's chats move to its provider's terminal account (it is
    /// removed).
    Reassign,
}

/// An account change, run on the engine's thread.
pub type ExclusiveWork = Box<dyn FnOnce() -> Result<(), HostError> + Send>;

/// What one batch of the engine changed, for the host's own watchers
/// (`ChatsDomain::watch`): remote control follows its shared chats with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatChange {
    /// The chat, one of its turns or its runtime changed.
    Changed(String),
    /// The chat was archived.
    Archived(String),
    Removed(String),
}

impl ChatChange {
    pub fn chat_id(&self) -> &str {
        match self {
            ChatChange::Changed(id) | ChatChange::Archived(id) | ChatChange::Removed(id) => id,
        }
    }
}

/// A chat as the engine has it now, folded, with its runtime
/// (`ChatsDomain::peek`): `Ok(None)` when it does not exist, `Err` when it
/// could not be read.
pub type Peeked = Result<Option<(Value, Option<ChatRuntime>)>, HostError>;

/// The client the host's own commands come from (`ChatsDomain::command`).
pub const INTERNAL_CLIENT: ClientId = u64::MAX - 1;

pub(crate) enum Msg {
    Call {
        method: String,
        params: Value,
        user: UserInfo,
        client: ClientId,
        notifier: Notifier,
        activity: Arc<Activity>,
        reply: oneshot::Sender<Result<Value, HostError>>,
    },
    /// `ChatsDomain::exclusive`.
    Exclusive {
        provider: String,
        profile_id: String,
        refusal: String,
        hold: Hold,
        work: ExclusiveWork,
        reply: oneshot::Sender<Result<(), HostError>>,
    },
    /// `ChatsDomain::watch`.
    Watch(tokio::sync::mpsc::UnboundedSender<Vec<ChatChange>>),
    /// `ChatsDomain::peek`.
    Peek { chat_id: String, reply: oneshot::Sender<Peeked> },
    Turn {
        chat_id: String,
        turn_id: String,
        event: TurnEvent,
    },
    /// A provider accepted (or refused) a turn the engine started.
    Started {
        chat_id: String,
        turn_id: String,
        result: Result<(), String>,
    },
    Steered {
        queue_id: Option<String>,
        chat_id: String,
        turn_id: String,
        segment: Value,
        actor: String,
        result: Result<(), String>,
        reply: oneshot::Sender<Result<Value, HostError>>,
    },
    SubagentMessaged {
        chat_id: String,
        turn_id: String,
        text: String,
        actor: String,
        result: Result<Value, String>,
        reply: oneshot::Sender<Result<Value, HostError>>,
    },
    Disconnected(ClientId),
}

const METHODS: &[&str] = &[
    methods::SUBSCRIBE,
    methods::UNSUBSCRIBE,
    methods::LIST,
    methods::LOAD_HISTORY,
    methods::CREATE,
    methods::PUT,
    methods::FLUSH,
    methods::IMPORT_DOCS,
    methods::CONFIGURE,
    methods::CONFIRM_ACCOUNT,
    methods::BIND_WORKSPACE,
    methods::CHANGE_WORKING_DIRECTORY,
    methods::RENAME,
    methods::ARCHIVE,
    methods::SET_TASK,
    methods::REMOVE,
    methods::REASSIGN_PROFILE,
    methods::SEND,
    methods::STOP,
    methods::STEER,
    methods::MESSAGE_SUBAGENT,
    methods::QUEUE,
    methods::RESPOND_PERMISSION,
    methods::RESPOND_QUESTION,
    methods::BUSY_PROFILES,
    methods::FORGET_SESSIONS,
];

pub struct ChatsDomain {
    store: Arc<SharedStore>,
    runners: Runners,
    /// Started on the first call (it needs the runtime to start turns on).
    engine: OnceLock<Sender<Msg>>,
}

impl ChatsDomain {
    pub fn new(store: Arc<SharedStore>, runners: Runners) -> Self {
        Self { store, runners, engine: OnceLock::new() }
    }

    fn engine(&self) -> &Sender<Msg> {
        self.engine.get_or_init(|| engine::start(Arc::clone(&self.store), self.runners.clone(), tokio::runtime::Handle::current()))
    }

    /// Runs `work` (a change to an account: its login, its enabled state, its
    /// removal) on the engine's thread, after `hold`, while no turn runs on
    /// `provider:profile_id`. No turn can start on it in between: the engine
    /// handles one message at a time. `busy` with `refusal` while one runs.
    pub fn exclusive(
        &self,
        provider: &str,
        profile_id: &str,
        refusal: impl Into<String>,
        hold: Hold,
        work: impl FnOnce() -> Result<(), HostError> + Send + 'static,
    ) -> impl Future<Output = Result<(), HostError>> + Send + 'static {
        let (reply, answer) = oneshot::channel();
        let sent = self.engine().send(Msg::Exclusive {
            provider: provider.to_string(),
            profile_id: profile_id.to_string(),
            refusal: refusal.into(),
            hold,
            work: Box::new(work),
            reply,
        });
        async move {
            if sent.is_err() {
                return Err(stopped());
            }
            answer.await.unwrap_or_else(|_| Err(stopped()))
        }
    }

    /// What every later batch changes, as it is published.
    pub fn watch(&self) -> tokio::sync::mpsc::UnboundedReceiver<Vec<ChatChange>> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let _ = self.engine().send(Msg::Watch(tx));
        rx
    }

    /// The chat folded with everything journaled so far, and its runtime.
    pub fn peek(&self, chat_id: &str) -> impl Future<Output = Peeked> + Send + 'static {
        let (reply, answer) = oneshot::channel();
        let sent = self.engine().send(Msg::Peek { chat_id: chat_id.to_string(), reply });
        async move {
            if sent.is_err() {
                return Err(stopped());
            }
            answer.await.unwrap_or_else(|_| Err(stopped()))
        }
    }

    /// Whether this host runs `provider`'s turns (Claude is off with
    /// `PRISM_CLAUDE_ENGINE=sdk`).
    pub fn runs(&self, provider: &str) -> bool {
        self.runners.get(provider).is_some()
    }

    /// Runs `chats.<method>` for the host itself (a phone's command) as
    /// `user`, the journal's actor, in line with every other command.
    pub fn command(&self, method: &str, params: Value, user: UserInfo, activity: Arc<Activity>) -> impl Future<Output = Result<Value, HostError>> + Send + 'static {
        let (reply, answer) = oneshot::channel();
        // Nobody listens: the host's own calls never subscribe.
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let sent = self.engine().send(Msg::Call {
            method: method.to_string(),
            params,
            user,
            client: INTERNAL_CLIENT,
            notifier: Notifier::new(INTERNAL_CLIENT, tx),
            activity,
            reply,
        });
        async move {
            if sent.is_err() {
                return Err(stopped());
            }
            answer.await.unwrap_or_else(|_| Err(stopped()))
        }
    }
}

fn stopped() -> HostError {
    HostError::new(ErrorCode::Internal, "O motor de chats do host parou.")
}

impl Domain for ChatsDomain {
    fn features(&self) -> &'static [&'static str] { &["chats.queue@1", "chats.subagents.message@1", "chats.history@1", "chats.working-directory@1"] }
    fn name(&self) -> &'static str {
        "chats"
    }

    fn call(&self, method: &str, params: Value, ctx: CallContext) -> Option<HandlerFuture> {
        if !METHODS.contains(&method) {
            return None;
        }
        let (reply, answer) = oneshot::channel();
        let sent = self.engine().send(Msg::Call {
            method: method.to_string(),
            params,
            user: ctx.user,
            client: ctx.notifier.client,
            notifier: ctx.notifier,
            activity: Arc::clone(&ctx.state.activity),
            reply,
        });
        Some(Box::pin(async move {
            if sent.is_err() {
                return Err(stopped());
            }
            answer.await.unwrap_or_else(|_| Err(stopped()))
        }))
    }

    fn disconnected(&self, client: ClientId) {
        if let Some(engine) = self.engine.get() {
            let _ = engine.send(Msg::Disconnected(client));
        }
    }
}
