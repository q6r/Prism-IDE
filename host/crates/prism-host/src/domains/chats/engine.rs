//! The chats engine: one thread, one order. Commands, provider events and
//! subscriptions are handled one at a time, so a chat's commands are
//! serialized and a subscription is atomic with respect to the deltas.
//!
//! Streamed output waits up to `BATCH` and then goes, in one step, into the
//! journal (one transaction) and out to every subscriber (one
//! `chats.delta`). Anything else (a command, a prompt, a turn ending) flushes
//! at once.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use prism_protocol::providers::ProfileRefParams;
use prism_protocol::chats::{
    methods, AppendKind, ArchiveParams, BindWorkspaceParams, BusyProfiles, ChatDelta, ChatDocParams, ChatDocsParams, ChatIdParams, ChatPatch, ChatRef,
    ChatRuntime, ChatRuntimeUpdate, ChatUpsert, ChatsDeltaBatch, ChatsSnapshot, ChatsWritten, ConfigureParams, FastReport,
    PermissionDecision, PermissionParams, QuestionParams, ReassignProfileParams, Reassigned, RenameParams, SendParams, SendResult,
    SteerParams, SetTaskParams, TurnAppend, TurnMetrics, TurnSegment, TurnUpsert,
};
use prism_protocol::{ErrorCode, HostError, OkResult, Role, UserInfo};
use prism_store::{kinds, route_key, NewEvent, Store};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::runtime::Handle;

use super::port::{continuation_prompt, first_title, truthy};
use super::image_references::{image_attachments_for_history, number_existing_images, number_new_images, resolve_image_references};
use super::{ChatChange, ExclusiveWork, Hold, Msg, Runners, TurnEvent, TurnSink, TurnStart};
use crate::activity::{Activity, ActivityGuard};
use crate::domain::{params, ClientId, Notifier};
use crate::domains::store::{store_error, SharedStore};

#[path = "subagents.rs"]
mod subagents;

/// Streamed text, tool snapshots and metrics wait this long, to reach the
/// journal and the subscribers in one batch.
pub(super) const BATCH: Duration = Duration::from_millis(40);
/// How long the engine sleeps with nothing pending.
const IDLE: Duration = Duration::from_secs(3600);

const RUNNING: &str = "Este chat já está executando uma tarefa.";
const RUNNING_REPLACE: &str = "Esta conversa está em execução. Aguarde antes de substituir seu histórico.";
const INVALID_CHAT: &str = "Conversa inválida.";
const PERMISSION_GONE: &str = "Esta permissão já foi respondida.";
const QUESTION_GONE: &str = "Esta pergunta já foi respondida.";
const STARTUP_FAILED: &str = "O provedor falhou ao iniciar a tarefa. Envie a mensagem novamente.";

pub(super) fn start(shared: Arc<SharedStore>, runners: Runners, handle: Handle) -> Sender<Msg> {
    let (tx, rx) = std::sync::mpsc::channel();
    let me = tx.clone();
    std::thread::Builder::new()
        .name("prism-chats".into())
        .spawn(move || run(shared, runners, handle, me, rx))
        .expect("the chats engine thread starts");
    tx
}

