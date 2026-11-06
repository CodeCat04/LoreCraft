//! The normalized request and events shared by every provider.

use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::sse::SseEvent;

/// What the UI asks for. Conversation content is normalized blocks:
///
/// - `{type:"text", text, cache?, provider?, raw?}`
/// - `{type:"thinking", text, provider?, model?, raw?}`
/// - `{type:"toolCall", id, name, input, invalid?, provider?, model?, raw?}`
/// - `{type:"toolResult", toolCallId, content, isError?}`
/// - `{type:"image", mime, base64}`: a picture for a vision model
/// - `{type:"opaque", provider, model?, raw}`: a provider block we keep only to replay
///
/// `raw` is the provider's own block, returned unchanged when replaying to that same
/// provider. Other providers get the normalized fields instead, and never see `raw`.
/// Anything else in the list is UI bookkeeping and is not sent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamRequest {
    pub stream_id: String,
    pub profile_id: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default)]
    pub tools: Vec<ToolDef>,
    /// `auto` (the default) or `none`. Forced choices do not exist on every provider.
    #[serde(default)]
    pub tool_choice: Option<String>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Ask for JSON matching this schema, where the provider can enforce it.
    #[serde(default)]
    pub json_schema: Option<JsonSchemaSpec>,
    /// Let a growing conversation tail be cached, for multi-turn chat.
    #[serde(default)]
    pub auto_cache: bool,
    /// A stable id for this conversation, used as a provider cache hint.
    #[serde(default)]
    pub cache_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JsonSchemaSpec {
    pub name: String,
    pub schema: Value,
}

// ---- Block helpers ----------------------------------------------------------

pub fn block_type(block: &Value) -> &str {
    block.get("type").and_then(Value::as_str).unwrap_or("")
}

pub fn block_str<'a>(block: &'a Value, key: &str) -> &'a str {
    block.get(key).and_then(Value::as_str).unwrap_or("")
}

/// The block's provider data, if it came from this provider.
pub fn raw_for<'a>(block: &'a Value, provider: &str) -> Option<&'a Value> {
    if block_str(block, "provider") == provider {
        block.get("raw").filter(|raw| !raw.is_null())
    } else {
        None
    }
}

/// Tool input as an object. Providers require one, even if the model sent garbage.
pub fn input_object(block: &Value) -> Value {
    match block.get("input") {
        Some(value) if value.is_object() => value.clone(),
        _ => Value::Object(Map::new()),
    }
}

/// An image block as a `data:` address, for providers that take one.
pub fn image_data_url(block: &Value) -> String {
    format!("data:{};base64,{}", block_str(block, "mime"), block_str(block, "base64"))
}

pub fn has_images(messages: &[Message]) -> bool {
    messages.iter().any(|m| m.content.iter().any(|b| block_type(b) == "image"))
}

/// Keeps a tool id acceptable to the strictest provider when a conversation moves
/// between them. Ids stay paired because the same mapping applies to call and result.
pub fn safe_tool_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    if cleaned.is_empty() {
        "call".to_string()
    } else {
        cleaned
    }
}

// ---- Events -----------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Usage {
    /// All input, including anything read from or written to a cache.
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// Output spent on thinking, where the provider reports it.
    pub reasoning: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Done {
    /// `end_turn`, `tool_use`, `max_tokens`, `pause_turn`, `refusal`, `stop_sequence`,
    /// or `cancelled`.
    pub stop_reason: String,
    /// `{category, explanation, recommendedModel}` for a refusal.
    pub stop_details: Value,
    /// The assistant turn as normalized blocks, ready to store and replay.
    pub content: Vec<Value>,
    pub model: String,
    pub provider: &'static str,
    /// `{from, to}` if a fallback model finished this response.
    pub fallback: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StreamError {
    /// `SERVER_DOWN`, `NO_KEY`, `BAD_KEY`, `UNKNOWN_MODEL`, `NO_MODEL`, `CONTEXT_TOO_LONG`,
    /// `RATE_LIMITED`, `OVERLOADED`, `BILLING`, `BAD_REQUEST`, `IDLE_TIMEOUT`,
    /// `STREAM_BROKEN`, `SERVER_ERROR`, `BAD_URL`, `INTERNAL`.
    pub code: String,
    /// Plain words about what to do. Never contains a key.
    pub message: String,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
}

impl StreamError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable: false,
            retry_after_ms: None,
        }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum AiEvent {
    Thinking(String),
    Text(String),
    /// A tool call began, so the UI can show it before its input finishes.
    ToolStart { id: String, name: String },
    /// A tool call's input is complete. `invalid` holds the raw text if it did not parse.
    ToolCall {
        id: String,
        name: String,
        input: Value,
        invalid: Option<String>,
    },
    Usage(Usage),
    Retrying { attempt: u32, delay_ms: u64, reason: String },
    Fallback { from: String, to: String },
    Done(Done),
    Error(StreamError, Vec<Value>),
}

