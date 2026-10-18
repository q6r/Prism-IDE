//! Importer for the data Prism 0.2 keeps in its Electron `userData`
//! (`%APPDATA%\prism-ide\`), into the host's data directory.
//!
//! - `prism-agents.db` (documents, state and the journal) is merged into the
//!   host database row by row, read through a read-only connection;
//! - `prism-settings.json` (electron-store) contributes only what the domain
//!   map gives the host: the recent folders and workspaces;
//! - `provider-profiles\` is copied file by file. A profile linked to a
//!   Traycer account keeps its `credentialLink` (in its `profiles` document,
//!   with the absolute `~/.traycer` root), so it stays linked and nothing of
//!   `~/.traycer` is copied;
//! - `prism-usage.db` is copied as a consistent snapshot.
//!
//! Nothing is ever deleted or written in the source. Re-running is a no-op:
//! the database merge and the marker (`MARKER_KEY` in `state`) commit in one
//! transaction, and the file copies before it skip what already exists.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};

use crate::{now_ms, Result, Store, StoreError};

/// `state` key recording that the 0.2 import ran (and what it brought).
pub const MARKER_KEY: &str = "import.prism-0.2";
/// Bumped if a later build has to import something new.
pub const IMPORT_VERSION: u32 = 1;
/// `state` keys the host-owned settings land in.
pub const RECENT_FOLDERS_KEY: &str = "settings.recentFolders";
pub const RECENT_WORKSPACES_KEY: &str = "settings.recentWorkspaces";

const AGENTS_DB: &str = "prism-agents.db";
const USAGE_DB: &str = "prism-usage.db";
const SETTINGS_JSON: &str = "prism-settings.json";
const PROFILES_DIR: &str = "provider-profiles";
const TEMP_SUFFIX: &str = ".prism-import.tmp";

/// What happened to `prism-usage.db`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageImport {
    Copied,
    /// The host already has one; it is never overwritten.
    AlreadyPresent,
    Missing,
    /// Not copied: the host uses the app's own file where it is (T08).
    InPlace,
}

/// What the import copies besides the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportOptions {
    /// `provider-profiles\` (the profiles' logins).
    pub profile_folders: bool,
    /// `prism-usage.db`.
    pub usage_db: bool,
}

impl ImportOptions {
    /// Everything, as T02 shipped it (a host that will own copies of its own).
    pub const COPY_ALL: Self = Self { profile_folders: true, usage_db: true };
    /// Only the database: a desktop host runs the logins and the Usage store
    /// in place, since a copied login forks its rotating refresh token.
    pub const IN_PLACE: Self = Self { profile_folders: false, usage_db: false };
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// The marker was already there: nothing was read or written.
    pub already_imported: bool,
    /// The 0.2 folder does not exist: nothing to import (no marker written).
    pub source_missing: bool,
    pub documents: u64,
    /// Documents the host already had (kept as they are, with their journal).
    pub documents_skipped: u64,
    pub events: u64,
    pub state_keys: u64,
    /// `state` keys filled from `prism-settings.json`.
    pub settings: Vec<String>,
    pub profile_files: u64,
    pub profile_files_skipped: u64,
    /// Symlinks and junctions under `provider-profiles\`, left uncopied.
    pub profile_links_skipped: Vec<String>,
    pub usage: UsageImport,
    /// Imported turns that 0.2 left running, now marked interrupted.
    pub repaired_turns: u64,
}

impl ImportReport {
    fn new() -> Self {
        Self {
            already_imported: false,
            source_missing: false,
            documents: 0,
            documents_skipped: 0,
            events: 0,
            state_keys: 0,
            settings: Vec::new(),
            profile_files: 0,
            profile_files_skipped: 0,
            profile_links_skipped: Vec::new(),
            usage: UsageImport::Missing,
            repaired_turns: 0,
        }
    }
}

/// Prism 0.2's data folder on this machine (`%APPDATA%\prism-ide`), if the
/// platform has one.
pub fn default_v02_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("APPDATA").filter(|v| !v.is_empty()).map(|a| PathBuf::from(a).join("prism-ide"))
    } else {
        None
    }
}

/// Imports Prism 0.2's data from `source_dir` into `store` (the host
/// database) and `host_dir` (the host's data folder, for the profile folders
/// and `prism-usage.db`). Copies without deleting; idempotent.
pub fn import_v02(store: &Store, source_dir: &Path, host_dir: &Path) -> Result<ImportReport> {
    import_v02_with(store, source_dir, host_dir, ImportOptions::COPY_ALL)
}

