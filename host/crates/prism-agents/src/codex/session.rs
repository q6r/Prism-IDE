//! Codex conversations on the host: the port of src/main/ipc/nativeCodex.ts.
//!
//! One app-server process per chat, kept between turns while the route
//! (profile and folder) and the thread stay the same. A turn emits the same
//! `CodexEvent`s the renderer consumes today; approvals and questions go out
//! with the payloads of `agent:permission` / `agent:question`. The client that
//! started a chat owns it: only it can abort, answer or reuse it.

use std::any::Any;
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use super::convert::{
    Segment, apply_delta, codex_metrics, codex_skill_inputs, codex_skill_refs, codex_subtract, codex_turn_usage, delta_kind, js_string,
    native_item, skill_tokens,
};
use super::server::{AppServer, Incoming, js_truthy};
use super::{CodexError, Launcher};

/// Identifies the client (socket) that owns a chat's session.
pub type Owner = u64;

/// Kept while a turn runs (the host's activity hold); dropped when it ends.
pub type Hold = Box<dyn Any + Send + Sync>;

/// How long a turn waits for `skills/list` before going out as text only.
pub const SKILLS_TIMEOUT: Duration = Duration::from_secs(5);

/// `CodexEvent` (src/shared/agents.ts).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CodexEvent {
    pub id: String,
    #[serde(flatten)]
    pub body: EventBody,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum EventBody {
    Subagent { agent: Value },
    Session {
        session_id: String,
    },
    Metrics {
        metrics: Value,
    },
    Segment {
        segment: Box<Segment>,
    },
    Done {
        #[serde(skip_serializing_if = "Option::is_none")]
        aborted: Option<bool>,
    },
    Error {
        message: String,
    },
}

/// Where a chat's output goes: its owner's connection.
pub trait CodexSink: Send + Sync {
    fn event(&self, event: &CodexEvent);
    /// `agent:permission` payload.
    fn permission(&self, payload: Value);
    /// `agent:question` payload.
    fn question(&self, payload: Value);
}

/// `CodexSend` (src/shared/agents.ts). The `chat` snapshot is not needed here.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CodexSend {
    pub id: String,
    pub chat_id: String,
    pub prompt: String,
    pub images: Vec<Value>,
    pub cwd: String,
    pub resume: Option<String>,
    pub selection: Selection,
}

/// `AgentSelection`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Selection {
    pub provider: String,
    pub profile_id: String,
    pub model: String,
    pub effort: Option<Value>,
    pub permission_mode: String,
    pub service_tier: Option<String>,
}

/// The thread total before the active turn.
#[derive(Debug, Clone, Default, PartialEq)]
enum Base {
    /// No update in this turn yet.
    #[default]
    Unset,
    /// The process's first update carried no `last`: unknown.
    Unknown,
    Known(Value),
}

struct Active {
    id: String,
    /// Output belongs to this turn. The host supplies a fresh sink even when
    /// the native process and thread are reused for the next message.
    sink: Arc<dyn CodexSink>,
    _hold: Option<Hold>,
}

#[derive(Default)]
struct State {
    subagents: super::subagents::Subagents,
    thread_id: Option<String>,
    active: Option<Active>,
    native_turn_id: Option<Value>,
    segments: HashMap<String, Segment>,
    /// `codex:<chat>:<id>` → the server request's own id.
    requests: HashMap<String, Value>,
    abort_requested: bool,
    failure: Option<String>,
    grants: HashMap<String, Option<Value>>,
    question_keys: HashMap<String, Vec<(Value, Value)>>,
    turn_base: Base,
    /// The last thread total this process reported.
    last_total: Option<Value>,
}

struct Session {
    chat_id: String,
    owner: Owner,
    /// Profile and folder: a different one needs a fresh process.
    signature: (String, String),
    server: OnceLock<Arc<AppServer>>,
    /// Closed (or abandoned) while its process was still starting.
    dead: AtomicBool,
    st: Mutex<State>,
}

