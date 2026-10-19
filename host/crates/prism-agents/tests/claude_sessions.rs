//! Session behavior of `prism_agents::claude` against a scripted CLI: the
//! Rust side of tests/native-claude, tests/claude-fast and the Claude part
//! of tests/usage-turn (which exercise src/main/ipc/claudeAgent.ts).

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use prism_agents::claude::profiles::BoxFuture;
use prism_agents::claude::{ClaudeAgents, ClaudeProfiles, CliCommand, Emitter, Exit, Input, LaunchEnv, LaunchSpec, Launcher, PermissionReply, QuestionReply, SendPayload, Spawned};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

const OWNER: u64 = 1;
const OTHER: u64 = 2;

struct Process {
    spec: LaunchSpec,
    input: tokio::sync::Mutex<mpsc::UnboundedReceiver<Input>>,
    output: Mutex<Option<mpsc::UnboundedSender<String>>>,
    exit: Mutex<Option<oneshot::Sender<Exit>>>,
    ignore_kill: AtomicBool,
}

impl Process {
    fn emit(&self, msg: Value) {
        if let Some(tx) = self.output.lock().unwrap().as_ref() {
            tx.send(msg.to_string()).unwrap();
        }
    }
    fn exit(&self, code: i32) {
        self.output.lock().unwrap().take();
        if let Some(tx) = self.exit.lock().unwrap().take() {
            let _ = tx.send(Exit { code: Some(code) });
        }
    }
    async fn next(&self) -> Option<Input> {
        tokio::time::timeout(Duration::from_secs(5), self.input.lock().await.recv()).await.ok().flatten()
    }
    async fn line(&self) -> Value {
        match self.next().await {
            Some(Input::Line(line)) => serde_json::from_str(&line).unwrap(),
            other => panic!("esperava uma linha, veio {other:?}"),
        }
    }
    /// Nothing more written for a moment.
    async fn quiet(&self) -> bool {
        tokio::time::timeout(Duration::from_millis(150), self.input.lock().await.recv()).await.is_err()
    }
    fn arg(&self, prefix: &str) -> Option<String> {
        self.spec.args.iter().find_map(|a| a.strip_prefix(prefix).map(str::to_string))
    }
}

#[derive(Default)]
struct Scripted {
    procs: Mutex<Vec<Arc<Process>>>,
}

impl Launcher for Scripted {
    fn launch(&self, spec: &LaunchSpec) -> std::io::Result<Spawned> {
        let (input_tx, input_rx) = mpsc::unbounded_channel();
        let (output_tx, output_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = oneshot::channel();
        let p = Arc::new(Process { spec: spec.clone(), input: tokio::sync::Mutex::new(input_rx), output: Mutex::new(Some(output_tx)), exit: Mutex::new(Some(exit_tx)), ignore_kill: AtomicBool::new(false) });
        let killed = Arc::clone(&p);
        self.procs.lock().unwrap().push(p);
        Ok(Spawned { input: input_tx, output: output_rx, exit: exit_rx, kill: Box::new(move || {
            if !killed.ignore_kill.load(Ordering::Relaxed) { killed.exit(1); }
        }) })
    }
}

struct Profiles;

impl ClaudeProfiles for Profiles {
    fn environment(&self, profile: Option<&str>) -> Result<LaunchEnv, String> {
        if profile == Some("disabled") {
            return Err("Esta conta está desativada. Ative-a no gerenciador de contas.".into());
        }
        Ok(LaunchEnv { remove: Vec::new(), set: vec![("PROFILE".into(), profile.unwrap_or("ambient-claude").into())] })
    }
    fn command<'a>(&'a self, _profile: Option<&'a str>) -> BoxFuture<'a, Option<CliCommand>> {
        Box::pin(async { Some(CliCommand { program: "claude".into(), args: Vec::new() }) })
    }
    fn version<'a>(&'a self, _command: &'a CliCommand) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { Some("2.1.289".into()) })
    }
}

struct Fixture {
    agents: ClaudeAgents,
    launcher: Arc<Scripted>,
    events: Arc<Mutex<Vec<(String, Value)>>>,
    emit: Emitter,
}

