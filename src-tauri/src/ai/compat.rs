//! Chat Completions, for local and other OpenAI-compatible servers.
//!
//! A local server may be any OpenAI-compatible server, so only the shared OpenAI-style
//! endpoints are assumed. Servers differ in small ways, and this is tolerant of them:
//! thinking arrives as `reasoning_content`, `reasoning`, or `<think>` tags in the text,
//! tool calls arrive whole or in pieces, and `[DONE]` may never come.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use super::profile::Profile;
use super::sse::SseEvent;
use super::transport::Prepared;
use super::types::*;

pub const PROVIDER: &str = "compat";

/// Messages for a Chat Completions server. Thinking is sent back only inside an active
/// tool loop, which is where templates use it, and old turns stay small.
pub fn wire_messages(system: Option<&str>, messages: &[Message]) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(system) = system.filter(|s| !s.is_empty()) {
        out.push(json!({ "role": "system", "content": system }));
    }
    let is_user_text = |m: &Message| m.role == "user" && m.content.iter().any(|b| block_type(b) == "text");
    let last_user_text = messages.iter().rposition(is_user_text);

    for (index, message) in messages.iter().enumerate() {
        if message.role == "assistant" {
            let mut text = String::new();
            let mut thinking = String::new();
            let mut calls = Vec::new();
            for block in &message.content {
                match block_type(block) {
                    "text" => text.push_str(block_str(block, "text")),
                    "thinking" if block_str(block, "provider") == PROVIDER => thinking.push_str(block_str(block, "text")),
                    "toolCall" => calls.push(json!({
                        "id": safe_tool_id(block_str(block, "id")),
                        "type": "function",
                        "function": { "name": block_str(block, "name"), "arguments": input_object(block).to_string() },
                    })),
                    _ => {}
                }
            }
            if text.is_empty() && calls.is_empty() {
                continue;
            }
            let mut wire = Map::new();
            wire.insert("role".into(), json!("assistant"));
            wire.insert("content".into(), if text.is_empty() { Value::Null } else { json!(text) });
            if !calls.is_empty() {
                wire.insert("tool_calls".into(), Value::Array(calls));
            }
            if !thinking.is_empty() && last_user_text.is_some_and(|last| index > last) {
                wire.insert("reasoning_content".into(), json!(thinking));
            }
            out.push(Value::Object(wire));
        } else {
            let mut text = String::new();
            let mut images = Vec::new();
            for block in &message.content {
                match block_type(block) {
                    "text" => {
                        let piece = block_str(block, "text");
                        if !piece.is_empty() {
                            if !text.is_empty() {
                                text.push_str("\n\n");
                            }
                            text.push_str(piece);
                        }
                    }
                    "toolResult" => out.push(json!({
                        "role": "tool",
                        "tool_call_id": safe_tool_id(block_str(block, "toolCallId")),
                        "content": block_str(block, "content"),
                    })),
                    "image" => images.push(json!({ "type": "image_url", "image_url": { "url": image_data_url(block) } })),
                    _ => {}
                }
            }
            if !images.is_empty() {
                let mut parts = Vec::new();
                if !text.is_empty() {
                    parts.push(json!({ "type": "text", "text": text }));
                }
                parts.extend(images);
                out.push(json!({ "role": "user", "content": parts }));
                continue;
            }
            if text.is_empty() {
                continue;
            }
            // Many chat templates refuse two user turns in a row.
            let last_text = out
                .last()
                .filter(|m| m["role"] == "user")
                .and_then(|m| m["content"].as_str())
                .map(str::to_string);
            if let Some(previous) = last_text {
                let last = out.last_mut().expect("just checked");
                last["content"] = json!(format!("{previous}\n\n{text}"));
            } else {
                out.push(json!({ "role": "user", "content": text }));
            }
        }
    }
    out
}

