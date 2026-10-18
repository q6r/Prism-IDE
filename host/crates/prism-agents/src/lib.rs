//! Prism host agent sessions. The Codex app-server client lands here in T05
//! and the Claude Code native CLI protocol in T06; see
//! `prism-rust-host/tickets/` in the Traycer epic.

pub mod claude;
pub mod codex;
pub mod profile_env;