impl Fixture {
    fn new() -> Self {
        let launcher = Arc::new(Scripted::default());
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let emit: Emitter = Arc::new(move |c: &str, d: Value| sink.lock().unwrap().push((c.to_string(), d)));
        Self { agents: ClaudeAgents::new(Arc::new(Profiles), launcher.clone()), launcher, events, emit }
    }
    fn proc(&self, n: usize) -> Arc<Process> {
        Arc::clone(&self.launcher.procs.lock().unwrap()[n])
    }
    fn procs(&self) -> usize {
        self.launcher.procs.lock().unwrap().len()
    }
    async fn send_as(&self, client: u64, id: &str, resume: Option<&str>, profile: &str) -> bool {
        let payload: SendPayload = serde_json::from_value(json!({"id": id, "permissionScope": "chat", "chat": {"id": "chat"}, "prompt": "hello", "cwd": "C:\\QA",
            "model": "sonnet", "effort": "high", "profileId": profile, "resume": resume})).unwrap();
        self.agents.send(client, Arc::clone(&self.emit), payload).await
    }
    async fn send(&self, id: &str, resume: Option<&str>, profile: &str) -> bool {
        self.send_as(OWNER, id, resume, profile).await
    }
    fn of(&self, channel: &str) -> Vec<Value> {
        self.events.lock().unwrap().iter().filter(|(c, _)| c == channel).map(|(_, d)| d.clone()).collect()
    }
    async fn settle(&self) {
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
    /// Skips the initialize request and returns the user message text.
    async fn started(&self, p: &Process) -> String {
        assert_eq!(p.line().await["request"]["subtype"], "initialize");
        p.line().await["message"]["content"].as_str().unwrap().to_string()
    }
}

fn init(session: &str) -> Value {
    json!({"type": "system", "subtype": "init", "session_id": session, "model": "claude-sonnet-5"})
}

#[tokio::test]
async fn subagents_are_linked_to_the_spawning_turn_and_never_contaminate_parent_output() {
    let f = Fixture::new();
    assert!(f.send("parent-turn", None, "ambient-claude").await);
    let p = f.proc(0); f.started(&p).await;
    assert!(p.spec.args.iter().any(|arg| arg == "--forward-subagent-text"));
    p.emit(init("native"));
    p.emit(json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "spawn", "name": "Agent", "input": {"description": "Revisar testes", "subagent_type": "Explore"}}]}}));
    p.emit(json!({"type": "system", "subtype": "task_started", "task_id": "native-child", "tool_use_id": "spawn", "task_type": "local_agent"}));
    p.emit(json!({"type": "stream_event", "parent_tool_use_id": "spawn", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Resposta do filho"}}}));
    p.emit(json!({"type": "assistant", "parent_tool_use_id": "spawn", "message": {"content": [{"type": "tool_use", "id": "read", "name": "Read", "input": {"file_path": "test.ts"}}]}}));
    p.emit(result(json!({})));
    f.settle().await;
    assert!(f.send("second-turn", Some("native"), "ambient-claude").await);
    p.emit(json!({"type": "system", "subtype": "task_notification", "task_id": "native-child", "status": "completed", "summary": "Pronto"}));
    f.settle().await;
    let events = f.of("agent:subagent");
    assert!(events.iter().any(|event| event["id"] == "parent-turn" && event["agent"]["id"] == "spawn" && event["agent"]["text"] == "Resposta do filho"));
    assert!(events.iter().any(|event| event["id"] == "parent-turn" && event["agent"]["status"] == "completed"));
    assert!(f.of("agent:text").is_empty());
    assert!(!f.of("agent:tool").iter().any(|tool| tool["toolId"] == "read"));
    p.exit(0);
}

#[tokio::test]
async fn child_messages_use_verified_recipients_and_only_acknowledge_parent_forwarding() {
    let f = Fixture::new();
    assert!(f.send("origin", None, "ambient-claude").await);
    let p = f.proc(0); f.started(&p).await;
    let mut system = init("native"); system["tools"] = json!(["Task", "SendMessage"]); p.emit(system);
    p.emit(json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "spawn", "name": "Agent", "input": {"description": "Revisar"}}]}}));
    f.settle().await;
    assert!(f.agents.message_subagent(OWNER, "chat", "origin", "spawn", "Continue").is_err(), "the spawn tool ID is not a native recipient");
    p.emit(json!({"type": "system", "subtype": "task_started", "task_id": "real-native-target", "tool_use_id": "spawn", "task_type": "local_agent"}));
    f.settle().await;
    assert!(f.agents.message_subagent(OTHER, "chat", "origin", "spawn", "Continue").is_err());
    assert!(f.agents.message_subagent(OWNER, "chat", "wrong-origin", "spawn", "Continue").is_err());
    assert!(f.agents.message_subagent(OWNER, "another-chat", "origin", "spawn", "Continue").is_err());
    let message = "Compare \"a\"\ncom b";
    let ack = f.agents.message_subagent(OWNER, "chat", "origin", "spawn", message).unwrap();
    assert_eq!(ack, json!({"delivery": "parent", "rootTurnId": "origin", "messageTarget": "real-native-target"}));
    let input = p.line().await;
    assert!(input["parent_tool_use_id"].is_null());
    assert_eq!(input["priority"], "now");
    let text = input["message"]["content"].as_str().unwrap();
    let data: Value = serde_json::from_str(text.rsplit_once("\n\n").unwrap().1).unwrap();
    assert_eq!(data, json!({"to": "real-native-target", "message": message}));
    assert!(!f.of("agent:subagent").iter().any(|event| event["agent"]["segment"]["kind"] == "user"), "the parent receipt does not fabricate a child transcript entry");
    p.emit(result(json!({}))); f.settle().await;
    assert!(f.agents.message_subagent(OWNER, "chat", "origin", "spawn", message).is_err(), "an idle parent must start a separate visible turn in the engine");
    assert!(f.send("current-parent", Some("native"), "ambient-claude").await);
    assert_eq!(p.line().await["message"]["content"], "hello");
    let ack = f.agents.message_subagent(OWNER, "unified:chat", "origin", "real-native-target", message).unwrap();
    assert_eq!(ack["rootTurnId"], "current-parent");
    p.line().await;
    p.emit(json!({"type": "system", "subtype": "task_started", "task_id": "real-native-target", "tool_use_id": "new-send-message-tool", "task_type": "local_agent", "run_id": "002"}));
    f.settle().await;
    let resumed = f.of("agent:subagent").pop().unwrap();
    assert_eq!(resumed["id"], "origin"); assert_eq!(resumed["agent"]["id"], "spawn");
    p.exit(0);
}

