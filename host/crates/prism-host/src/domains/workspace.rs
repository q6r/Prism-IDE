//! `workspace.*`: reading and writing `.prism-workspace` files (a JSON list
//! of root folders, VS Code `.code-workspace` shape) on the host. Choosing
//! the file is the shell's job (a native dialog on the desktop).

use std::fs;
use std::path::Path;

use prism_protocol::fs::{WorkspaceInfo, WorkspaceReadParams, WorkspaceWriteParams};
use prism_protocol::HostError;
use serde_json::{json, Value};

use super::fs::{blocking, io_error, to_json};
use super::node_path;
use crate::domain::{params, CallContext, Domain, HandlerFuture};

pub struct WorkspaceDomain;

impl Domain for WorkspaceDomain {
    fn name(&self) -> &'static str {
        "workspace"
    }

    fn call(&self, method: &str, value: Value, _ctx: CallContext) -> Option<HandlerFuture> {
        Some(match method {
            "read" => Box::pin(async move {
                let file = params::<WorkspaceReadParams>(value)?.file;
                to_json(blocking(move || Ok::<_, HostError>(read(&file))).await?)
            }),
            "write" => Box::pin(async move {
                let p: WorkspaceWriteParams = params(value)?;
                to_json(blocking(move || write(&p.file, &p.folders)).await?)
            }),
            _ => return None,
        })
    }
}

/// The workspace's folders that exist, or `None` when the file cannot be
/// read or is not a workspace. Relative folders are resolved against the
/// file's own folder.
pub fn read(file: &str) -> Option<WorkspaceInfo> {
    let raw = fs::read(file).ok()?;
    let data: Value = serde_json::from_str(&String::from_utf8_lossy(&raw)).ok()?;
    if data.is_null() {
        return None;
    }
    let declared: Vec<String> = match data.get("folders") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("path").and_then(Value::as_str))
            .filter(|p| !p.is_empty())
            .map(str::to_string)
            .collect(),
        Some(_) => return None,
    };
    let dir = node_path::dirname(file);
    let folders = declared
        .into_iter()
        .map(|p| if node_path::is_absolute(&p) { p } else { node_path::resolve(&dir, &p) })
        .filter(|p| fs::metadata(p).is_ok_and(|m| m.is_dir()))
        .collect();
    Some(WorkspaceInfo { file: file.to_string(), folders })
}

/// Saves `folders` as a workspace file; answers its path.
pub fn write(file: &str, folders: &[String]) -> Result<String, HostError> {
    let data = json!({ "folders": folders.iter().map(|p| json!({ "path": p })).collect::<Vec<_>>() });
    let text = serde_json::to_string_pretty(&data).expect("workspace serializes");
    fs::write(Path::new(file), text).map_err(|err| io_error(err, "salvar", file))?;
    Ok(file.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_existing_folders_resolving_relative_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        fs::create_dir_all(dir.path().join("app")).unwrap();
        fs::create_dir_all(dir.path().join("lib")).unwrap();
        let file = node_path::join(&[&root, "x.prism-workspace"]);
        let absolute = node_path::join(&[&root, "lib"]);
        write(&file, &["app".into(), absolute.clone(), "sumiu".into()]).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), format!(
            "{{\n  \"folders\": [\n    {{\n      \"path\": \"app\"\n    }},\n    {{\n      \"path\": {}\n    }},\n    {{\n      \"path\": \"sumiu\"\n    }}\n  ]\n}}",
            serde_json::to_string(&absolute).unwrap()
        ));
        let info = read(&file).unwrap();
        assert_eq!(info.folders, [node_path::join(&[&root, "app"]), absolute]);

        let empty = node_path::join(&[&root, "empty.prism-workspace"]);
        fs::write(&empty, "{\"folders\": null}").unwrap();
        assert_eq!(read(&empty).unwrap().folders, Vec::<String>::new());
        for bad in ["nada", "null", "{\"folders\": \"x\"}"] {
            fs::write(&empty, bad).unwrap();
            assert!(read(&empty).is_none(), "{bad}");
        }
        assert!(read(&node_path::join(&[&root, "missing"])).is_none());
    }
}
