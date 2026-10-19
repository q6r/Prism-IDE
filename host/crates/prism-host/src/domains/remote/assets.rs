
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
fn referenced_value(value: &Value, spellings: &[&str]) -> bool {
    match value {
        Value::String(text) => spellings.iter().any(|path| text.contains(path)),
        Value::Array(rows) => rows.iter().any(|row| referenced_value(row, spellings)),
        Value::Object(row) => row.values().any(|value| referenced_value(value, spellings)),
        _ => false,
    }
}
fn decode_image_reference(reference: &str) -> Result<String, HostError> {
    let mut decoded = Vec::with_capacity(reference.len());
    let mut bytes = reference.as_bytes().iter().copied();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let a = bytes.next().and_then(|byte| (byte as char).to_digit(16));
            let b = bytes.next().and_then(|byte| (byte as char).to_digit(16));
            let (Some(a), Some(b)) = (a, b) else { return Err(invalid("Endereço de imagem inválido.")); };
            decoded.push((a * 16 + b) as u8);
        } else { decoded.push(byte); }
    }
    let decoded = String::from_utf8(decoded).map_err(|_| invalid("Endereço de imagem inválido."))?;
    if decoded.chars().any(char::is_control) { return Err(invalid("Endereço de imagem inválido.")); }
    Ok(decoded)
}
fn image_reference(chat: &Value, path: &str) -> bool {
    let Ok(decoded) = decode_image_reference(path) else { return false };
    if decoded.trim().is_empty() { return false; }
    // Markdown normalizes raw Windows backslashes and spaces into URI escapes.
    // Decode only the request spelling: do not decode the stored document and
    // thereby authorize an unmentioned path against an encoded-only reference.
    let spellings = [path, decoded.as_str()];
    turns(chat).any(|turn| {
        turn.get("text").is_some_and(|value| referenced_value(value, &spellings)) ||
        turn.get("segments").and_then(Value::as_array).into_iter().flatten().any(|s| {
            ["text", "result"].iter().any(|key| s.get(key).is_some_and(|value| referenced_value(value, &spellings))) ||
            s.get("input").is_some_and(|i| referenced_value(i, &spellings))
        })
    })
}

/// Decode only after the original Markdown reference has been authorized.
/// The resulting path still goes through `resolve` and its canonical workspace check.
fn image_path(reference: &str) -> Result<String, HostError> {
    let reference = reference.trim();
    let lower = reference.to_ascii_lowercase();
    let raw = if lower.starts_with("file:") {
        let rest = &reference[5..];
        if let Some(rest) = rest.strip_prefix("//") {
            if rest.starts_with('/') { rest }
            else {
                let (host, _) = rest.split_once('/').ok_or_else(|| invalid("Endereço de imagem inválido."))?;
                if !host.eq_ignore_ascii_case("localhost") { return Err(invalid("Compartilhamento de rede não suportado.")); }
                &rest[host.len()..]
            }
        } else { rest }
    } else if lower.starts_with("sandbox:") { &reference[8..] }
    else { reference };
    let raw = raw.split(['?', '#']).next().unwrap_or_default();
    let path = decode_image_reference(raw)?;
    if path.starts_with("//") || path.starts_with("\\\\") {
        return Err(invalid("Endereço de imagem inválido."));
    }
    let path = if path.starts_with('/') && path.as_bytes().get(2) == Some(&b':') && path.as_bytes().get(1).is_some_and(u8::is_ascii_alphabetic) {
        path[1..].to_string()
    } else { path };
    if path.find(':').is_some_and(|index| index != 1 || !path.as_bytes()[0].is_ascii_alphabetic()) {
        return Err(invalid("Endereço de imagem não suportado."));
    }
    Ok(path)
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
    let decoded = image_path(path)?;
    let (_, target) = resolve(chat, &decoded).await?;
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
    #[tokio::test]
    async fn markdown_image_paths_decode_only_after_authorization_and_stay_in_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("modal preview.png"), b"\x89PNG\r\n\x1a\n").await.unwrap();
        let reference = "./modal%20preview.png";
        let chat = json!({"cwd":dir.path(), "turns":[{"text":format!("![Preview]({reference})")} ]});
        assert!(image(&chat, &json!({"path":reference})).await.unwrap()["url"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert!(image(&chat, &json!({"path":"modal preview.png"})).await.is_err(), "the decoded spelling alone was not shared");
        assert!(image(&chat, &json!({"path":"./modal preview.png"})).await.is_err(), "the document's encoded-only reference does not grant the decoded spelling");
        let raw_chat = json!({"cwd":dir.path(), "turns":[{"text":"![Preview](<./modal preview.png>)"}]});
        assert!(image(&raw_chat, &json!({"path":reference})).await.is_ok(), "Markdown's encoded request resolves a raw reference containing spaces");
        let outside = tempfile::tempdir().unwrap();
        tokio::fs::write(outside.path().join("private.png"), b"\x89PNG\r\n\x1a\n").await.unwrap();
        let traversal = format!("../{}/private.png", outside.path().file_name().unwrap().to_string_lossy());
        let traversal = traversal.replace("..", "%2e%2e");
        let chat = json!({"cwd":dir.path(), "turns":[{"text":format!("![Private]({traversal})")} ]});
        assert!(image(&chat, &json!({"path":traversal})).await.is_err(), "a referenced encoded traversal still cannot leave the workspace");
    }
    #[test]
    fn markdown_encoded_windows_request_matches_only_an_existing_reference() {
        // react-markdown turns ![Preview](C:\QA\modal.png) into this src.
        let source = "C:%5CQA%5Cmodal.png";
        let chat = json!({"turns":[{"text":r"![Preview](C:\QA\modal.png)"}]});
        assert!(image_reference(&chat, source));
        assert_eq!(image_path(source).unwrap(), r"C:\QA\modal.png");
        let chat = json!({"turns":[{"segments":[{"kind":"tool", "input":{"nested":{"file_path":r"C:\QA\modal.png"}}}]}]});
        assert!(image_reference(&chat, source));
        assert!(!image_reference(&chat, "C:%5CQA%5Cother.png"));
        assert!(!image_reference(&chat, "C:%5CQA%5Cmodal%00.png"));
        assert!(!image_reference(&chat, "C:%5CQA%5Cmodal%XX.png"));
        let encoded_only = json!({"turns":[{"text":format!("![Preview]({source})")}]});
        assert!(!image_reference(&encoded_only, r"C:\QA\modal.png"));
    }
    #[test]
    fn image_file_urls_decode_spaces_and_reject_network_or_unsafe_schemes() {
        assert_eq!(image_path("file:///C:/project/modal%20preview.png").unwrap(), "C:/project/modal preview.png");
        assert_eq!(image_path("file:///tmp/modal%23preview.png").unwrap(), "/tmp/modal#preview.png");
        assert_eq!(image_path("file://localhost/tmp/modal.png").unwrap(), "/tmp/modal.png");
        assert_eq!(image_path("C:%5cproject%5cmodal.png").unwrap(), "C:\\project\\modal.png");
        assert!(image_path("file://remote/share.png").is_err());
        assert!(image_path("javascript:evil.png").is_err());
        assert!(image_path("bad%XX.png").is_err());
        assert!(image_path("bad%00.png").is_err());
    }
}
