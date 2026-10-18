//! The profiles as the host keeps them (T08): `profiles` documents in the
//! host database, and each Prism-managed profile's own login in
//! `<app data>/provider-profiles/<id>`, the desktop's own folder on a desktop
//! host (`paths::app_data_root`), so a login is never copied.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use prism_agents::profile_env::{link_state, LinkState, ProfileError, ProfileErrorKind, ProfileSource, StoredProfile};
use prism_protocol::HostError;
use prism_store::kinds;
use serde_json::{json, Value};

use crate::domains::store::{store_error, SharedStore};

/// The terminal accounts' name (`profiles()` in src/main/providers.ts).
pub const TERMINAL_ACCOUNT: &str = "Conta do terminal";

/// The `ProfileSource` of a host that owns its profiles.
pub struct HostProfiles {
    store: Arc<SharedStore>,
    root: PathBuf,
}

impl HostProfiles {
    pub fn new(store: Arc<SharedStore>, root: impl Into<PathBuf>) -> Self {
        Self { store, root: root.into() }
    }

    /// `<app data>/provider-profiles` of the running host.
    pub fn default_root() -> PathBuf {
        crate::paths::app_data_root().map(|dir| dir.join("provider-profiles")).unwrap_or_else(|| PathBuf::from("provider-profiles"))
    }

    /// Where the profiles' own login folders live.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The stored documents as they are, Traycer links included. While the
    /// desktop's profiles have not been taken over yet, the ones the host has
    /// are read (and the takeover tried again). Blocking.
    pub fn documents(&self) -> Result<Vec<Value>, HostError> {
        let _ = self.store.profiles_taken_over();
        self.store.get()?.documents(kinds::PROFILES).map_err(store_error)
    }

    /// Inserts or replaces one document; refused until the desktop's
    /// profiles were taken over (that would undo it). Blocking.
    pub fn put(&self, doc: &Value) -> Result<(), HostError> {
        self.store.profiles_taken_over()?;
        let id = doc.get("id").and_then(Value::as_str).unwrap_or_default();
        self.store.get()?.put_document(kinds::PROFILES, id, doc).map_err(store_error)
    }
}

impl ProfileSource for HostProfiles {
    fn stored(&self) -> Result<Vec<StoredProfile>, ProfileError> {
        let docs = self.documents().map_err(|err| ProfileError {
            kind: ProfileErrorKind::Unreadable,
            message: format!("Não foi possível ler as contas do Prism: {}", err.message),
        })?;
        Ok(docs
            .into_iter()
            .filter_map(|doc| match serde_json::from_value::<StoredProfile>(doc) {
                Ok(profile) => Some(profile),
                Err(err) => {
                    tracing::warn!(%err, "perfil ilegível no banco do host ignorado");
                    None
                }
            })
            .collect())
    }

    fn own_home(&self, profile_id: &str) -> PathBuf {
        self.root.join(profile_id)
    }
}

fn ambient(provider: &str) -> Value {
    json!({ "id": format!("ambient-{provider}"), "provider": provider, "name": TERMINAL_ACCOUNT, "ambient": true })
}

/// `publicProfiles()`: the terminal accounts, then the stored ones, each
/// Traycer link reduced to its state (`traycerLink`), never its paths.
pub fn public_list(docs: &[Value]) -> Vec<Value> {
    let mut out = vec![ambient("claude"), ambient("codex")];
    for doc in docs {
        let Some(map) = doc.as_object() else { continue };
        let mut public = map.clone();
        if public.remove("credentialLink").is_some()
            && let Ok(stored) = serde_json::from_value::<StoredProfile>(doc.clone())
        {
            match link_state(&stored) {
                LinkState::Linked => {
                    public.insert("traycerLink".into(), "linked".into());
                }
                LinkState::Broken => {
                    public.insert("traycerLink".into(), "broken".into());
                }
                LinkState::None => {}
            }
        }
        out.push(Value::Object(public));
    }
    out
}

/// Whether a profile id is safe as a folder name under `provider-profiles/`.
pub fn is_profile_folder_name(id: &str) -> bool {
    !id.is_empty() && id != "." && id != ".." && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A folder only the OS user can open (`mode: 0o700`, as the app creates them).
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

/// `.trash-<id>-<ms>`: where a removed profile's folder waits when it cannot
/// be deleted yet; the next start purges it.
pub fn trash_folder_name(id: &str, now: u64) -> String {
    format!(".trash-{id}-{now}")
}

/// Whether a `provider-profiles/` entry is one of those trash folders.
pub fn is_trash_folder_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(".trash-") else { return false };
    let Some((id, stamp)) = rest.rsplit_once('-') else { return false };
    !stamp.is_empty() && stamp.bytes().all(|b| b.is_ascii_digit()) && is_profile_folder_name(id)
}

