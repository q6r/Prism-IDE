//! Claude Code session transcripts (`<config>/projects/<key>/<session>.jsonl`):
//! checkpoint ids for rewind, and the fork the Agent SDK's `forkSession`
//! makes (a copy of the conversation up to a message, under a new session).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

/// A Claude Code session id (a UUID); anything else never names a file.
pub fn valid_session_id(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// `<config>/projects/*/<session>.jsonl`.
pub fn find_transcript(config_dir: &Path, session_id: &str) -> Option<PathBuf> {
    if !valid_session_id(session_id) {
        return None;
    }
    let projects = config_dir.join("projects");
    for entry in std::fs::read_dir(&projects).ok()?.flatten() {
        let file = entry.path().join(format!("{session_id}.jsonl"));
        if file.is_file() {
            return Some(file);
        }
    }
    None
}

fn entries(text: &str) -> impl Iterator<Item = Value> + '_ {
    text.lines().filter(|l| !l.trim().is_empty()).filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(Value::is_object)
}

/// Ordered uuids of the user's prompts (not tool results, meta or sidechain
/// entries): index N is the chat's Nth user message.
pub fn checkpoint_ids(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for o in entries(text) {
        if o.get("type").and_then(Value::as_str) != Some("user") || super::json::truthy(o.get("isSidechain")) || super::json::truthy(o.get("isMeta")) {
            continue;
        }
        let content = o.pointer("/message/content");
        let blocks = content.and_then(Value::as_array);
        let tool_result = blocks.is_some_and(|b| b.iter().any(|x| x.get("type").and_then(Value::as_str) == Some("tool_result")));
        let has_text = content.is_some_and(Value::is_string) || blocks.is_some_and(|b| b.iter().any(|x| x.get("type").and_then(Value::as_str) == Some("text")));
        let Some(uuid) = super::json::text(o.get("uuid")) else { continue };
        if tool_result || !has_text {
            continue;
        }
        out.push(uuid.to_string());
    }
    out
}

const CONVERSATION: [&str; 5] = ["user", "assistant", "attachment", "system", "progress"];
/// Fields a fork clears (subagent and team bookkeeping of the source).
const CLEARED: [&str; 6] = ["teamName", "agentName", "sessionKind", "slug", "sourceToolAssistantUUID", "summarizedTurnPromptUuids"];

/// A queued command's own uuid (`attachment.source_uuid`), which a fork point may name.
fn source_uuid(e: &Value) -> Option<&str> {
    if e.get("type").and_then(Value::as_str) != Some("attachment") {
        return None;
    }
    let a = e.get("attachment")?;
    if a.get("type").and_then(Value::as_str) != Some("queued_command") {
        return None;
    }
    super::json::text(a.get("source_uuid"))
}

fn printable(s: &str) -> bool {
    s.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// The session's title, for the fork's own: the custom title, else the AI
/// one, else the first prompt.
fn title(all: &[Value]) -> Option<String> {
    let last = |key: &str| all.iter().rev().find_map(|e| super::json::text(e.get(key)).map(str::to_string));
    last("customTitle").or_else(|| last("aiTitle")).or_else(|| {
        all.iter()
            .filter(|e| e.get("type").and_then(Value::as_str) == Some("user") && !super::json::truthy(e.get("isMeta")) && !super::json::truthy(e.get("isCompactSummary")))
            .find_map(|e| {
                let content = e.pointer("/message/content")?;
                let text = match content {
                    Value::String(s) => s.clone(),
                    Value::Array(blocks) => {
                        if blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")) {
                            return None;
                        }
                        blocks.iter().find_map(|b| super::json::text(b.get("text")).map(str::to_string))?
                    }
                    _ => return None,
                };
                let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
                Some(line.chars().take(200).collect())
            })
    })
}

