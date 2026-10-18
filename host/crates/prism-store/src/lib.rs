//! Prism host storage: one SQLite database (`prism-host.db`, WAL,
//! `synchronous=FULL`) holding
//!
//! - `documents(kind, id, body)`: chats, tasks, profiles… as JSON;
//! - `state(key, body)`: small JSON values;
//! - `events(seq, chat_id, turn_id, body, actor, at)`: the chat journal;
//! - `journal_meta(chat_id, compacted_through)`: how far a chat's journal was
//!   folded into its document and dropped.
//!
//! A chat as the UI sees it is its document folded with its journal
//! (`fold_journal`, the port of `foldJournal`). Clients follow a chat by
//! `seq`: `events_since` answers the events after a cursor, or asks for a
//! fresh `snapshot` when compaction already dropped part of that range.
//!
//! The `Store` is `Send + Sync`; every call takes the connection's lock for
//! its duration and blocks on disk, so async callers run it on a blocking
//! thread. See `prism-rust-host/tickets/t02-armazenamento-diario` in the
//! Traycer epic.

mod error;
mod fold;
pub mod import;
mod journal;
mod schema;
pub mod usage;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};

pub use error::{Result, StoreError};
pub use fold::{compaction_cut, fold_journal, route_key};
pub use import::{import_v02, import_v02_with, take_over_profiles, ImportOptions, ImportReport, UsageImport};
pub use journal::{is_streaming_kind, EventBuffer, EventRecord, JournalEvent, NewEvent, Seq, BUFFER_LIMIT};
pub use schema::{Migrated, SCHEMA_VERSION};
pub use usage::{read_desktop_turn_runs, read_traycer_usage, TraycerUsage, TurnRun};

/// The host database's file name inside the data directory.
pub const DB_FILE: &str = "prism-host.db";

/// Document kinds the app uses.
pub mod kinds {
    pub const CHATS: &str = "chats";
    pub const TASKS: &str = "tasks";
    pub const PROFILES: &str = "profiles";
}

/// A turn that was still running when the database was last closed and was
/// marked interrupted on open (`done { aborted: true }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairedTurn {
    pub chat_id: String,
    pub turn_id: String,
}

/// A folded chat and the cursor it reflects: apply events with a greater
/// `seq` on top of it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub chat: Value,
    pub seq: Seq,
}

/// Answer to `events_since`.
#[derive(Debug, Clone, PartialEq)]
pub enum Since {
    /// Everything after the cursor, in order (possibly empty).
    Events(Vec<EventRecord>),
    /// No cursor, or part of the range was compacted away: start over from
    /// this snapshot (`None` when the chat does not exist).
    Snapshot(Option<Snapshot>),
}

/// `store.stats`: what is in the database, for tests and diagnostics.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreStats {
    pub path: Option<String>,
    pub schema_version: u32,
    /// The database file plus its WAL.
    pub size_bytes: u64,
    /// Count per document kind.
    pub documents: BTreeMap<String, u64>,
    pub events: u64,
    pub chats_with_events: u64,
    pub head_seq: Seq,
    pub compacted_chats: u64,
    /// The Prism 0.2 import marker (`import::MARKER_KEY`), when it ran.
    pub imported: Option<Value>,
}

pub struct Store {
    conn: Mutex<Connection>,
    path: Option<PathBuf>,
    migrated: Migrated,
    repaired: Vec<RepairedTurn>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store").field("path", &self.path).field("migrated", &self.migrated).finish_non_exhaustive()
    }
}

impl Store {
    /// Opens (creating it and its folder if needed) the database at `path`,
    /// migrates it to `SCHEMA_VERSION` (backing it up first) and marks turns
    /// left running by a previous process as interrupted.
    pub fn open(path: impl AsRef<Path>) -> Result<Store> {
        let path = path.as_ref();
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        Self::init(conn, Some(path.to_path_buf()))
    }

