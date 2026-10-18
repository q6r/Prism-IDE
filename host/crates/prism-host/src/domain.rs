//! How a backend area (files, git, terminals, agents…) plugs into the host.
//!
//! A domain owns the methods `<name>.<verb>` and is advertised to clients as
//! the capability `<name>@<major>`, which is what makes the UI route that
//! `window.prism` domain to the host (src/shared/host/routing.ts). Domains are
//! listed in `crate::domains::all`; nothing else in the server changes when
//! one is added.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use prism_protocol::{HostError, RpcNotification, UserInfo};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::HostState;

pub type HandlerFuture = Pin<Box<dyn Future<Output = Result<Value, HostError>> + Send>>;

/// Identifies one connected client (one socket) for subscription bookkeeping.
pub type ClientId = u64;

static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);

pub fn next_client_id() -> ClientId {
    NEXT_CLIENT.fetch_add(1, Ordering::Relaxed)
}

/// Pushes notifications to one client; cheap to clone and keep (e.g. by a
/// terminal that streams output to its subscribers).
#[derive(Clone, Debug)]
pub struct Notifier {
    pub client: ClientId,
    tx: mpsc::UnboundedSender<String>,
}

impl Notifier {
    pub fn new(client: ClientId, tx: mpsc::UnboundedSender<String>) -> Self {
        Self { client, tx }
    }

    /// False once the client is gone, so holders can drop their subscription.
    pub fn send(&self, method: &str, params: Value) -> bool {
        let note = RpcNotification::new(method, params);
        match serde_json::to_string(&note) {
            Ok(text) => self.tx.send(text).is_ok(),
            Err(_) => false,
        }
    }

    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
}

/// Everything a call can see about its caller and the host.
#[derive(Clone)]
pub struct CallContext {
    pub user: UserInfo,
    pub notifier: Notifier,
    pub state: Arc<HostState>,
}

pub trait Domain: Send + Sync + 'static {
    /// Method prefix: `fs` serves `fs.readDir`, `fs.writeFile`…
    fn name(&self) -> &'static str;

    /// Advertised as `<name>@<major>`; bump on breaking changes.
    fn features(&self) -> &'static [&'static str] { &[] }

    fn major(&self) -> u32 {
        1
    }

    /// Starts `<name>.<method>`; `None` answers `method_not_found`. The future
    /// runs on its own task, so long calls never block the socket.
    fn call(&self, method: &str, params: Value, ctx: CallContext) -> Option<HandlerFuture>;

    /// The client's socket closed: drop whatever was kept for it.
    fn disconnected(&self, _client: ClientId) {}
}

/// Parses call params into a typed struct, answering `invalid` on mismatch.
pub fn params<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, HostError> {
    serde_json::from_value(value)
        .map_err(|err| HostError::new(prism_protocol::ErrorCode::Invalid, format!("Parâmetros inválidos: {err}")))
}
