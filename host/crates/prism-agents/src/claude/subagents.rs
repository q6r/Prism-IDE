//! Separate the native Agent/Task transcript from its parent turn. The map lives
//! as long as the CLI, since background tasks can finish between parent turns.
use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

#[derive(Default)]
pub(super) struct Subagents {
    aliases: HashMap<String, String>,
    children: HashMap<String, Child>,
    messages: HashMap<String, String>,
    streams: HashMap<String, HashMap<usize, Block>>,
    tools: HashMap<String, Value>,
    runs: HashMap<String, String>,
    peer_messages: HashSet<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(router: &mut Subagents, msg: Value) -> Vec<Value> { router.route(&msg, Some("root-turn")).1 }
    fn spawn(id: &str) -> Value { json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": id, "name": "Agent", "input": {"description": "Revisar arquivos", "subagent_type": "Explore"}}]}}) }

    #[test]
    fn child_stream_tools_and_terminal_are_isolated_and_aliases_keep_the_origin_turn() {
        let mut router = Subagents::default();
        assert!(!router.route(&spawn("spawn"), Some("root-turn")).0);
        feed(&mut router, json!({"type": "system", "subtype": "task_started", "task_id": "native-child", "tool_use_id": "spawn", "task_type": "local_agent"}));
        let mut events = Vec::new();
        events.extend(feed(&mut router, json!({"type": "stream_event", "parent_tool_use_id": "spawn", "event": {"type": "message_start", "message": {"id": "m", "usage": {"input_tokens": 900}}}})));
        events.extend(feed(&mut router, json!({"type": "stream_event", "parent_tool_use_id": "spawn", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Resposta do filho"}}})));
        events.extend(feed(&mut router, json!({"type": "assistant", "parent_tool_use_id": "spawn", "message": {"id": "m", "content": [{"type": "text", "text": "Resposta do filho"}, {"type": "tool_use", "id": "read", "name": "Read", "input": {"file_path": "test.ts"}}]}})));
        events.extend(feed(&mut router, json!({"type": "user", "parent_tool_use_id": "spawn", "message": {"content": [{"type": "tool_result", "tool_use_id": "read", "content": "arquivo completo"}]}})));
        let terminal = router.route(&json!({"type": "system", "subtype": "task_notification", "task_id": "native-child", "status": "completed", "summary": "Pronto"}), Some("second-root-turn"));
        events.extend(terminal.1);
        assert!(events.iter().all(|event| event["id"] == "root-turn" && event["agent"]["id"] == "spawn"));
        assert_eq!(events.iter().filter_map(|event| event["agent"]["text"].as_str()).collect::<String>(), "Resposta do filho");
        assert!(events.iter().any(|event| event["agent"]["segment"]["name"] == "Read" && event["agent"]["segment"]["result"] == "arquivo completo"));
        assert_eq!(events.last().unwrap()["agent"]["status"], "completed");
        let late_placeholder = feed(&mut router, json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "spawn", "content": "running in the background"}]}, "tool_use_result": {"status": "async_launched", "agentId": "native-child"}}));
        assert_eq!(late_placeholder.last().unwrap()["agent"]["status"], "completed", "a late async placeholder must not resurrect the task");
        assert!(router.close().is_empty());
    }

    #[test]
    fn nested_background_agents_and_resumes_keep_ancestry_and_reject_late_runs() {
        let mut router = Subagents::default();
        feed(&mut router, spawn("spawn"));
        feed(&mut router, json!({"type": "system", "subtype": "task_started", "task_id": "parent", "tool_use_id": "spawn", "task_type": "local_agent", "run_id": "001"}));
        let mut nested = spawn("nested"); nested["parent_tool_use_id"] = "spawn".into();
        let events = feed(&mut router, nested);
        assert!(events.iter().any(|event| event["agent"]["id"] == "nested" && event["agent"]["parentId"] == "spawn"));
        feed(&mut router, json!({"type": "system", "subtype": "task_notification", "task_id": "parent", "status": "completed", "run_id": "001"}));
        let events = feed(&mut router, json!({"type": "system", "subtype": "task_started", "task_id": "parent", "run_id": "002"}));
        assert_eq!(events.last().unwrap()["agent"]["status"], "running");
        assert!(feed(&mut router, json!({"type": "system", "subtype": "task_notification", "task_id": "parent", "status": "completed", "run_id": "001"})).is_empty());
        let stopped = router.close();
        assert_eq!(stopped.len(), 2);
        assert!(stopped.iter().all(|event| event["agent"]["status"] == "stopped"));
    }

