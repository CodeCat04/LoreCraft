//! Embeddings from a provider profile, through the OpenAI-compatible `/v1/embeddings`.
//! Keys come from the credential store and never appear in a message.

use std::time::Duration;

use reqwest::StatusCode;
use serde_json::{json, Value};

use super::{normalize, Config, Provider};
use crate::ai::profile::{is_loopback_url, Kind, Profile};
use crate::ai::{keys, models, transport};
use crate::engine::Engine;
use crate::error::{AppError, AppResult};

const BATCH: usize = 32;
const MAX_ATTEMPTS: u32 = 4;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

pub struct RemoteProvider {
    profile: Profile,
    model: String,
    key: Option<String>,
}

/// On this computer or the writer's own network.
fn is_private_address(url: &str) -> bool {
    if is_loopback_url(url) {
        return true;
    }
    let without_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = without_scheme.split('/').next().unwrap_or("");
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = host.split(':').next().unwrap_or("").to_ascii_lowercase();
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        return ip.is_private() || ip.is_link_local();
    }
    !host.contains('.') || host.ends_with(".local")
}

/// Local-only text never goes to a cloud provider, so when in doubt this says cloud. The
/// profile's own setting counts, and so does an address that is not plainly private.
pub fn profile_is_cloud(profile: &Profile) -> bool {
    profile.is_cloud || profile.kind != Kind::Compatible || !is_private_address(&profile.base_url)
}

pub fn provider(engine: &Engine, config: &Config) -> AppResult<RemoteProvider> {
    let profile = {
        let settings = engine.settings();
        Profile::from_settings(&settings, &config.profile_id).map_err(|e| AppError::new(&e.code, e.message))?
    };
    if profile.kind == Kind::Anthropic {
        return Err(AppError::new(
            "NO_EMBEDDINGS",
            "Anthropic has no embeddings service. Choose another profile, or the built-in model.",
        ));
    }
    let model = config.model.trim().to_string();
    if model.is_empty() {
        return Err(AppError::new("NOT_SET_UP", "Enter the name of an embeddings model."));
    }
    let key = keys::get(&engine.paths, &profile.id)?;
    if profile.needs_key() && key.is_none() {
        return Err(AppError::new(
            "NO_KEY",
            format!("Add an API key for {} in Settings > AI.", profile.provider_name()),
        ));
    }
    Ok(RemoteProvider { profile, model, key })
}

fn parse_vectors(body: &Value, expected: usize, provider: &str) -> AppResult<Vec<Vec<f32>>> {
    let bad = || AppError::new("BAD_REQUEST", format!("{provider} sent embeddings in a format LoreCraft does not understand."));
    let items = body.get("data").and_then(Value::as_array).ok_or_else(bad)?;
    if items.len() != expected {
        return Err(AppError::new(
            "BAD_REQUEST",
            format!("{provider} sent {} embeddings for {expected} passages.", items.len()),
        ));
    }
    let mut out: Vec<Option<Vec<f32>>> = vec![None; expected];
    for (position, item) in items.iter().enumerate() {
        let index = item.get("index").and_then(Value::as_u64).map_or(position, |i| i as usize);
        let values = item.get("embedding").and_then(Value::as_array).ok_or_else(bad)?;
        let mut vector = Vec::with_capacity(values.len());
        for value in values {
            vector.push(value.as_f64().ok_or_else(bad)? as f32);
        }
        if vector.is_empty() {
            return Err(bad());
        }
        normalize(&mut vector);
        *out.get_mut(index).ok_or_else(bad)? = Some(vector);
    }
    out.into_iter().map(|v| v.ok_or_else(bad)).collect()
}

