//! Replays the recorded Claude Code contracts (host/fixtures/claude/<cli
//! version>/<scenario>/) against `prism_agents::claude`. The fake launcher
//! plays the CLI's side of `cli.jsonl`: it requires the same stdin lines the
//! Agent SDK wrote (host request ids remapped) and answers with the recorded
//! stdout. The test performs the scenario's script (sends, answers, stop,
//! calls) and requires the `agent:*` events claudeAgent.ts emitted
//! (`expected.jsonl`). Re-record with host/tools/record-claude-contracts.cjs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use prism_agents::claude::profiles::BoxFuture;
use prism_agents::claude::{
    Catalog, ClaudeAgents, ClaudeProfiles, CliCommand, Emitter, Exit, Input, LaunchEnv, LaunchSpec, Launcher, PermissionReply, QuestionReply, RewindParams, SendPayload, Spawned,
};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc, oneshot};

const CLIENT: u64 = 7;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/claude")
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path).unwrap_or_default().lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/* ---------------- the fake CLI ---------------- */

struct Replay {
    meta: Value,
    lines: Vec<Value>,
    next: AtomicUsize,
    problems: Arc<Mutex<Vec<String>>>,
}

impl Replay {
    fn problem(problems: &Mutex<Vec<String>>, text: String) {
        problems.lock().unwrap().push(text);
    }
}

/// Recorded vs written stdin line, with host → CLI request ids mapped.
fn same_input(recorded: &Value, written: &Value, ids: &mut HashMap<String, String>) -> bool {
    let mut recorded = recorded.clone();
    if recorded.get("type").and_then(Value::as_str) == Some("control_request")
        && let (Some(r), Some(w)) = (recorded.get("request_id").and_then(Value::as_str), written.get("request_id").and_then(Value::as_str))
    {
        ids.insert(r.to_string(), w.to_string());
        recorded["request_id"] = Value::String(w.to_string());
    }
    &recorded == written
}