pub fn build(
    request: &StreamRequest,
    profile: &Profile,
    model: &str,
    key: Option<&str>,
) -> Result<Prepared, StreamError> {
    let root = profile.api_root()?;
    let max_tokens = request.max_tokens.or(profile.max_tokens).unwrap_or_else(|| profile.default_max_tokens());
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("stream".into(), json!(true));
    body.insert("stream_options".into(), json!({ "include_usage": true }));
    // OpenAI itself has moved to `max_completion_tokens`, but `max_tokens` is what local
    // servers all understand. `relax` swaps it if a server refuses it.
    body.insert("max_tokens".into(), json!(max_tokens));
    body.insert(
        "messages".into(),
        Value::Array(wire_messages(request.system.as_deref(), &request.messages)),
    );
    if !request.tools.is_empty() {
        let mut tools = request.tools.clone();
        tools.sort_by(|a, b| a.name.cmp(&b.name));
        let wire: Vec<Value> = tools
            .iter()
            .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.input_schema } }))
            .collect();
        body.insert("tools".into(), Value::Array(wire));
        let choice = if request.tool_choice.as_deref() == Some("none") { "none" } else { "auto" };
        body.insert("tool_choice".into(), json!(choice));
    }
    if let Some(spec) = &request.json_schema {
        body.insert(
            "response_format".into(),
            json!({ "type": "json_schema", "json_schema": { "name": spec.name, "strict": true, "schema": spec.schema } }),
        );
    }
    let mut headers = Vec::new();
    if let Some(key) = key {
        headers.push(("authorization".to_string(), format!("Bearer {key}")));
    }
    Ok(Prepared {
        url: format!("{root}/chat/completions"),
        headers,
        body: Value::Object(body),
    })
}

/// Servers vary in what they accept. The local default refuses `response_format`, for
/// example, and the caller then extracts JSON from the text instead.
pub fn relax(prepared: &mut Prepared, rejection: &Rejection) -> bool {
    let Some(body) = prepared.body.as_object_mut() else {
        return false;
    };
    let message = rejection.message.to_ascii_lowercase();
    let code = rejection.code.as_str();
    if (rejection.param == "response_format" || code == "response_format_not_supported" || message.contains("response_format"))
        && body.remove("response_format").is_some()
    {
        return true;
    }
    if (rejection.param == "stream_options" || message.contains("stream_options")) && body.remove("stream_options").is_some() {
        return true;
    }
    if (rejection.param == "max_tokens" || message.contains("max_completion_tokens")) && body.contains_key("max_tokens") {
        if let Some(value) = body.remove("max_tokens") {
            body.insert("max_completion_tokens".into(), value);
            return true;
        }
    }
    false
}

const OPEN_TAG: &str = "<think>";
const CLOSE_TAG: &str = "</think>";

#[derive(Debug, Default, PartialEq, Eq, Clone, Copy)]
enum ThinkState {
    /// Nothing but whitespace yet, so an opening tag might still come.
    #[default]
    Start,
    Inside,
    /// Just left a thinking section, so leading blank lines are dropped.
    After,
    Content,
}

/// Separates `<think>` sections from answer text for servers that leave them in the
/// content. Only a leading tag counts, so a story that mentions the word keeps it.
#[derive(Debug, Default)]
struct ThinkFilter {
    state: ThinkState,
    held: String,
}

/// How much of `text`'s end could be the start of `tag`.
fn partial_suffix(text: &str, tag: &str) -> usize {
    let max = tag.len().saturating_sub(1).min(text.len());
    for len in (1..=max).rev() {
        if text.is_char_boundary(text.len() - len) && tag.starts_with(&text[text.len() - len..]) {
            return len;
        }
    }
    0
}

