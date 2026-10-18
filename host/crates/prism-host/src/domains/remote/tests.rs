//! `remote.*` driven through `Domain::call`, as an owner and a member, with
//! phones on real WebSockets to the domain's own loopback server. Everything
//! lives in a temporary folder: the chats engine runs a fake provider, Codex a
//! launcher that never starts a process, and the tunnel is a fake that opens
//! nothing (it lets the test end it, or refuse to open).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use prism_agents::codex::{AppServer, BoxFuture as CodexFuture, CodexError, CodexErrorKind, CodexQueries, CodexSessions, Launcher};
use prism_agents::profile_env::{ProfileSource, Profiles};
use prism_protocol::{ErrorCode, HostError, Role, UserInfo};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{self, Message};

use super::tunnel::{BoxFuture as TunnelFuture, OpenTunnel, Tunnels};
use super::*;
use crate::domain::next_client_id;
use crate::domains::chats::{BoxFuture, Hold, Runner, Runners, TurnEvent, TurnSink, TurnStart};
use crate::domains::store::SharedStore;
use crate::HostState;

const WAIT: Duration = Duration::from_secs(20);

// ---- fakes ----

/// A Codex that cannot start anything.
struct NoCodex;

impl Launcher for NoCodex {
    fn check(&self, _profile_id: String) -> CodexFuture<'_, Result<(), CodexError>> {
        Box::pin(async { Ok(()) })
    }

    fn account(&self, profile_id: String) -> CodexFuture<'_, Result<String, CodexError>> {
        Box::pin(async move { Ok(profile_id) })
    }

    fn launch(&self, _profile_id: String, _cwd: Option<String>) -> CodexFuture<'_, Result<Arc<AppServer>, CodexError>> {
        Box::pin(async { Err(CodexError::new(CodexErrorKind::Failed, "sem Codex nos testes")) })
    }
}

type Answered = (String, String, Option<Map<String, Value>>);

/// What the fake provider was asked.
#[derive(Default)]
struct Fake {
    starts: Mutex<Vec<(TurnStart, TurnSink)>>,
    aborts: Mutex<Vec<(String, String)>>,
    permissions: Mutex<Vec<(String, String, String)>>,
    questions: Mutex<Vec<Answered>>,
}

struct FakeRunner(Arc<Fake>);

impl Runner for FakeRunner {
    fn start(&self, turn: TurnStart, sink: TurnSink) -> BoxFuture<Result<(), String>> {
        self.0.starts.lock().unwrap().push((turn, sink));
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

/// Counts when a tunnel's guard is dropped (the tunnel closed).
struct Closed(Arc<AtomicUsize>);

impl Drop for Closed {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct FakeTunnels {
    opens: AtomicUsize,
    closed: Arc<AtomicUsize>,
    /// The next opens fail with this message.
    fail: Mutex<Option<String>>,
    /// To end the tunnel on its own: the sender of the last open's `ended`.
    enders: Mutex<Vec<oneshot::Sender<String>>>,
    ports: Mutex<Vec<u16>>,
}

impl FakeTunnels {
    fn end(&self, reason: &str) {
        let ender = self.enders.lock().unwrap().pop().expect("a tunnel is open");
        ender.send(reason.to_string()).expect("the domain still listens to the tunnel");
    }
}

impl Tunnels for FakeTunnels {
    fn open(&self, port: u16) -> TunnelFuture<Result<OpenTunnel, String>> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        self.ports.lock().unwrap().push(port);
        if let Some(message) = self.fail.lock().unwrap().clone() {
            return Box::pin(async move { Err(message) });
        }
        let (end, ended) = oneshot::channel();
        self.enders.lock().unwrap().push(end);
        let guard = Closed(Arc::clone(&self.closed));
        Box::pin(async move { Ok(OpenTunnel { url: format!("http://127.0.0.1:{port}"), ended, guard: Box::new(guard) }) })
    }
}

// ---- the rig ----

struct Client {
    ctx: CallContext,
    notes: mpsc::UnboundedReceiver<String>,
}

impl Client {
    /// The next `remote.changed` status that satisfies `pred`.
    async fn changed_where(&mut self, pred: impl Fn(&Value) -> bool) -> Value {
        tokio::time::timeout(WAIT, async {
            loop {
                let text = self.notes.recv().await.expect("the notifier closed");
                let note: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(note["method"], "remote.changed");
                if pred(&note["params"]) {
                    return note["params"].clone();
                }
            }
        })
        .await
        .expect("the expected remote.changed never came")
    }

    /// Every `remote.changed` status received so far.
    fn drain(&mut self) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(text) = self.notes.try_recv() {
            let note: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(note["method"], "remote.changed");
            out.push(note["params"].clone());
        }
        out
    }
}

struct Rig {
    _dir: tempfile::TempDir,
    remote: RemoteDomain,
    chats: Arc<ChatsDomain>,
    store: Arc<SharedStore>,
    state: Arc<HostState>,
    fake: Arc<Fake>,
    tunnels: Arc<FakeTunnels>,
}

fn new_chat(id: &str) -> Value {
    json!({
        "id": id, "title": "Novo chat", "cwd": "C:/repo", "createdAt": 1, "updatedAt": 1, "turns": [],
        "selection": { "provider": "claude", "profileId": "ambient-claude", "model": "haiku", "effort": "low", "permissionMode": "default" }
    })
}

impl Rig {
    fn new() -> Self {
        Self::with_claude(true)
    }

    /// The host without a Claude executor, as with `PRISM_CLAUDE_ENGINE=sdk`.
    fn with_claude(claude: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = SharedStore::at(dir.path().join("prism-host.db"));
        let host_profiles = Arc::new(HostProfiles::new(Arc::clone(&store), dir.path().join("provider-profiles")));
        let profiles = Profiles::with_roots(Arc::clone(&host_profiles) as Arc<dyn ProfileSource>, dir.path().join("home"), dir.path().join("traycer"));
        let launcher: Arc<dyn Launcher> = Arc::new(NoCodex);
        let queries: Arc<CodexQueries> = CodexQueries::new(Arc::clone(&launcher));
        let _sessions = CodexSessions::new(launcher);
        let catalogs = Catalogs::new(profiles, None, queries);
        let fake = Arc::new(Fake::default());
        let runner: Arc<dyn Runner> = Arc::new(FakeRunner(Arc::clone(&fake)));
        let chats = Arc::new(ChatsDomain::new(Arc::clone(&store), Runners { claude: claude.then(|| Arc::clone(&runner)), codex: Some(runner) }));
        let tunnels = Arc::new(FakeTunnels::default());
        let remote = RemoteDomain::new(RemoteParts {
            chats: Arc::clone(&chats),
            catalogs,
            host_profiles,
            tunnels: Arc::clone(&tunnels) as Arc<dyn Tunnels>,
        });
        let state = HostState::with_domains("t".into(), "h".into(), "Máquina".into(), "qa".into(), Vec::new());
        Rig { _dir: dir, remote, chats, store, state, fake, tunnels }
    }

    fn client(&self, role: Role) -> Client {
        let (tx, notes) = mpsc::unbounded_channel();
        let ctx = CallContext {
            user: UserInfo { id: format!("{role:?}"), name: "qa".into(), role },
            notifier: Notifier::new(next_client_id(), tx),
            state: Arc::clone(&self.state),
        };
        Client { ctx, notes }
    }

