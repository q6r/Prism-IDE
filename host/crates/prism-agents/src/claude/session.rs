//! One live chat session: a Claude Code process with streaming input. Its
//! stdout becomes the `agent:*` events the renderer has always consumed
//! (port of `consumeStream` and `canUseTool` in src/main/ipc/claudeAgent.ts).
//! `system/init` marks each turn's start and `result` its end.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot, watch};

use super::json::{stringify, text, truthy};
use super::transport::{Exit, Input};
use super::usage::{ClaudeTotals, claude_turn_usage};
use super::wire;

/// Delivers one `agent:*` event (channel, payload) to the session's owner.
pub type Emitter = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// The client (socket) that owns a session; only it can answer or stop it.
pub type ClientKey = u64;

/// After stdin closes the CLI gets this long to exit on its own (the SDK's grace).
pub(super) const EXIT_GRACE: Duration = Duration::from_secs(2);

/// Assistant errors that mean the account must sign in again.
const AUTH_ERRORS: [&str; 2] = ["authentication_failed", "oauth_org_not_allowed"];

pub(crate) struct PendingPermission {
    request_id: Value,
    tool_name: String,
    input: Option<Value>,
    suggestions: Option<Value>,
    tool_use_id: Option<Value>,
}

pub(crate) struct PendingDialog {
    request_id: Value,
    input: Option<Value>,
    tool_use_id: Option<Value>,
}

pub(crate) struct State {
    pub owner: ClientKey,
    /// The route the process was started for; a different one restarts it.
    pub signature: String,
    pub profile_id: Option<String>,
    /// "Always allow" scope: `<chat>:<profile>`, or "" for the app-wide set.
    pub permissions_key: String,
    pub session_id: Option<String>,
    pub active_turn: Option<String>,
    pub model: String,
    pub emit: Emitter,
    subagents: super::subagents::Subagents,
    perms: HashMap<String, PendingPermission>,
    dialogs: HashMap<String, PendingDialog>,
    /// The model `system/init` reported (an alias such as "haiku" resolved).
    resolved_model: Option<String>,
    context_usage: Option<Value>,
    /// This process's usage totals before its next result; None when unknown.
    usage_base: Option<ClaudeTotals>,
    auth_failed: bool,
    /// The last error result's text, for a process that then exits with an error.
    last_error: Option<String>,
    pub(super) aborted: bool,
    pub(super) closed: bool,
    pub(super) closing: bool,
}

pub(crate) struct NewState {
    pub owner: ClientKey,
    pub signature: String,
    pub profile_id: Option<String>,
    pub permissions_key: String,
    pub active_turn: Option<String>,
    pub model: String,
    pub emit: Emitter,
    pub usage_base: Option<ClaudeTotals>,
}

/// What every session shares with the manager.
#[derive(Default)]
pub(crate) struct Shared {
    pub sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Tools the user chose to always allow, per permissions key.
    pub allowed: Mutex<HashMap<String, HashSet<String>>>,
    /// Last usage totals seen per CLI session id: a resumed process continues
    /// from them. Nothing is known after a host restart.
    pub totals: Mutex<HashMap<String, ClaudeTotals>>,
    pub perm_seq: AtomicU64,
    pub dialog_seq: AtomicU64,
}

pub(crate) struct Session {
    pub key: String,
    input: mpsc::UnboundedSender<Input>,
    kill: Box<dyn Fn() + Send + Sync>,
    pub state: Mutex<State>,
    closed: watch::Sender<bool>,
    next_request: AtomicU64,
}

