//! `terminal.*` (T04): interactive shells on real PTYs (ConPTY on Windows),
//! owned by the host so they outlive the window.
//!
//! - Ids come from the UI, one per attempt. Only the terminal that currently
//!   owns an id reports its exit, and a killed one goes quiet at once, so a
//!   replacement under the same id never sees the old one's output or exit.
//! - Output is decoded to UTF-8, batched over ~16 ms to the subscribed
//!   clients and kept in a ~2 MB ring; `attach { since }` replays from it.
//! - Each shell is adopted into its own `ProcessTree`: killing the terminal
//!   (or the shell exiting) takes everything it started along.
//! - While the shell has children (something runs in the foreground), the
//!   terminal holds the host alive.

pub(crate) mod scrollback;

pub use scrollback::{Scrollback, Utf8Stream};

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use prism_proc::ProcessTree;
use prism_protocol::terminal::{
    methods, TerminalAttachParams, TerminalAttached, TerminalCreateParams, TerminalCreated, TerminalData, TerminalExit,
    TerminalIdParams, TerminalInfo, TerminalInputParams, TerminalResizeParams, TerminalSetCwdParams,
};
use prism_protocol::{ErrorCode, HostError, OkResult};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::activity::{Activity, ActivityGuard};
use crate::domain::{params, CallContext, ClientId, Domain, HandlerFuture, Notifier};

/// Output kept per terminal for replays.
pub const SCROLLBACK_BYTES: usize = 2 * 1024 * 1024;
/// Output is pushed at most this often per terminal.
const BATCH: Duration = Duration::from_millis(16);
/// Upper bound of one `terminal.data` notification.
const MAX_BATCH: usize = 256 * 1024;
/// How often a terminal checks whether something runs in it.
const BUSY_POLL: Duration = Duration::from_secs(2);
/// How long an exited shell's last output may take to arrive.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// The program a terminal runs.
#[derive(Debug, Clone)]
pub struct Shell {
    pub program: String,
    pub args: Vec<String>,
}

impl Shell {
    /// What the Electron terminal ran: PowerShell on Windows, `$SHELL` (or
    /// bash) elsewhere.
    pub fn platform_default() -> Self {
        #[cfg(windows)]
        let program = "powershell.exe".to_string();
        #[cfg(not(windows))]
        let program = std::env::var("SHELL").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "/bin/bash".into());
        Self { program, args: Vec::new() }
    }
}

#[derive(Debug, Clone)]
pub struct Options {
    pub shell: Shell,
    pub scrollback: usize,
    pub busy_poll: Duration,
    pub default_cwd: PathBuf,
}

impl Default for Options {
    fn default() -> Self {
        Self { shell: Shell::platform_default(), scrollback: SCROLLBACK_BYTES, busy_poll: BUSY_POLL, default_cwd: home_dir() }
    }
}

fn home_dir() -> PathBuf {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

pub struct TerminalDomain {
    registry: Arc<Registry>,
}

impl TerminalDomain {
    pub fn new() -> Self {
        Self::with_options(Options::default())
    }

    pub fn with_options(options: Options) -> Self {
        let default_cwd = Mutex::new(options.default_cwd.clone());
        Self { registry: Arc::new(Registry { options, terms: Mutex::new(HashMap::new()), default_cwd, next_gen: AtomicU64::new(1) }) }
    }
}

impl Default for TerminalDomain {
    fn default() -> Self {
        Self::new()
    }
}

impl Domain for TerminalDomain {
    fn name(&self) -> &'static str {
        "terminal"
    }

    fn call(&self, method: &str, value: Value, ctx: CallContext) -> Option<HandlerFuture> {
        let registry = &self.registry;
        // Everything whose order matters (keystrokes, resizes, kills,
        // subscribing) happens right here, in the socket's message order;
        // calls run on their own tasks, so doing it in the future would let
        // two keystrokes swap. Only spawning the shell is deferred.
        let result = match method {
            methods::CREATE => {
                return Some(match params::<TerminalCreateParams>(value) {
                    Ok(p) => registry.create(p, ctx),
                    Err(err) => Box::pin(async move { Err(err) }),
                });
            }
            methods::INPUT => params::<TerminalInputParams>(value).map(|p| ok(registry.input(&p.id, p.data))),
            methods::RESIZE => params::<TerminalResizeParams>(value).map(|p| ok(registry.resize(&p.id, p.cols, p.rows))),
            methods::KILL => params::<TerminalIdParams>(value).map(|p| ok(registry.kill(&p.id))),
            methods::ATTACH => params::<TerminalAttachParams>(value).and_then(|p| registry.attach(&p, &ctx.notifier)),
            methods::LIST => Ok(json!(registry.list())),
            methods::INIT => Ok(json!(registry.default_cwd())),
            methods::SET_CWD => params::<TerminalSetCwdParams>(value).map(|p| json!(registry.set_cwd(&p.cwd))),
            _ => return None,
        };
        Some(Box::pin(async move { result }))
    }

    fn disconnected(&self, client: ClientId) {
        // The terminals stay; only this client stops receiving their output.
        for term in self.registry.all() {
            term.out.lock().unwrap().subscribers.retain(|n| n.client != client);
        }
    }
}

