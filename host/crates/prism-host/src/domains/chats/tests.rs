//! The engine driven directly: a fake provider, clients with a mirror that
//! applies the deltas the way `src/shared/chatDeltas.ts` does, and the store
//! as the reference (the mirror must equal the folded chat).

use std::collections::BTreeMap;
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};

use prism_protocol::{ErrorCode, HostError, Role, UserInfo};
use prism_store::Store;
use serde_json::{json, Map, Value};
use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot};

use super::engine::Engine;
use super::{BoxFuture, Msg, Runner, Runners, TurnEvent, TurnSink, TurnStart};
use crate::activity::Activity;
use crate::domain::{next_client_id, ClientId, Notifier};

/// A question answered: chat, dialog and the answers (`None` cancelled).
pub(super) type Answered = (String, String, Option<Map<String, Value>>);
pub(super) type Steered = (String, String, String, Vec<Value>);

#[derive(Default)]
pub(super) struct Fake {
    pub starts: Mutex<Vec<(TurnStart, TurnSink)>>,
    pub aborts: Mutex<Vec<(String, String)>>,
    pub permissions: Mutex<Vec<(String, String, String)>>,
    pub questions: Mutex<Vec<Answered>>,
    pub refuse: Mutex<Option<String>>,
    pub stall_start: std::sync::atomic::AtomicBool,
    pub panic_start: std::sync::atomic::AtomicBool,
    pub panic_constructor: std::sync::atomic::AtomicBool,
    pub steers: Mutex<Vec<Steered>>,
    pub child_messages: Mutex<Vec<(String, String, String, String)>>,
    pub child_reply: Mutex<Option<Result<Value, String>>>,
}

struct FakeRunner(Arc<Fake>);

impl Runner for FakeRunner {
    fn message_subagent(&self, root: String, turn: String, agent: String, text: String) -> BoxFuture<Result<Value, String>> {
        self.0.child_messages.lock().unwrap().push((root, turn, agent, text));
        let result = self.0.child_reply.lock().unwrap().clone().unwrap_or_else(|| Ok(json!({"delivery":"direct"})));
        Box::pin(async move { result })
    }
    fn start(&self, turn: TurnStart, sink: TurnSink) -> BoxFuture<Result<(), String>> {
        let refuse = self.0.refuse.lock().unwrap().clone();
        self.0.starts.lock().unwrap().push((turn, sink));
        assert!(!self.0.panic_constructor.load(std::sync::atomic::Ordering::SeqCst), "fixture: runner constructor failed");
        let stalled = self.0.stall_start.load(std::sync::atomic::Ordering::SeqCst);
        let panics = self.0.panic_start.load(std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move {
            if stalled { std::future::pending::<()>().await; }
            assert!(!panics, "fixture: provider launch failed");
            refuse.map_or(Ok(()), Err)
        })
    }

    fn steer(&self, chat_id: String, turn_id: String, text: String, images: Vec<Value>) -> BoxFuture<Result<(), String>> {
        self.0.steers.lock().unwrap().push((chat_id, turn_id, text, images));
        Box::pin(async { Ok(()) })
    }

    fn abort(&self, chat_id: &str, turn_id: &str) {
        self.0.aborts.lock().unwrap().push((chat_id.into(), turn_id.into()));
    }

    fn permission(&self, chat_id: &str, _turn_id: &str, perm_id: &str, decision: &str, _updated_input: Option<Value>) {
        self.0.permissions.lock().unwrap().push((chat_id.into(), perm_id.into(), decision.into()));
    }

    fn question(&self, chat_id: &str, _turn_id: &str, dialog_id: &str, answers: Option<Map<String, Value>>, _response: Option<String>) {
        self.0.questions.lock().unwrap().push((chat_id.into(), dialog_id.into(), answers));
    }
}

/// A client's view, built only from the snapshot and the deltas.
#[derive(Default)]
pub(super) struct Mirror {
    pub rev: u64,
    pub chats: Vec<Value>,
    pub runtime: BTreeMap<String, Value>,
}

fn same_id(value: &Value, id: &str) -> bool {
    value.get("id").and_then(Value::as_str) == Some(id)
}

impl Mirror {
    fn chat(&mut self, id: &str) -> Option<&mut Value> {
        self.chats.iter_mut().find(|c| same_id(c, id))
    }

    fn turn(&mut self, chat: &str, turn: &str) -> Option<&mut Value> {
        self.chat(chat)?.get_mut("turns")?.as_array_mut()?.iter_mut().find(|t| same_id(t, turn))
    }

    pub fn apply(&mut self, batch: &Value) {
        let deltas = batch["deltas"].as_array().unwrap();
        let rev = batch["rev"].as_u64().unwrap();
        assert_eq!(rev - deltas.len() as u64, self.rev, "batches are contiguous");
        for d in deltas {
            let chat_id = d.get("chatId").and_then(Value::as_str).unwrap_or_default().to_string();
            match d["op"].as_str().unwrap() {
                "chat" => {
                    let id = d["chat"]["id"].as_str().unwrap().to_string();
                    match self.chat(&id) {
                        Some(slot) => *slot = d["chat"].clone(),
                        None => self.chats.push(d["chat"].clone()),
                    }
                }
                "remove" => {
                    self.chats.retain(|c| !same_id(c, &chat_id));
                    self.runtime.remove(&chat_id);
                }
                "patch" => {
                    let chat = self.chat(&chat_id).unwrap().as_object_mut().unwrap();
                    for (field, value) in d["patch"].as_object().unwrap() {
                        if value.is_null() {
                            chat.remove(field);
                        } else {
                            chat.insert(field.clone(), value.clone());
                        }
                    }
                }
                "turn" => {
                    let turn = d["turn"].clone();
                    let turns = self.chat(&chat_id).unwrap()["turns"].as_array_mut().unwrap();
                    match turns.iter_mut().find(|t| same_id(t, turn["id"].as_str().unwrap())) {
                        Some(slot) => *slot = turn,
                        None => turns.push(turn),
                    }
                }
                "append" => {
                    let (kind, text) = (d["kind"].as_str().unwrap(), d["text"].as_str().unwrap());
                    let turn = self.turn(&chat_id, d["turnId"].as_str().unwrap()).unwrap();
                    let segments = turn.as_object_mut().unwrap().entry("segments").or_insert(json!([])).as_array_mut().unwrap();
                    match segments.last_mut().filter(|s| s["kind"] == kind) {
                        Some(last) => last["text"] = Value::String(format!("{}{text}", last["text"].as_str().unwrap_or_default())),
                        None => segments.push(json!({ "kind": kind, "text": text })),
                    }
                }
                "segment" => {
                    let segment = d["segment"].clone();
                    let turn = self.turn(&chat_id, d["turnId"].as_str().unwrap()).unwrap();
                    let segments = turn.as_object_mut().unwrap().entry("segments").or_insert(json!([])).as_array_mut().unwrap();
                    let id = segment.get("toolId").filter(|v| v.as_str().is_some_and(|s| !s.is_empty())).cloned();
                    match id.and_then(|id| segments.iter_mut().find(|s| s.get("toolId") == Some(&id))) {
                        Some(slot) => *slot = segment,
                        None => segments.push(segment),
                    }
                }
                "metrics" => {
                    let turn = self.turn(&chat_id, d["turnId"].as_str().unwrap()).unwrap().as_object_mut().unwrap();
                    let metrics = turn.entry("metrics").or_insert(json!({})).as_object_mut().unwrap();
                    for (field, value) in d["metrics"].as_object().unwrap() {
                        metrics.insert(field.clone(), value.clone());
                    }
                }
                "runtime" => match d.get("runtime").filter(|r| !r.is_null()) {
                    Some(runtime) => {
                        self.runtime.insert(chat_id, runtime.clone());
                    }
                    None => {
                        self.runtime.remove(&chat_id);
                    }
                },
                other => panic!("delta desconhecido: {other}"),
            }
        }
        self.rev = rev;
    }
}

pub(super) struct Client {
    pub id: ClientId,
    notifier: Notifier,
    notes: mpsc::UnboundedReceiver<String>,
    pub mirror: Mirror,
}

impl Client {
    /// Applies every `chats.delta` received so far.
    pub fn sync(&mut self) {
        while let Ok(text) = self.notes.try_recv() {
            let note: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(note["method"], "chats.delta");
            self.mirror.apply(&note["params"]);
        }
    }

    pub fn chat(&self, id: &str) -> Value {
        self.mirror.chats.iter().find(|c| same_id(c, id)).cloned().unwrap()
    }
}

pub(super) struct Harness {
    pub engine: Engine,
    rx: Receiver<Msg>,
    pub fake: Arc<Fake>,
    pub store: Arc<Store>,
    pub activity: Arc<Activity>,
}

pub(super) fn owner() -> UserInfo {
    UserInfo { id: "owner".into(), name: "qa".into(), role: Role::Owner }
}

impl Harness {
    pub fn new() -> Self {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let fake = Arc::new(Fake::default());
        let runner: Arc<dyn Runner> = Arc::new(FakeRunner(Arc::clone(&fake)));
        let (tx, rx) = channel();
        let engine = Engine::new(Arc::clone(&store), Runners { claude: Some(Arc::clone(&runner)), codex: Some(runner) }, Handle::current(), tx);
        Self { engine, rx, fake, store, activity: Activity::new() }
    }

    pub fn client(&self) -> Client {
        let (tx, notes) = mpsc::unbounded_channel();
        let id = next_client_id();
        Client { id, notifier: Notifier::new(id, tx), notes, mirror: Mirror::default() }
    }

    pub fn call(&mut self, client: &Client, method: &str, params: Value) -> Result<Value, HostError> {
        let (reply, mut answer) = oneshot::channel();
        self.engine.handle(Msg::Call {
            method: method.into(),
            params,
            user: owner(),
            client: client.id,
            notifier: client.notifier.clone(),
            activity: Arc::clone(&self.activity),
            reply,
        });
        answer.try_recv().expect("the engine answers every call at once")
    }

    /// Subscribes `client`, its mirror starting from the snapshot.
    pub fn subscribe(&mut self, client: &mut Client) {
        let snapshot = self.call(client, "subscribe", json!({})).unwrap();
        client.mirror = Mirror {
            rev: snapshot["rev"].as_u64().unwrap(),
            chats: snapshot["chats"].as_array().unwrap().clone(),
            runtime: snapshot["runtime"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        };
    }

    /// Lets the providers' tasks run, delivers what they sent and flushes.
    pub async fn settle(&mut self) {
        for _ in 0..4 {
            tokio::task::yield_now().await;
        }
        while let Ok(msg) = self.rx.try_recv() {
            self.engine.handle(msg);
        }
        self.engine.flush();
    }

    /// The provider of the `index`-th started turn reports `event`.
    pub async fn emit(&mut self, index: usize, event: TurnEvent) {
        let sink = self.fake.starts.lock().unwrap()[index].1.clone();
        sink.send(event);
        self.settle().await;
    }

    pub fn stored(&self, id: &str) -> Value {
        self.store.chat(id).unwrap().unwrap()
    }
}

pub(super) fn new_chat(id: &str, provider: &str) -> Value {
    json!({
        "id": id, "title": "Novo chat", "cwd": "C:/repo", "createdAt": 1, "updatedAt": 1, "turns": [],
        "selection": { "provider": provider, "profileId": format!("ambient-{provider}"), "model": "haiku", "effort": "low", "permissionMode": "default" }
    })
}

fn code(result: Result<Value, HostError>) -> ErrorCode {
    result.unwrap_err().code
}

#[tokio::test]
async fn a_turn_streams_to_subscribers_and_ends_as_the_store_folds_it() {
    let mut h = Harness::new();
    let mut ui = h.client();
    h.subscribe(&mut ui);
    h.call(&ui, "create", json!({ "chat": new_chat("c1", "claude") })).unwrap();
    let sent = h.call(&ui, "send", json!({ "chatId": "c1", "text": "  Liste os arquivos  ", "serviceTier": "", "profileName": "Terminal" })).unwrap();
    let turn = sent["turnId"].as_str().unwrap().to_string();
    h.settle().await;
    ui.sync();
    assert_eq!(h.activity.holds(), 1, "a running turn keeps the host alive");
    let started = h.fake.starts.lock().unwrap()[0].0.clone();
    assert_eq!((started.prompt.as_str(), started.resume.as_deref(), started.service_tier.as_deref()), ("  Liste os arquivos  ", None, None));
    let chat = ui.chat("c1");
    assert_eq!(chat["title"], "Liste os arquivos");
    assert_eq!(chat["pendingTurnId"], turn.as_str());
    assert_eq!(chat["turns"][1]["profileName"], "Terminal");
    assert_eq!(ui.mirror.runtime["c1"]["busy"], true);

    h.emit(0, TurnEvent::Session("s1".into())).await;
    h.emit(0, TurnEvent::Thinking("hmm".into())).await;
    h.emit(0, TurnEvent::Text("Vou ".into())).await;
    h.emit(0, TurnEvent::Text("listar.".into())).await;
    h.emit(0, TurnEvent::Tool { tool_id: "t1".into(), name: json!("Bash"), input: Some(json!({ "command": "ls" })) }).await;
    h.emit(0, TurnEvent::Permission(json!({ "id": turn, "permId": "perm1", "toolName": "Bash", "toolUseId": "t1" }))).await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["c1"]["permission"]["permId"], "perm1");
    assert_eq!(ui.chat("c1")["turns"][1]["segments"][2]["status"], "awaiting");

    h.call(&ui, "respondPermission", json!({ "chatId": "c1", "permId": "perm1", "decision": "allow" })).unwrap();
    assert_eq!(code(h.call(&ui, "respondPermission", json!({ "chatId": "c1", "permId": "perm1", "decision": "allow" }))), ErrorCode::Gone);
    assert_eq!(h.fake.permissions.lock().unwrap().as_slice(), &[("c1".to_string(), "perm1".to_string(), "allow".to_string())]);
    h.emit(0, TurnEvent::ToolResult { tool_id: "t1".into(), content: Some(json!("a.txt")), is_error: false }).await;
    h.emit(0, TurnEvent::Text(" Pronto.".into())).await;
    h.emit(0, TurnEvent::Metrics(json!({ "scope": "session", "inputTokens": 10 }))).await;
    h.emit(0, TurnEvent::Done { aborted: false }).await;
    ui.sync();

    assert_eq!(h.activity.holds(), 0);
    assert_eq!(ui.mirror.runtime["c1"]["busy"], false);
    assert!(ui.mirror.runtime["c1"].get("permission").is_none());
    let mirror = ui.chat("c1");
    assert_eq!(mirror, h.stored("c1"), "the deltas rebuild exactly the folded chat");
    assert_eq!(mirror["resume"], json!({ "route": "claude:ambient-claude", "sessionId": "s1" }));
    let segments = &mirror["turns"][1]["segments"];
    assert_eq!(segments[1]["text"], "Vou listar.");
    assert_eq!(segments[2]["status"], "done");
    assert_eq!(segments[2]["result"], "a.txt");
    assert!(mirror.get("pendingTurnId").is_none());
    assert!(mirror["turns"][1]["completedAt"].is_number());
}

