use super::*;
use crate::app_state::{scratch_root, state, state_with_agents, state_with_stream};
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
        Some(json!({"project":"operator", "generation":state.0.coordinator.generation()})),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(connected, json!({"route":"operator", "error":null}));

    let (code, thinking) = request_json(
        &state,
        Method::POST,
        "/thinking",
        Some(json!({"level":"high", "generation":state.0.coordinator.generation()})),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(thinking, json!({"thinking":"", "error":null}));
    assert_eq!(state.0.coordinator.status().thinking_default, "high");

    let (code, model) = request_json(
        &state,
        Method::POST,
        "/model",
        Some(json!({"model":"anthropic/next", "generation":state.0.coordinator.generation()})),
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

/// The status the primary listener answers a `/ws` upgrade from `origin`
/// with. It goes over a real socket: a oneshot request cannot upgrade.
async fn call_socket_upgrade_status(origin: Option<&str>) -> u16 {
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Error};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = state().router(None);
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let mut request = format!("ws://{address}/ws").into_client_request().unwrap();
    if let Some(origin) = origin {
        let origin = origin.replace("{address}", &address.to_string());
        request
            .headers_mut()
            .insert("Origin", origin.parse().unwrap());
    }
    let status = match tokio_tungstenite::connect_async(request).await {
        Ok((_, response)) => response.status().as_u16(),
        Err(Error::Http(response)) => response.status().as_u16(),
        Err(error) => panic!("upgrade failed: {error}"),
    };
    server.abort();
    status
}

#[tokio::test]
async fn the_call_socket_accepts_only_its_own_origin() {
    // #223: a browser applies no CORS to a WebSocket, and this one reads the
    // transcript and speaks to the agent on the line as the caller. A page
    // on any other site must not be able to open it.
    assert_eq!(call_socket_upgrade_status(None).await, 101);
    assert_eq!(
        call_socket_upgrade_status(Some("http://{address}")).await,
        101
    );
    assert_eq!(
        call_socket_upgrade_status(Some("HTTP://{address}")).await,
        101
    );
    for foreign in [
        "http://evil.example",
        "http://evil.example:8765",
        "https://{address}.evil.example",
        "null",
        "file://",
    ] {
        assert_eq!(
            call_socket_upgrade_status(Some(foreign)).await,
            403,
            "{foreign}"
        );
    }
}

/// `POST /hangup` as a page at `origin` sends it to `host`: no body and no
/// `Content-Type`, which a cross-site `fetch(.., {mode: "no-cors"})` can
/// send without a preflight.
async fn hangup_from(state: &AppState, origin: &str, host: &str) -> StatusCode {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/hangup")
        .header("origin", origin)
        .header("host", host)
        .body(Body::empty())
        .unwrap();
    state
        .clone()
        .router(None)
        .oneshot(request)
        .await
        .unwrap()
        .status()
}

#[cfg(unix)]
#[tokio::test]
async fn a_cross_site_hangup_is_refused_and_leaves_the_leg_on_the_line() {
    let root = scratch_root("api-cross-site-hangup");
    let state = state_with_agents(&root);
    let (_connection, _, _) = state.register_connection().await;
    state.0.switchboard.lock().await.handle("hello").await;
    let operator = state
        .0
        .active_session
        .lock()
        .await
        .clone()
        .expect("the operator is live");

    let code = hangup_from(&state, "http://evil.example", "switchboard.home.arpa").await;
    assert_eq!(code, StatusCode::FORBIDDEN);
    assert!(operator.alive().await);
    assert!(state.0.active_session.lock().await.is_some());

    // The page itself, as caddy hands it on: the browser's Host, unchanged.
    let code = hangup_from(
        &state,
        "https://switchboard.home.arpa",
        "switchboard.home.arpa",
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert!(!operator.alive().await);
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
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

/// What `router` answers a `GET` for `path` sent to `host`, from a page at
/// `origin` when there is one.
async fn status_for_host(
    router: axum::Router,
    path: &str,
    host: &str,
    origin: Option<&str>,
) -> StatusCode {
    let mut request = Request::builder().uri(path).header("host", host);
    if let Some(origin) = origin {
        request = request.header("origin", origin);
    }
    router
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn a_name_public_dns_could_rebind_is_refused_on_both_listeners() {
    // #229: after a DNS rebind, a page at http://evil.example:8766 reaches
    // the service with Host and Origin both naming evil.example, so they
    // agree. A same-origin GET carries no Origin at all. The Host has to be
    // a name public DNS cannot answer for.
    let state = state();
    for (router, path) in [
        (state.clone().router(None), "/healthz"),
        (state.debug_router(), "/"),
    ] {
        for host in [
            "evil.example:8766",
            "evil.example",
            "evil.example.",
            "switchboard.home.arpa.evil.example",
            "192.168.1.217.nip.io:8765",
            "home.arpa.evil.example",
        ] {
            let origin = format!("http://{host}");
            assert_eq!(
                status_for_host(router.clone(), path, host, Some(&origin)).await,
                StatusCode::FORBIDDEN,
                "{host} from {origin}"
            );
            assert_eq!(
                status_for_host(router.clone(), path, host, None).await,
                StatusCode::FORBIDDEN,
                "{host} with no Origin"
            );
        }
        for host in [
            "switchboard.home.arpa",
            "SWITCHBOARD.HOME.ARPA",
            "switchboard.home.arpa.",
            "192.168.1.217:8765",
            "127.0.0.1",
            "[::1]:8766",
            "localhost:8765",
            "damocles",
            "damocles:8766",
            "damocles.local",
            "damocles.internal",
            "debug.localhost:8766",
        ] {
            let origin = format!("https://{host}");
            assert_eq!(
                status_for_host(router.clone(), path, host, Some(&origin)).await,
                StatusCode::OK,
                "{host} from {origin}"
            );
            assert_eq!(
                status_for_host(router.clone(), path, host, None).await,
                StatusCode::OK,
                "{host} with no Origin"
            );
        }
    }
}