#[tokio::test]
async fn child_forwarding_requires_send_message_capability_and_respects_parent_approval() {
    let f = Fixture::new();
    assert!(f.send("origin", None, "ambient-claude").await);
    let p = f.proc(0); f.started(&p).await; p.emit(init("native"));
    p.emit(json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "spawn", "name": "Agent", "input": {"description": "Revisar"}}]}}));
    p.emit(json!({"type": "system", "subtype": "task_started", "task_id": "native-child", "tool_use_id": "spawn", "task_type": "local_agent"}));
    f.settle().await;
    assert!(f.agents.message_subagent(OWNER, "chat", "origin", "spawn", "Continue").unwrap_err().contains("SendMessage"));
    let mut system = init("native"); system["tools"] = json!(["Task", "SendMessage"]); p.emit(system);
    p.emit(can_use_tool("root-permission", "Bash")); f.settle().await;
    assert!(f.agents.message_subagent(OWNER, "chat", "origin", "spawn", "Continue").unwrap_err().contains("aprovação ou pergunta"));
    assert!(p.quiet().await);
    p.exit(0);
}
fn text(t: &str) -> Value {
    json!({"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": t}}})
}
fn result(extra: Value) -> Value {
    let mut r = json!({"type": "result", "subtype": "success", "session_id": "native", "is_error": false});
    r.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    r
}
fn mu(i: f64, o: f64, cr: f64, cw: f64, th: f64, cost: f64) -> Value {
    json!({"inputTokens": i, "outputTokens": o, "cacheReadInputTokens": cr, "cacheCreationInputTokens": cw, "thinkingTokens": th, "costUSD": cost})
}
fn can_use_tool(request: &str, tool: &str) -> Value {
    json!({"type": "control_request", "request_id": request, "request": {"subtype": "can_use_tool", "tool_name": tool, "input": {"command": "echo hi"}, "tool_use_id": "tool",
        "permission_suggestions": [{"type": "addRules", "rules": [{"toolName": tool}], "behavior": "allow", "destination": "session"}]}})
}

#[tokio::test]
async fn one_live_process_per_chat_keeps_turn_ids_and_moves_when_the_route_changes() {
    let f = Fixture::new();
    assert!(f.send("first", None, "ambient-claude").await);
    assert_eq!(f.procs(), 1);
    let p = f.proc(0);
    assert_eq!(p.spec.env.get("PROFILE").unwrap(), "ambient-claude");
    assert_eq!(f.started(&p).await, "hello");
    p.emit(init("native"));
    p.emit(text("ação"));
    p.emit(result(json!({})));
    f.settle().await;
    assert_eq!(f.of("agent:text")[0], json!({"id": "first", "text": "ação"}));

    // Same route, continuing the session: pushed into the live process.
    assert!(f.send("second", Some("native"), "ambient-claude").await);
    assert_eq!(f.procs(), 1);
    assert_eq!(p.line().await["message"]["content"], "hello");
    assert_eq!(f.of("agent:system").last().unwrap(), &json!({"id": "second", "sessionId": "native", "model": "sonnet"}));
    p.emit(text("continuation"));
    p.emit(result(json!({})));
    f.settle().await;
    assert_eq!(f.of("agent:text")[1], json!({"id": "second", "text": "continuation"}));

    // Another account: the old process is closed, a new one starts with its environment.
    let agents = f.agents.clone();
    let emit = Arc::clone(&f.emit);
    let third = tokio::spawn(async move {
        let payload: SendPayload = serde_json::from_value(json!({"id": "third", "permissionScope": "chat", "chat": {"id": "chat"}, "prompt": "hello", "model": "sonnet", "profileId": "claude-work"})).unwrap();
        agents.send(OWNER, emit, payload).await
    });
    assert_eq!(p.next().await, Some(Input::Close));
    p.exit(0);
    assert!(third.await.unwrap());
    assert_eq!(f.procs(), 2);
    assert_eq!(f.proc(1).spec.env.get("PROFILE").unwrap(), "claude-work");
    assert_eq!(f.proc(1).arg("--resume="), None);
}

