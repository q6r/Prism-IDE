//! The Prism 0.2 importer, against a 0.2 data folder built in a temporary
//! directory from `repository-v02.json` (rows a real AgentRepository wrote).

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use prism_store::import::{PROFILES_MARKER_KEY, MARKER_KEY, RECENT_FOLDERS_KEY, RECENT_WORKSPACES_KEY};
use prism_store::{import_v02, import_v02_with, take_over_profiles, ImportOptions, NewEvent, Store, UsageImport, DB_FILE};
use rusqlite::Connection;
use serde_json::json;

struct Legacy {
    _dir: tempfile::TempDir,
    source: PathBuf,
    host: PathBuf,
    /// Writers kept open so part of the data is still only in the WAL files.
    _writers: Vec<Connection>,
}

fn legacy() -> Legacy {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("prism-ide");
    let host = source.join("host");
    fs::create_dir_all(&source).unwrap();

    let agents = common::write_v02_agents_db(&source.join("prism-agents.db"), &common::fixture("repository-v02.json"));
    agents.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    agents.execute("INSERT INTO state VALUES ('only-in-wal', '\"sim\"')", []).unwrap();

    let usage = Connection::open(source.join("prism-usage.db")).unwrap();
    usage.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get::<_, String>(0)).unwrap();
    usage.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    usage.execute_batch("CREATE TABLE turns (id TEXT PRIMARY KEY, tokens INTEGER); INSERT INTO turns VALUES ('a', 10), ('b', 20);").unwrap();

    fs::write(
        source.join("prism-settings.json"),
        json!({
            "theme": "prism-dark", "fontSize": 14,
            "recentFolders": ["C:\\QA", "D:\\Projeto"], "recentWorkspaces": ["C:\\QA\\x.prism-workspace"],
            "sshHosts": [{ "id": "h", "host": "vps" }], "sshSecrets": { "h": "segredo" }
        })
        .to_string(),
    )
    .unwrap();

    let profiles = source.join("provider-profiles");
    fs::create_dir_all(profiles.join("work").join("sessions")).unwrap();
    fs::write(profiles.join("work").join("auth.json"), "{\"token\":\"codex\"}").unwrap();
    fs::write(profiles.join("work").join("sessions").join("s1.jsonl"), "linha\n").unwrap();
    fs::create_dir_all(profiles.join("traycer-0123")).unwrap();
    fs::write(profiles.join("traycer-0123").join(".credentials.json.replaced-by-traycer-link-1"), "old").unwrap();
    // Not inside provider-profiles: must never be read.
    fs::write(source.join("Preferences"), "chromium").unwrap();

    Legacy { _dir: dir, source, host, _writers: vec![agents, usage] }
}

/// Content of every file under `dir` except SQLite's shared-memory index,
/// which readers legitimately update.
fn snapshot_files(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut out = BTreeMap::new();
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.ends_with("host") {
            continue;
        }
        if path.is_dir() {
            out.extend(snapshot_files(&path));
        } else if !path.to_string_lossy().ends_with("-shm") {
            out.insert(path.clone(), fs::read(&path).unwrap());
        }
    }
    out
}