impl ThinkFilter {
    /// Returns `(is_thinking, text)` pieces in order.
    fn push(&mut self, piece: &str) -> Vec<(bool, String)> {
        let mut out = Vec::new();
        self.held.push_str(piece);
        loop {
            match self.state {
                ThinkState::Start => {
                    let trimmed = self.held.trim_start();
                    if let Some(rest) = trimmed.strip_prefix(OPEN_TAG) {
                        self.held = rest.to_string();
                        self.state = ThinkState::Inside;
                    } else if trimmed.is_empty() || OPEN_TAG.starts_with(trimmed) {
                        return out;
                    } else {
                        self.state = ThinkState::Content;
                    }
                }
                ThinkState::Inside => {
                    if let Some(at) = self.held.find(CLOSE_TAG) {
                        if at > 0 {
                            out.push((true, self.held[..at].to_string()));
                        }
                        self.held = self.held[at + CLOSE_TAG.len()..].to_string();
                        self.state = ThinkState::After;
                    } else {
                        let keep = partial_suffix(&self.held, CLOSE_TAG);
                        let cut = self.held.len() - keep;
                        if cut > 0 {
                            out.push((true, self.held[..cut].to_string()));
                            self.held = self.held[cut..].to_string();
                        }
                        return out;
                    }
                }
                ThinkState::After => {
                    let trimmed = self.held.trim_start();
                    if trimmed.is_empty() {
                        self.held.clear();
                        return out;
                    }
                    self.held = trimmed.to_string();
                    self.state = ThinkState::Content;
                }
                ThinkState::Content => {
                    if !self.held.is_empty() {
                        out.push((false, std::mem::take(&mut self.held)));
                    }
                    return out;
                }
            }
        }
    }

    fn flush(&mut self) -> Vec<(bool, String)> {
        let held = std::mem::take(&mut self.held);
        if held.is_empty() {
            return Vec::new();
        }
        match self.state {
            ThinkState::Inside => vec![(true, held)],
            ThinkState::After => Vec::new(),
            _ => vec![(false, held)],
        }
    }
}

#[derive(Debug, Default, Clone)]
struct ToolBuf {
    id: String,
    name: String,
    arguments: String,
    announced: bool,
}

#[derive(Debug, Default)]
pub struct CompatDecoder {
    model: String,
    text: String,
    thinking: String,
    filter: ThinkFilter,
    tools: BTreeMap<u64, ToolBuf>,
    usage: Usage,
    saw_usage: bool,
    finish_reason: Option<String>,
    refusal: String,
    saw_done: bool,
    failed: bool,
}

impl CompatDecoder {
    pub fn new(model: &str) -> Self {
        Self {
            model: model.to_string(),
            ..Default::default()
        }
    }

    fn emit_content(&mut self, piece: &str, out: &mut Vec<AiEvent>) {
        for (is_thinking, text) in self.filter.push(piece) {
            self.emit_piece(is_thinking, text, out);
        }
    }

    fn emit_piece(&mut self, is_thinking: bool, text: String, out: &mut Vec<AiEvent>) {
        if text.is_empty() {
            return;
        }
        if is_thinking {
            self.thinking.push_str(&text);
            out.push(AiEvent::Thinking(text));
        } else {
            self.text.push_str(&text);
            out.push(AiEvent::Text(text));
        }
    }

    fn read_usage(&mut self, usage: &Value) {
        let number = |value: &Value, key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
        self.saw_usage = true;
        self.usage.input = number(usage, "prompt_tokens");
        self.usage.output = number(usage, "completion_tokens");
        if let Some(details) = usage.get("prompt_tokens_details") {
            self.usage.cache_read = number(details, "cached_tokens");
        }
        if let Some(details) = usage.get("completion_tokens_details") {
            self.usage.reasoning = number(details, "reasoning_tokens");
        }
    }