    async fn call(&self, client: &Client, method: &str, params: Value) -> Result<Value, HostError> {
        self.remote.call(method, params, client.ctx.clone()).expect("the domain handles it").await
    }

    /// A chat call as the desktop.
    async fn chat(&self, client: &Client, method: &str, params: Value) -> Result<Value, HostError> {
        self.chats.call(method, params, client.ctx.clone()).expect("the chats domain handles it").await
    }

    async fn create(&self, client: &Client, id: &str) {
        self.chat(client, "create", json!({ "chat": new_chat(id) })).await.unwrap();
    }

    async fn share(&self, client: &Client, id: &str) -> ShareResult {
        serde_json::from_value(self.call(client, "share", json!({ "chatId": id })).await.unwrap()).unwrap()
    }

    async fn status(&self, client: &Client) -> RemoteStatus {
        serde_json::from_value(self.call(client, "status", json!({})).await.unwrap()).unwrap()
    }

    /// Holds the chats engine's thread (so every `peek` waits) until the returned
    /// sender is used or dropped. Returns once the engine is held.
    async fn freeze_engine(&self) -> (std::sync::mpsc::Sender<()>, tokio::task::JoinHandle<Result<(), HostError>>) {
        let (release, released) = std::sync::mpsc::channel::<()>();
        let (held, is_held) = std::sync::mpsc::channel::<()>();
        let work = move || {
            let _ = held.send(());
            let _ = released.recv();
            Ok(())
        };
        let job = tokio::spawn(self.chats.exclusive("claude", "congelar", "", Hold::Nothing, work));
        for _ in 0..1000 {
            if is_held.try_recv().is_ok() {
                return (release, job);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the engine was never held");
    }

    /// Waits for the `index`-th turn to reach the provider.
    async fn started(&self, index: usize) -> (TurnStart, TurnSink) {
        for _ in 0..1000 {
            if let Some(found) = self.fake.starts.lock().unwrap().get(index).cloned() {
                return found;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the turn never reached the provider");
    }
}

fn port_of(base_url: &str) -> u16 {
    base_url.rsplit(':').next().unwrap().parse().unwrap()
}

// ---- a phone ----

struct Phone {
    ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
}

async fn connect(base_url: &str, token: &str) -> Result<Phone, tungstenite::Error> {
    let url = format!("ws://127.0.0.1:{}/?t={token}", port_of(base_url));
    tokio_tungstenite::connect_async(url).await.map(|(ws, _)| Phone { ws })
}

impl Phone {
    async fn open(base_url: &str, token: &str) -> Phone {
        connect(base_url, token).await.expect("the phone connects")
    }

    /// The next text message; `None` when the socket closed.
    async fn next(&mut self) -> Option<Value> {
        tokio::time::timeout(WAIT, async {
            loop {
                match self.ws.next().await {
                    Some(Ok(Message::Text(text))) => return Some(serde_json::from_str(text.as_str()).unwrap()),
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return None,
                    Some(Ok(_)) => {}
                }
            }
        })
        .await
        .expect("the phone heard nothing")
    }

    async fn recv(&mut self) -> Value {
        self.next().await.expect("the socket closed")
    }

    /// The next message of type `t`, skipping the others.
    async fn recv_t(&mut self, t: &str) -> Value {
        loop {
            let message = self.recv().await;
            if message["t"] == t {
                return message;
            }
        }
    }

    /// The next message that satisfies `pred`, skipping the others.
    async fn recv_where(&mut self, pred: impl Fn(&Value) -> bool) -> Value {
        loop {
            let message = self.recv().await;
            if pred(&message) {
                return message;
            }
        }
    }

    async fn send(&mut self, message: Value) {
        self.ws.send(Message::Text(message.to_string().into())).await.unwrap();
    }

    async fn cmd(&mut self, tab: &str, action: &str, payload: Value) {
        self.send(json!({ "t": "cmd", "tabId": tab, "action": action, "payload": payload })).await;
    }

    /// Both acks of a command: (`pc`, `done`).
    async fn acks(&mut self, action: &str) -> (Value, Value) {
        let pc = self.recv_where(|m| m["t"] == "ack" && m["stage"] == "pc" && m["action"] == action).await;
        let done = self.recv_where(|m| m["t"] == "ack" && m["stage"] == "done" && m["action"] == action).await;
        (pc, done)
    }

    /// Reads past the greeting (`chats`, then `state`).
    async fn greeting(&mut self) -> (Value, Value) {
        (self.recv_t("chats").await, self.recv_t("state").await)
    }

    /// The socket ends (after whatever is still in flight).
    async fn closed(&mut self) {
        while self.next().await.is_some() {}
    }

    /// Nothing arrives for `ms`.
    async fn quiet(&mut self, ms: u64) {
        if let Ok(message) = tokio::time::timeout(Duration::from_millis(ms), self.ws.next()).await {
            panic!("the phone should have heard nothing, got {message:?}");
        }
    }
}

async fn http_get(port: u16, path: &str) -> (u16, String, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut raw = String::new();
    tokio::time::timeout(WAIT, stream.read_to_string(&mut raw)).await.expect("the server never answered").unwrap();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw.as_str(), ""));
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, head.to_lowercase(), body.to_string())
}

/// The tunnel's guard was dropped `count` times (the host lets the phones' last word out first).
async fn closed(tunnels: &FakeTunnels, count: usize) {
    for _ in 0..400 {
        if tunnels.closed.load(Ordering::SeqCst) == count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the tunnel closed {} times, not {count}", tunnels.closed.load(Ordering::SeqCst));
}

/// The server on `port` no longer accepts connections.
async fn down(port: u16) {
    for _ in 0..200 {
        if TcpStream::connect(("127.0.0.1", port)).await.is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the server on {port} is still up");
}

fn unauthorized(result: Result<Phone, tungstenite::Error>) -> bool {
    matches!(result, Err(tungstenite::Error::Http(response)) if response.status() == 401)
}

macro_rules! rig_test {
    ($name:ident, $body:expr) => {
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn $name() {
            let rig = Rig::new();
            let body: fn(Rig) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> = $body;
            body(rig).await;
        }
    };
}

// ---- sharing and the desktop's view ----

rig_test!(sharing_answers_the_link_and_sharing_again_answers_the_same_token, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    rig.create(&owner, "c2").await;
    assert!(!rig.status(&owner).await.running);

    let first = rig.share(&owner, "c1").await;
    assert_eq!(first.base_url, format!("http://127.0.0.1:{}", rig.tunnels.ports.lock().unwrap()[0]));
    assert_eq!(first.url, link(&first.base_url, &first.token, "c1"));
    assert!(first.url.contains("/#t=") && first.url.ends_with("&c=c1"));
    assert_eq!(first.token.len(), 48, "24 random bytes, hex");

    let again = rig.share(&owner, "c1").await;
    assert_eq!(again, first, "the same link");
    assert_eq!(rig.tunnels.opens.load(Ordering::SeqCst), 1, "one tunnel and one server for every chat");

    let second = rig.share(&owner, "c2").await;
    assert_ne!(second.token, first.token, "each chat has its own secret");
    assert_eq!(second.base_url, first.base_url);
    assert_eq!(rig.tunnels.opens.load(Ordering::SeqCst), 1);

    let status = rig.status(&owner).await;
    assert!(status.running);
    assert_eq!((status.base_url.as_deref(), status.phones, status.reason), (Some(first.base_url.as_str()), 0, None));
    let listed: Vec<_> = status.chats.iter().map(|c| (c.chat_id.as_str(), c.token.as_str(), c.url.as_str(), c.title.as_str(), c.phones, c.streaming, c.pending)).collect();
    assert_eq!(listed, [("c1", first.token.as_str(), first.url.as_str(), "Novo chat", 0, false, false), ("c2", second.token.as_str(), second.url.as_str(), "Novo chat", 0, false, false)]);
}));

rig_test!(a_title_comes_from_the_chat_the_way_the_phone_lists_it, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.chat(&owner, "create", json!({ "chat": { "id": "c1", "title": "Refatorar o parser", "cwd": "C:/repo", "createdAt": 1, "updatedAt": 1, "turns": [], "selection": new_chat("c1")["selection"] } })).await.unwrap();
    rig.share(&owner, "c1").await;
    assert_eq!(rig.status(&owner).await.chats[0].title, "Refatorar o parser");
}));

