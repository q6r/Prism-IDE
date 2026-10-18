//! `terminal.*`: PTYs that live in the host, so they outlive the window.
//!
//! Output is a stream of UTF-8 text numbered by `seq`, the byte offset just
//! past it. The host keeps the tail of that stream (~2 MB per terminal) and
//! `terminal.attach { since }` replays from any offset still kept, which is
//! how a reopened window or a reconnected socket catches up.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Method and notification names.
pub mod methods {
    pub const INIT: &str = "init";
    pub const SET_CWD: &str = "setCwd";
    pub const CREATE: &str = "create";
    pub const INPUT: &str = "input";
    pub const RESIZE: &str = "resize";
    pub const KILL: &str = "kill";
    pub const ATTACH: &str = "attach";
    pub const LIST: &str = "list";
    /// Notification: `TerminalData`.
    pub const DATA: &str = "terminal.data";
    /// Notification: `TerminalExit`.
    pub const EXIT: &str = "terminal.exit";
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalInitParams {
    /// Accepted for parity with the old IPC; the host answers its default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalSetCwdParams {
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalCreateParams {
    /// Chosen by the UI, one per attempt (`<pane>:<attempt>`), so a retry
    /// never collides with the attempt it replaces.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cols: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rows: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalCreated {
    pub id: String,
    /// False when the id was already running: the caller is subscribed from
    /// `seq` on, without a replay (use `terminal.attach` for one).
    pub created: bool,
    #[ts(type = "number")]
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalInputParams {
    pub id: String,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalResizeParams {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalIdParams {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalAttachParams {
    pub id: String,
    /// The last `seq` the caller has; absent replays everything kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub since: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalAttached {
    pub id: String,
    /// Output from `since` up to `seq`; `terminal.data` continues from `seq`.
    pub data: String,
    #[ts(type = "number")]
    pub seq: u64,
    /// Part of what the caller asked for was already dropped from the ring.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalInfo {
    pub id: String,
    /// The shell's pid, once it started.
    pub pid: Option<u32>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    /// Epoch milliseconds.
    #[ts(type = "number")]
    pub created_at: u64,
    /// Clients currently receiving its output; 0 means nobody shows it.
    pub attached: u32,
    /// Something besides the shell is running in it (keeps the host alive).
    pub busy: bool,
    #[ts(type = "number")]
    pub seq: u64,
}

/// Notification `terminal.data`: output batched over ~16 ms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalData {
    pub id: String,
    pub data: String,
    /// Offset just past `data`.
    #[ts(type = "number")]
    pub seq: u64,
}

/// Notification `terminal.exit`: the shell ended by itself (an explicit
/// `terminal.kill` is never reported).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalExit {
    pub id: String,
    pub code: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn optional_fields_may_be_absent() {
        let create: TerminalCreateParams = serde_json::from_value(json!({ "id": "p:0" })).unwrap();
        assert_eq!((create.cols, create.rows, create.cwd), (None, None, None));
        let attach: TerminalAttachParams = serde_json::from_value(json!({ "id": "p:0", "since": 42 })).unwrap();
        assert_eq!(attach.since, Some(42));
    }

    #[test]
    fn info_is_camel_case() {
        let info = TerminalInfo { id: "a".into(), pid: Some(7), cwd: "/".into(), cols: 80, rows: 24, created_at: 1, attached: 0, busy: false, seq: 3 };
        assert_eq!(serde_json::to_value(info).unwrap()["createdAt"], 1);
    }
}
