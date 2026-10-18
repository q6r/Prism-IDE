mod common;

use prism_store::{EventBuffer, JournalEvent, NewEvent, Since, Store, StoreError, DB_FILE, SCHEMA_VERSION};
use rusqlite::Connection;
use serde_json::{json, Value};

fn chat(id: &str) -> Value {
    json!({
        "id": id, "title": "Conversa", "cwd": "C:\\QA", "updatedAt": 1,
        "selection": { "provider": "codex", "profileId": "work", "model": "gpt-5", "effort": "high", "permissionMode": "default" },
        "turns": [{ "id": "u1", "role": "user", "text": "Oi" }, { "id": "t1", "role": "assistant", "text": "", "segments": [] }],
        "pendingTurnId": "t1"
    })
}

fn text(chat: &str, turn: &str, text: &str) -> NewEvent {
    NewEvent::new(chat, turn, &JournalEvent::Text { text: text.into() })
}

fn done(chat: &str, turn: &str) -> NewEvent {
    NewEvent::new(chat, turn, &JournalEvent::Done { aborted: None, at: None })
}

#[test]
fn opens_with_wal_full_sync_and_current_schema() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("sub").join(DB_FILE)).unwrap();
    assert_eq!(store.migrated().to, SCHEMA_VERSION);
    assert_eq!(store.migrated().backup, None, "a new database needs no backup");
    let conn = Connection::open(store.path().unwrap()).unwrap();
    let mode: String = conn.pragma_query_value(None, "journal_mode", |r| r.get(0)).unwrap();
    assert_eq!(mode, "wal");
    let version: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
    assert_eq!(version, SCHEMA_VERSION);
}

#[test]
fn begin_turn_appends_with_seq_actor_and_at_and_folds() {
    let store = Store::open_in_memory().unwrap();
    let (stored, begin) = store.begin_turn(&chat("c"), "t1", Some("owner")).unwrap();
    assert_eq!(stored["lastRunId"], "t1");
    assert_eq!(begin.actor.as_deref(), Some("owner"));
    assert_eq!(begin.event["route"], "codex:work");
    assert_eq!(begin.event["turn"]["model"], "gpt-5");
    assert!(begin.event["turn"]["startedAt"].as_i64().unwrap() > 0);
    assert!(begin.at > 0);

    let recs = store
        .append_batch(vec![
            NewEvent::new("c", "t1", &JournalEvent::Session { session_id: "thread".into() }),
            text("c", "t1", "ação").by("owner"),
            text("c", "t1", "🙂").at(42),
            done("c", "t1"),
        ])
        .unwrap();
    let seqs: Vec<i64> = recs.iter().map(|r| r.seq).collect();
    assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1) && seqs[0] == begin.seq + 1);
    assert_eq!(recs[2].at, 42);
    assert_eq!(recs[3].event["at"], json!(recs[3].at), "done gets its record time");
    assert_eq!(recs[3].typed(), Some(JournalEvent::Done { aborted: None, at: Some(recs[3].at) }));

    let folded = store.chat("c").unwrap().unwrap();
    assert_eq!(folded["turns"][1]["segments"][0]["text"], "ação🙂");
    assert_eq!(folded["resume"], json!({ "route": "codex:work", "sessionId": "thread" }));
    assert!(folded.get("pendingTurnId").is_none());
    assert_eq!(store.chats().unwrap(), vec![folded]);
    assert!(matches!(
        store.begin_turn(&chat("c"), "u1", None),
        Err(StoreError::Invalid(message)) if message.contains("inválido")
    ));
}

#[test]
fn events_since_a_cursor_and_snapshots() {
    let store = Store::open_in_memory().unwrap();
    store.begin_turn(&chat("c"), "t1", None).unwrap();
    store.begin_turn(&chat("other"), "t1", None).unwrap();
    let first = store.append(text("c", "t1", "a")).unwrap();
    store.append(text("other", "t1", "x")).unwrap();
    let second = store.append(text("c", "t1", "b")).unwrap();

    let Since::Events(events) = store.events_since("c", Some(first.seq)).unwrap() else { panic!("expected events") };
    assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![second.seq]);
    let Since::Events(none) = store.events_since("c", Some(second.seq)).unwrap() else { panic!("expected events") };
    assert!(none.is_empty());

    let Since::Snapshot(Some(snap)) = store.events_since("c", None).unwrap() else { panic!("expected a snapshot") };
    assert_eq!(snap.seq, second.seq);
    assert_eq!(snap.chat["turns"][1]["segments"][0]["text"], "ab");
    assert_eq!(store.events_since("missing", None).unwrap(), Since::Snapshot(None));
    assert!(
        matches!(store.events_since("c", Some(second.seq + 1000)).unwrap(), Since::Snapshot(Some(_))),
        "a cursor from another database restarts from a snapshot"
    );
    assert!(store.head_seq().unwrap() >= second.seq);
}

