//! The public way in for the phone's page: a Cloudflare quick tunnel
//! (`cloudflared`), found or downloaded, started against a loopback port and
//! watched until it ends; or no tunnel at all (`PRISM_REMOTE_TUNNEL=off`,
//! tests). Port of the `cloudflared` handling in src/main/ipc/remoteControl.ts
//! (`ensureCloudflared`, `startTunnel`) and of the npm `cloudflared` package it
//! uses (`install.js`, `tunnel.js`).
//!
//! - The binary: `PRISM_CLOUDFLARED_BIN`, else the one the app already
//!   downloaded (`<app data>/cloudflared/`), else `cloudflared` on PATH, else
//!   the latest GitHub release, downloaded into `<app data>/cloudflared/`.
//! - The tunnel: `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>`.
//!   The URL is the first `https://<sub>.trycloudflare.com` it prints, except
//!   `api.` (the CLI logs `https://api.trycloudflare.com/tunnel` on errors).
//! - The process lives in a `ProcessTree`, killed when the guard is dropped.

use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use regex::{Captures, Regex};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, mpsc, oneshot};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// Um túnel aberto.
pub struct OpenTunnel {
    /// `https://….trycloudflare.com`, sem a barra final; ou `http://127.0.0.1:{port}` no modo sem túnel.
    pub url: String,
    /// Dispara uma vez quando o túnel acaba sozinho (o processo saiu), com o
    /// motivo em pt-BR. No modo sem túnel nunca dispara. Soltar o `guard`
    /// fecha o canal sem mensagem.
    pub ended: oneshot::Receiver<String>,
    /// Encerra o túnel quando é solto (mata a árvore de processos).
    pub guard: Box<dyn Send + Sync>,
}

pub trait Tunnels: Send + Sync + 'static {
    /// Abre um caminho público até `http://127.0.0.1:{port}`. Erros em pt-BR.
    fn open(&self, port: u16) -> BoxFuture<Result<OpenTunnel, String>>;
}

/// Com `PRISM_REMOTE_TUNNEL=off`, devolve `Loopback`; senão,
/// `Cloudflared::new(crate::paths::app_data_root())`.
pub fn from_env() -> Arc<dyn Tunnels> {
    if tunnel_off(std::env::var_os("PRISM_REMOTE_TUNNEL")) {
        Arc::new(Loopback)
    } else {
        Arc::new(Cloudflared::new(crate::paths::app_data_root()))
    }
}

fn tunnel_off(value: Option<OsString>) -> bool {
    value.is_some_and(|v| v.to_str().is_some_and(|v| v.trim().eq_ignore_ascii_case("off")))
}

/// Sem túnel: a URL é a do loopback (testes, QA sem internet).
pub struct Loopback;

impl Tunnels for Loopback {
    fn open(&self, port: u16) -> BoxFuture<Result<OpenTunnel, String>> {
        // The sender lives in the guard: `ended` stays pending until then.
        let (keep, ended) = oneshot::channel::<String>();
        Box::pin(async move { Ok(OpenTunnel { url: format!("http://127.0.0.1:{port}"), ended, guard: Box::new(keep) }) })
    }
}

/// How long `cloudflared` gets to print its URL (as in the TS).
const URL_DEADLINE: Duration = Duration::from_secs(45);

const RELEASES: &str = "https://github.com/cloudflare/cloudflared/releases/latest/download/";

const BINARY: &str = if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" };

/// O túnel rápido do cloudflared.
pub struct Cloudflared {
    app_data: Option<PathBuf>,
    /// Tests: this binary, without the search or the download.
    fixed: Option<PathBuf>,
    deadline: Duration,
    /// One search (and download) at a time.
    install: Arc<Mutex<()>>,
}

impl Cloudflared {
    pub fn new(app_data: Option<PathBuf>) -> Self {
        Self { app_data, fixed: None, deadline: URL_DEADLINE, install: Arc::default() }
    }

    #[cfg(test)]
    fn with_binary(bin: PathBuf, deadline: Duration) -> Self {
        Self { app_data: None, fixed: Some(bin), deadline, install: Arc::default() }
    }
}

