//! Pure conversions from app-server shapes to what the Prism UI consumes,
//! ported one to one from the TypeScript they replace:
//!
//! - `native_item`: src/main/ipc/nativeCodex.ts (`nativeItem`);
//! - metrics and per-turn usage: src/shared/providerUsage.ts (`codexMetrics`,
//!   `codexSubtract`, `codexTurnUsage`);
//! - catalog: src/main/ipc/agentModels.ts (`codexModels`, `codexUpgradeTier`)
//!   and src/shared/modelLabels.ts (`codexModelLabel`);
//! - skills: src/main/ipc/agentCommands.ts (`codexSkillCommands`,
//!   `codexSkillRefs`, `codexSkillInputs`);
//! - account: src/shared/providerUsage.ts (`codexDetails`, `codexPlanLabel`,
//!   `limitReachedLabel`, `codexResetCredits`, `codexResetOutcome`).
//!
//! Inputs are raw JSON on purpose: like the TypeScript, a field of the wrong
//! type is skipped, never fatal.

use serde::Serialize;
use serde_json::{Map, Value, json};

use super::server::js_truthy;

/// A transcript segment (`SharedSegment` in src/shared/agents.ts).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub kind: SegmentKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<SegmentStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<Value>>,
    /// Async questions arrive on agentMessage items and do not wait for an RPC answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub questions: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SegmentKind {
    Text,
    Thinking,
    Tool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SegmentStatus {
    Running,
    Done,
    Error,
}

impl Segment {
    pub fn text(kind: SegmentKind, tool_id: Option<Value>, text: String) -> Self {
        Self { kind, tool_id, status: None, name: None, input: None, text: Some(text), result: None, result_is_error: None, images: None, questions: None }
    }

    fn tool(tool_id: Option<Value>, status: SegmentStatus, name: Value, input: Value, result: Option<String>) -> Self {
        Self { kind: SegmentKind::Tool, tool_id, status: Some(status), name: Some(name), input: Some(input), text: None, result, result_is_error: None, images: None, questions: None }
    }
}


/// Images in native tool content. Keep raster bytes with their owning segment;
/// mobile snapshots expose a scoped reference and load these bytes on demand.
pub fn content_images(value: &Value) -> Vec<Value> {
    fn collect(value: &Value, output: &mut Vec<Value>, depth: usize) {
        if depth > 8 || output.len() >= 8 { return; }
        match value {
            Value::Array(rows) => { for row in rows { collect(row, output, depth + 1); } }
            Value::Object(row) => {
                if row.get("type").and_then(Value::as_str) == Some("imageGeneration") {
                    if let Some(data) = row.get("result").and_then(Value::as_str) {
                        let mime = [("iVBORw0KGgo", "image/png"), ("/9j/", "image/jpeg"), ("R0lG", "image/gif"), ("UklGR", "image/webp")].iter().find_map(|(prefix, mime)| data.starts_with(prefix).then_some(*mime));
                        if let Some(mime) = mime && data.len() <= 16 * 1024 * 1024 { output.push(json!({"mime": mime, "data": data})); }
                    }
                } else if row.get("type").and_then(Value::as_str) == Some("image") {
                    let source = row.get("source").unwrap_or(value);
                    let mime = source.get("media_type").or_else(|| source.get("mimeType")).or_else(|| source.get("mime")).and_then(Value::as_str);
                    if let (Some(mime), Some(data)) = (mime, source.get("data").and_then(Value::as_str))
                        && ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(&mime)
                        && !data.is_empty() && data.len() <= 16 * 1024 * 1024 {
                        output.push(json!({"mime": mime, "data": data}));
                    }
                } else { for key in ["content", "result", "output"] { if let Some(child) = row.get(key) { collect(child, output, depth + 1); } } }
            }
            Value::String(text) => { if let Ok(parsed) = serde_json::from_str::<Value>(text) && !parsed.is_string() { collect(&parsed, output, depth + 1); } }
            _ => {}
        }
    }
    let mut output = Vec::new(); collect(value, &mut output, 0); output
}