rig_test!(only_the_owner_may_share_unshare_stop_or_read_the_status, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    let member = rig.client(Role::Member);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    for (method, params) in [("share", json!({ "chatId": "c1" })), ("unshare", json!({ "chatId": "c1" })), ("stop", json!({})), ("status", json!({}))] {
        let err = rig.call(&member, method, params).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Forbidden, "{method}");
    }
    // The member touched nothing: the link still works.
    let status = rig.status(&owner).await;
    assert_eq!(status.chats.len(), 1);
    assert!(connect(&shared.base_url, &shared.token).await.is_ok());
}));

rig_test!(a_missing_chat_is_not_found_and_nothing_starts, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    let err = rig.call(&owner, "share", json!({ "chatId": "nope" })).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(rig.tunnels.opens.load(Ordering::SeqCst), 0);
    assert_eq!(rig.state.activity.holds(), 0);
    assert!(rig.status(&owner).await.chats.is_empty());
}));

/// `share` refused with `Invalid` and a pt-BR reason, and nothing is left shared.
async fn assert_refused(rig: &Rig, owner: &Client, id: &str, reason: &str) {
    let err = rig.call(owner, "share", json!({ "chatId": id })).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    assert!(err.message.contains(reason), "{}", err.message);
    assert_eq!(rig.tunnels.opens.load(Ordering::SeqCst), 0, "no tunnel opened");
    assert_eq!(rig.state.activity.holds(), 0, "the host is not held");
    let status = rig.status(owner).await;
    assert!(status.chats.is_empty() && !status.running && status.phones == 0);
}

rig_test!(an_archived_chat_cannot_be_shared, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    let mut chat = new_chat("c1");
    chat["archived"] = json!(true);
    rig.chat(&owner, "create", json!({ "chat": chat })).await.unwrap();
    assert_refused(&rig, &owner, "c1", "arquivado").await;
}));

rig_test!(a_chat_of_the_old_ssh_mode_cannot_be_shared, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    let mut chat = new_chat("c1");
    chat["remoteId"] = json!("ssh-1");
    rig.chat(&owner, "create", json!({ "chat": chat })).await.unwrap();
    assert_refused(&rig, &owner, "c1", "SSH").await;
}));

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_provider_the_host_does_not_run_cannot_be_shared_and_the_others_can() {
    let rig = Rig::with_claude(false);
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await; // Claude
    assert_refused(&rig, &owner, "c1", "PRISM_CLAUDE_ENGINE=sdk").await;

    let mut codex = new_chat("c2");
    codex["selection"]["provider"] = json!("codex");
    rig.chat(&owner, "create", json!({ "chat": codex })).await.unwrap();
    rig.share(&owner, "c2").await;
    assert_eq!(rig.status(&owner).await.chats.len(), 1);
}

rig_test!(bad_params_are_invalid_and_unknown_methods_are_not_ours, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    assert_eq!(rig.call(&owner, "share", json!({})).await.unwrap_err().code, ErrorCode::Invalid);
    assert_eq!(rig.call(&owner, "unshare", json!({ "chat": 1 })).await.unwrap_err().code, ErrorCode::Invalid);
    assert!(rig.remote.call("bogus", json!({}), owner.ctx.clone()).is_none());
    assert_eq!(rig.remote.name(), "remote");
}));

rig_test!(unsharing_a_chat_that_is_not_shared_is_harmless, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    assert_eq!(rig.call(&owner, "unshare", json!({ "chatId": "nope" })).await.unwrap(), json!({ "ok": true }));
    assert_eq!(rig.call(&owner, "stop", json!({})).await.unwrap(), json!({ "ok": true }));
    assert!(!rig.status(&owner).await.running);
}));

// ---- the server ----

rig_test!(the_server_serves_the_page_the_health_check_and_nothing_else, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let port = port_of(&shared.base_url);

    for path in ["/", "/index.html"] {
        let (status, head, body) = http_get(port, path).await;
        assert_eq!(status, 200, "{path}");
        assert!(head.contains("content-type: text/html"), "{path}: {head}");
        assert!(head.contains("cache-control: no-store"), "{path}: {head}");
        assert!(body.to_lowercase().contains("<html"), "{path}");
    }
    // The page also answers a plain GET with a token (it is the socket that checks it).
    assert_eq!(http_get(port, &format!("/?t={}", shared.token)).await.0, 200);

    let (status, head, body) = http_get(port, "/health").await;
    assert_eq!((status, body.as_str()), (200, "ok"));
    assert!(head.contains("content-type: text/plain"));

    for path in ["/nope", "/health/x", "/api", "/index.html/"] {
        assert_eq!(http_get(port, path).await.0, 404, "{path}");
    }
}));

rig_test!(the_socket_needs_the_token_of_a_shared_chat, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let port = port_of(&shared.base_url);

    assert!(unauthorized(connect(&shared.base_url, "nao-existe").await));
    assert!(unauthorized(connect(&shared.base_url, "").await));
    let no_token = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/")).await;
    assert!(matches!(no_token, Err(tungstenite::Error::Http(r)) if r.status() == 401));
    // The chat's id is not its secret.
    assert!(unauthorized(connect(&shared.base_url, "c1").await));
    assert!(connect(&shared.base_url, &shared.token).await.is_ok());
}));

rig_test!(a_phone_gets_its_chat_and_then_its_state_on_connecting, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;

    let first = phone.recv().await;
    assert_eq!(first["t"], "chats");
    assert_eq!(first["chats"], json!([{ "tabId": "c1", "title": "Novo chat", "streaming": false, "pending": false }]));
    let second = phone.recv().await;
    assert_eq!(second["t"], "state");
    assert_eq!(second["chat"]["tabId"], "c1");
    assert_eq!(second["chat"]["streaming"], false);
    assert_eq!(second["chat"]["turns"], json!([]));
    assert!(second["chat"]["updatedAt"].is_number());
    phone.quiet(300).await;
}));

rig_test!(a_phone_only_hears_about_its_own_chat, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    rig.create(&owner, "c2").await;
    let one = rig.share(&owner, "c1").await;
    let two = rig.share(&owner, "c2").await;
    let mut phone1 = Phone::open(&one.base_url, &one.token).await;
    let mut phone2 = Phone::open(&two.base_url, &two.token).await;
    let (chats, state) = phone1.greeting().await;
    assert_eq!((chats["chats"][0]["tabId"].clone(), state["chat"]["tabId"].clone()), (json!("c1"), json!("c1")));
    let (chats, state) = phone2.greeting().await;
    assert_eq!((chats["chats"][0]["tabId"].clone(), state["chat"]["tabId"].clone()), (json!("c2"), json!("c2")));

    rig.chat(&owner, "rename", json!({ "chatId": "c2", "title": "Só o segundo" })).await.unwrap();
    let delta = phone2.recv_t("delta").await;
    assert_eq!((delta["tabId"].clone(), delta["title"].clone()), (json!("c2"), json!("Só o segundo")));
    phone1.quiet(500).await;
}));

