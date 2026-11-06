//! Sends a request and pumps the response through a decoder: timeouts, retries,
//! cancellation and turning HTTP failures into something a person can act on.

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE, RETRY_AFTER};
use serde_json::Value;
use tokio::sync::watch;

use super::sse::SseParser;
use super::types::*;

/// A ready-to-send request.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

/// What a person needs to know about where a failure happened.
#[derive(Debug, Clone)]
pub struct ErrorContext {
    pub provider: String,
    pub address: String,
    pub model: String,
    pub is_local: bool,
    /// Removed from anything a server echoes back.
    pub secret: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RunOptions {
    pub connect_timeout: Duration,
    /// Longest silence allowed. There is no limit on the total, since a long answer from
    /// a slow local model is not a failure.
    pub idle_timeout: Duration,
    pub max_retries: u32,
    pub base_delay: Duration,
    /// A server asking for a longer wait than this gets a clear error instead.
    pub max_retry_after: Duration,
    pub no_proxy: bool,
}

impl RunOptions {
    pub fn for_profile(is_local: bool) -> Self {
        Self {
            connect_timeout: Duration::from_secs(10),
            // A local server may spend minutes reading a long prompt before its first token.
            idle_timeout: Duration::from_secs(if is_local { 600 } else { 180 }),
            max_retries: 3,
            base_delay: Duration::from_millis(1000),
            max_retry_after: Duration::from_secs(60),
            no_proxy: is_local,
        }
    }
}

pub fn build_client(options: &RunOptions) -> Result<reqwest::Client, StreamError> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(options.connect_timeout)
        .tcp_nodelay(true)
        .user_agent(concat!("LoreCraft/", env!("CARGO_PKG_VERSION")))
        // A redirect to another host must not carry the key along with it.
        .redirect(reqwest::redirect::Policy::none());
    if options.no_proxy {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|e| StreamError::new("INTERNAL", format!("Could not start the network client: {}", e.without_url())))
}

pub fn header_map(headers: &[(String, String)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        let Ok(mut value) = HeaderValue::from_str(value) else {
            continue;
        };
        if name == "authorization" || name == "x-api-key" {
            value.set_sensitive(true);
        }
        map.insert(name, value);
    }
    map
}

fn redact(text: &str, context: &ErrorContext) -> String {
    let mut text = text.to_string();
    if let Some(secret) = context.secret.as_deref().filter(|s| !s.is_empty()) {
        text = text.replace(secret, "[hidden]");
    }
    if text.chars().count() > 600 {
        let cut: String = text.chars().take(600).collect();
        text = format!("{cut}…");
    }
    text
}

/// Pulls the code, type, field and message out of whichever error shape the server used.
pub fn parse_rejection(status: u16, body: &str) -> Rejection {
    let mut rejection = Rejection {
        status,
        ..Default::default()
    };
    let Ok(json) = serde_json::from_str::<Value>(body) else {
        rejection.message = body.trim().to_string();
        return rejection;
    };
    let text = |value: &Value| match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    };
    let error = json.get("error").cloned().unwrap_or(Value::Null);
    if let Some(message) = error.as_str() {
        rejection.message = message.to_string();
    } else if error.is_object() {
        rejection.message = text(error.get("message").unwrap_or(&Value::Null));
        rejection.code = text(error.get("code").unwrap_or(&Value::Null));
        rejection.kind = text(error.get("type").unwrap_or(&Value::Null));
        rejection.param = text(error.get("param").unwrap_or(&Value::Null));
    } else if let Some(detail) = json.get("detail").and_then(Value::as_str) {
        rejection.message = detail.to_string();
    } else if let Some(message) = json.get("message").and_then(Value::as_str) {
        rejection.message = message.to_string();
    }
    if rejection.message.is_empty() {
        rejection.message = body.trim().to_string();
    }
    rejection
}

fn is_context_too_long(rejection: &Rejection) -> bool {
    let message = rejection.message.to_ascii_lowercase();
    rejection.status == 413
        || rejection.code == "context_length_exceeded"
        || rejection.code == "string_above_max_length"
        || rejection.kind == "request_too_large"
        || message.contains("prompt is too long")
        || message.contains("context length")
        || message.contains("context_length")
        || message.contains("max_context")
        || message.contains("maximum context")
        || message.contains("too many tokens")
        || message.contains("input is too long")
}

