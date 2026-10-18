//! `search.*`: the Search panel (streamed `search.result`/`search.done`
//! notifications, cancellable) and cross-file "Go to Definition"
//! (`search.findDef`). Same limits and results as `src/main/ipc/search.ts`,
//! with the ripgrep libraries doing the walking and the matching.

use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use prism_protocol::search::{
    DefinitionMatch, FindDefParams, FindDefResult, SearchCancelParams, SearchDone, SearchFileResult, SearchMatch,
    SearchRunParams, SEARCH_DONE, SEARCH_RESULT,
};
use prism_protocol::{HostError, OkResult};
use regex::Regex;
use serde_json::{json, Value};

use super::fs::{blocking, list_files, to_json, LIST_CAP};
use super::node_path::{self, utf16_len, utf16_prefix};
use crate::domain::{params, CallContext, ClientId, Domain, HandlerFuture};

/// Files bigger than this are not searched.
pub const MAX_FILE_SIZE: u64 = 1024 * 1024;
/// Matching lines in one search before it stops (`truncated`).
pub const MAX_RESULTS: u32 = 2000;
pub const MAX_PER_FILE: usize = 200;
/// Characters (UTF-16 units) of a match line sent as its preview.
pub const PREVIEW: usize = 240;
pub const MAX_DEFINITIONS: usize = 40;
/// Lines longer than this are not considered by "Go to Definition".
pub const MAX_DEFINITION_LINE: usize = 400;

type Runs = Arc<Mutex<HashMap<ClientId, Vec<(u64, Arc<AtomicBool>)>>>>;

/// Running searches by client: a newer `search.run` from the same client,
/// `search.cancel` or a disconnect stops them.
#[derive(Default)]
pub struct SearchDomain {
    runs: Runs,
}

impl SearchDomain {
    pub fn new() -> Self {
        Self::default()
    }

    fn cancel(&self, client: ClientId, id: Option<u64>) {
        let mut runs = self.runs.lock().unwrap();
        if let Some(list) = runs.get_mut(&client) {
            list.retain(|(run, flag)| {
                let hit = id.is_none_or(|id| id == *run);
                if hit {
                    flag.store(true, Ordering::Relaxed);
                }
                !hit
            });
            if list.is_empty() {
                runs.remove(&client);
            }
        }
    }
}

impl Domain for SearchDomain {
    fn name(&self) -> &'static str {
        "search"
    }

    fn call(&self, method: &str, value: Value, ctx: CallContext) -> Option<HandlerFuture> {
        match method {
            "run" => {
                let client = ctx.notifier.client;
                let run: Result<SearchRunParams, HostError> = params(value);
                let flag = Arc::new(AtomicBool::new(false));
                if let Ok(run) = &run {
                    // Only the newest search of a client keeps going.
                    self.cancel(client, None);
                    self.runs.lock().unwrap().entry(client).or_default().push((run.id, Arc::clone(&flag)));
                }
                let runs = Arc::clone(&self.runs);
                Some(Box::pin(async move {
                    let run = run?;
                    let notifier = ctx.notifier.clone();
                    let task_flag = Arc::clone(&flag);
                    tokio::task::spawn_blocking(move || {
                        search(&run, &task_flag, |method, params| {
                            notifier.send(method, params);
                        });
                        let mut runs = runs.lock().unwrap();
                        if let Some(list) = runs.get_mut(&client) {
                            list.retain(|(_, flag)| !Arc::ptr_eq(flag, &task_flag));
                            if list.is_empty() {
                                runs.remove(&client);
                            }
                        }
                    });
                    to_json(OkResult { ok: true })
                }))
            }
            "cancel" => {
                let cancel: Result<SearchCancelParams, HostError> =
                    if value.is_null() { Ok(SearchCancelParams::default()) } else { params(value) };
                if let Ok(cancel) = &cancel {
                    self.cancel(ctx.notifier.client, cancel.id);
                }
                Some(Box::pin(async move {
                    cancel?;
                    to_json(OkResult { ok: true })
                }))
            }
            "findDef" => Some(Box::pin(async move {
                let find: FindDefParams = params(value)?;
                to_json(blocking(move || Ok(find_definitions(&find.root, &find.word))).await?)
            })),
            _ => None,
        }
    }

    fn disconnected(&self, client: ClientId) {
        self.cancel(client, None);
    }
}

