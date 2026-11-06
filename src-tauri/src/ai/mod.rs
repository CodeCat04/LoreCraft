//! Provider streaming. See docs/ARCHITECTURE.md.
//!
//! `ai_stream` turns one normalized request into one provider response, delivered as
//! normalized events. Orchestration (context, the tool loop, suggestions) is in
//! TypeScript. Each provider has its own module: request building and stream decoding
//! there, and shared timeouts, retries and error wording in `transport`.

pub mod anthropic;
pub mod compat;
pub mod discover;
pub mod keys;
pub mod models;
pub mod openai;
pub mod profile;
pub mod sse;
pub mod transport;
pub mod types;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::Value;
use tauri::ipc::Channel;
use tokio::sync::watch;

use crate::engine::Engine;
use crate::paths;
use profile::{Kind, Profile};
use transport::{Prepared, RunOptions};
use types::*;

// ---- Cancellation -----------------------------------------------------------

#[derive(Default)]
struct Registry {
    streams: HashMap<String, watch::Sender<bool>>,
    /// Cancelled before they registered, since the two commands can race.
    early: HashSet<String>,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(Mutex::default)
}

fn lock_registry() -> std::sync::MutexGuard<'static, Registry> {
    registry().lock().unwrap_or_else(|e| e.into_inner())
}

fn register(stream_id: &str) -> watch::Receiver<bool> {
    let mut registry = lock_registry();
    let (tx, rx) = watch::channel(false);
    if registry.early.remove(stream_id) {
        let _ = tx.send(true);
    }
    registry.streams.insert(stream_id.to_string(), tx);
    rx
}

fn unregister(stream_id: &str) {
    lock_registry().streams.remove(stream_id);
}

pub fn cancel(stream_id: &str) {
    let mut registry = lock_registry();
    match registry.streams.get(stream_id) {
        Some(tx) => {
            let _ = tx.send(true);
        }
        None => {
            // Keep this bounded: an id that never registers is only ever a stray.
            if registry.early.len() > 64 {
                registry.early.clear();
            }
            registry.early.insert(stream_id.to_string());
        }
    }
}

// ---- Running a request ------------------------------------------------------

/// True when requests go to the real provider, so its newer fields are safe. Anything in
/// front of it may refuse them. The E2E mock imitates the real API, so it counts.
fn is_first_party_anthropic(profile: &Profile) -> bool {
    let root = profile.api_root().unwrap_or_default().to_ascii_lowercase();
    root == "https://api.anthropic.com" || paths::is_e2e()
}

fn prepare(
    request: &StreamRequest,
    profile: &Profile,
    model: &str,
    key: Option<&str>,
) -> Result<Prepared, StreamError> {
    match profile.kind {
        Kind::Anthropic => anthropic::build(request, profile, model, key, is_first_party_anthropic(profile)),
        Kind::OpenAi => openai::build(request, profile, model, key),
        Kind::Compatible => compat::build(request, profile, model, key),
    }
}

fn new_decoder(kind: Kind, model: &str) -> Box<dyn Decoder> {
    match kind {
        Kind::Anthropic => Box::new(anthropic::AnthropicDecoder::new(model)),
        Kind::OpenAi => Box::new(openai::ResponsesDecoder::new(model)),
        Kind::Compatible => Box::new(compat::CompatDecoder::new(model)),
    }
}

fn relax_for(kind: Kind) -> fn(&mut Prepared, &Rejection) -> bool {
    match kind {
        Kind::Anthropic => anthropic::relax,
        Kind::OpenAi => openai::relax,
        Kind::Compatible => compat::relax,
    }
}

async fn resolve_model(request: &StreamRequest, profile: &Profile, key: Option<&str>) -> Result<String, StreamError> {
    let chosen = request.model.as_deref().map(str::trim).filter(|m| !m.is_empty()).unwrap_or(&profile.model);
    if !chosen.is_empty() {
        return Ok(chosen.to_string());
    }
    match profile.kind {
        Kind::Anthropic => Ok(profile::DEFAULT_ANTHROPIC_MODEL.to_string()),
        Kind::OpenAi => Ok(profile::DEFAULT_OPENAI_MODEL.to_string()),
        Kind::Compatible => models::pick_local_model(profile, key).await,
    }
}

