//! The Anthropic Messages API, over raw HTTP because Rust has no official SDK.
//!
//! Rules that shape this file, from the current API docs:
//! - `temperature`, `top_p` and `top_k` return a 400 on this API version, so they are
//!   never sent. Neither are `budget_tokens`, a forced `tool_choice`, or assistant prefill.
//! - Thinking blocks are tied to the conversation that produced them: the system prompt,
//!   tools and every earlier message must stay as they were. So stored blocks replay
//!   their `raw` form unchanged, and the caller keeps history append-only.
//! - A refusal is an HTTP 200 with `stop_reason: "refusal"`. Check it before using output.
//! - With `eager_input_streaming`, the API stops validating tool input. A parse failure
//!   is reported to the caller rather than treated as a usable call.

use serde_json::{json, Map, Value};

use super::profile::Profile;
use super::sse::SseEvent;
use super::transport::Prepared;
use super::types::*;

pub const API_VERSION: &str = "2026-10-21";
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
pub const PROVIDER: &str = "anthropic";

/// Models from before adaptive thinking and effort, which reject those fields.
fn is_legacy(model: &str) -> bool {
    const LEGACY: [&str; 10] = [
        "claude-2",
        "claude-3",
        "claude-instant",
        "claude-opus-4-0",
        "claude-opus-4-1",
        "claude-opus-4-5",
        "claude-sonnet-4-0",
        "claude-sonnet-4-5",
        "claude-haiku-4-5",
        "claude-opus-4-2",
    ];
    LEGACY.iter().any(|prefix| model.starts_with(prefix)) || model.starts_with("claude-sonnet-4-2")
}

/// `fallbacks: "default"` is documented for these models only. It is not offered for
/// Claude Haiku 5.5 or anything older.
fn accepts_default_fallbacks(model: &str) -> bool {
    const MODELS: [&str; 4] = ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];
    MODELS.iter().any(|id| model == *id || model.strip_prefix(id).is_some_and(|rest| rest.starts_with("-2")))
}

fn supports_structured_output(model: &str) -> bool {
    // Opus 4.7, Opus 4.6 and Sonnet 4.6 are not in the documented list, so they get text
    // extraction. A few older models are, despite predating adaptive thinking.
    const UNLISTED: [&str; 3] = ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"];
    const OLD_BUT_LISTED: [&str; 3] = ["claude-haiku-4-5", "claude-opus-4-5", "claude-opus-4-1"];
    if UNLISTED.iter().any(|prefix| model.starts_with(prefix)) {
        return false;
    }
    !is_legacy(model) || OLD_BUT_LISTED.iter().any(|prefix| model.starts_with(prefix))
}

fn effort_for(model: &str, effort: &str) -> Option<String> {
    if !matches!(effort, "low" | "medium" | "high" | "xhigh" | "max") {
        return None;
    }
    // `xhigh` arrived after the 4.6 family.
    if effort == "xhigh" && (model.starts_with("claude-opus-4-6") || model.starts_with("claude-sonnet-4-6")) {
        return Some("high".to_string());
    }
    Some(effort.to_string())
}

/// Normalized messages to the wire format. `raw` blocks replay byte for byte.
pub fn wire_messages(messages: &[Message]) -> Vec<Value> {
    // At most four cache breakpoints are allowed per request, so only the newest marked
    // block keeps its marker. Moving a marker does not invalidate thinking blocks.
    let last_marked = messages
        .iter()
        .enumerate()
        .flat_map(|(m, message)| {
            message
                .content
                .iter()
                .enumerate()
                .filter(|(_, b)| b.get("cache").and_then(Value::as_bool) == Some(true))
                .map(move |(b, _)| (m, b))
        })
        .last();

    let mut out = Vec::new();
    for (m, message) in messages.iter().enumerate() {
        let mut content = Vec::new();
        for (b, block) in message.content.iter().enumerate() {
            let mut wire = match block_type(block) {
                "text" => {
                    let text = block_str(block, "text");
                    if text.is_empty() {
                        continue; // The API refuses empty text blocks.
                    }
                    match raw_for(block, PROVIDER) {
                        Some(raw) => raw.clone(),
                        None => json!({ "type": "text", "text": text }),
                    }
                }
                // Another provider's thinking cannot be read here, so it is not sent.
                "thinking" | "opaque" => match raw_for(block, PROVIDER) {
                    Some(raw) => raw.clone(),
                    None => continue,
                },
                "toolCall" => match raw_for(block, PROVIDER) {
                    Some(raw) => raw.clone(),
                    None => json!({
                        "type": "tool_use",
                        "id": safe_tool_id(block_str(block, "id")),
                        "name": block_str(block, "name"),
                        "input": input_object(block),
                    }),
                },
                "toolResult" => {
                    let mut wire = json!({
                        "type": "tool_result",
                        "tool_use_id": safe_tool_id(block_str(block, "toolCallId")),
                        "content": block_str(block, "content"),
                    });
                    if block.get("isError").and_then(Value::as_bool) == Some(true) {
                        wire["is_error"] = json!(true);
                    }
                    wire
                }
                "image" => json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": block_str(block, "mime"),
                        "data": block_str(block, "base64"),
                    },
                }),
                _ => continue,
            };
            if last_marked == Some((m, b)) {
                wire["cache_control"] = json!({ "type": "ephemeral" });
            }
            content.push(wire);
        }
        if !content.is_empty() {
            out.push(json!({ "role": message.role, "content": content }));
        }
    }
    out
}

