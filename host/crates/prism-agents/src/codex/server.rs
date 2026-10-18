//! The JSON-RPC client of `codex app-server --listen stdio://`, the host's
//! port of src/main/codexServer.ts: one JSON message per line, `initialize`
//! then `initialized`, 30 s per request, and the whole process tree killed on
//! close.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use prism_proc::ProcessTree;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::{Notify, mpsc, oneshot, watch};

use crate::profile_env::{ProfileEnv, ProviderCommand};

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const STDERR_TAIL: usize = 4000;

/// What the server sends besides responses, in order. `Closed` is last.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// A notification, or a request from the server (it has an `id`).
    Message(Value),
    /// The process ended: the failure that closed it, else its stderr, else a generic text.
    Closed(String),
}

type Reply = oneshot::Sender<Result<Value, String>>;

pub struct AppServer {
    shared: Arc<Shared>,
    incoming: Mutex<Option<mpsc::UnboundedReceiver<Incoming>>>,
    ready: watch::Receiver<Option<Result<(), String>>>,
}

struct Shared {
    out: mpsc::UnboundedSender<String>,
    stop_writing: Notify,
    pending: Mutex<HashMap<u64, Reply>>,
    serial: AtomicU64,
    /// Set once: why the client stopped (`close`, a write error, the process exiting).
    failure: Mutex<Option<String>>,
    tree: Mutex<Option<ProcessTree>>,
    stderr: Mutex<String>,
}

impl Shared {
    fn closed(&self) -> bool {
        self.failure.lock().unwrap().is_some()
    }

    /// Stops the client: later writes are dropped and every pending request fails.
    fn fail(&self, error: &str) {
        {
            let mut failure = self.failure.lock().unwrap();
            if failure.is_some() {
                return;
            }
            *failure = Some(error.to_string());
        }
        for (_, reply) in self.pending.lock().unwrap().drain() {
            let _ = reply.send(Err(error.to_string()));
        }
    }

    fn write(&self, message: &Value) {
        if !self.closed() {
            let _ = self.out.send(message.to_string());
        }
    }
}

impl AppServer {
    /// Starts `<cli> app-server --listen stdio://` in its own process tree. A
    /// non-terminal profile keeps its login in its own folder's file store.
    pub fn spawn(command: &ProviderCommand, env: &ProfileEnv, ambient: bool, cwd: Option<&Path>) -> std::io::Result<Arc<Self>> {
        let tree = ProcessTree::new()?;
        let mut cmd = command.to_command();
        cmd.args(["app-server", "--listen", "stdio://"]);
        // Questions must remain available while implementing, not just in Plan mode.
        cmd.args(["-c", "features.default_mode_request_user_input=true", "-c", "tools.experimental_request_user_input.enabled=true"]);
        if !ambient {
            cmd.args(["-c", "cli_auth_credentials_store=\"file\""]);
        }
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        env.apply(&mut cmd);
        cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
        let mut child = tree.spawn(&mut cmd)?;
        let (stdin, stdout, stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
        let (Some(stdin), Some(stdout)) = (stdin, stdout) else {
            return Err(std::io::Error::other("Codex App Server sem stdio."));
        };
        Ok(Self::start(stdout, stdin, stderr, Some(child), Some(tree)))
    }

    /// A client over any byte streams (tests drive a fake server this way).
    pub fn from_io<R, W>(reader: R, writer: W) -> Arc<Self>
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        Self::start(reader, writer, None::<tokio::io::Empty>, None, None)
    }

    fn start<R, W, E>(reader: R, writer: W, stderr: Option<E>, child: Option<Child>, tree: Option<ProcessTree>) -> Arc<Self>
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
        E: AsyncRead + Send + Unpin + 'static,
    {
        let (out, lines) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared {
            out,
            stop_writing: Notify::new(),
            pending: Mutex::new(HashMap::new()),
            serial: AtomicU64::new(0),
            failure: Mutex::new(None),
            tree: Mutex::new(tree),
            stderr: Mutex::new(String::new()),
        });
        let (incoming_tx, incoming_rx) = mpsc::unbounded_channel();
        tokio::spawn(write_loop(Arc::clone(&shared), lines, writer));
        let stderr_task = stderr.map(|stderr| tokio::spawn(stderr_loop(Arc::clone(&shared), stderr)));
        tokio::spawn(read_loop(Arc::clone(&shared), reader, incoming_tx, child, stderr_task));

