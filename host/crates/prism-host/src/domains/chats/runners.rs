//! The engine's providers. Their sessions belong to the engine
//! (`ENGINE_OWNER`), not to a connection, so closing a window ends nothing;
//! what each reports becomes `TurnEvent`s of the turn it runs (events of
//! another turn of the same process are dropped here).

use std::sync::Arc;

use prism_agents::claude::{ClaudeAgents, Emitter, PermissionReply, QuestionReply, SendPayload};
use prism_agents::codex::{CodexEvent, CodexSend, CodexSessions, CodexSink, EventBody};
use serde_json::{json, Map, Value};

use super::port::{claude_metrics, truthy};
use super::{BoxFuture, Runner, TurnEvent, TurnSink, TurnStart};

/// Owner of the engine's sessions: client ids count up from 1, never this far.
pub const ENGINE_OWNER: u64 = u64::MAX;

fn string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

fn session_and_fast(data: &Value, out: &mut Vec<TurnEvent>) {
    if let Some(id) = data.get("sessionId").and_then(Value::as_str).filter(|id| !id.is_empty()) {
        out.push(TurnEvent::Session(id.to_string()));
    }
    if let Some(fast) = data.get("fastMode")
        && let Some(state) = fast.get("state").and_then(Value::as_str)
    {
        out.push(TurnEvent::Fast { state: state.to_string(), reason: string(fast.get("reason")) });
    }
}

/// A failure's reason code (`cli_auth`, `cli_missing`), ahead of its error.
fn push_code(data: &Value, out: &mut Vec<TurnEvent>) {
    if let Some(code) = data.get("code").and_then(Value::as_str).filter(|c| !c.is_empty()) {
        out.push(TurnEvent::ErrorCode(code.to_string()));
    }
}

/// One `agent:*` event → what the renderer did with it in agentChats.ts.
pub fn claude_events(channel: &str, data: &Value) -> Vec<TurnEvent> {
    let mut out = Vec::new();
    match channel {
        "agent:subagent" => if let Some(agent) = data.get("agent") { out.push(TurnEvent::Subagent(agent.clone())); },
        "agent:system" => session_and_fast(data, &mut out),
        "agent:text" => out.push(TurnEvent::Text(string(data.get("text")).unwrap_or_default())),
        "agent:thinking" => out.push(TurnEvent::Thinking(string(data.get("text")).unwrap_or_default())),
        "agent:tool" => out.push(TurnEvent::Tool {
            tool_id: string(data.get("toolId")).unwrap_or_default(),
            name: data.get("name").cloned().unwrap_or(Value::Null),
            input: data.get("input").cloned(),
        }),
        "agent:tool-result" => out.push(TurnEvent::ToolResult {
            tool_id: string(data.get("toolId")).unwrap_or_default(),
            content: data.get("content").cloned(),
            is_error: truthy(data.get("isError")),
        }),
        "agent:permission" => out.push(TurnEvent::Permission(data.clone())),
        "agent:question" => out.push(TurnEvent::Question(data.clone())),
        "agent:result" => {
            out.push(TurnEvent::Metrics(claude_metrics(data)));
            session_and_fast(data, &mut out);
            if truthy(data.get("isError")) {
                let message = data.get("resultText").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_string).unwrap_or_else(|| {
                    format!("Claude encerrou com erro: {}", data.get("subtype").and_then(Value::as_str).unwrap_or("undefined"))
                });
                push_code(data, &mut out);
                out.push(TurnEvent::Error(message));
            }
        }
        "agent:done" => out.push(TurnEvent::Done { aborted: truthy(data.get("aborted")) }),
        "agent:error" => {
            push_code(data, &mut out);
            out.push(TurnEvent::Error(string(data.get("message")).unwrap_or_default()));
        }
        _ => {}
    }
    out
}

/// Claude Code over its native protocol (prism_agents::claude).
pub struct ClaudeRunner {
    agents: ClaudeAgents,
}

impl ClaudeRunner {
    pub fn new(agents: ClaudeAgents) -> Self {
        Self { agents }
    }
}

