//! Stable chat image numbers and native attachments for later `#image N` mentions.
use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Value, json};

const MAX_NUMBER: u64 = 9_007_199_254_740_991;
const INVALID_NUMBER: &str =
    "Use um número inteiro positivo para referenciar uma imagem, por exemplo #image 1.";

#[derive(Clone, Debug)]
pub(crate) struct ImageReference<'a> {
    pub number: u64,
    pub image: &'a Value,
}

fn number(image: &Value) -> Option<u64> {
    image
        .get("number")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0 && *n <= MAX_NUMBER)
}

fn same_image(a: &Value, b: &Value) -> bool {
    a.get("mime") == b.get("mime") && a.get("data") == b.get("data")
}

fn historical_images(chat: &Value) -> Vec<&Value> {
    let mut images = Vec::new();
    if let Some(turns) = chat.get("turns").and_then(Value::as_array) {
        for turn in turns {
            images.extend(
                turn.get("images")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten(),
            );
            if let Some(segments) = turn.get("segments").and_then(Value::as_array) {
                for segment in segments {
                    images.extend(
                        segment
                            .get("images")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten(),
                    );
                }
            }
        }
    }
    images
}

fn images_in(chat: &Value) -> Vec<&Value> {
    let mut images = historical_images(chat);
    if let Some(queued) = chat.get("queued").and_then(Value::as_array) {
        for row in queued {
            images.extend(
                row.get("images")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten(),
            );
        }
    }
    images
}

pub(crate) fn collect_chat_images<'a>(
    chat: &'a Value,
    pending: &'a [Value],
) -> Vec<ImageReference<'a>> {
    let images = images_in(chat)
        .into_iter()
        .chain(pending.iter())
        .collect::<Vec<_>>();
    let reserved = images
        .iter()
        .filter_map(|image| number(image))
        .collect::<BTreeSet<_>>();
    let mut catalog = Vec::<ImageReference<'a>>::new();
    let mut next = 1;
    for image in images.iter().copied() {
        if let Some(number) = number(image) {
            if !catalog.iter().any(|reference| reference.number == number) {
                catalog.push(ImageReference { number, image });
            }
        } else if !catalog
            .iter()
            .any(|reference| same_image(reference.image, image))
        {
            if let Some(assigned) = images
                .iter()
                .find(|other| number(other).is_some() && same_image(other, image))
                .and_then(|other| number(other))
            {
                if !catalog.iter().any(|reference| reference.number == assigned) {
                    catalog.push(ImageReference {
                        number: assigned,
                        image,
                    });
                }
                continue;
            }
            while reserved.contains(&next)
                || catalog.iter().any(|reference| reference.number == next)
            {
                next += 1;
            }
            catalog.push(ImageReference {
                number: next,
                image,
            });
            next += 1;
        }
    }
    catalog
}