type Events = Vec<(&'static str, Value)>;

/// A JSON object from optional fields (absent ones are left out, like
/// `undefined` in the TS payloads).
fn object(fields: Vec<(&str, Option<Value>)>) -> Value {
    let mut out = Map::new();
    for (key, value) in fields {
        if let Some(value) = value {
            out.insert(key.to_string(), value);
        }
    }
    Value::Object(out)
}

/// A pass-through field: absent stays absent, `null` stays `null` (as in the TS payloads).
fn field(msg: &Value, key: &str) -> Option<Value> {
    msg.get(key).cloned()
}

/// `fastModeOf`: whether Fast actually serves the session, and why not.
fn fast_mode(msg: &Value) -> Option<Value> {
    let state = msg.get("fast_mode_state")?.as_str()?;
    Some(object(vec![("state", Some(state.into())), ("reason", msg.get("fast_mode_disabled_reason").and_then(Value::as_str).map(Value::from))]))
}

/// A tool result's content as the renderer shows it.
fn tool_result_text(content: Option<&Value>) -> Option<Value> {
    match content {
        None => None,
        Some(Value::String(s)) => Some(Value::String(s.clone())),
        Some(Value::Array(parts)) => Some(Value::String(
            parts
                .iter()
                .map(|x| match x.get("type").and_then(Value::as_str) {
                    Some("text") => x.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                    other => format!("[{}]", other.unwrap_or("undefined")),
                })
                .collect(),
        )),
        Some(other) => Some(Value::String(stringify(other))),
    }
}

impl Session {
    pub fn new(key: String, input: mpsc::UnboundedSender<Input>, kill: Box<dyn Fn() + Send + Sync>, s: NewState) -> Arc<Self> {
        let state = State {
            owner: s.owner,
            signature: s.signature,
            profile_id: s.profile_id,
            permissions_key: s.permissions_key,
            session_id: None,
            active_turn: s.active_turn,
            model: s.model,
            emit: s.emit,
            subagents: super::subagents::Subagents::default(),
            perms: HashMap::new(),
            dialogs: HashMap::new(),
            resolved_model: None,
            context_usage: None,
            usage_base: s.usage_base,
            auth_failed: false,
            last_error: None,
            aborted: false,
            closed: false,
            closing: false,
        };
        Arc::new(Self { key, input, kill, state: Mutex::new(state), closed: watch::channel(false).0, next_request: AtomicU64::new(1) })
    }

    pub fn input_closed(&self) -> bool {
        self.input.is_closed()
    }

    pub fn write(&self, line: String) {
        let _ = self.input.send(Input::Line(line));
    }

    pub fn push(&self, text: &str, images: &[Value]) {
        self.write(wire::user_message(text, images));
    }

    pub fn push_now(&self, text: &str, images: &[Value]) {
        let mut message: Value = serde_json::from_str(&wire::user_message(text, images)).expect("user_message is JSON");
        message["priority"] = json!("now");
        self.write(message.to_string());
    }

    /// A host → CLI control request; its answer is not awaited.
    pub fn request(&self, request: Value) {
        let id = format!("prism-{}", self.next_request.fetch_add(1, Ordering::Relaxed));
        self.write(wire::control_request(&id, request));
    }

    /// Interrupts only this turn, then closes its process if it never settles.
    pub fn interrupt(self: &Arc<Self>) {
        let turn = {
            let mut st = self.state.lock().unwrap();
            let Some(turn) = st.active_turn.clone() else { return };
            st.aborted = true;
            turn
        };
        self.request(wire::interrupt());
        let me = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(EXIT_GRACE).await;
            let still_running = me.state.lock().unwrap().active_turn.as_deref() == Some(turn.as_str());
            if still_running { me.kill(); }
        });
    }

    /// Stops the session: stdin closes, and the tree is killed if the CLI has
    /// not exited after the grace period. A turn in progress ends aborted.
    pub fn end(self: &Arc<Self>) {
        {
            let mut st = self.state.lock().unwrap();
            if st.closed {
                return;
            }
            st.aborted = true;
            st.closing = true;
        }
        let _ = self.input.send(Input::Close);
        let me = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(EXIT_GRACE).await;
            if !*me.closed.borrow() {
                (me.kill)();
            }
        });
    }

    pub fn kill(&self) {
        {
            let mut st = self.state.lock().unwrap();
            st.aborted = true;
            st.closing = true;
        }
        (self.kill)();
    }

    pub async fn closed(&self) {
        let mut rx = self.closed.subscribe();
        let _ = rx.wait_for(|closed| *closed).await;
    }

    fn emit(&self, emit: &Emitter, events: Events) {
        for (channel, payload) in events {
            emit(channel, payload);
        }
    }

    /// Answers a permission the user decided. False when `perm_id` is not
    /// pending for this owner and turn.
    pub fn answer_permission(&self, shared: &Shared, client: ClientKey, turn: &str, perm_id: &str, decision: &str, updated_input: Option<Value>) -> bool {
        let (pending, key) = {
            let mut st = self.state.lock().unwrap();
            if st.owner != client || st.active_turn.as_deref() != Some(turn) {
                return false;
            }
            match st.perms.remove(perm_id) {
                Some(p) => (p, st.permissions_key.clone()),
                None => return false,
            }
        };
        let updated = updated_input.filter(|v| !v.is_null()).or_else(|| pending.input.clone());
        let response = match decision {
            "deny" => wire::deny("Negado pelo usuário.", pending.tool_use_id.as_ref()),
            "allow_always" => {
                shared.allowed.lock().unwrap().entry(key).or_default().insert(pending.tool_name.clone());
                wire::allow(updated.as_ref(), pending.suggestions.as_ref(), pending.tool_use_id.as_ref())
            }
            _ => wire::allow(updated.as_ref(), None, pending.tool_use_id.as_ref()),
        };
        self.write(wire::control_success(&pending.request_id, response));
        true
    }

    /// Answers an AskUserQuestion. Cancelled or empty answers let the tool run
    /// with its own input (the model sees no choice).
    pub fn answer_question(&self, client: ClientKey, turn: &str, dialog_id: &str, cancelled: bool, answers: Option<Value>) -> bool {
        let pending = {
            let mut st = self.state.lock().unwrap();
            if st.owner != client || st.active_turn.as_deref() != Some(turn) {
                return false;
            }
            match st.dialogs.remove(dialog_id) {
                Some(p) => p,
                None => return false,
            }
        };
        let answers = answers.filter(|a| a.as_object().is_some_and(|m| !m.is_empty()));
        let input = match (cancelled, answers) {
            (false, Some(answers)) => {
                let mut input = pending.input.clone().and_then(|v| v.as_object().cloned()).unwrap_or_default();
                input.insert("answers".into(), answers);
                Some(Value::Object(input))
            }
            _ => pending.input.clone(),
        };
        self.write(wire::control_success(&pending.request_id, wire::allow(input.as_ref(), None, pending.tool_use_id.as_ref())));
        true
    }
}