const TOOL_ITEMS: [&str; 5] = ["mcpToolCall", "webSearch", "dynamicToolCall", "plan", "imageView"];

/// A thread item as a segment; None for item kinds the transcript does not show.
pub fn native_item(item: &Value, complete: bool) -> Option<Segment> {
    let id = item.get("id").cloned();
    let failed = item.get("status").and_then(Value::as_str) == Some("failed")
        || item.get("exitCode").is_some_and(|code| !code.is_null() && code.as_f64() != Some(0.0));
    let status = if !complete {
        SegmentStatus::Running
    } else if failed {
        SegmentStatus::Error
    } else {
        SegmentStatus::Done
    };
    match item.get("type").and_then(Value::as_str)? {
        "agentMessage" => {
            let mut segment = Segment::text(SegmentKind::Text, id, truthy_str(item.get("text")).unwrap_or_default());
            let questions: Vec<Value> = item.get("questions").and_then(Value::as_array).into_iter().flatten()
                .filter_map(|question| {
                    let title = question.get("title").and_then(Value::as_str).filter(|title| !title.trim().is_empty())?;
                    let mut row = Map::new(); row.insert("title".into(), json!(title));
                    if let Some(options) = question.get("options").and_then(Value::as_array) {
                        row.insert("options".into(), Value::Array(options.iter().filter(|option| option.is_string()).take(24).cloned().collect()));
                    }
                    Some(Value::Object(row))
                }).take(12).collect();
            if !questions.is_empty() { segment.questions = Some(questions); }
            Some(segment)
        },
        "reasoning" => {
            let parts = ["summary", "content"].iter().filter_map(|k| item.get(*k).and_then(Value::as_array)).flatten();
            let text = parts.map(join_part).collect::<Vec<_>>().join("\n");
            Some(Segment::text(SegmentKind::Thinking, id, text))
        }
        "commandExecution" => {
            let mut input = Map::new();
            copy(&mut input, item, "command", "command");
            copy(&mut input, item, "cwd", "cwd");
            let result = truthy_str(item.get("aggregatedOutput")).unwrap_or_default();
            let mut segment = Segment::tool(id, status, json!("Bash"), Value::Object(input), Some(result));
            segment.result_is_error = Some(status == SegmentStatus::Error);
            Some(segment)
        }
        "imageGeneration" => {
            let path = item.get("path").or_else(|| item.get("outputPath")).and_then(Value::as_str);
            let text = path.map(|path| format!("![Imagem gerada](<{}>)", path.replace('>', "%3E"))).unwrap_or_else(|| "Imagem gerada".into());
            let mut segment = Segment::text(SegmentKind::Text, id, text);
            let images = content_images(item);
            if !images.is_empty() { segment.images = Some(images); }
            Some(segment)
        }
        "fileChange" => {
            let mut input = Map::new();
            copy(&mut input, item, "changes", "changes");
            let result = item.get("changes").map(Value::to_string);
            Some(Segment::tool(id, status, json!("Write"), Value::Object(input), result))
        }
        "collabAgentToolCall" => {
            let input = json!({"prompt":item["prompt"], "model":item["model"], "receiverThreadIds":item["receiverThreadIds"]});
            Some(Segment::tool(id, status, item.get("tool").cloned().unwrap_or(json!("Agent")), input, Some(item["agentsStates"].to_string())))
        }
        kind if TOOL_ITEMS.contains(&kind) => {
            let name = item.get("tool").filter(|t| js_truthy(t)).cloned().unwrap_or_else(|| json!(kind));
            let input = item.get("arguments").filter(|a| js_truthy(a)).cloned().unwrap_or_else(|| item.clone());
            let shown = ["result", "content"].iter().find_map(|k| item.get(*k).filter(|v| js_truthy(v))).cloned().unwrap_or(json!(""));
            let mut segment = Segment::tool(id, status, name, input, Some(shown.to_string()));
            let images = content_images(&shown);
            if !images.is_empty() { segment.images = Some(images); }
            Some(segment)
        }
        _ => None,
    }
}

