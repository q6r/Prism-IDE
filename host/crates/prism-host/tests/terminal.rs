//! `terminal.*` against real PTYs over a real socket: ordered input, the
//! queue while the shell starts, replay on attach, the owner guards on kill
//! and exit, process trees and the "busy terminal holds the host" rule.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use prism_host::domains::terminal::{Options, Shell, TerminalDomain};
use prism_host::{serve, HostState};
use prism_protocol::PROTOCOL_MAJOR;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WAIT: Duration = Duration::from_secs(20);

fn options(default_cwd: std::path::PathBuf) -> Options {
    // A light shell keeps the tests fast; the product runs PowerShell / $SHELL.
    #[cfg(windows)]
    let shell = Shell { program: "cmd.exe".into(), args: vec![] };
    #[cfg(unix)]
    let shell = Shell { program: "/bin/sh".into(), args: vec![] };
    Options { shell, scrollback: 1 << 20, busy_poll: Duration::from_millis(100), default_cwd }
}

async fn start() -> (u16, Arc<HostState>) {
    let domain = Arc::new(TerminalDomain::with_options(options(std::env::temp_dir())));
    let state = HostState::with_domains(TOKEN.into(), "h".into(), "Máquina".into(), "qa".into(), vec![domain]);
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(serve(listener, Arc::clone(&state)));
    (port, state)
}

/// Drops escape sequences so assertions see the text a person would.
fn plain(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' || (c == '\x1b' && chars.next_if_eq(&'\\').is_some()) {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

struct Client {
    socket: Socket,
    next_id: u64,
    responses: HashMap<u64, Value>,
    notes: Vec<Value>,
}

impl Client {
    async fn connect(port: u16) -> Self {
        let socket = connect_async(format!("ws://127.0.0.1:{port}/rpc")).await.unwrap().0;
        let mut client = Self { socket, next_id: 1, responses: HashMap::new(), notes: Vec::new() };
        let hello = client
            .call("host.hello", json!({ "protocol": { "major": PROTOCOL_MAJOR, "minor": 0 }, "client": { "kind": "web", "version": "t" }, "token": TOKEN }))
            .await;
        assert!(hello["result"]["capabilities"].as_array().unwrap().contains(&json!("terminal@1")));
        client
    }

    async fn send(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.socket.send(Message::Text(message.to_string().into())).await.unwrap();
        id
    }

    /// Reads one frame into `responses` or `notes`; false on timeout.
    async fn pump(&mut self, timeout: Duration) -> bool {
        let frame = match tokio::time::timeout(timeout, self.socket.next()).await {
            Ok(frame) => frame,
            Err(_) => return false,
        };
        match frame {
            Some(Ok(Message::Text(text))) => {
                let value: Value = serde_json::from_str(&text).unwrap();
                match value["id"].as_u64() {
                    Some(id) => {
                        self.responses.insert(id, value);
                    }
                    None => self.notes.push(value),
                }
                true
            }
            Some(Ok(_)) => true,
            other => panic!("socket ended: {other:?}"),
        }
    }

    async fn response(&mut self, id: u64) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(value) = self.responses.remove(&id) {
                return value;
            }
            assert!(Instant::now() < deadline, "no response to #{id}");
            self.pump(Duration::from_millis(200)).await;
        }
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params).await;
        self.response(id).await
    }

    async fn result(&mut self, method: &str, params: Value) -> Value {
        let reply = self.call(method, params).await;
        assert!(reply.get("error").is_none(), "{method} failed: {reply}");
        reply["result"].clone()
    }

    async fn input(&mut self, id: &str, data: &str) {
        self.result("terminal.input", json!({ "id": id, "data": data })).await;
    }

    /// All `terminal.data` received for `term`, in order, with the last seq.
    fn output(&self, term: &str) -> (String, u64) {
        let mut text = String::new();
        let mut seq = 0;
        for note in self.notes.iter().filter(|n| n["method"] == "terminal.data" && n["params"]["id"] == term) {
            text.push_str(note["params"]["data"].as_str().unwrap());
            seq = note["params"]["seq"].as_u64().unwrap();
        }
        (text, seq)
    }

    async fn output_until(&mut self, term: &str, done: impl Fn(&str) -> bool) -> (String, u64) {
        let deadline = Instant::now() + WAIT;
        loop {
            let (text, seq) = self.output(term);
            if done(&plain(&text)) {
                return (text, seq);
            }
            assert!(Instant::now() < deadline, "output of {term} never matched; got {text:?}");
            self.pump(Duration::from_millis(200)).await;
        }
    }

    fn exits(&self, term: &str) -> usize {
        self.notes.iter().filter(|n| n["method"] == "terminal.exit" && n["params"]["id"] == term).count()
    }

    async fn create(&mut self, id: &str) -> Value {
        self.result("terminal.create", json!({ "id": id, "cols": 100, "rows": 30 })).await
    }
}