fn is_unknown_model(rejection: &Rejection) -> bool {
    let message = rejection.message.to_ascii_lowercase();
    rejection.code == "model_not_found"
        || (rejection.kind == "not_found_error" && message.starts_with("model"))
        || (rejection.status == 404 && message.contains("model"))
        || (rejection.status == 400
            && message.contains("model")
            && (message.contains("not found") || message.contains("does not exist") || message.contains("unknown model")))
}

/// Turns an HTTP failure into a clear error. Retryable ones say so in `retryable`.
pub fn classify_status(status: u16, headers: &HeaderMap, body: &str, context: &ErrorContext) -> StreamError {
    let rejection = parse_rejection(status, body);
    let provider = &context.provider;
    let server_says = redact(&rejection.message, context);
    let retry_after_ms = retry_after(headers);

    let mut error = if is_context_too_long(&rejection) {
        StreamError::new(
            "CONTEXT_TOO_LONG",
            "This request is too long for the model. Lower the context size in Settings > AI, or exclude some pages in the context view.",
        )
    } else if is_unknown_model(&rejection) {
        StreamError::new(
            "UNKNOWN_MODEL",
            format!("{provider} does not have a model called \"{}\". Choose another in Settings > AI.", context.model),
        )
    } else if rejection.code == "insufficient_quota" || status == 402 || rejection.kind == "billing_error" {
        StreamError::new("BILLING", format!("{provider} says this account is out of credit or has a billing problem."))
    } else {
        match status {
            401 => StreamError::new("BAD_KEY", format!("{provider} did not accept the API key. Check it in Settings > AI.")),
            403 => StreamError::new(
                "BAD_KEY",
                format!("{provider} says this API key is not allowed to do that. Check its permissions, or the model, in Settings > AI."),
            ),
            404 => StreamError::new(
                "BAD_URL",
                format!("{} answered, but not as an AI server would. Check the address in Settings > AI.", context.address),
            ),
            429 => StreamError::new("RATE_LIMITED", format!("{provider}'s rate limit was reached. Wait a moment and try again.")).retryable(),
            529 | 503 => StreamError::new("OVERLOADED", format!("{provider} is overloaded right now. Try again in a moment.")).retryable(),
            500..=599 => StreamError::new(
                "SERVER_ERROR",
                if server_says.is_empty() {
                    format!("{provider} reported a server error ({status}). Try again in a moment.")
                } else {
                    format!("{provider} reported a server error ({status}): {server_says}")
                },
            )
            .retryable(),
            300..=399 => StreamError::new(
                "BAD_URL",
                format!("{} redirected the request elsewhere. Check the address in Settings > AI.", context.address),
            ),
            _ => StreamError::new(
                "BAD_REQUEST",
                if server_says.is_empty() {
                    format!("{provider} refused the request ({status}).")
                } else {
                    format!("{provider} refused the request: {server_says}")
                },
            ),
        }
    };
    error.retry_after_ms = retry_after_ms;
    error
}

/// `retry-after-ms`, or `retry-after` in seconds or as a date.
pub fn retry_after(headers: &HeaderMap) -> Option<u64> {
    if let Some(ms) = headers
        .get("retry-after-ms")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<f64>().ok())
    {
        return Some(ms.max(0.0) as u64);
    }
    let text = headers.get(RETRY_AFTER)?.to_str().ok()?.trim();
    if let Ok(seconds) = text.parse::<f64>() {
        return Some((seconds.max(0.0) * 1000.0) as u64);
    }
    let at = chrono::DateTime::parse_from_rfc2822(text).ok()?;
    let wait = at.signed_duration_since(chrono::Utc::now()).num_milliseconds();
    Some(wait.max(0) as u64)
}

pub fn connection_error(error: &reqwest::Error, context: &ErrorContext) -> StreamError {
    let provider = &context.provider;
    if context.is_local {
        return StreamError::new(
            "SERVER_DOWN",
            format!(
                "Nothing is answering at {}. Start your model server, or change the address in Settings > AI.",
                context.address
            ),
        );
    }
    if error.is_timeout() {
        return StreamError::new("SERVER_DOWN", format!("{provider} took too long to connect. Check your internet connection and try again."));
    }
    StreamError::new(
        "SERVER_DOWN",
        format!("Could not reach {provider} at {}. Check your internet connection and the address in Settings > AI.", context.address),
    )
}

