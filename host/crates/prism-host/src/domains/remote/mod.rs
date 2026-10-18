//! `remote.*` (T09): remote control from a phone, on the host. Plan:
//! `prism-rust-host/tickets/t09-controle-remoto/desenho` in the Traycer epic;
//! contract in `prism_protocol::remote`.
//!
//! One actor (a task) holds the shared chats: their tokens, the phones on
//! each link, the last snapshot each phone has, the page's server and the
//! tunnel. The chats engine tells it which chats a batch changed; a shared
//! chat is read again (`ChatsDomain::peek`) at most every `THROTTLE` and its
//! phones get only what changed. A phone's command is decided as the
//! renderer decided it (`model::decide`) and run by the engine, in line with
//! every other command, as `celular · <chat>`. Nothing here depends on a
//! window: sharing goes on with the app closed, and the host stays up while
//! a chat is shared.

pub mod model;
mod server;
mod assets;
pub mod tunnel;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use prism_protocol::chats::{methods as chat_methods, ChatRuntime};
use prism_protocol::remote::{methods, RemoteStatus, RemoteStopReason, ShareParams, ShareResult, SharedChat};
use prism_protocol::{ErrorCode, HostError, OkResult, Role, UserInfo};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, oneshot};

use self::model::{ChatGrants, PhoneCommand, TurnCache};
use self::tunnel::{OpenTunnel, Tunnels};
use crate::activity::{Activity, ActivityGuard};
use crate::domain::{params, CallContext, ClientId, Domain, HandlerFuture, Notifier};
use crate::domains::chats::{ChatChange, ChatsDomain, Peeked};
use crate::domains::providers::profiles::public_list;
use crate::domains::providers::{Catalogs, HostProfiles};

const METHODS: &[&str] = &[methods::SHARE, methods::UNSHARE, methods::STOP, methods::STATUS];

/// A shared chat is read again at most this often (the renderer's bridge
/// throttled its pushes the same).
const THROTTLE: Duration = Duration::from_millis(160);

/// How long the tunnel stays after the phones were told it all stopped, for
/// that message to reach them.
const LAST_WORD: Duration = Duration::from_secs(2);

/// A shared chat that could not be read is tried again after this.
const READ_RETRY: Duration = Duration::from_secs(1);

/// What the domain works with (`domains::all`).
pub struct RemoteParts {
    pub chats: Arc<ChatsDomain>,
    pub catalogs: Arc<Catalogs>,
    pub host_profiles: Arc<HostProfiles>,
    pub tunnels: Arc<dyn Tunnels>,
}

pub struct RemoteDomain {
    deps: Arc<RemoteParts>,
    /// Started on the first call (it needs the runtime).
    actor: OnceLock<mpsc::UnboundedSender<Msg>>,
}

impl RemoteDomain {
    pub fn new(parts: RemoteParts) -> Self {
        Self { deps: Arc::new(parts), actor: OnceLock::new() }
    }

    fn actor(&self) -> &mpsc::UnboundedSender<Msg> {
        self.actor.get_or_init(|| Actor::start(Arc::clone(&self.deps)))
    }
}

impl Drop for RemoteDomain {
    fn drop(&mut self) {
        if let Some(actor) = self.actor.get() {
            let _ = actor.send(Msg::Shutdown);
        }
    }
}

fn stopped() -> HostError {
    HostError::new(ErrorCode::Internal, "O controle remoto do host parou.")
}

impl Domain for RemoteDomain {
    fn features(&self) -> &'static [&'static str] { &["remote.controls@1"] }
    fn name(&self) -> &'static str {
        "remote"
    }

    fn call(&self, method: &str, value: Value, ctx: CallContext) -> Option<HandlerFuture> {
        if !METHODS.contains(&method) {
            return None;
        }
        let actor = self.actor().clone();
        let method = method.to_string();
        Some(Box::pin(async move {
            // The links are secrets that command the chats.
            if ctx.user.role != Role::Owner {
                return Err(HostError::new(ErrorCode::Forbidden, "Só o dono do host compartilha conversas."));
            }
            let (reply, answer) = oneshot::channel();
            actor.send(Msg::Call { method, params: value, ctx, reply }).map_err(|_| stopped())?;
            answer.await.unwrap_or_else(|_| Err(stopped()))
        }))
    }

    fn disconnected(&self, client: ClientId) {
        if let Some(actor) = self.actor.get() {
            let _ = actor.send(Msg::Disconnected(client));
        }
    }
}

/// What a phone's socket is sent.
enum Outbound {
    Text(String),
    Close,
}

