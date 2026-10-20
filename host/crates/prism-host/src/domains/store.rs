//! `store`: the host database (`prism_store::Store`, `<data>/prism-host.db`)
//! as seen over RPC: `store.stats`, for tests and diagnostics. The chats,
//! their journal and the tasks are served by the `chats` and `tasks`
//! domains (T07), over the same `SharedStore`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use prism_protocol::{ErrorCode, HostError};
use prism_store::{import_v02_with, kinds, take_over_profiles, ImportOptions, Store, StoreError, DB_FILE};
use serde_json::Value;

use crate::domain::{CallContext, Domain, HandlerFuture};

/// How long a failed takeover of the desktop's profiles waits before the
/// next try.
const PROFILES_RETRY: Duration = Duration::from_secs(30);

/// The host database, opened once on first use and shared by the domains
/// that read or write it (`store`, `chats`, `tasks`). The first open of a
/// desktop host also imports Prism 0.2's data (`import_v02`, once, recorded
/// by its marker), takes the profiles over from the desktop (T08) and settles
/// turns a previous process left pending, so nothing shows as running that
/// is not.
pub struct SharedStore {
    path: Option<PathBuf>,
    /// Prism 0.2's folder (the desktop's Electron `userData`) to import from.
    import_from: Option<PathBuf>,
    slot: Mutex<Option<Arc<Store>>>,
    /// The profiles are the host's: taken over, or nothing to take over.
    profiles_owned: AtomicBool,
    /// When the takeover last failed.
    profiles_failed: Mutex<Option<Instant>>,
}

impl std::fmt::Debug for SharedStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedStore").field("path", &self.path).field("import_from", &self.import_from).finish_non_exhaustive()
    }
}

impl SharedStore {
    /// The database in the data directory the host is serving
    /// (`paths::data_dir`), importing from the desktop's `userData` when the
    /// host runs from it. Without a data directory (a host built in a test)
    /// every use answers `internal`.
    pub fn from_data_dir() -> Arc<Self> {
        let path = crate::paths::data_dir().map(|dir| dir.join(DB_FILE));
        Self::new(path, crate::paths::electron_user_data())
    }

    /// The database at `path`, with nothing to import.
    pub fn at(path: impl Into<PathBuf>) -> Arc<Self> {
        Self::new(Some(path.into()), None)
    }

    /// The database at `path`, importing Prism 0.2's data from `source` on
    /// first open.
    pub fn importing(path: impl Into<PathBuf>, source: impl Into<PathBuf>) -> Arc<Self> {
        Self::new(Some(path.into()), Some(source.into()))
    }

    /// An already open store.
    pub fn with_store(store: Arc<Store>) -> Arc<Self> {
        Arc::new(Self {
            path: store.path().map(PathBuf::from),
            import_from: None,
            slot: Mutex::new(Some(store)),
            profiles_owned: AtomicBool::new(true),
            profiles_failed: Mutex::new(None),
        })
    }

    fn new(path: Option<PathBuf>, import_from: Option<PathBuf>) -> Arc<Self> {
        let owned = import_from.is_none();
        Arc::new(Self { path, import_from, slot: Mutex::new(None), profiles_owned: AtomicBool::new(owned), profiles_failed: Mutex::new(None) })
    }