async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            // Nobody can cancel any more, so this never finishes.
            std::future::pending::<()>().await;
        }
    }
}

fn is_output(event: &AiEvent) -> bool {
    matches!(event, AiEvent::Text(_) | AiEvent::Thinking(_) | AiEvent::ToolStart { .. } | AiEvent::ToolCall { .. })
}

enum Pump {
    /// A terminal event went out, so this request is over.
    Finished,
    /// A failure before any output, which may be retried.
    Retry(StreamError),
}

/// Runs one logical request to its terminal event. Exactly one `Done` or `Error` is
/// delivered, whatever happens.
pub async fn run(
    client: &reqwest::Client,
    mut prepared: Prepared,
    new_decoder: &(dyn Fn() -> Box<dyn Decoder> + Sync),
    relax: &(dyn Fn(&mut Prepared, &Rejection) -> bool + Sync),
    context: &ErrorContext,
    options: &RunOptions,
    cancel: &mut watch::Receiver<bool>,
    sink: &mut (dyn FnMut(AiEvent) + Send),
) {
    let done_cancelled = |content: Vec<Value>, model: &str| {
        AiEvent::Done(Done {
            stop_reason: "cancelled".to_string(),
            stop_details: Value::Null,
            content,
            model: model.to_string(),
            provider: "",
            fallback: Value::Null,
        })
    };
    let mut attempt: u32 = 0;
    let mut relaxed: u32 = 0;
    loop {
        let request = client
            .post(&prepared.url)
            .headers(header_map(&prepared.headers))
            .json(&prepared.body)
            .send();
        let sent = tokio::select! {
            biased;
            _ = cancelled(cancel) => {
                sink(done_cancelled(Vec::new(), &context.model));
                return;
            }
            sent = tokio::time::timeout(options.idle_timeout, request) => sent,
        };
        let failure = match sent {
            Err(_) => StreamError::new(
                "IDLE_TIMEOUT",
                format!("{} did not start answering within {} seconds.", context.provider, options.idle_timeout.as_secs()),
            ),
            Ok(Err(error)) => connection_error(&error, context),
            Ok(Ok(response)) => {
                let status = response.status();
                if status.is_success() {
                    let mut decoder = new_decoder();
                    match pump(response, decoder.as_mut(), context, options, cancel, sink).await {
                        Pump::Finished => return,
                        Pump::Retry(error) => error,
                    }
                } else {
                    let headers = response.headers().clone();
                    let body = tokio::select! {
                        biased;
                        _ = cancelled(cancel) => {
                            sink(done_cancelled(Vec::new(), &context.model));
                            return;
                        }
                        body = tokio::time::timeout(options.idle_timeout, response.text()) => {
                            body.ok().and_then(Result::ok).unwrap_or_default()
                        }
                    };
                    if status.as_u16() == 400 && relaxed < 5 {
                        let rejection = parse_rejection(400, &body);
                        if relax(&mut prepared, &rejection) {
                            relaxed += 1;
                            continue;
                        }
                    }
                    classify_status(status.as_u16(), &headers, &body, context)
                }
            }
        };
        let may_retry = failure.retryable && attempt < options.max_retries;
        let wait = failure
            .retry_after_ms
            .map(Duration::from_millis)
            .unwrap_or_else(|| options.base_delay * 2u32.saturating_pow(attempt));
        if !may_retry || wait > options.max_retry_after {
            let mut failure = failure;
            failure.message = redact(&failure.message, context);
            if let Some(ms) = failure.retry_after_ms.filter(|ms| *ms > 1000) {
                failure.message = format!("{} The server asks to wait about {} seconds.", failure.message, ms.div_ceil(1000));
            }
            sink(AiEvent::Error(failure, Vec::new()));
            return;
        }
        attempt += 1;
        sink(AiEvent::Retrying {
            attempt,
            delay_ms: wait.as_millis() as u64,
            reason: redact(&failure.message, context),
        });
        tokio::select! {
            biased;
            _ = cancelled(cancel) => {
                sink(done_cancelled(Vec::new(), &context.model));
                return;
            }
            _ = tokio::time::sleep(wait) => {}
        }
    }
}