/// The page's server and the tunnel to it, both up.
struct Opened {
    generation: u64,
    server: server::Running,
    tunnel: OpenTunnel,
}

enum Msg {
    Call { method: String, params: Value, ctx: CallContext, reply: oneshot::Sender<Result<Value, HostError>> },
    Disconnected(ClientId),
    Opened(u64, Result<Opened, String>),
    TunnelEnded { generation: u64, reason: String },
    Changes(Vec<ChatChange>),
    Tick(String),
    Snapshot { chat_id: String, peeked: Peeked },
    /// Before a phone's upgrade: is the token a shared chat's?
    PhoneCheck { token: String, reply: oneshot::Sender<bool> },
    /// A phone's socket is up: its id, or `None` when the link died meanwhile.
    PhoneOpen { token: String, tx: mpsc::Sender<Outbound>, reply: oneshot::Sender<Option<u64>> },
    PhoneText { phone: u64, text: String },
    PhoneClosed(u64),
    Shutdown,
}

/// The server and the tunnel while they are up.
struct Up {
    generation: u64,
    base_url: String,
    _server: server::Running,
    /// Dropping it ends the tunnel.
    _tunnel: Box<dyn Send + Sync>,
}

/// One shared chat as its phones have it.
struct Shared {
    title: String,
    /// The last snapshot built (what a newly connected phone gets).
    snapshot: Option<Value>,
    /// Its turns as last sent, for the next delta.
    cache: TurnCache,
    /// The list entry last sent.
    entry: Option<Value>,
    /// A read is scheduled.
    scheduled: bool,
    /// A read is in flight: one at a time, so an older one never lands last.
    reading: bool,
    /// Something changed while it was in flight: read again after it.
    dirty: bool,
    last: Option<Instant>,
    /// Still shared: a command accepted just before a revocation checks it.
    alive: Arc<AtomicBool>,
}

impl Shared {
    fn new(title: String) -> Self {
        Self {
            title,
            snapshot: None,
            cache: TurnCache::new(),
            entry: None,
            scheduled: false,
            reading: false,
            dirty: false,
            last: None,
            alive: Arc::new(AtomicBool::new(true)),
        }
    }
}

struct Phone {
    chat_id: String,
    tx: mpsc::Sender<Outbound>,
    /// A command of this phone is running: one at a time.
    busy: Arc<AtomicBool>,
}

/// What may wait for one phone at once; a phone that falls further behind
/// is dropped (it reconnects and gets the whole chat again).
const PHONE_QUEUE: usize = 256;

struct Actor {
    me: mpsc::UnboundedSender<Msg>,
    deps: Arc<RemoteParts>,
    clients: HashMap<ClientId, Notifier>,
    activity: Option<Arc<Activity>>,
    /// Keeps the host up while a chat is shared.
    hold: Option<ActivityGuard>,
    grants: ChatGrants,
    shared: HashMap<String, Shared>,
    phones: HashMap<u64, Phone>,
    next_phone: u64,
    up: Option<Up>,
    /// The start in flight (its generation, and how to cancel it), and the
    /// shares waiting for it.
    starting: Option<(u64, tokio::task::AbortHandle)>,
    waiting: Vec<(String, oneshot::Sender<Result<Value, HostError>>)>,
    generation: u64,
    watching: bool,
}