impl AiEvent {
    pub fn to_json(&self) -> Value {
        match self {
            AiEvent::Thinking(text) => json!({ "type": "thinking", "text": text }),
            AiEvent::Text(text) => json!({ "type": "text", "text": text }),
            AiEvent::ToolStart { id, name } => json!({ "type": "toolStart", "id": id, "name": name }),
            AiEvent::ToolCall { id, name, input, invalid } => {
                let mut value = json!({ "type": "toolCall", "id": id, "name": name, "input": input });
                if let Some(raw) = invalid {
                    value["invalid"] = json!(raw);
                }
                value
            }
            AiEvent::Usage(usage) => json!({
                "type": "usage",
                "inputTokens": usage.input,
                "outputTokens": usage.output,
                "cacheReadTokens": usage.cache_read,
                "cacheWriteTokens": usage.cache_write,
                "reasoningTokens": usage.reasoning,
            }),
            AiEvent::Retrying { attempt, delay_ms, reason } => json!({
                "type": "retrying", "attempt": attempt, "delayMs": delay_ms, "reason": reason,
            }),
            AiEvent::Fallback { from, to } => json!({ "type": "fallback", "from": from, "to": to }),
            AiEvent::Done(done) => json!({
                "type": "done",
                "stopReason": done.stop_reason,
                "stopDetails": done.stop_details,
                "content": done.content,
                "model": done.model,
                "provider": done.provider,
                "fallback": done.fallback,
            }),
            AiEvent::Error(error, partial) => json!({
                "type": "error",
                "code": error.code,
                "message": error.message,
                "partial": partial,
            }),
        }
    }
}

/// Turns one provider's stream into normalized events.
pub trait Decoder: Send {
    fn on_event(&mut self, event: &SseEvent) -> Vec<AiEvent>;
    /// The provider has said the response is complete, so reading can stop.
    fn finished(&self) -> bool;
    /// The stream is over. Returns `Done` if the response was complete. Returns nothing
    /// if it was cut off, and the transport reports that with `partial`.
    fn finish(&mut self) -> Vec<AiEvent>;
    /// What has arrived so far, as blocks that are safe to store and replay.
    fn partial(&self) -> Vec<Value>;
    /// A response that is not SSE at all. Returns false if it is not understood.
    fn on_whole_body(&mut self, _body: &str) -> Option<Vec<AiEvent>> {
        None
    }
}

/// A provider's error details, for deciding whether a request can be relaxed and sent again.
#[derive(Debug, Clone, Default)]
pub struct Rejection {
    pub status: u16,
    pub code: String,
    pub kind: String,
    pub param: String,
    pub message: String,
}

#[cfg(test)]
pub mod testutil {
    use super::*;
    use crate::ai::sse::SseParser;

    /// Runs a recorded stream through a decoder, split into chunks of this many bytes.
    pub fn decode(decoder: &mut dyn Decoder, stream: &str, chunk_size: usize) -> Vec<AiEvent> {
        let mut parser = SseParser::new();
        let mut out = Vec::new();
        for chunk in stream.as_bytes().chunks(chunk_size.max(1)) {
            for event in parser.feed(chunk) {
                out.extend(decoder.on_event(&event));
            }
        }
        if let Some(event) = parser.finish() {
            out.extend(decoder.on_event(&event));
        }
        out.extend(decoder.finish());
        out
    }

    pub fn joined_text(events: &[AiEvent]) -> String {
        events
            .iter()
            .filter_map(|e| if let AiEvent::Text(t) = e { Some(t.as_str()) } else { None })
            .collect()
    }

    pub fn joined_thinking(events: &[AiEvent]) -> String {
        events
            .iter()
            .filter_map(|e| if let AiEvent::Thinking(t) = e { Some(t.as_str()) } else { None })
            .collect()
    }

    pub fn done_of(events: &[AiEvent]) -> &Done {
        events
            .iter()
            .find_map(|e| if let AiEvent::Done(d) = e { Some(d) } else { None })
            .expect("a done event")
    }

    /// The same stream must decode identically however it was split.
    pub fn assert_split_independent(make: &dyn Fn() -> Box<dyn Decoder>, stream: &str) -> Vec<AiEvent> {
        let whole = decode(make().as_mut(), stream, usize::MAX);
        for size in [1, 2, 3, 7, 64] {
            assert_eq!(decode(make().as_mut(), stream, size), whole, "chunk size {size}");
        }
        whole
    }
}
