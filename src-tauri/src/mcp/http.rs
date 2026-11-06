//! The local Streamable HTTP endpoint, on its own thread and runtime so it can start and
//! stop with the setting. Every request passes `gate` first: the address must be this
//! computer's, a web page's `Origin` is refused, and the bearer token must match. Those
//! together block a page in the writer's browser from reaching it by DNS rebinding.

use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::sync::Arc;
use std::thread::JoinHandle;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{AUTHORIZATION, HOST, ORIGIN, WWW_AUTHENTICATE};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::config::same_secret;
use super::server::LorebookServer;
use crate::engine::Engine;
use crate::error::{AppError, AppResult};

/// Used when nothing is saved yet, and outside the range Windows hands out for itself.
const PREFERRED_PORT: u16 = 47615;
/// A proposal can hold a whole page, but nothing legitimate is larger than this.
const MAX_BODY: usize = 8 * 1024 * 1024;

type Body = BoxBody<Bytes, Infallible>;

/// The listening server. Dropping it does not stop it: call `stop`.
pub struct Running {
    pub port: u16,
    cancel: CancellationToken,
    thread: Option<JoinHandle<()>>,
}

impl Running {
    pub fn stop(mut self) {
        self.cancel.cancel();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn plain(status: StatusCode, text: &'static str) -> Response<Body> {
    let mut response = Response::new(Full::new(Bytes::from_static(text.as_bytes())).boxed());
    *response.status_mut() = status;
    response
}

fn header<'a>(request: &'a Request<Incoming>, name: hyper::header::HeaderName) -> Option<&'a str> {
    request.headers().get(name).and_then(|v| v.to_str().ok())
}

/// The first failed check, as what to answer.
fn refuse(request: &Request<Incoming>, port: u16, token: &str) -> Option<Response<Body>> {
    let hosts = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    if !header(request, HOST).is_some_and(|host| hosts.iter().any(|h| h.eq_ignore_ascii_case(host))) {
        return Some(plain(StatusCode::FORBIDDEN, "That host is not allowed.\n"));
    }
    // Native clients send no Origin. A browser always does, and only this address's own
    // pages would pass, of which there are none.
    if let Some(origin) = request.headers().get(ORIGIN) {
        let allowed = origin
            .to_str()
            .ok()
            .and_then(|o| o.strip_prefix("http://"))
            .is_some_and(|rest| hosts.iter().any(|h| h.eq_ignore_ascii_case(rest)));
        if !allowed {
            return Some(plain(StatusCode::FORBIDDEN, "That origin is not allowed.\n"));
        }
    }
    let given = header(request, AUTHORIZATION).and_then(|h| h.strip_prefix("Bearer "));
    if token.is_empty() || !given.is_some_and(|given| same_secret(given.trim(), token)) {
        let mut response = plain(StatusCode::UNAUTHORIZED, "A valid bearer token is required.\n");
        response
            .headers_mut()
            .insert(WWW_AUTHENTICATE, hyper::header::HeaderValue::from_static("Bearer"));
        return Some(response);
    }
    None
}

fn status_response(engine: &Engine) -> Response<Body> {
    let status = engine.status();
    let body = json!({
        "app": "lorebook",
        "version": env!("CARGO_PKG_VERSION"),
        "open": status.open,
        "path": status.path,
    });
    let mut response = Response::new(Full::new(Bytes::from(body.to_string())).boxed());
    response.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json"),
    );
    response
}

async fn handle(
    request: Request<Incoming>,
    engine: Arc<Engine>,
    service: StreamableHttpService<LorebookServer, LocalSessionManager>,
    port: u16,
) -> Result<Response<Body>, Infallible> {
    // Read each time, so rotating the token takes effect on the next request.
    let token = engine.mcp.settings().token;
    if let Some(refused) = refuse(&request, port, &token) {
        return Ok(refused);
    }
    match request.uri().path() {
        "/mcp" => Ok(service.handle(request).await),
        // Waits for the session lock, so it must not hold up this runtime's few threads.
        "/status" => Ok(tokio::task::spawn_blocking(move || status_response(&engine))
            .await
            .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "Status failed.\n"))),
        _ => Ok(plain(StatusCode::NOT_FOUND, "Not found.\n")),
    }
}

/// Binds now, so a failure is known at once, then serves on a thread of its own.
pub fn start(engine: Arc<Engine>, wanted_port: u16) -> AppResult<Running> {
    let first = if wanted_port == 0 { PREFERRED_PORT } else { wanted_port };
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, first))
        // Something else has that port, so take any free one. The address shown in
        // Settings and `mcp.json` follow it.
        .or_else(|_| TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let cancel = CancellationToken::new();

    let serving = cancel.clone();
    let thread = std::thread::Builder::new()
        .name("mcp-http".to_string())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(e) => {
                    engine.mcp.record_error(format!("Could not start: {e}"));
                    return;
                }
            };
            runtime.block_on(serve(listener, engine, serving, port));
            // Streams to clients may still be open. They are cut, not waited for.
            runtime.shutdown_background();
        })
        .map_err(|e| AppError::internal(e.to_string()))?;

    Ok(Running {
        port,
        cancel,
        thread: Some(thread),
    })
}

async fn serve(listener: TcpListener, engine: Arc<Engine>, cancel: CancellationToken, port: u16) {
    let listener = match tokio::net::TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(e) => {
            engine.mcp.record_error(format!("Could not listen: {e}"));
            return;
        }
    };
    let factory_engine = engine.clone();
    let service = StreamableHttpService::new(
        move || Ok(LorebookServer::in_app(factory_engine.clone())),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default()
            .with_max_request_body_bytes(MAX_BODY)
            .with_cancellation_token(cancel.child_token()),
    );
    loop {
        let accepted = tokio::select! {
            _ = cancel.cancelled() => break,
            accepted = listener.accept() => accepted,
        };
        let Ok((stream, _)) = accepted else {
            continue;
        };
        let engine = engine.clone();
        let service = service.clone();
        let stop = cancel.clone();
        tokio::spawn(async move {
            let respond = service_fn(move |request| {
                handle(request, engine.clone(), service.clone(), port)
            });
            let connection = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), respond);
            tokio::select! {
                _ = stop.cancelled() => {}
                _ = connection => {}
            }
        });
    }
}
