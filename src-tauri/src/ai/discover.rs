//! Looks for OpenAI-compatible servers on this computer, when the writer asks.
//!
//! Only ever 127.0.0.1, and only the ports listed here, so this cannot be pointed anywhere
//! else. No key is sent, nothing follows a redirect, and timeouts are short, because a port
//! with nothing on it is the usual answer and the writer is waiting for the result.

use std::time::Duration;

use futures_util::future::join_all;
use serde::Serialize;
use serde_json::Value;

use super::models;
use super::profile::Kind;
use super::transport::{self, RunOptions};

/// 8080 llama.cpp, 11434 Ollama, 1234 LM Studio, 5000 and 5001 text-generation-webui and
/// KoboldCpp, 8000 vLLM and others.
pub const COMMON_PORTS: [u16; 6] = [8080, 11434, 1234, 5000, 5001, 8000];

const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);
const ANSWER_TIMEOUT: Duration = Duration::from_millis(1500);
/// A model list is small. Anything longer is not one.
const MAX_BODY_BYTES: usize = 512 * 1024;
const MAX_MODELS: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundServer {
    pub port: u16,
    pub base_url: String,
    pub models: Vec<String>,
    /// It answered, but only to a request with a key.
    pub needs_key: bool,
}

async fn read_capped(response: &mut reqwest::Response) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BODY_BYTES {
            return None;
        }
    }
    Some(body)
}

/// What a server on this port said, if it spoke the API at all. A web page or anything else
/// that merely answers on the port does not count.
fn read_answer(port: u16, status: u16, body: &[u8]) -> Option<FoundServer> {
    let base_url = format!("http://127.0.0.1:{port}/v1");
    if status == 401 || status == 403 {
        return Some(FoundServer { port, base_url, models: Vec::new(), needs_key: true });
    }
    if !(200..300).contains(&status) {
        return None;
    }
    let json: Value = serde_json::from_slice(body).ok()?;
    if !json.get("data").or_else(|| json.get("models")).is_some_and(Value::is_array) {
        return None;
    }
    let models = models::parse_list(Kind::Compatible, &json)
        .into_iter()
        .take(MAX_MODELS)
        .map(|model| model.id)
        .collect();
    Some(FoundServer { port, base_url, models, needs_key: false })
}

async fn probe(client: &reqwest::Client, port: u16) -> Option<FoundServer> {
    let ask = async {
        let mut response = client.get(format!("http://127.0.0.1:{port}/v1/models")).send().await.ok()?;
        let status = response.status().as_u16();
        let body = read_capped(&mut response).await?;
        read_answer(port, status, &body)
    };
    tokio::time::timeout(ANSWER_TIMEOUT, ask).await.ok()?
}

/// Tries each port at once, so the whole search takes no longer than the slowest one.
pub async fn find(ports: &[u16]) -> Vec<FoundServer> {
    let mut options = RunOptions::for_profile(true);
    options.connect_timeout = CONNECT_TIMEOUT;
    let Ok(client) = transport::build_client(&options) else {
        return Vec::new();
    };
    join_all(ports.iter().map(|port| probe(&client, *port)))
        .await
        .into_iter()
        .flatten()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::transport::tests::{json_reply, serve};

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    fn port_of(url: &str) -> u16 {
        url.rsplit(':').next().unwrap().parse().unwrap()
    }

    fn closed_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    #[test]
    fn finds_what_answers_like_a_model_server_and_nothing_else() {
        let model_server = serve(vec![json_reply("200 OK", "", "{\"data\":[{\"id\":\"one\"},{\"id\":\"two\"}]}")]);
        let locked = serve(vec![json_reply("401 Unauthorized", "", "{\"error\":{\"message\":\"no key\"}}")]);
        let web_page = serve(vec![json_reply("200 OK", "", "<html>Hello</html>")]);
        let other_json = serve(vec![json_reply("200 OK", "", "{\"ok\":true}")]);
        let missing = serve(vec![json_reply("404 Not Found", "", "{}")]);
        let found = block_on(find(&[
            port_of(&model_server.url),
            closed_port(),
            port_of(&locked.url),
            port_of(&web_page.url),
            port_of(&other_json.url),
            port_of(&missing.url),
        ]));
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(found[0].models, ["one", "two"]);
        assert_eq!(found[0].base_url, format!("http://127.0.0.1:{}/v1", port_of(&model_server.url)));
        assert!(!found[0].needs_key);
        assert!(found[1].needs_key);
        assert!(model_server.requests.lock().unwrap()[0].starts_with("GET /v1/models"));
    }

    #[test]
    fn a_server_that_says_nothing_does_not_hold_up_the_search() {
        // Accepts the connection and then never replies.
        let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let started = std::time::Instant::now();
        let found = block_on(find(&[silent.local_addr().unwrap().port()]));
        assert!(found.is_empty());
        assert!(started.elapsed() < Duration::from_secs(4), "{:?}", started.elapsed());
    }

    #[test]
    fn the_common_ports_are_the_ones_promised() {
        assert_eq!(COMMON_PORTS, [8080, 11434, 1234, 5000, 5001, 8000]);
    }
}
