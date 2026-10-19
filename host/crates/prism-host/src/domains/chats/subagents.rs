//! Projected conversations for native children. They retain the provider
//! session's identity, accept explicitly routed messages, and keep the host alive until
//! the native child reports a terminal status.
use super::*;

pub(super) struct Child {
    root_chat: String,
    root_turn: String,
    native_id: String,
    control_id: String,
    control_turn: String,
    parent_native: Option<String>,
    chat_id: String,
    turn_id: String,
    generation: u64,
    native_turns: std::collections::BTreeMap<String,String>,
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
    meta.insert("nativeTurns".into(), json!(child.native_turns));
    meta.insert("controlId".into(),json!(child.control_id));
    meta.insert("controlTurnId".into(),json!(child.control_turn));
    if let Some(parent) = &child.parent_native {
        meta.insert("parentId".into(), json!(parent));
    }
    Value::Object(meta)
}

impl Engine {
    fn hydrate_subagent(&mut self, chat_id: &str) -> Result<(), HostError> {
        if self.native_children.contains_key(chat_id) { return Ok(()); }
        let doc = self.store.chat(chat_id).map_err(store_error)?.ok_or_else(not_found)?;
        let meta = &doc["nativeAgent"];
        let root_chat = id(meta,"rootChatId").ok_or_else(|| invalid("Esta conversa não é um subagente nativo."))?;
        let root_turn = id(meta,"rootTurnId").ok_or_else(|| invalid("Origem do subagente indisponível."))?;
        let native_id = id(meta,"id").ok_or_else(|| invalid("Subagente sem identificador nativo."))?;
        if native_chat(&root_chat,&native_id) != chat_id { return Err(invalid("Identidade do subagente inválida.")); }
        let root = self.store.chat(&root_chat).map_err(store_error)?.ok_or_else(not_found)?;
        if !root["turns"].as_array().is_some_and(|turns| turns.iter().any(|t|t["id"]==root_turn && t["role"]=="assistant")) {
            return Err(gone("A conversa de origem do subagente não está disponível."));
        }
        let parent_native=id(meta,"parentId");
        let parent_chat=parent_native.as_ref().map(|parent|native_chat(&root_chat,parent)).unwrap_or_else(||root_chat.clone());
        let parent_turn=parent_native.as_ref().and_then(|_|self.store.chat(&parent_chat).ok().flatten()).and_then(|c|id(&c["nativeAgent"],"turnId")).unwrap_or_else(||root_turn.clone());
        let turn_id=id(meta,"turnId").or_else(||doc["turns"].as_array().and_then(|turns|turns.iter().rev().find(|t|t["role"]=="assistant")).and_then(|turn|id(turn,"id"))).ok_or_else(||gone("Histórico do subagente indisponível."))?;
        let mut link=meta.as_object().cloned().unwrap_or_default();
        for field in ["rootChatId","rootTurnId","turnId","generation","parentId","nativeTurns","controlId","controlTurnId"] { link.remove(field); }
        link.insert("chatId".into(),json!(chat_id));
        let control_id=id(meta,"controlId").unwrap_or_else(||native_id.clone());
        let control_turn=id(meta,"controlTurnId").unwrap_or_else(||root_turn.clone());
        self.native_children.insert(chat_id.into(),Child {root_chat,root_turn,native_id,control_id,control_turn,parent_native,chat_id:chat_id.into(),turn_id,
            native_turns:serde_json::from_value(meta["nativeTurns"].clone()).unwrap_or_default(),
            generation:meta["generation"].as_u64().unwrap_or(0),parent_chat,parent_turn,selection:doc["selection"].clone(),link:Value::Object(link),_hold:None});
        Ok(())
    }