type Chats = Mutex<HashMap<String, Arc<Session>>>;

impl Session {
    fn close(&self) {
        self.dead.store(true, Ordering::SeqCst);
        if let Some(server) = self.server.get() {
            server.close();
        }
    }

    fn emit(&self, st: &State, body: EventBody) {
        if let Some(active) = &st.active {
            active.sink.event(&CodexEvent { id: active.id.clone(), body });
        }
    }

    /// Ends the active turn once: an error, else done.
    fn finish(&self, st: &mut State, error: Option<String>, aborted: Option<bool>) {
        if st.active.is_none() {
            return;
        }
        let body = match error {
            Some(message) => EventBody::Error { message },
            None => EventBody::Done { aborted },
        };
        self.emit(st, body);
        st.active = None;
        st.native_turn_id = None;
        st.abort_requested = false;
        st.requests.clear();
        st.question_keys.clear();
        st.grants.clear();
        st.turn_base = Base::Unset;
    }

    fn interrupt(server: &Arc<AppServer>, thread_id: Option<String>, turn_id: Value) {
        let server = Arc::clone(server);
        tokio::spawn(async move {
            if server.request("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id })).await.is_err() {
                server.close();
            }
        });
    }

    /// One notification or server request.
    fn handle(&self, server: &Arc<AppServer>, msg: Value) {
        let p = msg.get("params").filter(|p| p.is_object()).cloned().unwrap_or_else(|| json!({}));
        let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
        let request_id = msg.get("id").cloned();
        let mut st = self.st.lock().unwrap();
        let root = st.thread_id.clone().unwrap_or_default();
        let origin = st.active.as_ref().map(|active| super::subagents::Origin { id: active.id.clone(), sink: Arc::clone(&active.sink) });
        if st.subagents.handle(&root, origin.as_ref(), &msg) { return; }
        let child_request = request_id.is_some() && p["threadId"].as_str().is_some_and(|id| origin.as_ref().is_some_and(|o| st.subagents.belongs_to(id, &o.id)));
        let other_thread = p.get("threadId").filter(|t| js_truthy(t)).is_some_and(|t| st.thread_id.as_deref().map(|id| json!(id)).as_ref() != Some(t));
        if st.active.is_none() || st.failure.is_some() || (other_thread && !child_request) {
            if let Some(id) = &request_id {
                server.reject(id);
            }
            return;
        }
        if !child_request && let (Some(turn), Some(native)) = (p.get("turnId").filter(|t| js_truthy(t)), &st.native_turn_id)
            && turn != native
        {
            return;
        }
        let active_id = st.active.as_ref().map(|a| a.id.clone()).unwrap_or_default();
        if let Some(id) = request_id {
            let sink = Arc::clone(&st.active.as_ref().unwrap().sink);
            let key = format!("codex:{}:{}", self.chat_id, js_string(&id));
            st.requests.insert(key.clone(), id.clone());
            let mut payload = Map::new();
            payload.insert("id".into(), json!(active_id));
            match method {
                "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                    let mut input = Map::new();
                    for k in ["command", "cwd", "grantRoot"] {
                        copy(&mut input, &p, k);
                    }
                    payload.insert("permId".into(), json!(key));
                    if let Some(item) = p.get("itemId") {
                        payload.insert("toolUseId".into(), item.clone());
                    }
                    payload.insert("toolName".into(), json!(if method.contains("commandExecution") { "Bash" } else { "Write" }));
                    payload.insert("input".into(), Value::Object(input));
                    payload.insert("title".into(), json!(reason(&p, "Codex solicita permissão")));
                    sink.permission(Value::Object(payload));
                }
                "item/permissions/requestApproval" => {
                    st.grants.insert(key.clone(), p.get("permissions").cloned());
                    let mut input = Map::new();
                    copy(&mut input, &p, "cwd");
                    copy(&mut input, &p, "permissions");
                    payload.insert("permId".into(), json!(key));
                    if let Some(item) = p.get("itemId") {
                        payload.insert("toolUseId".into(), item.clone());
                    }
                    payload.insert("toolName".into(), json!("Permissões"));
                    payload.insert("input".into(), Value::Object(input));
                    payload.insert("title".into(), json!(reason(&p, "Codex solicita acesso a arquivos ou rede")));
                    sink.permission(Value::Object(payload));
                }
                "item/tool/requestUserInput" => {
                    let questions: Vec<Value> = p
                        .get("questions")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .enumerate()
                        .filter_map(|(index, q)| {
                            let question = q.get("question").and_then(Value::as_str).filter(|question| !question.trim().is_empty())?;
                            let mut out = q.as_object().cloned().unwrap_or_default();
                            out.insert("question".into(), json!(question));
                            out.insert("id".into(), q.get("id").or_else(|| q.get("questionId")).filter(|id| id.is_string()).cloned().unwrap_or_else(|| json!(index.to_string())));
                            let options = q.get("options").filter(|options| options.is_array()).cloned().unwrap_or_else(|| json!([]));
                            out.insert("options".into(), options);
                            Some(Value::Object(out))
                        })
                        .collect();
                    if questions.is_empty() { st.requests.remove(&key); server.reject(&id); return; }
                    let keys = questions
                        .iter()
                        .map(|q| (q.get("id").cloned().unwrap_or(Value::Null), q.get("question").cloned().unwrap_or(Value::Null)))
                        .collect();
                    st.question_keys.insert(key.clone(), keys);
                    payload.insert("dialogId".into(), json!(key));
                    if let Some(item) = p.get("itemId") { payload.insert("toolUseId".into(), item.clone()); }
                    payload.insert("questions".into(), Value::Array(questions));
                    sink.question(Value::Object(payload));
                }
                _ => {
                    st.requests.remove(&key);
                    server.reject(&id);
                }
            }
            return;
        }
        match method {
            "turn/started" => {
                st.native_turn_id = p.pointer("/turn/id").cloned();
                if st.abort_requested
                    && let Some(turn) = st.native_turn_id.clone()
                {
                    Self::interrupt(server, st.thread_id.clone(), turn);
                }
            }
            "thread/tokenUsage/updated" => {
                let usage = p.get("tokenUsage").cloned().unwrap_or(Value::Null);
                let turn = turn_from_update(&mut st, &usage);
                self.emit(&st, EventBody::Metrics { metrics: codex_metrics(&usage, turn.as_ref()) });
            }
            "item/started" | "item/completed" => {
                let item = p.get("item").cloned().unwrap_or(Value::Null);
                if let Some(segment) = native_item(&item, method == "item/completed") {
                    st.segments.insert(segment_key(item.get("id")), segment.clone());
                    self.emit(&st, EventBody::Segment { segment: Box::new(segment) });
                }
            }
            "turn/completed" => {
                let status = p.pointer("/turn/status").and_then(Value::as_str);
                let error = (status == Some("failed")).then(|| {
                    p.pointer("/turn/error/message").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or("Falha no Codex.").to_string()
                });
                self.finish(&mut st, error, Some(status == Some("interrupted")));
            }
            m => {
                if let Some(kind) = delta_kind(m) {
                    let item_id = p.get("itemId").cloned();
                    let key = segment_key(item_id.as_ref());
                    let mut segment = st.segments.get(&key).cloned().unwrap_or_else(|| Segment::text(kind, item_id, String::new()));
                    apply_delta(&mut segment, p.get("delta").and_then(Value::as_str).unwrap_or_default());
                    st.segments.insert(key, segment.clone());
                    self.emit(&st, EventBody::Segment { segment: Box::new(segment) });
                }
            }
        }
    }
}