fn count(haystack: &str, needle: &str) -> usize {
    haystack.matches(needle).count()
}

async fn wait_until(mut condition: impl FnMut() -> bool, what: &str) {
    let deadline = Instant::now() + WAIT;
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(windows)]
const LONG_RUNNING: &str = "ping -n 60 127.0.0.1 > nul\r";
#[cfg(unix)]
const LONG_RUNNING: &str = "sleep 60\r";

#[tokio::test]
async fn keystrokes_arrive_in_order_and_echo_back() {
    let (port, _state) = start().await;
    let mut client = Client::connect(port).await;
    let created = client.create("a:0").await;
    assert_eq!(created["created"], true);
    // One call per character, sent back to back: any reordering would
    // scramble the marker.
    let mut ids = vec![];
    for c in "echo ordered-0123456789\r".chars() {
        ids.push(client.send("terminal.input", json!({ "id": "a:0", "data": c.to_string() })).await);
    }
    for id in ids {
        client.response(id).await;
    }
    client.output_until("a:0", |text| count(text, "ordered-0123456789") >= 2).await;
}

#[tokio::test]
async fn input_sent_while_the_shell_starts_is_queued() {
    let (port, _state) = start().await;
    let mut client = Client::connect(port).await;
    let create = client.send("terminal.create", json!({ "id": "q:0" })).await;
    client.send("terminal.input", json!({ "id": "q:0", "data": "echo queued-mark\r" })).await;
    assert_eq!(client.response(create).await["result"]["created"], true);
    client.output_until("q:0", |text| count(text, "queued-mark") >= 2).await;
}

#[tokio::test]
async fn a_new_client_replays_what_it_missed_and_continues_live() {
    let (port, _state) = start().await;
    let mut first = Client::connect(port).await;
    first.create("r:0").await;
    first.input("r:0", "echo first-mark\r").await;
    let (_, seen) = first.output_until("r:0", |text| count(text, "first-mark") >= 2).await;
    drop(first); // the window closes; the terminal stays

    let mut second = Client::connect(port).await;
    let list = second.result("terminal.list", json!(null)).await;
    let info = list.as_array().unwrap().iter().find(|t| t["id"] == "r:0").expect("terminal survives its client").clone();
    assert_eq!(info["attached"], 0, "nobody shows it now");
    assert!(info["pid"].as_u64().is_some());
    second.input("r:0", "echo second-mark\r").await;

    // Catch up from where the first client stopped, then follow live.
    let attached = second.result("terminal.attach", json!({ "id": "r:0", "since": seen })).await;
    assert_eq!(attached["truncated"], false);
    let mut replayed = attached["data"].as_str().unwrap().to_string();
    let mut seq = attached["seq"].as_u64().unwrap();
    let deadline = Instant::now() + WAIT;
    while count(&plain(&replayed), "second-mark") < 2 {
        assert!(Instant::now() < deadline, "never saw second-mark: {:?}", plain(&replayed));
        second.pump(Duration::from_millis(200)).await;
        for note in second.notes.drain(..) {
            if note["method"] == "terminal.data" && note["params"]["id"] == "r:0" {
                let to = note["params"]["seq"].as_u64().unwrap();
                let data = note["params"]["data"].as_str().unwrap();
                assert_eq!(to, seq + data.len() as u64, "live output continues exactly where the replay ended");
                replayed.push_str(data);
                seq = to;
            }
        }
    }
    assert!(!plain(&replayed).contains("first-mark"), "nothing before `since` is sent again");

    let everything = second.result("terminal.attach", json!({ "id": "r:0" })).await;
    let all = plain(everything["data"].as_str().unwrap());
    assert!(all.contains("first-mark") && all.contains("second-mark"));
    let list = second.result("terminal.list", json!(null)).await;
    assert_eq!(list[0]["attached"], 1);

    let missing = second.call("terminal.attach", json!({ "id": "nope" })).await;
    assert_eq!(missing["error"]["data"]["code"], "not_found");
}