pub fn build(
    request: &StreamRequest,
    profile: &Profile,
    model: &str,
    key: Option<&str>,
    first_party: bool,
) -> Result<Prepared, StreamError> {
    let root = profile.api_root()?;
    let max_tokens = request.max_tokens.or(profile.max_tokens).unwrap_or_else(|| profile.default_max_tokens());
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("max_tokens".into(), json!(max_tokens));
    body.insert("stream".into(), json!(true));

    if !is_legacy(model) {
        // A readable summary, since the default looks like a long silent pause.
        body.insert("thinking".into(), json!({ "type": "adaptive", "display": "summarized" }));
    }
    let mut output_config = Map::new();
    if !is_legacy(model) {
        let effort = request.effort.as_deref().or(profile.effort.as_deref());
        if let Some(effort) = effort.and_then(|e| effort_for(model, e)) {
            output_config.insert("effort".into(), json!(effort));
        }
    }
    if let Some(spec) = &request.json_schema {
        if supports_structured_output(model) {
            output_config.insert("format".into(), json!({ "type": "json_schema", "schema": spec.schema }));
        }
    }
    if !output_config.is_empty() {
        body.insert("output_config".into(), Value::Object(output_config));
    }

    // Render order is tools, then system, then messages. The marker on the last system
    // block caches the tools and system together.
    if let Some(system) = request.system.as_deref().filter(|s| !s.is_empty()) {
        body.insert(
            "system".into(),
            json!([{ "type": "text", "text": system, "cache_control": { "type": "ephemeral" } }]),
        );
    }
    if !request.tools.is_empty() {
        let mut tools = request.tools.clone();
        tools.sort_by(|a, b| a.name.cmp(&b.name));
        let wire: Vec<Value> = tools
            .iter()
            .map(|t| {
                let mut tool = json!({ "name": t.name, "description": t.description, "input_schema": t.input_schema });
                // Gateways in front of the API may refuse this field.
                if first_party {
                    tool["eager_input_streaming"] = json!(true);
                }
                tool
            })
            .collect();
        body.insert("tools".into(), Value::Array(wire));
        let choice = if request.tool_choice.as_deref() == Some("none") { "none" } else { "auto" };
        body.insert("tool_choice".into(), json!({ "type": choice }));
    }
    body.insert("messages".into(), Value::Array(wire_messages(&request.messages)));
    if request.auto_cache && first_party {
        body.insert("cache_control".into(), json!({ "type": "ephemeral" }));
    }

    let mut headers = vec![("anthropic-version".to_string(), API_VERSION.to_string())];
    if let Some(key) = key {
        headers.push(("x-api-key".to_string(), key.to_string()));
    }
    if first_party && accepts_default_fallbacks(model) {
        body.insert("fallbacks".into(), json!("default"));
        headers.push(("anthropic-beta".to_string(), FALLBACK_BETA.to_string()));
    }
    Ok(Prepared {
        url: format!("{root}/v1/messages"),
        headers,
        body: Value::Object(body),
    })
}

/// Removes every thinking block from a request's history. True if there were any.
fn strip_thinking(body: &mut Map<String, Value>) -> bool {
    let mut changed = false;
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages.iter_mut() {
            if let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) {
                let before = content.len();
                content.retain(|block| !matches!(block_type(block), "thinking" | "redacted_thinking"));
                changed |= content.len() != before;
            }
        }
        messages.retain(|message| message["content"].as_array().is_none_or(|c| !c.is_empty()));
    }
    changed
}

/// Drops a field a model or gateway refused, if the request still makes sense without it.
pub fn relax(prepared: &mut Prepared, rejection: &Rejection) -> bool {
    let message = rejection.message.to_ascii_lowercase();
    let Some(body) = prepared.body.as_object_mut() else {
        return false;
    };
    // Thinking is tied to the exact conversation that produced it. If that no longer holds,
    // as when an older chat outlives a change to the app's instructions, the documented
    // recovery is to send the history without thinking. Everything else in it stays.
    if message.contains("signature") && message.contains("thinking") {
        return strip_thinking(body);
    }
    if message.contains("fallbacks") && body.remove("fallbacks").is_some() {
        prepared.headers.retain(|(name, _)| name != "anthropic-beta");
        return true;
    }
    if message.contains("anthropic-beta") && prepared.headers.iter().any(|(n, _)| n == "anthropic-beta") {
        prepared.headers.retain(|(name, _)| name != "anthropic-beta");
        body.remove("fallbacks");
        return true;
    }
    if message.contains("eager_input_streaming") {
        let mut changed = false;
        if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
            for tool in tools {
                changed |= tool.as_object_mut().and_then(|t| t.remove("eager_input_streaming")).is_some();
            }
        }
        return changed;
    }
    if message.contains("output_config.format") || message.contains("structured output") {
        if let Some(config) = body.get_mut("output_config").and_then(Value::as_object_mut) {
            let changed = config.remove("format").is_some();
            if config.is_empty() {
                body.remove("output_config");
            }
            return changed;
        }
    }
    if message.contains("thinking") && !message.contains("signature") && body.remove("thinking").is_some() {
        return true;
    }
    if message.contains("effort") && body.remove("output_config").is_some() {
        return true;
    }
    if message.contains("top-level") && message.contains("cache_control") && body.remove("cache_control").is_some() {
        return true;
    }
    false
}

#[derive(Debug)]
enum BlockBuf {
    Text { text: String },
    Thinking { text: String, signature: String },
    Tool { id: String, name: String, json: String, initial: Value },
    Other { raw: Value },
}

#[derive(Debug, Default)]
pub struct AnthropicDecoder {
    /// Blocks in arrival order, by their stream index.
    open: Vec<(u64, BlockBuf)>,
    closed: Vec<Value>,
    model: String,
    stop_reason: Option<String>,
    stop_details: Value,
    usage: Usage,
    fallback: Value,
    complete: bool,
    failed: bool,
    last_fallback_at: Option<usize>,
}

