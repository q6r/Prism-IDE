//! Short-lived CLI processes that only answer control requests: rewind,
//! the model and command catalogs, the account's usage limits. No prompt is
//! sent, so none of them is a paid model call. Also: whether the CLI is
//! installed, and the one-shot `claude -p` for commit messages.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::{Instant, timeout_at};

use super::launch::{CliCommand, LaunchEnv, LaunchSpec, Purpose, launch_env};
use super::transport::{Input, Launcher, Spawned};
use super::wire;

/// A process driven only by control requests.
struct Probe {
    spawned: Spawned,
    next: u64,
    deadline: Instant,
    /// Responses read while waiting for another request.
    early: Vec<(String, Result<Value, String>)>,
}

impl Probe {
    fn start(launcher: &dyn Launcher, spec: &LaunchSpec, limit: Duration) -> Result<Self, String> {
        let spawned = launcher.launch(spec).map_err(|err| format!("Não foi possível iniciar o Claude Code: {err}"))?;
        Ok(Self { spawned, next: 1, deadline: Instant::now() + limit, early: Vec::new() })
    }

    fn send(&mut self, request: Value) -> String {
        let id = format!("prism-{}", self.next);
        self.next += 1;
        let _ = self.spawned.input.send(Input::Line(wire::control_request(&id, request)));
        id
    }

