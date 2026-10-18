//! Process trees: everything an agent session or terminal starts — the CLI,
//! its tools, the shells they open — belongs to one tree that can be killed
//! as a whole, and dies with the tree's owner.
//!
//! - Windows: a job object with `KILL_ON_JOB_CLOSE`. Children start suspended,
//!   join the job, then resume, so not even an immediate grandchild escapes.
//! - Unix: each spawned child leads its own process group, killed with
//!   `kill(-pgid, SIGKILL)`.
//!
//! Also: `child_pids`/`alive`, used to tell whether a terminal is busy.

use std::io;

use tokio::process::{Child, Command};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as imp;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as imp;

/// Owns every process spawned (or adopted) through it, transitively.
pub struct ProcessTree {
    inner: imp::Tree,
}

impl ProcessTree {
    pub fn new() -> io::Result<Self> {
        Ok(Self { inner: imp::Tree::new()? })
    }

    /// Spawns `command` inside the tree. On Windows it also gets no console
    /// window (the host has none to share).
    pub fn spawn(&self, command: &mut Command) -> io::Result<Child> {
        self.inner.spawn(command)
    }

    /// Brings an already running process (e.g. a PTY's shell) into the tree.
    /// Processes it started before this call are not covered.
    pub fn adopt(&self, pid: u32) -> io::Result<()> {
        self.inner.adopt(pid)
    }

    /// Kills every process in the tree. Safe to call more than once.
    pub fn kill(&self) -> io::Result<()> {
        self.inner.kill()
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        let _ = self.inner.kill();
    }
}

/// Direct children of `pid` (empty when it has none or is gone).
pub fn child_pids(pid: u32) -> Vec<u32> {
    imp::child_pids(pid)
}

/// Whether `pid` is still running.
pub fn alive(pid: u32) -> bool {
    imp::alive(pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    async fn wait_for(mut condition: impl FnMut() -> bool, what: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !condition() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// A parent that keeps a long-lived child of its own.
    fn parent_with_child() -> Command {
        #[cfg(windows)]
        {
            let mut command = Command::new("cmd");
            command.args(["/C", "ping -n 60 127.0.0.1 > nul"]);
            command
        }
        #[cfg(unix)]
        {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 60 & wait"]);
            command
        }
    }

    #[tokio::test]
    async fn killing_the_tree_takes_the_grandchildren_too() {
        let tree = ProcessTree::new().unwrap();
        let mut parent = tree.spawn(&mut parent_with_child()).unwrap();
        let parent_pid = parent.id().unwrap();
        wait_for(|| !child_pids(parent_pid).is_empty(), "the grandchild").await;
        let grandchild = child_pids(parent_pid)[0];
        assert!(alive(parent_pid) && alive(grandchild));

        tree.kill().unwrap();
        parent.wait().await.unwrap();
        wait_for(|| !alive(grandchild), "the grandchild to die").await;
        assert!(!alive(parent_pid));
        tree.kill().unwrap();
    }

    #[tokio::test]
    async fn dropping_the_tree_kills_it() {
        let tree = ProcessTree::new().unwrap();
        let mut parent = tree.spawn(&mut parent_with_child()).unwrap();
        let parent_pid = parent.id().unwrap();
        wait_for(|| !child_pids(parent_pid).is_empty(), "the grandchild").await;
        let grandchild = child_pids(parent_pid)[0];
        drop(tree);
        parent.wait().await.unwrap();
        wait_for(|| !alive(grandchild), "the grandchild to die").await;
    }

    #[tokio::test]
    async fn adopted_processes_die_with_the_tree() {
        let mut outside = parent_with_child().spawn().unwrap();
        let pid = outside.id().unwrap();
        let tree = ProcessTree::new().unwrap();
        tree.adopt(pid).unwrap();
        tree.kill().unwrap();
        outside.wait().await.unwrap();
        assert!(!alive(pid));
    }

    #[test]
    fn unknown_pids_are_neither_alive_nor_parents() {
        assert!(!alive(u32::MAX - 7));
        assert!(child_pids(u32::MAX - 7).is_empty());
        assert!(alive(std::process::id()));
    }
}