    #[test]
    fn a_later_tool_alias_keeps_the_first_native_child_instead_of_duplicating_it() {
        let mut router = Subagents::default();
        feed(&mut router, json!({"type": "system", "subtype": "task_started", "task_id": "native-child", "task_type": "local_agent"}));
        let events = feed(&mut router, json!({"type": "assistant", "parent_tool_use_id": "later-tool", "agent_id": "native-child", "message": {"content": [{"type": "text", "text": "Progresso"}]}}));
        assert!(events.iter().all(|event| event["agent"]["id"] == "native-child"));
        assert_eq!(router.children.len(), 1);
        assert_eq!(router.canonical("later-tool"), "native-child");
    }

    #[test]
    fn native_message_target_and_resumed_tool_alias_keep_the_original_parent() {
        let mut router = Subagents::default();
        feed(&mut router, spawn("spawn"));
        assert!(router.message_target("spawn", "root-turn").is_none());
        feed(&mut router, json!({"type": "system", "subtype": "task_started", "task_id": "native-target", "tool_use_id": "spawn", "task_type": "local_agent", "run_id": "001"}));
        assert_eq!(router.message_target("spawn", "root-turn").as_deref(), Some("native-target"));
        assert!(router.message_target("spawn", "wrong-turn").is_none());
        let resumed = router.route(&json!({"type": "system", "subtype": "task_started", "task_id": "native-target", "tool_use_id": "send-message-call", "task_type": "local_agent", "run_id": "002"}), Some("new-parent-turn")).1;
        assert_eq!(resumed.last().unwrap()["id"], "root-turn");
        assert_eq!(resumed.last().unwrap()["agent"]["id"], "spawn");
        assert!(resumed.last().unwrap()["agent"].get("spawnToolCallId").is_none());
        assert_eq!(router.message_target("send-message-call", "root-turn").as_deref(), Some("native-target"));
    }

    #[test]
    fn restarted_router_includes_recipient_on_its_first_child_update() {
        let mut router = Subagents::default();
        let events = router.route(&json!({"type": "system", "subtype": "task_started", "task_id": "persisted-native-inbox", "tool_use_id": "new-send-tool", "task_type": "local_agent"}), Some("new-parent-turn")).1;
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|event| event["agent"]["messageTarget"] == "persisted-native-inbox"));
        let mut wrapper = Subagents::default();
        let events = wrapper.route(&json!({"type": "assistant", "parent_tool_use_id": "new-parent-tool", "agent_id": "persisted-native-inbox", "message": {"content": [{"type": "text", "text": "Resumed output"}]}}), Some("new-parent-turn")).1;
        assert_eq!(events[0]["agent"]["messageTarget"], "persisted-native-inbox");
    }

    #[test]
    fn native_peer_echo_records_actual_child_input_once_on_its_original_turn() {
        let mut router = Subagents::default();
        feed(&mut router, json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "spawn", "name": "Agent", "input": {"description": "Check files"}}]}}));
        feed(&mut router, json!({"type": "system", "subtype": "task_started", "task_id": "native-target", "tool_use_id": "spawn", "task_type": "local_agent"}));
        let echo = json!({"type": "user", "uuid": "native-inbox-uuid", "parent_tool_use_id": "spawn", "agent_id": "native-target", "origin": {"kind": "peer", "from": "main", "body": "Exact message\nwithout envelope"}, "message": {"content": [{"type": "text", "text": "Envelope must not be parsed"}]}});
        let first = router.route(&echo, Some("new-parent-turn")).1;
        let input: Vec<_> = first.iter().filter(|event| event.pointer("/agent/segment/kind") == Some(&json!("user"))).collect();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["id"], "root-turn");
        assert_eq!(input[0]["agent"]["id"], "spawn");
        assert_eq!(input[0]["agent"]["segment"], json!({"kind": "user", "toolId": "native-inbox-uuid", "text": "Exact message\nwithout envelope"}));
        assert!(router.route(&echo, Some("new-parent-turn")).1.is_empty());
    }

    #[test]
    fn forwarding_prompt_escapes_target_and_user_data_and_requires_a_real_target() {
        let message = "linha 1\n\"to\": \"outro\", @arquivo /comando";
        let prompt = format_subagent_message("real-native-agent", message).unwrap();
        let data: Value = serde_json::from_str(prompt.rsplit_once("\n\n").unwrap().1).unwrap();
        assert_eq!(data, json!({"to": "real-native-agent", "message": message}));
        assert!(prompt.contains("usando SendMessage"));
        assert!(prompt.contains("somente após o resultado"));
        assert!(format_subagent_message("", "text").is_err());
        assert!(format_subagent_message("target\nwrong", "text").is_err());
        assert!(format_subagent_message("target", "  ").is_err());
    }
}