impl Actor {
    fn start(deps: Arc<RemoteParts>) -> mpsc::UnboundedSender<Msg> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut actor = Actor {
            me: tx.clone(),
            deps,
            clients: HashMap::new(),
            activity: None,
            hold: None,
            grants: ChatGrants::default(),
            shared: HashMap::new(),
            phones: HashMap::new(),
            next_phone: 1,
            up: None,
            starting: None,
            waiting: Vec::new(),
            generation: 0,
            watching: false,
        };
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if let Msg::Shutdown = msg {
                    actor.stop_all(None);
                    break;
                }
                actor.handle(msg).await;
            }
        });
        tx
    }

    async fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Call { method, params: value, ctx, reply } => {
                self.clients.insert(ctx.notifier.client, ctx.notifier.clone());
                self.activity.get_or_insert_with(|| Arc::clone(&ctx.state.activity));
                match method.as_str() {
                    methods::SHARE => match params::<ShareParams>(value) {
                        Ok(p) => self.share(p.chat_id, reply).await,
                        Err(err) => {
                            let _ = reply.send(Err(err));
                        }
                    },
                    methods::UNSHARE => {
                        let result = params::<ShareParams>(value).map(|p| {
                            self.revoke(&p.chat_id);
                            json!(OkResult { ok: true })
                        });
                        let _ = reply.send(result);
                    }
                    methods::STOP => {
                        self.stop_all(Some(RemoteStopReason::User));
                        let _ = reply.send(Ok(json!(OkResult { ok: true })));
                    }
                    methods::STATUS => {
                        let _ = reply.send(answer(self.status(None)));
                    }
                    _ => {
                        let _ = reply.send(Err(HostError::new(ErrorCode::MethodNotFound, format!("Método desconhecido: remote.{method}"))));
                    }
                }
            }
            Msg::Disconnected(client) => {
                self.clients.remove(&client);
            }
            Msg::Opened(generation, opened) => self.opened(generation, opened),
            Msg::TunnelEnded { generation, reason } => {
                if self.up.as_ref().is_some_and(|up| up.generation == generation) {
                    tracing::warn!(%reason, "o túnel do controle remoto caiu");
                    self.stop_all(Some(RemoteStopReason::Tunnel));
                }
            }
            Msg::Changes(changes) => {
                for change in changes {
                    match change {
                        ChatChange::Changed(id) => self.schedule(&id),
                        // A deleted or archived chat stops being shared.
                        ChatChange::Removed(id) | ChatChange::Archived(id) => self.revoke(&id),
                    }
                }
            }
            Msg::Tick(chat_id) => self.tick(&chat_id),
            Msg::Snapshot { chat_id, peeked } => self.read(&chat_id, peeked),
            Msg::PhoneCheck { token, reply } => {
                let _ = reply.send(self.grants.chat_for(Some(&token)).is_some());
            }
            Msg::PhoneOpen { token, tx, reply } => {
                let _ = reply.send(self.phone_open(&token, tx));
            }
            Msg::PhoneText { phone, text } => self.phone_text(phone, &text),
            Msg::PhoneClosed(phone) => {
                if self.phones.remove(&phone).is_some() {
                    self.broadcast(None);
                }
            }
            Msg::Shutdown => {}
        }
    }

    // ---- sharing ----

    async fn share(&mut self, chat_id: String, reply: oneshot::Sender<Result<Value, HostError>>) {
        // Watching first: nothing published after the read below is missed.
        self.watch();
        let peeked = match self.deps.chats.peek(&chat_id).await {
            Ok(Some(peeked)) => peeked,
            Ok(None) => {
                let _ = reply.send(Err(HostError::new(ErrorCode::NotFound, "Conversa não encontrada.")));
                return;
            }
            Err(err) => {
                let _ = reply.send(Err(err));
                return;
            }
        };
        if let Some(refusal) = self.refusal(&peeked.0) {
            let _ = reply.send(Err(HostError::new(ErrorCode::Invalid, refusal)));
            return;
        }
        let token = self.grants.grant(&chat_id, model::mint_token);
        if self.hold.is_none() {
            self.hold = self.activity.as_ref().map(|activity| activity.hold());
        }
        if !self.shared.contains_key(&chat_id) {
            self.shared.insert(chat_id.clone(), Shared::new(model::remote_title(&peeked.0)));
        }
        // Built now, so a phone that connects at once has the chat.
        self.snapshot(&chat_id, peeked);
        match &self.up {
            Some(up) => {
                let _ = reply.send(answer(share_result(&up.base_url, &token, &chat_id)));
            }
            None => {
                self.waiting.push((chat_id, reply));
                if self.starting.is_none() {
                    self.open();
                }
            }
        }
        self.broadcast(None);
    }

    /// Why a chat cannot be driven from a phone through the host, if it cannot.
    fn refusal(&self, chat: &Value) -> Option<&'static str> {
        if truthy(chat.get("archived")) {
            return Some("Este chat está arquivado. Desarquive-o para compartilhar.");
        }
        // The window drives these turns itself: the host could not run the phone's commands.
        if truthy(chat.get("remoteId")) {
            return Some("Este chat usa o SSH do modo antigo, que a janela conduz: o controle remoto pelo host não chega a ele.");
        }
        let provider = chat.pointer("/selection/provider").and_then(Value::as_str).unwrap_or_default();
        if !self.deps.chats.runs(provider) {
            return Some("Este agente não roda neste host (PRISM_CLAUDE_ENGINE=sdk): o celular não poderia comandá-lo.");
        }
        None
    }

    /// Starts the page's server and the tunnel to it, off the actor.
    fn open(&mut self) {
        self.generation += 1;
        let generation = self.generation;
        let (me, tunnels) = (self.me.clone(), Arc::clone(&self.deps.tunnels));
        let task = tokio::spawn(async move {
            let opened = async {
                let server = server::start(me.clone()).await.map_err(|err| format!("não foi possível abrir o servidor do celular ({err})"))?;
                let tunnel = tunnels.open(server.port).await?;
                Ok(Opened { generation, server, tunnel })
            }
            .await;
            let _ = me.send(Msg::Opened(generation, opened));
        });
        self.starting = Some((generation, task.abort_handle()));
    }

    fn opened(&mut self, generation: u64, opened: Result<Opened, String>) {
        // Stopped (or restarted) meanwhile: this one just goes away.
        if self.starting.as_ref().map(|(g, _)| *g) != Some(generation) {
            return;
        }
        self.starting = None;
        match opened {
            Ok(Opened { generation, server, tunnel }) => {
                let OpenTunnel { url, ended, guard } = tunnel;
                let me = self.me.clone();
                tokio::spawn(async move {
                    if let Ok(reason) = ended.await {
                        let _ = me.send(Msg::TunnelEnded { generation, reason });
                    }
                });
                let base_url = url.trim_end_matches('/').to_string();
                for (chat_id, reply) in std::mem::take(&mut self.waiting) {
                    let result = match self.grants.token_of(&chat_id) {
                        Some(token) => answer(share_result(&base_url, token, &chat_id)),
                        None => Err(HostError::new(ErrorCode::Gone, "Este chat parou de ser compartilhado.")),
                    };
                    let _ = reply.send(result);
                }
                self.up = Some(Up { generation, base_url, _server: server, _tunnel: guard });
                self.broadcast(None);
            }
            Err(message) => {
                tracing::warn!(%message, "o controle remoto não abriu");
                for (_, reply) in std::mem::take(&mut self.waiting) {
                    let _ = reply.send(Err(HostError::new(ErrorCode::Internal, message.clone())));
                }
                self.stop_all(Some(RemoteStopReason::Error));
            }
        }
    }

    /// The chat's link stops working and its phones are dropped; the last
    /// shared chat takes everything down.
    fn revoke(&mut self, chat_id: &str) {
        if self.grants.revoke(chat_id).is_none() {
            return;
        }
        if let Some(shared) = self.shared.remove(chat_id) {
            shared.alive.store(false, Ordering::SeqCst);
        }
        let revoked = json!({ "t": "revoked", "tabId": chat_id }).to_string();
        self.phones.retain(|_, phone| {
            if phone.chat_id != chat_id {
                return true;
            }
            let _ = phone.tx.try_send(Outbound::Text(revoked.clone()));
            let _ = phone.tx.try_send(Outbound::Close);
            false
        });
        if self.grants.is_empty() {
            self.stop_all(Some(RemoteStopReason::Empty));
        } else {
            self.broadcast(None);
        }
    }

    /// Every link dies: the phones are told, the tunnel and the server go,
    /// the host may sleep again. `reason`: what the clients are told (none at
    /// host shutdown).
    fn stop_all(&mut self, reason: Option<RemoteStopReason>) {
        let was = self.up.is_some() || self.starting.is_some() || !self.grants.is_empty();
        let message = json!({ "t": "stopped" }).to_string();
        for phone in self.phones.values() {
            let _ = phone.tx.try_send(Outbound::Text(message.clone()));
            let _ = phone.tx.try_send(Outbound::Close);
        }
        self.phones.clear();
        // The phones' last word (`revoked`, `stopped`) still has to get out
        // through the tunnel: killing cloudflared at once would cut it off
        // (the app's SIGINT gave cloudflared a grace period instead).
        if let Some(up) = self.up.take() {
            tokio::spawn(async move {
                tokio::time::sleep(LAST_WORD).await;
                drop(up);
            });
        }
        // A start in flight goes too (a download, a tunnel half open).
        if let Some((_, start)) = self.starting.take() {
            start.abort();
        }
        for (_, reply) in std::mem::take(&mut self.waiting) {
            let _ = reply.send(Err(HostError::new(ErrorCode::Gone, "O controle remoto foi encerrado.")));
        }
        self.grants.clear();
        for shared in self.shared.values() {
            shared.alive.store(false, Ordering::SeqCst);
        }
        self.shared.clear();
        self.hold = None;
        if was && reason.is_some() {
            self.broadcast(reason);
        }
    }

    // ---- following the shared chats ----

    fn watch(&mut self) {
        if self.watching {
            return;
        }
        self.watching = true;
        let mut changes = self.deps.chats.watch();
        let me = self.me.clone();
        tokio::spawn(async move {
            while let Some(batch) = changes.recv().await {
                if me.send(Msg::Changes(batch)).is_err() {
                    break;
                }
            }
        });
    }

    fn schedule(&mut self, chat_id: &str) {
        let Some(shared) = self.shared.get_mut(chat_id) else { return };
        if shared.reading {
            shared.dirty = true;
            return;
        }
        if shared.scheduled {
            return;
        }
        let wait = shared.last.map_or(Duration::ZERO, |last| THROTTLE.saturating_sub(last.elapsed()));
        self.tick_after(chat_id, wait);
    }

    fn tick_after(&mut self, chat_id: &str, wait: Duration) {
        let Some(shared) = self.shared.get_mut(chat_id) else { return };
        shared.scheduled = true;
        let (me, id) = (self.me.clone(), chat_id.to_string());
        tokio::spawn(async move {
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
            let _ = me.send(Msg::Tick(id));
        });
    }

    /// One read at a time per chat: a change during it reads again after it.
    fn tick(&mut self, chat_id: &str) {
        let Some(shared) = self.shared.get_mut(chat_id) else { return };
        shared.scheduled = false;
        if shared.reading {
            shared.dirty = true;
            return;
        }
        shared.reading = true;
        shared.last = Some(Instant::now());
        let (me, chats, id) = (self.me.clone(), Arc::clone(&self.deps.chats), chat_id.to_string());
        tokio::spawn(async move {
            let peeked = chats.peek(&id).await;
            let _ = me.send(Msg::Snapshot { chat_id: id, peeked });
        });
    }

    fn read(&mut self, chat_id: &str, peeked: Peeked) {
        let Some(shared) = self.shared.get_mut(chat_id) else { return };
        shared.reading = false;
        let again = std::mem::take(&mut shared.dirty);
        match peeked {
            Ok(Some(peeked)) => self.snapshot(chat_id, peeked),
            // Gone from the engine: nothing left to share.
            Ok(None) => return self.revoke(chat_id),
            // A failed read keeps the link: it is read again in a moment.
            Err(err) => {
                tracing::warn!(message = %err.message, "o controle remoto não leu um chat compartilhado");
                return self.tick_after(chat_id, READ_RETRY);
            }
        }
        if again {
            self.schedule(chat_id);
        }
    }

    /// Builds the chat's snapshot and sends its phones what changed (port of `rc:state`).
    fn snapshot(&mut self, chat_id: &str, (chat, runtime): (Value, Option<ChatRuntime>)) {
        let Some(shared) = self.shared.get_mut(chat_id) else { return };
        let next = model::build_snapshot(&chat, runtime.as_ref());
        let delta = model::snapshot_delta(shared.snapshot.as_ref(), Some(&shared.cache), &next);
        shared.cache = delta.cache;
        let first = shared.snapshot.is_none();
        let mut stamped = next.clone();
        if let Some(map) = stamped.as_object_mut() {
            map.insert("updatedAt".into(), json!(crate::now_ms()));
        }
        shared.title = next.get("title").and_then(Value::as_str).unwrap_or("Chat").to_string();
        shared.snapshot = Some(stamped.clone());
        if !delta.changed {
            return;
        }
        let message = if first {
            json!({ "t": "state", "chat": stamped })
        } else {
            json!({
                "t": "delta",
                "tabId": chat_id,
                "title": next.get("title"),
                "streaming": next.get("streaming"),
                "contextPct": next.get("contextPct"),
                "selection": next.get("selection"),
                "queued": next.get("queued"),
                "queuePaused": next.get("queuePaused"),
                "ids": delta.ids,
                "turns": delta.turns,
            })
        };
        self.send_to_chat(chat_id, &message.to_string());
        let entry = model::list_entry(&next);
        let Some(shared) = self.shared.get_mut(chat_id) else { return };
        if !model::same_entry(shared.entry.as_ref(), &entry) {
            shared.entry = Some(entry.clone());
            self.send_to_chat(chat_id, &json!({ "t": "chats", "chats": [entry] }).to_string());
            // The desktop lists whether it runs and waits on someone.
            self.broadcast(None);
        }
    }

    // ---- phones ----

    fn phone_open(&mut self, token: &str, tx: mpsc::Sender<Outbound>) -> Option<u64> {
        let chat_id = self.grants.chat_for(Some(token))?.to_string();
        let id = self.next_phone;
        self.next_phone += 1;
        let _ = tx.try_send(Outbound::Text(json!({ "t": "chats", "chats": [self.entry_for(&chat_id)] }).to_string()));
        if let Some(snapshot) = self.shared.get(&chat_id).and_then(|s| s.snapshot.as_ref()) {
            let _ = tx.try_send(Outbound::Text(json!({ "t": "state", "chat": snapshot }).to_string()));
        }
        self.phones.insert(id, Phone { chat_id, tx, busy: Arc::new(AtomicBool::new(false)) });
        self.broadcast(None);
        Some(id)
    }

    fn entry_for(&self, chat_id: &str) -> Value {
        let shared = self.shared.get(chat_id);
        if let Some(entry) = shared.and_then(|s| s.entry.clone()) {
            return entry;
        }
        if let Some(snapshot) = shared.and_then(|s| s.snapshot.as_ref()) {
            return model::list_entry(snapshot);
        }
        let title = shared.map_or("Chat", |s| s.title.as_str());
        json!({ "tabId": chat_id, "title": title, "streaming": false, "pending": false })
    }

    fn phone_text(&mut self, phone: u64, text: &str) {
        let Some(Phone { chat_id: scope, tx, busy }) = self.phones.get(&phone) else { return };
        let Ok(message) = serde_json::from_str::<Value>(text) else { return };
        match message.get("t").and_then(Value::as_str) {
            Some("ping") => {
                let _ = tx.try_send(Outbound::Text(json!({ "t": "pong" }).to_string()));
            }
            Some("cmd") => {
                let (Some(tab), Some(action)) =
                    (message.get("tabId").and_then(Value::as_str), message.get("action").and_then(Value::as_str).filter(|a| !a.is_empty()))
                else {
                    return;
                };
                // The link only speaks for its own chat, only while it is
                // shared, and one command at a time.
                let shared = self.shared.get(scope.as_str());
                let reason = if tab != scope {
                    "forbidden"
                } else if !self.grants.has(scope) || shared.is_none() {
                    "no-chat"
                } else if busy.swap(true, Ordering::SeqCst) {
                    "busy"
                } else {
                    ""
                };
                let mut ack = json!({ "t": "ack", "stage": "pc", "action": action, "ok": reason.is_empty(), "reason": reason });
                if let Some(id) = message.get("requestId") { ack["requestId"] = id.clone(); }
                let _ = tx.try_send(Outbound::Text(ack.to_string()));
                let Some(shared) = shared.filter(|_| reason.is_empty()) else { return };
                let payload = message.get("payload").filter(|p| p.is_object()).cloned().unwrap_or_else(|| json!({}));
                let job = Command {
                    deps: Arc::clone(&self.deps),
                    activity: self.activity.clone(),
                    chat_id: scope.clone(),
                    action: action.to_string(),
                    request_id: message.get("requestId").cloned(),
                    payload,
                    phone: tx.clone(),
                    busy: Arc::clone(busy),
                    alive: Arc::clone(&shared.alive),
                };
                tokio::spawn(job.run());
            }
            _ => {}
        }
    }

    /// Queues the text for the chat's phones; a phone gone, or too far
    /// behind, is dropped (it reconnects and gets the whole chat).
    fn send_to_chat(&mut self, chat_id: &str, text: &str) {
        let mut dropped = false;
        self.phones.retain(|_, phone| {
            if phone.chat_id != chat_id {
                return true;
            }
            let kept = phone.tx.try_send(Outbound::Text(text.to_string())).is_ok();
            dropped |= !kept;
            kept
        });
        if dropped {
            self.broadcast(None);
        }
    }

    // ---- the desktop ----

    fn status(&self, reason: Option<RemoteStopReason>) -> RemoteStatus {
        let base_url = self.up.as_ref().map(|up| up.base_url.clone());
        let chats = self
            .grants
            .chats()
            .into_iter()
            .filter_map(|chat_id| {
                let token = self.grants.token_of(&chat_id)?.to_string();
                let shared = self.shared.get(&chat_id);
                let flag = |key: &str| shared.and_then(|s| s.entry.as_ref()).and_then(|e| e.get(key)).and_then(Value::as_bool).unwrap_or(false);
                Some(SharedChat {
                    url: base_url.as_deref().map(|base| link(base, &token, &chat_id)).unwrap_or_default(),
                    title: shared.map_or_else(|| "Chat".to_string(), |s| s.title.clone()),
                    phones: self.phones.values().filter(|p| p.chat_id == chat_id).count() as u32,
                    streaming: flag("streaming"),
                    pending: flag("pending"),
                    token,
                    chat_id,
                })
            })
            .collect();
        RemoteStatus { running: base_url.is_some(), base_url, phones: self.phones.len() as u32, chats, reason }
    }

    fn broadcast(&mut self, reason: Option<RemoteStopReason>) {
        if self.clients.is_empty() {
            return;
        }
        let Ok(status) = serde_json::to_value(self.status(reason)) else { return };
        self.clients.retain(|_, notifier| notifier.send(methods::CHANGED, status.clone()));
    }
}

