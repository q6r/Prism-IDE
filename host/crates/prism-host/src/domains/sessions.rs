//! `sessions.*`: the Claude Code transcripts the CLI writes to the host's
//! `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, for the session
//! browser (list, reopen, delete). Same parsing as `src/main/ipc/sessions.ts`,
//! including its JavaScript truthiness rules.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::SystemTime;

use prism_protocol::sessions::{
    SessionFileParams, SessionMeta, SessionsListParams, TranscriptRole, TranscriptSegment, TranscriptSegmentKind, TranscriptTurn,
};
use serde_json::{json, Value};

use super::fs::{blocking, to_json};
use super::node_path::{self, js_trim, utf16_prefix};
use crate::domain::{params, CallContext, Domain, HandlerFuture};

pub struct SessionsDomain {
    home: Option<PathBuf>,
}

impl SessionsDomain {
    /// Reads the OS user's home (`%USERPROFILE%`, `$HOME`), like Node's `os.homedir()`.
    pub fn new() -> Self {
        Self { home: std::env::home_dir() }
    }

    pub fn with_home(home: PathBuf) -> Self {
        Self { home: Some(home) }
    }

    fn projects_dir(&self) -> Option<String> {
        let home = self.home.as_ref()?.to_string_lossy().into_owned();
        Some(node_path::join(&[&home, ".claude", "projects"]))
    }
}

impl Default for SessionsDomain {
    fn default() -> Self {
        Self::new()
    }
}

impl Domain for SessionsDomain {
    fn name(&self) -> &'static str {
        "sessions"
    }

    fn call(&self, method: &str, value: Value, _ctx: CallContext) -> Option<HandlerFuture> {
        let projects = self.projects_dir();
        Some(match method {
            "list" => Box::pin(async move {
                let p: SessionsListParams = if value.is_null() { SessionsListParams::default() } else { params(value)? };
                to_json(blocking(move || Ok(projects.map(|dir| list(&dir, p.filter_cwd.as_deref())).unwrap_or_default())).await?)
            }),
            "read" => Box::pin(async move {
                let file = params::<SessionFileParams>(value)?.file;
                to_json(blocking(move || Ok(read(&file))).await?)
            }),
            "delete" => Box::pin(async move {
                let file = params::<SessionFileParams>(value)?.file;
                Ok(json!(blocking(move || Ok(fs::remove_file(&file).is_ok())).await?))
            }),
            _ => return None,
        })
    }
}

/// Every session under `projects` (only those of `filter_cwd` when given),
/// newest first. Files are parsed on a few threads: there can be hundreds.
pub fn list(projects: &str, filter_cwd: Option<&str>) -> Vec<SessionMeta> {
    let Ok(dirs) = fs::read_dir(projects) else { return Vec::new() };
    let mut candidates = Vec::new();
    for dir in dirs.filter_map(Result::ok) {
        let dir_name = dir.file_name().to_string_lossy().into_owned();
        let Ok(files) = fs::read_dir(dir.path()) else { continue };
        for file in files.filter_map(Result::ok) {
            candidates.push((dir_name.clone(), file.file_name().to_string_lossy().into_owned()));
        }
    }
    let next = AtomicUsize::new(0);
    let metas = Mutex::new(Vec::new());
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, 8).min(candidates.len().max(1));
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some((dir, name)) = candidates.get(i) else { break };
                    if let Some(meta) = read_meta(projects, dir, name) {
                        metas.lock().unwrap().push(meta);
                    }
                }
            });
        }
    });
    let norm = |p: &str| p.trim_end_matches(['\\', '/']).to_lowercase();
    let mut metas: Vec<SessionMeta> = metas.into_inner().unwrap();
    if let Some(cwd) = filter_cwd.filter(|c| !c.is_empty()) {
        let wanted = norm(cwd);
        metas.retain(|m| norm(&m.cwd) == wanted);
    }
    metas.sort_by(|a, b| b.mtime.total_cmp(&a.mtime));
    metas
}

fn epoch_ms(time: std::io::Result<SystemTime>) -> f64 {
    time.ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_nanos() as f64 / 1e6)
}

fn read_meta(projects: &str, dir: &str, name: &str) -> Option<SessionMeta> {
    let file = node_path::join(&[projects, dir, name]);
    let stat = fs::metadata(&file).ok()?;
    if !name.ends_with(".jsonl") || stat.len() == 0 {
        return None;
    }
    let raw = String::from_utf8_lossy(&fs::read(&file).ok()?).into_owned();
    let id = name.strip_suffix(".jsonl").unwrap_or(name);
    meta_from_content(&raw, id, &file, dir, epoch_ms(stat.modified()), epoch_ms(stat.created()))
}

