//! A profile's interactive login (`claude auth login --claudeai`, `codex
//! login --device-auth`) in a terminal on the host: one per profile, its
//! output streamed only to the client that started it, which alone can type
//! into it, resize or cancel it. Port of `providers:login` and its siblings
//! in src/main/ipc/providers.ts. A login ends with its client.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use prism_agents::profile_env::{ProfileEnv, ProviderCommand};
use prism_proc::ProcessTree;
use prism_protocol::providers::{methods, LoginEvent, LoginEventKind};
use serde_json::json;
use tokio::sync::watch;

use crate::domain::{ClientId, Notifier};
use crate::domains::terminal::scrollback::Utf8Stream;

/// The terminal size the renderer measured; anything implausible is 100×24.
pub fn terminal_size(cols: Option<u16>, rows: Option<u16>) -> (u16, u16) {
    let cols = cols.filter(|c| (20..=500).contains(c)).unwrap_or(100);
    let rows = rows.filter(|r| (5..=200).contains(r)).unwrap_or(24);
    (cols, rows)
}

/// A caller-chosen session id, when it is a safe token (`[\w-]{1,64}`).
pub fn session_id(value: Option<&str>) -> Option<String> {
    value
        .filter(|v| !v.is_empty() && v.len() <= 64 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .map(str::to_string)
}

/// What a login needs to start.
pub struct LoginRequest {
    pub profile_id: String,
    pub session: String,
    pub cols: u16,
    pub rows: u16,
    pub owner: ClientId,
    pub notifier: Notifier,
    pub command: ProviderCommand,
    /// After the CLI's own arguments (`auth login --claudeai`…).
    pub args: Vec<String>,
    pub env: ProfileEnv,
    pub cwd: PathBuf,
    /// Runs once the CLI exits (the login may have changed), inside `runtime`:
    /// what it ends may spawn tasks.
    pub on_exit: Box<dyn FnOnce() + Send>,
    pub runtime: tokio::runtime::Handle,
}

/// `start` while the profile's login is still open.
pub const ALREADY_OPEN: &str = "O login desta conta já está aberto.";

struct Login {
    session: String,
    owner: ClientId,
    input: std_mpsc::Sender<Vec<u8>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    tree: Mutex<Option<ProcessTree>>,
    exited: watch::Receiver<bool>,
}

impl Login {
    fn kill(&self) {
        if let Some(tree) = self.tree.lock().unwrap().as_ref() {
            let _ = tree.kill();
        }
        let _ = self.killer.lock().unwrap().kill();
    }
}

/// The logins running on this host, by profile.
#[derive(Default)]
pub struct Logins {
    by_profile: Mutex<HashMap<String, Arc<Login>>>,
}

impl Logins {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn is_open(&self, profile_id: &str) -> bool {
        self.by_profile.lock().unwrap().contains_key(profile_id)
    }

    fn owned(&self, profile_id: &str, owner: ClientId) -> Option<Arc<Login>> {
        self.by_profile.lock().unwrap().get(profile_id).filter(|l| l.owner == owner).cloned()
    }

    /// Opens the PTY and starts the CLI (blocking: call it off the runtime).
    /// Refused (`ALREADY_OPEN`) while the profile's login is open: a second
    /// login never replaces the first behind its client's back.
    pub fn start(self: &Arc<Self>, request: LoginRequest) -> Result<(), String> {
        let LoginRequest { profile_id, session, cols, rows, owner, notifier, command, args, env, cwd, on_exit, runtime } = request;
        if self.is_open(&profile_id) {
            return Err(ALREADY_OPEN.to_string());
        }
        let pair = native_pty_system().openpty(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 }).map_err(|err| err.to_string())?;
        let mut builder = CommandBuilder::new(&command.bin);
        builder.args(&command.args);
        builder.args(&args);
        builder.cwd(&cwd);
        for key in &env.remove {
            builder.env_remove(key);
        }
        for (key, value) in &env.set {
            builder.env(key, value);
        }
        builder.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(builder).map_err(|err| format!("{}: {err}", command.bin.display()))?;
        drop(pair.slave);
        // Whatever the CLI starts dies with the login.
        let tree = child.process_id().and_then(|pid| ProcessTree::new().and_then(|tree| tree.adopt(pid).map(|()| tree)).ok());
        let reader = pair.master.try_clone_reader().map_err(|err| err.to_string())?;
        let writer = pair.master.take_writer().map_err(|err| err.to_string())?;
        let (input, queued) = std_mpsc::channel::<Vec<u8>>();
        let (exited_tx, exited) = watch::channel(false);
        let login = Arc::new(Login {
            session: session.clone(),
            owner,
            input,
            master: Mutex::new(Some(pair.master)),
            killer: Mutex::new(child.clone_killer()),
            tree: Mutex::new(tree),
            exited,
        });
        {
            let mut all = self.by_profile.lock().unwrap();
            if all.contains_key(&profile_id) {
                drop(all);
                login.kill();
                let _ = child.wait();
                return Err(ALREADY_OPEN.to_string());
            }
            all.insert(profile_id.clone(), Arc::clone(&login));
        }

        let send = {
            let (notifier, profile_id, session) = (notifier.clone(), profile_id.clone(), session.clone());
            move |kind: LoginEventKind, text: Option<String>, code: Option<i32>| {
                let event = LoginEvent { profile_id: profile_id.clone(), session: session.clone(), kind, text, code };
                notifier.send(methods::LOGIN_EVENT, json!(event));
            }
        };
        spawn_writer(queued, writer);
        let output = {
            let send = send.clone();
            std::thread::Builder::new().name(format!("login-out {profile_id}")).spawn(move || {
                let mut reader = reader;
                let mut decoder = Utf8Stream::default();
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let text = decoder.push(&buf[..n]);
                            if !text.is_empty() {
                                send(LoginEventKind::Data, Some(text), None);
                            }
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                let rest = decoder.finish();
                if !rest.is_empty() {
                    send(LoginEventKind::Data, Some(rest), None);
                }
            })
        }
        .map_err(|err| err.to_string())?;

        let logins = Arc::clone(self);
        std::thread::Builder::new()
            .name(format!("login-wait {profile_id}"))
            .spawn(move || {
                let code = child.wait().ok().map(|status| status.exit_code() as i32);
                // Closing the PTY lets the reader see the end (ConPTY keeps the pipe open until then).
                let current = {
                    let mut all = logins.by_profile.lock().unwrap();
                    let current = all.get(&profile_id).is_some_and(|l| Arc::ptr_eq(l, &login));
                    if current {
                        all.remove(&profile_id);
                    }
                    current
                };
                if let Some(tree) = login.tree.lock().unwrap().take() {
                    let _ = tree.kill();
                }
                drop(login.master.lock().unwrap().take());
                let _ = output.join();
                // The login's caches and idle sessions go before anyone hears the end.
                {
                    let _runtime = runtime.enter();
                    on_exit();
                }
                let _ = exited_tx.send(true);
                if current {
                    send(LoginEventKind::Exit, None, code);
                }
            })
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// Keystrokes from the client that owns the login.
    pub fn input(&self, profile_id: &str, owner: ClientId, text: &str) {
        if let Some(login) = self.owned(profile_id, owner) {
            let _ = login.input.send(text.as_bytes().to_vec());
        }
    }

    pub fn resize(&self, profile_id: &str, owner: ClientId, cols: Option<u16>, rows: Option<u16>) {
        if let Some(login) = self.owned(profile_id, owner) {
            let (cols, rows) = terminal_size(cols, rows);
            if let Some(master) = login.master.lock().unwrap().as_ref() {
                let _ = master.resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 });
            }
        }
    }

    /// Ends the login; `session` limits it to that one, so a stale cancel
    /// never ends a newer login.
    pub fn cancel(&self, profile_id: &str, owner: ClientId, session: Option<&str>) {
        let Some(login) = self.owned(profile_id, owner) else { return };
        if session.is_some_and(|s| s != login.session) {
            return;
        }
        self.by_profile.lock().unwrap().remove(profile_id);
        login.kill();
    }

    /// Ends the profile's login and waits for its CLI to exit, up to `wait`.
    pub async fn end(&self, profile_id: &str, wait: Duration) {
        let Some(login) = self.by_profile.lock().unwrap().remove(profile_id) else { return };
        login.kill();
        let mut exited = login.exited.clone();
        let _ = tokio::time::timeout(wait, exited.wait_for(|done| *done)).await;
    }

    /// The client is gone: its logins end with it.
    pub fn client_gone(&self, owner: ClientId) {
        let gone: Vec<Arc<Login>> = {
            let mut all = self.by_profile.lock().unwrap();
            let ids: Vec<String> = all.iter().filter(|(_, l)| l.owner == owner).map(|(id, _)| id.clone()).collect();
            ids.iter().filter_map(|id| all.remove(id)).collect()
        };
        for login in gone {
            login.kill();
        }
    }

    /// Host shutdown: every login goes.
    pub fn shutdown(&self) {
        let all: Vec<Arc<Login>> = self.by_profile.lock().unwrap().drain().map(|(_, l)| l).collect();
        for login in all {
            login.kill();
        }
    }
}

