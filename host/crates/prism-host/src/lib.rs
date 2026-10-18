//! The Prism host: the backend that used to live in the Electron main process,
//! as a standalone daemon. Plan: `prism-rust-host` in the Traycer epic.

pub mod activity;
pub mod domain;
pub mod domains;
pub mod instance;
pub mod logging;
pub mod paths;
pub mod rpc;
pub mod server;
pub mod shutdown;

use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use prism_protocol::{HostInstance, ProtocolVersion};
use tokio::net::TcpListener;

use crate::activity::Activity;
use crate::domain::Domain;
use crate::shutdown::Shutdown;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Everything a request handler can see.
pub struct HostState {
    pub token: String,
    pub host_id: String,
    pub host_name: String,
    pub owner_name: String,
    pub version: String,
    /// `host@1` plus `<name>@<major>` for every registered domain.
    pub capabilities: Vec<String>,
    pub domains: Vec<Arc<dyn Domain>>,
    pub activity: Arc<Activity>,
    pub shutdown: Shutdown,
}

impl std::fmt::Debug for HostState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostState").field("host_id", &self.host_id).field("capabilities", &self.capabilities).finish_non_exhaustive()
    }
}

impl HostState {
    /// A host serving the registered domains (`domains::all`).
    pub fn new(token: String, host_id: String, host_name: String, owner_name: String) -> Arc<Self> {
        Self::with_domains(token, host_id, host_name, owner_name, domains::all())
    }

    pub fn with_domains(token: String, host_id: String, host_name: String, owner_name: String, domains: Vec<Arc<dyn Domain>>) -> Arc<Self> {
        let mut capabilities = vec!["host@1".to_string()];
        capabilities.extend(domains.iter().map(|d| format!("{}@{}", d.name(), d.major())));
        capabilities.extend(domains.iter().flat_map(|domain| domain.features().iter().map(|feature| (*feature).to_string())));
        Arc::new(Self {
            token,
            host_id,
            host_name,
            owner_name,
            version: VERSION.to_string(),
            capabilities,
            domains,
            activity: Activity::new(),
            shutdown: Shutdown::new(),
        })
    }

    /// The domain serving `method` (`fs.readDir` → `fs`).
    pub fn domain_for(&self, method: &str) -> Option<&Arc<dyn Domain>> {
        let prefix = method.split_once('.')?.0;
        self.domains.iter().find(|d| d.name() == prefix)
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub data_dir: PathBuf,
    /// 0 lets the OS pick a free port.
    pub port: u16,
    /// `None` keeps the host up until asked to stop.
    pub idle_timeout: Option<Duration>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Stopped,
    AlreadyRunning,
}

/// Runs the host until it is asked to stop, goes idle or gets a signal.
pub async fn run(config: Config) -> io::Result<Outcome> {
    std::fs::create_dir_all(&config.data_dir)?;
    let _lock = match instance::acquire_lock(&config.data_dir) {
        Ok(lock) => lock,
        Err(instance::LockError::AlreadyRunning) => return Ok(Outcome::AlreadyRunning),
        Err(instance::LockError::Io(err)) => return Err(err),
    };
    paths::set_data_dir(&config.data_dir);
    let state = HostState::new(
        instance::new_token(),
        instance::host_id(&config.data_dir)?,
        paths::host_name(),
        paths::os_user_name(),
    );
    // Loopback only: remote clients arrive through an SSH tunnel or cloudflared.
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, config.port))).await?;
    let port = listener.local_addr()?.port();
    let pid = std::process::id();
    instance::write_instance(
        &config.data_dir,
        &HostInstance {
            pid,
            port,
            host_id: state.host_id.clone(),
            version: VERSION.to_string(),
            protocol: ProtocolVersion::CURRENT,
            started_at: now_ms(),
            token: state.token.clone(),
        },
    )?;
    tracing::info!(port, pid, version = VERSION, dir = %config.data_dir.display(), "host pronto");

    if let Some(timeout) = config.idle_timeout {
        spawn_idle_watcher(Arc::clone(&state), timeout);
    }
    spawn_signal_listener(state.shutdown.clone());
    let result = serve(listener, Arc::clone(&state)).await;
    instance::remove_instance(&config.data_dir, pid);
    result.map(|()| Outcome::Stopped)
}

/// Serves until the shutdown flag is raised.
pub async fn serve(listener: TcpListener, state: Arc<HostState>) -> io::Result<()> {
    let shutdown = state.shutdown.clone();
    axum::serve(listener, server::router(state)).with_graceful_shutdown(async move { shutdown.wait().await }).await
}

pub fn spawn_idle_watcher(state: Arc<HostState>, timeout: Duration) {
    let tick = (timeout / 4).clamp(Duration::from_millis(200), Duration::from_secs(5));
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tick);
        loop {
            interval.tick().await;
            if state.shutdown.is_triggered() {
                return;
            }
            if state.activity.idle_for().is_some_and(|idle| idle >= timeout) {
                state.shutdown.trigger("ocioso, sem clientes nem trabalho em andamento");
                return;
            }
        }
    });
}

fn spawn_signal_listener(shutdown: Shutdown) {
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut term = match signal(SignalKind::terminate()) {
                Ok(term) => term,
                Err(_) => return,
            };
            tokio::select! {
                _ = tokio::signal::ctrl_c() => shutdown.trigger("SIGINT"),
                _ = term.recv() => shutdown.trigger("SIGTERM"),
            }
        }
        #[cfg(not(unix))]
        if tokio::signal::ctrl_c().await.is_ok() {
            shutdown.trigger("Ctrl+C");
        }
    });
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
