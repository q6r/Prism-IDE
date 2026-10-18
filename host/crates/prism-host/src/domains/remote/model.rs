//! What the phone sees and may do, without any I/O: the chat's snapshot, the
//! per-turn delta, the chat list entry, the per-chat tokens and the decision
//! for each phone command. Ports of src/renderer/src/lib/remoteControlModel.ts
//! and src/main/ipc/remoteControlState.ts, over the folded `UnifiedChat` (JSON)
//! and the engine's `ChatRuntime`.
//!
//! JavaScript semantics kept: `trim` and `\s` with JS's whitespace set, `||`,
//! `??` and truthiness, `===` (objects never equal), `undefined` fields left
//! out of the output. Deviations:
//! - lengths and cuts (`.length`, `.slice`, `JSON.stringify(turn).length`)
//!   count `char`s, not UTF-16 units: a character outside the BMP counts 1
//!   instead of 2 and is never split in half;
//! - where the TS would throw on a malformed value (a non-string `text`, a
//!   non-array `segments`, `questions` or `options`), the value counts as
//!   empty;
//! - `String(number)` of a non-integral float may differ from JS in
//!   exponent notation.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;

use prism_protocol::ErrorCode;
use prism_protocol::chats::{ChatRuntime, PermissionDecision};
use serde::Serialize;
use serde_json::{Map, Value, json};

/// How many turns / segments per turn a snapshot carries (payload stays small).
pub const MAX_TURNS: usize = 40;
pub const MAX_SEGMENTS: usize = 40;
/// A user message is cut here; assistant text lives in its (already cut) segments.
pub const MAX_USER_TEXT: usize = 4000;
/// Rough size budget (serialized chars) for the turns in one snapshot; the newest turn always fits.
pub const MAX_SNAPSHOT_CHARS: usize = 120_000;

const INTERRUPTED: &str = "⏹ Tarefa interrompida.";

/// JS `\s` / `String.prototype.trim` whitespace (WhiteSpace + LineTerminator).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `!!value`, with an absent value as `undefined`.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `a === b`, with an absent value as `undefined`; objects and arrays are
/// distinct references, so never equal.
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::Array(_) | Value::Object(_)), _)
        | (_, Some(Value::Array(_) | Value::Object(_))) => false,
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// `String(value)`.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if !n.is_i64() && !n.is_u64() && f.fract() == 0.0 && f.abs() < 1e21 => {
                format!("{f:.0}")
            }
            _ => n.to_string(),
        },
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `value || ''` for a string field.
fn text_of(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or("")
}

/// `text.slice(0, max)`.
fn take(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() > max {
        format!("{}…", take(text, max))
    } else {
        text.to_string()
    }
}

/// `value.replace(/\s+/g, ' ').trim().slice(0, max)`.
fn one_line(value: &str, max: usize) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_space = false;
    for c in value.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    take(js_trim(&out), max)
}

/// `JSON.stringify(value).length`.
fn json_len(v: &Value) -> usize {
    serde_json::to_string(v)
        .map(|s| s.chars().count())
        .unwrap_or(0)
}

/// `{ key: value }` where an `undefined` value leaves the key out.
fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(v) = value {
        map.insert(key.into(), v.clone());
    }
}

