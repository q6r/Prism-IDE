//! `providers.*` and `usage.*` (T08): the accounts the agents run on, their
//! logins, limits and model catalogs, and the Usage records, all on the host.
//!
//! Profiles are stored by the host. Their logins stay in the app's data
//! folder (`provider-profiles/<id>`, next to the Electron app's own data on a
//! desktop host): never copied, because a copy forks one rotating refresh
//! token between two places. Managing accounts (create, change, remove, log
//! in, link, spend a reset) is the owner's (`forbidden` otherwise); reading
//! them is everyone's.
//!
//! Profiles, statuses, details, models and selections travel as the JSON of
//! `ProviderProfile`, `ProfileStatus`, `ProfileDetails` and `AgentModel`
//! (src/shared/agents.ts), and the Usage records as `UsageRecordsResponse`
//! (src/shared/usage.ts).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// Method names of the `providers` domain, and its notifications.
pub mod methods {
    /// `{}` → `ProfilesList` (the terminal accounts first; removed ones too,
    /// tombstoned, so old references still read as removed).
    pub const LIST: &str = "list";
    /// `CreateProfileParams` → the new `ProviderProfile` (owner).
    pub const CREATE: &str = "create";
    /// `UpdateProfileParams` → `ProfilesList` (owner). Disabling waits for the
    /// profile's running turns (`busy`).
    pub const UPDATE: &str = "update";
    /// `RenameProfileParams` → `ProfilesList` (owner).
    pub const RENAME: &str = "rename";
    /// `ProfileIdParams` → `ProfilesList` (owner): tombstoned, its chats moved
    /// to the terminal account, its processes and login ended, its own folder
    /// deleted (or moved to the trash when locked). `busy` while it runs.
    pub const REMOVE: &str = "remove";
    /// `ProfileRefParams` → `ProfileStatus`: is the CLI installed, is the
    /// account logged in.
    pub const STATUS: &str = "status";
    /// `LoginParams` → `LoginStarted` (owner): the CLI's login in a terminal
    /// on the host, streamed to the caller as `providers.login`.
    pub const LOGIN: &str = "login";
    /// `LoginInputParams` → `OkResult` (owner, the client that started it).
    pub const LOGIN_INPUT: &str = "loginInput";
    /// `LoginResizeParams` → `OkResult`.
    pub const LOGIN_RESIZE: &str = "loginResize";
    /// `LoginCancelParams` → `OkResult`.
    pub const LOGIN_CANCEL: &str = "loginCancel";
    /// `DetailsParams` → `ProfileDetails`: limits, plan, resets. Cached 1 min
    /// (30 s after a failure, which keeps the last reading, marked stale).
    pub const DETAILS: &str = "details";
    /// `CatalogParams` → `AgentModel[]`, cached 5 min.
    pub const MODELS: &str = "models";
    /// `CommandsParams` → `AgentCommand[]` (the `/` menu), cached 5 min per
    /// account and folder.
    pub const COMMANDS: &str = "commands";
    /// `CodexResetParams` → `CodexResetResult` (owner): spends one real manual
    /// reset; the idempotency key makes a retried click safe.
    pub const CODEX_RESET: &str = "codexReset";
    /// `AvailableParams` → `CliAvailability`.
    pub const AVAILABLE: &str = "available";
    /// `{}` → `StoredProfilesList` (owner): the profiles with their Traycer
    /// links, for the desktop's Traycer import.
    pub const STORED: &str = "stored";
    /// `ImportProfilesParams` → `ProfilesList` (owner): inserts or replaces
    /// these profiles (the Traycer import).
    pub const IMPORT_PROFILES: &str = "importProfiles";
    /// `SetLinkParams` → `ProfilesList` (owner): links a profile to a Traycer
    /// account's login (or unlinks it). `busy` while the profile runs.
    pub const SET_LINK: &str = "setLink";
    /// Notification: `ProfilesList`, after any change, to every client.
    pub const CHANGED: &str = "providers.changed";
    /// Notification: `LoginEvent`, to the client running the login.
    pub const LOGIN_EVENT: &str = "providers.login";
}

/// Method names of the `usage` domain.
pub mod usage_methods {
    /// `{}` → `UsageRecordsResponse`: Prism's turns (the chats and their
    /// journal) and the Traycer turns the desktop imported.
    pub const RECORDS: &str = "records";
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProfilesList {
    #[ts(type = "Array<import('../../agents').ProviderProfile>")]
    pub profiles: Vec<Value>,
}

/// The profiles as stored, Traycer links included (`credentialLink`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StoredProfilesList {
    #[ts(type = "Array<import('../../agents').ProviderProfile & { credentialLink?: import('./CredentialLink').CredentialLink }>")]
    pub profiles: Vec<Value>,
}

