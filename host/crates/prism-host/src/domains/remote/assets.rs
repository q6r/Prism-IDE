
//! Read-only assets scoped to a shared chat. File reads are restricted to paths
//! mentioned by edit tools, images to referenced image paths inside the workspace.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use base64::Engine;
use prism_protocol::{ErrorCode, HostError};
use serde_json::{json, Value};

fn invalid(message: &str) -> HostError { HostError::new(ErrorCode::Invalid, message) }
fn turns(chat: &Value) -> impl Iterator<Item=&Value> {
    chat.get("turns").and_then(Value::as_array).into_iter().flatten()
}
pub fn changes(chat: &Value) -> Value {
    let mut rows: BTreeMap<String, Value> = BTreeMap::new();
    for segment in turns(chat).flat_map(|turn| turn.get("segments").and_then(Value::as_array).into_iter().flatten()) {
        if segment.get("kind").and_then(Value::as_str) != Some("tool") { continue; }
        let name = segment.get("name").and_then(Value::as_str).unwrap_or_default().to_lowercase();
        if !["edit", "write", "patch", "file_change"].iter().any(|term| name.contains(term)) { continue; }
        let Some(input) = segment.get("input") else { continue };
        let path = ["file_path", "path", "notebook_path"].iter().find_map(|key| input.get(key).and_then(Value::as_str));
        if let Some(path) = path {
            rows.insert(path.to_string(), json!({"path": path, "input": input, "result": segment.get("result"), "status": segment.get("status")}));
        }
        if let Some(changes) = input.get("changes") {
            let list: Vec<(String, Value)> = if let Some(items) = changes.as_array() {
                items.iter().filter_map(|item| item.get("path").and_then(Value::as_str).map(|path| (path.into(), item.clone()))).collect()
            } else if let Some(items) = changes.as_object() {
                items.iter().map(|(path, item)| (path.clone(), item.clone())).collect()
            } else { Vec::new() };
            for (path, detail) in list {
                rows.insert(path.clone(), json!({"path": path, "input": detail, "result": segment.get("result"), "status": segment.get("status")}));
            }
        }
    }
    json!(rows.into_values().collect::<Vec<_>>())
}