/// Reads the process until it exits, then finalizes the session.
pub(crate) async fn run(session: Arc<Session>, shared: Arc<Shared>, mut output: mpsc::UnboundedReceiver<String>, exit: oneshot::Receiver<Exit>) {
    tokio::pin!(exit);
    let exit = loop {
        tokio::select! {
            status = &mut exit => {
                session.state.lock().unwrap().closing = true;
                // A descendant may inherit stdout beyond the CLI's exit. Drain
                // final messages, but never keep the session alive on that pipe.
                let _ = tokio::time::timeout(EXIT_GRACE, async {
                    while let Some(line) = output.recv().await {
                        handle_line(&session, &shared, &line);
                    }
                }).await;
                break status.unwrap_or(Exit { code: None });
            }
            line = output.recv() => match line {
                Some(line) => handle_line(&session, &shared, &line),
                None => {
                    // A process can keep running after its protocol pipe closes.
                    // It can no longer deliver a result, so invalidate it before
                    // another turn reuses the otherwise live stdin channel.
                    let unfinished = {
                        let mut st = session.state.lock().unwrap();
                        st.closing = true;
                        let unfinished = st.active_turn.is_some() && !st.aborted;
                        if unfinished && st.last_error.is_none() {
                            st.last_error = Some("O canal de respostas do Claude Code foi fechado antes de concluir a mensagem.".into());
                        }
                        unfinished
                    };
                    if unfinished {
                        tracing::warn!(chat = %session.key, "claude: stdout fechado antes do resultado");
                    }
                    (session.kill)();
                    let status = tokio::time::timeout(EXIT_GRACE, &mut exit).await.ok().and_then(Result::ok).unwrap_or(Exit { code: None });
                    // A clean OS exit still failed this accepted prompt if no
                    // result arrived; it must not look like a user's cancellation.
                    break if unfinished { Exit { code: None } } else { status };
                }
            }
        }
    };
    finish(&session, &shared, exit);
}

