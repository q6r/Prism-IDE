use std::io;
use std::sync::Mutex;

use tokio::process::{Child, Command};

pub struct Tree {
    groups: Mutex<Vec<i32>>,
}

impl Tree {
    pub fn new() -> io::Result<Self> {
        Ok(Self { groups: Mutex::new(Vec::new()) })
    }

    pub fn spawn(&self, command: &mut Command) -> io::Result<Child> {
        // The child leads a new process group whose id is its pid.
        command.process_group(0);
        let child = command.spawn()?;
        if let Some(pid) = child.id() {
            self.groups.lock().unwrap().push(pid as i32);
        }
        Ok(child)
    }

    pub fn adopt(&self, pid: u32) -> io::Result<()> {
        // SAFETY: getpgid has no memory-safety preconditions.
        let group = unsafe { libc::getpgid(pid as i32) };
        if group < 0 {
            return Err(io::Error::last_os_error());
        }
        // Never adopt our own group: killing it would kill the host.
        // SAFETY: as above.
        if group == unsafe { libc::getpgid(0) } {
            return Err(io::Error::other("o processo está no grupo do próprio host"));
        }
        self.groups.lock().unwrap().push(group);
        Ok(())
    }

    pub fn kill(&self) -> io::Result<()> {
        for group in self.groups.lock().unwrap().drain(..) {
            // SAFETY: kill has no memory-safety preconditions; ESRCH (already
            // gone) is fine.
            unsafe { libc::kill(-group, libc::SIGKILL) };
        }
        Ok(())
    }
}

pub fn child_pids(pid: u32) -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
    entries
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<u32>().ok())
        .filter(|&candidate| candidate != pid && parent_of(candidate) == Some(pid))
        .collect()
}

/// The parent pid from `/proc/<pid>/stat` (field 4, after the `(comm)`).
fn parent_of(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_comm = &stat[stat.rfind(')')? + 2..];
    let mut fields = after_comm.split_whitespace();
    let state = fields.next()?;
    if state == "Z" {
        return None;
    }
    fields.next()?.parse().ok()
}

pub fn alive(pid: u32) -> bool {
    if pid > i32::MAX as u32 {
        return false;
    }
    // A zombie still answers kill(0); treat it as gone.
    if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat"))
        && let Some(close) = stat.rfind(')')
        && stat[close + 2..].starts_with('Z')
    {
        return false;
    }
    // SAFETY: signal 0 only checks for existence.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}
