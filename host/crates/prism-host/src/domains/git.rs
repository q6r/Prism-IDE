//! `git.*`: the Source Control panel and the diff view, running the `git`
//! executable on the host. Same commands, parsing and result shapes as
//! `src/main/ipc/git.ts` (local mode). `aiCommitMessage` stays in the
//! Electron main process until the Claude domain lands (T06).

use std::path::Path;
use std::process::Stdio;

use prism_protocol::git::{
    GitBranchParams, GitBranches, GitCommitParams, GitDiff, GitDiffParams, GitDiffScope, GitDirParams, GitDiscardParams,
    GitDiscardResult, GitFile, GitFileParams, GitMessage, GitOutput, GitRootParams, GitStats, GitStatus, GitStatusAllParams,
};
use prism_protocol::{ErrorCode, HostError};
use serde_json::Value;
use tokio::process::Command;

use super::fs::{os_trash, to_json, TrashFn};
use super::node_path::{self, js_trim};
use crate::domain::{params, CallContext, Domain, HandlerFuture};

pub struct GitDomain {
    trash: TrashFn,
}

impl GitDomain {
    pub fn new() -> Self {
        Self { trash: os_trash }
    }

    /// With a stand-in trash, so tests never touch the real one.
    pub fn with_trash(trash: TrashFn) -> Self {
        Self { trash }
    }
}

impl Default for GitDomain {
    fn default() -> Self {
        Self::new()
    }
}

impl Domain for GitDomain {
    fn name(&self) -> &'static str {
        "git"
    }

    fn call(&self, method: &str, value: Value, _ctx: CallContext) -> Option<HandlerFuture> {
        let trash = self.trash;
        Some(match method {
            "status" => Box::pin(async move {
                let p: GitDirParams = params(value)?;
                to_json(status(&p.dir, p.stats.unwrap_or(false)).await?)
            }),
            "statusAll" => Box::pin(async move {
                let p: GitStatusAllParams = params(value)?;
                to_json(status_all(&p.folders, p.stats.unwrap_or(false)).await?)
            }),
            "branches" => Box::pin(async move { to_json(branches(&params::<GitRootParams>(value)?.root).await) }),
            "checkout" => Box::pin(async move {
                let p: GitBranchParams = params(value)?;
                to_json(message(git(&p.root, &["checkout", &p.branch]).await))
            }),
            "createBranch" => Box::pin(async move {
                let p: GitBranchParams = params(value)?;
                to_json(message(git(&p.root, &["checkout", "-b", &p.branch]).await))
            }),
            "fetch" => Box::pin(async move {
                let root = params::<GitRootParams>(value)?.root;
                to_json(message(git(&root, &["fetch", "--all", "--prune"]).await))
            }),
            "pull" => Box::pin(async move {
                let root = params::<GitRootParams>(value)?.root;
                to_json(message(git(&root, &["pull", "--ff-only"]).await))
            }),
            "push" => Box::pin(async move { to_json(push(&params::<GitRootParams>(value)?.root).await) }),
            "stage" => Box::pin(async move {
                let p: GitFileParams = params(value)?;
                to_json(git(&p.root, &["add", "--", &p.file]).await)
            }),
            "unstage" => Box::pin(async move {
                let p: GitFileParams = params(value)?;
                to_json(git(&p.root, &["reset", "-q", "HEAD", "--", &p.file]).await)
            }),
            "stageAll" => Box::pin(async move { to_json(git(&params::<GitRootParams>(value)?.root, &["add", "-A"]).await) }),
            "unstageAll" => Box::pin(async move {
                to_json(git(&params::<GitRootParams>(value)?.root, &["reset", "-q", "HEAD", "--"]).await)
            }),
            "discard" => Box::pin(async move { to_json(discard(params(value)?, trash).await) }),
            "commit" => Box::pin(async move {
                let p: GitCommitParams = params(value)?;
                to_json(message(git(&p.root, &["commit", "-m", &p.message]).await))
            }),
            "init" => Box::pin(async move { to_json(git(&params::<GitDirParams>(value)?.dir, &["init"]).await) }),
            "diff" => Box::pin(async move { to_json(diff(params(value)?).await) }),
            _ => return None,
        })
    }
}

