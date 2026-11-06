//! Provider profiles. Their shape and defaults are defined in `src/lib/settings.ts`,
//! and Rust reads the fields it needs by name from the stored settings.

use serde_json::Value;

use super::types::StreamError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Anthropic,
    OpenAi,
    /// Anything that speaks the OpenAI Chat Completions format, such as a local server.
    Compatible,
}

pub const DEFAULT_ANTHROPIC_MODEL: &str = "claude-opus-5-5";
pub const DEFAULT_OPENAI_MODEL: &str = "gpt-6-astra";

/// Thinking counts against these limits on every provider. A local model that thinks at
/// length needs room to still produce an answer.
const DEFAULT_MAX_TOKENS_ANTHROPIC: u64 = 64_000;
const DEFAULT_MAX_TOKENS_OPENAI: u64 = 32_000;
const DEFAULT_MAX_TOKENS_COMPATIBLE: u64 = 16_384;

#[derive(Debug, Clone, PartialEq)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub base_url: String,
    pub model: String,
    pub is_cloud: bool,
    pub max_tokens: Option<u64>,
    pub effort: Option<String>,
    /// Whether to send images. Unset means use the default for this kind of provider.
    pub supports_images: Option<bool>,
}

impl Profile {
    /// The profile a fresh install starts with, before any settings have been saved.
    pub fn default_local() -> Self {
        Self {
            id: "local".to_string(),
            name: "Local model".to_string(),
            kind: Kind::Compatible,
            base_url: "http://127.0.0.1:8080/v1".to_string(),
            model: String::new(),
            is_cloud: false,
            max_tokens: None,
            effort: None,
            supports_images: None,
        }
    }

    pub fn from_settings(settings: &Value, id: &str) -> Result<Self, StreamError> {
        let found = settings
            .get("ai")
            .and_then(|ai| ai.get("profiles"))
            .and_then(Value::as_array)
            .and_then(|profiles| {
                profiles
                    .iter()
                    .find(|p| p.get("id").and_then(Value::as_str) == Some(id))
            });
        let Some(raw) = found else {
            if id == "local" {
                return Ok(Self::default_local());
            }
            return Err(StreamError::new(
                "NO_PROFILE",
                "That AI profile no longer exists. Choose another in Settings > AI.",
            ));
        };
        let text = |key: &str| raw.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let kind = match text("kind").as_str() {
            "anthropic" => Kind::Anthropic,
            "openai" => Kind::OpenAi,
            _ => Kind::Compatible,
        };
        let effort = text("effort");
        Ok(Self {
            id: id.to_string(),
            name: text("name"),
            kind,
            base_url: text("baseUrl"),
            model: text("model"),
            is_cloud: raw.get("isCloud").and_then(Value::as_bool).unwrap_or(false),
            max_tokens: raw.get("maxTokens").and_then(Value::as_u64).filter(|n| *n > 0),
            effort: if effort.is_empty() { None } else { Some(effort) },
            supports_images: raw.get("supportsImages").and_then(Value::as_bool),
        })
    }

    pub fn provider_name(&self) -> String {
        match self.kind {
            Kind::Anthropic => "Anthropic".to_string(),
            Kind::OpenAi => "OpenAI".to_string(),
            Kind::Compatible => {
                if self.name.is_empty() {
                    "the model server".to_string()
                } else {
                    self.name.clone()
                }
            }
        }
    }

    pub fn default_max_tokens(&self) -> u64 {
        match self.kind {
            Kind::Anthropic => DEFAULT_MAX_TOKENS_ANTHROPIC,
            Kind::OpenAi => DEFAULT_MAX_TOKENS_OPENAI,
            Kind::Compatible => DEFAULT_MAX_TOKENS_COMPATIBLE,
        }
    }