#[test]
fn imports_everything_once_without_touching_the_originals() {
    let legacy = legacy();
    let before = snapshot_files(&legacy.source);
    let store = Store::open(legacy.host.join(DB_FILE)).unwrap();

    let report = import_v02(&store, &legacy.source, &legacy.host).unwrap();
    assert!(!report.already_imported && !report.source_missing);
    let fixture = common::fixture("repository-v02.json");
    let expected = &fixture["expected"];
    assert_eq!(report.events as usize, fixture["rows"]["events"].as_array().unwrap().len());
    assert_eq!(report.repaired_turns, 1, "the turn 0.2 left running");
    assert_eq!(report.usage, UsageImport::Copied);
    assert_eq!(report.profile_files, 3);
    assert_eq!(report.settings, vec![RECENT_FOLDERS_KEY.to_string(), RECENT_WORKSPACES_KEY.to_string()]);

    assert_eq!(store.chats().unwrap(), *expected["chats"].as_array().unwrap(), "chats as the 0.2 app showed them");
    assert_eq!(store.documents("tasks").unwrap(), *expected["tasks"].as_array().unwrap());
    let profiles = store.documents("profiles").unwrap();
    assert_eq!(profiles, *expected["profiles"].as_array().unwrap());
    let linked = profiles.iter().find(|p| p["id"] == "traycer-0123").unwrap();
    assert_eq!(linked["credentialLink"]["root"], "C:\\Users\\qa\\.traycer", "Traycer link kept as is");
    assert_eq!(store.read_state("task-tabs").unwrap().unwrap(), expected["taskTabs"]);
    assert_eq!(store.read_state("only-in-wal").unwrap(), Some(json!("sim")), "WAL content imported");
    assert_eq!(store.read_state(RECENT_FOLDERS_KEY).unwrap(), Some(json!(["C:\\QA", "D:\\Projeto"])));
    assert_eq!(store.read_state("sshSecrets").unwrap(), None, "shell-owned settings stay out");
    assert_eq!(store.read_state(MARKER_KEY).unwrap().unwrap()["version"], 1);

    let usage = Connection::open(legacy.host.join("prism-usage.db")).unwrap();
    let tokens: i64 = usage.query_row("SELECT sum(tokens) FROM turns", [], |r| r.get(0)).unwrap();
    assert_eq!(tokens, 30);
    assert_eq!(fs::read_to_string(legacy.host.join("provider-profiles/work/sessions/s1.jsonl")).unwrap(), "linha\n");
    assert!(!legacy.host.join("Preferences").exists());

    let again = import_v02(&store, &legacy.source, &legacy.host).unwrap();
    assert!(again.already_imported);
    assert_eq!((again.documents, again.events, again.profile_files), (0, 0, 0));
    assert_eq!(snapshot_files(&legacy.source), before, "the 0.2 files are untouched");
}

#[test]
fn the_merge_itself_never_duplicates_even_without_the_marker() {
    let legacy = legacy();
    let store = Store::open(legacy.host.join(DB_FILE)).unwrap();
    let first = import_v02(&store, &legacy.source, &legacy.host).unwrap();
    let chats = store.chats().unwrap();
    let head = store.head_seq().unwrap();

    store.delete_state(MARKER_KEY).unwrap();
    let second = import_v02(&store, &legacy.source, &legacy.host).unwrap();
    assert_eq!((second.documents, second.events, second.profile_files), (0, 0, 0));
    assert_eq!(second.documents_skipped, first.documents);
    assert_eq!(second.profile_files_skipped, first.profile_files);
    assert_eq!(second.usage, UsageImport::AlreadyPresent);
    assert_eq!(store.chats().unwrap(), chats);
    assert_eq!(store.head_seq().unwrap(), head);
}

#[test]
fn host_data_wins_over_the_import() {
    let legacy = legacy();
    let store = Store::open(legacy.host.join(DB_FILE)).unwrap();
    let mine = json!({ "id": "chat-a", "title": "Do host", "selection": {}, "turns": [] });
    store.put_chat(&mine).unwrap();
    store.append(NewEvent::raw("chat-a", "x", json!({ "kind": "text", "text": "host" }))).unwrap();
    store.write_state(RECENT_FOLDERS_KEY, &json!(["E:\\host"])).unwrap();

    let report = import_v02(&store, &legacy.source, &legacy.host).unwrap();
    assert!(report.documents_skipped >= 1);
    assert_eq!(store.document("chats", "chat-a").unwrap().unwrap()["title"], "Do host");
    assert_eq!(store.events("chat-a").unwrap().len(), 1, "no 0.2 events grafted onto the host's chat");
    assert_eq!(store.read_state(RECENT_FOLDERS_KEY).unwrap(), Some(json!(["E:\\host"])));
    assert!(!report.settings.contains(&RECENT_FOLDERS_KEY.to_string()));
}

#[test]
fn a_missing_source_is_a_no_op() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    let report = import_v02(&store, &dir.path().join("nada"), &dir.path().join("host")).unwrap();
    assert!(report.source_missing);
    assert_eq!(store.read_state(MARKER_KEY).unwrap(), None);
    assert!(import_v02(&store, dir.path(), dir.path()).is_err(), "source and host folders must differ");
}