    fn read_tool_delta(&mut self, call: &Value, position: usize, out: &mut Vec<AiEvent>) {
        let index = call.get("index").and_then(Value::as_u64).unwrap_or(position as u64);
        let buf = self.tools.entry(index).or_default();
        if let Some(id) = call.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            buf.id = id.to_string();
        }
        if let Some(function) = call.get("function") {
            if let Some(name) = function.get("name").and_then(Value::as_str) {
                buf.name.push_str(name);
            }
            match function.get("arguments") {
                Some(Value::String(piece)) => buf.arguments.push_str(piece),
                // Some servers send an object where the spec says a string.
                Some(value) if value.is_object() => buf.arguments = value.to_string(),
                _ => {}
            }
        }
        if !buf.announced && !buf.name.is_empty() {
            buf.announced = true;
            if buf.id.is_empty() {
                buf.id = format!("call_{index}");
            }
            out.push(AiEvent::ToolStart { id: buf.id.clone(), name: buf.name.clone() });
        }
    }

    fn read_choice(&mut self, choice: &Value, delta: &Value, out: &mut Vec<AiEvent>) {
        for key in ["reasoning_content", "reasoning"] {
            if let Some(piece) = delta.get(key).and_then(Value::as_str) {
                self.emit_piece(true, piece.to_string(), out);
            }
        }
        if let Some(piece) = delta.get("content").and_then(Value::as_str) {
            self.emit_content(piece, out);
        }
        if let Some(piece) = delta.get("refusal").and_then(Value::as_str) {
            self.refusal.push_str(piece);
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for (position, call) in calls.iter().enumerate() {
                self.read_tool_delta(call, position, out);
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
    }

    fn read_chunk(&mut self, data: &Value, out: &mut Vec<AiEvent>) {
        if let Some(error) = data.get("error").filter(|e| !e.is_null()) {
            self.failed = true;
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
                .unwrap_or("The model server reported an error.")
                .to_string();
            let code = block_str(error, "code");
            let lowered = message.to_ascii_lowercase();
            let mapped = if code == "context_length_exceeded" || lowered.contains("context") {
                StreamError::new(
                    "CONTEXT_TOO_LONG",
                    "This request is too long for the model. Lower the context size in Settings > AI, or exclude some pages in the context view.",
                )
            } else {
                StreamError::new("SERVER_ERROR", message)
            };
            out.push(AiEvent::Error(mapped, self.partial()));
            return;
        }
        if let Some(model) = data.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
            self.model = model.to_string();
        }
        if let Some(usage) = data.get("usage").filter(|u| !u.is_null()) {
            self.read_usage(usage);
        }
        if let Some(choices) = data.get("choices").and_then(Value::as_array) {
            if let Some(choice) = choices.first() {
                let null = Value::Null;
                let delta = choice.get("delta").unwrap_or(&null).clone();
                self.read_choice(choice, &delta, out);
            }
        }
    }

    fn stop_reason(&self) -> String {
        if !self.refusal.is_empty() {
            return "refusal".to_string();
        }
        let has_tools = !self.tools.is_empty();
        match self.finish_reason.as_deref() {
            Some("length") => "max_tokens".to_string(),
            Some("content_filter") => "refusal".to_string(),
            _ if has_tools => "tool_use".to_string(),
            Some("tool_calls" | "function_call" | "stop" | "eos" | "end_turn") | None => "end_turn".to_string(),
            Some(other) => other.to_string(),
        }
    }

    fn content_blocks(&self, out: &mut Vec<AiEvent>) -> Vec<Value> {
        let mut blocks = Vec::new();
        if !self.thinking.is_empty() {
            blocks.push(json!({ "type": "thinking", "text": self.thinking, "provider": PROVIDER, "model": self.model }));
        }
        if !self.text.is_empty() {
            blocks.push(json!({ "type": "text", "text": self.text, "provider": PROVIDER }));
        }
        for (index, tool) in &self.tools {
            let id = if tool.id.is_empty() { format!("call_{index}") } else { tool.id.clone() };
            let (input, invalid) = if tool.arguments.trim().is_empty() {
                (Value::Object(Map::new()), None)
            } else {
                match serde_json::from_str::<Value>(&tool.arguments) {
                    Ok(value) if value.is_object() => (value, None),
                    _ => (Value::Object(Map::new()), Some(tool.arguments.clone())),
                }
            };
            let mut block = json!({ "type": "toolCall", "id": id, "name": tool.name, "input": input, "provider": PROVIDER });
            if let Some(raw) = &invalid {
                block["invalid"] = json!(raw);
            }
            blocks.push(block);
            out.push(AiEvent::ToolCall { id, name: tool.name.clone(), input, invalid });
        }
        blocks
    }
}