impl AnthropicDecoder {
    pub fn new(model: &str) -> Self {
        Self {
            model: model.to_string(),
            stop_details: Value::Null,
            fallback: Value::Null,
            ..Default::default()
        }
    }

    fn read_usage(&mut self, usage: &Value) {
        let number = |key: &str| usage.get(key).and_then(Value::as_u64);
        // Top-level usage covers only the attempt that produced the message, and
        // `iterations` covers every attempt, so it is the true total when present.
        if let Some(iterations) = usage.get("iterations").and_then(Value::as_array).filter(|i| !i.is_empty()) {
            let mut total = Usage::default();
            for item in iterations {
                let get = |key: &str| item.get(key).and_then(Value::as_u64).unwrap_or(0);
                total.cache_read += get("cache_read_input_tokens");
                total.cache_write += get("cache_creation_input_tokens");
                total.input += get("input_tokens") + get("cache_read_input_tokens") + get("cache_creation_input_tokens");
                total.output += get("output_tokens");
            }
            self.usage = total;
            return;
        }
        let uncached = number("input_tokens");
        let read = number("cache_read_input_tokens");
        let write = number("cache_creation_input_tokens");
        if let Some(read) = read {
            self.usage.cache_read = read;
        }
        if let Some(write) = write {
            self.usage.cache_write = write;
        }
        if let Some(uncached) = uncached {
            self.usage.input = uncached + self.usage.cache_read + self.usage.cache_write;
        }
        if let Some(output) = number("output_tokens") {
            self.usage.output = output;
        }
    }

    fn finish_block(&mut self, buf: BlockBuf, out: &mut Vec<AiEvent>) {
        match buf {
            BlockBuf::Text { text } => {
                self.closed.push(json!({
                    "type": "text", "text": text, "provider": PROVIDER,
                    "raw": { "type": "text", "text": text },
                }));
            }
            BlockBuf::Thinking { text, signature } => {
                self.closed.push(json!({
                    "type": "thinking", "text": text, "provider": PROVIDER, "model": self.model,
                    "raw": { "type": "thinking", "thinking": text, "signature": signature },
                }));
            }
            BlockBuf::Tool { id, name, json, initial } => {
                let (input, invalid) = parse_tool_input(&json, initial);
                let mut block = json!({
                    "type": "toolCall", "id": id, "name": name, "input": input,
                    "provider": PROVIDER, "model": self.model,
                    "raw": { "type": "tool_use", "id": id, "name": name, "input": input },
                });
                if let Some(raw) = &invalid {
                    block["invalid"] = json!(raw);
                }
                self.closed.push(block);
                out.push(AiEvent::ToolCall { id, name, input, invalid });
            }
            BlockBuf::Other { raw } => {
                if block_type(&raw) == "fallback" {
                    self.last_fallback_at = Some(self.closed.len());
                }
                self.closed.push(json!({
                    "type": "opaque", "provider": PROVIDER, "model": self.model, "raw": raw,
                }));
            }
        }
    }

    /// After a mid-output fallback, only text and paired server-tool blocks from before
    /// the boundary may be echoed back.
    fn final_content(&self) -> Vec<Value> {
        let boundary = self.last_fallback_at.unwrap_or(0);
        let mut result_ids: Vec<&str> = Vec::new();
        for block in &self.closed {
            if let Some(raw) = block.get("raw") {
                let wire_type = block_type(raw);
                if wire_type.ends_with("_tool_result") {
                    if let Some(id) = raw.get("tool_use_id").and_then(Value::as_str) {
                        result_ids.push(id);
                    }
                }
            }
        }
        self.closed
            .iter()
            .enumerate()
            .filter(|(index, block)| {
                let raw = block.get("raw").cloned().unwrap_or(Value::Null);
                let wire_type = block_type(&raw).to_string();
                if wire_type == "fallback" {
                    return false; // An audit marker with nothing to replay.
                }
                if *index >= boundary {
                    return true;
                }
                match wire_type.as_str() {
                    "text" => true,
                    "server_tool_use" => raw
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| result_ids.contains(&id)),
                    other => other.ends_with("_tool_result"),
                }
            })
            .map(|(_, block)| block.clone())
            .collect()
    }

    fn error_event(&mut self, data: &Value) -> AiEvent {
        self.failed = true;
        let error = data.get("error").cloned().unwrap_or(Value::Null);
        let kind = block_str(&error, "type").to_string();
        let message = block_str(&error, "message").to_string();
        let mapped = match kind.as_str() {
            "overloaded_error" => StreamError::new("OVERLOADED", "Anthropic is overloaded right now. Try again in a moment.").retryable(),
            "rate_limit_error" => StreamError::new("RATE_LIMITED", "Anthropic's rate limit was reached. Wait a moment and try again.").retryable(),
            "api_error" => StreamError::new("SERVER_ERROR", "Anthropic reported a server error. Try again in a moment.").retryable(),
            "request_too_large" => StreamError::new(
                "CONTEXT_TOO_LONG",
                "This request is too large for the model. Lower the context size in Settings > AI, or exclude some pages in the context view.",
            ),
            _ => StreamError::new("BAD_REQUEST", if message.is_empty() { "Anthropic reported an error.".to_string() } else { message }),
        };
        AiEvent::Error(mapped, self.partial())
    }
}

