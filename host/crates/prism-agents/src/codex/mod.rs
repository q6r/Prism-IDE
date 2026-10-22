//! Codex on the host: a client of `codex app-server --listen stdio://`.
//!
//! - [`server`]: the JSON-RPC client (port of src/main/codexServer.ts).
//! - [`session`]: conversations, approvals, questions and abort (port of
//!   src/main/ipc/nativeCodex.ts), emitting the renderer's `CodexEvent`s.
//! - [`queries`]: the one-shot reads (`model/list`, `skills/list`,
//!   `account/read` + `account/rateLimits/read`) and the manual reset.
//! - [`convert`]: the pure shape conversions they share.
//!
//! Each process runs with its profile's environment and CLI
//! ([`crate::profile_env`]) inside its own process tree.

pub mod convert;
pub mod queries;
pub mod server;
pub mod session;
mod subagents;
mod lifecycle;

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

use crate::profile_env::{ProfileError, ProfileErrorKind, Profiles, Provider};

pub use queries::CodexQueries;
pub use server::AppServer;
pub use session::{CodexEvent, CodexSend, CodexSessions, CodexSink, EventBody, Hold, Owner};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexErrorKind {
    Invalid,
    NotFound,
    Busy,
    /// No Codex CLI to run.
    CliMissing,
    /// The account cannot run (a broken Traycer link).
    CliAuth,
    Failed,
}

/// A failed Codex call; `message` is pt-BR, shown as is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexError {
    pub kind: CodexErrorKind,
    pub message: String,
}

impl CodexError {
    pub fn new(kind: CodexErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(CodexErrorKind::Invalid, message)
    }

    pub fn busy(message: impl Into<String>) -> Self {
        Self::new(CodexErrorKind::Busy, message)
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self::new(CodexErrorKind::Failed, message)
    }
}

impl std::fmt::Display for CodexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CodexError {}

impl From<ProfileError> for CodexError {
    fn from(err: ProfileError) -> Self {
        let kind = match err.kind {
            ProfileErrorKind::NotFound => CodexErrorKind::NotFound,
            ProfileErrorKind::Disabled => CodexErrorKind::Invalid,
            ProfileErrorKind::BrokenLink => CodexErrorKind::CliAuth,
            ProfileErrorKind::Unreadable => CodexErrorKind::Failed,
        };
        Self::new(kind, err.message)
    }
}

pub const CLI_MISSING_MESSAGE: &str = "Instale o Codex para usar esta conta.";

/// Starts app-servers for profiles. Tests swap in a fake server.
pub trait Launcher: Send + Sync + 'static {
    /// The profile exists for Codex (the app's `getProfile`).
    fn check(&self, profile_id: String) -> BoxFuture<'_, Result<(), CodexError>>;
    /// The account a profile runs in once its environment resolves (the
    /// app's `profileEnvironment`): its `CODEX_HOME`, or `ambient`. Two
    /// profiles linked to one Traycer account share it.
    fn account(&self, profile_id: String) -> BoxFuture<'_, Result<String, CodexError>>;
    /// An app-server for the profile, in `cwd` when given.
    fn launch(&self, profile_id: String, cwd: Option<String>) -> BoxFuture<'_, Result<Arc<AppServer>, CodexError>>;
}

/// The real launcher: the profile's CLI (`Profiles::command`) with its environment.
pub struct ProfileLauncher {
    profiles: Profiles,
}

impl ProfileLauncher {
    pub fn new(profiles: Profiles) -> Self {
        Self { profiles }
    }

    async fn environment(&self, profile_id: String) -> Result<crate::profile_env::ProfileEnv, CodexError> {
        let profiles = self.profiles.clone();
        tokio::task::spawn_blocking(move || profiles.environment(Provider::Codex, Some(&profile_id)))
            .await
            .map_err(|err| CodexError::failed(err.to_string()))?
            .map_err(CodexError::from)
    }
}

impl Launcher for ProfileLauncher {
    fn check(&self, profile_id: String) -> BoxFuture<'_, Result<(), CodexError>> {
        let profiles = self.profiles.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || profiles.get(Provider::Codex, &profile_id).map(|_| ()))
                .await
                .map_err(|err| CodexError::failed(err.to_string()))?
                .map_err(CodexError::from)
        })
    }

    fn account(&self, profile_id: String) -> BoxFuture<'_, Result<String, CodexError>> {
        Box::pin(async move {
            let env = self.environment(profile_id).await?;
            Ok(match env.get("CODEX_HOME").filter(|h| !h.is_empty()) {
                Some(home) => {
                    let home = home.to_string_lossy();
                    let home = home.trim_end_matches(['/', '\\']);
                    if cfg!(windows) { home.to_lowercase() } else { home.to_string() }
                }
                None => "ambient".to_string(),
            })
        })
    }

    fn launch(&self, profile_id: String, cwd: Option<String>) -> BoxFuture<'_, Result<Arc<AppServer>, CodexError>> {
        Box::pin(async move {
            let command = self.profiles.command(Provider::Codex, Some(&profile_id)).await.ok_or_else(|| CodexError::new(CodexErrorKind::CliMissing, CLI_MISSING_MESSAGE))?;
            let env = self.environment(profile_id.clone()).await?;
            AppServer::spawn(&command, &env, profile_id.starts_with("ambient-"), cwd.as_deref().map(Path::new))
                .map_err(|err| CodexError::failed(format!("Não foi possível iniciar o Codex: {err}")))
        })
    }
}

#[cfg(test)]
mod tests;