    /// A private in-memory database (tests).
    pub fn open_in_memory() -> Result<Store> {
        Self::init(Connection::open_in_memory()?, None)
    }

    fn init(mut conn: Connection, path: Option<PathBuf>) -> Result<Store> {
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0))?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        let migrated = schema::migrate(&mut conn, path.as_deref())?;
        let mut store = Store { conn: Mutex::new(conn), path, migrated, repaired: Vec::new() };
        store.repaired = store.repair_interrupted_turns()?;
        Ok(store)
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// The migration this open ran (`from == to` when none was needed).
    pub fn migrated(&self) -> &Migrated {
        &self.migrated
    }

    /// Turns marked interrupted when this store was opened.
    pub fn repaired_on_open(&self) -> &[RepairedTurn] {
        &self.repaired
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        // A panic mid-call rolled its transaction back on drop.
        self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Runs `f` inside one `BEGIN IMMEDIATE` transaction.
    fn transaction<T>(&self, f: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = f(&tx)?;
        tx.commit()?;
        Ok(value)
    }

    // ---- documents ----

    pub fn document(&self, kind: &str, id: &str) -> Result<Option<Value>> {
        let conn = self.lock();
        read_document(&conn, kind, id)
    }

    /// Every document of `kind`, as stored (chats unfolded; see `chats`).
    pub fn documents(&self, kind: &str) -> Result<Vec<Value>> {
        let conn = self.lock();
        read_documents(&conn, kind)
    }

    /// Inserts or replaces one document.
    pub fn put_document(&self, kind: &str, id: &str, body: &Value) -> Result<()> {
        let conn = self.lock();
        put_document(&conn, kind, id, body)
    }

    pub fn delete_document(&self, kind: &str, id: &str) -> Result<bool> {
        let conn = self.lock();
        Ok(conn.execute("DELETE FROM documents WHERE kind=?1 AND id=?2", params![kind, id])? > 0)
    }

    /// Replaces every document of `kind` with `items` (each needs a string
    /// `id`), atomically. For chats, each is folded with its journal first and
    /// the journals of chats no longer listed are dropped, as the TypeScript
    /// repository's `set` does.
    pub fn replace_documents(&self, kind: &str, items: &[Value]) -> Result<()> {
        let mut ids = Vec::with_capacity(items.len());
        for item in items {
            ids.push(item_id(item)?);
        }
        self.transaction(|tx| {
            tx.execute("DELETE FROM documents WHERE kind=?1", [kind])?;
            for (item, id) in items.iter().zip(&ids) {
                let body = if kind == kinds::CHATS { fold_chat(tx, item, id)? } else { item.clone() };
                tx.execute("INSERT INTO documents(kind, id, body) VALUES (?1, ?2, ?3)", params![kind, id, body.to_string()])?;
            }
            if kind == kinds::CHATS {
                tx.execute_batch(
                    "DELETE FROM events WHERE chat_id NOT IN (SELECT id FROM documents WHERE kind='chats');
                     DELETE FROM journal_meta WHERE chat_id NOT IN (SELECT id FROM documents WHERE kind='chats');",
                )?;
            }
            Ok(())
        })
    }

    // ---- state ----

    pub fn read_state(&self, key: &str) -> Result<Option<Value>> {
        let conn = self.lock();
        read_state(&conn, key)
    }

    pub fn write_state(&self, key: &str, value: &Value) -> Result<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO state(key, body) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET body=excluded.body",
            params![key, value.to_string()],
        )?;
        Ok(())
    }

    pub fn delete_state(&self, key: &str) -> Result<bool> {
        let conn = self.lock();
        Ok(conn.execute("DELETE FROM state WHERE key=?1", [key])? > 0)
    }

    // ---- chats ----

    /// The chat folded with its journal, as the UI shows it.
    pub fn chat(&self, id: &str) -> Result<Option<Value>> {
        let conn = self.lock();
        let Some(doc) = read_document(&conn, kinds::CHATS, id)? else {
            return Ok(None);
        };
        Ok(Some(fold_chat(&conn, &doc, id)?))
    }

    /// Every chat, folded (`AgentRepository.get('chats')`).
    pub fn chats(&self) -> Result<Vec<Value>> {
        let conn = self.lock();
        let docs = read_documents(&conn, kinds::CHATS)?;
        docs.iter().map(|doc| fold_chat(&conn, doc, doc.get("id").and_then(Value::as_str).unwrap_or_default())).collect()
    }

    /// Stores `chat` folded with its journal (`AgentRepository.upsert`) and
    /// returns what was stored.
    pub fn put_chat(&self, chat: &Value) -> Result<Value> {
        let id = item_id(chat)?;
        let conn = self.lock();
        let folded = fold_chat(&conn, chat, &id)?;
        put_document(&conn, kinds::CHATS, &id, &folded)?;
        Ok(folded)
    }

    /// Deletes the chat document and its journal.
    pub fn remove_chat(&self, id: &str) -> Result<bool> {
        self.transaction(|tx| {
            let removed = tx.execute("DELETE FROM documents WHERE kind='chats' AND id=?1", [id])? > 0;
            tx.execute("DELETE FROM events WHERE chat_id=?1", [id])?;
            tx.execute("DELETE FROM journal_meta WHERE chat_id=?1", [id])?;
            Ok(removed)
        })
    }

    // ---- journal ----

    /// Appends one event and returns it with its `seq`.
    pub fn append(&self, event: NewEvent) -> Result<EventRecord> {
        let mut records = self.append_batch(vec![event])?;
        Ok(records.remove(0))
    }

    /// Appends `events` in order in one transaction (one fsync). `done` and
    /// `error` bodies without a truthy `at` get the record time, as in the
    /// TypeScript repository.
    pub fn append_batch(&self, events: Vec<NewEvent>) -> Result<Vec<EventRecord>> {
        if events.is_empty() {
            return Ok(Vec::new());
        }
        let now = now_ms();
        self.transaction(|tx| events.into_iter().map(|event| insert_event(tx, event, now)).collect())
    }

    /// Starts an assistant turn the way `AgentRepository.beginRun` does, in
    /// one transaction: stores `chat` with `lastRunId = turn_id` (folded with
    /// its journal) and appends `begin` with the turn's snapshot (`startedAt`
    /// and `model` filled in when missing) and the chat's route. Returns the
    /// stored chat and the `begin` record. Whether the chat is already
    /// running is the caller's concern.
    pub fn begin_turn(&self, chat: &Value, turn_id: &str, actor: Option<&str>) -> Result<(Value, EventRecord)> {
        let id = item_id(chat)?;
        let turn = chat
            .get("turns")
            .and_then(Value::as_array)
            .and_then(|turns| turns.iter().find(|t| t.get("id").and_then(Value::as_str) == Some(turn_id)))
            .filter(|t| t.get("role").and_then(Value::as_str) == Some("assistant"))
            .and_then(Value::as_object)
            .ok_or_else(|| StoreError::Invalid("Turno de conversa inválido.".into()))?;
        let now = now_ms();
        let mut turn = turn.clone();
        if !fold::truthy(turn.get("startedAt")) {
            turn.insert("startedAt".into(), json!(now));
        }
        if !fold::truthy(turn.get("model")) {
            match chat.get("selection").and_then(|s| s.get("model")) {
                Some(model) => turn.insert("model".into(), model.clone()),
                None => turn.remove("model"),
            };
        }
        let mut chat = chat.clone();
        if let Some(map) = chat.as_object_mut() {
            map.insert("lastRunId".into(), json!(turn_id));
        }
        let begin = json!({ "kind": "begin", "turn": turn, "route": route_key(chat.get("selection")) });
        let mut event = NewEvent::raw(&id, turn_id, begin);
        event.actor = actor.map(str::to_string);
        self.transaction(|tx| {
            let stored = fold_chat(tx, &chat, &id)?;
            put_document(tx, kinds::CHATS, &id, &stored)?;
            let record = insert_event(tx, event, now)?;
            Ok((stored, record))
        })
    }

    /// A chat's whole remaining journal, in order.
    pub fn events(&self, chat_id: &str) -> Result<Vec<EventRecord>> {
        let conn = self.lock();
        read_events(&conn, chat_id, 0)
    }

    /// The events after `since` (exclusive), or a snapshot to restart from
    /// when there is no cursor, compaction dropped part of the range, or the
    /// cursor is ahead of this journal (it came from another database).
    pub fn events_since(&self, chat_id: &str, since: Option<Seq>) -> Result<Since> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let compacted = compacted_through(&tx, chat_id)?.unwrap_or(0);
        let head = head_seq(&tx)?;
        let answer = match since {
            Some(since) if since >= compacted && since <= head => Since::Events(read_events(&tx, chat_id, since)?),
            _ => Since::Snapshot(snapshot(&tx, chat_id)?),
        };
        tx.commit()?;
        Ok(answer)
    }

    /// The folded chat and the cursor it reflects, read together.
    pub fn snapshot(&self, chat_id: &str) -> Result<Option<Snapshot>> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let snap = snapshot(&tx, chat_id)?;
        tx.commit()?;
        Ok(snap)
    }

    /// The last `seq` ever assigned (0 when nothing was ever appended).
    pub fn head_seq(&self) -> Result<Seq> {
        let conn = self.lock();
        head_seq(&conn)
    }

    /// How far this chat's journal was compacted, if ever.
    pub fn compacted_through(&self, chat_id: &str) -> Result<Option<Seq>> {
        let conn = self.lock();
        compacted_through(&conn, chat_id)
    }

    /// Folds the finished prefix of a chat's journal (`compaction_cut`) into
    /// its document and drops those events. The folded chat does not change;
    /// cursors older than the new mark get a snapshot from `events_since`.
    /// Afterwards the document is the only copy of that prefix, so writers
    /// must start from the stored chat, never from an older copy of it.
    /// Returns the new mark, or `None` when there was nothing to compact.
    pub fn compact_chat(&self, chat_id: &str) -> Result<Option<Seq>> {
        self.transaction(|tx| {
            let Some(doc) = read_document(tx, kinds::CHATS, chat_id)? else {
                return Ok(None);
            };
            let events = read_events(tx, chat_id, 0)?;
            let Some(cut) = compaction_cut(events.iter().map(|e| (e.turn_id.as_str(), &e.event))) else {
                return Ok(None);
            };
            let prefix = &events[..=cut];
            let through = prefix[cut].seq;
            let folded = fold_journal(&doc, prefix.iter().map(|e| (e.turn_id.as_str(), &e.event)));
            put_document(tx, kinds::CHATS, chat_id, &folded)?;
            tx.execute("DELETE FROM events WHERE chat_id=?1 AND seq<=?2", params![chat_id, through])?;
            tx.execute(
                "INSERT INTO journal_meta(chat_id, compacted_through) VALUES (?1, ?2)
                 ON CONFLICT(chat_id) DO UPDATE SET compacted_through=excluded.compacted_through",
                params![chat_id, through],
            )?;
            Ok(Some(through))
        })
    }

    /// Compacts every chat; returns how many changed.
    pub fn compact_all(&self) -> Result<usize> {
        let ids: Vec<String> = {
            let conn = self.lock();
            let mut stmt = conn.prepare("SELECT DISTINCT chat_id FROM events")?;
            stmt.query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?
        };
        let mut changed = 0;
        for id in ids {
            if self.compact_chat(&id)?.is_some() {
                changed += 1;
            }
        }
        Ok(changed)
    }

    /// Marks turns that a previous process left running as interrupted: a
    /// chat whose `pendingTurnId` has journal events but no `done`/`error`
    /// gets `done { aborted: true, at }`, `at` being the last event's time
    /// (or the chat's `updatedAt`). Same rule as the TypeScript repository's
    /// constructor; `open` runs it.
    pub fn repair_interrupted_turns(&self) -> Result<Vec<RepairedTurn>> {
        let mut repairs = Vec::new();
        {
            let conn = self.lock();
            let pending = {
                let mut stmt = conn.prepare(
                    "SELECT body FROM documents WHERE kind='chats' AND json_valid(body) AND json_extract(body, '$.pendingTurnId') IS NOT NULL",
                )?;
                stmt.query_map([], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for body in pending {
                let chat: Value = serde_json::from_str(&body)?;
                let (Some(chat_id), Some(turn_id)) =
                    (chat.get("id").and_then(Value::as_str), chat.get("pendingTurnId").and_then(Value::as_str))
                else {
                    continue;
                };
                if turn_id.is_empty() {
                    continue;
                }
                let events: Vec<EventRecord> =
                    read_events(&conn, chat_id, 0)?.into_iter().filter(|e| e.turn_id == turn_id).collect();
                let Some(last) = events.last() else {
                    continue;
                };
                if events.iter().any(|e| matches!(e.kind(), Some("done" | "error"))) {
                    continue;
                }
                let at = if last.at != 0 {
                    json!(last.at)
                } else if fold::truthy(chat.get("updatedAt")) {
                    chat["updatedAt"].clone()
                } else {
                    json!(now_ms())
                };
                repairs.push((
                    RepairedTurn { chat_id: chat_id.to_string(), turn_id: turn_id.to_string() },
                    json!({ "kind": "done", "aborted": true, "at": at }),
                ));
            }
        }
        let events = repairs.iter().map(|(t, body)| NewEvent::raw(&t.chat_id, &t.turn_id, body.clone())).collect();
        self.append_batch(events)?;
        Ok(repairs.into_iter().map(|(t, _)| t).collect())
    }

    pub fn stats(&self) -> Result<StoreStats> {
        let conn = self.lock();
        let mut documents = BTreeMap::new();
        {
            let mut stmt = conn.prepare("SELECT kind, count(*) FROM documents GROUP BY kind")?;
            for row in stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))? {
                let (kind, count) = row?;
                documents.insert(kind, count as u64);
            }
        }
        let (events, chats_with_events): (i64, i64) =
            conn.query_row("SELECT count(*), count(DISTINCT chat_id) FROM events", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let compacted: i64 = conn.query_row("SELECT count(*) FROM journal_meta", [], |row| row.get(0))?;
        let size_bytes = self
            .path
            .as_deref()
            .map(|p| {
                let wal = PathBuf::from(format!("{}-wal", p.display()));
                [p.to_path_buf(), wal].iter().filter_map(|f| std::fs::metadata(f).ok()).map(|m| m.len()).sum()
            })
            .unwrap_or(0);
        Ok(StoreStats {
            path: self.path.as_ref().map(|p| p.display().to_string()),
            schema_version: schema::user_version(&conn)?,
            size_bytes,
            documents,
            events: events as u64,
            chats_with_events: chats_with_events as u64,
            head_seq: head_seq(&conn)?,
            compacted_chats: compacted as u64,
            imported: read_state(&conn, import::MARKER_KEY)?,
        })
    }
}

