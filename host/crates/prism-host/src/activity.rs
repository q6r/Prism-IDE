//! What keeps the host alive: connected clients and "holds" (a running agent
//! turn, a terminal with a foreground process — added by their tickets).
//! With neither for `idle_timeout`, the host shuts itself down.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct Activity {
    clients: AtomicUsize,
    holds: AtomicUsize,
    idle_since: Mutex<Option<Instant>>,
}

/// Decrements its counter when dropped.
#[derive(Debug)]
pub struct ActivityGuard {
    activity: Arc<Activity>,
    client: bool,
}

impl Activity {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { clients: AtomicUsize::new(0), holds: AtomicUsize::new(0), idle_since: Mutex::new(Some(Instant::now())) })
    }

    /// A connected UI client.
    pub fn client(self: &Arc<Self>) -> ActivityGuard {
        self.clients.fetch_add(1, Ordering::SeqCst);
        self.touch();
        ActivityGuard { activity: Arc::clone(self), client: true }
    }

    /// Work that must outlive the clients (a running turn, a busy terminal).
    pub fn hold(self: &Arc<Self>) -> ActivityGuard {
        self.holds.fetch_add(1, Ordering::SeqCst);
        self.touch();
        ActivityGuard { activity: Arc::clone(self), client: false }
    }

    pub fn clients(&self) -> usize {
        self.clients.load(Ordering::SeqCst)
    }

    pub fn holds(&self) -> usize {
        self.holds.load(Ordering::SeqCst)
    }

    /// How long the host has had neither clients nor holds.
    pub fn idle_for(&self) -> Option<Duration> {
        self.idle_since.lock().unwrap().map(|since| since.elapsed())
    }

    fn touch(&self) {
        let busy = self.clients() + self.holds() > 0;
        let mut idle = self.idle_since.lock().unwrap();
        *idle = if busy { None } else { Some(idle.unwrap_or_else(Instant::now)) };
    }
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        let counter = if self.client { &self.activity.clients } else { &self.activity.holds };
        counter.fetch_sub(1, Ordering::SeqCst);
        self.activity.touch();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_only_without_clients_and_holds() {
        let activity = Activity::new();
        assert!(activity.idle_for().is_some());
        let client = activity.client();
        assert!(activity.idle_for().is_none());
        let hold = activity.hold();
        drop(client);
        assert!(activity.idle_for().is_none(), "a hold keeps the host busy without clients");
        drop(hold);
        assert!(activity.idle_for().is_some());
        assert_eq!((activity.clients(), activity.holds()), (0, 0));
    }
}