/// `import_v02`, choosing which files are copied besides the database.
pub fn import_v02_with(store: &Store, source_dir: &Path, host_dir: &Path, options: ImportOptions) -> Result<ImportReport> {
    let mut report = ImportReport::new();
    if store.read_state(MARKER_KEY)?.is_some() {
        report.already_imported = true;
        return Ok(report);
    }
    if !source_dir.is_dir() {
        report.source_missing = true;
        return Ok(report);
    }
    if same_dir(source_dir, host_dir) {
        return Err(StoreError::Invalid("A pasta de origem da importação é a própria pasta do host.".into()));
    }
    fs::create_dir_all(host_dir)?;

    let profiles = source_dir.join(PROFILES_DIR);
    if options.profile_folders && profiles.is_dir() {
        copy_tree(&profiles, &host_dir.join(PROFILES_DIR), Path::new(PROFILES_DIR), &mut report)?;
    }
    report.usage = if options.usage_db { copy_usage(&source_dir.join(USAGE_DB), &host_dir.join(USAGE_DB))? } else { UsageImport::InPlace };
    let settings = read_settings(&source_dir.join(SETTINGS_JSON));

    let agents = source_dir.join(AGENTS_DB);
    let source = if agents.is_file() { Some(open_read_only(&agents)?) } else { None };
    {
        let mut conn = store.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if crate::read_state(&tx, MARKER_KEY)?.is_some() {
            // Another import committed while the files were being copied.
            report.already_imported = true;
            return Ok(report);
        }
        if let Some(source) = &source {
            merge_agents(source, &tx, &mut report)?;
        }
        for (key, value) in settings {
            if tx.execute("INSERT OR IGNORE INTO state(key, body) VALUES (?1, ?2)", params![key, value.to_string()])? > 0 {
                report.settings.push(key.to_string());
            }
        }
        let marker = json!({
            "version": IMPORT_VERSION,
            "at": now_ms(),
            "source": source_dir.display().to_string(),
            "documents": report.documents,
            "events": report.events,
            "profileFiles": report.profile_files,
            "usage": report.usage,
        });
        tx.execute("INSERT INTO state(key, body) VALUES (?1, ?2)", params![MARKER_KEY, marker.to_string()])?;
        tx.commit()?;
    }
    report.repaired_turns = store.repair_interrupted_turns()?.len() as u64;
    Ok(report)
}

/// `state` key recording that the profiles were taken over from the
/// desktop's store (T08: the host owns them from then on).
pub const PROFILES_MARKER_KEY: &str = "import.profiles-t08";

/// Once: the profiles of `source_dir/prism-agents.db` (read only), which
/// owned them until T08, become the host's. The desktop's documents win; a
/// profile only the host has stays. It is marked done even when the desktop
/// has no store or no profiles (a fresh install), so a desktop store that
/// shows up later never touches the host's profiles. `Ok(None)` when it
/// already ran; else how many profiles came from the desktop.
pub fn take_over_profiles(store: &Store, source_dir: &Path) -> Result<Option<usize>> {
    if store.read_state(PROFILES_MARKER_KEY)?.is_some() {
        return Ok(None);
    }
    let desktop = desktop_profiles(&source_dir.join(AGENTS_DB))?;
    if !desktop.is_empty() {
        let mut merged = store.documents(crate::kinds::PROFILES)?;
        merged.retain(|own| !desktop.iter().any(|doc| doc.get("id") == own.get("id")));
        merged.extend(desktop.iter().cloned());
        store.replace_documents(crate::kinds::PROFILES, &merged)?;
    }
    store.write_state(PROFILES_MARKER_KEY, &json!({ "at": now_ms(), "profiles": desktop.len() }))?;
    Ok(Some(desktop.len()))
}