/// A phone's command, decided and run off the actor.
struct Command {
    deps: Arc<RemoteParts>,
    activity: Option<Arc<Activity>>,
    chat_id: String,
    action: String,
    request_id: Option<Value>,
    payload: Value,
    phone: mpsc::Sender<Outbound>,
    /// The phone's "a command runs" flag, freed when this one ends.
    busy: Arc<AtomicBool>,
    /// The chat is still shared.
    alive: Arc<AtomicBool>,
}

/// Frees the phone for its next command however this one ends.
struct Release(Arc<AtomicBool>);

impl Drop for Release {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Command {
    async fn extra(&self, chat: &Value, action: &str, payload: Value, actor: UserInfo, activity: &Arc<Activity>) -> Result<Value, HostError> {
        match action {
            "models" => {
                let selection = chat.get("selection").unwrap_or(&Value::Null);
                let provider = selection.get("provider").and_then(Value::as_str).unwrap_or_default();
                let profile = selection.get("profileId").and_then(Value::as_str).unwrap_or_default();
                self.deps.catalogs.models(provider, profile, false).await
            }
            "configure" => {
                let mut selection = chat.get("selection").and_then(Value::as_object).cloned().unwrap_or_default();
                let patch = payload.get("selection").and_then(Value::as_object).ok_or_else(|| HostError::new(ErrorCode::Invalid, "Seleção inválida."))?;
                for (key, value) in patch {
                    if !matches!(key.as_str(), "model" | "effort" | "permissionMode" | "serviceTier") || !value.is_string() { return Err(HostError::new(ErrorCode::Invalid, "Seleção inválida.")); }
                    selection.insert(key.clone(), value.clone());
                }
                if !matches!(selection.get("permissionMode").and_then(Value::as_str), Some("default" | "plan" | "acceptEdits" | "bypassPermissions")) {
                    return Err(HostError::new(ErrorCode::Invalid, "Modo inválido."));
                }
                self.deps.chats.command(chat_methods::CONFIGURE, json!({"chatId": self.chat_id, "selection": selection}), actor, Arc::clone(activity)).await
            }
            "queue" => {
                let mut params = payload.as_object().cloned().unwrap_or_default();
                params.insert("chatId".into(), json!(self.chat_id));
                self.deps.chats.command(chat_methods::QUEUE, Value::Object(params), actor, Arc::clone(activity)).await
            }
            "changes" => Ok(assets::changes(chat)),
            "image" => assets::image(chat, &payload).await,
            "file" => assets::file(chat, &payload).await,
            _ => Err(HostError::new(ErrorCode::Invalid, "Ação inválida.")),
        }
    }