fn segment_key(id: Option<&Value>) -> String {
    id.map(Value::to_string).unwrap_or_default()
}

fn reason(p: &Value, fallback: &str) -> String {
    p.get("reason").and_then(Value::as_str).filter(|r| !r.is_empty()).unwrap_or(fallback).to_string()
}

fn copy(out: &mut Map<String, Value>, from: &Value, key: &str) {
    if let Some(value) = from.get(key) {
        out.insert(key.to_string(), value.clone());
    }
}

/// This turn's usage from a `thread/tokenUsage/updated`: the thread total
/// minus the total before the turn. The process's first update has no
/// earlier total, so its base is that update's total minus its `last` call.
fn turn_from_update(st: &mut State, usage: &Value) -> Option<Value> {
    let total = usage.get("total").filter(|t| t.is_object() || t.is_array())?;
    let last = usage.get("last");
    if st.turn_base == Base::Unset {
        st.turn_base = match (&st.last_total, last) {
            (Some(previous), _) => Base::Known(previous.clone()),
            (None, Some(last)) if last.is_object() || last.is_array() => Base::Known(codex_subtract(total, last)),
            _ => Base::Unknown,
        };
    }
    st.last_total = Some(total.clone());
    match &st.turn_base {
        Base::Known(base) => codex_turn_usage(base, total),
        _ => None,
    }
}