#[cfg(unix)]
#[test]
fn links_inside_profiles_are_not_followed() {
    let legacy = legacy();
    let outside = legacy.source.parent().unwrap().join("traycer-account");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join(".credentials.json"), "traycer").unwrap();
    std::os::unix::fs::symlink(&outside, legacy.source.join("provider-profiles/linked")).unwrap();
    let store = Store::open(legacy.host.join(DB_FILE)).unwrap();
    let report = import_v02(&store, &legacy.source, &legacy.host).unwrap();
    assert_eq!(report.profile_links_skipped, vec!["provider-profiles/linked".to_string()]);
    assert!(!legacy.host.join("provider-profiles/linked").exists());
}

#[test]
fn in_place_import_copies_neither_profiles_nor_usage() {
    let legacy = legacy();
    let store = Store::open(legacy.host.join(DB_FILE)).unwrap();
    let report = import_v02_with(&store, &legacy.source, &legacy.host, ImportOptions::IN_PLACE).unwrap();
    assert_eq!(report.usage, UsageImport::InPlace);
    assert_eq!((report.profile_files, report.profile_files_skipped), (0, 0));
    assert!(report.profile_links_skipped.is_empty());
    assert!(!legacy.host.join("provider-profiles").exists());
    assert!(!legacy.host.join("prism-usage.db").exists());
    // The database part still came across.
    assert!(report.documents > 0 && report.events > 0);
    assert_eq!(store.read_state(MARKER_KEY).unwrap().unwrap()["usage"], "inPlace");
    assert_eq!(store.documents("profiles").unwrap(), *common::fixture("repository-v02.json")["expected"]["profiles"].as_array().unwrap());
}

#[test]
fn copy_all_options_are_what_import_v02_does() {
    assert_eq!(ImportOptions::COPY_ALL, ImportOptions { profile_folders: true, usage_db: true });
    assert_eq!(ImportOptions::IN_PLACE, ImportOptions { profile_folders: false, usage_db: false });
    let legacy = legacy();
    let store = Store::open(legacy.host.join(DB_FILE)).unwrap();
    let report = import_v02_with(&store, &legacy.source, &legacy.host, ImportOptions::COPY_ALL).unwrap();
    assert_eq!(report.usage, UsageImport::Copied);
    assert_eq!(report.profile_files, 3);
    assert!(legacy.host.join("provider-profiles/work/auth.json").is_file());
    assert!(legacy.host.join("prism-usage.db").is_file());
}

fn profile(id: &str, name: &str) -> serde_json::Value {
    json!({ "id": id, "provider": "claude", "name": name })
}

/// A bare desktop store: only the `documents` table, with these `profiles` bodies.
fn desktop_db(dir: &Path, bodies: &[&str]) {
    let conn = Connection::open(dir.join("prism-agents.db")).unwrap();
    conn.execute_batch("CREATE TABLE documents (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (kind, id));").unwrap();
    for (n, body) in bodies.iter().enumerate() {
        conn.execute("INSERT INTO documents VALUES ('profiles', ?1, ?2)", rusqlite::params![format!("row{n}"), body]).unwrap();
    }
    conn.execute("INSERT INTO documents VALUES ('tasks', 't', '{\"id\":\"t\"}')", []).unwrap();
}