/// Handles one decoded event. Returns what to do next, if anything.
fn deliver(
    event: AiEvent,
    started: &mut bool,
    context: &ErrorContext,
    sink: &mut (dyn FnMut(AiEvent) + Send),
) -> Option<Pump> {
    if is_output(&event) {
        *started = true;
    }
    match event {
        AiEvent::Error(mut error, partial) => {
            if error.retryable && !*started {
                return Some(Pump::Retry(error));
            }
            error.message = redact(&error.message, context);
            sink(AiEvent::Error(error, partial));
            Some(Pump::Finished)
        }
        AiEvent::Done(done) => {
            sink(AiEvent::Done(done));
            Some(Pump::Finished)
        }
        other => {
            sink(other);
            None
        }
    }
}

async fn pump(
    response: reqwest::Response,
    decoder: &mut dyn Decoder,
    context: &ErrorContext,
    options: &RunOptions,
    cancel: &mut watch::Receiver<bool>,
    sink: &mut (dyn FnMut(AiEvent) + Send),
) -> Pump {
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut started = false;

    // A server that ignored `stream: true` and sent one JSON object.
    if content_type.contains("application/json") {
        let body = tokio::select! {
            biased;
            _ = cancelled(cancel) => {
                sink(cancelled_event(decoder, context));
                return Pump::Finished;
            }
            body = tokio::time::timeout(options.idle_timeout, response.text()) => {
                body.ok().and_then(Result::ok).unwrap_or_default()
            }
        };
        if let Some(events) = decoder.on_whole_body(&body) {
            for event in events {
                if let Some(next) = deliver(event, &mut started, context, sink) {
                    return next;
                }
            }
        }
        sink(AiEvent::Error(
            StreamError::new("BAD_REQUEST", format!("{} sent an answer in a format LoreCraft does not understand.", context.provider)),
            Vec::new(),
        ));
        return Pump::Finished;
    }

    let mut bytes = response.bytes_stream();
    let mut parser = SseParser::new();
    loop {
        let next = tokio::select! {
            biased;
            _ = cancelled(cancel) => {
                // Dropping `bytes` on return closes the connection straight away.
                sink(cancelled_event(decoder, context));
                return Pump::Finished;
            }
            next = tokio::time::timeout(options.idle_timeout, bytes.next()) => next,
        };
        let chunk = match next {
            Err(_) => {
                sink(AiEvent::Error(
                    StreamError::new(
                        "IDLE_TIMEOUT",
                        format!("{} stopped responding for {} seconds, so the request was ended.", context.provider, options.idle_timeout.as_secs()),
                    ),
                    decoder.partial(),
                ));
                return Pump::Finished;
            }
            Ok(None) => break,
            Ok(Some(Err(_))) => {
                let error = StreamError::new(
                    "STREAM_BROKEN",
                    format!("The connection to {} broke before the answer finished.", context.provider),
                );
                if !started {
                    return Pump::Retry(error.retryable());
                }
                sink(AiEvent::Error(error, decoder.partial()));
                return Pump::Finished;
            }
            Ok(Some(Ok(chunk))) => chunk,
        };
        for event in parser.feed(&chunk) {
            for decoded in decoder.on_event(&event) {
                if let Some(next) = deliver(decoded, &mut started, context, sink) {
                    return next;
                }
            }
        }
        if decoder.finished() {
            break;
        }
    }
    if let Some(event) = parser.finish() {
        for decoded in decoder.on_event(&event) {
            if let Some(next) = deliver(decoded, &mut started, context, sink) {
                return next;
            }
        }
    }
    for decoded in decoder.finish() {
        if let Some(next) = deliver(decoded, &mut started, context, sink) {
            return next;
        }
    }
    // The body ended without the provider saying the response was complete.
    let error = StreamError::new(
        "STREAM_BROKEN",
        format!("The connection to {} ended before the answer finished.", context.provider),
    );
    if !started {
        return Pump::Retry(error.retryable());
    }
    sink(AiEvent::Error(error, decoder.partial()));
    Pump::Finished
}

