//! profile_env against temporary folders only: a fake Electron store
//! (`prism-agents.db`), a fake Traycer root and fake CLI installs.

use super::*;
use serde_json::json;
use std::fs;

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    user_data: PathBuf,
    traycer: PathBuf,
    home: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let (user_data, traycer, home) = (root.join("user-data"), root.join("traycer"), root.join("home"));
        for d in [&user_data, &traycer, &home] {
            fs::create_dir_all(d).unwrap();
        }
        Self { _dir: dir, root, user_data, traycer, home }
    }

    /// The Electron store as the app writes it (WAL, `documents` rows).
    fn store(&self, profiles: &[Value]) {
        let conn = rusqlite::Connection::open(self.user_data.join("prism-agents.db")).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
             DELETE FROM documents;",
        )
        .unwrap();
        for (i, p) in profiles.iter().enumerate() {
            let id = p.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("row-{i}"));
            conn.execute("INSERT INTO documents VALUES ('profiles',?1,?2)", rusqlite::params![id, p.to_string()]).unwrap();
        }
        conn.execute("INSERT INTO documents VALUES ('chats','c1','{}')", []).unwrap();
    }

    fn profiles(&self) -> Profiles {
        Profiles::with_roots(Arc::new(ElectronProfiles::new(&self.user_data)), self.home.clone(), self.traycer.clone())
    }

    /// A Traycer-managed account folder plus its `provider-accounts.json` row.
    fn traycer_account(&self, provider: &str, id: &str, extra: Value) -> PathBuf {
        let dir = self.traycer.join("host").join("harness-accounts").join(provider).join(id);
        fs::create_dir_all(&dir).unwrap();
        let file = self.traycer.join("host").join("config").join("provider-accounts.json");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        let mut data: Value = fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({ "profiles": [] }));
        let mut row = json!({ "profileId": id, "providerId": provider, "kind": "managed", "dirPath": dir.to_string_lossy() });
        for (k, v) in extra.as_object().unwrap() {
            if v.is_null() {
                row.as_object_mut().unwrap().remove(k);
            } else {
                row[k] = v.clone();
            }
        }
        data["profiles"].as_array_mut().unwrap().push(row);
        fs::write(&file, data.to_string()).unwrap();
        dir
    }

    fn link(&self, id: &str, provider: &str, traycer_id: &str, traycer_provider: &str) -> Value {
        json!({ "id": id, "provider": provider, "name": id,
            "credentialLink": { "root": self.traycer.to_string_lossy(), "providerId": traycer_provider, "profileId": traycer_id } })
    }

    /// A managed pack: `host/providers/<provider>/<platform>/<version>/<exe>`.
    fn pack(&self, provider: &str, version: &str, exe: &str) -> PathBuf {
        let base = self.traycer.join("host").join("providers").join(provider).join(platform_key());
        let dir = base.join(version);
        fs::create_dir_all(&dir).unwrap();
        fs::write(base.join("current.json"), json!({ "pack": provider, "version": version }).to_string()).unwrap();
        fs::write(dir.join("pack.json"), json!({ "pack": provider, "version": version, "executablePath": exe }).to_string()).unwrap();
        let path = dir.join(exe);
        fs::write(&path, b"fake").unwrap();
        path
    }

    /// An npm install of the CLI: the shim, its package and `package.json`.
    fn npm_install(&self, provider: Provider, version: &str) -> (PathBuf, PathBuf) {
        let bin = self.root.join("npm");
        let script = bin.join("node_modules").join(provider.npm_script());
        fs::create_dir_all(script.parent().unwrap()).unwrap();
        fs::write(&script, b"// fake").unwrap();
        let package = script.parent().unwrap().parent().unwrap().join("package.json");
        fs::write(package, json!({ "version": version }).to_string()).unwrap();
        let shim = bin.join(format!("{}.cmd", provider.as_str()));
        fs::write(&shim, b"@echo off").unwrap();
        (shim, script)
    }
}

fn set_of(env: &ProfileEnv) -> HashMap<&'static str, PathBuf> {
    env.set.iter().map(|(k, v)| (*k, PathBuf::from(v))).collect()
}

