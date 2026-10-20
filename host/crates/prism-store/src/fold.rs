//! The journal fold: a port of `foldJournal` (src/shared/agentJournal.ts).
//!
//! It works on JSON values, not typed structs, so every field the UI keeps on
//! a chat or a turn survives untouched, and it follows the TypeScript's
//! JavaScript semantics (truthiness, `===`, string concatenation, `undefined`
//! dropping out of JSON) closely enough that both folds give the same chat on
//! the fixtures in `host/fixtures/journal`. Where the TypeScript would throw on
//! a malformed record (a `segment` event without a segment, a chat without a
//! selection), the Rust fold skips the record instead.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use serde_json::{Map, Number, Value};

/// Applies `records` (`(turnId, event)` in `seq` order) to `chat`.
pub fn fold_journal<'a, I>(chat: &Value, records: I) -> Value
where
    I: IntoIterator<Item = (&'a str, &'a Value)>,
{
    let mut fold = JournalFold::new(chat);
    for (turn_id, ev) in records {
        fold.apply(turn_id, ev);
    }
    fold.finish()
}

/// Incremental fold: database readers release each serialized event before
/// reading the next. Tool snapshots can be many times larger than the final
/// conversation, so retaining the whole journal defeats streaming.
pub(crate) struct JournalFold<'a> {
    chat: Cow<'a, Value>,
    resume: Option<Value>,
    pending: Option<Value>,
    route_key: String,
    turns: HashMap<String, Map<String, Value>>,
    routes: HashMap<String, Option<Value>>,
    compacted_routes: HashMap<String, Option<Value>>,
}

impl<'a> JournalFold<'a> {
    pub(crate) fn new(chat: &'a Value) -> Self {
        Self::from_chat(Cow::Borrowed(chat))
    }

    pub(crate) fn owned(chat: Value) -> Self {
        Self::from_chat(Cow::Owned(chat))
    }

    fn from_chat(chat: Cow<'a, Value>) -> Self {
        Self {
            resume: chat.get("resume").cloned(), pending: chat.get("pendingTurnId").cloned(),
            route_key: route_key(chat.get("selection")), turns: HashMap::new(), routes: HashMap::new(), compacted_routes: HashMap::new(),
            chat,
        }
    }

    /// Only turns with a persisted compacted `begin` may accept late native
    /// updates without another begin. Ordinary/malformed journals keep their
    /// original semantics of ignoring events for unbegun turns.
    pub(crate) fn with_compacted_turns(mut self, turns: Vec<(String, Option<String>)>) -> Self {
        self.compacted_routes = turns.into_iter().map(|(id, route)| (id, route.map(Value::String))).collect();
        self
    }