/// Every Codex chat this host runs.
pub struct CodexSessions {
    launcher: Arc<dyn Launcher>,
    chats: Arc<Chats>,
}

struct Begun {
    session: Arc<Session>,
    created: bool,
    payload: CodexSend,
}

/// A claimed chat must be released if the start future is cancelled or never polled.
struct Admission {
    sessions: Arc<CodexSessions>,
    session: Arc<Session>,
    created: bool,
    turn_id: String,
    accepted: bool,
}

impl Drop for Admission {
    fn drop(&mut self) {
        if self.accepted { return; }
        let mut st = self.session.st.lock().unwrap();
        if !st.active.as_ref().is_some_and(|turn| turn.id == self.turn_id) { return; }
        st.active = None;
        st.abort_requested = false;
        drop(st);
        if self.created {
            self.session.close();
            let mut chats = self.sessions.chats.lock().unwrap();
            if chats.get(&self.session.chat_id).is_some_and(|s| Arc::ptr_eq(s, &self.session)) {
                chats.remove(&self.session.chat_id);
            }
        }
    }
}

impl CodexSessions {
    pub fn new(launcher: Arc<dyn Launcher>) -> Arc<Self> {
        Arc::new(Self { launcher, chats: Arc::new(Mutex::new(HashMap::new())) })
    }