    /// T08: the desktop's profiles become the host's, once. A failure (the
    /// desktop's store busy) is only recorded: `profiles_taken_over` tries again.
    fn take_over(&self, store: &Store, source: &Path) -> Result<(), HostError> {
        match take_over_profiles(store, source) {
            Ok(count) => {
                if let Some(count) = count {
                    tracing::info!(count, "perfis assumidos pelo host");
                }
                self.profiles_owned.store(true, Ordering::Release);
                Ok(())
            }
            Err(err) => {
                tracing::warn!(%err, "falha ao assumir os perfis do Prism");
                *self.profiles_failed.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Instant::now());
                Err(profiles_pending())
            }
        }
    }

    /// Whether the profiles are the host's, trying the takeover again (at
    /// most every `PROFILES_RETRY`) when the first open could not. Until it
    /// works the host must not change a profile: the takeover would undo it
    /// (the desktop's documents win). Blocking.
    pub fn profiles_taken_over(&self) -> Result<(), HostError> {
        if self.profiles_owned.load(Ordering::Acquire) {
            return Ok(());
        }
        let store = self.get()?;
        let Some(source) = self.import_from.as_deref() else { return Ok(()) };
        if self.profiles_owned.load(Ordering::Acquire) {
            return Ok(());
        }
        let failed = *self.profiles_failed.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if failed.is_some_and(|at| at.elapsed() < PROFILES_RETRY) {
            return Err(profiles_pending());
        }
        self.take_over(&store, source)
    }

    /// Tests: as if `PROFILES_RETRY` had passed since the last failure.
    #[cfg(test)]
    pub(crate) fn retry_profiles_now(&self) {
        *self.profiles_failed.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    /// The open store, opening (and on first open importing and settling)
    /// it now. Blocking.
    pub fn get(&self) -> Result<Arc<Store>, HostError> {
        let mut slot = self.slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(store) = slot.as_ref() {
            return Ok(Arc::clone(store));
        }
        let path = self
            .path
            .as_ref()
            .ok_or_else(|| HostError::new(ErrorCode::Internal, "O armazenamento do host não está configurado."))?;
        let store = Store::open(path).map_err(store_error)?;
        if let (Some(source), Some(host_dir)) = (&self.import_from, path.parent()) {
            // The logins and the Usage store stay where the desktop keeps them
            // (a copied login forks its rotating refresh token).
            match import_v02_with(&store, source, host_dir, ImportOptions::IN_PLACE) {
                Ok(report) if !report.already_imported && !report.source_missing => {
                    tracing::info!(?report, "dados do Prism 0.2 importados para o host");
                }
                Ok(_) => {}
                Err(err) => tracing::warn!(%err, "falha ao importar os dados do Prism 0.2"),
            }
            // T08: the desktop's store owned the profiles until now.
            let _ = self.take_over(&store, source);
        }
        match settle_pending_turns(&store) {
            Ok(0) => {}
            Ok(settled) => tracing::info!(settled, "turnos sem processo marcados como interrompidos"),
            Err(err) => tracing::warn!(%err, "falha ao revisar turnos pendentes"),
        }
        match store.compact_large_journals() {
            Ok(0) => {}
            Ok(compacted) => tracing::info!(compacted, "diários grandes de chats compactados sem alterar o histórico"),
            Err(err) => tracing::warn!(%err, "falha ao compactar diários grandes de chats"),
        }
        let store = Arc::new(store);
        *slot = Some(Arc::clone(&store));
        Ok(store)
    }

    /// Opens it now on a thread of its own, so the first call does not wait
    /// for an import.
    pub fn warm_up(self: &Arc<Self>) {
        if self.path.is_none() {
            return;
        }
        let me = Arc::clone(self);
        let _ = std::thread::Builder::new().name("prism-store-open".into()).spawn(move || {
            if let Err(err) = me.get() {
                tracing::warn!(message = %err.message, "falha ao abrir o armazenamento do host");
            }
        });
    }
}

/// Chats that still show a pending turn with no process behind it: the
/// journal had nothing for that turn, so neither `Store::open` nor the import
/// could close it. Same rule as the renderer applied on start before T07:
/// the turn is interrupted, its live tools failed, and the native session is
/// not resumed.
fn settle_pending_turns(store: &Store) -> prism_store::Result<usize> {
    let mut settled = 0;
    for id in store.pending_chat_ids()? {
        let Some(chat) = store.chat(&id)? else { continue };
        let Some(pending) = chat.get("pendingTurnId").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned) else { continue };
        drop(chat);
        let Some(Value::Object(mut doc)) = store.document(kinds::CHATS, &id)? else { continue };
        doc.remove("pendingTurnId");
        doc.remove("resume");
        if let Some(turns) = doc.get_mut("turns").and_then(Value::as_array_mut) {
            for turn in turns.iter_mut().filter(|t| t.get("id").and_then(Value::as_str) == Some(pending.as_str())) {
                let Some(turn) = turn.as_object_mut() else { continue };
                turn.insert("interrupted".into(), Value::Bool(true));
                for segment in turn.get_mut("segments").and_then(Value::as_array_mut).into_iter().flatten() {
                    if matches!(segment.get("status").and_then(Value::as_str), Some("running" | "awaiting")) {
                        segment["status"] = Value::from("error");
                    }
                }
            }
        }
        store.put_document(kinds::CHATS, &id, &Value::Object(doc))?;
        settled += 1;
    }
    Ok(settled)
}