impl Launcher for Replay {
    fn launch(&self, spec: &LaunchSpec) -> std::io::Result<Spawned> {
        let p = self.next.fetch_add(1, Ordering::SeqCst);
        let problems = Arc::clone(&self.problems);
        let Some(recorded) = self.meta["processes"].get(p) else {
            Self::problem(&problems, format!("processo extra #{p}: {:?}", spec.args));
            return Err(std::io::Error::other("processo não gravado"));
        };
        let mut args: Vec<String> = recorded["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
        // These original recordings predate nested transcript forwarding. The
        // extra display-only flag is validated separately by launch/session QA;
        // it changes which child frames are emitted, not the input contract.
        if spec.args.iter().any(|arg| arg == "--forward-subagent-text") && !args.iter().any(|arg| arg == "--forward-subagent-text") {
            let index = args.iter().position(|arg| arg == "--include-partial-messages").map(|index| index + 1).unwrap_or(args.len());
            args.insert(index, "--forward-subagent-text".into());
        }
        if args != spec.args {
            Self::problem(&problems, format!("argumentos do processo #{p}:\n  gravados {args:?}\n  host     {:?}", spec.args));
        }
        for (key, value) in recorded["env"].as_object().unwrap() {
            let got = spec.env.get(key).map(|v| v.to_string_lossy().into_owned());
            let want = match key.as_str() {
                // The host names itself: the CLI's own name for a stream-json client.
                "CLAUDE_CODE_ENTRYPOINT" => Some("sdk-cli".to_string()),
                "CLAUDE_AGENT_SDK_VERSION" => continue,
                _ => value.as_str().map(str::to_string),
            };
            if got != want {
                Self::problem(&problems, format!("ambiente do processo #{p}: {key} = {got:?}, esperado {want:?}"));
            }
        }
        let script: Vec<Value> = self.lines.iter().filter(|l| l["p"].as_u64() == Some(p as u64)).cloned().collect();
        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Input>();
        let (output_tx, output_rx) = mpsc::unbounded_channel::<String>();
        let (exit_tx, exit_rx) = oneshot::channel::<Exit>();
        tokio::spawn(async move {
            let mut ids: HashMap<String, String> = HashMap::new();
            let mut code = Some(0);
            for entry in script {
                match entry["d"].as_str().unwrap() {
                    "out" => {
                        let line = match entry.get("m") {
                            Some(m) => {
                                let mut m = m.clone();
                                if let Some(rid) = m.pointer("/response/request_id").and_then(Value::as_str).and_then(|r| ids.get(r)).cloned() {
                                    m["response"]["request_id"] = Value::String(rid);
                                }
                                m.to_string()
                            }
                            None => entry["raw"].as_str().unwrap().to_string(),
                        };
                        let _ = output_tx.send(line);
                    }
                    "in" => {
                        let want = entry.get("m").cloned().unwrap_or(Value::Null);
                        match tokio::time::timeout(Duration::from_secs(10), input_rx.recv()).await {
                            Ok(Some(Input::Line(line))) => {
                                let got: Value = serde_json::from_str(&line).unwrap_or(Value::String(line));
                                if !same_input(&want, &got, &mut ids) {
                                    Self::problem(&problems, format!("stdin do processo #{p}:\n  gravado {want}\n  host    {got}"));
                                }
                            }
                            other => {
                                Self::problem(&problems, format!("stdin do processo #{p}: esperado {want}, veio {other:?}"));
                                code = None;
                                break;
                            }
                        }
                    }
                    "eof" => match tokio::time::timeout(Duration::from_secs(10), input_rx.recv()).await {
                        Ok(Some(Input::Close)) | Ok(None) => {}
                        other => {
                            Self::problem(&problems, format!("processo #{p}: esperado EOF, veio {other:?}"));
                            code = None;
                            break;
                        }
                    },
                    "exit" => code = entry["code"].as_i64().map(|c| c as i32),
                    other => panic!("entrada desconhecida {other}"),
                }
            }
            drop(output_tx);
            let _ = exit_tx.send(Exit { code });
        });
        Ok(Spawned { input: input_tx, output: output_rx, exit: exit_rx, kill: Box::new(|| {}) })
    }
}

struct FakeProfiles {
    config: PathBuf,
    logged_out: bool,
}

impl ClaudeProfiles for FakeProfiles {
    fn environment(&self, _profile: Option<&str>) -> Result<LaunchEnv, String> {
        let dir: PathBuf = if self.logged_out { "C:\\Temp\\logged-out-config".into() } else { self.config.clone() };
        Ok(LaunchEnv { remove: Vec::new(), set: vec![("CLAUDE_CONFIG_DIR".into(), dir.into_os_string())] })
    }
    fn command<'a>(&'a self, _profile: Option<&'a str>) -> BoxFuture<'a, Option<CliCommand>> {
        Box::pin(async { Some(CliCommand { program: "<CLI>".into(), args: Vec::new() }) })
    }
    fn version<'a>(&'a self, _command: &'a CliCommand) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { Some("2.1.289".to_string()) })
    }
}

/* ---------------- the scenario ---------------- */

#[derive(Default)]
struct Events {
    list: Mutex<Vec<(String, Value)>>,
    changed: Notify,
}

impl Events {
    fn count(&self, channel: &str) -> usize {
        self.list.lock().unwrap().iter().filter(|(c, _)| c == channel).count()
    }
    fn nth(&self, channel: &str, n: usize) -> Option<Value> {
        self.list.lock().unwrap().iter().filter(|(c, _)| c == channel).nth(n).map(|(_, v)| v.clone())
    }
    fn reached(&self, on: &Value) -> bool {
        self.count(on["channel"].as_str().unwrap()) > on["nth"].as_u64().unwrap() as usize
    }
    fn session(&self) -> Option<String> {
        self.list.lock().unwrap().iter().rev().find(|(c, _)| c == "agent:system").and_then(|(_, v)| v["sessionId"].as_str().map(str::to_string))
    }
    async fn wait(&self, what: &str, cond: impl Fn() -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while !cond() {
            if tokio::time::Instant::now() >= deadline {
                let seen: Vec<String> = self.list.lock().unwrap().iter().map(|(c, d)| format!("{c} {}", d.to_string().chars().take(160).collect::<String>())).collect();
                panic!("tempo esgotado esperando {what}; eventos:
{}", seen.join("
"));
            }
            let _ = tokio::time::timeout(Duration::from_millis(50), self.changed.notified()).await;
        }
    }
}

struct Ctx {
    cwd: String,
    checkpoints: Vec<String>,
}

fn resolve(value: &Value, events: &Events, ctx: &Ctx) -> Value {
    match value {
        Value::String(s) if s == "$cwd" => Value::String(ctx.cwd.clone()),
        Value::String(s) if s == "$session" => events.session().map(Value::String).unwrap_or(Value::Null),
        Value::String(s) if s.starts_with("$checkpoint[") => {
            let n: usize = s.trim_start_matches("$checkpoint[").trim_end_matches(']').parse().unwrap();
            ctx.checkpoints.get(n).cloned().map(Value::String).unwrap_or(Value::Null)
        }
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), resolve(v, events, ctx))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(|v| resolve(v, events, ctx)).collect()),
        other => other.clone(),
    }
}