    /// Starts a turn. Validating and claiming the chat happen before this
    /// returns, so an abort sent right after already finds the turn. The
    /// future resolves once the turn is accepted (its process started); the
    /// rest of the turn runs on its own task and reports through `sink`. An
    /// error means nothing was accepted and no event was emitted.
    pub fn send(self: &Arc<Self>, owner: Owner, sink: Arc<dyn CodexSink>, payload: CodexSend, hold: Option<Hold>) -> impl Future<Output = Result<(), CodexError>> + Send + 'static {
        let begun = self.begin(owner, sink, payload, hold);
        // Construct outside the async body: even an unpolled future owns a claim.
        let admission = begun.as_ref().ok().map(|begun| Admission {
            sessions: Arc::clone(self), session: Arc::clone(&begun.session), created: begun.created,
            turn_id: begun.payload.id.clone(), accepted: false,
        });
        let this = Arc::clone(self);
        async move {
            let mut admission = admission;
            let result = this.accept(begun?).await;
            if result.is_ok() && let Some(admission) = admission.as_mut() {
                admission.accepted = true;
            }
            result
        }
    }

    fn begin(&self, owner: Owner, sink: Arc<dyn CodexSink>, payload: CodexSend, hold: Option<Hold>) -> Result<Begun, CodexError> {
        if payload.id.is_empty() || payload.chat_id.is_empty() || (payload.prompt.trim().is_empty() && payload.images.is_empty()) || payload.selection.provider != "codex" {
            return Err(CodexError::invalid("Mensagem Codex inválida."));
        }
        let mut chats = self.chats.lock().unwrap();
        let mut existing = chats.get(&payload.chat_id).cloned();
        if let Some(s) = &existing
            && (s.owner != owner || s.st.lock().unwrap().active.is_some())
        {
            return Err(CodexError::busy("Este chat já está ocupado em outra execução."));
        }
        let signature = (payload.selection.profile_id.clone(), payload.cwd.clone());
        // A route handoff must create a fresh native thread with transferred
        // history. Never silently reuse the older thread of the returning agent.
        if let Some(s) = &existing {
            let resume = payload.resume.as_deref().filter(|r| !r.is_empty());
            let thread = s.st.lock().unwrap().thread_id.clone();
            if signature != s.signature || resume.is_none() || thread.as_deref() != resume {
                s.close();
                existing = None;
            }
        }
        let created = existing.is_none();
        let session = existing.unwrap_or_else(|| {
            Arc::new(Session {
                chat_id: payload.chat_id.clone(),
                owner,
                signature,
                server: OnceLock::new(),
                dead: AtomicBool::new(false),
                st: Mutex::new(State::default()),
            })
        });
        if created {
            chats.insert(payload.chat_id.clone(), Arc::clone(&session));
        }
        let mut st = session.st.lock().unwrap();
        st.active = Some(Active { id: payload.id.clone(), sink, _hold: hold });
        st.segments.clear();
        st.abort_requested = false;
        st.turn_base = Base::Unset;
        drop(st);
        Ok(Begun { session, created, payload })
    }

    async fn accept(self: Arc<Self>, begun: Begun) -> Result<(), CodexError> {
        let Begun { session, created, payload } = begun;
        let profile = payload.selection.profile_id.clone();
        let launched = match self.launcher.check(profile.clone()).await {
            Err(err) => Err(err),
            Ok(()) if created => {
                let cwd = Some(payload.cwd.clone()).filter(|c| !c.is_empty());
                self.launcher.launch(profile, cwd).await.map(Some)
            }
            Ok(()) => Ok(None),
        };
        let server = match launched {
            Ok(Some(server)) => {
                let _ = session.server.set(Arc::clone(&server));
                tokio::spawn(pump(Arc::clone(&session), Arc::clone(&server), server.take_incoming(), Arc::downgrade(&self.chats)));
                if session.dead.load(Ordering::SeqCst) {
                    server.close();
                }
                Some(server)
            }
            Ok(None) => session.server.get().cloned(),
            Err(err) => {
                self.revert(&session, created);
                return Err(err);
            }
        };
        let Some(server) = server else {
            self.revert(&session, created);
            return Err(CodexError::failed("Codex App Server desconectado."));
        };
        tokio::spawn(run_turn(session, server, payload));
        Ok(())
    }

    /// A send that was not accepted leaves no trace.
    fn revert(&self, session: &Arc<Session>, created: bool) {
        let mut st = session.st.lock().unwrap();
        st.active = None;
        st.abort_requested = false;
        drop(st);
        if created {
            session.dead.store(true, Ordering::SeqCst);
            let mut chats = self.chats.lock().unwrap();
            if chats.get(&session.chat_id).is_some_and(|s| Arc::ptr_eq(s, session)) {
                chats.remove(&session.chat_id);
            }
        }
    }

    fn owned(&self, owner: Owner, chat_id: &str) -> Option<Arc<Session>> {
        self.chats.lock().unwrap().get(chat_id).filter(|s| s.owner == owner).cloned()
    }

    /// Stops the chat's turn: right away when it has started, else as soon as it does.
    pub fn abort(&self, owner: Owner, chat_id: &str) {
        self.abort_matching(owner, chat_id, None);
    }

    /// A delayed cancellation must not interrupt a later turn in the same chat.
    pub fn abort_turn(&self, owner: Owner, chat_id: &str, turn_id: &str) {
        self.abort_matching(owner, chat_id, Some(turn_id));
    }

    fn abort_matching(&self, owner: Owner, chat_id: &str, turn_id: Option<&str>) {
        let Some(s) = self.owned(owner, chat_id) else { return };
        let mut st = s.st.lock().unwrap();
        if st.active.is_none() || turn_id.is_some_and(|id| st.active.as_ref().is_none_or(|turn| turn.id != id)) {
            return;
        }
        st.abort_requested = true;
        let active_id = st.active.as_ref().unwrap().id.clone();
        if let (Some(turn), Some(server)) = (st.native_turn_id.clone(), s.server.get()) {
            Session::interrupt(server, st.thread_id.clone(), turn);
        }
        drop(st);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let st = s.st.lock().unwrap();
            let stalled = st.abort_requested && st.active.as_ref().is_some_and(|a| a.id == active_id);
            drop(st);
            if stalled { s.close(); }
        });
    }

    /// Same-turn input using the app-server's expected turn guard.
    pub async fn steer(&self, owner: Owner, chat_id: &str, turn_id: &str, text: String, images: Vec<Value>) -> Result<(), String> {
        let s = self.owned(owner, chat_id).ok_or("Conversa Codex indisponível.")?;
        let (thread, native) = {
            let st = s.st.lock().unwrap();
            if st.active.as_ref().map(|a| a.id.as_str()) != Some(turn_id) || st.abort_requested {
                return Err("O turno já terminou ou está sendo interrompido.".into());
            }
            (st.thread_id.clone(), st.native_turn_id.clone().ok_or("O Codex ainda está iniciando o turno. Tente novamente.")?)
        };
        let server = s.server.get().ok_or("Codex desconectado.")?;
        let mut input = vec![json!({"type": "text", "text": text, "text_elements": []})];
        input.extend(images.iter().map(|image| json!({"type": "image", "url": format!("data:{};base64,{}", image["mime"].as_str().unwrap_or_default(), image["data"].as_str().unwrap_or_default())})));
        server.request("turn/steer", json!({"threadId": thread, "expectedTurnId": native, "input": input})).await?;
        Ok(())
    }

    /// Answers an approval: `allow`, `allow_always` or anything else (deny).
    pub fn permission(&self, owner: Owner, chat_id: &str, request_id: &str, decision: &str) {
        let Some(s) = self.owned(owner, chat_id) else { return };
        let Some(server) = s.server.get() else { return };
        let mut st = s.st.lock().unwrap();
        if st.active.is_none() {
            return;
        }
        let Some(request) = st.requests.remove(request_id) else { return };
        if let Some(grant) = st.grants.remove(request_id) {
            let mut result = Map::new();
            if decision == "deny" {
                result.insert("permissions".into(), json!({}));
            } else if let Some(grant) = grant {
                result.insert("permissions".into(), grant);
            }
            result.insert("scope".into(), json!(if decision == "allow_always" { "session" } else { "turn" }));
            server.answer(&request, Value::Object(result));
        } else {
            let decision = match decision {
                "allow_always" => "acceptForSession",
                "allow" => "accept",
                _ => "decline",
            };
            server.answer(&request, json!({ "decision": decision }));
        }
    }

    /// Answers a question dialog; `answers` maps question text to the chosen answer.
    pub fn question(&self, owner: Owner, chat_id: &str, request_id: &str, answers: Option<&Map<String, Value>>) {
        let Some(s) = self.owned(owner, chat_id) else { return };
        let Some(server) = s.server.get() else { return };
        let mut st = s.st.lock().unwrap();
        if st.active.is_none() {
            return;
        }
        let Some(request) = st.requests.remove(request_id) else { return };
        let mut out = Map::new();
        for (id, question) in st.question_keys.remove(request_id).into_iter().flatten() {
            let chosen = answers.and_then(|a| a.get(&js_string(&id)).or_else(|| a.get(&js_string(&question)))).filter(|v| js_truthy(v));
            out.insert(js_string(&id), json!({ "answers": chosen.map(|v| vec![v.clone()]).unwrap_or_default() }));
        }
        server.answer(&request, json!({ "answers": out }));
    }

    /// A login changed: idle processes of that profile restart on their next turn.
    pub fn profile_changed(&self, profile_id: &str) {
        let mut chats = self.chats.lock().unwrap();
        let idle: Vec<String> =
            chats.iter().filter(|(_, s)| s.signature.0 == profile_id && s.st.lock().unwrap().active.is_none()).map(|(id, _)| id.clone()).collect();
        for id in idle {
            if let Some(s) = chats.remove(&id) {
                s.close();
            }
        }
    }

    /// The owner disconnected: its chats stop (T07 moves ownership to the host).
    pub fn close_owner(&self, owner: Owner) {
        let gone: Vec<Arc<Session>> = {
            let mut chats = self.chats.lock().unwrap();
            let ids: Vec<String> = chats.iter().filter(|(_, s)| s.owner == owner).map(|(id, _)| id.clone()).collect();
            ids.iter().filter_map(|id| chats.remove(id)).collect()
        };
        for s in gone {
            s.close();
        }
    }

    pub fn close_all(&self) {
        let gone: Vec<Arc<Session>> = self.chats.lock().unwrap().drain().map(|(_, s)| s).collect();
        for s in gone {
            s.close();
        }
    }

    /// Chats with a process (tests and diagnostics).
    pub fn len(&self) -> usize {
        self.chats.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether a chat has a turn running.
    pub fn busy(&self, chat_id: &str) -> bool {
        self.chats.lock().unwrap().get(chat_id).is_some_and(|s| s.st.lock().unwrap().active.is_some())
    }
}