        let (ready_tx, ready) = watch::channel(None);
        let server = Arc::new(Self { shared, incoming: Mutex::new(Some(incoming_rx)), ready });
        let init = Arc::clone(&server);
        tokio::spawn(async move {
            let params = json!({ "clientInfo": { "name": "prism", "version": "1.0.0" }, "capabilities": { "experimentalApi": true } });
            let result = init.request("initialize", params).await.map(|_| init.notify("initialized", json!({})));
            let _ = ready_tx.send(Some(result));
        });
        server
    }

    /// Resolves once `initialize` was answered (or failed).
    pub async fn ready(&self) -> Result<(), String> {
        let mut ready = self.ready.clone();
        match ready.wait_for(Option::is_some).await {
            Ok(result) => result.clone().unwrap_or(Ok(())),
            Err(_) => Err("Codex App Server desconectado.".to_string()),
        }
    }

    /// Notifications and server requests, once; `None` when already taken.
    pub fn take_incoming(&self) -> Option<mpsc::UnboundedReceiver<Incoming>> {
        self.incoming.lock().unwrap().take()
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT).await
    }

    pub async fn request_with_timeout(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.shared.serial.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        {
            // Checked under the pending lock: `fail` drains after setting the failure.
            let mut pending = self.shared.pending.lock().unwrap();
            if self.shared.closed() {
                return Err("Codex App Server fechado.".to_string());
            }
            pending.insert(id, tx);
        }
        self.shared.write(&json!({ "id": id, "method": method, "params": params }));
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(self.shared.failure.lock().unwrap().clone().unwrap_or_else(|| "Codex App Server fechado.".to_string())),
            Err(_) => {
                self.shared.pending.lock().unwrap().remove(&id);
                Err(format!("Tempo esgotado: {method}"))
            }
        }
    }

    pub fn notify(&self, method: &str, params: Value) {
        self.shared.write(&json!({ "method": method, "params": params }));
    }

    /// Answers a request the server made.
    pub fn answer(&self, id: &Value, result: Value) {
        self.shared.write(&json!({ "id": id, "result": result }));
    }

    /// Refuses a request the server made that Prism does not handle.
    pub fn reject(&self, id: &Value) {
        self.shared.write(&json!({ "id": id, "error": { "code": -32601, "message": "Operação não suportada pelo Prism." } }));
    }

    pub fn is_closed(&self) -> bool {
        self.shared.closed()
    }

    /// Fails what is pending and kills the process tree. `Closed` follows once
    /// the process is gone.
    pub fn close(&self) {
        self.shared.fail("Codex App Server encerrado.");
        self.shared.stop_writing.notify_one();
        if let Some(tree) = self.shared.tree.lock().unwrap().as_ref() {
            let _ = tree.kill();
        }
    }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        self.close();
    }
}

async fn write_loop<W: AsyncWrite + Unpin>(shared: Arc<Shared>, mut lines: mpsc::UnboundedReceiver<String>, mut writer: W) {
    loop {
        tokio::select! {
            line = lines.recv() => {
                let Some(line) = line else { break };
                let written = async {
                    writer.write_all(line.as_bytes()).await?;
                    writer.write_all(b"\n").await?;
                    writer.flush().await
                };
                if let Err(err) = written.await {
                    shared.fail(&err.to_string());
                    break;
                }
            }
            _ = shared.stop_writing.notified() => break,
        }
    }
    let _ = writer.shutdown().await;
}

async fn stderr_loop<E: AsyncRead + Unpin>(shared: Arc<Shared>, mut stderr: E) {
    let mut chunk = [0u8; 4096];
    let mut carry = Vec::new();
    while let Ok(n) = stderr.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        carry.extend_from_slice(&chunk[..n]);
        // Keep an incomplete UTF-8 sequence for the next chunk.
        let valid = match std::str::from_utf8(&carry) {
            Ok(_) => carry.len(),
            Err(err) if err.error_len().is_none() => err.valid_up_to(),
            Err(_) => carry.len(),
        };
        let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
        carry.drain(..valid);
        let mut tail = shared.stderr.lock().unwrap();
        tail.push_str(&text);
        if tail.len() > STDERR_TAIL {
            let mut cut = tail.len() - STDERR_TAIL;
            while !tail.is_char_boundary(cut) {
                cut += 1;
            }
            tail.drain(..cut);
        }
    }
}

async fn read_loop<R: AsyncRead + Unpin>(
    shared: Arc<Shared>,
    reader: R,
    incoming: mpsc::UnboundedSender<Incoming>,
    child: Option<Child>,
    stderr_task: Option<tokio::task::JoinHandle<()>>,
) {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => handle_line(&shared, &incoming, &line),
        }
    }
    if let Some(mut child) = child {
        let _ = child.wait().await;
    }
    if let Some(task) = stderr_task {
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    }
    let stderr = shared.stderr.lock().unwrap().trim().to_string();
    let error = shared.failure.lock().unwrap().clone().unwrap_or(if stderr.is_empty() { "Codex App Server desconectado.".to_string() } else { stderr });
    shared.fail(&error);
    let _ = incoming.send(Incoming::Closed(error));
}

fn handle_line(shared: &Shared, incoming: &mpsc::UnboundedSender<Incoming>, raw: &[u8]) {
    let text = String::from_utf8_lossy(raw);
    if text.trim().is_empty() {
        return;
    }
    let Ok(message) = serde_json::from_str::<Value>(&text) else { return };
    let is_response = message.get("method").is_none_or(|m| !js_truthy(m)) && message.get("id").is_some();
    if !is_response {
        let _ = incoming.send(Incoming::Message(message));
        return;
    }
    let Some(id) = message.get("id").and_then(Value::as_u64) else { return };
    let Some(reply) = shared.pending.lock().unwrap().remove(&id) else { return };
    let result = match message.get("error") {
        Some(error) if js_truthy(error) => Err(error
            .get("message")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
            .unwrap_or("Falha no Codex App Server.")
            .to_string()),
        _ => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
    };
    let _ = reply.send(result);
}

pub(crate) fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