#[tokio::test]
async fn permissions_and_stop_reject_a_different_owner() {
    let f = Fixture::new();
    f.send("first", None, "ambient-claude").await;
    let p = f.proc(0);
    f.started(&p).await;
    p.emit(init("native"));
    p.emit(can_use_tool("req-1", "Bash"));
    f.settle().await;
    let perm = f.of("agent:permission")[0].clone();
    assert_eq!(perm["permId"], "perm0");
    assert_eq!(perm["toolName"], "Bash");

    f.agents.respond_permission(OTHER, PermissionReply { id: "first".into(), perm_id: "perm0".into(), decision: "allow".into(), updated_input: None });
    assert!(p.quiet().await);
    f.agents.respond_permission(OWNER, PermissionReply { id: "first".into(), perm_id: "perm0".into(), decision: "allow".into(), updated_input: None });
    let answer = p.line().await;
    assert_eq!(answer["response"]["request_id"], "req-1");
    assert_eq!(answer["response"]["response"], json!({"behavior": "allow", "updatedInput": {"command": "echo hi"}, "toolUseID": "tool"}));

    f.agents.abort(OTHER, "first");
    assert!(p.quiet().await);
    f.agents.abort(OWNER, "first");
    assert_eq!(p.line().await["request"], json!({"subtype": "interrupt"}));
    p.emit(result(json!({"subtype": "error_during_execution"})));
    f.settle().await;
    assert_eq!(f.of("agent:done")[0], json!({"id": "first", "aborted": true}));

    // Another client cannot send into a chat it does not own.
    assert!(!f.send_as(OTHER, "intruder", Some("native"), "ambient-claude").await);
    assert_eq!(f.of("agent:error").last().unwrap()["message"], "Este chat já está executando uma tarefa.");
}

#[tokio::test]
async fn a_running_turn_refuses_a_second_send_and_a_disabled_profile_never_starts() {
    let f = Fixture::new();
    f.send("first", None, "ambient-claude").await;
    assert!(!f.send("second", Some("native"), "ambient-claude").await);
    assert_eq!(f.of("agent:error")[0], json!({"id": "second", "message": "Este chat já está executando uma tarefa."}));
    assert!(!f.send("third", None, "disabled").await);
    assert_eq!(f.of("agent:error")[1]["message"], "Esta conta está desativada. Ative-a no gerenciador de contas.");
    assert_eq!(f.procs(), 1);
}

#[tokio::test]
async fn signing_in_again_releases_the_idle_process_and_its_permission_cache() {
    let f = Fixture::new();
    f.send("first", None, "ambient-claude").await;
    let p = f.proc(0);
    f.started(&p).await;
    p.emit(init("native"));
    p.emit(can_use_tool("req-1", "Bash"));
    f.settle().await;
    f.agents.respond_permission(OWNER, PermissionReply { id: "first".into(), perm_id: "perm0".into(), decision: "allow_always".into(), updated_input: None });
    let always = p.line().await;
    assert_eq!(always["response"]["response"]["updatedPermissions"][0]["type"], "addRules");
    // Always allowed for the rest of this chat and account.
    p.emit(can_use_tool("req-2", "Bash"));
    assert_eq!(p.line().await["response"]["response"]["behavior"], "allow");
    p.emit(result(json!({})));
    f.settle().await;

    f.agents.profile_changed("ambient-claude");
    assert_eq!(p.next().await, Some(Input::Close));
    p.exit(0);
    f.settle().await;
    f.send("second", Some("native"), "ambient-claude").await;
    assert_eq!(f.procs(), 2);
    let q = f.proc(1);
    assert_eq!(q.arg("--resume=").as_deref(), Some("native"));
    f.started(&q).await;
    q.emit(init("native"));
    q.emit(can_use_tool("req-3", "Bash"));
    f.settle().await;
    assert_eq!(f.of("agent:permission").len(), 2, "the old allow-always choice is gone");
}

#[tokio::test]
async fn a_withdrawn_prompt_is_answered_like_the_sdk_and_an_unexpected_exit_is_an_error() {
    let f = Fixture::new();
    f.send("first", None, "ambient-claude").await;
    let p = f.proc(0);
    f.started(&p).await;
    p.emit(init("native"));
    p.emit(can_use_tool("req-1", "Write"));
    p.emit(json!({"type": "control_cancel_request", "request_id": "req-1"}));
    assert_eq!(p.line().await["response"]["response"], json!({"behavior": "deny", "message": "Cancelado.", "toolUseID": "tool"}));
    // An unknown request is refused, not left hanging.
    p.emit(json!({"type": "control_request", "request_id": "req-2", "request": {"subtype": "brand_new"}}));
    assert_eq!(p.line().await["response"], json!({"subtype": "error", "request_id": "req-2", "error": "Unsupported control request subtype: brand_new"}));
    p.emit(json!({"type": "control_request", "request_id": "req-dialog", "request": {"subtype": "request_user_dialog", "dialog_kind": "future_dialog", "payload": {}}}));
    assert_eq!(p.line().await["response"], json!({"subtype": "success", "request_id": "req-dialog", "response": {"behavior": "cancelled"}}));
    p.exit(3);
    f.settle().await;
    let error = f.of("agent:error")[0].clone();
    assert_eq!(error["id"], "first");
    // The OS exit and protocol EOF become ready together. Either diagnostic
    // describes the same failed turn; neither may leave it running or aborted.
    let message = error["message"].as_str().unwrap();
    assert!(message == "O Claude Code encerrou inesperadamente (código 3)." || message.contains("O canal de respostas do Claude Code foi fechado antes de concluir a mensagem."), "{message}");
    assert!(f.of("agent:done").is_empty());
    assert_eq!(f.agents.live(), 0);
}