fn parse_tool_input(json: &str, initial: Value) -> (Value, Option<String>) {
    if json.trim().is_empty() {
        let input = if initial.is_object() { initial } else { Value::Object(Map::new()) };
        return (input, None);
    }
    match serde_json::from_str::<Value>(json) {
        Ok(value) if value.is_object() => (value, None),
        // Parsed but not an object, or malformed. With eager input streaming the API no
        // longer validates this, so the model gets it back as an error rather than running.
        _ => (Value::Object(Map::new()), Some(json.to_string())),
    }
}

impl Decoder for AnthropicDecoder {
    fn on_event(&mut self, event: &SseEvent) -> Vec<AiEvent> {
        let Ok(data) = serde_json::from_str::<Value>(&event.data) else {
            return Vec::new();
        };
        let name = data.get("type").and_then(Value::as_str).unwrap_or(event.event.as_str()).to_string();
        let mut out = Vec::new();
        match name.as_str() {
            "message_start" => {
                let message = data.get("message").cloned().unwrap_or(Value::Null);
                if let Some(model) = message.get("model").and_then(Value::as_str) {
                    self.model = model.to_string();
                }
                if let Some(usage) = message.get("usage") {
                    self.read_usage(usage);
                }
            }
            "content_block_start" => {
                let index = data.get("index").and_then(Value::as_u64).unwrap_or(0);
                let block = data.get("content_block").cloned().unwrap_or(Value::Null);
                let buf = match block_type(&block) {
                    "text" => {
                        let text = block_str(&block, "text").to_string();
                        if !text.is_empty() {
                            out.push(AiEvent::Text(text.clone()));
                        }
                        BlockBuf::Text { text }
                    }
                    "thinking" => {
                        let text = block_str(&block, "thinking").to_string();
                        if !text.is_empty() {
                            out.push(AiEvent::Thinking(text.clone()));
                        }
                        BlockBuf::Thinking { text, signature: block_str(&block, "signature").to_string() }
                    }
                    "tool_use" => {
                        let id = block_str(&block, "id").to_string();
                        let name = block_str(&block, "name").to_string();
                        out.push(AiEvent::ToolStart { id: id.clone(), name: name.clone() });
                        BlockBuf::Tool {
                            id,
                            name,
                            json: String::new(),
                            initial: block.get("input").cloned().unwrap_or(Value::Null),
                        }
                    }
                    "fallback" => {
                        let from = block.get("from").map(|f| block_str(f, "model").to_string()).unwrap_or_default();
                        let to = block.get("to").map(|t| block_str(t, "model").to_string()).unwrap_or_default();
                        self.fallback = json!({ "from": from, "to": to });
                        if !to.is_empty() {
                            self.model = to.clone();
                        }
                        out.push(AiEvent::Fallback { from, to });
                        BlockBuf::Other { raw: block }
                    }
                    // `redacted_thinking` and anything else: kept whole, only to replay.
                    _ => BlockBuf::Other { raw: block },
                };
                self.open.push((index, buf));
            }
            "content_block_delta" => {
                let index = data.get("index").and_then(Value::as_u64).unwrap_or(0);
                let delta = data.get("delta").cloned().unwrap_or(Value::Null);
                if let Some((_, buf)) = self.open.iter_mut().rev().find(|(i, _)| *i == index) {
                    match (block_type(&delta), buf) {
                        ("text_delta", BlockBuf::Text { text }) => {
                            let piece = block_str(&delta, "text");
                            text.push_str(piece);
                            out.push(AiEvent::Text(piece.to_string()));
                        }
                        ("thinking_delta", BlockBuf::Thinking { text, .. }) => {
                            let piece = block_str(&delta, "thinking");
                            text.push_str(piece);
                            out.push(AiEvent::Thinking(piece.to_string()));
                        }
                        ("signature_delta", BlockBuf::Thinking { signature, .. }) => {
                            signature.push_str(block_str(&delta, "signature"));
                        }
                        ("input_json_delta", BlockBuf::Tool { json, .. }) => {
                            json.push_str(block_str(&delta, "partial_json"));
                        }
                        _ => {}
                    }
                }
            }
            "content_block_stop" => {
                let index = data.get("index").and_then(Value::as_u64).unwrap_or(0);
                if let Some(at) = self.open.iter().rposition(|(i, _)| *i == index) {
                    let (_, buf) = self.open.remove(at);
                    self.finish_block(buf, &mut out);
                }
            }
            "message_delta" => {
                let delta = data.get("delta").cloned().unwrap_or(Value::Null);
                if let Some(reason) = delta.get("stop_reason").and_then(Value::as_str) {
                    self.stop_reason = Some(reason.to_string());
                }
                let details = delta.get("stop_details").or_else(|| data.get("stop_details")).filter(|d| !d.is_null());
                if let Some(details) = details {
                    self.stop_details = json!({
                        "category": details.get("category").cloned().unwrap_or(Value::Null),
                        "explanation": details.get("explanation").cloned().unwrap_or(Value::Null),
                        "recommendedModel": details.get("recommended_model").cloned().unwrap_or(Value::Null),
                    });
                }
                if let Some(usage) = data.get("usage") {
                    self.read_usage(usage);
                    out.push(AiEvent::Usage(self.usage.clone()));
                }
            }
            "message_stop" => self.complete = true,
            "error" => out.push(self.error_event(&data)),
            // `ping`, and anything added to the API later.
            _ => {}
        }
        out
    }

    fn finished(&self) -> bool {
        self.complete
    }

