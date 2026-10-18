//! The providers domain driven through `Domain::call`, as an owner and a
//! member: everything lives in a temporary folder (host database, the
//! profiles' own folders, a fake `.traycer`), the chats engine runs fake
//! providers and Codex a launcher that never starts a process.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use prism_agents::codex::{AppServer, BoxFuture as CodexFuture, CodexError, CodexErrorKind, CodexQueries, CodexSessions, Launcher};
use prism_agents::profile_env::{ProfileSource, Profiles};
use prism_protocol::{ErrorCode, HostError, Role, UserInfo};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::*;
use crate::domain::next_client_id;
use crate::domains::chats::{BoxFuture, Runner, Runners, TurnEvent, TurnSink, TurnStart};
use crate::domains::store::SharedStore;
use crate::HostState;

const OWNER_ONLY: &str = "Só o dono do host gerencia as contas.";

/// A Codex that cannot start anything: `launch` fails and counts.
#[derive(Default)]
struct NoCodex {
    launches: AtomicUsize,
}

impl Launcher for NoCodex {
    fn check(&self, _profile_id: String) -> CodexFuture<'_, Result<(), CodexError>> {
        Box::pin(async { Ok(()) })
    }

    fn account(&self, profile_id: String) -> CodexFuture<'_, Result<String, CodexError>> {
        Box::pin(async move { Ok(profile_id) })
    }

    fn launch(&self, _profile_id: String, _cwd: Option<String>) -> CodexFuture<'_, Result<Arc<AppServer>, CodexError>> {
        self.launches.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(CodexError::new(CodexErrorKind::Failed, "sem Codex nos testes")) })
    }
}

/// A chats provider that accepts every turn and reports nothing until told.
#[derive(Default)]
struct Silent {
    sinks: Mutex<Vec<TurnSink>>,
    /// Runs as each turn starts (what the account looked like at that moment).
    on_start: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

struct SilentRunner(Arc<Silent>);

impl Runner for SilentRunner {
    fn start(&self, _turn: TurnStart, sink: TurnSink) -> BoxFuture<Result<(), String>> {
        if let Some(hook) = self.0.on_start.lock().unwrap().as_ref() {
            hook();
        }
        self.0.sinks.lock().unwrap().push(sink);
        Box::pin(async { Ok(()) })
    }

    fn abort(&self, _chat_id: &str, _turn_id: &str) {}

    fn permission(&self, _chat_id: &str, _turn_id: &str, _perm_id: &str, _decision: &str, _updated_input: Option<Value>) {}

    fn question(&self, _chat_id: &str, _turn_id: &str, _dialog_id: &str, _answers: Option<serde_json::Map<String, Value>>, _response: Option<String>) {}
}

struct Client {
    ctx: CallContext,
    notes: mpsc::UnboundedReceiver<String>,
}

impl Client {
    /// The `providers.changed` lists received so far (each the list of profiles).
    fn changes(&mut self) -> Vec<Vec<Value>> {
        let mut out = Vec::new();
        while let Ok(text) = self.notes.try_recv() {
            let note: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(note["method"], "providers.changed");
            out.push(note["params"]["profiles"].as_array().unwrap().clone());
        }
        out
    }
}

struct Rig {
    dir: tempfile::TempDir,
    domain: ProvidersDomain,
    chats: Arc<ChatsDomain>,
    store: Arc<SharedStore>,
    state: Arc<HostState>,
    silent: Arc<Silent>,
    codex: Arc<NoCodex>,
}

impl Rig {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = SharedStore::at(dir.path().join("prism-host.db"));
        let host_profiles = Arc::new(HostProfiles::new(Arc::clone(&store), dir.path().join("provider-profiles")));
        let profiles = Profiles::with_roots(Arc::clone(&host_profiles) as Arc<dyn ProfileSource>, dir.path().join("home"), dir.path().join("traycer"));
        let codex = Arc::new(NoCodex::default());
        let launcher: Arc<dyn Launcher> = codex.clone();
        let (sessions, queries) = (CodexSessions::new(Arc::clone(&launcher)), CodexQueries::new(launcher));
        let silent = Arc::new(Silent::default());
        let runner: Arc<dyn Runner> = Arc::new(SilentRunner(Arc::clone(&silent)));
        let chats = Arc::new(ChatsDomain::new(Arc::clone(&store), Runners { claude: Some(Arc::clone(&runner)), codex: Some(runner) }));
        let domain = ProvidersDomain::new(ProvidersParts {
            host_profiles,
            catalogs: Catalogs::new(profiles.clone(), None, Arc::clone(&queries)),
            profiles,
            chats: Arc::clone(&chats),
            claude: None,
            codex: sessions,
            codex_queries: queries,
        });
        let state = HostState::with_domains("t".into(), "h".into(), "Máquina".into(), "qa".into(), Vec::new());
        Rig { dir, domain, chats, store, state, silent, codex }
    }