#[tokio::test]
async fn ask_user_questions_wait_for_answers_in_each_turn_and_reject_stale_replies() {
    let f = Fixture::new();
    assert!(f.send("first", None, "ambient-claude").await);
    let p = f.proc(0);
    f.started(&p).await;
    p.emit(init("native"));
    let input = json!({"questions": [{"question": "Qual modo?", "header": "Modo", "options": [{"label": "A", "description": "Primeiro"}, {"label": "B", "description": "Segundo"}], "multiSelect": false}], "metadata": "keep"});
    p.emit(json!({"type": "control_request", "request_id": "question-1", "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": input, "tool_use_id": "ask-1"}}));
    f.settle().await;
    let question = f.of("agent:question")[0].clone();
    assert_eq!(question["id"], "first");
    assert_eq!(question["questions"], input["questions"]);
    assert!(f.of("agent:permission").is_empty(), "questions must always reach the question UI");
    let dialog_id = question["dialogId"].as_str().unwrap().to_string();
    f.agents.respond_question(OTHER, QuestionReply { id: "first".into(), dialog_id: dialog_id.clone(), cancelled: None, answers: Some(json!({"Qual modo?": "A"})) });
    f.agents.respond_question(OWNER, QuestionReply { id: "stale".into(), dialog_id: dialog_id.clone(), cancelled: None, answers: Some(json!({"Qual modo?": "A"})) });
    assert!(p.quiet().await, "unrelated owner/turn cannot answer the pending question");
    f.agents.respond_question(OWNER, QuestionReply { id: "first".into(), dialog_id: dialog_id.clone(), cancelled: None, answers: Some(json!({"Qual modo?": "B"})) });
    let answer = p.line().await;
    assert_eq!(answer["response"]["request_id"], "question-1");
    assert_eq!(answer["response"]["response"]["updatedInput"]["metadata"], "keep");
    assert_eq!(answer["response"]["response"]["updatedInput"]["answers"], json!({"Qual modo?": "B"}));
    f.agents.respond_question(OWNER, QuestionReply { id: "first".into(), dialog_id, cancelled: None, answers: Some(json!({"Qual modo?": "A"})) });
    assert!(p.quiet().await, "a question is answered once");
    p.emit(result(json!({})));
    f.settle().await;
    assert!(f.send("second", Some("native"), "ambient-claude").await);
    p.line().await;
    p.emit(json!({"type": "control_request", "request_id": "question-2", "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": input, "tool_use_id": "ask-2"}}));
    f.settle().await;
    let second = f.of("agent:question")[1].clone();
    assert_eq!(second["id"], "second");
    assert_ne!(second["dialogId"], question["dialogId"]);
    f.agents.respond_question(OWNER, QuestionReply { id: "second".into(), dialog_id: second["dialogId"].as_str().unwrap().into(), cancelled: Some(true), answers: None });
    let cancelled = p.line().await;
    assert_eq!(cancelled["response"]["request_id"], "question-2");
    assert_eq!(cancelled["response"]["response"]["updatedInput"], input);
    p.exit(0);
}

// tests/claude-fast.test.cjs: agent:system and agent:result carry fastMode when the CLI reports it.
#[tokio::test]
async fn fast_mode_state_is_reported_only_when_the_cli_sends_it() {
    let f = Fixture::new();
    f.send("t", None, "ambient-claude").await;
    let p = f.proc(0);
    f.started(&p).await;
    let mut i = init("native");
    i["fast_mode_state"] = json!("cooldown");
    i["fast_mode_disabled_reason"] = json!("rate_limit");
    p.emit(i);
    p.emit(result(json!({"fast_mode_state": "on"})));
    f.settle().await;
    assert_eq!(f.of("agent:system")[0]["fastMode"], json!({"state": "cooldown", "reason": "rate_limit"}));
    assert_eq!(f.of("agent:result")[0]["fastMode"], json!({"state": "on"}));

    let g = Fixture::new();
    g.send("t", None, "ambient-claude").await;
    let q = g.proc(0);
    g.started(&q).await;
    let mut i = init("native");
    i["fast_mode_disabled_reason"] = json!("orphan");
    q.emit(i);
    q.emit(result(json!({"fast_mode_state": 42})));
    g.settle().await;
    assert!(g.of("agent:system")[0].get("fastMode").is_none());
    assert!(g.of("agent:result")[0].get("fastMode").is_none());
}