async fn request(provider: &RemoteProvider, texts: &[String]) -> AppResult<Vec<Vec<f32>>> {
    let profile = &provider.profile;
    let root = profile.api_root().map_err(|e| AppError::new(&e.code, e.message))?;
    let context = models::error_context(profile, &provider.model, provider.key.as_deref());
    let options = transport::RunOptions::for_profile(context.is_local);
    let client = transport::build_client(&options).map_err(|e| AppError::new(&e.code, e.message))?;
    let body = json!({ "model": provider.model, "input": texts, "encoding_format": "float" });
    let mut headers = vec![("content-type".to_string(), "application/json".to_string())];
    if let Some(key) = provider.key.as_deref() {
        headers.push(("authorization".to_string(), format!("Bearer {key}")));
    }
    let mut attempt = 0;
    loop {
        attempt += 1;
        let sent = client
            .post(format!("{root}/embeddings"))
            .headers(transport::header_map(&headers))
            .timeout(REQUEST_TIMEOUT)
            .json(&body)
            .send()
            .await;
        let failure = match sent {
            Err(error) => {
                let e = transport::connection_error(&error, &context);
                AppError::new(&e.code, e.message)
            }
            Ok(response) => {
                let status = response.status();
                let response_headers = response.headers().clone();
                let text = response.text().await.unwrap_or_default();
                if status.is_success() {
                    let value: Value = serde_json::from_str(&text)
                        .map_err(|_| AppError::new("BAD_REQUEST", format!("{} sent something that is not an embeddings answer.", context.provider)))?;
                    return parse_vectors(&value, texts.len(), &context.provider);
                }
                // The writer's local server, for one, answers this way: it has no such endpoint.
                if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED || status == StatusCode::NOT_IMPLEMENTED {
                    let rejection = transport::parse_rejection(status.as_u16(), &text);
                    if !rejection.message.to_ascii_lowercase().contains("model") {
                        return Err(AppError::new(
                            "NO_EMBEDDINGS",
                            format!("{} has no embeddings service at {root}/embeddings. Use the built-in model, or another profile.", context.provider),
                        ));
                    }
                }
                let error = transport::classify_status(status.as_u16(), &response_headers, &text, &context);
                if error.retryable && attempt < MAX_ATTEMPTS {
                    let wait = error.retry_after_ms.map_or(Duration::from_millis(500 * 2u64.pow(attempt)), Duration::from_millis);
                    if wait <= options.max_retry_after {
                        tokio::time::sleep(wait).await;
                        continue;
                    }
                }
                AppError::new(&error.code, error.message)
            }
        };
        return Err(failure);
    }
}

impl Provider for RemoteProvider {
    fn model_id(&self) -> String {
        format!("remote:{}", self.model)
    }

    fn is_cloud(&self) -> bool {
        profile_is_cloud(&self.profile)
    }

    fn batch_size(&self) -> usize {
        BATCH
    }

    fn embed(&self, texts: &[String]) -> AppResult<Vec<Vec<f32>>> {
        tauri::async_runtime::block_on(request(self, texts))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(kind: Kind, base: &str, is_cloud: bool) -> Profile {
        Profile { kind, base_url: base.to_string(), is_cloud, ..Profile::default_local() }
    }

    #[test]
    fn only_a_plainly_private_address_with_the_setting_off_counts_as_local() {
        assert!(!profile_is_cloud(&profile(Kind::Compatible, "http://127.0.0.1:8080/v1", false)));
        assert!(!profile_is_cloud(&profile(Kind::Compatible, "http://192.168.1.5:1234/v1", false)));
        assert!(!profile_is_cloud(&profile(Kind::Compatible, "http://mybox:1234/v1", false)));
        assert!(!profile_is_cloud(&profile(Kind::Compatible, "http://mybox.local/v1", false)));
        assert!(profile_is_cloud(&profile(Kind::Compatible, "http://127.0.0.1:8080/v1", true)));
        assert!(profile_is_cloud(&profile(Kind::Compatible, "https://api.example.com/v1", false)));
        assert!(profile_is_cloud(&profile(Kind::Compatible, "http://8.8.8.8/v1", false)));
        assert!(profile_is_cloud(&profile(Kind::OpenAi, "http://127.0.0.1:8080/v1", false)));
    }

    #[test]
    fn vectors_come_back_in_input_order_with_length_one() {
        let body = json!({ "data": [
            { "index": 1, "embedding": [0.0, 2.0] },
            { "index": 0, "embedding": [3.0, 0.0] },
        ]});
        assert_eq!(parse_vectors(&body, 2, "X").unwrap(), vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
        assert!(parse_vectors(&body, 3, "X").is_err());
        assert!(parse_vectors(&json!({ "error": "no" }), 1, "X").is_err());
        assert!(parse_vectors(&json!({ "data": [{ "index": 9, "embedding": [1.0] }] }), 1, "X").is_err());
    }
}
