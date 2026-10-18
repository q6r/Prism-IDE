//! Journal records: what goes in (`NewEvent`), what comes out
//! (`EventRecord`), the typed events of `agentJournal.ts` and the streaming
//! buffer that coalesces bursts before they are committed.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Position in the journal. Global and strictly increasing, so it is also a
/// per-chat cursor.
pub type Seq = i64;

/// The events `foldJournal` understands (`JournalEvent` in agentJournal.ts).
/// Stored as the event body, `{"kind": …}`; the fold also tolerates kinds it
/// does not know, which it ignores.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum JournalEvent {
    /// Starts (or restarts) a turn; `turn` is the `SharedTurn` snapshot and
    /// `route` the `provider:profileId` it runs on.
    Begin { turn: Value, route: String },
    Text { text: String },
    Thinking { text: String },
    /// Merged into the turn's `metrics` (`RunMetrics`).
    Metrics { metrics: Map<String, Value> },
    /// A `SharedSegment`; with a `toolId` it replaces the earlier segment
    /// with the same id.
    Segment { segment: Value },
    Session {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Done {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        aborted: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<i64>,
    },
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<i64>,
        /// Why, when the provider said (`cli_auth`: the login is gone); the
        /// fold keeps it as the turn's `errorCode`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
}

impl JournalEvent {
    pub fn kind(&self) -> &'static str {
        match self {
            JournalEvent::Begin { .. } => "begin",
            JournalEvent::Text { .. } => "text",
            JournalEvent::Thinking { .. } => "thinking",
            JournalEvent::Metrics { .. } => "metrics",
            JournalEvent::Segment { .. } => "segment",
            JournalEvent::Session { .. } => "session",
            JournalEvent::Done { .. } => "done",
            JournalEvent::Error { .. } => "error",
        }
    }

    pub fn to_body(&self) -> Value {
        serde_json::to_value(self).expect("journal events always serialize")
    }
}

/// Streaming kinds: worth batching (`text`, `thinking`, `segment`, `metrics`).
pub fn is_streaming_kind(kind: Option<&str>) -> bool {
    matches!(kind, Some("text" | "thinking" | "segment" | "metrics"))
}

/// An event about to be appended. `at` defaults to the host clock when it is
/// committed; `actor` is who caused it (a user id), `None` for the host.
#[derive(Debug, Clone, PartialEq)]
pub struct NewEvent {
    pub chat_id: String,
    pub turn_id: String,
    pub actor: Option<String>,
    pub at: Option<i64>,
    pub body: Value,
}

impl NewEvent {
    pub fn new(chat_id: impl Into<String>, turn_id: impl Into<String>, event: &JournalEvent) -> Self {
        Self::raw(chat_id, turn_id, event.to_body())
    }

    /// Any JSON body; the fold skips kinds it does not know.
    pub fn raw(chat_id: impl Into<String>, turn_id: impl Into<String>, body: Value) -> Self {
        Self { chat_id: chat_id.into(), turn_id: turn_id.into(), actor: None, at: None, body }
    }

    pub fn by(mut self, actor: impl Into<String>) -> Self {
        self.actor = Some(actor.into());
        self
    }

    pub fn at(mut self, at: i64) -> Self {
        self.at = Some(at);
        self
    }

    pub fn kind(&self) -> Option<&str> {
        self.body.get("kind").and_then(Value::as_str)
    }

    pub fn is_streaming(&self) -> bool {
        is_streaming_kind(self.kind())
    }

    fn tool_id(&self) -> Option<&Value> {
        if self.kind() != Some("segment") {
            return None;
        }
        self.body.get("segment")?.get("toolId").filter(|id| crate::fold::truthy(Some(id)))
    }
}

/// A committed event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub seq: Seq,
    pub chat_id: String,
    pub turn_id: String,
    pub actor: Option<String>,
    /// Epoch milliseconds when it was recorded; 0 when unknown (imported
    /// events that predate the column and had no `recordedAt`).
    pub at: i64,
    pub event: Value,
}

