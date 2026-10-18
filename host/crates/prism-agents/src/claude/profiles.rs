//! Which CLI and environment a Claude profile runs with. Production uses the
//! shared `profile_env` (port of `providerCommand` / `profileEnvironment`);
//! tests plug in fixed answers.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use crate::profile_env::{self, Profiles, Provider, ProviderCommand};

use super::launch::{CliCommand, LaunchEnv};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait ClaudeProfiles: Send + Sync + 'static {
    /// The CLI's environment for a profile (None: the terminal account), or
    /// why it cannot run (pt-BR). Blocking: small file reads.
    fn environment(&self, profile_id: Option<&str>) -> Result<LaunchEnv, String>;
    /// The CLI to run for a profile, when one is installed.
    fn command<'a>(&'a self, profile_id: Option<&'a str>) -> BoxFuture<'a, Option<CliCommand>>;
    /// The CLI's version (`x.y.z`), when it can be read.
    fn version<'a>(&'a self, command: &'a CliCommand) -> BoxFuture<'a, Option<String>>;
}

impl ClaudeProfiles for Profiles {
    fn environment(&self, profile_id: Option<&str>) -> Result<LaunchEnv, String> {
        let env = Profiles::environment(self, Provider::Claude, profile_id).map_err(|err| err.message)?;
        Ok(LaunchEnv {
            remove: env.remove.iter().map(|k| k.to_string()).collect(),
            set: env.set.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
        })
    }

    fn command<'a>(&'a self, profile_id: Option<&'a str>) -> BoxFuture<'a, Option<CliCommand>> {
        Box::pin(async move { Profiles::command(self, Provider::Claude, profile_id).await.map(|c| CliCommand { program: c.bin, args: c.args }) })
    }

    fn version<'a>(&'a self, command: &'a CliCommand) -> BoxFuture<'a, Option<String>> {
        let command = ProviderCommand { bin: command.program.clone(), args: command.args.clone() };
        Box::pin(async move { Profiles::version(self, &command).await })
    }
}

/// Where the CLI keeps its sessions for an environment: `CLAUDE_CONFIG_DIR`, else `~/.claude`.
pub fn config_dir(env: &LaunchEnv) -> PathBuf {
    env.get("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| profile_env::home_dir().join(".claude"))
}