    pub(crate) fn apply(&mut self, turn_id: &str, ev: &Value) {
        let Some(input) = self.chat.as_object() else { return };
        let kind = ev.get("kind").and_then(Value::as_str);
        if kind == Some("begin") {
            let mut turn = ev.get("turn").and_then(Value::as_object).cloned().unwrap_or_default();
            turn.insert("segments".into(), Value::Array(Vec::new()));
            self.turns.insert(turn_id.into(), turn);
            self.routes.insert(turn_id.into(), ev.get("route").cloned());
            return;
        }
        if !self.turns.contains_key(turn_id)
            && let Some(route) = self.compacted_routes.get(turn_id)
            && let Some(turn) = input.get("turns").and_then(Value::as_array)
                .and_then(|turns| turns.iter().find(|turn| turn["id"] == turn_id && turn["role"] == "assistant"))
                .and_then(Value::as_object)
        {
            self.turns.insert(turn_id.into(), turn.clone());
            self.routes.insert(turn_id.into(), route.clone());
        }
        let Some(turn) = self.turns.get_mut(turn_id) else {
            return;
        };
        let route = self.routes.get(turn_id).and_then(Option::as_ref);
        let current = input.get("lastRunId").and_then(Value::as_str) == Some(turn_id) && route.and_then(Value::as_str) == Some(self.route_key.as_str());
        match kind {
            Some(kind @ ("text" | "thinking")) => {
                let text = ev.get("text");
                let segments = segments_mut(turn);
                match segments.last_mut().and_then(Value::as_object_mut) {
                    Some(last) if last.get("kind").and_then(Value::as_str) == Some(kind) => {
                        if !last.get("text").is_some_and(Value::is_string) {
                            let joined = if truthy(last.get("text")) { to_js_string(last.get("text")) } else { String::new() };
                            last.insert("text".into(), Value::String(joined));
                        }
                        if let Some(Value::String(joined)) = last.get_mut("text") {
                            match text { Some(Value::String(more)) => joined.push_str(more), _ => joined.push_str(&to_js_string(text)) }
                        }
                    }
                    _ => {
                        let mut segment = Map::new();
                        segment.insert("kind".into(), Value::String(kind.into()));
                        if let Some(text) = text {
                            segment.insert("text".into(), text.clone());
                        }
                        segments.push(Value::Object(segment));
                    }
                }
            }
            Some("metrics") => {
                let mut merged = turn.get("metrics").and_then(Value::as_object).cloned().unwrap_or_default();
                if let Some(update) = ev.get("metrics").and_then(Value::as_object) {
                    for (key, value) in update {
                        merged.insert(key.clone(), value.clone());
                    }
                }
                turn.insert("metrics".into(), Value::Object(merged));
            }
            Some("segment") => {
                let Some(segment) = ev.get("segment").and_then(Value::as_object) else {
                    return;
                };
                let tool_id = segment.get("toolId");
                let segments = segments_mut(turn);
                let index = if truthy(tool_id) {
                    segments.iter().position(|s| strict_eq(s.get("toolId"), tool_id))
                } else {
                    None
                };
                match index {
                    Some(i) => segments[i] = Value::Object(segment.clone()),
                    None => segments.push(Value::Object(segment.clone())),
                }
            }
            Some("session") if current => {
                let mut next = Map::new();
                if let Some(route) = route {
                    next.insert("route".into(), route.clone());
                }
                if let Some(session) = ev.get("sessionId") {
                    next.insert("sessionId".into(), session.clone());
                }
                self.resume = Some(Value::Object(next));
            }
            Some(kind @ ("done" | "error")) => {
                let error = kind == "error";
                let at = ev.get("at");
                if truthy(at) {
                    turn.insert("completedAt".into(), at.cloned().unwrap_or(Value::Null));
                }
                if truthy(turn.get("startedAt")) && truthy(turn.get("completedAt")) {
                    let duration = to_js_number(turn.get("completedAt")) - to_js_number(turn.get("startedAt"));
                    turn.insert("durationMs".into(), js_number(js_max0(duration)));
                }
                let interrupted = !error && truthy(ev.get("aborted"));
                turn.insert("error".into(), Value::Bool(error));
                turn.insert("interrupted".into(), Value::Bool(interrupted));
                // Why it failed, when the provider said (T08: `cli_auth`, the login is gone).
                if error && let Some(code) = ev.get("code").filter(|c| truthy(Some(c))) {
                    turn.insert("errorCode".into(), code.clone());
                }
                let segments = segments_mut(turn);
                if error {
                    let mut segment = Map::new();
                    segment.insert("kind".into(), Value::String("text".into()));
                    if let Some(message) = ev.get("message") {
                        segment.insert("text".into(), message.clone());
                    }
                    segments.push(Value::Object(segment));
                }
                let settled = if error || interrupted { "error" } else { "done" };
                for segment in segments.iter_mut() {
                    if let Some(s) = segment.as_object_mut()
                        && !s.contains_key("subagent")
                        && matches!(s.get("status").and_then(Value::as_str), Some("running" | "awaiting"))
                    {
                        s.insert("status".into(), Value::String(settled.into()));
                    }
                }
                if input.get("pendingTurnId").and_then(Value::as_str) == Some(turn_id) {
                    self.pending = None;
                }
                if current && (error || interrupted) {
                    self.resume = None;
                }
            }
            _ => {}
        }
    }

    pub(crate) fn finish(mut self) -> Value {
        let mut out = match self.chat.into_owned() { Value::Object(out) => out, value => return value };
        set_or_remove(&mut out, "resume", self.resume);
        set_or_remove(&mut out, "pendingTurnId", self.pending);
        if let Some(Value::Array(list)) = out.get_mut("turns") {
            // Malformed legacy documents may repeat a turn id. Preserve the fold's
            // historical behavior for those while moving normal turns without a copy.
            let mut remaining = HashMap::<String, usize>::new();
            for turn in list.iter() {
                if let Some(id) = turn.get("id").and_then(Value::as_str) { *remaining.entry(id.into()).or_default() += 1; }
            }
            for turn in list.iter_mut() {
                let Some(id) = turn.get("id").and_then(Value::as_str) else { continue };
                let count = remaining.get_mut(id).expect("the turn id was counted");
                *count -= 1;
                let folded = if *count == 0 { self.turns.remove(id) } else { self.turns.get(id).cloned() };
                if let Some(folded) = folded {
                    *turn = Value::Object(folded);
                }
            }
        }
        Value::Object(out)
    }
}

