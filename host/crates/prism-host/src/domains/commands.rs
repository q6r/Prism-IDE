//! `commands.list`: the `/` commands the Claude CLI can run, for the chat's
//! autocomplete: user and project custom commands (`.claude/commands/*.md`)
//! and skills (`~/.claude/skills/<name>/SKILL.md`). Same discovery as
//! `src/main/ipc/slashCommands.ts`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use prism_protocol::sessions::{CommandsListParams, SlashCommand, SlashCommandSource};
use prism_protocol::HostError;
use regex::Regex;
use serde_json::Value;

use super::fs::{blocking, to_json};
use super::node_path::{js_trim, utf16_prefix};
use crate::domain::{params, CallContext, Domain, HandlerFuture};

pub struct CommandsDomain {
    home: Option<PathBuf>,
}

impl CommandsDomain {
    pub fn new() -> Self {
        Self { home: std::env::home_dir() }
    }

    pub fn with_home(home: PathBuf) -> Self {
        Self { home: Some(home) }
    }
}

impl Default for CommandsDomain {
    fn default() -> Self {
        Self::new()
    }
}

impl Domain for CommandsDomain {
    fn name(&self) -> &'static str {
        "commands"
    }

    fn call(&self, method: &str, value: Value, _ctx: CallContext) -> Option<HandlerFuture> {
        if method != "list" {
            return None;
        }
        let home = self.home.clone();
        Some(Box::pin(async move {
            let p: CommandsListParams = if value.is_null() { CommandsListParams::default() } else { params(value)? };
            to_json(blocking(move || Ok::<_, HostError>(list(home.as_deref(), p.project_dir.as_deref()))).await?)
        }))
    }
}

/// User commands, then skills, then project commands; the first of a name
/// wins. Sorted by name (the client re-sorts with the UI's collation).
pub fn list(home: Option<&Path>, project_dir: Option<&str>) -> Vec<SlashCommand> {
    let mut groups = Vec::new();
    if let Some(home) = home {
        groups.push(read_commands(&home.join(".claude").join("commands"), SlashCommandSource::User));
        groups.push(read_skills(&home.join(".claude").join("skills")));
    }
    if let Some(project) = project_dir.filter(|p| !p.is_empty()) {
        groups.push(read_commands(&Path::new(project).join(".claude").join("commands"), SlashCommandSource::Project));
    }
    let mut all: Vec<SlashCommand> = Vec::new();
    for command in groups.into_iter().flatten() {
        if !all.iter().any(|c| c.name == command.name) {
            all.push(command);
        }
    }
    all.sort_by_key(|c| c.name.to_lowercase());
    all
}

fn read_commands(dir: &Path, source: SlashCommandSource) -> Vec<SlashCommand> {
    let Ok(items) = fs::read_dir(dir) else { return Vec::new() };
    items
        .filter_map(Result::ok)
        .filter_map(|item| {
            let file = item.file_name().to_string_lossy().into_owned();
            let stem = file.strip_suffix(".md")?;
            let description = fs::read(item.path()).map(|raw| frontmatter_description(&String::from_utf8_lossy(&raw))).unwrap_or_default();
            Some(SlashCommand { name: format!("/{stem}"), description, source })
        })
        .collect()
}

fn read_skills(dir: &Path) -> Vec<SlashCommand> {
    let Ok(items) = fs::read_dir(dir) else { return Vec::new() };
    items
        .filter_map(Result::ok)
        // Like Node's Dirent: a linked folder is not a folder.
        .filter(|item| item.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|item| {
            let raw = fs::read(item.path().join("SKILL.md")).ok()?;
            let name = item.file_name().to_string_lossy().into_owned();
            Some(SlashCommand { name: format!("/{name}"), description: frontmatter_description(&String::from_utf8_lossy(&raw)), source: SlashCommandSource::Skill })
        })
        .collect()
}

static FRONTMATTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^---\r?\n([\s\S]*?)\r?\n---").unwrap());
static INLINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?mR)^description:\s*(.+)$").unwrap());
static BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?mR)^description:\s*[|>]\s*\r?\n([\s\S]*?)(?:\r?\n\S|$)").unwrap());

/// `description:` from the YAML frontmatter (inline, or the first line of a
/// `|`/`>` block); without frontmatter, from the first 400 characters.
pub fn frontmatter_description(raw: &str) -> String {
    let body = match FRONTMATTER.captures(raw) {
        Some(found) => found.get(1).map_or("", |m| m.as_str()),
        None => utf16_prefix(raw, 400),
    };
    if let Some(inline) = INLINE.captures(body).and_then(|c| c.get(1)) {
        let value = js_trim(inline.as_str());
        if value != "|" && value != ">" {
            let value = value.strip_prefix(['"', '\'']).unwrap_or(value);
            return value.strip_suffix(['"', '\'']).unwrap_or(value).to_string();
        }
    }
    if let Some(block) = BLOCK.captures(body).and_then(|c| c.get(1)) {
        let first = js_trim(block.as_str()).split('\n').next().unwrap_or("");
        return js_trim(first.strip_suffix('\r').unwrap_or(first)).to_string();
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptions_from_frontmatter() {
        assert_eq!(frontmatter_description("---\r\nname: x\r\ndescription: \"Revisa o código\"\r\n---\r\ncorpo"), "Revisa o código");
        assert_eq!(frontmatter_description("---\ndescription: |\n  Primeira linha\n  segunda\nname: x\n---"), "Primeira linha");
        assert_eq!(frontmatter_description("---\ndescription: >\n  Dobrada\n---\n"), "Dobrada");
        assert_eq!(frontmatter_description("sem frontmatter\ndescription: solto"), "solto");
        assert_eq!(frontmatter_description("---\nname: x\n---\ndescription: fora"), "");
        assert_eq!(frontmatter_description("nada"), "");
    }

    #[test]
    fn lists_user_skill_and_project_commands_once() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let write = |path: PathBuf, content: &str| {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        };
        let claude = home.path().join(".claude");
        write(claude.join("commands").join("review.md"), "---\ndescription: Revisar\n---");
        write(claude.join("commands").join("notes.txt"), "x");
        write(claude.join("skills").join("deploy").join("SKILL.md"), "---\ndescription: Publicar\n---");
        fs::create_dir_all(claude.join("skills").join("empty")).unwrap();
        write(project.path().join(".claude").join("commands").join("review.md"), "---\ndescription: Do projeto\n---");
        write(project.path().join(".claude").join("commands").join("build.md"), "sem descrição");

        let commands = list(Some(home.path()), Some(&project.path().to_string_lossy()));
        let got: Vec<(&str, &str, SlashCommandSource)> =
            commands.iter().map(|c| (c.name.as_str(), c.description.as_str(), c.source)).collect();
        assert_eq!(got, [
            ("/build", "", SlashCommandSource::Project),
            ("/deploy", "Publicar", SlashCommandSource::Skill),
            ("/review", "Revisar", SlashCommandSource::User),
        ]);
        assert!(list(None, None).is_empty());
    }
}