pub(crate) fn image_reference_number(catalog: &[ImageReference<'_>], image: &Value) -> Option<u64> {
    number(image).or_else(|| {
        catalog
            .iter()
            .find(|reference| same_image(reference.image, image))
            .map(|reference| reference.number)
    })
}

/// Existing legacy queue assets retain the number shown before moving, sending or deleting rows.
pub(crate) fn number_existing_images(chat: &Value, images: &[Value]) -> Vec<Value> {
    let catalog = collect_chat_images(chat, &[]);
    images.iter().map(|image| {
        let mut image = image.clone();
        if let Some(number) = image_reference_number(&catalog, &image) { image["number"] = json!(number); }
        image
    }).collect()
}

/// New uploads get numbers beyond every committed or queued image. Old chats stay readable without migration.
pub(crate) fn number_new_images(chat: &Value, added: &[Value]) -> Result<Vec<Value>, String> {
    if added.is_empty() {
        return Ok(Vec::new());
    }
    let catalog = collect_chat_images(chat, &[]);
    let mut assigned_images = catalog
        .iter()
        .map(|reference| (reference.number, reference.image))
        .collect::<Vec<_>>();
    let mut next = catalog
        .iter()
        .map(|reference| reference.number)
        .chain(added.iter().filter_map(number))
        .max()
        .unwrap_or(0);
    let mut result = Vec::with_capacity(added.len());
    for image in added {
        let incoming = if image.get("number").is_some() {
            Some(number(image).ok_or_else(|| INVALID_NUMBER.to_string())?)
        } else {
            None
        };
        let assigned = if let Some(incoming) = incoming.filter(|incoming| {
            assigned_images
                .iter()
                .find(|(number, _)| number == incoming)
                .is_none_or(|(_, existing)| same_image(existing, image))
        }) {
            incoming
        } else {
            next = next
                .checked_add(1)
                .filter(|n| *n <= MAX_NUMBER)
                .ok_or_else(|| INVALID_NUMBER.to_string())?;
            next
        };
        if !assigned_images
            .iter()
            .any(|(number, _)| *number == assigned)
        {
            assigned_images.push((assigned, image));
        }
        let mut numbered = image.clone();
        numbered["number"] = json!(assigned);
        result.push(numbered);
    }
    Ok(result)
}

/// A queued image first used by a reference becomes history before its queue entry can disappear.
pub(crate) fn image_attachments_for_history(
    chat: &Value,
    attached: &[Value],
    resolved: &[Value],
) -> Vec<Value> {
    let catalog = collect_chat_images(chat, attached);
    let historical = historical_images(chat)
        .into_iter()
        .filter_map(|image| image_reference_number(&catalog, image))
        .collect::<BTreeSet<_>>();
    let mut images = attached.to_vec();
    for image in resolved {
        if let Some(number) = image_reference_number(&catalog, image)
            && !historical.contains(&number)
            && !images
                .iter()
                .any(|existing| image_reference_number(&catalog, existing) == Some(number))
        {
            images.push(image.clone());
        }
    }
    images
}

fn prose(text: &str) -> String {
    let mut bytes = text.as_bytes().to_vec();
    let mut offset = 0;
    let mut fence: Option<(u8, usize)> = None;
    for line in text.split_inclusive('\n') {
        let spaces = line.bytes().take_while(|c| *c == b' ').count();
        let trimmed = &line[spaces..];
        let marker = trimmed.as_bytes().first().copied();
        let count = marker
            .map(|marker| trimmed.bytes().take_while(|c| *c == marker).count())
            .unwrap_or(0);
        let delimiter = spaces <= 3 && matches!(marker, Some(b'`' | b'~')) && count >= 3;
        if let Some((open, length)) = fence {
            bytes[offset..offset + line.len()].fill(b' ');
            if delimiter
                && marker == Some(open)
                && count >= length
                && trimmed[count..].trim().is_empty()
            {
                fence = None;
            }
        } else if delimiter && (marker != Some(b'`') || !trimmed[count..].contains('`')) {
            fence = Some((marker.unwrap(), count));
            bytes[offset..offset + line.len()].fill(b' ');
        }
        offset += line.len();
    }
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'`' {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && bytes[index] == b'`' {
            index += 1;
        }
        let length = index - start;
        let mut end = index;
        while end < bytes.len() {
            if bytes[end] != b'`' {
                end += 1;
                continue;
            }
            let close = end;
            while end < bytes.len() && bytes[end] == b'`' {
                end += 1;
            }
            if end - close == length {
                bytes[start..end].fill(b' ');
                index = end;
                break;
            }
        }
    }
    let masked = String::from_utf8(bytes).expect("masked ranges retain UTF-8 boundaries");
    static URL: OnceLock<Regex> = OnceLock::new();
    let urls =
        URL.get_or_init(|| Regex::new(r#"(?i)(?:https?://|mailto:|www\.)[^\s<>"']+"#).unwrap());
    let ranges = urls
        .find_iter(&masked)
        .map(|m| m.range())
        .collect::<Vec<_>>();
    let mut bytes = masked.into_bytes();
    for range in ranges {
        bytes[range].fill(b' ');
    }
    String::from_utf8(bytes).expect("URL ranges retain UTF-8 boundaries")
}

fn references(text: &str) -> Result<Vec<u64>, String> {
    static REFERENCE: OnceLock<Regex> = OnceLock::new();
    let regex = REFERENCE.get_or_init(|| {
        Regex::new(r#"(?i)(?:^|[\s'(\[{"<>:,;!?])#image[ \t]*([-+]?\d+(?:[.,]\d+)?(?:e[-+]?\d+)?)"#)
            .unwrap()
    });
    let text = prose(text);
    let mut found = Vec::new();
    for captures in regex.captures_iter(&text) {
        let token = captures.get(1).unwrap();
        if text[token.end()..]
            .chars()
            .next()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
        {
            continue;
        }
        let after = &text[token.end()..];
        if after.starts_with('/')
            || after.starts_with('\\')
            || after.strip_prefix('.').is_some_and(|s| {
                s.chars()
                    .next()
                    .is_some_and(|c| c.is_alphabetic() || c == '_')
            })
        {
            continue;
        }
        let value = token.as_str();
        let number = value
            .bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| value.parse::<u64>().ok())
            .flatten()
            .filter(|n| *n > 0 && *n <= MAX_NUMBER)
            .ok_or_else(|| INVALID_NUMBER.to_string())?;
        if !found.contains(&number) {
            found.push(number);
        }
    }
    Ok(found)
}

pub(crate) struct ResolvedImages {
    pub images: Vec<Value>,
    pub prompt: String,
}

pub(crate) fn resolve_image_references(
    chat: &Value,
    text: &str,
    attached: &[Value],
) -> Result<ResolvedImages, String> {
    let catalog = collect_chat_images(chat, attached);
    let mut images = Vec::new();
    let mut numbers = Vec::new();
    for image in attached {
        let number =
            image_reference_number(&catalog, image).ok_or_else(|| INVALID_NUMBER.to_string())?;
        if !numbers.contains(&number) {
            numbers.push(number);
            images.push(image.clone());
        }
    }
    for number in references(text)? {
        if numbers.contains(&number) {
            continue;
        }
        let reference = catalog
            .iter()
            .find(|reference| reference.number == number)
            .ok_or_else(|| {
                format!("A imagem #image {number} não foi encontrada nesta conversa.")
            })?;
        let mut image = reference.image.clone();
        image["number"] = json!(number);
        images.push(image);
        numbers.push(number);
    }
    if images.len() > 8 {
        return Err("Envie no máximo 8 imagens por mensagem, incluindo as referências.".into());
    }
    if images
        .iter()
        .map(|image| {
            image
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .len()
        })
        .sum::<usize>()
        > 12 * 1024 * 1024
    {
        return Err("As imagens desta mensagem excedem o limite de 12 MiB. Reduza os anexos ou referências.".into());
    }
    if images.iter().any(|image| {
        !["image/png", "image/jpeg", "image/gif", "image/webp"].contains(
            &image
                .get("mime")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ) || image
            .get("data")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    }) {
        return Err("Anexos inválidos: use PNG, JPEG, GIF ou WebP.".into());
    }
    let prompt = if images.is_empty() {
        text.to_string()
    } else {
        format!(
            "{text}\n\n[Referências de imagens anexadas]\n{}",
            numbers
                .iter()
                .enumerate()
                .map(|(index, number)| format!("Anexo {} = #image {number}", index + 1))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    Ok(ResolvedImages { images, prompt })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(data: &str) -> Value {
        json!({"mime":"image/png","data":data})
    }

    #[test]
    fn old_images_keep_numbers_after_numbered_copies_and_queued_images() {
        let a = image("a");
        let b = image("b");
        let mut copy = b.clone();
        copy["number"] = json!(2);
        let chat = json!({"turns":[{"images":[a,b]},{"segments":[{"images":[copy]}]}],"queued":[{"images":[{"mime":"image/png","data":"future","number":5}]}]});
        let catalog = collect_chat_images(&chat, &[]);
        assert_eq!(
            catalog
                .iter()
                .map(|reference| reference.number)
                .collect::<Vec<_>>(),
            vec![1, 2, 5]
        );
        let new = number_new_images(&chat, &[image("a")]).unwrap();
        assert_eq!(
            new[0]["number"], 6,
            "identical new uploads still get their own number"
        );
    }

    #[test]
    fn restored_numbers_are_preserved_and_conflicts_are_renumbered() {
        let chat = json!({"turns":[{"images":[{"mime":"image/png","data":"one","number":1}]}]});
        let added = vec![
            json!({"mime":"image/png","data":"new","number":1}),
            json!({"mime":"image/png","data":"restored","number":4}),
            image("fresh"),
        ];
        let images = number_new_images(&chat, &added).unwrap();
        assert_eq!(
            images
                .iter()
                .map(|image| image["number"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![5, 4, 6]
        );
    }

    #[test]
    fn only_prose_references_are_interpreted() {
        let text = "Veja #IMAGE2 e #image 1; #image2. `#image3`\n```ts\n#image4\n```\nhttps://example.test/#image5 arquivo#image6 #image7.png #image8/path #image1_foo #image1.2foo";
        assert_eq!(references(text).unwrap(), vec![2, 1]);
        for text in [
            "#image0",
            "#image -1",
            "#image1.5",
            "#image2,5",
            "#image1e2",
            "#image9007199254740992",
        ] {
            assert!(references(text).is_err(), "{text}");
        }
    }

    #[test]
    fn references_resend_bytes_in_mention_order_without_catalog_growth() {
        let chat = json!({"turns":[{"images":[image("one"), image("two")]}]});
        let result =
            resolve_image_references(&chat, "compare #image2 com #image 1 e #image2", &[]).unwrap();
        assert_eq!(
            result
                .images
                .iter()
                .map(|image| image["number"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![2, 1]
        );
        assert_eq!(result.images[0]["data"], "two");
        assert!(
            result
                .prompt
                .ends_with("Anexo 1 = #image 2\nAnexo 2 = #image 1")
        );
        assert_eq!(collect_chat_images(&chat, &[]).len(), 2);
        assert!(resolve_image_references(&chat, "#image3", &[]).is_err());
    }

    #[test]
    fn combined_limits_apply_to_images_loaded_from_history() {
        let images = (1..=9).map(|number| json!({"mime":"image/png","data":format!("image-{number}"),"number":number})).collect::<Vec<_>>();
        let chat = json!({"turns":[{"images":images}]});
        assert!(
            resolve_image_references(
                &chat,
                "#image1 #image2 #image3 #image4 #image5 #image6 #image7 #image8 #image9",
                &[]
            )
            .is_err()
        );
        let huge = json!({"turns":[{"images":[{"mime":"image/png","data":"x".repeat(12 * 1024 * 1024 + 1),"number":1}]}]});
        assert!(resolve_image_references(&huge, "#image1", &[]).is_err());
    }
}
