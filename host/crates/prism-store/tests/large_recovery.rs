//! Opt-in conservation check on an OFFLINE COPY, never the live profile.
//! Set PRISM_RECOVERY_DATABASE to the copied .db and run this ignored test.
use prism_store::{Store, kinds};
use std::collections::BTreeMap;
use std::hash::Hasher;
use std::io::{self, Write};

#[derive(Default)]
struct Digest {
    first: std::collections::hash_map::DefaultHasher,
    second: std::collections::hash_map::DefaultHasher,
    bytes: u64,
}
impl Write for Digest {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.first.write(bytes);
        for chunk in bytes.chunks(1024) {
            self.second.write_u64(chunk.len() as u64);
            self.second.write(chunk);
        }
        self.bytes += bytes.len() as u64;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn fingerprints(store: &Store) -> BTreeMap<String, (u64, u64, u64)> {
    let mut hashes = BTreeMap::new();
    for chat in store.chats().unwrap() {
        let id = chat["id"].as_str().unwrap().to_string();
        let mut digest = Digest::default();
        serde_json::to_writer(&mut digest, &chat).unwrap();
        hashes.insert(
            id,
            (digest.first.finish(), digest.second.finish(), digest.bytes),
        );
    }
    hashes
}
#[test]
#[ignore = "requires an explicit offline database COPY in PRISM_RECOVERY_DATABASE"]
fn compact_large_history_preserves_every_folded_chat_and_usage_origin() {
    let path = std::env::var_os("PRISM_RECOVERY_DATABASE")
        .expect("Set an offline COPY path; never the live profile");
    let path = std::path::PathBuf::from(path);
    assert!(path.is_file(), "the copied database must already exist");
    assert!(
        !path.parent().unwrap().join("host-instance.json").exists(),
        "refuse a host data directory; use a separate offline copy"
    );
    let store = Store::open(&path).unwrap();
    println!("reading logical history before compaction");
    let before = fingerprints(&store);
    let runs = store.turn_runs().unwrap();
    let tasks = store.documents(kinds::TASKS).unwrap();
    let profiles = store.documents(kinds::PROFILES).unwrap();
    let changed = store.compact_all().unwrap();
    println!("compacted {changed} chats; comparing logical history");
    assert_eq!(
        fingerprints(&store),
        before,
        "every chat must retain its full folded content"
    );
    assert_eq!(
        store.turn_runs().unwrap(),
        runs,
        "profile/session attribution must survive"
    );
    assert_eq!(store.documents(kinds::TASKS).unwrap(), tasks);
    assert_eq!(store.documents(kinds::PROFILES).unwrap(), profiles);
    drop(store);
    let reopened = Store::open(&path).unwrap();
    assert_eq!(
        fingerprints(&reopened),
        before,
        "reopening must preserve the same content"
    );
    assert_eq!(reopened.turn_runs().unwrap(), runs);
    println!(
        "preserved {} chats, {} tasks, {} profiles and {} usage origins",
        before.len(),
        tasks.len(),
        profiles.len(),
        runs.len()
    );
}