    fn finish(&mut self) -> Vec<AiEvent> {
        let mut out = Vec::new();
        // A stop reason means the response finished, even if the closing event got lost.
        if self.failed || self.stop_reason.is_none() {
            return out;
        }
        let open = std::mem::take(&mut self.open);
        for (_, buf) in open {
            self.finish_block(buf, &mut out);
        }
        out.push(AiEvent::Usage(self.usage.clone()));
        out.push(AiEvent::Done(Done {
            stop_reason: self.stop_reason.clone().unwrap_or_else(|| "end_turn".to_string()),
            stop_details: self.stop_details.clone(),
            content: self.final_content(),
            model: self.model.clone(),
            provider: PROVIDER,
            fallback: self.fallback.clone(),
        }));
        out
    }

    fn partial(&self) -> Vec<Value> {
        // Unsigned thinking and half-written tool calls cannot be replayed, so a response
        // that was cut off keeps only its text.
        let mut text = String::new();
        for block in &self.closed {
            if block_type(block) == "text" {
                text.push_str(block_str(block, "text"));
            }
        }
        for (_, buf) in &self.open {
            if let BlockBuf::Text { text: piece } = buf {
                text.push_str(piece);
            }
        }
        if text.is_empty() {
            Vec::new()
        } else {
            vec![json!({ "type": "text", "text": text })]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::profile::Kind;
    use crate::ai::types::testutil::*;

    fn profile() -> Profile {
        Profile {
            id: "c".into(),
            name: "Claude".into(),
            kind: Kind::Anthropic,
            base_url: "https://api.anthropic.com".into(),
            model: "claude-opus-5-5".into(),
            is_cloud: true,
            max_tokens: None,
            effort: Some("high".into()),
            supports_images: None,
        }
    }

    fn request(messages: Value) -> StreamRequest {
        serde_json::from_value(json!({
            "streamId": "s", "profileId": "c",
            "system": "You help novelists.",
            "messages": messages,
        }))
        .unwrap()
    }

    fn make() -> Box<dyn Decoder> {
        Box::new(AnthropicDecoder::new("claude-opus-5-5"))
    }

    /// Writes events the way the API does: an `event:` line, then one `data:` line.
    fn sse(events: &[Value]) -> String {
        let mut out = String::new();
        for event in events {
            out.push_str(&format!("event: {}\ndata: {}\n\n", block_str(event, "type"), event));
        }
        out
    }

    fn start(model: &str) -> Value {
        json!({ "type": "message_start", "message": {
            "id": "msg_1", "type": "message", "role": "assistant", "content": [], "model": model,
            "stop_reason": null, "usage": { "input_tokens": 10, "cache_read_input_tokens": 90, "cache_creation_input_tokens": 5, "output_tokens": 1 }
        }})
    }

    fn end(reason: &str, details: Value, output: u64) -> [Value; 2] {
        [
            json!({ "type": "message_delta", "delta": { "stop_reason": reason, "stop_sequence": null, "stop_details": details }, "usage": { "output_tokens": output } }),
            json!({ "type": "message_stop" }),
        ]
    }

    #[test]
    fn the_request_follows_the_current_api_rules() {
        let p = profile();
        let mut req = request(json!([{ "role": "user", "content": [{ "type": "text", "text": "Hi" }] }]));
        req.tools = vec![ToolDef { name: "search_lore".into(), description: "d".into(), input_schema: json!({ "type": "object" }) }];
        req.auto_cache = true;
        let prepared = build(&req, &p, "claude-opus-5-5", Some("k"), true).unwrap();
        assert_eq!(prepared.url, "https://api.anthropic.com/v1/messages");
        let body = &prepared.body;
        assert_eq!(body["thinking"], json!({ "type": "adaptive", "display": "summarized" }));
        assert_eq!(body["output_config"]["effort"], "high");
        assert_eq!(body["tool_choice"], json!({ "type": "auto" }));
        assert_eq!(body["tools"][0]["eager_input_streaming"], true);
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 64_000);
        assert_eq!(body["system"][0]["cache_control"], json!({ "type": "ephemeral" }));
        assert_eq!(body["cache_control"], json!({ "type": "ephemeral" }));
        for banned in ["temperature", "top_p", "top_k"] {
            assert!(body.get(banned).is_none(), "{banned} must never be sent");
        }
        let header = |name: &str| prepared.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
        assert_eq!(header("anthropic-version"), Some("2026-10-21"));
        assert_eq!(header("x-api-key"), Some("k"));
        assert_eq!(header("anthropic-beta"), Some("server-side-fallback-2026-07-01"));
    }

    #[test]
    fn fallbacks_and_new_fields_are_limited_to_models_and_servers_that_accept_them() {
        let p = profile();
        let req = request(json!([{ "role": "user", "content": [{ "type": "text", "text": "Hi" }] }]));

        for model in ["claude-haiku-5-5", "claude-opus-4-8", "claude-sonnet-5", "claude-fable-5"] {
            let prepared = build(&req, &p, model, Some("k"), true).unwrap();
            assert!(prepared.body.get("fallbacks").is_none(), "{model}");
            assert!(!prepared.headers.iter().any(|(n, _)| n == "anthropic-beta"), "{model}");
            assert_eq!(prepared.body["thinking"]["type"], "adaptive", "{model}");
        }
        for model in ["claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-opus-5-5"] {
            let prepared = build(&req, &p, model, Some("k"), true).unwrap();
            assert_eq!(prepared.body["fallbacks"], "default", "{model}");
        }
        for model in ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-3-5-sonnet-latest"] {
            let prepared = build(&req, &p, model, Some("k"), true).unwrap();
            assert!(prepared.body.get("thinking").is_none(), "{model}");
            assert!(prepared.body.get("output_config").is_none(), "{model}");
        }
        // A gateway may refuse fields it does not know.
        let mut with_tools = req.clone();
        with_tools.tools = vec![ToolDef { name: "t".into(), description: "d".into(), input_schema: json!({}) }];
        with_tools.auto_cache = true;
        let proxied = build(&with_tools, &p, "claude-opus-5-5", Some("k"), false).unwrap();
        assert!(proxied.body.get("fallbacks").is_none());
        assert!(proxied.body["tools"][0].get("eager_input_streaming").is_none());
        assert!(proxied.body.get("cache_control").is_none());
    }

