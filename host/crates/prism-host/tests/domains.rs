//! A domain plugs in through `Domain` alone: advertised as a capability,
//! called on its own task, able to notify its caller, told about disconnects.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use prism_host::domain::{params, CallContext, ClientId, Domain, HandlerFuture};
use prism_host::{serve, HostState};
use prism_protocol::{ErrorCode, HostError, PROTOCOL_MAJOR};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[derive(Default)]
struct Echo {
    disconnects: AtomicUsize,
}

#[derive(Deserialize)]
struct Say {
    text: String,
}

impl Domain for Echo {
    fn name(&self) -> &'static str {
        "echo"
    }

    fn major(&self) -> u32 {
        2
    }

    fn call(&self, method: &str, value: Value, ctx: CallContext) -> Option<HandlerFuture> {
        match method {
            "say" => Some(Box::pin(async move {
                let say: Say = params(value)?;
                Ok(json!({ "text": say.text, "by": ctx.user.name }))
            })),
            "slow" => Some(Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(400)).await;
                Ok(json!("slow"))
            })),
            "notify" => Some(Box::pin(async move {
                ctx.notifier.send("echo.event", json!({ "n": 1 }));
                Ok(json!(true))
            })),
            "fail" => Some(Box::pin(async move { Err(HostError::new(ErrorCode::Busy, "Ocupado.")) })),
            _ => None,
        }
    }

    fn disconnected(&self, _client: ClientId) {
        self.disconnects.fetch_add(1, Ordering::SeqCst);
    }
}

async fn start(echo: Arc<Echo>) -> u16 {
    let state = HostState::with_domains(TOKEN.into(), "h".into(), "Máquina".into(), "qa".into(), vec![echo]);
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(serve(listener, state));
    port
}

async fn send(socket: &mut Socket, message: Value) {
    socket.send(Message::Text(message.to_string().into())).await.unwrap();
}

async fn next(socket: &mut Socket) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), socket.next()).await.unwrap() {
            Some(Ok(Message::Text(text))) => return serde_json::from_str(&text).unwrap(),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            other => panic!("unexpected frame: {other:?}"),
        }
    }
}

async fn connected(port: u16) -> (Socket, Value) {
    let mut socket = connect_async(format!("ws://127.0.0.1:{port}/rpc")).await.unwrap().0;
    send(&mut socket, json!({ "jsonrpc": "2.0", "id": 1, "method": "host.hello", "params": {
        "protocol": { "major": PROTOCOL_MAJOR, "minor": 0 }, "client": { "kind": "web", "version": "t" }, "token": TOKEN } })).await;
    let hello = next(&mut socket).await;
    (socket, hello)
}

#[tokio::test]
async fn a_registered_domain_is_advertised_and_called() {
    let echo = Arc::new(Echo::default());
    let port = start(Arc::clone(&echo)).await;
    let (mut socket, hello) = connected(port).await;
    assert_eq!(hello["result"]["capabilities"], json!(["host@1", "echo@2"]));

    send(&mut socket, json!({ "jsonrpc": "2.0", "id": 2, "method": "echo.say", "params": { "text": "oi" } })).await;
    assert_eq!(next(&mut socket).await["result"], json!({ "text": "oi", "by": "qa" }));

    send(&mut socket, json!({ "jsonrpc": "2.0", "id": 3, "method": "echo.say", "params": { "nope": 1 } })).await;
    assert_eq!(next(&mut socket).await["error"]["data"]["code"], "invalid");

    send(&mut socket, json!({ "jsonrpc": "2.0", "id": 4, "method": "echo.fail" })).await;
    assert_eq!(next(&mut socket).await["error"]["data"]["code"], "busy");

    send(&mut socket, json!({ "jsonrpc": "2.0", "id": 5, "method": "echo.missing" })).await;
    assert_eq!(next(&mut socket).await["error"]["data"]["code"], "method_not_found");
}

#[tokio::test]
async fn slow_calls_do_not_block_fast_ones_and_notifications_arrive() {
    let echo = Arc::new(Echo::default());
    let port = start(Arc::clone(&echo)).await;
    let (mut socket, _) = connected(port).await;

    send(&mut socket, json!({ "jsonrpc": "2.0", "id": 10, "method": "echo.slow" })).await;
    send(&mut socket, json!({ "jsonrpc": "2.0", "id": 11, "method": "echo.notify" })).await;
    let mut seen = vec![];
    for _ in 0..3 {
        seen.push(next(&mut socket).await);
    }
    assert_eq!(seen[0]["method"], "echo.event", "the notification goes out before the slow reply");
    assert_eq!(seen[0]["params"], json!({ "n": 1 }));
    assert_eq!(seen[1]["id"], 11);
    assert_eq!(seen[2]["id"], 10);
    assert_eq!(seen[2]["result"], "slow");
}

#[tokio::test]
async fn domains_hear_about_disconnects() {
    let echo = Arc::new(Echo::default());
    let port = start(Arc::clone(&echo)).await;
    let (mut socket, _) = connected(port).await;
    socket.close(None).await.unwrap();
    for _ in 0..50 {
        if echo.disconnects.load(Ordering::SeqCst) == 1 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("disconnected() was not called");
}