fn ok(found: bool) -> Value {
    json!(OkResult { ok: found })
}

struct Registry {
    options: Options,
    terms: Mutex<HashMap<String, Arc<Term>>>,
    default_cwd: Mutex<PathBuf>,
    next_gen: AtomicU64,
}

impl Registry {
    fn get(&self, id: &str) -> Option<Arc<Term>> {
        self.terms.lock().unwrap().get(id).cloned()
    }

    fn all(&self) -> Vec<Arc<Term>> {
        self.terms.lock().unwrap().values().cloned().collect()
    }

    /// Removes `id` only while `generation` still owns it.
    fn remove_if_current(&self, id: &str, generation: u64) -> bool {
        let mut terms = self.terms.lock().unwrap();
        if terms.get(id).is_some_and(|t| t.generation == generation) {
            terms.remove(id);
            true
        } else {
            false
        }
    }

    fn default_cwd(&self) -> String {
        self.default_cwd.lock().unwrap().display().to_string()
    }

    /// New terminals start here, and idle shells `cd` along. A shell running
    /// something is left alone: the `cd` would be typed into that program.
    fn set_cwd(&self, dir: &str) -> String {
        if !dir.is_empty() && Path::new(dir).is_dir() {
            *self.default_cwd.lock().unwrap() = PathBuf::from(dir);
            for term in self.all() {
                if !term.busy.load(Ordering::SeqCst) {
                    let _ = term.input.send(format!("cd \"{dir}\"\r").into_bytes());
                }
            }
        }
        self.default_cwd()
    }

    fn create(self: &Arc<Self>, p: TerminalCreateParams, ctx: CallContext) -> HandlerFuture {
        if let Some(term) = self.get(&p.id) {
            // Same pane, same attempt (a remount): rebind it, as the IPC did.
            let seq = term.subscribe(&ctx.notifier);
            if let (Some(cols), Some(rows)) = (p.cols, p.rows) {
                term.resize(cols, rows);
            }
            let created = TerminalCreated { id: p.id, created: false, seq };
            return Box::pin(async move { Ok(json!(created)) });
        }
        let cwd = p.cwd.map(PathBuf::from).filter(|dir| dir.is_dir()).unwrap_or_else(|| self.default_cwd.lock().unwrap().clone());
        let size = PtySize { cols: p.cols.filter(|&c| c > 0).unwrap_or(80), rows: p.rows.filter(|&r| r > 0).unwrap_or(24), pixel_width: 0, pixel_height: 0 };
        // Keystrokes sent before the shell is up wait in this queue, in order.
        let (input, queued) = std_mpsc::channel();
        let term = Arc::new(Term {
            id: p.id.clone(),
            generation: self.next_gen.fetch_add(1, Ordering::Relaxed),
            cwd,
            created_at: crate::now_ms(),
            input,
            out: Mutex::new(Output { ring: Scrollback::new(self.options.scrollback), subscribers: Vec::new(), closed: false }),
            pty: Mutex::new(Pty { size, pid: None, master: None, killer: None, tree: None, queued: Some(queued), killed: false }),
            busy: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            hold: Mutex::new(None),
        });
        term.subscribe(&ctx.notifier);
        self.terms.lock().unwrap().insert(p.id.clone(), Arc::clone(&term));
        let registry = Arc::clone(self);
        let activity = Arc::clone(&ctx.state.activity);
        Box::pin(async move {
            let shell = registry.options.shell.clone();
            let spawning = Arc::clone(&term);
            let spawned = tokio::task::spawn_blocking(move || spawn_shell(&shell, &spawning))
                .await
                .unwrap_or_else(|err| Err(format!("{err}")));
            match spawned {
                Ok(spawned) => {
                    registry.start(&term, spawned, activity)?;
                    tracing::info!(id = %term.id, cwd = %term.cwd.display(), "terminal criado");
                    Ok(json!(TerminalCreated { id: term.id.clone(), created: true, seq: 0 }))
                }
                Err(err) => {
                    tracing::warn!(id = %term.id, error = %err, "terminal não iniciou");
                    registry.remove_if_current(&term.id, term.generation);
                    term.close();
                    Err(HostError::new(ErrorCode::Internal, format!("Não foi possível iniciar o terminal: {err}")))
                }
            }
        })
    }

