use std::path::{Path, PathBuf};
use std::sync::RwLock;

static DATA_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Records the data directory `run` serves, before the domains are built,
/// so a domain can keep files there (`data_dir`).
pub fn set_data_dir(dir: &Path) {
    *DATA_DIR.write().unwrap_or_else(|p| p.into_inner()) = Some(dir.to_path_buf());
}

/// The data directory of the running host; `None` outside `run` (tests).
pub fn data_dir() -> Option<PathBuf> {
    DATA_DIR.read().unwrap_or_else(|p| p.into_inner()).clone()
}

/// The desktop app's Electron `userData`, where its profiles and its Prism
/// 0.2 data live: `PRISM_APP_DATA_DIR`, else the folder the desktop runs
/// this host from (`<userData>/host`, recognized by its `prism-agents.db`).
/// `None` for a host on its own (a test, a VPS).
pub fn electron_user_data() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("PRISM_APP_DATA_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    data_dir()
        .filter(|dir| dir.file_name().is_some_and(|n| n == "host"))
        .and_then(|dir| dir.parent().map(PathBuf::from))
        .filter(|parent| parent.join("prism-agents.db").exists())
}

/// The app's own data folder, where the profiles' logins
/// (`provider-profiles/<id>`) and the Usage store (`prism-usage.db`) live: the
/// desktop's Electron `userData` when the host runs from it (so a login is
/// never copied: a copy forks its rotating refresh token), else the host's
/// data directory (a VPS). `None` outside `run` (tests).
pub fn app_data_root() -> Option<PathBuf> {
    electron_user_data().or_else(data_dir)
}

/// Where the host keeps its state when `--data-dir` is not given. On Windows
/// this is next to the Prism app's own data (`%APPDATA%\prism-ide\host`); on
/// Linux it follows XDG (`~/.local/share/prism-host`), which is what a VPS
/// user-level systemd service runs with.
pub fn default_data_dir() -> PathBuf {
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA").filter(|v| !v.is_empty()) {
        return PathBuf::from(appdata).join("prism-ide").join("host");
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(home).join("Library").join("Application Support").join("prism-ide").join("host");
    }
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(xdg).join("prism-host");
    }
    if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(home).join(".local").join("share").join("prism-host");
    }
    PathBuf::from(".prism-host")
}

/// The machine's name, shown in the host picker.
pub fn host_name() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(name) = std::env::var(key)
            && !name.trim().is_empty()
        {
            return name.trim().to_string();
        }
    }
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "host".to_string())
}

/// The OS account running the host: the local owner's display name.
pub fn os_user_name() -> String {
    for key in ["USERNAME", "USER", "LOGNAME"] {
        if let Ok(name) = std::env::var(key)
            && !name.trim().is_empty()
        {
            return name.trim().to_string();
        }
    }
    "Dono".to_string()
}
