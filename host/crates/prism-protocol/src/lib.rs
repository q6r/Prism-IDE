//! Prism host wire protocol.
//!
//! The UI talks to the host over one WebSocket (`/rpc`) carrying JSON-RPC 2.0:
//! requests with responses, plus host-to-client notifications for
//! subscriptions. The first request on a socket must be `host.hello`.
//! Every type here is the single source of truth for both sides: the
//! TypeScript in `src/shared/host/generated/` is produced from it by
//! `npm run host:types` (ts-rs) and checked for drift by the test suite.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

// Domain entities (T03): files, search, git, Claude sessions and commands.
pub mod fs;
pub mod git;
pub mod search;
pub mod sessions;
// Terminals (T04): PTYs with scrollback.
pub mod terminal;
// Chats and tasks owned by the host (T07).
pub mod chats;
// Accounts, logins, limits, catalogs and Usage on the host (T08).
pub mod providers;
// Remote control from a phone (T09).
pub mod remote;

/// Bumped on any breaking wire change; a client and host with different
/// majors refuse each other (`version_mismatch`).
pub const PROTOCOL_MAJOR: u32 = 1;
/// Bumped on additive changes; differences surface as `capabilities`.
pub const PROTOCOL_MINOR: u32 = 1;
pub const JSONRPC: &str = "2.0";

/// Method names. Domains added by later tickets follow `<domain>.<verb>`.
pub mod methods {
    pub const HELLO: &str = "host.hello";
    pub const PING: &str = "host.ping";
    pub const SHUTDOWN: &str = "host.shutdown";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProtocolVersion {
    pub major: u32,
    pub minor: u32,
}

impl ProtocolVersion {
    pub const CURRENT: Self = Self { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR };

    /// Same major: the minor difference is negotiated through capabilities.
    pub fn compatible_with(&self, other: &Self) -> bool {
        self.major == other.major
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ClientKind {
    Desktop,
    Web,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ClientInfo {
    pub kind: ClientKind,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelloParams {
    pub protocol: ProtocolVersion,
    pub client: ClientInfo,
    pub token: String,
}

/// Shared workspace roles: the owner manages access, accounts and the host
/// itself; members use everything else (see protocol-and-state in the plan).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Role {
    Owner,
    Member,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UserInfo {
    pub id: String,
    pub name: String,
    pub role: Role,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelloResult {
    pub host_id: String,
    pub host_name: String,
    pub version: String,
    pub protocol: ProtocolVersion,
    /// `<domain>@<major>` entries, e.g. `host@1`. The UI routes a domain to
    /// the host only when it is listed here.
    pub capabilities: Vec<String>,
    pub user: UserInfo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PingResult {
    pub pong: bool,
    /// Host clock, epoch milliseconds.
    #[ts(type = "number")]
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OkResult {
    pub ok: bool,
}

/// `GET /health`: unauthenticated liveness used by the supervisor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HealthResult {
    pub ok: bool,
    pub version: String,
    pub protocol: ProtocolVersion,
}

/// What the host writes to `<data>/host-instance.json` (readable only by the
/// OS user that runs it). The local token in it is the owner's credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HostInstance {
    pub pid: u32,
    pub port: u16,
    pub host_id: String,
    pub version: String,
    pub protocol: ProtocolVersion,
    #[ts(type = "number")]
    pub started_at: u64,
    pub token: String,
}

/// Stable error codes; the message travels in pt-BR (the product language).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ErrorCode {
    Busy,
    Gone,
    Forbidden,
    NotFound,
    VersionMismatch,
    CliMissing,
    CliAuth,
    Invalid,
    Unauthorized,
    MethodNotFound,
    Internal,
}

impl ErrorCode {
    /// JSON-RPC numeric code: the standard ones where they fit, else the
    /// implementation-defined server error with the string code in `data`.
    pub fn rpc_code(self) -> i64 {
        match self {
            ErrorCode::MethodNotFound => -32601,
            ErrorCode::Invalid => -32602,
            ErrorCode::Internal => -32603,
            _ => -32000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RpcErrorData {
    pub code: ErrorCode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RpcError {
    #[ts(type = "number")]
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub data: Option<RpcErrorData>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RpcRequest {
    pub jsonrpc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | string")]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RpcResponse {
    pub jsonrpc: String,
    #[ts(type = "number | string | null")]
    pub id: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub params: Option<Value>,
}

/// A failed call: what the domains return and the server turns into an
/// `RpcError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostError {
    pub code: ErrorCode,
    pub message: String,
}

impl HostError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn to_rpc(&self) -> RpcError {
        RpcError { code: self.code.rpc_code(), message: self.message.clone(), data: Some(RpcErrorData { code: self.code }) }
    }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for HostError {}

impl RpcResponse {
    pub fn ok(id: Value, result: Value) -> Self {
        Self { jsonrpc: JSONRPC.into(), id, result: Some(result), error: None }
    }

    pub fn err(id: Value, error: &HostError) -> Self {
        Self { jsonrpc: JSONRPC.into(), id, result: None, error: Some(error.to_rpc()) }
    }
}

impl RpcNotification {
    pub fn new(method: impl Into<String>, params: Value) -> Self {
        Self { jsonrpc: JSONRPC.into(), method: method.into(), params: Some(params) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hello_round_trips_in_camel_case() {
        let raw = json!({
            "protocol": { "major": 1, "minor": 3 },
            "client": { "kind": "desktop", "version": "0.2.0" },
            "token": "abc"
        });
        let hello: HelloParams = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(hello.client.kind, ClientKind::Desktop);
        assert_eq!(serde_json::to_value(&hello).unwrap(), raw);
    }

    #[test]
    fn versions_are_compatible_only_within_a_major() {
        let current = ProtocolVersion::CURRENT;
        assert!(current.compatible_with(&ProtocolVersion { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR + 7 }));
        assert!(!current.compatible_with(&ProtocolVersion { major: PROTOCOL_MAJOR + 1, minor: 0 }));
    }

    #[test]
    fn errors_carry_the_string_code_in_data() {
        let err = HostError::new(ErrorCode::VersionMismatch, "Atualize o Prism ou o host.");
        let rpc = serde_json::to_value(RpcResponse::err(json!(7), &err)).unwrap();
        assert_eq!(rpc, json!({
            "jsonrpc": "2.0", "id": 7,
            "error": { "code": -32000, "message": "Atualize o Prism ou o host.", "data": { "code": "version_mismatch" } }
        }));
        assert_eq!(ErrorCode::MethodNotFound.rpc_code(), -32601);
    }

    #[test]
    fn request_without_id_is_a_notification_shape() {
        let req: RpcRequest = serde_json::from_value(json!({ "jsonrpc": "2.0", "method": "host.ping" })).unwrap();
        assert!(req.id.is_none() && req.params.is_none());
    }
}
