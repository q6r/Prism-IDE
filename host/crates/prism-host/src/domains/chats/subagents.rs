//! Read-only conversations for native children. They are observers of the
//! provider session, not independent runners, and keep the host alive until
//! the native child reports a terminal status.
use super::*;

pub(super) struct Child {
    root_chat: String,
    root_turn: String,
    native_id: String,
    parent_native: Option<String>,
    chat_id: String,
    turn_id: String,
    generation: u64,
    parent_chat: String,
    parent_turn: String,
    selection: Value,
    link: Value,
    _hold: Option<ActivityGuard>,
}

fn active(status: &str) -> bool {
    matches!(status, "pending" | "running" | "waiting")
}
fn native_chat(root: &str, native: &str) -> String {
    format!("subagent:{root}:{native}")
}
fn native_turn(origin: &str, native: &str) -> String {
    format!("subagent:{origin}:{native}")
}
fn id(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}
fn link_segment(child: &Child) -> Value {
    let status = child.link["status"].as_str().unwrap_or("pending");
    json!({"kind":"tool", "toolId":format!("subagent:{}", child.native_id), "name":"Agent",
        "input":{"description":child.link["description"], "model":child.link["model"]},
        "status":if active(status) { "running" } else if status == "failed" { "error" } else { "done" },
        "subagent":child.link})
}
fn metadata(child: &Child) -> Value {
    let mut meta = child.link.as_object().cloned().unwrap_or_default();
    meta.remove("chatId");
    meta.insert("rootChatId".into(), json!(child.root_chat));
    meta.insert("rootTurnId".into(), json!(child.root_turn));
    meta.insert("turnId".into(), json!(child.turn_id));
    meta.insert("generation".into(), json!(child.generation));
    if let Some(parent) = &child.parent_native {
        meta.insert("parentId".into(), json!(parent));
    }
    Value::Object(meta)
}

impl Engine {
    pub(super) fn native_descendants_busy(&self, root: &str) -> bool {
        self.native_children.values().any(|child| {
            child.root_chat == root && child.link["status"].as_str().is_some_and(active)
        })
    }
    pub(super) fn restore_subagents(&mut self) {
        let chats = self.store.chats().unwrap_or_default();
        for chat in chats {
            let meta = &chat["nativeAgent"];
            if !meta["status"].as_str().is_some_and(active) {
                continue;
            }
            if let (Some(root), Some(turn), Some(native)) = (
                id(meta, "rootChatId"),
                id(meta, "rootTurnId"),
                id(meta, "id"),
            ) {
                let mut agent = json!({"id":native, "status":"stopped", "summary":"O host foi reiniciado; este subagente não está mais em execução."});
                if let Some(parent) = meta.get("parentId") {
                    agent["parentId"] = parent.clone();
                }
                self.subagent_event(&root, &turn, agent);
            }
        }
        self.flush();
    }