async fn resolve(chat: &Value, value: &str) -> Result<(PathBuf, PathBuf), HostError> {
    let cwd = chat.get("cwd").and_then(Value::as_str).ok_or_else(|| invalid("Pasta indisponível."))?;
    let root = tokio::fs::canonicalize(cwd).await.map_err(|_| invalid("Pasta indisponível."))?;
    let raw = Path::new(value);
    let candidate = if raw.is_absolute() { raw.to_path_buf() } else { root.join(raw) };
    let target = tokio::fs::canonicalize(candidate).await.map_err(|_| invalid("Arquivo indisponível."))?;
    if !target.starts_with(&root) { return Err(HostError::new(ErrorCode::Forbidden, "Arquivo fora da pasta compartilhada.")); }
    Ok((root, target))
}
fn referenced_value(value: &Value, path: &str) -> bool {
    match value {
        Value::String(text) => text.contains(path),
        Value::Array(rows) => rows.iter().any(|row| referenced_value(row, path)),
        Value::Object(row) => row.values().any(|value| referenced_value(value, path)),
        _ => false,
    }
}
fn image_reference(chat: &Value, path: &str) -> bool {
    turns(chat).any(|turn| {
        turn.get("text").and_then(Value::as_str).is_some_and(|text| text.contains(path)) ||
        turn.get("segments").and_then(Value::as_array).into_iter().flatten().any(|s| {
            ["text", "result"].iter().any(|key| s.get(key).and_then(Value::as_str).is_some_and(|text| text.contains(path))) ||
            s.get("input").is_some_and(|i| referenced_value(i, path))
        })
    })
}
pub async fn image(chat: &Value, payload: &Value) -> Result<Value, HostError> {
    if let Some(index) = payload.get("index").and_then(Value::as_u64) {
        let owner = if let Some(id) = payload.get("queueId").and_then(Value::as_str) {
            chat.get("queued").and_then(Value::as_array).and_then(|rows| rows.iter().find(|row| row.get("id").and_then(Value::as_str) == Some(id)))
        } else {
            turns(chat).find(|turn| turn.get("id") == payload.get("turnId")).and_then(|turn| {
                if let Some(id) = payload.get("toolId").and_then(Value::as_str) {
                    turn.get("segments").and_then(Value::as_array).and_then(|rows| rows.iter().find(|row| row.get("toolId").and_then(Value::as_str) == Some(id)))
                } else { Some(turn) }
            })
        };
        let image = owner.and_then(|owner| owner.get("images")).and_then(Value::as_array).and_then(|images| images.get(index as usize))
            .ok_or_else(|| HostError::new(ErrorCode::Gone, "Imagem não está mais disponível."))?;
        let mime = image.get("mime").and_then(Value::as_str).unwrap_or_default();
        let data = image.get("data").and_then(Value::as_str).unwrap_or_default();
        if !["image/png", "image/jpeg", "image/gif", "image/webp"].contains(&mime) || data.is_empty() || data.len() > 16 * 1024 * 1024 { return Err(invalid("Imagem inválida.")); }
        return Ok(json!({"url": format!("data:{mime};base64,{data}")}));
    }
    let path = payload.get("path").and_then(Value::as_str).ok_or_else(|| invalid("Imagem inválida."))?;
    if path.len() < 3 || !image_reference(chat, path) { return Err(HostError::new(ErrorCode::Forbidden, "Imagem não pertence à conversa.")); }
    let (_, target) = resolve(chat, path).await?;
    let size = tokio::fs::metadata(&target).await.map_err(|_| invalid("Imagem indisponível."))?.len();
    if size > 12 * 1024 * 1024 { return Err(invalid("Imagem excede 12 MB.")); }
    let bytes = tokio::fs::read(target).await.map_err(|_| invalid("Imagem indisponível."))?;
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { "image/png" }
        else if bytes.starts_with(b"\xff\xd8\xff") { "image/jpeg" }
        else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { "image/gif" }
        else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") { "image/webp" }
        else { return Err(invalid("Formato de imagem não suportado.")); };
    Ok(json!({"path": path, "url": format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))}))
}
pub async fn file(chat: &Value, payload: &Value) -> Result<Value, HostError> {
    let path = payload.get("path").and_then(Value::as_str).ok_or_else(|| invalid("Arquivo inválido."))?;
    let rows = changes(chat);
    let row = rows.as_array().and_then(|rows| rows.iter().find(|row| row.get("path").and_then(Value::as_str) == Some(path))).ok_or_else(|| HostError::new(ErrorCode::Forbidden, "Arquivo não foi alterado nesta conversa."))?;
    match resolve(chat, path).await {
        Ok((root, target)) => {
            if tokio::fs::metadata(&target).await.map_err(|_| invalid("Arquivo indisponível."))?.len() > 4 * 1024 * 1024 {
                return Err(invalid("Arquivo excede 4 MB. Abra no computador para ver todo o conteúdo."));
            }
            let content = tokio::fs::read_to_string(&target).await.map_err(|_| invalid("Arquivo binário; use a visualização no computador."))?;
            let relative = target.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
            let output = tokio::time::timeout(std::time::Duration::from_secs(10), tokio::process::Command::new("git")
                .args(["--no-pager", "diff", "HEAD", "--", &relative]).current_dir(&root).output()).await;
            let diff = output.ok().and_then(Result::ok).filter(|out| out.status.success()).and_then(|out| String::from_utf8(out.stdout).ok()).unwrap_or_default();
            Ok(json!({"path": path, "content": content, "diff": diff, "tool": row}))
        }
        Err(_) => Ok(json!({"path": path, "content": null, "tool": row, "unavailable": true})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn references_load_only_the_owning_chats_images() {
        let chat = json!({"turns":[{"id":"t", "segments":[{"toolId":"image", "images":[{"mime":"image/png", "data":"iVBORw0KGgo="}]}]}]});
        assert_eq!(image(&chat, &json!({"turnId":"t", "toolId":"image", "index":0})).await.unwrap()["url"], "data:image/png;base64,iVBORw0KGgo=");
        assert!(image(&chat, &json!({"turnId":"other", "toolId":"image", "index":0})).await.is_err());
        assert!(image(&chat, &json!({"turnId":"t", "toolId":"other", "index":0})).await.is_err());
    }
    #[tokio::test]
    async fn changed_files_are_full_and_unreferenced_reads_are_denied() {
        let dir = tempfile::tempdir().unwrap();
        let content = (0..1200).map(|i| format!("line-{i}\n")).collect::<String>();
        tokio::fs::write(dir.path().join("changed.txt"), &content).await.unwrap();
        let chat = json!({"cwd":dir.path(), "turns":[{"segments":[{"kind":"tool", "name":"Write", "input":{"file_path":"changed.txt"}}]}]});
        assert_eq!(file(&chat, &json!({"path":"changed.txt"})).await.unwrap()["content"], content);
        assert!(file(&chat, &json!({"path":"other.txt"})).await.is_err());
        assert!(image(&chat, &json!({"path":"../private.png"})).await.is_err());
    }
}