/// Runs git in `cwd`. Credential prompts fail fast instead of hanging
/// (`GIT_TERMINAL_PROMPT=0`); a git that cannot start is `code: 1`.
pub async fn git(cwd: &str, args: &[&str]) -> GitOutput {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // The host has no console; without this every git call flashes one.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    match command.output().await {
        Ok(out) => GitOutput {
            code: out.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        },
        Err(err) => GitOutput { code: 1, stdout: String::new(), stderr: err.to_string() },
    }
}

fn message(out: GitOutput) -> GitMessage {
    GitMessage { code: out.code, message: js_trim(&format!("{}{}", out.stdout, out.stderr)).to_string() }
}

/// Parses `git status --porcelain=v1 --branch -z`.
pub fn parse_status(out: &str) -> (String, u32, u32, Vec<GitFile>) {
    let parts: Vec<&str> = out.split('\0').collect();
    let (mut branch, mut ahead, mut behind) = (String::new(), 0, 0);
    let mut files = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let p = parts[i];
        i += 1;
        if p.is_empty() {
            continue;
        }
        if let Some(header) = p.strip_prefix("## ") {
            let name = header.strip_prefix("No commits yet on ").or_else(|| header.strip_prefix("Initial commit on ")).unwrap_or(header);
            branch = name.split("...").next().unwrap_or("").split(' ').next().unwrap_or("").to_string();
            ahead = count_after(header, "ahead ").unwrap_or(0);
            behind = count_after(header, "behind ").unwrap_or(0);
            continue;
        }
        let x = p.get(0..1).unwrap_or("").to_string();
        let y = p.get(1..2).unwrap_or("").to_string();
        let path = p.get(3..).unwrap_or("").to_string();
        let untracked = x == "?" && y == "?";
        let staged = !untracked && x != " ";
        let orig_path = if format!("{x}{y}").contains(['R', 'C']) {
            let orig = parts.get(i).map(|s| s.to_string());
            i += 1;
            orig.filter(|s| !s.is_empty())
        } else {
            None
        };
        files.push(GitFile { path, orig_path, x, y, staged, untracked, staged_stats: None, working_stats: None });
    }
    (branch, ahead, behind, files)
}

/// The number after the first `label` (`ahead 2`).
fn count_after(text: &str, label: &str) -> Option<u32> {
    let mut rest = text;
    while let Some(at) = rest.find(label) {
        let after = &rest[at + label.len()..];
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            return digits.parse().ok();
        }
        rest = after;
    }
    None
}

/// Parses `git diff --numstat -z`; a rename record is `a\td\t\0src\0dst\0`
/// and is keyed by the destination.
pub fn parse_numstat(out: &str) -> Vec<(String, GitStats)> {
    let parts: Vec<&str> = out.split('\0').collect();
    let mut stats = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let part = parts[i];
        let mut fields = part.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) = (fields.next(), fields.next(), fields.next()) else {
            i += 1;
            continue;
        };
        let count = |s: &str| s == "-" || (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
        if !count(added) || !count(deleted) {
            i += 1;
            continue;
        }
        let path = if path.is_empty() {
            i += 2;
            parts.get(i).copied().unwrap_or("")
        } else {
            path
        };
        let binary = added == "-" && deleted == "-";
        if !path.is_empty() {
            let n = |s: &str| if binary { 0 } else { s.parse().unwrap_or(0) };
            stats.push((path.to_string(), GitStats { insertions: n(added), deletions: n(deleted), binary }));
        }
        i += 1;
    }
    stats
}

fn stats_for(stats: &[(String, GitStats)], path: &str) -> Option<GitStats> {
    stats.iter().rev().find(|(p, _)| p == path).map(|(_, s)| *s)
}