fn cancelled_event(decoder: &dyn Decoder, context: &ErrorContext) -> AiEvent {
    AiEvent::Done(Done {
        stop_reason: "cancelled".to_string(),
        stop_details: Value::Null,
        content: decoder.partial(),
        model: context.model.clone(),
        provider: "",
        fallback: Value::Null,
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::ai::compat::{self, CompatDecoder};
    use crate::ai::types::testutil::joined_text;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    /// One scripted reply: a status line and headers, then body pieces with pauses.
    #[derive(Clone)]
    pub struct Reply {
        pub head: String,
        pub pieces: Vec<(u64, String)>,
    }

    pub fn sse_reply(pieces: Vec<(u64, &str)>) -> Reply {
        Reply {
            head: "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n".to_string(),
            pieces: pieces.into_iter().map(|(ms, text)| (ms, text.to_string())).collect(),
        }
    }

    pub fn json_reply(status: &str, extra_headers: &str, body: &str) -> Reply {
        Reply {
            head: format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\n{extra_headers}content-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            ),
            pieces: vec![(0, body.to_string())],
        }
    }

    pub struct Server {
        pub url: String,
        pub requests: Arc<Mutex<Vec<String>>>,
        pub closed_early: Arc<Mutex<bool>>,
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let mut data = Vec::new();
        let mut buf = [0u8; 4096];
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
        loop {
            let Ok(n) = stream.read(&mut buf) else { break };
            if n == 0 {
                break;
            }
            data.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&data);
            if let Some(end) = text.find("\r\n\r\n") {
                let lower = text[..end].to_ascii_lowercase();
                let length = lower
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if data.len() >= end + 4 + length {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&data).into_owned()
    }

    /// A small real HTTP server, so these tests use the real client and real timers.
    pub fn serve(replies: Vec<Reply>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let closed_early = Arc::new(Mutex::new(false));
        let seen = requests.clone();
        let closed = closed_early.clone();
        std::thread::spawn(move || {
            for reply in replies {
                let Ok((mut stream, _)) = listener.accept() else { return };
                seen.lock().unwrap().push(read_request(&mut stream));
                if stream.write_all(reply.head.as_bytes()).is_err() {
                    continue;
                }
                for (pause, piece) in reply.pieces {
                    std::thread::sleep(Duration::from_millis(pause));
                    if stream.write_all(piece.as_bytes()).and_then(|_| stream.flush()).is_err() {
                        *closed.lock().unwrap() = true;
                        break;
                    }
                }
            }
        });
        Server { url, requests, closed_early }
    }

    fn context(key: Option<&str>) -> ErrorContext {
        ErrorContext {
            provider: "Test server".to_string(),
            address: "http://127.0.0.1:1/v1".to_string(),
            model: "m".to_string(),
            is_local: true,
            secret: key.map(str::to_string),
        }
    }

    fn fast_options() -> RunOptions {
        RunOptions {
            connect_timeout: Duration::from_secs(2),
            idle_timeout: Duration::from_secs(5),
            max_retries: 3,
            base_delay: Duration::from_millis(10),
            max_retry_after: Duration::from_secs(3),
            no_proxy: true,
        }
    }

    fn prepared(url: &str) -> Prepared {
        Prepared { url: url.to_string(), headers: Vec::new(), body: json!({ "stream": true }) }
    }

    async fn run_compat(url: &str, options: &RunOptions, cancel: &mut watch::Receiver<bool>) -> Vec<AiEvent> {
        let client = build_client(options).unwrap();
        let mut events = Vec::new();
        let mut sink = |event: AiEvent| events.push(event);
        run(
            &client,
            prepared(url),
            &|| Box::new(CompatDecoder::new("m")) as Box<dyn Decoder>,
            &compat::relax,
            &context(None),
            options,
            cancel,
            &mut sink,
        )
        .await;
        events
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    const CHUNK_HI: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n";
    const CHUNK_STOP: &str = "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

    fn terminal_count(events: &[AiEvent]) -> usize {
        events.iter().filter(|e| matches!(e, AiEvent::Done(_) | AiEvent::Error(..))).count()
    }

    #[test]
    fn a_normal_stream_ends_with_one_done() {
        let server = serve(vec![sse_reply(vec![(0, CHUNK_HI), (0, CHUNK_STOP)])]);
        let (_tx, mut rx) = watch::channel(false);
        let events = block_on(run_compat(&server.url, &fast_options(), &mut rx));
        assert_eq!(joined_text(&events), "hi");
        assert_eq!(terminal_count(&events), 1);
        assert!(matches!(events.last(), Some(AiEvent::Done(d)) if d.stop_reason == "end_turn"));
    }

    #[test]
    fn rate_limits_and_server_errors_retry_and_honor_retry_after() {
        let server = serve(vec![
            json_reply("429 Too Many Requests", "retry-after: 1\r\n", "{\"error\":{\"message\":\"slow down\"}}"),
            json_reply("503 Service Unavailable", "", "{\"error\":{\"message\":\"busy\"}}"),
            sse_reply(vec![(0, CHUNK_HI), (0, CHUNK_STOP)]),
        ]);
        let (_tx, mut rx) = watch::channel(false);
        let started = Instant::now();
        let events = block_on(run_compat(&server.url, &fast_options(), &mut rx));
        assert!(started.elapsed() >= Duration::from_millis(950), "waited for retry-after");
        let retries: Vec<_> = events.iter().filter(|e| matches!(e, AiEvent::Retrying { .. })).collect();
        assert_eq!(retries.len(), 2);
        assert!(matches!(retries[0], AiEvent::Retrying { attempt: 1, delay_ms: 1000, .. }));
        assert_eq!(joined_text(&events), "hi");
        assert_eq!(server.requests.lock().unwrap().len(), 3);
    }

    #[test]
    fn retries_are_bounded() {
        let busy = json_reply("500 Internal Server Error", "", "{\"error\":{\"message\":\"down\"}}");
        let server = serve(vec![busy.clone(), busy.clone(), busy.clone(), busy.clone(), busy]);
        let (_tx, mut rx) = watch::channel(false);
        let events = block_on(run_compat(&server.url, &fast_options(), &mut rx));
        assert_eq!(events.iter().filter(|e| matches!(e, AiEvent::Retrying { .. })).count(), 3);
        assert!(matches!(events.last(), Some(AiEvent::Error(e, _)) if e.code == "SERVER_ERROR"));
        assert_eq!(terminal_count(&events), 1);
    }

    #[test]
    fn a_long_retry_after_becomes_a_clear_error_instead_of_a_long_wait() {
        let server = serve(vec![json_reply("429 Too Many Requests", "retry-after: 3600\r\n", "{\"error\":{\"message\":\"later\"}}")]);
        let (_tx, mut rx) = watch::channel(false);
        let events = block_on(run_compat(&server.url, &fast_options(), &mut rx));
        match events.last() {
            Some(AiEvent::Error(e, _)) => {
                assert_eq!(e.code, "RATE_LIMITED");
                assert!(e.message.contains("3600 seconds"), "{}", e.message);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn nothing_is_retried_after_output_has_started() {
        // The server sends text, then an error, then there is no second reply queued.
        let server = serve(vec![sse_reply(vec![(0, CHUNK_HI), (0, "data: {\"error\":{\"message\":\"boom\"}}\n\n")])]);
        let (_tx, mut rx) = watch::channel(false);
        let events = block_on(run_compat(&server.url, &fast_options(), &mut rx));
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        match events.last() {
            Some(AiEvent::Error(e, partial)) => {
                assert_eq!(e.code, "SERVER_ERROR");
                assert_eq!(partial[0]["text"], "hi");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn cancelling_ends_the_stream_promptly_and_closes_the_connection() {
        let many: Vec<(u64, &str)> = std::iter::repeat_n((100, CHUNK_HI), 100).collect();
        let server = serve(vec![sse_reply(many)]);
        let (tx, mut rx) = watch::channel(false);
        let started = Instant::now();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(350));
            let _ = tx.send(true);
            std::thread::sleep(Duration::from_secs(30));
        });
        let events = block_on(run_compat(&server.url, &fast_options(), &mut rx));
        assert!(started.elapsed() < Duration::from_secs(3), "took {:?}", started.elapsed());
        match events.last() {
            Some(AiEvent::Done(done)) => {
                assert_eq!(done.stop_reason, "cancelled");
                assert!(block_str(&done.content[0], "text").starts_with("hi"), "partial text is kept");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(terminal_count(&events), 1);
        // The server sees the connection close while it is still writing.
        let wait = Instant::now();
        while !*server.closed_early.lock().unwrap() && wait.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(*server.closed_early.lock().unwrap(), "the HTTP stream was closed");
    }

    #[test]
    fn cancelling_during_a_retry_wait_stops_at_once() {
        let server = serve(vec![json_reply("429 Too Many Requests", "retry-after: 3\r\n", "{}")]);
        let (tx, mut rx) = watch::channel(false);
        let started = Instant::now();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let _ = tx.send(true);
            std::thread::sleep(Duration::from_secs(30));
        });
        let events = block_on(run_compat(&server.url, &fast_options(), &mut rx));
        assert!(started.elapsed() < Duration::from_millis(2000));
        assert!(matches!(events.last(), Some(AiEvent::Done(d)) if d.stop_reason == "cancelled"));
    }

    #[test]
    fn a_silent_server_trips_the_idle_timeout_but_a_slow_one_does_not() {
        // Each gap is under the limit and the total is well over it.
        let slow: Vec<(u64, &str)> = vec![(200, CHUNK_HI), (200, CHUNK_HI), (200, CHUNK_HI), (200, CHUNK_STOP)];
        let server = serve(vec![sse_reply(slow)]);
        let options = RunOptions { idle_timeout: Duration::from_millis(500), ..fast_options() };
        let (_tx, mut rx) = watch::channel(false);
        let events = block_on(run_compat(&server.url, &options, &mut rx));
        assert_eq!(joined_text(&events), "hihihi");

        let server = serve(vec![sse_reply(vec![(0, CHUNK_HI), (2000, CHUNK_STOP)])]);
        let options = RunOptions { idle_timeout: Duration::from_millis(300), ..fast_options() };
        let (_tx, mut rx) = watch::channel(false);
        let events = block_on(run_compat(&server.url, &options, &mut rx));
        match events.last() {
            Some(AiEvent::Error(e, partial)) => {
                assert_eq!(e.code, "IDLE_TIMEOUT");
                assert_eq!(partial[0]["text"], "hi");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn nothing_listening_is_reported_as_the_server_being_down() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let (_tx, mut rx) = watch::channel(false);
        let events = block_on(run_compat(&format!("http://127.0.0.1:{port}/x"), &fast_options(), &mut rx));
        match events.last() {
            Some(AiEvent::Error(e, _)) => {
                assert_eq!(e.code, "SERVER_DOWN");
                assert!(e.message.contains("Start your model server"), "{}", e.message);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(events.len(), 1, "no pointless retries against a stopped server");
    }

    #[test]
    fn a_stream_that_just_stops_is_reported_with_what_arrived() {
        let server = serve(vec![sse_reply(vec![(0, CHUNK_HI)])]);
        let (_tx, mut rx) = watch::channel(false);
        let events = block_on(run_compat(&server.url, &fast_options(), &mut rx));
        match events.last() {
            Some(AiEvent::Error(e, partial)) => {
                assert_eq!(e.code, "STREAM_BROKEN");
                assert_eq!(partial[0]["text"], "hi");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_refused_field_is_dropped_and_the_request_sent_again() {
        let refusal = "{\"error\":{\"code\":\"response_format_not_supported\",\"message\":\"only text\",\"param\":\"response_format\",\"type\":\"invalid_request_error\"}}";
        let server = serve(vec![
            json_reply("400 Bad Request", "", refusal),
            sse_reply(vec![(0, CHUNK_HI), (0, CHUNK_STOP)]),
        ]);
        let options = fast_options();
        let client = build_client(&options).unwrap();
        let mut first = prepared(&server.url);
        first.body["response_format"] = json!({ "type": "json_schema" });
        let (_tx, mut rx) = watch::channel(false);
        let mut events = Vec::new();
        let mut sink = |event: AiEvent| events.push(event);
        block_on(run(
            &client,
            first,
            &|| Box::new(CompatDecoder::new("m")) as Box<dyn Decoder>,
            &compat::relax,
            &context(None),
            &options,
            &mut rx,
            &mut sink,
        ));
        assert_eq!(joined_text(&events), "hi");
        let seen = server.requests.lock().unwrap();
        assert!(seen[0].contains("response_format"));
        assert!(!seen[1].contains("response_format"));
    }

    fn classify(status: u16, body: &str) -> StreamError {
        classify_status(status, &HeaderMap::new(), body, &context(Some("sk-secret-123")))
    }

    #[test]
    fn failures_get_clear_codes() {
        assert_eq!(classify(401, "{\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}").code, "BAD_KEY");
        assert_eq!(classify(403, "{\"error\":{\"type\":\"permission_error\",\"message\":\"no\"}}").code, "BAD_KEY");
        assert_eq!(classify(404, "{\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"model: nope\"}}").code, "UNKNOWN_MODEL");
        // The exact error from the local server.
        assert_eq!(classify(404, "{\"error\":{\"code\":\"model_not_found\",\"message\":\"model 'x' not found\",\"param\":\"model\",\"type\":\"invalid_request_error\"}}").code, "UNKNOWN_MODEL");
        assert_eq!(classify(404, "").code, "BAD_URL");
        assert_eq!(classify(400, "{\"error\":{\"code\":\"context_length_exceeded\",\"message\":\"prepared prompt exceeds Engine max_context 262144\",\"param\":\"messages\",\"type\":\"invalid_request_error\"}}").code, "CONTEXT_TOO_LONG");
        assert_eq!(classify(400, "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 1000001 tokens > 1000000 maximum\"}}").code, "CONTEXT_TOO_LONG");
        assert_eq!(classify(413, "{\"error\":{\"type\":\"request_too_large\",\"message\":\"too big\"}}").code, "CONTEXT_TOO_LONG");
        assert_eq!(classify(429, "{\"error\":{\"code\":\"insufficient_quota\",\"message\":\"out of credit\"}}").code, "BILLING");
        assert!(!classify(429, "{\"error\":{\"code\":\"insufficient_quota\",\"message\":\"x\"}}").retryable, "paying later will not fix itself by waiting");
        assert!(classify(429, "{\"error\":{\"message\":\"slow\"}}").retryable);
        assert!(classify(500, "oops").retryable);
        assert_eq!(classify(529, "{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}").code, "OVERLOADED");
        assert_eq!(classify(400, "{\"error\":{\"message\":\"bad field\"}}").code, "BAD_REQUEST");
    }

    #[test]
    fn a_key_echoed_by_a_server_never_reaches_the_message() {
        let error = classify(400, "{\"error\":{\"message\":\"bad key sk-secret-123 sent\"}}");
        assert!(!error.message.contains("sk-secret-123"), "{}", error.message);
        assert!(error.message.contains("[hidden]"));
    }

    #[test]
    fn retry_after_reads_seconds_milliseconds_and_dates() {
        let mut headers = HeaderMap::new();
        assert_eq!(retry_after(&headers), None);
        headers.insert(RETRY_AFTER, HeaderValue::from_static("7"));
        assert_eq!(retry_after(&headers), Some(7000));
        headers.insert("retry-after-ms", HeaderValue::from_static("250"));
        assert_eq!(retry_after(&headers), Some(250));
        headers.remove("retry-after-ms");
        let future = (chrono::Utc::now() + chrono::Duration::seconds(30)).to_rfc2822();
        headers.insert(RETRY_AFTER, HeaderValue::from_str(&future).unwrap());
        let parsed = retry_after(&headers).unwrap();
        assert!((28_000..=31_000).contains(&parsed), "{parsed}");
    }

    #[test]
    fn sensitive_headers_are_marked() {
        let map = header_map(&[("x-api-key".to_string(), "k".to_string()), ("authorization".to_string(), "Bearer k".to_string()), ("accept".to_string(), "*/*".to_string())]);
        assert!(map.get("x-api-key").unwrap().is_sensitive());
        assert!(map.get("authorization").unwrap().is_sensitive());
        assert!(!map.get("accept").unwrap().is_sensitive());
    }
}