#[tokio::test]
async fn native_children_have_linked_readonly_conversations_and_outlive_their_root_turn() {
    let (mut h, mut ui, first_turn) = Harness::running("codex").await;
    h.emit(0,TurnEvent::Subagent(json!({"id":"reviewer","name":"Ada","description":"Revisar arquivos","model":"child-model","status":"running","spawnToolCallId":"spawn-1"}))).await;
    ui.sync();
    let child_id="subagent:c1:reviewer";
    let child=ui.chat(child_id);
    assert_eq!(child["parentChatId"],"c1");
    assert_eq!(child["parentId"],"c1");assert_eq!(child["readOnly"],true);
    assert_eq!(child["nativeAgent"]["rootTurnId"],first_turn);
    assert_eq!(child["selection"]["model"],"child-model");
    assert_eq!(child["turns"][0]["model"],"child-model");
    assert_eq!(ui.mirror.runtime[child_id]["busy"],true);
    assert_eq!(h.activity.holds(),2,"root and native child each keep the host alive");
    h.emit(0,TurnEvent::Subagent(json!({"id":"reviewer","segment":{"kind":"text","toolId":"answer","text":"Análise do subagente"}}))).await;
    h.emit(0,TurnEvent::Subagent(json!({"id":"reviewer","segment":{"kind":"tool","toolId":"check","name":"Bash","input":{"command":"npm test"},"status":"running","result":""}}))).await;
    h.emit(0,TurnEvent::Done{aborted:false}).await;
    ui.sync();
    assert_eq!(h.activity.holds(),1,"a background child survives its root Done");
    assert_eq!(ui.chat("c1")["turns"][1]["segments"][0]["subagent"]["status"],"running");
    assert_eq!(ui.chat("c1")["turns"][1]["segments"][0]["status"],"running");
    assert!(!ui.chat("c1")["turns"][1]["segments"].as_array().unwrap().iter().any(|s|s["text"]=="Análise do subagente"));
    assert_eq!(ui.chat(child_id)["turns"][0]["segments"][0]["text"],"Análise do subagente");
    assert_eq!(code(h.call(&ui,"remove",json!({"chatId":"c1"}))),ErrorCode::Busy,"deleting the root cannot strand a running native child");
    let second_turn=h.send(&ui,"c1","Outra mensagem enquanto Ada trabalha");h.settle().await;
    assert_eq!(h.activity.holds(),2);
    h.emit(0,TurnEvent::Subagent(json!({"id":"reviewer","status":"completed","summary":"Revisão terminada"}))).await;
    ui.sync();
    assert_eq!(h.activity.holds(),1);
    assert_eq!(ui.mirror.runtime["c1"]["turnId"],second_turn);
    assert_eq!(ui.mirror.runtime["c1"]["busy"],true,"late child completion cannot finish the next root turn");
    assert_eq!(ui.mirror.runtime[child_id]["busy"],false);
    assert_eq!(ui.chat("c1")["turns"][1]["segments"][0]["subagent"]["status"],"completed");
    assert!(ui.chat("c1")["turns"][3]["segments"].as_array().unwrap().is_empty());
    assert_eq!(code(h.call(&ui,"send",json!({"chatId":child_id,"text":"Não iniciar outro runner"}))),ErrorCode::Invalid);
    assert_eq!(h.fake.starts.lock().unwrap().len(),2);
    assert_eq!(ui.chat("c1"),h.stored("c1"));
    assert_eq!(ui.chat(child_id),h.stored(child_id));
    h.emit(1,TurnEvent::Done{aborted:false}).await;
    assert_eq!(h.activity.holds(),0);
}

async fn message_child(h: &mut Harness, ui: &Client, chat: &str, text: &str) -> Result<Value, HostError> {
    let (reply, answer) = oneshot::channel();
    h.engine.handle(Msg::Call { method: "messageSubagent".into(), params: json!({"chatId":chat,"text":text}),
        user:owner(),client:ui.id,notifier:ui.notifier.clone(),activity:Arc::clone(&h.activity),reply });
    h.settle().await;
    answer.await.unwrap()
}

#[tokio::test]
async fn native_child_messages_use_the_original_session_without_starting_or_interrupting_the_parent() {
    let (mut h, mut ui, origin) = Harness::running("codex").await;
    h.emit(0,TurnEvent::Subagent(json!({"id":"review","status":"running"}))).await;
    h.emit(0,TurnEvent::Done{aborted:false}).await;
    h.call(&ui,"send",json!({"chatId":"c1","text":"second parent turn"})).unwrap();
    h.settle().await;
    let before = h.stored("c1");
    let reply = message_child(&mut h,&ui,"subagent:c1:review","focus on tests").await.unwrap();
    assert_eq!(reply["delivery"],"direct");
    assert_eq!(h.fake.child_messages.lock().unwrap()[0],("c1".into(),origin,"review".into(),"focus on tests".into()));
    assert_eq!(h.fake.starts.lock().unwrap().len(),2);
    assert!(h.fake.aborts.lock().unwrap().is_empty());
    assert_eq!(h.stored("c1"),before);
    ui.sync();
    let child = h.stored("subagent:c1:review");
    assert_eq!(child["readOnly"],true,"a child cannot start an independent runner");
    assert!(child["turns"][0]["segments"].as_array().unwrap().iter().any(|s|s["kind"]=="user"&&s["text"]=="focus on tests"));
    assert_eq!(ui.chat("subagent:c1:review"),child);
}

#[tokio::test]
async fn refused_native_child_messages_do_not_append_fake_user_messages_and_can_be_retried() {
    let (mut h, ui, _) = Harness::running("codex").await;
    h.emit(0,TurnEvent::Subagent(json!({"id":"review","status":"completed"}))).await;
    *h.fake.child_reply.lock().unwrap()=Some(Err("thread unavailable".into()));
    let before=h.stored("subagent:c1:review");
    assert!(message_child(&mut h,&ui,"subagent:c1:review","keep this draft").await.is_err());
    assert_eq!(h.stored("subagent:c1:review"),before);
    assert!(message_child(&mut h,&ui,"c1","do not impersonate a child").await.is_err());
    *h.fake.child_reply.lock().unwrap()=None;
    assert!(message_child(&mut h,&ui,"subagent:c1:review","retry").await.is_ok());
}

#[tokio::test]
async fn native_child_prompts_remain_answerable_after_parent_finishes() {
    let (mut h, mut ui, _) = Harness::running("codex").await;
    h.emit(0,TurnEvent::Subagent(json!({"id":"review","status":"waiting","permission":{"permId":"child-perm","toolName":"Bash"}}))).await;
    h.emit(0,TurnEvent::Done{aborted:false}).await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["subagent:c1:review"]["permission"]["permId"],"child-perm");
    h.call(&ui,"respondPermission",json!({"chatId":"subagent:c1:review","permId":"child-perm","decision":"allow"})).unwrap();
    assert_eq!(h.fake.permissions.lock().unwrap()[0],("c1".into(),"child-perm".into(),"allow".into()));
    h.emit(0,TurnEvent::Subagent(json!({"id":"review","status":"waiting","question":{"dialogId":"child-question","questions":[]}}))).await;
    h.call(&ui,"respondQuestion",json!({"chatId":"subagent:c1:review","dialogId":"child-question","answers":{"Q":"A"}})).unwrap();
    assert_eq!(h.fake.questions.lock().unwrap()[0].0,"c1");
    assert_eq!(h.fake.questions.lock().unwrap()[0].1,"child-question");
    ui.sync();
    assert!(ui.mirror.runtime["subagent:c1:review"].get("question").is_none());
    assert!(ui.mirror.runtime["subagent:c1:review"].get("permission").is_none());
}

#[tokio::test]
async fn claude_child_messages_resume_the_same_idle_parent_with_an_explicit_native_inbox_target() {
    let (mut h, ui, _) = Harness::running("claude").await;
    h.emit(0,TurnEvent::Session("native-parent-session".into())).await;
    h.emit(0,TurnEvent::Subagent(json!({"id":"spawn","messageTarget":"native-child","status":"completed"}))).await;
    h.emit(0,TurnEvent::Done{aborted:false}).await;
    let reply=message_child(&mut h,&ui,"subagent:c1:spawn","review these changes").await.unwrap();
    assert_eq!(reply["delivery"],"parent");
    let starts=h.fake.starts.lock().unwrap();
    assert_eq!(starts.len(),2);
    assert_eq!(starts[1].0.chat_id,"c1");
    assert_eq!(starts[1].0.resume.as_deref(),Some("native-parent-session"));
    assert!(starts[1].0.prompt.contains("native-child"));
    assert!(starts[1].0.prompt.contains("review these changes"));
    assert!(starts[1].0.prompt.contains("SendMessage"));
    assert!(h.fake.child_messages.lock().unwrap().is_empty());
}

#[tokio::test]
async fn child_message_ack_cannot_move_a_steered_message_into_the_next_native_generation() {
    let (mut h, ui, origin)=Harness::running("codex").await;
    h.emit(0,TurnEvent::Subagent(json!({"id":"a","status":"running","nativeTurnId":"first-native"}))).await;
    let first=h.stored("subagent:c1:a")["nativeAgent"]["turnId"].clone();
    *h.fake.child_reply.lock().unwrap()=Some(Ok(json!({"delivery":"direct","steered":true,"nativeTurnId":"first-native"})));
    let (reply,answer)=oneshot::channel();
    h.engine.handle(Msg::Call{method:"messageSubagent".into(),params:json!({"chatId":"subagent:c1:a","text":"belongs to first"}),user:owner(),client:ui.id,notifier:ui.notifier.clone(),activity:Arc::clone(&h.activity),reply});
    h.engine.handle(Msg::Turn{chat_id:"c1".into(),turn_id:origin.clone(),event:TurnEvent::Subagent(json!({"id":"a","status":"completed"}))});
    h.engine.handle(Msg::Turn{chat_id:"c1".into(),turn_id:origin,event:TurnEvent::Subagent(json!({"id":"a","status":"running","nativeTurnId":"second-native"}))});
    h.settle().await;
    assert!(answer.await.unwrap().is_ok());
    let child=h.stored("subagent:c1:a");
    assert_ne!(child["nativeAgent"]["turnId"],first);
    assert!(child["turns"][0]["segments"].as_array().unwrap().iter().any(|s|s["text"]=="belongs to first"));
    assert!(!child["turns"][1]["segments"].as_array().unwrap().iter().any(|s|s["kind"]=="user"));
}

#[tokio::test]
async fn resumed_claude_inbox_reuses_persisted_child_identity_after_the_host_restarts() {
    let (mut h, ui, origin)=Harness::running("claude").await;
    h.emit(0,TurnEvent::Session("original-session".into())).await;
    h.emit(0,TurnEvent::Subagent(json!({"id":"original-spawn","messageTarget":"native-inbox","status":"completed"}))).await;
    h.emit(0,TurnEvent::Done{aborted:false}).await;
    let runner:Arc<dyn Runner>=Arc::new(FakeRunner(Arc::clone(&h.fake)));
    let(tx,rx)=channel();
    h.engine=Engine::new(Arc::clone(&h.store),Runners{claude:Some(runner),codex:None},Handle::current(),tx);
    h.rx=rx;
    assert_eq!(message_child(&mut h,&ui,"subagent:c1:original-spawn","resume this inbox").await.unwrap()["delivery"],"parent");
    h.emit(1,TurnEvent::Subagent(json!({"id":"new-send-tool","messageTarget":"native-inbox","status":"running","text":"continued child"}))).await;
    let child=h.stored("subagent:c1:original-spawn");
    assert_eq!(child["nativeAgent"]["rootTurnId"],origin);
    assert_eq!(child["turns"].as_array().unwrap().len(),2);
    assert!(h.store.chat("subagent:c1:new-send-tool").unwrap().is_none());
    let transport_origin=h.fake.starts.lock().unwrap()[1].0.turn_id.clone();
    assert_eq!(child["nativeAgent"]["controlId"],"new-send-tool");
    assert_eq!(child["nativeAgent"]["controlTurnId"],transport_origin);
    message_child(&mut h,&ui,"subagent:c1:original-spawn","another message").await.unwrap();
    let routed=h.fake.child_messages.lock().unwrap()[0].clone();
    assert_eq!(routed.1,transport_origin);
    assert_eq!(routed.2,"new-send-tool");
    h.emit(1,TurnEvent::Subagent(json!({"id":"grandchild","parentId":"new-send-tool","status":"running","text":"nested resumed output"}))).await;
    let grandchild=h.stored("subagent:c1:grandchild");
    assert_eq!(grandchild["parentChatId"],"subagent:c1:original-spawn");
    assert_eq!(grandchild["nativeAgent"]["rootTurnId"],origin);
}

#[tokio::test]
async fn native_children_preserve_nested_parent_links_reject_unknown_origins_and_restore_as_stopped() {
    let (mut h,mut ui,root_turn)=Harness::running("claude").await;
    h.emit(0,TurnEvent::Subagent(json!({"id":"first","name":"Pesquisa","status":"running"}))).await;
    h.emit(0,TurnEvent::Subagent(json!({"id":"nested","parentId":"first","name":"Testes","status":"waiting","thinking":"Conferindo os casos"}))).await;
    let sink=h.fake.starts.lock().unwrap()[0].1.clone();
    sink.send_to_turn("nonexistent",TurnEvent::Subagent(json!({"id":"intruder","status":"running"})));
    h.emit(0,TurnEvent::Subagent(json!({"id":"cycle","parentId":"cycle","status":"running"}))).await;
    h.emit(0,TurnEvent::Subagent(json!({"id":"orphan","parentId":"unknown","status":"running"}))).await;
    ui.sync();
    let first="subagent:c1:first";let nested="subagent:c1:nested";
    assert_eq!(ui.chat(nested)["parentId"],first);
    assert_eq!(ui.chat(nested)["parentChatId"],first);
    assert_eq!(ui.chat(nested)["nativeAgent"]["parentId"],"first");
    assert_eq!(ui.chat(first)["turns"][0]["segments"][0]["subagent"]["chatId"],nested);
    assert_eq!(h.activity.holds(),3);
    assert!(h.store.chat("subagent:c1:intruder").unwrap().is_none());
    assert!(h.store.chat("subagent:c1:cycle").unwrap().is_none());
    assert!(h.store.chat("subagent:c1:orphan").unwrap().is_none());
    h.emit(0,TurnEvent::Done{aborted:false}).await;
    assert_eq!(h.activity.holds(),2);
    let (tx,_rx)=channel();
    h.engine=Engine::new(Arc::clone(&h.store),Runners::default(),Handle::current(),tx);
    assert_eq!(h.activity.holds(),0,"old native session holds are dropped with the engine");
    let mut reopened=h.client();h.subscribe(&mut reopened);
    assert_eq!(reopened.chat(first)["nativeAgent"]["status"],"stopped");
    assert_eq!(reopened.chat(nested)["nativeAgent"]["status"],"stopped");
    assert_eq!(reopened.mirror.runtime[first]["busy"],false);
    assert_eq!(reopened.chat("c1")["turns"][1]["segments"][0]["subagent"]["status"],"stopped");
    assert_eq!(reopened.chat("c1")["turns"][1]["id"],root_turn);
    assert_eq!(reopened.chat(nested)["turns"][0]["segments"][0]["text"],"Conferindo os casos");
    assert_eq!(reopened.chat(first),h.stored(first));
    assert_eq!(reopened.chat(nested),h.stored(nested));
}

#[tokio::test]
async fn resuming_a_native_child_adds_a_turn_and_preserves_its_previous_output() {
    let (mut h,mut ui,_)=Harness::running("codex").await;
    let child="subagent:c1:resume";
    h.emit(0,TurnEvent::Subagent(json!({"id":"resume","status":"running","text":"Primeira análise"}))).await;
    h.emit(0,TurnEvent::Subagent(json!({"id":"resume","status":"completed"}))).await;
    h.emit(0,TurnEvent::Done{aborted:false}).await;
    assert_eq!(h.activity.holds(),0);
    h.emit(0,TurnEvent::Subagent(json!({"id":"resume","status":"running"}))).await;
    h.emit(0,TurnEvent::Subagent(json!({"id":"resume","text":"Segunda análise"}))).await;
    h.emit(0,TurnEvent::Subagent(json!({"id":"resume","status":"completed","summary":"Resultado final completo"}))).await;
    ui.sync();
    let chat=ui.chat(child);
    assert_eq!(chat["turns"].as_array().unwrap().len(),2);
    assert_eq!(chat["turns"][0]["segments"][0]["text"],"Primeira análise");
    assert_eq!(chat["turns"][1]["segments"][0]["text"],"Segunda análise");
    assert_eq!(chat["turns"][1]["segments"][1]["text"],"Resultado final completo");
    assert_ne!(chat["turns"][0]["id"],chat["turns"][1]["id"]);
    assert_eq!(chat,h.stored(child));
    assert_eq!(h.activity.holds(),0);
}

#[tokio::test]
async fn a_turn_outlives_its_window_and_a_new_one_catches_up() {
    let mut h = Harness::new();
    let mut first = h.client();
    h.subscribe(&mut first);
    h.call(&first, "create", json!({ "chat": new_chat("c1", "codex") })).unwrap();
    h.call(&first, "send", json!({ "chatId": "c1", "text": "oi" })).unwrap();
    h.settle().await;
    h.emit(0, TurnEvent::Segment(json!({ "kind": "text", "toolId": "m1", "text": "Olá" }))).await;
    // The window closes: nothing stops.
    h.engine.handle(Msg::Disconnected(first.id));
    h.emit(0, TurnEvent::Segment(json!({ "kind": "text", "toolId": "m1", "text": "Olá, tudo" }))).await;
    assert!(h.fake.aborts.lock().unwrap().is_empty());

    let mut second = h.client();
    h.subscribe(&mut second);
    assert_eq!(second.mirror.runtime["c1"]["busy"], true, "the snapshot shows the turn still running");
    assert_eq!(second.chat("c1")["turns"][1]["segments"][0]["text"], "Olá, tudo");
    h.emit(0, TurnEvent::Segment(json!({ "kind": "text", "toolId": "m1", "text": "Olá, tudo bem?" }))).await;
    h.emit(0, TurnEvent::Done { aborted: false }).await;
    second.sync();
    assert_eq!(second.chat("c1"), h.stored("c1"));
    assert_eq!(second.chat("c1")["turns"][1]["segments"][0]["text"], "Olá, tudo bem?");
    first.sync();
    assert_eq!(first.mirror.runtime["c1"]["busy"], true, "a client that left hears nothing more");
}