#[derive(Clone)]
struct Child { id: String, turn: String, parent: Option<String>, status: String, message_target: Option<String>, spawn_tool_call_id: Option<String> }
struct Block { kind: String, text: String, consumed: bool }

fn text(value: Option<&Value>) -> Option<&str> { value.and_then(Value::as_str).filter(|s| !s.is_empty()) }
fn content(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("text")).filter_map(|b| text(b.get("text"))).collect(),
        _ => String::new(),
    }
}
fn terminal(status: &str) -> bool { matches!(status, "completed" | "failed" | "stopped") }

/// An instruction to the parent to use the native SendMessage tool. This is
/// deliberately not a direct child stdin frame or a child-delivery receipt.
pub fn format_subagent_message(message_target: &str, message: &str) -> Result<String, String> {
    if message_target.is_empty() || message_target != message_target.trim() || message_target.len() > 1024 || message_target.chars().any(|c| c.is_ascii_control()) {
        return Err("Este subagente ainda não informou um destinatário nativo válido.".into());
    }
    if message.trim().is_empty() { return Err("Digite uma mensagem.".into()); }
    Ok(format!("Encaminhe esta mensagem do usuário ao subagente já existente usando SendMessage.\nUse exatamente o ID do campo \"to\" abaixo; não crie outro agente nem execute a tarefa no lugar dele.\nSe esse destinatário não existir ou não aceitar mensagens, informe a falha sem escolher outro.\nConfirme a entrega somente após o resultado de SendMessage.\n\n{}", json!({"to": message_target, "message": message})))
}

impl Subagents {
    fn canonical(&self, id: &str) -> String { self.aliases.get(id).cloned().unwrap_or_else(|| id.into()) }

    fn update(&mut self, id: &str, mut update: Value, out: &mut Vec<Value>) {
        let Some(child) = self.children.get_mut(id) else { return };
        if let Some(status) = text(update.get("status")) { child.status = status.into(); }
        if let Some(target) = text(update.get("messageTarget")) { child.message_target = Some(target.into()); }
        if let Some(tool) = text(update.get("spawnToolCallId")) { child.spawn_tool_call_id = Some(tool.into()); }
        update["id"] = child.id.clone().into();
        if let Some(parent) = &child.parent { update["parentId"] = parent.clone().into(); }
        if let Some(target) = &child.message_target { update["messageTarget"] = target.clone().into(); }
        out.push(json!({"id": child.turn, "agent": update}));
    }