pub(crate) fn handle_line(session: &Session, shared: &Shared, line: &str) {
    let Ok(msg) = serde_json::from_str::<Value>(line) else {
        tracing::debug!(chat = %session.key, "claude: linha fora do protocolo ignorada");
        return;
    };
    match msg.get("type").and_then(Value::as_str).unwrap_or("") {
        "control_request" => control_request(session, shared, &msg),
        "control_cancel_request" => cancel(session, &msg),
        "control_response" | "keep_alive" | "transcript_mirror" => {}
        _ => {
            let (emit, events) = {
                let mut st = session.state.lock().unwrap();
                let events = translate(&mut st, &session.key, &msg, shared);
                (st.emit.clone(), events)
            };
            session.emit(&emit, events);
        }
    }
}

/// One CLI message → the events the TS backend emitted for it.
fn translate(st: &mut State, key: &str, msg: &Value, shared: &Shared) -> Events {
    let kind = msg.get("type").and_then(Value::as_str).unwrap_or("");
    let subtype = msg.get("subtype").and_then(Value::as_str).unwrap_or("");
    // The SDK keeps the last error result's text until any other message (but a state change) arrives.
    if kind != "result" && !(kind == "system" && subtype == "session_state_changed") {
        st.last_error = None;
    }
    let mut out: Events = Vec::new();
    let (child_frame, children) = st.subagents.route(msg, st.active_turn.as_deref());
    out.extend(children.into_iter().map(|payload| ("agent:subagent", payload)));
    if child_frame { return out; }
    let id = || st.active_turn.clone().map(Value::String);
    match kind {
        "system" if subtype == "init" => {
            st.session_id = msg.get("session_id").and_then(Value::as_str).map(str::to_string);
            if let Some(model) = text(msg.get("model")) {
                st.resolved_model = Some(model.to_string());
            }
            out.push((
                "agent:system",
                object(vec![
                    ("id", Some(id().unwrap_or(Value::Null))),
                    ("sessionId", field(msg, "session_id")),
                    ("model", field(msg, "model")),
                    ("tools", field(msg, "tools")),
                    ("fastMode", fast_mode(msg)),
                ]),
            ));
        }
        "system" if subtype == "api_retry" => {
            // Protocol metadata only: no prompts, headers, credentials or API
            // response bodies enter the host log.
            tracing::warn!(chat = %key, turn = st.active_turn.as_deref().unwrap_or(""),
                attempt = msg.get("attempt").and_then(|value| value.as_u64()),
                max_retries = msg.get("max_retries").and_then(|value| value.as_u64()),
                retry_delay_ms = msg.get("retry_delay_ms").and_then(|value| value.as_u64()),
                error_status = msg.get("error_status").and_then(|value| value.as_u64()),
                waited_ms = msg.pointer("/no_response/waited_ms").and_then(|value| value.as_u64()),
                retry_wait_ms = msg.pointer("/no_response/retry_wait_ms").and_then(|value| value.as_u64()),
                "claude: nova tentativa de chamada à API programada");
        }
        "stream_event" => {
            let Some(id) = id() else { return out };
            let ev = msg.get("event");
            match ev.and_then(|e| e.get("type")).and_then(Value::as_str) {
                Some("content_block_delta") => {
                    let delta = ev.and_then(|e| e.get("delta"));
                    match delta.and_then(|d| d.get("type")).and_then(Value::as_str) {
                        Some("text_delta") => out.push(("agent:text", object(vec![("id", Some(id)), ("text", delta.and_then(|d| field(d, "text")))]))),
                        Some("thinking_delta") => out.push(("agent:thinking", object(vec![("id", Some(id)), ("text", delta.and_then(|d| field(d, "thinking")))]))),
                        _ => {}
                    }
                }
                Some("message_start") => {
                    if let Some(usage) = ev.and_then(|e| e.pointer("/message/usage")).filter(|u| truthy(Some(u))) {
                        st.context_usage = Some(usage.clone());
                        out.push(("agent:context", json!({"id": id, "usage": usage})));
                    }
                }
                _ => {}
            }
        }
        "assistant" => {
            if let Some(usage) = msg.pointer("/message/usage") {
                st.context_usage = Some(usage.clone());
            }
            if msg.get("error").and_then(Value::as_str).is_some_and(|e| AUTH_ERRORS.contains(&e)) {
                st.auth_failed = true;
            }
            let Some(id) = id() else { return out };
            for b in msg.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                if b.get("type").and_then(Value::as_str) == Some("tool_use") {
                    out.push(("agent:tool", object(vec![("id", Some(id.clone())), ("toolId", field(b, "id")), ("name", field(b, "name")), ("input", field(b, "input"))])));
                }
            }
        }
        "user" => {
            let Some(id) = id() else { return out };
            for b in msg.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                if b.get("type").and_then(Value::as_str) == Some("tool_result") {
                    out.push((
                        "agent:tool-result",
                        object(vec![
                            ("id", Some(id.clone())),
                            ("toolId", field(b, "tool_use_id")),
                            ("content", tool_result_text(b.get("content"))),
                            ("isError", Some(truthy(b.get("is_error")).into())),
                        ]),
                    ));
                }
            }
        }
        "result" => {
            let is_error = truthy(msg.get("is_error"));
            st.last_error = is_error.then(|| {
                if subtype == "success" {
                    msg.get("result").and_then(Value::as_str).unwrap_or("").to_string()
                } else {
                    msg.get("errors").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("; ")
                }
            });
            // Measured even without an open turn, so the base stays in step.
            let (turn, next) = claude_turn_usage(msg, st.usage_base);
            if let (Some(next), Some(sid)) = (next, text(msg.get("session_id"))) {
                shared.totals.lock().unwrap().insert(sid.to_string(), next);
            }
            st.usage_base = next;
            let auth = std::mem::take(&mut st.auth_failed);
            if let Some(id) = st.active_turn.take() {
                out.push((
                    "agent:result",
                    object(vec![
                        ("id", Some(id.clone().into())),
                        ("chatId", Some(key.into())),
                        ("sessionId", field(msg, "session_id")),
                        ("isError", Some(is_error.into())),
                        ("subtype", field(msg, "subtype")),
                        ("costUsd", field(msg, "total_cost_usd")),
                        ("durationMs", field(msg, "duration_ms")),
                        ("numTurns", field(msg, "num_turns")),
                        ("resultText", field(msg, "result")),
                        ("usage", field(msg, "usage")),
                        ("contextTokens", st.context_usage.as_ref().map(|usage| json!(["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"].iter().filter_map(|key| usage.get(key).and_then(Value::as_u64)).sum::<u64>()))),
                        ("contextWindow", msg.get("modelUsage").and_then(|models| models.get(st.resolved_model.as_deref().unwrap_or(&st.model))).and_then(|model| model.get("contextWindow")).cloned()),
                        ("turn", turn),
                        ("model", st.resolved_model.clone().map(Value::String)),
                        ("fastMode", fast_mode(msg)),
                        // The login is gone: the UI offers to sign in again.
                        ("code", (is_error && auth).then(|| "cli_auth".into())),
                    ]),
                ));
                // A subtype other than success means the turn was interrupted, not failed.
                let aborted = std::mem::take(&mut st.aborted) || (truthy(msg.get("subtype")) && msg.get("subtype").and_then(Value::as_str) != Some("success"));
                out.push(("agent:done", json!({"id": id, "aborted": aborted})));
            }
        }
        _ => {
            if !matches!(kind, "system" | "rate_limit_event" | "stream_event" | "tool_progress" | "auth_status" | "active_goal" | "autocompact_state") {
                tracing::debug!(chat = %key, kind, "claude: mensagem desconhecida ignorada");
            }
        }
    }
    out
}