fn profiles_pending() -> HostError {
    HostError::new(ErrorCode::Internal, "As contas do Prism ainda não passaram para o host; tente de novo em instantes.")
}

pub(crate) fn store_error(err: StoreError) -> HostError {
    tracing::warn!(%err, "falha no armazenamento");
    HostError::new(ErrorCode::Internal, err.to_string())
}

pub struct StoreDomain {
    store: Arc<SharedStore>,
}

impl StoreDomain {
    pub fn new(store: Arc<SharedStore>) -> Self {
        Self { store }
    }

    /// The database in the data directory the host is serving, opened on first use.
    pub fn from_data_dir() -> Self {
        Self::new(SharedStore::from_data_dir())
    }

    /// The database at `path`, opened on first use.
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self::new(SharedStore::at(path))
    }

    /// An already open store (shared with whoever else writes it).
    pub fn with_store(store: Arc<Store>) -> Self {
        Self::new(SharedStore::with_store(store))
    }
}

impl Domain for StoreDomain {
    fn name(&self) -> &'static str {
        "store"
    }

    fn call(&self, method: &str, _params: Value, _ctx: CallContext) -> Option<HandlerFuture> {
        let shared = Arc::clone(&self.store);
        match method {
            "stats" => Some(Box::pin(async move {
                tokio::task::spawn_blocking(move || {
                    let stats = shared.get()?.stats().map_err(store_error)?;
                    serde_json::to_value(stats).map_err(|err| HostError::new(ErrorCode::Internal, err.to_string()))
                })
                .await
                .map_err(|err| HostError::new(ErrorCode::Internal, format!("Falha ao ler o armazenamento: {err}")))?
            })),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{next_client_id, Notifier};
    use crate::HostState;
    use prism_protocol::{Role, UserInfo};
    use serde_json::json;
    use tokio::sync::mpsc;

    fn ctx() -> CallContext {
        let (tx, _rx) = mpsc::unbounded_channel();
        CallContext {
            user: UserInfo { id: "owner".into(), name: "qa".into(), role: Role::Owner },
            notifier: Notifier::new(next_client_id(), tx),
            state: HostState::with_domains("t".into(), "h".into(), "Máquina".into(), "qa".into(), Vec::new()),
        }
    }

    #[tokio::test]
    async fn stats_opens_the_database_lazily() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let domain = StoreDomain::at(&path);
        assert!(!path.exists());
        let stats = domain.call("stats", Value::Null, ctx()).unwrap().await.unwrap();
        assert_eq!(stats["schemaVersion"], prism_store::SCHEMA_VERSION);
        assert_eq!(stats["events"], 0);
        assert!(path.exists());
        assert!(domain.call("nope", Value::Null, ctx()).is_none());
    }

    #[tokio::test]
    async fn without_a_data_dir_it_answers_internal() {
        let domain = StoreDomain::new(SharedStore::new(None, None));
        let err = domain.call("stats", Value::Null, ctx()).unwrap().await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Internal);
    }

    #[test]
    fn a_pending_turn_without_journal_is_settled_on_first_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        {
            let store = Store::open(&path).unwrap();
            let chat = json!({
                "id": "c", "title": "x", "cwd": "", "updatedAt": 1, "pendingTurnId": "t2",
                "resume": { "route": "claude:ambient-claude", "sessionId": "s" },
                "selection": { "provider": "claude", "profileId": "ambient-claude", "model": "" },
                "turns": [
                    { "id": "t1", "role": "user", "text": "oi" },
                    { "id": "t2", "role": "assistant", "text": "", "segments": [{ "kind": "tool", "toolId": "a", "status": "running" }, { "kind": "tool", "toolId": "b", "status": "done" }] }
                ]
            });
            store.put_chat(&chat).unwrap();
        }
        let chat = SharedStore::at(&path).get().unwrap().chat("c").unwrap().unwrap();
        assert!(chat.get("pendingTurnId").is_none() && chat.get("resume").is_none());
        assert_eq!(chat["turns"][1]["interrupted"], true);
        assert_eq!(chat["turns"][1]["segments"][0]["status"], "error");
        assert_eq!(chat["turns"][1]["segments"][1]["status"], "done");
    }

    /// A Prism 0.2 `userData` with one finished chat (journaled) and one that
    /// 0.2 left pending without any journal.
    fn legacy_user_data(root: &std::path::Path) -> PathBuf {
        let source = root.join("prism-ide");
        std::fs::create_dir_all(&source).unwrap();
        let conn = rusqlite::Connection::open(source.join("prism-agents.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE documents (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
             CREATE TABLE state (key TEXT PRIMARY KEY, body TEXT NOT NULL);
             CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL, body TEXT NOT NULL);",
        )
        .unwrap();
        let selection = json!({ "provider": "claude", "profileId": "ambient-claude", "model": "haiku" });
        let done = json!({
            "id": "done", "title": "Antigo", "cwd": "C:/repo", "updatedAt": 1, "selection": selection,
            "turns": [{ "id": "u1", "role": "user", "text": "oi" }, { "id": "a1", "role": "assistant", "text": "", "segments": [] }]
        });
        let stuck = json!({
            "id": "stuck", "title": "Preso", "cwd": "C:/repo", "updatedAt": 1, "pendingTurnId": "a2",
            "resume": { "route": "claude:ambient-claude", "sessionId": "s" }, "selection": selection,
            "turns": [{ "id": "u2", "role": "user", "text": "oi" }, { "id": "a2", "role": "assistant", "text": "", "segments": [{ "kind": "tool", "toolId": "x", "status": "running" }] }]
        });
        for (id, doc) in [("done", &done), ("stuck", &stuck)] {
            conn.execute("INSERT INTO documents VALUES ('chats', ?1, ?2)", rusqlite::params![id, doc.to_string()]).unwrap();
        }
        let events = [
            json!({ "kind": "begin", "turn": { "id": "a1", "role": "assistant", "text": "", "segments": [] }, "route": "claude:ambient-claude" }),
            json!({ "kind": "text", "text": "Olá do 0.2" }),
            json!({ "kind": "done", "aborted": false, "at": 5 }),
        ];
        for body in events {
            conn.execute("INSERT INTO events(chat_id, turn_id, body) VALUES ('done', 'a1', ?1)", [body.to_string()]).unwrap();
        }
        conn.execute("INSERT INTO documents VALUES ('tasks', 't1', ?1)", [json!({ "id": "t1", "cwd": "C:/repo", "title": "Projeto" }).to_string()]).unwrap();
        source
    }

    #[test]
    fn the_first_open_imports_prism_0_2_once_and_settles_what_it_left_pending() {
        let dir = tempfile::tempdir().unwrap();
        let source = legacy_user_data(dir.path());
        let path = dir.path().join("host").join(DB_FILE);
        {
            let store = SharedStore::importing(&path, &source).get().unwrap();
            let done = store.chat("done").unwrap().unwrap();
            assert_eq!(done["turns"][1]["segments"][0]["text"], "Olá do 0.2", "the journal came along and folds");
            assert_eq!(done["turns"][1]["error"], false);
            let stuck = store.chat("stuck").unwrap().unwrap();
            assert!(stuck.get("pendingTurnId").is_none() && stuck.get("resume").is_none(), "nothing shows as running");
            assert_eq!(stuck["turns"][1]["interrupted"], true);
            assert_eq!(stuck["turns"][1]["segments"][0]["status"], "error");
            assert_eq!(store.documents("tasks").unwrap().len(), 1);
            assert!(store.read_state(prism_store::import::MARKER_KEY).unwrap().is_some());
        }
        // Another process opening the same database imports nothing more.
        std::fs::remove_file(source.join("prism-agents.db")).unwrap();
        let again = SharedStore::importing(&path, &source).get().unwrap();
        assert_eq!(again.chats().unwrap().len(), 2);
        assert_eq!(again.events("done").unwrap().len(), 3);
    }

    #[test]
    fn an_explicit_path_never_imports() {
        let dir = tempfile::tempdir().unwrap();
        let _source = legacy_user_data(dir.path());
        let path = dir.path().join("host").join(DB_FILE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let store = SharedStore::at(&path).get().unwrap();
        assert!(store.chats().unwrap().is_empty());
        assert!(store.read_state(prism_store::import::MARKER_KEY).unwrap().is_none());
    }

    #[test]
    fn a_shared_store_opens_once_and_hands_out_the_same_database() {
        let dir = tempfile::tempdir().unwrap();
        let shared = SharedStore::at(dir.path().join(DB_FILE));
        let (a, b) = (shared.get().unwrap(), shared.get().unwrap());
        assert!(Arc::ptr_eq(&a, &b));
        let with = SharedStore::with_store(Arc::new(Store::open_in_memory().unwrap()));
        assert!(Arc::ptr_eq(&with.get().unwrap(), &with.get().unwrap()));
    }

    // ---- the profiles takeover is retried until it works (T08 review, item 3) ----

    use crate::domains::providers::HostProfiles;

    const PENDING: &str = "As contas do Prism ainda não passaram para o host; tente de novo em instantes.";

    /// A `prism-agents.db` that is not SQLite at all.
    fn broken_source(root: &std::path::Path) -> PathBuf {
        let source = root.join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("prism-agents.db"), b"isto nao e um banco sqlite, so lixo repetido ".repeat(200)).unwrap();
        source
    }

    /// Swaps the garbage for a desktop store with one profile.
    fn fix_source(source: &std::path::Path) {
        let db = source.join("prism-agents.db");
        std::fs::remove_file(&db).unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE documents (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));").unwrap();
        let profile = json!({ "id": "desktop", "provider": "claude", "name": "Do desktop" });
        conn.execute("INSERT INTO documents VALUES ('profiles', 'desktop', ?1)", [profile.to_string()]).unwrap();
    }

    fn ids(profiles: &HostProfiles) -> Vec<String> {
        let mut ids: Vec<String> = profiles.documents().unwrap().iter().map(|d| d["id"].as_str().unwrap().to_string()).collect();
        ids.sort();
        ids
    }

    #[test]
    fn a_failed_takeover_refuses_writes_until_it_works_and_then_the_desktop_profile_is_there() {
        let dir = tempfile::tempdir().unwrap();
        let source = broken_source(dir.path());
        let shared = SharedStore::importing(dir.path().join("host").join(DB_FILE), &source);
        let profiles = HostProfiles::new(Arc::clone(&shared), dir.path().join("provider-profiles"));
        let own = json!({ "id": "own", "provider": "codex", "name": "Do host" });

        // 1. The source is garbage: nothing is taken over and the host may not write.
        let err = profiles.put(&own).unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (ErrorCode::Internal, PENDING));
        assert!(ids(&profiles).is_empty(), "reading serves what the host has");

        // 2. The source is fixed, but the retry is not due yet: still refused.
        fix_source(&source);
        assert_eq!(profiles.put(&own).unwrap_err().message, PENDING, "no second attempt within PROFILES_RETRY");
        assert!(ids(&profiles).is_empty(), "documents() does not force the retry either");

        // 3. 30 s later it runs, works, and the desktop's profile arrives.
        shared.retry_profiles_now();
        profiles.put(&own).unwrap();
        assert_eq!(ids(&profiles), ["desktop", "own"]);
        assert!(shared.get().unwrap().read_state(prism_store::import::PROFILES_MARKER_KEY).unwrap().is_some());
        // And it stays done.
        profiles.put(&json!({ "id": "again", "provider": "codex", "name": "Outra" })).unwrap();
        assert_eq!(ids(&profiles), ["again", "desktop", "own"]);
    }

    #[test]
    fn a_read_after_the_retry_is_due_also_takes_over() {
        let dir = tempfile::tempdir().unwrap();
        let source = broken_source(dir.path());
        let shared = SharedStore::importing(dir.path().join("host").join(DB_FILE), &source);
        let profiles = HostProfiles::new(Arc::clone(&shared), dir.path().join("provider-profiles"));
        assert!(ids(&profiles).is_empty());
        fix_source(&source);
        shared.retry_profiles_now();
        assert_eq!(ids(&profiles), ["desktop"], "documents() tries the takeover again once it is due");
    }
}