// ---- the phone's messages ----

rig_test!(ping_is_answered_with_pong_and_noise_is_ignored, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;
    phone.send(json!({ "t": "ping" })).await;
    assert_eq!(phone.recv().await, json!({ "t": "pong" }));

    // None of these is a command or a ping: no answer, and the socket stays up.
    phone.ws.send(Message::Text("isto não é json".into())).await.unwrap();
    phone.send(json!({ "t": "outra" })).await;
    phone.send(json!({ "t": "cmd" })).await;
    phone.send(json!({ "t": "cmd", "tabId": "c1" })).await;
    phone.send(json!({ "t": "cmd", "tabId": "c1", "action": "" })).await;
    phone.send(json!({ "t": "cmd", "action": "send" })).await;
    phone.send(json!({ "t": "ping" })).await;
    assert_eq!(phone.recv().await, json!({ "t": "pong" }), "nothing came in between");
}));

rig_test!(a_command_for_another_chat_is_forbidden_and_never_runs, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    rig.create(&owner, "c2").await;
    let one = rig.share(&owner, "c1").await;
    rig.share(&owner, "c2").await;
    let mut phone = Phone::open(&one.base_url, &one.token).await;
    phone.greeting().await;

    phone.cmd("c2", "send", json!({ "text": "oi" })).await;
    let ack = phone.recv().await;
    assert_eq!(ack, json!({ "t": "ack", "stage": "pc", "action": "send", "ok": false, "reason": "forbidden" }));
    phone.cmd("nope", "send", json!({ "text": "oi" })).await;
    assert_eq!(phone.recv().await["reason"], "forbidden");
    phone.quiet(300).await;
    assert!(rig.fake.starts.lock().unwrap().is_empty());
}));

rig_test!(a_command_is_acked_at_the_desktop_and_then_done_with_the_reason_it_was_refused, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;

    for (action, payload, reason) in [
        ("send", json!({ "text": "   " }), "empty"),
        ("send", json!({}), "empty"),
        ("stop", json!({}), "idle"),
        ("perm", json!({ "permId": "p", "decision": "allow" }), "gone"),
        ("perm", json!({ "permId": "p", "decision": "talvez" }), "invalid"),
        ("question", json!({ "dialogId": "d", "answers": { "Q": "A" } }), "gone"),
        ("dançar", json!({}), "unknown"),
    ] {
        phone.cmd("c1", action, payload).await;
        let (pc, done) = phone.acks(action).await;
        assert_eq!(pc, json!({ "t": "ack", "stage": "pc", "action": action, "ok": true, "reason": "" }), "{action}");
        assert_eq!(done, json!({ "t": "ack", "stage": "done", "action": action, "ok": false, "reason": reason }), "{action} {reason}");
    }
    assert!(rig.fake.starts.lock().unwrap().is_empty(), "no refused command reached the engine");
}));

rig_test!(a_read_only_chat_refuses_a_send, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    let mut chat = new_chat("c1");
    chat["readOnly"] = json!(true);
    rig.chat(&owner, "create", json!({ "chat": chat })).await.unwrap();
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;
    phone.cmd("c1", "send", json!({ "text": "oi" })).await;
    let (_, done) = phone.acks("send").await;
    assert_eq!((done["ok"].clone(), done["reason"].clone()), (json!(false), json!("read-only")));
}));

// ---- a turn from the phone ----

rig_test!(a_send_from_the_phone_starts_a_turn_as_the_phone_and_the_phone_follows_it, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;

    phone.cmd("c1", "send", json!({ "text": "  Liste os arquivos  " })).await;
    let (pc, done) = phone.acks("send").await;
    assert_eq!((pc["ok"].clone(), done["ok"].clone(), done["reason"].clone()), (json!(true), json!(true), json!("")));

    let (start, sink) = rig.started(0).await;
    assert_eq!((start.chat_id.as_str(), start.prompt.as_str(), start.service_tier.clone()), ("c1", "Liste os arquivos", None));
    assert_eq!(start.selection["model"], "haiku");

    // The phone sees the chat start running, with the turns.
    let delta = phone.recv_where(|m| m["t"] == "delta" && m["streaming"] == true).await;
    assert_eq!(delta["tabId"], "c1");
    assert_eq!(delta["title"], "Liste os arquivos");
    assert_eq!(delta["ids"].as_array().unwrap().len(), 2);
    let listed = phone.recv_t("chats").await;
    assert_eq!(listed["chats"][0]["streaming"], true);

    // The desktop's view counts it, too.
    let streaming = rig.status(&owner).await.chats[0].streaming;
    assert!(streaming);

    sink.send(TurnEvent::Text("Vou listar.".into()));
    let delta = phone.recv_where(|m| m["t"] == "delta" && m.to_string().contains("Vou listar.")).await;
    assert_eq!(delta["tabId"], "c1");
    sink.send(TurnEvent::Done { aborted: false });
    let delta = phone.recv_where(|m| m["t"] == "delta" && m["streaming"] == false).await;
    assert_eq!(delta["tabId"], "c1");
    let listed = phone.recv_t("chats").await;
    assert_eq!(listed["chats"][0]["streaming"], false);

    // The journal says who began it: the phone, by chat.
    rig.chats.peek("c1").await.unwrap();
    let events = rig.store.get().unwrap().events("c1").unwrap();
    assert_eq!(events[0].kind(), Some("begin"));
    assert_eq!(events[0].actor.as_deref(), Some("celular · c1"));
    assert!(!rig.status(&owner).await.chats[0].streaming);
}));

rig_test!(a_busy_chat_queues_a_second_send_and_a_stop_preserves_it, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;
    phone.cmd("c1", "send", json!({ "text": "um" })).await;
    phone.acks("send").await;
    rig.started(0).await;
    phone.recv_where(|m| m["t"] == "delta" && m["streaming"] == true).await;

    phone.cmd("c1", "send", json!({ "text": "dois" })).await;
    let (_, done) = phone.acks("send").await;
    assert_eq!((done["ok"].clone(), done["reason"].clone()), (json!(true), json!("")));
    assert_eq!(rig.chats.peek("c1").await.unwrap().unwrap().0["queued"][0]["text"], "dois");
    assert_eq!(rig.fake.starts.lock().unwrap().len(), 1);

    phone.cmd("c1", "stop", json!({})).await;
    let (_, done) = phone.acks("stop").await;
    assert_eq!(done["ok"], true);
    let aborts = rig.fake.aborts.lock().unwrap().clone();
    assert_eq!(aborts.len(), 1);
    assert_eq!(aborts[0].0, "c1");
}));

rig_test!(a_send_carries_the_selections_tier_when_the_host_has_no_catalog_to_say_otherwise, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    let mut chat = new_chat("c1");
    chat["selection"]["serviceTier"] = json!("fast");
    rig.chat(&owner, "create", json!({ "chat": chat })).await.unwrap();
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;
    phone.cmd("c1", "send", json!({ "text": "rápido" })).await;
    phone.acks("send").await;
    assert_eq!(rig.started(0).await.0.service_tier.as_deref(), Some("fast"));
}));