#[tokio::test]
async fn a_kill_is_silent_and_frees_the_id_for_a_new_attempt() {
    let (port, _state) = start().await;
    let mut client = Client::connect(port).await;
    client.create("k:0").await;
    client.output_until("k:0", |text| !text.trim().is_empty()).await;
    client.result("terminal.kill", json!({ "id": "k:0" })).await;
    let notes_before = client.notes.len();

    // Same id again: a brand-new shell, untouched by the old one's end.
    assert_eq!(client.create("k:0").await["created"], true);
    client.input("k:0", "echo after-kill\r").await;
    client.output_until("k:0", |text| count(text, "after-kill") >= 2).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    while client.pump(Duration::from_millis(50)).await {}
    assert_eq!(client.exits("k:0"), 0, "the killed shell never reports an exit");
    assert!(client.notes.len() > notes_before);

    // A dead id takes input, resize and kill quietly.
    for (method, params) in [
        ("terminal.input", json!({ "id": "ghost", "data": "x" })),
        ("terminal.resize", json!({ "id": "ghost", "cols": 10, "rows": 10 })),
        ("terminal.kill", json!({ "id": "ghost" })),
    ] {
        assert_eq!(client.result(method, params).await["ok"], false);
    }
}

#[tokio::test]
async fn a_shell_that_exits_is_reported_once_and_forgotten() {
    let (port, _state) = start().await;
    let mut client = Client::connect(port).await;
    client.create("x:0").await;
    client.input("x:0", "exit\r").await;
    let deadline = Instant::now() + WAIT;
    while client.exits("x:0") == 0 {
        assert!(Instant::now() < deadline, "no terminal.exit");
        client.pump(Duration::from_millis(200)).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    while client.pump(Duration::from_millis(50)).await {}
    assert_eq!(client.exits("x:0"), 1);
    assert_eq!(client.result("terminal.list", json!(null)).await, json!([]));
}

#[tokio::test]
async fn a_running_program_holds_the_host_and_dies_with_its_terminal() {
    let (port, state) = start().await;
    let mut client = Client::connect(port).await;
    client.create("b:0").await;
    client.output_until("b:0", |text| !text.trim().is_empty()).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(state.activity.holds(), 0, "an idle shell does not hold the host");

    client.input("b:0", LONG_RUNNING).await;
    wait_until(|| state.activity.holds() == 1, "the busy terminal to hold the host").await;
    let list = client.result("terminal.list", json!(null)).await;
    assert_eq!(list[0]["busy"], true);
    let shell = list[0]["pid"].as_u64().unwrap() as u32;
    let program = prism_proc::child_pids(shell)[0];

    // Closing the window does not release it…
    drop(client);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(state.activity.holds(), 1);
    assert_eq!(state.activity.clients(), 0);

    // …killing the terminal does, and takes the program along.
    let mut client = Client::connect(port).await;
    client.result("terminal.kill", json!({ "id": "b:0" })).await;
    wait_until(|| state.activity.holds() == 0, "the hold to go").await;
    wait_until(|| !prism_proc::alive(program), "the program to die with its terminal").await;
    wait_until(|| !prism_proc::alive(shell), "the shell to die").await;
}

#[tokio::test]
async fn the_product_shell_runs_commands() {
    // PowerShell on Windows (with PSReadLine and ConPTY's win32 input mode
    // on), $SHELL elsewhere: plain VT keystrokes must work.
    let options = Options { default_cwd: std::env::temp_dir(), ..Options::default() };
    let state = HostState::with_domains(TOKEN.into(), "h".into(), "Máquina".into(), "qa".into(), vec![Arc::new(TerminalDomain::with_options(options))]);
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(serve(listener, state));
    let mut client = Client::connect(port).await;
    client.create("s:0").await;
    client.input("s:0", "echo product-shell\r").await;
    client.output_until("s:0", |text| count(text, "product-shell") >= 2).await;
    client.result("terminal.kill", json!({ "id": "s:0" })).await;
}

#[tokio::test]
async fn init_and_set_cwd_steer_where_new_terminals_start() {
    let (port, _state) = start().await;
    let mut client = Client::connect(port).await;
    let initial = client.result("terminal.init", json!({})).await;
    assert_eq!(initial, json!(std::env::temp_dir().display().to_string()));

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().display().to_string();
    assert_eq!(client.result("terminal.setCwd", json!({ "cwd": path })).await, json!(path));
    let missing = dir.path().join("missing").display().to_string();
    assert_eq!(client.result("terminal.setCwd", json!({ "cwd": missing })).await, json!(path), "a missing folder is ignored");

    client.create("c:0").await;
    let list = client.result("terminal.list", json!(null)).await;
    assert_eq!(list[0]["cwd"], json!(path));
    client.result("terminal.kill", json!({ "id": "c:0" })).await;
}