/// Loads what a request needs from settings and the credential store. Locks are released
/// before any network use.
fn load_profile_and_key(engine: &Engine, profile_id: &str) -> Result<(Profile, Option<String>), StreamError> {
    let profile = {
        let settings = engine.settings();
        Profile::from_settings(&settings, profile_id)?
    };
    let key = keys::get(&engine.paths, profile_id).map_err(|e| StreamError::new("KEY_STORE", e.message))?;
    if profile.needs_key() && key.is_none() {
        return Err(StreamError::new(
            "NO_KEY",
            format!("Add an API key for {} in Settings > AI.", profile.provider_name()),
        ));
    }
    Ok((profile, key))
}

/// Runs one request to its terminal event. Always delivers exactly one `done` or `error`.
pub async fn run_request(engine: &Engine, request: StreamRequest, mut deliver: impl FnMut(Value) + Send) {
    // Only the code goes in the log: a provider's error text can echo the prompt.
    let mut sink = move |event: Value| {
        if event["type"] == "error" {
            crate::logs::warn("ai.failed", &[("code", event["code"].as_str().unwrap_or(""))], None);
        }
        deliver(event);
    };
    let mut cancel = register(&request.stream_id);
    let (profile, key) = match load_profile_and_key(engine, &request.profile_id) {
        Ok(found) => found,
        Err(error) => {
            unregister(&request.stream_id);
            sink(AiEvent::Error(error, Vec::new()).to_json());
            return;
        }
    };
    let key = key.as_deref();
    if has_images(&request.messages) {
        let (supported, _) = models::image_support(&profile, key).await;
        if !supported {
            unregister(&request.stream_id);
            let message = format!(
                "{} is not set up to read images. Choose a profile that can, or turn on \"Can read images\" in Settings > AI.",
                profile.provider_name()
            );
            sink(AiEvent::Error(StreamError::new("IMAGES_NOT_SUPPORTED", message), Vec::new()).to_json());
            return;
        }
    }
    let model = tokio::select! {
        biased;
        _ = cancel_requested(&mut cancel) => {
            unregister(&request.stream_id);
            sink(cancelled_event(&profile.model).to_json());
            return;
        }
        model = resolve_model(&request, &profile, key) => model,
    };
    let model = match model {
        Ok(model) => model,
        Err(error) => {
            unregister(&request.stream_id);
            sink(AiEvent::Error(error, Vec::new()).to_json());
            return;
        }
    };
    let prepared = match prepare(&request, &profile, &model, key) {
        Ok(prepared) => prepared,
        Err(error) => {
            unregister(&request.stream_id);
            sink(AiEvent::Error(error, Vec::new()).to_json());
            return;
        }
    };
    let context = models::error_context(&profile, &model, key);
    let options = RunOptions::for_profile(context.is_local);
    match transport::build_client(&options) {
        Ok(client) => {
            let kind = profile.kind;
            let served = model.clone();
            let mut forward = |event: AiEvent| sink(event.to_json());
            transport::run(
                &client,
                prepared,
                &move || new_decoder(kind, &served),
                &relax_for(kind),
                &context,
                &options,
                &mut cancel,
                &mut forward,
            )
            .await;
        }
        Err(error) => sink(AiEvent::Error(error, Vec::new()).to_json()),
    }
    unregister(&request.stream_id);
}

