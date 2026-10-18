//! Codex against fake app-servers over in-memory pipes. No real account,
//! CLI, `~/.codex` or prompt is touched.
//!
//! - `fixtures/catalog-0.142.5.jsonl`: traffic recorded from the real
//!   `codex app-server` 0.142.5 with a throwaway `CODEX_HOME` and no login
//!   (paths and ids replaced).
//! - `fixtures/turn-*.jsonl`: turns written from the 0.142.5 protocol types
//!   (`codex app-server generate-ts`), replayed message by message.
//! - A scripted peer for the edge cases, ported from tests/native-codex.test.cjs
//!   and tests/codex-reset-and-plan.test.cjs.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Notify, mpsc};

use super::convert::*;
use super::server::{AppServer, Incoming};
use super::session::*;
use super::*;

const CATALOG: &str = include_str!("fixtures/catalog-0.142.5.jsonl");
const TURN_BASIC: &str = include_str!("fixtures/turn-basic.jsonl");
const TURN_INTERRUPT: &str = include_str!("fixtures/turn-interrupt.jsonl");

async fn eventually(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !cond() {
        assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/* ---------------- In-memory app-server ---------------- */

/// The server end of a pipe: what the client wrote, and a way to write back.
/// When the client stops writing (it closed), the "process" exits too.
struct Pipe {
    from_client: mpsc::UnboundedReceiver<Value>,
    to_client: mpsc::UnboundedSender<Vec<u8>>,
    hang_up: Arc<Notify>,
}

fn pipe() -> (Arc<AppServer>, Pipe) {
    let (client, server) = tokio::io::duplex(1 << 16);
    let (client_read, client_write) = tokio::io::split(client);
    let app = AppServer::from_io(client_read, client_write);
    let (server_read, mut server_write) = tokio::io::split(server);
    let (from_tx, from_client) = mpsc::unbounded_channel();
    let (to_client, mut to_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let hang_up = Arc::new(Notify::new());
    let eof = Arc::clone(&hang_up);
    tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(value) = serde_json::from_str::<Value>(&line)
                && from_tx.send(value).is_err()
            {
                break;
            }
        }
        eof.notify_one();
    });
    let stop = Arc::clone(&hang_up);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                bytes = to_rx.recv() => {
                    let Some(bytes) = bytes else { break };
                    if server_write.write_all(&bytes).await.is_err() { break; }
                }
                _ = stop.notified() => break,
            }
        }
        let _ = server_write.shutdown().await;
    });
    (app, Pipe { from_client, to_client, hang_up })
}

type Responder = Arc<dyn Fn(&str, &Value, usize) -> Option<Value> + Send + Sync>;

/// A scripted app-server: records what the client sent and answers requests
/// through a responder (`None` leaves the request to the test; a result with
/// `__error` answers with that error message).
#[derive(Clone)]
struct Fake {
    index: usize,
    received: Arc<Mutex<Vec<Value>>>,
    to_client: mpsc::UnboundedSender<Vec<u8>>,
    hang_up: Arc<Notify>,
}

impl Fake {
    fn start(index: usize, responder: Responder) -> (Arc<AppServer>, Fake) {
        let (app, mut pipe) = pipe();
        let fake = Fake { index, received: Arc::default(), to_client: pipe.to_client.clone(), hang_up: Arc::clone(&pipe.hang_up) };
        let peer = fake.clone();
        tokio::spawn(async move {
            while let Some(msg) = pipe.from_client.recv().await {
                peer.received.lock().unwrap().push(msg.clone());
                let (Some(method), Some(id)) = (msg.get("method").and_then(Value::as_str), msg.get("id")) else { continue };
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let result = if method == "initialize" { Some(json!({})) } else { responder(method, &params, peer.index) };
                match result {
                    Some(result) if result.get("__error").is_some() => peer.send(json!({ "id": id, "error": { "code": -32600, "message": result["__error"] } })),
                    Some(result) => peer.send(json!({ "id": id, "result": result })),
                    None => {}
                }
            }
        });
        (app, fake)
    }

    fn send(&self, value: Value) {
        let _ = self.to_client.send(format!("{value}\n").into_bytes());
    }

    fn notify(&self, method: &str, params: Value) {
        self.send(json!({ "method": method, "params": params }));
    }

    fn request(&self, id: impl Into<Value>, method: &str, params: Value) {
        self.send(json!({ "id": id.into(), "method": method, "params": params }));
    }

    fn hang_up(&self) {
        self.hang_up.notify_one();
    }

    /// Requests and notifications the client sent with `method`, as full messages.
    fn calls(&self, method: &str) -> Vec<Value> {
        self.received.lock().unwrap().iter().filter(|m| m.get("method").and_then(Value::as_str) == Some(method)).cloned().collect()
    }

    fn methods(&self) -> Vec<String> {
        self.received
            .lock()
            .unwrap()
            .iter()
            .filter_map(|m| m.get("method").and_then(Value::as_str))
            .filter(|m| !m.starts_with("initialize"))
            .map(str::to_string)
            .collect()
    }

    /// The client's answers to server requests.
    fn answers(&self) -> Vec<Value> {
        self.received.lock().unwrap().iter().filter(|m| m.get("method").is_none()).cloned().collect()
    }
}

/// Whether every field of `expected` is in `actual` with the same value
/// (objects recursively; arrays and scalars exactly).
fn subset(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) => e.iter().all(|(k, v)| a.get(k).is_some_and(|x| subset(v, x))),
        _ => expected == actual,
    }
}

fn transcript(text: &str) -> Vec<(String, Value)> {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let entry: Value = serde_json::from_str(l).unwrap_or_else(|err| panic!("bad fixture line {l}: {err}"));
            (entry["dir"].as_str().unwrap().to_string(), entry["msg"].clone())
        })
        .collect()
}

/// Replays a transcript: `<` lines are sent (responses get the id the
/// client really used), `>` lines must match what the client sends next.
fn replay(text: &str) -> (Arc<AppServer>, tokio::task::JoinHandle<Result<(), String>>) {
    let entries = transcript(text);
    let (app, mut pipe) = pipe();
    let handle = tokio::spawn(async move {
        let mut ids: HashMap<String, Value> = HashMap::new();
        for (step, (dir, msg)) in entries.into_iter().enumerate() {
            if dir == "<" {
                let mut msg = msg;
                if msg.get("method").is_none()
                    && let Some(id) = msg.get("id").and_then(|id| ids.get(&id.to_string()))
                {
                    msg["id"] = id.clone();
                }
                let _ = pipe.to_client.send(format!("{msg}\n").into_bytes());
                continue;
            }
            let actual = match tokio::time::timeout(Duration::from_secs(10), pipe.from_client.recv()).await {
                Ok(Some(actual)) => actual,
                _ => return Err(format!("passo {step}: o cliente não enviou {msg}")),
            };
            match msg.get("method") {
                Some(method) => {
                    if actual.get("method") != Some(method) {
                        return Err(format!("passo {step}: esperava {method}, veio {actual}"));
                    }
                    if let Some(params) = msg.get("params")
                        && !subset(params, actual.get("params").unwrap_or(&Value::Null))
                    {
                        return Err(format!("passo {step}: parâmetros de {method}\n esperado {params}\n veio     {}", actual["params"]));
                    }
                    if let (Some(expected), Some(id)) = (msg.get("id"), actual.get("id")) {
                        ids.insert(expected.to_string(), id.clone());
                    }
                }
                None => {
                    if actual.get("method").is_some() || !subset(&msg, &actual) {
                        return Err(format!("passo {step}: esperava a resposta {msg}, veio {actual}"));
                    }
                }
            }
        }
        // Keep the "process" alive until the client is done with it.
        std::mem::forget(pipe.to_client);
        Ok(())
    });
    (app, handle)
}

/* ---------------- Launcher, sink and payloads ---------------- */

struct FakeLauncher {
    responder: Responder,
    fakes: Mutex<Vec<(Arc<AppServer>, Fake)>>,
    scripted: Mutex<VecDeque<Arc<AppServer>>>,
    launches: Mutex<Vec<(String, Option<String>)>>,
    fail: Mutex<Option<CodexError>>,
    accounts: HashMap<String, String>,
}

impl FakeLauncher {
    fn new(responder: Responder) -> Arc<Self> {
        Self::with_accounts(responder, &[])
    }

    fn with_accounts(responder: Responder, accounts: &[(&str, &str)]) -> Arc<Self> {
        Arc::new(Self {
            responder,
            fakes: Mutex::default(),
            scripted: Mutex::default(),
            launches: Mutex::default(),
            fail: Mutex::default(),
            accounts: accounts.iter().map(|(p, a)| (p.to_string(), a.to_string())).collect(),
        })
    }

    fn fake(&self, i: usize) -> Fake {
        self.fakes.lock().unwrap()[i].1.clone()
    }

    fn server(&self, i: usize) -> Arc<AppServer> {
        Arc::clone(&self.fakes.lock().unwrap()[i].0)
    }
}

impl Launcher for FakeLauncher {
    fn check(&self, profile_id: String) -> BoxFuture<'_, Result<(), CodexError>> {
        Box::pin(async move {
            match profile_id.as_str() {
                "missing" => Err(CodexError::new(CodexErrorKind::NotFound, "Conta não encontrada para este agente. Selecione outra conta.")),
                "stall" => std::future::pending().await,
                _ => Ok(()),
            }
        })
    }

    fn account(&self, profile_id: String) -> BoxFuture<'_, Result<String, CodexError>> {
        Box::pin(async move {
            match profile_id.as_str() {
                "disabled" | "unknown" => Err(CodexError::invalid("disabled")),
                id => Ok(self.accounts.get(id).cloned().unwrap_or_else(|| "ambient".to_string())),
            }
        })
    }

    fn launch(&self, profile_id: String, cwd: Option<String>) -> BoxFuture<'_, Result<Arc<AppServer>, CodexError>> {
        Box::pin(async move {
            self.launches.lock().unwrap().push((profile_id, cwd));
            if let Some(err) = self.fail.lock().unwrap().clone() {
                return Err(err);
            }
            if let Some(server) = self.scripted.lock().unwrap().pop_front() {
                return Ok(server);
            }
            let index = self.fakes.lock().unwrap().len();
            let (server, fake) = Fake::start(index, Arc::clone(&self.responder));
            self.fakes.lock().unwrap().push((Arc::clone(&server), fake));
            Ok(server)
        })
    }
}

/// Answers threads and turns like tests/native-codex.test.cjs's mock.
fn turn_responder() -> Responder {
    let turns = Arc::new(AtomicUsize::new(0));
    Arc::new(move |method, params, index| match method {
        "thread/start" | "thread/resume" => {
            let id = params.get("threadId").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("thread-{index}"));
            Some(json!({ "thread": { "id": id } }))
        }
        "turn/start" => Some(json!({ "turn": { "id": format!("native-{}", turns.fetch_add(1, Ordering::SeqCst) + 1) } })),
        "turn/interrupt" => Some(json!({})),
        "skills/list" => Some(json!({ "data": [{ "skills": [{ "name": "pdf", "path": "/s/pdf/SKILL.md" }] }] })),
        _ => None,
    })
}

#[derive(Default)]
struct Sink {
    log: Mutex<Vec<(&'static str, Value)>>,
}

impl CodexSink for Sink {
    fn event(&self, event: &CodexEvent) {
        self.log.lock().unwrap().push(("codex:event", json!(event)));
    }

    fn permission(&self, payload: Value) {
        self.log.lock().unwrap().push(("agent:permission", payload));
    }

    fn question(&self, payload: Value) {
        self.log.lock().unwrap().push(("agent:question", payload));
    }
}

impl Sink {
    fn of(&self, channel: &str) -> Vec<Value> {
        self.log.lock().unwrap().iter().filter(|(c, _)| *c == channel).map(|(_, v)| v.clone()).collect()
    }

    fn events(&self) -> Vec<Value> {
        self.of("codex:event")
    }

    fn kinds(&self, kind: &str) -> Vec<Value> {
        self.events().into_iter().filter(|e| e["kind"] == kind).collect()
    }
}

fn merge(base: &mut Value, extra: Value) {
    match (base, extra) {
        (Value::Object(base), Value::Object(extra)) => {
            for (k, v) in extra {
                match base.get_mut(&k) {
                    Some(existing) if existing.is_object() && v.is_object() => merge(existing, v),
                    _ => {
                        base.insert(k, v);
                    }
                }
            }
        }
        (base, extra) => *base = extra,
    }
}

fn payload(id: &str, extra: Value) -> CodexSend {
    let mut value = json!({ "id": id, "chatId": "chat", "cwd": "C:\\QA", "prompt": "hello",
        "selection": { "provider": "codex", "profileId": "ambient-codex", "model": "native-model", "effort": "high", "permissionMode": "default" },
        "chat": { "id": "chat" } });
    merge(&mut value, extra);
    serde_json::from_value(value).unwrap()
}

const OWNER: Owner = 1;
const OTHER: Owner = 99;

struct Fixture {
    launcher: Arc<FakeLauncher>,
    sessions: Arc<CodexSessions>,
    sink: Arc<Sink>,
}

impl Fixture {
    fn new() -> Self {
        Self::with(turn_responder())
    }

    fn with(responder: Responder) -> Self {
        let launcher = FakeLauncher::new(responder);
        Self { sessions: CodexSessions::new(launcher.clone()), launcher, sink: Arc::default() }
    }