#[tokio::test]
async fn refusals_answer_with_stable_codes_and_end_the_turn() {
    let mut h = Harness::new();
    let mut ui = h.client();
    h.subscribe(&mut ui);
    h.call(&ui, "create", json!({ "chat": new_chat("c1", "codex") })).unwrap();
    assert_eq!(code(h.call(&ui, "create", json!({ "chat": new_chat("c1", "codex") }))), ErrorCode::Invalid);
    assert_eq!(code(h.call(&ui, "send", json!({ "chatId": "nope", "text": "oi" }))), ErrorCode::NotFound);
    assert_eq!(code(h.call(&ui, "send", json!({ "chatId": "c1", "text": "   " }))), ErrorCode::Invalid);

    *h.fake.refuse.lock().unwrap() = Some("Instale o Codex para usar esta conta.".into());
    h.call(&ui, "send", json!({ "chatId": "c1", "text": "oi" })).unwrap();
    assert_eq!(code(h.call(&ui, "send", json!({ "chatId": "c1", "text": "de novo" }))), ErrorCode::Busy);
    assert_eq!(code(h.call(&ui, "remove", json!({ "chatId": "c1" }))), ErrorCode::Busy);
    h.settle().await;
    ui.sync();
    let turn = &ui.chat("c1")["turns"][1];
    assert_eq!(turn["error"], true);
    assert_eq!(turn["segments"][0]["text"], "Instale o Codex para usar esta conta.");
    assert_eq!(ui.mirror.runtime["c1"]["busy"], false);
    assert_eq!(ui.chat("c1"), h.stored("c1"));
    assert_eq!(h.activity.holds(), 0);
}

// ---- scenarios of the commands, the prompts and the journal ----

impl Harness {
    /// The provider of the `index`-th started turn reports `events` together:
    /// the engine handles them all before it flushes once.
    async fn emit_all(&mut self, index: usize, events: Vec<TurnEvent>) {
        let sink = self.fake.starts.lock().unwrap()[index].1.clone();
        for event in events {
            sink.send(event);
        }
        self.settle().await;
    }

    fn send(&mut self, ui: &Client, chat: &str, text: &str) -> String {
        self.call(ui, "send", json!({ "chatId": chat, "text": text })).unwrap()["turnId"].as_str().unwrap().to_string()
    }

    fn started(&self, index: usize) -> TurnStart {
        self.fake.starts.lock().unwrap()[index].0.clone()
    }

    /// One subscribed client and chat `c1` with a turn running (settled).
    async fn running(provider: &str) -> (Harness, Client, String) {
        let mut h = Harness::new();
        let mut ui = h.client();
        h.subscribe(&mut ui);
        h.call(&ui, "create", json!({ "chat": new_chat("c1", provider) })).unwrap();
        let turn = h.send(&ui, "c1", "oi");
        h.settle().await;
        ui.sync();
        (h, ui, turn)
    }

    /// The `index`-th turn ends.
    async fn finish(&mut self, ui: &mut Client, index: usize) {
        self.emit(index, TurnEvent::Done { aborted: false }).await;
        ui.sync();
    }
}

/// The mirror equals the folded chat.
fn assert_same(h: &Harness, ui: &mut Client, id: &str) {
    ui.sync();
    assert_eq!(ui.chat(id), h.stored(id), "the mirror must equal the folded chat");
}

fn with(mut chat: Value, fields: Value) -> Value {
    for (k, v) in fields.as_object().unwrap() {
        chat[k] = v.clone();
    }
    chat
}

fn user_turn() -> Value {
    json!({ "id": "u0", "role": "user", "text": "antes" })
}

#[tokio::test]
async fn questions_go_to_the_runtime_and_are_answered_once() {
    let (mut h, mut ui, turn) = Harness::running("claude").await;
    h.emit(0, TurnEvent::Question(json!({ "id": turn, "dialogId": "d1", "questions": [{ "question": "Qual?" }] }))).await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["c1"]["question"]["dialogId"], "d1");

    h.call(&ui, "respondQuestion", json!({ "chatId": "c1", "dialogId": "d1", "answers": { "Qual?": "A" } })).unwrap();
    assert_eq!(code(h.call(&ui, "respondQuestion", json!({ "chatId": "c1", "dialogId": "d1", "answers": {} }))), ErrorCode::Gone);
    ui.sync();
    assert!(ui.mirror.runtime["c1"].get("question").is_none(), "answering clears the question");
    {
        let answered = h.fake.questions.lock().unwrap();
        let answers: Map<String, Value> = [("Qual?".to_string(), json!("A"))].into_iter().collect();
        assert_eq!(answered.as_slice(), &[("c1".to_string(), "d1".to_string(), Some(answers))]);
    }

    // No `answers` cancels.
    h.emit(0, TurnEvent::Question(json!({ "id": turn, "dialogId": "d2" }))).await;
    h.call(&ui, "respondQuestion", json!({ "chatId": "c1", "dialogId": "d2" })).unwrap();
    assert_eq!(h.fake.questions.lock().unwrap()[1], ("c1".to_string(), "d2".to_string(), None));
    assert_eq!(code(h.call(&ui, "respondQuestion", json!({ "chatId": "c1", "dialogId": "nope" }))), ErrorCode::Gone);
    assert_eq!(code(h.call(&ui, "respondQuestion", json!({ "chatId": "other", "dialogId": "d2" }))), ErrorCode::Gone);
    h.finish(&mut ui, 0).await;
    assert_same(&h, &mut ui, "c1");
}

#[tokio::test]
async fn pending_permissions_queue_oldest_first_and_deny_marks_the_segment() {
    let (mut h, mut ui, turn) = Harness::running("claude").await;
    for tool in ["t1", "t2", "t3"] {
        h.emit(0, TurnEvent::Tool { tool_id: tool.into(), name: json!("Bash"), input: None }).await;
        h.emit(0, TurnEvent::Permission(json!({ "id": turn, "permId": format!("p-{tool}"), "toolName": "Bash", "toolUseId": tool }))).await;
    }
    ui.sync();
    assert_eq!(ui.mirror.runtime["c1"]["permission"]["permId"], "p-t1", "the oldest first");
    for i in 0..3 {
        assert_eq!(ui.chat("c1")["turns"][1]["segments"][i]["status"], "awaiting");
    }

    // A newer one answered first does not change what the runtime shows.
    h.call(&ui, "respondPermission", json!({ "chatId": "c1", "permId": "p-t2", "decision": "allow_always" })).unwrap();
    ui.sync();
    assert_eq!(ui.mirror.runtime["c1"]["permission"]["permId"], "p-t1");
    assert_eq!(ui.chat("c1")["turns"][1]["segments"][1]["status"], "running");

    h.call(&ui, "respondPermission", json!({ "chatId": "c1", "permId": "p-t1", "decision": "deny" })).unwrap();
    ui.sync();
    assert_eq!(ui.mirror.runtime["c1"]["permission"]["permId"], "p-t3", "answered, the next appears");
    assert_eq!(ui.chat("c1")["turns"][1]["segments"][0]["status"], "denied");
    assert_eq!(
        h.fake.permissions.lock().unwrap().as_slice(),
        &[("c1".to_string(), "p-t2".to_string(), "allow_always".to_string()), ("c1".to_string(), "p-t1".to_string(), "deny".to_string())]
    );

    h.call(&ui, "respondPermission", json!({ "chatId": "c1", "permId": "p-t3", "decision": "allow" })).unwrap();
    ui.sync();
    assert!(ui.mirror.runtime["c1"].get("permission").is_none());
    assert_eq!(code(h.call(&ui, "respondPermission", json!({ "chatId": "c1", "permId": "p-t3", "decision": "allow" }))), ErrorCode::Gone);
    h.finish(&mut ui, 0).await;
    assert_same(&h, &mut ui, "c1");
    assert_eq!(h.stored("c1")["turns"][1]["segments"][0]["status"], "denied", "the end of the turn keeps `denied`");
}

#[tokio::test]
async fn stop_before_the_provider_accepts_aborts_again_once_it_does() {
    let mut h = Harness::new();
    let mut ui = h.client();
    h.subscribe(&mut ui);
    h.call(&ui, "create", json!({ "chat": new_chat("c1", "claude") })).unwrap();
    let turn = h.send(&ui, "c1", "oi");
    // The provider has not answered `start` yet (its `Started` is queued).
    h.call(&ui, "stop", json!({ "chatId": "c1" })).unwrap();
    assert_eq!(h.fake.aborts.lock().unwrap().as_slice(), &[("c1".to_string(), turn.clone())]);
    h.settle().await;
    assert_eq!(h.fake.aborts.lock().unwrap().len(), 2, "cancelling the pending launch repeats the abort before releasing the chat");
    assert_eq!(h.fake.aborts.lock().unwrap()[1], ("c1".to_string(), turn));
    h.emit(0, TurnEvent::Done { aborted: true }).await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["c1"]["busy"], false);
    assert_eq!(ui.chat("c1")["turns"][1]["interrupted"], true);
    assert_same(&h, &mut ui, "c1");
}

#[tokio::test]
async fn stop_with_the_turn_running_aborts_once_and_idle_chats_ignore_it() {
    let (mut h, mut ui, turn) = Harness::running("codex").await;
    h.call(&ui, "stop", json!({ "chatId": "c1" })).unwrap();
    h.settle().await;
    assert_eq!(h.fake.aborts.lock().unwrap().as_slice(), &[("c1".to_string(), turn)], "no second abort: the provider had accepted it");
    ui.sync();
    assert_eq!(ui.mirror.runtime["c1"]["busy"], true, "the turn ends when the provider says so");
    h.emit(0, TurnEvent::Done { aborted: true }).await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["c1"]["busy"], false);
    h.call(&ui, "stop", json!({ "chatId": "c1" })).unwrap();
    h.call(&ui, "stop", json!({ "chatId": "nope" })).unwrap();
    assert_eq!(h.fake.aborts.lock().unwrap().len(), 1);
    assert_same(&h, &mut ui, "c1");
}

#[tokio::test]
async fn configure_keeps_the_active_turn_and_rejects_bad_selections() {
    let (mut h, ui, _turn) = Harness::running("claude").await;
    let selection = json!({ "provider": "codex", "profileId": "ambient-codex", "model": "gpt" });
    h.call(&ui, "configure", json!({ "chatId": "c1", "selection": selection })).unwrap();
    assert_eq!(h.stored("c1")["selection"]["provider"], "codex");
    assert_eq!(h.fake.starts.lock().unwrap().len(), 1, "changing a selection does not start or interrupt a turn");
    assert_eq!(h.fake.starts.lock().unwrap()[0].0.selection["provider"], "claude");
    h.emit(0, TurnEvent::Done { aborted: false }).await;
    assert_eq!(code(h.call(&ui, "configure", json!({ "chatId": "c1", "selection": { "provider": "x", "profileId": "p" } }))), ErrorCode::Invalid);
    assert_eq!(code(h.call(&ui, "configure", json!({ "chatId": "nope", "selection": selection }))), ErrorCode::NotFound);
}

#[tokio::test]
async fn a_new_route_drops_the_session_and_the_account_flag() {
    let mut h = Harness::new();
    let mut ui = h.client();
    h.subscribe(&mut ui);
    let chat = with(
        new_chat("c1", "claude"),
        json!({ "turns": [user_turn()], "resume": { "route": "claude:ambient-claude", "sessionId": "s" }, "lastRunId": "r", "accountNeedsSelection": true }),
    );
    h.call(&ui, "create", json!({ "chat": chat })).unwrap();
    let selection = json!({ "provider": "claude", "profileId": "work", "model": "haiku", "effort": "low", "permissionMode": "default" });
    h.call(&ui, "configure", json!({ "chatId": "c1", "selection": selection })).unwrap();
    let stored = h.stored("c1");
    assert_eq!(stored["selection"], selection);
    assert!(stored.get("resume").is_none() && stored.get("lastRunId").is_none());
    assert_eq!(stored["accountNeedsSelection"], false);
    assert_eq!(stored["turns"][0]["text"], "antes", "the turns stay");
    assert_same(&h, &mut ui, "c1");
}

#[tokio::test]
async fn the_same_route_keeps_everything_and_model_or_tier_changes_clear_fast() {
    let (mut h, mut ui, _turn) = Harness::running("claude").await;
    h.emit(0, TurnEvent::Session("s1".into())).await;
    h.emit(0, TurnEvent::Fast { state: "on".into(), reason: None }).await;
    h.finish(&mut ui, 0).await;
    assert_eq!(ui.mirror.runtime["c1"]["fast"]["state"], "on", "Fast outlives the turn");
    let before = h.stored("c1");

    // Same route, model and tier (only the effort moves): nothing is reset.
    let mut selection = before["selection"].clone();
    selection["effort"] = json!("high");
    h.call(&ui, "configure", json!({ "chatId": "c1", "selection": selection })).unwrap();
    ui.sync();
    let after = h.stored("c1");
    assert_eq!(after["selection"]["effort"], "high");
    assert_eq!(after["resume"], before["resume"]);
    assert_eq!(after["lastRunId"], before["lastRunId"]);
    assert_eq!(ui.mirror.runtime["c1"]["fast"]["state"], "on");

    // Another model: same route, so the session stays, but Fast was about the old model.
    selection["model"] = json!("sonnet");
    h.call(&ui, "configure", json!({ "chatId": "c1", "selection": selection })).unwrap();
    ui.sync();
    assert!(ui.mirror.runtime["c1"].get("fast").is_none());
    assert_eq!(h.stored("c1")["resume"], before["resume"]);

    // The next turn reports Fast again; a new tier clears it.
    h.send(&ui, "c1", "outra");
    h.settle().await;
    h.emit(1, TurnEvent::Fast { state: "cooldown".into(), reason: Some("limite".into()) }).await;
    h.emit(1, TurnEvent::Done { aborted: false }).await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["c1"]["fast"], json!({ "state": "cooldown", "reason": "limite" }));
    selection["serviceTier"] = json!("fast");
    h.call(&ui, "configure", json!({ "chatId": "c1", "selection": selection })).unwrap();
    ui.sync();
    assert!(ui.mirror.runtime["c1"].get("fast").is_none());
    assert_same(&h, &mut ui, "c1");
}

#[tokio::test]
async fn confirm_account_clears_the_flag() {
    let mut h = Harness::new();
    let mut ui = h.client();
    h.subscribe(&mut ui);
    h.call(&ui, "create", json!({ "chat": with(new_chat("c1", "claude"), json!({ "accountNeedsSelection": true })) })).unwrap();
    assert_eq!(code(h.call(&ui, "send", json!({ "chatId": "c1", "text": "oi" }))), ErrorCode::Invalid, "an unconfirmed account blocks sending");
    h.call(&ui, "confirmAccount", json!({ "chatId": "c1" })).unwrap();
    assert_eq!(h.stored("c1")["accountNeedsSelection"], false);
    assert_same(&h, &mut ui, "c1");
    assert_eq!(code(h.call(&ui, "confirmAccount", json!({ "chatId": "nope" }))), ErrorCode::NotFound);
    h.send(&ui, "c1", "oi");
}

