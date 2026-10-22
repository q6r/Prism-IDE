//! A user task may span several native root turns while descendants run.
//! Only native completion events and a new root turn (or returned wait/list
//! output) prove that the root has consumed the descendants' results.
use std::collections::{HashMap, HashSet};

use serde_json::Value;

#[derive(Default)]
struct Agent {
    pending: bool,
    active: bool,
    terminal: bool,
    turn: Option<String>,
    completed_epoch: u64,
    completed_turns: HashSet<String>,
}

pub(super) struct Lifecycle {
    root: String,
    agents: HashMap<String, Agent>,
    parents: HashMap<String, String>,
    metadata: HashMap<String, Value>,
    activated_calls: HashSet<String>,
    known_children: HashSet<String>,
    completed_root_turns: HashSet<String>,
    pub root_active: bool,
    pub root_turn: Option<String>,
    root_completed: bool,
    pub error: Option<String>,
    pub interrupted: bool,
    completion_epoch: u64,
    handled_epoch: u64,
}

impl Lifecycle {
    pub fn new(root: String) -> Self {
        Self {
            root, agents: HashMap::new(), parents: HashMap::new(), metadata: HashMap::new(),
            activated_calls: HashSet::new(), known_children: HashSet::new(), completed_root_turns: HashSet::new(),
            root_active: false, root_turn: None, root_completed: false, error: None,
            interrupted: false, completion_epoch: 0, handled_epoch: 0,
        }
    }

    pub fn remember_children(&mut self, ids: Vec<String>) { self.known_children.extend(ids); }

    fn owned(&self, id: &str) -> bool { id == self.root || self.agents.contains_key(id) }

    fn ensure(&mut self, id: &str) -> bool {
        if id.is_empty() || id == self.root { return false; }
        self.agents.entry(id.to_string()).or_insert_with(|| Agent { pending: true, ..Agent::default() });
        true
    }

    fn finish_child(&mut self, id: &str, turn: Option<&str>) {
        let Some(agent) = self.agents.get_mut(id) else { return };
        if let Some(turn) = turn {
            if !agent.completed_turns.insert(turn.to_string()) { return; }
            if agent.turn.as_deref().is_some_and(|current| current != turn) { return; }
        }
        if agent.terminal { return; }
        agent.pending = false;
        agent.active = false;
        agent.terminal = true;
        self.completion_epoch += 1;
        agent.completed_epoch = self.completion_epoch;
    }

    fn start_child(&mut self, id: &str, turn: Option<&str>, force: bool, active: bool) {
        let Some(agent) = self.agents.get_mut(id) else { return };
        if turn.is_some_and(|turn| agent.completed_turns.contains(turn)) { return; }
        if agent.terminal && !force && (turn.is_none() || turn == agent.turn.as_deref()) { return; }
        if let Some(turn) = turn { agent.turn = Some(turn.to_string()); }
        agent.pending = true;
        agent.active = active || agent.active && !agent.terminal;
        agent.terminal = false;
    }

    fn child_status(&mut self, id: &str, status: &Value) {
        match status["type"].as_str() {
            Some("active") => self.start_child(id, None, true, true),
            Some("systemError") => self.finish_child(id, None),
            Some("idle") if self.agents.get(id).is_some_and(|agent| agent.active) => self.finish_child(id, None),
            _ => {}
        }
    }

    fn adopt_links(&mut self) {
        loop {
            let adopt: Vec<String> = self.parents.iter()
                .filter(|(id, parent)| id.as_str() != self.root && !self.agents.contains_key(*id) && self.owned(parent))
                .map(|(id, _)| id.clone()).collect();
            if adopt.is_empty() { break; }
            for id in adopt {
                self.ensure(&id);
                if let Some(status) = self.metadata.get(&id).and_then(|thread| thread.get("status")).cloned() {
                    self.child_status(&id, &status);
                }
            }
        }
    }

