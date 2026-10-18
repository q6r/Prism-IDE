//! Single-instance lock, the local owner token and `host-instance.json`.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use prism_protocol::HostInstance;

pub const INSTANCE_FILE: &str = "host-instance.json";
pub const LOCK_FILE: &str = "host.lock";
pub const HOST_ID_FILE: &str = "host-id";

/// Held for the life of the process; the OS releases it if the host dies.
#[derive(Debug)]
pub struct InstanceLock {
    _file: File,
}

#[derive(Debug)]
pub enum LockError {
    AlreadyRunning,
    Io(io::Error),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::AlreadyRunning => write!(f, "outro prism-host já está usando este diretório de dados"),
            LockError::Io(err) => write!(f, "não foi possível travar o diretório de dados: {err}"),
        }
    }
}

pub fn acquire_lock(dir: &Path) -> Result<InstanceLock, LockError> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join(LOCK_FILE))
        .map_err(LockError::Io)?;
    match file.try_lock() {
        Ok(()) => Ok(InstanceLock { _file: file }),
        Err(fs::TryLockError::WouldBlock) => Err(LockError::AlreadyRunning),
        Err(fs::TryLockError::Error(err)) => Err(LockError::Io(err)),
    }
}

/// 256 random bits, hex encoded.
pub fn new_token() -> String {
    random_hex(32)
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the OS random source is unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// A stable id for this host, created once per data directory.
pub fn host_id(dir: &Path) -> io::Result<String> {
    let path = dir.join(HOST_ID_FILE);
    if let Ok(existing) = fs::read_to_string(&path) {
        let existing = existing.trim();
        if existing.len() >= 16 && existing.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return Ok(existing.to_string());
        }
    }
    let id = random_hex(16);
    write_private(&path, id.as_bytes())?;
    Ok(id)
}

pub fn instance_path(dir: &Path) -> PathBuf {
    dir.join(INSTANCE_FILE)
}

/// Written atomically (temp file + rename) and readable only by the OS user:
/// the token in it is the local owner's credential.
pub fn write_instance(dir: &Path, instance: &HostInstance) -> io::Result<()> {
    let body = serde_json::to_vec_pretty(instance).map_err(io::Error::other)?;
    let tmp = dir.join(format!("{INSTANCE_FILE}.tmp"));
    write_private(&tmp, &body)?;
    fs::rename(&tmp, instance_path(dir))
}

pub fn read_instance(dir: &Path) -> Option<HostInstance> {
    let raw = fs::read(instance_path(dir)).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// Removes the instance file only if it still describes this process, so a
/// host that lost a race never deletes its successor's file.
pub fn remove_instance(dir: &Path, pid: u32) {
    if read_instance(dir).is_some_and(|instance| instance.pid == pid) {
        let _ = fs::remove_file(instance_path(dir));
    }
}

fn write_private(path: &Path, body: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // On Windows the data directory lives in the user's profile, whose ACL
    // already limits it to that account (and administrators).
    let mut file = options.open(path)?;
    file.write_all(body)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use prism_protocol::ProtocolVersion;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("prism-host-test-{name}-{}", random_hex(4)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn second_lock_on_the_same_directory_is_refused() {
        let dir = temp_dir("lock");
        let first = acquire_lock(&dir).unwrap();
        assert!(matches!(acquire_lock(&dir), Err(LockError::AlreadyRunning)));
        drop(first);
        assert!(acquire_lock(&dir).is_ok());
    }

    #[test]
    fn host_id_is_stable_and_tokens_are_unique() {
        let dir = temp_dir("id");
        let id = host_id(&dir).unwrap();
        assert_eq!(host_id(&dir).unwrap(), id);
        assert_eq!(new_token().len(), 64);
        assert_ne!(new_token(), new_token());
    }

    #[test]
    fn instance_file_round_trips_and_is_removed_only_by_its_owner() {
        let dir = temp_dir("instance");
        let instance = HostInstance {
            pid: 42, port: 5000, host_id: "h".into(), version: "0.2.0".into(),
            protocol: ProtocolVersion::CURRENT, started_at: 1, token: "t".into(),
        };
        write_instance(&dir, &instance).unwrap();
        assert_eq!(read_instance(&dir), Some(instance));
        remove_instance(&dir, 7);
        assert!(read_instance(&dir).is_some());
        remove_instance(&dir, 42);
        assert!(read_instance(&dir).is_none());
    }
}