/// Delivers the process's messages in order, then its end.
async fn pump(session: Arc<Session>, server: Arc<AppServer>, incoming: Option<mpsc::UnboundedReceiver<Incoming>>, chats: Weak<Chats>) {
    let Some(mut incoming) = incoming else { return };
    while let Some(item) = incoming.recv().await {
        match item {
            Incoming::Message(msg) => session.handle(&server, msg),
            Incoming::Closed(error) => {
                {
                    let mut st = session.st.lock().unwrap();
                    st.subagents.close();
                    let aborted = st.abort_requested;
                    let message = (!aborted).then(|| st.failure.clone().unwrap_or(error));
                    session.finish(&mut st, message, Some(aborted));
                }
                if let Some(chats) = chats.upgrade() {
                    let mut chats = chats.lock().unwrap();
                    if chats.get(&session.chat_id).is_some_and(|s| Arc::ptr_eq(s, &session)) {
                        chats.remove(&session.chat_id);
                    }
                }
                break;
            }
        }
    }
}

/// The turn after acceptance; any failure closes the process, which ends the turn with it.
async fn run_turn(session: Arc<Session>, server: Arc<AppServer>, payload: CodexSend) {
    if let Err(message) = turn_steps(&session, &server, &payload).await {
        let mut st = session.st.lock().unwrap();
        if st.active.as_ref().is_some_and(|a| a.id == payload.id) {
            st.failure = Some(message);
            drop(st);
            server.close();
        }
    }
}

