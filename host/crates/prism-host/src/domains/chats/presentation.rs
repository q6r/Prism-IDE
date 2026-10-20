//! A small desktop view of tool payloads. The database and journal retain the
//! original bytes; this projection is applied only to outgoing snapshots and
//! deltas. Large output and tool images are ordinary derived cache files.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use prism_protocol::chats::ChatDelta;
use serde_json::{Map, Value, json};

const INLINE_BYTES: usize = 16 * 1024;
const PREVIEW_CHARS: usize = 6000;
const RESTORE_ERROR: &str = "A versão completa desta ferramenta não está disponível. Recarregue a conversa antes de salvar; nenhum conteúdo foi substituído.";

pub(super) struct Presentation {
    directory: Option<PathBuf>,
}

impl Presentation {
    pub(super) fn new(database: Option<&Path>) -> Self {
        Self {
            directory: database.and_then(Path::parent).map(|parent| {
                let directory = parent.join("display-cache");
                std::path::absolute(&directory).unwrap_or(directory)
            }),
        }
    }

    pub(super) fn chat(&self, chat: &mut Value) {
        for turn in chat
            .get_mut("turns")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            self.turn(turn);
        }
        queued_images(chat.get_mut("queued"));
    }

    fn turn(&self, turn: &mut Value) {
        image_keys(turn.get_mut("images"));
        for segment in turn
            .get_mut("segments")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            self.segment(segment);
        }
    }

    pub(super) fn delta(&self, delta: &mut ChatDelta) {
        match delta {
            ChatDelta::Chat(update) => self.chat(&mut update.chat),
            ChatDelta::Turn(update) => self.turn(&mut update.turn),
            ChatDelta::Segment(update) => self.segment(&mut update.segment),
            ChatDelta::Patch(update) => queued_images(update.patch.get_mut("queued")),
            _ => {}
        }
    }

    fn segment(&self, segment: &mut Value) {
        image_keys(segment.get_mut("images"));
        if segment.get("kind").and_then(Value::as_str) != Some("tool") {
            return;
        }
        let Some(fields) = segment.as_object_mut() else {
            return;
        };
        // A delta may already have passed through the projection. Never
        // replace its full-file reference with a cache of its own preview.
        if fields.contains_key("presentation") {
            return;
        }
        let mut metadata = Map::new();
        let streaming = matches!(
            fields.get("status").and_then(Value::as_str),
            Some("running" | "awaiting")
        );
        for (field, path_field) in [("result", "outputPath"), ("input", "inputPath")] {
            let Some(value) = fields.get(field) else {
                continue;
            };
            let serialized;
            let content = if field == "result" && value.is_string() {
                value.as_str().unwrap_or_default()
            } else {
                serialized = value.to_string();
                &serialized
            };
            if content.len() <= INLINE_BYTES {
                continue;
            }
            let preview: String = content.chars().take(PREVIEW_CHARS).collect();
            let size = content.len();
            // Caching each cumulative live output would merely move its
            // quadratic growth from the journal into display-cache. Its
            // complete final output is cached once the tool settles.
            if field == "result" && streaming {
                metadata.insert("resultPending".into(), json!(true));
            } else {
                match self.cache(content.as_bytes(), if field == "input" { "json" } else { "txt" }) {
                    Ok(Some(path)) => {
                        fields.insert(path_field.into(), json!(path));
                    }
                    Ok(None) => {}
                    Err(error) => {
                        tracing::warn!(%error, field, "cache da apresentação da ferramenta indisponível");
                    }
                }
            }
            fields.insert(
                field.into(),
                if field == "input" {
                    json!({"_preview": preview})
                } else {
                    json!(preview)
                },
            );
            metadata.insert(field.into(), json!(true));
            metadata.insert(format!("{field}Bytes"), json!(size));
        }
        // An in-memory test store has no stable cache folder. Keep its image
        // bytes inline; real stores always have a disk path.
        if self.directory.is_some()
            && let Some(images) = fields.get_mut("images").and_then(Value::as_array_mut)
        {
            let mut changed = false;
            for image in images {
                let Some(image) = image.as_object_mut() else {
                    continue;
                };
                let Some(data) = image
                    .get("data")
                    .and_then(Value::as_str)
                    .filter(|data| !data.is_empty())
                else {
                    continue;
                };
                let extension = match image.get("mime").and_then(Value::as_str) {
                    Some("image/png") => "png",
                    Some("image/jpeg") => "jpg",
                    Some("image/gif") => "gif",
                    Some("image/webp") => "webp",
                    _ => "bin",
                };
                let identity = image
                    .get("cacheKey")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| cache_key(data.as_bytes()));
                let cached = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
                    .and_then(|bytes| self.cache(&bytes, extension));
                match cached {
                    Ok(Some(path)) => {
                        image.insert("cachedPath".into(), json!(path));
                    }
                    Ok(None) => unreachable!("the disk cache has a directory"),
                    Err(error) => {
                        tracing::warn!(%error, "imagem da ferramenta não pôde ser colocada no cache");
                        image.insert("cacheError".into(), json!("A imagem original está salva, mas sua prévia não pôde ser carregada."));
                    }
                }
                image.insert("data".into(), json!(""));
                image.insert("cacheKey".into(), json!(identity));
                changed = true;
            }
            if changed {
                metadata.insert("images".into(), json!(true));
            }
        }
        if !metadata.is_empty() {
            metadata.insert("version".into(), json!(1));
            fields.insert("presentation".into(), Value::Object(metadata));
        }
    }

    fn cache(&self, bytes: &[u8], extension: &str) -> io::Result<Option<String>> {
        let Some(directory) = &self.directory else {
            return Ok(None);
        };
        fs::create_dir_all(directory)?;
        let name = format!("{}.{extension}", cache_key(bytes));
        let target = directory.join(name);
        if fs::metadata(&target).is_ok_and(|metadata| metadata.len() == bytes.len() as u64) {
            return Ok(Some(target.to_string_lossy().into_owned()));
        }
        let temporary = directory.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        if let Err(error) = fs::write(&temporary, bytes) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        if let Err(error) = fs::rename(&temporary, &target) {
            let _ = fs::remove_file(&temporary);
            if !fs::metadata(&target).is_ok_and(|metadata| metadata.len() == bytes.len() as u64) {
                return Err(error);
            }
        }
        Ok(Some(target.to_string_lossy().into_owned()))
    }
}

