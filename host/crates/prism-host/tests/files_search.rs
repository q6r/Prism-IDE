//! T03 domains over the real socket: capabilities, search notifications by
//! request id (superseded and cancelled searches stay quiet) and the
//! `/files` byte transfer with its token.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use prism_host::domain::Domain;
use prism_host::domains::{commands, fs, git, search, sessions, workspace};
use prism_host::{serve, HostState};
use prism_protocol::PROTOCOL_MAJOR;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const TOKEN: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

fn no_trash(_: &Path) -> Result<(), String> {
    Err("lixeira desligada no teste".into())
}

async fn start(home: &Path) -> u16 {
    let domains: Vec<Arc<dyn Domain>> = vec![
        Arc::new(fs::FsDomain::with_trash(no_trash)),
        Arc::new(search::SearchDomain::new()),
        Arc::new(git::GitDomain::with_trash(no_trash)),
        Arc::new(workspace::WorkspaceDomain),
        Arc::new(sessions::SessionsDomain::with_home(home.to_path_buf())),
        Arc::new(commands::CommandsDomain::with_home(home.to_path_buf())),
    ];
    let state = HostState::with_domains(TOKEN.into(), "h".into(), "Máquina".into(), "qa".into(), domains);
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(serve(listener, state));
    port
}

async fn connected(port: u16) -> (Socket, Value) {
    let mut socket = connect_async(format!("ws://127.0.0.1:{port}/rpc")).await.unwrap().0;
    send(&mut socket, json!({ "jsonrpc": "2.0", "id": 1, "method": "host.hello", "params": {
        "protocol": { "major": PROTOCOL_MAJOR, "minor": 0 }, "client": { "kind": "desktop", "version": "t" }, "token": TOKEN } })).await;
    let hello = next(&mut socket).await;
    (socket, hello)
}

async fn send(socket: &mut Socket, message: Value) {
    socket.send(Message::Text(message.to_string().into())).await.unwrap();
}

async fn next(socket: &mut Socket) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(10), socket.next()).await.unwrap() {
            Some(Ok(Message::Text(text))) => return serde_json::from_str(&text).unwrap(),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            other => panic!("unexpected frame: {other:?}"),
        }
    }
}

async fn call(socket: &mut Socket, id: u64, method: &str, params: Value) -> Value {
    send(socket, json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await;
    loop {
        let message = next(socket).await;
        if message["id"] == json!(id) {
            return message;
        }
    }
}

/// Collects `search.*` notifications until the `search.done` of `id` (an
/// older search may have finished before it was superseded).
async fn search_until_done(socket: &mut Socket, id: u64) -> (Vec<Value>, Value) {
    let mut results = Vec::new();
    loop {
        let message = next(socket).await;
        match message["method"].as_str() {
            Some("search.result") => results.push(message["params"].clone()),
            Some("search.done") if message["params"]["id"] == json!(id) => return (results, message["params"].clone()),
            _ => {}
        }
    }
}

#[tokio::test]
async fn the_t03_domains_are_advertised_and_answer() {
    let home = tempfile::tempdir().unwrap();
    let port = start(home.path()).await;
    let (mut socket, hello) = connected(port).await;
    let caps = hello["result"]["capabilities"].as_array().unwrap();
    for domain in ["fs@1", "search@1", "git@1", "workspace@1", "sessions@1", "commands@1"] {
        assert!(caps.contains(&json!(domain)), "{domain}");
    }
    let root = home.path().to_string_lossy().into_owned();
    std::fs::write(home.path().join("a.txt"), "olá").unwrap();
    let read = call(&mut socket, 2, "fs.readFile", json!({ "path": format!("{root}/a.txt") })).await;
    assert_eq!(read["result"], "olá");
    let missing = call(&mut socket, 3, "fs.readFile", json!({ "path": format!("{root}/nada.txt") })).await;
    assert_eq!(missing["error"]["data"]["code"], "not_found");
    assert_eq!(missing["error"]["message"], "Arquivo não encontrado: nada.txt");
    let invalid = call(&mut socket, 4, "fs.readDir", json!({})).await;
    assert_eq!(invalid["error"]["data"]["code"], "invalid");
    let outside = call(&mut socket, 5, "git.status", json!({ "dir": root })).await;
    assert_eq!(outside["result"], json!({ "isRepo": false }));
    let sessions = call(&mut socket, 6, "sessions.list", Value::Null).await;
    assert_eq!(sessions["result"], json!([]));
    let commands = call(&mut socket, 7, "commands.list", json!({})).await;
    assert_eq!(commands["result"], json!([]));
    let unknown = call(&mut socket, 8, "fs.nope", json!({})).await;
    assert_eq!(unknown["error"]["data"]["code"], "method_not_found");
    let trash = call(&mut socket, 9, "fs.trash", json!({ "path": format!("{root}/a.txt") })).await;
    assert!(trash["error"]["message"].as_str().unwrap().contains("lixeira desligada"));
}

#[tokio::test]
async fn searches_stream_by_id_and_only_the_newest_one_runs() {
    let home = tempfile::tempdir().unwrap();
    for i in 0..40 {
        std::fs::write(home.path().join(format!("f{i:02}.txt")), "agulha no palheiro\n".repeat(50)).unwrap();
    }
    let port = start(home.path()).await;
    let (mut socket, _) = connected(port).await;
    let root = home.path().to_string_lossy().into_owned();

    let ack = call(&mut socket, 2, "search.run", json!({ "id": 11, "root": root, "query": "AGULHA", "caseSensitive": false })).await;
    assert_eq!(ack["result"], json!({ "ok": true }));
    let (results, done) = search_until_done(&mut socket, 11).await;
    assert_eq!(done, json!({ "id": 11, "files": 40, "matches": 2000, "truncated": false }));
    assert_eq!(results.len(), 40);
    assert!(results.iter().all(|r| r["id"] == 11 && r["matches"][0] == json!({ "line": 1, "col": 1, "preview": "agulha no palheiro" })));

    // A newer run supersedes the older one: only id 13 finishes.
    send(&mut socket, json!({ "jsonrpc": "2.0", "id": 3, "method": "search.run", "params": { "id": 12, "root": root, "query": "palheiro" } })).await;
    send(&mut socket, json!({ "jsonrpc": "2.0", "id": 4, "method": "search.run", "params": { "id": 13, "root": root, "query": "palheiro" } })).await;
    let (results, done) = search_until_done(&mut socket, 13).await;
    assert_eq!(done["id"], 13);
    assert!(results.iter().all(|r| r["id"] == 12 || r["id"] == 13));
    assert_eq!(results.iter().filter(|r| r["id"] == 13).count(), 40);

    // A cancelled search ends quietly; the next one still answers.
    send(&mut socket, json!({ "jsonrpc": "2.0", "id": 5, "method": "search.run", "params": { "id": 14, "root": root, "query": "palheiro" } })).await;
    send(&mut socket, json!({ "jsonrpc": "2.0", "id": 6, "method": "search.cancel", "params": { "id": 14 } })).await;
    let short = call(&mut socket, 7, "search.run", json!({ "id": 15, "root": root, "query": "x" })).await;
    assert_eq!(short["result"]["ok"], true);
    let (_, done) = search_until_done(&mut socket, 15).await;
    assert_eq!(done, json!({ "id": 15, "files": 0, "matches": 0, "truncated": false }));

    let def = call(&mut socket, 8, "search.findDef", json!({ "root": root, "word": "agulha" })).await;
    assert_eq!(def["result"], json!({ "matches": [] }));
}

/// One raw HTTP/1.1 exchange (the test has no HTTP client crate).
async fn http(port: u16, method: &str, target: &str, token: Option<&str>, body: &[u8]) -> (u16, Vec<u8>) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let head = format!("{method} {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let mut body = raw[split + 4..].to_vec();
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        body = dechunk(&body);
    }
    (status, body)
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let line_end = data.windows(2).position(|w| w == b"\r\n").unwrap();
        let size = usize::from_str_radix(std::str::from_utf8(&data[..line_end]).unwrap().trim(), 16).unwrap();
        if size == 0 {
            return out;
        }
        out.extend_from_slice(&data[line_end + 2..line_end + 2 + size]);
        data = &data[line_end + 4 + size..];
    }
}

