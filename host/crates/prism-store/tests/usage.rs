//! `Store::turn_runs` and `read_traycer_usage` (T08).

use std::path::Path;

use prism_store::{read_desktop_turn_runs, read_traycer_usage, NewEvent, Store, TraycerUsage, TurnRun, DB_FILE};
use rusqlite::{params, Connection};
use serde_json::json;

fn raw(chat: &str, turn: &str, body: serde_json::Value) -> NewEvent {
    NewEvent::raw(chat, turn, body)
}

fn run(chat: &str, turn: &str, route: Option<&str>, session: Option<&str>) -> TurnRun {
    TurnRun { chat_id: chat.into(), turn_id: turn.into(), route: route.map(Into::into), session_id: session.map(Into::into) }
}

/// A body written as is (any key order, any text), as another writer could.
fn insert_body(db: &Path, chat: &str, turn: &str, body: &str) {
    let conn = Connection::open(db).unwrap();
    conn.execute("INSERT INTO events(chat_id, turn_id, body, actor, at) VALUES (?1, ?2, ?3, NULL, 1)", params![chat, turn, body]).unwrap();
}

#[test]
fn turn_runs_is_empty_without_events() {
    let store = Store::open_in_memory().unwrap();
    assert_eq!(store.turn_runs().unwrap(), Vec::<TurnRun>::new());
}

#[test]
fn turn_runs_reads_route_and_session_across_chats_in_first_seen_order() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_batch(vec![
            raw("c1", "t1", json!({ "kind": "begin", "turn": { "id": "t1" }, "route": "claude:work" })),
            raw("c2", "t9", json!({ "kind": "begin", "turn": { "id": "t9" }, "route": "codex:ambient-codex" })),
            raw("c1", "t1", json!({ "kind": "session", "sessionId": "s1" })),
            raw("c1", "t1", json!({ "kind": "text", "text": "ignored" })),
            raw("c2", "t9", json!({ "kind": "session", "sessionId": "s9" })),
        ])
        .unwrap();
    assert_eq!(
        store.turn_runs().unwrap(),
        vec![run("c1", "t1", Some("claude:work"), Some("s1")), run("c2", "t9", Some("codex:ambient-codex"), Some("s9"))]
    );
}

#[test]
fn turn_runs_keeps_a_route_with_extra_colons_whole() {
    let store = Store::open_in_memory().unwrap();
    store.append(raw("c", "t", json!({ "kind": "begin", "route": "claude:a:b:c" }))).unwrap();
    assert_eq!(store.turn_runs().unwrap(), vec![run("c", "t", Some("claude:a:b:c"), None)]);
}

#[test]
fn turn_runs_last_begin_and_last_session_win() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_batch(vec![
            raw("c", "t", json!({ "kind": "begin", "route": "claude:old" })),
            raw("c", "t", json!({ "kind": "session", "sessionId": "old" })),
            raw("c", "t", json!({ "kind": "begin", "route": "codex:new" })),
            raw("c", "t", json!({ "kind": "session", "sessionId": "new" })),
        ])
        .unwrap();
    assert_eq!(store.turn_runs().unwrap(), vec![run("c", "t", Some("codex:new"), Some("new"))]);
}

#[test]
fn turn_runs_blank_values_count_as_absent_and_keep_the_earlier_one() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_batch(vec![
            raw("c", "t", json!({ "kind": "begin", "route": "claude:p" })),
            raw("c", "t", json!({ "kind": "session", "sessionId": "s" })),
            raw("c", "t", json!({ "kind": "begin", "route": "   " })),
            raw("c", "t", json!({ "kind": "session", "sessionId": "" })),
            raw("c", "u", json!({ "kind": "begin" })),
            raw("c", "v", json!({ "kind": "session", "sessionId": 7 })),
        ])
        .unwrap();
    assert_eq!(
        store.turn_runs().unwrap(),
        vec![run("c", "t", Some("claude:p"), Some("s")), run("c", "u", None, None), run("c", "v", None, None)]
    );
}

#[test]
fn turn_runs_ignores_other_kinds_and_turns_without_begin_or_session() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_batch(vec![
            raw("c", "t", json!({ "kind": "text", "text": "oi" })),
            raw("c", "t", json!({ "kind": "done", "at": 5 })),
            raw("c", "t", json!({ "kind": "metrics", "metrics": { "route": "x:y" } })),
        ])
        .unwrap();
    assert!(store.turn_runs().unwrap().is_empty());
}