fn control_request(session: &Session, shared: &Shared, msg: &Value) {
    let request_id = msg.get("request_id").cloned().unwrap_or(Value::Null);
    let req = msg.get("request").cloned().unwrap_or(Value::Null);
    let subtype = req.get("subtype").and_then(Value::as_str).unwrap_or("");
    match subtype {
        "can_use_tool" => can_use_tool(session, shared, request_id, &req),
        "elicitation" => session.write(wire::control_success(&request_id, json!({"action": "decline"}))),
        // No renderer is declared for these dialog kinds. The protocol requires
        // cancellation so the CLI applies its default instead of parking the turn.
        "request_user_dialog" => session.write(wire::control_success(&request_id, json!({"behavior": "cancelled"}))),
        "hook_callback" => {
            let id = req.get("callback_id").and_then(Value::as_str).unwrap_or("");
            session.write(wire::control_error(&request_id, &format!("No hook callback found for ID: {id}")));
        }
        "mcp_message" => {
            let name = req.get("server_name").and_then(Value::as_str).unwrap_or("");
            session.write(wire::control_error(&request_id, &format!("SDK MCP server not found: {name}")));
        }
        other => {
            tracing::debug!(chat = %session.key, subtype = other, "claude: control_request não suportado");
            session.write(wire::control_error(&request_id, &format!("Unsupported control request subtype: {other}")));
        }
    }
}