// tests/usage-turn.test.cjs, Claude part.
#[tokio::test]
async fn a_new_session_turn_is_the_whole_total_and_the_next_one_the_difference() {
    let f = Fixture::new();
    f.send("first", None, "ambient-claude").await;
    let p = f.proc(0);
    f.started(&p).await;
    p.emit(init("native"));
    p.emit(result(json!({"modelUsage": {"claude-opus": mu(100.0, 50.0, 1000.0, 200.0, 10.0, 0.5)}, "total_cost_usd": 0.5})));
    f.settle().await;
    assert_eq!(f.of("agent:result")[0]["turn"], json!({"inputTokens": 100, "cacheReadTokens": 1000, "cacheWriteTokens": 200, "outputTokens": 50, "reasoningTokens": 10, "costUsd": 0.5}));
    assert_eq!(f.of("agent:result")[0]["model"], "claude-sonnet-5");

    f.send("second", Some("native"), "ambient-claude").await;
    assert_eq!(f.procs(), 1);
    p.emit(init("native"));
    p.emit(result(json!({"modelUsage": {"claude-opus": mu(160.0, 90.0, 1500.0, 250.0, 14.0, 0.8)}, "total_cost_usd": 0.8})));
    f.settle().await;
    let t = &f.of("agent:result")[1]["turn"];
    assert_eq!((t["inputTokens"].clone(), t["outputTokens"].clone(), t["cacheReadTokens"].clone(), t["cacheWriteTokens"].clone(), t["reasoningTokens"].clone()), (json!(60), json!(40), json!(500), json!(50), json!(4)));
    assert!((t["costUsd"].as_f64().unwrap() - 0.3).abs() < 1e-9);
}

#[tokio::test]
async fn resuming_an_unknown_session_uses_the_turn_usage_without_cost() {
    let f = Fixture::new();
    f.send("x", Some("old"), "ambient-claude").await;
    let p = f.proc(0);
    assert_eq!(p.arg("--resume=").as_deref(), Some("old"));
    f.started(&p).await;
    p.emit(init("native"));
    p.emit(result(json!({"modelUsage": {"claude-opus": mu(900.0, 900.0, 900.0, 900.0, 9.0, 9.0)}, "total_cost_usd": 9,
        "usage": {"input_tokens": 5, "output_tokens": 6, "cache_read_input_tokens": 7, "cache_creation_input_tokens": 8}})));
    f.settle().await;
    assert_eq!(f.of("agent:result")[0]["turn"], json!({"inputTokens": 5, "cacheReadTokens": 7, "cacheWriteTokens": 8, "outputTokens": 6}));
}

#[tokio::test]
async fn after_a_restart_the_resumed_process_continues_from_the_session_totals() {
    for (models, with_cost) in [(mu(150.0, 80.0, 1100.0, 230.0, 12.0, 0.7), true), (mu(10.0, 10.0, 10.0, 10.0, 1.0, 0.1), false)] {
        let f = Fixture::new();
        f.send("first", None, "ambient-claude").await;
        let p = f.proc(0);
        f.started(&p).await;
        p.emit(init("native"));
        p.emit(result(json!({"modelUsage": {"m": mu(100.0, 50.0, 1000.0, 200.0, 10.0, 0.5)}, "total_cost_usd": 0.5})));
        f.settle().await;
        f.agents.profile_changed("ambient-claude");
        assert_eq!(p.next().await, Some(Input::Close));
        p.exit(0);
        f.settle().await;
        f.send("second", Some("native"), "ambient-claude").await;
        let q = f.proc(1);
        f.started(&q).await;
        q.emit(init("native"));
        let cost = models["costUSD"].clone();
        q.emit(result(json!({"modelUsage": {"m": models}, "total_cost_usd": cost, "usage": {"input_tokens": 1, "output_tokens": 2}})));
        f.settle().await;
        let t = f.of("agent:result")[1]["turn"].clone();
        if with_cost {
            assert_eq!((t["inputTokens"].clone(), t["outputTokens"].clone(), t["cacheReadTokens"].clone(), t["cacheWriteTokens"].clone()), (json!(50), json!(30), json!(100), json!(30)));
            assert!((t["costUsd"].as_f64().unwrap() - 0.2).abs() < 1e-9);
        } else {
            assert_eq!(t, json!({"inputTokens": 1, "outputTokens": 2}));
        }
    }
}

#[tokio::test]
async fn the_owners_window_closing_ends_its_sessions() {
    let f = Fixture::new();
    f.send("first", None, "ambient-claude").await;
    let p = f.proc(0);
    f.started(&p).await;
    p.emit(init("native"));
    f.settle().await;
    f.agents.client_gone(OTHER);
    assert!(p.quiet().await);
    f.agents.client_gone(OWNER);
    assert_eq!(p.next().await, Some(Input::Close));
    p.exit(0);
    f.settle().await;
    assert_eq!(f.of("agent:done")[0], json!({"id": "first", "aborted": true}));
}


#[tokio::test]
async fn steer_injects_priority_now_and_refuses_another_owner_or_turn() {
    let f = Fixture::new();
    assert!(f.send("first", None, "ambient-claude").await);
    let p = f.proc(0);
    f.started(&p).await;
    assert!(f.agents.steer(OTHER, "first", "wrong owner", &[]).is_err());
    assert!(f.agents.steer(OWNER, "wrong", "wrong turn", &[]).is_err());
    f.agents.steer(OWNER, "first", "follow-up", &[]).unwrap();
    let message = p.line().await;
    assert_eq!(message["priority"], "now");
    assert_eq!(message["message"]["content"], "follow-up");
    assert_eq!(f.procs(), 1);
    p.emit(result(json!({})));
    f.settle().await;
    assert_eq!(f.of("agent:done")[0]["aborted"], false);
}

