//! The HTTP surface: the primary listener's router, `/healthz`, and the
//! debug listener's router.
use crate::app_state::AppState;
use crate::browser::ws;
use crate::module_calls::host_link;
use crate::page_controls::{connect, current_status, hangup, model, status, thinking};
#[cfg(test)]
use crate::speech::start_speech_worker_for_test;
#[cfg(test)]
use axum::body::Body;
use axum::extract::State;
#[cfg(test)]
use axum::http::{Method, Request, StatusCode};
use axum::response::IntoResponse;
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
        if let Some(service) = static_dir {
            router.fallback_service(service)
        } else {
            router
        }
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