/// `canUseTool`: questions go to the question UI, always-allowed tools pass,
/// everything else waits for the user.
fn can_use_tool(session: &Session, shared: &Shared, request_id: Value, req: &Value) {
    let tool_name = req.get("tool_name").and_then(Value::as_str).unwrap_or("").to_string();
    let input = field(req, "input");
    let tool_use_id = field(req, "tool_use_id");
    let mut answer = None;
    let (emit, events) = {
        let mut st = session.state.lock().unwrap();
        let id = Value::String(st.active_turn.clone().unwrap_or_default());
        let mut events: Events = Vec::new();
        if tool_name == "AskUserQuestion" {
            let dialog_id = format!("dlg{}", shared.dialog_seq.fetch_add(1, Ordering::Relaxed));
            let questions = input.as_ref().and_then(|i| i.get("questions")).filter(|q| !q.is_null()).cloned().unwrap_or_else(|| json!([]));
            events.push(("agent:question", object(vec![("id", Some(id)), ("dialogId", Some(dialog_id.clone().into())), ("toolUseId", tool_use_id.clone()), ("questions", Some(questions))])));
            st.dialogs.insert(dialog_id, PendingDialog { request_id, input, tool_use_id });
        } else if shared.allowed.lock().unwrap().get(&st.permissions_key).is_some_and(|set| set.contains(&tool_name)) {
            answer = Some(wire::control_success(&request_id, wire::allow(input.as_ref(), None, tool_use_id.as_ref())));
        } else {
            let perm_id = format!("perm{}", shared.perm_seq.fetch_add(1, Ordering::Relaxed));
            events.push((
                "agent:permission",
                object(vec![
                    ("id", Some(id)),
                    ("permId", Some(perm_id.clone().into())),
                    ("toolName", Some(tool_name.clone().into())),
                    ("toolUseId", tool_use_id.clone()),
                    ("input", input.clone()),
                    ("title", field(req, "title")),
                    ("displayName", field(req, "display_name")),
                    ("description", field(req, "description")),
                    ("blockedPath", field(req, "blocked_path")),
                ]),
            ));
            st.perms.insert(perm_id, PendingPermission { request_id, tool_name, input, suggestions: field(req, "permission_suggestions"), tool_use_id });
        }
        (st.emit.clone(), events)
    };
    if let Some(line) = answer {
        session.write(line);
    }
    session.emit(&emit, events);
}

