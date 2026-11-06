//! OpenAI, through the Responses API.
//!
//! Chat Completions "remains supported, Responses is recommended for all new projects",
//! and the newest models (GPT-6 Astra, GPT-6.1 Sol) require Responses for tool calling.
//! Reasoning summaries are also only available here. Local servers use `compat.rs`.
//!
//! Requests are stateless (`store: false`). Each output item, including reasoning with
//! its `encrypted_content` and an assistant message's `phase`, is kept whole and sent
//! back unchanged on later turns, as the API asks. `max_output_tokens` caps reasoning and
//! visible output together.

use serde_json::{json, Map, Value};

use super::profile::Profile;
use super::sse::SseEvent;
use super::transport::Prepared;
use super::types::*;

pub const PROVIDER: &str = "openai";

/// Normalized messages to Responses input items. `model` decides whether stored items
/// can replay: reasoning belongs to the model that wrote it.
pub fn wire_input(messages: &[Message], model: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for message in messages {
        let mut user_parts: Vec<Value> = Vec::new();
        let flush_user = |parts: &mut Vec<Value>, out: &mut Vec<Value>| {
            if !parts.is_empty() {
                out.push(json!({ "role": "user", "content": std::mem::take(parts) }));
            }
        };
        for block in &message.content {
            let replayable = block_str(block, "model").is_empty() || block_str(block, "model") == model;
            let raw = raw_for(block, PROVIDER).filter(|_| replayable);
            match block_type(block) {
                "text" => {
                    let text = block_str(block, "text");
                    if text.is_empty() {
                        continue;
                    }
                    if message.role == "assistant" {
                        out.push(match raw {
                            Some(raw) => raw.clone(),
                            None => json!({ "role": "assistant", "content": text }),
                        });
                    } else {
                        user_parts.push(json!({ "type": "input_text", "text": text }));
                    }
                }
                "thinking" | "opaque" => {
                    if let Some(raw) = raw {
                        out.push(raw.clone());
                    }
                }
                "toolCall" => out.push(match raw {
                    Some(raw) => raw.clone(),
                    None => json!({
                        "type": "function_call",
                        "call_id": safe_tool_id(block_str(block, "id")),
                        "name": block_str(block, "name"),
                        "arguments": input_object(block).to_string(),
                    }),
                }),
                "toolResult" => {
                    flush_user(&mut user_parts, &mut out);
                    out.push(json!({
                        "type": "function_call_output",
                        "call_id": safe_tool_id(block_str(block, "toolCallId")),
                        "output": block_str(block, "content"),
                    }));
                }
                "image" if message.role != "assistant" => user_parts.push(json!({
                    "type": "input_image",
                    "image_url": image_data_url(block),
                    "detail": "auto",
                })),
                _ => {}
            }
        }
        flush_user(&mut user_parts, &mut out);
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
    body.insert("store".into(), json!(false));
    if let Some(system) = request.system.as_deref().filter(|s| !s.is_empty()) {
        body.insert("instructions".into(), json!(system));
    }
    body.insert("input".into(), Value::Array(wire_input(&request.messages, model)));
    body.insert("max_output_tokens".into(), json!(max_tokens));

    let mut reasoning = Map::new();
    reasoning.insert("summary".into(), json!("auto"));
    if let Some(effort) = request.effort.as_deref().or(profile.effort.as_deref()).filter(|e| !e.is_empty()) {
        reasoning.insert("effort".into(), json!(effort));
    }
    body.insert("reasoning".into(), Value::Object(reasoning));
    body.insert("include".into(), json!(["reasoning.encrypted_content"]));

    if !request.tools.is_empty() {
        let mut tools = request.tools.clone();
        tools.sort_by(|a, b| a.name.cmp(&b.name));
        let wire: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.input_schema,
                    // Strict mode needs every field required, and these have optional ones.
                    // Input is validated before a tool runs either way.
                    "strict": false,
                })
            })
            .collect();
        body.insert("tools".into(), Value::Array(wire));
        let choice = if request.tool_choice.as_deref() == Some("none") { "none" } else { "auto" };
        body.insert("tool_choice".into(), json!(choice));
    }
    if let Some(spec) = &request.json_schema {
        body.insert(
            "text".into(),
            json!({ "format": { "type": "json_schema", "name": spec.name, "schema": spec.schema, "strict": true } }),
        );
    }
    if let Some(cache_key) = request.cache_key.as_deref().filter(|k| !k.is_empty()) {
        body.insert("prompt_cache_key".into(), json!(cache_key));
    }
    let mut headers = Vec::new();
    if let Some(key) = key {
        headers.push(("authorization".to_string(), format!("Bearer {key}")));
    }
    Ok(Prepared {
        url: format!("{root}/responses"),
        headers,
        body: Value::Object(body),
    })
}

