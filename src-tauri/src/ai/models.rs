//! Model lists and connection tests.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use super::anthropic;
use super::profile::{Kind, Profile};
use super::transport::{self, ErrorContext, RunOptions};
use super::types::StreamError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    /// A friendlier name, where the provider gives one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The context window in tokens, where the provider reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
}

pub fn error_context(profile: &Profile, model: &str, key: Option<&str>) -> ErrorContext {
    ErrorContext {
        provider: profile.provider_name(),
        address: profile.api_root().unwrap_or_else(|_| profile.base_url.clone()),
        model: model.to_string(),
        is_local: profile.is_local_address(),
        secret: key.map(str::to_string),
    }
}

/// Things that are plainly not chat models, in OpenAI's list.
fn is_chat_model(id: &str) -> bool {
    const NOT_CHAT: [&str; 12] = [
        "embedding", "whisper", "tts", "dall-e", "image", "moderation", "transcribe", "realtime", "audio", "davinci", "babbage", "sora",
    ];
    !NOT_CHAT.iter().any(|word| id.contains(word))
}

pub fn parse_list(kind: Kind, body: &Value) -> Vec<ModelInfo> {
    let Some(items) = body.get("data").or_else(|| body.get("models")).and_then(Value::as_array) else {
        return Vec::new();
    };
    let number = |item: &Value, keys: &[&str]| keys.iter().find_map(|key| item.get(*key).and_then(Value::as_u64));
    let mut out: Vec<ModelInfo> = items
        .iter()
        .filter_map(|item| {
            let id = item.get("id").or_else(|| item.get("name")).and_then(Value::as_str)?.to_string();
            if kind == Kind::OpenAi && !is_chat_model(&id) {
                return None;
            }
            Some(ModelInfo {
                name: item.get("display_name").and_then(Value::as_str).map(str::to_string),
                // Anthropic reports `max_input_tokens`. Local servers vary.
                context_tokens: number(item, &["max_input_tokens", "max_model_len", "context_length", "context_window", "max_context_length"])
                    .or_else(|| item.get("meta").and_then(|meta| number(meta, &["n_ctx", "n_ctx_train"]))),
                max_output_tokens: match kind {
                    Kind::Anthropic => number(item, &["max_tokens"]),
                    _ => None,
                },
                id,
            })
        })
        .collect();
    if kind == Kind::OpenAi {
        out.sort_by(|a, b| a.id.cmp(&b.id));
    }
    out
}

fn wants_stop_paging(body: &Value) -> Option<String> {
    let more = body.get("has_more").and_then(Value::as_bool).unwrap_or(false);
    if more {
        body.get("last_id").and_then(Value::as_str).map(str::to_string)
    } else {
        None
    }
}