/// Runs one search to the end (or until `cancel`), handing each file's
/// matches and then the totals to `emit`. Nothing more is emitted once
/// cancelled, not even `search.done`.
pub fn search(run: &SearchRunParams, cancel: &AtomicBool, mut emit: impl FnMut(&str, Value)) {
    let cancelled = || cancel.load(Ordering::Relaxed);
    let mut send = |method: &str, params: Value| {
        if !cancelled() {
            emit(method, params);
        }
    };
    let done = |files: u32, matches: u32, truncated: bool| json!(SearchDone { id: run.id, files, matches, truncated });
    // A line never holds a line break, so such a query matches nothing.
    if run.root.is_empty() || utf16_len(&run.query) < 2 || run.query.contains('\n') {
        send(SEARCH_DONE, done(0, 0, false));
        return;
    }
    let built = RegexMatcherBuilder::new()
        .case_insensitive(!run.case_sensitive)
        .line_terminator(Some(b'\n'))
        .build(&regex::escape(&run.query));
    let Ok(matcher) = built else {
        send(SEARCH_DONE, done(0, 0, false));
        return;
    };
    let mut searcher = SearcherBuilder::new().line_number(true).binary_detection(BinaryDetection::none()).build();
    let (mut files, mut total, mut truncated) = (0u32, 0u32, false);
    for file in list_files(&run.root, LIST_CAP, Some(cancel)) {
        if cancelled() {
            return;
        }
        if total >= MAX_RESULTS {
            truncated = true;
            break;
        }
        let Some(bytes) = searchable(&file.path) else { continue };
        let matches = matches_in(&mut searcher, &matcher, &bytes);
        if matches.is_empty() {
            continue;
        }
        files += 1;
        total += matches.len() as u32;
        let name = node_path::basename(&file.path);
        send(SEARCH_RESULT, json!(SearchFileResult { id: run.id, path: file.path, rel: file.rel, name, matches }));
    }
    send(SEARCH_DONE, done(files, total, truncated));
}

/// The file's bytes when it is small enough and not binary (no NUL byte).
fn searchable(path: &str) -> Option<Vec<u8>> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_SIZE {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    memchr::memchr(0, &bytes).is_none().then_some(bytes)
}

/// The first match of each matching line, up to `MAX_PER_FILE`.
fn matches_in(searcher: &mut Searcher, matcher: &RegexMatcher, bytes: &[u8]) -> Vec<SearchMatch> {
    struct Collect<'m> {
        matcher: &'m RegexMatcher,
        out: Vec<SearchMatch>,
    }
    impl Sink for Collect<'_> {
        type Error = std::io::Error;

        fn matched(&mut self, _: &Searcher, found: &SinkMatch<'_>) -> Result<bool, Self::Error> {
            let line = strip_line_end(found.bytes());
            let start = self.matcher.find(line).ok().flatten().map_or(0, |m| m.start());
            let text = String::from_utf8_lossy(line);
            self.out.push(SearchMatch {
                line: found.line_number().unwrap_or(0) as u32,
                col: utf16_len(&String::from_utf8_lossy(&line[..start])) as u32 + 1,
                preview: utf16_prefix(&text, PREVIEW).to_string(),
            });
            Ok(self.out.len() < MAX_PER_FILE)
        }
    }
    let mut sink = Collect { matcher, out: Vec::new() };
    let _ = searcher.search_slice(matcher, bytes, &mut sink);
    sink.out
}

/// A line as `split(/\r?\n/)` leaves it.
fn strip_line_end(line: &[u8]) -> &[u8] {
    match line.strip_suffix(b"\n") {
        Some(rest) => rest.strip_suffix(b"\r").unwrap_or(rest),
        None => line,
    }
}

/// `text.split(/\r?\n/)`.
fn split_lines(text: &str) -> impl Iterator<Item = &str> {
    let mut pieces = text.split('\n').peekable();
    std::iter::from_fn(move || {
        let piece = pieces.next()?;
        Some(if pieces.peek().is_some() { piece.strip_suffix('\r').unwrap_or(piece) } else { piece })
    })
}