rig_test!(a_permission_reaches_the_phone_and_its_answer_reaches_the_provider, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;
    phone.cmd("c1", "send", json!({ "text": "rode" })).await;
    phone.acks("send").await;
    let (start, sink) = rig.started(0).await;
    sink.send(TurnEvent::Tool { tool_id: "t1".into(), name: json!("Bash"), input: Some(json!({ "command": "ls" })) });
    sink.send(TurnEvent::Permission(json!({ "id": start.turn_id, "permId": "p1", "toolName": "Bash", "toolUseId": "t1" })));

    let delta = phone.recv_where(|m| m["t"] == "delta" && m.to_string().contains("pendingPerm")).await;
    let running = delta["turns"].as_array().unwrap().iter().find(|t| t.get("pendingPerm").is_some()).unwrap().clone();
    assert_eq!(running["pendingPerm"]["permId"], "p1");
    assert_eq!(running["pendingPerm"]["toolName"], "Bash");
    let listed = phone.recv_where(|m| m["t"] == "chats" && m["chats"][0]["pending"] == true).await;
    assert_eq!(listed["chats"][0]["tabId"], "c1");
    assert!(rig.status(&owner).await.chats[0].pending, "the desktop sees it waits on someone");

    // A stale or wrong id is refused as gone.
    phone.cmd("c1", "perm", json!({ "permId": "outra", "decision": "allow" })).await;
    let (_, done) = phone.acks("perm").await;
    assert_eq!((done["ok"].clone(), done["reason"].clone()), (json!(false), json!("gone")));
    phone.cmd("c1", "perm", json!({ "permId": "p1", "turnId": "velho", "decision": "allow" })).await;
    let (_, done) = phone.acks("perm").await;
    assert_eq!(done["reason"], "gone");
    assert!(rig.fake.permissions.lock().unwrap().is_empty());

    phone.cmd("c1", "perm", json!({ "permId": "p1", "turnId": start.turn_id, "decision": "allow" })).await;
    let (_, done) = phone.acks("perm").await;
    assert_eq!((done["ok"].clone(), done["reason"].clone()), (json!(true), json!("")));
    assert_eq!(rig.fake.permissions.lock().unwrap().as_slice(), &[("c1".to_string(), "p1".to_string(), "allow".to_string())]);

    // No longer pending, and the answer is the phone's in the journal.
    phone.recv_where(|m| m["t"] == "chats" && m["chats"][0]["pending"] == false).await;
    rig.chats.peek("c1").await.unwrap();
    let events = rig.store.get().unwrap().events("c1").unwrap();
    let actors: Vec<_> = events.iter().filter(|e| e.kind() == Some("segment") && e.event["segment"]["toolId"] == "t1").filter_map(|e| e.actor.clone()).collect();
    assert_eq!(actors, ["celular · c1"]);

    // Answering twice is gone.
    phone.cmd("c1", "perm", json!({ "permId": "p1", "decision": "allow" })).await;
    let (_, done) = phone.acks("perm").await;
    assert_eq!(done["reason"], "gone");
}));

rig_test!(a_question_reaches_the_phone_and_its_answers_reach_the_provider, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;
    phone.cmd("c1", "send", json!({ "text": "pergunte" })).await;
    phone.acks("send").await;
    let (start, sink) = rig.started(0).await;
    sink.send(TurnEvent::Question(json!({
        "id": start.turn_id, "dialogId": "d1",
        "questions": [{ "question": "Qual?", "header": "Escolha", "options": [{ "label": "A", "description": "a" }, { "label": "B" }] }]
    })));
    let delta = phone.recv_where(|m| m["t"] == "delta" && m.to_string().contains("pendingQuestion")).await;
    let running = delta["turns"].as_array().unwrap().iter().find(|t| t.get("pendingQuestion").is_some()).unwrap().clone();
    assert_eq!(running["pendingQuestion"]["dialogId"], "d1");
    assert_eq!(running["pendingQuestion"]["questions"][0]["question"], "Qual?");

    // Nothing chosen is `empty`; a wrong dialog is `gone`.
    phone.cmd("c1", "question", json!({ "dialogId": "d1", "answers": {} })).await;
    assert_eq!(phone.acks("question").await.1["reason"], "empty");
    phone.cmd("c1", "question", json!({ "dialogId": "x", "answers": { "Qual?": "A" } })).await;
    assert_eq!(phone.acks("question").await.1["reason"], "gone");
    assert!(rig.fake.questions.lock().unwrap().is_empty());

    phone.cmd("c1", "question", json!({ "dialogId": "d1", "answers": { "Qual?": "B" } })).await;
    let (_, done) = phone.acks("question").await;
    assert_eq!((done["ok"].clone(), done["reason"].clone()), (json!(true), json!("")));
    let answered = rig.fake.questions.lock().unwrap().clone();
    assert_eq!(answered.len(), 1);
    assert_eq!((answered[0].0.as_str(), answered[0].1.as_str()), ("c1", "d1"));
    assert_eq!(answered[0].2.as_ref().unwrap().get("Qual?"), Some(&json!("B")));
}));

rig_test!(a_cancelled_question_answers_none, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;
    phone.cmd("c1", "send", json!({ "text": "pergunte" })).await;
    phone.acks("send").await;
    let (start, sink) = rig.started(0).await;
    sink.send(TurnEvent::Question(json!({ "id": start.turn_id, "dialogId": "d1", "questions": [{ "question": "Qual?" }] })));
    phone.recv_where(|m| m["t"] == "delta" && m.to_string().contains("pendingQuestion")).await;
    phone.cmd("c1", "question", json!({ "dialogId": "d1", "cancelled": true })).await;
    assert_eq!(phone.acks("question").await.1["ok"], true);
    let answered = rig.fake.questions.lock().unwrap().clone();
    assert_eq!(answered.len(), 1);
    assert!(answered[0].2.is_none());
}));

// ---- following the chat ----

rig_test!(a_change_to_the_chat_reaches_the_phone_as_a_delta_and_a_new_list_entry, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;

    rig.chat(&owner, "rename", json!({ "chatId": "c1", "title": "Outro nome" })).await.unwrap();
    let delta = phone.recv_t("delta").await;
    assert_eq!(delta["tabId"], "c1");
    assert_eq!(delta["title"], "Outro nome");
    assert_eq!((delta["ids"].clone(), delta["turns"].clone()), (json!([]), json!([])));
    let listed = phone.recv_t("chats").await;
    assert_eq!(listed["chats"][0]["title"], "Outro nome");
    assert_eq!(rig.status(&owner).await.chats[0].title, "Outro nome");

    // A change that the phone does not render (the same title again) is not sent.
    rig.chat(&owner, "rename", json!({ "chatId": "c1", "title": "Outro nome" })).await.unwrap();
    phone.quiet(500).await;
}));