/// `Array.prototype.join` of one element.
fn join_part(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        other => js_string(other),
    }
}

/// The streaming delta methods and whether they grow a reasoning segment.
pub fn delta_kind(method: &str) -> Option<SegmentKind> {
    match method {
        "item/agentMessage/delta" | "item/commandExecution/outputDelta" => Some(SegmentKind::Text),
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => Some(SegmentKind::Thinking),
        _ => None,
    }
}

/// Appends a delta: to a tool's `result`, else to the `text`.
pub fn apply_delta(segment: &mut Segment, delta: &str) {
    if segment.kind == SegmentKind::Tool {
        segment.result.get_or_insert_with(String::new).push_str(delta);
    } else {
        segment.text.get_or_insert_with(String::new).push_str(delta);
    }
}

/* ---------------- Usage ---------------- */

const CODEX_FIELDS: [&str; 5] = ["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"];
const TURN_FIELDS: [&str; 6] = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "costUsd"];

fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|f| f.is_finite())
}

/// A JSON number, integral when it is one (as JS prints it).
pub fn num(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// `a - b` field by field (missing fields count as 0).
pub fn codex_subtract(a: &Value, b: &Value) -> Value {
    let mut out = Map::new();
    for field in CODEX_FIELDS {
        out.insert(field.to_string(), num(finite(a.get(field)).unwrap_or(0.0) - finite(b.get(field)).unwrap_or(0.0)));
    }
    Value::Object(out)
}

/// A per-turn capture with only finite, non-negative fields, or None.
fn turn_usage(value: &Map<String, Value>) -> Option<Value> {
    let mut turn = Map::new();
    for key in TURN_FIELDS {
        if let Some(v) = finite(value.get(key)).filter(|v| *v >= 0.0) {
            turn.insert(key.to_string(), num(v));
        }
    }
    (!turn.is_empty()).then_some(Value::Object(turn))
}

/// This turn's share of a thread total: `total` minus the total before the
/// turn. Summing `last` would count a repeated update twice. None when the
/// total went below the base (a restarted counter).
pub fn codex_turn_usage(base: &Value, total: &Value) -> Option<Value> {
    let d = codex_subtract(total, base);
    let field = |f: &str| d.get(f).and_then(Value::as_f64).unwrap_or(0.0);
    if CODEX_FIELDS.iter().any(|f| field(f) < 0.0) {
        return None;
    }
    // Codex counts cached input inside input; Prism keeps them apart.
    let mut turn = Map::new();
    turn.insert("inputTokens".into(), num((field("inputTokens") - field("cachedInputTokens")).max(0.0)));
    turn.insert("cacheReadTokens".into(), num(field("cachedInputTokens")));
    turn.insert("outputTokens".into(), num(field("outputTokens")));
    turn.insert("reasoningTokens".into(), num(field("reasoningOutputTokens")));
    turn_usage(&turn)
}

/// Codex `tokenUsage` as `RunMetrics`: `total` is the thread's running
/// total; `turn` this turn's share.
pub fn codex_metrics(data: &Value, turn: Option<&Value>) -> Value {
    let empty = Value::Object(Map::new());
    let u = data.get("total").filter(|t| js_truthy(t)).unwrap_or(&empty);
    let mut out = Map::new();
    out.insert("scope".into(), json!("session"));
    for (to, from) in [("inputTokens", "inputTokens"), ("outputTokens", "outputTokens"), ("cachedTokens", "cachedInputTokens"), ("reasoningTokens", "reasoningOutputTokens"), ("totalTokens", "totalTokens")] {
        copy(&mut out, u, from, to);
    }
    if let Some(window) = data.get("modelContextWindow").filter(|w| js_truthy(w)) {
        out.insert("contextWindow".into(), window.clone());
    }
    if let Some(input) = data.pointer("/last/inputTokens").and_then(Value::as_u64) {
        let output = data.pointer("/last/outputTokens").and_then(Value::as_u64).unwrap_or_default();
        out.insert("contextTokens".into(), json!(input.saturating_add(output)));
    }
    if let Some(own) = turn.and_then(Value::as_object).and_then(turn_usage) {
        out.insert("turn".into(), own);
    }
    Value::Object(out)
}

/* ---------------- Catalog ---------------- */

const LEVELS: [&str; 6] = ["low", "medium", "high", "xhigh", "max", "ultra"];

fn known_efforts(ids: impl Iterator<Item = Option<String>>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids.flatten() {
        if LEVELS.contains(&id.as_str()) && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// Visible models as `AgentModel`s, the catalog default first.
pub fn codex_models(rows: &[Value]) -> Vec<Value> {
    let visible: Vec<&Value> = rows
        .iter()
        .filter(|m| m.is_object() && m.get("model").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) && !js_truthy(m.get("hidden").unwrap_or(&Value::Null)))
        .collect();
    let first = visible.iter().position(|m| m.get("isDefault") == Some(&Value::Bool(true)));
    let mut ordered = visible.clone();
    if let Some(first) = first.filter(|&i| i > 0) {
        let lead = ordered.remove(first);
        ordered.insert(0, lead);
    }
    ordered
        .into_iter()
        .map(|m| {
            let id = m.get("model").and_then(Value::as_str).unwrap_or_default();
            let efforts = m.get("supportedReasoningEfforts").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
            let efforts = known_efforts(efforts.iter().map(|e| e.get("reasoningEffort").and_then(Value::as_str).map(str::to_string)));
            let mut out = Map::new();
            out.insert("provider".into(), json!("codex"));
            out.insert("id".into(), json!(id));
            out.insert("label".into(), json!(codex_model_label(id, m.get("displayName").and_then(Value::as_str))));
            out.insert("description".into(), json!(truthy_str(m.get("description")).unwrap_or_default()));
            out.insert("efforts".into(), json!(efforts));
            if let Some(effort) = m.get("defaultReasoningEffort").and_then(Value::as_str).filter(|e| LEVELS.contains(e)) {
                out.insert("defaultEffort".into(), json!(effort));
            }
            out.insert("default".into(), json!(m.get("isDefault") == Some(&Value::Bool(true))));
            out.insert("fast".into(), codex_upgrade_tier(m).unwrap_or(Value::Null));
            Value::Object(out)
        })
        .collect()
}

/// The tier Traycer's Fast toggle flips to: the first advertised tier that is
/// not the model's default (`serviceTiers`, or the deprecated
/// `additionalSpeedTiers`), else the first one.
pub fn codex_upgrade_tier(model: &Value) -> Option<Value> {
    let tiers: Vec<Value> = match model.get("serviceTiers").and_then(Value::as_array).filter(|t| !t.is_empty()) {
        Some(tiers) => tiers.clone(),
        None => model
            .get("additionalSpeedTiers")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter(|id| id.as_str().is_some_and(|s| s != "default")).map(|id| json!({ "id": id })).collect())
            .unwrap_or_default(),
    };
    if tiers.is_empty() {
        return None;
    }
    let default = model.get("defaultServiceTier");
    // A catalog that names no default can still list the baseline tier itself.
    let baseline: Vec<Value> = default.filter(|d| js_truthy(d)).into_iter().cloned().chain(["default", "standard", "auto"].map(|s| json!(s))).collect();
    let id = |t: &Value| t.get("id").cloned().unwrap_or(Value::Null);
    let upgrade = tiers
        .iter()
        .find(|t| !baseline.contains(&id(t)))
        .or_else(|| tiers.iter().find(|t| t.get("id") != default))
        .unwrap_or(&tiers[0]);
    let label = upgrade.get("name").and_then(Value::as_str).filter(|n| !n.is_empty() && n.encode_utf16().count() <= 12).unwrap_or("Fast");
    Some(json!({ "id": id(upgrade), "label": label }))
}

/// Traycer's Codex label: "gpt-6.1-sol" reads "GPT-6.1-Sol"; other ids keep their display name.
pub fn codex_model_label(id: &str, display_name: Option<&str>) -> String {
    if !id.starts_with("gpt-") {
        return display_name.filter(|d| !d.is_empty()).unwrap_or(id).to_string();
    }
    id.split('-')
        .enumerate()
        .map(|(i, part)| {
            if i == 0 {
                part.to_uppercase()
            } else if !part.is_empty() && part.chars().all(|c| c.is_ascii_digit() || c == '.') {
                part.to_string()
            } else {
                capitalize(part)
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars.as_str().to_lowercase().chars()).collect(),
        None => String::new(),
    }
}

/* ---------------- Skills ---------------- */

/// A skill as `turn/start` takes it (SkillUserInput).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillRef {
    pub name: String,
    pub path: String,
}

fn enabled_skills(response: &Value) -> impl Iterator<Item = (String, &Value)> {
    let mut seen = Vec::<String>::new();
    response
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|entry| entry.get("skills").and_then(Value::as_array).into_iter().flatten())
        .filter_map(move |skill| {
            let name = skill.get("name").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
            if name.is_empty() || skill.get("enabled") == Some(&Value::Bool(false)) || seen.contains(&name) {
                return None;
            }
            seen.push(name.clone());
            Some((name, skill))
        })
}