    fn child(&mut self, native: &str, turn: Option<&str>, metadata: Value, out: &mut Vec<Value>) -> Option<String> {
        let id = self.canonical(native);
        if !self.children.contains_key(&id) {
            let turn = turn?;
            self.children.insert(id.clone(), Child { id: id.clone(), turn: turn.into(), parent: text(metadata.get("parentId")).map(str::to_owned), status: "running".into(), message_target: None, spawn_tool_call_id: None });
            let mut update = metadata;
            update["status"] = "running".into();
            self.update(&id, update, out);
        }
        Some(id)
    }

    pub fn message_target(&self, agent_id: &str, root_turn: &str) -> Option<String> {
        self.children.get(&self.canonical(agent_id)).filter(|child| child.turn == root_turn).and_then(|child| child.message_target.clone())
    }

    fn spawn(&mut self, block: &Value, parent: Option<&str>, turn: Option<&str>, out: &mut Vec<Value>) {
        if !matches!(text(block.get("name")), Some("Agent" | "Task")) { return; }
        let Some(id) = text(block.get("id")) else { return };
        let input = &block["input"];
        let mut metadata = json!({
            "spawnToolCallId": id,
            "name": text(input.get("name")).or_else(|| text(input.get("subagent_type"))).unwrap_or("Claude"),
            "description": text(input.get("description")).or_else(|| text(input.get("prompt"))).unwrap_or("Subagente")
        });
        if let Some(model) = text(input.get("model")) { metadata["model"] = model.into(); }
        let parent_turn = parent.and_then(|id| self.children.get(id)).map(|child| child.turn.clone());
        if let Some(parent) = parent { metadata["parentId"] = parent.into(); }
        if let Some(canonical) = self.child(id, parent_turn.as_deref().or(turn), metadata, out) { self.aliases.insert(id.into(), canonical); }
    }