#[tokio::test]
async fn stop_is_recorded_even_when_cli_reports_success_and_the_next_turn_can_run() {
    let f = Fixture::new();
    assert!(f.send("first", None, "ambient-claude").await);
    let p = f.proc(0);
    f.started(&p).await;
    p.emit(init("native")); f.settle().await;
    f.agents.abort(OWNER, "first");
    assert_eq!(p.line().await["request"]["subtype"], "interrupt");
    p.emit(result(json!({}))); f.settle().await;
    assert_eq!(f.of("agent:done")[0]["aborted"], true);
    assert!(f.send("second", Some("native"), "ambient-claude").await);
    assert_eq!(p.line().await["message"]["content"], "hello");
    p.emit(result(json!({}))); f.settle().await;
    assert_eq!(f.of("agent:done")[1]["aborted"], false);
}

#[tokio::test]
async fn a_cli_that_ignores_interrupt_is_killed_and_finishes_aborted() {
    let f = Fixture::new();
    assert!(f.send("first", None, "ambient-claude").await);
    let p = f.proc(0);
    f.started(&p).await;
    f.agents.abort(OWNER, "first");
    assert_eq!(p.line().await["request"]["subtype"], "interrupt");
    tokio::time::sleep(Duration::from_millis(2300)).await;
    assert_eq!(f.of("agent:done")[0], json!({"id": "first", "aborted": true}));
    assert!(f.agents.steer(OWNER, "first", "late", &[]).is_err());
}