async fn cancel_requested(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

fn cancelled_event(model: &str) -> AiEvent {
    AiEvent::Done(Done {
        stop_reason: "cancelled".to_string(),
        stop_details: Value::Null,
        content: Vec::new(),
        model: model.to_string(),
        provider: "",
        fallback: Value::Null,
    })
}

/// Streams one model response as normalized events.
#[tauri::command]
pub async fn ai_stream(
    engine: tauri::State<'_, Arc<Engine>>,
    request: StreamRequest,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let engine = engine.inner().clone();
    run_request(&engine, request, move |event| {
        let _ = on_event.send(event);
    })
    .await;
    Ok(())
}

/// Stops a stream. The HTTP connection closes straight away, and the stream ends with a
/// `done` event whose `stopReason` is `cancelled`.
#[tauri::command]
pub fn ai_cancel(stream_id: String) {
    cancel(&stream_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::transport::tests::{json_reply, serve, sse_reply};
    use crate::rpc::call;
    use serde_json::json;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    fn engine_with(profile: Value) -> (Arc<Engine>, crate::engine::TestDir) {
        let (engine, _host, dir) = Engine::for_test();
        call(&engine, "settings.update", json!({ "patch": { "ai": { "profiles": [profile] } } }));
        (engine, dir)
    }

    fn request(stream: &str, profile: &str) -> StreamRequest {
        serde_json::from_value(json!({
            "streamId": stream, "profileId": profile, "system": "sys",
            "messages": [{ "role": "user", "content": [{ "type": "text", "text": "Hi" }] }],
        }))
        .unwrap()
    }

    fn run_collect(engine: &Engine, request: StreamRequest) -> Vec<Value> {
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        block_on(run_request(engine, request, move |event| seen.lock().unwrap().push(event)));
        let out = events.lock().unwrap().clone();
        out
    }

    const CHUNK: &str = "data: {\"model\":\"served\",\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n";
    const STOP: &str = "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

    #[test]
    fn a_local_profile_with_no_model_uses_the_servers_first_and_streams() {
        let server = serve(vec![
            json_reply("200 OK", "", "{\"data\":[{\"id\":\"loaded-model\"}]}"),
            sse_reply(vec![(0, CHUNK), (0, STOP)]),
        ]);
        let (engine, _dir) = engine_with(json!({ "id": "local", "name": "Local", "kind": "openai-compatible", "baseUrl": server.url, "model": "", "isCloud": false }));
        let events = run_collect(&engine, request("a", "local"));
        assert_eq!(events[0], json!({ "type": "text", "text": "hi" }));
        let done = events.last().unwrap();
        assert_eq!(done["type"], "done");
        assert_eq!(done["stopReason"], "end_turn");
        assert_eq!(done["provider"], "compat");
        let seen = server.requests.lock().unwrap();
        assert!(seen[0].starts_with("GET /v1/models"));
        assert!(seen[1].starts_with("POST /v1/chat/completions"));
        assert!(seen[1].contains("\"model\":\"loaded-model\""));
    }

    #[test]
    fn a_cloud_profile_with_no_key_is_stopped_before_any_request() {
        let (engine, _dir) = engine_with(json!({ "id": "c", "name": "Claude", "kind": "anthropic", "baseUrl": "http://127.0.0.1:9", "model": "claude-opus-5-5", "isCloud": true }));
        let events = run_collect(&engine, request("b", "c"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["code"], "NO_KEY");
    }

    #[test]
    fn images_go_only_to_a_profile_that_can_read_them() {
        let picture = json!([{ "role": "user", "content": [
            { "type": "text", "text": "What is this?" },
            { "type": "image", "mime": "image/png", "base64": "AAAA" },
        ]}]);
        let with_picture = |stream: &str, profile: &str| -> StreamRequest {
            serde_json::from_value(json!({ "streamId": stream, "profileId": profile, "messages": picture })).unwrap()
        };

        // No /props on this server, and no setting, so it is off and nothing is sent.
        let server = serve(vec![json_reply("404 Not Found", "", "")]);
        let (engine, _dir) = engine_with(json!({ "id": "local", "kind": "openai-compatible", "baseUrl": server.url, "model": "m" }));
        let events = run_collect(&engine, with_picture("img-a", "local"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["code"], "IMAGES_NOT_SUPPORTED");
        assert_eq!(server.requests.lock().unwrap().len(), 1, "only the /props question");

        // The setting turns it on.
        let server = serve(vec![sse_reply(vec![(0, CHUNK), (0, STOP)])]);
        let (engine, _dir) = engine_with(json!({ "id": "local", "kind": "openai-compatible", "baseUrl": server.url, "model": "m", "supportsImages": true }));
        let events = run_collect(&engine, with_picture("img-b", "local"));
        assert_eq!(events.last().unwrap()["stopReason"], "end_turn");
        assert!(server.requests.lock().unwrap()[0].contains("data:image/png;base64,AAAA"));
    }

    #[test]
    fn keys_go_in_the_right_header_and_never_in_events() {
        let server = serve(vec![json_reply("401 Unauthorized", "", "{\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key sk-ant-secret\"}}")]);
        let (engine, _dir) = engine_with(json!({ "id": "c", "name": "Claude", "kind": "anthropic", "baseUrl": server.url, "model": "claude-opus-5-5", "isCloud": true }));
        call(&engine, "ai.setKey", json!({ "profileId": "c", "key": "sk-ant-secret" }));
        let events = run_collect(&engine, request("c", "c"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["code"], "BAD_KEY");
        assert!(!serde_json::to_string(&events).unwrap().contains("sk-ant-secret"));
        let seen = server.requests.lock().unwrap();
        assert!(seen[0].starts_with("POST /v1/messages"));
        assert!(seen[0].contains("x-api-key: sk-ant-secret"));
    }

    #[test]
    fn a_provider_error_is_logged_by_code_without_its_text_or_the_key() {
        let echo = "{\"error\":{\"message\":\"bad key sk-ant-echoed in Vaelthrix burned Ashmoor\"}}";
        let server = serve(vec![json_reply("400 Bad Request", "", echo)]);
        let (engine, _dir) = engine_with(json!({ "id": "c", "name": "Claude", "kind": "anthropic", "baseUrl": server.url, "model": "claude-opus-5-5", "isCloud": true }));
        call(&engine, "ai.setKey", json!({ "profileId": "c", "key": "sk-ant-echoed" }));
        let lines = crate::logs::capture(|| {
            let events = run_collect(&engine, request("logged", "c"));
            assert_eq!(events.last().unwrap()["code"], "BAD_REQUEST");
        });
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("WARN ai.failed code=BAD_REQUEST"), "{}", lines[0]);
        for leak in ["sk-ant", "Vaelthrix", "Ashmoor", "message="] {
            assert!(!lines[0].contains(leak), "{leak} reached the log: {}", lines[0]);
        }
    }

    #[test]
    fn ai_cancel_stops_a_running_stream_even_if_it_arrives_first() {
        let many: Vec<(u64, &str)> = std::iter::repeat_n((100, CHUNK), 200).collect();
        let server = serve(vec![sse_reply(many)]);
        let (engine, _dir) = engine_with(json!({ "id": "local", "kind": "openai-compatible", "baseUrl": server.url, "model": "m" }));

        // Before it starts.
        cancel("early");
        let events = run_collect(&engine, request("early", "local"));
        assert_eq!(events.last().unwrap()["stopReason"], "cancelled");

        // While it runs.
        let server = serve(vec![sse_reply(std::iter::repeat_n((100, CHUNK), 200).collect())]);
        let (engine, _dir) = engine_with(json!({ "id": "local", "kind": "openai-compatible", "baseUrl": server.url, "model": "m" }));
        let started = Instant::now();
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(350));
            cancel("running");
        });
        let events = run_collect(&engine, request("running", "local"));
        assert!(started.elapsed() < Duration::from_secs(3));
        let done = events.last().unwrap();
        assert_eq!(done["stopReason"], "cancelled");
        assert_eq!(done["content"][0]["type"], "text");
    }

    #[test]
    fn the_normalized_events_have_the_documented_shape() {
        assert_eq!(AiEvent::Thinking("t".into()).to_json(), json!({ "type": "thinking", "text": "t" }));
        assert_eq!(AiEvent::Text("t".into()).to_json(), json!({ "type": "text", "text": "t" }));
        assert_eq!(
            AiEvent::ToolCall { id: "i".into(), name: "n".into(), input: json!({}), invalid: Some("{".into()) }.to_json(),
            json!({ "type": "toolCall", "id": "i", "name": "n", "input": {}, "invalid": "{" })
        );
        assert_eq!(
            AiEvent::Usage(Usage { input: 1, output: 2, cache_read: 3, cache_write: 4, reasoning: 5 }).to_json(),
            json!({ "type": "usage", "inputTokens": 1, "outputTokens": 2, "cacheReadTokens": 3, "cacheWriteTokens": 4, "reasoningTokens": 5 })
        );
        assert_eq!(
            AiEvent::Error(StreamError::new("X", "msg"), Vec::new()).to_json(),
            json!({ "type": "error", "code": "X", "message": "msg", "partial": [] })
        );
    }
}