fn cache_key(bytes: &[u8]) -> String {
    let mut first = DefaultHasher::new();
    ("prism-display-a", bytes).hash(&mut first);
    let mut second = DefaultHasher::new();
    ("prism-display-b", bytes).hash(&mut second);
    format!(
        "{:016x}{:016x}-{}",
        first.finish(),
        second.finish(),
        bytes.len()
    )
}

// Raw user/queue attachments retain their bytes. The same compact identity on
// every outgoing image lets clients deduplicate them against cached tool
// images without recalculating hashes or changing #image encounter order.
fn image_keys(images: Option<&mut Value>) {
    for image in images.and_then(Value::as_array_mut).into_iter().flatten() {
        let Some(image) = image.as_object_mut() else {
            continue;
        };
        if let Some(data) = image
            .get("data")
            .and_then(Value::as_str)
            .filter(|data| !data.is_empty())
        {
            let key = cache_key(data.as_bytes());
            image.insert("cacheKey".into(), json!(key));
        }
    }
}

fn queued_images(queued: Option<&mut Value>) {
    for row in queued.and_then(Value::as_array_mut).into_iter().flatten() {
        image_keys(row.get_mut("images"));
    }
}

fn marked(segment: &Value) -> bool {
    segment.get("presentation").is_some()
        || segment.get("outputPath").is_some()
        || segment.get("inputPath").is_some()
        || segment
            .get("images")
            .and_then(Value::as_array)
            .is_some_and(|images| {
                images.iter().any(|image| {
                    image.get("cachedPath").is_some() || image.get("cacheError").is_some()
                })
            })
}