/// Not every model takes every field. For example, summaries can require a verified
/// organization, and models without reasoning refuse the `reasoning` object.
pub fn relax(prepared: &mut Prepared, rejection: &Rejection) -> bool {
    let Some(body) = prepared.body.as_object_mut() else {
        return false;
    };
    let message = rejection.message.to_ascii_lowercase();
    let param = rejection.param.as_str();
    let mentions = |name: &str| param == name || message.contains(name);
    if mentions("reasoning.summary") {
        if let Some(reasoning) = body.get_mut("reasoning").and_then(Value::as_object_mut) {
            if reasoning.remove("summary").is_some() {
                if reasoning.is_empty() {
                    body.remove("reasoning");
                }
                return true;
            }
        }
    }
    if mentions("reasoning.encrypted_content") || param == "include" {
        if body.remove("include").is_some() {
            return true;
        }
    }
    if (mentions("reasoning.effort") || param == "reasoning" || message.contains("'reasoning'"))
        && body.remove("reasoning").is_some()
    {
        return true;
    }
    if (param == "prompt_cache_key" || message.contains("prompt_cache_key")) && body.remove("prompt_cache_key").is_some() {
        return true;
    }
    false
}

#[derive(Debug, Default)]
pub struct ResponsesDecoder {
    /// Finished output items by `output_index`.
    items: Vec<(u64, Value)>,
    /// Text seen so far, for a response that gets cut off.
    text_so_far: String,
    model: String,
    usage: Usage,
    stop_reason: Option<String>,
    stop_details: Value,
    refusal: String,
    complete: bool,
    failed: bool,
    summary_parts: u64,
    announced: Vec<String>,
}

impl ResponsesDecoder {
    pub fn new(model: &str) -> Self {
        Self {
            model: model.to_string(),
            stop_details: Value::Null,
            ..Default::default()
        }
    }

    fn store_item(&mut self, index: u64, item: Value) {
        if let Some(slot) = self.items.iter_mut().find(|(i, _)| *i == index) {
            slot.1 = item;
        } else {
            self.items.push((index, item));
        }
    }

    fn read_usage(&mut self, usage: &Value) {
        let number = |value: &Value, key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
        self.usage.input = number(usage, "input_tokens");
        self.usage.output = number(usage, "output_tokens");
        if let Some(details) = usage.get("input_tokens_details") {
            self.usage.cache_read = number(details, "cached_tokens");
            self.usage.cache_write = number(details, "cache_write_tokens");
        }
        if let Some(details) = usage.get("output_tokens_details") {
            self.usage.reasoning = number(details, "reasoning_tokens");
        }
    }

    /// `response.completed` and friends carry the whole response, which fills in any
    /// item whose own event was missed.
    fn read_response(&mut self, response: &Value) {
        if let Some(model) = response.get("model").and_then(Value::as_str) {
            self.model = model.to_string();
        }
        if let Some(usage) = response.get("usage").filter(|u| !u.is_null()) {
            self.read_usage(usage);
        }
        if let Some(output) = response.get("output").and_then(Value::as_array) {
            for (index, item) in output.iter().enumerate() {
                let index = index as u64;
                if !self.items.iter().any(|(i, _)| *i == index) {
                    self.items.push((index, item.clone()));
                }
            }
        }
    }

    fn refusal_details(explanation: &str, category: Value) -> Value {
        json!({ "category": category, "explanation": explanation, "recommendedModel": null })
    }