    /// The bool consumes child-only frames before parent text/context handling.
    pub fn route(&mut self, msg: &Value, turn: Option<&str>) -> (bool, Vec<Value>) {
        let mut out = Vec::new();
        let kind = text(msg.get("type")).unwrap_or("");
        let subtype = text(msg.get("subtype")).unwrap_or("");
        if kind == "system" && matches!(subtype, "task_started" | "task_progress" | "task_notification" | "task_updated") {
            if msg.get("ambient") == Some(&Value::Bool(true)) || msg.get("skip_transcript") == Some(&Value::Bool(true)) { return (true, out); }
            // A resumed child keeps its task id but may have a new SendMessage
            // tool id. Reuse the first identity and its original parent turn.
            let existing_task = text(msg.get("task_id")).map(|id| self.canonical(id)).filter(|id| self.children.contains_key(id));
            let Some(native) = existing_task.as_deref().or_else(|| text(msg.get("tool_use_id"))).or_else(|| text(msg.get("task_id"))) else { return (true, out) };
            let known = self.children.contains_key(&self.canonical(native)) || text(msg.get("task_id")).is_some_and(|id| self.children.contains_key(&self.canonical(id)));
            if !known && !matches!(text(msg.get("task_type")), Some("local_agent" | "subagent")) && text(msg.get("subagent_type")).is_none() { return (true, out); }
            let mut metadata = json!({});
            if let Some(target) = text(msg.get("task_id")) { metadata["messageTarget"] = target.into(); }
            if let Some(parent) = text(msg.get("parent_task_id")).map(|id| self.canonical(id)).filter(|id| self.children.contains_key(id)) { metadata["parentId"] = parent.into(); }
            if let Some(name) = text(msg.get("subagent_type")) { metadata["name"] = name.into(); }
            if let Some(description) = text(msg.get("description")) { metadata["description"] = description.into(); }
            let Some(id) = self.child(native, turn, metadata, &mut out) else { return (true, out) };
            for key in ["task_id", "tool_use_id"] { if let Some(alias) = text(msg.get(key)) { self.aliases.insert(alias.into(), id.clone()); } }
            if let Some(run) = text(msg.get("run_id")) {
                if self.runs.get(&id).is_some_and(|previous| run < previous.as_str()) { return (true, out); }
                self.runs.insert(id.clone(), run.into());
            }
            let patch = &msg["patch"];
            let status = if subtype == "task_notification" { text(msg.get("status")) } else { text(patch.get("status")) };
            let mut update = json!({});
            if let Some(target) = text(msg.get("task_id")) { update["messageTarget"] = target.into(); }
            if let Some(status) = status { update["status"] = match status { "killed" => "stopped", "paused" => "waiting", other => other }.into(); }
            else if subtype == "task_started" || !terminal(&self.children[&id].status) { update["status"] = "running".into(); }
            if self.children[&id].spawn_tool_call_id.is_none()
                && let Some(tool) = text(msg.get("tool_use_id")) { update["spawnToolCallId"] = tool.into(); }
            if let Some(description) = text(msg.get("description")).or_else(|| text(patch.get("description"))) { update["description"] = description.into(); }
            if let Some(summary) = text(msg.get("summary")).or_else(|| text(patch.get("error"))) { update["summary"] = summary.into(); }
            if let Some(tool) = text(msg.get("last_tool_name")) { update["description"] = format!("{} · {}", text(msg.get("description")).unwrap_or("Trabalhando"), tool).into(); }
            self.update(&id, update, &mut out);
            return (true, out);
        }

        let parent_tool = text(msg.get("parent_tool_use_id"));
        let alias = text(msg.get("agent_id")).and_then(|id| self.aliases.get(id).cloned());
        let known_parent = parent_tool.filter(|id| self.children.contains_key(&self.canonical(id)));
        let native = known_parent.map(str::to_owned).or(alias).or_else(|| parent_tool.map(str::to_owned));
        let mut metadata = json!({});
        if let Some(target) = text(msg.get("agent_id")) { metadata["messageTarget"] = target.into(); }
        if let Some(name) = text(msg.get("subagent_type")) { metadata["name"] = name.into(); }
        if let Some(description) = text(msg.get("task_description")) { metadata["description"] = description.into(); }
        let child = native.as_deref().and_then(|id| self.child(id, turn, metadata, &mut out));
        if let (Some(child), Some(alias)) = (&child, text(msg.get("agent_id"))) {
            self.aliases.insert(alias.into(), child.clone());
            if self.children[child].message_target.as_deref() != Some(alias) { self.update(child, json!({"messageTarget": alias}), &mut out); }
        }
        if let (Some(child), Some(alias)) = (&child, parent_tool) { self.aliases.insert(alias.into(), child.clone()); }
        let blocks = msg.pointer("/message/content").and_then(Value::as_array);
        if kind == "assistant" {
            for block in blocks.into_iter().flatten() { self.spawn(block, child.as_deref(), turn, &mut out); }
        }
        if kind == "user" {
            for block in blocks.into_iter().flatten().filter(|b| text(b.get("type")) == Some("tool_result")) {
                let Some(tool) = text(block.get("tool_use_id")) else { continue };
                let spawned = self.canonical(tool);
                if !self.children.contains_key(&spawned) { continue; }
                let output = &msg["tool_use_result"];
                if let Some(alias) = text(output.get("agentId")) { self.aliases.insert(alias.into(), spawned.clone()); }
                let rendered = content(block.get("content"));
                let lower = rendered.to_lowercase();
                let background = text(output.get("status")) == Some("async_launched") || output.get("isAsync") == Some(&Value::Bool(true)) || ["running in the background", "launched successfully", "agent is running"].iter().any(|s| lower.contains(s));
                let status = if block.get("is_error") == Some(&Value::Bool(true)) { "failed" } else if background { if terminal(&self.children[&spawned].status) { &self.children[&spawned].status } else { "running" } } else { "completed" };
                let mut update = json!({"status": status});
                if let Some(target) = text(output.get("agentId")) { update["messageTarget"] = target.into(); }
                if let Some(model) = text(output.get("resolvedModel")) { update["model"] = model.into(); }
                if !background { let report = content(output.get("content")); update["summary"] = if report.is_empty() { rendered } else { report }.into(); }
                self.update(&spawned, update, &mut out);
            }
        }
        let Some(child) = child else { return (parent_tool.is_some(), out) };
        if kind == "stream_event" {
            let ev = &msg["event"];
            if text(ev.get("type")) == Some("message_start")
                && let Some(id) = ev.pointer("/message/id").and_then(Value::as_str) {
                self.messages.insert(child.clone(), id.into());
            }
            if text(ev.get("type")) == Some("content_block_delta") {
                let delta = &ev["delta"];
                let kind = match text(delta.get("type")) { Some("text_delta") => Some("text"), Some("thinking_delta") => Some("thinking"), _ => None };
                if let Some(kind) = kind
                    && let Some(fragment) = text(delta.get(if kind == "text" { "text" } else { "thinking" })) {
                        let key = format!("{}:{}", child, self.messages.get(&child).map(String::as_str).unwrap_or(""));
                        let block = self.streams.entry(key).or_default().entry(ev.get("index").and_then(Value::as_u64).unwrap_or(0) as usize).or_insert_with(|| Block { kind: kind.into(), text: String::new(), consumed: false });
                        block.text.push_str(fragment);
                        let mut update = json!({}); update[kind] = fragment.into(); self.update(&child, update, &mut out);
                }
            }
        } else if kind == "assistant" {
            for block in blocks.into_iter().flatten() {
                match text(block.get("type")) {
                    Some(kind @ ("text" | "thinking")) => {
                        let Some(full) = text(block.get(kind)) else { continue };
                        let key = format!("{}:{}", child, msg.pointer("/message/id").and_then(Value::as_str).unwrap_or(""));
                        let streamed = self.streams.get_mut(&key).and_then(|blocks| blocks.values_mut().find(|b| !b.consumed && b.kind == kind && full.starts_with(&b.text))).map(|b| { b.consumed = true; b.text.len() }).unwrap_or(0);
                        let rest = &full[streamed..];
                        if !rest.is_empty() { let mut update = json!({}); update[kind] = rest.into(); self.update(&child, update, &mut out); }
                    }
                    Some("tool_use") => {
                        let segment = json!({"kind": "tool", "toolId": block["id"], "name": block["name"], "input": block["input"], "status": "running"});
                        if let Some(id) = text(block.get("id")) { self.tools.insert(id.into(), segment.clone()); }
                        self.update(&child, json!({"segment": segment}), &mut out);
                    }
                    _ => {}
                }
            }
        } else if kind == "user" {
            // The harness supplies the decoded inbox body on peer-origin frames.
            // A parent forwarding receipt must never manufacture this input.
            if msg.pointer("/origin/kind").and_then(Value::as_str) == Some("peer")
                && let (Some(body), Some(uuid)) = (msg.pointer("/origin/body").and_then(Value::as_str), text(msg.get("uuid")))
                && self.peer_messages.insert(format!("{child}:{uuid}"))
            {
                self.update(&child, json!({"segment": {"kind": "user", "toolId": uuid, "text": body}}), &mut out);
            }
            for block in blocks.into_iter().flatten().filter(|b| text(b.get("type")) == Some("tool_result")) {
                let Some(tool) = text(block.get("tool_use_id")) else { continue };
                let mut segment = self.tools.get(tool).cloned().unwrap_or_else(|| json!({"kind": "tool", "toolId": tool, "name": "Ferramenta"}));
                let failed = block.get("is_error") == Some(&Value::Bool(true));
                segment["status"] = if failed { "error" } else { "done" }.into();
                segment["result"] = content(block.get("content")).into(); segment["resultIsError"] = failed.into();
                self.tools.insert(tool.into(), segment.clone()); self.update(&child, json!({"segment": segment}), &mut out);
            }
        }
        (true, out)
    }

    pub fn close(&mut self) -> Vec<Value> {
        let ids: Vec<String> = self.children.values().filter(|child| !terminal(&child.status)).map(|child| child.id.clone()).collect();
        let mut out = Vec::new();
        for id in ids { self.update(&id, json!({"status": "stopped"}), &mut out); }
        out
    }
}