    pub(super) fn message_subagent(&mut self, value: Value, user: &UserInfo, reply: tokio::sync::oneshot::Sender<Result<Value, HostError>>) {
        self.flush();
        let prepared = (|| {
            let p: prism_protocol::chats::MessageSubagentParams = params(value)?;
            if p.text.trim().is_empty() { return Err(invalid("Digite uma mensagem para o subagente.")); }
            if p.text.len() > 200_000 { return Err(invalid("A mensagem para o subagente é muito longa.")); }
            self.hydrate_subagent(&p.chat_id)?;
            let child = self.native_children.get(&p.chat_id).ok_or_else(|| gone("Este subagente não está conectado ao host. Abra sua conversa principal."))?;
            if self.child_sending.contains(&p.chat_id) { return Err(busy("Aguarde a confirmação da mensagem anterior.")); }
            if self.runtime.get(&p.chat_id).is_some_and(|r| r.permission.is_some() || r.question.is_some()) {
                return Err(invalid("Responda à aprovação ou pergunta do subagente antes de enviar."));
            }
            let provider = child.selection["provider"].as_str().unwrap_or_default();
            let runner = self.runners.get(provider).ok_or_else(|| invalid("Provedor indisponível."))?;
            // Claude exposes SendMessage as a model tool rather than a control RPC.
            // An idle parent must visibly resume its own native session to deliver it.
            if provider == "claude" && !self.runs.contains_key(&child.root_chat) {
                let root_id = child.root_chat.clone();
                let turn_id = child.turn_id.clone();
                let target = child.link["messageTarget"].as_str().ok_or_else(|| invalid("Este subagente não anunciou um endereço de mensagem. Peça ao agente principal para retomá-lo."))?.to_string();
                let route = route_key(Some(&child.selection));
                let root = self.store.chat(&root_id).map_err(store_error)?.ok_or_else(not_found)?;
                if route_key(root.get("selection")) != route || root["resume"]["route"] != route || root["resume"]["sessionId"].as_str().is_none_or(str::is_empty) {
                    return Err(invalid("A sessão original do agente principal não está disponível. Continue na conversa principal."));
                }
                let prompt = prism_agents::claude::format_subagent_message(&target, p.text.trim()).map_err(|message| invalid(&message))?;
                let accepted = self.send(params(json!({"chatId":root_id,"text":prompt}))?, user)?;
                let future: crate::domains::chats::BoxFuture<Result<Value, String>> = Box::pin(async move { Ok(json!({"delivery":"parent", "rootTurnId":accepted["turnId"], "messageTarget":target, "parentJournaled":true})) });
                return Ok((p.chat_id, turn_id, p.text.trim().to_string(), future));
            }
            let future = runner.message_subagent(child.root_chat.clone(), child.control_turn.clone(), child.control_id.clone(), p.text.trim().into());
            Ok((p.chat_id, child.turn_id.clone(), p.text.trim().to_string(), future))
        })();
        match prepared {
            Err(error) => { let _ = reply.send(Err(error)); }
            Ok((chat_id, turn_id, text, future)) => {
                self.child_sending.insert(chat_id.clone());
                let tx = self.tx.clone();
                let actor = user.id.clone();
                let hold = self.activity.as_ref().map(|a| a.hold());
                self.handle.spawn(async move {
                    let result = tokio::time::timeout(std::time::Duration::from_secs(30), future).await
                        .unwrap_or_else(|_| Err("O provedor ainda não confirmou a mensagem. Confira o subagente antes de reenviar.".into()));
                    let _ = tx.send(Msg::SubagentMessaged { chat_id, turn_id, text, actor, result, reply });
                    drop(hold);
                });
            }
        }
    }

    pub(super) fn subagent_messaged(&mut self, chat_id: String, turn_id: String, text: String, actor: String,
        result: Result<Value, String>, reply: tokio::sync::oneshot::Sender<Result<Value, HostError>>) {
        self.child_sending.remove(&chat_id);
        let result = result.map_err(|message| invalid(&message)).and_then(|mut result| {
            let delivery = result["delivery"].as_str().ok_or_else(|| invalid("O provedor não confirmou o destino da mensagem."))?.to_string();
            if !matches!(delivery.as_str(), "direct" | "parent") { return Err(invalid("Destino de mensagem inválido.")); }
            if delivery == "parent" && result["parentJournaled"] != true
                && let (Some(child), Some(parent_turn), Some(target)) = (self.native_children.get(&chat_id), result["rootTurnId"].as_str(), result["messageTarget"].as_str())
            {
                let root_chat = child.root_chat.clone();
                let prompt = prism_agents::claude::format_subagent_message(target, &text).map_err(|message| invalid(&message))?;
                self.segment(&root_chat, parent_turn, json!({"kind":"user", "toolId":new_id(),"text":prompt,"sentAt":crate::now_ms()}), Some(&actor));
            }
            if let Some(fields) = result.as_object_mut() { fields.remove("parentJournaled"); }
            let current_turn = self.native_children.get(&chat_id).and_then(|child| {
                result["nativeTurnId"].as_str().and_then(|native|child.native_turns.get(native).cloned())
                    .or_else(|| if result["steered"]==true { Some(turn_id.clone()) } else { Some(child.turn_id.clone()) })
            }).unwrap_or(turn_id);
            if delivery == "direct" {
                self.segment(&chat_id, &current_turn, json!({"kind":"user","toolId":new_id(),"text":text,"sentAt":crate::now_ms()}), Some(&actor));
            }
            result["ok"] = json!(true);
            self.flush();
            Ok(result)
        });
        let _ = reply.send(result);
    }

    pub(super) fn respond_subagent_permission(&mut self, p: PermissionParams) -> Result<Value, HostError> {
        let child = self.native_children.get(&p.chat_id).ok_or_else(|| gone(PERMISSION_GONE))?;
        let runtime = self.runtime.get(&p.chat_id).ok_or_else(|| gone(PERMISSION_GONE))?;
        if runtime.permission.as_ref().and_then(|pending| pending["permId"].as_str()) != Some(p.perm_id.as_str()) {
            return Err(gone(PERMISSION_GONE));
        }
        let decision = match p.decision { PermissionDecision::Allow => "allow", PermissionDecision::AllowAlways => "allow_always", PermissionDecision::Deny => "deny" };
        let runner = self.runners.get(child.selection["provider"].as_str().unwrap_or_default()).ok_or_else(|| invalid("Provedor indisponível."))?;
        runner.permission(&child.root_chat, &child.control_turn, &p.perm_id, decision, p.updated_input);
        self.update_runtime(&p.chat_id, |rt| { if let Some(rt) = rt { rt.permission = None; } });
        ok()
    }