fn spawn_writer(queued: std_mpsc::Receiver<Vec<u8>>, mut writer: Box<dyn Write + Send>) {
    let _ = std::thread::Builder::new().name("login-in".into()).spawn(move || {
        while let Ok(data) = queued.recv() {
            if writer.write_all(&data).and_then(|()| writer.flush()).is_err() {
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn sizes_and_sessions_are_checked_like_the_app() {
        assert_eq!(terminal_size(Some(120), Some(30)), (120, 30));
        assert_eq!(terminal_size(Some(5), Some(1000)), (100, 24));
        assert_eq!(terminal_size(None, None), (100, 24));
        assert_eq!(session_id(Some("abc_1-2")), Some("abc_1-2".into()));
        assert_eq!(session_id(Some("../x")), None);
        assert_eq!(session_id(Some("")), None);
    }

    // ---- real PTY sessions, with a harmless shell in place of the CLI ----
    //
    // ConPTY asks the terminal where the cursor is (`ESC[6n`) and holds the
    // child until it is answered; in the product the renderer's xterm does,
    // here `Probe::handshake` does.

    use crate::domain::next_client_id;
    use std::ffi::OsString;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::mpsc;

    const WAIT: Duration = Duration::from_secs(20);
    const CURSOR_QUERY: &str = "\u{1b}[6n";
    const CURSOR_REPORT: &str = "\u{1b}[1;1R";

    /// A client as the engine sees it: its id, a notifier and what it was sent.
    struct Probe {
        id: ClientId,
        notifier: Notifier,
        rx: mpsc::UnboundedReceiver<String>,
        /// Events already taken off the channel (by `handshake`).
        seen: Vec<LoginEvent>,
    }

    fn parse(text: &str) -> LoginEvent {
        let note: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(note["method"], "providers.login");
        serde_json::from_value(note["params"].clone()).unwrap()
    }

    impl Probe {
        fn new() -> Self {
            let (tx, rx) = mpsc::unbounded_channel();
            let id = next_client_id();
            Probe { id, notifier: Notifier::new(id, tx), rx, seen: Vec::new() }
        }

        /// Answers the terminal's cursor query, as a real client would (Windows only).
        async fn handshake(&mut self, logins: &Logins, profile: &str) {
            if !cfg!(windows) {
                return;
            }
            loop {
                let text = tokio::time::timeout(WAIT, self.rx.recv()).await.expect("no cursor query from the login").expect("channel closed");
                let event = parse(&text);
                let asked = event.text.as_deref().is_some_and(|t| t.contains(CURSOR_QUERY));
                self.seen.push(event);
                if asked {
                    break;
                }
            }
            logins.input(profile, self.id, CURSOR_REPORT);
        }

        /// The `providers.login` events received so far.
        fn drain(&mut self) -> Vec<LoginEvent> {
            let mut out = std::mem::take(&mut self.seen);
            while let Ok(text) = self.rx.try_recv() {
                out.push(parse(&text));
            }
            out
        }

        /// Events up to and including the first `exit`.
        async fn until_exit(&mut self) -> Vec<LoginEvent> {
            let mut out = std::mem::take(&mut self.seen);
            if out.last().is_some_and(|e| e.kind == LoginEventKind::Exit) {
                return out;
            }
            loop {
                let text = tokio::time::timeout(WAIT, self.rx.recv()).await.expect("timeout waiting for the login to exit").expect("channel closed");
                let event = parse(&text);
                let done = event.kind == LoginEventKind::Exit;
                out.push(event);
                if done {
                    return out;
                }
            }
        }
    }

    /// An interactive shell: the test types into it and ends it with `exit N`.
    fn interactive() -> (ProviderCommand, Vec<String>) {
        let bin = if cfg!(windows) { "cmd.exe" } else { "sh" };
        (ProviderCommand { bin: bin.into(), args: vec![] }, vec![])
    }

    /// Runs for a minute unless killed.
    fn slow() -> (ProviderCommand, Vec<String>) {
        let (bin, flag, script) = if cfg!(windows) { ("cmd.exe", "/c", "ping -n 60 127.0.0.1 >nul") } else { ("sh", "-c", "sleep 60") };
        (ProviderCommand { bin: bin.into(), args: vec![OsString::from(flag)] }, vec![script.to_string()])
    }

    /// `on_exit` reports through a channel so tests can wait for it.
    fn request(probe: &Probe, profile: &str, session: &str, script: (ProviderCommand, Vec<String>), cwd: &Path) -> (LoginRequest, std_mpsc::Receiver<()>) {
        let (done_tx, done_rx) = std_mpsc::channel();
        let (command, args) = script;
        let request = LoginRequest {
            profile_id: profile.into(),
            session: session.into(),
            cols: 100,
            rows: 24,
            owner: probe.id,
            notifier: probe.notifier.clone(),
            command,
            args,
            env: ProfileEnv::default(),
            cwd: cwd.to_path_buf(),
            on_exit: Box::new(move || {
                let _ = done_tx.send(());
            }),
            runtime: tokio::runtime::Handle::current(),
        };
        (request, done_rx)
    }

    async fn exited(done: &std_mpsc::Receiver<()>) -> bool {
        for _ in 0..(WAIT.as_millis() / 50) {
            if done.try_recv().is_ok() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    #[tokio::test]
    async fn a_login_streams_data_then_exit_to_its_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let (mut owner, mut other) = (Probe::new(), Probe::new());
        let logins = Logins::new();
        let ran = Arc::new(AtomicBool::new(false));
        let (mut req, _done) = request(&owner, "work", "s1", interactive(), dir.path());
        let flag = Arc::clone(&ran);
        req.on_exit = Box::new(move || flag.store(true, Ordering::SeqCst));
        logins.start(req).unwrap();
        owner.handshake(&logins, "work").await;
        logins.input("work", owner.id, "echo oi\rexit 0\r");

        let events = owner.until_exit().await;
        let (exit, data) = events.split_last().unwrap();
        assert!(!data.is_empty() && data.iter().all(|e| e.kind == LoginEventKind::Data));
        let text: String = data.iter().filter_map(|e| e.text.clone()).collect();
        assert!(text.contains("oi"), "{text:?}");
        assert!(events.iter().all(|e| e.profile_id == "work" && e.session == "s1"));
        assert_eq!((exit.kind, exit.code, exit.text.as_deref()), (LoginEventKind::Exit, Some(0), None));
        assert!(ran.load(Ordering::SeqCst), "on_exit runs before the exit event");
        assert!(!logins.is_open("work"), "closed once the CLI is gone");
        assert!(other.drain().is_empty(), "nobody else hears a login");
        assert!(owner.drain().is_empty(), "nothing after the exit");
    }

    #[tokio::test]
    async fn a_failing_cli_reports_its_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let mut owner = Probe::new();
        let logins = Logins::new();
        let (req, _done) = request(&owner, "work", "s1", interactive(), dir.path());
        logins.start(req).unwrap();
        owner.handshake(&logins, "work").await;
        logins.input("work", owner.id, "exit 3\r");
        assert_eq!(owner.until_exit().await.last().unwrap().code, Some(3));
    }

    #[tokio::test]
    async fn a_missing_command_fails_to_start_and_leaves_nothing_open() {
        let dir = tempfile::tempdir().unwrap();
        let owner = Probe::new();
        let logins = Logins::new();
        let (mut req, _done) = request(&owner, "work", "s1", interactive(), dir.path());
        req.command = ProviderCommand { bin: dir.path().join("nao-existe-mesmo"), args: vec![] };
        let err = logins.start(req).unwrap_err();
        assert!(err.contains("nao-existe-mesmo"), "{err}");
        assert!(!logins.is_open("work"));
    }

    #[tokio::test]
    async fn a_second_start_of_the_same_profile_is_refused_while_the_first_runs() {
        let dir = tempfile::tempdir().unwrap();
        let mut owner = Probe::new();
        let logins = Logins::new();
        let (first, first_done) = request(&owner, "work", "s1", slow(), dir.path());
        logins.start(first).unwrap();
        owner.handshake(&logins, "work").await;
        assert!(logins.is_open("work"));
        let (second, second_done) = request(&owner, "work", "s2", slow(), dir.path());
        assert_eq!(logins.start(second).unwrap_err(), ALREADY_OPEN);
        assert!(logins.is_open("work"), "the first login keeps running");
        assert!(first_done.try_recv().is_err());
        assert!(second_done.try_recv().is_err(), "the refused one never ran");

        // A late cancel naming another session must not touch it.
        logins.cancel("work", owner.id, Some("s2"));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(logins.is_open("work"));
        assert!(first_done.try_recv().is_err());

        logins.cancel("work", owner.id, Some("s1"));
        assert!(!logins.is_open("work"));
        assert!(exited(&first_done).await);
        assert!(owner.drain().iter().all(|e| e.kind != LoginEventKind::Exit), "a cancelled login's end is not reported");

        // Once it is gone the profile can log in again.
        let (third, third_done) = request(&owner, "work", "s3", slow(), dir.path());
        logins.start(third).unwrap();
        owner.handshake(&logins, "work").await;
        logins.cancel("work", owner.id, None);
        assert!(exited(&third_done).await);
    }

    #[tokio::test]
    async fn cancel_needs_the_owner_and_without_a_session_ends_whatever_runs() {
        let dir = tempfile::tempdir().unwrap();
        let (mut owner, stranger) = (Probe::new(), Probe::new());
        let logins = Logins::new();
        let (req, done) = request(&owner, "work", "s1", slow(), dir.path());
        logins.start(req).unwrap();
        owner.handshake(&logins, "work").await;

        logins.cancel("work", stranger.id, None);
        logins.cancel("outro", owner.id, None);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(logins.is_open("work"));
        assert!(done.try_recv().is_err());

        logins.cancel("work", owner.id, None);
        assert!(!logins.is_open("work"));
        assert!(exited(&done).await);
    }

    #[tokio::test]
    async fn only_the_owner_can_type_and_resize() {
        let dir = tempfile::tempdir().unwrap();
        let (mut owner, stranger) = (Probe::new(), Probe::new());
        let logins = Logins::new();
        let (req, _done) = request(&owner, "work", "s1", interactive(), dir.path());
        logins.start(req).unwrap();
        owner.handshake(&logins, "work").await;
        logins.input("work", stranger.id, "exit 9\r");
        logins.resize("work", stranger.id, Some(80), Some(30));
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(logins.is_open("work"), "a stranger's keystrokes do nothing");
        logins.resize("work", owner.id, Some(120), Some(40));
        logins.input("work", owner.id, "echo ola\rexit 4\r");
        let events = owner.until_exit().await;
        let text: String = events.iter().filter_map(|e| e.text.clone()).collect();
        assert!(text.contains("ola"), "{text:?}");
        assert_eq!(events.last().unwrap().code, Some(4), "the owner's exit, not the stranger's");
    }

    #[tokio::test]
    async fn a_client_that_leaves_ends_its_logins_only() {
        let dir = tempfile::tempdir().unwrap();
        let (mut gone, mut stays) = (Probe::new(), Probe::new());
        let logins = Logins::new();
        let (mine, mine_done) = request(&gone, "a", "s1", slow(), dir.path());
        let (theirs, theirs_done) = request(&stays, "b", "s2", slow(), dir.path());
        logins.start(mine).unwrap();
        logins.start(theirs).unwrap();
        gone.handshake(&logins, "a").await;
        stays.handshake(&logins, "b").await;

        logins.client_gone(gone.id);
        assert!(!logins.is_open("a"));
        assert!(logins.is_open("b"));
        assert!(exited(&mine_done).await);
        assert!(theirs_done.try_recv().is_err());

        logins.shutdown();
        assert!(!logins.is_open("b"));
        assert!(exited(&theirs_done).await);
    }

    #[tokio::test]
    async fn end_kills_the_login_and_waits_for_the_cli_to_exit() {
        let dir = tempfile::tempdir().unwrap();
        let mut owner = Probe::new();
        let logins = Logins::new();
        logins.end("nada", Duration::from_millis(10)).await;

        let (req, done) = request(&owner, "work", "s1", slow(), dir.path());
        logins.start(req).unwrap();
        owner.handshake(&logins, "work").await;
        logins.end("work", WAIT).await;
        assert!(!logins.is_open("work"));
        assert!(done.try_recv().is_ok(), "on_exit already ran when end returned");
    }
    #[tokio::test]
    async fn on_exit_runs_inside_the_runtime_so_it_can_spawn_tasks() {
        let dir = tempfile::tempdir().unwrap();
        let mut owner = Probe::new();
        let logins = Logins::new();
        let (spawned_tx, spawned_rx) = tokio::sync::oneshot::channel();
        let (mut req, _done) = request(&owner, "work", "s1", interactive(), dir.path());
        req.on_exit = Box::new(move || {
            // Outside the runtime this would panic and the exit would never be sent.
            tokio::spawn(async move {
                let _ = spawned_tx.send(7);
            });
        });
        logins.start(req).unwrap();
        owner.handshake(&logins, "work").await;
        logins.input("work", owner.id, "exit 0\r");
        let events = owner.until_exit().await;
        assert_eq!(events.last().unwrap().kind, LoginEventKind::Exit, "the exit still reaches the owner");
        assert_eq!(tokio::time::timeout(WAIT, spawned_rx).await.unwrap().unwrap(), 7, "the spawned task ran");
    }

    #[tokio::test]
    async fn on_exit_has_finished_before_the_exit_event_and_before_end_returns() {
        let dir = tempfile::tempdir().unwrap();
        let mut owner = Probe::new();
        let logins = Logins::new();

        // The exit event: on_exit is slow, yet done when the owner hears the end.
        let finished = Arc::new(AtomicBool::new(false));
        let (mut req, _done) = request(&owner, "work", "s1", interactive(), dir.path());
        let flag = Arc::clone(&finished);
        req.on_exit = Box::new(move || {
            std::thread::sleep(Duration::from_millis(300));
            flag.store(true, Ordering::SeqCst);
        });
        logins.start(req).unwrap();
        owner.handshake(&logins, "work").await;
        logins.input("work", owner.id, "exit 0\r");
        owner.until_exit().await;
        assert!(finished.load(Ordering::SeqCst), "on_exit finished before the exit event");

        // end(): it returns only once on_exit is done.
        let finished = Arc::new(AtomicBool::new(false));
        let (mut req, _done) = request(&owner, "work", "s2", slow(), dir.path());
        let flag = Arc::clone(&finished);
        req.on_exit = Box::new(move || {
            std::thread::sleep(Duration::from_millis(300));
            flag.store(true, Ordering::SeqCst);
        });
        logins.start(req).unwrap();
        owner.handshake(&logins, "work").await;
        logins.end("work", WAIT).await;
        assert!(finished.load(Ordering::SeqCst), "on_exit finished before end returned");
    }
}