    async fn run(self) {
        let release = Release(Arc::clone(&self.busy));
        let outcome = match self.deps.chats.peek(&self.chat_id).await {
            Err(_) => Err("unknown"),
            Ok(peeked) => {
                let (chat, runtime) = match &peeked {
                    Some((chat, runtime)) => (Some(chat), runtime.as_ref()),
                    None => (None, None),
                };
                match model::decide(chat, runtime, &self.action, &self.payload) {
                    Err(reason) => Err(reason),
                    // Revoked since it was accepted: it no longer speaks for the chat.
                    Ok(_) if !self.alive.load(Ordering::SeqCst) => Err("no-chat"),
                    Ok(command) => match &self.activity {
                        Some(activity) => self.execute(chat, command, activity).await.map_err(|err| model::refusal_reason(err.code)),
                        None => Err("unknown"),
                    },
                }
            }
        };
        let (ok, reason, data) = match outcome {
            Ok(data) => (true, "", data),
            Err(reason) => (false, reason, Value::Null),
        };
        // Free before the phone hears it is done, so its next command is never `busy`.
        drop(release);
        let mut ack = json!({ "t": "ack", "stage": "done", "action": self.action, "ok": ok, "reason": reason });
        if !data.is_null() { ack["data"] = data; }
        if let Some(id) = self.request_id { ack["requestId"] = id; }
        let _ = self.phone.try_send(Outbound::Text(ack.to_string()));
    }