/// Host additions on top of the TS payloads (the contract allows them).
fn strip_additions(channel: &str, mut data: Value) -> Value {
    // These fields were added after the SDK contracts were captured. Their
    // values are checked independently against the recorded native messages.
    if channel == "agent:result" {
        data.as_object_mut().unwrap().shift_remove("contextTokens");
        data.as_object_mut().unwrap().shift_remove("contextWindow");
    }
    if channel == "agent:result" && data.get("code").and_then(Value::as_str) == Some("cli_auth") {
        data.as_object_mut().unwrap().shift_remove("code");
    }
    data
}

/// A fork compared up to its fresh ids: same entries and the same links.
fn same_fork(expected: &Value, actual: &[Value]) -> Result<(), String> {
    let expected = expected["entries"].as_array().ok_or("sem entries")?;
    if expected.len() != actual.len() {
        return Err(format!("{} entradas no fork, esperado {}", actual.len(), expected.len()));
    }
    let index_of = |list: &[Value], uuid: &Value| list.iter().position(|e| &e["uuid"] == uuid);
    for (i, (want, got)) in expected.iter().zip(actual).enumerate() {
        let strip = |v: &Value| {
            let mut v = v.clone();
            for key in ["uuid", "parentUuid", "logicalParentUuid", "sessionId", "timestamp"] {
                v.as_object_mut().unwrap().shift_remove(key);
            }
            v
        };
        if strip(want) != strip(got) {
            return Err(format!("entrada {i}:\n  SDK  {}\n  host {}", strip(want), strip(got)));
        }
        let link = |list: &[Value], e: &Value| e.get("parentUuid").filter(|p| !p.is_null()).map(|p| index_of(list, p));
        if link(expected, want) != link(actual, got) {
            return Err(format!("entrada {i}: parentUuid aponta para outra entrada"));
        }
    }
    Ok(())
}

