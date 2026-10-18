//! HTTP surface: `/health`, the `/rpc` WebSocket and `/files` (bytes too big
//! for JSON, served by the `fs` domain).

use std::sync::Arc;

use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use prism_protocol::{ErrorCode, HealthResult, ProtocolVersion};
use serde_json::json;

use crate::rpc;
use crate::HostState;

/// Largest JSON-RPC message accepted on the socket.
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

pub fn router(state: Arc<HostState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/rpc", get(rpc_upgrade))
        .route("/files", any(files))
        .with_state(state)
}

async fn health(State(state): State<Arc<HostState>>) -> Json<HealthResult> {
    Json(HealthResult { ok: true, version: state.version.clone(), protocol: ProtocolVersion::CURRENT })
}

async fn rpc_upgrade(ws: WebSocketUpgrade, headers: HeaderMap, State(state): State<Arc<HostState>>) -> Response {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if !origin_allowed(origin) {
        tracing::warn!(origin, "conexão recusada: origem não permitida");
        return (StatusCode::FORBIDDEN, "origem não permitida").into_response();
    }
    ws.max_message_size(MAX_MESSAGE_BYTES).on_upgrade(move |socket| rpc::serve(socket, state))
}

/// `GET`/`PUT /files?path=…` (or `PUT ?temp=<ext>`), with the session token
/// as `Authorization: Bearer`; see `domains::fs::serve_files`.
async fn files(method: Method, uri: Uri, headers: HeaderMap, State(state): State<Arc<HostState>>, body: Body) -> Response {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if !origin_allowed(origin) {
        return error(StatusCode::FORBIDDEN, ErrorCode::Forbidden, "Origem não permitida.");
    }
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if !presented.is_some_and(|token| tokens_match(token, &state.token)) {
        return error(StatusCode::UNAUTHORIZED, ErrorCode::Unauthorized, "Token inválido.");
    }
    crate::domains::fs::serve_files(method, &uri, body).await
}

fn error(status: StatusCode, code: ErrorCode, message: &str) -> Response {
    (status, Json(json!({ "code": code, "message": message }))).into_response()
}

/// Browsers attach an `Origin` to WebSocket handshakes. The host only accepts
/// its own UI: the Electron renderer (`file://`, or the Vite dev server on
/// localhost) and non-browser clients (no `Origin`). A web page elsewhere,
/// including one inside the embedded browser, is refused even before the
/// token check.
pub fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(origin) = origin else { return true };
    if origin == "null" || origin.starts_with("file://") {
        return true;
    }
    let Some(rest) = origin.strip_prefix("http://") else { return false };
    let host = rest.split(':').next().unwrap_or("");
    let port_ok = rest.split_once(':').is_none_or(|(_, port)| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()));
    (host == "localhost" || host == "127.0.0.1") && port_ok && !rest.contains('/')
}

/// Constant-time comparison for tokens of public length.
pub fn tokens_match(presented: &str, expected: &str) -> bool {
    let (a, b) = (presented.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_prism_ui_origins_are_allowed() {
        for ok in [None, Some("null"), Some("file://"), Some("http://localhost:5173"), Some("http://127.0.0.1:4000"), Some("http://localhost")] {
            assert!(origin_allowed(ok), "{ok:?}");
        }
        for bad in [
            Some("https://evil.example"), Some("http://localhost.evil.example"), Some("http://127.0.0.1.nip.io:80"),
            Some("http://localhost:5173/x"), Some("http://localhost:"), Some("https://localhost:5173"), Some("http://10.0.0.2:5173"),
        ] {
            assert!(!origin_allowed(bad), "{bad:?}");
        }
    }

    #[test]
    fn tokens_compare_exactly() {
        assert!(tokens_match("abc", "abc"));
        assert!(!tokens_match("abd", "abc"));
        assert!(!tokens_match("ab", "abc"));
        assert!(!tokens_match("", "abc"));
    }
}