/// Enabled skills as `/` menu rows (`AgentCommand`), first occurrence of a name wins.
pub fn codex_skill_commands(response: &Value) -> Vec<Value> {
    enabled_skills(response)
        .map(|(name, skill)| {
            let candidates = [skill.get("description"), skill.get("interface").and_then(|i| i.get("shortDescription")), skill.get("shortDescription")];
            let description = candidates.into_iter().flatten().filter_map(Value::as_str).find(|d| !d.trim().is_empty()).unwrap_or_default();
            json!({ "name": name, "description": description, "argumentHint": null, "kind": "skill", "builtin": false })
        })
        .collect()
}

/// Enabled skills with a path, first occurrence of a name wins.
pub fn codex_skill_refs(response: &Value) -> Vec<SkillRef> {
    enabled_skills(response)
        .filter_map(|(name, skill)| skill.get("path").and_then(Value::as_str).filter(|p| !p.trim().is_empty()).map(|path| SkillRef { name, path: path.to_string() }))
        .collect()
}

/// JS `\s`: Unicode white space plus the BOM.
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// The `$name` tokens of a prompt: at the start or after white space, up to
/// the next white space or `$` (`/(?:^|\s)\$([^\s$]+)/g`).
pub fn skill_tokens(prompt: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let chars: Vec<(usize, char)> = prompt.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        let dollar = if i == 0 && chars[0].1 == '$' {
            Some(0)
        } else if js_space(chars[i].1) && chars.get(i + 1).is_some_and(|c| c.1 == '$') {
            Some(i + 1)
        } else {
            None
        };
        if let Some(d) = dollar {
            let mut end = d + 1;
            while end < chars.len() && !js_space(chars[end].1) && chars[end].1 != '$' {
                end += 1;
            }
            if end > d + 1 {
                let from = chars[d + 1].0;
                let to = chars.get(end).map(|c| c.0).unwrap_or(prompt.len());
                out.push(&prompt[from..to]);
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// The structured skill items of a turn: every `$name` whose name is exactly
/// an enabled skill's (as typed, then without trailing sentence punctuation),
/// each skill once, in order. The text keeps the tokens.
pub fn codex_skill_inputs(prompt: &str, skills: &[SkillRef]) -> Vec<Value> {
    if skills.is_empty() || !prompt.contains('$') {
        return Vec::new();
    }
    let find = |name: &str| skills.iter().rev().find(|s| s.name == name);
    let mut used: Vec<&str> = Vec::new();
    let mut out = Vec::new();
    for token in skill_tokens(prompt) {
        let stripped = token.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']', '}', '\'', '"']);
        let Some(skill) = find(token).or_else(|| find(stripped)) else { continue };
        if used.contains(&skill.name.as_str()) {
            continue;
        }
        used.push(&skill.name);
        out.push(json!({ "type": "skill", "name": skill.name, "path": skill.path }));
    }
    out
}

/* ---------------- Account: plan, limits, resets ---------------- */

fn squash_title(v: &str) -> String {
    v.split(|c: char| js_space(c) || c == '_' || c == '-').filter(|w| !w.is_empty()).map(capitalize).collect::<Vec<_>>().join(" ")
}

/// Traycer's Codex identity tier ("ChatGPT Plus Subscription") from `account.planType`.
pub fn codex_plan_label(plan_type: Option<&Value>) -> Option<String> {
    let plan = plan_type.and_then(Value::as_str).filter(|p| !p.trim().is_empty())?;
    if plan == "unknown" {
        return Some("Assinatura ChatGPT".to_string());
    }
    let name = match plan {
        "free" => "Free".to_string(),
        "go" => "Go".to_string(),
        "plus" => "Plus".to_string(),
        "pro" => "Pro 20x".to_string(),
        "prolite" => "Pro 5x".to_string(),
        "team" => "Team".to_string(),
        "self_serve_business_usage_based" | "business" => "Business".to_string(),
        "enterprise_cbp_usage_based" | "enterprise" => "Enterprise".to_string(),
        "edu" => "Edu".to_string(),
        other => squash_title(other),
    };
    Some(format!("Assinatura ChatGPT {name}"))
}

/// A `rateLimitReachedType` in the account's words; unknown codes still read as "limit reached".
pub fn limit_reached_label(kind: &str) -> String {
    if kind.contains("workspace_member") {
        "Limite de uso atingido (membro do workspace)"
    } else if kind.contains("workspace") {
        "Limite de uso atingido (workspace)"
    } else if kind.contains("credit") {
        "Limite de uso atingido (créditos esgotados)"
    } else {
        "Limite de uso atingido"
    }
    .to_string()
}

fn text_or_null(value: Option<&Value>) -> Value {
    value.and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| json!(s)).unwrap_or(Value::Null)
}

