//! Path strings built the way the Electron main process built them with
//! Node's `path` (`join`, `basename`, `dirname`, `resolve`), so the host
//! returns the same strings: the UI keys editor tabs, tree nodes and git rows
//! by them. Windows rules on Windows, POSIX rules elsewhere.

#[cfg(windows)]
pub const SEP: char = '\\';
#[cfg(not(windows))]
pub const SEP: char = '/';

pub fn is_sep(c: char) -> bool {
    c == '/' || (cfg!(windows) && c == '\\')
}

/// Length of the device part (`C:` or `\\server\share`) and whether the
/// path is absolute after it.
#[cfg(windows)]
fn root(path: &str) -> (usize, bool) {
    let bytes = path.as_bytes();
    let sep = |i: usize| bytes.get(i).is_some_and(|&b| b == b'\\' || b == b'/');
    if sep(0) {
        if !sep(1) {
            return (0, true);
        }
        // `\\server\share`: both parts must be present to form a device.
        let mut i = 2;
        let server = i;
        while i < bytes.len() && !sep(i) {
            i += 1;
        }
        if i == server || i == bytes.len() {
            return (0, true);
        }
        let mut j = i + 1;
        while j < bytes.len() && sep(j) {
            j += 1;
        }
        let share = j;
        while j < bytes.len() && !sep(j) {
            j += 1;
        }
        if j == share {
            return (0, true);
        }
        return (j, true);
    }
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return (2, sep(2));
    }
    (0, false)
}

#[cfg(not(windows))]
fn root(path: &str) -> (usize, bool) {
    (0, path.starts_with('/'))
}

/// Node's `normalizeString`: drops empty and `.` segments, applies `..`.
fn normalize_segments(path: &str, allow_above_root: bool) -> String {
    let mut out: Vec<&str> = Vec::new();
    for segment in path.split(is_sep) {
        match segment {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|last| *last != "..") {
                    out.pop();
                } else if allow_above_root {
                    out.push("..");
                }
            }
            other => out.push(other),
        }
    }
    out.join(&SEP.to_string())
}

/// `path.normalize`.
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let (device_len, absolute) = root(path);
    let device: String = path[..device_len].chars().map(|c| if is_sep(c) { SEP } else { c }).collect();
    let mut tail = normalize_segments(&path[device_len..], !absolute);
    let trailing = path.ends_with(is_sep);
    if tail.is_empty() && !absolute {
        tail = ".".into();
    }
    if !tail.is_empty() && trailing {
        tail.push(SEP);
    }
    if absolute {
        format!("{device}{SEP}{tail}")
    } else {
        format!("{device}{tail}")
    }
}

/// `path.join`.
pub fn join(parts: &[&str]) -> String {
    let joined: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if joined.is_empty() {
        return ".".into();
    }
    normalize(&joined.join(&SEP.to_string()))
}

/// `path.basename` (without the suffix argument).
pub fn basename(path: &str) -> String {
    let (device_len, _) = root(path);
    let rest = &path[device_len..];
    let trimmed = rest.trim_end_matches(is_sep);
    match trimmed.rfind(is_sep) {
        Some(i) => trimmed[i + 1..].to_string(),
        None => trimmed.to_string(),
    }
}

/// `path.dirname`.
pub fn dirname(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let (device_len, absolute) = root(path);
    let root_end = device_len + usize::from(absolute && path[device_len..].starts_with(is_sep));
    let body = &path[..path.trim_end_matches(is_sep).len().max(root_end)];
    match body[root_end..].rfind(is_sep) {
        Some(i) => path[..root_end + i].to_string(),
        None if root_end > 0 => path[..root_end].to_string(),
        None => ".".into(),
    }
}

/// `path.isAbsolute`.
pub fn is_absolute(path: &str) -> bool {
    root(path).1
}

/// `path.resolve(base, path)` for an absolute `base`.
pub fn resolve(base: &str, path: &str) -> String {
    let (device_len, absolute) = root(path);
    let resolved = if absolute && device_len > 0 {
        normalize(path)
    } else if absolute {
        // Rooted without a drive (`\x`): keeps the base's drive.
        normalize(&format!("{}{}", &base[..root(base).0], path))
    } else {
        join(&[base, path])
    };
    // Unlike `join`, `resolve` never keeps a trailing separator past the root.
    let (device_len, absolute) = root(&resolved);
    if resolved.len() > device_len + usize::from(absolute) && resolved.ends_with(is_sep) {
        resolved[..resolved.len() - 1].to_string()
    } else {
        resolved
    }
}

/// Lengths and slices in UTF-16 code units, the way JavaScript counts them.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, n)` in UTF-16 units (a surrogate pair is never split).
pub fn utf16_prefix(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// JavaScript's `String.prototype.trim` (Unicode whitespace plus the BOM).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_paths_match_node() {
        assert_eq!(join(&["C:\\a", "b.txt"]), "C:\\a\\b.txt");
        assert_eq!(join(&["C:/a/", "b"]), "C:\\a\\b");
        assert_eq!(join(&["C:\\a\\", "..", "c"]), "C:\\c");
        assert_eq!(join(&["C:\\", "x"]), "C:\\x");
        assert_eq!(join(&["\\\\srv\\share", "x"]), "\\\\srv\\share\\x");
        assert_eq!(normalize("C:\\a\\b\\"), "C:\\a\\b\\");
        assert_eq!(normalize("a\\..\\.."), "..");
        assert_eq!(basename("C:\\a\\b\\"), "b");
        assert_eq!(basename("C:\\"), "");
        assert_eq!(basename("x/y.txt"), "y.txt");
        assert_eq!(dirname("C:\\a\\b"), "C:\\a");
        assert_eq!(dirname("C:\\a"), "C:\\");
        assert_eq!(dirname("C:\\"), "C:\\");
        assert_eq!(dirname("a"), ".");
        assert_eq!(dirname("C:/a/b/"), "C:/a");
        assert!(is_absolute("C:\\x") && is_absolute("\\x") && is_absolute("//srv/share") && !is_absolute("C:x"));
        assert_eq!(resolve("C:\\ws", "..\\other"), "C:\\other");
        assert_eq!(resolve("C:\\ws", "D:\\abs\\"), "D:\\abs");
        assert_eq!(resolve("C:\\ws", "D:\\"), "D:\\");
        assert_eq!(resolve("C:\\ws", "\\rooted"), "C:\\rooted");
        assert_eq!(resolve("C:\\ws", "sub\\"), "C:\\ws\\sub");
    }

    #[cfg(not(windows))]
    #[test]
    fn posix_paths_match_node() {
        assert_eq!(join(&["/a", "b.txt"]), "/a/b.txt");
        assert_eq!(join(&["/a/", "../c"]), "/c");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(dirname("/a/b"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(resolve("/ws", "../x/"), "/x");
    }

    #[test]
    fn utf16_helpers_count_like_javascript() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(utf16_prefix("a😀b", 2), "a");
        assert_eq!(utf16_prefix("a😀b", 3), "a😀");
        assert_eq!(utf16_prefix("abc", 10), "abc");
        assert_eq!(js_trim("\u{feff} x \n"), "x");
    }
}
