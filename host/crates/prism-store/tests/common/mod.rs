#![allow(dead_code)]

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde_json::Value;

pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/journal")
}

pub fn fixture(name: &str) -> Value {
    let path = fixtures_dir().join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
    serde_json::from_str(&text).unwrap()
}

/// Writes the rows of `repository-v02.json` into a Prism 0.2 style
/// `prism-agents.db` (the TypeScript schema, WAL). Returns the connection,
/// still open, so callers can keep data in the WAL.
pub fn write_v02_agents_db(path: &Path, fixture: &Value) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0)).unwrap();
    for ddl in fixture["schema"].as_array().unwrap() {
        conn.execute_batch(ddl.as_str().unwrap()).unwrap();
    }
    let rows = &fixture["rows"];
    for doc in rows["documents"].as_array().unwrap() {
        conn.execute("INSERT INTO documents VALUES (?1, ?2, ?3)", params![s(&doc["kind"]), s(&doc["id"]), s(&doc["body"])]).unwrap();
    }
    for state in rows["state"].as_array().unwrap() {
        conn.execute("INSERT INTO state VALUES (?1, ?2)", params![s(&state["key"]), s(&state["body"])]).unwrap();
    }
    for ev in rows["events"].as_array().unwrap() {
        conn.execute(
            "INSERT INTO events(seq, chat_id, turn_id, body) VALUES (?1, ?2, ?3, ?4)",
            params![ev["seq"].as_i64().unwrap(), s(&ev["chat_id"]), s(&ev["turn_id"]), s(&ev["body"])],
        )
        .unwrap();
    }
    conn
}

fn s(value: &Value) -> &str {
    value.as_str().unwrap()
}