rig_test!(many_quick_changes_are_read_at_most_every_160ms_and_the_last_one_arrives, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;
    phone.cmd("c1", "send", json!({ "text": "fale muito" })).await;
    phone.acks("send").await;
    let (_, sink) = rig.started(0).await;

    // 60 pieces of text, 10 ms apart: about 600 ms of streaming.
    let streaming = tokio::spawn(async move {
        for i in 0..60 {
            sink.send(TurnEvent::Text(format!("[{i}]")));
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    let mut deltas: Vec<(Instant, Value)> = Vec::new();
    let mut quiet_since = Instant::now();
    while quiet_since.elapsed() < Duration::from_millis(700) {
        if let Ok(Some(message)) = tokio::time::timeout(Duration::from_millis(100), phone.next()).await
            && message["t"] == "delta"
        {
            deltas.push((Instant::now(), message));
            quiet_since = Instant::now();
        }
    }
    streaming.await.unwrap();

    assert!(deltas.len() < 30, "60 changes must not mean 60 deltas, got {}", deltas.len());
    for pair in deltas.windows(2) {
        let gap = pair[1].0.duration_since(pair[0].0);
        assert!(gap >= Duration::from_millis(100), "two reads only {gap:?} apart");
    }
    let last = deltas.last().expect("a delta").1.to_string();
    assert!(last.contains("[59]"), "the last change is not lost: {last}");
}));

// ---- revoking ----

rig_test!(a_removed_chat_revokes_its_link_and_the_other_chats_go_on, |rig| Box::pin(async move {
    let mut owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    rig.create(&owner, "c2").await;
    let one = rig.share(&owner, "c1").await;
    let two = rig.share(&owner, "c2").await;
    let mut phone1 = Phone::open(&one.base_url, &one.token).await;
    let mut phone2 = Phone::open(&two.base_url, &two.token).await;
    phone1.greeting().await;
    phone2.greeting().await;
    owner.drain();

    rig.chat(&owner, "remove", json!({ "chatId": "c1" })).await.unwrap();
    assert_eq!(phone1.recv_t("revoked").await, json!({ "t": "revoked", "tabId": "c1" }));
    phone1.closed().await;
    assert!(unauthorized(connect(&one.base_url, &one.token).await));

    // The other chat's link and phone are untouched.
    phone2.send(json!({ "t": "ping" })).await;
    assert_eq!(phone2.recv().await, json!({ "t": "pong" }));
    let status = owner.changed_where(|s| s["chats"].as_array().is_some_and(|c| c.len() == 1)).await;
    assert_eq!(status["chats"][0]["chatId"], "c2");
    assert_eq!(status["running"], true);
    assert!(connect(&two.base_url, &two.token).await.is_ok());
}));

rig_test!(an_archived_chat_revokes_its_link_and_the_last_one_stops_everything, |rig| Box::pin(async move {
    let mut owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;
    owner.drain();

    rig.chat(&owner, "archive", json!({ "chatId": "c1", "archived": true })).await.unwrap();
    assert_eq!(phone.recv_t("revoked").await["tabId"], "c1");
    phone.closed().await;
    let stopped = owner.changed_where(|s| s["reason"] == "empty").await;
    assert_eq!((stopped["running"].clone(), stopped["chats"].clone(), stopped["phones"].clone()), (json!(false), json!([]), json!(0)));
    down(port_of(&shared.base_url)).await;
    assert_eq!(rig.state.activity.holds(), 0);
    // Un-archiving does not share it again.
    rig.chat(&owner, "archive", json!({ "chatId": "c1", "archived": false })).await.unwrap();
    assert!(!rig.status(&owner).await.running);
}));

rig_test!(unshare_revokes_that_chat_and_the_last_one_stops_the_tunnel_with_empty, |rig| Box::pin(async move {
    let mut owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    rig.create(&owner, "c2").await;
    let one = rig.share(&owner, "c1").await;
    let two = rig.share(&owner, "c2").await;
    let mut phone1 = Phone::open(&one.base_url, &one.token).await;
    let mut phone2 = Phone::open(&two.base_url, &two.token).await;
    phone1.greeting().await;
    phone2.greeting().await;
    owner.drain();

    rig.call(&owner, "unshare", json!({ "chatId": "c1" })).await.unwrap();
    assert_eq!(phone1.recv_t("revoked").await["tabId"], "c1");
    phone1.closed().await;
    assert!(unauthorized(connect(&one.base_url, &one.token).await));
    phone2.send(json!({ "t": "ping" })).await;
    assert_eq!(phone2.recv().await, json!({ "t": "pong" }));
    assert_eq!(rig.tunnels.closed.load(Ordering::SeqCst), 0, "a chat is still shared");
    assert!(rig.status(&owner).await.running);
    assert!(owner.drain().iter().all(|s| s.get("reason").is_none()));

    rig.call(&owner, "unshare", json!({ "chatId": "c2" })).await.unwrap();
    assert_eq!(phone2.recv_t("revoked").await["tabId"], "c2");
    phone2.closed().await;
    let stopped = owner.changed_where(|s| s["reason"] == "empty").await;
    assert_eq!((stopped["running"].clone(), stopped["baseUrl"].clone(), stopped["chats"].clone()), (json!(false), Value::Null, json!([])));
    closed(&rig.tunnels, 1).await;
    down(port_of(&one.base_url)).await;

    // Sharing again opens a new server and mints a new token.
    let again = rig.share(&owner, "c1").await;
    assert_ne!(again.token, one.token);
    assert_eq!(rig.tunnels.opens.load(Ordering::SeqCst), 2);
    assert!(unauthorized(connect(&again.base_url, &one.token).await), "the old token is dead");
    assert!(connect(&again.base_url, &again.token).await.is_ok());
}));

rig_test!(stop_ends_every_link_tells_the_phones_and_the_desktop_gets_user, |rig| Box::pin(async move {
    let mut owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    rig.create(&owner, "c2").await;
    let one = rig.share(&owner, "c1").await;
    let two = rig.share(&owner, "c2").await;
    let mut phone1 = Phone::open(&one.base_url, &one.token).await;
    let mut phone2 = Phone::open(&two.base_url, &two.token).await;
    phone1.greeting().await;
    phone2.greeting().await;
    owner.drain();

    assert_eq!(rig.call(&owner, "stop", json!({})).await.unwrap(), json!({ "ok": true }));
    for phone in [&mut phone1, &mut phone2] {
        assert_eq!(phone.recv_t("stopped").await, json!({ "t": "stopped" }));
        phone.closed().await;
    }
    let stopped = owner.changed_where(|s| s["reason"] == "user").await;
    assert_eq!((stopped["running"].clone(), stopped["chats"].clone(), stopped["phones"].clone()), (json!(false), json!([]), json!(0)));
    closed(&rig.tunnels, 1).await;
    down(port_of(&one.base_url)).await;
    let status = rig.status(&owner).await;
    assert!((status.running, status.chats.len(), status.reason) == (false, 0, None));
    assert_eq!(rig.state.activity.holds(), 0);
}));

// ---- the tunnel ----

rig_test!(a_tunnel_that_ends_on_its_own_stops_everything_with_tunnel, |rig| Box::pin(async move {
    let mut owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;
    owner.drain();

    rig.tunnels.end("o cloudflared saiu");
    assert_eq!(phone.recv_t("stopped").await, json!({ "t": "stopped" }));
    phone.closed().await;
    let stopped = owner.changed_where(|s| s["reason"] == "tunnel").await;
    assert_eq!((stopped["running"].clone(), stopped["chats"].clone()), (json!(false), json!([])));
    down(port_of(&shared.base_url)).await;
    assert_eq!(rig.state.activity.holds(), 0);
    assert!(!rig.status(&owner).await.running);
}));

rig_test!(a_tunnel_that_ends_after_the_links_were_stopped_does_not_stop_the_next_ones, |rig| Box::pin(async move {
    let mut owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    rig.call(&owner, "stop", json!({})).await.unwrap();
    owner.drain();
    // The first tunnel's channel is gone with its guard; a new share opens a second one.
    let again = rig.share(&owner, "c1").await;
    assert_eq!(rig.tunnels.opens.load(Ordering::SeqCst), 2);
    assert_ne!(again.token, shared.token);
    assert!(rig.status(&owner).await.running);
    assert!(owner.drain().iter().all(|s| s.get("reason").is_none()));
}));

rig_test!(a_tunnel_that_fails_to_open_answers_the_error_and_stops_with_error, |rig| Box::pin(async move {
    let mut owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    *rig.tunnels.fail.lock().unwrap() = Some("não consegui abrir o túnel".into());
    let err = rig.call(&owner, "share", json!({ "chatId": "c1" })).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Internal);
    assert_eq!(err.message, "não consegui abrir o túnel");
    let stopped = owner.changed_where(|s| s["reason"] == "error").await;
    assert_eq!((stopped["running"].clone(), stopped["chats"].clone()), (json!(false), json!([])));
    assert_eq!(rig.state.activity.holds(), 0, "a failed share does not keep the host up");
    assert!(rig.status(&owner).await.chats.is_empty());
    let port = rig.tunnels.ports.lock().unwrap()[0];
    down(port).await;

    // Once the tunnel works, the same chat shares.
    *rig.tunnels.fail.lock().unwrap() = None;
    let shared = rig.share(&owner, "c1").await;
    assert!(rig.status(&owner).await.running);
    assert!(connect(&shared.base_url, &shared.token).await.is_ok());
}));