fn item_id(item: &Value) -> Result<String> {
    item.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| StoreError::Invalid("Documento sem id.".into()))
}

fn read_document(conn: &Connection, kind: &str, id: &str) -> Result<Option<Value>> {
    let body: Option<String> =
        conn.query_row("SELECT body FROM documents WHERE kind=?1 AND id=?2", params![kind, id], |row| row.get(0)).optional()?;
    body.map(|b| serde_json::from_str(&b).map_err(StoreError::from)).transpose()
}

fn read_documents(conn: &Connection, kind: &str) -> Result<Vec<Value>> {
    // Same query as the TypeScript repository, so the order matches too.
    let mut stmt = conn.prepare_cached("SELECT body FROM documents WHERE kind=?1")?;
    let bodies = stmt.query_map([kind], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    bodies.iter().map(|b| serde_json::from_str(b).map_err(StoreError::from)).collect()
}

fn put_document(conn: &Connection, kind: &str, id: &str, body: &Value) -> Result<()> {
    conn.execute(
        "INSERT INTO documents(kind, id, body) VALUES (?1, ?2, ?3) ON CONFLICT(kind, id) DO UPDATE SET body=excluded.body",
        params![kind, id, body.to_string()],
    )?;
    Ok(())
}

fn read_state(conn: &Connection, key: &str) -> Result<Option<Value>> {
    let body: Option<String> = conn.query_row("SELECT body FROM state WHERE key=?1", [key], |row| row.get(0)).optional()?;
    body.map(|b| serde_json::from_str(&b).map_err(StoreError::from)).transpose()
}

fn read_events(conn: &Connection, chat_id: &str, after: Seq) -> Result<Vec<EventRecord>> {
    let mut stmt =
        conn.prepare_cached("SELECT seq, turn_id, body, actor, at FROM events WHERE chat_id=?1 AND seq>?2 ORDER BY seq")?;
    let rows = stmt
        .query_map(params![chat_id, after], |row| {
            Ok((row.get::<_, Seq>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, i64>(4)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(seq, turn_id, body, actor, at)| {
            Ok(EventRecord { seq, chat_id: chat_id.to_string(), turn_id, actor, at, event: serde_json::from_str(&body)? })
        })
        .collect()
}

fn fold_chat(conn: &Connection, chat: &Value, id: &str) -> Result<Value> {
    let events = read_events(conn, id, 0)?;
    Ok(fold_journal(chat, events.iter().map(|e| (e.turn_id.as_str(), &e.event))))
}

fn compacted_through(conn: &Connection, chat_id: &str) -> Result<Option<Seq>> {
    Ok(conn.query_row("SELECT compacted_through FROM journal_meta WHERE chat_id=?1", [chat_id], |row| row.get(0)).optional()?)
}

/// The highest `seq` ever assigned (AUTOINCREMENT never reuses one, even
/// after compaction or removal).
fn head_seq(conn: &Connection) -> Result<Seq> {
    Ok(conn.query_row(
        "SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'), 0), COALESCE((SELECT MAX(seq) FROM events), 0))",
        [],
        |row| row.get(0),
    )?)
}

fn snapshot(conn: &Connection, chat_id: &str) -> Result<Option<Snapshot>> {
    let Some(doc) = read_document(conn, kinds::CHATS, chat_id)? else {
        return Ok(None);
    };
    let events = read_events(conn, chat_id, 0)?;
    let seq = events.last().map(|e| e.seq).or(compacted_through(conn, chat_id)?).unwrap_or(0);
    let chat = fold_journal(&doc, events.iter().map(|e| (e.turn_id.as_str(), &e.event)));
    Ok(Some(Snapshot { chat, seq }))
}

/// Inserts one event; `now` is the record time when the event has none.
fn insert_event(conn: &Connection, event: NewEvent, now: i64) -> Result<EventRecord> {
    let NewEvent { chat_id, turn_id, actor, at, mut body } = event;
    let at = at.unwrap_or(now);
    if matches!(body.get("kind").and_then(Value::as_str), Some("done" | "error"))
        && !fold::truthy(body.get("at"))
        && let Some(map) = body.as_object_mut()
    {
        map.insert("at".into(), json!(at));
    }
    let mut insert = conn.prepare_cached("INSERT INTO events(chat_id, turn_id, body, actor, at) VALUES (?1, ?2, ?3, ?4, ?5)")?;
    insert.execute(params![chat_id, turn_id, body.to_string(), actor, at])?;
    Ok(EventRecord { seq: conn.last_insert_rowid(), chat_id, turn_id, actor, at, event: body })
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