/// The longest prefix of a chat's journal (by index into `records`, in `seq`
/// order) that can be folded into the chat document and dropped without
/// changing the folded chat: every turn it touches is finished (a `done` or
/// `error` after its last `begin`) and has no events after it. `None` when
/// nothing can be compacted.
pub fn compaction_cut<'a, I>(records: I) -> Option<usize>
where
    I: IntoIterator<Item = (&'a str, &'a Value)>,
{
    compaction_cut_kinds(records.into_iter().map(|(turn, ev)| (turn, ev.get("kind").and_then(Value::as_str).unwrap_or(""))))
}

pub(crate) fn compaction_cut_kinds<'a, I>(records: I) -> Option<usize>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let records: Vec<(&str, &str)> = records.into_iter().collect();
    let mut last: HashMap<&str, usize> = HashMap::new();
    let mut last_begin: HashMap<&str, usize> = HashMap::new();
    let mut last_end: HashMap<&str, usize> = HashMap::new();
    for (i, (turn, kind)) in records.iter().enumerate() {
        last.insert(turn, i);
        match *kind {
            "begin" => {
                last_begin.insert(turn, i);
            }
            "done" | "error" => {
                last_end.insert(turn, i);
            }
            _ => {}
        }
    }
    let finished: HashSet<&str> = last
        .keys()
        .copied()
        .filter(|turn| match (last_begin.get(turn), last_end.get(turn)) {
            (Some(begin), Some(end)) => end > begin,
            // Never begun: the fold ignores these events anyway.
            (None, _) => true,
            (Some(_), None) => false,
        })
        .collect();
    let mut cut = None;
    let mut reach = 0;
    for (i, (turn, _)) in records.iter().enumerate() {
        if !finished.contains(turn) {
            break;
        }
        reach = reach.max(last[turn]);
        if reach == i {
            cut = Some(i);
        }
    }
    cut
}

/// `${selection.provider}:${selection.profileId}` (`routeKey` in agents.ts).
pub fn route_key(selection: Option<&Value>) -> String {
    let field = |name: &str| selection.and_then(|s| s.get(name));
    format!("{}:{}", to_js_string(field("provider")), to_js_string(field("profileId")))
}

fn segments_mut(turn: &mut Map<String, Value>) -> &mut Vec<Value> {
    let slot = turn.entry("segments").or_insert_with(|| Value::Array(Vec::new()));
    if !slot.is_array() {
        *slot = Value::Array(Vec::new());
    }
    match slot {
        Value::Array(list) => list,
        _ => unreachable!("segments was just made an array"),
    }
}

fn set_or_remove(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            map.insert(key.into(), value);
        }
        None => {
            map.remove(key);
        }
    }
}

/// JavaScript truthiness; `None` is `undefined`.
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `a === b` for JSON values: objects and arrays are never identical.
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        _ => false,
    }
}

/// `String(value)` as a template literal or `+` would produce it.
fn to_js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => number_to_js_string(n),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => to_js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

fn number_to_js_string(n: &Number) -> String {
    if n.is_i64() || n.is_u64() {
        return n.to_string();
    }
    let f = n.as_f64().unwrap_or(f64::NAN);
    if f == 0.0 {
        return "0".into();
    }
    if (1e-6..1e21).contains(&f.abs()) {
        return format!("{f}");
    }
    // JS writes large and tiny numbers as 1e+21 / 1e-7.
    let text = format!("{f:e}");
    match text.split_once('e') {
        Some((mantissa, exp)) if !exp.starts_with('-') => format!("{mantissa}e+{exp}"),
        _ => text,
    }
}

fn to_js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() { 0.0 } else { s.parse().unwrap_or(f64::NAN) }
        }
        Some(Value::Array(_) | Value::Object(_)) => f64::NAN,
    }
}

/// `Math.max(0, x)`, NaN included.
fn js_max0(x: f64) -> f64 {
    if x.is_nan() { x } else { x.max(0.0) }
}