#[test]
fn turn_runs_reads_keys_in_any_order_and_ignores_quoted_text() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join(DB_FILE);
    let store = Store::open(&db).unwrap();
    store.append(raw("c", "t", json!({ "kind": "begin", "route": "claude:p" }))).unwrap();
    // Keys out of order, and a streamed text that quotes an event (escaped quotes).
    insert_body(&db, "c", "t", r#"{"sessionId":"s","kind":"session"}"#);
    insert_body(&db, "c", "q", &json!({ "kind": "text", "text": r#"{"kind":"session","sessionId":"fake"}"# }).to_string());
    insert_body(&db, "c", "q", &json!({ "kind": "text", "text": r#"{"kind":"begin","route":"codex:fake"}"# }).to_string());
    // Not JSON at all, though it matches the cheap LIKE filter.
    insert_body(&db, "c", "bad", r#"{"kind":"session","sessionId":"x""#);
    assert_eq!(store.turn_runs().unwrap(), vec![run("c", "t", Some("claude:p"), Some("s"))]);
}

#[test]
fn turn_runs_skips_turns_with_only_streamed_events() {
    let store = Store::open_in_memory().unwrap();
    store.append(raw("c", "t", json!({ "kind": "text", "text": "só texto" }))).unwrap();
    assert!(store.turn_runs().unwrap().is_empty());
}

// ---------------------------------------------------------------- read_traycer_usage

fn usage_schema(conn: &Connection) {
    conn.execute_batch(
        "CREATE TABLE traycer_turns(id TEXT PRIMARY KEY, epic_id TEXT, chat_id TEXT, body TEXT NOT NULL, imported_at INTEGER, updated_at INTEGER);
         CREATE TABLE state(key TEXT PRIMARY KEY, body TEXT NOT NULL);",
    )
    .unwrap();
}

fn insert_turn(conn: &Connection, id: &str, body: &str) {
    conn.execute("INSERT INTO traycer_turns(id, epic_id, chat_id, body, imported_at, updated_at) VALUES (?1, 'e', 'c', ?2, 1, 1)", params![id, body]).unwrap();
}

#[test]
fn read_traycer_usage_without_a_file_is_none() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(read_traycer_usage(&dir.path().join("prism-usage.db")).unwrap(), None);
    // A directory is not a file either.
    assert_eq!(read_traycer_usage(dir.path()).unwrap(), None);
}

#[test]
fn read_traycer_usage_reads_turns_and_import_state() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("prism-usage.db");
    {
        let conn = Connection::open(&db).unwrap();
        usage_schema(&conn);
        insert_turn(&conn, "a", r#"{"id":"a"}"#);
        insert_turn(&conn, "b", r#"{"id":"b"}"#);
        conn.execute("INSERT INTO state(key, body) VALUES ('traycer-import', '{\"status\":\"ok\"}'), ('other', 'x')", []).unwrap();
    }
    let usage = read_traycer_usage(&db).unwrap().unwrap();
    assert_eq!(usage.turns, [r#"{"id":"a"}"#, r#"{"id":"b"}"#]);
    assert_eq!(usage.import_state.as_deref(), Some(r#"{"status":"ok"}"#));
}

#[test]
fn read_traycer_usage_state_without_the_key_is_none() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("prism-usage.db");
    {
        let conn = Connection::open(&db).unwrap();
        usage_schema(&conn);
        conn.execute("INSERT INTO state(key, body) VALUES ('other', 'x')", []).unwrap();
    }
    assert_eq!(read_traycer_usage(&db).unwrap(), Some(TraycerUsage::default()));
}

#[test]
fn read_traycer_usage_database_without_the_tables_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("prism-usage.db");
    Connection::open(&db).unwrap().execute_batch("CREATE TABLE unrelated(x)").unwrap();
    assert_eq!(read_traycer_usage(&db).unwrap(), Some(TraycerUsage::default()));
    // Only one of the two tables.
    let only_state = dir.path().join("only-state.db");
    {
        let conn = Connection::open(&only_state).unwrap();
        conn.execute_batch("CREATE TABLE state(key TEXT PRIMARY KEY, body TEXT); INSERT INTO state VALUES ('traycer-import', '{}')").unwrap();
    }
    let usage = read_traycer_usage(&only_state).unwrap().unwrap();
    assert!(usage.turns.is_empty());
    assert_eq!(usage.import_state.as_deref(), Some("{}"));
}

#[test]
fn read_traycer_usage_skips_non_text_bodies() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("prism-usage.db");
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE traycer_turns(id, body); INSERT INTO traycer_turns VALUES ('a', X'FF00'), ('b', 5), ('c', '{\"id\":\"c\"}')").unwrap();
    }
    let usage = read_traycer_usage(&db).unwrap().unwrap();
    assert_eq!(usage.turns, [r#"{"id":"c"}"#]);
}

#[test]
fn read_traycer_usage_rejects_a_file_that_is_not_sqlite() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("prism-usage.db");
    std::fs::write(&db, b"isto nao e um banco de dados sqlite, apenas lixo repetido ".repeat(40)).unwrap();
    assert!(read_traycer_usage(&db).is_err());
}

#[test]
fn read_traycer_usage_sees_rows_only_in_the_wal_and_never_writes() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("prism-usage.db");
    let writer = Connection::open(&db).unwrap();
    writer.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0)).unwrap();
    // Keep SQLite from checkpointing behind our back.
    writer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    usage_schema(&writer);
    insert_turn(&writer, "a", r#"{"id":"a"}"#);
    writer.execute("INSERT INTO state(key, body) VALUES ('traycer-import', '{\"status\":\"ok\"}')", []).unwrap();
    let wal = dir.path().join("prism-usage.db-wal");
    assert!(std::fs::metadata(&wal).unwrap().len() > 0, "the rows are still only in the -wal");

    let before = std::fs::read(&db).unwrap();
    let usage = read_traycer_usage(&db).unwrap().unwrap();
    assert_eq!(usage.turns, [r#"{"id":"a"}"#]);
    assert_eq!(usage.import_state.as_deref(), Some(r#"{"status":"ok"}"#));
    assert_eq!(std::fs::read(&db).unwrap(), before, "the main file is untouched");

    // Nothing was left locked: the writer carries on, and a second read sees it.
    insert_turn(&writer, "b", r#"{"id":"b"}"#);
    let usage = read_traycer_usage(&db).unwrap().unwrap();
    assert_eq!(usage.turns, [r#"{"id":"a"}"#, r#"{"id":"b"}"#]);
}

#[test]
fn read_traycer_usage_reads_while_a_write_transaction_is_open() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("prism-usage.db");
    let mut writer = Connection::open(&db).unwrap();
    writer.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0)).unwrap();
    usage_schema(&writer);
    insert_turn(&writer, "a", r#"{"id":"a"}"#);
    let tx = writer.transaction().unwrap();
    tx.execute("INSERT INTO traycer_turns(id, body) VALUES ('b', '{\"id\":\"b\"}')", []).unwrap();
    // The uncommitted row is not visible; the committed one is.
    let usage = read_traycer_usage(&db).unwrap().unwrap();
    assert_eq!(usage.turns, [r#"{"id":"a"}"#]);
    tx.commit().unwrap();
}

#[test]
fn read_traycer_usage_handles_odd_characters_in_the_path() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("a b#c%d");
    std::fs::create_dir_all(&folder).unwrap();
    let db = folder.join("prism-usage.db");
    {
        let conn = Connection::open(&db).unwrap();
        usage_schema(&conn);
        insert_turn(&conn, "a", r#"{"id":"a"}"#);
    }
    assert_eq!(read_traycer_usage(&db).unwrap().unwrap().turns, [r#"{"id":"a"}"#]);
}

#[test]
fn read_traycer_usage_of_a_closed_wal_database_leaves_no_side_files() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("prism-usage.db");
    {
        let conn = Connection::open(&db).unwrap();
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0)).unwrap();
        usage_schema(&conn);
        insert_turn(&conn, "a", r#"{"id":"a"}"#);
    }
    let files = || {
        let mut names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    };
    assert_eq!(files(), ["prism-usage.db"], "closing the last connection leaves only the database");
    let before = std::fs::read(&db).unwrap();

    let usage = read_traycer_usage(&db).unwrap().unwrap();
    assert_eq!(usage.turns, [r#"{"id":"a"}"#]);
    assert_eq!(files(), ["prism-usage.db"], "no -wal or -shm was created");
    assert_eq!(std::fs::read(&db).unwrap(), before, "the database is untouched");
}

// ---------------------------------------------------------------- read_desktop_turn_runs

fn journal_schema(conn: &Connection) {
    conn.execute_batch("CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL, body TEXT NOT NULL);").unwrap();
}

fn journal_event(conn: &Connection, chat: &str, turn: &str, body: serde_json::Value) {
    conn.execute("INSERT INTO events(chat_id, turn_id, body) VALUES (?1, ?2, ?3)", params![chat, turn, body.to_string()]).unwrap();
}

#[test]
fn read_desktop_turn_runs_without_a_file_is_none() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(read_desktop_turn_runs(&dir.path().join("prism-agents.db")).unwrap(), None);
    assert_eq!(read_desktop_turn_runs(dir.path()).unwrap(), None, "a directory is not a file");
}

#[test]
fn read_desktop_turn_runs_of_a_database_without_events_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("prism-agents.db");
    Connection::open(&db).unwrap().execute_batch("CREATE TABLE documents(kind TEXT, id TEXT, body TEXT)").unwrap();
    assert_eq!(read_desktop_turn_runs(&db).unwrap(), Some(Vec::new()));
}

#[test]
fn read_desktop_turn_runs_reads_the_begin_and_session_events() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("prism-agents.db");
    {
        let conn = Connection::open(&db).unwrap();
        journal_schema(&conn);
        journal_event(&conn, "c1", "t1", json!({ "kind": "begin", "turn": { "id": "t1" }, "route": "claude:work" }));
        journal_event(&conn, "c2", "t2", json!({ "kind": "session", "sessionId": "only-session" }));
        journal_event(&conn, "c1", "t1", json!({ "kind": "text", "text": "ignored" }));
        journal_event(&conn, "c1", "t1", json!({ "kind": "session", "sessionId": "s1" }));
        journal_event(&conn, "c3", "t3", json!({ "kind": "begin", "route": "codex:ambient-codex" }));
    }
    assert_eq!(
        read_desktop_turn_runs(&db).unwrap().unwrap(),
        vec![run("c1", "t1", Some("claude:work"), Some("s1")), run("c2", "t2", None, Some("only-session")), run("c3", "t3", Some("codex:ambient-codex"), None)]
    );
}

#[test]
fn read_desktop_turn_runs_never_creates_side_files_or_changes_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("prism-agents.db");
    {
        let conn = Connection::open(&db).unwrap();
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0)).unwrap();
        journal_schema(&conn);
        journal_event(&conn, "c", "t", json!({ "kind": "begin", "route": "claude:p" }));
    }
    let files = || {
        let mut names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    };
    assert_eq!(files(), ["prism-agents.db"]);
    let before = std::fs::read(&db).unwrap();
    assert_eq!(read_desktop_turn_runs(&db).unwrap().unwrap(), vec![run("c", "t", Some("claude:p"), None)]);
    assert_eq!(files(), ["prism-agents.db"], "no -wal or -shm was created");
    assert_eq!(std::fs::read(&db).unwrap(), before, "the database is untouched");
}

#[test]
fn read_desktop_turn_runs_sees_rows_only_in_the_wal_of_a_live_writer() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("prism-agents.db");
    let writer = Connection::open(&db).unwrap();
    writer.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0)).unwrap();
    writer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    journal_schema(&writer);
    journal_event(&writer, "c", "t", json!({ "kind": "begin", "route": "claude:p" }));
    let before = std::fs::read(&db).unwrap();
    assert_eq!(read_desktop_turn_runs(&db).unwrap().unwrap(), vec![run("c", "t", Some("claude:p"), None)]);
    assert_eq!(std::fs::read(&db).unwrap(), before, "the main file is untouched");
    journal_event(&writer, "c", "t", json!({ "kind": "session", "sessionId": "s" }));
    assert_eq!(read_desktop_turn_runs(&db).unwrap().unwrap(), vec![run("c", "t", Some("claude:p"), Some("s"))]);
}