#[tokio::test]
async fn process_exit_releases_chat_even_if_a_descendant_keeps_stdout_open() {
    let f = Fixture::new();
    assert!(f.send("first", None, "ambient-claude").await);
    let p = f.proc(0);
    f.started(&p).await;
    p.emit(init("native"));
    p.emit(text("buffered output"));
    // The process has exited, but an inherited pipe remains open.
    p.exit.lock().unwrap().take().unwrap().send(Exit { code: Some(1) }).unwrap();
    tokio::time::timeout(Duration::from_secs(4), async {
        while f.agents.live() != 0 { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.expect("process exit must release the session without waiting forever for pipe EOF");
    assert_eq!(f.of("agent:text")[0]["text"], "buffered output");
    assert_eq!(f.of("agent:error").last().unwrap()["id"], "first");
    assert!(f.send("second", Some("native"), "ambient-claude").await);
    assert_eq!(f.procs(), 2);
    f.started(&f.proc(1)).await;
    f.proc(1).exit(0);
}

#[tokio::test]
async fn next_message_never_reuses_an_idle_session_that_is_shutting_down() {
    let f = Fixture::new();
    assert!(f.send("first", None, "ambient-claude").await);
    let p = f.proc(0);
    f.started(&p).await;
    p.emit(init("native"));
    p.emit(result(json!({})));
    f.settle().await;
    f.agents.end("unified:chat");
    assert_eq!(p.next().await, Some(Input::Close));
    let agents = f.agents.clone();
    let emit = f.emit.clone();
    let next = tokio::spawn(async move {
        let payload = serde_json::from_value(json!({"id":"second", "chat":{"id":"chat"}, "prompt":"hello",
            "cwd":"C:\\QA", "model":"sonnet", "effort":"high", "profileId":"ambient-claude", "resume":"native"})).unwrap();
        agents.send(OWNER, emit, payload).await
    });
    f.settle().await;
    assert!(!next.is_finished(), "the next prompt must wait for replacement instead of going to a closing process");
    p.exit(0);
    assert!(tokio::time::timeout(Duration::from_secs(4), next).await.unwrap().unwrap());
    assert_eq!(f.procs(), 2);
    f.started(&f.proc(1)).await;
    assert_eq!(f.proc(1).arg("--resume=").as_deref(), Some("native"), "replacement resumes the existing conversation");
    f.proc(1).exit(0);
}

#[tokio::test]
async fn closed_stdout_replaces_the_idle_session_even_when_process_exit_never_arrives() {
    let f = Fixture::new();
    assert!(f.send("first", None, "ambient-claude").await);
    let p = f.proc(0);
    f.started(&p).await;
    p.emit(init("native"));
    p.emit(result(json!({})));
    f.settle().await;
    // Model a live OS process whose protocol writer disappeared. Neither a
    // usable stdin nor a missing exit notification makes this stream reusable.
    p.ignore_kill.store(true, Ordering::Relaxed);
    p.output.lock().unwrap().take();
    f.settle().await;
    assert!(tokio::time::timeout(Duration::from_secs(4), f.send("second", Some("native"), "ambient-claude")).await
        .expect("EOF must not wait forever for process exit"));
    assert_eq!(f.procs(), 2);
    let second = f.proc(1);
    assert_eq!(second.arg("--resume=").as_deref(), Some("native"));
    f.started(&second).await;
    second.emit(init("native"));
    let input = json!({"questions": [{"question": "Continuar?", "header": "", "options": [], "multiSelect": false}]});
    second.emit(json!({"type": "control_request", "request_id": "second-question", "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": input}}));
    f.settle().await;
    let question = f.of("agent:question")[0].clone();
    assert_eq!(question["id"], "second");
    f.agents.respond_question(OWNER, QuestionReply { id: "second".into(), dialog_id: question["dialogId"].as_str().unwrap().into(), cancelled: None, answers: Some(json!({"Continuar?": "Sim"})) });
    assert_eq!(second.line().await["response"]["request_id"], "second-question");
    second.emit(result(json!({})));
    f.settle().await;
    assert_eq!(f.of("agent:done").len(), 2);
    assert!(f.of("agent:error").is_empty());
    second.exit(0);
    p.exit(0);
}

#[tokio::test]
async fn second_turn_protocol_eof_reports_failure_and_allows_a_retry_without_restarting_host() {
    let f = Fixture::new();
    assert!(f.send("first", None, "ambient-claude").await);
    let p = f.proc(0);
    f.started(&p).await;
    p.emit(init("native"));
    p.emit(result(json!({})));
    f.settle().await;
    assert!(f.send("second", Some("native"), "ambient-claude").await);
    assert_eq!(p.line().await["message"]["content"], "hello");
    p.ignore_kill.store(true, Ordering::Relaxed);
    p.output.lock().unwrap().take();
    tokio::time::timeout(Duration::from_secs(4), async {
        while f.of("agent:error").is_empty() { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.expect("an accepted message with a dead reply stream must finish with an error");
    assert_eq!(f.of("agent:error")[0]["id"], "second");
    assert!(f.of("agent:error")[0]["message"].as_str().unwrap().contains("canal de respostas"));
    assert!(!f.of("agent:done").iter().any(|done| done["id"] == "second"), "transport failure is not a user's cancellation");
    assert_eq!(f.agents.live(), 0);
    assert!(f.send("retry", Some("native"), "ambient-claude").await);
    assert_eq!(f.procs(), 2);
    let retry = f.proc(1);
    assert_eq!(retry.arg("--resume=").as_deref(), Some("native"));
    f.started(&retry).await;
    retry.emit(init("native"));
    retry.emit(text("recovered"));
    retry.emit(result(json!({})));
    f.settle().await;
    assert_eq!(f.of("agent:text").last().unwrap(), &json!({"id": "retry", "text": "recovered"}));
    retry.exit(0);
    p.exit(0);
}

#[tokio::test]
async fn a_replacement_has_a_deadline_when_the_old_process_never_confirms_shutdown() {
    let f = Fixture::new();
    assert!(f.send("first", None, "ambient-claude").await);
    let p = f.proc(0);
    f.started(&p).await;
    p.emit(init("native"));
    p.emit(result(json!({})));
    f.settle().await;
    p.ignore_kill.store(true, Ordering::Relaxed);
    assert!(tokio::time::timeout(Duration::from_secs(8), f.send("second", Some("native"), "claude-work")).await
        .expect("changing a route must not leave the new message starting forever"));
    assert_eq!(f.procs(), 1, "do not duplicate a prompt into another process before the old one closes");
    assert_eq!(f.of("agent:error")[0]["id"], "second");
    assert!(f.of("agent:error")[0]["message"].as_str().unwrap().contains("sessão anterior"));
    p.exit(0);
    f.settle().await;
    assert!(f.send("retry", Some("native"), "claude-work").await);
    assert_eq!(f.procs(), 2);
    f.started(&f.proc(1)).await;
    f.proc(1).exit(0);
}

#[tokio::test]
async fn api_retry_metadata_does_not_finish_the_active_turn_or_corrupt_its_result() {
    let f = Fixture::new();
    assert!(f.send("first", None, "ambient-claude").await);
    let p = f.proc(0);
    f.started(&p).await;
    p.emit(init("native"));
    p.emit(json!({"type": "system", "subtype": "api_retry", "attempt": 1, "max_retries": 2, "retry_delay_ms": 1000, "error_status": null, "error": "api_error", "no_response": {"waited_ms": 60000, "retry_wait_ms": 30000}}));
    f.settle().await;
    assert!(f.of("agent:done").is_empty());
    assert!(f.of("agent:error").is_empty());
    p.emit(text("connected"));
    p.emit(result(json!({})));
    f.settle().await;
    assert_eq!(f.of("agent:text")[0]["id"], "first");
    assert_eq!(f.of("agent:done")[0], json!({"id": "first", "aborted": false}));
    p.exit(0);
}

#[tokio::test]
async fn clean_process_exit_without_a_second_turn_result_is_a_failure_not_cancellation() {
    let f = Fixture::new();
    assert!(f.send("first", None, "ambient-claude").await);
    let p = f.proc(0);
    f.started(&p).await;
    p.emit(init("native"));
    p.emit(result(json!({})));
    f.settle().await;
    assert!(f.send("second", Some("native"), "ambient-claude").await);
    p.line().await;
    p.exit(0);
    f.settle().await;
    assert_eq!(f.of("agent:error")[0]["id"], "second");
    assert!(!f.of("agent:done").iter().any(|done| done["id"] == "second"));
    assert_eq!(f.agents.live(), 0);
    assert!(f.send("retry", Some("native"), "ambient-claude").await);
    f.started(&f.proc(1)).await;
    f.proc(1).emit(result(json!({})));
    f.settle().await;
    f.proc(1).exit(0);
}