fn run(shared: Arc<SharedStore>, runners: Runners, handle: Handle, tx: Sender<Msg>, rx: Receiver<Msg>) {
    let store = match shared.get() {
        Ok(store) => store,
        Err(err) => {
            tracing::error!(message = %err.message, "o motor de chats não abriu o armazenamento");
            drop(tx);
            for msg in rx {
                match msg {
                    Msg::Call { reply, .. } => {
                        let _ = reply.send(Err(err.clone()));
                    }
                    Msg::Exclusive { reply, .. } => {
                        let _ = reply.send(Err(err.clone()));
                    }
                    _ => {}
                }
            }
            return;
        }
    };
    // Runner controls (interrupt, permission and session teardown) may spawn
    // native tasks. The actor uses a dedicated std thread, so enter the host runtime.
    let _runtime = handle.enter();
    let mut engine = Engine::new(store, runners, handle.clone(), tx);
    loop {
        let wait = engine.deadline.map_or(IDLE, |at| at.saturating_duration_since(Instant::now()));
        match rx.recv_timeout(wait) {
            Ok(msg) => engine.handle(msg),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if engine.deadline.is_some_and(|at| Instant::now() >= at) {
            engine.flush();
        }
    }
    engine.flush();
}

/// The provider launch is supervised separately so a panic or cancelled job
/// always reports a terminal outcome to the actor.
struct Startup {
    task: tokio::task::JoinHandle<()>,
    abort: tokio::task::AbortHandle,
}

/// A turn the engine is running.
struct Run {
    turn_id: String,
    provider: String,
    route: String,
    /// Tool segments by tool id, as last recorded (to update their status).
    tools: HashMap<String, Value>,
    /// Pending approvals and questions, oldest first.
    permissions: VecDeque<Value>,
    questions: VecDeque<Value>,
    /// The chat's `resume` as the subscribers last saw it.
    resume: Option<Value>,
    /// The session id last journaled for this turn.
    session: Option<String>,
    /// The failure's reason the provider gave ahead of its error (`cli_auth`).
    error_code: Option<String>,
    abort_requested: bool,
    /// Cancel a provider still waiting to accept the turn (session teardown or launch).
    startup: Option<Startup>,
    /// Keeps the host alive while the turn runs.
    _hold: Option<ActivityGuard>,
}

pub(super) struct Engine {
    store: Arc<Store>,
    runners: Runners,
    handle: Handle,
    tx: Sender<Msg>,
    activity: Option<Arc<Activity>>,
    subscribers: HashMap<ClientId, Notifier>,
    /// The host's own watchers (`ChatsDomain::watch`).
    watchers: Vec<tokio::sync::mpsc::UnboundedSender<Vec<ChatChange>>>,
    runtime: BTreeMap<String, ChatRuntime>,
    runs: HashMap<String, Run>,
    queue_sending: HashMap<String, String>,
    native_children: HashMap<String, subagents::Child>,
    rev: u64,
    events: Vec<NewEvent>,
    deltas: Vec<ChatDelta>,
    pub(super) deadline: Option<Instant>,
}

fn invalid(message: &str) -> HostError {
    HostError::new(ErrorCode::Invalid, message)
}

fn busy(message: &str) -> HostError {
    HostError::new(ErrorCode::Busy, message)
}

fn gone(message: &str) -> HostError {
    HostError::new(ErrorCode::Gone, message)
}

fn not_found() -> HostError {
    HostError::new(ErrorCode::NotFound, "Conversa não encontrada.")
}

fn ok() -> Result<Value, HostError> {
    Ok(json!(OkResult { ok: true }))
}

/// What only the owner may do to the chats (the accounts' side of them).
fn owner(user: &UserInfo) -> Result<(), HostError> {
    if user.role == Role::Owner {
        Ok(())
    } else {
        Err(HostError::new(ErrorCode::Forbidden, "Só o dono do host gerencia as contas."))
    }
}

fn answer<T: Serialize>(value: T) -> Result<Value, HostError> {
    serde_json::to_value(value).map_err(|err| HostError::new(ErrorCode::Internal, err.to_string()))
}

pub(super) fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// A JSON id as a map key (`toolId`/`toolUseId` are strings in practice).
fn key(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn tool_key(segment: &Value) -> Option<String> {
    segment.get("toolId").and_then(key)
}

fn tier(selection: &Value) -> &str {
    selection.get("serviceTier").and_then(Value::as_str).unwrap_or("")
}

fn check_selection(selection: Option<&Value>) -> Result<(), HostError> {
    let selection = selection.filter(|s| s.is_object()).ok_or_else(|| invalid("Seleção de modelo inválida."))?;
    let provider = selection.get("provider").and_then(Value::as_str);
    if !matches!(provider, Some("claude" | "codex")) || !selection.get("profileId").is_some_and(Value::is_string) {
        return Err(invalid("Seleção de modelo inválida."));
    }
    Ok(())
}

/// What a batch changed: one entry per chat, in the order it was first
/// touched; an archive or a removal wins over a plain change.
pub(super) fn changes_of(deltas: &[ChatDelta]) -> Vec<ChatChange> {
    let mut out: Vec<ChatChange> = Vec::new();
    for delta in deltas {
        let change = match delta {
            ChatDelta::Chat(ChatUpsert { chat }) => {
                let id = chat.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                if truthy(chat.get("archived")) { ChatChange::Archived(id) } else { ChatChange::Changed(id) }
            }
            ChatDelta::Remove(ChatRef { chat_id }) => ChatChange::Removed(chat_id.clone()),
            ChatDelta::Patch(ChatPatch { chat_id, patch }) if truthy(patch.get("archived")) => ChatChange::Archived(chat_id.clone()),
            ChatDelta::Patch(ChatPatch { chat_id, .. })
            | ChatDelta::Turn(TurnUpsert { chat_id, .. })
            | ChatDelta::Append(TurnAppend { chat_id, .. })
            | ChatDelta::Segment(TurnSegment { chat_id, .. })
            | ChatDelta::Metrics(TurnMetrics { chat_id, .. })
            | ChatDelta::Runtime(ChatRuntimeUpdate { chat_id, .. }) => ChatChange::Changed(chat_id.clone()),
        };
        match out.iter().position(|seen| seen.chat_id() == change.chat_id()) {
            Some(slot) if !matches!(change, ChatChange::Changed(_)) => out[slot] = change,
            Some(_) => {}
            None => out.push(change),
        }
    }
    out
}

/// The `chats:save` checks: an id, the turns, the folder and a selection.
fn check_chat(chat: &Value) -> Result<String, HostError> {
    let id = chat.get("id").and_then(Value::as_str).filter(|id| !id.is_empty());
    let shaped = chat.get("turns").is_some_and(Value::is_array) && chat.get("cwd").is_some_and(Value::is_string);
    match id {
        Some(id) if shaped && check_selection(chat.get("selection")).is_ok() => Ok(id.to_string()),
        _ => Err(invalid(INVALID_CHAT)),
    }
}

impl Engine {
    pub(super) fn new(store: Arc<Store>, runners: Runners, handle: Handle, tx: Sender<Msg>) -> Self {
        let mut engine = Self {
            store,
            runners,
            handle,
            tx,
            activity: None,
            subscribers: HashMap::new(),
            watchers: Vec::new(),
            runtime: BTreeMap::new(),
            runs: HashMap::new(),
            queue_sending: HashMap::new(),
            native_children: HashMap::new(),
            rev: 0,
            events: Vec::new(),
            deltas: Vec::new(),
            deadline: None,
        };
        engine.restore_subagents();
        engine
    }

    pub(super) fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Call { method, params, user, client, notifier, activity, reply } => {
                self.activity.get_or_insert(activity);
                if method == methods::QUEUE && params.get("operation").and_then(Value::as_str) == Some("send") {
                    self.send_queued(params, &user, reply);
                    return;
                }
                if method == methods::STEER {
                    self.steer(params, &user, reply);
                    return;
                }
                let result = self.call(&method, params, &user, client, notifier);
                // The deltas of a command go out before its answer.
                self.flush();
                let _ = reply.send(result);
            }
            Msg::Exclusive { provider, profile_id, refusal, hold, work, reply } => {
                let result = self.exclusive(&provider, &profile_id, &refusal, hold, work);
                self.flush();
                let _ = reply.send(result);
            }
            Msg::Watch(tx) => self.watchers.push(tx),
            Msg::Peek { chat_id, reply } => {
                // Whatever is queued reaches the journal first, so the fold has it.
                self.flush();
                let peeked = self.store.chat(&chat_id).map_err(store_error).map(|chat| chat.map(|chat| (chat, self.runtime.get(&chat_id).cloned())));
                let _ = reply.send(peeked);
            }
            Msg::Turn { chat_id, turn_id, event } => self.turn_event(&chat_id, &turn_id, event),
            Msg::Started { chat_id, turn_id, result } => self.started(&chat_id, &turn_id, result),
            Msg::Steered { queue_id, chat_id, turn_id, segment, actor, result, reply } => {
                if let Some(id) = &queue_id {
                    self.queue_sending.remove(&chat_id);
                    if result.is_ok() { let _ = self.remove_queued(&chat_id, id); }
                    else { let _ = self.edit(&chat_id, |doc| { doc.insert("queuePaused".into(), json!(true)); }); }
                }
                let result = result.map_err(|message| invalid(&message)).and_then(|()| {
                    self.segment(&chat_id, &turn_id, segment, Some(&actor));
                    self.flush();
                    ok()
                });
                let _ = reply.send(result);
                if queue_id.is_some() && !self.running(&chat_id) { self.flush_queue(&chat_id); }
            }
            Msg::Disconnected(client) => {
                self.subscribers.remove(&client);
            }
        }
    }

    fn call(&mut self, method: &str, value: Value, user: &UserInfo, client: ClientId, notifier: Notifier) -> Result<Value, HostError> {
        match method {
            methods::SUBSCRIBE => {
                self.flush();
                let snapshot = self.snapshot()?;
                self.subscribers.insert(client, notifier);
                answer(snapshot)
            }
            methods::UNSUBSCRIBE => {
                self.subscribers.remove(&client);
                ok()
            }
            methods::LIST => {
                self.flush();
                answer(self.snapshot()?)
            }
            methods::CREATE => self.create(params(value)?),
            methods::PUT => self.put(params(value)?),
            methods::FLUSH | methods::IMPORT_DOCS => self.put_many(params(value)?),
            methods::CONFIGURE => self.configure(params(value)?),
            methods::QUEUE => self.queue(value, user),
            methods::CONFIRM_ACCOUNT => self.confirm_account(params(value)?),
            methods::BIND_WORKSPACE => self.bind_workspace(params(value)?),
            methods::RENAME => self.rename(params(value)?),
            methods::ARCHIVE => self.archive(params(value)?),
            methods::SET_TASK => self.set_task(params(value)?),
            methods::REMOVE => self.remove(params(value)?),
            methods::REASSIGN_PROFILE => {
                owner(user)?;
                self.reassign_profile(params(value)?)
            }
            methods::SEND => self.send(params(value)?, user),
            methods::STOP => self.stop(params(value)?),
            methods::RESPOND_PERMISSION => self.respond_permission(params(value)?, user),
            methods::RESPOND_QUESTION => self.respond_question(params(value)?),
            methods::BUSY_PROFILES => answer(BusyProfiles { profile_ids: self.busy_profiles() }),
            methods::FORGET_SESSIONS => {
                owner(user)?;
                self.forget_sessions(params(value)?)
            }
            _ => Err(HostError::new(ErrorCode::MethodNotFound, format!("Método desconhecido: chats.{method}"))),
        }
    }

    fn snapshot(&self) -> Result<ChatsSnapshot, HostError> {
        Ok(ChatsSnapshot { rev: self.rev, chats: self.store.chats().map_err(store_error)?, runtime: self.runtime.clone() })
    }

    fn running(&self, chat_id: &str) -> bool {
        self.runs.contains_key(chat_id) || self.runtime.get(chat_id).is_some_and(|rt| rt.busy)
    }

    // ---- documents ----

    fn create(&mut self, p: ChatDocParams) -> Result<Value, HostError> {
        let id = check_chat(&p.chat)?;
        if self.store.document(kinds::CHATS, &id).map_err(store_error)?.is_some() {
            return Err(invalid("Este chat já existe."));
        }
        let stored = self.store.put_chat(&p.chat).map_err(store_error)?;
        self.delta(ChatDelta::Chat(ChatUpsert { chat: stored }));
        ok()
    }

    fn put(&mut self, p: ChatDocParams) -> Result<Value, HostError> {
        let id = check_chat(&p.chat)?;
        if self.running(&id) {
            return Err(busy(RUNNING_REPLACE));
        }
        let stored = self.store.put_chat(&p.chat).map_err(store_error)?;
        self.delta(ChatDelta::Chat(ChatUpsert { chat: stored }));
        ok()
    }

    fn put_many(&mut self, p: ChatDocsParams) -> Result<Value, HostError> {
        let ids = p.chats.iter().map(check_chat).collect::<Result<Vec<_>, _>>()?;
        let mut written = 0;
        let mut skipped = Vec::new();
        for (chat, id) in p.chats.iter().zip(ids) {
            if self.running(&id) {
                skipped.push(id);
                continue;
            }
            let stored = self.store.put_chat(chat).map_err(store_error)?;
            self.delta(ChatDelta::Chat(ChatUpsert { chat: stored }));
            written += 1;
        }
        answer(ChatsWritten { written, skipped })
    }

    /// Changes top-level fields of a chat's document (never its turns) and
    /// publishes them as a patch.
    fn edit(&mut self, chat_id: &str, change: impl FnOnce(&mut Map<String, Value>)) -> Result<(), HostError> {
        let Some(Value::Object(before)) = self.store.document(kinds::CHATS, chat_id).map_err(store_error)? else {
            return Err(not_found());
        };
        let mut after = before.clone();
        change(&mut after);
        let mut patch = Map::new();
        for (field, value) in &after {
            if field != "turns" && before.get(field) != Some(value) {
                patch.insert(field.clone(), value.clone());
            }
        }
        for field in before.keys() {
            if field != "turns" && !after.contains_key(field) {
                patch.insert(field.clone(), Value::Null);
            }
        }
        if patch.is_empty() {
            return Ok(());
        }
        self.store.put_document(kinds::CHATS, chat_id, &Value::Object(after)).map_err(store_error)?;
        self.delta(ChatDelta::Patch(ChatPatch { chat_id: chat_id.to_string(), patch }));
        Ok(())
    }


    fn remove_queued(&mut self, chat_id: &str, id: &str) -> Result<(), HostError> {
        self.edit(chat_id, |doc| {
            if let Some(rows) = doc.get_mut("queued").and_then(Value::as_array_mut) {
                rows.retain(|row| row.get("id").and_then(Value::as_str) != Some(id));
            }
        })
    }

    fn queue(&mut self, value: Value, user: &UserInfo) -> Result<Value, HostError> {
        let chat_id = value.get("chatId").and_then(Value::as_str).ok_or_else(|| invalid("Conversa inválida."))?;
        let chat = self.store.chat(chat_id).map_err(store_error)?.ok_or_else(not_found)?;
        if truthy(chat.get("readOnly")) { return Err(invalid("Conversa somente leitura.")); }
        let operation = value.get("operation").and_then(Value::as_str).unwrap_or_default();
        let id = value.get("id").and_then(Value::as_str).unwrap_or_default();
        if value.get("operation").and_then(Value::as_str) == Some("add")
            && let Some(id) = value.get("message").and_then(|m| m.get("id")).and_then(Value::as_str)
            && chat.get("queued").and_then(Value::as_array).is_some_and(|rows| rows.iter().any(|row| row.get("id").and_then(Value::as_str) == Some(id))) {
            return Ok(json!({"ok": true, "id": id}));
        }
        let mut added_id = None;
        let mut rows = chat.get("queued").and_then(Value::as_array).cloned().unwrap_or_default();
        for row in &mut rows {
            if let Some(images) = row.get("images").and_then(Value::as_array) { row["images"] = json!(number_existing_images(&chat, images)); }
        }
        match operation {
            "add" | "replace" => {
                let mut item = value.get("message").and_then(Value::as_object).cloned().ok_or_else(|| invalid("Mensagem inválida."))?;
                if operation == "replace" {
                    let mut original = rows.iter().find(|row| row.get("id").and_then(Value::as_str) == Some(id))
                        .and_then(Value::as_object).cloned().ok_or_else(|| gone("Mensagem não está mais na fila."))?;
                    original.extend(item); item = original;
                }
                let text = item.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
                if text.len() > 200_000 || rows.len() >= 100 && operation == "add" {
                    return Err(invalid("Digite uma mensagem; a fila aceita até 100 itens."));
                }
                // Validate attachments through the same SendParams contract before storing.
                let message: SendParams = params(json!({"chatId": chat_id, "text": text, "images": item.get("images")}))?;
                let images = message.images.as_deref().unwrap_or_default();
                if text.trim().is_empty() && images.is_empty() || images.len() > 8 || images.iter().map(|image| image.data.len()).sum::<usize>() > 12 * 1024 * 1024
                    || images.iter().any(|image| !["image/png", "image/jpeg", "image/gif", "image/webp"].contains(&image.mime.as_str()) || image.data.is_empty()) {
                    return Err(invalid("Mensagem ou anexos inválidos."));
                }
                item.retain(|key, _| matches!(key.as_str(), "text" | "context" | "images" | "id"));
                let added = images.iter().map(|image| serde_json::to_value(image).unwrap()).collect::<Vec<_>>();
                let attached = number_new_images(&chat, &added).map_err(|message| invalid(&message))?;
                let resolved = resolve_image_references(&chat, &text, &attached).map_err(|message| invalid(&message))?;
                let stored_images = image_attachments_for_history(&chat, &attached, &resolved.images);
                if !stored_images.is_empty() { item.insert("images".into(), json!(stored_images)); }
                if operation == "add" {
                    let id = item.get("id").and_then(Value::as_str).filter(|id| !id.is_empty() && id.len() <= 128).map(str::to_string).unwrap_or_else(new_id);
                    added_id = Some(id.clone());
                    item.insert("id".into(), json!(id));
                    rows.push(Value::Object(item));
                } else {
                    if self.queue_sending.get(chat_id).is_some_and(|sending| sending == id) { return Err(busy("Esta mensagem está sendo enviada.")); }
                    let index = rows.iter().position(|row| row.get("id").and_then(Value::as_str) == Some(id)).ok_or_else(|| gone("Mensagem não está mais na fila."))?;
                    item.insert("id".into(), json!(id));
                    rows[index] = Value::Object(item);
                }
            }
            "remove" => {
                if self.queue_sending.get(chat_id).is_some_and(|sending| sending == id) { return Err(busy("Esta mensagem está sendo enviada.")); }
                rows.retain(|row| row.get("id").and_then(Value::as_str) != Some(id));
            }
            "move" => {
                if self.queue_sending.contains_key(chat_id) { return Err(busy("Aguarde o envio da mensagem.")); }
                let from = rows.iter().position(|row| row.get("id").and_then(Value::as_str) == Some(id)).ok_or_else(|| gone("Mensagem não está mais na fila."))?;
                let to = value.get("to").and_then(Value::as_u64).ok_or_else(|| invalid("Posição inválida."))? as usize;
                if to >= rows.len() { return Err(invalid("Posição inválida.")); }
                let row = rows.remove(from); rows.insert(to, row);
            }
            "pause" => {
                let paused = value.get("paused").and_then(Value::as_bool).ok_or_else(|| invalid("Pausa inválida."))?;
                self.edit(chat_id, |doc| { doc.insert("queuePaused".into(), json!(paused)); })?;
                if !paused { self.flush_queue(chat_id); }
                return ok();
            }
            "flush" => { self.flush_queue(chat_id); return ok(); }
            _ => return Err(invalid("Ação da fila inválida.")),
        }
        self.edit(chat_id, |doc| { doc.insert("queued".into(), json!(rows)); })?;
        let _ = user;
        Ok(json!({"ok": true, "id": added_id}))
    }

    fn queued_params(&self, chat_id: &str, row: &Value) -> Result<SendParams, HostError> {
        let chat = self.store.chat(chat_id).map_err(store_error)?.ok_or_else(not_found)?;
        let mut row = row.clone();
        if let Some(images) = row.get("images").and_then(Value::as_array) { row["images"] = json!(number_existing_images(&chat, images)); }
        params(json!({"chatId": chat_id, "text": row.get("text"), "context": row.get("context"),
            "images": row.get("images"), "serviceTier": chat.get("selection").and_then(|s| s.get("serviceTier"))}))
    }

    fn flush_queue(&mut self, chat_id: &str) {
        if self.running(chat_id) || self.queue_sending.contains_key(chat_id) { return; }
        let Ok(Some(chat)) = self.store.chat(chat_id) else { return };
        if truthy(chat.get("queuePaused")) { return; }
        let Some(row) = chat.get("queued").and_then(Value::as_array).and_then(|rows| rows.first()).cloned() else { return };
        let Some(id) = row.get("id").and_then(Value::as_str) else { return };
        let user = UserInfo { id: "fila".into(), name: "Fila".into(), role: Role::Owner };
        match self.queued_params(chat_id, &row).and_then(|p| self.send(p, &user)) {
            Ok(_) => { let _ = self.remove_queued(chat_id, id); }
            Err(_) => { let _ = self.edit(chat_id, |doc| { doc.insert("queuePaused".into(), json!(true)); }); }
        }
        self.flush();
    }

    fn send_queued(&mut self, value: Value, user: &UserInfo, reply: tokio::sync::oneshot::Sender<Result<Value, HostError>>) {
        let prepared = (|| {
            let chat_id = value.get("chatId").and_then(Value::as_str).ok_or_else(|| invalid("Conversa inválida."))?.to_string();
            let id = value.get("id").and_then(Value::as_str).ok_or_else(|| invalid("Mensagem inválida."))?.to_string();
            if self.queue_sending.contains_key(&chat_id) { return Err(busy("Aguarde o envio da mensagem.")); }
            let chat = self.store.chat(&chat_id).map_err(store_error)?.ok_or_else(not_found)?;
            if truthy(chat.get("readOnly")) { return Err(invalid("Conversa somente leitura.")); }
            let mut row = chat.get("queued").and_then(Value::as_array).and_then(|rows| rows.iter().find(|row| row.get("id").and_then(Value::as_str) == Some(id.as_str()))).cloned().ok_or_else(|| gone("Mensagem não está mais na fila."))?;
            if let Some(images) = row.get("images").and_then(Value::as_array) { row["images"] = json!(number_existing_images(&chat, images)); }
            Ok((chat_id, id, row))
        })();
        match prepared {
            Err(err) => { let _ = reply.send(Err(err)); }
            Ok((chat_id, id, row)) => {
                if let Some(run) = self.runs.get(&chat_id) {
                    let params = json!({"chatId": chat_id, "turnId": run.turn_id, "text": row.get("text"), "context": row.get("context"), "images": row.get("images"), "queueId": id});
                    self.queue_sending.insert(chat_id, id);
                    self.steer(params, user, reply);
                } else {
                    let result = self.queued_params(&chat_id, &row).and_then(|p| self.send(p, user)).and_then(|_| { self.remove_queued(&chat_id, &id)?; ok() });
                    self.flush();
                    let _ = reply.send(result);
                }
            }
        }
    }

    fn configure(&mut self, p: ConfigureParams) -> Result<Value, HostError> {
        check_selection(Some(&p.selection))?;
        let selection = p.selection;
        let pending = self.runs.get(&p.chat_id).map(|run| run.permissions.iter().cloned().collect::<Vec<_>>()).unwrap_or_default();
        // Live Claude settings change only on the run's route. A provider/account
        // switch configures the next turn and never redirects the current one.
        if let Some(run) = self.runs.get(&p.chat_id)
            && run.route == route_key(Some(&selection))
            && let Some(runner) = self.runners.get(&run.provider) {
            runner.configure(&p.chat_id, &selection);
        }
        let mut reset_fast = false;
        self.edit(&p.chat_id, |doc| {
            let before = doc.get("selection").cloned().unwrap_or(Value::Null);
            let same_route = route_key(Some(&before)) == route_key(Some(&selection));
            // Claude's Fast report described the previous route.
            reset_fast = !same_route || before.get("model") != selection.get("model") || tier(&before) != tier(&selection);
            doc.insert("selection".into(), selection.clone());
            if !same_route {
                doc.insert("accountNeedsSelection".into(), Value::Bool(false));
                doc.remove("lastRunId");
                doc.remove("resume");
            }
        })?;
        for permission in pending {
            if self.accepts_edit(&p.chat_id, &permission)
                && let Some(perm_id) = permission.get("permId").and_then(Value::as_str) {
                let user = UserInfo { id: "modo de permissões".into(), name: "Modo de permissões".into(), role: Role::Owner };
                let reply: PermissionParams = serde_json::from_value(json!({"chatId": p.chat_id, "permId": perm_id, "decision": "allow"})).unwrap();
                let _ = self.respond_permission(reply, &user);
            }
        }
        if reset_fast {
            self.update_runtime(&p.chat_id, |rt| {
                if let Some(rt) = rt {
                    rt.fast = None;
                }
            });
        }
        ok()
    }

    fn confirm_account(&mut self, p: ChatIdParams) -> Result<Value, HostError> {
        if !self.running(&p.chat_id) {
            self.edit(&p.chat_id, |doc| {
                doc.insert("accountNeedsSelection".into(), Value::Bool(false));
            })?;
        }
        ok()
    }

    fn bind_workspace(&mut self, p: BindWorkspaceParams) -> Result<Value, HostError> {
        if self.running(&p.chat_id) {
            return Err(busy("Pare a tarefa antes de trocar a pasta."));
        }
        self.edit(&p.chat_id, |doc| {
            let has_turns = doc.get("turns").and_then(Value::as_array).is_some_and(|t| !t.is_empty());
            if has_turns && !truthy(doc.get("workspaceNeedsBinding")) {
                return;
            }
            doc.insert("cwd".into(), Value::String(p.cwd.clone()));
            match &p.remote_id {
                Some(remote) => doc.insert("remoteId".into(), Value::String(remote.clone())),
                None => doc.remove("remoteId"),
            };
            doc.insert("workspaceNeedsBinding".into(), Value::Bool(false));
            match (&p.remote_id, &p.remote_target) {
                (Some(_), Some(target)) => doc.insert("remoteTarget".into(), target.clone()),
                _ => doc.remove("remoteTarget"),
            };
            doc.remove("resume");
            // SSH chats always run the server's terminal Claude.
            if p.remote_id.is_some() {
                let mut selection = doc.get("selection").and_then(Value::as_object).cloned().unwrap_or_default();
                selection.insert("provider".into(), "claude".into());
                selection.insert("profileId".into(), "ambient-claude".into());
                if let Some(model) = &p.model {
                    selection.insert("model".into(), Value::String(model.clone()));
                }
                doc.insert("selection".into(), Value::Object(selection));
            }
        })?;
        ok()
    }

    fn rename(&mut self, p: RenameParams) -> Result<Value, HostError> {
        let title: String = p.title.trim().chars().take(100).collect();
        if !title.is_empty() {
            self.edit(&p.chat_id, |doc| {
                doc.insert("title".into(), Value::String(title));
            })?;
        }
        ok()
    }

    fn archive(&mut self, p: ArchiveParams) -> Result<Value, HostError> {
        // Archiving waits for the run to stop; bringing a chat back never has to.
        if p.archived && self.running(&p.chat_id) {
            return Err(busy("Pare a tarefa antes de arquivar o chat."));
        }
        self.edit(&p.chat_id, |doc| {
            if p.archived {
                doc.insert("archived".into(), Value::Bool(true));
            } else {
                doc.remove("archived");
            }
        })?;
        ok()
    }

    fn set_task(&mut self, p: SetTaskParams) -> Result<Value, HostError> {
        self.edit(&p.chat_id, |doc| {
            match &p.task_id {
                Some(task) => doc.insert("taskId".into(), Value::String(task.clone())),
                None => doc.remove("taskId"),
            };
        })?;
        ok()
    }

    fn remove(&mut self, p: ChatIdParams) -> Result<Value, HostError> {
        if self.running(&p.chat_id) || self.native_descendants_busy(&p.chat_id) {
            return Err(busy("Pare a tarefa antes de excluir o chat."));
        }
        self.store.remove_chat(&p.chat_id).map_err(store_error)?;
        self.runtime.remove(&p.chat_id);
        self.delta(ChatDelta::Remove(ChatRef { chat_id: p.chat_id }));
        ok()
    }

    /// `moveChatsToTerminal`: a removed profile's chats continue on its
    /// provider's terminal account, starting a new native session.
    fn reassign_profile(&mut self, p: ReassignProfileParams) -> Result<Value, HostError> {
        let mut targets = Vec::new();
        for doc in self.store.documents(kinds::CHATS).map_err(store_error)? {
            let selection = doc.get("selection");
            if selection.and_then(|s| s.get("profileId")).and_then(Value::as_str) != Some(p.profile_id.as_str()) {
                continue;
            }
            let provider = selection.and_then(|s| s.get("provider")).and_then(Value::as_str).unwrap_or_default().to_string();
            if let Some(id) = doc.get("id").and_then(Value::as_str) {
                targets.push((id.to_string(), provider));
            }
        }
        if targets.iter().any(|(id, _)| self.running(id)) {
            return Err(busy("Pare as tarefas desta conta antes de removê-la."));
        }
        for (id, provider) in &targets {
            self.edit(id, |doc| {
                if let Some(selection) = doc.get_mut("selection").and_then(Value::as_object_mut) {
                    selection.insert("profileId".into(), Value::String(format!("ambient-{provider}")));
                }
                doc.remove("resume");
                doc.remove("lastRunId");
            })?;
        }
        answer(Reassigned { moved: targets.len() as u32 })
    }

    /// The profiles a turn runs on, sorted (a route is `provider:profileId`).
    fn busy_profiles(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.runtime.values().filter(|rt| rt.busy).filter_map(|rt| rt.route.split_once(':').map(|(_, id)| id.to_string())).collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// A profile's login changed (linked to Traycer or back): the chats
    /// resuming its native sessions start new ones, as `retarget` did.
    fn forget_sessions(&mut self, p: ProfileRefParams) -> Result<Value, HostError> {
        let route = format!("{}:{}", p.provider, p.id);
        if self.runtime.values().any(|rt| rt.busy && rt.route == route) {
            return Err(busy("Pare as tarefas desta conta antes de trocar o login dela."));
        }
        self.forget_route(&route)?;
        ok()
    }

    /// The chats resuming `route`'s native sessions drop them.
    fn forget_route(&mut self, route: &str) -> Result<(), HostError> {
        let mut ids = Vec::new();
        for doc in self.store.documents(kinds::CHATS).map_err(store_error)? {
            if doc.pointer("/resume/route").and_then(Value::as_str) == Some(route)
                && let Some(id) = doc.get("id").and_then(Value::as_str)
            {
                ids.push(id.to_string());
            }
        }
        for id in ids {
            self.edit(&id, |doc| {
                doc.remove("resume");
            })?;
        }
        Ok(())
    }

    /// `ChatsDomain::exclusive`: an account change with no turn on the
    /// account, none able to start before it is done.
    fn exclusive(&mut self, provider: &str, profile_id: &str, refusal: &str, hold: Hold, work: ExclusiveWork) -> Result<(), HostError> {
        let route = format!("{provider}:{profile_id}");
        if self.runtime.values().any(|rt| rt.busy && rt.route == route) {
            return Err(busy(refusal));
        }
        match hold {
            Hold::Nothing => {}
            Hold::ForgetSessions => self.forget_route(&route)?,
            Hold::Reassign => {
                self.reassign_profile(ReassignProfileParams { profile_id: profile_id.to_string() })?;
            }
        }
        work()
    }

    // ---- turns ----

    /// `send` of lib/agentChats.ts: the user's turn and the assistant's,
    /// journaled as a `begin`, then the provider starts.
    fn send(&mut self, p: SendParams, user: &UserInfo) -> Result<Value, HostError> {
        let images = p.images.as_deref().unwrap_or_default();
        if images.len() > 8 || images.iter().map(|i| i.data.len()).sum::<usize>() > 12 * 1024 * 1024
            || images.iter().any(|i| !["image/png", "image/jpeg", "image/gif", "image/webp"].contains(&i.mime.as_str()) || i.data.is_empty()) {
            return Err(invalid("Anexos inválidos: use PNG, JPEG, GIF ou WebP, até 8 imagens e 8 MB no total."));
        }
        if p.text.trim().is_empty() && images.is_empty() {
            return Err(invalid("Escreva uma mensagem."));
        }
        if self.running(&p.chat_id) {
            return Err(busy(RUNNING));
        }
        let chat = self.store.chat(&p.chat_id).map_err(store_error)?.ok_or_else(not_found)?;
        if truthy(chat.get("readOnly")) { return Err(invalid("Esta conversa é somente leitura.")); }
        if truthy(chat.get("workspaceNeedsBinding")) || truthy(chat.get("accountNeedsSelection")) {
            return Err(invalid("Confirme a pasta e a conta deste chat importado antes de continuar."));
        }
        if truthy(chat.get("remoteId")) {
            return Err(invalid("Este chat usa o SSH do modo antigo e roda pela janela, não pelo host."));
        }
        let selection = chat.get("selection").cloned().unwrap_or(Value::Null);
        let provider = selection.get("provider").and_then(Value::as_str).unwrap_or_default().to_string();
        let Some(runner) = self.runners.get(&provider).cloned() else {
            return Err(invalid(if provider == "claude" { "O Claude está desligado neste host (PRISM_CLAUDE_ENGINE=sdk)." } else { "Provedor desconhecido." }));
        };

        let uploaded = images.iter().map(|image| serde_json::to_value(image).unwrap()).collect::<Vec<_>>();
        let attached = number_new_images(&chat, &uploaded).map_err(|message| invalid(&message))?;
        let resolved = resolve_image_references(&chat, &p.text, &attached).map_err(|message| invalid(&message))?;
        let stored_images = image_attachments_for_history(&chat, &attached, &resolved.images);
        let turn_id = new_id();
        let (request, resume) = continuation_prompt(&chat, &resolved.prompt);
        let context = p.context.as_deref().filter(|c| !c.is_empty());
        let prompt = match context {
            Some(context) => format!("{request}\n\nArquivo aberto como contexto:\n{context}"),
            None => request,
        };
        let now = crate::now_ms();
        let user_text = match context {
            Some(context) => format!("{}\n\n{context}", p.text),
            None => p.text.clone(),
        };
        let mut user_turn = json!({ "id": new_id(), "role": "user", "text": user_text });
        if !stored_images.is_empty() {
            user_turn["images"] = json!(stored_images);
        }
        let mut assistant = Map::new();
        assistant.insert("id".into(), Value::String(turn_id.clone()));
        assistant.insert("role".into(), "assistant".into());
        assistant.insert("text".into(), "".into());
        assistant.insert("segments".into(), json!([]));
        assistant.insert("provider".into(), Value::String(provider.clone()));
        assistant.insert("selection".into(), selection.clone());
        if let Some(name) = p.profile_name.as_ref().filter(|n| !n.is_empty()) {
            assistant.insert("profileName".into(), Value::String(name.clone()));
        }
        if let Some(model) = selection.get("model") {
            assistant.insert("model".into(), model.clone());
        }
        assistant.insert("startedAt".into(), json!(now));

        let mut next = chat.clone();
        let fresh = next.get("turns").and_then(Value::as_array).is_none_or(|t| t.is_empty());
        if let Some(doc) = next.as_object_mut() {
            doc.insert("pendingTurnId".into(), Value::String(turn_id.clone()));
            doc.insert("lastRunId".into(), Value::String(turn_id.clone()));
            if fresh {
                doc.insert("title".into(), Value::String(first_title(if p.text.trim().is_empty() { "Imagem" } else { &p.text })));
            }
            doc.insert("updatedAt".into(), json!(now));
            let turns = doc.entry("turns").or_insert_with(|| json!([]));
            if let Some(turns) = turns.as_array_mut() {
                turns.push(user_turn.clone());
                turns.push(Value::Object(assistant.clone()));
            }
        }
        let (stored, _begin) = self.store.begin_turn(&next, &turn_id, Some(&user.id)).map_err(store_error)?;
        let assistant = stored
            .get("turns")
            .and_then(Value::as_array)
            .and_then(|turns| turns.iter().find(|t| t.get("id").and_then(Value::as_str) == Some(turn_id.as_str())).cloned())
            .unwrap_or(Value::Object(assistant));
        self.delta(ChatDelta::Turn(TurnUpsert { chat_id: p.chat_id.clone(), turn: user_turn }));
        self.delta(ChatDelta::Turn(TurnUpsert { chat_id: p.chat_id.clone(), turn: assistant }));
        let mut patch = Map::new();
        for field in ["pendingTurnId", "lastRunId", "title", "updatedAt"] {
            patch.insert(field.into(), stored.get(field).cloned().unwrap_or(Value::Null));
        }
        self.delta(ChatDelta::Patch(ChatPatch { chat_id: p.chat_id.clone(), patch }));

        let route = route_key(Some(&selection));
        // The last Fast report stays until this turn's own init replaces it.
        let fast = self.runtime.get(&p.chat_id).and_then(|rt| rt.fast.clone());
        let runtime = ChatRuntime { turn_id: turn_id.clone(), route: route.clone(), busy: true, permission: None, question: None, fast };
        self.update_runtime(&p.chat_id, |rt| *rt = Some(runtime));
        self.runs.insert(
            p.chat_id.clone(),
            Run {
                turn_id: turn_id.clone(),
                provider,
                route,
                tools: HashMap::new(),
                permissions: VecDeque::new(),
                questions: VecDeque::new(),
                resume: stored.get("resume").cloned(),
                session: None,
                error_code: None,
                abort_requested: false,
                startup: None,
                _hold: self.activity.as_ref().map(|activity| activity.hold()),
            },
        );

        let start = TurnStart {
            chat_id: p.chat_id.clone(),
            turn_id: turn_id.clone(),
            prompt,
            images: resolved.images,
            cwd: chat.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string(),
            resume,
            selection,
            service_tier: p.service_tier.filter(|t| !t.is_empty()),
        };
        let sink = TurnSink { tx: self.tx.clone(), chat_id: p.chat_id.clone(), turn_id: turn_id.clone() };
        // A synchronous runner failure must not terminate the chats actor.
        let started = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runner.start(start, sink)));
        let started = self.handle.spawn(async move {
            match started {
                Ok(future) => future.await,
                Err(_) => Err(STARTUP_FAILED.to_string()),
            }
        });
        let abort = started.abort_handle();
        let tx = self.tx.clone();
        let start_chat_id = p.chat_id.clone();
        let (chat_id, turn) = (p.chat_id, turn_id.clone());
        let task = self.handle.spawn(async move {
            let result = match started.await {
                Ok(result) => result,
                Err(error) => {
                    tracing::warn!(chat = %chat_id, turn = %turn, panicked = error.is_panic(), "o início do provedor terminou sem resposta");
                    // A panicking launch may already have created its session.
                    // Keep a poisoned runner from taking down this supervisor too.
                    if error.is_panic() {
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runner.abort(&chat_id, &turn)));
                    }
                    Err(STARTUP_FAILED.to_string())
                }
            };
            let _ = tx.send(Msg::Started { chat_id, turn_id: turn, result });
        });
        self.runs.get_mut(&start_chat_id).expect("the start belongs to this run").startup = Some(Startup { task, abort });
        answer(SendResult { turn_id })
    }

    fn started(&mut self, chat_id: &str, turn_id: &str, result: Result<(), String>) {
        let Some(run) = self.runs.get_mut(chat_id).filter(|run| run.turn_id == turn_id) else { return };
        run.startup = None;
        match result {
            // Refused before it began: the turn ends with the reason.
            Err(message) => {
                let stopped = run.abort_requested;
                self.finish(chat_id, (!stopped).then_some(message), stopped);
            }
            Ok(()) => {
                // A stop that arrived before the provider had the turn.
                if run.abort_requested
                    && let Some(runner) = self.runners.get(&run.provider)
                {
                    runner.abort(chat_id, turn_id);
                }
            }
        }
    }

    fn steer(&mut self, value: Value, user: &UserInfo, reply: tokio::sync::oneshot::Sender<Result<Value, HostError>>) {
        self.flush();
        let queue_id = value.get("queueId").and_then(Value::as_str).map(str::to_string);
        let prepared = (|| {
            let p: SteerParams = params(value)?;
            let run = self.runs.get(&p.chat_id).filter(|r| r.turn_id == p.turn_id && !r.abort_requested)
                .ok_or_else(|| invalid("O turno já terminou ou está sendo interrompido. A mensagem continua na fila."))?;
            if !run.permissions.is_empty() || !run.questions.is_empty() {
                return Err(invalid("Responda à aprovação ou pergunta antes de enviar durante o turno."));
            }
            let images = p.images.unwrap_or_default();
            if p.text.trim().is_empty() && images.is_empty() { return Err(invalid("Digite uma mensagem.")); }
            let text = p.context.as_ref().filter(|s| !s.is_empty()).map_or_else(|| p.text.clone(), |c| format!("{}\n\n{c}", p.text));
            let images: Vec<Value> = images.iter().map(|image| serde_json::to_value(image).unwrap()).collect();
            let chat = self.store.chat(&p.chat_id).map_err(store_error)?.ok_or_else(not_found)?;
            let attached = number_new_images(&chat, &images).map_err(|message| invalid(&message))?;
            let resolved = resolve_image_references(&chat, &p.text, &attached).map_err(|message| invalid(&message))?;
            let stored_images = image_attachments_for_history(&chat, &attached, &resolved.images);
            let prompt = p.context.as_ref().filter(|s| !s.is_empty()).map_or_else(|| resolved.prompt.clone(), |c| format!("{}\n\n{c}", resolved.prompt));
            let segment = json!({"kind": "user", "toolId": uuid::Uuid::new_v4().to_string(), "text": text, "images": stored_images, "sentAt": crate::now_ms()});
            let runner = self.runners.get(&run.provider).ok_or_else(|| invalid("Provedor indisponível."))?;
            let future = runner.steer(p.chat_id.clone(), p.turn_id.clone(), prompt, resolved.images);
            Ok((p.chat_id, p.turn_id, segment, future))
        })();
        match prepared {
            Err(error) => {
                if queue_id.is_some() { self.queue_sending.retain(|_, id| Some(id.as_str()) != queue_id.as_deref()); }
                let _ = reply.send(Err(error));
            }
            Ok((chat_id, turn_id, segment, future)) => {
                let tx = self.tx.clone();
                let actor = user.id.clone();
                self.handle.spawn(async move {
                    let result = future.await;
                    let _ = tx.send(Msg::Steered { queue_id, chat_id, turn_id, segment, actor, result, reply });
                });
            }
        }
    }

    fn stop(&mut self, p: ChatIdParams) -> Result<Value, HostError> {
        if self.store.document(kinds::CHATS, &p.chat_id).map_err(store_error)?.is_some() {
            self.edit(&p.chat_id, |doc| { doc.insert("queuePaused".into(), json!(true)); })?;
        }
        if let Some(run) = self.runs.get_mut(&p.chat_id) {
            run.abort_requested = true;
            if let Some(runner) = self.runners.get(&run.provider) {
                runner.abort(&p.chat_id, &run.turn_id);
            }
            if let Some(startup) = run.startup.take() {
                // Drop the pending start so it cannot launch after Stop. The
                // provider abort above also handles a partially created session.
                startup.abort.abort();
                let runner = self.runners.get(&run.provider).cloned();
                let sink = TurnSink { tx: self.tx.clone(), chat_id: p.chat_id.clone(), turn_id: run.turn_id.clone() };
                self.handle.spawn(async move {
                    // Cancellation is cooperative. If the launch completed in
                    // the same instant, stop that session before releasing the chat.
                    let _ = startup.task.await;
                    if let Some(runner) = runner {
                        runner.abort(&sink.chat_id, &sink.turn_id);
                    }
                    sink.send(TurnEvent::Done { aborted: true });
                });
            }
        }
        ok()
    }

    fn respond_permission(&mut self, p: PermissionParams, user: &UserInfo) -> Result<Value, HostError> {
        let Some(run) = self.runs.get_mut(&p.chat_id) else { return Err(gone(PERMISSION_GONE)) };
        let Some(index) = run.permissions.iter().position(|q| q.get("permId").and_then(Value::as_str) == Some(p.perm_id.as_str())) else {
            return Err(gone(PERMISSION_GONE));
        };
        let pending = run.permissions.remove(index).unwrap_or_default();
        let decision = match p.decision {
            PermissionDecision::Allow => "allow",
            PermissionDecision::AllowAlways => "allow_always",
            PermissionDecision::Deny => "deny",
        };
        let turn_id = run.turn_id.clone();
        let tool = pending.get("toolUseId").and_then(key).and_then(|id| run.tools.get_mut(&id)).and_then(|segment| {
            segment.as_object_mut()?.insert("status".into(), (if decision == "deny" { "denied" } else { "running" }).into());
            Some(segment.clone())
        });
        if let Some(runner) = self.runners.get(&run.provider) {
            runner.permission(&p.chat_id, &turn_id, &p.perm_id, decision, p.updated_input);
        }
        if let Some(segment) = tool {
            self.segment(&p.chat_id, &turn_id, segment, Some(&user.id));
        }
        self.sync_prompts(&p.chat_id);
        ok()
    }

    fn respond_question(&mut self, p: QuestionParams) -> Result<Value, HostError> {
        let Some(run) = self.runs.get_mut(&p.chat_id) else { return Err(gone(QUESTION_GONE)) };
        let Some(index) = run.questions.iter().position(|q| q.get("dialogId").and_then(Value::as_str) == Some(p.dialog_id.as_str())) else {
            return Err(gone(QUESTION_GONE));
        };
        run.questions.remove(index);
        let answers = p.answers.map(|answers| answers.into_iter().map(|(question, choice)| (question, Value::String(choice))).collect::<Map<_, _>>());
        if let Some(runner) = self.runners.get(&run.provider) {
            runner.question(&p.chat_id, &run.turn_id, &p.dialog_id, answers, p.response);
        }
        self.sync_prompts(&p.chat_id);
        ok()
    }


    fn accepts_edit(&self, chat_id: &str, payload: &Value) -> bool {
        let Ok(Some(chat)) = self.store.chat(chat_id) else { return false };
        let selection = chat.get("selection");
        if self.runs.get(chat_id).is_none_or(|run| run.route != route_key(selection)) { return false; }
        let mode = selection.and_then(|s| s.get("permissionMode")).and_then(Value::as_str);
        if mode == Some("bypassPermissions") { return true; }
        if mode != Some("acceptEdits") || truthy(payload.get("blockedPath")) { return false; }
        let tool = payload.get("toolName").and_then(Value::as_str).unwrap_or_default();
        if !matches!(tool, "Edit" | "Write" | "MultiEdit" | "NotebookEdit") { return false; }
        let input = payload.get("input");
        let target = ["file_path", "notebook_path", "path", "grantRoot"].iter().find_map(|key| input.and_then(|i| i.get(key)).and_then(Value::as_str));
        let Some(target) = target else { return false; };
        let Some(cwd) = chat.get("cwd").and_then(Value::as_str) else { return false; };
        let Ok(root) = std::fs::canonicalize(cwd) else { return false; };
        let path = std::path::Path::new(target);
        let mut resolved = if path.is_absolute() { path.to_path_buf() } else { root.join(path) };
        let mut normalized = std::path::PathBuf::new();
        for component in resolved.components() {
            match component {
                std::path::Component::ParentDir => { normalized.pop(); }
                std::path::Component::CurDir => {}
                other => normalized.push(other.as_os_str()),
            }
        }
        resolved = normalized;
        // Windows canonical paths have a verbatim prefix; compare canonical ancestors below.
        while !resolved.exists() { if !resolved.pop() { return false; } }
        std::fs::canonicalize(resolved).is_ok_and(|p| p.starts_with(root))
    }

    fn turn_event(&mut self, chat_id: &str, turn_id: &str, event: TurnEvent) {
        if let TurnEvent::Subagent(agent) = event {
            self.subagent_event(chat_id, turn_id, agent);
            return;
        }
        let auto_edit = if let TurnEvent::Permission(payload) = &event { self.accepts_edit(chat_id, payload) } else { false };
        let Some(run) = self.runs.get_mut(chat_id).filter(|run| run.turn_id == turn_id) else { return };
        match event {
            TurnEvent::Subagent(_) => unreachable!("native child activity is independent of the root run"),
            TurnEvent::Text(text) => self.stream(chat_id, turn_id, AppendKind::Text, text),
            TurnEvent::Thinking(text) => self.stream(chat_id, turn_id, AppendKind::Thinking, text),
            TurnEvent::Tool { tool_id, name, input } => {
                let mut segment = Map::new();
                segment.insert("kind".into(), "tool".into());
                segment.insert("toolId".into(), Value::String(tool_id.clone()));
                segment.insert("name".into(), name);
                if let Some(input) = input {
                    segment.insert("input".into(), input);
                }
                segment.insert("status".into(), "running".into());
                let segment = Value::Object(segment);
                run.tools.insert(tool_id, segment.clone());
                self.segment(chat_id, turn_id, segment, None);
            }
            TurnEvent::ToolResult { tool_id, content, is_error } => {
                let Some(segment) = run.tools.get_mut(&tool_id).and_then(Value::as_object_mut) else { return };
                if let Some(content) = &content {
                    let images = prism_agents::codex::convert::content_images(content);
                    if !images.is_empty() { segment.insert("images".into(), json!(images)); }
                }
                match content {
                    Some(content) => segment.insert("result".into(), content),
                    None => segment.remove("result"),
                };
                segment.insert("resultIsError".into(), Value::Bool(is_error));
                segment.insert("status".into(), (if is_error { "error" } else { "done" }).into());
                let segment = Value::Object(segment.clone());
                self.segment(chat_id, turn_id, segment, None);
            }
            TurnEvent::Segment(segment) => {
                if let Some(id) = tool_key(&segment) {
                    run.tools.insert(id, segment.clone());
                }
                self.segment(chat_id, turn_id, segment, None);
            }
            TurnEvent::Permission(payload) => {
                let awaiting = payload.get("toolUseId").and_then(key).and_then(|id| run.tools.get_mut(&id)).and_then(|segment| {
                    segment.as_object_mut()?.insert("status".into(), "awaiting".into());
                    Some(segment.clone())
                });
                let perm_id = payload.get("permId").and_then(Value::as_str).map(str::to_string);
                run.permissions.push_back(payload);
                if let Some(segment) = awaiting {
                    self.segment(chat_id, turn_id, segment, None);
                }
                self.sync_prompts(chat_id);
                if auto_edit && let Some(perm_id) = perm_id {
                    let user = UserInfo { id: "modo de permissões".into(), name: "Modo de permissões".into(), role: Role::Owner };
                    let p: PermissionParams = serde_json::from_value(json!({"chatId": chat_id, "permId": perm_id, "decision": "allow"})).unwrap();
                    let _ = self.respond_permission(p, &user);
                }
                self.flush();
            }
            TurnEvent::Question(payload) => {
                run.questions.push_back(payload);
                self.sync_prompts(chat_id);
                self.flush();
            }
            TurnEvent::Metrics(metrics) => {
                self.record(chat_id, turn_id, json!({ "kind": "metrics", "metrics": metrics }), None);
                self.delta(ChatDelta::Metrics(TurnMetrics { chat_id: chat_id.to_string(), turn_id: turn_id.to_string(), metrics }));
            }
            TurnEvent::Session(session_id) => {
                if session_id.is_empty() {
                    return;
                }
                let resume = json!({ "route": run.route, "sessionId": session_id });
                let changed = run.resume.as_ref() != Some(&resume);
                let journal = run.session.as_deref() != Some(session_id.as_str());
                run.resume = Some(resume.clone());
                run.session = Some(session_id.clone());
                if journal {
                    self.record(chat_id, turn_id, json!({ "kind": "session", "sessionId": session_id }), None);
                }
                if changed {
                    let patch = Map::from_iter([("resume".to_string(), resume)]);
                    self.delta(ChatDelta::Patch(ChatPatch { chat_id: chat_id.to_string(), patch }));
                }
            }
            TurnEvent::Fast { state, reason } => {
                let report = FastReport { state, reason };
                self.update_runtime(chat_id, |rt| {
                    if let Some(rt) = rt {
                        rt.fast = Some(report);
                    }
                });
            }
            TurnEvent::Done { aborted } => { let stopped = run.abort_requested; self.finish(chat_id, None, aborted || stopped); },
            TurnEvent::ErrorCode(code) => run.error_code = Some(code),
            TurnEvent::Error(message) => { let stopped = run.abort_requested; self.finish(chat_id, (!stopped).then_some(message), stopped); },
        }
    }

    fn stream(&mut self, chat_id: &str, turn_id: &str, kind: AppendKind, text: String) {
        if text.is_empty() {
            return;
        }
        let name = match kind {
            AppendKind::Text => "text",
            AppendKind::Thinking => "thinking",
        };
        self.record(chat_id, turn_id, json!({ "kind": name, "text": text }), None);
        self.delta(ChatDelta::Append(TurnAppend { chat_id: chat_id.to_string(), turn_id: turn_id.to_string(), kind, text }));
    }

    fn segment(&mut self, chat_id: &str, turn_id: &str, segment: Value, actor: Option<&str>) {
        self.record(chat_id, turn_id, json!({ "kind": "segment", "segment": segment }), actor);
        self.delta(ChatDelta::Segment(TurnSegment { chat_id: chat_id.to_string(), turn_id: turn_id.to_string(), segment }));
    }

    /// `finish` of lib/agentChats.ts, through the journal: `done`/`error`,
    /// then the folded chat with its `updatedAt`, published as the turn,
    /// the chat's fields and the idle runtime (in that order, one batch).
    fn finish(&mut self, chat_id: &str, error: Option<String>, aborted: bool) {
        let Some(run) = self.runs.remove(chat_id) else { return };
        let at = crate::now_ms();
        let body = match (&error, &run.error_code) {
            (Some(message), Some(code)) => json!({ "kind": "error", "message": message, "at": at, "code": code }),
            (Some(message), None) => json!({ "kind": "error", "message": message, "at": at }),
            (None, _) => json!({ "kind": "done", "aborted": aborted, "at": at }),
        };
        self.record(chat_id, &run.turn_id, body, None);
        self.flush();
        match self.store.chat(chat_id) {
            Ok(Some(mut chat)) => {
                if let Some(doc) = chat.as_object_mut() {
                    doc.insert("updatedAt".into(), json!(at));
                }
                match self.store.put_chat(&chat) {
                    Ok(stored) => chat = stored,
                    Err(err) => tracing::warn!(%err, chat = chat_id, "falha ao gravar o fim do turno"),
                }
                let turn = chat
                    .get("turns")
                    .and_then(Value::as_array)
                    .and_then(|turns| turns.iter().find(|t| t.get("id").and_then(Value::as_str) == Some(run.turn_id.as_str())).cloned());
                if let Some(turn) = turn {
                    self.delta(ChatDelta::Turn(TurnUpsert { chat_id: chat_id.to_string(), turn }));
                }
                let mut patch = Map::new();
                for field in ["updatedAt", "pendingTurnId", "resume"] {
                    patch.insert(field.into(), chat.get(field).cloned().unwrap_or(Value::Null));
                }
                self.delta(ChatDelta::Patch(ChatPatch { chat_id: chat_id.to_string(), patch }));
            }
            Ok(None) => {}
            Err(err) => tracing::warn!(%err, chat = chat_id, "falha ao ler o chat no fim do turno"),
        }
        self.update_runtime(chat_id, |rt| {
            if let Some(rt) = rt {
                rt.busy = false;
                rt.permission = None;
                rt.question = None;
            }
        });
        drop(run);
        self.flush();
        if aborted || error.is_some() {
            let _ = self.edit(chat_id, |doc| { doc.insert("queuePaused".into(), json!(true)); });
            self.flush();
        } else { self.flush_queue(chat_id); }
    }

    // ---- runtime ----

    fn update_runtime(&mut self, chat_id: &str, change: impl FnOnce(&mut Option<ChatRuntime>)) {
        let before = self.runtime.get(chat_id).cloned();
        let mut after = before.clone();
        change(&mut after);
        if after == before {
            return;
        }
        match &after {
            Some(runtime) => self.runtime.insert(chat_id.to_string(), runtime.clone()),
            None => self.runtime.remove(chat_id),
        };
        self.delta(ChatDelta::Runtime(ChatRuntimeUpdate { chat_id: chat_id.to_string(), runtime: after }));
    }

    /// The runtime shows the oldest pending approval and question.
    fn sync_prompts(&mut self, chat_id: &str) {
        let (permission, question) =
            self.runs.get(chat_id).map(|run| (run.permissions.front().cloned(), run.questions.front().cloned())).unwrap_or_default();
        self.update_runtime(chat_id, |rt| {
            if let Some(rt) = rt {
                rt.permission = permission;
                rt.question = question;
            }
        });
    }

    // ---- journal and deltas ----

    fn schedule(&mut self) {
        self.deadline.get_or_insert_with(|| Instant::now() + BATCH);
    }

    /// Queues a journal event. Consecutive text of one turn becomes one
    /// event, and a newer snapshot of a tool replaces the queued one (as the
    /// TypeScript repository's queue did).
    fn record(&mut self, chat_id: &str, turn_id: &str, body: Value, actor: Option<&str>) {
        let kind = body.get("kind").and_then(Value::as_str).unwrap_or_default().to_string();
        let same = |e: &NewEvent| e.chat_id == chat_id && e.turn_id == turn_id && e.kind() == Some(kind.as_str());
        if matches!(kind.as_str(), "text" | "thinking")
            && let Some(last) = self.events.last_mut()
            && same(last)
            && last.actor.as_deref() == actor
            && let (Some(Value::String(text)), Some(more)) = (last.body.get_mut("text"), body.get("text").and_then(Value::as_str))
        {
            text.push_str(more);
            return;
        }
        let mut event = NewEvent::raw(chat_id, turn_id, body);
        event.actor = actor.map(str::to_string);
        if kind == "segment"
            && let Some(id) = event.body.get("segment").and_then(tool_key)
            && let Some(slot) = self.events.iter().position(|e| same(e) && e.body.get("segment").and_then(tool_key).as_deref() == Some(id.as_str()))
        {
            self.events[slot] = event;
            return;
        }
        self.events.push(event);
        self.schedule();
    }

    /// Queues a delta, merging streamed text into the previous append of the
    /// same turn and a newer tool snapshot into the queued one.
    fn delta(&mut self, delta: ChatDelta) {
        if let ChatDelta::Append(next) = &delta
            && let Some(ChatDelta::Append(last)) = self.deltas.last_mut()
            && last.chat_id == next.chat_id
            && last.turn_id == next.turn_id
            && last.kind == next.kind
        {
            last.text.push_str(&next.text);
            return;
        }
        if let Some(slot) = self.segment_slot(&delta) {
            self.deltas[slot] = delta;
            return;
        }
        self.deltas.push(delta);
        self.schedule();
    }

    /// Where a queued snapshot of the same tool sits, unless the turn or the
    /// chat was replaced after it (the order matters then).
    fn segment_slot(&self, delta: &ChatDelta) -> Option<usize> {
        let ChatDelta::Segment(next) = delta else { return None };
        let id = tool_key(&next.segment)?;
        for (slot, queued) in self.deltas.iter().enumerate().rev() {
            match queued {
                ChatDelta::Segment(prior)
                    if prior.chat_id == next.chat_id && prior.turn_id == next.turn_id && tool_key(&prior.segment).as_deref() == Some(id.as_str()) =>
                {
                    return Some(slot);
                }
                ChatDelta::Chat(ChatUpsert { chat }) if chat.get("id").and_then(Value::as_str) == Some(next.chat_id.as_str()) => return None,
                ChatDelta::Turn(TurnUpsert { chat_id, .. }) | ChatDelta::Remove(ChatRef { chat_id }) if *chat_id == next.chat_id => return None,
                _ => {}
            }
        }
        None
    }

    /// Commits the queued journal events, then sends the queued deltas to
    /// every subscriber as one batch.
    pub(super) fn flush(&mut self) {
        self.deadline = None;
        if !self.events.is_empty() {
            let events = std::mem::take(&mut self.events);
            if let Err(err) = self.store.append_batch(events) {
                tracing::warn!(%err, "falha ao gravar o diário dos chats");
            }
        }
        if self.deltas.is_empty() {
            return;
        }
        let deltas = std::mem::take(&mut self.deltas);
        if !self.watchers.is_empty() {
            let changes = changes_of(&deltas);
            self.watchers.retain(|tx| tx.send(changes.clone()).is_ok());
        }
        self.rev += deltas.len() as u64;
        let batch = match serde_json::to_value(ChatsDeltaBatch { rev: self.rev, deltas }) {
            Ok(batch) => batch,
            Err(err) => {
                tracing::warn!(%err, "lote de deltas dos chats inválido");
                return;
            }
        };
        self.subscribers.retain(|_, notifier| notifier.send(methods::DELTA, batch.clone()));
    }
}