async fn turn_steps(session: &Session, server: &AppServer, payload: &CodexSend) -> Result<(), String> {
    server.ready().await?;
    let selection = &payload.selection;
    let full = selection.permission_mode == "bypassPermissions";
    let write = selection.permission_mode == "acceptEdits";
    let approval_policy = if full || selection.permission_mode == "plan" { "never" } else { "on-request" };
    let sandbox = if full {
        "danger-full-access"
    } else if write {
        "workspace-write"
    } else {
        "read-only"
    };
    // Fast mode is the model's upgrade service tier; null clears it on resume.
    let service_tier = selection.service_tier.clone().filter(|t| !t.is_empty()).map(Value::String).unwrap_or(Value::Null);
    let model = Some(&selection.model).filter(|m| !m.is_empty());

    let known_thread = session.st.lock().unwrap().thread_id.clone();
    let thread_id = match known_thread {
        Some(thread) => thread,
        None => {
            let resume = payload.resume.as_deref().filter(|r| !r.is_empty());
            let mut params = Map::new();
            if let Some(resume) = resume {
                params.insert("threadId".into(), json!(resume));
            }
            params.insert("cwd".into(), json!(payload.cwd));
            params.insert("approvalPolicy".into(), json!(approval_policy));
            params.insert("sandbox".into(), json!(sandbox));
            if let Some(model) = model {
                params.insert("model".into(), json!(model));
            }
            params.insert("serviceTier".into(), service_tier.clone());
            let response = server.request(if resume.is_some() { "thread/resume" } else { "thread/start" }, Value::Object(params)).await?;
            let thread = response.pointer("/thread/id").and_then(Value::as_str).ok_or("O Codex App Server não informou a conversa.")?.to_string();
            session.st.lock().unwrap().thread_id = Some(thread.clone());
            thread
        }
    };
    {
        let mut st = session.st.lock().unwrap();
        session.emit(&st, EventBody::Session { session_id: thread_id.clone() });
        if st.abort_requested {
            session.finish(&mut st, None, Some(true));
            return Ok(());
        }
    }
    let sandbox_policy = if full {
        json!({ "type": "dangerFullAccess" })
    } else if write {
        json!({ "type": "workspaceWrite", "writableRoots": [payload.cwd], "networkAccess": false, "excludeTmpdirEnvVar": false, "excludeSlashTmp": false })
    } else {
        json!({ "type": "readOnly" })
    };
    // `$skill` tokens also go as structured skill items, as Codex's own
    // composer sends them; the text stays as typed. The listing comes from this
    // process; when it fails or is slow, the turn goes as text only.
    let mut input = vec![json!({ "type": "text", "text": payload.prompt, "text_elements": [] })];
    input.extend(payload.images.iter().map(|image| json!({"type": "image", "url": format!("data:{};base64,{}", image["mime"].as_str().unwrap_or_default(), image["data"].as_str().unwrap_or_default())})));
    if !skill_tokens(&payload.prompt).is_empty() {
        let cwds = if payload.cwd.is_empty() { json!([]) } else { json!([payload.cwd]) };
        if let Ok(listing) = server.request_with_timeout("skills/list", json!({ "cwds": cwds }), SKILLS_TIMEOUT).await {
            input.extend(codex_skill_inputs(&payload.prompt, &codex_skill_refs(&listing)));
        }
    }
    let mut params = Map::new();
    params.insert("threadId".into(), json!(thread_id));
    params.insert("input".into(), Value::Array(input));
    params.insert("cwd".into(), json!(payload.cwd));
    params.insert("approvalPolicy".into(), json!(approval_policy));
    params.insert("sandboxPolicy".into(), sandbox_policy);
    if let Some(model) = model {
        params.insert("model".into(), json!(model));
    }
    if let Some(effort) = &selection.effort {
        params.insert("effort".into(), effort.clone());
    }
    params.insert("serviceTier".into(), service_tier);
    let response = server.request("turn/start", Value::Object(params)).await?;
    let interrupt = {
        let mut st = session.st.lock().unwrap();
        if st.active.as_ref().is_some_and(|a| a.id == payload.id) {
            st.native_turn_id = response.pointer("/turn/id").cloned();
            if let Some(id) = st.native_turn_id.as_ref().and_then(Value::as_str).map(str::to_string)
                && let Some(active) = &st.active {
                let origin = super::subagents::Origin { id: active.id.clone(), sink: Arc::clone(&active.sink) };
                st.subagents.remember_root_turn(&id, origin);
            }
            if st.abort_requested { st.native_turn_id.clone() } else { None }
        } else {
            None
        }
    };
    if let Some(turn_id) = interrupt {
        server.request("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id })).await?;
    }
    Ok(())
}