#[test]
fn take_over_brings_the_desktop_profiles_once_and_leaves_the_source_alone() {
    let legacy = legacy();
    let store = Store::open(legacy.host.join(DB_FILE)).unwrap();
    let expected = common::fixture("repository-v02.json")["expected"]["profiles"].as_array().unwrap().clone();
    let shared = expected[0]["id"].as_str().unwrap().to_string();
    store.put_document("profiles", "mine", &profile("mine", "Do host")).unwrap();
    store.put_document("profiles", &shared, &profile(&shared, "Cópia antiga")).unwrap();
    store.put_document("tasks", "keep", &json!({ "id": "keep" })).unwrap();
    let db = legacy.source.join("prism-agents.db");
    let (before, mtime) = (snapshot_files(&legacy.source), fs::metadata(&db).unwrap().modified().unwrap());

    let taken = take_over_profiles(&store, &legacy.source).unwrap();
    assert_eq!(taken, Some(expected.len()));
    let mut got = store.documents("profiles").unwrap();
    let mut want = expected.clone();
    want.push(profile("mine", "Do host"));
    got.sort_by_key(|p| p["id"].to_string());
    want.sort_by_key(|p| p["id"].to_string());
    assert_eq!(got, want, "the desktop's profiles win; one only the host has stays");
    assert_eq!(store.document("profiles", &shared).unwrap().unwrap(), expected[0], "the desktop's copy replaces the host's older one");
    assert!(store.document("tasks", "keep").unwrap().is_some(), "other kinds untouched");
    assert_eq!(store.read_state(PROFILES_MARKER_KEY).unwrap().unwrap()["profiles"], expected.len());

    assert_eq!(snapshot_files(&legacy.source), before, "the desktop store is not written");
    assert_eq!(fs::metadata(&db).unwrap().modified().unwrap(), mtime);

    // Second run: nothing happens, even if the host changed meanwhile.
    store.put_document("profiles", "later", &profile("later", "Depois")).unwrap();
    assert_eq!(take_over_profiles(&store, &legacy.source).unwrap(), None);
    assert!(store.document("profiles", "later").unwrap().is_some());
    assert_eq!(store.documents("profiles").unwrap().len(), got.len() + 1);
}

#[test]
fn take_over_skips_unreadable_and_idless_profiles() {
    let dir = tempfile::tempdir().unwrap();
    desktop_db(dir.path(), &["{\"id\":\"ok\",\"provider\":\"codex\",\"name\":\"Ok\"}", "não é json", "{\"name\":\"sem id\"}", "{\"id\":\"\"}", "{\"id\":7}"]);
    let store = Store::open_in_memory().unwrap();
    assert_eq!(take_over_profiles(&store, dir.path()).unwrap(), Some(1));
    let docs = store.documents("profiles").unwrap();
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0]["id"], "ok");
}

#[test]
fn take_over_without_a_desktop_store_keeps_the_host_profiles_and_is_done() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_in_memory().unwrap();
    store.put_document("profiles", "mine", &profile("mine", "Do host")).unwrap();
    assert_eq!(take_over_profiles(&store, dir.path()).unwrap(), Some(0));
    assert_eq!(store.read_state(PROFILES_MARKER_KEY).unwrap().unwrap()["profiles"], 0);
    assert!(store.document("profiles", "mine").unwrap().is_some());
    assert!(!dir.path().join("prism-agents.db").exists(), "a read-only open never creates the file");

    // A desktop store that shows up later never counts.
    desktop_db(dir.path(), &["{\"id\":\"late\",\"provider\":\"codex\",\"name\":\"Tarde\"}"]);
    assert_eq!(take_over_profiles(&store, dir.path()).unwrap(), None);
    assert!(store.document("profiles", "late").unwrap().is_none());
    assert!(store.document("profiles", "mine").unwrap().is_some());

    // A database with no `documents` table is no store either.
    let other = tempfile::tempdir().unwrap();
    Connection::open(other.path().join("prism-agents.db")).unwrap().execute_batch("CREATE TABLE state (key TEXT PRIMARY KEY, body TEXT);").unwrap();
    let fresh = Store::open_in_memory().unwrap();
    fresh.put_document("profiles", "mine", &profile("mine", "Do host")).unwrap();
    assert_eq!(take_over_profiles(&fresh, other.path()).unwrap(), Some(0));
    assert!(fresh.document("profiles", "mine").unwrap().is_some());
}

#[test]
fn take_over_with_no_desktop_profiles_keeps_the_host_ones() {
    let dir = tempfile::tempdir().unwrap();
    desktop_db(dir.path(), &[]);
    let store = Store::open_in_memory().unwrap();
    store.put_document("profiles", "mine", &profile("mine", "Do host")).unwrap();
    assert_eq!(take_over_profiles(&store, dir.path()).unwrap(), Some(0));
    assert!(store.document("profiles", "mine").unwrap().is_some());
    assert!(store.read_state(PROFILES_MARKER_KEY).unwrap().is_some());
}