    async fn wait(&mut self, id: &str, what: &str) -> Result<Value, String> {
        if let Some(at) = self.early.iter().position(|(k, _)| k == id) {
            return self.early.remove(at).1;
        }
        loop {
            let line = match timeout_at(self.deadline, self.spawned.output.recv()).await {
                Err(_) => return Err(format!("Tempo esgotado ao {what}.")),
                Ok(None) => return Err(format!("O Claude Code encerrou antes de {what}.")),
                Ok(Some(line)) => line,
            };
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            match msg.get("type").and_then(Value::as_str) {
                Some("control_response") => {
                    let response = msg.get("response").cloned().unwrap_or(Value::Null);
                    let rid = response.get("request_id").and_then(Value::as_str).unwrap_or("").to_string();
                    let result = if response.get("subtype").and_then(Value::as_str) == Some("success") {
                        Ok(response.get("response").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(response.get("error").and_then(Value::as_str).unwrap_or("Erro do Claude Code.").to_string())
                    };
                    if rid == id {
                        return result;
                    }
                    self.early.push((rid, result));
                }
                // Nothing here asks permission; refuse whatever the CLI asks, as the SDK does without callbacks.
                Some("control_request") => {
                    let rid = msg.get("request_id").cloned().unwrap_or(Value::Null);
                    let subtype = msg.pointer("/request/subtype").and_then(Value::as_str).unwrap_or("");
                    let _ = self.spawned.input.send(Input::Line(wire::control_error(&rid, &format!("Unsupported control request subtype: {subtype}"))));
                }
                _ => {}
            }
        }
    }

    /// stdin EOF, a short grace, then the tree is killed.
    async fn close(self) {
        let Spawned { input, exit, kill, .. } = self.spawned;
        let _ = input.send(Input::Close);
        if tokio::time::timeout(Duration::from_secs(3), exit).await.is_err() {
            kill();
        }
    }
}

pub struct RewindRequest {
    pub session_id: String,
    pub user_message_id: String,
    pub cwd: Option<PathBuf>,
    pub dry_run: bool,
}

/// `rewind_files`: the session's files back to their state at a user
/// message. `{ ok, canRewind, filesChanged, insertions, deletions }` or
/// `{ ok: false, error }`, like the IPC handler.
pub async fn rewind(launcher: &dyn Launcher, cli: CliCommand, env: LaunchEnv, r: RewindRequest) -> Value {
    let spec = LaunchSpec { program: cli.program, prefix: cli.args, args: super::launch::rewind_args(&r.session_id), cwd: r.cwd, env: launch_env(env, Purpose::Rewind) };
    let mut probe = match Probe::start(launcher, &spec, Duration::from_secs(60)) {
        Ok(p) => p,
        Err(error) => return json!({"ok": false, "error": error}),
    };
    // The SDK sends the request right behind initialize, without waiting for its answer.
    probe.send(wire::initialize());
    let id = probe.send(wire::rewind_files(&r.user_message_id, r.dry_run));
    let result = probe.wait(&id, "restaurar os arquivos").await;
    probe.close().await;
    match result {
        Ok(Value::Object(mut fields)) => {
            let mut out = serde_json::Map::new();
            out.insert("ok".into(), true.into());
            out.append(&mut fields);
            Value::Object(out)
        }
        Ok(_) => json!({"ok": true}),
        Err(error) => json!({"ok": false, "error": error}),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Catalog {
    /// `initialize` → `models` (the model picker).
    Models,
    /// `initialize` → `commands` (the `/` menu), with the folder's project settings.
    Commands,
    /// `initialize` → `account`, then `get_usage` (Settings ▸ Contas).
    Usage,
}

/// One metadata read, raw as the CLI reports it.
pub async fn catalog(launcher: &dyn Launcher, cli: CliCommand, env: LaunchEnv, kind: Catalog, cwd: Option<PathBuf>) -> Result<Value, String> {
    let (sources, cwd) = match kind {
        Catalog::Models => (None, None),
        Catalog::Commands => (Some("user,project,local"), cwd),
        Catalog::Usage => (Some("user"), Some(crate::profile_env::home_dir())),
    };
    let spec = LaunchSpec { program: cli.program, prefix: cli.args, args: super::launch::metadata_args(sources), cwd, env: launch_env(env, Purpose::Metadata) };
    let mut probe = Probe::start(launcher, &spec, Duration::from_secs(25))?;
    let init = probe.send(wire::initialize());
    let result = async {
        let init = probe.wait(&init, "ler a configuração do Claude Code").await?;
        // As reported: a reply without the list (a CLI that changed) is
        // `null`, for the caller to refuse, never an empty catalog.
        match kind {
            Catalog::Models => Ok(init.get("models").cloned().unwrap_or(Value::Null)),
            Catalog::Commands => Ok(init.get("commands").cloned().unwrap_or(Value::Null)),
            Catalog::Usage => {
                let id = probe.send(wire::get_usage());
                let usage = probe.wait(&id, "consultar o uso da conta").await?;
                Ok(json!({"account": init.get("account").cloned().unwrap_or(Value::Null), "usage": usage}))
            }
        }
    }
    .await;
    probe.close().await;
    result
}

/// `claude --version` output, trimmed; None when the CLI does not answer in time.
pub async fn version_output(cli: &CliCommand) -> Option<String> {
    let mut command = tokio::process::Command::new(&cli.program);
    command.args(&cli.args).arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    launch_env(LaunchEnv::default(), Purpose::Metadata).apply(&mut command);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = tokio::time::timeout(Duration::from_secs(6), command.output()).await.ok()?.ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// `claude -p` with Haiku: the commit message the Git panel asks for.
/// `prompt` is the full instruction plus diff (built by the git domain).
pub async fn commit_message(cli: CliCommand, env: LaunchEnv, cwd: PathBuf, prompt: String) -> Result<String, String> {
    let tree = prism_proc::ProcessTree::new().map_err(|err| err.to_string())?;
    let mut command = tokio::process::Command::new(&cli.program);
    command
        .args(&cli.args)
        .args(["-p", "--model", "claude-haiku-4-5"])
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    launch_env(env, Purpose::Metadata).apply(&mut command);
    command.env("GIT_TERMINAL_PROMPT", "0");
    let mut child = tree.spawn(&mut command).map_err(|err| err.to_string())?;
    let mut stdin = child.stdin.take();
    let mut stdout = child.stdout.take().ok_or("stdout indisponível")?;
    let mut stderr = child.stderr.take().ok_or("stderr indisponível")?;
    let run = async {
        if let Some(stdin) = stdin.as_mut() {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
        drop(stdin);
        let (mut out, mut err) = (String::new(), String::new());
        let _ = tokio::join!(stdout.read_to_string(&mut out), stderr.read_to_string(&mut err));
        let status = child.wait().await;
        (status.ok().and_then(|s| s.code()), out, err)
    };
    let Ok((code, out, err)) = tokio::time::timeout(Duration::from_secs(30), run).await else {
        let _ = tree.kill();
        return Err("Tempo esgotado ao gerar a mensagem.".into());
    };
    let message = strip_fences(out.trim());
    if code == Some(0) && !message.is_empty() {
        Ok(message)
    } else {
        if !err.trim().is_empty() {
            tracing::warn!(stderr = %err.trim(), "claude -p falhou ao gerar a mensagem de commit");
        }
        Err("Falha ao gerar a mensagem.".into())
    }
}

/// The model sometimes wraps the message in a code fence.
fn strip_fences(text: &str) -> String {
    let mut s = text;
    if let Some(rest) = s.strip_prefix("```") {
        let lang = rest.find('\n').filter(|&i| rest[..i].chars().all(|c| c.is_ascii_lowercase())).map(|i| i + 1).unwrap_or_else(|| rest.chars().take_while(|c| c.is_ascii_lowercase()).count());
        s = &rest[lang..];
    }
    if let Some(rest) = s.strip_suffix("```") {
        s = rest.strip_suffix('\n').unwrap_or(rest);
    }
    s.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_fences_are_removed_like_the_ipc_handler() {
        assert_eq!(strip_fences("```\nAdd x\n```"), "Add x");
        assert_eq!(strip_fences("```text\nAdd x\n\n- y\n```"), "Add x\n\n- y");
        assert_eq!(strip_fences("Add x"), "Add x");
    }
}