/// JavaScript truthiness of an optional JSON value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// A truthy string field.
fn text<'a>(obj: &'a Value, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// The first text of a message's content (`Err` where the JavaScript threw).
fn first_text(content: Option<&Value>) -> Result<String, ()> {
    if !truthy(content) {
        return Ok(String::new());
    }
    match content {
        Some(Value::String(s)) => Ok(s.clone()),
        Some(Value::Array(blocks)) => {
            for block in blocks {
                if block.is_null() {
                    return Err(());
                }
                if block.get("type").and_then(Value::as_str) == Some("text") && truthy(block.get("text")) {
                    return Ok(block.get("text").and_then(Value::as_str).unwrap_or("").to_string());
                }
            }
            Ok(String::new())
        }
        _ => Err(()),
    }
}

/// `str.replace(/\s+/g, ' ')`.
fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for c in s.chars() {
        if c.is_whitespace() || c == '\u{feff}' {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// A transcript's list entry; `None` without messages (or where the
/// JavaScript reader failed).
pub fn meta_from_content(raw: &str, id: &str, file: &str, dir: &str, mtime_ms: f64, birth_ms: f64) -> Option<SessionMeta> {
    // A user-set name (`custom-title`) beats the generated `ai-title`; both
    // can repeat, so the last wins, preferring entries of this session.
    let (mut custom_own, mut custom_any, mut ai_own, mut ai_any) = (None, None, None, None);
    let (mut preview, mut cwd) = (String::new(), String::new());
    let mut git_branch: Option<String> = None;
    let mut first_ts = 0.0;
    let mut message_count = 0u32;

    for line in raw.split('\n') {
        if js_trim(line).is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else { continue };
        if obj.is_null() {
            return None;
        }
        let kind = obj.get("type").and_then(Value::as_str);
        let own = !truthy(obj.get("sessionId")) || obj.get("sessionId").and_then(Value::as_str) == Some(id);
        if kind == Some("custom-title")
            && let Some(title) = text(&obj, "customTitle")
        {
            custom_any = Some(title.to_string());
            if own {
                custom_own = Some(title.to_string());
            }
        }
        if kind == Some("ai-title")
            && let Some(title) = text(&obj, "aiTitle")
        {
            ai_any = Some(title.to_string());
            if own {
                ai_own = Some(title.to_string());
            }
        }
        if matches!(kind, Some("user" | "assistant")) && !truthy(obj.get("isSidechain")) {
            message_count += 1;
            if cwd.is_empty()
                && let Some(c) = text(&obj, "cwd")
            {
                cwd = c.to_string();
            }
            if git_branch.is_none() {
                git_branch = text(&obj, "gitBranch").map(str::to_string);
            }
            if first_ts == 0.0
                && let Some(ts) = text(&obj, "timestamp")
            {
                first_ts = parse_date_ms(ts).unwrap_or(0.0);
            }
            if kind == Some("user") && preview.is_empty() {
                let content = obj.get("message").and_then(|m| m.get("content"));
                let first = first_text(content).ok()?;
                let t = js_trim(&first);
                // Command and system noise is not a preview.
                if !t.is_empty() && !t.starts_with('<') {
                    preview = utf16_prefix(&collapse_whitespace(t), 140).to_string();
                }
            }
        }
    }
    if message_count == 0 {
        return None;
    }
    let title = custom_own.or(custom_any).or(ai_own).or(ai_any).unwrap_or_default();
    let project = cwd.rsplit(['\\', '/']).find(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| dir.to_string());
    let title = if !title.is_empty() {
        title
    } else if !preview.is_empty() {
        utf16_prefix(&preview, 60).to_string()
    } else {
        "(sem título)".to_string()
    };
    Some(SessionMeta {
        id: id.to_string(),
        title,
        preview,
        cwd,
        project,
        mtime: mtime_ms,
        first_ts: if first_ts != 0.0 { first_ts } else { birth_ms },
        message_count,
        git_branch,
        file: file.to_string(),
    })
}

/// `Date.parse` for the ISO 8601 timestamps the CLI writes
/// (`2026-10-09T12:34:56.789Z`, an offset, or a bare date).
pub fn parse_date_ms(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = s.get(from..from + len)?;
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok())?
    };
    let year = num(0, 4)?;
    let (mut month, mut day) = (1, 1);
    let mut i = 4;
    if b.get(i) == Some(&b'-') {
        month = num(5, 2)?;
        i = 7;
        if b.get(i) == Some(&b'-') {
            day = num(8, 2)?;
            i = 10;
        }
    }
    let (mut hour, mut minute, mut second, mut millis, mut offset_min) = (0, 0, 0, 0.0, 0);
    if matches!(b.get(i), Some(b'T' | b't' | b' ')) {
        hour = num(i + 1, 2)?;
        if b.get(i + 3) != Some(&b':') {
            return None;
        }
        minute = num(i + 4, 2)?;
        i += 6;
        if b.get(i) == Some(&b':') {
            second = num(i + 1, 2)?;
            i += 3;
            if b.get(i) == Some(&b'.') {
                let digits: String = s[i + 1..].chars().take_while(char::is_ascii_digit).collect();
                if digits.is_empty() {
                    return None;
                }
                let ms: String = digits.chars().chain("000".chars()).take(3).collect();
                millis = ms.parse::<f64>().ok()?;
                i += 1 + digits.len();
            }
        }
        match b.get(i) {
            None => {}
            Some(b'Z' | b'z') if i + 1 == b.len() => {}
            Some(sign @ (b'+' | b'-')) => {
                let h = num(i + 1, 2)?;
                let m = if b.get(i + 3) == Some(&b':') { num(i + 4, 2)? } else { num(i + 3, 2)? };
                offset_min = (h * 60 + m) * if *sign == b'-' { -1 } else { 1 };
            }
            _ => return None,
        }
    } else if i != b.len() {
        return None;
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 24 || minute > 59 || second > 59 {
        return None;
    }
    // Days from 1970-01-01 (Howard Hinnant's days_from_civil).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset_min * 60;
    Some(seconds as f64 * 1000.0 + millis)
}

/// What `blockResultText` gave: the text of a tool result (`Err` where the
/// JavaScript threw).
fn block_result_text(content: Option<&Value>) -> Result<Option<String>, ()> {
    let js = |v: Option<&Value>| match v {
        None => "undefined".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    Ok(match content {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Array(items)) => {
            let mut out = String::new();
            for item in items {
                if item.is_null() {
                    return Err(());
                }
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    // `join` writes null/undefined as nothing.
                    match item.get("text") {
                        None | Some(Value::Null) => {}
                        text => out.push_str(&js(text)),
                    }
                } else {
                    out.push_str(&format!("[{}]", js(item.get("type"))));
                }
            }
            Some(out)
        }
        Some(other) => Some(other.to_string()),
    })
}

