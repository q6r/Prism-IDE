//! Schema versions (`PRAGMA user_version`) and their migrations.
//!
//! Version 0 is either an empty file or the Prism 0.2 `prism-agents.db`
//! layout (`documents`, `state`, `events(seq, chat_id, turn_id, body)`), so a
//! copy of the old database opens as-is and is upgraded in place. Before an
//! existing database is migrated it is copied next to itself
//! (`<file>.v<from>-<ms>.bak`).

use std::path::{Path, PathBuf};

use rusqlite::{Connection, Transaction, TransactionBehavior};

use crate::error::{Result, StoreError};

/// The schema this build writes.
pub const SCHEMA_VERSION: u32 = 1;

type Migration = fn(&Transaction<'_>) -> Result<()>;

/// `MIGRATIONS[n]` upgrades version `n` to `n + 1`.
const MIGRATIONS: [Migration; SCHEMA_VERSION as usize] = [v1];

fn v1(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind, id));
         CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, body TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL, body TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS events_chat ON events(chat_id, seq);
         CREATE TABLE IF NOT EXISTS journal_meta (chat_id TEXT PRIMARY KEY, compacted_through INTEGER NOT NULL);",
    )?;
    let columns = table_columns(tx, "events")?;
    if !columns.iter().any(|c| c == "actor") {
        tx.execute_batch("ALTER TABLE events ADD COLUMN actor TEXT;")?;
    }
    if !columns.iter().any(|c| c == "at") {
        tx.execute_batch(
            "ALTER TABLE events ADD COLUMN at INTEGER NOT NULL DEFAULT 0;
             UPDATE events SET at = COALESCE(CASE WHEN json_valid(body) THEN CAST(json_extract(body, '$.recordedAt') AS INTEGER) END, 0);",
        )?;
    }
    Ok(())
}

fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |row| row.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}

pub(crate) fn user_version(conn: &Connection) -> Result<u32> {
    Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

fn has_tables(conn: &Connection) -> Result<bool> {
    let count: i64 =
        conn.query_row("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'", [], |row| row.get(0))?;
    Ok(count > 0)
}

/// What `migrate` did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Migrated {
    pub from: u32,
    pub to: u32,
    /// The copy taken before migrating an existing database.
    pub backup: Option<PathBuf>,
}

/// Brings the database to `SCHEMA_VERSION`. `path` is the database file,
/// for the pre-migration backup (`None` for in-memory databases).
pub(crate) fn migrate(conn: &mut Connection, path: Option<&Path>) -> Result<Migrated> {
    let from = user_version(conn)?;
    if from > SCHEMA_VERSION {
        return Err(StoreError::TooNew { found: from, supported: SCHEMA_VERSION });
    }
    if from == SCHEMA_VERSION {
        return Ok(Migrated { from, to: from, backup: None });
    }
    let backup = match path {
        Some(path) if has_tables(conn)? => Some(backup(conn, path, from)?),
        _ => None,
    };
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for migration in &MIGRATIONS[from as usize..] {
        migration(&tx)?;
    }
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()?;
    Ok(Migrated { from, to: SCHEMA_VERSION, backup })
}

/// A consistent copy of the live database (WAL included) next to it.
fn backup(conn: &Connection, path: &Path, from: u32) -> Result<PathBuf> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "prism-host.db".into());
    let target = path.with_file_name(format!("{name}.v{from}-{}.bak", crate::now_ms()));
    conn.execute("VACUUM INTO ?1", [target.to_string_lossy()])?;
    Ok(target)
}
