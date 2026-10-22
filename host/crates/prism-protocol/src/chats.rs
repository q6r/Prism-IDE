//! `chats.*` and `tasks.*` (T07): the host owns the agent chats.
//!
//! The host is the only writer of chats, their turns and the run journal, so
//! a turn keeps running with every window closed. A client subscribes
//! (`chats.subscribe`) and gets every chat folded as the UI shows it plus the
//! runtime of the chats the host runs; from then on `chats.delta`
//! notifications carry each change, numbered by `rev` (one counter for the
//! whole host, every subscriber gets every batch), so a client applies each
//! delta once, in order, and drops those its snapshot already reflects. A
//! reconnecting client subscribes again and gets a fresh snapshot.
//!
//! Commands are serialized by the host and answer `busy`, `gone`,
//! `not_found` or `invalid` (pt-BR message) when they do not apply in the
//! chat's current state.
//!
//! Chats, turns, segments, metrics, selections and tasks travel as the JSON
//! of `UnifiedChat`, `SharedTurn`, `SharedSegment`, `RunMetrics`,
//! `AgentSelection` and `AgentTask` (src/shared/agents.ts): the host keeps
//! them as JSON documents and folds the journal like `foldJournal`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

/// Method names of the `chats` domain, and its notification.
pub mod methods {
    /// `{ metadataOnly?: boolean }` → `ChatsSnapshot`; the caller then receives `chats.delta`.
    pub const SUBSCRIBE: &str = "subscribe";
    /// `{}` → `OkResult`.
    pub const UNSUBSCRIBE: &str = "unsubscribe";
    /// `{ metadataOnly?: boolean }` → `ChatsSnapshot`, without subscribing.
    pub const LIST: &str = "list";
    /// `ChatIdParams` → `OkResult`: publish the requested folded chat in an
    /// ordered `ChatDelta::Chat` before acknowledging (chats.history@1).
    pub const LOAD_HISTORY: &str = "loadHistory";
    /// `ChatDocParams` → `OkResult`: a new chat (`invalid` when the id exists).
    pub const CREATE: &str = "create";
    /// `ChatDocParams` → `OkResult`: stores a chat a client runs itself (the
    /// old SSH mode, or Claude while the host has no `claude@1`); `busy`
    /// while the host runs it.
    pub const PUT: &str = "put";
    /// `ChatDocsParams` → `ChatsWritten`: `put` for several chats, skipping
    /// the ones the host runs (the window's last save before closing).
    pub const FLUSH: &str = "flush";
    /// `ChatDocsParams` → `ChatsWritten`: chats created or changed outside a
    /// client (Traycer import and login links), skipping running ones.
    pub const IMPORT_DOCS: &str = "importDocs";
    /// `ConfigureParams` → `OkResult` (`busy` while running).
    pub const CONFIGURE: &str = "configure";
    /// `ChatIdParams` → `OkResult`: an imported chat's account is confirmed.
    pub const CONFIRM_ACCOUNT: &str = "confirmAccount";
    /// `BindWorkspaceParams` → `OkResult` (`busy` while running).
    pub const BIND_WORKSPACE: &str = "bindWorkspace";
    /// `ChangeWorkingDirectoryParams` → `OkResult`; preserves history and route,
    /// resets the native resume only when cwd changes; `busy` while running.
    pub const CHANGE_WORKING_DIRECTORY: &str = "changeWorkingDirectory";
    /// `RenameParams` → `OkResult`.
    pub const RENAME: &str = "rename";
    /// `ArchiveParams` → `OkResult` (archiving is `busy` while running).
    pub const ARCHIVE: &str = "archive";
    /// `SetTaskParams` → `OkResult` (allowed while running).
    pub const SET_TASK: &str = "setTask";
    /// `ChatIdParams` → `OkResult` (`busy` while running).
    pub const REMOVE: &str = "remove";
    /// `ReassignProfileParams` → `Reassigned`: chats of a removed profile
    /// move to its provider's terminal account (`busy` if one runs on it).
    pub const REASSIGN_PROFILE: &str = "reassignProfile";
    /// `SendParams` → `SendResult`: starts a turn (`busy`, `invalid`).
    pub const SEND: &str = "send";
    /// `ChatIdParams` → `OkResult`: stops the running turn, if any.
    pub const STOP: &str = "stop";
    /// `SteerParams` ? `OkResult`: a follow-up in the exact active turn.
    pub const STEER: &str = "steer";
    /// `MessageSubagentParams` -> `{ ok, delivery }`: address an existing native child.
    pub const MESSAGE_SUBAGENT: &str = "messageSubagent";
    /// Shared persisted send queue, addressed by message id.
    pub const QUEUE: &str = "queue";
    /// `PermissionParams` → `OkResult` (`gone` when no longer pending).
    pub const RESPOND_PERMISSION: &str = "respondPermission";
    /// `QuestionParams` → `OkResult` (`gone` when no longer pending).
    pub const RESPOND_QUESTION: &str = "respondQuestion";
    /// `{}` → `BusyProfiles`: the profiles a turn is running on (T08: an
    /// account cannot be disabled, logged in again or relinked meanwhile).
    pub const BUSY_PROFILES: &str = "busyProfiles";
    /// `ProfileRefParams` (providers) → `OkResult`: the chats resuming that
    /// profile's native sessions start new ones (its login changed). `busy`
    /// while one of them runs.
    pub const FORGET_SESSIONS: &str = "forgetSessions";
    /// Notification: `ChatsDeltaBatch`.
    pub const DELTA: &str = "chats.delta";
}

