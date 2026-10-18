//! How a Claude Code process is started: the Agent SDK's option → flag and
//! environment mapping (`sdk.mjs`, ProcessTransport.initialize and the query
//! builder) for exactly the options Prism used, checked against the recorded
//! contracts (`host/fixtures/claude/<version>/*/meta.json`).

use std::ffi::OsString;
use std::path::PathBuf;

/// Variables of the session that spawned the host (a Claude Code or Traycer
/// terminal running `npm run dev`, say). The CLI reads them as its own
/// identity and messaging channel, so they never reach a child CLI.
const INHERITED_SESSION_VARS: [&str; 14] = [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
    "CLAUDE_CODE_SDK_READS_SESSION_STATE",
    "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
    "NODE_OPTIONS",
];

/// What the CLI reports as its entrypoint for a process driven over the
/// stream-json protocol (the CLI picks it itself for `-p` without one).
pub const ENTRYPOINT: &str = "sdk-cli";

/// Environment changes over the host's own, applied in order: remove, then set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchEnv {
    pub remove: Vec<String>,
    pub set: Vec<(String, OsString)>,
}

impl LaunchEnv {
    pub fn apply(&self, command: &mut tokio::process::Command) {
        for key in &self.remove {
            command.env_remove(key);
        }
        for (key, value) in &self.set {
            command.env(key, value);
        }
    }

    /// The value the CLI will see for `key`.
    pub fn get(&self, key: &str) -> Option<OsString> {
        let same = |k: &str| if cfg!(windows) { k.eq_ignore_ascii_case(key) } else { k == key };
        if let Some((_, v)) = self.set.iter().rev().find(|(k, _)| same(k)) {
            return Some(v.clone());
        }
        if self.remove.iter().any(|k| same(k)) {
            return None;
        }
        std::env::var_os(key)
    }

    fn set(&mut self, key: &str, value: &str) {
        self.set.push((key.to_string(), value.into()));
    }
}

/// One process to start.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub program: PathBuf,
    /// Leading arguments of the CLI itself (`node cli.js` for an npm install).
    pub prefix: Vec<OsString>,
    /// The protocol arguments (what the contracts record).
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: LaunchEnv,
}

/// The CLI to run: `program` alone, or `program` + script for an npm install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliCommand {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

/// The chat options that shape a session process.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionOptions {
    pub model: Option<String>,
    pub permission_mode: String,
    /// Already mapped (`ultra` → `max`); None for Haiku.
    pub effort: Option<String>,
    /// `adaptive` / `disabled`; None for Haiku.
    pub thinking: Option<&'static str>,
    pub resume: Option<String>,
    pub fast: bool,
}

impl SessionOptions {
    /// claudeAgent.ts's options for a chat send: effort and thinking are
    /// never sent for Haiku, Fast is explicit both ways.
    pub fn from_chat(model: &str, effort: Option<&str>, thinking: Option<bool>, permission_mode: Option<&str>, resume: Option<&str>, service_tier: Option<&str>) -> Self {
        let haiku = model == "haiku" || model.starts_with("claude-haiku");
        Self {
            model: (!model.is_empty()).then(|| model.to_string()),
            permission_mode: permission_mode.filter(|m| !m.is_empty()).unwrap_or("default").to_string(),
            effort: if haiku { None } else { effort.filter(|e| !e.is_empty()).map(|e| if e == "ultra" { "max".into() } else { e.to_string() }) },
            thinking: if haiku { None } else { Some(if thinking == Some(false) { "disabled" } else { "adaptive" }) },
            resume: resume.filter(|r| !r.is_empty()).map(str::to_string),
            fast: service_tier == Some("fast"),
        }
    }
}

const BASE_ARGS: [&str; 5] = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];

/// A live chat session: streaming input, permissions over stdio, partial messages.
pub fn session_args(o: &SessionOptions) -> Vec<String> {
    let mut args: Vec<String> = BASE_ARGS.iter().map(|s| s.to_string()).collect();
    if let Some(thinking) = o.thinking {
        args.push(format!("--thinking={thinking}"));
    }
    if let Some(effort) = &o.effort {
        args.push(format!("--effort={effort}"));
    }
    if let Some(model) = &o.model {
        args.push(format!("--model={model}"));
    }
    args.push("--permission-prompt-tool=stdio".into());
    if let Some(resume) = &o.resume {
        args.push(format!("--resume={resume}"));
    }
    args.push("--setting-sources=user,project,local".into());
    args.push(format!("--permission-mode={}", o.permission_mode));
    args.push("--include-partial-messages".into());
    args.push("--forward-subagent-text".into());
    args.push("--settings".into());
    args.push(format!("{{\"fastMode\":{}}}", o.fast));
    args
}