    /// Wires a freshly spawned shell to its terminal: writer, reader, output
    /// pump, exit and busy watchers.
    fn start(self: &Arc<Self>, term: &Arc<Term>, spawned: Spawned, activity: Arc<Activity>) -> Result<(), HostError> {
        let Spawned { master, mut child, reader, writer, pid, tree, size } = spawned;
        let queued = {
            let mut pty = term.pty.lock().unwrap();
            if pty.killed {
                // Killed while it was starting.
                drop(pty);
                if let Some(tree) = &tree {
                    let _ = tree.kill();
                }
                let _ = child.kill();
                tokio::task::spawn_blocking(move || {
                    let _ = child.wait();
                });
                return Err(HostError::new(ErrorCode::Gone, "O terminal foi encerrado."));
            }
            if pty.size != size {
                let _ = master.resize(pty.size);
            }
            pty.pid = pid;
            pty.killer = Some(child.clone_killer());
            pty.master = Some(master);
            pty.tree = tree;
            pty.queued.take()
        };
        if let Some(queued) = queued {
            spawn_writer(&term.id, queued, writer);
        }
        let (chunks, received) = mpsc::unbounded_channel();
        spawn_reader(&term.id, reader, chunks);
        let pump = tokio::spawn(pump(Arc::clone(term), received));
        tokio::spawn(watch_exit(Arc::clone(self), Arc::clone(term), child, pump));
        tokio::spawn(watch_busy(Arc::clone(term), activity, self.options.busy_poll));
        Ok(())
    }

    fn input(&self, id: &str, data: String) -> bool {
        self.get(id).is_some_and(|term| term.input.send(data.into_bytes()).is_ok())
    }

    fn resize(&self, id: &str, cols: u16, rows: u16) -> bool {
        let Some(term) = self.get(id) else { return false };
        term.resize(cols, rows);
        true
    }

    /// Releases the id first, so the dying shell reports nothing.
    fn kill(&self, id: &str) -> bool {
        let removed = self.terms.lock().unwrap().remove(id);
        match removed {
            Some(term) => {
                tracing::info!(id = %term.id, "terminal encerrado");
                term.terminate();
                true
            }
            None => false,
        }
    }

    fn attach(&self, p: &TerminalAttachParams, notifier: &Notifier) -> Result<Value, HostError> {
        let term = self.get(&p.id).ok_or_else(|| HostError::new(ErrorCode::NotFound, "Terminal não encontrado."))?;
        Ok(json!(term.attach(notifier, p.since)))
    }

    fn list(&self) -> Vec<TerminalInfo> {
        let mut infos: Vec<TerminalInfo> = self.all().iter().map(|term| term.info()).collect();
        infos.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
        infos
    }
}

struct Term {
    id: String,
    /// Distinguishes successive terminals created under the same id.
    generation: u64,
    cwd: PathBuf,
    created_at: u64,
    input: std_mpsc::Sender<Vec<u8>>,
    out: Mutex<Output>,
    pty: Mutex<Pty>,
    busy: AtomicBool,
    /// The shell is gone (or being killed): no more holds.
    ended: AtomicBool,
    hold: Mutex<Option<ActivityGuard>>,
}

struct Output {
    ring: Scrollback,
    subscribers: Vec<Notifier>,
    /// Killed or exited: nothing more goes out.
    closed: bool,
}

struct Pty {
    size: PtySize,
    pid: Option<u32>,
    master: Option<Box<dyn MasterPty + Send>>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    tree: Option<ProcessTree>,
    /// Input queued until the writer starts.
    queued: Option<std_mpsc::Receiver<Vec<u8>>>,
    killed: bool,
}

impl Term {
    /// Adds a client to the output; returns the offset it receives from.
    fn subscribe(&self, notifier: &Notifier) -> u64 {
        let mut out = self.out.lock().unwrap();
        add_subscriber(&mut out.subscribers, notifier);
        out.ring.end()
    }