async fn run_scenario(version: &str, name: &str) -> Vec<String> {
    let dir = fixtures().join(version).join(name);
    let script = read_json(&dir.join("script.json"));
    let meta = read_json(&dir.join("meta.json"));
    let expected = read_jsonl(&dir.join("expected.jsonl"));
    let config = tempfile::tempdir().unwrap();
    let problems = Arc::new(Mutex::new(Vec::new()));
    let launcher = Arc::new(Replay { meta, lines: read_jsonl(&dir.join("cli.jsonl")), next: AtomicUsize::new(0), problems: Arc::clone(&problems) });
    let profiles = Arc::new(FakeProfiles { config: config.path().to_path_buf(), logged_out: script["loggedOut"].as_bool().unwrap_or(false) });
    let agents = ClaudeAgents::new(profiles, launcher);
    let events = Arc::new(Events::default());
    let sink = Arc::clone(&events);
    let emit: Emitter = Arc::new(move |channel: &str, data: Value| {
        sink.list.lock().unwrap().push((channel.to_string(), data));
        sink.changed.notify_waiters();
    });
    let mut ctx = Ctx { cwd: script["cwd"].as_str().unwrap().to_string(), checkpoints: Vec::new() };

    // Answers run beside the sends, as the user would; an action whose event
    // never comes (the oracle never saw it either) simply never runs.
    let actions = script["actions"].as_array().cloned().unwrap_or_default();
    let (answerer_agents, answerer_events) = (agents.clone(), Arc::clone(&events));
    let answerer = tokio::spawn(async move {
        let mut done = vec![false; actions.len()];
        loop {
            for (i, action) in actions.iter().enumerate() {
                if done[i] || !answerer_events.reached(&action["on"]) {
                    continue;
                }
                done[i] = true;
                let ev = answerer_events.nth(action["on"]["channel"].as_str().unwrap(), action["on"]["nth"].as_u64().unwrap() as usize).unwrap();
                let id = ev["id"].as_str().unwrap().to_string();
                match action["do"]["type"].as_str().unwrap() {
                    "permission" => answerer_agents.respond_permission(CLIENT, PermissionReply {
                        id,
                        perm_id: ev["permId"].as_str().unwrap().into(),
                        decision: action["do"]["decision"].as_str().unwrap().into(),
                        updated_input: None,
                    }),
                    "question" => {
                        let mut answers = serde_json::Map::new();
                        for q in ev["questions"].as_array().unwrap() {
                            answers.insert(q["question"].as_str().unwrap().into(), q["options"][0]["label"].clone());
                        }
                        answerer_agents.respond_question(CLIENT, QuestionReply { id, dialog_id: ev["dialogId"].as_str().unwrap().into(), cancelled: None, answers: Some(Value::Object(answers)) })
                    }
                    "abort" => answerer_agents.abort(CLIENT, action["do"]["id"].as_str().unwrap()),
                    other => panic!("ação desconhecida {other}"),
                }
            }
            let _ = tokio::time::timeout(Duration::from_millis(20), answerer_events.changed.notified()).await;
        }
    });

    let mut chats = Vec::new();
    for send in script["sends"].as_array().unwrap() {
        if let Some(after) = send.get("after") {
            events.wait("o próximo envio", || events.reached(after)).await;
        }
        let payload: SendPayload = serde_json::from_value(resolve(&send["payload"], &events, &ctx)).unwrap();
        let chat = payload.chat.as_ref().unwrap()["id"].as_str().unwrap().to_string();
        if !chats.contains(&chat) {
            chats.push(chat);
        }
        agents.send(CLIENT, Arc::clone(&emit), payload).await;
    }
    if let Some(end) = script.get("end").filter(|e| !e.is_null()) {
        events.wait("o fim do turno", || events.reached(end)).await;
    }
    answerer.abort();
    for chat in &chats {
        agents.end(&format!("unified:{chat}"));
    }
    events.wait("o fim dos processos", || agents.live() == 0).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    // The transcript the CLI wrote, where the checkpoint and fork calls read it.
    let mut actual_calls: Vec<(String, Value)> = Vec::new();
    if let Ok(text) = std::fs::read_to_string(dir.join("transcript.jsonl")) {
        let sid = events.session().unwrap();
        let project = config.path().join("projects").join("C--work-scenario");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join(format!("{sid}.jsonl")), text).unwrap();
    }
    for call in script["calls"].as_array().cloned().unwrap_or_default() {
        let args = resolve(call.get("args").unwrap_or(&Value::Null), &events, &ctx);
        let result = match call["method"].as_str().unwrap() {
            "checkpointIds" => {
                let ids = agents.checkpoint_ids(args["sessionId"].as_str().unwrap(), None).await;
                ctx.checkpoints = ids.clone();
                json!(ids)
            }
            "rewind" => agents.rewind(serde_json::from_value::<RewindParams>(args).unwrap()).await,
            "fork" => agents.fork(args["sessionId"].as_str().unwrap(), args["upToMessageId"].as_str().unwrap(), None).await,
            "models" => agents.catalog(Catalog::Models, None, None).await.unwrap_or_else(|e| json!({"error": e})),
            "commands" => agents.catalog(Catalog::Commands, None, args["cwd"].as_str().map(str::to_string)).await.unwrap_or_else(|e| json!({"error": e})),
            "usage" => agents.catalog(Catalog::Usage, None, None).await.unwrap_or_else(|e| json!({"error": e})),
            other => panic!("chamada desconhecida {other}"),
        };
        actual_calls.push((call["method"].as_str().unwrap().to_string(), result));
    }

    let mut problems = problems.lock().unwrap().clone();
    let mut last_usage = HashMap::new();
    let mut native_contexts = Vec::new();
    for line in read_jsonl(&dir.join("cli.jsonl")) {
        if line["d"] != "out" { continue; }
        let process = line["p"].as_u64().unwrap_or_default();
        let message = &line["m"];
        if let Some(usage) = message.pointer("/message/usage").or_else(|| message.pointer("/event/message/usage")) {
            last_usage.insert(process, usage.clone());
        }
        if message["type"] == "result" {
            let tokens = last_usage.get(&process).map(|usage| ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"].iter().filter_map(|key| usage.get(key).and_then(Value::as_u64)).sum::<u64>());
            native_contexts.push((tokens, message["modelUsage"].clone()));
        }
    }
    for ((tokens, models), (_, data)) in native_contexts.iter().zip(events.list.lock().unwrap().iter().filter(|(c, _)| c == "agent:result")) {
        if data.get("contextTokens").and_then(Value::as_u64) != *tokens {
            problems.push(format!("contextTokens: esperado {tokens:?}, recebido {}", data["contextTokens"]));
        }
        let window = data["model"].as_str().and_then(|model| models.get(model)).and_then(|model| model.get("contextWindow"));
        if data.get("contextWindow") != window {
            problems.push(format!("contextWindow: esperado {window:?}, recebido {}", data["contextWindow"]));
        }
    }
    let actual: Vec<(String, Value)> = events.list.lock().unwrap().iter().map(|(c, d)| (c.clone(), strip_additions(c, d.clone()))).collect();
    let want: Vec<(String, Value)> = expected.iter().filter(|e| e.get("channel").is_some()).map(|e| (e["channel"].as_str().unwrap().to_string(), e["data"].clone())).collect();
    for i in 0..want.len().max(actual.len()) {
        if want.get(i) != actual.get(i) {
            problems.push(format!("evento {i}:\n  TS   {:?}\n  host {:?}", want.get(i), actual.get(i)));
            break;
        }
    }
    let want_calls: Vec<&Value> = expected.iter().filter(|e| e.get("call").is_some()).collect();
    for (i, want) in want_calls.iter().enumerate() {
        let Some((method, got)) = actual_calls.get(i) else {
            problems.push(format!("chamada {i} não feita"));
            continue;
        };
        if method == "fork" {
            let file = got["file"].as_str().map(PathBuf::from);
            let entries: Vec<Value> = file.map(|f| read_jsonl(&f)).unwrap_or_default();
            if got["ok"] != want["result"]["ok"] {
                problems.push(format!("fork: {got}"));
            } else if let Err(e) = same_fork(&want["result"], &entries) {
                problems.push(format!("fork: {e}"));
            }
        } else if &want["result"] != got {
            problems.push(format!("chamada {method}:\n  TS   {}\n  host {got}", want["result"]));
        }
    }
    problems
}