    async fn execute(&self, chat: Option<&Value>, command: PhoneCommand, activity: &Arc<Activity>) -> Result<Value, HostError> {
        let actor = UserInfo { id: format!("celular · {}", self.chat_id), name: "Celular".into(), role: Role::Owner };
        let mut params = Map::new();
        params.insert("chatId".into(), json!(self.chat_id));
        let method = match command {
            PhoneCommand::Send { text } => {
                let selection = chat.and_then(|c| c.get("selection")).cloned().unwrap_or(Value::Null);
                params.insert("text".into(), json!(text));
                if let Some(tier) = service_tier(&self.deps.catalogs, &selection).await {
                    params.insert("serviceTier".into(), json!(tier));
                }
                if let Some(name) = profile_name(&self.deps.host_profiles, &selection).await {
                    params.insert("profileName".into(), json!(name));
                }
                chat_methods::SEND
            }
            PhoneCommand::Extra { action, payload } => {
                return self.extra(chat.ok_or_else(|| HostError::new(ErrorCode::NotFound, "Conversa não encontrada."))?, &action, payload, actor, activity).await;
            }
            PhoneCommand::Stop => chat_methods::STOP,
            PhoneCommand::Permission { perm_id, decision } => {
                params.insert("permId".into(), json!(perm_id));
                params.insert("decision".into(), json!(decision));
                chat_methods::RESPOND_PERMISSION
            }
            PhoneCommand::Question { dialog_id, answers, response } => {
                params.insert("dialogId".into(), json!(dialog_id));
                if let Some(answers) = answers {
                    params.insert("answers".into(), json!(answers));
                }
                if let Some(response) = response {
                    params.insert("response".into(), json!(response));
                }
                chat_methods::RESPOND_QUESTION
            }
        };
        self.deps.chats.command(method, Value::Object(params), actor, Arc::clone(activity)).await
    }
}

/// The tier a phone's turn may use, over the host's catalog (`effective_tier`).
async fn service_tier(catalogs: &Catalogs, selection: &Value) -> Option<String> {
    selection.get("serviceTier").and_then(Value::as_str).filter(|t| !t.is_empty())?;
    let field = |key: &str| selection.get(key).and_then(Value::as_str).unwrap_or_default();
    let models = catalogs.models(field("provider"), field("profileId"), false).await.ok();
    effective_tier(selection, models.as_ref().and_then(Value::as_array).map(Vec::as_slice))
}

/// `effectiveServiceTier(selection, selectedModelFor(selection, models))`:
/// the selection's tier only when its model honours it. Without a catalog
/// (`None`, or empty) the tier stays as chosen, as the client did before its
/// catalog loaded.
pub fn effective_tier(selection: &Value, models: Option<&[Value]>) -> Option<String> {
    let tier = selection.get("serviceTier").and_then(Value::as_str).filter(|t| !t.is_empty())?.to_string();
    let Some(models) = models.filter(|m| !m.is_empty()) else { return Some(tier) };
    let model = match selection.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
        Some(id) => models.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(id)),
        None => models.iter().find(|m| m.get("default").and_then(Value::as_bool) == Some(true)),
    };
    let fast = model?.get("fast").and_then(|f| f.get("id")).and_then(Value::as_str);
    (fast == Some(tier.as_str())).then_some(tier)
}