#[tokio::test]
async fn bind_workspace_local_remote_and_when_nothing_is_needed() {
    let mut h = Harness::new();
    let mut ui = h.client();
    h.subscribe(&mut ui);
    let imported = with(
        new_chat("c1", "codex"),
        json!({ "workspaceNeedsBinding": true, "turns": [user_turn()], "remoteId": "old", "remoteTarget": { "host": "x", "port": 22, "username": "u" },
                "resume": { "route": "codex:ambient-codex", "sessionId": "s" } }),
    );
    h.call(&ui, "create", json!({ "chat": imported })).unwrap();
    assert_eq!(code(h.call(&ui, "send", json!({ "chatId": "c1", "text": "oi" }))), ErrorCode::Invalid, "an unbound workspace blocks sending");

    // Local: the folder, no remote, no session.
    h.call(&ui, "bindWorkspace", json!({ "chatId": "c1", "cwd": "D:/novo" })).unwrap();
    let local = h.stored("c1");
    assert_eq!(local["cwd"], "D:/novo");
    assert_eq!(local["workspaceNeedsBinding"], false);
    for field in ["remoteId", "remoteTarget", "resume"] {
        assert!(local.get(field).is_none(), "{field}");
    }
    assert_eq!(local["selection"]["provider"], "codex", "a local bind leaves the selection");
    assert_same(&h, &mut ui, "c1");

    // Nothing to bind: the chat has turns and no flag.
    let rev = ui.mirror.rev;
    h.call(&ui, "bindWorkspace", json!({ "chatId": "c1", "cwd": "E:/outro", "remoteId": "r9" })).unwrap();
    ui.sync();
    assert_eq!((h.stored("c1")["cwd"].as_str(), ui.mirror.rev), (Some("D:/novo"), rev), "no change, no delta");

    // Remote: always Claude on the terminal account, with the window's model.
    let again = with(new_chat("c2", "codex"), json!({ "workspaceNeedsBinding": true, "resume": { "route": "codex:ambient-codex", "sessionId": "s" } }));
    h.call(&ui, "create", json!({ "chat": again })).unwrap();
    let target = json!({ "host": "vps", "port": 22, "username": "root" });
    h.call(&ui, "bindWorkspace", json!({ "chatId": "c2", "cwd": "/srv/app", "remoteId": "r1", "remoteTarget": target, "model": "opus" })).unwrap();
    let remote = h.stored("c2");
    assert_eq!((remote["cwd"].as_str(), remote["remoteId"].as_str()), (Some("/srv/app"), Some("r1")));
    assert_eq!(remote["remoteTarget"], target);
    assert_eq!(remote["selection"]["provider"], "claude");
    assert_eq!(remote["selection"]["profileId"], "ambient-claude");
    assert_eq!(remote["selection"]["model"], "opus");
    assert!(remote.get("resume").is_none());
    assert_same(&h, &mut ui, "c2");
    assert_eq!(code(h.call(&ui, "send", json!({ "chatId": "c2", "text": "oi" }))), ErrorCode::Invalid, "SSH chats run in the window, not in the host");
    assert_eq!(code(h.call(&ui, "bindWorkspace", json!({ "chatId": "nope", "cwd": "x" }))), ErrorCode::NotFound);

    // Running chats refuse.
    h.call(&ui, "create", json!({ "chat": new_chat("c3", "claude") })).unwrap();
    h.send(&ui, "c3", "oi");
    assert_eq!(code(h.call(&ui, "bindWorkspace", json!({ "chatId": "c3", "cwd": "x" }))), ErrorCode::Busy);
}

#[tokio::test]
async fn rename_trims_cuts_at_100_characters_and_ignores_empty_titles() {
    let mut h = Harness::new();
    let mut ui = h.client();
    h.subscribe(&mut ui);
    h.call(&ui, "create", json!({ "chat": new_chat("c1", "claude") })).unwrap();
    h.call(&ui, "rename", json!({ "chatId": "c1", "title": "  Meu chat  " })).unwrap();
    assert_eq!(h.stored("c1")["title"], "Meu chat");
    h.call(&ui, "rename", json!({ "chatId": "c1", "title": format!("  {}  ", "é".repeat(130)) })).unwrap();
    assert_eq!(h.stored("c1")["title"], "é".repeat(100).as_str());
    ui.sync();
    let rev = ui.mirror.rev;
    h.call(&ui, "rename", json!({ "chatId": "c1", "title": " \t\n " })).unwrap();
    ui.sync();
    assert_eq!((h.stored("c1")["title"].as_str(), ui.mirror.rev), (Some("é".repeat(100).as_str()), rev));
    assert_eq!(code(h.call(&ui, "rename", json!({ "chatId": "nope", "title": "x" }))), ErrorCode::NotFound);
    assert_same(&h, &mut ui, "c1");
}

#[tokio::test]
async fn archiving_a_running_chat_is_busy_and_unarchiving_removes_the_field() {
    let (mut h, mut ui, _turn) = Harness::running("claude").await;
    assert_eq!(code(h.call(&ui, "archive", json!({ "chatId": "c1", "archived": true }))), ErrorCode::Busy);
    h.call(&ui, "archive", json!({ "chatId": "c1", "archived": false })).unwrap();
    h.finish(&mut ui, 0).await;
    h.call(&ui, "archive", json!({ "chatId": "c1", "archived": true })).unwrap();
    assert_eq!(h.stored("c1")["archived"], true);
    assert_same(&h, &mut ui, "c1");
    h.call(&ui, "archive", json!({ "chatId": "c1", "archived": false })).unwrap();
    assert!(h.stored("c1").get("archived").is_none());
    assert_same(&h, &mut ui, "c1");
    assert_eq!(code(h.call(&ui, "archive", json!({ "chatId": "nope", "archived": true }))), ErrorCode::NotFound);
}

#[tokio::test]
async fn set_task_works_with_the_turn_running() {
    let (mut h, mut ui, _turn) = Harness::running("claude").await;
    h.call(&ui, "setTask", json!({ "chatId": "c1", "taskId": "task-1" })).unwrap();
    ui.sync();
    assert_eq!(ui.chat("c1")["taskId"], "task-1");
    assert_eq!(ui.mirror.runtime["c1"]["busy"], true);
    h.emit(0, TurnEvent::Text("ok".into())).await;
    h.finish(&mut ui, 0).await;
    assert_eq!(h.stored("c1")["taskId"], "task-1", "the end of the turn keeps the task");
    h.call(&ui, "setTask", json!({ "chatId": "c1" })).unwrap();
    assert!(h.stored("c1").get("taskId").is_none());
    assert_same(&h, &mut ui, "c1");
    assert_eq!(code(h.call(&ui, "setTask", json!({ "chatId": "nope", "taskId": "t" }))), ErrorCode::NotFound);
}

#[tokio::test]
async fn remove_is_busy_while_running_and_otherwise_publishes_remove() {
    let (mut h, mut ui, _turn) = Harness::running("claude").await;
    assert_eq!(code(h.call(&ui, "remove", json!({ "chatId": "c1" }))), ErrorCode::Busy);
    assert!(h.store.chat("c1").unwrap().is_some());
    h.emit(0, TurnEvent::Text("ok".into())).await;
    h.finish(&mut ui, 0).await;
    assert!(!h.store.events("c1").unwrap().is_empty());

    let mut late = h.client();
    h.subscribe(&mut late);
    h.call(&ui, "remove", json!({ "chatId": "c1" })).unwrap();
    ui.sync();
    late.sync();
    for mirror in [&ui.mirror, &late.mirror] {
        assert!(mirror.chats.is_empty() && mirror.runtime.is_empty(), "the chat and its runtime are gone");
    }
    assert!(h.store.chat("c1").unwrap().is_none());
    assert!(h.store.events("c1").unwrap().is_empty(), "the journal goes with it");
    let mut after = h.client();
    h.subscribe(&mut after);
    assert!(after.mirror.chats.is_empty() && after.mirror.runtime.is_empty());
}

#[tokio::test]
async fn reassign_profile_moves_chats_to_the_terminal_account() {
    let mut h = Harness::new();
    let mut ui = h.client();
    h.subscribe(&mut ui);
    let route = |p: &str, provider: &str| json!({ "provider": provider, "profileId": p, "model": "m" });
    let resume = json!({ "route": "claude:work", "sessionId": "s" });
    h.call(&ui, "create", json!({ "chat": with(new_chat("a", "claude"), json!({ "selection": route("work", "claude"), "resume": resume, "lastRunId": "r" })) })).unwrap();
    h.call(&ui, "create", json!({ "chat": with(new_chat("b", "codex"), json!({ "selection": route("work", "codex") })) })).unwrap();
    h.call(&ui, "create", json!({ "chat": new_chat("c", "claude") })).unwrap();
    h.call(&ui, "create", json!({ "chat": with(new_chat("d", "claude"), json!({ "selection": route("other", "claude") })) })).unwrap();

    // A chat running on the account blocks the whole move.
    h.send(&ui, "a", "oi");
    h.settle().await;
    assert_eq!(code(h.call(&ui, "reassignProfile", json!({ "profileId": "work" }))), ErrorCode::Busy);
    assert_eq!(h.stored("b")["selection"]["profileId"], "work", "nothing moved");
    h.emit(0, TurnEvent::Done { aborted: false }).await;

    let moved = h.call(&ui, "reassignProfile", json!({ "profileId": "work" })).unwrap();
    assert_eq!(moved, json!({ "moved": 2 }));
    assert_eq!(h.stored("a")["selection"]["profileId"], "ambient-claude");
    assert_eq!(h.stored("b")["selection"]["profileId"], "ambient-codex");
    assert!(h.stored("a").get("resume").is_none() && h.stored("a").get("lastRunId").is_none());
    assert_eq!(h.stored("c")["selection"]["profileId"], "ambient-claude");
    assert_eq!(h.stored("d")["selection"]["profileId"], "other", "other accounts stay");
    for id in ["a", "b", "c", "d"] {
        assert_same(&h, &mut ui, id);
    }
    assert_eq!(h.call(&ui, "reassignProfile", json!({ "profileId": "work" })).unwrap(), json!({ "moved": 0 }));
}

#[tokio::test]
async fn put_is_busy_for_a_running_chat_and_batches_skip_it() {
    let (mut h, mut ui, _turn) = Harness::running("claude").await;
    let edited = |id: &str, title: &str| with(new_chat(id, "claude"), json!({ "title": title }));
    assert_eq!(code(h.call(&ui, "put", json!({ "chat": edited("c1", "x") }))), ErrorCode::Busy);
    h.call(&ui, "put", json!({ "chat": edited("c2", "novo") })).unwrap();
    h.call(&ui, "put", json!({ "chat": edited("c2", "trocado") })).unwrap();
    assert_eq!(h.stored("c2")["title"], "trocado");

    let flushed = h.call(&ui, "flush", json!({ "chats": [edited("c1", "ignorado"), edited("c2", "f2"), edited("c3", "f3")] })).unwrap();
    assert_eq!(flushed, json!({ "written": 2, "skipped": ["c1"] }));
    assert_eq!(h.stored("c2")["title"], "f2");
    assert_ne!(h.stored("c1")["title"], "ignorado");
    let imported = h.call(&ui, "importDocs", json!({ "chats": [edited("c1", "ignorado"), edited("c4", "i4")] })).unwrap();
    assert_eq!(imported, json!({ "written": 1, "skipped": ["c1"] }));

    // A malformed chat refuses the whole batch before writing anything.
    let bad = h.call(&ui, "flush", json!({ "chats": [edited("c5", "x"), { "id": "c6" }] }));
    assert_eq!(code(bad), ErrorCode::Invalid);
    assert!(h.store.chat("c5").unwrap().is_none());
    assert_eq!(code(h.call(&ui, "put", json!({ "chat": { "id": "", "turns": [], "cwd": "x" } }))), ErrorCode::Invalid);
    h.finish(&mut ui, 0).await;
    for id in ["c1", "c2", "c3", "c4"] {
        assert_same(&h, &mut ui, id);
    }
}