/// Method names of the `tasks` domain (the task tabs of `lib/agentTasks.ts`).
pub mod task_methods {
    /// `{}` → `TasksState`.
    pub const LOAD: &str = "load";
    /// `TasksState` → `OkResult`: replaces every task and the open tabs.
    pub const SAVE: &str = "save";
    /// `TasksMergeParams` → `OkResult`: inserts or replaces these tasks only.
    pub const MERGE: &str = "merge";
}

/// Fast as Claude last reported it for the chat's route (`fastModeOf`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FastReport {
    /// `on`, `off` or `cooldown`.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
}

/// A chat's live state on the host (`ChatRuntime` in lib/agentChats.ts).
/// Memory only: after a host restart nothing runs and nothing is pending.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatRuntime {
    /// The last turn the host ran for this chat.
    pub turn_id: String,
    /// `provider:profileId` of that turn.
    pub route: String,
    pub busy: bool,
    /// The approval the turn waits for (the `agent:permission` payload); the
    /// oldest one when several are pending.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub permission: Option<Value>,
    /// The question the turn waits for (the `agent:question` payload).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub question: Option<Value>,
    /// Claude's last Fast report for this route; survives the turn, cleared
    /// when `configure` changes the route, model or tier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fast: Option<FastReport>,
}

/// Every chat as the UI shows it, and the runtime of the chats the host ran.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatsSnapshot {
    /// The last delta this snapshot reflects: apply only deltas after it.
    #[ts(type = "number")]
    pub rev: u64,
    #[ts(type = "Array<import('../../agents').UnifiedChat>")]
    pub chats: Vec<Value>,
    /// By chat id.
    pub runtime: BTreeMap<String, ChatRuntime>,
}

/// Notification `chats.delta`: consecutive deltas, the last one numbered
/// `rev` (so the first is `rev - deltas.length + 1`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatsDeltaBatch {
    #[ts(type = "number")]
    pub rev: u64,
    pub deltas: Vec<ChatDelta>,
}