impl EventRecord {
    pub fn kind(&self) -> Option<&str> {
        self.event.get("kind").and_then(Value::as_str)
    }

    /// The typed event, when it is one `agentJournal.ts` defines.
    pub fn typed(&self) -> Option<JournalEvent> {
        serde_json::from_value(self.event.clone()).ok()
    }
}

/// Holds a burst of streaming events until it is committed in one
/// transaction (`Store::append_batch`), like the TypeScript repository's
/// pending queue: a later snapshot of the same tool item (`segment` with the
/// same chat, turn and `toolId`) replaces the queued one in place, while text
/// deltas and the order of distinct items are kept.
#[derive(Debug, Default)]
pub struct EventBuffer {
    pending: Vec<NewEvent>,
}

/// Flush once this many events are queued, as the TypeScript repository does.
pub const BUFFER_LIMIT: usize = 500;

impl EventBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queues `event`; true when the caller should flush now: a
    /// non-streaming event (`begin`, `session`, `done`, `error`…) or a full
    /// buffer.
    pub fn push(&mut self, event: NewEvent) -> bool {
        let streaming = event.is_streaming();
        if let Some(id) = event.tool_id() {
            let prior = self
                .pending
                .iter()
                .position(|p| p.chat_id == event.chat_id && p.turn_id == event.turn_id && p.tool_id() == Some(id));
            if let Some(i) = prior {
                self.pending[i] = event;
                return self.pending.len() >= BUFFER_LIMIT;
            }
        }
        self.pending.push(event);
        !streaming || self.pending.len() >= BUFFER_LIMIT
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Everything queued, in order, leaving the buffer empty.
    pub fn take(&mut self) -> Vec<NewEvent> {
        std::mem::take(&mut self.pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn typed_events_match_the_typescript_shape() {
        let done = JournalEvent::Done { aborted: Some(true), at: None };
        assert_eq!(done.to_body(), json!({ "kind": "done", "aborted": true }));
        let session = JournalEvent::Session { session_id: "s".into() };
        assert_eq!(session.to_body(), json!({ "kind": "session", "sessionId": "s" }));
        let back: JournalEvent = serde_json::from_value(json!({ "kind": "error", "message": "x", "at": 5 })).unwrap();
        assert_eq!(back, JournalEvent::Error { message: "x".into(), at: Some(5), code: None });
    }

    #[test]
    fn buffer_coalesces_tool_snapshots_and_asks_to_flush_on_control_events() {
        let seg = |id: &str, text: &str| NewEvent::raw("c", "t", json!({ "kind": "segment", "segment": { "toolId": id, "text": text } }));
        let mut buffer = EventBuffer::new();
        assert!(!buffer.push(seg("message", "a")));
        assert!(!buffer.push(seg("bash", "run")));
        assert!(!buffer.push(seg("message", "ab")));
        assert!(!buffer.push(NewEvent::new("c", "t", &JournalEvent::Text { text: "x".into() })));
        assert_eq!(buffer.len(), 3);
        assert!(buffer.push(NewEvent::new("c", "t", &JournalEvent::Done { aborted: None, at: None })));
        let taken = buffer.take();
        assert_eq!(taken[0].body["segment"]["text"], "ab");
        assert_eq!(taken[1].body["segment"]["toolId"], "bash");
        assert_eq!(taken[3].kind(), Some("done"));
        assert!(buffer.is_empty());
    }

    #[test]
    fn error_code_round_trips_and_is_omitted_when_absent() {
        let with = JournalEvent::Error { message: "x".into(), at: Some(5), code: Some("cli_auth".into()) };
        let body = with.to_body();
        assert_eq!(body, json!({ "kind": "error", "message": "x", "at": 5, "code": "cli_auth" }));
        assert_eq!(serde_json::from_value::<JournalEvent>(body).unwrap(), with);

        let without = JournalEvent::Error { message: "x".into(), at: None, code: None };
        let body = without.to_body();
        assert!(body.get("code").is_none() && body.get("at").is_none(), "{body}");
        assert_eq!(serde_json::from_value::<JournalEvent>(body).unwrap(), without);
    }
}
