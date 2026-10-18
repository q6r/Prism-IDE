//! The line transport to a Claude Code process. The real launcher spawns the
//! CLI in its own process tree (`prism-proc`): killing it takes the
//! subagents and tool processes with it. Tests plug in a launcher that
//! replays recorded contracts instead.

use std::io;
use std::process::Stdio;
use std::sync::Arc;

use prism_proc::ProcessTree;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use super::launch::LaunchSpec;

/// What the host writes to the CLI's stdin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    Line(String),
    /// EOF: the CLI finishes what it is doing and exits.
    Close,
}

/// How the process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Exit {
    /// None when killed by a signal (or the code is unknown).
    pub code: Option<i32>,
}

/// A started process.
pub struct Spawned {
    pub input: mpsc::UnboundedSender<Input>,
    /// stdout, one JSON line per message; closes when stdout does.
    pub output: mpsc::UnboundedReceiver<String>,
    pub exit: oneshot::Receiver<Exit>,
    /// Kills the whole process tree.
    pub kill: Box<dyn Fn() + Send + Sync>,
}

pub trait Launcher: Send + Sync + 'static {
    fn launch(&self, spec: &LaunchSpec) -> io::Result<Spawned>;
}

/// Spawns the real CLI.
#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessLauncher;

/// stderr lines kept for the log when a process fails.
const STDERR_TAIL: usize = 4096;

impl Launcher for ProcessLauncher {
    fn launch(&self, spec: &LaunchSpec) -> io::Result<Spawned> {
        let tree = Arc::new(ProcessTree::new()?);
        let mut command = tokio::process::Command::new(&spec.program);
        command.args(&spec.prefix).args(&spec.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        spec.env.apply(&mut command);
        let mut child = tree.spawn(&mut command)?;
        let pid = child.id();
        let mut stdin = child.stdin.take().ok_or_else(|| io::Error::other("stdin indisponível"))?;
        let stdout = child.stdout.take().ok_or_else(|| io::Error::other("stdout indisponível"))?;
        let stderr = child.stderr.take().ok_or_else(|| io::Error::other("stderr indisponível"))?;

        let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Input>();
        tokio::spawn(async move {
            while let Some(input) = input_rx.recv().await {
                match input {
                    Input::Line(line) => {
                        let mut bytes = line.into_bytes();
                        bytes.push(b'\n');
                        if let Err(err) = async {
                            stdin.write_all(&bytes).await?;
                            stdin.flush().await
                        }
                        .await
                        {
                            tracing::debug!(%err, "claude: escrita no stdin falhou (processo encerrado)");
                            return;
                        }
                    }
                    Input::Close => break,
                }
            }
            let _ = stdin.shutdown().await;
        });

        let (output_tx, output_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() && output_tx.send(line).is_err() {
                    break;
                }
            }
        });

        // stderr stays in the host log, never in a transcript.
        let (tail_tx, tail_rx) = oneshot::channel::<String>();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut tail = String::new();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "claude_cli", pid, "{line}");
                tail.push_str(&line);
                tail.push('\n');
                if tail.len() > STDERR_TAIL * 2 {
                    tail.drain(..tail.len() - STDERR_TAIL);
                }
            }
            let _ = tail_tx.send(tail);
        });

        let (exit_tx, exit_rx) = oneshot::channel::<Exit>();
        let waiter_tree = Arc::clone(&tree);
        tokio::spawn(async move {
            let status = child.wait().await;
            // Whatever the CLI left running (background shells) goes with it.
            let _ = waiter_tree.kill();
            let code = status.ok().and_then(|s| s.code());
            if code != Some(0)
                && let Ok(Ok(tail)) = tokio::time::timeout(std::time::Duration::from_secs(2), tail_rx).await
                && !tail.trim().is_empty()
            {
                tracing::warn!(pid, ?code, stderr = %tail.trim(), "claude: processo encerrou com erro");
            }
            let _ = exit_tx.send(Exit { code });
        });

        Ok(Spawned {
            input: input_tx,
            output: output_rx,
            exit: exit_rx,
            kill: Box::new(move || {
                let _ = tree.kill();
            }),
        })
    }
}