impl Runner for ClaudeRunner {
    fn configure(&self, chat_id: &str, selection: &Value) {
        let key = format!("unified:{chat_id}");
        if let Some(model) = selection.get("model").and_then(Value::as_str) { self.agents.set_model(&key, model); }
        if let Some(mode) = selection.get("permissionMode").and_then(Value::as_str) { self.agents.set_permission_mode(&key, mode); }
    }

    fn start(&self, turn: TurnStart, sink: TurnSink) -> BoxFuture<Result<(), String>> {
        let own = turn.turn_id.clone();
        let emit: Emitter = Arc::new(move |channel: &str, data: Value| {
            if channel == "agent:subagent" {
                if let (Some(origin), Some(agent)) = (data.get("id").and_then(Value::as_str), data.get("agent")) {
                    sink.send_to_turn(origin, TurnEvent::Subagent(agent.clone()));
                }
                return;
            }
            if data.get("id").and_then(Value::as_str) != Some(own.as_str()) {
                return;
            }
            for event in claude_events(channel, &data) {
                sink.send(event);
            }
        });
        let selection = &turn.selection;
        let payload = SendPayload {
            id: turn.turn_id.clone(),
            chat: Some(json!({ "id": turn.chat_id })),
            profile_id: string(selection.get("profileId")),
            permission_scope: Some(turn.chat_id.clone()),
            prompt: turn.prompt,
            images: turn.images,
            cwd: Some(turn.cwd).filter(|cwd| !cwd.is_empty()),
            resume: turn.resume,
            model: string(selection.get("model")).unwrap_or_default(),
            effort: string(selection.get("effort")),
            permission_mode: string(selection.get("permissionMode")),
            service_tier: turn.service_tier,
            ..SendPayload::default()
        };
        let agents = self.agents.clone();
        // A refusal is reported as `agent:error` before `send` returns.
        Box::pin(async move {
            agents.send(ENGINE_OWNER, emit, payload).await;
            Ok(())
        })
    }

    fn steer(&self, _chat_id: String, turn_id: String, text: String, images: Vec<Value>) -> BoxFuture<Result<(), String>> {
        let agents = self.agents.clone();
        Box::pin(async move { agents.steer(ENGINE_OWNER, &turn_id, &text, &images) })
    }

    fn abort(&self, _chat_id: &str, turn_id: &str) {
        self.agents.abort(ENGINE_OWNER, turn_id);
    }

    fn permission(&self, _chat_id: &str, turn_id: &str, perm_id: &str, decision: &str, updated_input: Option<Value>) {
        self.agents.respond_permission(
            ENGINE_OWNER,
            PermissionReply { id: turn_id.to_string(), perm_id: perm_id.to_string(), decision: decision.to_string(), updated_input },
        );
    }

    fn question(&self, _chat_id: &str, turn_id: &str, dialog_id: &str, answers: Option<Map<String, Value>>, _response: Option<String>) {
        self.agents.respond_question(
            ENGINE_OWNER,
            QuestionReply { id: turn_id.to_string(), dialog_id: dialog_id.to_string(), cancelled: Some(answers.is_none()), answers: answers.map(Value::Object) },
        );
    }
}

/// Codex through `codex app-server` (prism_agents::codex).
pub struct CodexRunner {
    sessions: Arc<CodexSessions>,
}

impl CodexRunner {
    pub fn new(sessions: Arc<CodexSessions>) -> Self {
        Self { sessions }
    }
}

struct EngineSink(TurnSink);

impl EngineSink {
    fn own(&self, payload: &Value) -> bool {
        payload.get("id").and_then(Value::as_str) == Some(self.0.turn_id.as_str())
    }
}

impl CodexSink for EngineSink {
    fn event(&self, event: &CodexEvent) {
        if let EventBody::Subagent { agent } = &event.body {
            self.0.send_to_turn(&event.id, TurnEvent::Subagent(agent.clone()));
            return;
        }
        if event.id != self.0.turn_id {
            return;
        }
        self.0.send(match &event.body {
            EventBody::Subagent { .. } => unreachable!("child events use their originating turn"),
            EventBody::Session { session_id } => TurnEvent::Session(session_id.clone()),
            EventBody::Metrics { metrics } => TurnEvent::Metrics(metrics.clone()),
            EventBody::Segment { segment } => TurnEvent::Segment(serde_json::to_value(segment).unwrap_or(Value::Null)),
            EventBody::Done { aborted } => TurnEvent::Done { aborted: aborted.unwrap_or(false) },
            EventBody::Error { message } => TurnEvent::Error(message.clone()),
        });
    }