#[tokio::test]
async fn list_does_not_subscribe_and_unsubscribe_stops_the_deltas() {
    let mut h = Harness::new();
    let mut ui = h.client();
    let mut reader = h.client();
    let mut leaver = h.client();
    h.subscribe(&mut ui);
    h.subscribe(&mut leaver);
    h.call(&ui, "create", json!({ "chat": new_chat("c1", "claude") })).unwrap();

    let snapshot = h.call(&reader, "list", json!({})).unwrap();
    assert_eq!(snapshot["chats"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["rev"], 1);
    h.call(&ui, "rename", json!({ "chatId": "c1", "title": "novo" })).unwrap();
    reader.sync();
    assert_eq!(reader.mirror.rev, 0, "`list` receives no deltas");

    leaver.sync();
    let seen = leaver.mirror.rev;
    assert_eq!(seen, 2);
    h.call(&leaver, "unsubscribe", json!({})).unwrap();
    h.call(&ui, "rename", json!({ "chatId": "c1", "title": "outro" })).unwrap();
    leaver.sync();
    assert_eq!(leaver.mirror.rev, seen);
    ui.sync();
    assert_eq!(ui.chat("c1")["title"], "outro");
    assert!(ui.mirror.rev > seen);
}

#[tokio::test]
async fn image_only_messages_are_persisted_and_reach_the_runner() {
    let mut h = Harness::new();
    let ui = h.client();
    h.call(&ui, "create", json!({"chat": new_chat("c1", "codex")})).unwrap();
    let images = json!([{"mime": "image/png", "data": "aGVsbG8=", "name": "screen.png", "number": 1}]);
    h.call(&ui, "send", json!({"chatId": "c1", "text": "", "images": images})).unwrap();
    h.settle().await;
    assert_eq!(json!(h.started(0).images), images);
    assert_eq!(h.stored("c1")["turns"][0]["images"], images);
    assert_eq!(h.stored("c1")["title"], "Imagem");
}

#[tokio::test]
async fn later_image_references_reach_resumed_runs_and_do_not_duplicate_history() {
    let mut h = Harness::new();
    let mut ui = h.client();
    h.call(&ui, "create", json!({"chat": new_chat("c1", "codex")})).unwrap();
    h.subscribe(&mut ui);
    h.call(&ui, "send", json!({"chatId":"c1","text":"screens","images":[{"mime":"image/png","data":"one"},{"mime":"image/png","data":"two"}]})).unwrap();
    h.settle().await;
    assert_eq!(h.stored("c1")["turns"][0]["images"][0]["number"], 1);
    assert_eq!(h.stored("c1")["turns"][0]["images"][1]["number"], 2);
    h.emit(0, TurnEvent::Session("native-session".into())).await;
    h.finish(&mut ui, 0).await;
    let text = "compare #image2 com #image 1 e #image2";
    h.send(&ui, "c1", text);
    h.settle().await;
    let second = h.started(1);
    assert_eq!(second.resume.as_deref(), Some("native-session"));
    assert_eq!(second.images.iter().map(|image| image["number"].as_u64().unwrap()).collect::<Vec<_>>(), vec![2, 1]);
    assert_eq!(second.images[0]["data"], "two");
    assert!(second.prompt.ends_with("Anexo 1 = #image 2\nAnexo 2 = #image 1"));
    let stored = h.stored("c1");
    assert_eq!(stored["turns"][2]["text"], text);
    assert!(stored["turns"][2].get("images").is_none());
    assert_eq!(super::image_references::collect_chat_images(&stored, &[]).len(), 2);
    assert_same(&h, &mut ui, "c1");
}

#[tokio::test]
async fn invalid_image_references_never_start_a_turn_and_stale_queue_entries_are_retained() {
    let mut h = Harness::new();
    let mut ui = h.client();
    let mut chat = new_chat("c1", "claude");
    chat["queued"] = json!([{"id":"bad","text":"compare #image999"}]);
    chat["queuePaused"] = json!(true);
    h.call(&ui, "create", json!({"chat":chat})).unwrap();
    h.subscribe(&mut ui);
    for text in ["#image0", "#image -1", "#image999", "#image9007199254740992"] {
        let error = h.call(&ui, "send", json!({"chatId":"c1","text":text})).unwrap_err();
        assert_eq!(error.code, ErrorCode::Invalid);
    }
    assert!(h.fake.starts.lock().unwrap().is_empty());
    assert!(ui.mirror.runtime.is_empty());
    h.call(&ui, "queue", json!({"chatId":"c1","operation":"pause","paused":false})).unwrap();
    h.settle().await;
    let stored = h.stored("c1");
    assert_eq!(stored["queued"][0]["id"], "bad");
    assert_eq!(stored["queuePaused"], true);
    assert!(stored["turns"].as_array().unwrap().is_empty());
    assert!(h.fake.starts.lock().unwrap().is_empty());
    assert_same(&h, &mut ui, "c1");
}

#[tokio::test]
async fn references_to_queued_images_survive_removing_the_original_queue_entry() {
    let mut h = Harness::new();
    let ui = h.client();
    h.call(&ui, "create", json!({"chat":new_chat("c1", "claude")})).unwrap();
    let queued = h.call(&ui, "queue", json!({"chatId":"c1","operation":"add","message":{"text":"later","images":[{"mime":"image/png","data":"queued"}]}})).unwrap();
    h.send(&ui, "c1", "show #image1");
    h.settle().await;
    h.call(&ui, "queue", json!({"chatId":"c1","operation":"remove","id":queued["id"]})).unwrap();
    let stored = h.stored("c1");
    assert_eq!(stored["turns"][0]["images"][0]["number"], 1);
    assert_eq!(stored["turns"][0]["images"][0]["data"], "queued");
    assert_eq!(super::image_references::collect_chat_images(&stored, &[]).len(), 1);
}

#[tokio::test]
async fn legacy_queue_numbers_survive_reordering_removal_and_send() {
    let mut h = Harness::new();
    let ui = h.client();
    let mut chat = new_chat("c1", "claude");
    chat["turns"] = json!([{"id":"old","role":"user","text":"old","images":[{"mime":"image/png","data":"old"}]}]);
    chat["queued"] = json!([
        {"id":"a","text":"a","images":[{"mime":"image/png","data":"a"}]},
        {"id":"b","text":"b","images":[{"mime":"image/png","data":"b"}]}
    ]);
    chat["queuePaused"] = json!(true);
    h.call(&ui, "create", json!({"chat":chat})).unwrap();
    h.call(&ui, "queue", json!({"chatId":"c1","operation":"move","id":"b","to":0})).unwrap();
    assert_eq!(h.stored("c1")["queued"][0]["images"][0]["number"], 3);
    assert_eq!(h.stored("c1")["queued"][1]["images"][0]["number"], 2);
    h.call(&ui, "queue", json!({"chatId":"c1","operation":"remove","id":"a"})).unwrap();
    h.call(&ui, "queue", json!({"chatId":"c1","operation":"pause","paused":false})).unwrap();
    h.settle().await;
    assert_eq!(h.started(0).images[0]["number"], 3);
    assert_eq!(h.stored("c1")["turns"][1]["images"][0]["number"], 3);
    assert!(h.stored("c1")["queued"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn steering_resends_references_without_persisting_duplicate_attachments() {
    let mut h = Harness::new();
    let ui = h.client();
    h.call(&ui, "create", json!({"chat":new_chat("c1", "claude")})).unwrap();
    let first = h.call(&ui, "send", json!({"chatId":"c1","text":"start","images":[{"mime":"image/png","data":"one"}]})).unwrap();
    h.settle().await;
    let (reply, answer) = oneshot::channel();
    h.engine.handle(Msg::Call { method:"steer".into(), params:json!({"chatId":"c1","turnId":first["turnId"],"text":"check #image1 twice #image1"}),
        user:owner(), client:ui.id, notifier:ui.notifier.clone(), activity:Arc::clone(&h.activity), reply });
    h.settle().await;
    assert!(answer.await.unwrap().is_ok());
    let steers = h.fake.steers.lock().unwrap();
    assert_eq!(steers[0].3.len(), 1);
    assert_eq!(steers[0].3[0]["data"], "one");
    assert!(steers[0].2.ends_with("Anexo 1 = #image 1"));
    let stored = h.stored("c1");
    assert!(stored["turns"][1]["segments"][0]["images"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_new_route_sends_the_history_in_the_prompt() {
    let (mut h, mut ui, _turn) = Harness::running("claude").await;
    h.emit(0, TurnEvent::Session("s1".into())).await;
    h.emit(0, TurnEvent::Text("olá".into())).await;
    h.finish(&mut ui, 0).await;
    let codex = json!({ "provider": "codex", "profileId": "ambient-codex", "model": "gpt" });
    h.call(&ui, "configure", json!({ "chatId": "c1", "selection": codex })).unwrap();
    h.send(&ui, "c1", "e agora?");
    h.settle().await;
    let second = h.started(1);
    assert_eq!(second.resume, None);
    assert!(second.prompt.contains("<historico>\nUsuário: oi\n\nclaude: olá\n</historico>"), "{}", second.prompt);
    assert!(second.prompt.ends_with("Nova mensagem do usuário:\ne agora?"));
    assert_eq!(h.stored("c1")["turns"][2]["text"], "e agora?", "the visible user turn is the plain text");
}

#[tokio::test]
async fn the_same_route_resumes_and_sends_only_the_text() {
    let (mut h, mut ui, _turn) = Harness::running("claude").await;
    assert_eq!(h.started(0).resume, None);
    h.emit(0, TurnEvent::Session("s1".into())).await;
    h.finish(&mut ui, 0).await;
    assert_eq!(ui.chat("c1")["resume"], json!({ "route": "claude:ambient-claude", "sessionId": "s1" }));
    h.send(&ui, "c1", "segunda");
    h.settle().await;
    let second = h.started(1);
    assert_eq!((second.prompt.as_str(), second.resume.as_deref()), ("segunda", Some("s1")));
    assert_eq!((second.cwd.as_str(), second.chat_id.as_str()), ("C:/repo", "c1"));
    assert_eq!(second.selection["model"], "haiku");
}

#[tokio::test]
async fn the_context_file_goes_in_the_prompt_and_in_the_users_turn_and_only_the_first_message_titles() {
    let mut h = Harness::new();
    let mut ui = h.client();
    h.subscribe(&mut ui);
    h.call(&ui, "create", json!({ "chat": new_chat("c1", "claude") })).unwrap();
    h.call(&ui, "send", json!({ "chatId": "c1", "text": "Explique isto", "context": "fn main() {}", "serviceTier": "fast" })).unwrap();
    h.settle().await;
    let first = h.started(0);
    assert_eq!(first.prompt, "Explique isto\n\nArquivo aberto como contexto:\nfn main() {}");
    assert_eq!(first.service_tier.as_deref(), Some("fast"));
    ui.sync();
    assert_eq!(ui.chat("c1")["turns"][0]["text"], "Explique isto\n\nfn main() {}");
    assert_eq!(ui.chat("c1")["title"], "Explique isto");
    h.emit(0, TurnEvent::Session("s1".into())).await;
    h.finish(&mut ui, 0).await;

    h.call(&ui, "send", json!({ "chatId": "c1", "text": "Outra pergunta", "context": "" })).unwrap();
    h.settle().await;
    assert_eq!(h.started(1).prompt, "Outra pergunta", "an empty context is no context");
    ui.sync();
    assert_eq!(ui.chat("c1")["title"], "Explique isto", "the title stays after the first message");
    assert_eq!(ui.chat("c1")["turns"][2]["text"], "Outra pergunta");
    h.finish(&mut ui, 1).await;
    assert_same(&h, &mut ui, "c1");
}

#[tokio::test]
async fn fast_reports_reach_the_runtime_and_outlive_the_turn() {
    let (mut h, mut ui, _turn) = Harness::running("claude").await;
    assert!(ui.mirror.runtime["c1"].get("fast").is_none());
    h.emit(0, TurnEvent::Fast { state: "on".into(), reason: None }).await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["c1"]["fast"], json!({ "state": "on" }));
    h.emit(0, TurnEvent::Fast { state: "cooldown".into(), reason: Some("limite".into()) }).await;
    h.finish(&mut ui, 0).await;
    assert_eq!(ui.mirror.runtime["c1"]["fast"], json!({ "state": "cooldown", "reason": "limite" }));
    assert_eq!(ui.mirror.runtime["c1"]["busy"], false);
    h.send(&ui, "c1", "de novo");
    h.settle().await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["c1"]["fast"]["state"], "cooldown", "the last report stays until this turn's own replaces it");
    let mut late = h.client();
    h.subscribe(&mut late);
    assert_eq!(late.mirror.runtime["c1"]["fast"]["state"], "cooldown", "a snapshot carries it too");
}

#[tokio::test]
async fn the_journal_merges_text_replaces_tool_snapshots_and_records_who_acted() {
    let (mut h, mut ui, turn) = Harness::running("claude").await;
    h.emit_all(
        0,
        vec![
            TurnEvent::Text("a".into()),
            TurnEvent::Text("b".into()),
            TurnEvent::Thinking("x".into()),
            TurnEvent::Thinking("y".into()),
            TurnEvent::Text("c".into()),
            TurnEvent::Tool { tool_id: "t1".into(), name: json!("Bash"), input: None },
            TurnEvent::ToolResult { tool_id: "t1".into(), content: Some(json!("ok")), is_error: false },
        ],
    )
    .await;
    let events = h.store.events("c1").unwrap();
    let kinds: Vec<_> = events.iter().map(|e| e.kind().unwrap().to_string()).collect();
    assert_eq!(kinds, ["begin", "text", "thinking", "text", "segment"], "{events:?}");
    assert_eq!(events[1].event["text"], "ab");
    assert_eq!(events[2].event["text"], "xy");
    assert_eq!(events[3].event["text"], "c");
    assert_eq!(events[4].event["segment"]["status"], "done", "only the newest snapshot was committed");
    assert_eq!(events[4].event["segment"]["result"], "ok");

    // The permission flow: `awaiting` by the host, the answer by the user.
    h.emit(0, TurnEvent::Tool { tool_id: "t2".into(), name: json!("Edit"), input: None }).await;
    h.emit(0, TurnEvent::Permission(json!({ "id": turn, "permId": "p", "toolUseId": "t2" }))).await;
    h.call(&ui, "respondPermission", json!({ "chatId": "c1", "permId": "p", "decision": "deny" })).unwrap();
    h.finish(&mut ui, 0).await;
    let events = h.store.events("c1").unwrap();
    let seen: Vec<_> = events
        .iter()
        .filter(|e| e.kind() == Some("segment") && e.event["segment"]["toolId"] == "t2")
        .map(|e| (e.event["segment"]["status"].as_str().unwrap().to_string(), e.actor.clone()))
        .collect();
    assert_eq!(seen, [("running".to_string(), None), ("awaiting".to_string(), None), ("denied".to_string(), Some("owner".to_string()))]);
    assert_eq!(events[0].kind(), Some("begin"));
    assert_eq!(events[0].actor.as_deref(), Some("owner"), "`begin` is the sender's");
    assert_eq!(events.last().unwrap().kind(), Some("done"));
    assert_eq!(events.last().unwrap().actor, None);
    assert_same(&h, &mut ui, "c1");
}

#[tokio::test]
async fn revs_are_contiguous_for_every_client_and_a_late_subscriber_gets_the_snapshot_plus_new_deltas() {
    let mut h = Harness::new();
    let mut a = h.client();
    let mut b = h.client();
    h.subscribe(&mut a);
    h.subscribe(&mut b);
    h.call(&a, "create", json!({ "chat": new_chat("c1", "codex") })).unwrap();
    h.call(&b, "create", json!({ "chat": new_chat("c2", "claude") })).unwrap();
    h.send(&a, "c1", "oi");
    h.settle().await;
    h.emit(0, TurnEvent::Segment(json!({ "kind": "text", "toolId": "m1", "text": "Olá" }))).await;
    h.emit(0, TurnEvent::Metrics(json!({ "scope": "session", "inputTokens": 5 }))).await;

    let mut late = h.client();
    h.subscribe(&mut late);
    let at_snapshot = late.mirror.rev;
    assert!(at_snapshot > 0);
    a.sync();
    assert_eq!(a.mirror.rev, at_snapshot, "the snapshot reflects every batch already sent");
    h.emit(0, TurnEvent::Segment(json!({ "kind": "text", "toolId": "m1", "text": "Olá, tudo" }))).await;
    h.send(&b, "c2", "ola");
    h.settle().await;
    h.emit(1, TurnEvent::Text("oi!".into())).await;
    h.emit(0, TurnEvent::Done { aborted: false }).await;
    h.emit(1, TurnEvent::Done { aborted: false }).await;
    for client in [&mut a, &mut b, &mut late] {
        client.sync(); // `apply` asserts each batch starts right after the previous rev
    }
    assert!(late.mirror.rev > at_snapshot);
    assert_eq!((a.mirror.rev, b.mirror.rev), (late.mirror.rev, late.mirror.rev), "one counter for everyone");
    for id in ["c1", "c2"] {
        assert_same(&h, &mut a, id);
        assert_same(&h, &mut b, id);
        assert_same(&h, &mut late, id);
    }
    assert_eq!(a.mirror.runtime, late.mirror.runtime);
}

// ---- the Claude event translation ----

// ---- T08: accounts in use, forgotten sessions, failure codes ----

#[tokio::test]
async fn busy_profiles_lists_the_accounts_with_a_turn_running() {
    let mut h = Harness::new();
    let mut ui = h.client();
    h.subscribe(&mut ui);
    let busy = |h: &mut Harness, ui: &Client| h.call(ui, "busyProfiles", json!({})).unwrap();
    assert_eq!(busy(&mut h, &ui), json!({ "profileIds": [] }));

    h.call(&ui, "create", json!({ "chat": new_chat("a", "codex") })).unwrap();
    h.call(&ui, "create", json!({ "chat": new_chat("b", "claude") })).unwrap();
    h.call(&ui, "create", json!({ "chat": new_chat("c", "claude") })).unwrap();
    h.send(&ui, "a", "oi");
    h.send(&ui, "b", "oi");
    h.send(&ui, "c", "oi");
    h.settle().await;
    assert_eq!(busy(&mut h, &ui), json!({ "profileIds": ["ambient-claude", "ambient-codex"] }), "sorted, one per account");

    let index_of = |h: &Harness, chat: &str| h.fake.starts.lock().unwrap().iter().position(|(t, _)| t.chat_id == chat).unwrap();
    let index = index_of(&h, "a");
    h.emit(index, TurnEvent::Done { aborted: false }).await;
    assert_eq!(busy(&mut h, &ui), json!({ "profileIds": ["ambient-claude"] }));
    let index = index_of(&h, "b");
    h.emit(index, TurnEvent::Done { aborted: false }).await;
    assert_eq!(busy(&mut h, &ui), json!({ "profileIds": ["ambient-claude"] }), "c still runs on it");
    let index = index_of(&h, "c");
    h.emit(index, TurnEvent::Done { aborted: false }).await;
    assert_eq!(busy(&mut h, &ui), json!({ "profileIds": [] }));
}

#[tokio::test]
async fn forget_sessions_is_busy_while_the_account_runs_and_otherwise_clears_only_its_resumes() {
    let mut h = Harness::new();
    let mut ui = h.client();
    h.subscribe(&mut ui);
    let resume = |route: &str| json!({ "route": route, "sessionId": "s" });
    let create = |h: &mut Harness, id: &str, provider: &str, profile: &str, route: Option<&str>| {
        let selection = json!({ "provider": provider, "profileId": profile, "model": "m" });
        let mut chat = with(new_chat(id, provider), json!({ "selection": selection }));
        if let Some(route) = route {
            chat["resume"] = resume(route);
        }
        h.call(&ui, "create", json!({ "chat": chat })).unwrap();
    };
    create(&mut h, "a", "claude", "work", Some("claude:work"));
    create(&mut h, "b", "claude", "work", Some("claude:work"));
    create(&mut h, "other", "claude", "home", Some("claude:home"));
    create(&mut h, "codex", "codex", "work", Some("codex:work"));
    create(&mut h, "none", "claude", "work", None);

    // A turn running on claude:work blocks it, and nothing is touched.
    h.send(&ui, "a", "oi");
    h.settle().await;
    let err = h.call(&ui, "forgetSessions", json!({ "provider": "claude", "id": "work" })).unwrap_err();
    assert_eq!(err.code, ErrorCode::Busy);
    assert_eq!(err.message, "Pare as tarefas desta conta antes de trocar o login dela.");
    assert!(h.stored("b").get("resume").is_some());

    // The same id on another provider is another account: not blocked.
    h.call(&ui, "forgetSessions", json!({ "provider": "codex", "id": "work" })).unwrap();
    assert!(h.stored("codex").get("resume").is_none());
    assert!(h.stored("b").get("resume").is_some());

    h.emit(0, TurnEvent::Done { aborted: false }).await;
    assert_eq!(h.call(&ui, "forgetSessions", json!({ "provider": "claude", "id": "work" })).unwrap(), json!({ "ok": true }));
    for id in ["a", "b", "none"] {
        assert!(h.stored(id).get("resume").is_none(), "{id}");
    }
    assert_eq!(h.stored("other")["resume"], resume("claude:home"), "other accounts keep theirs");
    assert_eq!(h.stored("b")["selection"]["profileId"], "work", "only the session goes");
    for id in ["a", "b", "other", "codex", "none"] {
        assert_same(&h, &mut ui, id);
    }
    // Nothing left to forget is fine.
    h.call(&ui, "forgetSessions", json!({ "provider": "claude", "id": "work" })).unwrap();
}

fn last_event_body(h: &Harness, chat: &str) -> Value {
    h.store.events(chat).unwrap().last().unwrap().event.clone()
}

#[tokio::test]
async fn an_error_code_before_the_error_lands_in_the_journal_and_on_the_turn() {
    let (mut h, mut ui, _turn) = Harness::running("claude").await;
    h.emit(0, TurnEvent::Session("s1".into())).await;
    h.emit(0, TurnEvent::ErrorCode("cli_auth".into())).await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["c1"]["busy"], true, "the code alone ends nothing");
    h.emit(0, TurnEvent::Error("Faça login de novo.".into())).await;
    ui.sync();

    let body = last_event_body(&h, "c1");
    assert_eq!(body["kind"], "error");
    assert_eq!(body["message"], "Faça login de novo.");
    assert_eq!(body["code"], "cli_auth");
    let turn = &ui.chat("c1")["turns"][1];
    assert_eq!((turn["error"].clone(), turn["errorCode"].clone()), (json!(true), json!("cli_auth")));
    assert!(ui.chat("c1").get("resume").is_none());
    assert_eq!(ui.mirror.runtime["c1"]["busy"], false);
    assert_same(&h, &mut ui, "c1");
}

#[tokio::test]
async fn an_error_without_a_code_has_none_and_a_stray_code_does_not_leak() {
    let (mut h, mut ui, _turn) = Harness::running("claude").await;
    h.emit(0, TurnEvent::Error("falhou".into())).await;
    ui.sync();
    assert!(last_event_body(&h, "c1").get("code").is_none());
    assert!(ui.chat("c1")["turns"][1].get("errorCode").is_none());

    // A code followed by a normal end is dropped: `done` never carries one.
    h.send(&ui, "c1", "de novo");
    h.settle().await;
    h.emit(1, TurnEvent::ErrorCode("cli_auth".into())).await;
    h.emit(1, TurnEvent::Done { aborted: false }).await;
    ui.sync();
    assert_eq!(last_event_body(&h, "c1")["kind"], "done");
    assert!(last_event_body(&h, "c1").get("code").is_none());
    assert!(ui.chat("c1")["turns"].as_array().unwrap().iter().all(|t| t.get("errorCode").is_none()));

    // And that code does not stick to a later failure (the run is gone).
    h.send(&ui, "c1", "mais uma");
    h.settle().await;
    h.emit(2, TurnEvent::Error("outra".into())).await;
    assert!(last_event_body(&h, "c1").get("code").is_none());
    assert_same(&h, &mut ui, "c1");
}

#[test]
fn claude_failures_with_a_code_report_it_before_the_error() {
    use super::runners::claude_events;
    let result = claude_events("agent:result", &json!({ "isError": true, "resultText": "Faça login", "code": "cli_auth", "sessionId": "s" }));
    let tail = &result[result.len() - 2..];
    assert_eq!(tail, [TurnEvent::ErrorCode("cli_auth".into()), TurnEvent::Error("Faça login".into())]);

    let error = claude_events("agent:error", &json!({ "message": "CLI ausente", "code": "cli_missing" }));
    assert_eq!(error, [TurnEvent::ErrorCode("cli_missing".into()), TurnEvent::Error("CLI ausente".into())]);

    // No code, an empty one or one that is not a string: just the error.
    for code in [json!(null), json!(""), json!(5)] {
        assert_eq!(claude_events("agent:error", &json!({ "message": "x", "code": code })), [TurnEvent::Error("x".into())]);
    }
    assert_eq!(claude_events("agent:error", &json!({ "message": "x" })), [TurnEvent::Error("x".into())]);
    // A successful result never reports a code.
    let ok = claude_events("agent:result", &json!({ "isError": false, "code": "cli_auth" }));
    assert!(!ok.iter().any(|e| matches!(e, TurnEvent::ErrorCode(_) | TurnEvent::Error(_))));
}

#[tokio::test]
async fn a_claude_auth_failure_ends_the_turn_with_its_code_through_the_runner_events() {
    use super::runners::claude_events;
    let (mut h, mut ui, _turn) = Harness::running("claude").await;
    for event in claude_events("agent:error", &json!({ "message": "Sessão expirada", "code": "cli_auth" })) {
        h.emit(0, event).await;
    }
    ui.sync();
    assert_eq!(ui.chat("c1")["turns"][1]["errorCode"], "cli_auth");
    assert_same(&h, &mut ui, "c1");
}

#[test]
fn claude_channels_become_the_right_turn_events() {
    use super::runners::claude_events;
    let events = |channel: &str, data: Value| claude_events(channel, &data);

    assert_eq!(
        events("agent:system", json!({ "id": "t", "sessionId": "s1", "fastMode": { "state": "cooldown", "reason": "limite" } })),
        [TurnEvent::Session("s1".into()), TurnEvent::Fast { state: "cooldown".into(), reason: Some("limite".into()) }]
    );
    assert_eq!(events("agent:system", json!({ "sessionId": "s1", "fastMode": { "state": "on" } }))[1], TurnEvent::Fast { state: "on".into(), reason: None });
    assert!(events("agent:system", json!({ "sessionId": "" })).is_empty(), "an empty session is ignored");
    assert!(events("agent:system", json!({ "fastMode": { "reason": "sem estado" } })).is_empty());
    assert_eq!(events("agent:text", json!({ "text": "olá" })), [TurnEvent::Text("olá".into())]);
    assert_eq!(events("agent:thinking", json!({ "text": "hm" })), [TurnEvent::Thinking("hm".into())]);
    assert_eq!(
        events("agent:tool", json!({ "toolId": "t1", "name": "Bash", "input": { "command": "ls" } })),
        [TurnEvent::Tool { tool_id: "t1".into(), name: json!("Bash"), input: Some(json!({ "command": "ls" })) }]
    );
    assert_eq!(events("agent:tool", json!({ "toolId": "t2", "name": "Read" })), [TurnEvent::Tool { tool_id: "t2".into(), name: json!("Read"), input: None }]);
    assert_eq!(
        events("agent:tool-result", json!({ "toolId": "t1", "content": "a.txt", "isError": true })),
        [TurnEvent::ToolResult { tool_id: "t1".into(), content: Some(json!("a.txt")), is_error: true }]
    );
    assert_eq!(events("agent:tool-result", json!({ "toolId": "t1" })), [TurnEvent::ToolResult { tool_id: "t1".into(), content: None, is_error: false }]);
    let permission = json!({ "id": "t", "permId": "p", "toolUseId": "t1" });
    assert_eq!(events("agent:permission", permission.clone()), [TurnEvent::Permission(permission)]);
    let question = json!({ "id": "t", "dialogId": "d" });
    assert_eq!(events("agent:question", question.clone()), [TurnEvent::Question(question)]);
    assert_eq!(events("agent:done", json!({ "id": "t", "aborted": true })), [TurnEvent::Done { aborted: true }]);
    assert_eq!(events("agent:done", json!({ "id": "t" })), [TurnEvent::Done { aborted: false }]);
    assert_eq!(events("agent:error", json!({ "message": "falhou" })), [TurnEvent::Error("falhou".into())]);
    assert!(events("agent:config", json!({ "x": 1 })).is_empty(), "unknown channels are dropped");
}

#[test]
fn a_claude_result_carries_metrics_session_and_fast_and_an_error_ends_the_turn() {
    use super::runners::claude_events;
    let ok = claude_events(
        "agent:result",
        &json!({ "sessionId": "s9", "usage": { "input_tokens": 3, "output_tokens": 4 }, "costUsd": 0.25, "model": "claude-haiku", "fastMode": { "state": "on" } }),
    );
    assert_eq!(
        ok,
        [
            TurnEvent::Metrics(json!({ "scope": "session", "inputTokens": 3, "outputTokens": 4, "costUsd": 0.25, "model": "claude-haiku" })),
            TurnEvent::Session("s9".into()),
            TurnEvent::Fast { state: "on".into(), reason: None },
        ]
    );

    let error = claude_events("agent:result", &json!({ "isError": true, "resultText": "Limite atingido", "subtype": "error_during_execution" }));
    assert_eq!(error.len(), 2);
    assert_eq!(error[1], TurnEvent::Error("Limite atingido".into()));
    let no_text = claude_events("agent:result", &json!({ "isError": true, "resultText": "", "subtype": "error_max_turns", "sessionId": "s" }));
    assert_eq!(no_text.last(), Some(&TurnEvent::Error("Claude encerrou com erro: error_max_turns".into())));
    assert!(no_text.contains(&TurnEvent::Session("s".into())), "the session is reported before the error ends the turn");
    let nothing = claude_events("agent:result", &json!({ "isError": 1 }));
    assert_eq!(nothing.last(), Some(&TurnEvent::Error("Claude encerrou com erro: undefined".into())));
    assert!(!claude_events("agent:result", &json!({ "isError": false })).iter().any(|e| matches!(e, TurnEvent::Error(_))));
}

#[tokio::test]
async fn a_claude_error_result_ends_the_turn_in_the_engine_with_the_message() {
    use super::runners::claude_events;
    let (mut h, mut ui, _turn) = Harness::running("claude").await;
    for event in claude_events("agent:result", &json!({ "isError": true, "resultText": "Sem créditos", "sessionId": "s1" })) {
        h.emit(0, event).await;
    }
    ui.sync();
    let chat = ui.chat("c1");
    assert_eq!(chat["turns"][1]["error"], true);
    assert_eq!(chat["turns"][1]["segments"].as_array().unwrap().last().unwrap()["text"], "Sem créditos");
    assert!(chat.get("resume").is_none(), "an error drops the session");
    assert_eq!(ui.mirror.runtime["c1"]["busy"], false);
    assert_same(&h, &mut ui, "c1");
}

// ---- CodexRunner over the real CodexSessions and a scripted app-server ----

mod codex {
    use std::time::Duration;

    use prism_agents::codex::{AppServer, BoxFuture as CodexFuture, CodexError, CodexSessions, Launcher};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    use super::*;
    use crate::domains::chats::CodexRunner;

    /// An app-server that starts a thread and a turn, shows a command item,
    /// asks one approval and completes the turn once it is answered.
    struct Scripted;

    impl Launcher for Scripted {
        fn check(&self, _profile_id: String) -> CodexFuture<'_, Result<(), CodexError>> {
            Box::pin(async { Ok(()) })
        }

        fn account(&self, _profile_id: String) -> CodexFuture<'_, Result<String, CodexError>> {
            Box::pin(async { Ok("ambient".to_string()) })
        }

        fn launch(&self, _profile_id: String, _cwd: Option<String>) -> CodexFuture<'_, Result<Arc<AppServer>, CodexError>> {
            Box::pin(async {
                let (client, server) = tokio::io::duplex(1 << 16);
                let (read, write) = tokio::io::split(client);
                let app = AppServer::from_io(read, write);
                tokio::spawn(async move {
                    let (server_read, mut server_write) = tokio::io::split(server);
                    let mut lines = BufReader::new(server_read).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let msg: Value = serde_json::from_str(&line).unwrap();
                        let replies = match (msg.get("method").and_then(Value::as_str), msg.get("id")) {
                            (Some("initialize"), Some(id)) => vec![json!({ "id": id, "result": {} })],
                            (Some("thread/start"), Some(id)) => vec![json!({ "id": id, "result": { "thread": { "id": "th" } } })],
                            (Some("turn/start"), Some(id)) => vec![
                                json!({ "id": id, "result": { "turn": { "id": "t1" } } }),
                                json!({ "method": "turn/started", "params": { "threadId": "th", "turn": { "id": "t1" } } }),
                                json!({ "method": "item/started", "params": { "threadId": "th", "turnId": "t1", "item": { "id": "c", "type": "commandExecution", "command": "ls", "status": "inProgress" } } }),
                                json!({ "id": 7, "method": "item/commandExecution/requestApproval", "params": { "threadId": "th", "turnId": "t1", "itemId": "c", "command": "ls" } }),
                            ],
                            (None, Some(_)) => vec![
                                json!({ "method": "item/completed", "params": { "threadId": "th", "turnId": "t1", "item": { "id": "c", "type": "commandExecution", "command": "ls", "exitCode": 0, "aggregatedOutput": "a.txt" } } }),
                                json!({ "method": "item/completed", "params": { "threadId": "th", "turnId": "t1", "item": { "id": "m", "type": "agentMessage", "text": "Pronto." } } }),
                                json!({ "method": "turn/completed", "params": { "threadId": "th", "turn": { "id": "t1", "status": "completed" } } }),
                            ],
                            _ => vec![],
                        };
                        for reply in replies {
                            server_write.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
                        }
                    }
                });
                Ok(app)
            })
        }
    }

    /// Lets the real tasks run until `done` holds for the mirror.
    async fn until(h: &mut Harness, ui: &mut Client, what: &str, done: impl Fn(&Client) -> bool) {
        for _ in 0..500 {
            h.settle().await;
            ui.sync();
            if done(ui) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timeout waiting for {what}: {:?}", ui.mirror.runtime);
    }

    fn harness() -> Harness {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let runner: Arc<dyn Runner> = Arc::new(CodexRunner::new(CodexSessions::new(Arc::new(Scripted))));
        let (tx, rx) = channel();
        let engine = Engine::new(Arc::clone(&store), Runners { claude: None, codex: Some(runner) }, Handle::current(), tx);
        Harness { engine, rx, fake: Arc::new(Fake::default()), store, activity: Activity::new() }
    }

    #[tokio::test]
    async fn a_full_codex_turn_through_the_engine_session_permission_answer_and_done() {
        let mut h = harness();
        let mut ui = h.client();
        h.subscribe(&mut ui);
        h.call(&ui, "create", json!({ "chat": new_chat("c1", "codex") })).unwrap();
        h.call(&ui, "create", json!({ "chat": new_chat("c2", "claude") })).unwrap();
        assert_eq!(code(h.call(&ui, "send", json!({ "chatId": "c2", "text": "oi" }))), ErrorCode::Invalid, "Claude is off in this host");

        let turn = h.call(&ui, "send", json!({ "chatId": "c1", "text": "liste" })).unwrap()["turnId"].as_str().unwrap().to_string();
        assert_eq!(h.activity.holds(), 1);
        until(&mut h, &mut ui, "the permission", |ui| ui.mirror.runtime.get("c1").is_some_and(|rt| rt.get("permission").is_some())).await;
        let permission = ui.mirror.runtime["c1"]["permission"].clone();
        assert_eq!(permission["permId"], "codex:c1:7");
        assert_eq!(permission["id"], turn.as_str());
        assert_eq!(permission["toolName"], "Bash");
        assert_eq!(ui.chat("c1")["resume"], json!({ "route": "codex:ambient-codex", "sessionId": "th" }), "the thread is the session");
        assert_eq!(ui.mirror.runtime["c1"]["busy"], true);
        let segments = ui.chat("c1")["turns"][1]["segments"].clone();
        assert_eq!(segments[0]["toolId"], "c");
        assert_eq!(segments[0]["status"], "awaiting", "the command waits for the answer");

        h.call(&ui, "respondPermission", json!({ "chatId": "c1", "permId": "codex:c1:7", "decision": "allow" })).unwrap();
        assert_eq!(code(h.call(&ui, "respondPermission", json!({ "chatId": "c1", "permId": "codex:c1:7", "decision": "allow" }))), ErrorCode::Gone);
        until(&mut h, &mut ui, "the end of the turn", |ui| ui.mirror.runtime["c1"]["busy"] == false).await;

        assert_eq!(h.activity.holds(), 0);
        let chat = ui.chat("c1");
        assert!(chat.get("pendingTurnId").is_none());
        assert_eq!(chat["turns"][1]["error"], false);
        let segments = chat["turns"][1]["segments"].as_array().unwrap();
        let command = segments.iter().find(|s| s["toolId"] == "c").unwrap();
        assert_eq!((command["status"].as_str(), command["result"].as_str()), (Some("done"), Some("a.txt")));
        assert!(segments.iter().any(|s| s["text"] == "Pronto."));
        assert_same(&h, &mut ui, "c1");
        let kinds: Vec<_> = h.store.events("c1").unwrap().iter().map(|e| e.kind().unwrap().to_string()).collect();
        assert_eq!((kinds.first().map(String::as_str), kinds.last().map(String::as_str)), (Some("begin"), Some("done")));
        assert!(kinds.iter().any(|k| k == "session"));
    }
}

// ---- ChatsDomain::exclusive: an account change with no turn in the way ----

mod exclusive {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use super::super::{ChatsDomain, Hold};
    use super::*;
    use crate::domain::{CallContext, Domain};
    use crate::domains::store::SharedStore;
    use crate::HostState;

    const REFUSAL: &str = "Pare as tarefas desta conta antes de mexer nela.";

    /// Runs `work` through the engine as an `Exclusive` message and answers at once.
    fn run(h: &mut Harness, provider: &str, profile: &str, hold: Hold, work: impl FnOnce() -> Result<(), HostError> + Send + 'static) -> Result<(), HostError> {
        let (reply, mut answer) = oneshot::channel();
        h.engine.handle(Msg::Exclusive { provider: provider.into(), profile_id: profile.into(), refusal: REFUSAL.into(), hold, work: Box::new(work), reply });
        answer.try_recv().expect("the engine answers an exclusive at once")
    }

    fn on_route(id: &str, provider: &str, profile: &str, resume: bool) -> Value {
        let mut chat = with(new_chat(id, provider), json!({ "selection": { "provider": provider, "profileId": profile, "model": "m" } }));
        if resume {
            chat["resume"] = json!({ "route": format!("{provider}:{profile}"), "sessionId": "s" });
        }
        chat
    }

    fn flag() -> (Arc<AtomicBool>, impl FnOnce() -> Result<(), HostError> + Send + 'static) {
        let ran = Arc::new(AtomicBool::new(false));
        let inner = Arc::clone(&ran);
        (ran, move || {
            inner.store(true, Ordering::SeqCst);
            Ok(())
        })
    }

    #[tokio::test]
    async fn a_turn_on_the_route_is_busy_with_the_given_message_and_the_work_never_runs() {
        let mut h = Harness::new();
        let ui = h.client();
        h.call(&ui, "create", json!({ "chat": on_route("a", "claude", "work", true) })).unwrap();
        h.send(&ui, "a", "oi");
        h.settle().await;

        let (ran, work) = flag();
        let err = run(&mut h, "claude", "work", Hold::ForgetSessions, work).unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (ErrorCode::Busy, REFUSAL));
        assert!(!ran.load(Ordering::SeqCst));
        assert!(h.stored("a").get("resume").is_some(), "the hold did not run either");

        // Once the turn ends the same call goes through.
        h.emit(0, TurnEvent::Done { aborted: false }).await;
        let (ran, work) = flag();
        run(&mut h, "claude", "work", Hold::Nothing, work).unwrap();
        assert!(ran.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_turn_on_another_account_or_provider_does_not_block() {
        let mut h = Harness::new();
        let ui = h.client();
        h.call(&ui, "create", json!({ "chat": on_route("a", "claude", "work", false) })).unwrap();
        h.send(&ui, "a", "oi");
        h.settle().await;

        for (provider, profile) in [("claude", "home"), ("codex", "work")] {
            let (ran, work) = flag();
            run(&mut h, provider, profile, Hold::Nothing, work).unwrap();
            assert!(ran.load(Ordering::SeqCst), "{provider}:{profile}");
        }
    }

    #[tokio::test]
    async fn forget_sessions_clears_only_the_resumes_of_the_route() {
        let mut h = Harness::new();
        let ui = h.client();
        for (id, provider, profile) in [("a", "claude", "work"), ("b", "claude", "home"), ("c", "codex", "work")] {
            h.call(&ui, "create", json!({ "chat": on_route(id, provider, profile, true) })).unwrap();
        }
        let (ran, work) = flag();
        run(&mut h, "claude", "work", Hold::ForgetSessions, work).unwrap();
        assert!(ran.load(Ordering::SeqCst));
        assert!(h.stored("a").get("resume").is_none());
        assert!(h.stored("b").get("resume").is_some(), "another account keeps its session");
        assert!(h.stored("c").get("resume").is_some(), "the same id on another provider keeps its session");
        assert_eq!(h.stored("a")["selection"]["profileId"], "work", "only the session goes");
    }

    #[tokio::test]
    async fn reassign_moves_the_chats_of_the_route_to_the_terminal_account() {
        let mut h = Harness::new();
        let ui = h.client();
        for (id, provider, profile) in [("a", "claude", "work"), ("b", "codex", "work"), ("c", "claude", "home")] {
            h.call(&ui, "create", json!({ "chat": on_route(id, provider, profile, true) })).unwrap();
        }
        run(&mut h, "claude", "work", Hold::Reassign, || Ok(())).unwrap();
        assert_eq!(h.stored("a")["selection"]["profileId"], "ambient-claude");
        assert_eq!(h.stored("c")["selection"]["profileId"], "home");
        assert!(h.stored("a").get("resume").is_none());
        // Moving the codex account of the same id is its own move, to ambient-codex.
        run(&mut h, "codex", "work", Hold::Reassign, || Ok(())).unwrap();
        assert_eq!(h.stored("b")["selection"]["profileId"], "ambient-codex");
    }

    #[tokio::test]
    async fn the_error_of_the_work_goes_back_to_the_caller() {
        let mut h = Harness::new();
        let err = run(&mut h, "claude", "work", Hold::Nothing, || Err(HostError::new(ErrorCode::Internal, "disco cheio"))).unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (ErrorCode::Internal, "disco cheio"));
    }

    fn real_domain(dir: &std::path::Path) -> (ChatsDomain, Arc<Fake>, CallContext, mpsc::UnboundedReceiver<String>) {
        let fake = Arc::new(Fake::default());
        let runner: Arc<dyn Runner> = Arc::new(FakeRunner(Arc::clone(&fake)));
        let domain = ChatsDomain::new(SharedStore::at(dir.join("prism-host.db")), Runners { claude: Some(Arc::clone(&runner)), codex: Some(runner) });
        let (tx, notes) = mpsc::unbounded_channel();
        let ctx = CallContext {
            user: owner(),
            notifier: Notifier::new(next_client_id(), tx),
            state: HostState::with_domains("t".into(), "h".into(), "Máquina".into(), "qa".into(), Vec::new()),
        };
        (domain, fake, ctx, notes)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_send_during_the_work_is_handled_only_after_the_work_ends() {
        let dir = tempfile::tempdir().unwrap();
        let (domain, fake, ctx, _notes) = real_domain(dir.path());
        domain.call("create", json!({ "chat": new_chat("c1", "claude") }), ctx.clone()).unwrap().await.unwrap();

        let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let starts_at_end = Arc::new(Mutex::new(None));
        let seen = Arc::clone(&starts_at_end);
        let probe = Arc::clone(&fake);
        let exclusive = domain.exclusive("claude", "ambient-claude", REFUSAL, Hold::Nothing, move || {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            *seen.lock().unwrap() = Some(probe.starts.lock().unwrap().len());
            Ok(())
        });
        let exclusive = tokio::spawn(exclusive);
        tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(20)).expect("the work never started")).await.unwrap();

        // The engine is inside `work`: a send queues behind it.
        let send = tokio::spawn(domain.call("send", json!({ "chatId": "c1", "text": "oi" }), ctx.clone()).unwrap());
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!send.is_finished(), "the send must wait for the work");
        assert!(fake.starts.lock().unwrap().is_empty(), "no turn starts in the middle of the work");

        release_tx.send(()).unwrap();
        exclusive.await.unwrap().unwrap();
        let sent = tokio::time::timeout(Duration::from_secs(20), send).await.expect("the send never answered").unwrap().unwrap();
        assert!(sent["turnId"].is_string());
        assert_eq!(*starts_at_end.lock().unwrap(), Some(0), "no turn had started when the work ended");
        for _ in 0..200 {
            if !fake.starts.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(fake.starts.lock().unwrap().len(), 1, "the send ran once the work was done");
    }

    #[tokio::test]
    async fn reassign_profile_and_forget_sessions_over_rpc_need_the_owner() {
        let mut h = Harness::new();
        let ui = h.client();
        h.call(&ui, "create", json!({ "chat": on_route("a", "claude", "work", true) })).unwrap();
        let member = UserInfo { id: "m".into(), name: "membro".into(), role: Role::Member };
        for (method, params) in [("reassignProfile", json!({ "profileId": "work" })), ("forgetSessions", json!({ "provider": "claude", "id": "work" }))] {
            let (reply, mut answer) = oneshot::channel();
            h.engine.handle(Msg::Call {
                method: method.into(),
                params: params.clone(),
                user: member.clone(),
                client: ui.id,
                notifier: ui.notifier.clone(),
                activity: Arc::clone(&h.activity),
                reply,
            });
            assert_eq!(answer.try_recv().unwrap().unwrap_err().code, ErrorCode::Forbidden, "{method}");
            assert!(h.stored("a").get("resume").is_some(), "{method} touched nothing");
            assert_eq!(h.stored("a")["selection"]["profileId"], "work");
        }
        // The owner may.
        h.call(&ui, "forgetSessions", json!({ "provider": "claude", "id": "work" })).unwrap();
        assert!(h.stored("a").get("resume").is_none());
        assert_eq!(h.call(&ui, "reassignProfile", json!({ "profileId": "work" })).unwrap(), json!({ "moved": 1 }));
    }
}