impl Tunnels for Cloudflared {
    fn open(&self, port: u16) -> BoxFuture<Result<OpenTunnel, String>> {
        let (app_data, fixed, deadline, install) = (self.app_data.clone(), self.fixed.clone(), self.deadline, self.install.clone());
        Box::pin(async move {
            let bin = match fixed {
                Some(bin) => bin,
                None => {
                    let _one = install.lock().await;
                    let (env_bin, path_var) = (std::env::var_os("PRISM_CLOUDFLARED_BIN"), std::env::var_os("PATH"));
                    tokio::task::spawn_blocking(move || match find_binary(env_bin, app_data.as_deref(), path_var) {
                        Some(found) => Ok(found),
                        None => download(app_data.as_deref()),
                    })
                    .await
                    .map_err(|err| format!("Falha ao preparar o cloudflared: {err}"))??
                }
            };
            start(&bin, port, deadline).await
        })
    }
}

/// The binary to run, in order: `PRISM_CLOUDFLARED_BIN` (taken as given),
/// the app's own copy, `cloudflared` on PATH. None: download it.
fn find_binary(env_bin: Option<OsString>, app_data: Option<&Path>, path_var: Option<OsString>) -> Option<PathBuf> {
    if let Some(bin) = env_bin.filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(bin));
    }
    if let Some(own) = app_data.map(managed_binary).filter(|p| p.is_file()) {
        return Some(own);
    }
    path_var.and_then(|paths| std::env::split_paths(&paths).map(|dir| dir.join(BINARY)).find(|p| p.is_file()))
}

/// Where the app keeps (and downloads) its copy: `<app data>/cloudflared/cloudflared(.exe)`.
fn managed_binary(app_data: &Path) -> PathBuf {
    app_data.join("cloudflared").join(BINARY)
}

/// The release file for this system, named as in the npm package's
/// `install.js` (`std::env::consts::{OS, ARCH}` values).
fn release_asset(os: &str, arch: &str) -> Result<&'static str, String> {
    Ok(match (os, arch) {
        ("windows", "x86_64") => "cloudflared-windows-amd64.exe",
        ("windows", "x86") => "cloudflared-windows-386.exe",
        ("linux", "x86_64") => "cloudflared-linux-amd64",
        ("linux", "x86") => "cloudflared-linux-386",
        ("linux", "aarch64") => "cloudflared-linux-arm64",
        ("linux", "arm") => "cloudflared-linux-arm",
        ("macos", "x86_64") => "cloudflared-darwin-amd64.tgz",
        ("macos", "aarch64") => "cloudflared-darwin-arm64.tgz",
        ("windows" | "linux" | "macos", _) => {
            return Err(format!(
                "O cloudflared não tem versão pronta para a arquitetura {arch} ({os}). Instale-o no PATH ou aponte PRISM_CLOUDFLARED_BIN para ele."
            ));
        }
        _ => {
            return Err(format!(
                "O cloudflared não tem versão pronta para o sistema {os}. Instale-o no PATH ou aponte PRISM_CLOUDFLARED_BIN para ele."
            ));
        }
    })
}

fn release_url(asset: &str) -> String {
    format!("{RELEASES}{asset}")
}

/// Downloads the latest release into `<app data>/cloudflared/`. Everything
/// lands in a staging folder next to it first and is renamed in at the end,
/// so a broken download never leaves a half binary behind.
fn download(app_data: Option<&Path>) -> Result<PathBuf, String> {
    let asset = release_asset(std::env::consts::OS, std::env::consts::ARCH)?;
    let target = managed_binary(app_data.ok_or("Sem pasta de dados do app para baixar o cloudflared.")?);
    let dir = target.parent().unwrap_or(Path::new("."));
    let staging = dir.join(".download");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|err| format!("Não foi possível criar a pasta do cloudflared ({}): {err}", dir.display()))?;
    tracing::info!(asset, "baixando o cloudflared");
    let result = install_into(asset, &staging, &target);
    let _ = std::fs::remove_dir_all(&staging);
    result.map(|()| target)
}

fn install_into(asset: &str, staging: &Path, target: &Path) -> Result<(), String> {
    let fetched = staging.join(asset);
    fetch(&release_url(asset), &fetched)?;
    let binary = if asset.ends_with(".tgz") {
        extract(&fetched, staging)?;
        staging.join("cloudflared")
    } else {
        fetched
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).map_err(|err| format!("Falha ao gravar o cloudflared: {err}"))?;
    }
    std::fs::rename(&binary, target).map_err(|err| format!("Falha ao gravar o cloudflared ({}): {err}", target.display()))
}