/// The fork's entries: the source's conversation up to `up_to` (inclusive),
/// with fresh uuids and the new session id, as `forkSession` writes them.
/// Not ported: the SDK's repair of compacted chains (`preservedMessages`
/// segments are copied as they are).
pub fn fork_entries(text: &str, session_id: &str, up_to: Option<&str>, new_id: &str, now: &str, mut new_uuid: impl FnMut() -> String) -> Result<Vec<Value>, String> {
    let all: Vec<Value> = entries(text).collect();
    let mut transcript = Vec::new();
    let mut replacements = Vec::new();
    let mut relocated: Option<String> = None;
    let mut suppressed = false;
    let mut latch: Option<String> = None;
    for e in &all {
        let kind = e.get("type").and_then(Value::as_str).unwrap_or("");
        let same_session = e.get("sessionId").and_then(Value::as_str) == Some(session_id);
        if CONVERSATION.contains(&kind) && e.get("uuid").is_some_and(Value::is_string) {
            transcript.push(e.clone());
        } else if kind == "history-suppression" {
            suppressed = true;
        } else if kind == "atis-latch" && same_session && let Some(atis) = e.get("atis").and_then(Value::as_str) && printable(atis) {
            latch = Some(atis.to_string());
        } else if kind == "content-replacement" && same_session && let Some(r) = e.get("replacements").and_then(Value::as_array) {
            replacements.extend(r.iter().cloned());
        } else if kind == "relocated" && same_session && let Some(cwd) = super::json::text(e.get("relocatedCwd")) {
            relocated = Some(cwd.to_string());
        }
    }
    let mut o: Vec<Value> = transcript.into_iter().filter(|e| !super::json::truthy(e.get("isSidechain"))).collect();
    if o.is_empty() {
        return Err(format!("A sessão {session_id} não tem mensagens para bifurcar."));
    }
    if let Some(target) = up_to {
        let at = o
            .iter()
            .position(|e| e.get("uuid").and_then(Value::as_str) == Some(target))
            .or_else(|| o.iter().position(|e| source_uuid(e) == Some(target)))
            .ok_or_else(|| format!("A mensagem {target} não existe na sessão {session_id}."))?;
        o.truncate(at + 1);
    }
    let uuid_of = |e: &Value| e.get("uuid").and_then(Value::as_str).unwrap_or("").to_string();
    let mut fresh: HashMap<String, String> = HashMap::new();
    for e in &o {
        fresh.insert(uuid_of(e), new_uuid());
    }
    let kept: Vec<&Value> = o.iter().filter(|e| e.get("type").and_then(Value::as_str) != Some("progress")).collect();
    if kept.is_empty() {
        return Err(format!("A sessão {session_id} não tem mensagens para bifurcar."));
    }
    let kept_ids: HashMap<String, String> = kept.iter().map(|e| (uuid_of(e), fresh[&uuid_of(e)].clone())).collect();
    let by_uuid: HashMap<String, &Value> = o.iter().map(|e| (uuid_of(e), e)).collect();

    let mut out = Vec::new();
    if suppressed {
        out.push(json!({"type": "history-suppression", "sessionId": new_id, "cause": "fork_inherit", "ts": now}));
    }
    for (index, e) in kept.iter().enumerate() {
        let mut entry: Map<String, Value> = e.as_object().cloned().unwrap_or_default();
        // The nearest ancestor that is not progress chatter.
        let mut parent: Option<String> = None;
        let mut cursor = e.get("parentUuid").and_then(Value::as_str).map(str::to_string);
        let mut seen = HashSet::new();
        while let Some(id) = cursor {
            let Some(ancestor) = by_uuid.get(&id) else { break };
            if ancestor.get("type").and_then(Value::as_str) != Some("progress") || !seen.insert(id.clone()) {
                parent = fresh.get(&id).cloned();
                break;
            }
            cursor = ancestor.get("parentUuid").and_then(Value::as_str).map(str::to_string);
        }
        if e.get("type").and_then(Value::as_str) == Some("system") && e.get("subtype").and_then(Value::as_str) == Some("model_refusal_fallback") {
            entry.insert("neutralizedByFork".into(), Value::Bool(true));
        }
        if let Some(Value::Object(attachment)) = e.get("attachment") {
            let mut attachment = attachment.clone();
            if attachment.get("type").and_then(Value::as_str) == Some("deferred_tools_record")
                && let Some(Value::Array(names)) = attachment.get("nameOnlyAnnouncements")
            {
                let mapped: Vec<Value> = names.iter().filter_map(|n| n.as_str().and_then(|n| fresh.get(n)).map(|v| Value::String(v.clone()))).collect();
                attachment.insert("nameOnlyAnnouncements".into(), Value::Array(mapped));
            }
            if let Some(source) = source_uuid(e).and_then(|s| fresh.get(s)) {
                attachment.insert("source_uuid".into(), Value::String(source.clone()));
            }
            entry.insert("attachment".into(), Value::Object(attachment));
        }
        if let Some(Value::Object(meta)) = e.get("compactMetadata") {
            let remap = |v: &Value| match v {
                Value::String(s) => Value::String(kept_ids.get(s).cloned().unwrap_or_else(|| s.clone())),
                Value::Array(items) => Value::Array(items.iter().map(|i| i.as_str().and_then(|s| kept_ids.get(s)).map(|s| Value::String(s.clone())).unwrap_or_else(|| i.clone())).collect()),
                other => other.clone(),
            };
            let mut meta = meta.clone();
            meta.shift_remove("runningTurnSends");
            for (field, keys) in [("preservedMessages", &["anchorUuid", "uuids", "allUuids"][..]), ("preservedSegment", &["headUuid", "anchorUuid", "tailUuid"][..])] {
                if let Some(Value::Object(inner)) = meta.get(field).cloned() {
                    let mut inner = inner;
                    for key in keys {
                        if let Some(v) = inner.get(*key).cloned() {
                            inner.insert((*key).into(), remap(&v));
                        }
                    }
                    meta.insert(field.into(), Value::Object(inner));
                }
            }
            entry.insert("compactMetadata".into(), Value::Object(meta));
        }
        let old_uuid = uuid_of(e);
        entry.insert("uuid".into(), Value::String(fresh[&old_uuid].clone()));
        entry.insert("parentUuid".into(), parent.map(Value::String).unwrap_or(Value::Null));
        match e.get("logicalParentUuid") {
            None => {}
            Some(Value::Null) => {}
            Some(v) => {
                let mapped = v.as_str().and_then(|s| fresh.get(s)).map(|s| Value::String(s.clone())).unwrap_or(Value::Null);
                entry.insert("logicalParentUuid".into(), mapped);
            }
        }
        entry.insert("sessionId".into(), Value::String(new_id.to_string()));
        if index == kept.len() - 1 {
            entry.insert("timestamp".into(), Value::String(now.to_string()));
        }
        entry.insert("isSidechain".into(), Value::Bool(false));
        for key in CLEARED {
            entry.shift_remove(key);
        }
        entry.insert("forkedFrom".into(), json!({"sessionId": session_id, "messageUuid": old_uuid}));
        out.push(Value::Object(entry));
    }
    if !replacements.is_empty() {
        out.push(json!({"type": "content-replacement", "sessionId": new_id, "replacements": replacements, "uuid": new_uuid(), "timestamp": now}));
    }
    if let Some(atis) = latch {
        out.push(json!({"type": "atis-latch", "sessionId": new_id, "atis": atis}));
    }
    if let Some(cwd) = relocated {
        out.push(json!({"type": "relocated", "sessionId": new_id, "relocatedCwd": cwd}));
    }
    let name = format!("{} (fork)", title(&all).unwrap_or_else(|| "Forked session".into()));
    out.push(json!({"type": "custom-title", "sessionId": new_id, "customTitle": name, "uuid": new_uuid(), "timestamp": now}));
    Ok(out)
}