fn reset_credit(raw: &Value) -> Option<Value> {
    if !raw.is_object() {
        return None;
    }
    let id = raw.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    let granted = finite(raw.get("grantedAt"))?;
    let expires = raw.get("expiresAt").filter(|e| !e.is_null());
    // A credit with a garbled expiry is dropped, never guessed.
    if expires.is_some_and(|e| !e.is_number()) {
        return None;
    }
    let status = raw.get("status").and_then(Value::as_str).filter(|s| ["available", "redeeming", "redeemed"].contains(s)).unwrap_or("unknown");
    Some(json!({
        "id": id, "status": status, "grantedAt": num(granted), "expiresAt": expires.cloned().unwrap_or(Value::Null),
        "title": text_or_null(raw.get("title")), "description": text_or_null(raw.get("description")),
    }))
}

/// Codex manual resets (`rateLimitResetCredits`); `credits` is null on a count-only reply.
pub fn codex_reset_credits(raw: Option<&Value>) -> Option<Value> {
    let raw = raw.filter(|r| r.is_object())?;
    let count = finite(raw.get("availableCount")).filter(|c| *c >= 0.0)?;
    let credits = raw.get("credits").and_then(Value::as_array).map(|list| Value::Array(list.iter().filter_map(reset_credit).collect())).unwrap_or(Value::Null);
    Some(json!({ "availableCount": num(count.floor()), "credits": credits }))
}

