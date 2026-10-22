//! What the renderer computed for a turn before T07, ported as is:
//! `continuationPrompt`/`transcriptText` (src/shared/agents.ts),
//! `claudeMetrics`/`turnUsage` (src/shared/providerUsage.ts) and the title
//! a chat takes from its first message (lib/agentChats.ts).

use prism_store::route_key;
use serde_json::{Map, Value};

/// JavaScript truthiness of a JSON value.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// A value as a template literal prints it (`${value}`).
fn template(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) => "null".into(),
        Some(Value::Array(items)) => items.iter().map(|v| if v.is_null() { String::new() } else { template(Some(v)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(other) => other.to_string(),
    }
}

/// `JSON.stringify(value)`, `undefined` when absent.
fn stringify(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(v) => serde_json::to_string(v).unwrap_or_default(),
    }
}

fn str_or<'a>(value: Option<&'a Value>, fallback: &'a str) -> &'a str {
    value.and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(fallback)
}

/// One turn as `transcriptText` prints it.
fn turn_block(t: &Value) -> String {
    let segments = t.get("segments").and_then(Value::as_array).filter(|s| !s.is_empty());
    let text = match segments {
        Some(segments) => segments
            .iter()
            .map(|s| match s.get("kind").and_then(Value::as_str) {
                Some("text") => str_or(s.get("text"), "").to_string(),
                Some("user") => format!("Usuário: {}", str_or(s.get("text"), "")),
                Some("tool") => format!(
                    "[Ferramenta {}: {}]\n{}",
                    template(s.get("name")),
                    stringify(s.get("input")),
                    str_or(s.get("result"), "")
                ),
                _ => String::new(),
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        None => template(t.get("text")),
    };
    let who = if t.get("role").and_then(Value::as_str) == Some("user") { "Usuário" } else { str_or(t.get("provider"), "Assistente") };
    let failed = truthy(t.get("error")) || truthy(t.get("interrupted"));
    let note = if failed { "\n[Esta execução terminou com erro ou foi interrompida; as ferramentas acima podem já ter sido executadas.]" } else { "" };
    format!("{who}: {text}{note}")
}

/// A long import (tens of thousands of turns) would blow the model's context and
/// the Codex 1 MB submission cap, so only the most recent turns within this
/// budget are carried, with a marker. The native-session resume (when the chat
/// keeps the account that holds it) is the path to the full history. ~50k tokens.
const HISTORY_BUDGET: usize = 200_000;
pub const HISTORY_OMITTED: &str = "[Parte mais antiga desta conversa foi omitida por limite de tamanho; os arquivos estão no disco.]";

/// The most recent turns whose text fits `budget`, with a marker when older ones were dropped.
fn bounded_transcript(turns: &[Value], budget: usize) -> String {
    let blocks: Vec<String> = turns.iter().map(turn_block).collect();
    let mut total = 0usize;
    let mut start = blocks.len();
    for i in (0..blocks.len()).rev() {
        let sep = if start < blocks.len() { 2 } else { 0 };
        let add = blocks[i].chars().count() + sep;
        if start < blocks.len() && total + add > budget {
            break;
        }
        total += add;
        start = i;
    }
    let mut dropped = start > 0;
    let mut body = blocks[start..].join("\n\n");
    // One recent turn can still be larger than the budget (a huge tool result): keep its tail.
    if body.chars().count() > budget {
        body = body.chars().skip(body.chars().count() - budget).collect();
        dropped = true;
    }
    if dropped && !body.is_empty() { format!("{HISTORY_OMITTED}\n\n{body}") } else { body }
}

/// `continuationPrompt`: the same route resumes its native session; any
/// other carries the visible history in the prompt.
pub fn continuation_prompt(chat: &Value, prompt: &str) -> (String, Option<String>) {
    let resume = chat.get("resume");
    if let Some(resume) = resume
        && resume.get("route").and_then(Value::as_str) == Some(route_key(chat.get("selection")).as_str())
    {
        return (prompt.to_string(), resume.get("sessionId").and_then(Value::as_str).map(str::to_string));
    }
    let turns = chat.get("turns").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let history = bounded_transcript(turns, HISTORY_BUDGET);
    let workspace = if truthy(chat.get("cwdPinned")) {
        format!("Pasta de trabalho atual desta conversa: {}. Use esta pasta nas próximas ações; caminhos antigos no histórico são apenas contexto.\n\n", chat.get("cwd").and_then(Value::as_str).unwrap_or_default())
    } else { String::new() };
    if history.is_empty() {
        return (format!("{workspace}{prompt}"), None);
    }
    (
        format!(
            "Continue esta conversa usando o histórico abaixo como contexto. As ferramentas anteriores já foram executadas; não repita ações só porque aparecem no histórico.\n\n<historico>\n{history}\n</historico>\n\n{workspace}Nova mensagem do usuário:\n{prompt}"
        ),
        None,
    )
}

/// A new chat's title: its first message, trimmed, up to 48 characters.
pub fn first_title(text: &str) -> String {
    text.trim().chars().take(48).collect()
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|f| f.is_finite())
}

/// `turnUsage`: only the finite, non-negative fields; `None` when none is.
pub fn turn_usage(value: Option<&Value>) -> Option<Value> {
    let value = value.filter(|v| v.is_object())?;
    let mut out = Map::new();
    for key in ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "costUsd"] {
        if finite(value.get(key)).is_some_and(|f| f >= 0.0) {
            out.insert(key.into(), value[key].clone());
        }
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// `claudeMetrics(result)`: the turn's `RunMetrics` from an `agent:result`.
pub fn claude_metrics(data: &Value) -> Value {
    let usage = data.get("usage").filter(|u| u.is_object());
    let mut out = Map::new();
    out.insert("scope".into(), "session".into());
    for (key, from) in [
        ("inputTokens", "input_tokens"),
        ("outputTokens", "output_tokens"),
        ("cachedTokens", "cache_read_input_tokens"),
        ("cacheWriteTokens", "cache_creation_input_tokens"),
    ] {
        if let Some(value) = usage.and_then(|u| u.get(from)) {
            out.insert(key.into(), value.clone());
        }
    }
    if finite(data.get("costUsd")).is_some() {
        out.insert("costUsd".into(), data["costUsd"].clone());
    }
    if let Some(turn) = turn_usage(data.get("turn")) {
        out.insert("turn".into(), turn);
    }
    for key in ["contextTokens", "contextWindow"] {
        if let Some(value) = data.get(key).filter(|v| v.as_u64().is_some()) {
            out.insert(key.into(), value.clone());
        }
    }
    if let Some(model) = data.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
        out.insert("model".into(), model.into());
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chat(resume: Option<Value>, turns: Value) -> Value {
        let mut chat = json!({ "id": "c", "selection": { "provider": "claude", "profileId": "ambient-claude" }, "turns": turns });
        if let Some(resume) = resume {
            chat["resume"] = resume;
        }
        chat
    }

    #[test]
    fn same_route_resumes_and_another_carries_the_history() {
        let turns = json!([
            { "id": "u", "role": "user", "text": "oi" },
            { "id": "a", "role": "assistant", "provider": "codex", "text": "", "interrupted": true, "segments": [
                { "kind": "thinking", "text": "hm" },
                { "kind": "text", "text": "olá" },
                { "kind": "tool", "name": "Bash", "input": { "command": "ls" }, "result": "a.txt" }
            ] }
        ]);
        let resumed = continuation_prompt(&chat(Some(json!({ "route": "claude:ambient-claude", "sessionId": "s1" })), turns.clone()), "e aí");
        assert_eq!(resumed, ("e aí".to_string(), Some("s1".to_string())));
        let (prompt, resume) = continuation_prompt(&chat(Some(json!({ "route": "codex:ambient-codex", "sessionId": "s1" })), turns), "e aí");
        assert_eq!(resume, None);
        assert_eq!(
            prompt,
            "Continue esta conversa usando o histórico abaixo como contexto. As ferramentas anteriores já foram executadas; não repita ações só porque aparecem no histórico.\n\n<historico>\nUsuário: oi\n\ncodex: olá\n[Ferramenta Bash: {\"command\":\"ls\"}]\na.txt\n[Esta execução terminou com erro ou foi interrompida; as ferramentas acima podem já ter sido executadas.]\n</historico>\n\nNova mensagem do usuário:\ne aí"
        );
        assert_eq!(continuation_prompt(&chat(None, json!([])), "primeira"), ("primeira".to_string(), None));
    }

    #[test]
    fn a_huge_import_carries_only_the_recent_tail_within_budget() {
        // 400 turns of ~5k chars each (~2 MB) — far past the Codex 1 MB cap.
        let turns: Vec<Value> = (0..400)
            .map(|i| json!({ "id": format!("t{i}"), "role": "user", "text": format!("TURNO {i} {}", "x".repeat(5000)) }))
            .collect();
        let (prompt, resume) = continuation_prompt(&chat(None, Value::Array(turns)), "e agora");
        assert_eq!(resume, None);
        assert!(prompt.chars().count() < HISTORY_BUDGET + 2000, "ficou {} chars", prompt.chars().count());
        assert!(prompt.contains(HISTORY_OMITTED), "deve avisar que cortou");
        assert!(prompt.contains("TURNO 399"), "mantém o mais recente");
        assert!(!prompt.contains("TURNO 0 "), "larga o mais antigo");
        assert!(prompt.ends_with("Nova mensagem do usuário:\ne agora"));
    }

    #[test]
    fn a_short_history_is_carried_whole_without_a_marker() {
        let turns = json!([{ "id": "u", "role": "user", "text": "oi" }, { "id": "a", "role": "assistant", "provider": "codex", "text": "olá" }]);
        let (prompt, _) = continuation_prompt(&chat(None, turns), "segue");
        assert!(!prompt.contains(HISTORY_OMITTED));
        assert!(prompt.contains("Usuário: oi") && prompt.contains("codex: olá"));
    }

    #[test]
    fn claude_metrics_keeps_the_typescript_shape() {
        let data = json!({ "usage": { "input_tokens": 3, "output_tokens": 4, "cache_read_input_tokens": 5 }, "costUsd": 0.5, "turn": { "inputTokens": 1, "costUsd": -1 }, "model": "claude-haiku" });
        assert_eq!(
            claude_metrics(&data),
            json!({ "scope": "session", "inputTokens": 3, "outputTokens": 4, "cachedTokens": 5, "costUsd": 0.5, "turn": { "inputTokens": 1 }, "model": "claude-haiku" })
        );
        assert_eq!(claude_metrics(&json!({})), json!({ "scope": "session" }));
    }

    #[test]
    fn titles_take_the_first_48_characters() {
        assert_eq!(first_title("  oi  "), "oi");
        assert_eq!(first_title(&"á".repeat(60)).chars().count(), 48);
    }
}