#[test]
fn terminal_accounts_change_nothing_and_are_always_listed() {
    let f = Fixture::new();
    let profiles = f.profiles();
    for provider in [Provider::Claude, Provider::Codex] {
        assert_eq!(profiles.environment(provider, None).unwrap(), ProfileEnv::default());
        assert_eq!(profiles.environment(provider, Some(provider.ambient_id())).unwrap(), ProfileEnv::default());
    }
    // No store at all (a VPS): just the two terminal accounts.
    let ids: Vec<_> = profiles.list().unwrap().into_iter().map(|p| p.id).collect();
    assert_eq!(ids, ["ambient-claude", "ambient-codex"]);
    assert!(!f.user_data.join("provider-profiles").exists());
}

#[test]
fn own_profiles_get_their_folder_and_drop_inherited_keys() {
    let f = Fixture::new();
    f.store(&[json!({ "id": "p-claude", "provider": "claude", "name": "Work" }), json!({ "id": "p-codex", "provider": "codex", "name": "Home" })]);
    let profiles = f.profiles();
    for (provider, id, var) in [(Provider::Claude, "p-claude", "CLAUDE_CONFIG_DIR"), (Provider::Codex, "p-codex", "CODEX_HOME")] {
        let env = profiles.environment(provider, Some(id)).unwrap();
        let home = f.user_data.join("provider-profiles").join(id);
        assert_eq!(set_of(&env), HashMap::from([(var, home.clone())]));
        assert!(home.is_dir(), "the profile's folder is created like the app does");
        assert_eq!(env.remove, REMOVED_VARS.to_vec());
        assert_eq!(env.get("ANTHROPIC_API_KEY"), None);
        assert_eq!(env.get("CODEX_SQLITE_HOME"), None);
        assert_eq!(env.get(var).map(PathBuf::from), Some(home));
    }
}

#[test]
fn applying_the_environment_removes_keys_and_sets_the_home() {
    let f = Fixture::new();
    f.store(&[json!({ "id": "p", "provider": "codex", "name": "x" })]);
    let env = f.profiles().environment(Provider::Codex, Some("p")).unwrap();
    let mut command = std::process::Command::new("unused");
    command.env("OPENAI_API_KEY", "fake").env("UNRELATED", "kept");
    env.apply_std(&mut command);
    let vars: HashMap<_, _> = command.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_os_string()))).collect();
    assert_eq!(vars["OPENAI_API_KEY"], None, "removed even when set explicitly before");
    assert_eq!(vars["UNRELATED"], Some("kept".into()));
    assert!(vars["CODEX_HOME"].as_ref().unwrap().to_string_lossy().ends_with("p"));
}

#[test]
fn unknown_removed_and_mismatched_profiles_are_not_found() {
    let f = Fixture::new();
    f.store(&[json!({ "id": "c", "provider": "claude", "name": "x" }), json!({ "id": "gone", "provider": "codex", "name": "x", "tombstoned": true })]);
    let profiles = f.profiles();
    for (provider, id) in [(Provider::Codex, "c"), (Provider::Claude, "ambient-codex"), (Provider::Codex, "missing"), (Provider::Codex, "gone")] {
        let err = profiles.environment(provider, Some(id)).unwrap_err();
        assert_eq!(err.kind, ProfileErrorKind::NotFound);
        assert_eq!(err.message, NOT_FOUND_MESSAGE);
    }
    assert!(!f.user_data.join("provider-profiles").exists(), "no folder for a refused profile");
}

#[test]
fn disabled_profiles_fail_before_anything_else() {
    let f = Fixture::new();
    f.store(&[json!({ "id": "off", "provider": "codex", "name": "x", "enabled": false }), json!({ "id": "on", "provider": "codex", "name": "x", "enabled": true })]);
    let profiles = f.profiles();
    assert_eq!(profiles.environment(Provider::Codex, Some("off")).unwrap_err().message, DISABLED_MESSAGE);
    assert!(profiles.environment(Provider::Codex, Some("on")).is_ok());
}