#[test]
fn compaction_keeps_the_chat_and_sends_old_cursors_a_snapshot() {
    let store = Store::open_in_memory().unwrap();
    let mut c = chat("c");
    c["turns"].as_array_mut().unwrap().extend([json!({ "id": "u2", "role": "user", "text": "De novo" }), json!({ "id": "t2", "role": "assistant", "text": "" })]);
    store.begin_turn(&c, "t1", None).unwrap();
    let early = store.append(text("c", "t1", "primeiro")).unwrap();
    let end = store.append(done("c", "t1")).unwrap();
    c["pendingTurnId"] = json!("t2");
    store.begin_turn(&c, "t2", None).unwrap();
    store.append(text("c", "t2", "rodando")).unwrap();
    let before = store.chat("c").unwrap().unwrap();

    assert_eq!(store.compact_chat("c").unwrap(), Some(end.seq), "only the finished turn is folded in");
    assert_eq!(store.compacted_through("c").unwrap(), Some(end.seq));
    assert_eq!(store.chat("c").unwrap().unwrap(), before);
    assert!(store.events("c").unwrap().iter().all(|e| e.turn_id == "t2"));
    assert!(matches!(store.events_since("c", Some(early.seq)).unwrap(), Since::Snapshot(Some(_))));
    let Since::Events(rest) = store.events_since("c", Some(end.seq)).unwrap() else { panic!("expected events") };
    assert_eq!(rest.len(), 2);
    assert_eq!(store.compact_chat("c").unwrap(), None, "the running turn stays in the journal");

    store.append(done("c", "t2")).unwrap();
    let finished = store.chat("c").unwrap().unwrap();
    assert_eq!(store.compact_all().unwrap(), 1);
    assert!(store.events("c").unwrap().is_empty());
    assert_eq!(store.chat("c").unwrap().unwrap(), finished);
    let snap = store.snapshot("c").unwrap().unwrap();
    assert_eq!(snap.seq, store.compacted_through("c").unwrap().unwrap());
}

#[test]
fn documents_state_replace_and_remove() {
    let store = Store::open_in_memory().unwrap();
    store.put_document("tasks", "a", &json!({ "id": "a", "title": "A" })).unwrap();
    store.put_document("tasks", "a", &json!({ "id": "a", "title": "A2" })).unwrap();
    assert_eq!(store.document("tasks", "a").unwrap().unwrap()["title"], "A2");
    store.replace_documents("tasks", &[json!({ "id": "b" }), json!({ "id": "c" })]).unwrap();
    assert_eq!(store.documents("tasks").unwrap().len(), 2);
    assert!(store.replace_documents("tasks", &[json!({ "title": "sem id" })]).is_err());
    assert!(store.delete_document("tasks", "b").unwrap());

    store.write_state("task-tabs", &json!({ "openIds": ["c"] })).unwrap();
    assert_eq!(store.read_state("task-tabs").unwrap().unwrap()["openIds"][0], "c");
    assert!(store.delete_state("task-tabs").unwrap());
    assert_eq!(store.read_state("task-tabs").unwrap(), None);

    store.begin_turn(&chat("keep"), "t1", None).unwrap();
    store.begin_turn(&chat("drop"), "t1", None).unwrap();
    store.append(text("keep", "t1", "fica")).unwrap();
    // Replacing the chat list folds what is kept and drops the other journal.
    store.replace_documents("chats", &[chat("keep")]).unwrap();
    assert!(store.events("drop").unwrap().is_empty());
    assert_eq!(store.document("chats", "keep").unwrap().unwrap()["turns"][1]["segments"][0]["text"], "fica");

    let put = store.put_chat(&json!({ "id": "keep", "title": "Renomeada", "selection": {}, "turns": [] })).unwrap();
    assert_eq!(put["title"], "Renomeada");
    assert!(store.remove_chat("keep").unwrap());
    assert!(store.events("keep").unwrap().is_empty() && store.chat("keep").unwrap().is_none());
}