    fn client(&self, role: Role) -> Client {
        let (tx, notes) = mpsc::unbounded_channel();
        let ctx = CallContext {
            user: UserInfo { id: format!("{role:?}"), name: "qa".into(), role },
            notifier: Notifier::new(next_client_id(), tx),
            state: Arc::clone(&self.state),
        };
        Client { ctx, notes }
    }

    async fn call(&self, client: &Client, method: &str, params: Value) -> Result<Value, HostError> {
        self.domain.call(method, params, client.ctx.clone()).unwrap_or_else(|| panic!("providers.{method} does not exist")).await
    }

    async fn chat_call(&self, client: &Client, method: &str, params: Value) -> Result<Value, HostError> {
        self.chats.call(method, params, client.ctx.clone()).unwrap().await
    }

    fn profiles_root(&self) -> PathBuf {
        self.dir.path().join("provider-profiles")
    }

    fn traycer_root(&self) -> PathBuf {
        self.dir.path().join("traycer")
    }

    /// The stored document of a profile.
    fn doc(&self, id: &str) -> Option<Value> {
        self.store.get().unwrap().document("profiles", id).unwrap()
    }

    fn chat(&self, id: &str) -> Value {
        self.store.get().unwrap().chat(id).unwrap().unwrap()
    }

    /// Creates a profile as the owner and returns its id.
    async fn profile(&self, owner: &Client, provider: &str, name: &str) -> String {
        self.call(owner, "create", json!({ "provider": provider, "name": name })).await.unwrap()["id"].as_str().unwrap().to_string()
    }

    /// A chat on the profile with a turn running (nothing ends it until `finish_turns`).
    async fn run_turn(&self, owner: &Client, chat: &str, provider: &str, profile: &str, resume: bool) {
        let mut doc = json!({
            "id": chat, "title": "Novo chat", "cwd": "C:/repo", "createdAt": 1, "updatedAt": 1, "turns": [],
            "selection": { "provider": provider, "profileId": profile, "model": "m", "effort": "low", "permissionMode": "default" }
        });
        if resume {
            doc["resume"] = json!({ "route": format!("{provider}:{profile}"), "sessionId": "s" });
        }
        self.chat_call(owner, "create", json!({ "chat": doc })).await.unwrap();
        self.chat_call(owner, "send", json!({ "chatId": chat, "text": "oi" })).await.unwrap();
        self.wait_busy(owner, |ids| ids.iter().any(|id| id == profile)).await;
    }

    /// A chat that only resumes the profile's session (no turn).
    async fn idle_chat(&self, owner: &Client, chat: &str, provider: &str, profile: &str, resume: bool) {
        let mut doc = json!({
            "id": chat, "title": "Parado", "cwd": "C:/repo", "createdAt": 1, "updatedAt": 1, "turns": [],
            "selection": { "provider": provider, "profileId": profile, "model": "m", "effort": "low", "permissionMode": "default" }
        });
        if resume {
            doc["resume"] = json!({ "route": format!("{provider}:{profile}"), "sessionId": "s" });
        }
        self.chat_call(owner, "create", json!({ "chat": doc })).await.unwrap();
    }