// ---- what the host's own callers use: changes_of, watch, peek, command ----

mod host_api {
    use std::time::Duration;

    use prism_protocol::chats::{
        AppendKind, ChatDelta, ChatPatch, ChatRef, ChatRuntime, ChatRuntimeUpdate, ChatUpsert, TurnAppend, TurnMetrics, TurnSegment, TurnUpsert,
    };

    use super::super::engine::changes_of;
    use super::super::{ChatChange, ChatsDomain};
    use super::*;
    use crate::domain::{CallContext, Domain};
    use crate::domains::store::SharedStore;
    use crate::HostState;

    fn changed(id: &str) -> ChatChange {
        ChatChange::Changed(id.into())
    }

    fn patch(id: &str, fields: Value) -> ChatDelta {
        ChatDelta::Patch(ChatPatch { chat_id: id.into(), patch: fields.as_object().unwrap().clone() })
    }

    fn upsert(chat: Value) -> ChatDelta {
        ChatDelta::Chat(ChatUpsert { chat })
    }

    fn runtime(id: &str) -> ChatDelta {
        ChatDelta::Runtime(ChatRuntimeUpdate {
            chat_id: id.into(),
            runtime: Some(ChatRuntime { turn_id: "t".into(), route: "claude:x".into(), busy: true, permission: None, question: None, fast: None }),
        })
    }

