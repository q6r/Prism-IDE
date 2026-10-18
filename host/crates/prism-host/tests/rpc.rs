//! The host's wire contract, end to end over a real WebSocket.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use prism_host::{serve, spawn_idle_watcher, HostState};
use prism_protocol::{PROTOCOL_MAJOR, PROTOCOL_MINOR};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async fn start() -> (u16, Arc<HostState>, tokio::task::JoinHandle<std::io::Result<()>>) {
    let state = HostState::new(TOKEN.into(), "host-test".into(), "Máquina QA".into(), "qa".into());
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(serve(listener, Arc::clone(&state)));
    (port, state, server)
}

async fn connect(port: u16) -> Socket {
    connect_async(format!("ws://127.0.0.1:{port}/rpc")).await.unwrap().0
}

fn hello(token: &str, major: u32) -> Value {
    json!({ "jsonrpc": "2.0", "id": 1, "method": "host.hello", "params": {
        "protocol": { "major": major, "minor": PROTOCOL_MINOR + 4 },
        "client": { "kind": "desktop", "version": "test" }, "token": token } })
}

async fn call(socket: &mut Socket, message: Value) -> Value {
    socket.send(Message::Text(message.to_string().into())).await.unwrap();
    loop {
        match tokio::time::timeout(Duration::from_secs(5), socket.next()).await.unwrap() {
            Some(Ok(Message::Text(text))) => return serde_json::from_str(&text).unwrap(),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            other => panic!("unexpected frame: {other:?}"),
        }
    }
}

#[tokio::test]
async fn hello_then_ping_with_the_local_owner_token() {
    let (port, _state, _server) = start().await;
    let mut socket = connect(port).await;
    let reply = call(&mut socket, hello(TOKEN, PROTOCOL_MAJOR)).await;
    let result = &reply["result"];
    assert_eq!(reply["id"], 1);
    assert_eq!(result["hostId"], "host-test");
    assert_eq!(result["hostName"], "Máquina QA");
    assert_eq!(result["protocol"], json!({ "major": PROTOCOL_MAJOR, "minor": PROTOCOL_MINOR }));
    assert_eq!(result["user"]["role"], "owner");
    assert!(result["capabilities"].as_array().unwrap().contains(&json!("host@1")));

    let pong = call(&mut socket, json!({ "jsonrpc": "2.0", "id": 2, "method": "host.ping" })).await;
    assert_eq!(pong["result"]["pong"], true);
    assert!(pong["result"]["at"].as_u64().unwrap() > 0);

    // A domain no host registers (real ones, like `fs`, answer their own errors).
    let unknown = call(&mut socket, json!({ "jsonrpc": "2.0", "id": "x", "method": "nope.readDir" })).await;
    assert_eq!(unknown["id"], "x");
    assert_eq!(unknown["error"]["code"], -32601);
    assert_eq!(unknown["error"]["data"]["code"], "method_not_found");

    let again = call(&mut socket, hello(TOKEN, PROTOCOL_MAJOR)).await;
    assert_eq!(again["error"]["data"]["code"], "invalid");
}

#[tokio::test]
async fn wrong_token_and_wrong_major_are_refused() {
    let (port, _state, _server) = start().await;
    let mut socket = connect(port).await;
    let reply = call(&mut socket, hello("nope", PROTOCOL_MAJOR)).await;
    assert_eq!(reply["error"]["data"]["code"], "unauthorized");

    let mut socket = connect(port).await;
    let reply = call(&mut socket, hello(TOKEN, PROTOCOL_MAJOR + 1)).await;
    assert_eq!(reply["error"]["data"]["code"], "version_mismatch");
    assert!(reply["error"]["message"].as_str().unwrap().contains("Atualize"));

    let mut socket = connect(port).await;
    let reply = call(&mut socket, json!({ "jsonrpc": "2.0", "id": 9, "method": "host.ping" })).await;
    assert_eq!(reply["error"]["data"]["code"], "invalid", "anything before hello is refused");
}

#[tokio::test]
async fn foreign_web_origins_cannot_open_the_socket() {
    let (port, _state, _server) = start().await;
    let mut request = format!("ws://127.0.0.1:{port}/rpc").into_client_request().unwrap();
    request.headers_mut().insert("Origin", "https://evil.example".parse().unwrap());
    assert!(connect_async(request).await.is_err());

    let mut request = format!("ws://127.0.0.1:{port}/rpc").into_client_request().unwrap();
    request.headers_mut().insert("Origin", "http://localhost:5173".parse().unwrap());
    assert!(connect_async(request).await.is_ok());
}

#[tokio::test]
async fn owner_shutdown_stops_the_server_and_closes_clients() {
    let (port, state, server) = start().await;
    let mut watcher = connect(port).await;
    call(&mut watcher, hello(TOKEN, PROTOCOL_MAJOR)).await;
    let mut owner = connect(port).await;
    call(&mut owner, hello(TOKEN, PROTOCOL_MAJOR)).await;
    assert_eq!(state.activity.clients(), 2);

    let reply = call(&mut owner, json!({ "jsonrpc": "2.0", "id": 3, "method": "host.shutdown" })).await;
    assert_eq!(reply["result"]["ok"], true);
    tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap().unwrap();
    assert!(state.shutdown.is_triggered());
    // The other client was told the host is going away.
    let frame = tokio::time::timeout(Duration::from_secs(5), watcher.next()).await.unwrap();
    assert!(matches!(frame, Some(Ok(Message::Close(_))) | None | Some(Err(_))));
}

#[tokio::test]
async fn idle_host_stops_only_after_the_last_client_leaves() {
    let (port, state, server) = start().await;
    let mut socket = connect(port).await;
    call(&mut socket, hello(TOKEN, PROTOCOL_MAJOR)).await;
    spawn_idle_watcher(Arc::clone(&state), Duration::from_millis(400));
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(!state.shutdown.is_triggered(), "a connected client keeps the host up");

    let hold = state.activity.hold();
    socket.close(None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(!state.shutdown.is_triggered(), "a hold keeps the host up without clients");

    drop(hold);
    tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap().unwrap();
    assert!(state.shutdown.is_triggered());
}