    async fn wait_busy(&self, owner: &Client, until: impl Fn(&[String]) -> bool) {
        for _ in 0..200 {
            let busy = self.chat_call(owner, "busyProfiles", json!({})).await.unwrap();
            let ids: Vec<String> = busy["profileIds"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
            if until(&ids) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("the chats engine never reached the expected busy state");
    }

    async fn finish_turns(&self, owner: &Client) {
        let sinks: Vec<TurnSink> = self.silent.sinks.lock().unwrap().drain(..).collect();
        for sink in sinks {
            sink.send(TurnEvent::Done { aborted: false });
        }
        self.wait_busy(owner, |ids| ids.is_empty()).await;
    }

    /// A fake `.traycer`: `(Traycer provider id, profile id, has a login file)`.
    fn fake_traycer(&self, accounts: &[(&str, &str, bool)]) {
        let root = self.traycer_root();
        std::fs::create_dir_all(root.join("host").join("config")).unwrap();
        let listed: Vec<Value> = accounts.iter().map(|(provider, id, _)| json!({ "profileId": id, "providerId": provider, "kind": "managed" })).collect();
        std::fs::write(root.join("host").join("config").join("provider-accounts.json"), json!({ "profiles": listed }).to_string()).unwrap();
        for (provider, id, login) in accounts {
            let home = root.join("host").join("harness-accounts").join(provider).join(id);
            std::fs::create_dir_all(&home).unwrap();
            if *login {
                let file = if *provider == "codex" { "auth.json" } else { ".credentials.json" };
                std::fs::write(home.join(file), "traycer-login").unwrap();
            }
        }
    }

    fn link(&self, provider_id: &str, profile_id: &str) -> Value {
        json!({ "root": self.traycer_root().to_string_lossy(), "providerId": provider_id, "profileId": profile_id })
    }
}

fn code(result: Result<Value, HostError>) -> (ErrorCode, String) {
    let err = result.unwrap_err();
    (err.code, err.message)
}

fn names(list: &[Value]) -> Vec<String> {
    list.iter().map(|p| p["name"].as_str().unwrap_or_default().to_string()).collect()
}

fn entries(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    out.sort();
    out
}

#[tokio::test]
async fn a_member_may_read_but_never_manage_accounts() {
    let rig = Rig::new();
    let (owner, member) = (rig.client(Role::Owner), rig.client(Role::Member));
    let id = rig.profile(&owner, "claude", "Trabalho").await;

    let list = rig.call(&member, "list", json!({})).await.unwrap();
    assert_eq!(names(list["profiles"].as_array().unwrap()), ["Conta do terminal", "Conta do terminal", "Trabalho"]);

    let attempts = [
        ("create", json!({ "provider": "claude", "name": "x" })),
        ("update", json!({ "id": id, "name": "x" })),
        ("rename", json!({ "id": id, "name": "x" })),
        ("remove", json!({ "id": id })),
        ("login", json!({ "provider": "claude", "id": id })),
        ("loginInput", json!({ "id": id, "text": "x" })),
        ("loginResize", json!({ "id": id, "cols": 80, "rows": 24 })),
        ("loginCancel", json!({ "id": id })),
        ("stored", json!({})),
        ("importProfiles", json!({ "profiles": [] })),
        ("setLink", json!({ "id": id, "link": null })),
        ("codexReset", json!({ "profileId": "ambient-codex", "idempotencyKey": "abcdefgh-1234", "creditId": null })),
    ];
    for (method, params) in attempts {
        assert_eq!(code(rig.call(&member, method, params).await), (ErrorCode::Forbidden, OWNER_ONLY.to_string()), "{method}");
    }
    // Nothing happened.
    assert_eq!(rig.rig_names(), ["Trabalho"]);
    assert_eq!(rig.codex.launches.load(Ordering::SeqCst), 0);
    assert!(rig.domain.call("nao-existe", json!({}), member.ctx.clone()).is_none());
}

impl Rig {
    fn rig_names(&self) -> Vec<String> {
        let mut docs: Vec<String> = self.store.get().unwrap().documents("profiles").unwrap().iter().map(|d| d["name"].as_str().unwrap().to_string()).collect();
        docs.sort();
        docs
    }
}

#[tokio::test]
async fn create_validates_trims_cuts_and_makes_the_accounts_own_folder() {
    let rig = Rig::new();
    let owner = rig.client(Role::Owner);
    let message = "Informe o agente e o nome da conta.";
    for params in [
        json!({ "provider": "gemini", "name": "x" }),
        json!({ "provider": "", "name": "x" }),
        json!({ "provider": "claude", "name": "" }),
        json!({ "provider": "codex", "name": "   \t " }),
    ] {
        assert_eq!(code(rig.call(&owner, "create", params).await), (ErrorCode::Invalid, message.to_string()));
    }
    assert!(rig.rig_names().is_empty());

    let long = format!("  {}  ", "ñ".repeat(100));
    let doc = rig.call(&owner, "create", json!({ "provider": "codex", "name": long })).await.unwrap();
    assert_eq!(doc["provider"], "codex");
    assert_eq!(doc["name"].as_str().unwrap().chars().count(), 80, "cut at 80 characters, after trimming");
    let id = doc["id"].as_str().unwrap();
    assert!(profiles::is_profile_folder_name(id));
    assert!(rig.profiles_root().join(id).is_dir(), "its own folder exists");
    assert_eq!(rig.doc(id).unwrap(), doc);
    assert!(doc.get("credentialLink").is_none() && doc.get("enabled").is_none());
}

#[tokio::test]
async fn every_client_that_called_the_domain_hears_changes_and_a_stranger_does_not() {
    let rig = Rig::new();
    let (mut owner, mut member, mut stranger) = (rig.client(Role::Owner), rig.client(Role::Member), rig.client(Role::Member));
    rig.call(&member, "list", json!({})).await.unwrap();
    rig.call(&owner, "list", json!({})).await.unwrap();

    let id = rig.profile(&owner, "claude", "A").await;
    rig.call(&owner, "rename", json!({ "id": id, "name": "B" })).await.unwrap();
    for client in [&mut owner, &mut member] {
        let lists = client.changes();
        assert_eq!(lists.len(), 2, "one per change");
        assert_eq!(names(&lists[0]), ["Conta do terminal", "Conta do terminal", "A"]);
        assert_eq!(names(&lists[1])[2], "B");
    }
    assert!(stranger.changes().is_empty(), "a client that never called providers hears nothing");

    // A client that disconnects stops hearing; so does one whose socket closed.
    rig.domain.disconnected(member.ctx.notifier.client);
    drop(owner.notes);
    let mut other = rig.client(Role::Owner);
    rig.call(&other, "list", json!({})).await.unwrap();
    rig.call(&other, "rename", json!({ "id": id, "name": "C" })).await.unwrap();
    assert_eq!(other.changes().len(), 1);
    assert!(member.changes().is_empty());
}

#[tokio::test]
async fn update_validates_and_edits_only_what_was_sent() {
    let rig = Rig::new();
    let owner = rig.client(Role::Owner);
    let id = rig.profile(&owner, "claude", "Trabalho").await;

    assert_eq!(code(rig.call(&owner, "update", json!({ "id": "ambient-claude", "name": "x" })).await), (ErrorCode::Invalid, "A conta do terminal é gerenciada pelo terminal.".to_string()));
    for name in ["", "  "] {
        assert_eq!(code(rig.call(&owner, "update", json!({ "id": id, "name": name })).await), (ErrorCode::Invalid, "Informe um nome.".to_string()));
    }
    for color in ["red", "#12345", "#1234567", "#GGGGGG", "123456", "#12 456"] {
        assert_eq!(code(rig.call(&owner, "update", json!({ "id": id, "color": color })).await), (ErrorCode::Invalid, "Cor inválida.".to_string()), "{color}");
    }
    assert_eq!(rig.doc(&id).unwrap()["name"], "Trabalho");

    rig.call(&owner, "update", json!({ "id": id, "color": "#aBc012" })).await.unwrap();
    assert_eq!(rig.doc(&id).unwrap()["color"], "#aBc012");
    rig.call(&owner, "update", json!({ "id": id, "color": "" })).await.unwrap();
    assert_eq!(rig.doc(&id).unwrap()["color"], "#aBc012", "an empty colour is ignored");
    rig.call(&owner, "update", json!({ "id": id, "name": "  Casa  " })).await.unwrap();
    let doc = rig.doc(&id).unwrap();
    assert_eq!((doc["name"].as_str(), doc["color"].as_str(), doc.get("enabled")), (Some("Casa"), Some("#aBc012"), None));

    let list = rig.call(&owner, "update", json!({ "id": id, "enabled": true })).await.unwrap();
    assert_eq!(rig.doc(&id).unwrap()["enabled"], true);
    assert_eq!(list["profiles"].as_array().unwrap().len(), 3, "answers the public list");

    // An id nobody has changes nothing and creates nothing.
    rig.call(&owner, "update", json!({ "id": "fantasma", "name": "x" })).await.unwrap();
    assert!(rig.doc("fantasma").is_none());
}

#[tokio::test]
async fn turning_an_account_off_is_busy_while_it_runs() {
    let rig = Rig::new();
    let owner = rig.client(Role::Owner);
    let id = rig.profile(&owner, "claude", "Trabalho").await;
    rig.run_turn(&owner, "c1", "claude", &id, false).await;

    assert_eq!(
        code(rig.call(&owner, "update", json!({ "id": id, "enabled": false })).await),
        (ErrorCode::Busy, "Pare as tarefas desta conta antes de alterá-la.".to_string())
    );
    assert!(rig.doc(&id).unwrap().get("enabled").is_none());
    // Renaming or turning it on is fine while it runs.
    rig.call(&owner, "update", json!({ "id": id, "name": "Novo", "enabled": true })).await.unwrap();

    rig.finish_turns(&owner).await;
    rig.call(&owner, "update", json!({ "id": id, "enabled": false })).await.unwrap();
    assert_eq!(rig.doc(&id).unwrap()["enabled"], false);
}

#[tokio::test]
async fn rename_trims_cuts_and_rejects_an_empty_name() {
    let rig = Rig::new();
    let owner = rig.client(Role::Owner);
    let id = rig.profile(&owner, "codex", "Antes").await;
    for name in ["", "   "] {
        assert_eq!(code(rig.call(&owner, "rename", json!({ "id": id, "name": name })).await), (ErrorCode::Invalid, "Informe um nome.".to_string()));
    }
    assert_eq!(rig.doc(&id).unwrap()["name"], "Antes");
    rig.call(&owner, "rename", json!({ "id": id, "name": format!(" {} ", "a".repeat(120)) })).await.unwrap();
    assert_eq!(rig.doc(&id).unwrap()["name"], "a".repeat(80));
    rig.call(&owner, "rename", json!({ "id": id, "name": " Depois " })).await.unwrap();
    assert_eq!(rig.doc(&id).unwrap()["name"], "Depois");
    rig.call(&owner, "rename", json!({ "id": "fantasma", "name": "x" })).await.unwrap();
    assert!(rig.doc("fantasma").is_none());
}

#[tokio::test]
async fn remove_refuses_the_terminal_account_unknown_ids_and_a_running_one() {
    let rig = Rig::new();
    let owner = rig.client(Role::Owner);
    for id in ["", "ambient-claude", "ambient-codex"] {
        assert_eq!(
            code(rig.call(&owner, "remove", json!({ "id": id })).await),
            (ErrorCode::Invalid, "A conta do terminal é gerenciada pelo terminal e não pode ser removida.".to_string()),
            "{id:?}"
        );
    }
    assert_eq!(code(rig.call(&owner, "remove", json!({ "id": "fantasma" })).await), (ErrorCode::NotFound, "Conta não encontrada.".to_string()));

    let id = rig.profile(&owner, "claude", "Trabalho").await;
    rig.run_turn(&owner, "c1", "claude", &id, false).await;
    assert_eq!(code(rig.call(&owner, "remove", json!({ "id": id })).await), (ErrorCode::Busy, "Pare as tarefas desta conta antes de removê-la.".to_string()));
    assert!(rig.doc(&id).unwrap().get("tombstoned").is_none());
    assert!(rig.profiles_root().join(&id).is_dir());
    assert_eq!(rig.chat("c1")["selection"]["profileId"], id.as_str(), "nothing moved");
}

#[tokio::test]
async fn remove_moves_the_chats_to_the_terminal_account_tombstones_and_deletes_the_folder() {
    let rig = Rig::new();
    let (mut owner, mut member) = (rig.client(Role::Owner), rig.client(Role::Member));
    rig.call(&member, "list", json!({})).await.unwrap();
    let id = rig.profile(&owner, "claude", "Trabalho").await;
    let other = rig.profile(&owner, "claude", "Outra").await;
    std::fs::create_dir_all(rig.profiles_root().join(&id).join("sessions")).unwrap();
    std::fs::write(rig.profiles_root().join(&id).join("sessions").join("s.jsonl"), "x").unwrap();
    rig.idle_chat(&owner, "mine", "claude", &id, true).await;
    rig.idle_chat(&owner, "theirs", "claude", &other, true).await;
    owner.changes();
    member.changes();

    let list = rig.call(&owner, "remove", json!({ "id": id })).await.unwrap();
    let removed = list["profiles"].as_array().unwrap().iter().find(|p| p["id"] == id.as_str()).unwrap().clone();
    assert_eq!((removed["tombstoned"].clone(), removed["enabled"].clone()), (json!(true), json!(false)));
    assert_eq!(rig.doc(&id).unwrap()["tombstoned"], true);
    assert!(!rig.profiles_root().join(&id).exists(), "its own folder is gone");
    assert!(rig.profiles_root().join(&other).is_dir(), "other accounts keep theirs");

    let moved = rig.chat("mine");
    assert_eq!(moved["selection"]["profileId"], "ambient-claude");
    assert!(moved.get("resume").is_none());
    assert_eq!(rig.chat("theirs")["selection"]["profileId"], other.as_str());
    assert_eq!(owner.changes().len(), 1);
    assert_eq!(member.changes().len(), 1, "everyone is told");

    // Removed means gone, for removal and for linking.
    assert_eq!(code(rig.call(&owner, "remove", json!({ "id": id })).await), (ErrorCode::NotFound, "Conta não encontrada.".to_string()));
    assert_eq!(code(rig.call(&owner, "setLink", json!({ "id": id, "link": null })).await), (ErrorCode::NotFound, "Conta não encontrada.".to_string()));
}

#[tokio::test]
async fn import_profiles_refuses_bad_ones_whole_and_stores_the_good_ones() {
    let rig = Rig::new();
    let owner = rig.client(Role::Owner);
    let good = json!({ "id": "traycer-01", "provider": "claude", "name": "Do Traycer" });
    let bad = [
        json!({ "id": "../x", "provider": "claude", "name": "x" }),
        json!({ "id": "", "provider": "claude", "name": "x" }),
        json!({ "id": "a b", "provider": "claude", "name": "x" }),
        json!({ "id": "ambient-claude", "provider": "claude", "name": "x" }),
        json!({ "id": 7, "provider": "claude", "name": "x" }),
        json!({ "id": "ok", "provider": "gemini", "name": "x" }),
        json!({ "id": "ok", "name": "x" }),
        json!({ "id": "ok", "provider": "claude" }),
        json!({ "id": "ok", "provider": "claude", "name": 5 }),
        json!("não é objeto"),
    ];
    for doc in bad {
        let result = rig.call(&owner, "importProfiles", json!({ "profiles": [good.clone(), doc.clone()] })).await;
        assert_eq!(code(result), (ErrorCode::Invalid, "Perfil inválido.".to_string()), "{doc}");
    }
    assert!(rig.rig_names().is_empty(), "a bad one rejects the whole batch");
    assert!(!rig.profiles_root().join("traycer-01").exists());

    let link = rig.link("claude-code", "t1");
    let linked = json!({ "id": "traycer-02", "provider": "codex", "name": "Vinculada", "credentialLink": link });
    let list = rig.call(&owner, "importProfiles", json!({ "profiles": [good.clone(), linked.clone()] })).await.unwrap();
    assert_eq!(rig.doc("traycer-01").unwrap(), good);
    assert_eq!(rig.doc("traycer-02").unwrap(), linked, "stored as given, link included");
    assert!(rig.profiles_root().join("traycer-01").is_dir() && rig.profiles_root().join("traycer-02").is_dir());
    assert!(list["profiles"].as_array().unwrap().iter().all(|p| p.get("credentialLink").is_none()), "the public list never carries the link");

    // Importing again replaces the same ids.
    let renamed = json!({ "id": "traycer-01", "provider": "claude", "name": "Novo nome" });
    rig.call(&owner, "importProfiles", json!({ "profiles": [renamed.clone()] })).await.unwrap();
    assert_eq!(rig.doc("traycer-01").unwrap(), renamed);
    assert_eq!(rig.rig_names().len(), 2);
}

#[tokio::test]
async fn stored_gives_the_owner_the_documents_with_their_links() {
    let rig = Rig::new();
    let owner = rig.client(Role::Owner);
    let link = rig.link("claude-code", "t1");
    let linked = json!({ "id": "traycer-02", "provider": "claude", "name": "Vinculada", "credentialLink": link });
    rig.call(&owner, "importProfiles", json!({ "profiles": [linked.clone()] })).await.unwrap();
    let stored = rig.call(&owner, "stored", json!({})).await.unwrap();
    assert_eq!(stored["profiles"], json!([linked]));
    let public = rig.call(&owner, "list", json!({})).await.unwrap();
    let public = public["profiles"].as_array().unwrap().iter().find(|p| p["id"] == "traycer-02").unwrap().clone();
    assert_eq!(public["traycerLink"], "broken", "no fake Traycer yet");
}

#[tokio::test]
async fn set_link_refuses_unknown_accounts_other_providers_and_a_traycer_without_login() {
    let rig = Rig::new();
    let owner = rig.client(Role::Owner);
    let id = rig.profile(&owner, "claude", "Trabalho").await;
    let missing = (ErrorCode::NotFound, "Conta não encontrada.".to_string());
    assert_eq!(code(rig.call(&owner, "setLink", json!({ "id": "fantasma", "link": null })).await), missing);

    // The Traycer account must be of the profile's own agent.
    rig.fake_traycer(&[("claude-code", "acc", true), ("codex", "cod", true), ("claude-code", "vazia", false)]);
    assert_eq!(
        code(rig.call(&owner, "setLink", json!({ "id": id, "link": rig.link("codex", "cod") })).await),
        (ErrorCode::Invalid, "Esta conta não foi importada desta instalação do Traycer.".to_string())
    );
    let no_login = (ErrorCode::Invalid, "O Traycer não tem um login ativo para esta conta. Entre nela pelo Traycer e tente de novo.".to_string());
    assert_eq!(code(rig.call(&owner, "setLink", json!({ "id": id, "link": rig.link("claude-code", "vazia") })).await), no_login);
    assert_eq!(code(rig.call(&owner, "setLink", json!({ "id": id, "link": rig.link("claude-code", "nao-existe") })).await), no_login);
    assert_eq!(code(rig.call(&owner, "setLink", json!({ "id": id, "link": rig.link("claude-code", "../acc") })).await), no_login);
    assert!(rig.doc(&id).unwrap().get("credentialLink").is_none());

    // A tombstoned account reads as removed.
    rig.call(&owner, "remove", json!({ "id": id })).await.unwrap();
    assert_eq!(code(rig.call(&owner, "setLink", json!({ "id": id, "link": rig.link("claude-code", "acc") })).await), missing);
}

#[tokio::test]
async fn set_link_is_busy_while_the_account_runs_and_names_it() {
    let rig = Rig::new();
    let owner = rig.client(Role::Owner);
    let id = rig.profile(&owner, "claude", "Conta “Trabalho”").await;
    rig.fake_traycer(&[("claude-code", "acc", true)]);
    std::fs::write(rig.profiles_root().join(&id).join(".credentials.json"), "own-login").unwrap();
    rig.run_turn(&owner, "c1", "claude", &id, false).await;

    let result = rig.call(&owner, "setLink", json!({ "id": id, "link": rig.link("claude-code", "acc") })).await;
    assert_eq!(code(result), (ErrorCode::Busy, "Pare as tarefas da conta “Conta “Trabalho”” antes de trocar o login dela.".to_string()));
    assert!(rig.doc(&id).unwrap().get("credentialLink").is_none(), "nothing changed");
    assert_eq!(entries(&rig.profiles_root().join(&id)), [".credentials.json"], "the login was not retired");

    rig.finish_turns(&owner).await;
    rig.call(&owner, "setLink", json!({ "id": id, "link": rig.link("claude-code", "acc") })).await.unwrap();
    assert!(rig.doc(&id).unwrap().get("credentialLink").is_some());
}

#[tokio::test]
async fn linking_retires_the_own_login_forgets_sessions_and_tells_everyone() {
    let rig = Rig::new();
    let (mut owner, mut member) = (rig.client(Role::Owner), rig.client(Role::Member));
    rig.call(&member, "list", json!({})).await.unwrap();
    let id = rig.profile(&owner, "claude", "Trabalho").await;
    let other = rig.profile(&owner, "claude", "Outra").await;
    rig.fake_traycer(&[("claude-code", "acc", true)]);
    let own = rig.profiles_root().join(&id);
    std::fs::write(own.join(".credentials.json"), "own-login").unwrap();
    std::fs::write(own.join("settings.json"), "{}").unwrap();
    rig.idle_chat(&owner, "resumes", "claude", &id, true).await;
    rig.idle_chat(&owner, "elsewhere", "claude", &other, true).await;
    owner.changes();
    member.changes();

    let link = rig.link("claude-code", "acc");
    let list = rig.call(&owner, "setLink", json!({ "id": id, "link": link.clone() })).await.unwrap();

    assert_eq!(rig.doc(&id).unwrap()["credentialLink"], link);
    let public = list["profiles"].as_array().unwrap().iter().find(|p| p["id"] == id.as_str()).unwrap().clone();
    assert_eq!(public["traycerLink"], "linked");
    assert!(public.get("credentialLink").is_none());

    // The copy of the login is renamed, never deleted.
    let left = entries(&own);
    assert_eq!(left.len(), 2, "{left:?}");
    assert!(left.contains(&"settings.json".to_string()));
    let retired = left.iter().find(|n| n.starts_with(".credentials.json.replaced-by-traycer-link-")).expect("retired login");
    assert!(retired[".credentials.json.replaced-by-traycer-link-".len()..].bytes().all(|b| b.is_ascii_digit()));
    assert_eq!(std::fs::read_to_string(own.join(retired)).unwrap(), "own-login");

    assert!(rig.chat("resumes").get("resume").is_none(), "its native sessions are forgotten");
    assert!(rig.chat("elsewhere").get("resume").is_some());
    assert_eq!(owner.changes().len(), 1);
    assert_eq!(member.changes().len(), 1);

    // Unlinking goes back to its own login, forgets sessions again, and an
    // unlink of an account that has no link changes nothing.
    rig.idle_chat(&owner, "again", "claude", &id, true).await;
    rig.call(&owner, "setLink", json!({ "id": id, "link": null })).await.unwrap();
    assert!(rig.doc(&id).unwrap().get("credentialLink").is_none());
    assert!(rig.chat("again").get("resume").is_none());
    assert!(entries(&own).iter().any(|n| n.starts_with(".credentials.json.replaced-by-traycer-link-")), "the retired copy stays");
    rig.idle_chat(&owner, "kept", "claude", &id, true).await;
    owner.changes();
    rig.call(&owner, "setLink", json!({ "id": id, "link": null })).await.unwrap();
    assert!(rig.chat("kept").get("resume").is_some(), "nothing to unlink, nothing forgotten");
    assert_eq!(owner.changes().len(), 1, "still answers and publishes the list");
}

#[tokio::test]
async fn linking_without_an_own_login_file_just_links() {
    let rig = Rig::new();
    let owner = rig.client(Role::Owner);
    let id = rig.profile(&owner, "codex", "Codex").await;
    rig.fake_traycer(&[("codex", "cod", true)]);
    rig.call(&owner, "setLink", json!({ "id": id, "link": rig.link("codex", "cod") })).await.unwrap();
    assert!(rig.doc(&id).unwrap().get("credentialLink").is_some());
    assert!(entries(&rig.profiles_root().join(&id)).is_empty());
}

#[tokio::test]
async fn login_refuses_what_cannot_log_in_before_starting_anything() {
    let rig = Rig::new();
    let owner = rig.client(Role::Owner);
    assert_eq!(code(rig.call(&owner, "login", json!({ "provider": "gemini", "id": "x" })).await), (ErrorCode::Invalid, "Agente inválido.".to_string()));
    assert_eq!(code(rig.call(&owner, "login", json!({ "provider": "claude", "id": "fantasma" })).await).0, ErrorCode::NotFound);
    assert_eq!(
        code(rig.call(&owner, "login", json!({ "provider": "claude", "id": "ambient-claude" })).await),
        (ErrorCode::Invalid, "Adicione uma conta para fazer login sem alterar a conta do terminal.".to_string())
    );

    // A linked account always refuses, live or broken.
    let id = rig.profile(&owner, "claude", "Vinculada").await;
    rig.fake_traycer(&[("claude-code", "acc", true)]);
    let refusal = (ErrorCode::Invalid, "Esta conta usa o login do Traycer. Entre pelo Traycer ou desvincule para entrar no Prism.".to_string());
    rig.call(&owner, "setLink", json!({ "id": id, "link": rig.link("claude-code", "acc") })).await.unwrap();
    assert_eq!(code(rig.call(&owner, "login", json!({ "provider": "claude", "id": id })).await), refusal);
    rig.fake_traycer(&[]);
    let broken = rig.call(&owner, "login", json!({ "provider": "claude", "id": id })).await;
    assert_ne!(code(broken).0, ErrorCode::Internal, "a broken link is refused, never started");

    // A running turn comes first.
    let plain = rig.profile(&owner, "claude", "Simples").await;
    rig.run_turn(&owner, "c1", "claude", &plain, false).await;
    assert_eq!(
        code(rig.call(&owner, "login", json!({ "provider": "claude", "id": plain })).await),
        (ErrorCode::Busy, "Pare as tarefas desta conta antes de fazer login novamente.".to_string())
    );
}

#[tokio::test]
async fn codex_reset_validates_its_arguments_and_never_reaches_a_real_codex() {
    let rig = Rig::new();
    let owner = rig.client(Role::Owner);
    for key in ["", "curta", "tem espaço aqui", &"a".repeat(129)] {
        let result = rig.call(&owner, "codexReset", json!({ "profileId": "ambient-codex", "idempotencyKey": key, "creditId": null })).await;
        assert_eq!(code(result), (ErrorCode::Invalid, "Chave de idempotência inválida.".to_string()), "{key:?}");
    }
    let result = rig.call(&owner, "codexReset", json!({ "profileId": "", "idempotencyKey": "abcdefgh-1234", "creditId": null })).await;
    assert_eq!(code(result), (ErrorCode::Invalid, "Perfil inválido.".to_string()));
    assert_eq!(rig.codex.launches.load(Ordering::SeqCst), 0);

    // Valid arguments get as far as the (fake) launcher, which refuses.
    let result = rig.call(&owner, "codexReset", json!({ "profileId": "ambient-codex", "idempotencyKey": "abcdefgh-1234", "creditId": null })).await;
    assert_eq!(code(result), (ErrorCode::Internal, "sem Codex nos testes".to_string()));
    assert_eq!(rig.codex.launches.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_send_during_a_set_link_starts_only_after_the_link_is_stored() {
    let rig = Rig::new();
    let owner = rig.client(Role::Owner);
    let id = rig.profile(&owner, "claude", "Trabalho").await;
    rig.fake_traycer(&[("claude-code", "acc", true)]);
    rig.idle_chat(&owner, "c1", "claude", &id, false).await;

    // What the account's document held each time a turn started.
    let linked_at_start = Arc::new(Mutex::new(Vec::<bool>::new()));
    {
        let (store, seen, id) = (Arc::clone(&rig.store), Arc::clone(&linked_at_start), id.clone());
        *rig.silent.on_start.lock().unwrap() = Some(Box::new(move || {
            let doc = store.get().unwrap().document("profiles", &id).unwrap().unwrap();
            seen.lock().unwrap().push(doc.get("credentialLink").is_some());
        }));
    }

    // Hold the chats engine in another account's change: the setLink queues
    // behind it, and a send queues behind the setLink.
    let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let blocker = tokio::spawn(rig.chats.exclusive("claude", "outra", "x", crate::domains::chats::Hold::Nothing, move || {
        entered_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        Ok(())
    }));
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(20)).expect("the engine was never held")).await.unwrap();

    let link = rig.link("claude-code", "acc");
    let (linked, sent, _) = tokio::join!(
        rig.call(&owner, "setLink", json!({ "id": id, "link": link.clone() })),
        async {
            tokio::time::sleep(Duration::from_millis(400)).await;
            rig.chat_call(&owner, "send", json!({ "chatId": "c1", "text": "oi" })).await
        },
        async {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            release_tx.send(()).unwrap();
        }
    );
    blocker.await.unwrap().unwrap();
    linked.unwrap();
    sent.unwrap();
    assert_eq!(rig.doc(&id).unwrap()["credentialLink"], link);
    assert_eq!(linked_at_start.lock().unwrap().as_slice(), [true], "the turn started with the link already stored");
}

#[tokio::test]
async fn a_send_after_a_set_link_runs_on_the_linked_account() {
    let rig = Rig::new();
    let owner = rig.client(Role::Owner);
    let id = rig.profile(&owner, "claude", "Trabalho").await;
    rig.fake_traycer(&[("claude-code", "acc", true)]);
    rig.idle_chat(&owner, "c1", "claude", &id, true).await;
    let linked_at_start = Arc::new(Mutex::new(Vec::<bool>::new()));
    {
        let (store, seen, id) = (Arc::clone(&rig.store), Arc::clone(&linked_at_start), id.clone());
        *rig.silent.on_start.lock().unwrap() = Some(Box::new(move || {
            let doc = store.get().unwrap().document("profiles", &id).unwrap().unwrap();
            seen.lock().unwrap().push(doc.get("credentialLink").is_some());
        }));
    }
    rig.call(&owner, "setLink", json!({ "id": id, "link": rig.link("claude-code", "acc") })).await.unwrap();
    rig.chat_call(&owner, "send", json!({ "chatId": "c1", "text": "oi" })).await.unwrap();
    rig.wait_busy(&owner, |ids| ids.contains(&id)).await;
    assert_eq!(linked_at_start.lock().unwrap().as_slice(), [true]);
    assert!(rig.chat("c1").get("resume").is_none(), "the old session was forgotten before the turn");
    rig.finish_turns(&owner).await;
}