/// The CLI withdrew a prompt (the turn was interrupted): answer it as the SDK
/// does when its signal aborts.
fn cancel(session: &Session, msg: &Value) {
    let Some(request_id) = msg.get("request_id") else { return };
    let line = {
        let mut st = session.state.lock().unwrap();
        if let Some(key) = st.perms.iter().find(|(_, p)| &p.request_id == request_id).map(|(k, _)| k.clone()) {
            let p = st.perms.remove(&key).unwrap();
            Some(wire::control_success(&p.request_id, wire::deny("Cancelado.", p.tool_use_id.as_ref())))
        } else if let Some(key) = st.dialogs.iter().find(|(_, d)| &d.request_id == request_id).map(|(k, _)| k.clone()) {
            let d = st.dialogs.remove(&key).unwrap();
            Some(wire::control_success(&d.request_id, wire::allow(d.input.as_ref(), None, d.tool_use_id.as_ref())))
        } else {
            None
        }
    };
    if let Some(line) = line {
        session.write(line);
    }
}

/// The process is gone: close the open turn and forget the session.
pub(crate) fn finish(session: &Arc<Session>, shared: &Shared, exit: Exit) {
    let (emit, events) = {
        let mut st = session.state.lock().unwrap();
        st.closed = true;
        st.perms.clear();
        st.dialogs.clear();
        let id = st.active_turn.take();
        let mut events: Events = Vec::new();
        events.extend(st.subagents.close().into_iter().map(|payload| ("agent:subagent", payload)));
        if st.aborted {
            if let Some(id) = id {
                events.push(("agent:done", json!({"id": id, "aborted": true})));
            }
        } else if let Some(id) = id {
            // The CLI's stderr stays in the host log; the transcript gets a plain reason.
            let message = match (&st.last_error, exit.code) {
                (Some(text), _) => format!("O Claude Code retornou um erro: {text}"),
                (None, Some(code)) => format!("O Claude Code encerrou inesperadamente (código {code})."),
                (None, None) => "O Claude Code foi encerrado inesperadamente.".to_string(),
            };
            events.push(("agent:error", json!({"id": id, "message": message})));
        }
        (st.emit.clone(), events)
    };
    {
        let mut sessions = shared.sessions.lock().unwrap();
        if sessions.get(&session.key).is_some_and(|s| Arc::ptr_eq(s, session)) {
            sessions.remove(&session.key);
        }
    }
    session.emit(&emit, events);
    // Retain the exit even when no replacement is listening yet.
    session.closed.send_replace(true);
}


#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[tokio::test]
    async fn closed_notification_survives_until_a_late_waiter_subscribes() {
        let (input, _receiver) = mpsc::unbounded_channel();
        let session = Session::new("chat".into(), input, Box::new(|| {}), NewState {
            owner: 1, signature: String::new(), profile_id: None, permissions_key: String::new(),
            active_turn: None, model: String::new(), emit: Arc::new(|_, _| {}), usage_base: None,
        });
        finish(&session, &Shared::default(), Exit { code: Some(0) });
        tokio::time::timeout(Duration::from_millis(100), session.closed()).await
            .expect("a session that already exited must never wait for another exit");
    }
}