rig_test!(shares_that_wait_for_the_tunnel_all_get_their_link_or_all_the_error, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    rig.create(&owner, "c2").await;
    let (a, b) = tokio::join!(rig.call(&owner, "share", json!({ "chatId": "c1" })), rig.call(&owner, "share", json!({ "chatId": "c2" })));
    let (a, b): (ShareResult, ShareResult) = (serde_json::from_value(a.unwrap()).unwrap(), serde_json::from_value(b.unwrap()).unwrap());
    assert_eq!(a.base_url, b.base_url);
    assert_ne!(a.token, b.token);
    assert_eq!(rig.tunnels.opens.load(Ordering::SeqCst), 1, "one tunnel for both");
}));

// ---- the host stays up while a chat is shared ----

rig_test!(the_host_is_held_while_any_chat_is_shared_and_released_when_none_is, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    rig.create(&owner, "c2").await;
    assert_eq!(rig.state.activity.holds(), 0);
    rig.share(&owner, "c1").await;
    assert_eq!(rig.state.activity.holds(), 1);
    rig.share(&owner, "c2").await;
    assert_eq!(rig.state.activity.holds(), 1, "one hold for all of them");
    rig.call(&owner, "unshare", json!({ "chatId": "c1" })).await.unwrap();
    assert_eq!(rig.state.activity.holds(), 1);
    rig.call(&owner, "unshare", json!({ "chatId": "c2" })).await.unwrap();
    assert_eq!(rig.state.activity.holds(), 0);
    rig.share(&owner, "c1").await;
    assert_eq!(rig.state.activity.holds(), 1);
    rig.call(&owner, "stop", json!({})).await.unwrap();
    assert_eq!(rig.state.activity.holds(), 0);
}));

rig_test!(sharing_goes_on_with_every_window_closed, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;

    // The desktop disconnects: the domain forgets its notifier and nothing else changes.
    rig.remote.disconnected(owner.ctx.notifier.client);
    drop(owner);
    phone.send(json!({ "t": "ping" })).await;
    assert_eq!(phone.recv().await, json!({ "t": "pong" }));
    let second = rig.client(Role::Owner);
    let status = rig.status(&second).await;
    assert_eq!((status.running, status.phones, status.chats.len()), (true, 1, 1));
    assert_eq!(rig.state.activity.holds(), 1);
}));

// ---- what the desktop is told ----

rig_test!(remote_changed_counts_the_phones_as_they_come_and_go, |rig| Box::pin(async move {
    let mut owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    rig.create(&owner, "c2").await;
    let one = rig.share(&owner, "c1").await;
    let two = rig.share(&owner, "c2").await;
    let phones = |s: &Value| (s["phones"].as_u64().unwrap(), s["chats"][0]["phones"].as_u64().unwrap(), s["chats"][1]["phones"].as_u64().unwrap());
    owner.drain();

    let mut a = Phone::open(&one.base_url, &one.token).await;
    let status = owner.changed_where(|s| s["phones"] == 1).await;
    assert_eq!(phones(&status), (1, 1, 0));
    let b = Phone::open(&one.base_url, &one.token).await;
    let status = owner.changed_where(|s| s["phones"] == 2).await;
    assert_eq!(phones(&status), (2, 2, 0));
    let c = Phone::open(&two.base_url, &two.token).await;
    let status = owner.changed_where(|s| s["phones"] == 3).await;
    assert_eq!(phones(&status), (3, 2, 1));
    assert_eq!(rig.status(&owner).await.phones, 3);

    a.ws.close(None).await.unwrap();
    let status = owner.changed_where(|s| s["phones"] == 2).await;
    assert_eq!(phones(&status), (2, 1, 1));
    drop(b.ws);
    let status = owner.changed_where(|s| s["phones"] == 1).await;
    assert_eq!(phones(&status), (1, 0, 1));
    drop(c);
    owner.changed_where(|s| s["phones"] == 0).await;
}));

rig_test!(every_connected_desktop_hears_remote_changed, |rig| Box::pin(async move {
    let mut one = rig.client(Role::Owner);
    let mut two = rig.client(Role::Owner);
    rig.create(&one, "c1").await;
    rig.call(&two, "status", json!({})).await.unwrap(); // the domain knows this client now
    rig.share(&one, "c1").await;
    for client in [&mut one, &mut two] {
        let status = client.changed_where(|s| s["running"] == true).await;
        assert_eq!(status["chats"][0]["chatId"], "c1");
    }
}));

// ---- one command per phone ----

fn is_ack(m: &Value, stage: &str, action: &str) -> bool {
    m["t"] == "ack" && m["stage"] == stage && m["action"] == action
}

rig_test!(a_phone_runs_one_command_at_a_time_and_is_free_again_when_it_ends, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;

    // Every read waits for the engine: the first command stays in flight.
    let (release, job) = rig.freeze_engine().await;
    phone.cmd("c1", "stop", json!({})).await;
    let pc = phone.recv_where(|m| is_ack(m, "pc", "stop")).await;
    assert_eq!((pc["ok"].clone(), pc["reason"].clone()), (json!(true), json!("")));

    phone.cmd("c1", "send", json!({ "text": "oi" })).await;
    let pc = phone.recv_where(|m| is_ack(m, "pc", "send")).await;
    assert_eq!((pc["ok"].clone(), pc["reason"].clone()), (json!(false), json!("busy")));

    release.send(()).unwrap();
    job.await.unwrap().unwrap();
    let done = phone.recv_where(|m| is_ack(m, "done", "stop")).await;
    assert_eq!((done["ok"].clone(), done["reason"].clone()), (json!(false), json!("idle")));

    // Free again; the refused send never ran and never got a `done`.
    phone.cmd("c1", "stop", json!({})).await;
    let mut seen = Vec::new();
    loop {
        let message = phone.recv().await;
        let finished = is_ack(&message, "done", "stop");
        seen.push(message);
        if finished {
            break;
        }
    }
    assert!(seen.iter().any(|m| is_ack(m, "pc", "stop") && m["ok"] == true), "{seen:?}");
    assert!(!seen.iter().any(|m| m["action"] == "send"), "{seen:?}");
    assert!(rig.fake.starts.lock().unwrap().is_empty());
}));

