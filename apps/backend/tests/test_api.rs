use super::*;
use crate::app_state::{state, state_with_stream};
use crate::pbx::OPERATOR;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

#[tokio::test]
async fn healthz_reports_the_commit_the_binary_was_stamped_with() {
    // A deploy is checked with one request, so the stamp build.rs chose has to
    // reach /healthz verbatim, beside the fields existing consumers read.
    let (code, health) = request_json(&state(), Method::GET, "/healthz", None).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(health["git"], env!("SWITCHBOARD_GIT_SHA"));
    assert_eq!(health["git"], crate::GIT_SHA);
    assert!(!crate::GIT_SHA.is_empty());
    assert_eq!(health["status"], "ok");
}

#[tokio::test]
async fn healthz_reports_only_what_the_service_knows() {
    // "whisper_model" and "stt_adapter" were constants kept from the Python
    // response ("sidecar", on every deploy); they described nothing. Every
    // field left is state this process holds.
    let (code, health) = request_json(&state(), Method::GET, "/healthz", None).await;
    assert_eq!(code, StatusCode::OK);
    let fields = health
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        fields,
        std::collections::BTreeSet::from([
            "status",
            "git",
            "stt_configured",
            "stt_stream_configured",
            "elevenlabs_configured",
            "route",
            "model",
            "thinking",
            "model_swaps",
            "projects",
            "hosts",
        ])
    );
    assert_eq!(health["stt_configured"], false);
    assert_eq!(health["stt_stream_configured"], false);
    assert_eq!(health["elevenlabs_configured"], true);

    let configured = state_with_stream(Some("true".into()), Some("true".into()));
    let (_, health) = request_json(&configured, Method::GET, "/healthz", None).await;
    assert_eq!(health["stt_configured"], true);
    assert_eq!(health["stt_stream_configured"], true);
}

#[tokio::test]
async fn http_contract_exposes_status_health_and_page_controls() {
    let state = state();
    let (code, status) = request_json(&state, Method::GET, "/status", None).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(status["type"], "status");
    assert_eq!(status["route"], OPERATOR);
    assert_eq!(
        status["levels"],
        serde_json::json!(crate::models::THINKING_LEVELS)
    );

    let (code, health) = request_json(&state, Method::GET, "/healthz", None).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(health["status"], "ok");
    assert_eq!(health["stt_configured"], false);

    let (code, connected) = request_json(
        &state,
        Method::POST,
        "/connect",
        Some(json!({"project":"operator"})),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(connected, json!({"route":"operator", "error":null}));

    let (code, thinking) = request_json(
        &state,
        Method::POST,
        "/thinking",
        Some(json!({"level":"high"})),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(thinking, json!({"thinking":"", "error":null}));
    assert_eq!(state.0.coordinator.status().thinking_default, "high");

    let (code, model) = request_json(
        &state,
        Method::POST,
        "/model",
        Some(json!({"model":"anthropic/next"})),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(model["model"], "");
    assert!(model["error"].as_str().unwrap().contains("project leg"));
}

#[tokio::test]
async fn a_body_the_handler_cannot_read_gets_axums_own_answer() {
    // Controls and callbacks take axum's rejection so they can log it; the
    // page or agent that sent the body must still get the answer axum gives.
    async fn send(path: &str, content_type: Option<&str>, body: Vec<u8>) -> (StatusCode, String) {
        let mut request = Request::builder().method(Method::POST).uri(path);
        if let Some(content_type) = content_type {
            request = request.header("content-type", content_type);
        }
        let response = state()
            .router(None)
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }
    let json = Some("application/json");

    let (code, _) = send("/connect", json, b"{not json".to_vec()).await;
    assert_eq!(code, StatusCode::BAD_REQUEST);

    let (code, _) = send("/connect", None, br#"{"project":"alpha"}"#.to_vec()).await;
    assert_eq!(code, StatusCode::UNSUPPORTED_MEDIA_TYPE);
}

#[tokio::test]
async fn no_agent_callback_is_served_over_http() {
    // Project agents reach the service only through their host agent's link.
    for path in ["/speak", "/display", "/view", "/leg-state"] {
        let response = state()
            .router(None)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
}

async fn get_body(router: Router, path: &str) -> (StatusCode, Vec<u8>) {
    let response = router
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, bytes.to_vec())
}

#[tokio::test]
async fn the_primary_listener_never_serves_the_debug_page() {
    // The debug page is embedded in the binary and routed only by the debug
    // listener. These spellings once reached a `static/debug/` directory
    // through the primary static fallback, past a raw-path route guard.
    let static_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/static");
    assert!(
        !std::path::Path::new(static_dir).join("debug").exists(),
        "debug assets must not live under the primary static root"
    );
    let debug_assets = [
        crate::debug::INDEX_HTML.as_bytes(),
        crate::debug::DEBUG_JS.as_bytes(),
        crate::debug::DEBUG_CSS.as_bytes(),
    ];
    for path in [
        "/debug",
        "/debug/",
        "/debug/index.html",
        "/%64ebug/index.html",
        "/%64ebug/",
        "//debug/index.html",
        "/./debug/index.html",
        "/debug%2Findex.html",
        "/debug/../debug/index.html",
        "/debug.js",
        "/debug.css",
        "/debug/debug.js",
    ] {
        let router = state().router(Some(ServeDir::new(static_dir)));
        let (status, body) = get_body(router, path).await;
        assert!(
            !debug_assets.contains(&body.as_slice()),
            "{path} served debug content ({status})"
        );
        assert_ne!(status, StatusCode::OK, "{path}");
    }
}

#[tokio::test]
async fn the_debug_listener_serves_only_the_embedded_page() {
    let state = state();
    for (path, body, content_type) in [
        ("/", crate::debug::INDEX_HTML, "text/html; charset=utf-8"),
        (
            "/debug.js",
            crate::debug::DEBUG_JS,
            "text/javascript; charset=utf-8",
        ),
        (
            "/debug.css",
            crate::debug::DEBUG_CSS,
            "text/css; charset=utf-8",
        ),
    ] {
        let response = state
            .debug_router()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(
            response.headers()["content-type"].to_str().unwrap(),
            content_type,
            "{path}"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(bytes.as_ref(), body.as_bytes(), "{path}");
    }
    // No call control and no primary page on the debug listener.
    for path in [
        "/index.html",
        "/status",
        "/healthz",
        "/debug/",
        "/v17-assets/x.js",
    ] {
        let (status, _) = get_body(state.debug_router(), path).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
}

#[test]
fn an_origin_matches_its_host_with_or_without_the_default_port() {
    let headers = |origin: &str, host: &str| {
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, origin.parse().unwrap());
        headers.insert(header::HOST, host.parse().unwrap());
        headers
    };
    assert!(same_origin(&headers("http://damocles", "damocles:80")));
    assert!(same_origin(&headers("https://damocles:443", "damocles")));
    assert!(same_origin(&headers("http://[::1]:8766", "[::1]:8766")));
    assert!(!same_origin(&headers(
        "http://damocles:8765",
        "damocles:8766"
    )));
    assert!(!same_origin(&HeaderMap::from_iter([(
        header::ORIGIN,
        "http://damocles".parse().unwrap()
    )])));
}