    fn item(&mut self, method: &str, p: &Value) {
        let source = p["threadId"].as_str().unwrap_or_default();
        if !self.owned(source) { return; }
        let item = &p["item"];
        match item["type"].as_str() {
            Some("collabAgentToolCall") => {
                let states = item["agentsStates"].as_object();
                let mut ids: HashSet<String> = item["receiverThreadIds"].as_array().into_iter().flatten()
                    .filter_map(Value::as_str).map(str::to_string).collect();
                if let Some(states) = states { ids.extend(states.keys().cloned()); }
                let tool = item["tool"].as_str().unwrap_or_default();
                let failed = matches!(item["status"].as_str(), Some("failed" | "interrupted"));
                let activating = !failed && matches!(tool, "spawnAgent" | "sendInput" | "resumeAgent" | "followupTask")
                    && item["id"].as_str().is_some_and(|id| self.activated_calls.insert(format!("{source}:{id}")));
                for id in ids {
                    // Wait/list output does not establish ownership.
                    if tool != "spawnAgent" && !self.agents.contains_key(&id) && !self.known_children.contains(&id) { continue; }
                    let state = &item["agentsStates"][&id];
                    if failed && !self.agents.contains_key(&id) && state.is_null() { continue; }
                    if !self.ensure(&id) { continue; }
                    self.parents.entry(id.clone()).or_insert_with(|| source.to_string());
                    if activating { self.start_child(&id, None, true, false); }
                    match state["status"].as_str() {
                        Some("pendingInit") => self.start_child(&id, None, false, false),
                        Some("running") => self.start_child(&id, None, false, true),
                        Some(status) if terminal(status) => self.finish_child(&id, None),
                        _ => {}
                    }
                }
                self.adopt_links();
                let current = p["turnId"].as_str().is_none_or(|turn|
                    !self.completed_root_turns.contains(turn) && self.root_turn.as_deref().is_none_or(|current| current == turn));
                if source == self.root && self.root_active && current && method == "item/completed"
                    && item["status"] == "completed" && matches!(tool, "wait" | "listAgents")
                    && self.agents.iter().all(|(id, agent)| agent.completed_epoch <= self.handled_epoch
                        || item["agentsStates"][id]["status"].as_str().is_some_and(terminal))
                {
                    self.handled_epoch = self.completion_epoch;
                }
            }
            Some("subAgentActivity") => {
                let Some(id) = item["agentThreadId"].as_str() else { return };
                if !self.ensure(id) { return; }
                self.parents.entry(id.to_string()).or_insert_with(|| source.to_string());
                match item["kind"].as_str() {
                    Some("started") => self.start_child(id, None, true, false),
                    Some("interacted") => self.start_child(id, None, false, false),
                    Some("completed" | "interrupted") => self.finish_child(id, None),
                    _ => {}
                }
                self.adopt_links();
            }
            _ => {}
        }
    }

    pub fn observe(&mut self, method: &str, p: &Value) {
        if method == "thread/started" {
            let thread = &p["thread"];
            let Some(id) = thread["id"].as_str().filter(|id| *id != self.root) else { return };
            let parent = thread["parentThreadId"].as_str().or_else(|| thread.pointer("/source/subAgent/thread_spawn/parent_thread_id").and_then(Value::as_str));
            if let Some(parent) = parent {
                self.parents.insert(id.to_string(), parent.to_string());
                self.metadata.insert(id.to_string(), thread.clone());
                self.adopt_links();
            }
            return;
        }
        let thread = p["threadId"].as_str().unwrap_or_default();
        if !self.owned(thread) { return; }
        match method {
            "turn/started" => {
                let Some(id) = p["turn"]["id"].as_str() else { return };
                if thread != self.root { self.start_child(thread, Some(id), true, true); }
                else if !self.completed_root_turns.contains(id) {
                    self.root_turn = Some(id.to_string());
                    self.root_active = true;
                    self.root_completed = false;
                    self.error = None;
                    self.interrupted = false;
                    self.handled_epoch = self.completion_epoch;
                }
            }
            "turn/completed" => {
                let turn = &p["turn"];
                let Some(id) = turn["id"].as_str() else { return };
                let Some(status) = turn["status"].as_str().filter(|status| matches!(*status, "completed" | "failed" | "interrupted")) else { return };
                if thread != self.root { self.finish_child(thread, Some(id)); }
                else if !self.completed_root_turns.contains(id) && (!self.root_active || self.root_turn.as_deref().is_none_or(|current| current == id)) {
                    self.completed_root_turns.insert(id.to_string());
                    self.root_turn = Some(id.to_string());
                    self.root_active = false;
                    self.root_completed = true;
                    self.error = (status == "failed").then(|| turn["error"]["message"].as_str().unwrap_or("Falha no Codex.").to_string());
                    self.interrupted = status == "interrupted";
                }
            }
            "thread/status/changed" => {
                if thread != self.root { self.child_status(thread, &p["status"]); }
                else if p["status"]["type"] == "systemError" {
                    self.error = Some("A conversa do Codex encontrou um erro no App Server.".into());
                    self.root_active = false;
                    self.root_completed = true;
                }
                else if p["status"]["type"] == "active" && !self.root_active {
                    self.acknowledge_continuation();
                }
            }
            "thread/closed" if thread != self.root => self.finish_child(thread, None),
            "thread/closed" => {
                self.error = Some("A conversa do Codex foi encerrada antes de concluir a tarefa.".into());
                self.root_active = false;
                self.root_completed = true;
            }
            "item/started" | "item/completed" => self.item(method, p),
            _ => {}
        }
    }