    /// The replay and the subscription happen under one lock, so the client
    /// misses nothing and gets nothing twice: every later `terminal.data`
    /// starts exactly at the returned `seq`.
    fn attach(&self, notifier: &Notifier, since: Option<u64>) -> TerminalAttached {
        let mut out = self.out.lock().unwrap();
        let (data, truncated) = out.ring.since(since);
        let seq = out.ring.end();
        add_subscriber(&mut out.subscribers, notifier);
        TerminalAttached { id: self.id.clone(), data, seq, truncated }
    }

    fn publish(&self, text: String) {
        if text.is_empty() {
            return;
        }
        let mut out = self.out.lock().unwrap();
        if out.closed {
            return;
        }
        out.ring.push(&text);
        let note = json!(TerminalData { id: self.id.clone(), data: text, seq: out.ring.end() });
        out.subscribers.retain(|n| n.send(methods::DATA, note.clone()));
    }

    /// Stops all output; returns who was listening.
    fn close(&self) -> Vec<Notifier> {
        let mut out = self.out.lock().unwrap();
        out.closed = true;
        std::mem::take(&mut out.subscribers)
    }

    fn resize(&self, cols: u16, rows: u16) {
        if cols == 0 || rows == 0 {
            return;
        }
        let mut pty = self.pty.lock().unwrap();
        let size = PtySize { cols, rows, pixel_width: 0, pixel_height: 0 };
        if pty.size == size {
            return;
        }
        pty.size = size;
        if let Some(master) = &pty.master {
            let _ = master.resize(size);
        }
    }

    /// An explicit kill: silent, and takes the whole process tree.
    fn terminate(&self) {
        self.close();
        self.end();
        let mut pty = self.pty.lock().unwrap();
        pty.killed = true;
        if let Some(tree) = &pty.tree {
            let _ = tree.kill();
        }
        if let Some(killer) = pty.killer.as_mut() {
            let _ = killer.kill();
        }
    }

    fn end(&self) {
        self.ended.store(true, Ordering::SeqCst);
        self.busy.store(false, Ordering::SeqCst);
        *self.hold.lock().unwrap() = None;
    }

    fn set_busy(&self, busy: bool, activity: &Arc<Activity>) {
        let mut hold = self.hold.lock().unwrap();
        let busy = busy && !self.ended.load(Ordering::SeqCst);
        self.busy.store(busy, Ordering::SeqCst);
        if busy {
            hold.get_or_insert_with(|| activity.hold());
        } else {
            *hold = None;
        }
    }

    fn info(&self) -> TerminalInfo {
        let (attached, seq) = {
            let out = self.out.lock().unwrap();
            (out.subscribers.iter().filter(|n| !n.is_closed()).count() as u32, out.ring.end())
        };
        let (pid, size) = {
            let pty = self.pty.lock().unwrap();
            (pty.pid, pty.size)
        };
        TerminalInfo {
            id: self.id.clone(),
            pid,
            cwd: self.cwd.display().to_string(),
            cols: size.cols,
            rows: size.rows,
            created_at: self.created_at,
            attached,
            busy: self.busy.load(Ordering::SeqCst),
            seq,
        }
    }
}

fn add_subscriber(subscribers: &mut Vec<Notifier>, notifier: &Notifier) {
    subscribers.retain(|n| !n.is_closed());
    if !subscribers.iter().any(|n| n.client == notifier.client) {
        subscribers.push(notifier.clone());
    }
}

struct Spawned {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    pid: Option<u32>,
    tree: Option<ProcessTree>,
    size: PtySize,
}

/// Opens the PTY and starts the shell in it (blocking).
fn spawn_shell(shell: &Shell, term: &Term) -> Result<Spawned, String> {
    let size = term.pty.lock().unwrap().size;
    let pair = native_pty_system().openpty(size).map_err(|err| err.to_string())?;
    let mut command = CommandBuilder::new(&shell.program);
    command.args(&shell.args);
    command.cwd(&term.cwd);
    #[cfg(unix)]
    command.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(command).map_err(|err| format!("{}: {err}", shell.program))?;
    drop(pair.slave);
    let pid = child.process_id();
    // Whatever the shell starts from now on dies with the terminal.
    let tree = pid.and_then(|pid| match ProcessTree::new().and_then(|tree| tree.adopt(pid).map(|()| tree)) {
        Ok(tree) => Some(tree),
        Err(err) => {
            tracing::warn!(id = %term.id, pid, error = %err, "shell fora da árvore de processos");
            None
        }
    });
    let reader = pair.master.try_clone_reader().map_err(|err| err.to_string())?;
    let writer = pair.master.take_writer().map_err(|err| err.to_string())?;
    Ok(Spawned { master: pair.master, child, reader, writer, pid, tree, size })
}