/// The account's name for the turn, as the desktop lists it.
async fn profile_name(host_profiles: &Arc<HostProfiles>, selection: &Value) -> Option<String> {
    let id = selection.get("profileId").and_then(Value::as_str)?.to_string();
    let host = Arc::clone(host_profiles);
    let list = tokio::task::spawn_blocking(move || host.documents().ok().map(|docs| public_list(&docs))).await.ok().flatten()?;
    list.into_iter().find(|p| p.get("id").and_then(Value::as_str) == Some(id.as_str()))?.get("name").and_then(Value::as_str).map(str::to_string)
}

/// JavaScript truthiness; `None` is `undefined`.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

fn answer<T: Serialize>(value: T) -> Result<Value, HostError> {
    serde_json::to_value(value).map_err(|err| HostError::new(ErrorCode::Internal, err.to_string()))
}

fn share_result(base_url: &str, token: &str, chat_id: &str) -> ShareResult {
    ShareResult { url: link(base_url, token, chat_id), base_url: base_url.to_string(), token: token.to_string() }
}

/// `${baseUrl}/#t=${token}&c=${encodeURIComponent(chatId)}`.
pub fn link(base_url: &str, token: &str, chat_id: &str) -> String {
    format!("{base_url}/#t={token}&c={}", encode_component(chat_id))
}

/// `encodeURIComponent`.
pub fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests;
