//! Lines the host writes to the CLI, in the exact shape the Agent SDK writes
//! them (see the recorded `cli.jsonl` contracts).

use serde_json::{Value, json};

/// The first line of every process. The SDK sends an empty system prompt
/// when the caller sets none, which is what Prism's chats have always run with.
pub fn initialize() -> Value {
    json!({"subtype": "initialize", "systemPrompt": [""]})
}

/// A host → CLI control request.
pub fn control_request(request_id: &str, request: Value) -> String {
    json!({"request_id": request_id, "type": "control_request", "request": request}).to_string()
}

/// A user message for the streaming input.
pub fn user_message(text: &str, images: &[Value]) -> String {
    let content = if images.is_empty() {
        json!(text)
    } else {
        let mut blocks = Vec::new();
        if !text.is_empty() { blocks.push(json!({"type": "text", "text": text})); }
        blocks.extend(images.iter().map(|image| json!({"type": "image", "source": {
            "type": "base64", "media_type": image["mime"], "data": image["data"]
        }})));
        json!(blocks)
    };
    json!({"type": "user", "message": {"role": "user", "content": content}, "parent_tool_use_id": null}).to_string()
}

pub fn control_success(request_id: &Value, response: Value) -> String {
    json!({"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": response}}).to_string()
}

pub fn control_error(request_id: &Value, error: &str) -> String {
    json!({"type": "control_response", "response": {"subtype": "error", "request_id": request_id, "error": error}}).to_string()
}

pub fn interrupt() -> Value {
    json!({"subtype": "interrupt"})
}

pub fn set_model(model: &str) -> Value {
    json!({"subtype": "set_model", "model": model})
}

pub fn set_permission_mode(mode: &str) -> Value {
    json!({"subtype": "set_permission_mode", "mode": mode})
}

pub fn rewind_files(user_message_id: &str, dry_run: bool) -> Value {
    json!({"subtype": "rewind_files", "user_message_id": user_message_id, "dry_run": dry_run})
}

pub fn get_usage() -> Value {
    json!({"subtype": "get_usage", "skip_behaviors": true})
}

/// A `can_use_tool` answer. `toolUseID` goes last, as the SDK spreads it.
pub fn allow(updated_input: Option<&Value>, updated_permissions: Option<&Value>, tool_use_id: Option<&Value>) -> Value {
    let mut r = serde_json::Map::new();
    r.insert("behavior".into(), "allow".into());
    if let Some(input) = updated_input {
        r.insert("updatedInput".into(), input.clone());
    }
    if let Some(p) = updated_permissions {
        r.insert("updatedPermissions".into(), p.clone());
    }
    if let Some(id) = tool_use_id {
        r.insert("toolUseID".into(), id.clone());
    }
    Value::Object(r)
}

pub fn deny(message: &str, tool_use_id: Option<&Value>) -> Value {
    let mut r = serde_json::Map::new();
    r.insert("behavior".into(), "deny".into());
    r.insert("message".into(), message.into());
    if let Some(id) = tool_use_id {
        r.insert("toolUseID".into(), id.clone());
    }
    Value::Object(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The shapes of sdk.d.ts (SDKControlInterruptRequest, SDKControlSetModelRequest…).
    #[test]
    fn images_are_native_blocks_in_the_same_user_message() {
        let image = json!({"mime": "image/png", "data": "aGVsbG8="});
        let message: Value = serde_json::from_str(&user_message("describe", &[image])).unwrap();
        assert_eq!(message["message"]["content"], json!([
            {"type": "text", "text": "describe"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aGVsbG8="}}
        ]));
        let image = json!({"mime": "image/png", "data": "aGVsbG8="});
        let only: Value = serde_json::from_str(&user_message("", &[image])).unwrap();
        assert_eq!(only["message"]["content"].as_array().unwrap().len(), 1);
        assert_eq!(only["message"]["content"][0]["type"], "image");
    }
    #[test]
    fn control_requests_match_the_sdk() {
        assert_eq!(control_request("r1", interrupt()), r#"{"request_id":"r1","type":"control_request","request":{"subtype":"interrupt"}}"#);
        assert_eq!(set_model("opus").to_string(), r#"{"subtype":"set_model","model":"opus"}"#);
        assert_eq!(set_permission_mode("plan").to_string(), r#"{"subtype":"set_permission_mode","mode":"plan"}"#);
        assert_eq!(user_message("oi", &[]), r#"{"type":"user","message":{"role":"user","content":"oi"},"parent_tool_use_id":null}"#);
    }
}