    fn message_text(item: &Value) -> String {
        item.get("content")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter(|p| block_type(p) == "output_text")
                    .map(|p| block_str(p, "text"))
                    .collect::<String>()
            })
            .unwrap_or_default()
    }

    fn message_refusal(item: &Value) -> String {
        item.get("content")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter(|p| block_type(p) == "refusal")
                    .map(|p| block_str(p, "refusal"))
                    .collect::<String>()
            })
            .unwrap_or_default()
    }

    fn reasoning_text(item: &Value) -> String {
        let mut parts: Vec<&str> = Vec::new();
        for key in ["summary", "content"] {
            if let Some(list) = item.get(key).and_then(Value::as_array) {
                parts.extend(list.iter().map(|p| block_str(p, "text")).filter(|t| !t.is_empty()));
            }
        }
        parts.join("\n\n")
    }

    fn normalized(&self) -> Vec<Value> {
        let mut items: Vec<&(u64, Value)> = self.items.iter().collect();
        items.sort_by_key(|(index, _)| *index);
        items
            .iter()
            .map(|(_, item)| match block_type(item) {
                "message" => json!({
                    "type": "text", "text": Self::message_text(item),
                    "provider": PROVIDER, "model": self.model, "raw": item,
                }),
                "reasoning" => json!({
                    "type": "thinking", "text": Self::reasoning_text(item),
                    "provider": PROVIDER, "model": self.model, "raw": item,
                }),
                "function_call" => {
                    let (input, invalid) = parse_arguments(block_str(item, "arguments"));
                    let mut block = json!({
                        "type": "toolCall", "id": block_str(item, "call_id"), "name": block_str(item, "name"),
                        "input": input, "provider": PROVIDER, "model": self.model, "raw": item,
                    });
                    if let Some(raw) = invalid {
                        block["invalid"] = json!(raw);
                    }
                    block
                }
                _ => json!({ "type": "opaque", "provider": PROVIDER, "model": self.model, "raw": item }),
            })
            .collect()
    }

    fn error_from(&mut self, code: &str, message: &str) -> AiEvent {
        self.failed = true;
        let policy = matches!(code, "bio_policy" | "misalignment_policy_violation");
        if policy {
            // A policy block is a refusal, and gets the same handling as one.
            self.failed = false;
            self.complete = true;
            self.stop_reason = Some("refusal".to_string());
            self.stop_details = Self::refusal_details(message, json!(code));
            return AiEvent::Usage(self.usage.clone());
        }
        let mapped = match code {
            "rate_limit_exceeded" => StreamError::new("RATE_LIMITED", "OpenAI's rate limit was reached. Wait a moment and try again.").retryable(),
            "server_error" => StreamError::new("SERVER_ERROR", "OpenAI reported a server error. Try again in a moment.").retryable(),
            "context_length_exceeded" => StreamError::new(
                "CONTEXT_TOO_LONG",
                "This request is too long for the model. Lower the context size in Settings > AI, or exclude some pages in the context view.",
            ),
            _ => StreamError::new("BAD_REQUEST", if message.is_empty() { "OpenAI reported an error.".to_string() } else { message.to_string() }),
        };
        AiEvent::Error(mapped, self.partial())
    }
}

fn parse_arguments(arguments: &str) -> (Value, Option<String>) {
    if arguments.trim().is_empty() {
        return (Value::Object(Map::new()), None);
    }
    match serde_json::from_str::<Value>(arguments) {
        Ok(value) if value.is_object() => (value, None),
        _ => (Value::Object(Map::new()), Some(arguments.to_string())),
    }
}