    pub(super) fn subagent_event(&mut self, root_id: &str, origin: &str, agent: Value) {
        let Some(native_id) = id(&agent, "id") else {
            return;
        };
        let chat_id = native_chat(root_id, &native_id);
        let now = crate::now_ms();
        let mut child = if let Some(child) = self.native_children.remove(&chat_id) {
            if child.root_turn != origin {
                self.native_children.insert(chat_id, child);
                return;
            }
            child
        } else {
            let Some(root) = self.store.chat(root_id).ok().flatten() else {
                return;
            };
            // Validate origin once per child, rather than re-folding a long
            // root history for every streamed token.
            let Some(root_turn) = root["turns"]
                .as_array()
                .and_then(|turns| {
                    turns
                        .iter()
                        .find(|t| t["id"] == origin && t["role"] == "assistant")
                })
                .cloned()
            else {
                return;
            };
            let parent_native = id(&agent, "parentId");
            if parent_native.as_deref() == Some(native_id.as_str()) {
                return;
            }
            let (parent_chat, parent_turn) = if let Some(parent) = &parent_native {
                let parent_chat = native_chat(root_id, parent);
                let valid = self
                    .store
                    .document(kinds::CHATS, &parent_chat)
                    .ok()
                    .flatten()
                    .is_some_and(|c| {
                        c["nativeAgent"]["rootChatId"] == root_id
                            && c["nativeAgent"]["rootTurnId"] == origin
                    });
                if !valid {
                    return;
                }
                let parent_turn = self
                    .store
                    .document(kinds::CHATS, &parent_chat)
                    .ok()
                    .flatten()
                    .and_then(|c| id(&c["nativeAgent"], "turnId"))
                    .unwrap_or_else(|| native_turn(origin, parent));
                (parent_chat, parent_turn)
            } else {
                (root_id.to_string(), origin.to_string())
            };
            let existing = self.store.chat(&chat_id).ok().flatten();
            if existing.as_ref().is_some_and(|c| {
                c["nativeAgent"]["rootTurnId"]
                    .as_str()
                    .is_some_and(|turn| turn != origin)
            }) {
                return;
            }
            let old_meta = existing.as_ref().map(|c| &c["nativeAgent"]);
            let mut selection = root_turn
                .get("selection")
                .filter(|s| s.is_object())
                .cloned()
                .unwrap_or_else(|| root["selection"].clone());
            for field in ["provider", "model"] {
                if let Some(value) = root_turn.get(field) {
                    selection[field] = value.clone();
                }
            }
            if let Some(model) = agent.get("model").filter(|model| model.is_string()) {
                selection["model"] = model.clone();
            }
            let name = id(&agent, "name")
                .or_else(|| old_meta.and_then(|m| id(m, "name")))
                .unwrap_or_else(|| {
                    format!(
                        "Subagente {}",
                        native_id.chars().take(8).collect::<String>()
                    )
                });
            let started = old_meta
                .and_then(|m| m.get("startedAt"))
                .and_then(Value::as_u64)
                .unwrap_or(now);
            let mut link = json!({"id":native_id,"chatId":chat_id,"name":name,"status":"pending","startedAt":started,"updatedAt":now});
            for field in [
                "description",
                "model",
                "summary",
                "activity",
                "spawnToolCallId",
            ] {
                if let Some(value) = old_meta.and_then(|m| m.get(field)) {
                    link[field] = value.clone();
                }
            }
            let turn_id = old_meta
                .and_then(|m| id(m, "turnId"))
                .unwrap_or_else(|| native_turn(origin, &native_id));
            let generation = old_meta.and_then(|m| m["generation"].as_u64()).unwrap_or(0);
            let child = Child {
                root_chat: root_id.into(),
                root_turn: origin.into(),
                native_id,
                parent_native,
                chat_id: chat_id.clone(),
                turn_id: turn_id.clone(),
                generation,
                parent_chat,
                parent_turn,
                selection,
                link,
                _hold: None,
            };
            if existing.is_none() {
                let mut doc = json!({"id":chat_id,"title":name,"cwd":root["cwd"],"selection":child.selection,"turns":[{"id":turn_id,"role":"assistant","text":"","segments":[],"provider":child.selection["provider"],"model":child.selection["model"],"startedAt":started}],"readOnly":true,"parentChatId":child.parent_chat,"parentId":child.parent_chat,"parentTurnId":child.parent_turn,"nativeAgent":metadata(&child),"createdAt":started,"updatedAt":now,"pendingTurnId":turn_id,"lastRunId":turn_id});
                if let Some(task) = root.get("taskId") {
                    doc["taskId"] = task.clone();
                }
                let Ok((stored, _)) = self.store.begin_turn(&doc, &turn_id, None) else {
                    return;
                };
                self.delta(ChatDelta::Chat(ChatUpsert { chat: stored }));
            }
            child
        };
        let before_status = child.link["status"]
            .as_str()
            .unwrap_or("pending")
            .to_string();
        let new_summary = agent
            .get("summary")
            .and_then(Value::as_str)
            .is_some_and(|summary| {
                !summary.is_empty() && child.link["summary"].as_str() != Some(summary)
            });
        for field in ["name", "description", "model", "summary", "spawnToolCallId"] {
            if let Some(value) = agent.get(field).filter(|v| v.is_string()) {
                child.link[field] = value.clone();
            }
        }
        if let Some(status) = agent["status"].as_str().filter(|s| {
            matches!(
                *s,
                "pending" | "running" | "waiting" | "completed" | "failed" | "stopped"
            )
        }) {
            child.link["status"] = json!(status);
        }
        if let Some(model) = child.link.get("model") {
            child.selection["model"] = model.clone();
        }
        child.link["updatedAt"] = json!(now);
        let status = child.link["status"]
            .as_str()
            .unwrap_or("pending")
            .to_string();
        let busy = active(&status);
        if busy && !active(&before_status) {
            self.flush();
            if let Some(mut doc) = self.store.chat(&child.chat_id).ok().flatten() {
                child.generation += 1;
                child.turn_id = format!(
                    "{}:{}",
                    native_turn(&child.root_turn, &child.native_id),
                    child.generation
                );
                let turn = json!({"id":child.turn_id,"role":"assistant","text":"","segments":[],"provider":child.selection["provider"],"model":child.selection["model"],"startedAt":now});
                doc["turns"].as_array_mut().unwrap().push(turn.clone());
                doc["pendingTurnId"] = json!(child.turn_id);
                doc["lastRunId"] = json!(child.turn_id);
                if self.store.begin_turn(&doc, &child.turn_id, None).is_ok() {
                    self.delta(ChatDelta::Turn(TurnUpsert {
                        chat_id: child.chat_id.clone(),
                        turn,
                    }));
                    self.delta(ChatDelta::Patch(ChatPatch {
                        chat_id: child.chat_id.clone(),
                        patch: Map::from_iter([("lastRunId".into(), json!(child.turn_id))]),
                    }));
                }
            }
        }
        let mut activity = None;
        if let Some(text) = agent["text"].as_str().filter(|s| !s.is_empty()) {
            self.stream(
                &child.chat_id,
                &child.turn_id,
                AppendKind::Text,
                text.into(),
            );
            activity = Some("Respondendo".to_string());
        }
        if let Some(text) = agent["thinking"].as_str().filter(|s| !s.is_empty()) {
            self.stream(
                &child.chat_id,
                &child.turn_id,
                AppendKind::Thinking,
                text.into(),
            );
            activity = Some("Raciocinando".to_string());
        }
        if let Some(segment) = agent.get("segment").filter(|s| s.is_object()) {
            activity = Some(if segment["kind"] == "tool" {
                format!(
                    "{} {}",
                    if segment["status"] == "running" {
                        "Executando"
                    } else if segment["status"] == "error" {
                        "Falhou"
                    } else {
                        "Concluiu"
                    },
                    segment["name"].as_str().unwrap_or("ferramenta")
                )
            } else if segment["kind"] == "thinking" {
                "Raciocinando".into()
            } else {
                "Respondendo".into()
            });
            self.segment(&child.chat_id, &child.turn_id, segment.clone(), None);
        }
        if let Some(activity) = activity {
            child.link["activity"] = json!(activity);
        }
        match status.as_str() {
            "waiting" => child.link["activity"] = json!("Aguardando resposta"),
            "completed" => child.link["activity"] = json!("Concluído"),
            "failed" => child.link["activity"] = json!("Falhou"),
            "stopped" => child.link["activity"] = json!("Interrompido"),
            _ => {}
        }
        if busy {
            if child._hold.is_none() {
                child._hold = self.activity.as_ref().map(|a| a.hold());
            }
        } else {
            child._hold = None;
        }
        let child_meta = metadata(&child);
        let _ = self.edit(&child.chat_id, |doc| {
            doc.insert("nativeAgent".into(), child_meta);
            doc.insert("title".into(), child.link["name"].clone());
            doc.insert("selection".into(), child.selection.clone());
            doc.insert("updatedAt".into(), json!(now));
            if busy {
                doc.insert("pendingTurnId".into(), json!(child.turn_id));
            } else {
                doc.remove("pendingTurnId");
            }
        });
        let runtime = ChatRuntime {
            turn_id: child.turn_id.clone(),
            route: route_key(Some(&child.selection)),
            busy,
            permission: None,
            question: None,
            fast: None,
        };
        self.update_runtime(&child.chat_id, |rt| *rt = Some(runtime));
        self.segment(
            &child.parent_chat,
            &child.parent_turn,
            link_segment(&child),
            None,
        );
        if !busy && (active(&before_status) || new_summary) {
            if status != "failed"
                && let Some(summary) = child.link["summary"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
            {
                self.flush();
                let existing_text = self
                    .store
                    .chat(&child.chat_id)
                    .ok()
                    .flatten()
                    .and_then(|c| {
                        c["turns"]
                            .as_array()
                            .and_then(|turns| turns.iter().find(|t| t["id"] == child.turn_id))
                            .cloned()
                    })
                    .map(|turn| {
                        let mut parts = vec![turn["text"].as_str().unwrap_or_default().to_string()];
                        parts.extend(
                            turn["segments"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter(|s| s["kind"] == "text")
                                .filter_map(|s| s["text"].as_str().map(str::to_string)),
                        );
                        parts.join("\n")
                    })
                    .unwrap_or_default();
                if !existing_text.contains(summary.trim()) {
                    self.segment(
                        &child.chat_id,
                        &child.turn_id,
                        json!({"kind":"text","toolId":"subagent-summary","text":summary}),
                        None,
                    );
                }
            }
            let body = if status == "failed" {
                json!({"kind":"error","message":child.link["summary"].as_str().unwrap_or("O subagente terminou com erro."),"at":now})
            } else {
                json!({"kind":"done","aborted":status=="stopped","at":now})
            };
            self.record(&child.chat_id, &child.turn_id, body, None);
            self.flush();
            if let Some(chat) = self.store.chat(&child.chat_id).ok().flatten()
                && let Some(turn) = chat["turns"]
                    .as_array()
                    .and_then(|turns| turns.iter().find(|t| t["id"] == child.turn_id))
                    .cloned()
            {
                self.delta(ChatDelta::Turn(TurnUpsert {
                    chat_id: child.chat_id.clone(),
                    turn,
                }));
            }
        }
        self.native_children.insert(chat_id, child);
    }
}