/// Writes the fork next to the source transcript; returns the new session id and file.
pub fn fork(source: &Path, session_id: &str, up_to: Option<&str>) -> Result<(String, PathBuf), String> {
    let text = std::fs::read_to_string(source).map_err(|err| format!("Não foi possível ler a transcrição: {err}"))?;
    let new_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let entries = fork_entries(&text, session_id, up_to, &new_id, &now, || uuid::Uuid::new_v4().to_string())?;
    let file = source.with_file_name(format!("{new_id}.jsonl"));
    let mut body = String::new();
    for e in entries {
        body.push_str(&serde_json::to_string(&e).unwrap_or_default());
        body.push('\n');
    }
    std::fs::write(&file, body).map_err(|err| format!("Não foi possível gravar a bifurcação: {err}"))?;
    Ok((new_id, file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids_must_be_uuids() {
        assert!(valid_session_id("018626cf-a8bb-4030-a22c-18746c520798"));
        assert!(!valid_session_id("../../etc/passwd"));
        assert!(!valid_session_id("018626cf-a8bb-4030-a22c-18746c52079"));
    }

    #[test]
    fn checkpoints_skip_tool_results_meta_and_sidechains() {
        let text = [
            r#"{"type":"user","uuid":"a","message":{"content":"oi"}}"#,
            r#"{"type":"user","uuid":"b","message":{"content":[{"type":"tool_result","content":"x"}]}}"#,
            r#"{"type":"user","uuid":"c","isMeta":true,"message":{"content":"meta"}}"#,
            r#"{"type":"user","uuid":"d","isSidechain":true,"message":{"content":"sub"}}"#,
            r#"{"type":"assistant","uuid":"e","message":{"content":[{"type":"text","text":"r"}]}}"#,
            r#"{"type":"user","uuid":"f","message":{"content":[{"type":"text","text":"dois"}]}}"#,
            "not json",
        ]
        .join("\n");
        assert_eq!(checkpoint_ids(&text), vec!["a", "f"]);
    }

    #[test]
    fn a_fork_skips_progress_in_the_parent_chain() {
        let text = [
            r#"{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"s","message":{"content":"oi"},"timestamp":"t1","teamName":"x"}"#,
            r#"{"type":"progress","uuid":"p1","parentUuid":"u1","sessionId":"s"}"#,
            r#"{"type":"assistant","uuid":"a1","parentUuid":"p1","sessionId":"s","timestamp":"t2"}"#,
            r#"{"type":"user","uuid":"u2","parentUuid":"a1","sessionId":"s","message":{"content":"dois"},"timestamp":"t3"}"#,
            r#"{"type":"ai-title","aiTitle":"Título","sessionId":"s"}"#,
        ]
        .join("\n");
        let mut n = 0;
        let out = fork_entries(&text, "s", Some("a1"), "new", "now", || {
            n += 1;
            format!("n{n}")
        })
        .unwrap();
        let kinds: Vec<&str> = out.iter().map(|e| e["type"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["user", "assistant", "custom-title"]);
        assert_eq!(out[1]["parentUuid"], out[0]["uuid"]);
        assert_eq!(out[1]["timestamp"], "now");
        assert_eq!(out[0]["timestamp"], "t1");
        assert!(out[0].get("teamName").is_none());
        assert_eq!(out[1]["forkedFrom"], json!({"sessionId": "s", "messageUuid": "a1"}));
        assert_eq!(out[2]["customTitle"], "Título (fork)");
        assert!(fork_entries(&text, "s", Some("zzz"), "new", "now", String::new).is_err());
    }
}