/// The rewind process: the session resumed without a prompt, only to answer `rewind_files`.
pub fn rewind_args(session_id: &str) -> Vec<String> {
    let mut args: Vec<String> = BASE_ARGS.iter().map(|s| s.to_string()).collect();
    args.push(format!("--resume={session_id}"));
    args.push("--setting-sources=user,project,local".into());
    args.push("--permission-mode=bypassPermissions".into());
    args
}

/// Metadata reads (models, commands, usage): no transcript is written.
pub fn metadata_args(setting_sources: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = BASE_ARGS.iter().map(|s| s.to_string()).collect();
    if let Some(sources) = setting_sources {
        args.push(format!("--setting-sources={sources}"));
    }
    args.push("--no-session-persistence".into());
    args
}

/// What the process is for, which decides the SDK's environment additions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Session,
    Rewind,
    Metadata,
}

/// The profile's environment plus what the SDK adds for `purpose`.
pub fn launch_env(profile: LaunchEnv, purpose: Purpose) -> LaunchEnv {
    let mut env = profile;
    env.remove.extend(INHERITED_SESSION_VARS.iter().map(|s| s.to_string()));
    if std::env::var_os("DEBUG_CLAUDE_AGENT_SDK").is_some() {
        env.set("DEBUG", "1");
    } else {
        env.remove.push("DEBUG".into());
    }
    env.set("CLAUDE_CODE_ENTRYPOINT", ENTRYPOINT);
    if purpose != Purpose::Metadata {
        env.set("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "true");
    }
    env.set("CLAUDE_CODE_SDK_READS_SESSION_STATE", "1");
    if purpose == Purpose::Session {
        env.set("CLAUDE_CODE_QUESTION_PREVIEW_FORMAT", "markdown");
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(model: &str, effort: Option<&str>, thinking: Option<bool>, mode: Option<&str>, resume: Option<&str>, tier: Option<&str>) -> Vec<String> {
        session_args(&SessionOptions::from_chat(model, effort, thinking, mode, resume, tier))
    }

    // The same four routes the `args` contract recorded from the SDK.
    #[test]
    fn chat_options_map_to_the_sdk_flags() {
        assert_eq!(args("sonnet", Some("high"), None, Some("default"), None, None).join(" "),
            "--output-format stream-json --verbose --input-format stream-json --thinking=adaptive --effort=high --model=sonnet --permission-prompt-tool=stdio --setting-sources=user,project,local --permission-mode=default --include-partial-messages --forward-subagent-text --settings {\"fastMode\":false}");
        assert_eq!(args("opus", Some("ultra"), Some(false), Some("plan"), Some("resume-id"), Some("fast")).join(" "),
            "--output-format stream-json --verbose --input-format stream-json --thinking=disabled --effort=max --model=opus --permission-prompt-tool=stdio --resume=resume-id --setting-sources=user,project,local --permission-mode=plan --include-partial-messages --forward-subagent-text --settings {\"fastMode\":true}");
        assert_eq!(args("claude-haiku-4-5", Some("max"), None, Some("acceptEdits"), None, None).join(" "),
            "--output-format stream-json --verbose --input-format stream-json --model=claude-haiku-4-5 --permission-prompt-tool=stdio --setting-sources=user,project,local --permission-mode=acceptEdits --include-partial-messages --forward-subagent-text --settings {\"fastMode\":false}");
        assert_eq!(args("", None, Some(true), Some("bypassPermissions"), None, None).join(" "),
            "--output-format stream-json --verbose --input-format stream-json --thinking=adaptive --permission-prompt-tool=stdio --setting-sources=user,project,local --permission-mode=bypassPermissions --include-partial-messages --forward-subagent-text --settings {\"fastMode\":false}");
    }

    // tests/claude-fast.test.cjs: the setting is { fastMode: bool }, true only for the fast tier.
    #[test]
    fn fast_mode_is_explicit_both_ways() {
        for (tier, expected) in [(Some("fast"), true), (Some(""), false), (None, false), (Some("flex"), false), (Some("FAST"), false)] {
            let a = args("sonnet", Some("high"), None, None, None, tier);
            assert_eq!(a.last().unwrap(), &format!("{{\"fastMode\":{expected}}}"), "{tier:?}");
        }
    }

    #[test]
    fn the_sdk_environment_is_added_and_inherited_sessions_dropped() {
        let env = launch_env(LaunchEnv::default(), Purpose::Session);
        assert_eq!(env.get("CLAUDE_CODE_ENTRYPOINT").unwrap(), ENTRYPOINT);
        assert_eq!(env.get("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING").unwrap(), "true");
        assert_eq!(env.get("CLAUDE_CODE_QUESTION_PREVIEW_FORMAT").unwrap(), "markdown");
        assert!(env.remove.iter().any(|k| k == "CLAUDE_CODE_MESSAGING_TOKEN"));
        let meta = launch_env(LaunchEnv::default(), Purpose::Metadata);
        assert!(meta.set.iter().all(|(k, _)| k != "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING" && k != "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT"));
    }
}