/// The readable profile documents of a desktop store; none without the
/// store or its `documents` table.
fn desktop_profiles(agents: &Path) -> Result<Vec<Value>> {
    if !agents.is_file() {
        return Ok(Vec::new());
    }
    let source = open_read_only(agents)?;
    if !has_table(&source, "documents")? {
        return Ok(Vec::new());
    }
    let bodies: Vec<String> = {
        let mut stmt = source.prepare("SELECT body FROM documents WHERE kind='profiles'")?;
        stmt.query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?
    };
    Ok(bodies
        .iter()
        .filter_map(|body| serde_json::from_str::<Value>(body).ok())
        .filter(|p| p.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty()))
        .collect())
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// A read-only connection: SQLite reads the WAL too, and never writes the
/// database or its journal.
fn open_read_only(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

fn has_table(conn: &Connection, name: &str) -> Result<bool> {
    let count: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1", [name], |row| row.get(0))?;
    Ok(count > 0)
}

/// Copies documents and state the host lacks, and the journal of every chat
/// whose document was copied, in the source's `seq` order. All reads come
/// from one snapshot of the source.
fn merge_agents(source: &Connection, tx: &rusqlite::Transaction<'_>, report: &mut ImportReport) -> Result<()> {
    source.execute_batch("BEGIN")?;
    let result = (|| -> Result<()> {
        let mut new_chats = HashSet::new();
        if has_table(source, "documents")? {
            let mut read = source.prepare("SELECT kind, id, body FROM documents")?;
            let mut rows = read.query([])?;
            let mut insert = tx.prepare("INSERT OR IGNORE INTO documents(kind, id, body) VALUES (?1, ?2, ?3)")?;
            while let Some(row) = rows.next()? {
                let (kind, id, body): (String, String, String) = (row.get(0)?, row.get(1)?, row.get(2)?);
                if insert.execute(params![kind, id, body])? > 0 {
                    report.documents += 1;
                    if kind == crate::kinds::CHATS {
                        new_chats.insert(id);
                    }
                } else {
                    report.documents_skipped += 1;
                }
            }
        }
        if has_table(source, "state")? {
            let mut read = source.prepare("SELECT key, body FROM state")?;
            let mut rows = read.query([])?;
            let mut insert = tx.prepare("INSERT OR IGNORE INTO state(key, body) VALUES (?1, ?2)")?;
            while let Some(row) = rows.next()? {
                let (key, body): (String, String) = (row.get(0)?, row.get(1)?);
                if key != MARKER_KEY && insert.execute(params![key, body])? > 0 {
                    report.state_keys += 1;
                }
            }
        }
        if has_table(source, "events")? && !new_chats.is_empty() {
            let mut read = source.prepare(
                "SELECT chat_id, turn_id, body,
                        CASE WHEN json_valid(body) THEN CAST(json_extract(body, '$.recordedAt') AS INTEGER) END
                 FROM events ORDER BY seq",
            )?;
            let mut rows = read.query([])?;
            let mut insert = tx.prepare("INSERT INTO events(chat_id, turn_id, body, actor, at) VALUES (?1, ?2, ?3, NULL, ?4)")?;
            while let Some(row) = rows.next()? {
                let chat_id: String = row.get(0)?;
                if !new_chats.contains(&chat_id) {
                    continue;
                }
                let (turn_id, body, at): (String, String, Option<i64>) = (row.get(1)?, row.get(2)?, row.get(3)?);
                insert.execute(params![chat_id, turn_id, body, at.unwrap_or(0)])?;
                report.events += 1;
            }
        }
        Ok(())
    })();
    let _ = source.execute_batch("COMMIT");
    result
}

/// The host-owned keys of the electron-store settings file, as
/// `(state key, value)`. A missing or unreadable file contributes nothing.
fn read_settings(path: &Path) -> Vec<(&'static str, Value)> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(Value::Object(settings)) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else {
        return Vec::new();
    };
    [("recentFolders", RECENT_FOLDERS_KEY), ("recentWorkspaces", RECENT_WORKSPACES_KEY)]
        .into_iter()
        .filter_map(|(name, key)| match settings.get(name) {
            Some(value @ Value::Array(_)) => Some((key, value.clone())),
            _ => None,
        })
        .collect()
}

/// Snapshot of the usage database (WAL included) unless the host has one.
fn copy_usage(source: &Path, dest: &Path) -> Result<UsageImport> {
    if dest.exists() {
        return Ok(UsageImport::AlreadyPresent);
    }
    if !source.is_file() {
        return Ok(UsageImport::Missing);
    }
    let temp = temp_path(dest);
    remove_if_exists(&temp)?;
    let conn = open_read_only(source)?;
    conn.execute("VACUUM INTO ?1", [temp.to_string_lossy()])?;
    drop(conn);
    fs::rename(&temp, dest)?;
    Ok(UsageImport::Copied)
}

/// Copies `src` into `dst` file by file: existing files are kept, links are
/// not followed, and each file lands whole (copied beside, then renamed).
fn copy_tree(src: &Path, dst: &Path, shown: &Path, report: &mut ImportReport) -> Result<()> {
    create_private_dir(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name();
        let (from, to, label) = (entry.path(), dst.join(&name), shown.join(&name));
        if kind.is_symlink() {
            report.profile_links_skipped.push(label.display().to_string());
        } else if kind.is_dir() {
            copy_tree(&from, &to, &label, report)?;
        } else if kind.is_file() {
            if name.to_string_lossy().ends_with(TEMP_SUFFIX) {
                continue;
            }
            if fs::symlink_metadata(&to).is_ok() {
                report.profile_files_skipped += 1;
                continue;
            }
            let temp = temp_path(&to);
            fs::copy(&from, &temp)?;
            fs::rename(&temp, &to)?;
            report.profile_files += 1;
        }
    }
    Ok(())
}

fn create_private_dir(dir: &Path) -> io::Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(TEMP_SUFFIX);
    path.with_file_name(name)
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
        _ => Ok(()),
    }
}