    /// The configured address, tidied. Anthropic's paths include `/v1`, and the other two
    /// expect it in the base, so people can paste either form.
    pub fn api_root(&self) -> Result<String, StreamError> {
        let base = self.base_url.trim().trim_end_matches('/');
        let lower = base.to_ascii_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Err(StreamError::new(
                "BAD_URL",
                format!("\"{base}\" is not a web address. It should start with http:// or https://."),
            ));
        }
        let has_path = base.splitn(4, '/').nth(3).is_some_and(|path| !path.is_empty());
        Ok(match self.kind {
            Kind::Anthropic => base.strip_suffix("/v1").unwrap_or(base).to_string(),
            Kind::OpenAi | Kind::Compatible if !has_path => format!("{base}/v1"),
            _ => base.to_string(),
        })
    }

    /// True if the address is on this computer, so nothing leaves it.
    pub fn is_local_address(&self) -> bool {
        is_loopback_url(&self.base_url)
    }

    pub fn needs_key(&self) -> bool {
        matches!(self.kind, Kind::Anthropic | Kind::OpenAi)
    }
}

pub fn is_loopback_url(url: &str) -> bool {
    let without_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = without_scheme.split('/').next().unwrap_or("");
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if host.starts_with('[') {
        host.split(']').next().unwrap_or("").trim_start_matches('[')
    } else {
        host.split(':').next().unwrap_or("")
    };
    let host = host.to_ascii_lowercase();
    host == "localhost"
        || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn profile(kind: Kind, base: &str) -> Profile {
        Profile {
            kind,
            base_url: base.to_string(),
            ..Profile::default_local()
        }
    }

    #[test]
    fn base_addresses_are_tidied_for_each_provider() {
        assert_eq!(profile(Kind::Compatible, "http://127.0.0.1:8080/v1/").api_root().unwrap(), "http://127.0.0.1:8080/v1");
        assert_eq!(profile(Kind::Compatible, "http://127.0.0.1:8080").api_root().unwrap(), "http://127.0.0.1:8080/v1");
        assert_eq!(profile(Kind::Compatible, "https://x.example/custom/api").api_root().unwrap(), "https://x.example/custom/api");
        assert_eq!(profile(Kind::Anthropic, "https://api.anthropic.com/v1/").api_root().unwrap(), "https://api.anthropic.com");
        assert_eq!(profile(Kind::Anthropic, "https://api.anthropic.com").api_root().unwrap(), "https://api.anthropic.com");
        assert_eq!(profile(Kind::OpenAi, "https://api.openai.com/v1").api_root().unwrap(), "https://api.openai.com/v1");
        assert_eq!(profile(Kind::OpenAi, "ftp://nope").api_root().unwrap_err().code, "BAD_URL");
    }

    #[test]
    fn loopback_addresses_are_recognized() {
        for url in ["http://127.0.0.1:8080/v1", "http://localhost:1234", "http://[::1]:8080/v1", "http://LOCALHOST"] {
            assert!(is_loopback_url(url), "{url}");
        }
        for url in ["https://api.openai.com/v1", "http://127.0.0.1.evil.example/v1", "http://192.168.1.5:8080"] {
            assert!(!is_loopback_url(url), "{url}");
        }
    }

    #[test]
    fn profiles_come_from_settings_and_local_has_a_default() {
        let settings = json!({ "ai": { "profiles": [
            { "id": "c", "name": "Claude", "kind": "anthropic", "baseUrl": "https://api.anthropic.com", "model": "claude-opus-5-5", "isCloud": true, "maxTokens": 1000, "effort": "high" }
        ]}});
        let p = Profile::from_settings(&settings, "c").unwrap();
        assert_eq!(p.kind, Kind::Anthropic);
        assert_eq!(p.max_tokens, Some(1000));
        assert_eq!(p.effort.as_deref(), Some("high"));
        assert!(p.is_cloud);

        assert_eq!(Profile::from_settings(&json!({}), "local").unwrap(), Profile::default_local());
        assert_eq!(Profile::from_settings(&settings, "gone").unwrap_err().code, "NO_PROFILE");
    }
}
