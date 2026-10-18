use std::sync::Arc;

use tokio::sync::watch;

/// One-way "the host is stopping" flag shared by the server, every socket and
/// the idle watcher.
#[derive(Clone, Debug)]
pub struct Shutdown {
    tx: Arc<watch::Sender<bool>>,
}

impl Default for Shutdown {
    fn default() -> Self {
        Self::new()
    }
}

impl Shutdown {
    pub fn new() -> Self {
        let (tx, _rx) = watch::channel(false);
        Self { tx: Arc::new(tx) }
    }

    pub fn trigger(&self, reason: &str) {
        if !self.is_triggered() {
            tracing::info!(reason, "encerrando o host");
        }
        self.tx.send_replace(true);
    }

    pub fn is_triggered(&self) -> bool {
        *self.tx.borrow()
    }

    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.tx.subscribe()
    }

    pub async fn wait(&self) {
        let mut rx = self.subscribe();
        while !*rx.borrow_and_update() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }
}