pub async fn status(dir: &str, with_stats: bool) -> Result<GitStatus, HostError> {
    let top = git(dir, &["rev-parse", "--show-toplevel"]).await;
    if top.code != 0 {
        return Ok(GitStatus { is_repo: false, root: None, branch: None, ahead: None, behind: None, files: None });
    }
    let root = js_trim(&top.stdout).to_string();
    let st = git(&root, &["status", "--porcelain=v1", "--branch", "--untracked-files=all", "-z"]).await;
    if st.code != 0 {
        let reason = js_trim(&st.stderr);
        return Err(HostError::new(
            ErrorCode::Internal,
            if reason.is_empty() { "Não foi possível carregar o status Git".to_string() } else { reason.to_string() },
        ));
    }
    let (branch, ahead, behind, mut files) = parse_status(&st.stdout);
    if with_stats && !files.is_empty() {
        // Per-file +/− for the changed-files rows.
        let (cached, working) =
            tokio::join!(git(&root, &["diff", "--cached", "--numstat", "-z"]), git(&root, &["diff", "--numstat", "-z"]));
        let staged = if cached.code == 0 { parse_numstat(&cached.stdout) } else { Vec::new() };
        let unstaged = if working.code == 0 { parse_numstat(&working.stdout) } else { Vec::new() };
        for file in &mut files {
            file.staged_stats = stats_for(&staged, &file.path);
            file.working_stats = stats_for(&unstaged, &file.path);
        }
    }
    Ok(GitStatus { is_repo: true, root: Some(root), branch: Some(branch), ahead: Some(ahead), behind: Some(behind), files: Some(files) })
}

/// Every folder's repository once (a multi-root workspace with two folders
/// in one repo shows it once).
pub async fn status_all(folders: &[String], with_stats: bool) -> Result<Vec<GitStatus>, HostError> {
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for folder in folders {
        let st = status(folder, with_stats).await?;
        if let Some(root) = st.root.clone().filter(|_| st.is_repo)
            && !seen.contains(&root)
        {
            seen.push(root);
            out.push(st);
        }
    }
    Ok(out)
}

