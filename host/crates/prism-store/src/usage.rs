//! Reads for Settings ▸ Uso (`usage.records`, T08): where and in which
//! native session each journaled turn ran (`Store::turn_runs`, and the
//! desktop's own journal: `read_desktop_turn_runs`), and the Traycer turns
//! the desktop imported into its own `prism-usage.db` (`read_traycer_usage`).
//! The desktop's files are only ever read.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use crate::{Result, Store};

/// `state` key of the desktop's last Traycer import, in `prism-usage.db`.
pub const TRAYCER_IMPORT_KEY: &str = "traycer-import";

/// Where one journaled turn ran: the `route` (`provider:profileId`) of its
/// last `begin` and the `sessionId` of its last `session` event. Blank
/// values count as absent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnRun {
    pub chat_id: String,
    pub turn_id: String,
    pub route: Option<String>,
    pub session_id: Option<String>,
}

impl Store {
    /// Every turn with a `begin` or `session` event in the journal, in the
    /// order its first one was recorded. Compacted turns have none left.
    pub fn turn_runs(&self) -> Result<Vec<TurnRun>> {
        let conn = self.lock();
        turn_runs_of(&conn)
    }
}

/// The runs of the desktop's own journal (`prism-agents.db`: the turns a
/// window still drives itself, SSH), read like `read_traycer_usage`, never
/// written. `None` when there is no such file; a database without a journal
/// reads as empty.
pub fn read_desktop_turn_runs(path: &Path) -> Result<Option<Vec<TurnRun>>> {
    if !path.is_file() {
        return Ok(None);
    }
    read_quietly(path, |conn| if has_table(conn, "events")? { turn_runs_of(conn) } else { Ok(Vec::new()) }).map(Some)
}

/// `Store::turn_runs` on any connection to a journal (`events` with `seq`,
/// `chat_id`, `turn_id`, `body`: the host's and the desktop's alike).
fn turn_runs_of(conn: &Connection) -> Result<Vec<TurnRun>> {
    // LIKE skips the streamed bulk cheaply; json_extract decides. A quote
    // inside a JSON string is escaped, so text that quotes an event never
    // matches, whatever order the writer put the keys in.
    let mut stmt = conn.prepare(
        "SELECT chat_id, turn_id, json_extract(j, '$.kind'), json_extract(j, '$.sessionId'), json_extract(j, '$.route')
         FROM (SELECT seq, chat_id, turn_id, CASE WHEN json_valid(body) THEN body END AS j FROM events
               WHERE body LIKE '%\"kind\":\"session\"%' OR body LIKE '%\"kind\":\"begin\"%')
         ORDER BY seq",
    )?;
    let mut rows = stmt.query([])?;
    let mut runs: Vec<TurnRun> = Vec::new();
    let mut index: HashMap<(String, String), usize> = HashMap::new();
    while let Some(row) = rows.next()? {
        let text = |i: usize| -> Option<String> { row.get_ref(i).ok()?.as_str().ok().filter(|s| !s.trim().is_empty()).map(str::to_string) };
        let kind = text(2);
        if !matches!(kind.as_deref(), Some("begin" | "session")) {
            continue;
        }
        let (chat_id, turn_id): (String, String) = (row.get(0)?, row.get(1)?);
        let slot = *index.entry((chat_id.clone(), turn_id.clone())).or_insert_with(|| {
            runs.push(TurnRun { chat_id, turn_id, ..TurnRun::default() });
            runs.len() - 1
        });
        let run = &mut runs[slot];
        match kind.as_deref() {
            Some("session") => run.session_id = text(3).or(run.session_id.take()),
            _ => run.route = text(4).or(run.route.take()),
        }
    }
    Ok(runs)
}

/// What the desktop's `prism-usage.db` holds for Settings ▸ Uso, as stored
/// JSON text: the imported Traycer turns (`traycer_turns.body`, in table
/// order) and the last import's state (`state['traycer-import']`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TraycerUsage {
    pub turns: Vec<String>,
    pub import_state: Option<String>,
}

/// Reads `prism-usage.db` without ever writing it, while the desktop may be
/// writing it (WAL). `None` when there is no such file; a database without
/// those tables reads as empty.
pub fn read_traycer_usage(path: &Path) -> Result<Option<TraycerUsage>> {
    if !path.is_file() {
        return Ok(None);
    }
    read_quietly(path, usage_tables).map(Some)
}

fn usage_tables(conn: &Connection) -> Result<TraycerUsage> {
    let mut usage = TraycerUsage::default();
    if has_table(conn, "traycer_turns")? {
        let mut stmt = conn.prepare("SELECT body FROM traycer_turns")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            if let Ok(body) = row.get_ref(0)?.as_str() {
                usage.turns.push(body.to_string());
            }
        }
    }
    if has_table(conn, "state")? {
        usage.import_state = conn
            .query_row("SELECT body FROM state WHERE key=?1", [TRAYCER_IMPORT_KEY], |row| Ok(row.get_ref(0)?.as_str().ok().map(str::to_string)))
            .optional()?
            .flatten();
    }
    Ok(usage)
}

/// Reads a database the desktop may be writing (WAL) without writing
/// anything beside it. While a writer holds it open its WAL is there: the
/// read goes through the shared locks, which also see what is still only in
/// the WAL. Otherwise nobody writes it, and an immutable open reads it
/// without leaving the `-shm` and `-wal` a read-only open of a WAL database
/// creates; a writer that opened it meanwhile may have checkpointed under
/// that read, so then it is read again through the locks.
fn read_quietly<T>(path: &Path, read: impl Fn(&Connection) -> Result<T>) -> Result<T> {
    let immutable = !wal_of(path).exists();
    let first = read_once(path, immutable, &read);
    if immutable && wal_of(path).exists() {
        return read_once(path, false, &read);
    }
    first
}

/// One read transaction, so everything read comes from the same state.
fn read_once<T>(path: &Path, immutable: bool, read: &impl Fn(&Connection) -> Result<T>) -> Result<T> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = if immutable {
        let uri = path.to_string_lossy().replace('%', "%25").replace('\\', "/").replace('?', "%3f").replace('#', "%23");
        Connection::open_with_flags(format!("file:{uri}?immutable=1"), flags | OpenFlags::SQLITE_OPEN_URI)?
    } else {
        Connection::open_with_flags(path, flags)?
    };
    conn.busy_timeout(Duration::from_secs(3))?;
    conn.execute_batch("BEGIN")?;
    let result = read(&conn);
    let _ = conn.execute_batch("COMMIT");
    result
}

fn has_table(conn: &Connection, name: &str) -> Result<bool> {
    let count: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1", [name], |row| row.get(0))?;
    Ok(count > 0)
}

fn wal_of(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push("-wal");
    path.with_file_name(name)
}