pub const RESET_OUTCOMES: [&str; 4] = ["reset", "nothingToReset", "noCredit", "alreadyRedeemed"];

/// `account/rateLimitResetCredit/consume`'s answer; anything else is an error.
pub fn codex_reset_outcome(raw: &Value) -> Result<&'static str, String> {
    let outcome = raw.get("outcome").and_then(Value::as_str);
    RESET_OUTCOMES
        .into_iter()
        .find(|o| Some(*o) == outcome)
        .ok_or_else(|| "O Codex retornou um resultado desconhecido para a redefinição manual.".to_string())
}

fn window_label(minutes: Option<&Value>) -> String {
    match minutes.and_then(Value::as_f64) {
        Some(10080.0) => "7 dias".to_string(),
        Some(m) if m != 0.0 => format!("{}h", js_number(m / 60.0)),
        _ => "Janela da conta".to_string(),
    }
}

/// Limits, plan, credits and resets as `ProfileDetails`, from `account/read`
/// and `account/rateLimits/read`. The account-wide bucket leads.
pub fn codex_details(account: &Value, data: &Value, now_ms: i64) -> Value {
    let mut buckets: Vec<(String, Value)> =
        data.get("rateLimitsByLimitId").and_then(Value::as_object).map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
    let main = data.get("rateLimits").filter(|m| js_truthy(m));
    let main_limit = main.and_then(|m| m.get("limitId")).filter(|l| js_truthy(l));
    let main_id = main_limit.map(js_string).unwrap_or_else(|| "codex".to_string());
    let same_limit = |b: &Value| b.get("limitId").filter(|l| js_truthy(l)).is_some_and(|l| main.and_then(|m| m.get("limitId")) == Some(l));
    if let Some(main) = main
        && !buckets.iter().any(|(id, b)| *id == main_id || same_limit(b))
    {
        buckets.insert(0, (main_id.clone(), main.clone()));
    }
    let is_main = |id: &str, b: &Value| id == main_id || same_limit(b);
    if let Some(lead) = buckets.iter().position(|(id, b)| is_main(id, b)).filter(|&i| i > 0) {
        let entry = buckets.remove(lead);
        buckets.insert(0, entry);
    }
    let (mut limits, mut extras) = (Vec::new(), Vec::new());
    for (id, b) in &buckets {
        let limit_name = b.get("limitName").filter(|n| js_truthy(n));
        let name = limit_name.map(js_string).unwrap_or_else(|| id.clone());
        let scope = if is_main(id, b) { limit_name.cloned().unwrap_or(Value::Null) } else { json!(name) };
        for key in ["primary", "secondary"] {
            let Some(w) = b.get(key).filter(|w| js_truthy(w)) else { continue };
            let Some(used) = finite(w.get("usedPercent")) else { continue };
            let minutes = w.get("windowDurationMins");
            let mut limit = Map::new();
            limit.insert("id".into(), json!(format!("{id}:{key}")));
            limit.insert("label".into(), json!(format!("{name} · {}", window_label(minutes))));
            limit.insert("name".into(), scope.clone());
            limit.insert("usedPercent".into(), num(used));
            if let Some(resets) = finite(w.get("resetsAt")) {
                limit.insert("resetsAt".into(), num(resets));
            }
            if let Some(minutes) = minutes.filter(|m| js_truthy(m)) {
                limit.insert("windowMinutes".into(), minutes.clone());
            }
            limits.push(Value::Object(limit));
        }
        if let Some(credits) = b.get("credits").filter(|c| js_truthy(c)) {
            let value = if js_truthy(credits.get("unlimited").unwrap_or(&Value::Null)) {
                "Ilimitados".to_string()
            } else if let Some(balance) = credits.get("balance").filter(|b| !b.is_null()) {
                js_string(balance)
            } else if js_truthy(credits.get("hasCredits").unwrap_or(&Value::Null)) {
                "Disponíveis".to_string()
            } else {
                "Sem créditos".to_string()
            };
            extras.push(json!({ "label": format!("{name} · créditos"), "value": value }));
        }
        if let Some(individual) = b.get("individualLimit").filter(|i| js_truthy(i)) {
            let field = |k: &str| individual.get(k).map(js_string).unwrap_or_else(|| "undefined".to_string());
            let renews = individual
                .get("resetsAt")
                .filter(|r| js_truthy(r))
                .and_then(Value::as_f64)
                .map(|secs| format!(" · renova {}", local_date_time(secs)))
                .unwrap_or_default();
            extras.push(json!({
                "label": format!("{name} · limite individual"),
                "value": format!("{} / {} · {}% disponível{renews}", field("used"), field("limit"), field("remainingPercent")),
            }));
        }
        if let Some(reached) = b.get("rateLimitReachedType").filter(|r| js_truthy(r)) {
            extras.push(json!({ "label": name, "value": limit_reached_label(&js_string(reached)) }));
        }
    }
    let account_tier = account.get("account").and_then(|a| a.get("planType")).filter(|t| js_truthy(t));
    let tier = account_tier.or_else(|| main.and_then(|m| m.get("planType")));
    let mut out = Map::new();
    if let Some(email) = account.get("account").and_then(|a| a.get("email")) {
        out.insert("email".into(), email.clone());
    }
    if let Some(tier) = tier {
        out.insert("tier".into(), tier.clone());
    }
    if let Some(plan) = codex_plan_label(tier) {
        out.insert("plan".into(), json!(plan));
    }
    let empty = limits.is_empty();
    out.insert("limits".into(), Value::Array(limits));
    out.insert("extras".into(), Value::Array(extras));
    if let Some(resets) = codex_reset_credits(data.get("rateLimitResetCredits")) {
        out.insert("resetCredits".into(), resets);
    }
    out.insert("updatedAt".into(), json!(now_ms));
    if empty {
        out.insert("unavailable".into(), json!("O provedor não informou janelas de uso para esta conta."));
    }
    Value::Object(out)
}

