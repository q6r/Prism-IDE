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

/// Completed journal prefixes are checkpoints, not a permanent second copy of
/// every cumulative tool snapshot. Small journals retain their normal cursors.
const COMPACT_EVENT_LIMIT: i64 = 512;
const COMPACT_BYTE_LIMIT: i64 = 16 * 1024 * 1024;

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
                usage::remove_orphan_compacted_runs(tx)?;
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
        Ok(Some(fold_chat_owned(&conn, doc, id)?))
    }

    /// Every chat, folded (`AgentRepository.get('chats')`).
    pub fn chats(&self) -> Result<Vec<Value>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached("SELECT body FROM documents WHERE kind=?1")?;
        let mut rows = stmt.query([kinds::CHATS])?;
        let mut chats = Vec::new();
        while let Some(row) = rows.next()? {
            let doc = json_column(row, 0)?;
            let id = doc.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            chats.push(fold_chat_owned(&conn, doc, &id)?);
        }
        Ok(chats)
    }

    /// Initial desktop navigation needs chat metadata, drafts and queues, not
    /// every transcript. SQLite removes turns before Rust parses each result.
    pub fn chat_summaries(&self) -> Result<Vec<Value>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached("SELECT json_set(json_remove(body, '$.turns'), '$.turns', json('[]'), '$.historyPending', json('true'), '$.historyTurnCount', COALESCE(json_array_length(body, '$.turns'), 0)) FROM documents WHERE kind='chats'")?;
        let mut rows = stmt.query([])?;
        let mut chats = Vec::new();
        while let Some(row) = rows.next()? { chats.push(json_column(row, 0)?); }
        Ok(chats)
    }

    /// Native identity/status only, without retaining any conversation turns.
    pub fn native_chat_metadata(&self) -> Result<Vec<Value>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached("SELECT json_object('id', id, 'nativeAgent', json_extract(body, '$.nativeAgent')) FROM documents WHERE kind='chats' AND json_type(body, '$.nativeAgent')='object'")?;
        let mut rows = stmt.query([])?;
        let mut chats = Vec::new();
        while let Some(row) = rows.next()? { chats.push(json_column(row, 0)?); }
        Ok(chats)
    }

    /// Resolve a provider's child address without materializing every transcript.
    pub fn find_native_child(&self, root_chat_id: &str, message_target: &str) -> Result<Option<Value>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached("SELECT json_object('id', id, 'nativeAgent', json_extract(body, '$.nativeAgent')) FROM documents WHERE kind='chats' AND json_extract(body, '$.nativeAgent.rootChatId')=?1 AND json_extract(body, '$.nativeAgent.messageTarget')=?2 LIMIT 1")?;
        let mut rows = stmt.query(params![root_chat_id, message_target])?;
        rows.next()?.map(|row| json_column(row, 0)).transpose()
    }

    /// Startup recovery only needs candidates with a stored pending marker.
    /// Completed conversations never need their full transcript loaded here.
    pub fn pending_chat_ids(&self) -> Result<Vec<String>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached("SELECT id FROM documents WHERE kind='chats' AND json_type(body, '$.pendingTurnId')='text' AND json_extract(body, '$.pendingTurnId')<>''")?;
        Ok(stmt.query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?)
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
            usage::delete_compacted_runs(tx, id)?;
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
        let finished = events.iter().filter(|event| matches!(event.kind(), Some("done" | "error")))
            .map(|event| event.chat_id.clone()).collect::<std::collections::BTreeSet<_>>();
        let now = now_ms();
        let records = self.transaction(|tx| events.into_iter().map(|event| insert_event(tx, event, now)).collect())?;
        for chat_id in finished {
            // Maintenance failure must not turn an already committed append
            // into a false failure; its atomic transaction leaves the journal intact.
            let _ = self.compact_chat_if_large(&chat_id);
        }
        Ok(records)
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
            // Only tiny event identities/kinds are retained to find a safe cut;
            // superseded tool payloads are streamed when folding that prefix.
            let events = event_kinds(tx, chat_id)?;
            let Some(cut) = fold::compaction_cut_kinds(events.iter().map(|(_, turn, kind)| (turn.as_str(), kind.as_str()))) else {
                return Ok(None);
            };
            let through = events[cut].0;
            usage::preserve_compacted_runs(tx, chat_id, through)?;
            let folded = fold_rows(tx, chat_id, Some(through), fold::JournalFold::owned(doc))?;
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

    fn compact_chat_if_large(&self, chat_id: &str) -> Result<Option<Seq>> {
        let (count, bytes): (i64, i64) = {
            let conn = self.lock();
            conn.query_row("SELECT count(*), COALESCE(sum(length(CAST(body AS BLOB))), 0) FROM events WHERE chat_id=?1", [chat_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        };
        if count < COMPACT_EVENT_LIMIT && bytes < COMPACT_BYTE_LIMIT { return Ok(None); }
        self.compact_chat(chat_id)
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

    /// Startup maintenance selects only oversized journals, leaving small
    /// histories and their event cursors untouched.
    pub fn compact_large_journals(&self) -> Result<usize> {
        let ids: Vec<String> = {
            let conn = self.lock();
            let mut stmt = conn.prepare("SELECT chat_id FROM events GROUP BY chat_id HAVING count(*)>=?1 OR sum(length(CAST(body AS BLOB)))>=?2")?;
            stmt.query_map(params![COMPACT_EVENT_LIMIT, COMPACT_BYTE_LIMIT], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?
        };
        let mut changed = 0;
        for id in ids { if self.compact_chat(&id)?.is_some() { changed += 1; } }
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
                    "SELECT id, json_extract(body, '$.pendingTurnId'), json_object('updatedAt', json_extract(body, '$.updatedAt')) FROM documents WHERE kind='chats' AND json_valid(body) AND json_type(body, '$.pendingTurnId')='text'",
                )?;
                stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for (chat_id, turn_id, updated_at) in pending {
                let metadata: Value = serde_json::from_str(&updated_at)?;
                if turn_id.is_empty() {
                    continue;
                }
                let last: Option<i64> = conn.query_row("SELECT at FROM events WHERE chat_id=?1 AND turn_id=?2 ORDER BY seq DESC LIMIT 1", params![chat_id, turn_id], |row| row.get(0)).optional()?;
                let Some(last_at) = last else {
                    continue;
                };
                let finished: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE chat_id=?1 AND turn_id=?2 AND json_extract(body, '$.kind') IN ('done','error'))", params![chat_id, turn_id], |row| row.get(0))?;
                if finished {
                    continue;
                }
                let at = if last_at != 0 {
                    json!(last_at)
                } else if fold::truthy(metadata.get("updatedAt")) {
                    metadata["updatedAt"].clone()
                } else {
                    json!(now_ms())
                };
                repairs.push((
                    RepairedTurn { chat_id, turn_id },
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
    let mut stmt = conn.prepare_cached("SELECT body FROM documents WHERE kind=?1 AND id=?2")?;
    let mut rows = stmt.query(params![kind, id])?;
    rows.next()?.map(|row| json_column(row, 0)).transpose()
}

fn read_documents(conn: &Connection, kind: &str) -> Result<Vec<Value>> {
    // Same query as the TypeScript repository, so the order matches too.
    let mut stmt = conn.prepare_cached("SELECT body FROM documents WHERE kind=?1")?;
    let mut rows = stmt.query([kind])?;
    let mut docs = Vec::new();
    while let Some(row) = rows.next()? { docs.push(json_column(row, 0)?); }
    Ok(docs)
}

/// Parse directly from SQLite's borrowed text. No duplicate collection of all
/// serialized documents/events survives alongside the parsed values.
fn json_column(row: &rusqlite::Row<'_>, column: usize) -> Result<Value> {
    match row.get_ref(column)? {
        rusqlite::types::ValueRef::Text(bytes) => Ok(serde_json::from_slice(bytes)?),
        _ => Err(StoreError::Invalid("Documento JSON inválido no armazenamento.".into())),
    }
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
    let mut rows = stmt.query(params![chat_id, after])?;
    let mut events = Vec::new();
    while let Some(row) = rows.next()? {
        events.push(EventRecord { seq: row.get(0)?, chat_id: chat_id.into(), turn_id: row.get(1)?,
            actor: row.get(3)?, at: row.get(4)?, event: json_column(row, 2)? });
    }
    Ok(events)
}

fn fold_chat(conn: &Connection, chat: &Value, id: &str) -> Result<Value> {
    fold_rows(conn, id, None, fold::JournalFold::new(chat))
}

fn fold_chat_owned(conn: &Connection, chat: Value, id: &str) -> Result<Value> {
    fold_rows(conn, id, None, fold::JournalFold::owned(chat))
}

fn fold_rows(conn: &Connection, id: &str, through: Option<Seq>, mut fold: fold::JournalFold<'_>) -> Result<Value> {
    if compacted_through(conn, id)?.is_some() {
        fold = fold.with_compacted_turns(usage::compacted_turn_routes(conn, id)?);
    }
    let mut stmt = conn.prepare_cached("SELECT turn_id, body FROM events WHERE chat_id=?1 AND seq<=?2 ORDER BY seq")?;
    let mut rows = stmt.query(params![id, through.unwrap_or(Seq::MAX)])?;
    while let Some(row) = rows.next()? {
        let turn_id: String = row.get(0)?;
        let event = json_column(row, 1)?;
        fold.apply(&turn_id, &event);
    }
    Ok(fold.finish())
}

fn event_kinds(conn: &Connection, id: &str) -> Result<Vec<(Seq, String, String)>> {
    let mut stmt = conn.prepare_cached("SELECT seq, turn_id, CASE WHEN json_type(body, '$.kind')='text' THEN json_extract(body, '$.kind') ELSE '' END FROM events WHERE chat_id=?1 ORDER BY seq")?;
    Ok(stmt.query_map([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?.collect::<rusqlite::Result<_>>()?)
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
    let latest: Option<Seq> = conn.query_row("SELECT MAX(seq) FROM events WHERE chat_id=?1", [chat_id], |row| row.get(0))?;
    let seq = latest.or(compacted_through(conn, chat_id)?).unwrap_or(0);
    let chat = fold_chat_owned(conn, doc, chat_id)?;
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