    pub(super) fn respond_subagent_question(&mut self, p: QuestionParams) -> Result<Value, HostError> {
        let child = self.native_children.get(&p.chat_id).ok_or_else(|| gone(QUESTION_GONE))?;
        let runtime = self.runtime.get(&p.chat_id).ok_or_else(|| gone(QUESTION_GONE))?;
        if runtime.question.as_ref().and_then(|pending| pending["dialogId"].as_str()) != Some(p.dialog_id.as_str()) {
            return Err(gone(QUESTION_GONE));
        }
        let answers = p.answers.map(|answers| answers.into_iter().map(|(question, choice)| (question, Value::String(choice))).collect::<Map<_, _>>());
        let runner = self.runners.get(child.selection["provider"].as_str().unwrap_or_default()).ok_or_else(|| invalid("Provedor indisponível."))?;
        runner.question(&child.root_chat, &child.control_turn, &p.dialog_id, answers, p.response);
        self.update_runtime(&p.chat_id, |rt| { if let Some(rt) = rt { rt.question = None; } });
        ok()
    }

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

    pub(super) fn subagent_event(&mut self, root_id: &str, origin: &str, mut agent: Value) {
        let Some(mut native_id) = id(&agent, "id") else {
            return;
        };
        let control_id=native_id.clone();
        let control_turn=origin.to_string();
        let incoming_key = native_chat(root_id,&native_id);
        let mut alias = self.child_aliases.get(&incoming_key).cloned();
        if alias.is_none() && !self.native_children.contains_key(&incoming_key)
            && let Some(target)=id(&agent,"messageTarget")
        {
            let known=self.store.chats().unwrap_or_default().into_iter().find(|c| c["nativeAgent"]["rootChatId"]==root_id && c["nativeAgent"]["messageTarget"]==target);
            if let Some(meta)=known.as_ref().map(|c|&c["nativeAgent"])
                && let (Some(canonical),Some(original))=(id(meta,"id"),id(meta,"rootTurnId"))
            {
                alias=Some((canonical,original));
                self.child_aliases.insert(incoming_key.clone(),alias.clone().unwrap());
            }
        }
        let mut effective_origin=origin.to_string();
        if let Some((canonical,original))=&alias { native_id=canonical.clone();agent["id"]=json!(canonical);effective_origin=original.clone(); }
        if let Some(parent)=id(&agent,"parentId") {
            let parent_alias=self.child_aliases.get(&native_chat(root_id,&parent)).cloned();
            let canonical=parent_alias.as_ref().map(|(id,_)|id.clone()).unwrap_or(parent);
            agent["parentId"]=json!(canonical);
            if alias.is_none() {
                let parent_origin=parent_alias.map(|(_,turn)|turn).or_else(||self.store.document(kinds::CHATS,&native_chat(root_id,&canonical)).ok().flatten().and_then(|doc|id(&doc["nativeAgent"],"rootTurnId")));
                if let Some(parent_origin)=parent_origin {
                    effective_origin=parent_origin;
                    self.child_aliases.insert(incoming_key,(native_id.clone(),effective_origin.clone()));
                }
            }
        }
        let origin=effective_origin.as_str();
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
                "messageTarget",
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
                control_id:control_id.clone(),
                control_turn:control_turn.clone(),
                parent_native,
                chat_id: chat_id.clone(),
                turn_id: turn_id.clone(),
                generation,
                native_turns:old_meta.and_then(|m|serde_json::from_value(m["nativeTurns"].clone()).ok()).unwrap_or_default(),
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
        child.control_id=control_id;
        child.control_turn=control_turn;
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
        for field in ["name", "description", "model", "summary", "spawnToolCallId", "messageTarget"] {
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
        if let Some(native_turn)=agent["nativeTurnId"].as_str() { child.native_turns.insert(native_turn.into(),child.turn_id.clone()); }
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
        let previous_runtime = self.runtime.get(&child.chat_id);
        let prompt = |key: &str, previous: Option<&Value>| {
            if !busy { None } else { agent.get(key).map(|value| value.is_object().then(|| value.clone())).unwrap_or_else(|| previous.cloned()) }
        };
        let runtime = ChatRuntime {
            turn_id: child.turn_id.clone(),
            route: route_key(Some(&child.selection)),
            busy,
            permission: prompt("permission", previous_runtime.and_then(|rt| rt.permission.as_ref())),
            question: prompt("question", previous_runtime.and_then(|rt| rt.question.as_ref())),
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