fn turns_of(chat: &Value) -> &[Value] {
    chat.get("turns")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn array_of(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// Title the phone lists the chat under.
pub fn remote_title(chat: &Value) -> String {
    let title = chat.get("title").and_then(Value::as_str).map(js_trim);
    if let Some(t) = title.filter(|t| !t.is_empty() && *t != "Novo chat") {
        return t.to_string();
    }
    let first = turns_of(chat)
        .iter()
        .find(|t| t.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|t| t.get("text"))
        .and_then(Value::as_str)
        .map(js_trim);
    match (first, title) {
        (Some(first), _) if !first.is_empty() => one_line(first, 36),
        (_, Some(title)) if !title.is_empty() => title.to_string(),
        _ => "Chat".into(),
    }
}

/// One-line hint of what a tool call touched (path, command, pattern, url…).
pub fn tool_preview(input: Option<&Value>) -> String {
    let Some(Value::Object(i)) = input else {
        return String::new();
    };
    for key in [
        "file_path",
        "notebook_path",
        "path",
        "command",
        "pattern",
        "url",
        "query",
        "prompt",
        "description",
    ] {
        let Some(v) = i.get(key).filter(|v| !v.is_null()) else {
            continue;
        };
        let text = one_line(&js_string(v), 140);
        if !text.is_empty() {
            return text;
        }
    }
    String::new()
}

/// The body of a permission card (the `agent:permission` payload): the
/// command, the edit, the content or the raw input.
pub fn permission_preview(permission: &Value) -> String {
    let empty = Value::Object(Map::new());
    let i = permission
        .get("input")
        .filter(|v| truthy(Some(v)))
        .unwrap_or(&empty);
    let get = |key: &str| i.as_object().and_then(|o| o.get(key));
    if let Some(Value::String(command)) = get("command") {
        return take(command, 600);
    }
    if truthy(get("file_path")) || truthy(get("path")) {
        let head = get("file_path")
            .filter(|v| !v.is_null())
            .or(get("path"))
            .map(js_string)
            .unwrap_or_default();
        let body = match get("new_string") {
            Some(Value::String(s)) => format!("\n{}", take(s, 500)),
            _ => String::new(),
        };
        return head + &body;
    }
    if let Some(Value::String(content)) = get("content") {
        return take(content, 600);
    }
    let mut out = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(
        &mut out,
        serde_json::ser::PrettyFormatter::with_indent(b" "),
    );
    match i.serialize(&mut ser) {
        Ok(()) => take(&String::from_utf8(out).unwrap_or_default(), 500),
        Err(_) => String::new(),
    }
}

/// Tool status as the mobile page names it (`run`, `done`, `err`, `denied`, `awaiting`).
pub fn remote_status(status: Option<&str>) -> String {
    match status {
        None | Some("running") => "run".into(),
        Some("error") => "err".into(),
        Some(other) => other.into(),
    }
}

fn image_refs(images: Option<&Value>, base: Value, catalog: Option<&[crate::domains::chats::image_references::ImageReference<'_>]>) -> Value {
    json!(array_of(images).iter().enumerate().map(|(index, image)| {
        let mut reference = base.as_object().cloned().unwrap_or_default();
        reference.insert("index".into(), json!(index));
        let mut image_ref = json!({"mime": image.get("mime"), "name": image.get("name"), "ref": reference});
        if let Some(number) = catalog.and_then(|catalog| crate::domains::chats::image_references::image_reference_number(catalog, image)).or_else(|| image.get("number").and_then(Value::as_u64)) { image_ref["number"] = json!(number); }
        image_ref
    }).collect::<Vec<_>>())
}
fn remote_subagent(agent: &Value) -> Value {
    let mut m = Map::new();
    for (key, limit) in [("id", 160), ("chatId", 160), ("name", 120), ("description", 1500), ("model", 100), ("spawnToolCallId", 160), ("activity", 1500), ("summary", 6000)] {
        if let Some(text) = agent.get(key).and_then(Value::as_str) { m.insert(key.into(), json!(take(text, limit))); }
    }
    for key in ["status", "startedAt", "updatedAt"] { put(&mut m, key, agent.get(key)); }
    Value::Object(m)
}
fn remote_segment(s: &Value, turn_id: &str, catalog: Option<&[crate::domains::chats::image_references::ImageReference<'_>]>) -> Value {
    let mut m = Map::new();
    let kind = s.get("kind");
    if s.get("images").is_some() { m.insert("images".into(), image_refs(s.get("images"), json!({"turnId": turn_id, "toolId": s.get("toolId")}), catalog)); }
    if kind.and_then(Value::as_str) == Some("tool") {
        m.insert("kind".into(), json!("tool"));
        if let Some(agent) = s.get("subagent").filter(|agent| agent.is_object()) { m.insert("subagent".into(), remote_subagent(agent)); }
        put(&mut m, "name", s.get("name"));
        m.insert(
            "status".into(),
            json!(remote_status(s.get("status").and_then(Value::as_str))),
        );
        m.insert("preview".into(), json!(tool_preview(s.get("input"))));
    } else {
        put(&mut m, "kind", kind);
        if kind.and_then(Value::as_str) == Some("text") {
            let questions: Vec<Value> = array_of(s.get("questions")).iter().filter_map(|question| {
                let title = question.get("title").and_then(Value::as_str).filter(|title| !title.trim().is_empty())?;
                let mut row = Map::new(); row.insert("title".into(), json!(title));
                if let Some(options) = question.get("options").and_then(Value::as_array) {
                    row.insert("options".into(), json!(options.iter().filter(|option| option.is_string()).take(24).collect::<Vec<_>>()));
                }
                Some(Value::Object(row))
            }).take(12).collect();
            if !questions.is_empty() { put(&mut m, "toolId", s.get("toolId")); m.insert("questions".into(), json!(questions)); }
        }
        let max = if kind.and_then(Value::as_str) == Some("thinking") {
            800
        } else {
            6000
        };
        m.insert("text".into(), json!(take(text_of(s.get("text")), max)));
    }
    Value::Object(m)
}

fn pending_perm(perm: &Value) -> Value {
    let mut m = Map::new();
    put(&mut m, "permId", perm.get("permId"));
    put(&mut m, "toolName", perm.get("toolName"));
    let title = perm.get("title");
    put(
        &mut m,
        "title",
        if truthy(title) {
            title
        } else {
            perm.get("displayName")
        },
    );
    put(&mut m, "desc", perm.get("description"));
    m.insert("preview".into(), json!(permission_preview(perm)));
    Value::Object(m)
}

fn pending_question(question: &Value) -> Value {
    let questions: Vec<Value> = array_of(question.get("questions"))
        .iter()
        .map(|q| {
            let mut qm = Map::new();
            put(&mut qm, "question", q.get("question"));
            put(&mut qm, "header", q.get("header"));
            put(&mut qm, "multiSelect", q.get("multiSelect"));
            let options: Vec<Value> = array_of(q.get("options"))
                .iter()
                .map(|o| {
                    let mut om = Map::new();
                    put(&mut om, "label", o.get("label"));
                    put(&mut om, "description", o.get("description"));
                    Value::Object(om)
                })
                .collect();
            qm.insert("options".into(), Value::Array(options));
            Value::Object(qm)
        })
        .collect();
    let mut m = Map::new();
    put(&mut m, "dialogId", question.get("dialogId"));
    m.insert("questions".into(), Value::Array(questions));
    Value::Object(m)
}

/// One turn for the phone. The pending permission / question lives on the
/// chat's runtime, not on the turn, so it is attached here to the turn that
/// `running` is given for.
pub fn remote_turn(turn: &Value, running: Option<&ChatRuntime>) -> Value {
    remote_turn_numbered(turn, running, None)
}
fn remote_turn_numbered(turn: &Value, running: Option<&ChatRuntime>, catalog: Option<&[crate::domains::chats::image_references::ImageReference<'_>]>) -> Value {
    let mut m = Map::new();
    put(&mut m, "id", turn.get("id"));
    let text = text_of(turn.get("text"));
    if turn.get("role").and_then(Value::as_str) == Some("user") {
        if turn.get("images").is_some() { m.insert("images".into(), image_refs(turn.get("images"), json!({"turnId": turn.get("id")}), catalog)); }
        m.insert("role".into(), json!("user"));
        m.insert("text".into(), json!(cut(text, MAX_USER_TEXT)));
        return Value::Object(m);
    }
    // The page renders segments when there are any and `text` only otherwise, so
    // the text is never sent twice: with segments it becomes the leading one.
    let own = array_of(turn.get("segments"));
    let lead = json!({ "kind": "text", "text": text });
    let source: Vec<&Value> = if !js_trim(text).is_empty() && !own.is_empty() {
        std::iter::once(&lead).chain(own).collect()
    } else {
        own.iter().collect()
    };
    let spawned: BTreeSet<&str> = source.iter().filter_map(|segment| segment.get("subagent").and_then(|agent| agent.get("spawnToolCallId")).and_then(Value::as_str)).collect();
    let source: Vec<&Value> = source.iter().copied().filter(|segment| segment.get("subagent").is_some() || !segment.get("toolId").and_then(Value::as_str).is_some_and(|id| spawned.contains(id))).collect();
    let mut latest_question = None;
    for (index, segment) in source.iter().enumerate().rev() {
        if segment.get("kind").and_then(Value::as_str) == Some("user") { break; }
        if segment.get("kind").and_then(Value::as_str) == Some("text") && array_of(segment.get("questions")).iter().any(|question| question.get("title").and_then(Value::as_str).is_some_and(|title| !title.trim().is_empty())) { latest_question = Some(index); break; }
    }
    let mut indices = BTreeSet::new();
    for (index, segment) in source.iter().enumerate().rev() {
        if segment.get("subagent").is_some() && indices.len() < 24 { indices.insert(index); }
    }
    if let Some(index) = latest_question { indices.insert(index); }
    for index in (0..source.len()).rev() { if indices.len() >= MAX_SEGMENTS { break; } indices.insert(index); }
    let visible: Vec<&Value> = indices.into_iter().map(|index| source[index]).collect();
    let mut segments: Vec<Value> = visible
        .iter()
        .map(|s| remote_segment(s, turn.get("id").and_then(Value::as_str).unwrap_or_default(), catalog))
        .collect();
    if truthy(turn.get("interrupted")) {
        segments.push(json!({ "kind": "text", "text": INTERRUPTED }));
    }
    m.insert("role".into(), json!("assistant"));
    m.insert(
        "text".into(),
        json!(if segments.is_empty() {
            cut(text, 6000)
        } else {
            String::new()
        }),
    );
    put(&mut m, "error", turn.get("error"));
    m.insert("segments".into(), Value::Array(segments));
    if let Some(perm) = running
        .and_then(|r| r.permission.as_ref())
        .filter(|p| truthy(Some(p)))
    {
        m.insert("pendingPerm".into(), pending_perm(perm));
    }
    if let Some(question) = running
        .and_then(|r| r.question.as_ref())
        .filter(|q| truthy(Some(q)))
    {
        m.insert("pendingQuestion".into(), pending_question(question));
    }
    Value::Object(m)
}

/// The trimmed chat the phone renders (`buildRemoteSnapshot`): `{ tabId,
/// title, streaming, contextPct, turns }`, `tabId` being the chat id. The
/// pending permission / question goes on the running turn only.
pub fn build_snapshot(chat: &Value, runtime: Option<&ChatRuntime>) -> Value {
    let catalog = crate::domains::chats::image_references::collect_chat_images(chat, &[]);
    let busy = runtime.is_some_and(|r| r.busy);
    let all = turns_of(chat);
    // Newest first, until the turn cap or the size budget is reached.
    let mut turns = Vec::new();
    let mut size = 0;
    for t in all[all.len().saturating_sub(MAX_TURNS)..].iter().rev() {
        let running = runtime
            .filter(|r| busy && t.get("id").and_then(Value::as_str) == Some(r.turn_id.as_str()));
        let turn = remote_turn_numbered(t, running, Some(&catalog));
        size += json_len(&turn);
        if !turns.is_empty() && size > MAX_SNAPSHOT_CHARS {
            break;
        }
        turns.push(turn);
    }
    turns.reverse();
    let mut m = Map::new();
    put(&mut m, "tabId", chat.get("id"));
    put(&mut m, "selection", chat.get("selection"));
    m.insert("queued".into(), json!(array_of(chat.get("queued")).iter().map(|row| {
        let mut row = row.clone();
        if row.get("images").is_some() { row["images"] = image_refs(row.get("images"), json!({"queueId": row.get("id")}), Some(&catalog)); }
        row
    }).collect::<Vec<_>>()));
    m.insert("queuePaused".into(), json!(truthy(chat.get("queuePaused"))));
    m.insert("title".into(), json!(remote_title(chat)));
    m.insert("streaming".into(), json!(busy));
    // The phone does not show context usage, and native sessions report
    // cumulative totals rather than a reliable per-turn context figure.
    m.insert("contextPct".into(), json!(0));
    m.insert("turns".into(), Value::Array(turns));
    Value::Object(m)
}

/// One secret per shared chat. A link carries its chat's token, and the server
/// scopes that socket to that chat alone: it can neither read nor command any
/// other shared chat. Revoking (stop sharing) makes the token useless at once;
/// sharing again mints a new one.
#[derive(Default)]
pub struct ChatGrants {
    by_token: HashMap<String, String>,
    /// `(chat, token)`, in the order the chats were shared.
    shared: Vec<(String, String)>,
}

impl fmt::Debug for ChatGrants {
    /// The tokens are secrets: only the chats are printed.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChatGrants")
            .field("chats", &self.chats())
            .finish()
    }
}

impl ChatGrants {
    /// The chat's token, minted on first grant and kept while it stays shared.
    pub fn grant(&mut self, chat_id: &str, mut mint: impl FnMut() -> String) -> String {
        if let Some(existing) = self.token_of(chat_id) {
            return existing.to_string();
        }
        let mut token = mint();
        while self.by_token.contains_key(&token) {
            token = mint();
        }
        self.by_token.insert(token.clone(), chat_id.to_string());
        self.shared.push((chat_id.to_string(), token.clone()));
        token
    }

    /// Drops the chat's token; returns it (or `None` when it was not shared).
    pub fn revoke(&mut self, chat_id: &str) -> Option<String> {
        let at = self.shared.iter().position(|(chat, _)| chat == chat_id)?;
        let (_, token) = self.shared.remove(at);
        self.by_token.remove(&token);
        Some(token)
    }

    /// The chat a token opens; an absent or empty token opens none.
    pub fn chat_for(&self, token: Option<&str>) -> Option<&str> {
        token
            .filter(|t| !t.is_empty())
            .and_then(|t| self.by_token.get(t))
            .map(String::as_str)
    }

    pub fn token_of(&self, chat_id: &str) -> Option<&str> {
        self.shared
            .iter()
            .find(|(chat, _)| chat == chat_id)
            .map(|(_, token)| token.as_str())
    }

    pub fn has(&self, chat_id: &str) -> bool {
        self.token_of(chat_id).is_some()
    }

    pub fn len(&self) -> usize {
        self.shared.len()
    }

    pub fn is_empty(&self) -> bool {
        self.shared.is_empty()
    }

    /// The shared chats, in the order they were shared.
    pub fn chats(&self) -> Vec<String> {
        self.shared.iter().map(|(chat, _)| chat.clone()).collect()
    }

    pub fn clear(&mut self) {
        self.by_token.clear();
        self.shared.clear();
    }
}

/// 24 random bytes, hex encoded (`randomBytes(24).toString('hex')`).
pub fn mint_token() -> String {
    crate::instance::random_hex(24)
}

/// Serialized turns of the last snapshot sent, by turn id.
pub type TurnCache = HashMap<String, String>;

pub struct SnapshotDelta {
    /// Anything the phone should hear about at all.
    pub changed: bool,
    /// Title / streaming / context changed.
    pub meta_changed: bool,
    /// Turn ids in order (always sent so the phone can drop and reorder).
    pub ids: Vec<String>,
    /// Only the turns that are new or differ from the last send.
    pub turns: Vec<Value>,
    /// The cache to keep for the next diff.
    pub cache: TurnCache,
}

fn turn_id(turn: &Value) -> String {
    turn.get("id").map(js_string).unwrap_or_default()
}

/// Diffs a new snapshot against what was last sent. During streaming only the
/// running turn changes, so a delta carries one turn instead of the whole chat.
pub fn snapshot_delta(
    prev: Option<&Value>,
    prev_cache: Option<&TurnCache>,
    next: &Value,
) -> SnapshotDelta {
    let next_turns = turns_of(next);
    let mut cache = TurnCache::new();
    let mut turns = Vec::new();
    for turn in next_turns {
        let json = serde_json::to_string(turn).unwrap_or_default();
        let id = turn_id(turn);
        if prev_cache.and_then(|c| c.get(&id)) != Some(&json) {
            turns.push(turn.clone());
        }
        cache.insert(id, json);
    }
    let ids: Vec<String> = next_turns.iter().map(turn_id).collect();
    let ids_changed = prev.is_none_or(|p| {
        let before = turns_of(p);
        before.len() != ids.len()
            || before
                .iter()
                .zip(&ids)
                .any(|(t, id)| !strict_eq(t.get("id"), Some(&json!(id))))
    });
    let meta_changed = prev.is_none_or(|p| {
        ["title", "streaming", "contextPct", "selection", "queued", "queuePaused"]
            .iter()
            .any(|key| !strict_eq(p.get(*key), next.get(*key)))
    });
    SnapshotDelta {
        changed: meta_changed || ids_changed || !turns.is_empty(),
        meta_changed,
        ids,
        turns,
        cache,
    }
}

/// What the phone's chat list shows for one chat: `{ tabId, title, streaming, pending }`.
pub fn list_entry(snapshot: &Value) -> Value {
    let mut m = Map::new();
    put(&mut m, "tabId", snapshot.get("tabId"));
    put(&mut m, "title", snapshot.get("title"));
    put(&mut m, "streaming", snapshot.get("streaming"));
    let pending = turns_of(snapshot)
        .iter()
        .any(|t| truthy(t.get("pendingPerm")) || truthy(t.get("pendingQuestion")));
    m.insert("pending".into(), json!(pending));
    Value::Object(m)
}

pub fn same_entry(a: Option<&Value>, b: &Value) -> bool {
    a.is_some_and(|a| {
        ["title", "streaming", "pending"]
            .iter()
            .all(|key| strict_eq(a.get(*key), b.get(*key)))
    })
}

/// A phone command the chat accepts now (`runRemoteCommand` without the call
/// to the store: the domain hands it to the chats engine).
#[derive(Debug, Clone, PartialEq)]
pub enum PhoneCommand {
    /// The trimmed text.
    Send {
        text: String,
    },
    Stop,
    Extra { action: String, payload: Value },
    Permission {
        perm_id: String,
        decision: PermissionDecision,
    },
    /// `answers: None` cancels the question.
    Question {
        dialog_id: String,
        answers: Option<BTreeMap<String, String>>,
        response: Option<String>,
    },
}

fn decision_of(v: Option<&Value>) -> Option<PermissionDecision> {
    match v.and_then(Value::as_str)? {
        "allow" => Some(PermissionDecision::Allow),
        "allow_always" => Some(PermissionDecision::AllowAlways),
        "deny" => Some(PermissionDecision::Deny),
        _ => None,
    }
}

/// `payload.turnId` given and not the running turn.
fn stale_turn(payload: &Value, runtime: &ChatRuntime) -> bool {
    payload
        .get("turnId")
        .is_some_and(|t| !strict_eq(Some(t), Some(&json!(runtime.turn_id))))
}

/// The answers that are non-blank strings (`stringRecord`).
fn string_record(value: Option<&Value>) -> BTreeMap<String, String> {
    let Some(Value::Object(entries)) = value else {
        return BTreeMap::new();
    };
    entries
        .iter()
        .filter_map(|(k, v)| {
            v.as_str()
                .filter(|s| !js_trim(s).is_empty())
                .map(|s| (k.clone(), s.to_string()))
        })
        .collect()
}

/// What the phone may do now, or why it may not: `no-chat`, `empty`,
/// `read-only`, `busy`, `idle`, `invalid`, `gone`, `unknown`. `blocked` does
/// not come from here: it is the engine's refusal (`refusal_reason`).
pub fn decide(
    chat: Option<&Value>,
    runtime: Option<&ChatRuntime>,
    action: &str,
    payload: &Value,
) -> Result<PhoneCommand, &'static str> {
    let Some(chat) = chat else {
        return Err("no-chat");
    };
    let busy_rt = runtime.filter(|r| r.busy);
    if matches!(action, "models" | "image" | "changes" | "file") {
        return Ok(PhoneCommand::Extra { action: action.into(), payload: payload.clone() });
    }
    if matches!(action, "configure" | "queue") {
        if truthy(chat.get("readOnly")) { return Err("read-only"); }
        return Ok(PhoneCommand::Extra { action: action.into(), payload: payload.clone() });
    }
    match action {
        "send" => {
            let text = js_trim(text_of(payload.get("text")));
            if text.is_empty() {
                return Err("empty");
            }
            if truthy(chat.get("readOnly")) {
                return Err("read-only");
            }
            if busy_rt.is_some() {
                return Ok(PhoneCommand::Extra { action: "queue".into(), payload: json!({"operation": "add", "message": {"text": text}}) });
            }
            Ok(PhoneCommand::Send {
                text: text.to_string(),
            })
        }
        "stop" => busy_rt.map(|_| PhoneCommand::Stop).ok_or("idle"),
        "perm" => {
            let decision = decision_of(payload.get("decision")).ok_or("invalid")?;
            let rt = busy_rt.ok_or("gone")?;
            let perm = rt
                .permission
                .as_ref()
                .filter(|p| truthy(Some(p)))
                .ok_or("gone")?;
            if !strict_eq(perm.get("permId"), payload.get("permId")) || stale_turn(payload, rt) {
                return Err("gone");
            }
            Ok(PhoneCommand::Permission {
                perm_id: perm.get("permId").map(js_string).unwrap_or_default(),
                decision,
            })
        }
        "question" => {
            let rt = busy_rt.ok_or("gone")?;
            let question = rt
                .question
                .as_ref()
                .filter(|q| truthy(Some(q)))
                .ok_or("gone")?;
            if !strict_eq(question.get("dialogId"), payload.get("dialogId"))
                || stale_turn(payload, rt)
            {
                return Err("gone");
            }
            let dialog_id = question.get("dialogId").map(js_string).unwrap_or_default();
            if truthy(payload.get("cancelled")) {
                return Ok(PhoneCommand::Question {
                    dialog_id,
                    answers: None,
                    response: None,
                });
            }
            let answers = string_record(payload.get("answers"));
            if answers.is_empty() {
                return Err("empty");
            }
            let response = payload
                .get("response")
                .and_then(Value::as_str)
                .filter(|r| !js_trim(r).is_empty())
                .map(String::from);
            Ok(PhoneCommand::Question {
                dialog_id,
                answers: Some(answers),
                response,
            })
        }
        _ => Err("unknown"),
    }
}

/// The engine's refusal as the reason the mobile page knows.
pub fn refusal_reason(code: ErrorCode) -> &'static str {
    match code {
        ErrorCode::Busy => "busy",
        ErrorCode::Gone => "gone",
        ErrorCode::NotFound => "no-chat",
        ErrorCode::Invalid => "blocked",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- fixtures ----

    fn with(mut base: Value, extra: Value) -> Value {
        let target = base.as_object_mut().unwrap();
        for (k, v) in extra.as_object().unwrap() {
            target.insert(k.clone(), v.clone());
        }
        base
    }

    fn user(id: &str, text: &str) -> Value {
        json!({ "id": id, "role": "user", "text": text })
    }

    fn asst(id: &str) -> Value {
        json!({ "id": id, "role": "assistant", "text": "", "segments": [] })
    }

    fn asst_with(id: &str, extra: Value) -> Value {
        with(asst(id), extra)
    }

    fn chat(extra: Value) -> Value {
        with(json!({ "id": "chat-1", "title": "My chat", "turns": [] }), extra)
    }

    fn perm(extra: Value) -> Value {
        with(
            json!({
                "permId": "p1", "toolName": "Bash", "title": "Run it", "displayName": "Bash",
                "description": "why", "input": { "command": "ls" }
            }),
            extra,
        )
    }

    fn question(extra: Value) -> Value {
        with(
            json!({
                "dialogId": "d1",
                "questions": [{
                    "question": "Q?", "header": "H", "multiSelect": true,
                    "options": [{ "label": "A", "description": "da", "extra": 1 }]
                }]
            }),
            extra,
        )
    }

    fn rt(turn_id: &str, busy: bool) -> ChatRuntime {
        ChatRuntime {
            turn_id: turn_id.into(),
            route: String::new(),
            busy,
            permission: None,
            question: None,
            fast: None,
        }
    }

    fn rt_with(turn_id: &str, busy: bool, permission: Option<Value>, question: Option<Value>) -> ChatRuntime {
        ChatRuntime {
            permission,
            question,
            ..rt(turn_id, busy)
        }
    }

    fn busy_rt(permission: Option<Value>, question: Option<Value>) -> ChatRuntime {
        rt_with("t1", true, permission, question)
    }

    fn len_of(v: &Value) -> usize {
        v.as_str().unwrap().chars().count()
    }

    fn texts(n: usize) -> Vec<Value> {
        (0..n)
            .map(|i| json!({ "kind": "text", "text": format!("s{i}") }))
            .collect()
    }

    fn sorted_keys(cache: &TurnCache) -> Vec<String> {
        let mut keys: Vec<String> = cache.keys().cloned().collect();
        keys.sort();
        keys
    }

    fn counter(prefix: &'static str) -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("{prefix}{n}")
        }
    }

    fn turn(id: &str, extra: Value) -> Value {
        with(json!({ "id": id, "role": "assistant", "text": id }), extra)
    }

    fn snap(turns: Vec<Value>, extra: Value) -> Value {
        with(
            json!({ "tabId": "c1", "title": "T", "streaming": false, "contextPct": 0, "turns": turns }),
            extra,
        )
    }

    // ---- remoteControlModel ----

    #[test]
    fn constants() {
        assert_eq!(MAX_TURNS, 40);
        assert_eq!(MAX_SEGMENTS, 40);
        assert_eq!(MAX_USER_TEXT, 4000);
        assert_eq!(MAX_SNAPSHOT_CHARS, 120_000);
    }

    #[test]
    fn remote_title_cases() {
        assert_eq!(remote_title(&chat(json!({ "title": " Real " }))), "Real");
        let long = format!("hello\n  world   again {}", "x".repeat(50));
        let turns = json!([asst("a"), user("u", &format!("  {long}"))]);
        let expected: String = format!("hello world again {}", "x".repeat(50)).chars().take(36).collect();
        assert_eq!(
            remote_title(&chat(json!({ "title": "Novo chat", "turns": turns }))),
            expected
        );
        assert!(remote_title(&chat(json!({ "title": "", "turns": turns }))).starts_with("hello world again"));
        assert_eq!(remote_title(&chat(json!({ "title": "Novo chat" }))), "Novo chat");
        assert_eq!(remote_title(&chat(json!({ "title": "" }))), "Chat");
        let no_title = json!({ "id": "chat-1", "turns": [] });
        assert_eq!(remote_title(&no_title), "Chat");
    }

    #[test]
    fn tool_preview_priority_and_shaping() {
        let all = json!({
            "description": "d", "prompt": "p", "query": "q", "url": "u", "pattern": "pa",
            "command": "c", "path": "pt", "notebook_path": "nb", "file_path": "fp"
        });
        let order = [
            "file_path", "notebook_path", "path", "command", "pattern", "url", "query", "prompt",
            "description",
        ];
        let mut input = all.clone();
        for key in order {
            assert_eq!(tool_preview(Some(&input)), all[key].as_str().unwrap(), "{key}");
            input.as_object_mut().unwrap().remove(key);
        }
        assert_eq!(tool_preview(Some(&input)), "");
        assert_eq!(tool_preview(Some(&json!({ "command": "a  b\n\tc" }))), "a b c");
        let long = tool_preview(Some(&json!({ "command": "x".repeat(200) })));
        assert_eq!(long.chars().count(), 140);
        for v in [None, Some(json!(null)), Some(json!("str")), Some(json!(5))] {
            assert_eq!(tool_preview(v.as_ref()), "");
        }
    }

    #[test]
    fn permission_preview_cases() {
        let p = |input: Value| permission_preview(&json!({ "input": input }));
        assert_eq!(p(json!({ "command": "x".repeat(700) })).chars().count(), 600);
        assert_eq!(p(json!({ "command": "ls", "file_path": "/a" })), "ls");
        assert_eq!(p(json!({ "file_path": "/a", "new_string": "body" })), "/a\nbody");
        assert_eq!(
            p(json!({ "path": "/b", "new_string": "y".repeat(600) })),
            format!("/b\n{}", "y".repeat(500))
        );
        assert_eq!(p(json!({ "file_path": "/a" })), "/a");
        assert_eq!(p(json!({ "content": "c".repeat(700) })).chars().count(), 600);
        assert_eq!(p(json!({ "foo": "bar" })), "{\n \"foo\": \"bar\"\n}");
        assert_eq!(p(json!({ "big": "z".repeat(800) })).chars().count(), 500);
        assert_eq!(permission_preview(&json!({})), "{}");
    }

    #[test]
    fn remote_status_cases() {
        assert_eq!(remote_status(Some("running")), "run");
        assert_eq!(remote_status(None), "run");
        assert_eq!(remote_status(Some("error")), "err");
        for s in ["done", "denied", "awaiting"] {
            assert_eq!(remote_status(Some(s)), s);
        }
    }

    #[test]
    fn remote_turn_user_turn() {
        assert_eq!(
            remote_turn(&user("u", "hi"), None),
            json!({ "id": "u", "role": "user", "text": "hi" })
        );
        assert_eq!(
            remote_turn(&json!({ "id": "u", "role": "user" }), None),
            json!({ "id": "u", "role": "user", "text": "" })
        );
    }

    #[test]
    fn remote_turn_segments_mapped_truncated_and_capped() {
        let t = asst_with(
            "a",
            json!({
                "text": "final",
                "error": "bad",
                "segments": [
                    { "kind": "thinking", "text": "t".repeat(1000) },
                    { "kind": "text", "text": "x".repeat(7000) },
                    { "kind": "tool", "name": "Read", "status": "error", "input": { "file_path": "/a" } },
                    { "kind": "tool", "name": "Bash", "input": { "command": "ls" } },
                    { "kind": "text" }
                ]
            }),
        );
        let r = remote_turn(&t, None);
        assert_eq!(r["role"], "assistant");
        assert_eq!(r["text"], "");
        assert_eq!(r["error"], "bad");
        assert_eq!(r["segments"][0], json!({ "kind": "text", "text": "final" }));
        assert_eq!(len_of(&r["segments"][1]["text"]), 800);
        assert_eq!(len_of(&r["segments"][2]["text"]), 6000);
        assert_eq!(
            r["segments"][3],
            json!({ "kind": "tool", "name": "Read", "status": "err", "preview": "/a" })
        );
        assert_eq!(
            r["segments"][4],
            json!({ "kind": "tool", "name": "Bash", "status": "run", "preview": "ls" })
        );
        assert_eq!(r["segments"][5], json!({ "kind": "text", "text": "" }));
        assert!(r.get("pendingPerm").is_none());
        assert!(r.get("pendingQuestion").is_none());

        let capped = remote_turn(&asst_with("b", json!({ "segments": texts(55) })), None);
        let segs = capped["segments"].as_array().unwrap();
        assert_eq!(segs.len(), 40);
        assert_eq!(segs[0]["text"], "s15");
        assert_eq!(segs[39]["text"], "s54");
        assert_eq!(
            remote_turn(&json!({ "id": "c", "role": "assistant" }), None)["segments"],
            json!([])
        );
    }

    #[test]
    fn remote_snapshot_keeps_native_async_questions_without_a_blocking_dialog() {
        let turn = asst_with("async-turn", json!({ "segments": [{ "kind": "text", "toolId": "async-call", "text": "", "questions": [
            { "title": "Qual uso está sem cálculo?", "options": ["Tokens/contexto", "Limites da conta", "Os dois"] },
            { "title": "Detalhes", "options": null }, { "title": "", "options": ["invalid"] }
        ] }] }));
        let remote = remote_turn(&turn, None);
        assert_eq!(remote["segments"][0], json!({ "kind": "text", "text": "", "toolId": "async-call", "questions": [
            { "title": "Qual uso está sem cálculo?", "options": ["Tokens/contexto", "Limites da conta", "Os dois"] }, { "title": "Detalhes" }
        ] }));
        assert!(remote.get("pendingQuestion").is_none());
    }

    #[test]
    fn remote_segment_cap_keeps_only_the_latest_unanswered_native_question() {
        let question = json!({ "kind": "text", "toolId": "async-call", "questions": [{ "title": "Qual uso?", "options": ["Tokens", "Limites"] }] });
        let tools = || (0..50).map(|index| json!({ "kind": "tool", "toolId": index.to_string(), "name": "Bash", "input": { "command": "echo" } })).collect::<Vec<_>>();
        let mut unanswered = vec![question.clone()]; unanswered.extend(tools());
        let remote = remote_turn(&asst_with("turn", json!({ "segments": unanswered })), None);
        assert_eq!(remote["segments"].as_array().unwrap().len(), MAX_SEGMENTS);
        assert_eq!(remote["segments"][0]["toolId"], "async-call");
        let mut answered = vec![question, json!({ "kind": "user", "text": "Tokens" })]; answered.extend(tools());
        let remote = remote_turn(&asst_with("turn", json!({ "segments": answered })), None);
        assert!(remote["segments"].as_array().unwrap().iter().all(|segment| segment.get("questions").is_none()), "an answer beyond the cap must not revive an old question");
    }

    #[test]
    fn remote_turn_interrupted_appends_marker_after_the_cap() {
        let r = remote_turn(&asst_with("a", json!({ "segments": texts(50), "interrupted": true })), None);
        let segs = r["segments"].as_array().unwrap();
        assert_eq!(segs.len(), 41);
        assert_eq!(segs[40], json!({ "kind": "text", "text": "⏹ Tarefa interrompida." }));
    }

    #[test]
    fn remote_native_subagents_remain_visible_and_keep_their_own_status() {
        let agent = json!({ "id": "native", "chatId": "child-not-shared", "name": "Auditar API", "status": "running", "startedAt": 10, "updatedAt": 20, "spawnToolCallId": "spawn-native", "description": "d".repeat(2000), "activity": "a".repeat(2000), "summary": "s".repeat(7000), "token": "must-not-copy-unknown-fields" });
        let mut source = vec![json!({ "kind": "tool", "toolId": "spawn-native", "name": "spawn_agent", "status": "done" }), json!({ "kind": "tool", "toolId": "subagent:native", "name": "Agent", "status": "done", "subagent": agent })];
        source.extend((0..50).map(|index| json!({ "kind": "tool", "toolId": format!("tool-{index}"), "name": "Bash", "input": { "command": "echo" }, "status": "done" })));
        let remote = remote_turn(&asst_with("parent-turn", json!({ "segments": source })), None);
        let segments = remote["segments"].as_array().unwrap();
        assert_eq!(segments.len(), MAX_SEGMENTS);
        let cards: Vec<_> = segments.iter().filter_map(|segment| segment.get("subagent")).collect();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0]["status"], "running");
        assert_eq!(cards[0]["name"], "Auditar API");
        assert_eq!(len_of(&cards[0]["description"]), 1500);
        assert_eq!(len_of(&cards[0]["activity"]), 1500);
        assert_eq!(len_of(&cards[0]["summary"]), 6000);
        assert!(cards[0].get("token").is_none());
        assert!(segments.iter().all(|segment| segment["name"] != "spawn_agent"));
    }

    #[test]
    fn remote_turn_attaches_pending_permission_and_question_from_runtime() {
        let runtime = rt_with("a", true, Some(perm(json!({}))), Some(question(json!({}))));
        let r = remote_turn(&asst("a"), Some(&runtime));
        assert_eq!(
            r["pendingPerm"],
            json!({ "permId": "p1", "toolName": "Bash", "title": "Run it", "desc": "why", "preview": "ls" })
        );
        assert_eq!(
            r["pendingQuestion"],
            json!({
                "dialogId": "d1",
                "questions": [{
                    "question": "Q?", "header": "H", "multiSelect": true,
                    "options": [{ "label": "A", "description": "da" }]
                }]
            })
        );
        let fallback_rt = rt_with("", false, Some(perm(json!({ "title": "" }))), None);
        let fallback = remote_turn(&asst("a"), Some(&fallback_rt));
        assert_eq!(fallback["pendingPerm"]["title"], "Bash");
    }

    #[test]
    fn build_snapshot_basics() {
        let c = chat(json!({ "turns": [user("u", "hi"), asst("a")] }));
        let snap = build_snapshot(&c, Some(&rt("a", true)));
        assert_eq!(snap["tabId"], "chat-1");
        assert_eq!(snap["title"], "My chat");
        assert_eq!(snap["streaming"], true);
        assert_eq!(snap["contextPct"], 0);
        assert_eq!(snap["turns"].as_array().unwrap().len(), 2);
        let idle = build_snapshot(&chat(json!({})), None);
        assert_eq!(idle["streaming"], false);
        assert_eq!(idle["turns"], json!([]));
    }

    #[test]
    fn mobile_image_numbers_use_history_before_the_turn_limit() {
        let mut turns = vec![json!({"id":"old","role":"user","text":"old","images":[{"mime":"image/png","data":"old"}]})];
        turns.extend((0..40).map(|i| user(&format!("u{i}"), "text")));
        turns.push(json!({"id":"latest","role":"user","text":"latest","images":[{"mime":"image/png","data":"latest"}]}));
        let snap = build_snapshot(&chat(json!({"turns":turns})), None);
        assert_eq!(snap["turns"].as_array().unwrap().len(), 40);
        let last = snap["turns"].as_array().unwrap().last().unwrap();
        assert_eq!(last["images"][0]["number"], 2);
        assert!(last["images"][0].get("data").is_none());
    }

    #[test]
    fn build_snapshot_keeps_only_the_last_40_turns() {
        let turns: Vec<Value> = (0..50).map(|i| user(&format!("u{i}"), "t")).collect();
        let snap = build_snapshot(&chat(json!({ "turns": turns })), None);
        let out = snap["turns"].as_array().unwrap();
        assert_eq!(out.len(), 40);
        assert_eq!(out[0]["id"], "u10");
        assert_eq!(out[39]["id"], "u49");
    }

    #[test]
    fn build_snapshot_attaches_pending_only_to_the_running_turn_while_busy() {
        let c = chat(json!({ "turns": [asst("old"), asst("cur")] }));
        let runtime = rt_with("cur", true, Some(perm(json!({}))), Some(question(json!({}))));
        let snap = build_snapshot(&c, Some(&runtime));
        assert!(snap["turns"][0].get("pendingPerm").is_none());
        assert!(snap["turns"][0].get("pendingQuestion").is_none());
        assert_eq!(snap["turns"][1]["pendingPerm"]["permId"], "p1");
        assert_eq!(snap["turns"][1]["pendingQuestion"]["dialogId"], "d1");

        let idle_rt = ChatRuntime { busy: false, ..runtime.clone() };
        let idle = build_snapshot(&c, Some(&idle_rt));
        for t in idle["turns"].as_array().unwrap() {
            assert!(t.get("pendingPerm").is_none());
            assert!(t.get("pendingQuestion").is_none());
        }
        let other_rt = ChatRuntime { turn_id: "zzz".into(), ..runtime };
        let other = build_snapshot(&c, Some(&other_rt));
        for t in other["turns"].as_array().unwrap() {
            assert!(t.get("pendingPerm").is_none());
        }
    }

    // ---- runRemoteCommand (decide) ----

    #[test]
    fn command_no_chat() {
        let busy = busy_rt(None, None);
        assert_eq!(
            decide(None, Some(&busy), "send", &json!({ "text": "x" })),
            Err("no-chat")
        );
    }

    #[test]
    fn command_send_rejections_never_reach_the_store() {
        let cases: Vec<(Value, Option<&ChatRuntime>, Value, &str)> = vec![
            (chat(json!({})), None, json!({ "text": "" }), "empty"),
            (chat(json!({})), None, json!({ "text": "   \n" }), "empty"),
            (chat(json!({})), None, json!({}), "empty"),
            (chat(json!({})), None, json!({ "text": 5 }), "empty"),
            (chat(json!({ "readOnly": true })), None, json!({ "text": "x" }), "read-only"),
        ];
        for (c, runtime, payload, reason) in cases {
            assert_eq!(decide(Some(&c), runtime, "send", &payload), Err(reason), "{reason}");
        }
    }

    #[test]
    fn command_send_ok_with_trimmed_text() {
        let c = chat(json!({}));
        let expected = Ok(PhoneCommand::Send { text: "hello".into() });
        assert_eq!(decide(Some(&c), None, "send", &json!({ "text": "  hello  " })), expected);
        let idle = rt("", false);
        assert_eq!(
            decide(Some(&c), Some(&idle), "send", &json!({ "text": "  hello  " })),
            expected
        );
    }

    #[test]
    fn refusal_reason_maps_engine_codes() {
        assert_eq!(refusal_reason(ErrorCode::Busy), "busy");
        assert_eq!(refusal_reason(ErrorCode::Gone), "gone");
        assert_eq!(refusal_reason(ErrorCode::NotFound), "no-chat");
        assert_eq!(refusal_reason(ErrorCode::Invalid), "blocked");
        assert_eq!(refusal_reason(ErrorCode::Internal), "unknown");
        assert_eq!(refusal_reason(ErrorCode::Forbidden), "unknown");
    }

    #[test]
    fn command_stop() {
        let c = chat(json!({}));
        assert_eq!(decide(Some(&c), None, "stop", &json!({})), Err("idle"));
        let idle = rt("t", false);
        assert_eq!(decide(Some(&c), Some(&idle), "stop", &json!({})), Err("idle"));
        let busy = busy_rt(None, None);
        assert_eq!(decide(Some(&c), Some(&busy), "stop", &json!({})), Ok(PhoneCommand::Stop));
    }

    #[test]
    fn command_perm_invalid_and_gone_cases_never_respond() {
        let c = chat(json!({}));
        let with_perm = busy_rt(Some(perm(json!({}))), None);
        let not_busy = ChatRuntime { busy: false, ..with_perm.clone() };
        let no_perm = busy_rt(None, None);
        let cases: Vec<(Option<&ChatRuntime>, Value, &str)> = vec![
            (Some(&with_perm), json!({ "decision": "maybe", "permId": "p1" }), "invalid"),
            (Some(&with_perm), json!({ "permId": "p1" }), "invalid"),
            (Some(&no_perm), json!({ "decision": "allow", "permId": "p1" }), "gone"),
            (None, json!({ "decision": "allow", "permId": "p1" }), "gone"),
            (Some(&with_perm), json!({ "decision": "allow", "permId": "other" }), "gone"),
            (Some(&not_busy), json!({ "decision": "allow", "permId": "p1" }), "gone"),
            (
                Some(&with_perm),
                json!({ "decision": "allow", "permId": "p1", "turnId": "stale" }),
                "gone",
            ),
        ];
        for (runtime, payload, reason) in cases {
            assert_eq!(decide(Some(&c), runtime, "perm", &payload), Err(reason), "{reason}");
        }
    }

    #[test]
    fn command_perm_valid_decisions() {
        let c = chat(json!({}));
        let runtime = busy_rt(Some(perm(json!({}))), None);
        for (decision, expected) in [
            ("allow", PermissionDecision::Allow),
            ("allow_always", PermissionDecision::AllowAlways),
            ("deny", PermissionDecision::Deny),
        ] {
            assert_eq!(
                decide(Some(&c), Some(&runtime), "perm", &json!({ "decision": decision, "permId": "p1" })),
                Ok(PhoneCommand::Permission { perm_id: "p1".into(), decision: expected })
            );
        }
        assert_eq!(
            decide(
                Some(&c),
                Some(&runtime),
                "perm",
                &json!({ "decision": "allow", "permId": "p1", "turnId": "t1" })
            ),
            Ok(PhoneCommand::Permission {
                perm_id: "p1".into(),
                decision: PermissionDecision::Allow
            })
        );
    }

    #[test]
    fn command_question_gone_cases_never_respond() {
        let c = chat(json!({}));
        let with_q = busy_rt(None, Some(question(json!({}))));
        let not_busy = ChatRuntime { busy: false, ..with_q.clone() };
        let no_q = busy_rt(None, None);
        let answers = json!({ "Q?": "A" });
        let cases: Vec<(&ChatRuntime, Value)> = vec![
            (&no_q, json!({ "dialogId": "d1", "answers": answers })),
            (&with_q, json!({ "dialogId": "nope", "answers": answers })),
            (&not_busy, json!({ "dialogId": "d1", "answers": answers })),
            (&with_q, json!({ "dialogId": "d1", "answers": answers, "turnId": "stale" })),
            (&with_q, json!({ "dialogId": "d1", "cancelled": true, "turnId": "stale" })),
        ];
        for (runtime, payload) in cases {
            assert_eq!(decide(Some(&c), Some(runtime), "question", &payload), Err("gone"));
        }
    }

    #[test]
    fn command_question_cancelled_answers_response() {
        let c = chat(json!({}));
        let runtime = busy_rt(None, Some(question(json!({}))));
        assert_eq!(
            decide(Some(&c), Some(&runtime), "question", &json!({ "dialogId": "d1", "cancelled": true })),
            Ok(PhoneCommand::Question { dialog_id: "d1".into(), answers: None, response: None })
        );

        let empties = [
            json!({}),
            json!({ "answers": {} }),
            json!({ "answers": { "a": "   ", "b": 5 } }),
            json!({ "answers": ["x"] }),
            json!({ "answers": "x" }),
            json!({ "answers": null }),
        ];
        for extra in empties {
            let payload = with(json!({ "dialogId": "d1" }), extra);
            assert_eq!(decide(Some(&c), Some(&runtime), "question", &payload), Err("empty"));
        }

        let good = json!({
            "dialogId": "d1", "answers": { "Q?": "A", "skip": "", "num": 3 },
            "response": "free text", "turnId": "t1"
        });
        assert_eq!(
            decide(Some(&c), Some(&runtime), "question", &good),
            Ok(PhoneCommand::Question {
                dialog_id: "d1".into(),
                answers: Some(BTreeMap::from([("Q?".to_string(), "A".to_string())])),
                response: Some("free text".into()),
            })
        );

        let no_response = |extra: Value| {
            with(json!({ "dialogId": "d1", "answers": { "Q?": "A" } }), extra)
        };
        for extra in [json!({}), json!({ "response": "   " }), json!({ "response": 7 })] {
            assert_eq!(
                decide(Some(&c), Some(&runtime), "question", &no_response(extra)),
                Ok(PhoneCommand::Question {
                    dialog_id: "d1".into(),
                    answers: Some(BTreeMap::from([("Q?".to_string(), "A".to_string())])),
                    response: None,
                })
            );
        }
    }

    #[test]
    fn command_unknown_action() {
        let c = chat(json!({}));
        let busy = busy_rt(None, None);
        assert_eq!(decide(Some(&c), Some(&busy), "explode", &json!({})), Err("unknown"));
    }

    #[test]
    fn remote_turn_user_text_is_cut_at_max_user_text_with_an_ellipsis() {
        assert_eq!(remote_turn(&user("u", &"x".repeat(4000)), None)["text"], "x".repeat(4000));
        assert_eq!(
            remote_turn(&user("u", &"x".repeat(4001)), None)["text"],
            format!("{}…", "x".repeat(4000))
        );
    }

    #[test]
    fn remote_turn_assistant_text_is_not_duplicated_when_segments_exist() {
        let no_text = remote_turn(
            &asst_with("a", json!({ "text": "   ", "segments": [{ "kind": "text", "text": "s" }] })),
            None,
        );
        assert_eq!(no_text["text"], "");
        assert_eq!(no_text["segments"], json!([{ "kind": "text", "text": "s" }]));
        let with_text = remote_turn(
            &asst_with(
                "a",
                json!({ "text": "lead", "segments": [{ "kind": "tool", "name": "Read", "input": {} }] }),
            ),
            None,
        );
        assert_eq!(with_text["text"], "");
        let kinds: Vec<&str> = with_text["segments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["text", "tool"]);
        assert_eq!(with_text["segments"][0]["text"], "lead");
    }

    #[test]
    fn remote_turn_assistant_text_without_segments_is_cut_at_6000_plus_ellipsis() {
        let text = |t: &str| remote_turn(&asst_with("a", json!({ "text": t })), None)["text"].clone();
        assert_eq!(text("hi"), "hi");
        assert_eq!(text(&"y".repeat(6000)), "y".repeat(6000));
        assert_eq!(text(&"y".repeat(6001)), format!("{}…", "y".repeat(6000)));
    }

    #[test]
    fn remote_turn_leading_text_segment_is_subject_to_the_segment_cap() {
        let r = remote_turn(&asst_with("a", json!({ "text": "lead", "segments": texts(40) })), None);
        assert_eq!(r["segments"].as_array().unwrap().len(), 40);
        assert_eq!(r["segments"][0]["text"], "s0");
        let few = remote_turn(&asst_with("a", json!({ "text": "lead", "segments": texts(39) })), None);
        assert_eq!(few["segments"].as_array().unwrap().len(), 40);
        assert_eq!(few["segments"][0]["text"], "lead");
    }

    #[test]
    fn remote_turn_interrupted_turn_without_anything_else_has_marker_and_empty_text() {
        let r = remote_turn(&asst_with("a", json!({ "text": "partial", "interrupted": true })), None);
        assert_eq!(r["text"], "");
        assert_eq!(r["segments"], json!([{ "kind": "text", "text": "⏹ Tarefa interrompida." }]));
    }

    #[test]
    fn tool_preview_skips_empty_values_and_falls_through() {
        assert_eq!(tool_preview(Some(&json!({ "file_path": "", "command": "ls" }))), "ls");
        assert_eq!(tool_preview(Some(&json!({ "file_path": "   ", "pattern": "p" }))), "p");
    }

    #[test]
    fn build_snapshot_size_budget_keeps_newest_turns_in_chronological_order() {
        let turns: Vec<Value> = (0..40).map(|i| user(&format!("u{i}"), &"z".repeat(3900))).collect();
        let snap = build_snapshot(&chat(json!({ "turns": turns })), None);
        let out = snap["turns"].as_array().unwrap();
        assert!(out.len() < 40 && out.len() > 1);
        assert_eq!(out[out.len() - 1]["id"], "u39");
        let ids: Vec<&Value> = out.iter().map(|t| &t["id"]).collect();
        let expected: Vec<&Value> = turns[40 - out.len()..].iter().map(|t| &t["id"]).collect();
        assert_eq!(ids, expected);
        let total: usize = out.iter().map(json_len).sum();
        assert!(total <= MAX_SNAPSHOT_CHARS);
        // one more turn would have blown the budget
        let next = json_len(&remote_turn(&turns[39 - out.len()], None));
        assert!(total + next > MAX_SNAPSHOT_CHARS);
    }

    #[test]
    fn build_snapshot_newest_turn_always_fits_even_when_oversized() {
        let segments: Vec<Value> = (0..40)
            .map(|_| json!({ "kind": "text", "text": "q".repeat(6000) }))
            .collect();
        let huge = asst_with("new", json!({ "segments": segments }));
        let snap = build_snapshot(
            &chat(json!({ "turns": [user("u0", "old"), user("u1", "old2"), huge] })),
            None,
        );
        let ids: Vec<&Value> = snap["turns"].as_array().unwrap().iter().map(|t| &t["id"]).collect();
        assert_eq!(ids, [&json!("new")]);
    }

    // ---- remoteControlState: ChatGrants ----

    #[test]
    fn grant_same_token_while_shared_different_per_chat() {
        let mut g = ChatGrants::default();
        let mut mint = counter("t");
        let a = g.grant("a", &mut mint);
        assert_eq!(g.grant("a", &mut mint), a);
        let b = g.grant("b", &mut mint);
        assert_ne!(a, b);
        assert_eq!(g.len(), 2);
        assert!(g.has("a"));
        assert!(!g.has("zzz"));
    }

    #[test]
    fn grant_colliding_mint_retries_until_unique() {
        let mut g = ChatGrants::default();
        let seq = ["dup", "dup", "dup", "fresh"];
        let mut i = 0;
        let mut mint = move || {
            let v = seq[i.min(seq.len() - 1)];
            i += 1;
            v.to_string()
        };
        assert_eq!(g.grant("a", &mut mint), "dup");
        assert_eq!(g.grant("b", &mut mint), "fresh");
        assert_eq!(g.chat_for(Some("dup")), Some("a"));
        assert_eq!(g.chat_for(Some("fresh")), Some("b"));
    }

    #[test]
    fn chat_for_resolves_tokens_and_rejects_the_rest() {
        let mut g = ChatGrants::default();
        let t = g.grant("a", counter("t"));
        assert_eq!(g.chat_for(Some(&t)), Some("a"));
        assert_eq!(g.chat_for(None), None);
        assert_eq!(g.chat_for(Some("")), None);
        assert_eq!(g.chat_for(Some("unknown")), None);
    }

    #[test]
    fn revoke_returns_the_token_and_invalidates_it() {
        let mut g = ChatGrants::default();
        let mut mint = counter("t");
        let t = g.grant("a", &mut mint);
        g.grant("b", &mut mint);
        assert_eq!(g.revoke("a"), Some(t.clone()));
        assert_eq!(g.chat_for(Some(&t)), None);
        assert!(!g.has("a"));
        assert_eq!(g.len(), 1);
        assert!(g.has("b"));
        assert_eq!(g.revoke("a"), None);
        assert_eq!(g.revoke("never"), None);
    }

    #[test]
    fn re_grant_after_revoke_mints_a_new_token() {
        let mut g = ChatGrants::default();
        let mut mint = counter("t");
        let first = g.grant("a", &mut mint);
        g.revoke("a");
        let second = g.grant("a", &mut mint);
        assert_ne!(first, second);
        assert_eq!(g.chat_for(Some(&first)), None);
        assert_eq!(g.chat_for(Some(&second)), Some("a"));
    }

    #[test]
    fn clear_drops_everything() {
        let mut g = ChatGrants::default();
        let t = g.grant("a", counter("t"));
        g.grant("b", counter("x"));
        g.clear();
        assert_eq!(g.len(), 0);
        assert!(g.is_empty());
        assert!(!g.has("a"));
        assert_eq!(g.chat_for(Some(&t)), None);
    }

    // ---- remoteControlState: snapshotDelta ----

    #[test]
    fn snapshot_delta_without_a_previous_snapshot_sends_everything() {
        let next = snap(vec![turn("1", json!({})), turn("2", json!({}))], json!({}));
        let d = snapshot_delta(None, None, &next);
        assert!(d.changed);
        assert!(d.meta_changed);
        assert_eq!(d.ids, ["1", "2"]);
        assert_eq!(Value::Array(d.turns.clone()), next["turns"]);
        assert_eq!(sorted_keys(&d.cache), ["1", "2"]);
    }

    #[test]
    fn snapshot_delta_nothing_changed() {
        let a = snap(vec![turn("1", json!({})), turn("2", json!({}))], json!({}));
        let first = snapshot_delta(None, None, &a);
        let b = snap(vec![turn("1", json!({})), turn("2", json!({}))], json!({}));
        let d = snapshot_delta(Some(&a), Some(&first.cache), &b);
        assert!(!d.changed);
        assert!(!d.meta_changed);
        assert!(d.turns.is_empty());
        assert_eq!(d.ids, ["1", "2"]);
    }

    #[test]
    fn snapshot_delta_only_the_last_turn_changed() {
        let a = snap(vec![turn("1", json!({})), turn("2", json!({}))], json!({}));
        let first = snapshot_delta(None, None, &a);
        let b = snap(vec![turn("1", json!({})), turn("2", json!({ "text": "more" }))], json!({}));
        let d = snapshot_delta(Some(&a), Some(&first.cache), &b);
        assert!(d.changed);
        assert!(!d.meta_changed);
        assert_eq!(d.turns, vec![b["turns"][1].clone()]);
        assert_eq!(d.ids, ["1", "2"]);
    }

    #[test]
    fn snapshot_delta_appended_turn_is_sent_along_with_changed_ones() {
        let a = snap(vec![turn("1", json!({}))], json!({}));
        let first = snapshot_delta(None, None, &a);
        let b = snap(vec![turn("1", json!({})), turn("2", json!({}))], json!({}));
        let d = snapshot_delta(Some(&a), Some(&first.cache), &b);
        assert!(d.changed);
        let ids: Vec<&Value> = d.turns.iter().map(|t| &t["id"]).collect();
        assert_eq!(ids, [&json!("2")]);
        assert_eq!(d.ids, ["1", "2"]);
    }

    #[test]
    fn snapshot_delta_removal_or_reorder_is_a_change_even_with_no_changed_turn() {
        let a = snap(vec![turn("1", json!({})), turn("2", json!({})), turn("3", json!({}))], json!({}));
        let first = snapshot_delta(None, None, &a);
        let removed = snapshot_delta(
            Some(&a),
            Some(&first.cache),
            &snap(vec![turn("1", json!({})), turn("3", json!({}))], json!({})),
        );
        assert!(removed.changed);
        assert!(!removed.meta_changed);
        assert!(removed.turns.is_empty());
        assert_eq!(removed.ids, ["1", "3"]);
        let reordered = snapshot_delta(
            Some(&a),
            Some(&first.cache),
            &snap(vec![turn("2", json!({})), turn("1", json!({})), turn("3", json!({}))], json!({})),
        );
        assert!(reordered.changed);
        assert!(reordered.turns.is_empty());
        assert_eq!(reordered.ids, ["2", "1", "3"]);
    }

    #[test]
    fn snapshot_delta_title_streaming_context_pct_are_meta_changes() {
        let a = snap(vec![turn("1", json!({}))], json!({}));
        let first = snapshot_delta(None, None, &a);
        for extra in [json!({ "title": "New" }), json!({ "streaming": true }), json!({ "contextPct": 5 })] {
            let d = snapshot_delta(Some(&a), Some(&first.cache), &snap(vec![turn("1", json!({}))], extra.clone()));
            assert!(d.meta_changed, "{extra}");
            assert!(d.changed);
            assert!(d.turns.is_empty());
        }
    }

    #[test]
    fn snapshot_delta_pending_permission_on_a_turn_counts_as_that_turn_changing() {
        let a = snap(vec![turn("1", json!({}))], json!({}));
        let first = snapshot_delta(None, None, &a);
        let b = snap(vec![turn("1", json!({ "pendingPerm": { "permId": "p" } }))], json!({}));
        let d = snapshot_delta(Some(&a), Some(&first.cache), &b);
        assert!(d.changed);
        assert_eq!(Value::Array(d.turns.clone()), b["turns"]);
    }

    #[test]
    fn snapshot_delta_returned_cache_feeds_the_next_diff() {
        let s1 = snap(vec![turn("1", json!({}))], json!({}));
        let d1 = snapshot_delta(None, None, &s1);
        let s2 = snap(vec![turn("1", json!({ "text": "x" }))], json!({}));
        let d2 = snapshot_delta(Some(&s1), Some(&d1.cache), &s2);
        assert_eq!(d2.turns.len(), 1);
        let s3 = snap(vec![turn("1", json!({ "text": "x" }))], json!({}));
        let d3 = snapshot_delta(Some(&s2), Some(&d2.cache), &s3);
        assert!(!d3.changed);
        // a stale cache would still report the turn as changed
        let stale = snapshot_delta(Some(&s2), Some(&d1.cache), &s3);
        assert_eq!(stale.turns.len(), 1);
    }

    #[test]
    fn snapshot_delta_prev_given_but_no_cache_sends_all_turns() {
        let a = snap(vec![turn("1", json!({})), turn("2", json!({}))], json!({}));
        let d = snapshot_delta(Some(&a), None, &snap(vec![turn("1", json!({})), turn("2", json!({}))], json!({})));
        assert!(d.changed);
        assert_eq!(d.turns.len(), 2);
        assert!(!d.meta_changed);
    }

    // ---- remoteControlState: listEntry / sameEntry ----

    #[test]
    fn list_entry_cases() {
        assert_eq!(
            list_entry(&snap(vec![turn("1", json!({}))], json!({ "title": "X", "streaming": true }))),
            json!({ "tabId": "c1", "title": "X", "streaming": true, "pending": false })
        );
        let perm_turn = snap(
            vec![turn("1", json!({})), turn("2", json!({ "pendingPerm": { "permId": "p" } }))],
            json!({}),
        );
        assert_eq!(list_entry(&perm_turn)["pending"], true);
        let question_turn = snap(vec![turn("1", json!({ "pendingQuestion": { "dialogId": "d" } }))], json!({}));
        assert_eq!(list_entry(&question_turn)["pending"], true);
        assert_eq!(list_entry(&snap(vec![], json!({})))["pending"], false);
    }

    #[test]
    fn same_entry_cases() {
        let e = json!({ "tabId": "c1", "title": "T", "streaming": false, "pending": false });
        assert!(!same_entry(None, &e));
        assert!(same_entry(Some(&e.clone()), &e));
        assert!(!same_entry(Some(&with(e.clone(), json!({ "title": "U" }))), &e));
        assert!(!same_entry(Some(&with(e.clone(), json!({ "streaming": true }))), &e));
        assert!(!same_entry(Some(&with(e.clone(), json!({ "pending": true }))), &e));
    }

    // ---- extras ----

    #[test]
    fn chat_grants_chats_keep_sharing_order_after_revoking_the_middle() {
        let mut g = ChatGrants::default();
        assert!(g.is_empty());
        let mut mint = counter("t");
        let a = g.grant("a", &mut mint);
        g.grant("b", &mut mint);
        let c = g.grant("c", &mut mint);
        assert_eq!(g.chats(), ["a", "b", "c"]);
        g.revoke("b");
        assert_eq!(g.chats(), ["a", "c"]);
        assert_eq!(g.token_of("a"), Some(a.as_str()));
        assert_eq!(g.token_of("c"), Some(c.as_str()));
        assert_eq!(g.token_of("b"), None);
        assert!(!g.is_empty());
    }

    #[test]
    fn chat_grants_debug_does_not_print_the_token() {
        let mut g = ChatGrants::default();
        g.grant("chat-a", || "super-secret-token".to_string());
        let printed = format!("{g:?}");
        assert!(!printed.contains("super-secret-token"));
        assert!(printed.contains("chat-a"));
    }

    #[test]
    fn mint_token_is_48_lowercase_hex_and_unique() {
        let a = mint_token();
        let b = mint_token();
        assert_eq!(a.len(), 48);
        assert!(a.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
        assert_ne!(a, b);
    }

    #[test]
    fn json_output_matches_the_ts_shape() {
        assert_eq!(
            serde_json::to_string(&remote_turn(&user("u", "hi"), None)).unwrap(),
            r#"{"id":"u","role":"user","text":"hi"}"#
        );
        let s = serde_json::to_string(&build_snapshot(&chat(json!({})), None)).unwrap();
        assert!(s.contains(r#""contextPct":0,"#), "{s}");
        assert!(!s.contains("0.0"));
    }

    #[test]
    fn remote_title_trims_unicode_spaces() {
        assert_eq!(
            remote_title(&chat(json!({ "title": "\u{3000}Real\u{3000}" }))),
            "Real"
        );
    }

    #[test]
    fn command_perm_with_the_runtime_turn_id_is_ok() {
        let c = chat(json!({}));
        let runtime = busy_rt(Some(perm(json!({}))), None);
        assert_eq!(
            decide(
                Some(&c),
                Some(&runtime),
                "perm",
                &json!({ "decision": "deny", "permId": "p1", "turnId": "t1" })
            ),
            Ok(PhoneCommand::Permission { perm_id: "p1".into(), decision: PermissionDecision::Deny })
        );
    }
}