/// What became of a removed profile's own folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderRemoval {
    Removed,
    /// Locked (Windows holds a file a process just released): renamed into
    /// the trash, purged on the next start.
    Trashed,
    /// Neither worked; reported.
    Kept,
}

/// Deletes `root/<id>` (never a Traycer folder), retrying while Windows
/// releases the files the profile's processes held; else moves it aside.
pub fn remove_profile_folder(root: &Path, id: &str, now: u64) -> FolderRemoval {
    if !is_profile_folder_name(id) {
        return FolderRemoval::Kept;
    }
    let dir = root.join(id);
    if !dir.exists() {
        return FolderRemoval::Removed;
    }
    for attempt in 0..5 {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => return FolderRemoval::Removed,
            Err(_) if attempt < 4 => std::thread::sleep(std::time::Duration::from_millis(200)),
            Err(_) => {}
        }
    }
    match std::fs::rename(&dir, root.join(trash_folder_name(id, now))) {
        Ok(()) => FolderRemoval::Trashed,
        Err(_) => FolderRemoval::Kept,
    }
}

/// Purges the trash folders and the folders of removed profiles that could
/// not even be moved aside (`removed_ids`); how many went.
pub fn purge_profile_trash(root: &Path, removed_ids: &[String]) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else { return 0 };
    let mut purged = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let removed = removed_ids.iter().any(|id| id == &name) && is_profile_folder_name(&name);
        if (is_trash_folder_name(&name) || removed) && std::fs::remove_dir_all(entry.path()).is_ok() {
            purged += 1;
        }
    }
    purged
}

#[cfg(test)]
mod tests {
    use super::*;
    use prism_agents::profile_env::ProfileSource;

    #[test]
    fn the_public_list_hides_traycer_paths() {
        let docs = vec![
            json!({ "id": "p1", "provider": "claude", "name": "Trabalho", "color": "#ff0000" }),
            json!({ "id": "p2", "provider": "codex", "name": "Vinculada", "credentialLink": { "root": "C:/nada/.traycer", "providerId": "codex", "profileId": "x" } }),
        ];
        let list = public_list(&docs);
        assert_eq!(list[0], json!({ "id": "ambient-claude", "provider": "claude", "name": "Conta do terminal", "ambient": true }));
        assert_eq!(list[2]["color"], "#ff0000");
        assert!(list[3].get("credentialLink").is_none());
        assert_eq!(list[3]["traycerLink"], "broken", "a link that does not resolve here is broken");
    }

    #[test]
    fn trash_names_round_trip() {
        assert!(is_trash_folder_name(&trash_folder_name("abc-1", 1700)));
        assert!(!is_trash_folder_name(".trash-../x-1"));
        assert!(!is_trash_folder_name("abc"));
        assert!(!is_profile_folder_name(".."));
    }

