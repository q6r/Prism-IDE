//! `remote.*` (T09): controlling a chat from a phone, served by the host.
//!
//! A shared chat gets its own link (a token): it opens a mobile page through
//! a Cloudflare quick tunnel, and that page reads and commands that one chat
//! only. Sharing outlives the window: the host serves the page, builds the
//! chat's snapshot from its own state and runs the phone's commands through
//! the chats engine. Only the owner shares, stops sharing or reads the links
//! (`forbidden` otherwise).
//!
//! The phone's socket speaks the messages of the app's mobile page
//! (`src/main/ipc/remoteControlPage.ts`): it sends `cmd` and `ping`; the
//! host sends `chats`, `state`, `delta`, `ack`, `revoked`, `stopped`, `pong`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Method names of the `remote` domain, and its notification.
pub mod methods {
    /// `ShareParams` → `ShareResult` (owner): starts the page's server and
    /// the tunnel when needed (the first time may download `cloudflared`) and
    /// answers the chat's link; sharing it again answers the same link.
    pub const SHARE: &str = "share";
    /// `ShareParams` → `OkResult` (owner): the chat's link stops working and
    /// its phones are dropped; the last shared chat also closes the tunnel.
    pub const UNSHARE: &str = "unshare";
    /// `{}` → `OkResult` (owner): stops sharing every chat.
    pub const STOP: &str = "stop";
    /// `{}` → `RemoteStatus` (owner).
    pub const STATUS: &str = "status";
    /// Notification: `RemoteStatus`, to every client of the domain, after any
    /// change (a chat shared or not, a phone arriving or leaving, the tunnel
    /// ending).
    pub const CHANGED: &str = "remote.changed";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShareParams {
    pub chat_id: String,
}

/// A shared chat's link: `{baseUrl}/#t={token}&c={chatId}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShareResult {
    pub url: String,
    pub base_url: String,
    pub token: String,
}

/// Why remote control stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum RemoteStopReason {
    /// Asked for (`stop`).
    User,
    /// The last shared chat stopped being shared.
    Empty,
    /// The tunnel ended on its own.
    Tunnel,
    /// The server or the tunnel could not start.
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SharedChat {
    pub chat_id: String,
    /// What the phone lists it as.
    pub title: String,
    pub token: String,
    pub url: String,
    /// Phones connected to this chat's link.
    pub phones: u32,
    /// A turn is running.
    pub streaming: bool,
    /// The running turn waits for an approval or an answer.
    pub pending: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteStatus {
    /// The page's server and the tunnel are up.
    pub running: bool,
    pub base_url: Option<String>,
    /// Phones connected, all chats together.
    pub phones: u32,
    /// The shared chats, in the order they were shared.
    pub chats: Vec<SharedChat>,
    /// On the notification that says it stopped: why.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<RemoteStopReason>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wire_names_match_the_renderer() {
        assert_eq!(serde_json::to_value(RemoteStopReason::Tunnel).unwrap(), json!("tunnel"));
        let status = RemoteStatus { running: false, base_url: None, phones: 0, chats: vec![], reason: Some(RemoteStopReason::Empty) };
        assert_eq!(serde_json::to_value(status).unwrap(), json!({ "running": false, "baseUrl": null, "phones": 0, "chats": [], "reason": "empty" }));
        let share: ShareParams = serde_json::from_value(json!({ "chatId": "c1" })).unwrap();
        assert_eq!(share.chat_id, "c1");
    }
}