    fn permission(&self, payload: Value) {
        if self.own(&payload) {
            self.0.send(TurnEvent::Permission(payload));
        }
    }

    fn question(&self, payload: Value) {
        if self.own(&payload) {
            self.0.send(TurnEvent::Question(payload));
        }
    }
}

impl Runner for CodexRunner {
    fn start(&self, turn: TurnStart, sink: TurnSink) -> BoxFuture<Result<(), String>> {
        // `{ ...chat.selection, serviceTier: serviceTier || '' }`, without nulls.
        let mut selection = turn.selection.as_object().cloned().unwrap_or_default();
        selection.retain(|_, value| !value.is_null());
        selection.insert("serviceTier".into(), Value::String(turn.service_tier.clone().unwrap_or_default()));
        let payload = json!({
            "id": turn.turn_id,
            "chatId": turn.chat_id,
            "prompt": turn.prompt,
            "images": turn.images,
            "cwd": turn.cwd,
            "resume": turn.resume,
            "selection": selection,
        });
        let payload: CodexSend = match serde_json::from_value(payload) {
            Ok(payload) => payload,
            Err(_) => return Box::pin(async { Err("Mensagem Codex inválida.".to_string()) }),
        };
        let accepted = self.sessions.send(ENGINE_OWNER, Arc::new(EngineSink(sink)), payload, None);
        Box::pin(async move { accepted.await.map_err(|err| err.message) })
    }

    fn steer(&self, chat_id: String, turn_id: String, text: String, images: Vec<Value>) -> BoxFuture<Result<(), String>> {
        let sessions = Arc::clone(&self.sessions);
        Box::pin(async move { sessions.steer(ENGINE_OWNER, &chat_id, &turn_id, text, images).await })
    }

    fn abort(&self, chat_id: &str, turn_id: &str) {
        self.sessions.abort_turn(ENGINE_OWNER, chat_id, turn_id);
    }

    fn permission(&self, chat_id: &str, _turn_id: &str, perm_id: &str, decision: &str, _updated_input: Option<Value>) {
        self.sessions.permission(ENGINE_OWNER, chat_id, perm_id, decision);
    }

    fn question(&self, chat_id: &str, _turn_id: &str, dialog_id: &str, answers: Option<Map<String, Value>>, _response: Option<String>) {
        self.sessions.question(ENGINE_OWNER, chat_id, dialog_id, answers.as_ref());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::Msg;

    #[test]
    fn child_events_keep_their_origin_through_runner_adapters_but_foreign_terminal_events_are_ignored() {
        let (tx,rx)=std::sync::mpsc::channel();
        let sink=EngineSink(TurnSink {tx,chat_id:"root-chat".into(),turn_id:"new-root-turn".into()});
        sink.event(&CodexEvent {id:"old-root-turn".into(),body:EventBody::Subagent {agent:json!({"id":"child","status":"completed"})}});
        match rx.try_recv().unwrap() {
            Msg::Turn {chat_id,turn_id,event:TurnEvent::Subagent(agent)} => {
                assert_eq!(chat_id,"root-chat");assert_eq!(turn_id,"old-root-turn");assert_eq!(agent["id"],"child");
            }
            other=>panic!("unexpected adapter event: {}",matches!(other,Msg::Turn {..})),
        }
        sink.event(&CodexEvent {id:"old-root-turn".into(),body:EventBody::Done {aborted:Some(false)}});
        assert!(rx.try_recv().is_err(),"a foreign terminal event cannot finish the active root turn");
        sink.event(&CodexEvent {id:"new-root-turn".into(),body:EventBody::Done {aborted:Some(false)}});
        assert!(matches!(rx.try_recv().unwrap(),Msg::Turn{turn_id,event:TurnEvent::Done{aborted:false},..} if turn_id=="new-root-turn"));
        assert_eq!(claude_events("agent:subagent",&json!({"id":"old-root-turn","agent":{"id":"child","status":"running"}})),vec![TurnEvent::Subagent(json!({"id":"child","status":"running"}))]);
    }
}