fn scenarios(version: &str) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(fixtures().join(version))
        .unwrap()
        .flatten()
        .filter(|e| e.path().join("cli.jsonl").is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_recorded_contract_replays() {
    let mut failures = Vec::new();
    let mut count = 0;
    for version in prism_agents::claude::version::VERIFIED {
        for name in scenarios(version) {
            count += 1;
            eprintln!("contrato {version}/{name}");
            let problems = run_scenario(version, &name).await;
            if !problems.is_empty() {
                failures.push(format!("[{version}/{name}]\n{}", problems.join("\n")));
            }
        }
    }
    assert!(count >= 10, "só {count} contratos gravados");
    assert!(failures.is_empty(), "contratos com diferença:\n\n{}", failures.join("\n\n"));
}

/// The routes Haiku never exercises: the SDK's flags for them, recorded dry.
#[test]
fn every_recorded_route_maps_to_the_sdk_flags() {
    use prism_agents::claude::launch::{SessionOptions, session_args};
    for version in prism_agents::claude::version::VERIFIED {
        let dir = fixtures().join(version).join("args");
        let script = read_json(&dir.join("script.json"));
        let meta = read_json(&dir.join("meta.json"));
        for (send, process) in script["sends"].as_array().unwrap().iter().zip(meta["processes"].as_array().unwrap()) {
            let p: SendPayload = serde_json::from_value(send["payload"].clone()).unwrap();
            let args = session_args(&SessionOptions::from_chat(&p.model, p.effort.as_deref(), p.thinking, p.permission_mode.as_deref(), p.resume.as_deref(), p.service_tier.as_deref()));
            let mut recorded: Vec<String> = process["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
            let index = recorded.iter().position(|arg| arg == "--include-partial-messages").map(|index| index + 1).unwrap_or(recorded.len());
            recorded.insert(index, "--forward-subagent-text".into());
            assert_eq!(args, recorded, "{}", send["payload"]);
        }
    }
}