pub(super) fn needs_restore(chat: &Value) -> bool {
    chat.get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|turn| {
            turn.get("segments")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .any(marked)
}

/// A client may save a projected chat after changing unrelated metadata.
/// Restore only from the authoritative database, never a client-supplied path.
/// Moving fields out of `original` avoids another copy of large results/images.
pub(super) fn restore(chat: &mut Value, mut original: Option<Value>) -> Result<(), &'static str> {
    if !needs_restore(chat) {
        return Ok(());
    }
    let original = original.as_mut().ok_or(RESTORE_ERROR)?;
    for turn in chat
        .get_mut("turns")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let turn_id = turn
            .get("id")
            .filter(|id| !id.is_null())
            .ok_or(RESTORE_ERROR)?
            .clone();
        for segment in turn
            .get_mut("segments")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
            .filter(|segment| marked(segment))
        {
            let meta = segment
                .get("presentation")
                .and_then(Value::as_object)
                .filter(|meta| meta.get("version") == Some(&json!(1)))
                .ok_or(RESTORE_ERROR)?;
            let restore_result = meta.get("result") == Some(&Value::Bool(true));
            let restore_input = meta.get("input") == Some(&Value::Bool(true));
            let restore_images = meta.get("images") == Some(&Value::Bool(true));
            if !restore_result && !restore_input && !restore_images {
                return Err(RESTORE_ERROR);
            }
            let tool_id = segment
                .get("toolId")
                .filter(|id| !id.is_null())
                .ok_or(RESTORE_ERROR)?
                .clone();
            let source = original
                .get_mut("turns")
                .and_then(Value::as_array_mut)
                .ok_or(RESTORE_ERROR)?
                .iter_mut()
                .find(|turn| turn.get("id") == Some(&turn_id))
                .and_then(|turn| turn.get_mut("segments"))
                .and_then(Value::as_array_mut)
                .and_then(|segments| {
                    segments
                        .iter_mut()
                        .find(|segment| segment.get("toolId") == Some(&tool_id))
                })
                .and_then(Value::as_object_mut)
                .filter(|source| !source.contains_key("presentation"))
                .ok_or(RESTORE_ERROR)?;
            let fields = segment.as_object_mut().ok_or(RESTORE_ERROR)?;
            for (field, required) in [
                ("result", restore_result),
                ("input", restore_input),
                ("images", restore_images),
            ] {
                if required {
                    let value = source.remove(field).ok_or(RESTORE_ERROR)?;
                    fields.insert(field.into(), value);
                }
            }
            for field in ["presentation", "outputPath", "inputPath"] {
                fields.remove(field);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(segment: Value) -> Value {
        json!({"id":"chat", "turns":[{"id":"turn", "segments":[segment]}]})
    }

    #[test]
    fn small_payloads_and_assistant_text_remain_exact() {
        let mut chat = document(
            json!({"kind":"tool", "toolId":"t", "input":{"command":"pwd"}, "result":"ok"}),
        );
        let expected = chat.clone();
        Presentation::new(None).chat(&mut chat);
        assert_eq!(chat, expected);
        assert!(!needs_restore(&chat));
        let mut text = document(json!({"kind":"text", "text":"x".repeat(INLINE_BYTES * 2)}));
        let expected = text.clone();
        Presentation::new(None).chat(&mut text);
        assert_eq!(text, expected);
    }

    #[test]
    fn memory_store_previews_restore_from_the_original_without_reading_paths() {
        let source = document(
            json!({"kind":"tool", "toolId":"t", "result":"ação🙂".repeat(INLINE_BYTES), "input":{"script":"x".repeat(INLINE_BYTES)}, "images":[{"mime":"image/png", "data":"AA=="}]}),
        );
        let mut projected = source.clone();
        Presentation::new(None).chat(&mut projected);
        let segment = &projected["turns"][0]["segments"][0];
        assert_eq!(
            segment["result"].as_str().unwrap().chars().count(),
            PREVIEW_CHARS
        );
        assert!(segment.get("outputPath").is_none());
        assert_eq!(segment["images"][0]["data"], "AA==");
        assert!(needs_restore(&projected));
        restore(&mut projected, Some(source.clone())).unwrap();
        projected["turns"][0]["segments"][0]["images"][0]
            .as_object_mut()
            .unwrap()
            .remove("cacheKey");
        assert_eq!(projected, source);
    }

    #[test]
    fn disk_cache_preserves_full_text_json_and_image_bytes_and_deduplicates() {
        let directory = tempfile::tempdir().unwrap();
        let source = document(
            json!({"kind":"tool", "toolId":"t", "result":"ação🙂".repeat(INLINE_BYTES), "input":{"script":"x".repeat(INLINE_BYTES)}, "images":[{"mime":"image/png", "data":"AAECAw=="}]}),
        );
        let presentation = Presentation::new(Some(&directory.path().join("prism-host.db")));
        let mut projected = source.clone();
        presentation.chat(&mut projected);
        let tool = &projected["turns"][0]["segments"][0];
        assert_eq!(
            fs::read_to_string(tool["outputPath"].as_str().unwrap()).unwrap(),
            source["turns"][0]["segments"][0]["result"]
                .as_str()
                .unwrap()
        );
        assert_eq!(
            serde_json::from_slice::<Value>(
                &fs::read(tool["inputPath"].as_str().unwrap()).unwrap()
            )
            .unwrap(),
            source["turns"][0]["segments"][0]["input"]
        );
        assert_eq!(
            fs::read(tool["images"][0]["cachedPath"].as_str().unwrap()).unwrap(),
            [0, 1, 2, 3]
        );
        assert_eq!(tool["images"][0]["data"], "");
        assert_eq!(tool["presentation"]["images"], true);
        let expected = projected.clone();
        presentation.chat(&mut projected);
        assert_eq!(
            projected, expected,
            "already projected messages are idempotent"
        );
        let mut again = source.clone();
        presentation.chat(&mut again);
        assert_eq!(again, projected);
        assert_eq!(
            fs::read_dir(directory.path().join("display-cache"))
                .unwrap()
                .count(),
            3
        );
        restore(&mut projected, Some(source.clone())).unwrap();
        assert_eq!(projected, source);
    }

    #[test]
    fn projection_never_accepts_missing_or_forged_sources_for_writeback() {
        let mut projected = document(
            json!({"kind":"tool", "toolId":"t", "result":"short", "outputPath":"C:/do-not-read", "presentation":{"version":1,"result":true}}),
        );
        assert!(restore(&mut projected, None).is_err());
        assert!(
            restore(
                &mut projected,
                Some(document(
                    json!({"kind":"tool","toolId":"other","result":"original"})
                ))
            )
            .is_err()
        );
        projected["turns"][0]["segments"][0]["presentation"] = json!({"version":2,"result":true});
        assert!(
            restore(
                &mut projected,
                Some(document(
                    json!({"kind":"tool","toolId":"t","result":"original"})
                ))
            )
            .is_err()
        );
    }

    #[test]
    fn image_only_and_invalid_image_payloads_are_bounded_without_changing_source() {
        let directory = tempfile::tempdir().unwrap();
        let source = document(
            json!({"kind":"tool", "toolId":"t", "images":[{"mime":"image/png", "data":"invalid!"}]}),
        );
        let mut projected = source.clone();
        Presentation::new(Some(&directory.path().join("host.db"))).chat(&mut projected);
        assert_eq!(
            projected["turns"][0]["segments"][0]["images"][0]["data"],
            ""
        );
        assert!(projected["turns"][0]["segments"][0]["images"][0]["cacheError"].is_string());
        assert!(projected["turns"][0]["segments"][0]["images"][0]["cacheKey"].is_string());
        restore(&mut projected, Some(source.clone())).unwrap();
        assert_eq!(projected, source);
    }

    #[test]
    fn growing_live_output_does_not_accumulate_full_output_cache_files() {
        let directory = tempfile::tempdir().unwrap();
        let presentation = Presentation::new(Some(&directory.path().join("host.db")));
        for size in 1..=12 {
            let mut chat = document(
                json!({"kind":"tool", "toolId":"t", "status":"running", "result":"x".repeat(INLINE_BYTES * size)}),
            );
            presentation.chat(&mut chat);
            let segment = &chat["turns"][0]["segments"][0];
            if size > 1 {
                assert_eq!(segment["presentation"]["resultPending"], true);
                assert!(segment.get("outputPath").is_none());
            }
        }
        assert!(!directory.path().join("display-cache").exists());
        let mut completed = document(
            json!({"kind":"tool", "toolId":"t", "status":"done", "result":"x".repeat(INLINE_BYTES * 12)}),
        );
        presentation.chat(&mut completed);
        assert_eq!(
            fs::read_dir(directory.path().join("display-cache"))
                .unwrap()
                .count(),
            1
        );
        assert!(completed["turns"][0]["segments"][0]["outputPath"].is_string());
    }

    #[test]
    fn whole_chat_turn_and_segment_deltas_use_the_same_bounded_view() {
        use prism_protocol::chats::{ChatUpsert, TurnSegment, TurnUpsert};
        let source =
            document(json!({"kind":"tool", "toolId":"t", "result":"x".repeat(INLINE_BYTES * 3)}));
        let mut deltas = [
            ChatDelta::Chat(ChatUpsert {
                chat: source.clone(),
            }),
            ChatDelta::Turn(TurnUpsert {
                chat_id: "chat".into(),
                turn: source["turns"][0].clone(),
            }),
            ChatDelta::Segment(TurnSegment {
                chat_id: "chat".into(),
                turn_id: "turn".into(),
                segment: source["turns"][0]["segments"][0].clone(),
            }),
        ];
        let presentation = Presentation::new(None);
        for delta in &mut deltas {
            presentation.delta(delta);
            assert!(serde_json::to_vec(delta).unwrap().len() < INLINE_BYTES);
        }
        assert!(
            source["turns"][0]["segments"][0]["result"]
                .as_str()
                .unwrap()
                .len()
                > INLINE_BYTES
        );
    }

    #[test]
    fn raw_and_cached_images_share_identity_in_snapshots_and_new_queue_deltas() {
        use prism_protocol::chats::ChatPatch;
        let directory = tempfile::tempdir().unwrap();
        let image = json!({"mime":"image/png", "data":"AAECAw=="});
        let source = json!({"id":"chat", "turns":[
            {"id":"user", "role":"user", "images":[image.clone()], "segments":[{"kind":"user","images":[image.clone()]}]},
            {"id":"assistant", "segments":[{"kind":"tool","toolId":"tool", "images":[image.clone()]}]}
        ], "queued":[{"images":[image.clone()]}]});
        let mut projected = source.clone();
        let presentation = Presentation::new(Some(&directory.path().join("host.db")));
        presentation.chat(&mut projected);
        let key = projected["turns"][0]["images"][0]["cacheKey"].clone();
        assert!(key.is_string());
        for image in [
            &projected["turns"][0]["segments"][0]["images"][0],
            &projected["turns"][1]["segments"][0]["images"][0],
            &projected["queued"][0]["images"][0],
        ] {
            assert_eq!(image["cacheKey"], key);
        }
        assert_eq!(projected["turns"][0]["images"][0]["data"], "AAECAw==");
        assert_eq!(
            source["turns"][1]["segments"][0]["images"][0]["data"],
            "AAECAw=="
        );
        let mut patch = ChatDelta::Patch(ChatPatch {
            chat_id: "chat".into(),
            patch: json!({"queued":[{"images":[image]}]})
                .as_object()
                .unwrap()
                .clone(),
        });
        presentation.delta(&mut patch);
        let ChatDelta::Patch(patch) = patch else {
            unreachable!()
        };
        assert_eq!(patch.patch["queued"][0]["images"][0]["cacheKey"], key);
        let raw = json!({"turns":[{"id":"u", "images":[projected["turns"][0]["images"][0].clone()]}], "queued":patch.patch["queued"]});
        assert!(
            !needs_restore(&raw),
            "identity alone never marks original bytes as a preview"
        );
    }
}