/// Rebuilds the conversation of a transcript: user texts, and assistant
/// turns made of text, thinking and tool segments (with their results).
pub fn parse_transcript(raw: &str) -> Vec<TranscriptTurn> {
    parse_transcript_checked(raw).unwrap_or_default()
}

fn parse_transcript_checked(raw: &str) -> Result<Vec<TranscriptTurn>, ()> {
    let mut turns: Vec<TranscriptTurn> = Vec::new();
    // tool_use id → (turn, segment) so a later tool_result fills it in.
    let mut tools: HashMap<String, (usize, usize)> = HashMap::new();
    let mut seq = 0;
    let mut next_id = || {
        seq += 1;
        format!("s{}", seq - 1)
    };
    for line in raw.split('\n') {
        if js_trim(line).is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else { continue };
        if obj.is_null() {
            return Err(());
        }
        if truthy(obj.get("isSidechain")) {
            continue;
        }
        let kind = obj.get("type").and_then(Value::as_str);
        let content = obj.get("message").and_then(|m| m.get("content"));
        match (kind, content) {
            (Some("user"), Some(Value::String(text))) => {
                if !js_trim(text).is_empty() {
                    turns.push(TranscriptTurn { id: next_id(), role: TranscriptRole::User, text: Some(text.clone()), segments: None });
                }
            }
            (Some("user"), Some(Value::Array(blocks))) => {
                let mut user_text = String::new();
                for block in blocks {
                    if block.is_null() {
                        return Err(());
                    }
                    let block_type = block.get("type").and_then(Value::as_str);
                    if block_type == Some("text") && truthy(block.get("text")) {
                        user_text.push_str(block.get("text").and_then(Value::as_str).unwrap_or(""));
                    } else if block_type == Some("tool_result")
                        && truthy(block.get("tool_use_id"))
                        && let Some(&(turn, segment)) = block.get("tool_use_id").and_then(Value::as_str).and_then(|id| tools.get(id))
                    {
                        let result = block_result_text(block.get("content"))?;
                        if let Some(seg) = turns[turn].segments.as_mut().and_then(|s| s.get_mut(segment)) {
                            seg.result = result;
                            seg.result_is_error = Some(truthy(block.get("is_error")));
                        }
                    }
                }
                if !js_trim(&user_text).is_empty() {
                    turns.push(TranscriptTurn { id: next_id(), role: TranscriptRole::User, text: Some(user_text), segments: None });
                }
            }
            (Some("assistant"), Some(Value::Array(blocks))) => {
                let mut segments = Vec::new();
                let mut new_tools = Vec::new();
                for block in blocks {
                    if block.is_null() {
                        return Err(());
                    }
                    let segment = |kind, text: Option<&Value>| TranscriptSegment {
                        kind, text: text.and_then(Value::as_str).map(str::to_string), tool_id: None, name: None, input: None,
                        result: None, result_is_error: None,
                    };
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") if truthy(block.get("text")) => segments.push(segment(TranscriptSegmentKind::Text, block.get("text"))),
                        Some("thinking") if truthy(block.get("thinking")) => {
                            segments.push(segment(TranscriptSegmentKind::Thinking, block.get("thinking")))
                        }
                        Some("tool_use") if truthy(block.get("id")) => {
                            let id = block.get("id").and_then(Value::as_str).map(str::to_string);
                            if let Some(id) = &id {
                                new_tools.push((id.clone(), segments.len()));
                            }
                            segments.push(TranscriptSegment {
                                kind: TranscriptSegmentKind::Tool,
                                text: None,
                                tool_id: id,
                                name: block.get("name").and_then(Value::as_str).map(str::to_string),
                                input: block.get("input").cloned(),
                                result: None,
                                result_is_error: None,
                            });
                        }
                        _ => {}
                    }
                }
                if !segments.is_empty() {
                    let turn = turns.len();
                    turns.push(TranscriptTurn { id: next_id(), role: TranscriptRole::Assistant, text: None, segments: Some(segments) });
                    for (id, segment) in new_tools {
                        tools.insert(id, (turn, segment));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(turns)
}

pub fn read(file: &str) -> Vec<TranscriptTurn> {
    fs::read(file).map(|bytes| parse_transcript(&String::from_utf8_lossy(&bytes))).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn line(v: Value) -> String {
        v.to_string()
    }

    #[test]
    fn dates_parse_like_javascript() {
        assert_eq!(parse_date_ms("1970-01-01T00:00:00.000Z"), Some(0.0));
        assert_eq!(parse_date_ms("2026-10-09T12:34:56.789Z"), Some(1_791_549_296_789.0));
        assert_eq!(parse_date_ms("2026-10-09T12:34:56Z"), Some(1_791_549_296_000.0));
        assert_eq!(parse_date_ms("2026-10-09T09:34:56.7-03:00"), Some(1_791_549_296_700.0));
        assert_eq!(parse_date_ms("2026-10-09"), Some(1_791_504_000_000.0));
        assert_eq!(parse_date_ms("2000-02-29T00:00:00.123456Z"), Some(951_782_400_123.0));
        for bad in ["", "ontem", "2026-13-01", "2026-10-09T25", "2026-10-09Tx"] {
            assert_eq!(parse_date_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn meta_prefers_this_sessions_custom_title() {
        let raw = [
            line(json!({ "type": "ai-title", "aiTitle": "Gerado", "sessionId": "abc" })),
            line(json!({ "type": "custom-title", "customTitle": "De outra", "sessionId": "xyz" })),
            line(json!({ "type": "custom-title", "customTitle": "Meu nome", "sessionId": "abc" })),
            "não é json".into(),
            line(json!({ "type": "user", "cwd": "C:\\proj\\app\\", "gitBranch": "main", "timestamp": "2026-10-09T12:34:56.789Z",
                "message": { "content": "<command>ignorar</command>" } })),
            line(json!({ "type": "user", "isSidechain": true, "message": { "content": "lateral" } })),
            line(json!({ "type": "user", "message": { "content": [{ "type": "image" }, { "type": "text", "text": "  Olá\n\tmundo  " }] } })),
            line(json!({ "type": "assistant", "message": { "content": [] } })),
        ]
        .join("\n");
        let meta = meta_from_content(&raw, "abc", "f.jsonl", "C--proj-app", 5.5, 1.0).unwrap();
        assert_eq!(meta.title, "Meu nome");
        assert_eq!(meta.preview, "Olá mundo");
        assert_eq!((meta.cwd.as_str(), meta.project.as_str()), ("C:\\proj\\app\\", "app"));
        assert_eq!((meta.message_count, meta.first_ts, meta.mtime), (3, 1_791_549_296_789.0, 5.5));
        assert_eq!(meta.git_branch.as_deref(), Some("main"));

        let untitled = line(json!({ "type": "user", "message": { "content": "x".repeat(200) } }));
        let meta = meta_from_content(&untitled, "id", "f", "dir-name", 0.0, 42.0).unwrap();
        assert_eq!((meta.title.len(), meta.preview.len(), meta.first_ts, meta.project.as_str()), (60, 140, 42.0, "dir-name"));
        assert!(meta.git_branch.is_none());
        let empty = line(json!({ "type": "user", "message": { "content": "<cmd/>" } }));
        assert_eq!(meta_from_content(&empty, "id", "f", "d", 0.0, 0.0).unwrap().title, "(sem título)");
        assert!(meta_from_content(&line(json!({ "type": "ai-title", "aiTitle": "só título" })), "id", "f", "d", 0.0, 0.0).is_none());
    }

    #[test]
    fn transcripts_attach_tool_results_to_their_segments() {
        let raw = [
            line(json!({ "type": "user", "message": { "content": "Leia o arquivo" } })),
            line(json!({ "type": "assistant", "message": { "content": [
                { "type": "thinking", "thinking": "vou ler" },
                { "type": "text", "text": "Lendo." },
                { "type": "tool_use", "id": "t1", "name": "Read", "input": { "path": "a.txt" } },
                { "type": "tool_use", "id": "t2", "name": "Bash" },
            ] } })),
            line(json!({ "type": "user", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t1", "content": [{ "type": "text", "text": "conteúdo" }, { "type": "image" }] },
                { "type": "tool_result", "tool_use_id": "t2", "is_error": true, "content": "falhou" },
                { "type": "tool_result", "tool_use_id": "t9", "content": "órfão" },
            ] } })),
            line(json!({ "type": "assistant", "isSidechain": true, "message": { "content": [{ "type": "text", "text": "lateral" }] } })),
            line(json!({ "type": "user", "message": { "content": "   " } })),
        ]
        .join("\r\n");
        let turns = parse_transcript(&raw);
        assert_eq!(serde_json::to_value(&turns).unwrap(), json!([
            { "id": "s0", "role": "user", "text": "Leia o arquivo" },
            { "id": "s1", "role": "assistant", "segments": [
                { "kind": "thinking", "text": "vou ler" },
                { "kind": "text", "text": "Lendo." },
                { "kind": "tool", "toolId": "t1", "name": "Read", "input": { "path": "a.txt" }, "result": "conteúdo[image]", "resultIsError": false },
                { "kind": "tool", "toolId": "t2", "name": "Bash", "result": "falhou", "resultIsError": true },
            ] },
        ]));
        assert!(parse_transcript("null\n").is_empty(), "the JavaScript reader threw on a null line");
    }

    #[test]
    fn list_filters_by_folder_and_sorts_newest_first() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join(".claude").join("projects");
        let write = |dir: &str, name: &str, cwd: &str| {
            let dir = projects.join(dir);
            fs::create_dir_all(&dir).unwrap();
            let content = line(json!({ "type": "user", "cwd": cwd, "message": { "content": format!("em {cwd}") } }));
            fs::write(dir.join(name), content).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        write("C--a", "one.jsonl", "C:\\a");
        write("C--a", "two.jsonl", "C:\\A\\");
        write("C--b", "three.jsonl", "C:\\b");
        write("C--b", "notes.txt", "C:\\b");
        fs::write(projects.join("C--b").join("empty.jsonl"), "").unwrap();
        let domain = SessionsDomain::with_home(home.path().to_path_buf());
        let dir = domain.projects_dir().unwrap();

        let all = list(&dir, None);
        assert_eq!(all.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["three", "two", "one"]);
        assert_eq!(all[0].file, node_path::join(&[&dir, "C--b", "three.jsonl"]));
        let only_a = list(&dir, Some("c:\\a\\"));
        assert_eq!(only_a.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["two", "one"]);
        assert!(list(&node_path::join(&[&dir, "nada"]), None).is_empty());

        assert_eq!(read(&all[0].file)[0].text.as_deref(), Some("em C:\\b"));
        assert!(read(&node_path::join(&[&dir, "nada.jsonl"])).is_empty());
        assert!(fs::remove_file(&all[0].file).is_ok() && !Path::new(&all[0].file).exists());
    }
}
