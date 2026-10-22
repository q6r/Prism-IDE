//! A root result can yield to background agents; idle follows their native
//! continuation loop. Older CLIs only expose task edges and final results.
use std::collections::{HashMap, HashSet};

use serde_json::Value;

#[derive(Default)]
pub(super) struct TurnLifecycle {
    completed: bool,
    state: Option<String>,
    snapshot: bool,
    result: Option<Value>,
    tasks: HashMap<String, Value>,
    runs: HashMap<String, String>,
    ended: HashSet<String>,
}

fn terminal(task: &Value) -> bool {
    matches!(task.get("status").and_then(Value::as_str), Some("completed" | "failed" | "stopped" | "killed"))
}

fn activity(task: &Value) -> bool {
    task.get("ambient") != Some(&Value::Bool(true)) && task.get("skip_transcript") != Some(&Value::Bool(true))
}

fn pending(task: &Value) -> bool {
    activity(task) && task.get("is_backgrounded") != Some(&Value::Bool(false)) && !terminal(task)
        && (matches!(task.get("task_type").and_then(Value::as_str), None | Some("local_agent" | "subagent" | "local_workflow"))
            || task.get("subagent_type").and_then(Value::as_str).is_some())
}

impl TurnLifecycle {
    pub fn reset(&mut self) { *self = Self::default(); }

    fn finish(&mut self) -> Option<Value> {
        let result = self.result.take()?;
        self.completed = true;
        Some(result)
    }

    pub fn observe(&mut self, msg: &Value) -> Option<Value> {
        if self.completed || !activity(msg) { return None; }
        let kind = msg.get("type").and_then(Value::as_str).unwrap_or("");
        let subtype = msg.get("subtype").and_then(Value::as_str).unwrap_or("");
        let task_signal = kind == "system" && matches!(subtype, "task_started" | "task_updated" | "task_notification" | "background_tasks_changed");
        if msg.get("parent_tool_use_id").and_then(Value::as_str).is_some() && !task_signal { return None; }
        if kind == "assistant" || (kind == "stream_event" && matches!(msg.pointer("/event/type").and_then(Value::as_str), Some("message_start" | "content_block_start" | "content_block_delta")))
            || (kind == "system" && subtype == "init") { self.result = None; }
        if kind == "system" {
            if subtype == "session_state_changed" {
                self.state = msg.get("state").and_then(Value::as_str).map(str::to_string);
                if self.state.as_deref() == Some("idle") { return self.finish(); }
            } else if subtype == "background_tasks_changed" {
                if let Some(tasks) = msg.get("tasks").and_then(Value::as_array) {
                    self.snapshot = true;
                    self.tasks.clear();
                    for task in tasks {
                        if let Some(id) = task.get("task_id").and_then(Value::as_str).filter(|_| pending(task)) {
                            self.tasks.insert(id.to_string(), task.clone());
                        }
                    }
                }
            } else if !self.snapshot && let Some(id) = msg.get("task_id").and_then(Value::as_str) {
                if let Some(run) = msg.get("run_id").and_then(Value::as_str) {
                    if self.runs.get(id).is_some_and(|previous| run < previous.as_str()) { return None; }
                    if self.runs.get(id).is_none_or(|previous| run != previous) {
                        self.runs.insert(id.to_string(), run.to_string());
                        self.ended.remove(id);
                    }
                }
                if subtype == "task_started" && !self.ended.contains(id) {
                    self.tasks.insert(id.to_string(), msg.clone());
                } else if subtype == "task_notification" && terminal(msg) {
                    self.tasks.remove(id); self.ended.insert(id.to_string());
                } else if subtype == "task_updated" && let Some(task) = self.tasks.get_mut(id) {
                    if let Some(patch) = msg.get("patch").and_then(Value::as_object) {
                        for (key, value) in patch { task[key] = value.clone(); }
                    }
                    if terminal(task) { self.tasks.remove(id); self.ended.insert(id.to_string()); }
                }
            }
            return None;
        }
        if kind != "result" { return None; }
        self.result = Some(msg.clone());
        if msg.get("is_error") == Some(&Value::Bool(true)) || subtype != "success"
            || (self.state.is_none() && !self.tasks.values().any(pending)) {
            return self.finish();
        }
        None
    }
}