fn fetch(url: &str, to: &Path) -> Result<(), String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        // A redirect to plain http is refused: the binary only comes over TLS.
        .https_only(true)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .timeout_recv_body(Some(Duration::from_secs(600)))
        .build()
        .into();
    let mut response = agent.get(url).call().map_err(|err| match err {
        ureq::Error::StatusCode(code) => format!("Falha ao baixar o cloudflared (HTTP {code})."),
        err => format!("Falha ao baixar o cloudflared: {err}"),
    })?;
    let mut file = std::fs::File::create(to).map_err(|err| format!("Falha ao gravar o cloudflared ({}): {err}", to.display()))?;
    std::io::copy(&mut response.body_mut().as_reader(), &mut file).map_err(|err| format!("Falha ao baixar o cloudflared: {err}"))?;
    Ok(())
}

/// The macOS release is a `.tgz` holding `cloudflared`; the system `tar` opens it.
fn extract(archive: &Path, into: &Path) -> Result<(), String> {
    let status = std::process::Command::new("tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(into)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("Falha ao extrair o cloudflared (tar): {err}"))?;
    if status.success() { Ok(()) } else { Err(format!("Falha ao extrair o cloudflared (tar: {status}).")) }
}

/// Starts the quick tunnel and waits for its URL. On any failure the tree
/// (and the process) goes with it.
async fn start(bin: &Path, port: u16, deadline: Duration) -> Result<OpenTunnel, String> {
    let mut command = Command::new(bin);
    command
        .args(["tunnel", "--no-autoupdate", "--url", &format!("http://127.0.0.1:{port}")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let tree = prism_proc::ProcessTree::new().map_err(|err| format!("Não foi possível iniciar o cloudflared: {err}"))?;
    // On Windows the tree spawns with CREATE_NO_WINDOW.
    let mut child = tree.spawn(&mut command).map_err(|err| format!("Não foi possível iniciar o cloudflared ({}): {err}", bin.display()))?;
    tracing::debug!(bin = %bin.display(), port, "abrindo o túnel do cloudflared");

    // Both streams are read to the end, URL or not, so the CLI never blocks
    // on a full pipe.
    let (found_tx, mut found) = mpsc::channel(2);
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(drain(stdout, found_tx.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(drain(stderr, found_tx));
    }
    let first = tokio::time::timeout(deadline, async {
        tokio::select! {
            biased;
            Some(url) = found.recv() => Ok(url),
            status = child.wait() => Err(exited(status)),
        }
    })
    .await;
    let url = first.map_err(|_| "Tempo esgotado ao abrir o túnel (cloudflared não respondeu).".to_string())??;

    let (ended_tx, ended) = oneshot::channel();
    let (stop, stopped) = oneshot::channel();
    tokio::spawn(watch(child, stopped, ended_tx));
    tracing::info!(port, "túnel do cloudflared aberto");
    Ok(OpenTunnel { url, ended, guard: Box::new(Running { _stop: stop, _tree: tree }) })
}

/// What `OpenTunnel::guard` holds for a real tunnel. Fields drop in order:
/// the watcher hears the stop before the kill, so a stop never reads as the
/// tunnel ending on its own.
struct Running {
    _stop: oneshot::Sender<()>,
    _tree: prism_proc::ProcessTree,
}

/// Waits for the process to exit and reports it through `ended`, unless the
/// guard was dropped first.
async fn watch(mut child: Child, mut stopped: oneshot::Receiver<()>, ended: oneshot::Sender<String>) {
    tokio::select! {
        biased;
        _ = &mut stopped => {}
        status = child.wait() => {
            let reason = exited(status);
            tracing::info!(%reason, "o túnel do cloudflared acabou");
            let _ = ended.send(reason);
        }
    }
}

fn exited(status: std::io::Result<std::process::ExitStatus>) -> String {
    match status {
        Ok(status) => match status.code() {
            Some(code) => format!("cloudflared encerrou (código {code})."),
            None => "cloudflared encerrou.".to_string(),
        },
        Err(err) => format!("Falha ao acompanhar o cloudflared: {err}"),
    }
}

/// Reads one of the CLI's streams line by line until it closes, handing the
/// first quick-tunnel URL to `found`.
async fn drain(stream: impl AsyncRead + Unpin, found: mpsc::Sender<String>) {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    let mut announced = false;
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end();
        if !announced && let Some(url) = quick_url(text) {
            announced = true;
            let _ = found.try_send(url);
        }
        tracing::debug!(line = %redact(text), "cloudflared");
    }
}

static QUICK_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https://([a-z0-9-]+)\.trycloudflare\.com").unwrap());

/// The tunnel's public URL in a line of output, if any: the first
/// `https://<sub>.trycloudflare.com` whose `<sub>` is not the API's.
fn quick_url(line: &str) -> Option<String> {
    QUICK_URL.captures_iter(line).find(|c| &c[1] != "api").map(|c| c[0].to_string())
}

/// The line for the log, without the tunnel's subdomain.
fn redact(line: &str) -> std::borrow::Cow<'_, str> {
    QUICK_URL.replace_all(line, |c: &Captures| if &c[1] == "api" { c[0].to_string() } else { "https://….trycloudflare.com".to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD_URL: &str = "https://quiet-river-1234.trycloudflare.com";

    /// What cloudflared logs when all is well / when the API is unreachable.
    /// (No quotes, and `|` escaped for cmd.)
    #[cfg(windows)]
    const GOOD_LINE: &str = "echo 2026-10-09T12:00:00Z INF ^|  https://quiet-river-1234.trycloudflare.com                    ^| 1>&2";
    #[cfg(unix)]
    const GOOD_LINE: &str = "echo '2026-10-09T12:00:00Z INF |  https://quiet-river-1234.trycloudflare.com                    |' >&2";
    #[cfg(windows)]
    const API_LINE: &str = "echo 2026-10-09T12:00:00Z ERR failed to request quick Tunnel error=Post https://api.trycloudflare.com/tunnel: dial tcp: lookup api.trycloudflare.com: no such host 1>&2";
    #[cfg(unix)]
    const API_LINE: &str = "echo '2026-10-09T12:00:00Z ERR failed to request quick Tunnel error=Post https://api.trycloudflare.com/tunnel: dial tcp: lookup api.trycloudflare.com: no such host' >&2";

    #[cfg(windows)]
    const SLEEP: &str = "ping -n 30 127.0.0.1 > nul";
    #[cfg(unix)]
    const SLEEP: &str = "sleep 30";
    #[cfg(windows)]
    const SLEEP_1S: &str = "ping -n 2 127.0.0.1 > nul";
    #[cfg(unix)]
    const SLEEP_1S: &str = "sleep 1";
    #[cfg(windows)]
    fn exit(code: i32) -> String {
        format!("exit /b {code}")
    }
    #[cfg(unix)]
    fn exit(code: i32) -> String {
        format!("exit {code}")
    }

    /// Writes a stand-in `cloudflared` running `lines` (one command per line).
    fn fake(dir: &Path, lines: &[&str]) -> PathBuf {
        #[cfg(windows)]
        {
            let script = dir.join("fake.cmd");
            std::fs::write(&script, format!("@echo off\r\n{}\r\n", lines.join("\r\n"))).unwrap();
            script
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = dir.join("fake.sh");
            std::fs::write(&script, format!("#!/bin/sh\n{}\n", lines.join("\n"))).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            script
        }
    }

    fn long() -> Duration {
        Duration::from_secs(20)
    }

    async fn open_with(lines: &[&str], deadline: Duration) -> (Result<OpenTunnel, String>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake(dir.path(), lines);
        (Cloudflared::with_binary(bin, deadline).open(4321).await, dir)
    }

    fn err(result: Result<OpenTunnel, String>) -> String {
        match result {
            Ok(open) => panic!("esperava erro, veio a URL {}", open.url),
            Err(message) => message,
        }
    }

    #[tokio::test]
    async fn good_url_is_returned_and_cloudflared_gets_the_tunnel_args() {
        let dir = tempfile::tempdir().unwrap();
        let args = dir.path().join("args.txt");
        #[cfg(windows)]
        let record = format!("echo %*> \"{}\"", args.display());
        #[cfg(unix)]
        let record = format!("echo \"$*\" > '{}'", args.display());
        let bin = fake(dir.path(), &[&record, GOOD_LINE, SLEEP]);
        let open = Cloudflared::with_binary(bin, long()).open(4321).await.unwrap();
        assert_eq!(open.url, GOOD_URL);
        assert_eq!(std::fs::read_to_string(&args).unwrap().trim(), "tunnel --no-autoupdate --url http://127.0.0.1:4321");
    }

    #[tokio::test]
    async fn api_line_before_the_good_url_is_skipped() {
        let (open, _dir) = open_with(&[API_LINE, GOOD_LINE, SLEEP], long()).await;
        assert_eq!(open.unwrap().url, GOOD_URL);
    }

    #[tokio::test]
    async fn only_the_api_line_then_exit_is_an_error_never_the_api_url() {
        let code = exit(1);
        let (open, _dir) = open_with(&[API_LINE, &code], long()).await;
        assert_eq!(err(open), "cloudflared encerrou (código 1).");
    }

    #[tokio::test]
    async fn no_url_before_the_deadline_times_out() {
        let (open, _dir) = open_with(&[SLEEP], Duration::from_millis(500)).await;
        assert_eq!(err(open), "Tempo esgotado ao abrir o túnel (cloudflared não respondeu).");
    }

    #[tokio::test]
    async fn exit_before_the_url_reports_the_code() {
        let code = exit(3);
        let (open, _dir) = open_with(&[&code], long()).await;
        assert_eq!(err(open), "cloudflared encerrou (código 3).");
    }

    #[tokio::test]
    async fn ended_reports_the_exit_while_the_guard_is_alive() {
        let code = exit(7);
        let (open, _dir) = open_with(&[GOOD_LINE, SLEEP_1S, &code], long()).await;
        let open = open.unwrap();
        let reason = tokio::time::timeout(Duration::from_secs(10), open.ended).await.expect("ended não disparou");
        assert_eq!(reason, Ok("cloudflared encerrou (código 7).".to_string()));
        drop(open.guard);
    }

    #[tokio::test]
    async fn dropping_the_guard_kills_cloudflared_and_closes_ended_without_a_message() {
        let dir = tempfile::tempdir().unwrap();
        let beat = dir.path().join("beat.txt");
        #[cfg(windows)]
        let body = [GOOD_LINE.to_string(), ":loop".to_string(), format!("echo x>> \"{}\"", beat.display()), SLEEP_1S.to_string(), "goto loop".to_string()];
        #[cfg(unix)]
        let body = [GOOD_LINE.to_string(), format!("while true; do echo x >> '{}'; sleep 1; done", beat.display())];
        let lines: Vec<&str> = body.iter().map(String::as_str).collect();
        let bin = fake(dir.path(), &lines);
        let open = Cloudflared::with_binary(bin, long()).open(4321).await.unwrap();
        assert_eq!(open.url, GOOD_URL);
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert!(std::fs::metadata(&beat).is_ok_and(|m| m.len() > 0), "o falso não bateu");

        let OpenTunnel { ended, guard, .. } = open;
        drop(guard);
        let closed = tokio::time::timeout(Duration::from_secs(10), ended).await.expect("ended não fechou");
        assert!(closed.is_err(), "ended deveria fechar sem mensagem: {closed:?}");

        tokio::time::sleep(Duration::from_millis(1000)).await;
        let before = std::fs::metadata(&beat).unwrap().len();
        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert_eq!(std::fs::metadata(&beat).unwrap().len(), before, "o processo continuou vivo");
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
    }

    #[test]
    fn find_binary_env_wins_even_if_missing() {
        let app = tempfile::tempdir().unwrap();
        touch(&managed_binary(app.path()));
        let found = find_binary(Some("/no/such/cloudflared".into()), Some(app.path()), None);
        assert_eq!(found, Some(PathBuf::from("/no/such/cloudflared")));
    }

    #[test]
    fn find_binary_ignores_an_empty_env() {
        let app = tempfile::tempdir().unwrap();
        touch(&managed_binary(app.path()));
        let found = find_binary(Some(OsString::new()), Some(app.path()), None);
        assert_eq!(found, Some(managed_binary(app.path())));
    }

    #[test]
    fn find_binary_app_copy_beats_path() {
        let (app, on_path) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        touch(&managed_binary(app.path()));
        touch(&on_path.path().join(BINARY));
        let path_var = std::env::join_paths([on_path.path()]).unwrap();
        assert_eq!(find_binary(None, Some(app.path()), Some(path_var)), Some(managed_binary(app.path())));
    }

    #[test]
    fn find_binary_falls_back_to_the_first_path_dir_that_has_it() {
        let (app, first, second) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        touch(&second.path().join(BINARY));
        let path_var = std::env::join_paths([first.path(), second.path()]).unwrap();
        assert_eq!(find_binary(None, Some(app.path()), Some(path_var)), Some(second.path().join(BINARY)));
    }

    #[test]
    fn find_binary_finds_nothing() {
        let (app, dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let path_var = std::env::join_paths([dir.path()]).unwrap();
        assert_eq!(find_binary(None, Some(app.path()), Some(path_var)), None);
        assert_eq!(find_binary(None, None, None), None);
    }

    #[test]
    fn find_binary_ignores_a_directory_named_like_the_binary() {
        let (app, dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        std::fs::create_dir_all(managed_binary(app.path())).unwrap();
        std::fs::create_dir_all(dir.path().join(BINARY)).unwrap();
        let path_var = std::env::join_paths([dir.path()]).unwrap();
        assert_eq!(find_binary(None, Some(app.path()), Some(path_var)), None);
    }

    #[test]
    fn release_assets_per_platform() {
        for (os, arch, asset) in [
            ("windows", "x86_64", "cloudflared-windows-amd64.exe"),
            ("windows", "x86", "cloudflared-windows-386.exe"),
            ("linux", "x86_64", "cloudflared-linux-amd64"),
            ("linux", "x86", "cloudflared-linux-386"),
            ("linux", "aarch64", "cloudflared-linux-arm64"),
            ("linux", "arm", "cloudflared-linux-arm"),
            ("macos", "x86_64", "cloudflared-darwin-amd64.tgz"),
            ("macos", "aarch64", "cloudflared-darwin-arm64.tgz"),
        ] {
            assert_eq!(release_asset(os, arch), Ok(asset), "{os}/{arch}");
        }
        let arch = release_asset("windows", "aarch64").unwrap_err();
        assert!(arch.contains("aarch64"), "{arch}");
        let system = release_asset("freebsd", "x86_64").unwrap_err();
        assert!(system.contains("freebsd"), "{system}");
    }

    #[test]
    fn release_url_and_managed_binary_paths() {
        assert_eq!(
            release_url("cloudflared-linux-amd64"),
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
        );
        let app = Path::new("some").join("app");
        assert_eq!(managed_binary(&app), app.join("cloudflared").join(BINARY));
    }

    #[test]
    fn quick_url_skips_the_api_host() {
        assert_eq!(quick_url("ERR https://api.trycloudflare.com/tunnel failed"), None);
        assert_eq!(
            quick_url("https://api.trycloudflare.com/tunnel then https://calm-fox-9.trycloudflare.com |"),
            Some("https://calm-fox-9.trycloudflare.com".to_string())
        );
        assert_eq!(quick_url("https://api-foo.trycloudflare.com"), Some("https://api-foo.trycloudflare.com".to_string()));
        assert_eq!(quick_url("nada por aqui"), None);
    }

    #[test]
    fn redact_hides_the_subdomain_but_not_the_api() {
        let line = "https://api.trycloudflare.com/tunnel and https://quiet-river-1234.trycloudflare.com";
        let out = redact(line);
        assert!(!out.contains("quiet-river-1234"), "{out}");
        assert!(out.contains("https://api.trycloudflare.com/tunnel"), "{out}");
    }

    #[test]
    fn tunnel_off_values() {
        assert!(tunnel_off(Some("off".into())));
        assert!(tunnel_off(Some(" OFF ".into())));
        assert!(!tunnel_off(Some("on".into())));
        assert!(!tunnel_off(Some("".into())));
        assert!(!tunnel_off(None));
    }

    #[tokio::test]
    async fn loopback_url_and_ended_follow_the_guard() {
        let OpenTunnel { url, mut ended, guard } = Loopback.open(5678).await.unwrap();
        assert_eq!(url, "http://127.0.0.1:5678");
        assert!(tokio::time::timeout(Duration::from_millis(200), &mut ended).await.is_err(), "ended não deveria disparar");
        drop(guard);
        assert!(tokio::time::timeout(Duration::from_secs(5), ended).await.expect("ended não fechou").is_err());
    }
}