#[test]
fn linked_profiles_share_traycers_account_in_place() {
    let f = Fixture::new();
    let claude_home = f.traycer_account("claude-code", "tc", json!({}));
    let codex_home = f.traycer_account("codex", "tx", json!({ "layout": "overlay" }));
    f.store(&[f.link("lc", "claude", "tc", "claude-code"), f.link("lx", "codex", "tx", "codex")]);
    let profiles = f.profiles();

    let env = profiles.environment(Provider::Claude, Some("lc")).unwrap();
    assert_eq!(set_of(&env), HashMap::from([("CLAUDE_CONFIG_DIR", claude_home)]));
    assert_eq!(env.remove, REMOVED_VARS.to_vec());

    // Overlay layout: the thread database stays in the shared ~/.codex.
    let env = profiles.environment(Provider::Codex, Some("lx")).unwrap();
    assert_eq!(set_of(&env), HashMap::from([("CODEX_HOME", codex_home), ("CODEX_SQLITE_HOME", f.home.join(".codex"))]));
    fs::create_dir_all(f.home.join(".codex")).unwrap();
    let env = profiles.environment(Provider::Codex, Some("lx")).unwrap();
    let sqlite = set_of(&env)["CODEX_SQLITE_HOME"].clone();
    assert!(!sqlite.to_string_lossy().starts_with(r"\\?\"), "real path without the verbatim prefix: {sqlite:?}");
    assert!(same_path(&sqlite, &fs::canonicalize(f.home.join(".codex")).map(simplified).unwrap()));
    assert_eq!(env.get("CODEX_SQLITE_HOME").map(PathBuf::from), Some(sqlite));
    assert!(!f.user_data.join("provider-profiles").exists(), "a linked profile never uses its own folder");
}

#[test]
fn broken_links_fail_closed() {
    let f = Fixture::new();
    f.traycer_account("codex", "tomb", json!({ "tombstoned": true }));
    f.traycer_account("codex", "off", json!({ "enabled": false }));
    f.traycer_account("codex", "personal", json!({ "kind": "personal" }));
    f.traycer_account("codex", "moved", json!({ "dirPath": f.root.join("elsewhere").to_string_lossy() }));
    f.traycer_account("codex", "ok", json!({}));
    let mut rows = vec![
        f.link("a", "codex", "tomb", "codex"),
        f.link("b", "codex", "off", "codex"),
        f.link("c", "codex", "personal", "codex"),
        f.link("d", "codex", "moved", "codex"),
        f.link("e", "codex", "never-existed", "codex"),
        f.link("f", "codex", "ok", "claude-code"),
        f.link("g", "codex", "../ok", "codex"),
        json!({ "id": "h", "provider": "codex", "name": "x", "credentialLink": {} }),
    ];
    rows.push(f.link("i", "codex", "ok", "codex"));
    f.store(&rows);
    let profiles = f.profiles();
    for id in ["a", "b", "c", "d", "e", "f", "g", "h"] {
        let err = profiles.environment(Provider::Codex, Some(id)).unwrap_err();
        assert_eq!(err.kind, ProfileErrorKind::BrokenLink, "{id}");
        assert_eq!(err.message, BROKEN_LINK_MESSAGE);
        assert_eq!(link_state(&profiles.get(Provider::Codex, id).unwrap()), LinkState::Broken, "{id}");
    }
    assert_eq!(link_state(&profiles.get(Provider::Codex, "i").unwrap()), LinkState::Linked);
    assert!(profiles.environment(Provider::Codex, Some("i")).is_ok());
    // Removing Traycer's whole store breaks the working link too.
    fs::remove_dir_all(f.traycer.join("host").join("config")).unwrap();
    assert_eq!(profiles.environment(Provider::Codex, Some("i")).unwrap_err().kind, ProfileErrorKind::BrokenLink);
}

#[test]
fn the_store_is_read_without_writing_it() {
    let f = Fixture::new();
    f.store(&[
        json!({ "id": "ok", "provider": "codex", "name": "Ok", "color": "#fff", "ambient": null, "tombstoned": 0 }),
        json!({ "id": "weird", "provider": "gemini", "name": "x" }),
        json!({ "nope": true }),
    ]);
    let db = f.user_data.join("prism-agents.db");
    let before = fs::read(&db).unwrap();
    let stored = ElectronProfiles::new(&f.user_data).stored().unwrap();
    assert_eq!(stored.len(), 1, "unreadable rows are skipped, not fatal");
    assert_eq!(stored[0].id, "ok");
    assert!(!stored[0].ambient && !stored[0].tombstoned && stored[0].enabled.is_none());
    assert_eq!(fs::read(&db).unwrap(), before);
}

#[test]
fn a_cleanly_closed_store_without_wal_is_still_readable() {
    let f = Fixture::new();
    f.store(&[json!({ "id": "x", "provider": "claude", "name": "x" })]);
    // The connection above closed: SQLite checkpointed and removed the WAL.
    assert!(!f.user_data.join("prism-agents.db-wal").exists());
    assert_eq!(ElectronProfiles::new(&f.user_data).stored().unwrap().len(), 1);
    // A database the app never initialised has no table yet.
    let empty = Fixture::new();
    rusqlite::Connection::open(empty.user_data.join("prism-agents.db")).unwrap().execute_batch("CREATE TABLE t(x)").unwrap();
    assert!(ElectronProfiles::new(&empty.user_data).stored().unwrap().is_empty());
}

#[test]
fn a_corrupt_store_is_reported_not_guessed() {
    let f = Fixture::new();
    fs::write(f.user_data.join("prism-agents.db"), b"not a database at all, just text that is long enough").unwrap();
    let err = f.profiles().environment(Provider::Codex, Some("x")).unwrap_err();
    assert_eq!(err.kind, ProfileErrorKind::Unreadable);
    assert!(err.message.starts_with("Não foi possível ler as contas do Prism"));
    // Terminal accounts never depend on the store... but the lookup reads it first, like the app.
    assert_eq!(f.profiles().environment(Provider::Codex, None).unwrap_err().kind, ProfileErrorKind::Unreadable);
}

#[test]
fn managed_pack_is_accepted_only_when_consistent() {
    let f = Fixture::new();
    let exe = f.pack("codex", "1.2.3", if cfg!(windows) { "codex.exe" } else { "codex" });
    let (command, version) = f.profiles().managed_command(Provider::Codex).unwrap();
    assert_eq!((command.bin, command.args, version.as_str()), (exe, vec![], "1.2.3"));
    assert!(f.profiles().managed_command(Provider::Claude).is_none());

    let base = f.traycer.join("host").join("providers").join("codex").join(platform_key());
    let write = |file: &str, value: Value| fs::write(base.join(file), value.to_string()).unwrap();
    for current in [json!({ "pack": "claude", "version": "1.2.3" }), json!({ "pack": "codex", "version": "1.2" }), json!({ "pack": "codex", "version": "../1.2.3" })] {
        write("current.json", current);
        assert!(f.profiles().managed_command(Provider::Codex).is_none());
    }
    write("current.json", json!({ "pack": "codex", "version": "1.2.3" }));
    let pack = |value: Value| fs::write(base.join("1.2.3").join("pack.json"), value.to_string()).unwrap();
    for bad in [
        json!({ "pack": "codex", "version": "1.2.4", "executablePath": "codex" }),
        json!({ "pack": "codex", "version": "1.2.3", "executablePath": "sub/codex" }),
        json!({ "pack": "codex", "version": "1.2.3", "executablePath": "" }),
        json!({ "pack": "codex", "version": "1.2.3", "executablePath": ".." }),
        json!({ "pack": "codex", "version": "1.2.3", "executablePath": "missing" }),
        json!({ "pack": "codex", "version": "1.2.3" }),
    ] {
        pack(bad.clone());
        assert!(f.profiles().managed_command(Provider::Codex).is_none(), "{bad}");
    }
}

#[tokio::test]
async fn linked_profiles_always_run_traycers_cli_and_others_the_newest() {
    let f = Fixture::new();
    f.traycer_account("codex", "tx", json!({}));
    f.store(&[f.link("linked", "codex", "tx", "codex"), json!({ "id": "own", "provider": "codex", "name": "x" })]);
    let managed = f.pack("codex", "1.0.0", "codex.bin");
    let (shim, script) = f.npm_install(Provider::Codex, "2.0.0");
    let node = f.root.join("node.bin");
    fs::write(&node, b"fake node").unwrap();
    let profiles = f.profiles();
    // Seed the PATH lookup instead of searching the real machine.
    let terminal = pick_terminal(Provider::Codex, &[shim], Some(&node)).unwrap();
    assert_eq!(terminal, ProviderCommand { bin: node.clone(), args: vec![script.clone().into_os_string()] });
    profiles.inner.terminals.lock().unwrap().insert(Provider::Codex, (Instant::now(), Some(terminal.clone())));

    assert_eq!(profiles.version(&terminal).await.as_deref(), Some("2.0.0"));
    // Newer terminal CLI wins for own and terminal profiles...
    assert_eq!(profiles.command(Provider::Codex, Some("own")).await, Some(terminal.clone()));
    assert_eq!(profiles.command(Provider::Codex, None).await, Some(terminal.clone()));
    // ...but a linked profile keeps Traycer's.
    assert_eq!(profiles.command(Provider::Codex, Some("linked")).await.unwrap().bin, managed);

    // Same version: Traycer's (never a downgrade, never a needless switch).
    let pkg = script.parent().unwrap().parent().unwrap().join("package.json");
    fs::write(&pkg, json!({ "version": "1.0.0" }).to_string()).unwrap();
    // The cache is per file identity: the script itself did not change.
    profiles.inner.versions.lock().unwrap().clear();
    assert_eq!(profiles.command(Provider::Codex, Some("own")).await.unwrap().bin, managed);

    // No managed pack: the terminal's; neither: nothing.
    fs::remove_dir_all(f.traycer.join("host").join("providers")).unwrap();
    assert_eq!(profiles.command(Provider::Codex, Some("linked")).await, Some(terminal));
    profiles.inner.terminals.lock().unwrap().insert(Provider::Codex, (Instant::now(), None));
    assert_eq!(profiles.command(Provider::Codex, Some("own")).await, None);
}

#[test]
fn path_candidates_follow_the_app_rules() {
    let f = Fixture::new();
    let (shim, script) = f.npm_install(Provider::Claude, "1.0.0");
    let node = f.root.join("node.bin");
    fs::write(&node, b"").unwrap();
    let missing = f.root.join("missing.exe");
    let orphan = f.root.join("orphan").join("claude.cmd");
    fs::create_dir_all(orphan.parent().unwrap()).unwrap();
    fs::write(&orphan, b"").unwrap();
    let binary = f.root.join(if cfg!(windows) { "claude.exe" } else { "claude" });
    fs::write(&binary, b"").unwrap();

    // Missing files and shims without their package are skipped.
    let picked = pick_terminal(Provider::Claude, &[missing.clone(), orphan.clone(), shim.clone(), binary.clone()], Some(&node)).unwrap();
    assert_eq!(picked, ProviderCommand { bin: node.clone(), args: vec![script.into_os_string()] });
    // Without Node a shim cannot run: the next candidate.
    assert_eq!(pick_terminal(Provider::Claude, &[shim, binary.clone()], None).unwrap().bin, binary);
    assert_eq!(pick_terminal(Provider::Claude, &[missing, orphan], Some(&node)), None);
}

#[test]
fn versions_parse_and_compare_like_the_app() {
    for (text, expected) in [
        ("codex-cli 0.160.0", Some("0.160.0")),
        ("2.1.3 (Claude Code)", Some("2.1.3")),
        ("version 1.2.3-beta.1\n", Some("1.2.3-beta.1")),
        // `\b` needs a non-word character before the digits, as in the app's regex.
        ("v1.2.3", None),
        ("1.2.3-beta.", Some("1.2.3-beta")),
        ("build 10.20.30-rc-1 ok", Some("10.20.30-rc-1")),
        ("x1.2.3 then 4.5.6", Some("4.5.6")),
        ("1.2", None),
        ("1.2.3a", None),
        ("", None),
    ] {
        assert_eq!(parse_version(text).as_deref(), expected, "{text:?}");
    }
    for (v, ok) in [("1.2.3", true), ("1.2.3-rc.1", true), ("1.2.3+build", true), ("1.2", false), ("1.2.3-", false), ("a.b.c", false), ("1.2.3.4", false)] {
        assert_eq!(is_version(v), ok, "{v}");
    }
    use Ordering::*;
    for (a, b, order) in [("1.2.3", "1.2.3", Equal), ("1.10.0", "1.9.9", Greater), ("1.2.3-rc", "1.2.3", Less), ("2.0.0-rc", "1.9.9", Greater), ("0.160.0", "0.99.1", Greater)] {
        assert_eq!(compare_versions(a, b), order, "{a} vs {b}");
    }
}

#[test]
fn paths_compare_like_node() {
    let base = std::env::temp_dir();
    assert!(same_path(&base.join("a").join("..").join("b"), &base.join("b")));
    assert!(same_path(&base.join(".").join("b"), &base.join("b")));
    assert_eq!(cfg!(windows), same_path(&base.join("B"), &base.join("b")));
    assert_eq!(simplified(PathBuf::from(r"\\?\C:\x\y")), PathBuf::from(r"C:\x\y"));
    assert_eq!(simplified(PathBuf::from(r"\\?\UNC\server\share")), PathBuf::from(r"\\server\share"));
    assert_eq!(simplified(PathBuf::from("/usr/bin")), PathBuf::from("/usr/bin"));
}

#[tokio::test]
async fn a_terminal_lookup_that_found_nothing_is_kept_until_forgotten() {
    let f = Fixture::new();
    let profiles = f.profiles();
    // A lookup that found nothing, for both providers (seeded: the real lookup
    // depends on the machine's PATH).
    for provider in [Provider::Claude, Provider::Codex] {
        profiles.inner.terminals.lock().unwrap().insert(provider, (Instant::now(), None));
    }
    // The CLI shows up afterwards, where the terminal looks last (`~/.local/bin`).
    let bin = f.home.join(".local").join("bin");
    fs::create_dir_all(&bin).unwrap();
    let name = if cfg!(windows) { "codex.exe" } else { "codex" };
    fs::write(bin.join(name), b"fake cli").unwrap();

    // The `None` is served from the cache: it is not looked up again.
    assert_eq!(profiles.terminal_command(Provider::Codex).await, None);
    assert_eq!(profiles.terminal_command(Provider::Codex).await, None);
    assert_eq!(profiles.command(Provider::Codex, None).await, None, "the cached answer is the one commands use too");

    // Forgetting it makes the next lookup go to the disk and find the CLI.
    profiles.forget_terminal(Provider::Codex);
    assert!(!profiles.inner.terminals.lock().unwrap().contains_key(&Provider::Codex));
    let found = profiles.terminal_command(Provider::Codex).await;
    assert!(found.is_some(), "the CLI just installed is found at once");
    // (A Codex earlier on this machine's PATH would win over `~/.local/bin`; either way it is found.)

    // Only that provider was forgotten.
    assert_eq!(profiles.terminal_command(Provider::Claude).await, None, "the other provider's lookup is untouched");
    // Forgetting what is not cached is harmless.
    profiles.forget_terminal(Provider::Codex);
    profiles.forget_terminal(Provider::Codex);
}

#[tokio::test]
async fn a_cli_in_the_local_bin_becomes_the_terminal_command_once_installed() {
    // Deterministic form of the above: the candidate list is `PATH` entries then
    // `~/.local/bin`, and `pick_terminal` takes the first one that exists.
    let f = Fixture::new();
    let name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let local = f.home.join(".local").join("bin").join(name);
    assert_eq!(pick_terminal(Provider::Codex, std::slice::from_ref(&local), None), None, "not installed yet");
    fs::create_dir_all(local.parent().unwrap()).unwrap();
    fs::write(&local, b"fake cli").unwrap();
    assert_eq!(pick_terminal(Provider::Codex, std::slice::from_ref(&local), None), Some(ProviderCommand { bin: local, args: Vec::new() }));
}