/// A JS number as `JSON.stringify` writes it: integral values without a
/// fraction, NaN and infinities as `null`.
pub(crate) fn js_number(x: f64) -> Value {
    if !x.is_finite() {
        return Value::Null;
    }
    if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        return Value::Number(Number::from(x as i64));
    }
    Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fold(chat: &Value, records: &[(&str, Value)]) -> Value {
        fold_journal(chat, records.iter().map(|(t, e)| (*t, e)))
    }

    fn chat() -> Value {
        json!({
            "id": "c", "cwd": "C:\\QA", "updatedAt": 1, "pendingTurnId": "t", "lastRunId": "t",
            "selection": { "provider": "claude", "profileId": "p" },
            "turns": [{ "id": "u", "role": "user", "text": "oi" }, { "id": "t", "role": "assistant", "text": "" }]
        })
    }

    #[test]
    fn parent_done_does_not_settle_a_background_child() {
        let out = fold(&chat(), &[
            ("t", json!({"kind":"begin","turn":{"id":"t","role":"assistant","text":""},"route":"claude:p"})),
            ("t", json!({"kind":"segment","segment":{"kind":"tool","toolId":"child","status":"running","subagent":{"status":"running"}}})),
            ("t", json!({"kind":"done","at":350})),
        ]);
        assert_eq!(out["turns"][1]["segments"][0]["status"], "running");
        assert_eq!(out["turns"][1]["segments"][0]["subagent"]["status"], "running");
    }

    #[test]
    fn appends_streamed_text_and_settles_tools() {
        let out = fold(
            &chat(),
            &[
                ("t", json!({ "kind": "begin", "turn": { "id": "t", "role": "assistant", "text": "", "startedAt": 100 }, "route": "claude:p" })),
                ("t", json!({ "kind": "session", "sessionId": "s1" })),
                ("t", json!({ "kind": "text", "text": "ação" })),
                ("t", json!({ "kind": "text", "text": "🙂" })),
                ("t", json!({ "kind": "segment", "segment": { "kind": "tool", "toolId": "b", "status": "running" } })),
                ("t", json!({ "kind": "done", "at": 350 })),
            ],
        );
        let turn = &out["turns"][1];
        assert_eq!(turn["segments"][0]["text"], "ação🙂");
        assert_eq!(turn["segments"][1]["status"], "done");
        assert_eq!(turn["durationMs"], 250);
        assert_eq!(out["resume"], json!({ "route": "claude:p", "sessionId": "s1" }));
        assert!(out.get("pendingTurnId").is_none());
    }

    #[test]
    fn javascript_corners() {
        assert_eq!(to_js_string(None), "undefined");
        assert_eq!(to_js_string(Some(&json!(1.5))), "1.5");
        assert_eq!(to_js_string(Some(&json!(1e21))), "1e+21");
        assert_eq!(to_js_string(Some(&json!([1, null, "a"]))), "1,,a");
        assert_eq!(js_number(f64::NAN), Value::Null);
        assert_eq!(js_number(2500.0), json!(2500));
        assert!(!truthy(Some(&json!(0))) && !truthy(Some(&json!(""))) && truthy(Some(&json!([]))));
        assert!(!strict_eq(Some(&json!({})), Some(&json!({}))));
        assert_eq!(route_key(None), "undefined:undefined");
    }

    #[test]
    fn cut_stops_at_unfinished_and_spanning_turns() {
        let ev = |kind: &str| json!({ "kind": kind });
        let records = [("a", ev("begin")), ("a", ev("done")), ("b", ev("begin")), ("b", ev("text"))];
        assert_eq!(compaction_cut(records.iter().map(|(t, e)| (*t, e))), Some(1));
        // A late snapshot of `a` after `b` began keeps `a` (and so `b`) in the journal.
        let late = [("a", ev("begin")), ("a", ev("done")), ("b", ev("begin")), ("a", ev("segment")), ("b", ev("done"))];
        assert_eq!(compaction_cut(late.iter().map(|(t, e)| (*t, e))), Some(4));
        let restarted = [("a", ev("begin")), ("a", ev("done")), ("a", ev("begin"))];
        assert_eq!(compaction_cut(restarted.iter().map(|(t, e)| (*t, e))), None);
    }

    #[test]
    fn error_code_lands_on_the_turn_only_when_present() {
        let run = |error: Value| {
            fold(
                &chat(),
                &[
                    ("t", json!({ "kind": "begin", "turn": { "id": "t", "role": "assistant", "text": "", "startedAt": 100 }, "route": "claude:p" })),
                    ("t", error),
                ],
            )
        };
        let out = run(json!({ "kind": "error", "message": "login", "at": 200, "code": "cli_auth" }));
        assert_eq!(out["turns"][1]["errorCode"], "cli_auth");
        assert_eq!(out["turns"][1]["error"], true);
        assert!(out.get("resume").is_none());

        for error in [
            json!({ "kind": "error", "message": "x", "at": 200 }),
            json!({ "kind": "error", "message": "x", "at": 200, "code": "" }),
            json!({ "kind": "error", "message": "x", "at": 200, "code": null }),
        ] {
            let out = run(error);
            assert!(out["turns"][1].get("errorCode").is_none(), "{out}");
            assert_eq!(out["turns"][1]["error"], true);
        }
        // `done` never carries one, even if the body does.
        let out = run(json!({ "kind": "done", "at": 200, "code": "cli_auth" }));
        assert!(out["turns"][1].get("errorCode").is_none());
    }
}