    #[test]
    fn changes_of_names_every_kind_of_delta_by_its_chat() {
        let deltas = vec![
            upsert(json!({ "id": "a" })),
            ChatDelta::Turn(TurnUpsert { chat_id: "b".into(), turn: json!({ "id": "t" }) }),
            ChatDelta::Append(TurnAppend { chat_id: "c".into(), turn_id: "t".into(), kind: AppendKind::Text, text: "x".into() }),
            ChatDelta::Segment(TurnSegment { chat_id: "d".into(), turn_id: "t".into(), segment: json!({}) }),
            ChatDelta::Metrics(TurnMetrics { chat_id: "e".into(), turn_id: "t".into(), metrics: json!({}) }),
            runtime("f"),
            patch("g", json!({ "title": "x" })),
        ];
        let expected: Vec<_> = ["a", "b", "c", "d", "e", "f", "g"].into_iter().map(changed).collect();
        assert_eq!(changes_of(&deltas), expected);
        assert!(changes_of(&[]).is_empty());
    }

    #[test]
    fn changes_of_is_one_per_chat_in_the_order_of_the_first_touch() {
        let deltas = vec![runtime("b"), runtime("a"), runtime("b"), patch("a", json!({ "title": "y" })), runtime("c")];
        assert_eq!(changes_of(&deltas), vec![changed("b"), changed("a"), changed("c")]);
    }

    #[test]
    fn changes_of_an_archive_is_a_patch_or_a_chat_with_archived_truthy() {
        assert_eq!(changes_of(&[patch("a", json!({ "archived": true }))]), vec![ChatChange::Archived("a".into())]);
        assert_eq!(changes_of(&[upsert(json!({ "id": "a", "archived": true }))]), vec![ChatChange::Archived("a".into())]);
        // Un-archiving (the field deleted, or false) is just a change.
        assert_eq!(changes_of(&[patch("a", json!({ "archived": null }))]), vec![changed("a")]);
        assert_eq!(changes_of(&[patch("a", json!({ "archived": false }))]), vec![changed("a")]);
        assert_eq!(changes_of(&[upsert(json!({ "id": "a" }))]), vec![changed("a")]);
    }

    #[test]
    fn changes_of_an_archive_or_a_removal_wins_over_an_earlier_change_in_its_slot() {
        let removal = ChatDelta::Remove(ChatRef { chat_id: "a".into() });
        assert_eq!(changes_of(&[runtime("x"), runtime("a"), removal.clone()]), vec![changed("x"), ChatChange::Removed("a".into())]);
        assert_eq!(changes_of(&[runtime("a"), runtime("x"), patch("a", json!({ "archived": true }))]), vec![ChatChange::Archived("a".into()), changed("x")]);
        // And a later change does not undo it.
        assert_eq!(changes_of(&[removal, runtime("a")]), vec![ChatChange::Removed("a".into())]);
        assert_eq!(changes_of(&[patch("a", json!({ "archived": true })), runtime("a")]), vec![ChatChange::Archived("a".into())]);
    }

    struct Rig {
        domain: ChatsDomain,
        fake: Arc<Fake>,
        ctx: CallContext,
        store: Arc<SharedStore>,
        _dir: tempfile::TempDir,
        _notes: mpsc::UnboundedReceiver<String>,
    }