fn spawn_writer(id: &str, queued: std_mpsc::Receiver<Vec<u8>>, mut writer: Box<dyn Write + Send>) {
    let spawned = std::thread::Builder::new().name(format!("pty-in {id}")).spawn(move || {
        // Ends when the terminal is dropped (its sender goes away) or the PTY closes.
        while let Ok(data) = queued.recv() {
            if writer.write_all(&data).and_then(|()| writer.flush()).is_err() {
                break;
            }
        }
    });
    if let Err(err) = spawned {
        tracing::error!(id, error = %err, "sem thread de entrada do terminal");
    }
}

fn spawn_reader(id: &str, mut reader: Box<dyn Read + Send>, chunks: mpsc::UnboundedSender<Vec<u8>>) {
    let spawned = std::thread::Builder::new().name(format!("pty-out {id}")).spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if chunks.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });
    if let Err(err) = spawned {
        tracing::error!(id, error = %err, "sem thread de saída do terminal");
    }
}

/// Decodes the PTY's bytes and publishes them, at most every `BATCH`, so a
/// lone keystroke echoes at once and a flood goes out in few messages.
async fn pump(term: Arc<Term>, mut chunks: mpsc::UnboundedReceiver<Vec<u8>>) {
    let mut decoder = Utf8Stream::default();
    let mut last = Instant::now().checked_sub(BATCH).unwrap_or_else(Instant::now);
    let mut startup = true;
    while let Some(chunk) = chunks.recv().await {
        let mut text = decoder.push(&chunk);
        if startup && !text.is_empty() {
            startup = false;
            answer_startup_cursor_query(&term, &mut text);
        }
        let wait = (last + BATCH).saturating_duration_since(Instant::now());
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        while text.len() < MAX_BATCH {
            match chunks.try_recv() {
                Ok(more) => text.push_str(&decoder.push(&more)),
                Err(_) => break,
            }
        }
        term.publish(text);
        last = Instant::now();
    }
    term.publish(decoder.finish());
}

/// portable-pty opens ConPTY with `PSEUDOCONSOLE_INHERIT_CURSOR`: conhost
/// starts by asking where the cursor is (`ESC[6n`) and shows nothing until
/// it hears back. The host answers "top-left" (what a fresh xterm would) and
/// keeps the question out of the output — otherwise every replay of the
/// scrollback would make the viewer answer again, typing into the shell.
fn answer_startup_cursor_query(term: &Term, text: &mut String) {
    const QUERY: &str = "\x1b[6n";
    if cfg!(windows)
        && let Some(at) = text.find(QUERY)
    {
        text.replace_range(at..at + QUERY.len(), "");
        let _ = term.input.send(b"\x1b[1;1R".to_vec());
    }
}

/// Waits for the shell to end, lets its last output through, then reports
/// the exit — only if this terminal still owns its id (a kill released it).
async fn watch_exit(registry: Arc<Registry>, term: Arc<Term>, mut child: Box<dyn Child + Send + Sync>, pump: JoinHandle<()>) {
    let code = tokio::task::spawn_blocking(move || child.wait().ok().map(|status| status.exit_code())).await.ok().flatten();
    term.end();
    // What the shell left running dies with it, and closing the PTY lets the
    // reader see the end (ConPTY keeps the pipe open until then).
    let (master, tree) = {
        let mut pty = term.pty.lock().unwrap();
        (pty.master.take(), pty.tree.take())
    };
    if let Some(tree) = &tree {
        let _ = tree.kill();
    }
    let _ = tokio::task::spawn_blocking(move || drop((master, tree))).await;
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, pump).await;
    if registry.remove_if_current(&term.id, term.generation) {
        tracing::info!(id = %term.id, ?code, "terminal terminou");
        let note = json!(TerminalExit { id: term.id.clone(), code });
        for subscriber in term.close() {
            subscriber.send(methods::EXIT, note.clone());
        }
    }
}

/// Holds the host alive while the shell has children.
async fn watch_busy(term: Arc<Term>, activity: Arc<Activity>, every: Duration) {
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    while !term.ended.load(Ordering::SeqCst) {
        tick.tick().await;
        let Some(pid) = term.pty.lock().unwrap().pid else { continue };
        let busy = tokio::task::spawn_blocking(move || !prism_proc::child_pids(pid).is_empty()).await.unwrap_or(false);
        term.set_busy(busy, &activity);
    }
    term.end();
}