impl Decoder for CompatDecoder {
    fn on_event(&mut self, event: &SseEvent) -> Vec<AiEvent> {
        let data = event.data.trim();
        if data == "[DONE]" {
            self.saw_done = true;
            return Vec::new();
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        self.read_chunk(&chunk, &mut out);
        out
    }

    fn finished(&self) -> bool {
        self.saw_done
    }

    fn finish(&mut self) -> Vec<AiEvent> {
        let mut out = Vec::new();
        if self.failed {
            return out;
        }
        for (is_thinking, text) in self.filter.flush() {
            self.emit_piece(is_thinking, text, &mut out);
        }
        // A close with neither `[DONE]` nor a finish reason means the response was cut off.
        if !self.saw_done && self.finish_reason.is_none() {
            return out;
        }
        let content = self.content_blocks(&mut out);
        if self.saw_usage {
            out.push(AiEvent::Usage(self.usage.clone()));
        }
        let stop_reason = self.stop_reason();
        let stop_details = if stop_reason == "refusal" {
            let explanation = if self.refusal.is_empty() { "The server's content filter stopped this response." } else { self.refusal.as_str() };
            json!({ "category": null, "explanation": explanation, "recommendedModel": null })
        } else {
            Value::Null
        };
        out.push(AiEvent::Done(Done {
            stop_reason,
            stop_details,
            content,
            model: self.model.clone(),
            provider: PROVIDER,
            fallback: Value::Null,
        }));
        out
    }

    fn partial(&self) -> Vec<Value> {
        let mut text = self.text.clone();
        if self.filter.state != ThinkState::Inside {
            text.push_str(&self.filter.held);
        }
        if text.is_empty() {
            Vec::new()
        } else {
            vec![json!({ "type": "text", "text": text })]
        }
    }

    /// A server that ignored `stream: true` and sent the whole answer at once.
    fn on_whole_body(&mut self, body: &str) -> Option<Vec<AiEvent>> {
        let data: Value = serde_json::from_str(body).ok()?;
        let mut out = Vec::new();
        if data.get("error").is_some_and(|e| !e.is_null()) {
            self.read_chunk(&data, &mut out);
            return Some(out);
        }
        data.get("choices")?;
        if let Some(model) = data.get("model").and_then(Value::as_str) {
            self.model = model.to_string();
        }
        if let Some(usage) = data.get("usage").filter(|u| !u.is_null()) {
            self.read_usage(usage);
        }
        if let Some(choice) = data.get("choices").and_then(Value::as_array).and_then(|c| c.first()) {
            let null = Value::Null;
            let message = choice.get("message").unwrap_or(&null).clone();
            self.read_choice(choice, &message, &mut out);
        }
        self.saw_done = true;
        out.extend(self.finish());
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::profile::Kind;
    use crate::ai::types::testutil::*;

    fn make() -> Box<dyn Decoder> {
        Box::new(CompatDecoder::new("local-model"))
    }

    fn chunk(delta: Value, finish: Value) -> Value {
        json!({ "id": "chatcmpl-1", "object": "chat.completion.chunk", "model": "local-model-27b", "created": 1,
            "choices": [{ "index": 0, "delta": delta, "finish_reason": finish, "logprobs": null }], "usage": null })
    }

    /// Writes chunks as `data:` lines with no `event:` field, as these servers do.
    fn sse(chunks: &[Value]) -> String {
        let mut out = String::new();
        for chunk in chunks {
            out.push_str(&format!("data: {chunk}\n\n"));
        }
        out.push_str("data: [DONE]\n\n");
        out
    }

    fn usage_chunk() -> Value {
        json!({ "id": "chatcmpl-1", "choices": [], "usage": {
            "prompt_tokens": 59, "completion_tokens": 35, "total_tokens": 94,
            "prompt_tokens_details": { "cached_tokens": 54 },
            "completion_tokens_details": { "reasoning_tokens": 32 },
        }, "timings": { "predicted_per_second": 169.2 } })
    }

    /// Shaped like a real capture from the local server at 127.0.0.1:8080.
    #[test]
    fn reasoning_content_is_separate_and_usage_arrives_last() {
        let stream = sse(&[
            chunk(json!({ "content": "", "role": "assistant" }), Value::Null),
            chunk(json!({ "reasoning_content": "The user wants " }), Value::Null),
            chunk(json!({ "reasoning_content": "caf\u{e9}." }), Value::Null),
            chunk(json!({ "content": "po" }), Value::Null),
            chunk(json!({ "content": "ng" }), Value::Null),
            chunk(json!({}), json!("stop")),
            usage_chunk(),
        ]);
        let events = assert_split_independent(&make, &stream);
        assert_eq!(joined_text(&events), "pong");
        assert_eq!(joined_thinking(&events), "The user wants caf\u{e9}.");
        let done = done_of(&events);
        assert_eq!(done.stop_reason, "end_turn");
        assert_eq!(done.model, "local-model-27b");
        assert_eq!(done.content.len(), 2);
        assert_eq!(block_type(&done.content[0]), "thinking");
        assert_eq!(block_str(&done.content[1], "text"), "pong");
        assert!(events.contains(&AiEvent::Usage(Usage { input: 59, output: 35, cache_read: 54, cache_write: 0, reasoning: 32 })));
    }

    #[test]
    fn hitting_the_limit_while_thinking_is_max_tokens_with_no_text() {
        let stream = sse(&[
            chunk(json!({ "reasoning_content": "still thinking" }), Value::Null),
            chunk(json!({}), json!("length")),
            usage_chunk(),
        ]);
        let events = assert_split_independent(&make, &stream);
        let done = done_of(&events);
        assert_eq!(done.stop_reason, "max_tokens");
        assert_eq!(joined_text(&events), "");
    }

    /// The local server sends a tool call whole in one chunk.
    #[test]
    fn a_tool_call_in_one_chunk_decodes() {
        let stream = sse(&[
            chunk(json!({ "tool_calls": [{ "function": { "arguments": "{\"query\":\"Aria\"}", "name": "search_lore" }, "id": "call_66a", "index": 0, "type": "function" }] }), Value::Null),
            chunk(json!({}), json!("tool_calls")),
            usage_chunk(),
        ]);
        let events = assert_split_independent(&make, &stream);
        assert!(events.contains(&AiEvent::ToolStart { id: "call_66a".into(), name: "search_lore".into() }));
        assert!(events.iter().any(|e| matches!(e, AiEvent::ToolCall { id, input, invalid: None, .. } if id == "call_66a" && input == &json!({ "query": "Aria" }))));
        let done = done_of(&events);
        assert_eq!(done.stop_reason, "tool_use");
        assert_eq!(block_str(&done.content[0], "name"), "search_lore");
    }

    #[test]
    fn tool_calls_in_pieces_and_in_parallel_decode() {
        let stream = sse(&[
            chunk(json!({ "tool_calls": [{ "index": 0, "id": "a", "type": "function", "function": { "name": "get_page", "arguments": "" } }] }), Value::Null),
            chunk(json!({ "tool_calls": [{ "index": 1, "id": "b", "type": "function", "function": { "name": "get_scene", "arguments": "{\"ti" } }] }), Value::Null),
            chunk(json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "{\"title\":" } }] }), Value::Null),
            chunk(json!({ "tool_calls": [{ "index": 1, "function": { "arguments": "tle\":\"Two\"}" } }] }), Value::Null),
            chunk(json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "\"One\"}" } }] }), Value::Null),
            chunk(json!({}), json!("tool_calls")),
        ]);
        let events = assert_split_independent(&make, &stream);
        let done = done_of(&events);
        assert_eq!(done.content[0]["input"], json!({ "title": "One" }));
        assert_eq!(done.content[1]["input"], json!({ "title": "Two" }));
    }

    #[test]
    fn malformed_arguments_are_reported_and_a_missing_id_is_filled_in() {
        let stream = sse(&[
            chunk(json!({ "tool_calls": [{ "index": 0, "function": { "name": "get_page", "arguments": "{oops" } }] }), Value::Null),
            chunk(json!({}), json!("stop")),
        ]);
        let events = assert_split_independent(&make, &stream);
        assert!(events.iter().any(|e| matches!(e, AiEvent::ToolCall { id, invalid: Some(raw), .. } if id == "call_0" && raw == "{oops")));
        assert_eq!(done_of(&events).stop_reason, "tool_use", "a server that says stop still made a call");
    }

    #[test]
    fn think_tags_in_content_become_thinking_at_any_split() {
        let stream = sse(&[
            chunk(json!({ "content": "<thi" }), Value::Null),
            chunk(json!({ "content": "nk>Hmm </th" }), Value::Null),
            chunk(json!({ "content": "at" }), Value::Null),
            chunk(json!({ "content": " is it</think>\n\nThe " }), Value::Null),
            chunk(json!({ "content": "answer <think>stays</think>." }), Value::Null),
            chunk(json!({}), json!("stop")),
        ]);
        let events = assert_split_independent(&make, &stream);
        assert_eq!(joined_thinking(&events), "Hmm </that is it");
        assert_eq!(joined_text(&events), "The answer <think>stays</think>.");
    }

    #[test]
    fn plain_text_that_only_resembles_a_tag_is_kept() {
        let stream = sse(&[
            chunk(json!({ "content": "<th" }), Value::Null),
            chunk(json!({ "content": "e end>" }), Value::Null),
            chunk(json!({}), json!("stop")),
        ]);
        assert_eq!(joined_text(&assert_split_independent(&make, &stream)), "<the end>");
    }

    #[test]
    fn a_response_of_only_whitespace_and_a_partial_tag_keeps_its_text() {
        let mut decoder = CompatDecoder::new("m");
        let stream = "data: {\"choices\":[{\"delta\":{\"content\":\" <thi\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n";
        let events = decode(&mut decoder, stream, 4);
        assert_eq!(joined_text(&events), " <thi");
    }

    #[test]
    fn a_server_that_never_sends_done_still_finishes_if_it_gave_a_reason() {
        let stream = format!("data: {}\n\ndata: {}\n\n", chunk(json!({ "content": "hi" }), Value::Null), chunk(json!({}), json!("stop")));
        let events = assert_split_independent(&make, &stream);
        assert_eq!(done_of(&events).stop_reason, "end_turn");
    }

    #[test]
    fn a_stream_cut_off_gives_no_done_and_keeps_its_text() {
        let stream = format!("data: {}\n\n", chunk(json!({ "content": "half a sent" }), Value::Null));
        let mut decoder = CompatDecoder::new("m");
        let events = decode(&mut decoder, &stream, 3);
        assert!(!events.iter().any(|e| matches!(e, AiEvent::Done(_))));
        assert_eq!(decoder.partial(), vec![json!({ "type": "text", "text": "half a sent" })]);
    }

    #[test]
    fn an_error_inside_the_stream_is_reported() {
        let events = assert_split_independent(&make, "data: {\"error\":{\"code\":\"context_length_exceeded\",\"message\":\"prepared prompt exceeds Engine max_context 262144\"}}\n\n");
        let error = events.iter().find_map(|e| if let AiEvent::Error(err, _) = e { Some(err) } else { None }).unwrap();
        assert_eq!(error.code, "CONTEXT_TOO_LONG");
    }

    #[test]
    fn a_whole_json_body_is_understood() {
        let mut decoder = CompatDecoder::new("m");
        let events = decoder
            .on_whole_body(&json!({
                "model": "served", "usage": { "prompt_tokens": 1, "completion_tokens": 2 },
                "choices": [{ "finish_reason": "stop", "message": { "role": "assistant", "content": "pong", "reasoning_content": "think" } }],
            }).to_string())
            .unwrap();
        assert_eq!(joined_text(&events), "pong");
        assert_eq!(joined_thinking(&events), "think");
        assert_eq!(done_of(&events).model, "served");
        assert!(CompatDecoder::new("m").on_whole_body("<html>not json").is_none());
    }

    #[test]
    fn messages_are_built_for_chat_completions() {
        let messages: Vec<Message> = serde_json::from_value(json!([
            { "role": "user", "content": [{ "type": "text", "text": "lore" }, { "type": "text", "text": "q1" }] },
            { "role": "assistant", "content": [
                { "type": "thinking", "text": "old thought", "provider": "compat" },
                { "type": "text", "text": "a1", "provider": "compat" },
            ]},
            { "role": "user", "content": [{ "type": "text", "text": "q2" }] },
            { "role": "user", "content": [{ "type": "text", "text": "q3" }] },
            { "role": "assistant", "content": [
                { "type": "thinking", "text": "loop thought", "provider": "compat" },
                { "type": "toolCall", "id": "c1", "name": "get_page", "input": { "title": "A" }, "provider": "compat" },
            ]},
            { "role": "user", "content": [{ "type": "toolResult", "toolCallId": "c1", "content": "found" }] },
            // Blocks from Anthropic: signatures and raw forms must not leak to this server.
            { "role": "assistant", "content": [
                { "type": "thinking", "text": "claude", "provider": "anthropic", "raw": { "signature": "s" } },
                { "type": "opaque", "provider": "anthropic", "raw": { "type": "redacted_thinking" } },
                { "type": "text", "text": "from claude", "provider": "anthropic", "raw": { "type": "text", "text": "from claude" } },
            ]},
        ])).unwrap();
        let wire = wire_messages(Some("sys"), &messages);
        assert_eq!(wire[0], json!({ "role": "system", "content": "sys" }));
        assert_eq!(wire[1], json!({ "role": "user", "content": "lore\n\nq1" }));
        assert_eq!(wire[2], json!({ "role": "assistant", "content": "a1" }), "old thinking stays out");
        assert_eq!(wire[3], json!({ "role": "user", "content": "q2\n\nq3" }));
        assert_eq!(wire[4]["content"], Value::Null);
        assert_eq!(wire[4]["reasoning_content"], "loop thought");
        assert_eq!(wire[4]["tool_calls"][0]["function"]["arguments"], "{\"title\":\"A\"}");
        assert_eq!(wire[5], json!({ "role": "tool", "tool_call_id": "c1", "content": "found" }));
        assert_eq!(wire[6], json!({ "role": "assistant", "content": "from claude" }));
        assert_eq!(wire.len(), 7);
    }

    #[test]
    fn image_blocks_become_image_urls_in_a_content_list() {
        let messages: Vec<Message> = serde_json::from_value(json!([
            { "role": "user", "content": [
                { "type": "text", "text": "What is this?" },
                { "type": "image", "mime": "image/png", "base64": "AAAA" },
            ]},
        ])).unwrap();
        assert_eq!(wire_messages(None, &messages)[0], json!({ "role": "user", "content": [
            { "type": "text", "text": "What is this?" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
        ]}));
    }

    fn profile() -> Profile {
        Profile {
            kind: Kind::Compatible,
            ..Profile::default_local()
        }
    }

    #[test]
    fn the_request_asks_for_usage_and_has_no_sampling_parameters() {
        let req: StreamRequest = serde_json::from_value(json!({ "streamId": "s", "profileId": "local", "messages": [] })).unwrap();
        let prepared = build(&req, &profile(), "m", None).unwrap();
        assert_eq!(prepared.url, "http://127.0.0.1:8080/v1/chat/completions");
        assert_eq!(prepared.body["stream_options"], json!({ "include_usage": true }));
        assert_eq!(prepared.body["max_tokens"], 16_384);
        assert!(prepared.body.get("temperature").is_none());
        assert!(prepared.headers.is_empty());
    }

    #[test]
    fn what_a_server_refuses_is_dropped_and_retried() {
        let mut req: StreamRequest = serde_json::from_value(json!({ "streamId": "s", "profileId": "local", "messages": [] })).unwrap();
        req.json_schema = Some(JsonSchemaSpec { name: "x".into(), schema: json!({}) });
        let mut prepared = build(&req, &profile(), "m", None).unwrap();
        // The exact refusal from the local server.
        let refusal = Rejection {
            status: 400,
            code: "response_format_not_supported".into(),
            param: "response_format".into(),
            message: "this response_format requires constrained output, which this server cannot guarantee".into(),
            ..Default::default()
        };
        assert!(relax(&mut prepared, &refusal));
        assert!(prepared.body.get("response_format").is_none());
        assert!(!relax(&mut prepared, &refusal));

        let tokens = Rejection { status: 400, param: "max_tokens".into(), message: "Use 'max_completion_tokens' instead.".into(), ..Default::default() };
        assert!(relax(&mut prepared, &tokens));
        assert_eq!(prepared.body["max_completion_tokens"], 16_384);
        assert!(prepared.body.get("max_tokens").is_none());
    }
}