/// Language-agnostic declarations of `word` (mirrors the renderer's
/// codeNav.ts); `\b` is JavaScript's ASCII word boundary.
pub fn definition_regex(word: &str) -> Regex {
    let w = regex::escape(word);
    let b = r"(?-u:\b)";
    let parts = [
        format!(r"(?:async\s+)?function\s*\*?\s*{w}{b}"),
        format!(r"(?:const|let|var)\s+{w}{b}"),
        format!(r"class\s+{w}{b}"),
        format!(r"(?:interface|type|enum|trait|struct)\s+{w}{b}"),
        format!(r"def\s+{w}{b}"),
        format!(r"func\s+(?:\([^)]*\)\s*)?{w}{b}"),
        format!(r"fn\s+{w}{b}"),
        format!(r"{w}\s*[:=]\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)"),
        format!(r"(?:public|private|protected|static|async|get|set|\s)*{w}\s*\([^)]*\)\s*[:{{]"),
    ];
    Regex::new(&format!("(?:{})", parts.join("|"))).expect("definition regex compiles")
}

fn is_identifier(word: &str) -> bool {
    let mut chars = word.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// Where `word` is declared under `root`, in scan order (up to
/// `MAX_DEFINITIONS`). The client puts the matches of the current file first.
pub fn find_definitions(root: &str, word: &str) -> FindDefResult {
    let mut matches = Vec::new();
    if root.is_empty() || !is_identifier(word) {
        return FindDefResult { matches };
    }
    let re = definition_regex(word);
    'files: for file in list_files(root, LIST_CAP, None) {
        if matches.len() >= MAX_DEFINITIONS {
            break;
        }
        let Some(bytes) = searchable(&file.path) else { continue };
        let content = String::from_utf8_lossy(&bytes);
        if !content.contains(word) {
            continue;
        }
        for (i, line) in split_lines(&content).enumerate() {
            if utf16_len(line) > MAX_DEFINITION_LINE || !re.is_match(line) {
                continue;
            }
            let col = line.find(word).map_or(1, |at| utf16_len(&line[..at]) + 1);
            matches.push(DefinitionMatch {
                path: file.path.clone(),
                rel: file.rel.clone(),
                name: node_path::basename(&file.path),
                line: i as u32 + 1,
                col: col as u32,
                preview: utf16_prefix(line, PREVIEW).to_string(),
            });
            if matches.len() >= MAX_DEFINITIONS {
                break 'files;
            }
        }
    }
    FindDefResult { matches }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(files: &[(&str, &str)]) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        for (rel, content) in files {
            let path = dir.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        let root = dir.path().to_string_lossy().into_owned();
        (dir, root)
    }

    fn run(root: &str, query: &str, case_sensitive: bool) -> (Vec<SearchFileResult>, SearchDone) {
        let mut results = Vec::new();
        let mut done = None;
        let params = SearchRunParams { id: 7, root: root.into(), query: query.into(), case_sensitive };
        search(&params, &AtomicBool::new(false), |method, value| {
            match method {
                SEARCH_RESULT => results.push(serde_json::from_value(value).unwrap()),
                SEARCH_DONE => done = Some(serde_json::from_value(value).unwrap()),
                other => panic!("{other}"),
            }
        });
        results.sort_by(|a: &SearchFileResult, b| a.rel.cmp(&b.rel));
        (results, done.expect("search.done"))
    }

    #[test]
    fn finds_lines_with_utf16_columns_and_previews() {
        let (_dir, root) = tree(&[
            ("a.txt", "primeira\r\n😀 Alvo aqui\r\nnada\nALVO de novo"),
            ("sub/b.md", "sem nada"),
            ("bin.dat", "alvo\0binário"),
            ("node_modules/x.js", "alvo"),
        ]);
        let (results, done) = run(&root, "alvo", false);
        assert_eq!(done, SearchDone { id: 7, files: 1, matches: 2, truncated: false });
        assert_eq!(results.len(), 1);
        let file = &results[0];
        assert_eq!((file.id, file.rel.as_str(), file.name.as_str()), (7, "a.txt", "a.txt"));
        assert_eq!(file.path, node_path::join(&[&root, "a.txt"]));
        assert_eq!(file.matches, [
            SearchMatch { line: 2, col: 4, preview: "😀 Alvo aqui".into() },
            SearchMatch { line: 4, col: 1, preview: "ALVO de novo".into() },
        ]);
        let (results, done) = run(&root, "Alvo", true);
        assert_eq!((results[0].matches.len(), done.matches), (1, 1));
    }

    #[test]
    fn short_queries_finish_empty_and_limits_apply() {
        let (_dir, root) = tree(&[("big.txt", &"x\n".repeat(300)), ("long.txt", &format!("{}xx", "a".repeat(300)))]);
        assert_eq!(run(&root, "x", false).1, SearchDone { id: 7, files: 0, matches: 0, truncated: false });
        let (results, done) = run(&root, "xx", false);
        let long = results.iter().find(|r| r.rel == "long.txt").unwrap();
        assert_eq!(long.matches[0].col, 301);
        assert_eq!(utf16_len(&long.matches[0].preview), PREVIEW);
        assert_eq!(done.files, 1);
        let (results, _) = run(&root, "x\n", false);
        assert!(results.is_empty());
        let per_file = run(&root, "x", true);
        assert_eq!(per_file.1.matches, 0, "one character is too short");
        let many = tree(&[("m.txt", &"ab\n".repeat(500))]);
        let (results, _) = run(&many.1, "ab", false);
        assert_eq!(results[0].matches.len(), MAX_PER_FILE);
    }

    #[test]
    fn a_cancelled_search_emits_nothing() {
        let (_dir, root) = tree(&[("a.txt", "alvo")]);
        let params = SearchRunParams { id: 1, root, query: "alvo".into(), case_sensitive: false };
        let mut emitted = 0;
        search(&params, &AtomicBool::new(true), |_, _| emitted += 1);
        assert_eq!(emitted, 0);
    }

    #[test]
    fn total_results_are_capped_and_marked_truncated() {
        let files: Vec<(String, String)> = (0..12).map(|i| (format!("f{i:02}.txt"), "hit\n".repeat(200))).collect();
        let refs: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let (_dir, root) = tree(&refs);
        let (results, done) = run(&root, "hit", false);
        assert_eq!((results.len(), done.matches, done.truncated), (10, MAX_RESULTS, true));
    }

    #[test]
    fn definitions_across_languages() {
        let (_dir, root) = tree(&[
            ("a.ts", "import { alvo } from './b'\nexport function alvo() {}\nconst alvo2 = 1\n"),
            ("b.py", "def alvo(x):\n    return alvo(x)\n"),
            ("c.go", "func (s *S) alvo() {}\n"),
            ("d.rs", "pub fn alvo() {}\nlet x = alvo;\n"),
            ("e.js", "  alvo: async (a) => a,\nclass Alvo {}\n"),
            ("f.ts", "const alvoé = 1\n"),
        ]);
        let mut found: Vec<(String, u32, u32)> =
            find_definitions(&root, "alvo").matches.into_iter().map(|m| (m.rel, m.line, m.col)).collect();
        found.sort();
        assert_eq!(found, [
            ("a.ts".into(), 2, 17),
            ("b.py".into(), 1, 5),
            ("c.go".into(), 1, 13),
            ("d.rs".into(), 1, 8),
            ("e.js".into(), 1, 3),
            ("f.ts".into(), 1, 7),
        ]);
        assert!(find_definitions(&root, "não-ident").matches.is_empty());
        assert!(find_definitions(&root, "1x").matches.is_empty());
        assert!(find_definitions("", "alvo").matches.is_empty());
    }

    #[test]
    fn split_lines_matches_javascript() {
        assert_eq!(split_lines("a\r\nb\nc\r").collect::<Vec<_>>(), ["a", "b", "c\r"]);
        assert_eq!(split_lines("").collect::<Vec<_>>(), [""]);
        assert_eq!(strip_line_end(b"x\r\n"), b"x");
        assert_eq!(strip_line_end(b"x\r"), b"x\r");
    }
}
