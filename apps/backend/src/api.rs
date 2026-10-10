//! The HTTP surface: the primary listener's router, `/healthz`, the debug
//! listener's router, and the origin check both listeners apply.
use crate::app_state::AppState;
use crate::browser::ws;
use crate::module_calls::host_link;
use crate::page_controls::{connect, current_status, hangup, model, status, thinking};
#[cfg(test)]
use crate::speech::start_speech_worker_for_test;
#[cfg(test)]
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
#[cfg(test)]
use axum::http::{Method, Request};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
#[cfg(test)]
use http_body_util::BodyExt;
use serde_json::json;
#[cfg(test)]
use serde_json::Value;
#[cfg(test)]
use tower::ServiceExt;
use tower_http::services::ServeDir;

impl AppState {
    pub fn router(self, static_dir: Option<ServeDir>) -> Router {
        let router = Router::new()
            .route("/healthz", get(healthz))
            .route("/status", get(status))
            .route("/hangup", post(hangup))
            .route("/connect", post(connect))
            .route("/thinking", post(thinking))
            .route("/model", post(model))
            .route("/ws", get(ws))
            .route("/host", get(host_link))
            .with_state(self);
        let router = if let Some(service) = static_dir {
            router.fallback_service(service)
        } else {
            router
        };
        router.layer(middleware::from_fn(refuse_cross_origin))
    }

    /// The optional read-only listener. It has no call controls and serves
    /// only the embedded debug page and its WebSocket.
    pub fn debug_router(&self) -> Router {
        let state = self.clone();
        crate::debug::router(
            self.0.debug.clone(),
            move || state.0.projection.snapshot(),
            self.0.shutdown.subscribe(),
        )
    }
}

async fn healthz(State(state): State<AppState>) -> impl IntoResponse {
    let status = current_status(&state);
    Json(
        json!({"status":"ok", "git":crate::GIT_SHA, "stt_configured":state.0.stt.command.is_some(), "stt_stream_configured":state.0.stt_stream.configured(), "elevenlabs_configured":state.0.speaker.configured(), "route":status.route, "model":status.model, "thinking":status.thinking, "model_swaps":status.model_swaps, "projects":status.projects, "hosts":state.0.hosts.status()}),
    )
}

/// Refuses a request that a page on another site sent. A browser applies no
/// CORS to a WebSocket, and it sends a `POST` with no body cross-site without
/// a preflight, so without this check any page the caller opens could read
/// the call, speak to the agent on the line as the caller, or hang up (#223).
/// A browser names the sending page in `Origin` on both; a request from the
/// page itself, or from a client that is not a browser (no `Origin`: curl, a
/// host agent), passes.
pub(crate) async fn refuse_cross_origin(request: axum::extract::Request, next: Next) -> Response {
    if !same_origin(request.headers()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}

/// True when the request has no `Origin`, or its `Origin` names the same
/// host and port as its `Host`.
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let (Ok(origin), Some(host)) = (
        origin.to_str(),
        headers
            .get(header::HOST)
            .and_then(|host| host.to_str().ok()),
    ) else {
        return false;
    };
    let Some((scheme, authority)) = origin.split_once("://") else {
        return false;
    };
    let default_port = match scheme.to_ascii_lowercase().as_str() {
        "http" => ":80",
        "https" => ":443",
        _ => return false,
    };
    let normal = |authority: &str| {
        let authority = authority.to_ascii_lowercase();
        match authority.strip_suffix(default_port) {
            Some(bare) => bare.to_owned(),
            None => authority,
        }
    };
    normal(authority) == normal(host)
}

#[cfg(test)]
pub(crate) async fn request_json(
    state: &AppState,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    // Delivery tests call the router without the production worker bootstrap.
    // Start only the shared speech worker here so settled replies use the same
    // ordered path as production without a second lifecycle implementation.
    start_speech_worker_for_test(state);
    let mut request = Request::builder().method(method).uri(path);
    let body = match body {
        Some(value) => {
            request = request.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let response = state
        .clone()
        .router(None)
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap();
    (status, value)
}

#[cfg(test)]
#[path = "../tests/test_api.rs"]
mod tests;