/// Reads the provider's model list. Errors are the same clear ones a stream would give.
pub async fn list(profile: &Profile, key: Option<&str>) -> Result<Vec<ModelInfo>, StreamError> {
    if profile.needs_key() && key.is_none() {
        return Err(StreamError::new(
            "NO_KEY",
            format!("Add an API key for {} in Settings > AI first.", profile.provider_name()),
        ));
    }
    let root = profile.api_root()?;
    let is_local = profile.is_local_address();
    let mut options = RunOptions::for_profile(is_local);
    options.idle_timeout = Duration::from_secs(20);
    options.connect_timeout = Duration::from_secs(5);
    let client = transport::build_client(&options)?;
    let context = error_context(profile, &profile.model, key);

    let mut models = Vec::new();
    let mut after: Option<String> = None;
    // A provider with a long list pages it. This is only a sanity limit.
    for _ in 0..10 {
        let (url, mut headers) = match profile.kind {
            Kind::Anthropic => (
                format!("{root}/v1/models?limit=1000{}", after.as_deref().map(|id| format!("&after_id={id}")).unwrap_or_default()),
                vec![("anthropic-version".to_string(), anthropic::API_VERSION.to_string())],
            ),
            Kind::OpenAi | Kind::Compatible => (format!("{root}/models"), Vec::new()),
        };
        if let Some(key) = key {
            match profile.kind {
                Kind::Anthropic => headers.push(("x-api-key".to_string(), key.to_string())),
                _ => headers.push(("authorization".to_string(), format!("Bearer {key}"))),
            }
        }
        let response = tokio::time::timeout(
            options.idle_timeout,
            client.get(&url).headers(transport::header_map(&headers)).send(),
        )
        .await
        .map_err(|_| {
            StreamError::new(
                "SERVER_DOWN",
                format!("{} did not answer within {} seconds.", context.provider, options.idle_timeout.as_secs()),
            )
        })?
        .map_err(|e| transport::connection_error(&e, &context))?;

        let status = response.status().as_u16();
        let headers_back = response.headers().clone();
        let text = tokio::time::timeout(options.idle_timeout, response.text())
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(transport::classify_status(status, &headers_back, &text, &context));
        }
        let body: Value = serde_json::from_str(&text).map_err(|_| {
            StreamError::new(
                "BAD_URL",
                format!("{} answered, but not as an AI server would. Check the address in Settings > AI.", context.address),
            )
        })?;
        models.extend(parse_list(profile.kind, &body));
        match wants_stop_paging(&body) {
            Some(last) => after = Some(last),
            None => break,
        }
    }
    Ok(models)
}

/// The first model a server has ready. Lets the default local profile work with no setup.
pub async fn pick_local_model(profile: &Profile, key: Option<&str>) -> Result<String, StreamError> {
    let models = list(profile, key).await?;
    models.into_iter().next().map(|m| m.id).ok_or_else(|| {
        StreamError::new(
            "NO_MODEL",
            format!("{} is running but has no model loaded. Load one, then try again.", profile.provider_name()),
        )
    })
}

/// Asks a local server whether it takes images. `/props` is not part of the OpenAI API,
/// so a server without it simply has no answer, rather than an error.
pub async fn detect_vision(profile: &Profile, key: Option<&str>) -> Option<bool> {
    let root = profile.api_root().ok()?;
    let server = root.strip_suffix("/v1").unwrap_or(&root);
    let mut options = RunOptions::for_profile(profile.is_local_address());
    options.connect_timeout = Duration::from_secs(3);
    let client = transport::build_client(&options).ok()?;
    let mut headers = Vec::new();
    if let Some(key) = key {
        headers.push(("authorization".to_string(), format!("Bearer {key}")));
    }
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        client.get(format!("{server}/props")).headers(transport::header_map(&headers)).send(),
    )
    .await
    .ok()?
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = tokio::time::timeout(Duration::from_secs(5), response.json()).await.ok()?.ok()?;
    body.get("modalities")?.get("vision")?.as_bool()
}

/// Whether this profile can be sent images, and how that was decided: an explicit setting
/// wins, cloud providers default to yes, and a local server is asked. If it cannot say,
/// the answer is no, since sending an image it cannot read would only fail.
pub async fn image_support(profile: &Profile, key: Option<&str>) -> (bool, &'static str) {
    if let Some(setting) = profile.supports_images {
        return (setting, "setting");
    }
    match profile.kind {
        Kind::Anthropic | Kind::OpenAi => (true, "default"),
        Kind::Compatible => match detect_vision(profile, key).await {
            Some(detected) => (detected, "detected"),
            None => (false, "default"),
        },
    }
}