#[test]
fn reopening_marks_a_turn_left_running_as_interrupted() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DB_FILE);
    {
        let store = Store::open(&path).unwrap();
        store.begin_turn(&chat("c"), "t1", None).unwrap();
        store.append(text("c", "t1", "metade").at(5_000)).unwrap();
        store
            .append(NewEvent::raw("c", "t1", json!({ "kind": "segment", "segment": { "kind": "tool", "toolId": "b", "status": "running" } })).at(6_000))
            .unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.repaired_on_open().len(), 1);
    let turn = &store.chat("c").unwrap().unwrap()["turns"][1];
    assert_eq!(turn["interrupted"], true);
    assert_eq!(turn["completedAt"], 6_000, "the last event's time, like the TypeScript repository");
    assert_eq!(turn["segments"][1]["status"], "error");
    drop(store);
    assert!(Store::open(&path).unwrap().repaired_on_open().is_empty(), "repair happens once");
}

#[test]
fn migrates_a_prism_02_database_in_place_with_a_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("prism-agents.db");
    let fixture = common::fixture("repository-v02.json");
    drop(common::write_v02_agents_db(&path, &fixture));

    let store = Store::open(&path).unwrap();
    assert_eq!(store.migrated().from, 0);
    let backup = store.migrated().backup.clone().expect("existing data is backed up first");
    assert!(backup.file_name().unwrap().to_string_lossy().starts_with("prism-agents.db.v0-"));
    let old: i64 = Connection::open(&backup).unwrap().query_row("SELECT count(*) FROM events", [], |r| r.get(0)).unwrap();
    assert_eq!(old as usize, fixture["rows"]["events"].as_array().unwrap().len());

    let expected = &fixture["expected"];
    assert_eq!(store.chats().unwrap(), *expected["chats"].as_array().unwrap(), "same chats as AgentRepository reopened");
    assert_eq!(store.documents("tasks").unwrap(), *expected["tasks"].as_array().unwrap());
    assert_eq!(store.documents("profiles").unwrap(), *expected["profiles"].as_array().unwrap());
    assert_eq!(store.read_state("task-tabs").unwrap().unwrap(), expected["taskTabs"]);
    let events = store.events("chat-a").unwrap();
    assert!(events.iter().all(|e| e.at > 0 && e.actor.is_none()), "at backfilled from recordedAt");
    assert_eq!(store.repaired_on_open().len(), 1);
}

#[test]
fn refuses_a_database_from_a_newer_host() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DB_FILE);
    drop(Store::open(&path).unwrap());
    Connection::open(&path).unwrap().pragma_update(None, "user_version", SCHEMA_VERSION + 1).unwrap();
    let err = Store::open(&path).unwrap_err();
    assert!(matches!(err, StoreError::TooNew { .. }));
    assert!(err.to_string().contains("Atualize o Prism"));
}

#[test]
fn buffered_burst_commits_once_with_coalesced_snapshots() {
    let store = Store::open_in_memory().unwrap();
    store.begin_turn(&chat("c"), "t1", None).unwrap();
    let mut buffer = EventBuffer::new();
    for i in 0..100 {
        let flush = buffer.push(NewEvent::raw("c", "t1", json!({ "kind": "segment", "segment": { "kind": "text", "toolId": "message", "text": format!("output-{i}") } })));
        assert!(!flush);
    }
    buffer.push(NewEvent::raw("c", "t1", json!({ "kind": "segment", "segment": { "kind": "tool", "toolId": "tool", "status": "done", "result": "SIDE EFFECT" } })));
    buffer.push(NewEvent::raw("c", "t1", json!({ "kind": "segment", "segment": { "kind": "text", "toolId": "message", "text": "final" } })));
    assert!(buffer.push(done("c", "t1")));
    let records = store.append_batch(buffer.take()).unwrap();
    assert_eq!(records.len(), 3, "final snapshots plus completion, as the TypeScript repository stores them");
    let turn = &store.chat("c").unwrap().unwrap()["turns"][1];
    assert_eq!(turn["segments"][0]["text"], "final");
    assert_eq!(turn["segments"][1]["result"], "SIDE EFFECT");
}

#[test]
fn stats_describe_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join(DB_FILE)).unwrap();
    store.begin_turn(&chat("c"), "t1", None).unwrap();
    store.append(done("c", "t1")).unwrap();
    store.put_document("tasks", "x", &json!({ "id": "x" })).unwrap();
    store.compact_chat("c").unwrap();
    let stats = store.stats().unwrap();
    assert_eq!(stats.schema_version, SCHEMA_VERSION);
    assert_eq!(stats.documents.get("chats"), Some(&1));
    assert_eq!(stats.documents.get("tasks"), Some(&1));
    assert_eq!((stats.events, stats.compacted_chats), (0, 1));
    assert!(stats.head_seq >= 2 && stats.size_bytes > 0 && stats.imported.is_none());
    let wire = serde_json::to_value(&stats).unwrap();
    assert!(wire.get("schemaVersion").is_some() && wire.get("headSeq").is_some());
}