    fn rig() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let fake = Arc::new(Fake::default());
        let runner: Arc<dyn Runner> = Arc::new(FakeRunner(Arc::clone(&fake)));
        let store = SharedStore::at(dir.path().join("prism-host.db"));
        let domain = ChatsDomain::new(Arc::clone(&store), Runners { claude: Some(Arc::clone(&runner)), codex: Some(runner) });
        let (tx, notes) = mpsc::unbounded_channel();
        let ctx = CallContext {
            user: owner(),
            notifier: Notifier::new(next_client_id(), tx),
            state: HostState::with_domains("t".into(), "h".into(), "Máquina".into(), "qa".into(), Vec::new()),
        };
        Rig { domain, fake, ctx, store, _dir: dir, _notes: notes }
    }

    impl Rig {
        async fn call(&self, method: &str, params: Value) -> Result<Value, HostError> {
            self.domain.call(method, params, self.ctx.clone()).unwrap().await
        }

        fn phone(&self, chat: &str) -> UserInfo {
            UserInfo { id: format!("celular · {chat}"), name: "Celular".into(), role: Role::Owner }
        }

        async fn started(&self) {
            for _ in 0..800 {
                if !self.fake.starts.lock().unwrap().is_empty() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("the turn never reached the runner");
        }
    }

    async fn next(rx: &mut mpsc::UnboundedReceiver<Vec<ChatChange>>) -> Vec<ChatChange> {
        tokio::time::timeout(Duration::from_secs(20), rx.recv()).await.expect("no batch arrived").expect("the watch ended")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn watch_receives_each_published_batch_as_changes() {
        let r = rig();
        let mut rx = r.domain.watch();
        r.call("create", json!({ "chat": new_chat("c1", "claude") })).await.unwrap();
        r.call("create", json!({ "chat": new_chat("c2", "claude") })).await.unwrap();
        // Batches may merge the two creates; each chat is named once per batch.
        let mut seen = Vec::new();
        while !(seen.contains(&changed("c1")) && seen.contains(&changed("c2"))) {
            let batch = next(&mut rx).await;
            let mut ids: Vec<_> = batch.iter().map(|c| c.chat_id().to_string()).collect();
            ids.sort();
            ids.dedup();
            assert_eq!(ids.len(), batch.len(), "one change per chat in a batch: {batch:?}");
            seen.extend(batch);
        }

        r.call("archive", json!({ "chatId": "c1", "archived": true })).await.unwrap();
        while !next(&mut rx).await.contains(&ChatChange::Archived("c1".into())) {}
        r.call("remove", json!({ "chatId": "c2" })).await.unwrap();
        while !next(&mut rx).await.contains(&ChatChange::Removed("c2".into())) {}
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_watcher_gets_only_what_is_published_after_it_started() {
        let r = rig();
        r.call("create", json!({ "chat": new_chat("old", "claude") })).await.unwrap();
        r.domain.peek("old").await.unwrap(); // flushed before the watchers exist
        let (mut a, mut b) = (r.domain.watch(), r.domain.watch());
        r.call("create", json!({ "chat": new_chat("new", "claude") })).await.unwrap();
        for rx in [&mut a, &mut b] {
            assert_eq!(next(rx).await, vec![changed("new")]);
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dropped_watch_stops_nothing_for_the_others() {
        let r = rig();
        let dead = r.domain.watch();
        let mut live = r.domain.watch();
        drop(dead);
        r.call("create", json!({ "chat": new_chat("c1", "claude") })).await.unwrap();
        assert_eq!(next(&mut live).await, vec![changed("c1")]);
        r.call("rename", json!({ "chatId": "c1", "title": "Outro" })).await.unwrap();
        assert_eq!(next(&mut live).await, vec![changed("c1")]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn peek_of_a_missing_chat_is_none() {
        let r = rig();
        assert!(r.domain.peek("nope").await.unwrap().is_none());
        r.call("create", json!({ "chat": new_chat("c1", "claude") })).await.unwrap();
        assert!(r.domain.peek("nope").await.unwrap().is_none());
        let (chat, runtime) = r.domain.peek("c1").await.unwrap().unwrap();
        assert_eq!(chat["id"], "c1");
        assert!(runtime.is_none(), "no turn ran yet");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn peek_folds_what_is_still_queued_and_returns_the_runtime() {
        let r = rig();
        r.call("create", json!({ "chat": new_chat("c1", "claude") })).await.unwrap();
        let sent = r.domain.command("send", json!({ "chatId": "c1", "text": "oi" }), r.phone("c1"), Activity::new()).await.unwrap();
        let turn = sent["turnId"].as_str().unwrap().to_string();
        r.started().await;
        let sink = r.fake.starts.lock().unwrap()[0].1.clone();
        sink.send(TurnEvent::Text("Olá".into()));
        sink.send(TurnEvent::Text(" mundo".into()));
        // The text sits in the engine's queue until its flush deadline; peek must see it anyway.
        let mut text = Value::Null;
        for _ in 0..800 {
            let (chat, runtime) = r.domain.peek("c1").await.unwrap().unwrap();
            let runtime = runtime.expect("a turn ran");
            assert_eq!((runtime.turn_id.as_str(), runtime.busy), (turn.as_str(), true));
            let segments = chat["turns"][1]["segments"].as_array().cloned().unwrap_or_default();
            if let Some(found) = segments.iter().find(|s| s["kind"] == "text") {
                text = found["text"].clone();
                if text == "Olá mundo" {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(text, "Olá mundo");
        let stored = r.store.get().unwrap().chat("c1").unwrap().unwrap();
        assert_eq!(stored["turns"][1]["segments"][0]["text"], "Olá mundo", "the peek flushed it to the journal");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn command_journals_the_actor_of_the_begin_event() {
        let r = rig();
        r.call("create", json!({ "chat": new_chat("c1", "claude") })).await.unwrap();
        let sent = r.domain.command("send", json!({ "chatId": "c1", "text": "faça" }), r.phone("c1"), Activity::new()).await.unwrap();
        assert!(sent["turnId"].is_string());
        r.domain.peek("c1").await.unwrap();
        let events = r.store.get().unwrap().events("c1").unwrap();
        assert_eq!(events[0].kind(), Some("begin"));
        assert_eq!(events[0].actor.as_deref(), Some("celular · c1"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn command_journals_the_actor_of_a_permission_answer_and_returns_engine_errors() {
        let r = rig();
        r.call("create", json!({ "chat": new_chat("c1", "claude") })).await.unwrap();
        let actor = r.phone("c1");
        let sent = r.domain.command("send", json!({ "chatId": "c1", "text": "x" }), actor.clone(), Activity::new()).await.unwrap();
        let turn = sent["turnId"].as_str().unwrap().to_string();
        r.started().await;
        let sink = r.fake.starts.lock().unwrap()[0].1.clone();
        sink.send(TurnEvent::Tool { tool_id: "t1".into(), name: json!("Bash"), input: None });
        sink.send(TurnEvent::Permission(json!({ "id": turn, "permId": "p1", "toolName": "Bash", "toolUseId": "t1" })));
        for _ in 0..800 {
            let (_, runtime) = r.domain.peek("c1").await.unwrap().unwrap();
            if runtime.and_then(|rt| rt.permission).is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let allow = json!({ "chatId": "c1", "permId": "p1", "decision": "allow" });
        r.domain.command("respondPermission", allow.clone(), actor.clone(), Activity::new()).await.unwrap();
        assert_eq!(r.fake.permissions.lock().unwrap().as_slice(), &[("c1".to_string(), "p1".to_string(), "allow".to_string())]);
        let again = r.domain.command("respondPermission", allow, actor, Activity::new()).await;
        assert_eq!(again.unwrap_err().code, ErrorCode::Gone, "an answered permission is gone");

        r.domain.peek("c1").await.unwrap();
        let events = r.store.get().unwrap().events("c1").unwrap();
        let answered: Vec<_> = events
            .iter()
            .filter(|e| e.kind() == Some("segment") && e.event["segment"]["toolId"] == "t1" && e.actor.is_some())
            .map(|e| e.actor.clone().unwrap())
            .collect();
        assert_eq!(answered, ["celular · c1"], "the answer's segment carries the phone as its actor");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn command_on_a_missing_chat_or_method_is_refused() {
        let r = rig();
        let err = r.domain.command("send", json!({ "chatId": "nope", "text": "x" }), r.phone("nope"), Activity::new()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        let err = r.domain.command("bogus", json!({}), r.phone("x"), Activity::new()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::MethodNotFound);
    }
}

#[tokio::test]
async fn steering_is_persisted_in_the_existing_turn_and_mirrored_without_a_restart() {
    let mut h = Harness::new();
    let mut client = h.client();
    h.call(&client, "create", json!({ "chat": new_chat("c", "claude") })).unwrap();
    h.subscribe(&mut client);
    let started = h.call(&client, "send", json!({ "chatId": "c", "text": "start" })).unwrap();
    h.settle().await;
    let turn = started["turnId"].as_str().unwrap();
    let (reply, answer) = oneshot::channel();
    h.engine.handle(Msg::Call {
        method: "steer".into(), params: json!({"chatId":"c","turnId":turn,"text":"send now","context":"file context","images":[{"mime":"image/png","data":"aGVsbG8="}]}),
        user: owner(), client: client.id, notifier: client.notifier.clone(), activity: Arc::clone(&h.activity), reply,
    });
    h.settle().await;
    assert!(answer.await.unwrap().is_ok());
    client.sync();
    assert_eq!(h.fake.starts.lock().unwrap().len(), 1);
    assert!(h.fake.aborts.lock().unwrap().is_empty());
    assert_eq!(h.fake.steers.lock().unwrap()[0].2, "send now\n\n[Referências de imagens anexadas]\nAnexo 1 = #image 1\n\nfile context");
    let stored = h.stored("c");
    assert_eq!(client.chat("c"), stored);
    let segments = stored["turns"][1]["segments"].as_array().unwrap();
    let marker = segments.iter().find(|segment| segment["kind"] == "user").unwrap();
    assert_eq!(marker["text"], "send now\n\nfile context");
    assert_eq!(marker["images"][0]["data"], "aGVsbG8=");
    h.call(&client, "stop", json!({"chatId":"c"})).unwrap();
    h.emit(0, TurnEvent::Done { aborted: false }).await;
    assert_eq!(h.stored("c")["turns"][1]["interrupted"], true);
}


#[tokio::test]
async fn shared_queue_survives_clients_and_uses_the_new_selection_in_order() {
    let (mut h, mut first, _) = Harness::running("claude").await;
    let a = h.call(&first, "queue", json!({"chatId": "c1", "operation": "add", "message": {"text": "second"}})).unwrap();
    assert_eq!(a["ok"], true);
    h.call(&first, "queue", json!({"chatId": "c1", "operation": "add", "message": {"text": "third"}})).unwrap();
    let mut selection = h.stored("c1")["selection"].clone(); selection["model"] = json!("sonnet");
    h.call(&first, "configure", json!({"chatId": "c1", "selection": selection})).unwrap();
    let mut phone = h.client(); h.subscribe(&mut phone);
    assert_eq!(phone.chat("c1")["queued"].as_array().unwrap().len(), 2);
    h.engine.handle(Msg::Disconnected(first.id));
    h.emit(0, TurnEvent::Done { aborted: false }).await;
    assert_eq!(h.fake.starts.lock().unwrap().len(), 2);
    assert!(h.fake.starts.lock().unwrap()[1].0.prompt.ends_with("second"));
    assert_eq!(h.fake.starts.lock().unwrap()[1].0.selection["model"], "sonnet");
    assert_eq!(h.stored("c1")["queued"].as_array().unwrap().len(), 1);
    h.emit(1, TurnEvent::Done { aborted: false }).await;
    assert_eq!(h.fake.starts.lock().unwrap().len(), 3);
    assert!(h.fake.starts.lock().unwrap()[2].0.prompt.ends_with("third"));
    assert!(h.stored("c1")["queued"].as_array().unwrap().is_empty());
    first.sync(); phone.sync();
    assert_eq!(phone.chat("c1"), h.stored("c1"));
}

#[tokio::test]
async fn stop_pauses_shared_queue_and_resume_sends_exactly_once() {
    let (mut h, ui, _) = Harness::running("claude").await;
    h.call(&ui, "queue", json!({"chatId": "c1", "operation": "add", "message": {"text": "kept"}})).unwrap();
    h.call(&ui, "stop", json!({"chatId": "c1"})).unwrap();
    h.emit(0, TurnEvent::Done { aborted: true }).await;
    assert_eq!(h.fake.starts.lock().unwrap().len(), 1);
    assert_eq!(h.stored("c1")["queued"][0]["text"], "kept");
    assert_eq!(h.stored("c1")["queuePaused"], true);
    h.call(&ui, "queue", json!({"chatId": "c1", "operation": "pause", "paused": false})).unwrap();
    h.call(&ui, "queue", json!({"chatId": "c1", "operation": "flush"})).unwrap();
    h.settle().await;
    assert_eq!(h.fake.starts.lock().unwrap().len(), 2);
    assert!(h.stored("c1")["queued"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn accept_edits_resolves_workspace_edit_but_never_commands_or_outside_paths() {
    let dir = tempfile::tempdir().unwrap();
    let mut h = Harness::new(); let ui = h.client();
    let mut chat = new_chat("c1", "claude"); chat["cwd"] = json!(dir.path().to_str().unwrap());
    h.call(&ui, "create", json!({"chat": chat})).unwrap();
    h.call(&ui, "send", json!({"chatId": "c1", "text": "edit"})).unwrap(); h.settle().await;
    h.emit(0, TurnEvent::Permission(json!({"permId": "edit", "toolName": "Edit", "input": {"file_path": dir.path().join("new.txt").to_str().unwrap()}}))).await;
    assert!(h.fake.permissions.lock().unwrap().is_empty());
    let mut selection = h.stored("c1")["selection"].clone(); selection["permissionMode"] = json!("acceptEdits");
    h.call(&ui, "configure", json!({"chatId": "c1", "selection": selection})).unwrap();
    assert_eq!(h.fake.permissions.lock().unwrap().as_slice(), &[("c1".into(), "edit".into(), "allow".into())]);
    h.emit(0, TurnEvent::Permission(json!({"permId": "command", "toolName": "Bash", "input": {"command": "echo hi"}}))).await;
    h.emit(0, TurnEvent::Permission(json!({"permId": "outside", "toolName": "Write", "input": {"file_path": "new/../../outside.txt"}}))).await;
    h.emit(0, TurnEvent::Permission(json!({"permId": "blocked", "toolName": "Write", "blockedPath": "protected", "input": {"file_path": "safe.txt"}}))).await;
    assert_eq!(h.fake.permissions.lock().unwrap().len(), 1);
}


#[tokio::test]
async fn stop_cancels_a_stalled_start_and_the_next_message_can_run() {
    let mut h = Harness::new();
    let mut ui = h.client();
    h.subscribe(&mut ui);
    h.call(&ui, "create", json!({"chat":new_chat("c", "claude")})).unwrap();
    h.fake.stall_start.store(true, std::sync::atomic::Ordering::SeqCst);
    let first = h.call(&ui, "send", json!({"chatId":"c", "text":"first"})).unwrap();
    h.settle().await;
    h.call(&ui, "stop", json!({"chatId":"c"})).unwrap();
    h.settle().await;
    ui.sync();
    assert_ne!(ui.mirror.runtime.get("c").and_then(|rt| rt.get("busy")), Some(&json!(true)));
    assert_eq!(h.stored("c")["turns"][1]["interrupted"], true);
    assert_eq!(h.activity.holds(), 0);
    h.fake.stall_start.store(false, std::sync::atomic::Ordering::SeqCst);
    let second = h.call(&ui, "send", json!({"chatId":"c", "text":"second"})).unwrap();
    h.settle().await;
    // A completion from the cancelled start may never clear the new turn.
    h.engine.handle(Msg::Started {chat_id:"c".into(), turn_id:first["turnId"].as_str().unwrap().into(), result:Ok(())});
    ui.sync();
    assert_eq!(ui.mirror.runtime["c"]["turnId"], second["turnId"]);
    h.emit(1, TurnEvent::Done {aborted:false}).await;
    ui.sync();
    assert_ne!(ui.mirror.runtime.get("c").and_then(|rt| rt.get("busy")), Some(&json!(true)));
}

#[tokio::test]
async fn a_panicking_second_launch_ends_with_an_error_and_the_chat_can_continue() {
    let (mut h, mut ui, _) = Harness::running("claude").await;
    h.emit(0, TurnEvent::Session("native-session".into())).await;
    h.finish(&mut ui, 0).await;
    h.fake.panic_start.store(true, std::sync::atomic::Ordering::SeqCst);
    let failed = h.send(&ui, "c1", "second message");
    h.settle().await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["c1"]["busy"], false);
    assert_eq!(h.stored("c1")["turns"][3]["error"], true);
    assert!(h.stored("c1")["turns"][3]["segments"][0]["text"].as_str().unwrap().contains("falhou ao iniciar"));
    assert!(h.stored("c1").get("pendingTurnId").is_none());
    assert_eq!(h.activity.holds(), 0);
    assert!(h.fake.aborts.lock().unwrap().contains(&("c1".into(), failed)));

    h.fake.panic_start.store(false, std::sync::atomic::Ordering::SeqCst);
    let next = h.send(&ui, "c1", "retry without restarting the host");
    h.settle().await;
    h.emit(1, TurnEvent::Done { aborted: true }).await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["c1"]["turnId"], next);
    assert_eq!(ui.mirror.runtime["c1"]["busy"], true, "the failed launch cannot close the retry");
    h.finish(&mut ui, 2).await;
    assert_eq!(ui.mirror.runtime["c1"]["busy"], false);
    assert_eq!(h.activity.holds(), 0);
    assert_same(&h, &mut ui, "c1");
}

#[tokio::test]
async fn a_panicking_runner_constructor_does_not_terminate_the_chats_actor() {
    let mut h = Harness::new();
    let mut ui = h.client();
    h.subscribe(&mut ui);
    h.call(&ui, "create", json!({ "chat": new_chat("c", "claude") })).unwrap();
    h.fake.panic_constructor.store(true, std::sync::atomic::Ordering::SeqCst);
    h.send(&ui, "c", "first");
    h.settle().await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["c"]["busy"], false);
    assert_eq!(h.stored("c")["turns"][1]["error"], true);
    assert_eq!(h.activity.holds(), 0);
    h.fake.panic_constructor.store(false, std::sync::atomic::Ordering::SeqCst);
    h.send(&ui, "c", "second");
    h.settle().await;
    h.emit(1, TurnEvent::Done { aborted: false }).await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["c"]["busy"], false);
    assert_eq!(h.activity.holds(), 0);
    assert_same(&h, &mut ui, "c");
}

#[tokio::test]
async fn stop_recovers_a_completed_startup_even_before_its_notification_is_handled() {
    let mut h = Harness::new();
    let mut ui = h.client();
    h.subscribe(&mut ui);
    h.call(&ui, "create", json!({ "chat": new_chat("c", "claude") })).unwrap();
    h.send(&ui, "c", "first");
    let mut accepted = None;
    // Hold the launch notification while its task finishes: Stop must not
    // depend on that notification or on the provider eventually sending Done.
    for _ in 0..100 {
        tokio::task::yield_now().await;
        if let Ok(message) = h.rx.try_recv() {
            accepted = Some(message);
            break;
        }
    }
    let accepted = accepted.expect("the provider launch completed");
    assert!(matches!(&accepted, Msg::Started { result: Ok(()), .. }));
    h.call(&ui, "stop", json!({ "chatId": "c" })).unwrap();
    h.settle().await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["c"]["busy"], false);
    assert_eq!(h.stored("c")["turns"][1]["interrupted"], true);
    assert_eq!(h.activity.holds(), 0);
    let next = h.send(&ui, "c", "second");
    h.engine.handle(accepted);
    h.settle().await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["c"]["turnId"], next);
    assert_eq!(ui.mirror.runtime["c"]["busy"], true);
    h.emit(1, TurnEvent::Done { aborted: false }).await;
    ui.sync();
    assert_eq!(ui.mirror.runtime["c"]["busy"], false);
    assert_eq!(h.activity.holds(), 0);
}
