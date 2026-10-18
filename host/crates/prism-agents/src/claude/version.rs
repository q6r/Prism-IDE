//! Claude Code versions the native protocol was verified against: one
//! directory of recorded contracts per version in `host/fixtures/claude/`.
//! Other versions still run (best effort), with a warning.

/// Keep in step with the fixture directories (a test checks it).
pub const VERIFIED: &[&str] = &["2.1.289"];

pub const UNVERIFIED_WARNING: &str = "Versão do Claude Code não verificada com o Prism";

/// The `x.y.z` in `claude --version` output ("2.1.289 (Claude Code)").
pub fn parse(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|word| {
        let core = word.split(['-', '+']).next()?;
        let parts: Vec<&str> = core.split('.').collect();
        (parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))).then(|| word.to_string())
    })
}

pub fn verified(version: &str) -> bool {
    VERIFIED.contains(&version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_parse_from_the_cli_banner() {
        assert_eq!(parse("2.1.289 (Claude Code)").as_deref(), Some("2.1.289"));
        assert_eq!(parse("claude 2.2.0-beta.1").as_deref(), Some("2.2.0-beta.1"));
        assert_eq!(parse("Claude Code"), None);
    }

    #[test]
    fn every_verified_version_has_its_contracts() {
        let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/claude");
        let mut recorded: Vec<String> = std::fs::read_dir(&fixtures).unwrap().flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        recorded.sort();
        let mut listed: Vec<String> = VERIFIED.iter().map(|s| s.to_string()).collect();
        listed.sort();
        assert_eq!(recorded, listed);
    }
}