    pub fn pending_agents(&self) -> Vec<String> { self.agents.iter().filter(|(_, a)| a.pending).map(|(id, _)| id.clone()).collect() }
    pub fn children(&self) -> Vec<String> { self.agents.keys().cloned().collect() }
    pub fn child_state(&self, id: &str) -> Option<(bool, bool, Option<String>, u64)> {
        self.agents.get(id).map(|a| (a.pending, a.active, a.turn.clone(), a.completed_epoch))
    }
    pub fn can_finish(&self) -> bool {
        self.root_completed && (self.error.is_some() || self.interrupted
            || !self.agents.values().any(|a| a.pending) && self.completion_epoch == self.handled_epoch)
    }
    pub fn needs_continuation(&self) -> bool {
        self.root_completed && self.error.is_none() && !self.interrupted && !self.root_active
            && !self.agents.values().any(|a| a.pending) && self.completion_epoch > self.handled_epoch
    }
    pub fn acknowledge_continuation(&mut self) {
        self.handled_epoch = self.completion_epoch;
        self.root_active = true;
        self.root_completed = false;
        self.root_turn = None;
        self.error = None;
        self.interrupted = false;
    }
}

fn terminal(status: &str) -> bool { matches!(status, "completed" | "interrupted" | "errored" | "shutdown" | "notFound") }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn start(l: &mut Lifecycle, thread: &str, turn: &str) { l.observe("turn/started", &json!({"threadId":thread,"turn":{"id":turn}})); }
    fn done(l: &mut Lifecycle, thread: &str, turn: &str) { l.observe("turn/completed", &json!({"threadId":thread,"turn":{"id":turn,"status":"completed"}})); }
    fn child(l: &mut Lifecycle, id: &str, parent: &str) { l.observe("thread/started", &json!({"thread":{"id":id,"parentThreadId":parent,"status":{"type":"idle"}}})); }
    fn state(l: &mut Lifecycle, id: &str, status: &str) { l.observe("thread/status/changed", &json!({"threadId":id,"status":{"type":status}})); }
    fn wait(l: &mut Lifecycle, states: Value) { l.observe("item/completed", &json!({"threadId":"root","item":{"id":"wait","type":"collabAgentToolCall","tool":"wait","status":"completed","agentsStates":states}})); }

    #[test]
    fn yields_stay_open_and_native_continuation_consumes_children() {
        let mut l = Lifecycle::new("root".into());
        start(&mut l,"root","r1"); child(&mut l,"child","root"); start(&mut l,"child","c1");
        done(&mut l,"root","r1"); assert!(!l.can_finish()); assert!(!l.needs_continuation());
        done(&mut l,"child","c1"); assert!(l.needs_continuation());
        start(&mut l,"root","r2"); assert!(!l.needs_continuation()); done(&mut l,"root","r2"); assert!(l.can_finish());
    }

    #[test]
    fn ordinary_output_cannot_consume_a_child_completion_but_returned_wait_can() {
        for kind in ["agentMessage","commandExecution","reasoning","subAgentActivity"] {
            let mut l = Lifecycle::new("root".into());
            start(&mut l,"root","r"); child(&mut l,"child","root"); start(&mut l,"child","c"); done(&mut l,"child","c");
            l.observe("item/completed", &json!({"threadId":"root","item":{"type":kind,"text":"Vou aguardar","agentThreadId":"child","kind":"completed"}}));
            done(&mut l,"root","r"); assert!(l.needs_continuation(), "{kind}");
        }
        let mut l = Lifecycle::new("root".into());
        start(&mut l,"root","r"); child(&mut l,"child","root"); start(&mut l,"child","c"); done(&mut l,"child","c");
        wait(&mut l,json!({"child":{"status":"completed"}})); done(&mut l,"root","r"); assert!(l.can_finish());
    }

    #[test]
    fn descendants_and_reverse_edges_block_until_all_complete() {
        let mut l = Lifecycle::new("root".into());
        start(&mut l,"root","r"); child(&mut l,"nested","child"); child(&mut l,"stranger","foreign"); child(&mut l,"child","root");
        assert_eq!(l.children().len(),2); done(&mut l,"root","r");
        start(&mut l,"child","c"); start(&mut l,"nested","n"); done(&mut l,"child","c"); assert!(!l.needs_continuation());
        done(&mut l,"nested","n"); assert!(l.needs_continuation());
    }

    #[test]
    fn metadata_idle_is_terminal_only_after_activity_and_native_active_wins() {
        let mut l = Lifecycle::new("root".into());
        start(&mut l,"root","r"); child(&mut l,"child","root"); done(&mut l,"root","r");
        state(&mut l,"child","idle"); assert_eq!(l.pending_agents(),vec!["child"]);
        state(&mut l,"child","active"); state(&mut l,"child","idle"); assert!(l.needs_continuation());
        state(&mut l,"root","active"); assert!(l.root_active); assert!(!l.needs_continuation());
        done(&mut l,"root","native"); assert!(l.can_finish());
    }

    #[test]
    fn acknowledgement_deduplicates_and_short_continuation_can_complete_before_start_ack() {
        let mut l = Lifecycle::new("root".into());
        start(&mut l,"root","r"); child(&mut l,"child","root"); start(&mut l,"child","c"); done(&mut l,"root","r"); done(&mut l,"child","c");
        l.acknowledge_continuation(); done(&mut l,"root","r"); done(&mut l,"child","c"); assert!(l.root_active);
        done(&mut l,"root","fallback"); assert!(l.can_finish()); assert!(!l.needs_continuation());
    }

    #[test]
    fn stale_child_completion_does_not_end_new_work_or_revive_completed_spawn() {
        let mut l = Lifecycle::new("root".into());
        start(&mut l,"root","r"); child(&mut l,"child","root"); start(&mut l,"child","c1"); done(&mut l,"child","c1");
        start(&mut l,"child","c2"); done(&mut l,"child","c1"); assert_eq!(l.pending_agents(),vec!["child"]);
        done(&mut l,"root","r"); done(&mut l,"child","c2"); assert!(l.needs_continuation());
    }

    #[test]
    fn failed_spawn_and_unrelated_wait_do_not_register_phantom_agents() {
        let mut l = Lifecycle::new("root".into());
        start(&mut l,"root","r");
        l.observe("item/completed", &json!({"threadId":"root","item":{"id":"spawn","type":"collabAgentToolCall","tool":"spawnAgent","status":"failed","receiverThreadIds":["phantom"]}}));
        wait(&mut l,json!({"stranger":{"status":"running"}})); done(&mut l,"root","r"); assert!(l.can_finish());
    }

    #[test]
    fn later_tasks_can_reuse_known_descendants_without_waiting_for_every_old_child() {
        let mut l = Lifecycle::new("root".into());
        l.remember_children(vec!["known".into(), "old-completed".into()]);
        start(&mut l,"root","r"); assert!(l.pending_agents().is_empty());
        l.observe("item/completed",&json!({"threadId":"root","item":{"id":"followup","type":"collabAgentToolCall","tool":"sendInput","status":"completed","agentsStates":{"known":{"status":"running"},"stranger":{"status":"running"}}}}));
        assert_eq!(l.pending_agents(),vec!["known"]);
        done(&mut l,"root","r");start(&mut l,"known","c");done(&mut l,"known","c");assert!(l.needs_continuation());
    }
}
