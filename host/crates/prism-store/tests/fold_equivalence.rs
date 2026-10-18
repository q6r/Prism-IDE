//! The Rust fold against the TypeScript `foldJournal`: every expected chat in
//! `host/fixtures/journal` was produced by the TypeScript
//! (`node scripts/gen-journal-fixtures.cjs`).

mod common;

use prism_store::{compaction_cut, fold_journal};
use serde_json::Value;

fn records(case: &Value) -> Vec<(&str, &Value)> {
    case["records"].as_array().unwrap().iter().map(|r| (r["turnId"].as_str().unwrap(), &r["event"])).collect()
}

fn check_cases(file: &str) -> usize {
    let fixture = common::fixture(file);
    let cases = fixture["cases"].as_array().unwrap();
    assert!(!cases.is_empty(), "{file} has no cases");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let folded = fold_journal(&case["chat"], records(case));
        assert_eq!(folded, case["expected"], "{file}: {name}");
    }
    cases.len()
}

#[test]
fn scenarios_match_the_typescript_fold() {
    assert!(check_cases("scenarios.json") >= 15);
}

#[test]
fn random_journals_match_the_typescript_fold() {
    assert!(check_cases("random.json") >= 100);
}

/// Folding the compactable prefix into the document and then the rest gives
/// the same chat as folding everything: what `Store::compact_chat` relies on.
#[test]
fn compaction_preserves_every_fixture_chat() {
    let mut compacted = 0;
    for file in ["scenarios.json", "random.json"] {
        let fixture = common::fixture(file);
        for case in fixture["cases"].as_array().unwrap() {
            let all = records(case);
            let Some(cut) = compaction_cut(all.iter().copied()) else {
                continue;
            };
            compacted += 1;
            let document = fold_journal(&case["chat"], all[..=cut].iter().copied());
            let refolded = fold_journal(&document, all[cut + 1..].iter().copied());
            assert_eq!(refolded, case["expected"], "{file}: {} (cut at {cut})", case["name"]);
        }
    }
    assert!(compacted > 20, "too few compactable fixtures ({compacted})");
}

#[test]
fn repository_fixture_chats_fold_like_the_typescript_repository() {
    // AgentRepository.get('chats') = foldJournal(stored document, events).
    // Here without the reopen repair, so only chats with no running turn.
    let fixture = common::fixture("repository-v02.json");
    let rows = &fixture["rows"];
    for expected in fixture["expected"]["chats"].as_array().unwrap() {
        let id = expected["id"].as_str().unwrap();
        if id == "chat-b" {
            continue;
        }
        let doc = rows["documents"].as_array().unwrap().iter().find(|d| d["kind"] == "chats" && d["id"] == id).unwrap();
        let doc: Value = serde_json::from_str(doc["body"].as_str().unwrap()).unwrap();
        let events: Vec<(String, Value)> = rows["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["chat_id"] == id)
            .map(|e| (e["turn_id"].as_str().unwrap().to_string(), serde_json::from_str(e["body"].as_str().unwrap()).unwrap()))
            .collect();
        let folded = fold_journal(&doc, events.iter().map(|(t, e)| (t.as_str(), e)));
        assert_eq!(&folded, expected, "{id}");
    }
}