/// `new Date(secs * 1000).toLocaleString('pt-BR')`: "dd/mm/aaaa, hh:mm:ss" in local time.
fn local_date_time(secs: f64) -> String {
    use chrono::TimeZone;
    match chrono::Local.timestamp_millis_opt((secs * 1000.0) as i64) {
        chrono::LocalResult::Single(t) | chrono::LocalResult::Ambiguous(t, _) => t.format("%d/%m/%Y, %H:%M:%S").to_string(),
        chrono::LocalResult::None => "Invalid Date".to_string(),
    }
}

/* ---------------- JS value helpers ---------------- */

/// JS `String(value)` for JSON values.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() => js_number(f),
            _ => n.to_string(),
        },
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().map(join_part).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn js_number(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e21 { format!("{}", f as i128) } else { format!("{f}") }
}

fn truthy_str(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

fn copy(out: &mut Map<String, Value>, from: &Value, key: &str, to: &str) {
    if let Some(value) = from.get(key) {
        out.insert(to.to_string(), value.clone());
    }
}

#[cfg(test)]
mod raster_tests {
    use super::*;
    #[test]
    fn native_images_survive_tools_and_generation() {
        let block = json!({"type":"image", "source":{"media_type":"image/png", "data":"iVBORw0KGgo="}});
        let tool = native_item(&json!({"id":"tool", "type":"mcpToolCall", "result":{"content":[block]}}), true).unwrap();
        assert_eq!(tool.images.unwrap()[0]["mime"], "image/png");
        let generated = native_item(&json!({"id":"generated", "type":"imageGeneration", "result":"iVBORw0KGgo="}), true).unwrap();
        assert_eq!(generated.images.unwrap()[0]["data"], "iVBORw0KGgo=");
        assert!(content_images(&json!({"type":"image", "mimeType":"image/svg+xml", "data":"x"})).is_empty());
    }
}