rig_test!(another_phone_on_the_same_chat_is_not_blocked_by_a_busy_one, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let mut a = Phone::open(&shared.base_url, &shared.token).await;
    let mut b = Phone::open(&shared.base_url, &shared.token).await;
    a.greeting().await;
    b.greeting().await;

    let (release, job) = rig.freeze_engine().await;
    a.cmd("c1", "stop", json!({})).await;
    assert_eq!(a.recv_where(|m| is_ack(m, "pc", "stop")).await["ok"], true);
    a.cmd("c1", "stop", json!({})).await;
    let busy = a.recv_where(|m| is_ack(m, "pc", "stop")).await;
    assert_eq!((busy["ok"].clone(), busy["reason"].clone()), (json!(false), json!("busy")));

    // `b` has its own slot.
    b.cmd("c1", "stop", json!({})).await;
    let pc = b.recv_where(|m| is_ack(m, "pc", "stop")).await;
    assert_eq!((pc["ok"].clone(), pc["reason"].clone()), (json!(true), json!("")));

    release.send(()).unwrap();
    job.await.unwrap().unwrap();
    assert_eq!(a.recv_where(|m| is_ack(m, "done", "stop")).await["reason"], "idle");
    assert_eq!(b.recv_where(|m| is_ack(m, "done", "stop")).await["reason"], "idle");
}));

// ---- a phone counts once its socket is open ----

rig_test!(a_phone_is_counted_only_after_the_upgrade, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    let shared = rig.share(&owner, "c1").await;
    let port = port_of(&shared.base_url);

    // A request that never finishes (the phone gave up) and one the token refuses.
    let mut half = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    half.write_all(format!("GET /?t={} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n", shared.token).as_bytes()).await.unwrap();
    assert!(unauthorized(connect(&shared.base_url, "errado").await));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(rig.status(&owner).await.phones, 0);
    assert_eq!(rig.status(&owner).await.chats[0].phones, 0);

    let mut phone = Phone::open(&shared.base_url, &shared.token).await;
    phone.greeting().await;
    assert_eq!(rig.status(&owner).await.phones, 1);
    drop(half);
    drop(phone);
}));

rig_test!(a_token_revoked_between_the_check_and_the_open_closes_the_socket, |rig| Box::pin(async move {
    let owner = rig.client(Role::Owner);
    rig.create(&owner, "c1").await;
    rig.create(&owner, "c2").await;
    let one = rig.share(&owner, "c1").await;

    // The actor waits on the engine inside this share, while the phone's check
    // and the unshare queue behind it, in that order. The open comes after both.
    let (release, job) = rig.freeze_engine().await;
    let sharing = rig.share(&owner, "c2");
    let connecting = connect(&one.base_url, &one.token);
    let unsharing = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        rig.call(&owner, "unshare", json!({ "chatId": "c1" })).await.unwrap();
    };
    let releasing = async {
        tokio::time::sleep(Duration::from_millis(600)).await;
        release.send(()).unwrap();
    };
    let (_, phone, (), ()) = tokio::join!(sharing, connecting, unsharing, releasing);
    job.await.unwrap().unwrap();

    // The upgrade went through, then the host shut the socket: no greeting.
    let mut phone = phone.expect("the check passed before the revocation");
    assert!(phone.next().await.is_none());
    let status = rig.status(&owner).await;
    assert_eq!((status.phones, status.chats.len()), (0, 1));
}));

// ---- pure functions ----

mod pure {
    use super::*;

    fn models() -> Vec<Value> {
        vec![
            json!({ "id": "haiku", "fast": { "id": "fast" } }),
            json!({ "id": "opus", "default": true, "fast": { "id": "priority" } }),
            json!({ "id": "plain" }),
        ]
    }

    #[test]
    fn effective_tier_needs_a_tier_in_the_selection() {
        assert_eq!(effective_tier(&json!({ "model": "haiku" }), Some(&models())), None);
        assert_eq!(effective_tier(&json!({ "model": "haiku", "serviceTier": "" }), Some(&models())), None);
        assert_eq!(effective_tier(&json!({ "serviceTier": null }), None), None);
        assert_eq!(effective_tier(&Value::Null, None), None);
    }

    #[test]
    fn effective_tier_stays_as_chosen_without_a_catalog_to_judge_it() {
        let selection = json!({ "model": "haiku", "serviceTier": "fast" });
        assert_eq!(effective_tier(&selection, None), Some("fast".into()));
        assert_eq!(effective_tier(&selection, Some(&[])), Some("fast".into()));
    }

    #[test]
    fn effective_tier_is_kept_only_when_the_model_honours_it() {
        let models = models();
        assert_eq!(effective_tier(&json!({ "model": "haiku", "serviceTier": "fast" }), Some(&models)), Some("fast".into()));
        assert_eq!(effective_tier(&json!({ "model": "haiku", "serviceTier": "priority" }), Some(&models)), None, "another model's tier");
        assert_eq!(effective_tier(&json!({ "model": "plain", "serviceTier": "fast" }), Some(&models)), None, "a model with no Fast");
        assert_eq!(effective_tier(&json!({ "model": "nao-achei", "serviceTier": "fast" }), Some(&models)), None, "a model the catalog lacks");
    }

    #[test]
    fn effective_tier_uses_the_catalogs_default_model_when_the_selection_has_none() {
        let models = models();
        assert_eq!(effective_tier(&json!({ "serviceTier": "priority" }), Some(&models)), Some("priority".into()));
        assert_eq!(effective_tier(&json!({ "serviceTier": "fast" }), Some(&models)), None);
        assert_eq!(effective_tier(&json!({ "model": "", "serviceTier": "priority" }), Some(&models)), Some("priority".into()));
        let without_default = vec![json!({ "id": "haiku", "fast": { "id": "fast" } })];
        assert_eq!(effective_tier(&json!({ "serviceTier": "fast" }), Some(&without_default)), None);
    }

    #[test]
    fn link_is_the_base_the_token_and_the_encoded_chat_id() {
        assert_eq!(link("https://a.trycloudflare.com", "abc", "c1"), "https://a.trycloudflare.com/#t=abc&c=c1");
        assert_eq!(link("http://127.0.0.1:9", "t", "a b/c?d"), "http://127.0.0.1:9/#t=t&c=a%20b%2Fc%3Fd");
    }

    #[test]
    fn encode_component_is_encode_uri_component() {
        // What `encodeURIComponent` answers for each (checked by hand against the spec's unreserved set).
        for (input, expected) in [
            ("", ""),
            ("abcXYZ019", "abcXYZ019"),
            ("-_.!~*'()", "-_.!~*'()"),
            ("a b", "a%20b"),
            (";,/?:@&=+$#", "%3B%2C%2F%3F%3A%40%26%3D%2B%24%23"),
            ("%", "%25"),
            ("\"<>[]{}|\\^`", "%22%3C%3E%5B%5D%7B%7D%7C%5C%5E%60"),
            ("é", "%C3%A9"),
            ("日本", "%E6%97%A5%E6%9C%AC"),
            ("😀", "%F0%9F%98%80"),
            ("a\nb\t", "a%0Ab%09"),
            ("550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4-a716-446655440000"),
        ] {
            assert_eq!(encode_component(input), expected, "{input:?}");
        }
    }
}