    async fn send(&self, id: &str, extra: Value) -> Result<(), CodexError> {
        self.sessions.send(OWNER, self.sink.clone(), payload(id, extra), None).await
    }

    /// Sends and waits until the turn went out (`turn/start` answered).
    async fn started(&self, id: &str, extra: Value) -> Fake {
        let before = self.launcher.fakes.lock().unwrap().iter().map(|(_, f)| f.calls("turn/start").len()).sum::<usize>();
        self.send(id, extra).await.unwrap();
        eventually("turn/start", || self.launcher.fakes.lock().unwrap().iter().map(|(_, f)| f.calls("turn/start").len()).sum::<usize>() > before).await;
        let fake = self.launcher.fakes.lock().unwrap().last().unwrap().1.clone();
        eventually("the native turn id", || self.sink.events().iter().any(|e| e["id"] == id && e["kind"] == "session")).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        fake
    }
}

/* ---------------- Sessions (tests/native-codex.test.cjs) ---------------- */

#[tokio::test]
async fn subagents_keep_native_parent_edges_and_original_sink_after_root_completion() {
    let f = Fixture::new();
    let server = f.started("root-first", json!({})).await;
    server.notify("item/completed", json!({"threadId":"thread-0", "turnId":"native-1", "item":{
        "id":"spawn", "type":"collabAgentToolCall", "tool":"spawnAgent", "senderThreadId":"thread-0", "receiverThreadIds":["child"],
        "agentsStates":{"child":{"status":"running"}}, "prompt":"Revisar arquivos", "model":"test-model", "status":"completed"
    }}));
    server.notify("thread/started", json!({"thread":{"id":"child", "agentNickname":"Ada", "source":{"subAgent":{"thread_spawn":{"parent_thread_id":"thread-0","depth":1}}}}}));
    server.notify("turn/started", json!({"threadId":"child", "turn":{"id":"child-turn"}}));
    server.notify("item/started", json!({"threadId":"child", "turnId":"child-turn", "item":{"id":"reply", "type":"agentMessage", "text":""}}));
    server.notify("item/agentMessage/delta", json!({"threadId":"child", "turnId":"child-turn", "itemId":"reply", "delta":"Analisando…"}));
    server.notify("thread/started", json!({"thread":{"id":"nested", "source":{"subAgent":{"thread_spawn":{"parent_thread_id":"child","depth":2}}}}}));
    eventually("child stream", || f.sink.kinds("subagent").iter().any(|e| e["agent"]["segment"]["text"] == "Analisando…")).await;
    let events = f.sink.kinds("subagent");
    assert!(events.iter().any(|e| e["agent"]["id"] == "child" && e["agent"]["description"] == "Revisar arquivos" && e["agent"]["model"] == "test-model"));
    assert!(events.iter().any(|e| e["agent"]["id"] == "child" && e["agent"]["name"] == "Ada"));
    eventually("nested edge", || f.sink.kinds("subagent").iter().any(|e| e["agent"]["id"] == "nested" && e["agent"]["parentId"] == "child")).await;
    assert!(!f.sink.kinds("segment").iter().any(|e| e["segment"]["text"] == "Analisando…"));
    server.notify("turn/completed", json!({"threadId":"thread-0", "turn":{"id":"native-1","status":"completed"}}));
    eventually("parent done", || !f.sessions.busy("chat")).await;
    let next_sink = Arc::new(Sink::default());
    f.sessions.send(OWNER, next_sink.clone(), payload("root-second", json!({"resume":"thread-0"})), None).await.unwrap();
    eventually("next turn", || server.calls("turn/start").len() == 2).await;
    server.notify("item/agentMessage/delta", json!({"threadId":"child", "turnId":"child-turn", "itemId":"reply", "delta":" concluído"}));
    server.notify("turn/completed", json!({"threadId":"child", "turn":{"id":"child-turn", "status":"completed"}}));
    eventually("child done", || f.sink.kinds("subagent").iter().any(|e| e["agent"]["id"] == "child" && e["agent"]["status"] == "completed")).await;
    assert!(f.sink.kinds("subagent").iter().any(|e| e["id"] == "root-first" && e["agent"]["segment"]["text"] == "Analisando… concluído"));
    assert!(next_sink.kinds("subagent").is_empty());
    assert!(f.sessions.busy("chat"), "child terminal event cannot finish the next root turn");
    server.notify("thread/started", json!({"thread":{"id":"stranger", "source":{"subAgent":{"thread_spawn":{"parent_thread_id":"unrelated","depth":1}}}}}));
    server.notify("item/agentMessage/delta", json!({"threadId":"stranger", "itemId":"x", "delta":"Do not leak"}));
    server.notify("turn/completed", json!({"threadId":"thread-0", "turn":{"id":"native-2", "status":"completed"}}));
    eventually("root done", || !f.sessions.busy("chat")).await;
    assert!(!f.sink.kinds("subagent").iter().chain(next_sink.kinds("subagent").iter()).any(|e| e["agent"]["id"] == "stranger"));
}

#[tokio::test]
async fn subagent_approval_uses_originating_root_and_process_close_stops_children() {
    let f = Fixture::new();
    let server = f.started("root-first", json!({})).await;
    server.notify("thread/started", json!({"thread":{"id":"child", "source":{"subAgent":{"thread_spawn":{"parent_thread_id":"thread-0","depth":1}}}}}));
    server.request(51, "item/commandExecution/requestApproval", json!({"threadId":"child", "turnId":"child-turn", "itemId":"cmd", "command":"npm test"}));
    eventually("child approval", || !f.sink.of("agent:permission").is_empty()).await;
    let approval = f.sink.of("agent:permission")[0].clone();
    assert_eq!(approval["id"], "root-first");
    f.sessions.permission(OWNER, "chat", approval["permId"].as_str().unwrap(), "allow");
    eventually("approval answer", || server.received.lock().unwrap().iter().any(|message| message["id"] == 51 && message["result"]["decision"] == "accept")).await;
    f.sessions.close_all();
    eventually("child stops", || f.sink.kinds("subagent").iter().any(|e| e["agent"]["id"] == "child" && e["agent"]["status"] == "stopped")).await;
}

#[tokio::test]
async fn image_only_turn_uses_native_image_input() {
    let f = Fixture::new();
    let s = f.started("image", json!({"prompt": "", "images": [{"mime": "image/png", "data": "aGVsbG8="}]})).await;
    assert_eq!(s.calls("turn/start")[0]["params"]["input"], json!([
        {"type": "text", "text": "", "text_elements": []},
        {"type": "image", "url": "data:image/png;base64,aGVsbG8="}
    ]));
}

#[tokio::test]
async fn native_async_question_metadata_reaches_the_current_turn_without_blocking_it() {
    let f = Fixture::new();
    let server = f.started("turn", json!({})).await;
    assert!(server.calls("thread/start")[0]["params"].get("developerInstructions").is_none(), "profile developer instructions stay in the native configuration");
    server.notify("item/completed", json!({ "threadId": "thread-0", "turnId": "native-1", "item": {
        "id": "async-q", "type": "agentMessage", "text": "Qual uso?", "questions": [{ "title": "Qual uso?", "options": ["Tokens", "Limites", "Os dois"] }]
    } }));
    eventually("async question segment", || !f.sink.kinds("segment").is_empty()).await;
    let event = f.sink.events().into_iter().find(|event| event["kind"] == "segment").unwrap();
    assert_eq!(event["segment"]["questions"], json!([{ "title": "Qual uso?", "options": ["Tokens", "Limites", "Os dois"] }]));
    assert!(f.sink.of("agent:question").is_empty(), "async metadata is answered by a message, without an RPC dialog");
    server.notify("turn/completed", json!({ "threadId": "thread-0", "turn": { "status": "completed" } }));
    eventually("turn completed", || !f.sink.kinds("done").is_empty()).await;
}

#[tokio::test]
async fn native_questions_accept_ids_free_text_and_reject_malformed_empty_requests() {
    let f = Fixture::new();
    let server = f.started("turn", json!({})).await;
    server.request(30, "item/tool/requestUserInput", json!({ "threadId": "thread-0", "turnId": "native-1", "itemId": "question-call", "questions": [
        { "questionId": "usage", "question": "Qual uso?", "options": null }, { "id": "details", "question": "Detalhes", "options": [] }
    ] }));
    eventually("question", || !f.sink.of("agent:question").is_empty()).await;
    let question = f.sink.of("agent:question")[0].clone();
    assert_eq!(question["toolUseId"], "question-call");
    assert_eq!(question["questions"][0]["id"], "usage");
    assert_eq!(question["questions"][0]["options"], json!([]));
    let answers = serde_json::from_value(json!({ "usage": "Os dois", "details": "Texto livre" })).unwrap();
    f.sessions.question(OWNER, "chat", "codex:chat:30", Some(&answers));
    eventually("answer", || server.answers().len() == 1).await;
    assert_eq!(server.answers()[0], json!({ "id": 30, "result": { "answers": { "usage": { "answers": ["Os dois"] }, "details": { "answers": ["Texto livre"] } } } }));
    server.request(31, "item/tool/requestUserInput", json!({ "threadId": "thread-0", "questions": null }));
    eventually("rejected malformed question", || server.answers().len() == 2).await;
    assert_eq!(server.answers()[1]["id"], 31);
    assert!(server.answers()[1].get("error").is_some());
    assert_eq!(f.sink.of("agent:question").len(), 1);
}

#[tokio::test]
async fn a_reused_process_delivers_every_kind_of_output_to_the_current_turn_sink() {
    let f = Fixture::new();
    let server = f.started("first", json!({})).await;
    server.notify("turn/completed", json!({ "threadId": "thread-0", "turn": { "id": "native-1", "status": "completed" } }));
    eventually("first done", || !f.sink.kinds("done").is_empty()).await;
    let first_log = f.sink.log.lock().unwrap().clone();

    // The host creates a new EngineSink per turn. Reusing one recording sink,
    // as the other process-reuse tests do, hides delivery to the previous turn.
    let second: Arc<Sink> = Arc::default();
    f.sessions.send(OWNER, second.clone(), payload("second", json!({ "resume": "thread-0" })), None).await.unwrap();
    eventually("second turn/start", || server.calls("turn/start").len() == 2).await;
    eventually("second session in its own sink", || !second.kinds("session").is_empty()).await;
    server.notify("item/agentMessage/delta", json!({ "threadId": "thread-0", "turnId": "native-2", "itemId": "reply", "delta": "Resposta da segunda mensagem" }));
    server.notify("thread/tokenUsage/updated", json!({ "threadId": "thread-0", "tokenUsage": { "total": { "totalTokens": 10 }, "last": { "totalTokens": 10 } } }));
    server.request(21, "item/commandExecution/requestApproval", json!({ "threadId": "thread-0", "turnId": "native-2", "command": "npm test" }));
    server.request(23, "item/permissions/requestApproval", json!({ "threadId": "thread-0", "turnId": "native-2", "permissions": { "network": { "enabled": true } } }));
    server.request(22, "item/tool/requestUserInput", json!({ "threadId": "thread-0", "turnId": "native-2", "questions": [{ "id": "q", "question": "Continuar?", "options": [] }] }));
    server.notify("turn/completed", json!({ "threadId": "thread-0", "turn": { "id": "native-2", "status": "completed" } }));
    eventually("second done in its own sink", || !second.kinds("done").is_empty()).await;
    assert_eq!(second.kinds("segment")[0]["segment"]["text"], "Resposta da segunda mensagem");
    assert_eq!(second.kinds("metrics").len(), 1);
    assert_eq!(second.of("agent:permission").len(), 2);
    assert!(second.of("agent:permission").iter().all(|permission| permission["id"] == "second"));
    assert_eq!(second.of("agent:question")[0]["id"], "second");
    assert!(second.events().iter().all(|event| event["id"] == "second"));
    assert_eq!(*f.sink.log.lock().unwrap(), first_log, "the previous turn receives no later output");

    let second_log = second.log.lock().unwrap().clone();
    let third: Arc<Sink> = Arc::default();
    f.sessions.send(OWNER, third.clone(), payload("third", json!({ "resume": "thread-0" })), None).await.unwrap();
    eventually("third turn/start", || server.calls("turn/start").len() == 3).await;
    server.notify("turn/completed", json!({ "threadId": "thread-0", "turn": { "id": "native-3", "status": "interrupted" } }));
    eventually("third interrupted in its own sink", || !third.kinds("done").is_empty()).await;
    assert_eq!(third.kinds("done")[0], json!({ "id": "third", "kind": "done", "aborted": true }));
    assert_eq!(*second.log.lock().unwrap(), second_log);
    let third_log = third.log.lock().unwrap().clone();

    let fourth: Arc<Sink> = Arc::default();
    f.sessions.send(OWNER, fourth.clone(), payload("fourth", json!({ "resume": "thread-0" })), None).await.unwrap();
    eventually("fourth turn/start", || server.calls("turn/start").len() == 4).await;
    server.notify("turn/completed", json!({ "threadId": "thread-0", "turn": { "id": "native-4", "status": "failed", "error": { "message": "Falha simulada" } } }));
    eventually("fourth error in its own sink", || !fourth.kinds("error").is_empty()).await;
    assert_eq!(fourth.kinds("error")[0], json!({ "id": "fourth", "kind": "error", "message": "Falha simulada" }));
    assert_eq!(*third.log.lock().unwrap(), third_log);
    assert_eq!(f.launcher.fakes.lock().unwrap().len(), 1, "all turns reuse the same healthy process");
    assert!(!f.sessions.busy("chat"));
}

#[tokio::test]
async fn starts_once_resumes_the_same_thread_and_restarts_on_a_new_route() {
    let f = Fixture::new();
    let s = f.started("turn", json!({})).await;
    assert_eq!(s.methods(), ["thread/start", "turn/start"]);
    let turn = &s.calls("turn/start")[0]["params"];
    assert_eq!(turn["approvalPolicy"], "on-request");
    assert_eq!(turn["sandboxPolicy"], json!({ "type": "readOnly" }));
    assert_eq!(f.launcher.launches.lock().unwrap()[0], ("ambient-codex".to_string(), Some("C:\\QA".to_string())));
    s.notify("turn/completed", json!({ "threadId": "thread-0", "turn": { "status": "completed" } }));
    eventually("done", || !f.sink.kinds("done").is_empty()).await;
    assert_eq!(f.sink.kinds("done")[0], json!({ "id": "turn", "kind": "done", "aborted": false }));

    f.started("second", json!({ "resume": "thread-0" })).await;
    assert_eq!(f.launcher.fakes.lock().unwrap().len(), 1, "same route and thread: same process");
    assert_eq!(s.methods(), ["thread/start", "turn/start", "turn/start"]);
    s.notify("turn/completed", json!({ "threadId": "thread-0", "turn": { "status": "completed" } }));
    eventually("second done", || f.sink.kinds("done").len() == 2).await;

    // No resume: a fresh process and thread; the old one is closed.
    f.started("third", json!({})).await;
    assert_eq!(f.launcher.fakes.lock().unwrap().len(), 2);
    assert!(f.launcher.server(0).is_closed());
    assert_eq!(f.launcher.fake(1).methods()[0], "thread/start");

    // Another folder is another route even with the same thread.
    f.launcher.fake(1).notify("turn/completed", json!({ "threadId": "thread-1", "turn": { "status": "completed" } }));
    eventually("third done", || f.sink.kinds("done").len() == 3).await;
    f.started("fourth", json!({ "resume": "thread-1", "cwd": "C:\\Other" })).await;
    assert_eq!(f.launcher.fakes.lock().unwrap().len(), 3);
    assert_eq!(f.launcher.fake(2).methods()[0], "thread/resume");
}

#[tokio::test]
async fn items_replace_stream_unicode_and_a_failed_turn_errors_once() {
    let f = Fixture::new();
    let s = f.started("turn", json!({})).await;
    let (thread, turn) = ("thread-0", "native-1");
    s.notify("item/started", json!({ "threadId": thread, "turnId": turn, "item": { "id": "m", "type": "agentMessage", "text": "" } }));
    s.notify("item/agentMessage/delta", json!({ "threadId": thread, "turnId": turn, "itemId": "m", "delta": "ação🙂" }));
    s.notify("item/completed", json!({ "threadId": thread, "turnId": turn, "item": { "id": "b", "type": "commandExecution", "command": "migrate", "exitCode": 0, "aggregatedOutput": "SIDE_EFFECT" } }));
    s.notify("error", json!({ "threadId": thread, "turnId": turn, "error": { "message": "Rate limit" }, "willRetry": true }));
    eventually("segments", || f.sink.kinds("segment").len() == 3).await;
    assert!(f.sink.kinds("error").is_empty(), "a retried error is not the end of the turn");
    let segments = f.sink.kinds("segment");
    assert_eq!(segments[1]["segment"], json!({ "kind": "text", "toolId": "m", "text": "ação🙂" }));
    assert_eq!(segments[2]["segment"]["result"], "SIDE_EFFECT");
    assert_eq!(segments[2]["segment"]["status"], "done");
    s.notify("turn/completed", json!({ "threadId": thread, "turn": { "status": "failed", "error": { "message": "Rate limit" } } }));
    s.notify("turn/completed", json!({ "threadId": thread, "turn": { "status": "failed", "error": { "message": "Rate limit" } } }));
    eventually("error", || !f.sink.kinds("error").is_empty()).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(f.sink.kinds("error"), [json!({ "id": "turn", "kind": "error", "message": "Rate limit" })]);
    assert!(!f.sessions.busy("chat"));
}

#[tokio::test]
async fn approvals_questions_abort_and_duplicates_are_scoped_to_owner_and_turn() {
    let f = Fixture::new();
    let s = f.started("turn", json!({})).await;
    s.request(9, "item/commandExecution/requestApproval", json!({ "threadId": "thread-0", "turnId": "native-1", "itemId": "b", "command": "echo hi" }));
    eventually("permission", || !f.sink.of("agent:permission").is_empty()).await;
    let perm = f.sink.of("agent:permission")[0].clone();
    assert_eq!(perm, json!({ "id": "turn", "permId": "codex:chat:9", "toolUseId": "b", "toolName": "Bash", "input": { "command": "echo hi" }, "title": "Codex solicita permissão" }));
    f.sessions.permission(OTHER, "chat", "codex:chat:9", "allow");
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(s.answers().is_empty(), "another client cannot answer");
    f.sessions.permission(OWNER, "chat", "codex:chat:9", "allow_always");
    eventually("answer", || s.answers().len() == 1).await;
    assert_eq!(s.answers()[0], json!({ "id": 9, "result": { "decision": "acceptForSession" } }));
    f.sessions.permission(OWNER, "chat", "codex:chat:9", "allow");
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(s.answers().len(), 1, "a request is answered once");

    s.request(10, "item/tool/requestUserInput", json!({ "threadId": "thread-0", "questions": [{ "id": "q1", "question": "Which?", "header": "Mode", "options": [{ "label": "A", "description": "A" }] }] }));
    eventually("question", || !f.sink.of("agent:question").is_empty()).await;
    let question = f.sink.of("agent:question")[0].clone();
    assert_eq!(question["dialogId"], "codex:chat:10");
    assert_eq!(question["questions"][0]["options"][0]["label"], "A");
    let answers: Map<String, Value> = serde_json::from_value(json!({ "Which?": "A" })).unwrap();
    f.sessions.question(OWNER, "chat", "codex:chat:10", Some(&answers));
    eventually("question answer", || s.answers().len() == 2).await;
    assert_eq!(s.answers()[1]["result"], json!({ "answers": { "q1": { "answers": ["A"] } } }));

    s.request(11, "item/permissions/requestApproval", json!({ "threadId": "thread-0", "itemId": "grant", "permissions": { "network": { "enabled": true } } }));
    eventually("grant", || f.sink.of("agent:permission").len() == 2).await;
    let grant = f.sink.of("agent:permission")[1].clone();
    assert_eq!(grant["toolName"], "Permissões");
    assert_eq!(grant["title"], "Codex solicita acesso a arquivos ou rede");
    f.sessions.permission(OWNER, "chat", grant["permId"].as_str().unwrap(), "deny");
    eventually("grant answer", || s.answers().len() == 3).await;
    assert_eq!(s.answers()[2]["result"], json!({ "permissions": {}, "scope": "turn" }));
    s.request(12, "item/permissions/requestApproval", json!({ "threadId": "thread-0", "itemId": "g2", "permissions": { "fs": ["/x"] } }));
    eventually("grant 2", || f.sink.of("agent:permission").len() == 3).await;
    f.sessions.permission(OWNER, "chat", "codex:chat:12", "allow_always");
    eventually("grant 2 answer", || s.answers().len() == 4).await;
    assert_eq!(s.answers()[3]["result"], json!({ "permissions": { "fs": ["/x"] }, "scope": "session" }));

    let duplicate = f.send("duplicate", json!({})).await.unwrap_err();
    assert_eq!((duplicate.kind, duplicate.message.as_str()), (CodexErrorKind::Busy, "Este chat já está ocupado em outra execução."));
    assert_eq!(f.launcher.fakes.lock().unwrap().len(), 1);
    let stolen = f.sessions.send(OTHER, f.sink.clone(), payload("other", json!({})), None).await.unwrap_err();
    assert_eq!(stolen.kind, CodexErrorKind::Busy);

    f.sessions.abort(OTHER, "chat");
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(s.calls("turn/interrupt").is_empty());
    f.sessions.abort(OWNER, "chat");
    eventually("interrupt", || s.calls("turn/interrupt").len() == 1).await;
    assert_eq!(s.calls("turn/interrupt")[0]["params"], json!({ "threadId": "thread-0", "turnId": "native-1" }));
}

#[tokio::test]
async fn a_login_change_restarts_the_idle_process_only() {
    let f = Fixture::new();
    let s = f.started("turn", json!({})).await;
    f.sessions.profile_changed("ambient-codex");
    assert!(!f.launcher.server(0).is_closed(), "a running turn keeps its process");
    s.notify("turn/completed", json!({ "threadId": "thread-0", "turn": { "status": "completed" } }));
    eventually("done", || !f.sink.kinds("done").is_empty()).await;
    f.sessions.profile_changed("other-profile");
    assert!(!f.launcher.server(0).is_closed());
    f.sessions.profile_changed("ambient-codex");
    assert!(f.launcher.server(0).is_closed());
    f.started("second", json!({ "resume": "thread-0" })).await;
    assert_eq!(f.launcher.fakes.lock().unwrap().len(), 2);
    assert_eq!(f.launcher.fake(1).methods()[0], "thread/resume");
}

#[tokio::test]
async fn token_usage_is_scoped_to_the_thread_and_never_counted_twice() {
    let f = Fixture::new();
    let s = f.started("turn", json!({})).await;
    s.notify("thread/tokenUsage/updated", json!({ "threadId": "wrong", "tokenUsage": { "total": { "totalTokens": 999 } } }));
    let usage = json!({ "total": { "totalTokens": 20, "inputTokens": 12, "outputTokens": 8, "cachedInputTokens": 4 }, "modelContextWindow": 200000 });
    s.notify("thread/tokenUsage/updated", json!({ "threadId": "thread-0", "tokenUsage": usage }));
    eventually("metrics", || !f.sink.kinds("metrics").is_empty()).await;
    let m = &f.sink.kinds("metrics")[0]["metrics"];
    assert_eq!(f.sink.kinds("metrics").len(), 1, "another thread's usage is ignored");
    assert_eq!(m["totalTokens"], 20);
    assert_eq!(m["scope"], "session");
    assert_eq!(m["contextWindow"], 200000);
    assert_eq!(m["cachedTokens"], 4);
    assert!(m.get("turn").is_none(), "no `last` on the first update: the turn is unknown");
    s.notify("turn/completed", json!({ "threadId": "thread-0", "turn": { "status": "completed" } }));
    eventually("done", || !f.sink.kinds("done").is_empty()).await;

    // Next turn: the base is the last total this process saw; a repeated update counts once.
    f.started("second", json!({ "resume": "thread-0" })).await;
    let next = json!({ "total": { "totalTokens": 50, "inputTokens": 30, "outputTokens": 20, "cachedInputTokens": 10, "reasoningOutputTokens": 5 } });
    s.notify("thread/tokenUsage/updated", json!({ "threadId": "thread-0", "tokenUsage": next }));
    s.notify("thread/tokenUsage/updated", json!({ "threadId": "thread-0", "tokenUsage": next }));
    eventually("metrics 2", || f.sink.kinds("metrics").len() == 3).await;
    let expected = json!({ "inputTokens": 12, "cacheReadTokens": 6, "outputTokens": 12, "reasoningTokens": 5 });
    assert_eq!(f.sink.kinds("metrics")[1]["metrics"]["turn"], expected);
    assert_eq!(f.sink.kinds("metrics")[2]["metrics"]["turn"], expected);
}

#[tokio::test]
async fn turn_input_is_text_only_without_a_skill_token() {
    let f = Fixture::new();
    let s = f.started("t", json!({ "prompt": "sem tokens, US$100" })).await;
    assert!(s.calls("skills/list").is_empty(), "no listing when no token could name a skill");
    assert_eq!(s.calls("turn/start")[0]["params"]["input"], json!([{ "type": "text", "text": "sem tokens, US$100", "text_elements": [] }]));
}

#[tokio::test]
async fn skill_tokens_add_structured_items_from_the_sessions_own_listing() {
    let f = Fixture::new();
    let s = f.started("t", json!({ "prompt": "use $pdf agora $nada" })).await;
    assert_eq!(s.calls("skills/list")[0]["params"], json!({ "cwds": ["C:\\QA"] }));
    assert_eq!(
        s.calls("turn/start")[0]["params"]["input"],
        json!([{ "type": "text", "text": "use $pdf agora $nada", "text_elements": [] }, { "type": "skill", "name": "pdf", "path": "/s/pdf/SKILL.md" }])
    );
}

#[tokio::test]
async fn a_failed_skill_listing_sends_text_only() {
    let base = turn_responder();
    let f = Fixture::with(Arc::new(move |m, p, i| if m == "skills/list" { Some(json!({ "__error": "boom" })) } else { base(m, p, i) }));
    let s = f.started("t", json!({ "prompt": "$pdf" })).await;
    assert_eq!(s.calls("turn/start")[0]["params"]["input"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn an_abort_before_the_turn_starts_ends_it_aborted_without_turn_start() {
    let base = turn_responder();
    let f = Fixture::with(Arc::new(move |m, p, i| if m.starts_with("thread/") { None } else { base(m, p, i) }));
    f.send("turn", json!({})).await.unwrap();
    // Aborted right after acceptance, before the thread answers.
    f.sessions.abort(OWNER, "chat");
    eventually("thread/start", || f.launcher.fakes.lock().unwrap().first().is_some_and(|(_, s)| !s.calls("thread/start").is_empty())).await;
    let s = f.launcher.fake(0);
    let id = s.calls("thread/start")[0]["id"].clone();
    s.send(json!({ "id": id, "result": { "thread": { "id": "t1" } } }));
    eventually("done", || !f.sink.kinds("done").is_empty()).await;
    assert_eq!(f.sink.events(), [json!({ "id": "turn", "kind": "session", "sessionId": "t1" }), json!({ "id": "turn", "kind": "done", "aborted": true })]);
    assert!(s.calls("turn/start").is_empty());
}

#[tokio::test]
async fn an_abort_while_turn_start_is_pending_interrupts_once_it_answers() {
    let base = turn_responder();
    let f = Fixture::with(Arc::new(move |m, p, i| if m == "turn/start" { None } else { base(m, p, i) }));
    f.send("turn", json!({})).await.unwrap();
    eventually("turn/start", || f.launcher.fakes.lock().unwrap().first().is_some_and(|(_, s)| !s.calls("turn/start").is_empty())).await;
    f.sessions.abort(OWNER, "chat");
    let s = f.launcher.fake(0);
    assert!(s.calls("turn/interrupt").is_empty(), "no native turn id yet");
    let id = s.calls("turn/start")[0]["id"].clone();
    s.send(json!({ "id": id, "result": { "turn": { "id": "n1" } } }));
    eventually("interrupt", || s.calls("turn/interrupt").len() == 1).await;
    s.notify("turn/completed", json!({ "threadId": "thread-0", "turn": { "status": "interrupted" } }));
    eventually("done", || !f.sink.kinds("done").is_empty()).await;
    assert_eq!(f.sink.kinds("done")[0]["aborted"], true);
}

#[tokio::test]
async fn a_process_that_dies_ends_the_turn_and_the_next_send_restarts_it() {
    let f = Fixture::new();
    let s = f.started("turn", json!({})).await;
    s.hang_up();
    eventually("error", || !f.sink.kinds("error").is_empty()).await;
    assert_eq!(f.sink.kinds("error")[0]["message"], "Codex App Server desconectado.");
    eventually("forgotten", || f.sessions.is_empty()).await;
    f.started("again", json!({ "resume": "thread-0" })).await;
    assert_eq!(f.launcher.fakes.lock().unwrap().len(), 2);
    assert_eq!(f.launcher.fake(1).methods()[0], "thread/resume");
}

#[tokio::test]
async fn a_failed_request_closes_the_process_with_that_reason() {
    let base = turn_responder();
    let f = Fixture::with(Arc::new(move |m, p, i| if m == "turn/start" { Some(json!({ "__error": "modelo inválido" })) } else { base(m, p, i) }));
    f.send("turn", json!({})).await.unwrap();
    eventually("error", || !f.sink.kinds("error").is_empty()).await;
    assert_eq!(f.sink.kinds("error"), [json!({ "id": "turn", "kind": "error", "message": "modelo inválido" })]);
    assert!(f.launcher.server(0).is_closed());
}

#[tokio::test]
async fn the_owner_leaving_closes_its_chats_only() {
    let f = Fixture::new();
    f.started("turn", json!({})).await;
    let other = Arc::new(Sink::default());
    f.sessions.send(OTHER, other.clone(), payload("x", json!({ "chatId": "chat-2" })), None).await.unwrap();
    eventually("both started", || f.launcher.fakes.lock().unwrap().len() == 2).await;
    f.sessions.close_owner(OWNER);
    eventually("closed", || f.sink.kinds("error").len() == 1).await;
    assert_eq!(f.sink.kinds("error")[0]["message"], "Codex App Server encerrado.");
    assert!(f.launcher.server(0).is_closed() && !f.launcher.server(1).is_closed());
    assert!(f.sessions.busy("chat-2") && !f.sessions.busy("chat"));
}

#[tokio::test]
async fn policies_follow_the_permission_mode_and_fast_tier() {
    for (mode, approval, sandbox, policy) in [
        ("default", "on-request", "read-only", json!({ "type": "readOnly" })),
        ("plan", "never", "read-only", json!({ "type": "readOnly" })),
        (
            "acceptEdits",
            "on-request",
            "workspace-write",
            json!({ "type": "workspaceWrite", "writableRoots": ["C:\\QA"], "networkAccess": false, "excludeTmpdirEnvVar": false, "excludeSlashTmp": false }),
        ),
        ("bypassPermissions", "never", "danger-full-access", json!({ "type": "dangerFullAccess" })),
    ] {
        let f = Fixture::new();
        let s = f.started("t", json!({ "selection": { "permissionMode": mode, "serviceTier": "priority", "model": "", "effort": "xhigh" } })).await;
        let thread = &s.calls("thread/start")[0]["params"];
        assert_eq!(*thread, json!({ "cwd": "C:\\QA", "approvalPolicy": approval, "sandbox": sandbox, "serviceTier": "priority" }), "{mode}");
        let turn = &s.calls("turn/start")[0]["params"];
        assert_eq!(turn["sandboxPolicy"], policy, "{mode}");
        assert_eq!(turn["approvalPolicy"], approval);
        assert_eq!(turn["effort"], "xhigh");
        assert!(turn.get("model").is_none(), "no model: the CLI's default");
        let keys: Vec<&str> = turn.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["threadId", "input", "cwd", "approvalPolicy", "sandboxPolicy", "effort", "serviceTier"]);
    }
    // No tier (or ''): null, which clears a tier the thread had.
    let f = Fixture::new();
    let s = f.started("t", json!({ "selection": { "serviceTier": "" } })).await;
    assert_eq!(s.calls("turn/start")[0]["params"]["serviceTier"], Value::Null);
    assert_eq!(s.calls("turn/start")[0]["params"]["model"], "native-model");
}

#[tokio::test]
async fn sends_that_are_not_accepted_leave_no_session_and_no_event() {
    let f = Fixture::new();
    for bad in [json!({ "prompt": "   " }), json!({ "id": "" }), json!({ "chatId": "" }), json!({ "selection": { "provider": "claude" } })] {
        let mut p = json!({ "id": "x", "chatId": "chat", "cwd": "C:\\QA", "prompt": "hello", "selection": { "provider": "codex", "profileId": "ambient-codex" } });
        merge(&mut p, bad);
        let err = f.sessions.send(OWNER, f.sink.clone(), serde_json::from_value(p).unwrap(), None).await.unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (CodexErrorKind::Invalid, "Mensagem Codex inválida."));
    }
    let err = f.send("x", json!({ "selection": { "profileId": "missing" } })).await.unwrap_err();
    assert_eq!(err.kind, CodexErrorKind::NotFound);
    *f.launcher.fail.lock().unwrap() = Some(CodexError::new(CodexErrorKind::CliMissing, CLI_MISSING_MESSAGE));
    let err = f.send("y", json!({})).await.unwrap_err();
    assert_eq!(err.message, CLI_MISSING_MESSAGE);
    assert!(f.sessions.is_empty() && f.sink.events().is_empty());
    *f.launcher.fail.lock().unwrap() = None;
    f.started("z", json!({})).await;
    assert!(f.sessions.busy("chat"));
}

#[tokio::test]
async fn idle_requests_and_unknown_requests_are_refused() {
    let f = Fixture::new();
    let s = f.started("turn", json!({})).await;
    s.request("tc", "item/tool/call", json!({ "threadId": "thread-0", "tool": "x" }));
    eventually("refusal", || s.answers().len() == 1).await;
    assert_eq!(s.answers()[0], json!({ "id": "tc", "error": { "code": -32601, "message": "Operação não suportada pelo Prism." } }));
    s.notify("turn/completed", json!({ "threadId": "thread-0", "turn": { "status": "completed" } }));
    eventually("done", || !f.sink.kinds("done").is_empty()).await;
    s.request(5, "item/commandExecution/requestApproval", json!({ "threadId": "thread-0", "itemId": "late" }));
    eventually("idle refusal", || s.answers().len() == 2).await;
    assert_eq!(s.answers()[1]["error"]["code"], -32601);
    assert!(f.sink.of("agent:permission").is_empty());
}

/* ---------------- Transcripts ---------------- */

#[tokio::test]
async fn replays_a_turn_with_skills_approval_question_and_usage() {
    let launcher = FakeLauncher::new(turn_responder());
    let (server, replayed) = replay(TURN_BASIC);
    launcher.scripted.lock().unwrap().push_back(Arc::clone(&server));
    let sessions = CodexSessions::new(launcher.clone());
    let sink = Arc::new(Sink::default());
    let send = |id: &str, prompt: &str, extra: Value| {
        let mut p = json!({ "id": id, "chatId": "chat", "cwd": "C:\\QA\\projeto", "prompt": prompt,
            "selection": { "provider": "codex", "profileId": "p1", "model": "gpt-5.5", "effort": "high", "permissionMode": "default", "serviceTier": "priority" } });
        merge(&mut p, extra);
        sessions.send(OWNER, sink.clone(), serde_json::from_value(p).unwrap(), None)
    };
    send("t1", "leia $pdf. agora $off", json!({})).await.unwrap();
    eventually("permission", || !sink.of("agent:permission").is_empty()).await;
    let perm = sink.of("agent:permission")[0].clone();
    assert_eq!(perm, json!({ "id": "t1", "permId": "codex:chat:0", "toolUseId": "cmd_1", "toolName": "Bash",
        "input": { "command": "npm test", "cwd": "C:\\QA\\projeto" }, "title": "Rodar os testes" }));
    sessions.permission(OWNER, "chat", "codex:chat:0", "allow");
    eventually("question", || !sink.of("agent:question").is_empty()).await;
    let question = sink.of("agent:question")[0].clone();
    assert_eq!(question["questions"][1]["options"], json!([]), "null options become []");
    assert_eq!(question["questions"][0]["isOther"], false, "the rest of the question passes through");
    let answers: Map<String, Value> = serde_json::from_value(json!({ "Qual modo?": "Seguro", "Algo mais?": "" })).unwrap();
    sessions.question(OWNER, "chat", "codex:chat:1", Some(&answers));
    eventually("first turn done", || sink.events().iter().any(|e| e["kind"] == "done")).await;

    let events = sink.events();
    assert_eq!(events[0], json!({ "id": "t1", "kind": "session", "sessionId": "thr_1" }));
    let segments: Vec<&Value> = events.iter().filter(|e| e["kind"] == "segment").map(|e| &e["segment"]).collect();
    assert_eq!(*segments[1], json!({ "kind": "thinking", "toolId": "rs_1", "text": "Pensando" }));
    assert!(segments.iter().all(|s| s["text"] != "IGNORADO" && !s.to_string().contains("IGNORADO")), "another thread's delta is dropped");
    let command_done = segments.iter().rev().find(|s| s["toolId"] == "cmd_1").unwrap();
    assert_eq!(**command_done, json!({ "kind": "tool", "toolId": "cmd_1", "status": "done", "name": "Bash",
        "input": { "command": "npm test", "cwd": "C:\\QA\\projeto" }, "result": "ok 1\n", "resultIsError": false }));
    let message = segments.iter().rev().find(|s| s["toolId"] == "msg_1").unwrap();
    assert_eq!(message["text"], "Olá, ação🙂");
    let metrics: Vec<&Value> = events.iter().filter(|e| e["kind"] == "metrics").map(|e| &e["metrics"]).collect();
    let first_turn = json!({ "inputTokens": 1000, "cacheReadTokens": 200, "outputTokens": 300, "reasoningTokens": 50 });
    assert_eq!(metrics.len(), 2);
    assert_eq!(metrics[0]["turn"], first_turn);
    assert_eq!(metrics[1]["turn"], first_turn, "a repeated total is not counted twice");
    assert_eq!(*metrics[0], json!({ "scope": "session", "inputTokens": 1200, "outputTokens": 300, "cachedTokens": 200, "reasoningTokens": 50,
        "totalTokens": 1500, "contextWindow": 272000, "contextTokens": 1500, "turn": first_turn }));
    assert_eq!(*events.last().unwrap(), json!({ "id": "t1", "kind": "done", "aborted": false }));

    // Second turn on the same thread and process.
    send("t2", "de novo", json!({ "resume": "thr_1" })).await.unwrap();
    eventually("second turn done", || sink.events().iter().filter(|e| e["kind"] == "done").count() == 2).await;
    let second: Vec<Value> = sink.events().into_iter().filter(|e| e["id"] == "t2").collect();
    assert_eq!(second.iter().map(|e| e["kind"].as_str().unwrap()).collect::<Vec<_>>(), ["session", "metrics", "done"], "the late delta of turn 1 is dropped");
    assert_eq!(second[1]["metrics"]["turn"], json!({ "inputTokens": 600, "cacheReadTokens": 800, "outputTokens": 100, "reasoningTokens": 10 }));
    assert_eq!(launcher.launches.lock().unwrap().len(), 1);
    replayed.await.unwrap().unwrap();
}

#[tokio::test]
async fn replays_an_interrupted_turn() {
    let launcher = FakeLauncher::new(turn_responder());
    let (server, replayed) = replay(TURN_INTERRUPT);
    launcher.scripted.lock().unwrap().push_back(server);
    let sessions = CodexSessions::new(launcher.clone());
    let sink = Arc::new(Sink::default());
    let p = json!({ "id": "t9", "chatId": "chat", "cwd": "C:\\QA\\projeto", "prompt": "US$100 por $$pdf", "resume": "thr_9",
        "selection": { "provider": "codex", "profileId": "p1", "model": "", "permissionMode": "bypassPermissions" } });
    sessions.send(OWNER, sink.clone(), serde_json::from_value(p).unwrap(), None).await.unwrap();
    eventually("partial text", || sink.events().iter().any(|e| e["segment"]["text"] == "parcial")).await;
    sessions.abort(OWNER, "chat");
    eventually("done", || sink.events().iter().any(|e| e["kind"] == "done")).await;
    assert_eq!(*sink.events().last().unwrap(), json!({ "id": "t9", "kind": "done", "aborted": true }));
    replayed.await.unwrap().unwrap();
}

#[tokio::test]
async fn the_recorded_catalog_traffic_goes_through_the_client() {
    let (server, replayed) = replay(CATALOG);
    let mut incoming = server.take_incoming().unwrap();
    server.ready().await.unwrap();
    let models = server.request("model/list", json!({ "limit": 100 })).await.unwrap();
    let catalog = codex_models(models["data"].as_array().unwrap());
    assert_eq!(catalog[0]["id"], "gpt-5.5");
    assert_eq!(catalog[0]["label"], "GPT-5.5");
    assert_eq!(catalog[0]["default"], true);
    assert_eq!(catalog[0]["fast"], json!({ "id": "priority", "label": "Fast" }));
    assert_eq!(catalog[0]["efforts"], json!(["low", "medium", "high", "xhigh"]));
    assert_eq!(catalog[0]["defaultEffort"], "medium");
    assert!(catalog.iter().all(|m| m["provider"] == "codex" && m["label"].as_str().is_some_and(|l| l.starts_with("GPT-") || !m["id"].as_str().unwrap().starts_with("gpt-"))));
    let keys: Vec<&str> = catalog[0].as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["provider", "id", "label", "description", "efforts", "defaultEffort", "default", "fast"]);

    let skills = server.request("skills/list", json!({ "cwds": ["C:\\QA\\projeto"] })).await.unwrap();
    let commands = codex_skill_commands(&skills);
    assert_eq!(commands[0]["name"], "find-skills");
    assert_eq!(commands[0]["kind"], "skill");
    assert_eq!(codex_skill_refs(&skills)[0].path, "C:\\Users\\qa\\.agents\\skills\\find-skills\\SKILL.md");

    let account = server.request("account/read", json!({ "refreshToken": false })).await.unwrap();
    assert_eq!(account, json!({ "account": null, "requiresOpenaiAuth": true }));
    let refused = server.request("account/rateLimits/read", json!({})).await.unwrap_err();
    assert_eq!(refused, "codex account authentication required to read rate limits");
    // The interleaved notification reached the session channel, in order.
    match incoming.recv().await.unwrap() {
        Incoming::Message(m) => assert_eq!(m["method"], "remoteControl/status/changed"),
        other => panic!("{other:?}"),
    }
    replayed.await.unwrap().unwrap();
}

/* ---------------- The JSON-RPC client (tests/codex-server.test.cjs) ---------------- */

#[tokio::test]
async fn handshake_literal_json_and_split_utf8_bytes() {
    let (server, mut pipe) = pipe();
    let init = pipe.from_client.recv().await.unwrap();
    assert_eq!(init["method"], "initialize");
    assert_eq!(init["params"], json!({ "clientInfo": { "name": "prism", "version": "1.0.0" }, "capabilities": { "experimentalApi": true } }));
    let byte_by_byte = |value: Value| {
        for byte in format!("{value}\n").into_bytes() {
            let _ = pipe.to_client.send(vec![byte]);
        }
    };
    byte_by_byte(json!({ "id": init["id"], "result": {} }));
    server.ready().await.unwrap();
    assert_eq!(pipe.from_client.recv().await.unwrap(), json!({ "method": "initialized", "params": {} }));
    let reply = {
        let server = Arc::clone(&server);
        tokio::spawn(async move { server.request("model/list", json!({ "literal": "$(no-shell)" })).await })
    };
    let request = pipe.from_client.recv().await.unwrap();
    assert_eq!(request["params"]["literal"], "$(no-shell)");
    byte_by_byte(json!({ "id": request["id"], "result": { "text": "ação🙂" } }));
    assert_eq!(reply.await.unwrap().unwrap()["text"], "ação🙂");
    let mut incoming = server.take_incoming().unwrap();
    let _ = pipe.to_client.send(b"not json\n\n".to_vec());
    byte_by_byte(json!({ "method": "item/agentMessage/delta", "params": { "delta": "ç🙂" } }));
    match incoming.recv().await.unwrap() {
        Incoming::Message(m) => assert_eq!(m["params"]["delta"], "ç🙂"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn closing_rejects_pending_requests_and_reports_the_end_once() {
    let (server, mut pipe) = pipe();
    let init = pipe.from_client.recv().await.unwrap();
    let _ = pipe.to_client.send(format!("{}\n", json!({ "id": init["id"], "result": {} })).into_bytes());
    server.ready().await.unwrap();
    let mut incoming = server.take_incoming().unwrap();
    let pending = {
        let server = Arc::clone(&server);
        tokio::spawn(async move { server.request("turn/start", json!({})).await })
    };
    pipe.from_client.recv().await.unwrap();
    pipe.from_client.recv().await.unwrap();
    server.close();
    assert_eq!(pending.await.unwrap().unwrap_err(), "Codex App Server encerrado.");
    assert_eq!(server.request("x", json!({})).await.unwrap_err(), "Codex App Server fechado.");
    assert_eq!(incoming.recv().await.unwrap(), Incoming::Closed("Codex App Server encerrado.".to_string()));
    assert!(incoming.recv().await.is_none());
}

#[tokio::test]
async fn requests_time_out_and_errors_carry_their_message() {
    let (server, mut pipe) = pipe();
    let init = pipe.from_client.recv().await.unwrap();
    let _ = pipe.to_client.send(format!("{}\n", json!({ "id": init["id"], "result": {} })).into_bytes());
    server.ready().await.unwrap();
    assert_eq!(server.request_with_timeout("slow", json!({}), Duration::from_millis(50)).await.unwrap_err(), "Tempo esgotado: slow");
    let failing = {
        let server = Arc::clone(&server);
        tokio::spawn(async move { (server.request("a", json!({})).await, server.request("b", json!({})).await) })
    };
    for _ in 0..2 {
        loop {
            let msg = pipe.from_client.recv().await.unwrap();
            if msg["method"] == "a" {
                let _ = pipe.to_client.send(format!("{}\n", json!({ "id": 999, "result": "unknown id ignored" })).into_bytes());
                let _ = pipe.to_client.send(format!("{}\n", json!({ "id": msg["id"], "error": { "code": 1, "message": "Conta sem login" } })).into_bytes());
                break;
            }
            if msg["method"] == "b" {
                let _ = pipe.to_client.send(format!("{}\n", json!({ "id": msg["id"], "error": { "code": 1 } })).into_bytes());
                break;
            }
        }
    }
    let (a, b) = failing.await.unwrap();
    assert_eq!(a.unwrap_err(), "Conta sem login");
    assert_eq!(b.unwrap_err(), "Falha no Codex App Server.");
}

/// A stand-in CLI: records its arguments and `CODEX_HOME` in its folder, answers
/// `initialize`, writes to stderr and keeps running until killed.
fn fake_cli(dir: &std::path::Path) -> crate::profile_env::ProviderCommand {
    #[cfg(windows)]
    {
        let script = dir.join("fake-codex.cmd");
        std::fs::write(
            &script,
            "@echo off\r\necho %*> args.txt\r\necho %CODEX_HOME%> env.txt\r\necho {\"id\":1,\"result\":{}}\r\necho {\"method\":\"probe\",\"params\":{}}\r\necho falhou o login 1>&2\r\nping -n 30 127.0.0.1 > nul\r\n",
        )
        .unwrap();
        crate::profile_env::ProviderCommand { bin: "cmd.exe".into(), args: vec!["/d".into(), "/c".into(), script.into_os_string()] }
    }
    #[cfg(unix)]
    {
        let script = dir.join("fake-codex.sh");
        std::fs::write(
            &script,
            "echo \"$*\" > args.txt\necho \"$CODEX_HOME\" > env.txt\necho '{\"id\":1,\"result\":{}}'\necho '{\"method\":\"probe\",\"params\":{}}'\necho 'falhou o login' >&2\nsleep 30\n",
        )
        .unwrap();
        crate::profile_env::ProviderCommand { bin: "/bin/sh".into(), args: vec![script.into_os_string()] }
    }
}

#[tokio::test]
async fn spawn_runs_the_cli_with_its_args_env_and_folder_and_kills_it_on_close() {
    let dir = tempfile::tempdir().unwrap();
    let env = crate::profile_env::ProfileEnv { remove: crate::profile_env::REMOVED_VARS.to_vec(), set:vec![("CODEX_HOME", dir.path().join("home").into_os_string())] };
    let server = AppServer::spawn(&fake_cli(dir.path()), &env, false, Some(dir.path())).unwrap();
    server.ready().await.unwrap();
    let mut incoming = server.take_incoming().unwrap();
    match incoming.recv().await.unwrap() {
        Incoming::Message(m) => assert_eq!(m["method"], "probe"),
        other => panic!("{other:?}"),
    }
    // cmd.exe writes in the console code page.
    let read = |name: &str| String::from_utf8_lossy(&std::fs::read(dir.path().join(name)).unwrap()).into_owned();
    let args = read("args.txt");
    assert!(args.contains("app-server --listen stdio://"), "{args}");
    assert!(args.contains("cli_auth_credentials_store"), "a managed profile keeps its login in its folder: {args}");
    assert!(args.contains("features.default_mode_request_user_input=true"), "normal implementation turns can ask questions: {args}");
    assert!(args.contains("tools.experimental_request_user_input.enabled=true"), "the app-server exposes the native question tool: {args}");
    let env_seen = read("env.txt");
    assert!(env_seen.contains(&dir.path().join("home").to_string_lossy().to_string()), "{env_seen}");
    // Killed on close; the stderr tail is not the reason when we closed it.
    server.close();
    let closed = tokio::time::timeout(Duration::from_secs(10), incoming.recv()).await.unwrap().unwrap();
    assert_eq!(closed, Incoming::Closed("Codex App Server encerrado.".to_string()));
}

#[tokio::test]
async fn a_cli_that_exits_by_itself_reports_its_stderr() {
    let dir = tempfile::tempdir().unwrap();
    #[cfg(windows)]
    let command = {
        let script = dir.path().join("dies.cmd");
        std::fs::write(&script, "@echo off\r\necho Not logged in. Run codex login. 1>&2\r\nexit /b 3\r\n").unwrap();
        crate::profile_env::ProviderCommand { bin: "cmd.exe".into(), args: vec!["/d".into(), "/c".into(), script.into_os_string()] }
    };
    #[cfg(unix)]
    let command = {
        let script = dir.path().join("dies.sh");
        std::fs::write(&script, "echo 'Not logged in. Run codex login.' >&2\nexit 3\n").unwrap();
        crate::profile_env::ProviderCommand { bin: "/bin/sh".into(), args: vec![script.into_os_string()] }
    };
    let server = AppServer::spawn(&command, &crate::profile_env::ProfileEnv::default(), true, None).unwrap();
    assert_eq!(server.ready().await.unwrap_err(), "Not logged in. Run codex login.");
    let mut incoming = server.take_incoming().unwrap();
    assert_eq!(incoming.recv().await.unwrap(), Incoming::Closed("Not logged in. Run codex login.".to_string()));
}

/* ---------------- Queries (agentModels, agentCommands, providerUsage) ---------------- */

fn query_responder(log: Arc<Mutex<Vec<(String, Value)>>>, reply: Arc<Mutex<Value>>) -> Responder {
    Arc::new(move |method, params, _| {
        log.lock().unwrap().push((method.to_string(), params.clone()));
        match method {
            "model/list" => Some(if params.get("cursor").is_none() {
                json!({ "data": [{ "model": "gpt-5.4", "displayName": "gpt-5.4" }], "nextCursor": "p2" })
            } else {
                json!({ "data": [{ "model": "gpt-6.1-sol", "isDefault": true }], "nextCursor": null })
            }),
            "skills/list" => Some(json!({ "data": [{ "skills": [{ "name": "pdf", "description": "PDFs" }] }] })),
            "account/read" => Some(json!({ "account": { "email": "mock@example.invalid", "planType": "plus" } })),
            "account/rateLimits/read" => Some(json!({ "rateLimits": { "primary": { "usedPercent": 1 } } })),
            "account/rateLimitResetCredit/consume" => Some(reply.lock().unwrap().clone()),
            _ => None,
        }
    })
}

struct Queries {
    launcher: Arc<FakeLauncher>,
    queries: Arc<CodexQueries>,
    log: Arc<Mutex<Vec<(String, Value)>>>,
    reply: Arc<Mutex<Value>>,
}

impl Queries {
    fn new(accounts: &[(&str, &str)]) -> Self {
        let (log, reply) = (Arc::<Mutex<Vec<_>>>::default(), Arc::new(Mutex::new(json!({ "outcome": "reset" }))));
        let launcher = FakeLauncher::with_accounts(query_responder(log.clone(), reply.clone()), accounts);
        Self { queries: CodexQueries::new(launcher.clone()), launcher, log, reply }
    }

    fn requests(&self, method: &str) -> Vec<Value> {
        self.log.lock().unwrap().iter().filter(|(m, _)| m == method).map(|(_, p)| p.clone()).collect()
    }

    fn all_closed(&self) -> bool {
        self.launcher.fakes.lock().unwrap().iter().all(|(s, _)| s.is_closed())
    }
}

#[tokio::test]
async fn models_page_through_the_catalog_and_are_cached() {
    let q = Queries::new(&[]);
    let models = q.queries.models("p", false).await.unwrap();
    assert_eq!(models.as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect::<Vec<_>>(), ["gpt-6.1-sol", "gpt-5.4"]);
    assert_eq!(q.requests("model/list"), [json!({ "limit": 100 }), json!({ "limit": 100, "cursor": "p2" })]);
    assert!(q.all_closed(), "a one-shot server is always closed");
    q.queries.models("p", false).await.unwrap();
    assert_eq!(q.launcher.launches.lock().unwrap().len(), 1, "cached");
    q.queries.models("p", true).await.unwrap();
    assert_eq!(q.launcher.launches.lock().unwrap().len(), 2, "refresh reads again");
    q.queries.forget("p");
    q.queries.models("p", false).await.unwrap();
    assert_eq!(q.launcher.launches.lock().unwrap().len(), 3, "a login change drops the cache");
}

#[tokio::test]
async fn concurrent_reads_share_one_server_and_failures_are_not_cached() {
    let q = Queries::new(&[]);
    let (a, b) = tokio::join!(q.queries.models("p", false), q.queries.models("p", false));
    assert_eq!(a.unwrap(), b.unwrap());
    assert_eq!(q.launcher.launches.lock().unwrap().len(), 1);
    *q.launcher.fail.lock().unwrap() = Some(CodexError::new(CodexErrorKind::CliMissing, CLI_MISSING_MESSAGE));
    assert_eq!(q.queries.skills("p", "C:\\QA", false).await.unwrap_err().message, CLI_MISSING_MESSAGE);
    *q.launcher.fail.lock().unwrap() = None;
    let skills = q.queries.skills("p", "C:\\QA", false).await.unwrap();
    assert_eq!(skills, json!([{ "name": "pdf", "description": "PDFs", "argumentHint": null, "kind": "skill", "builtin": false }]));
    assert_eq!(q.requests("skills/list"), [json!({ "cwds": ["C:\\QA"] })]);
    assert_eq!(q.launcher.launches.lock().unwrap().last().unwrap().1.as_deref(), Some("C:\\QA"), "skills run in the folder");
    q.queries.skills("p", "", false).await.unwrap();
    assert_eq!(q.requests("skills/list")[1], json!({ "cwds": [] }), "per folder");
}

#[tokio::test]
async fn details_read_plan_and_limits_and_keep_a_stale_copy_on_failure() {
    let q = Queries::new(&[]);
    let details = q.queries.details("p", false).await.unwrap();
    assert_eq!(details["plan"], "Assinatura ChatGPT Plus");
    assert_eq!(details["email"], "mock@example.invalid");
    assert_eq!(details["limits"][0]["usedPercent"], 1);
    assert_eq!(q.requests("account/read"), [json!({ "refreshToken": false })]);
    q.queries.details("p", false).await.unwrap();
    assert_eq!(q.requests("account/read").len(), 1, "cached for a minute");
    *q.launcher.fail.lock().unwrap() = Some(CodexError::failed("offline"));
    let stale = q.queries.details("p", true).await.unwrap();
    assert_eq!(stale["stale"], true);
    assert_eq!(stale["error"], super::queries::DETAILS_ERROR);
    assert_eq!(stale["plan"], "Assinatura ChatGPT Plus", "the last good snapshot stays");
    let first = Queries::new(&[]);
    *first.launcher.fail.lock().unwrap() = Some(CodexError::failed("offline"));
    assert_eq!(first.queries.details("p", false).await.unwrap(), json!({ "limits": [], "stale": false, "error": super::queries::DETAILS_ERROR }));
    // A disabled or unknown profile fails even with a cached snapshot.
    assert_eq!(q.queries.details("disabled", false).await.unwrap_err().message, "disabled");
}

const KEY: &str = "abcdef12-3456";

#[tokio::test]
async fn reset_sends_the_key_returns_the_outcome_and_always_closes() {
    let q = Queries::new(&[]);
    *q.reply.lock().unwrap() = json!({ "outcome": "noCredit" });
    assert_eq!(q.queries.reset(&json!("p"), &json!(KEY), &json!("cred-1")).await.unwrap(), "noCredit");
    assert_eq!(q.requests("account/rateLimitResetCredit/consume")[0], json!({ "idempotencyKey": KEY, "creditId": "cred-1" }));
    q.queries.reset(&json!("p"), &json!(KEY), &Value::Null).await.unwrap();
    assert_eq!(q.requests("account/rateLimitResetCredit/consume")[1], json!({ "idempotencyKey": KEY }));
    assert!(q.all_closed());
    *q.reply.lock().unwrap() = json!({ "outcome": "weird" });
    assert!(q.queries.reset(&json!("p"), &json!(KEY), &Value::Null).await.unwrap_err().message.contains("desconhecido"));
    *q.reply.lock().unwrap() = json!({ "__error": "kaput" });
    assert_eq!(q.queries.reset(&json!("p"), &json!(KEY), &Value::Null).await.unwrap_err().message, "kaput");
    assert!(q.all_closed());
}

#[tokio::test]
async fn reset_validates_before_starting_anything() {
    let q = Queries::new(&[]);
    let long = "x".repeat(257);
    for (profile, key, credit) in [
        (json!(5), json!(KEY), Value::Null),
        (json!(""), json!(KEY), Value::Null),
        (json!("p"), json!("short"), Value::Null),
        (json!("p"), json!("has space here"), Value::Null),
        (json!("p"), json!(5), Value::Null),
        (json!("p"), json!(KEY), json!(5)),
        (json!("p"), json!(KEY), json!("")),
        (json!("p"), json!(KEY), json!(long)),
    ] {
        assert!(q.queries.reset(&profile, &key, &credit).await.is_err(), "{profile} {key} {credit}");
    }
    for profile in ["disabled", "unknown"] {
        assert_eq!(q.queries.reset(&json!(profile), &json!(KEY), &Value::Null).await.unwrap_err().message, "disabled");
    }
    assert!(q.launcher.launches.lock().unwrap().is_empty());
}

#[tokio::test]
async fn one_reset_at_a_time_per_account() {
    // The consume answers are held back and given by hand.
    let launcher = FakeLauncher::with_accounts(
        Arc::new(|m, _, _| (m != "account/rateLimitResetCredit/consume").then(|| json!({}))),
        &[("a", "/h/one"), ("b", "/h/one"), ("c", "/h/two")],
    );
    let queries = CodexQueries::new(launcher.clone());
    let first = {
        let queries = Arc::clone(&queries);
        tokio::spawn(async move { queries.reset(&json!("a"), &json!(KEY), &Value::Null).await })
    };
    eventually("first consume", || launcher.fakes.lock().unwrap().first().is_some_and(|(_, f)| !f.calls("account/rateLimitResetCredit/consume").is_empty())).await;
    let busy = queries.reset(&json!("b"), &json!(KEY), &Value::Null).await.unwrap_err();
    assert_eq!(busy.message, "Já há uma redefinição manual em andamento para esta conta.");
    let other = {
        let queries = Arc::clone(&queries);
        tokio::spawn(async move { queries.reset(&json!("c"), &json!(KEY), &Value::Null).await })
    };
    eventually("second consume", || launcher.fakes.lock().unwrap().len() == 2 && !launcher.fake(1).calls("account/rateLimitResetCredit/consume").is_empty()).await;
    for i in 0..2 {
        let fake = launcher.fake(i);
        let id = fake.calls("account/rateLimitResetCredit/consume")[0]["id"].clone();
        fake.send(json!({ "id": id, "result": { "outcome": "reset" } }));
    }
    assert_eq!(first.await.unwrap().unwrap(), "reset");
    assert_eq!(other.await.unwrap().unwrap(), "reset");
    // Released: the same account can reset again.
    let again = {
        let queries = Arc::clone(&queries);
        tokio::spawn(async move { queries.reset(&json!("b"), &json!(KEY), &Value::Null).await })
    };
    eventually("third consume", || launcher.fakes.lock().unwrap().len() == 3 && !launcher.fake(2).calls("account/rateLimitResetCredit/consume").is_empty()).await;
    let fake = launcher.fake(2);
    fake.send(json!({ "id": fake.calls("account/rateLimitResetCredit/consume")[0]["id"], "result": { "outcome": "reset" } }));
    assert_eq!(again.await.unwrap().unwrap(), "reset");
}

#[tokio::test]
async fn a_reset_timeout_reads_friendly_and_releases_the_account() {
    let q = Queries::new(&[]);
    *q.reply.lock().unwrap() = json!({ "__error": "Tempo esgotado: account/rateLimitResetCredit/consume" });
    assert_eq!(q.queries.reset(&json!("p"), &json!(KEY), &Value::Null).await.unwrap_err().message, "Tempo esgotado ao usar a redefinição manual do Codex.");
    *q.reply.lock().unwrap() = json!({ "outcome": "reset" });
    assert_eq!(q.queries.reset(&json!("p"), &json!(KEY), &Value::Null).await.unwrap(), "reset");
}

#[tokio::test]
async fn a_reset_drops_the_cached_usage() {
    let q = Queries::new(&[]);
    q.queries.details("p", false).await.unwrap();
    q.queries.details("p", false).await.unwrap();
    assert_eq!(q.requests("account/rateLimits/read").len(), 1);
    q.queries.reset(&json!("p"), &json!(KEY), &Value::Null).await.unwrap();
    q.queries.details("p", false).await.unwrap();
    assert_eq!(q.requests("account/rateLimits/read").len(), 2);
}

/* ---------------- Conversions ---------------- */

#[test]
fn native_items_become_segments() {
    let running = native_item(&json!({ "id": "c", "type": "commandExecution", "command": "ls" }), false).unwrap();
    assert_eq!(json!(running), json!({ "kind": "tool", "toolId": "c", "status": "running", "name": "Bash", "input": { "command": "ls" }, "result": "", "resultIsError": false }));
    let failed = native_item(&json!({ "id": "c", "type": "commandExecution", "exitCode": 2, "aggregatedOutput": "x" }), true).unwrap();
    assert_eq!((failed.status, failed.result_is_error), (Some(SegmentStatus::Error), Some(true)));
    let ok = native_item(&json!({ "id": "c", "type": "commandExecution", "exitCode": null, "status": "completed" }), true).unwrap();
    assert_eq!(ok.status, Some(SegmentStatus::Done));
    let change = native_item(&json!({ "id": "f", "type": "fileChange", "changes": [{ "path": "a", "kind": "add" }], "status": "failed" }), true).unwrap();
    assert_eq!(json!(change), json!({ "kind": "tool", "toolId": "f", "status": "error", "name": "Write", "input": { "changes": [{ "path": "a", "kind": "add" }] }, "result": "[{\"path\":\"a\",\"kind\":\"add\"}]" }));
    let mcp = native_item(&json!({ "id": "m", "type": "mcpToolCall", "tool": "search", "arguments": { "q": "x" }, "result": { "content": [] } }), true).unwrap();
    assert_eq!((mcp.name, mcp.input, mcp.result), (Some(json!("search")), Some(json!({ "q": "x" })), Some("{\"content\":[]}".to_string())));
    let web = native_item(&json!({ "id": "w", "type": "webSearch", "query": "q" }), false).unwrap();
    assert_eq!((web.name, web.result), (Some(json!("webSearch")), Some("\"\"".to_string())));
    assert_eq!(web.input.unwrap()["query"], "q", "no arguments: the item itself");
    let thinking = native_item(&json!({ "id": "r", "type": "reasoning", "summary": ["a", "b"], "content": ["c"] }), true).unwrap();
    assert_eq!(thinking.text.as_deref(), Some("a\nb\nc"));
    assert!(native_item(&json!({ "id": "u", "type": "userMessage" }), true).is_none());
    assert!(native_item(&json!({ "id": "u" }), true).is_none());
}

#[test]
fn async_questions_stay_with_the_native_message_instead_of_becoming_blocking_requests() {
    let item = json!({ "id": "async-q", "type": "agentMessage", "text": "Qual uso está sem cálculo?", "questions": [
        { "title": "Qual uso está sem cálculo?", "options": ["Tokens/contexto", "Limites da conta", "Os dois"] },
        { "title": "Detalhes", "options": null }, { "title": "", "options": ["invalid"] }
    ] });
    let segment = serde_json::to_value(native_item(&item, true).unwrap()).unwrap();
    assert_eq!(segment["toolId"], "async-q");
    assert_eq!(segment["questions"], json!([
        { "title": "Qual uso está sem cálculo?", "options": ["Tokens/contexto", "Limites da conta", "Os dois"] },
        { "title": "Detalhes" }
    ]));
    assert_eq!(segment["kind"], "text");
    assert_eq!(serde_json::to_value(native_item(&json!({ "id": "q", "type": "agentMessage", "questions": [{ "title": "Detalhes" }] }), true).unwrap()).unwrap()["questions"], json!([{ "title": "Detalhes" }]));
}

#[test]
fn turn_usage_is_the_total_minus_the_base() {
    let base = json!({ "totalTokens": 10, "inputTokens": 8, "cachedInputTokens": 2, "outputTokens": 2, "reasoningOutputTokens": 1 });
    let total = json!({ "totalTokens": 30, "inputTokens": 20, "cachedInputTokens": 5, "outputTokens": 10, "reasoningOutputTokens": 4 });
    assert_eq!(codex_turn_usage(&base, &total), Some(json!({ "inputTokens": 9, "cacheReadTokens": 3, "outputTokens": 8, "reasoningTokens": 3 })));
    assert_eq!(codex_turn_usage(&total, &base), None, "a restarted counter is not a negative turn");
    let cached_only = json!({ "totalTokens": 30, "inputTokens": 9, "cachedInputTokens": 20, "outputTokens": 2, "reasoningOutputTokens": 1 });
    assert_eq!(codex_turn_usage(&json!({}), &cached_only).unwrap()["inputTokens"], 0, "input never goes below zero");
    assert_eq!(codex_subtract(&json!({ "inputTokens": "x" }), &json!({})), json!({ "totalTokens": 0, "inputTokens": 0, "cachedInputTokens": 0, "outputTokens": 0, "reasoningOutputTokens": 0 }));
    let metrics = codex_metrics(&json!({ "total": { "inputTokens": 3, "totalTokens": null }, "modelContextWindow": 0 }), Some(&json!({ "inputTokens": 1, "costUsd": -1 })));
    assert_eq!(metrics, json!({ "scope": "session", "inputTokens": 3, "totalTokens": null, "turn": { "inputTokens": 1 } }));
}

#[test]
fn upgrade_tiers_and_labels_match_the_app() {
    assert_eq!(codex_upgrade_tier(&json!({})), None);
    assert_eq!(codex_upgrade_tier(&json!({ "serviceTiers": [] })), None);
    assert_eq!(codex_upgrade_tier(&json!({ "additionalSpeedTiers": ["default"] })), None);
    assert_eq!(codex_upgrade_tier(&json!({ "additionalSpeedTiers": ["default", "fast"] })), Some(json!({ "id": "fast", "label": "Fast" })));
    assert_eq!(
        codex_upgrade_tier(&json!({ "serviceTiers": [{ "id": "default", "name": "Padrão" }, { "id": "priority", "name": "Priority" }], "defaultServiceTier": "default" })),
        Some(json!({ "id": "priority", "label": "Priority" }))
    );
    assert_eq!(codex_upgrade_tier(&json!({ "serviceTiers": [{ "id": "p", "name": "Super long tier name" }], "defaultServiceTier": "p" })), Some(json!({ "id": "p", "label": "Fast" })));
    assert_eq!(codex_upgrade_tier(&json!({ "serviceTiers": [{ "id": "a" }, { "id": "b" }], "additionalSpeedTiers": ["z"] })), Some(json!({ "id": "a", "label": "Fast" })));
    assert_eq!(codex_upgrade_tier(&json!({ "serviceTiers": [{ "id": "a", "name": "Exactly12chr" }], "defaultServiceTier": "a" })), Some(json!({ "id": "a", "label": "Exactly12chr" })));
    for (id, display, label) in [
        ("gpt-6.1-sol", None, "GPT-6.1-Sol"),
        ("gpt-5.3-codex", None, "GPT-5.3-Codex"),
        ("gpt-5.4-mini", None, "GPT-5.4-Mini"),
        ("gpt-5.4", None, "GPT-5.4"),
        ("codex-auto-review", Some("Auto Review"), "Auto Review"),
        ("codex-auto-review", None, "codex-auto-review"),
    ] {
        assert_eq!(codex_model_label(id, display), label);
    }
}

#[test]
fn models_hide_reorder_keep_ultra_and_resolve_fast() {
    let out = codex_models(&[
        json!({ "model": "gpt-5.4", "displayName": "a", "description": "d1", "supportedReasoningEfforts": [{ "reasoningEffort": "low" }], "defaultReasoningEffort": "low" }),
        json!({ "model": "secret", "hidden": true }),
        json!({ "description": "no model" }),
        Value::Null,
        json!({ "model": "gpt-6.1-sol", "isDefault": true, "description": "d2", "defaultReasoningEffort": "ultra",
            "supportedReasoningEfforts": [{ "reasoningEffort": "medium" }, { "reasoningEffort": "ultra" }, { "reasoningEffort": "weird" }, { "reasoningEffort": "medium" }],
            "serviceTiers": [{ "id": "priority", "name": "Fast" }] }),
        json!({ "model": "gpt-5.4-mini", "defaultReasoningEffort": "nonsense" }),
    ]);
    assert_eq!(out.iter().map(|m| m["id"].as_str().unwrap()).collect::<Vec<_>>(), ["gpt-6.1-sol", "gpt-5.4", "gpt-5.4-mini"]);
    assert_eq!((out[0]["default"].clone(), out[1]["default"].clone()), (json!(true), json!(false)));
    assert_eq!(out[0]["efforts"], json!(["medium", "ultra"]));
    assert_eq!(out[0]["defaultEffort"], "ultra");
    assert_eq!(out[0]["fast"], json!({ "id": "priority", "label": "Fast" }));
    assert_eq!(out[0]["label"], "GPT-6.1-Sol");
    assert_eq!(out[1]["fast"], Value::Null);
    assert!(out[2].get("defaultEffort").is_none());
    assert_eq!(out[2]["efforts"], json!([]));
    let ids = |rows: &[Value]| codex_models(rows).iter().map(|m| m["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(ids(&[json!({ "model": "a", "isDefault": true }), json!({ "model": "b" })]), ["a", "b"]);
    assert_eq!(ids(&[json!({ "model": "a" }), json!({ "model": "b" })]), ["a", "b"]);
}

#[test]
fn skill_rows_and_refs_match_the_app() {
    let out = codex_skill_commands(&json!({ "data": [
        { "skills": [{ "name": "a", "description": "first" }, { "name": "off", "enabled": false }, { "name": "b" }] },
        { "skills": [{ "name": "a", "description": "second" }, { "name": "c", "enabled": true }] }
    ] }));
    assert_eq!(out.iter().map(|c| c["name"].as_str().unwrap()).collect::<Vec<_>>(), ["a", "b", "c"]);
    assert_eq!(out[0]["description"], "first");
    let descriptions = codex_skill_commands(&json!({ "data": [{ "skills": [
        { "name": "a", "description": "d", "interface": { "shortDescription": "i" }, "shortDescription": "s" },
        { "name": "b", "description": "   ", "interface": { "shortDescription": "i" }, "shortDescription": "s" },
        { "name": "c", "description": "", "interface": { "shortDescription": "  " }, "shortDescription": "s" },
        { "name": "d", "interface": { "shortDescription": "" }, "shortDescription": "" },
        { "name": "e", "description": 7, "interface": {}, "shortDescription": "s" },
        { "name": "f" }
    ] }] }));
    assert_eq!(descriptions.iter().map(|c| c["description"].as_str().unwrap()).collect::<Vec<_>>(), ["d", "i", "s", "", "s", ""]);
    for bad in [json!(null), json!({}), json!("x"), json!(3), json!({ "data": null }), json!({ "data": {} }), json!({ "data": [{ "skills": {} }] }), json!({ "data": [null, {}] })] {
        assert!(codex_skill_commands(&bad).is_empty() && codex_skill_refs(&bad).is_empty(), "{bad}");
    }
    let refs = codex_skill_refs(&json!({ "data": [
        { "skills": [{ "name": " a ", "path": "/a" }, { "name": "off", "path": "/o", "enabled": false }, { "name": "dup", "path": "/first" }, { "name": "nopath" }] },
        { "skills": [{ "name": "b", "path": "/b", "enabled": true }, { "name": "dup", "path": "/second" }, { "name": "nopath", "path": "/late" }, { "name": "blank", "path": "  " }] }
    ] }));
    assert_eq!(refs, [SkillRef { name: "a".into(), path: "/a".into() }, SkillRef { name: "dup".into(), path: "/first".into() }, SkillRef { name: "b".into(), path: "/b".into() }]);
}

#[test]
fn skill_tokens_resolve_like_the_composer() {
    let sk = |names: &[&str]| names.iter().map(|n| SkillRef { name: n.to_string(), path: format!("/s/{n}/SKILL.md") }).collect::<Vec<_>>();
    let names = |prompt: &str, skills: &[SkillRef]| codex_skill_inputs(prompt, skills).iter().map(|i| i["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    let pdf = sk(&["pdf"]);
    for prompt in ["$pdf x", "a $pdf", "a\t$pdf", "a\n$pdf", "a\u{a0}$pdf", "use $pdf.", "use $pdf, ok", "use $pdf!?"] {
        assert_eq!(names(prompt, &pdf), ["pdf"], "{prompt:?}");
    }
    let s = sk(&["pdf", "100"]);
    for prompt in ["US$100", "a$pdf", "$$pdf", "($pdf)", "x ($pdf)", "$PDF", "$pdfx"] {
        assert!(names(prompt, &s).is_empty(), "{prompt:?}");
    }
    assert_eq!(names("$PDF", &sk(&["PDF"])), ["PDF"]);
    assert_eq!(names("$a.b", &sk(&["a.b"])), ["a.b"]);
    assert_eq!(names("$a.", &sk(&["a."])), ["a."]);
    assert_eq!(names("$a.", &sk(&["a"])), ["a"]);
    assert_eq!(names("$b then $a and $b $a. $c", &sk(&["a", "b"])), ["b", "a"]);
    assert!(codex_skill_inputs("$pdf", &[]).is_empty() && codex_skill_inputs("pdf", &pdf).is_empty());
    assert_eq!(codex_skill_inputs("$pdf", &pdf), [json!({ "type": "skill", "name": "pdf", "path": "/s/pdf/SKILL.md" })]);
    assert_eq!(skill_tokens("$a $b$c  $ $d"), ["a", "b", "d"]);
}

#[test]
fn plans_resets_and_outcomes_match_the_app() {
    for (plan, label) in [
        ("plus", "Assinatura ChatGPT Plus"),
        ("pro", "Assinatura ChatGPT Pro 20x"),
        ("prolite", "Assinatura ChatGPT Pro 5x"),
        ("business", "Assinatura ChatGPT Business"),
        ("self_serve_business_usage_based", "Assinatura ChatGPT Business"),
        ("enterprise", "Assinatura ChatGPT Enterprise"),
        ("enterprise_cbp_usage_based", "Assinatura ChatGPT Enterprise"),
        ("unknown", "Assinatura ChatGPT"),
        ("new_tier", "Assinatura ChatGPT New Tier"),
    ] {
        assert_eq!(codex_plan_label(Some(&json!(plan))).as_deref(), Some(label));
    }
    for bad in [json!(""), json!(null), json!("  ")] {
        assert_eq!(codex_plan_label(Some(&bad)), None);
    }
    assert_eq!(codex_plan_label(None), None);

    for bad in [json!(null), json!("x"), json!({}), json!({ "availableCount": -1 }), json!({ "availableCount": "2" })] {
        assert_eq!(codex_reset_credits(Some(&bad)), None, "{bad}");
    }
    assert_eq!(codex_reset_credits(Some(&json!({ "availableCount": 3 }))), Some(json!({ "availableCount": 3, "credits": null })));
    assert_eq!(codex_reset_credits(Some(&json!({ "availableCount": 2.9 }))).unwrap()["availableCount"], 2);
    let r = codex_reset_credits(Some(&json!({ "availableCount": 5, "credits": [
        { "status": "available", "grantedAt": 1 }, { "id": "a", "status": "available" }, { "id": "b", "status": "available", "grantedAt": "1" },
        { "id": "c", "status": "available", "grantedAt": 1, "expiresAt": "soon" },
        { "id": "d", "status": "weird", "grantedAt": 10, "expiresAt": null, "title": 5, "description": {} },
        { "id": "e", "status": "redeeming", "grantedAt": 11, "title": "T", "description": "D" },
        { "id": "f", "status": "redeemed", "grantedAt": 12, "expiresAt": 1793295847 }, null, "x"] })))
    .unwrap();
    assert_eq!(r["credits"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect::<Vec<_>>(), ["d", "e", "f"]);
    assert_eq!(r["credits"][0], json!({ "id": "d", "status": "unknown", "grantedAt": 10, "expiresAt": null, "title": null, "description": null }));
    assert_eq!(r["credits"][1]["status"], "redeeming");
    assert_eq!(r["credits"][2]["expiresAt"], 1793295847);
    assert_eq!(codex_reset_credits(Some(&json!({ "availableCount": 0, "credits": [] }))), Some(json!({ "availableCount": 0, "credits": [] })));

    for outcome in RESET_OUTCOMES {
        assert_eq!(codex_reset_outcome(&json!({ "outcome": outcome })), Ok(outcome));
    }
    for bad in [json!({ "outcome": "other" }), json!({}), json!(null), json!("reset"), json!(42), json!({ "outcome": null })] {
        assert!(codex_reset_outcome(&bad).is_err());
    }
    for (kind, label) in [
        ("workspace_member_usage_limit", "Limite de uso atingido (membro do workspace)"),
        ("workspace_owner", "Limite de uso atingido (workspace)"),
        ("credits_depleted", "Limite de uso atingido (créditos esgotados)"),
        ("rate_limited", "Limite de uso atingido"),
    ] {
        assert_eq!(limit_reached_label(kind), label);
    }
}

#[test]
fn details_lead_with_the_account_bucket_and_read_like_the_app() {
    let data = json!({
        "rateLimits": { "limitId": "codex", "planType": "plus", "primary": { "usedPercent": 100, "windowDurationMins": 300, "resetsAt": 1791574662 },
            "secondary": { "usedPercent": 28, "windowDurationMins": 10080, "resetsAt": 1792114338 } },
        "rateLimitResetCredits": { "availableCount": 2, "credits": [
            { "id": "RateLimitResetCredit_a", "resetType": "codexRateLimits", "status": "available", "grantedAt": 1790703847, "expiresAt": 1793295847, "title": "Full reset (Weekly + 5 hr)", "description": "x" },
            { "id": "RateLimitResetCredit_b", "resetType": "codexRateLimits", "status": "available", "grantedAt": 1791408537, "expiresAt": 1794000537, "title": "Full reset (Weekly + 5 hr)", "description": "x" }] }
    });
    let r = codex_details(&json!({ "account": { "email": "mock@example.invalid", "planType": "plus" } }), &data, 42);
    assert_eq!((r["plan"].as_str(), r["tier"].as_str(), r["email"].as_str()), (Some("Assinatura ChatGPT Plus"), Some("plus"), Some("mock@example.invalid")));
    assert_eq!(r["resetCredits"]["availableCount"], 2);
    assert_eq!(r["resetCredits"]["credits"][0]["expiresAt"], 1793295847);
    assert_eq!(r["limits"].as_array().unwrap().len(), 2);
    assert_eq!(r["limits"][0], json!({ "id": "codex:primary", "label": "codex · 5h", "name": null, "usedPercent": 100, "resetsAt": 1791574662, "windowMinutes": 300 }));
    assert_eq!(r["limits"][1]["label"], "codex · 7 dias");
    assert_eq!(r["extras"], json!([]));
    assert!(r.get("unavailable").is_none());
    assert_eq!(r["updatedAt"], 42);

    let buckets = json!({
        "rateLimits": { "limitId": "main", "limitName": "Weekly", "primary": { "usedPercent": 5, "windowDurationMins": 90 } },
        "rateLimitsByLimitId": {
            "extra": { "limitId": "extra", "limitName": "Spark", "primary": { "usedPercent": 50, "windowDurationMins": 0 },
                "credits": { "balance": "12.5" }, "rateLimitReachedType": "workspace_member_limit",
                "individualLimit": { "used": 3, "limit": 10, "remainingPercent": 70, "resetsAt": 0 } },
            "main": { "limitId": "main", "limitName": "Weekly", "primary": { "usedPercent": 5, "windowDurationMins": 90 }, "credits": { "unlimited": true } }
        }
    });
    let r = codex_details(&json!({}), &buckets, 1);
    assert_eq!(r["limits"][0], json!({ "id": "main:primary", "label": "Weekly · 1.5h", "name": "Weekly", "usedPercent": 5, "windowMinutes": 90 }));
    assert_eq!(r["limits"][1], json!({ "id": "extra:primary", "label": "Spark · Janela da conta", "name": "Spark", "usedPercent": 50 }));
    assert_eq!(r["extras"], json!([
        { "label": "Weekly · créditos", "value": "Ilimitados" },
        { "label": "Spark · créditos", "value": "12.5" },
        { "label": "Spark · limite individual", "value": "3 / 10 · 70% disponível" },
        { "label": "Spark", "value": "Limite de uso atingido (membro do workspace)" }
    ]));
    assert!(r.get("plan").is_none() && r.get("email").is_none() && r.get("tier").is_none());

    let renew = codex_details(&json!({}), &json!({ "rateLimits": { "individualLimit": { "used": 1, "limit": 2, "remainingPercent": 50, "resetsAt": 1791574662 } } }), 1);
    let value = renew["extras"][0]["value"].as_str().unwrap();
    assert!(value.starts_with("1 / 2 · 50% disponível · renova "), "{value}");
    let when = value.rsplit("renova ").next().unwrap();
    assert_eq!(when.len(), "dd/mm/aaaa, hh:mm:ss".len(), "{when}");
    assert_eq!(renew["unavailable"], "O provedor não informou janelas de uso para esta conta.");
    let none = codex_details(&json!({ "account": null }), &json!({}), 1);
    assert_eq!(none["limits"], json!([]));
    assert!(none.get("resetCredits").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn simultaneous_first_requests_open_one_server_only() {
    for round in 0..5 {
        let q = Queries::new(&[]);
        let profile = format!("p{round}");
        let tasks: Vec<_> = (0..8)
            .map(|_| {
                let (queries, profile) = (Arc::clone(&q.queries), profile.clone());
                tokio::spawn(async move { queries.models(&profile, false).await })
            })
            .collect();
        let mut answers = Vec::new();
        for task in tasks {
            answers.push(task.await.unwrap().unwrap());
        }
        assert!(answers.iter().all(|a| *a == answers[0]));
        assert_eq!(q.launcher.launches.lock().unwrap().len(), 1, "round {round}");
        // The same for the skills of one folder.
        let tasks: Vec<_> = (0..8)
            .map(|_| {
                let queries = Arc::clone(&q.queries);
                tokio::spawn(async move { queries.skills("s", "C:\\QA", false).await })
            })
            .collect();
        for task in tasks {
            task.await.unwrap().unwrap();
        }
        assert_eq!(q.launcher.launches.lock().unwrap().len(), 2, "one more server for the skills, round {round}");
    }
}

/// The first server never answers `model/list`; later ones do.
fn hangs_on_the_first_server() -> Responder {
    Arc::new(|method, _, index| match method {
        "model/list" if index == 0 => None,
        "model/list" => Some(json!({ "data": [{ "model": "gpt-6.1-sol", "isDefault": true }], "nextCursor": null })),
        _ => Some(json!({})),
    })
}

#[tokio::test]
async fn a_request_dropped_midway_frees_the_key_for_the_next_one() {
    let launcher = FakeLauncher::new(hangs_on_the_first_server());
    let queries = CodexQueries::new(launcher.clone());

    // The caller gives up while the server is still silent: its future is dropped.
    let gave_up = tokio::time::timeout(Duration::from_millis(150), queries.models("p", false)).await;
    assert!(gave_up.is_err(), "the first read hangs");
    assert_eq!(launcher.launches.lock().unwrap().len(), 1);

    // The next request reads again, with a server of its own, instead of waiting for ever.
    let models = tokio::time::timeout(Duration::from_secs(10), queries.models("p", false)).await.expect("the key was freed").unwrap();
    assert_eq!(models[0]["id"], "gpt-6.1-sol");
    assert_eq!(launcher.launches.lock().unwrap().len(), 2);
    // And that answer is the one kept.
    queries.models("p", false).await.unwrap();
    assert_eq!(launcher.launches.lock().unwrap().len(), 2, "cached after the retry");
}

#[tokio::test]
async fn a_caller_waiting_on_a_read_that_is_dropped_reads_for_itself() {
    let launcher = FakeLauncher::new(hangs_on_the_first_server());
    let queries = CodexQueries::new(launcher.clone());

    // A starts the read and is dropped at 200 ms; B joined it at 20 ms and must not hang.
    let (a, b) = tokio::join!(tokio::time::timeout(Duration::from_millis(200), queries.models("p", false)), async {
        tokio::time::sleep(Duration::from_millis(20)).await;
        tokio::time::timeout(Duration::from_secs(10), queries.models("p", false)).await
    });
    assert!(a.is_err(), "A was cut off");
    let b = b.expect("B was left waiting for a read that no longer exists").unwrap();
    assert_eq!(b[0]["id"], "gpt-6.1-sol");
    assert_eq!(launcher.launches.lock().unwrap().len(), 2, "A's server and B's own");
}

#[tokio::test]
async fn steering_targets_the_active_native_turn_and_keeps_it_running() {
    let base = turn_responder();
    let f = Fixture::with(Arc::new(move |m, p, i| if m == "turn/steer" { Some(json!({})) } else { base(m, p, i) }));
    let s = f.started("logical", json!({})).await;
    assert!(f.sessions.steer(OTHER, "chat", "logical", "wrong owner".to_string(), vec![]).await.is_err());
    assert!(f.sessions.steer(OWNER, "chat", "stale", "wrong turn".to_string(), vec![]).await.is_err());
    assert!(s.calls("turn/steer").is_empty());
    let images = vec![json!({"mime":"image/png","data":"aGVsbG8="})];
    f.sessions.steer(OWNER, "chat", "logical", "do this now".to_string(), images).await.unwrap();
    assert_eq!(s.calls("turn/steer")[0]["params"], json!({
        "threadId":"thread-0", "expectedTurnId":"native-1",
        "input":[{"type":"text","text":"do this now","text_elements":[]},{"type":"image","url":"data:image/png;base64,aGVsbG8="}]
    }));
    assert_eq!(s.calls("turn/start").len(), 1);
    assert!(s.calls("turn/interrupt").is_empty());
    assert!(f.sink.kinds("done").is_empty());
    f.sessions.abort(OWNER, "chat");
    assert!(f.sessions.steer(OWNER, "chat", "logical", "after stop".to_string(), vec![]).await.is_err());
}

#[tokio::test]
async fn an_unresponsive_codex_interrupt_finishes_aborted_and_can_start_again() {
    let f = Fixture::new();
    let s = f.started("logical", json!({})).await;
    f.sessions.abort(OWNER, "chat");
    eventually("native interrupt", || !s.calls("turn/interrupt").is_empty()).await;
    // The peer acknowledges interruption but never sends turn/completed.
    eventually("forced aborted completion", || !f.sink.kinds("done").is_empty()).await;
    assert_eq!(f.sink.kinds("done")[0]["aborted"], true);
    assert!(f.sink.kinds("error").is_empty());
    let fresh = f.started("next", json!({})).await;
    assert_eq!(fresh.index, 1);
    assert_eq!(fresh.calls("turn/start").len(), 1);
}


#[tokio::test]
async fn dropping_an_unaccepted_send_releases_the_chat_before_another_message() {
    let f=Fixture::new();
    let pending=f.sessions.send(OWNER, f.sink.clone(), payload("cancelled", json!({})), None);
    assert!(f.sessions.busy("chat"));
    drop(pending);
    assert!(!f.sessions.busy("chat"), "dropping a start must release its chat claim");
    f.started("next", json!({})).await;
}

#[tokio::test]
async fn cancelling_a_polled_send_during_account_check_releases_its_claim() {
    let f=Fixture::new();
    let task=tokio::spawn(f.sessions.send(OWNER, f.sink.clone(), payload("cancelled", json!({"selection":{"profileId":"stall"}})), None));
    for _ in 0..4 { tokio::task::yield_now().await; }
    assert!(f.sessions.busy("chat"));
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(!f.sessions.busy("chat"), "cancelled initialization must release its claim");
    f.started("next", json!({})).await;
}

#[tokio::test]
async fn dropping_a_resumed_send_preserves_the_idle_native_session() {
    let f=Fixture::new();
    let native=f.started("first", json!({})).await;
    native.notify("turn/completed", json!({"threadId":"thread-0", "turn":{"status":"completed"}}));
    eventually("first done", || !f.sessions.busy("chat")).await;
    let pending=f.sessions.send(OWNER,f.sink.clone(),payload("cancelled",json!({"resume":"thread-0"})),None);
    drop(pending);
    assert!(!f.sessions.busy("chat"));
    f.started("next",json!({"resume":"thread-0"})).await;
    assert_eq!(f.launcher.launches.lock().unwrap().len(),1);
}


#[tokio::test]
async fn a_late_abort_of_the_previous_turn_never_interrupts_the_next_one() {
    let f=Fixture::new();
    let native=f.started("first",json!({})).await;
    native.notify("turn/completed",json!({"threadId":"thread-0", "turn":{"status":"completed"}}));
    eventually("first done",|| !f.sessions.busy("chat")).await;
    f.started("next",json!({"resume":"thread-0"})).await;
    f.sessions.abort_turn(OWNER,"chat","first");
    tokio::time::sleep(Duration::from_millis(2200)).await;
    assert!(f.sessions.busy("chat"));
    assert!(native.calls("turn/interrupt").is_empty());
    f.sessions.abort_turn(OWNER,"chat","next");
    eventually("next interrupted",|| !native.calls("turn/interrupt").is_empty()).await;
    native.notify("turn/completed",json!({"threadId":"thread-0", "turn":{"status":"interrupted"}}));
    eventually("next done",|| !f.sessions.busy("chat")).await;
}