pub async fn branches(root: &str) -> GitBranches {
    let mut current = git(root, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
    if current.code != 0 {
        current = git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await;
    }
    let local = git(root, &["for-each-ref", "--format=%(refname:short)", "refs/heads"]).await;
    let remote = git(root, &["for-each-ref", "--format=%(refname:short)", "refs/remotes"]).await;
    let lines = |s: &str| -> Vec<String> { s.split('\n').map(js_trim).filter(|l| !l.is_empty()).map(str::to_string).collect() };
    GitBranches {
        current: js_trim(&current.stdout).to_string(),
        local: lines(&local.stdout),
        // Real remote branches only: not the remote HEAD symref ("origin")
        // nor "origin/HEAD".
        remote: lines(&remote.stdout).into_iter().filter(|b| b.contains('/') && !b.ends_with("/HEAD")).collect(),
    }
}

/// Pushes the current branch, setting its upstream when it has none.
pub async fn push(root: &str) -> GitMessage {
    let mut out = git(root, &["push"]).await;
    let stderr = out.stderr.to_lowercase();
    if out.code != 0 && (stderr.contains("has no upstream branch") || stderr.contains("set-upstream")) {
        let current = git(root, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
        out = git(root, &["push", "--set-upstream", "origin", js_trim(&current.stdout)]).await;
    }
    message(out)
}

/// A status path that names one file inside the repository: never absolute,
/// a folder, or with `.`/`..` segments.
fn discardable(file: &str) -> bool {
    let absolute = file.starts_with(['/', '\\']) || (file.len() >= 2 && file.as_bytes()[0].is_ascii_alphabetic() && file.as_bytes()[1] == b':');
    !file.is_empty() && !absolute && !file.ends_with(['/', '\\']) && !file.split(['/', '\\']).any(|part| part == "." || part == "..")
}

/// Tracked files are restored from the index; untracked ones go to the
/// trash (never deleted outright), with the failure reported.
pub async fn discard(p: GitDiscardParams, trash: TrashFn) -> GitDiscardResult {
    let fail = |message: &str| GitDiscardResult { code: 1, message: Some(message.to_string()), stdout: None, stderr: None };
    if !p.untracked {
        let out = git(&p.root, &["checkout", "--", &p.file]).await;
        return GitDiscardResult { code: out.code, message: None, stdout: Some(out.stdout), stderr: Some(out.stderr) };
    }
    if !discardable(&p.file) {
        return fail("Caminho inválido para descartar arquivo");
    }
    let target = node_path::join(&[&p.root, &p.file]);
    let outcome = tokio::task::spawn_blocking(move || {
        let meta = std::fs::symlink_metadata(&target).map_err(|err| err.to_string())?;
        if meta.is_dir() {
            return Ok(false);
        }
        trash(Path::new(&target)).map(|()| true)
    })
    .await;
    match outcome {
        Ok(Ok(true)) => GitDiscardResult { code: 0, message: None, stdout: None, stderr: None },
        Ok(Ok(false)) => fail("Selecione um arquivo para descartar"),
        Ok(Err(reason)) if !reason.is_empty() => fail(&reason),
        _ => fail("Não foi possível mover o arquivo para a lixeira"),
    }
}

/// Both sides of a file's diff. `staged`: HEAD → index; `working`: index →
/// disk (HEAD when the path is not in the index); none: HEAD → disk.
pub async fn diff(p: GitDiffParams) -> GitDiff {
    let show = |rev: &'static str| {
        let path = if rev == "HEAD" { p.orig_path.clone().unwrap_or_else(|| p.file.clone()) } else { p.file.clone() };
        let root = p.root.clone();
        async move {
            let out = git(&root, &["show", &format!("{rev}:{path}")]).await;
            (out.code == 0).then_some(out.stdout)
        }
    };
    if p.scope == Some(GitDiffScope::Staged) {
        let original = if p.untracked { String::new() } else { show("HEAD").await.unwrap_or_default() };
        return GitDiff { original, modified: show("").await.unwrap_or_default() };
    }
    let original = if p.untracked {
        String::new()
    } else if p.scope == Some(GitDiffScope::Working) {
        match show("").await {
            Some(index) => index,
            None => show("HEAD").await.unwrap_or_default(),
        }
    } else {
        show("HEAD").await.unwrap_or_default()
    };
    let modified = tokio::fs::read(node_path::join(&[&p.root, &p.file]))
        .await
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    GitDiff { original, modified }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn status_parsing_matches_the_ipc_contract() {
        assert_eq!(parse_status("## No commits yet on main\0"), ("main".into(), 0, 0, vec![]));
        let (branch, ahead, behind, _) = parse_status("## main...origin/main [ahead 2, behind 3]\0");
        assert_eq!((branch.as_str(), ahead, behind), ("main", 2, 3));
        assert_eq!(parse_status("## HEAD (no branch)\0").0, "HEAD");

        let (_, _, _, files) = parse_status("## main\0R  new.txt\0old.txt\0M  other.txt\0?? n.txt\0C  c.txt\0s.txt\0");
        let file = |path: &str, orig: Option<&str>, x: &str, y: &str, staged: bool, untracked: bool| GitFile {
            path: path.into(), orig_path: orig.map(Into::into), x: x.into(), y: y.into(), staged, untracked,
            staged_stats: None, working_stats: None,
        };
        assert_eq!(files, [
            file("new.txt", Some("old.txt"), "R", " ", true, false),
            file("other.txt", None, "M", " ", true, false),
            file("n.txt", None, "?", "?", false, true),
            file("c.txt", Some("s.txt"), "C", " ", true, false),
        ]);
        let json = serde_json::to_value(&files[1]).unwrap();
        assert_eq!(json, serde_json::json!({ "path": "other.txt", "x": "M", "y": " ", "staged": true, "untracked": false }));
    }

    #[test]
    fn numstat_parsing_keys_renames_by_destination() {
        let stats = parse_numstat("5\t3\tfile.txt\0-\t-\timg.png\x002\t1\t\0src.txt\0dst.txt\0");
        assert_eq!(stats_for(&stats, "file.txt"), Some(GitStats { insertions: 5, deletions: 3, binary: false }));
        assert_eq!(stats_for(&stats, "img.png"), Some(GitStats { insertions: 0, deletions: 0, binary: true }));
        assert_eq!(stats_for(&stats, "dst.txt"), Some(GitStats { insertions: 2, deletions: 1, binary: false }));
        assert_eq!(stats_for(&stats, "src.txt"), None);
    }

    #[test]
    fn only_plain_relative_files_can_be_discarded() {
        for bad in ["", "/abs/path.txt", "C:\\drive\\path.txt", "\\x", "folder/", "folder\\", "../escape.txt", "a/../b.txt", "./a"] {
            assert!(!discardable(bad), "{bad}");
        }
        for ok in ["a.txt", "src/a.txt", "src\\a.txt", "..a", "a..b/c"] {
            assert!(discardable(ok), "{ok}");
        }
    }

    // ---- against real temporary repositories ----

    struct Repo {
        _dir: tempfile::TempDir,
        root: String,
    }

    impl Repo {
        async fn new() -> Repo {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().to_string_lossy().into_owned();
            let repo = Repo { _dir: dir, root };
            assert_eq!(repo.run(&["init", "-q", "-b", "main"]).await.code, 0);
            // Independent of the user's global config (signing, hooks, line endings).
            for (key, value) in [
                ("user.name", "Prism QA"), ("user.email", "qa@prism.test"), ("commit.gpgsign", "false"),
                ("core.autocrlf", "false"), ("core.hooksPath", "no-hooks"),
            ] {
                repo.run(&["config", key, value]).await;
            }
            repo
        }

        async fn run(&self, args: &[&str]) -> GitOutput {
            git(&self.root, args).await
        }

        fn write(&self, rel: &str, content: &str) {
            let path = Path::new(&self.root).join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }

        fn path(&self, rel: &str) -> String {
            node_path::join(&[&self.root, rel])
        }
    }

    fn canonical(path: &str) -> std::path::PathBuf {
        std::fs::canonicalize(path).unwrap()
    }

    #[tokio::test]
    async fn status_of_an_unborn_branch_and_outside_a_repo() {
        let repo = Repo::new().await;
        repo.write("dir/deep/new.txt", "x");
        let st = status(&repo.root, true).await.unwrap();
        assert!(st.is_repo);
        assert_eq!(canonical(st.root.as_deref().unwrap()), canonical(&repo.root));
        assert_eq!(st.branch.as_deref(), Some("main"));
        let files = st.files.unwrap();
        assert_eq!(files.len(), 1, "--untracked-files=all lists the file, not the folder");
        assert_eq!((files[0].path.as_str(), files[0].untracked, files[0].staged), ("dir/deep/new.txt", true, false));

        let outside = tempfile::tempdir().unwrap();
        let st = status(&outside.path().to_string_lossy(), false).await.unwrap();
        assert_eq!(serde_json::to_value(st).unwrap(), serde_json::json!({ "isRepo": false }));
        let missing = status(&repo.path("nope"), false).await.unwrap();
        assert!(!missing.is_repo);
    }

    #[tokio::test]
    async fn stage_commit_rename_stats_and_diff_scopes() {
        let repo = Repo::new().await;
        repo.write("a.txt", "um\ndois\n");
        repo.write("old.txt", "velho\n");
        assert_eq!(repo.run(&["add", "-A"]).await.code, 0);
        let commit = message(repo.run(&["commit", "-m", "inicial"]).await);
        assert_eq!(commit.code, 0, "{}", commit.message);

        repo.write("a.txt", "um\ndois\ntrês\n");
        assert_eq!(git(&repo.root, &["add", "--", "a.txt"]).await.code, 0);
        repo.write("a.txt", "um\ntrês\n");
        assert_eq!(repo.run(&["mv", "old.txt", "new.txt"]).await.code, 0);

        let st = status(&repo.root, true).await.unwrap();
        let files = st.files.unwrap();
        let a = files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!((a.x.as_str(), a.y.as_str()), ("M", "M"));
        assert_eq!(a.staged_stats, Some(GitStats { insertions: 1, deletions: 0, binary: false }));
        assert_eq!(a.working_stats, Some(GitStats { insertions: 0, deletions: 1, binary: false }));
        let renamed = files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!((renamed.x.as_str(), renamed.orig_path.as_deref()), ("R", Some("old.txt")));
        assert!(status(&repo.root, false).await.unwrap().files.unwrap().iter().all(|f| f.staged_stats.is_none()));

        let d = |scope, file: &str, orig: Option<&str>| GitDiffParams {
            root: repo.root.clone(), file: file.into(), untracked: false, scope, orig_path: orig.map(Into::into),
        };
        assert_eq!(diff(d(Some(GitDiffScope::Staged), "a.txt", None)).await, GitDiff { original: "um\ndois\n".into(), modified: "um\ndois\ntrês\n".into() });
        assert_eq!(diff(d(Some(GitDiffScope::Working), "a.txt", None)).await, GitDiff { original: "um\ndois\ntrês\n".into(), modified: "um\ntrês\n".into() });
        assert_eq!(diff(d(None, "a.txt", None)).await, GitDiff { original: "um\ndois\n".into(), modified: "um\ntrês\n".into() });
        assert_eq!(diff(d(Some(GitDiffScope::Staged), "new.txt", Some("old.txt"))).await, GitDiff { original: "velho\n".into(), modified: "velho\n".into() });
        repo.write("u.txt", "novo");
        let untracked = GitDiffParams { untracked: true, ..d(None, "u.txt", None) };
        assert_eq!(diff(untracked).await, GitDiff { original: String::new(), modified: "novo".into() });

        assert_eq!(git(&repo.root, &["reset", "-q", "HEAD", "--"]).await.code, 0);
        assert!(status(&repo.root, false).await.unwrap().files.unwrap().iter().all(|f| !f.staged));

        let all = status_all(&[repo.root.clone(), repo.path("."), repo.root.clone()], false).await.unwrap();
        assert_eq!(all.len(), 1, "one repository, listed once");
    }

    #[tokio::test]
    async fn branches_checkout_and_push_without_upstream() {
        let repo = Repo::new().await;
        repo.write("a.txt", "x");
        repo.run(&["add", "-A"]).await;
        repo.run(&["commit", "-qm", "c"]).await;
        let created = message(git(&repo.root, &["checkout", "-b", "feature"]).await);
        assert_eq!(created.code, 0);
        assert!(created.message.contains("feature"));
        let b = branches(&repo.root).await;
        assert_eq!(b.current, "feature");
        assert_eq!(b.local, ["feature", "main"]);
        assert!(b.remote.is_empty());

        // A bare "origin" to push to; the first push sets the upstream.
        let remote = tempfile::tempdir().unwrap();
        let remote_path = remote.path().to_string_lossy().into_owned();
        assert_eq!(git(&remote_path, &["init", "-q", "--bare"]).await.code, 0);
        repo.run(&["remote", "add", "origin", &remote_path]).await;
        let pushed = push(&repo.root).await;
        assert_eq!(pushed.code, 0, "{}", pushed.message);
        let b = branches(&repo.root).await;
        assert_eq!(b.remote, ["origin/feature"]);
        let fetched = message(git(&repo.root, &["fetch", "--all", "--prune"]).await);
        assert_eq!(fetched.code, 0, "{}", fetched.message);
    }

    static TRASHED: Mutex<Vec<String>> = Mutex::new(Vec::new());

    fn fake_trash(path: &Path) -> Result<(), String> {
        TRASHED.lock().unwrap().push(path.to_string_lossy().into_owned());
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }

    #[tokio::test]
    async fn discard_restores_tracked_and_trashes_untracked_files() {
        let repo = Repo::new().await;
        repo.write("t.txt", "original");
        repo.run(&["add", "-A"]).await;
        repo.run(&["commit", "-qm", "c"]).await;
        repo.write("t.txt", "mudado");
        let tracked = discard(GitDiscardParams { root: repo.root.clone(), file: "t.txt".into(), untracked: false }, fake_trash).await;
        assert_eq!(tracked.code, 0);
        assert_eq!(std::fs::read_to_string(repo.path("t.txt")).unwrap(), "original");

        repo.write("sub/u.txt", "novo");
        let p = |file: &str| GitDiscardParams { root: repo.root.clone(), file: file.into(), untracked: true };
        assert_eq!(discard(p("sub/u.txt"), fake_trash).await, GitDiscardResult { code: 0, message: None, stdout: None, stderr: None });
        assert!(TRASHED.lock().unwrap().contains(&repo.path("sub/u.txt")));
        assert_eq!(discard(p("sub"), fake_trash).await.message.as_deref(), Some("Selecione um arquivo para descartar"));
        assert_eq!(discard(p("../x"), fake_trash).await.message.as_deref(), Some("Caminho inválido para descartar arquivo"));
        let missing = discard(p("sumiu.txt"), fake_trash).await;
        assert_eq!(missing.code, 1);
        assert!(missing.message.is_some_and(|m| !m.is_empty()));
    }

    #[tokio::test]
    async fn a_missing_git_or_folder_is_code_one() {
        let out = git(&format!("{}{}nope-{}", std::env::temp_dir().display(), node_path::SEP, std::process::id()), &["status"]).await;
        assert_eq!(out.code, 1);
        assert!(!out.stderr.is_empty());
    }
}