/// A real check that costs nothing: the same list call, plus whether the chosen model
/// is on it. The result is a value rather than an error, since failing is an answer here.
pub async fn test_connection(profile: &Profile, key: Option<&str>) -> Value {
    match list(profile, key).await {
        Err(error) => json!({ "ok": false, "code": error.code, "message": error.message }),
        Ok(models) => {
            let count = models.len();
            let found = models.iter().any(|m| m.id == profile.model);
            let names: Vec<&str> = models.iter().take(5).map(|m| m.id.as_str()).collect();
            let provider = profile.provider_name();
            if profile.model.is_empty() {
                if count == 0 {
                    return json!({ "ok": false, "code": "NO_MODEL", "message": format!("Connected to {provider}, but it has no models loaded.") });
                }
                return json!({
                    "ok": true,
                    "message": format!("Connected to {provider}. With no model chosen, LoreCraft will use {}.", names[0]),
                    "models": count,
                });
            }
            if found || count == 0 {
                return json!({ "ok": true, "message": format!("Connected to {provider}. {} is available.", profile.model), "models": count });
            }
            json!({
                "ok": false,
                "code": "UNKNOWN_MODEL",
                "message": format!("Connected to {provider}, but it has no model called \"{}\". It has: {}.", profile.model, names.join(", ")),
                "models": count,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::transport::tests::{json_reply, serve};

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    fn profile(kind: Kind, url: &str, model: &str) -> Profile {
        Profile {
            kind,
            base_url: url.to_string(),
            model: model.to_string(),
            ..Profile::default_local()
        }
    }

    #[test]
    fn lists_parse_for_each_provider() {
        // The real response from the local server.
        let local = json!({ "data": [{ "created": 1793893690, "id": "local-model-27b", "max_model_len": 262144, "meta": { "n_ctx": 262144 }, "object": "model", "owned_by": "local", "status": { "value": "loaded" } }], "object": "list" });
        assert_eq!(parse_list(Kind::Compatible, &local), vec![ModelInfo {
            id: "local-model-27b".into(), name: None, context_tokens: Some(262144), max_output_tokens: None,
        }]);

        let claude = json!({ "data": [{ "id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "max_input_tokens": 1000000, "max_tokens": 128000, "capabilities": {} }], "has_more": false });
        assert_eq!(parse_list(Kind::Anthropic, &claude), vec![ModelInfo {
            id: "claude-opus-5-5".into(), name: Some("Claude Opus 5.5".into()), context_tokens: Some(1000000), max_output_tokens: Some(128000),
        }]);

        let openai = json!({ "data": [{ "id": "text-embedding-3-small" }, { "id": "gpt-6-astra" }, { "id": "whisper-1" }, { "id": "gpt-5.6-terra" }] });
        let ids: Vec<String> = parse_list(Kind::OpenAi, &openai).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["gpt-5.6-terra", "gpt-6-astra"]);
    }

    #[test]
    fn a_cloud_profile_with_no_key_says_so_without_a_request() {
        let p = profile(Kind::Anthropic, "http://127.0.0.1:9", "claude-opus-5-5");
        assert_eq!(block_on(list(&p, None)).unwrap_err().code, "NO_KEY");
        let result = block_on(test_connection(&p, None));
        assert_eq!(result["ok"], false);
        assert_eq!(result["code"], "NO_KEY");
    }

    #[test]
    fn anthropic_lists_page_and_send_the_version_header() {
        let server = serve(vec![
            json_reply("200 OK", "", "{\"data\":[{\"id\":\"a\"}],\"has_more\":true,\"last_id\":\"a\"}"),
            json_reply("200 OK", "", "{\"data\":[{\"id\":\"b\"}],\"has_more\":false}"),
        ]);
        let p = profile(Kind::Anthropic, &server.url, "b");
        let models = block_on(list(&p, Some("k"))).unwrap();
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        let seen = server.requests.lock().unwrap();
        assert!(seen[0].contains("anthropic-version: 2026-10-21"));
        assert!(seen[0].contains("x-api-key: k"));
        assert!(seen[1].contains("after_id=a"));
    }

    #[test]
    fn connection_tests_give_a_clear_result() {
        let ok = "{\"data\":[{\"id\":\"model-a\"}]}";

        let server = serve(vec![json_reply("200 OK", "", ok)]);
        let result = block_on(test_connection(&profile(Kind::Compatible, &server.url, "model-a"), None));
        assert_eq!(result["ok"], true);
        assert!(result["message"].as_str().unwrap().contains("model-a is available"));

        let server = serve(vec![json_reply("200 OK", "", ok)]);
        let result = block_on(test_connection(&profile(Kind::Compatible, &server.url, ""), None));
        assert_eq!(result["ok"], true);
        assert!(result["message"].as_str().unwrap().contains("will use model-a"));

        let server = serve(vec![json_reply("200 OK", "", ok)]);
        let result = block_on(test_connection(&profile(Kind::Compatible, &server.url, "missing"), None));
        assert_eq!(result["ok"], false);
        assert_eq!(result["code"], "UNKNOWN_MODEL");
        assert!(result["message"].as_str().unwrap().contains("model-a"));

        let server = serve(vec![json_reply("401 Unauthorized", "", "{\"error\":{\"message\":\"bad key sk-1\"}}")]);
        let result = block_on(test_connection(&profile(Kind::OpenAi, &server.url, "gpt"), Some("sk-1")));
        assert_eq!(result["code"], "BAD_KEY");
        assert!(!result.to_string().contains("sk-1"));

        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let result = block_on(test_connection(&profile(Kind::Compatible, &format!("http://127.0.0.1:{port}/v1"), ""), None));
        assert_eq!(result["code"], "SERVER_DOWN");
    }

    #[test]
    fn image_support_follows_the_setting_then_the_provider_then_the_server() {
        // An explicit setting wins, and asks nobody.
        let mut p = profile(Kind::Compatible, "http://127.0.0.1:9", "m");
        p.supports_images = Some(true);
        assert_eq!(block_on(image_support(&p, None)), (true, "setting"));
        let mut p = profile(Kind::Anthropic, "http://127.0.0.1:9", "m");
        p.supports_images = Some(false);
        assert_eq!(block_on(image_support(&p, None)), (false, "setting"));

        // Cloud providers default to yes.
        assert_eq!(block_on(image_support(&profile(Kind::Anthropic, "http://127.0.0.1:9", "m"), None)), (true, "default"));
        assert_eq!(block_on(image_support(&profile(Kind::OpenAi, "http://127.0.0.1:9", "m"), None)), (true, "default"));

        // A local server is asked, at the server's root rather than under /v1.
        let server = serve(vec![json_reply("200 OK", "", "{\"modalities\":{\"audio\":false,\"video\":false,\"vision\":true}}")]);
        let url = format!("{}/v1", server.url);
        assert_eq!(block_on(image_support(&profile(Kind::Compatible, &url, "m"), None)), (true, "detected"));
        assert!(server.requests.lock().unwrap()[0].starts_with("GET /props"));

        let server = serve(vec![json_reply("200 OK", "", "{\"modalities\":{\"vision\":false}}")]);
        assert_eq!(block_on(image_support(&profile(Kind::Compatible, &server.url, "m"), None)), (false, "detected"));

        // No /props, or none that says, means off.
        let server = serve(vec![json_reply("404 Not Found", "", "")]);
        assert_eq!(block_on(image_support(&profile(Kind::Compatible, &server.url, "m"), None)), (false, "default"));
        let server = serve(vec![json_reply("200 OK", "", "{\"something\":\"else\"}")]);
        assert_eq!(block_on(image_support(&profile(Kind::Compatible, &server.url, "m"), None)), (false, "default"));
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let down = format!("http://127.0.0.1:{port}/v1");
        assert_eq!(block_on(image_support(&profile(Kind::Compatible, &down, "m"), None)), (false, "default"));
    }

    #[test]
    fn a_local_server_with_no_chosen_model_uses_its_first() {
        let server = serve(vec![json_reply("200 OK", "", "{\"data\":[{\"id\":\"only-one\"}]}")]);
        assert_eq!(block_on(pick_local_model(&profile(Kind::Compatible, &server.url, ""), None)).unwrap(), "only-one");
        let server = serve(vec![json_reply("200 OK", "", "{\"data\":[]}")]);
        assert_eq!(block_on(pick_local_model(&profile(Kind::Compatible, &server.url, ""), None)).unwrap_err().code, "NO_MODEL");
    }
}
