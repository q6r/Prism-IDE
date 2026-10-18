//! Native child threads belong to the turn that discovered them, even after
//! that turn ends. Never infer membership from an arbitrary incoming thread id.
use super::convert::{Segment, apply_delta, delta_kind, native_item};
use super::session::{CodexEvent, CodexSink, EventBody};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone)]
pub(super) struct Origin {
    pub id: String,
    pub sink: Arc<dyn CodexSink>,
}
struct Child {
    id: String,
    parent: Option<String>,
    origin: Origin,
    status: String,
    turn: Option<String>,
    segments: HashMap<String, Segment>,
}
impl Child {
    fn emit(&self, patch: Value) {
        let mut agent = patch.as_object().cloned().unwrap_or_default();
        agent.retain(|_, value| !value.is_null());
        agent.insert("id".into(), json!(self.id));
        if let Some(parent) = &self.parent {
            agent.insert("parentId".into(), json!(parent));
        }
        self.origin.sink.event(&CodexEvent {
            id: self.origin.id.clone(),
            body: EventBody::Subagent {
                agent: Value::Object(agent),
            },
        });
    }
    fn status(&mut self, status: &str) {
        if self.status != status {
            self.status = status.into();
            self.emit(json!({"status":status}));
        }
    }
}
#[derive(Default)]
pub(super) struct Subagents {
    children: HashMap<String, Child>,
    root_turns: HashMap<String, Origin>,
}
impl Subagents {
    pub fn remember_root_turn(&mut self, id: &str, origin: Origin) {
        if !id.is_empty() {
            self.root_turns.insert(id.to_string(), origin);
        }
    }
    pub fn contains(&self, id: &str) -> bool {
        self.children.contains_key(id)
    }
    pub fn belongs_to(&self, id: &str, turn: &str) -> bool {
        self.children
            .get(id)
            .is_some_and(|child| child.origin.id == turn)
    }
    fn discover(&mut self, root: &str, parent: &str, id: &str, origin: Option<&Origin>) -> bool {
        if id.is_empty() || id == root {
            return false;
        }
        if self.children.contains_key(id) {
            return true;
        }
        let origin = if parent == root {
            origin.cloned()
        } else {
            self.children.get(parent).map(|c| c.origin.clone())
        };
        let Some(origin) = origin else {
            return false;
        };
        let child = Child {
            id: id.into(),
            parent: (parent != root).then(|| parent.to_string()),
            origin,
            status: "pending".into(),
            turn: None,
            segments: HashMap::new(),
        };
        child.emit(json!({"status":"pending"}));
        self.children.insert(id.into(), child);
        true
    }
    /// Returns true for a notification consumed by a known descendant. Requests
    /// remain in the regular permission path, with the child's waiting status.
    pub fn handle(&mut self, root: &str, origin: Option<&Origin>, message: &Value) -> bool {
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let p = &message["params"];
        if p["threadId"] == root
            && method == "turn/started"
            && let Some(origin) = origin
            && let Some(id) = p["turn"]["id"].as_str()
        {
            self.remember_root_turn(id, origin.clone());
        }
        let stored_origin = p["turnId"]
            .as_str()
            .and_then(|id| self.root_turns.get(id))
            .cloned();
        let origin = stored_origin.as_ref().or(origin);
        if method == "thread/started" {
            let thread = &p["thread"];
            let source = &thread["source"]["subAgent"]["thread_spawn"];
            if let (Some(parent), Some(id)) =
                (source["parent_thread_id"].as_str(), thread["id"].as_str())
                && self.discover(root, parent, id, origin)
            {
                let child = self.children.get_mut(id).unwrap();
                let name = thread["agentNickname"]
                    .as_str()
                    .or_else(|| source["agent_nickname"].as_str())
                    .or_else(|| source["agent_path"].as_str());
                child.emit(json!({"name":name,"description":thread["agentRole"].as_str().or_else(|| source["agent_role"].as_str())}));
                return true;
            }
        }
        let thread = p["threadId"].as_str().unwrap_or_default();
        let member = thread == root || self.contains(thread);
        if member
            && matches!(method, "item/started" | "item/completed")
            && p["item"]["type"] == "collabAgentToolCall"
        {
            let item = &p["item"];
            let parent = item["senderThreadId"]
                .as_str()
                .filter(|id| *id == root || self.contains(id))
                .unwrap_or(thread);
            let mut targets: Vec<&str> = item["receiverThreadIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            for id in item["agentsStates"]
                .as_object()
                .into_iter()
                .flat_map(|states| states.keys())
                .map(String::as_str)
            {
                if !targets.contains(&id) {
                    targets.push(id);
                }
            }
            for id in targets {
                // A wait/list may name the root or an unrelated thread. Only a
                // spawn establishes a new edge; later calls update known ones.
                let spawn = item["tool"] == "spawnAgent";
                if (!spawn && !self.contains(id)) || !self.discover(root, parent, id, origin) {
                    continue;
                }
                let child = self.children.get_mut(id).unwrap();
                let mut patch = json!({});
                if spawn {
                    if let Some(id) = item["id"].as_str() {
                        patch["spawnToolCallId"] = json!(id);
                    }
                    if let Some(prompt) = item["prompt"].as_str() {
                        patch["description"] = json!(prompt);
                    }
                    if let Some(model) = item["model"].as_str() {
                        patch["model"] = json!(model);
                    }
                }
                if patch.as_object().is_some_and(|p| !p.is_empty()) {
                    child.emit(patch);
                }
                let terminal_spawn =
                    spawn && matches!(child.status.as_str(), "completed" | "failed" | "stopped");
                if let Some(status) = item["agentsStates"][id]["status"].as_str() {
                    let status = collab_status(status);
                    if !(terminal_spawn && matches!(status, "pending" | "running")) {
                        child.status(status);
                    }
                } else if !terminal_spawn
                    && method == "item/completed"
                    && matches!(
                        item["tool"].as_str(),
                        Some("spawnAgent" | "sendInput" | "resumeAgent" | "followupTask")
                    )
                {
                    child.status("running");
                }
                if let Some(summary) = item["agentsStates"][id]["message"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                {
                    child.emit(json!({"summary":summary}));
                }
            }
        }
        let Some(child) = self.children.get_mut(thread) else {
            return false;
        };
        if message.get("id").is_some() {
            child.status("waiting");
            return false;
        }
        let turn = p["turnId"].as_str().or_else(|| {
            (method == "turn/completed")
                .then(|| p["turn"]["id"].as_str())
                .flatten()
        });
        if turn.is_some() && child.turn.as_deref().is_some() && turn != child.turn.as_deref() {
            return true;
        }
        match method {
            "turn/started" => {
                child.turn = p["turn"]["id"].as_str().map(str::to_string);
                child.segments.clear();
                child.status("running");
            }
            "thread/status/changed" => {
                match p["status"]["type"].as_str() {
                    Some("active") => child.status(
                        if p["status"]["activeFlags"]
                            .as_array()
                            .is_some_and(|a| !a.is_empty())
                        {
                            "waiting"
                        } else {
                            "running"
                        },
                    ),
                    Some("systemError") => child.status("failed"),
                    _ => {} // Idle is not completion: a child may still be starting.
                }
            }
            "item/started" | "item/completed" => {
                let item = &p["item"];
                if let Some(segment) = native_item(item, method == "item/completed") {
                    let id = item["id"].as_str().unwrap_or_default().to_string();
                    child.emit(json!({"segment":segment}));
                    child.segments.insert(id, segment);
                }
            }
            "turn/completed" => {
                child.status(match p["turn"]["status"].as_str() {
                    Some("failed") => "failed",
                    Some("interrupted") => "stopped",
                    _ => "completed",
                });
                if let Some(message) = p["turn"]["error"]["message"].as_str() {
                    child.emit(json!({"summary":message}));
                }
                child.turn = None;
            }
            "thread/closed" => child.status("stopped"),
            "error" => {
                if p["willRetry"] == false {
                    child.status("failed");
                }
                if let Some(message) = p["error"]["message"].as_str() {
                    child.emit(json!({"summary":message}));
                }
            }
            m => {
                if let Some(kind) = delta_kind(m) {
                    let id = p["itemId"].as_str().unwrap_or_default().to_string();
                    let mut segment = child
                        .segments
                        .get(&id)
                        .cloned()
                        .unwrap_or_else(|| Segment::text(kind, Some(json!(id)), String::new()));
                    apply_delta(&mut segment, p["delta"].as_str().unwrap_or_default());
                    child.emit(json!({"segment":segment}));
                    child.segments.insert(id, segment);
                }
            }
        }
        true
    }
    pub fn close(&mut self) {
        for child in self.children.values_mut() {
            if matches!(child.status.as_str(), "pending" | "running" | "waiting") {
                child.status("stopped");
            }
        }
    }
}
fn collab_status(status: &str) -> &str {
    match status {
        "pendingInit" => "pending",
        "running" => "running",
        "completed" => "completed",
        "errored" | "notFound" => "failed",
        "shutdown" | "interrupted" => "stopped",
        _ => "pending",
    }
}