    #[test]
    fn structured_output_uses_output_config_format() {
        let p = profile();
        let mut req = request(json!([{ "role": "user", "content": [{ "type": "text", "text": "Hi" }] }]));
        req.json_schema = Some(JsonSchemaSpec { name: "x".into(), schema: json!({ "type": "object", "additionalProperties": false }) });
        let body = build(&req, &p, "claude-opus-5-5", None, true).unwrap().body;
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        assert_eq!(body["output_config"]["format"]["schema"]["additionalProperties"], false);
        assert!(build(&req, &p, "claude-opus-4-7", None, true).unwrap().body["output_config"].get("format").is_none());
    }

    #[test]
    fn a_tool_loop_stream_decodes_with_thinking_signature_and_usage() {
        let stream = sse(&[
            start("claude-opus-5-5"),
            json!({ "type": "ping" }),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "", "signature": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "Let me \u{1F409} " } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "check." } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "sig" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "-abc" } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "text", "text": "" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "Looking " } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "caf\u{e9}." } }),
            json!({ "type": "content_block_stop", "index": 1 }),
            json!({ "type": "content_block_start", "index": 2, "content_block": { "type": "tool_use", "id": "toolu_1", "name": "search_lore", "input": {} } }),
            json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "{\"query\":\"Ari" } }),
            json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "a\",\"limit\":3}" } }),
            json!({ "type": "content_block_stop", "index": 2 }),
            end("tool_use", Value::Null, 42)[0].clone(),
            end("tool_use", Value::Null, 42)[1].clone(),
        ]);
        let events = assert_split_independent(&make, &stream);
        assert_eq!(joined_text(&events), "Looking caf\u{e9}.");
        assert_eq!(joined_thinking(&events), "Let me \u{1F409} check.");
        assert!(events.contains(&AiEvent::ToolStart { id: "toolu_1".into(), name: "search_lore".into() }));

        let done = done_of(&events);
        assert_eq!(done.stop_reason, "tool_use");
        assert_eq!(done.content.len(), 3);
        // Thinking replays exactly as it arrived, signature included.
        assert_eq!(done.content[0]["raw"], json!({ "type": "thinking", "thinking": "Let me \u{1F409} check.", "signature": "sig-abc" }));
        assert_eq!(done.content[1]["raw"], json!({ "type": "text", "text": "Looking caf\u{e9}." }));
        assert_eq!(done.content[2]["raw"]["input"], json!({ "query": "Aria", "limit": 3 }));
        // Key order survives, since it is part of what gets replayed.
        let keys: Vec<&String> = done.content[2]["input"].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["query", "limit"]);

        let usage = events.iter().rev().find_map(|e| if let AiEvent::Usage(u) = e { Some(u.clone()) } else { None }).unwrap();
        assert_eq!(usage, Usage { input: 105, output: 42, cache_read: 90, cache_write: 5, reasoning: 0 });
    }

    #[test]
    fn invalid_tool_json_is_reported_not_run() {
        let stream = sse(&[
            start("claude-opus-5-5"),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "tool_use", "id": "toolu_1", "name": "get_page", "input": {} } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "input_json_delta", "partial_json": "{\"title\":\"Aria" } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            end("max_tokens", Value::Null, 9)[0].clone(),
            end("max_tokens", Value::Null, 9)[1].clone(),
        ]);
        let events = assert_split_independent(&make, &stream);
        assert!(events.iter().any(|e| matches!(e, AiEvent::ToolCall { invalid: Some(raw), .. } if raw == "{\"title\":\"Aria")));
        let done = done_of(&events);
        assert_eq!(done.stop_reason, "max_tokens");
        assert_eq!(done.content[0]["invalid"], "{\"title\":\"Aria");
        assert_eq!(done.content[0]["raw"]["input"], json!({}));
    }

    #[test]
    fn a_tool_with_no_input_deltas_has_an_empty_object() {
        let stream = sse(&[
            start("claude-opus-5-5"),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "tool_use", "id": "t", "name": "list_pages", "input": {} } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            end("tool_use", Value::Null, 1)[0].clone(),
            end("tool_use", Value::Null, 1)[1].clone(),
        ]);
        let events = assert_split_independent(&make, &stream);
        assert!(events.iter().any(|e| matches!(e, AiEvent::ToolCall { input, invalid: None, .. } if input == &json!({}))));
    }

    #[test]
    fn a_refusal_is_a_done_with_details() {
        let details = json!({ "type": "refusal", "category": "cyber", "explanation": "Not allowed.", "recommended_model": "claude-opus-4-8" });
        let stream = sse(&[start("claude-opus-5-5"), end("refusal", details.clone(), 0)[0].clone(), end("refusal", details, 0)[1].clone()]);
        let events = assert_split_independent(&make, &stream);
        let done = done_of(&events);
        assert_eq!(done.stop_reason, "refusal");
        assert_eq!(done.stop_details["category"], "cyber");
        assert_eq!(done.stop_details["recommendedModel"], "claude-opus-4-8");
        assert!(done.content.is_empty());
    }

    #[test]
    fn a_stop_details_of_null_on_a_refusal_is_fine() {
        let stream = sse(&[start("claude-opus-5-5"), end("refusal", Value::Null, 0)[0].clone(), end("refusal", Value::Null, 0)[1].clone()]);
        let events = assert_split_independent(&make, &stream);
        assert_eq!(done_of(&events).stop_reason, "refusal");
        assert!(done_of(&events).stop_details.is_null());
    }

    #[test]
    fn pause_turn_keeps_server_tool_blocks_to_replay() {
        let server_use = json!({ "type": "server_tool_use", "id": "srv_1", "name": "web_search", "input": { "query": "x" } });
        let stream = sse(&[
            start("claude-opus-5-5"),
            json!({ "type": "content_block_start", "index": 0, "content_block": server_use }),
            json!({ "type": "content_block_stop", "index": 0 }),
            end("pause_turn", Value::Null, 3)[0].clone(),
            end("pause_turn", Value::Null, 3)[1].clone(),
        ]);
        let events = assert_split_independent(&make, &stream);
        let done = done_of(&events);
        assert_eq!(done.stop_reason, "pause_turn");
        assert_eq!(done.content[0]["raw"], server_use);
    }

    #[test]
    fn a_mid_stream_fallback_keeps_text_and_drops_what_cannot_be_echoed() {
        let stream = sse(&[
            start("claude-opus-5-5"),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "", "signature": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "hmm" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "s1" } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "text", "text": "" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "Partial " } }),
            json!({ "type": "content_block_stop", "index": 1 }),
            json!({ "type": "content_block_start", "index": 2, "content_block": { "type": "fallback", "from": { "model": "claude-opus-5-5" }, "to": { "model": "claude-opus-5" } } }),
            json!({ "type": "content_block_stop", "index": 2 }),
            json!({ "type": "content_block_start", "index": 3, "content_block": { "type": "text", "text": "" } }),
            json!({ "type": "content_block_delta", "index": 3, "delta": { "type": "text_delta", "text": "rest." } }),
            json!({ "type": "content_block_stop", "index": 3 }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 20, "iterations": [
                { "type": "message", "input_tokens": 10, "output_tokens": 5 },
                { "type": "fallback_message", "input_tokens": 10, "output_tokens": 15, "cache_read_input_tokens": 4 }
            ]}}),
            json!({ "type": "message_stop" }),
        ]);
        let events = assert_split_independent(&make, &stream);
        assert_eq!(joined_text(&events), "Partial rest.");
        assert!(events.contains(&AiEvent::Fallback { from: "claude-opus-5-5".into(), to: "claude-opus-5".into() }));
        let done = done_of(&events);
        assert_eq!(done.model, "claude-opus-5");
        assert_eq!(done.fallback["to"], "claude-opus-5");
        let kinds: Vec<&str> = done.content.iter().map(block_type).collect();
        assert_eq!(kinds, ["text", "text"], "thinking from before the boundary must not be echoed");
        let usage = events.iter().rev().find_map(|e| if let AiEvent::Usage(u) = e { Some(u.clone()) } else { None }).unwrap();
        assert_eq!(usage.output, 20, "every attempt counts");
        assert_eq!(usage.input, 24);
    }

    #[test]
    fn a_stream_error_event_is_retryable_when_overloaded() {
        let stream = sse(&[
            start("claude-opus-5-5"),
            json!({ "type": "error", "error": { "type": "overloaded_error", "message": "Overloaded" } }),
        ]);
        let events = assert_split_independent(&make, &stream);
        let error = events.iter().find_map(|e| if let AiEvent::Error(err, _) = e { Some(err) } else { None }).unwrap();
        assert_eq!(error.code, "OVERLOADED");
        assert!(error.retryable);
        assert!(!events.iter().any(|e| matches!(e, AiEvent::Done(_))));
    }

    #[test]
    fn a_stream_cut_off_gives_no_done_and_keeps_only_text_as_partial() {
        let stream = sse(&[
            start("claude-opus-5-5"),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "", "signature": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "half a thought" } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "text", "text": "" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "half a sentence" } }),
        ]);
        let mut decoder = AnthropicDecoder::new("claude-opus-5-5");
        let events = decode(&mut decoder, &stream, 5);
        assert!(!events.iter().any(|e| matches!(e, AiEvent::Done(_))));
        assert_eq!(decoder.partial(), vec![json!({ "type": "text", "text": "half a sentence" })]);
    }

    #[test]
    fn stored_blocks_replay_unchanged_to_anthropic_and_convert_safely_from_others() {
        let raw_thinking = json!({ "type": "thinking", "thinking": "summary", "signature": "SIG" });
        let wire = wire_messages(&serde_json::from_value::<Vec<Message>>(json!([
            { "role": "user", "content": [
                { "type": "text", "text": "lore", "cache": true },
                { "type": "text", "text": "question" },
            ]},
            { "role": "assistant", "content": [
                { "type": "thinking", "text": "summary", "provider": "anthropic", "raw": raw_thinking },
                { "type": "opaque", "provider": "anthropic", "raw": { "type": "redacted_thinking", "data": "xx" } },
                { "type": "text", "text": "answer", "provider": "anthropic", "raw": { "type": "text", "text": "answer" } },
                { "type": "toolCall", "id": "toolu_1", "name": "get_page", "input": { "b": 1, "a": 2 }, "provider": "anthropic",
                  "raw": { "type": "tool_use", "id": "toolu_1", "name": "get_page", "input": { "b": 1, "a": 2 } } },
            ]},
            { "role": "user", "content": [
                { "type": "toolResult", "toolCallId": "toolu_1", "content": "nope", "isError": true },
                { "type": "usage", "costUsd": 1 },
            ]},
            // From a conversation that began on OpenAI.
            { "role": "assistant", "content": [
                { "type": "thinking", "text": "their thoughts", "provider": "openai", "raw": { "type": "reasoning", "encrypted_content": "e" } },
                { "type": "opaque", "provider": "openai", "raw": { "type": "whatever" } },
                { "type": "text", "text": "theirs", "provider": "openai", "raw": { "type": "message", "phase": "final_answer" } },
                { "type": "toolCall", "id": "call:1/x", "name": "get_page", "input": "not an object", "provider": "openai", "raw": { "type": "function_call" } },
            ]},
            { "role": "user", "content": [{ "type": "toolResult", "toolCallId": "call:1/x", "content": "ok" }] },
        ])).unwrap());
        assert_eq!(wire[0]["content"][0]["cache_control"], json!({ "type": "ephemeral" }));
        assert_eq!(wire[1]["content"][0], raw_thinking);
        assert_eq!(wire[1]["content"][1]["type"], "redacted_thinking");
        assert_eq!(wire[1]["content"][3]["input"].to_string(), "{\"b\":1,\"a\":2}");
        assert_eq!(wire[2]["content"], json!([{ "type": "tool_result", "tool_use_id": "toolu_1", "content": "nope", "is_error": true }]));
        assert_eq!(wire[3]["content"], json!([
            { "type": "text", "text": "theirs" },
            { "type": "tool_use", "id": "call_1_x", "name": "get_page", "input": {} },
        ]));
        assert_eq!(wire[4]["content"][0]["tool_use_id"], "call_1_x");
    }

    #[test]
    fn image_blocks_become_base64_sources() {
        let wire = wire_messages(&serde_json::from_value::<Vec<Message>>(json!([
            { "role": "user", "content": [
                { "type": "image", "mime": "image/png", "base64": "AAAA" },
                { "type": "text", "text": "What is this?" },
            ]},
        ])).unwrap());
        assert_eq!(wire[0]["content"][0], json!({
            "type": "image",
            "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" },
        }));
    }

    #[test]
    fn only_the_newest_marked_block_keeps_its_cache_marker() {
        let wire = wire_messages(&serde_json::from_value::<Vec<Message>>(json!([
            { "role": "user", "content": [{ "type": "text", "text": "old lore", "cache": true }] },
            { "role": "assistant", "content": [{ "type": "text", "text": "a" }] },
            { "role": "user", "content": [{ "type": "text", "text": "new lore", "cache": true }, { "type": "text", "text": "q" }] },
        ])).unwrap());
        assert!(wire[0]["content"][0].get("cache_control").is_none());
        assert!(wire[2]["content"][0].get("cache_control").is_some());
        assert!(wire[2]["content"][1].get("cache_control").is_none());
    }

    #[test]
    fn empty_text_and_empty_messages_are_not_sent() {
        let wire = wire_messages(&serde_json::from_value::<Vec<Message>>(json!([
            { "role": "user", "content": [{ "type": "text", "text": "hi" }] },
            { "role": "assistant", "content": [{ "type": "text", "text": "" }] },
            { "role": "user", "content": [{ "type": "text", "text": "again" }] },
        ])).unwrap());
        assert_eq!(wire.len(), 2);
    }

    #[test]
    fn refused_fields_can_be_dropped_and_retried() {
        let p = profile();
        let req = request(json!([{ "role": "user", "content": [{ "type": "text", "text": "Hi" }] }]));
        let mut prepared = build(&req, &p, "claude-opus-5-5", Some("k"), true).unwrap();
        let reject = |message: &str| Rejection { status: 400, message: message.to_string(), ..Default::default() };
        assert!(relax(&mut prepared, &reject("fallbacks: not available for this organization")));
        assert!(prepared.body.get("fallbacks").is_none());
        assert!(!prepared.headers.iter().any(|(n, _)| n == "anthropic-beta"));
        assert!(relax(&mut prepared, &reject("\"thinking.type.adaptive\" is not supported for this model.")));
        assert!(prepared.body.get("thinking").is_none());
        assert!(!relax(&mut prepared, &reject("something else")));
    }

    #[test]
    fn a_broken_thinking_chain_is_recovered_by_sending_history_without_thinking() {
        let p = profile();
        let req = request(json!([
            { "role": "user", "content": [{ "type": "text", "text": "One" }] },
            { "role": "assistant", "content": [
                { "type": "thinking", "text": "t", "provider": "anthropic", "raw": { "type": "thinking", "thinking": "t", "signature": "S" } },
                { "type": "opaque", "provider": "anthropic", "raw": { "type": "redacted_thinking", "data": "d" } },
                { "type": "text", "text": "Two", "provider": "anthropic", "raw": { "type": "text", "text": "Two" } },
            ]},
            { "role": "assistant", "content": [
                { "type": "thinking", "text": "only", "provider": "anthropic", "raw": { "type": "thinking", "thinking": "only", "signature": "S2" } },
            ]},
            { "role": "user", "content": [{ "type": "text", "text": "Three" }] },
        ]));
        let mut prepared = build(&req, &p, "claude-opus-5-5", Some("k"), true).unwrap();
        let reject = Rejection {
            status: 400,
            message: "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.".to_string(),
            ..Default::default()
        };
        assert!(relax(&mut prepared, &reject));
        let wire = prepared.body["messages"].as_array().unwrap();
        assert_eq!(wire.len(), 3, "a turn of only thinking goes with it");
        assert_eq!(wire[1]["content"], json!([{ "type": "text", "text": "Two" }]));
        // A second refusal means thinking was not the cause, so it is reported, not looped on.
        assert!(!relax(&mut prepared, &reject));
    }
}