/// Where a linked profile's login lives: a Traycer installation's account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CredentialLink {
    /// The `.traycer` folder.
    pub root: String,
    /// Traycer's provider id (`claude-code`, `codex`).
    pub provider_id: String,
    pub profile_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreateProfileParams {
    #[ts(type = "import('../../agents').Provider")]
    pub provider: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateProfileParams {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    /// `#rrggbb`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RenameProfileParams {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProfileIdParams {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProfileRefParams {
    #[ts(type = "import('../../agents').Provider")]
    pub provider: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LoginParams {
    #[ts(type = "import('../../agents').Provider")]
    pub provider: String,
    pub id: String,
    /// Chosen by the caller (`[\w-]{1,64}`) so it can match events that
    /// arrive before the answer; the host picks one otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cols: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LoginStarted {
    pub session: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LoginInputParams {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LoginResizeParams {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LoginCancelParams {
    pub id: String,
    /// Limits the cancel to that login, so a stale cancel never ends a newer one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum LoginEventKind {
    Data,
    Exit,
}

/// Notification `providers.login` (`LoginEvent` of src/shared/agents.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LoginEvent {
    pub profile_id: String,
    pub session: String,
    pub kind: LoginEventKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DetailsParams {
    #[ts(type = "import('../../agents').Provider")]
    pub provider: String,
    pub profile_id: String,
    #[serde(default)]
    #[ts(optional)]
    pub refresh: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogParams {
    #[ts(type = "import('../../agents').Provider")]
    pub provider: String,
    pub profile_id: String,
    #[serde(default)]
    #[ts(optional)]
    pub refresh: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommandsParams {
    #[ts(type = "import('../../agents').Provider")]
    pub provider: String,
    pub profile_id: String,
    /// The folder whose project commands and skills count.
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    #[ts(optional)]
    pub refresh: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum AgentCommandKind {
    SlashCommand,
    Skill,
}

/// One row of the provider's own `/` catalog (Traycer's GuiAgentCommandOption).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentCommand {
    /// Without the leading slash.
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
    pub kind: AgentCommandKind,
    /// The CLI's own command, as opposed to a user, project, plugin or MCP one.
    pub builtin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CodexResetParams {
    pub profile_id: String,
    pub idempotency_key: String,
    pub credit_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum CodexResetOutcome {
    #[serde(rename = "reset")]
    Reset,
    #[serde(rename = "nothingToReset")]
    NothingToReset,
    #[serde(rename = "noCredit")]
    NoCredit,
    #[serde(rename = "alreadyRedeemed")]
    AlreadyRedeemed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CodexResetResult {
    pub outcome: CodexResetOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AvailableParams {
    #[ts(type = "import('../../agents').Provider")]
    pub provider: String,
}

/// Is the provider's CLI installed here, and is its version one Prism verified?
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CliAvailability {
    pub available: bool,
    /// The CLI's own `--version` line; empty when unavailable.
    pub version: String,
    /// Absent when Prism has no verified range for this provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub verified: Option<bool>,
    /// pt-BR, when the version is not a verified one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportProfilesParams {
    #[ts(type = "Array<import('../../agents').ProviderProfile & { credentialLink?: import('./CredentialLink').CredentialLink }>")]
    pub profiles: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SetLinkParams {
    pub id: String,
    /// `null` unlinks: the profile goes back to its own login.
    pub link: Option<CredentialLink>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wire_names_match_the_renderer() {
        assert_eq!(serde_json::to_value(AgentCommandKind::SlashCommand).unwrap(), json!("slash-command"));
        assert_eq!(serde_json::to_value(CodexResetOutcome::NothingToReset).unwrap(), json!("nothingToReset"));
        let event = LoginEvent { profile_id: "p".into(), session: "s".into(), kind: LoginEventKind::Exit, text: None, code: Some(0) };
        assert_eq!(serde_json::to_value(event).unwrap(), json!({ "profileId": "p", "session": "s", "kind": "exit", "code": 0 }));
        let unlink: SetLinkParams = serde_json::from_value(json!({ "id": "p", "link": null })).unwrap();
        assert_eq!(unlink.link, None);
    }
}