impl Decoder for ResponsesDecoder {
    fn on_event(&mut self, event: &SseEvent) -> Vec<AiEvent> {
        let Ok(data) = serde_json::from_str::<Value>(&event.data) else {
            return Vec::new();
        };
        let name = data.get("type").and_then(Value::as_str).unwrap_or(event.event.as_str()).to_string();
        let mut out = Vec::new();
        match name.as_str() {
            "response.created" | "response.in_progress" | "response.queued" => {
                if let Some(model) = data.get("response").and_then(|r| r.get("model")).and_then(Value::as_str) {
                    self.model = model.to_string();
                }
            }
            "response.output_text.delta" => {
                let delta = block_str(&data, "delta");
                self.text_so_far.push_str(delta);
                out.push(AiEvent::Text(delta.to_string()));
            }
            "response.reasoning_summary_part.added" => {
                self.summary_parts += 1;
                if self.summary_parts > 1 {
                    out.push(AiEvent::Thinking("\n\n".to_string()));
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                out.push(AiEvent::Thinking(block_str(&data, "delta").to_string()));
            }
            "response.refusal.delta" => self.refusal.push_str(block_str(&data, "delta")),
            "response.refusal.done" => {
                let done = block_str(&data, "refusal");
                if !done.is_empty() {
                    self.refusal = done.to_string();
                }
            }
            "response.output_item.added" => {
                if let Some(item) = data.get("item").filter(|i| block_type(i) == "function_call") {
                    let id = block_str(item, "call_id").to_string();
                    if !self.announced.contains(&id) {
                        self.announced.push(id.clone());
                        out.push(AiEvent::ToolStart { id, name: block_str(item, "name").to_string() });
                    }
                }
            }
            "response.output_item.done" => {
                if let Some(item) = data.get("item").cloned() {
                    let index = data.get("output_index").and_then(Value::as_u64).unwrap_or(self.items.len() as u64);
                    if block_type(&item) == "function_call" {
                        let (input, invalid) = parse_arguments(block_str(&item, "arguments"));
                        out.push(AiEvent::ToolCall {
                            id: block_str(&item, "call_id").to_string(),
                            name: block_str(&item, "name").to_string(),
                            input,
                            invalid,
                        });
                    }
                    self.store_item(index, item);
                }
            }
            "response.completed" => {
                let response = data.get("response").cloned().unwrap_or(Value::Null);
                self.read_response(&response);
                self.complete = true;
                self.stop_reason = Some(if !self.refusal.is_empty() {
                    self.stop_details = Self::refusal_details(&self.refusal, Value::Null);
                    "refusal".to_string()
                } else if self.items.iter().any(|(_, item)| block_type(item) == "function_call") {
                    "tool_use".to_string()
                } else {
                    "end_turn".to_string()
                });
            }
            "response.incomplete" => {
                let response = data.get("response").cloned().unwrap_or(Value::Null);
                self.read_response(&response);
                self.complete = true;
                let reason = response
                    .get("incomplete_details")
                    .map(|d| block_str(d, "reason").to_string())
                    .unwrap_or_default();
                self.stop_reason = Some(match reason.as_str() {
                    "content_filter" => {
                        self.stop_details = Self::refusal_details("The provider's content filter stopped this response.", json!("content_filter"));
                        "refusal".to_string()
                    }
                    _ => "max_tokens".to_string(),
                });
            }
            "response.failed" => {
                let response = data.get("response").cloned().unwrap_or(Value::Null);
                self.read_response(&response);
                let error = response.get("error").cloned().unwrap_or(Value::Null);
                let code = block_str(&error, "code").to_string();
                let message = block_str(&error, "message").to_string();
                out.push(self.error_from(&code, &message));
            }
            "error" => {
                let code = block_str(&data, "code").to_string();
                let message = block_str(&data, "message").to_string();
                out.push(self.error_from(&code, &message));
            }
            _ => {}
        }
        out
    }

    fn finished(&self) -> bool {
        self.complete
    }

    fn finish(&mut self) -> Vec<AiEvent> {
        if self.failed || !self.complete {
            return Vec::new();
        }
        // A refused message has nothing worth replaying.
        for (_, item) in &self.items {
            if block_type(item) == "message" && self.refusal.is_empty() {
                let refusal = Self::message_refusal(item);
                if !refusal.is_empty() {
                    self.refusal = refusal;
                }
            }
        }
        if !self.refusal.is_empty() && self.stop_reason.as_deref() != Some("refusal") {
            self.stop_reason = Some("refusal".to_string());
            self.stop_details = Self::refusal_details(&self.refusal, Value::Null);
        }
        vec![
            AiEvent::Usage(self.usage.clone()),
            AiEvent::Done(Done {
                stop_reason: self.stop_reason.clone().unwrap_or_else(|| "end_turn".to_string()),
                stop_details: self.stop_details.clone(),
                content: self.normalized(),
                model: self.model.clone(),
                provider: PROVIDER,
                fallback: Value::Null,
            }),
        ]
    }

    fn partial(&self) -> Vec<Value> {
        if self.text_so_far.is_empty() {
            Vec::new()
        } else {
            vec![json!({ "type": "text", "text": self.text_so_far })]
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
            id: "o".into(),
            name: "OpenAI".into(),
            kind: Kind::OpenAi,
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-6-astra".into(),
            is_cloud: true,
            max_tokens: None,
            effort: Some("medium".into()),
            supports_images: None,
        }
    }

    fn make() -> Box<dyn Decoder> {
        Box::new(ResponsesDecoder::new("gpt-6-astra"))
    }

    fn sse(events: &[Value]) -> String {
        let mut out = String::new();
        for (sequence, event) in events.iter().enumerate() {
            let mut event = event.clone();
            event["sequence_number"] = json!(sequence);
            out.push_str(&format!("event: {}\ndata: {}\n\n", block_str(&event, "type"), event));
        }
        out
    }

    fn usage() -> Value {
        json!({
            "input_tokens": 100, "input_tokens_details": { "cached_tokens": 40, "cache_write_tokens": 0 },
            "output_tokens": 30, "output_tokens_details": { "reasoning_tokens": 12 }, "total_tokens": 130,
        })
    }

    #[test]
    fn the_request_uses_the_responses_format() {
        let mut req: StreamRequest = serde_json::from_value(json!({
            "streamId": "s", "profileId": "o", "system": "You help novelists.", "cacheKey": "conv1",
            "messages": [{ "role": "user", "content": [{ "type": "text", "text": "Hi" }] }],
        })).unwrap();
        req.tools = vec![ToolDef { name: "search_lore".into(), description: "d".into(), input_schema: json!({ "type": "object" }) }];
        req.json_schema = Some(JsonSchemaSpec { name: "answer".into(), schema: json!({ "type": "object" }) });
        let prepared = build(&req, &profile(), "gpt-6-astra", Some("sk-x")).unwrap();
        assert_eq!(prepared.url, "https://api.openai.com/v1/responses");
        assert!(prepared.headers.contains(&("authorization".to_string(), "Bearer sk-x".to_string())));
        let body = &prepared.body;
        assert_eq!(body["store"], false);
        assert_eq!(body["instructions"], "You help novelists.");
        assert_eq!(body["max_output_tokens"], 32_000);
        assert_eq!(body["reasoning"], json!({ "summary": "auto", "effort": "medium" }));
        assert_eq!(body["input"][0], json!({ "role": "user", "content": [{ "type": "input_text", "text": "Hi" }] }));
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["name"], "search_lore");
        assert_eq!(body["tools"][0]["parameters"], json!({ "type": "object" }));
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["text"]["format"]["type"], "json_schema");
        assert_eq!(body["prompt_cache_key"], "conv1");
        for banned in ["max_tokens", "max_completion_tokens", "temperature", "top_p", "messages"] {
            assert!(body.get(banned).is_none(), "{banned} is not part of this request");
        }
    }

    #[test]
    fn a_response_with_reasoning_text_and_a_tool_call_decodes() {
        let reasoning = json!({ "id": "rs_1", "type": "reasoning", "summary": [{ "type": "summary_text", "text": "Thinking about Aria." }], "encrypted_content": "ENC" });
        let call = json!({ "id": "fc_1", "type": "function_call", "call_id": "call_1", "name": "search_lore", "arguments": "{\"query\":\"Aria\",\"limit\":2}", "status": "completed" });
        let message = json!({ "id": "msg_1", "type": "message", "role": "assistant", "status": "completed", "phase": "commentary",
            "content": [{ "type": "output_text", "text": "Checking caf\u{e9}.", "annotations": [] }] });
        let stream = sse(&[
            json!({ "type": "response.created", "response": { "id": "resp_1", "model": "gpt-6-astra", "status": "in_progress", "output": [] } }),
            json!({ "type": "response.in_progress", "response": { "id": "resp_1" } }),
            json!({ "type": "response.output_item.added", "output_index": 0, "item": { "id": "rs_1", "type": "reasoning", "summary": [] } }),
            json!({ "type": "response.reasoning_summary_part.added", "item_id": "rs_1", "output_index": 0, "summary_index": 0, "part": { "type": "summary_text", "text": "" } }),
            json!({ "type": "response.reasoning_summary_text.delta", "item_id": "rs_1", "output_index": 0, "summary_index": 0, "delta": "Thinking about " }),
            json!({ "type": "response.reasoning_summary_text.delta", "item_id": "rs_1", "output_index": 0, "summary_index": 0, "delta": "Aria." }),
            json!({ "type": "response.reasoning_summary_text.done", "item_id": "rs_1", "output_index": 0, "summary_index": 0, "text": "Thinking about Aria." }),
            json!({ "type": "response.reasoning_summary_part.done", "item_id": "rs_1", "output_index": 0, "summary_index": 0, "part": { "type": "summary_text", "text": "Thinking about Aria." } }),
            json!({ "type": "response.output_item.done", "output_index": 0, "item": reasoning }),
            json!({ "type": "response.output_item.added", "output_index": 1, "item": { "id": "msg_1", "type": "message", "role": "assistant", "content": [], "status": "in_progress" } }),
            json!({ "type": "response.content_part.added", "item_id": "msg_1", "output_index": 1, "content_index": 0, "part": { "type": "output_text", "text": "" } }),
            json!({ "type": "response.output_text.delta", "item_id": "msg_1", "output_index": 1, "content_index": 0, "delta": "Checking " }),
            json!({ "type": "response.output_text.delta", "item_id": "msg_1", "output_index": 1, "content_index": 0, "delta": "caf\u{e9}." }),
            json!({ "type": "response.output_text.done", "item_id": "msg_1", "output_index": 1, "content_index": 0, "text": "Checking caf\u{e9}." }),
            json!({ "type": "response.content_part.done", "item_id": "msg_1", "output_index": 1, "content_index": 0, "part": { "type": "output_text", "text": "Checking caf\u{e9}." } }),
            json!({ "type": "response.output_item.done", "output_index": 1, "item": message }),
            json!({ "type": "response.output_item.added", "output_index": 2, "item": { "id": "fc_1", "type": "function_call", "call_id": "call_1", "name": "search_lore", "arguments": "" } }),
            json!({ "type": "response.function_call_arguments.delta", "item_id": "fc_1", "output_index": 2, "delta": "{\"query\":\"Aria\"," }),
            json!({ "type": "response.function_call_arguments.delta", "item_id": "fc_1", "output_index": 2, "delta": "\"limit\":2}" }),
            json!({ "type": "response.function_call_arguments.done", "item_id": "fc_1", "output_index": 2, "arguments": "{\"query\":\"Aria\",\"limit\":2}" }),
            json!({ "type": "response.output_item.done", "output_index": 2, "item": call }),
            json!({ "type": "response.completed", "response": { "id": "resp_1", "model": "gpt-6-astra-2026", "status": "completed", "output": [reasoning, message, call], "usage": usage() } }),
        ]);
        let events = assert_split_independent(&make, &stream);
        assert_eq!(joined_text(&events), "Checking caf\u{e9}.");
        assert_eq!(joined_thinking(&events), "Thinking about Aria.");
        assert!(events.contains(&AiEvent::ToolStart { id: "call_1".into(), name: "search_lore".into() }));
        assert!(events.iter().any(|e| matches!(e, AiEvent::ToolCall { id, input, invalid: None, .. } if id == "call_1" && input == &json!({ "query": "Aria", "limit": 2 }))));

        let done = done_of(&events);
        assert_eq!(done.stop_reason, "tool_use");
        assert_eq!(done.model, "gpt-6-astra-2026");
        // Each item replays whole: encrypted reasoning, the phase field, the call id.
        assert_eq!(done.content[0]["raw"]["encrypted_content"], "ENC");
        assert_eq!(done.content[1]["raw"]["phase"], "commentary");
        assert_eq!(done.content[2]["raw"]["call_id"], "call_1");

        let usage = events.iter().rev().find_map(|e| if let AiEvent::Usage(u) = e { Some(u.clone()) } else { None }).unwrap();
        assert_eq!(usage, Usage { input: 100, output: 30, cache_read: 40, cache_write: 0, reasoning: 12 });
    }

    #[test]
    fn a_response_cut_off_by_the_limit_is_max_tokens() {
        let stream = sse(&[
            json!({ "type": "response.output_text.delta", "delta": "Some" }),
            json!({ "type": "response.incomplete", "response": { "status": "incomplete", "incomplete_details": { "reason": "max_output_tokens" }, "output": [], "usage": usage() } }),
        ]);
        let events = assert_split_independent(&make, &stream);
        assert_eq!(done_of(&events).stop_reason, "max_tokens");
    }

    #[test]
    fn a_refusal_part_is_a_refusal_with_its_explanation() {
        let stream = sse(&[
            json!({ "type": "response.refusal.delta", "item_id": "msg_1", "output_index": 0, "content_index": 0, "delta": "I can't " }),
            json!({ "type": "response.refusal.delta", "item_id": "msg_1", "output_index": 0, "content_index": 0, "delta": "help." }),
            json!({ "type": "response.refusal.done", "item_id": "msg_1", "output_index": 0, "content_index": 0, "refusal": "I can't help." }),
            json!({ "type": "response.completed", "response": { "status": "completed", "output": [], "usage": usage() } }),
        ]);
        let events = assert_split_independent(&make, &stream);
        let done = done_of(&events);
        assert_eq!(done.stop_reason, "refusal");
        assert_eq!(done.stop_details["explanation"], "I can't help.");
    }

    #[test]
    fn a_policy_failure_is_treated_as_a_refusal() {
        let stream = sse(&[
            json!({ "type": "response.failed", "response": { "status": "failed", "error": { "code": "bio_policy", "message": "Blocked by policy." }, "output": [] } }),
        ]);
        let events = assert_split_independent(&make, &stream);
        let done = done_of(&events);
        assert_eq!(done.stop_reason, "refusal");
        assert_eq!(done.stop_details["category"], "bio_policy");
    }

    #[test]
    fn failures_and_errors_map_to_clear_codes() {
        let stream = sse(&[json!({ "type": "response.failed", "response": { "error": { "code": "server_error", "message": "boom" } } })]);
        let events = assert_split_independent(&make, &stream);
        let error = events.iter().find_map(|e| if let AiEvent::Error(err, _) = e { Some(err) } else { None }).unwrap();
        assert_eq!(error.code, "SERVER_ERROR");
        assert!(error.retryable);

        let stream = sse(&[json!({ "type": "error", "code": "context_length_exceeded", "message": "too long", "param": null })]);
        let events = assert_split_independent(&make, &stream);
        let error = events.iter().find_map(|e| if let AiEvent::Error(err, _) = e { Some(err) } else { None }).unwrap();
        assert_eq!(error.code, "CONTEXT_TOO_LONG");
        assert!(!events.iter().any(|e| matches!(e, AiEvent::Done(_))));
    }

    #[test]
    fn malformed_arguments_are_reported() {
        let call = json!({ "id": "fc_1", "type": "function_call", "call_id": "c", "name": "get_page", "arguments": "{oops" });
        let stream = sse(&[
            json!({ "type": "response.output_item.done", "output_index": 0, "item": call }),
            json!({ "type": "response.completed", "response": { "status": "completed", "output": [call], "usage": usage() } }),
        ]);
        let events = assert_split_independent(&make, &stream);
        assert!(events.iter().any(|e| matches!(e, AiEvent::ToolCall { invalid: Some(raw), .. } if raw == "{oops")));
        assert_eq!(done_of(&events).content[0]["invalid"], "{oops");
    }

    #[test]
    fn items_replay_whole_on_the_same_model_and_convert_otherwise() {
        let reasoning = json!({ "id": "rs_1", "type": "reasoning", "summary": [], "encrypted_content": "ENC" });
        let message = json!({ "id": "msg_1", "type": "message", "role": "assistant", "phase": "final_answer", "content": [{ "type": "output_text", "text": "Hi" }] });
        let call = json!({ "id": "fc_1", "type": "function_call", "call_id": "call_1", "name": "get_page", "arguments": "{\"title\":\"A\"}" });
        let messages: Vec<Message> = serde_json::from_value(json!([
            { "role": "user", "content": [{ "type": "text", "text": "q" }] },
            { "role": "assistant", "content": [
                { "type": "thinking", "text": "", "provider": "openai", "model": "gpt-6-astra", "raw": reasoning },
                { "type": "text", "text": "Hi", "provider": "openai", "model": "gpt-6-astra", "raw": message },
                { "type": "toolCall", "id": "call_1", "name": "get_page", "input": { "title": "A" }, "provider": "openai", "model": "gpt-6-astra", "raw": call },
            ]},
            { "role": "user", "content": [
                { "type": "toolResult", "toolCallId": "call_1", "content": "found" },
                { "type": "text", "text": "and then?" },
            ]},
        ])).unwrap();

        let same = wire_input(&messages, "gpt-6-astra");
        assert_eq!(same[1], reasoning);
        assert_eq!(same[2], message);
        assert_eq!(same[3], call);
        assert_eq!(same[4], json!({ "type": "function_call_output", "call_id": "call_1", "output": "found" }));
        assert_eq!(same[5], json!({ "role": "user", "content": [{ "type": "input_text", "text": "and then?" }] }));

        // A different model cannot read the reasoning, and the ids tie items to it.
        let other = wire_input(&messages, "gpt-6.1-sol");
        assert_eq!(other[1], json!({ "role": "assistant", "content": "Hi" }));
        assert_eq!(other[2], json!({ "type": "function_call", "call_id": "call_1", "name": "get_page", "arguments": "{\"title\":\"A\"}" }));
        assert_eq!(other.len(), 5);
    }

    #[test]
    fn another_providers_blocks_convert_safely() {
        let messages: Vec<Message> = serde_json::from_value(json!([
            { "role": "assistant", "content": [
                { "type": "thinking", "text": "x", "provider": "anthropic", "raw": { "type": "thinking", "signature": "s" } },
                { "type": "opaque", "provider": "anthropic", "raw": { "type": "redacted_thinking", "data": "d" } },
                { "type": "text", "text": "Hello", "provider": "anthropic", "raw": { "type": "text", "text": "Hello" } },
                { "type": "toolCall", "id": "toolu_1", "name": "get_page", "input": { "title": "A" }, "provider": "anthropic", "raw": { "type": "tool_use" } },
            ]},
        ])).unwrap();
        let wire = wire_input(&messages, "gpt-6-astra");
        assert_eq!(wire, vec![
            json!({ "role": "assistant", "content": "Hello" }),
            json!({ "type": "function_call", "call_id": "toolu_1", "name": "get_page", "arguments": "{\"title\":\"A\"}" }),
        ]);
    }

    #[test]
    fn image_blocks_become_input_images() {
        let messages: Vec<Message> = serde_json::from_value(json!([
            { "role": "user", "content": [
                { "type": "text", "text": "What is this?" },
                { "type": "image", "mime": "image/png", "base64": "AAAA" },
            ]},
        ])).unwrap();
        assert_eq!(wire_input(&messages, "gpt-6-astra")[0], json!({ "role": "user", "content": [
            { "type": "input_text", "text": "What is this?" },
            { "type": "input_image", "image_url": "data:image/png;base64,AAAA", "detail": "auto" },
        ]}));
    }

    #[test]
    fn fields_a_model_refuses_are_dropped_and_retried() {
        let req: StreamRequest = serde_json::from_value(json!({ "streamId": "s", "profileId": "o", "messages": [] })).unwrap();
        let mut prepared = build(&req, &profile(), "gpt-4.1", Some("k")).unwrap();
        let summary = Rejection { status: 400, param: "reasoning.summary".into(), message: "Your organization must be verified.".into(), ..Default::default() };
        assert!(relax(&mut prepared, &summary));
        assert_eq!(prepared.body["reasoning"], json!({ "effort": "medium" }));
        let effort = Rejection { status: 400, param: "reasoning.effort".into(), message: "Unsupported parameter: 'reasoning.effort'".into(), ..Default::default() };
        assert!(relax(&mut prepared, &effort));
        assert!(prepared.body.get("reasoning").is_none());
        let include = Rejection { status: 400, param: "include".into(), message: "Encrypted content is not supported with this model.".into(), ..Default::default() };
        assert!(relax(&mut prepared, &include));
        assert!(prepared.body.get("include").is_none());
        assert!(!relax(&mut prepared, &Rejection { status: 400, param: "input".into(), message: "bad".into(), ..Default::default() }));
    }
}