fn encode(path: &str) -> String {
    path.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

#[tokio::test]
async fn files_moves_bytes_with_the_token() {
    let home = tempfile::tempdir().unwrap();
    let port = start(home.path()).await;
    let file = home.path().join("img.bin").to_string_lossy().into_owned();
    let bytes: Vec<u8> = (0..=255u8).cycle().take(300_000).collect();

    // (Small bodies: a refused request is answered without reading the body.)
    let (status, _) = http(port, "PUT", &format!("/files?path={}", encode(&file)), None, b"x").await;
    assert_eq!(status, 401);
    let (status, _) = http(port, "GET", &format!("/files?path={}", encode(&file)), Some("errado"), b"").await;
    assert_eq!(status, 401);
    assert!(!Path::new(&file).exists());

    let (status, body) = http(port, "PUT", &format!("/files?path={}", encode(&file)), Some(TOKEN), &bytes).await;
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), json!({ "path": file }));
    let (status, body) = http(port, "GET", &format!("/files?path={}", encode(&file)), Some(TOKEN), b"").await;
    assert_eq!((status, body.len()), (200, bytes.len()));
    assert_eq!(body, bytes);

    let (status, body) = http(port, "PUT", "/files?temp=png", Some(TOKEN), b"\x89PNG").await;
    assert_eq!(status, 200);
    let temp = serde_json::from_slice::<Value>(&body).unwrap()["path"].as_str().unwrap().to_string();
    assert!(temp.ends_with(".png") && temp.contains("prism-img-"));
    assert_eq!(std::fs::read(&temp).unwrap(), b"\x89PNG");
    std::fs::remove_file(&temp).unwrap();

    let missing = home.path().join("nada").to_string_lossy().into_owned();
    let (status, body) = http(port, "GET", &format!("/files?path={}", encode(&missing)), Some(TOKEN), b"").await;
    assert_eq!(status, 404);
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["code"], "not_found");
    let (status, _) = http(port, "GET", &format!("/files?path={}", encode(&home.path().to_string_lossy())), Some(TOKEN), b"").await;
    assert_eq!(status, 400, "a folder is not a file");
    let (status, _) = http(port, "PUT", "/files?temp=..%2Fx", Some(TOKEN), b"x").await;
    assert_eq!(status, 400);
    let (status, _) = http(port, "DELETE", &format!("/files?path={}", encode(&file)), Some(TOKEN), b"").await;
    assert_eq!(status, 400);
}