/// One change, as the renderer applies it (the operations `agentChats.ts`
/// performs on its own state today).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "camelCase")]
#[ts(export)]
pub enum ChatDelta {
    /// A whole chat as stored: created, imported, saved by a client.
    Chat(ChatUpsert),
    Remove(ChatRef),
    /// Top-level fields of a chat; `null` deletes the field. Never `turns`.
    Patch(ChatPatch),
    /// Inserts (at the end) or replaces one turn, by id.
    Turn(TurnUpsert),
    /// Streamed text or thinking: appended to the turn's last segment when
    /// it has the same kind, else added as a new segment.
    Append(TurnAppend),
    /// Replaces the turn's segment with the same `toolId`, else is added at
    /// the end.
    Segment(TurnSegment),
    /// Merged into the turn's `metrics` (`{ ...metrics, ...delta }`).
    Metrics(TurnMetrics),
    /// The chat's runtime; `null` when the host has none for it.
    Runtime(ChatRuntimeUpdate),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatUpsert {
    #[ts(type = "import('../../agents').UnifiedChat")]
    pub chat: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatRef {
    pub chat_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatPatch {
    pub chat_id: String,
    #[ts(type = "Record<string, unknown>")]
    pub patch: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TurnUpsert {
    pub chat_id: String,
    #[ts(type = "import('../../agents').SharedTurn")]
    pub turn: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum AppendKind {
    Text,
    Thinking,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TurnAppend {
    pub chat_id: String,
    pub turn_id: String,
    pub kind: AppendKind,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TurnSegment {
    pub chat_id: String,
    pub turn_id: String,
    #[ts(type = "import('../../agents').SharedSegment")]
    pub segment: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TurnMetrics {
    pub chat_id: String,
    pub turn_id: String,
    #[ts(type = "import('../../agents').RunMetrics")]
    pub metrics: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatRuntimeUpdate {
    pub chat_id: String,
    pub runtime: Option<ChatRuntime>,
}

// ---- commands ----

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatIdParams {
    pub chat_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatDocParams {
    #[ts(type = "import('../../agents').UnifiedChat")]
    pub chat: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatDocsParams {
    #[ts(type = "Array<import('../../agents').UnifiedChat>")]
    pub chats: Vec<Value>,
}

/// Answer to `flush` and `importDocs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatsWritten {
    pub written: u32,
    /// Ids left as they were because the host is running them.
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConfigureParams {
    pub chat_id: String,
    #[ts(type = "import('../../agents').AgentSelection")]
    pub selection: Value,
}

/// `bindWorkspace` (an imported chat gets its folder). The remote fields are
/// the old SSH mode's: the connection the window shows and its Claude model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BindWorkspaceParams {
    pub chat_id: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub remote_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "{ host: string; port: number; username: string }")]
    pub remote_target: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
}

/// Changes only the folder of an existing chat (chats.working-directory@1).
/// SSH retains its existing target; its directory is checked by the window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChangeWorkingDirectoryParams {
    pub chat_id: String,
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RenameParams {
    pub chat_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ArchiveParams {
    pub chat_id: String,
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SetTaskParams {
    pub chat_id: String,
    /// Absent removes the chat from its task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReassignProfileParams {
    pub profile_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Reassigned {
    pub moved: u32,
}

/// `send`: the composer's message. `serviceTier` is the tier the turn may
/// use (the selection's, only when the catalog says the model honours it)
/// and `profileName` the account's display name for the turn. Both come from
/// the client, worked out over the host's own catalog and accounts
/// (`providers.models`, `providers.list`; T08 kept that calculation there).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SendParams {
    pub chat_id: String,
    pub text: String,
    /// The open file attached as context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub profile_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub images: Option<Vec<ChatImageInput>>,
}

/// A same-turn follow-up. A stale turn id is refused rather than delivered to a newer turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SteerParams {
    pub chat_id: String,
    pub turn_id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub images: Option<Vec<ChatImageInput>>,
}

/// A message to a projected native child, never an independent conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MessageSubagentParams {
    pub chat_id: String,
    pub text: String,
}

/// An image attached to a message. Data contains base64 bytes without a URL prefix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChatImageInput {
    pub mime: String,
    pub data: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    /// Stable number used by later `#image N` references in this chat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub number: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SendResult {
    pub turn_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PermissionDecision {
    Allow,
    AllowAlways,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PermissionParams {
    pub chat_id: String,
    pub perm_id: String,
    pub decision: PermissionDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub updated_input: Option<Value>,
}

/// `respondQuestion`: absent `answers` cancels the question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QuestionParams {
    pub chat_id: String,
    pub dialog_id: String,
    /// Question text → chosen answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answers: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub response: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BusyProfiles {
    pub profile_ids: Vec<String>,
}

// ---- tasks ----

/// `tasks.load`'s answer and `tasks.save`'s params.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TasksState {
    #[ts(type = "Array<import('../../agents').AgentTask>")]
    pub tasks: Vec<Value>,
    pub open_ids: Vec<String>,
    pub active_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TasksMergeParams {
    #[ts(type = "Array<import('../../agents').AgentTask>")]
    pub tasks: Vec<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deltas_are_tagged_by_op_with_camel_case_fields() {
        let append = ChatDelta::Append(TurnAppend { chat_id: "c".into(), turn_id: "t".into(), kind: AppendKind::Thinking, text: "x".into() });
        assert_eq!(serde_json::to_value(&append).unwrap(), json!({ "op": "append", "chatId": "c", "turnId": "t", "kind": "thinking", "text": "x" }));
        let runtime = ChatDelta::Runtime(ChatRuntimeUpdate { chat_id: "c".into(), runtime: None });
        assert_eq!(serde_json::to_value(&runtime).unwrap(), json!({ "op": "runtime", "chatId": "c", "runtime": null }));
        let back: ChatDelta = serde_json::from_value(json!({ "op": "remove", "chatId": "c" })).unwrap();
        assert_eq!(back, ChatDelta::Remove(ChatRef { chat_id: "c".into() }));
    }

    #[test]
    fn runtime_leaves_out_what_is_not_pending() {
        let idle = ChatRuntime { turn_id: "t".into(), route: "claude:ambient-claude".into(), busy: false, permission: None, question: None, fast: None };
        assert_eq!(serde_json::to_value(&idle).unwrap(), json!({ "turnId": "t", "route": "claude:ambient-claude", "busy": false }));
    }

    #[test]
    fn decisions_use_the_renderer_names() {
        assert_eq!(serde_json::to_value(PermissionDecision::AllowAlways).unwrap(), json!("allow_always"));
        let p: QuestionParams = serde_json::from_value(json!({ "chatId": "c", "dialogId": "d" })).unwrap();
        assert_eq!((p.answers, p.response), (None, None));
    }
}