    #[test]
    fn a_folder_is_removed_and_the_trash_purged() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("p1/sub")).unwrap();
        std::fs::write(dir.path().join("p1/sub/a.json"), "{}").unwrap();
        assert_eq!(remove_profile_folder(dir.path(), "p1", 1), FolderRemoval::Removed);
        assert!(!dir.path().join("p1").exists());
        std::fs::create_dir_all(dir.path().join(".trash-p2-5")).unwrap();
        std::fs::create_dir_all(dir.path().join("p3")).unwrap();
        std::fs::create_dir_all(dir.path().join("live")).unwrap();
        assert_eq!(purge_profile_trash(dir.path(), &["p3".into()]), 2);
        assert!(dir.path().join("live").exists());
    }

    fn host_profiles(dir: &Path) -> HostProfiles {
        HostProfiles::new(SharedStore::at(dir.join("host.db")), dir.join("provider-profiles"))
    }

    #[test]
    fn documents_round_trip_through_put_and_replace_by_id() {
        let dir = tempfile::tempdir().unwrap();
        let profiles = host_profiles(dir.path());
        assert!(profiles.documents().unwrap().is_empty());

        let work = json!({ "id": "work", "provider": "claude", "name": "Trabalho", "color": "#fff" });
        let home = json!({ "id": "home", "provider": "codex", "name": "Casa", "credentialLink": { "root": "C:/x/.traycer", "providerId": "codex", "profileId": "p" } });
        profiles.put(&work).unwrap();
        profiles.put(&home).unwrap();
        let mut docs = profiles.documents().unwrap();
        docs.sort_by_key(|d| d["id"].to_string());
        assert_eq!(docs, vec![home.clone(), work.clone()], "stored as they are, links included");

        let renamed = json!({ "id": "work", "provider": "claude", "name": "Outro" });
        profiles.put(&renamed).unwrap();
        let docs = profiles.documents().unwrap();
        assert_eq!(docs.len(), 2);
        assert!(docs.contains(&renamed) && !docs.contains(&work));
        // They are in the host database, under the `profiles` kind.
        let reopened = host_profiles(dir.path());
        assert_eq!(reopened.documents().unwrap().len(), 2);
    }

    #[test]
    fn stored_skips_unreadable_documents_and_keeps_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let shared = SharedStore::at(dir.path().join("host.db"));
        let profiles = HostProfiles::new(Arc::clone(&shared), dir.path().join("pp"));
        profiles.put(&json!({ "id": "ok", "provider": "claude", "name": "Boa" })).unwrap();
        let store = shared.get().unwrap();
        for (id, body) in [
            ("sem-provider", json!({ "id": "sem-provider", "name": "x" })),
            ("provider-estranho", json!({ "id": "provider-estranho", "provider": "gemini", "name": "x" })),
            ("id-numero", json!({ "id": 7, "provider": "claude" })),
        ] {
            store.put_document(kinds::PROFILES, id, &body).unwrap();
        }
        let stored = profiles.stored().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!((stored[0].id.as_str(), stored[0].name.as_str()), ("ok", "Boa"));
        assert_eq!(profiles.documents().unwrap().len(), 4, "unreadable ones are ignored, not deleted");
    }

    #[test]
    fn stored_reports_a_store_that_cannot_open() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the database file should be.
        std::fs::create_dir_all(dir.path().join("host.db")).unwrap();
        let profiles = host_profiles(dir.path());
        let err = profiles.stored().unwrap_err();
        assert!(matches!(err.kind, ProfileErrorKind::Unreadable));
        assert!(err.message.starts_with("Não foi possível ler as contas do Prism:"), "{}", err.message);
        assert!(profiles.documents().is_err());
        assert!(profiles.put(&json!({ "id": "x", "provider": "claude" })).is_err());
    }

    #[test]
    fn own_home_is_the_folder_under_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let profiles = host_profiles(dir.path());
        assert_eq!(profiles.root(), dir.path().join("provider-profiles"));
        assert_eq!(profiles.own_home("work-1"), dir.path().join("provider-profiles").join("work-1"));
    }

    #[test]
    fn the_public_list_never_exposes_a_credential_link_in_any_state() {
        let link = json!({ "root": "C:/secreto/.traycer", "providerId": "claude", "profileId": "conta" });
        let docs = vec![
            json!({ "id": "a", "provider": "claude", "name": "Com link", "credentialLink": link }),
            json!({ "id": "b", "provider": "codex", "name": "Link torto", "credentialLink": "texto" }),
            json!({ "id": "c", "provider": "gemini", "name": "Provider ilegível", "credentialLink": link }),
            json!({ "id": "d", "provider": "claude", "name": "Sem link", "tombstoned": false }),
            json!("não é objeto"),
        ];
        let list = public_list(&docs);
        assert_eq!(list.len(), 2 + 4, "two terminal accounts, then every object document");
        for item in &list {
            assert!(item.get("credentialLink").is_none(), "{item}");
            assert!(!item.to_string().contains("secreto"), "{item}");
        }
        assert_eq!(list[1]["id"], "ambient-codex");
        assert_eq!(list[2]["traycerLink"], "broken");
        assert_eq!(list[3]["traycerLink"], "broken", "a malformed link reads as broken, never shown");
        assert!(list[4].get("traycerLink").is_none(), "an unreadable profile has no state to show");
        assert!(list[5].get("traycerLink").is_none(), "no link, no state");
        assert_eq!(list[5]["name"], "Sem link");
    }

    #[test]
    fn folder_names_are_validated_and_removal_refuses_unsafe_ids() {
        for ok in ["a", "A-1", "traycer_0123"] {
            assert!(is_profile_folder_name(ok), "{ok}");
        }
        for bad in ["", ".", "..", "a/b", r"a\b", "a b", "á", ".trash-x-1"] {
            assert!(!is_profile_folder_name(bad), "{bad}");
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("p")).unwrap();
        assert_eq!(remove_profile_folder(dir.path(), "../p", 1), FolderRemoval::Kept);
        assert!(dir.path().join("p").exists());
        assert_eq!(remove_profile_folder(dir.path(), "nunca-existiu", 1), FolderRemoval::Removed);
        assert!(!is_trash_folder_name(".trash-p-"));
        assert!(!is_trash_folder_name(".trash-p-1x"));
    }
}
