//! The debug listener: the embedded debug page and its read-only WebSocket,
//! behind the primary listener's origin check. Admission is bounded here: a
//! socket cap, a bound on any frame the page sends, and a timeout on any
//! frame sent to it.
use crate::api::refuse_cross_origin;
use crate::debug::{DebugBus, Feed, Outgoing, Snapshot};
use crate::debug_record::Clip;
use crate::protocol::AgentState;
use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    http::{header, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use std::sync::Arc;
use tokio::{
    sync::{watch, Semaphore},
    time::{timeout, Duration},
};

/// The compiled debug page. It is embedded at build time so it is served only
/// by the debug listener's router: the primary listener's static directory
/// never holds it, so no path spelling there can reach it.
pub(crate) const INDEX_HTML: &str = include_str!("../../../static-debug/index.html");
pub(crate) const DEBUG_JS: &str = include_str!("../../../static-debug/debug.js");
pub(crate) const DEBUG_CSS: &str = include_str!("../../../static-debug/debug.css");

/// What the debug listener's routes share.
#[derive(Clone)]
struct Site {
    bus: DebugBus,
    agents: Arc<dyn Fn() -> Vec<AgentState> + Send + Sync>,
    shutdown: watch::Receiver<bool>,
    /// One permit per open socket (`MAX_CLIENTS`).
    clients: Arc<Semaphore>,
}

/// The debug listener's whole router: the embedded page and the read-only
/// WebSocket, behind the same origin check as the primary listener (a
/// browser applies no CORS to a WebSocket, so any page it opens could
/// otherwise read this stream). `agents` reads the current agent projection
/// for snapshots; `shutdown` is the service's shutdown signal.
pub(crate) fn router(
    bus: DebugBus,
    agents: impl Fn() -> Vec<AgentState> + Send + Sync + 'static,
    shutdown: watch::Receiver<bool>,
) -> Router {
    asset_routes()
        .route("/ws", get(ws))
        .with_state(Site {
            bus,
            agents: Arc::new(agents),
            shutdown,
            clients: Arc::new(Semaphore::new(MAX_CLIENTS)),
        })
        .layer(middleware::from_fn(refuse_cross_origin))
}

/// The debug page's asset routes. Anything else is a 404.
fn asset_routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    fn asset(content_type: &'static str, body: &'static str) -> Response {
        (
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            body,
        )
            .into_response()
    }
    Router::new()
        .route(
            "/",
            get(|| async { asset("text/html; charset=utf-8", INDEX_HTML) }),
        )
        .route(
            "/debug.js",
            get(|| async { asset("text/javascript; charset=utf-8", DEBUG_JS) }),
        )
        .route(
            "/debug.css",
            get(|| async { asset("text/css; charset=utf-8", DEBUG_CSS) }),
        )
}

/// A debug client that does not take a frame within this time is dropped; it
/// can reconnect and get a fresh snapshot.
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
/// The largest frame the debug socket accepts; it reads none. It bounds a
/// frame as well as a message: the frame bound is checked on the header,
/// before the payload is buffered, and the message bound only after.
const MAX_INCOMING_BYTES: usize = 4096;
/// The most debug sockets open at once. Each one costs a full snapshot when
/// it opens and when it resyncs; a socket past this gets a 503.
const MAX_CLIENTS: usize = 8;

/// The read-only debug stream. The origin check the router applies
/// (`api::refuse_cross_origin`) keeps other sites' pages off it.
async fn ws(State(site): State<Site>, upgrade: WebSocketUpgrade) -> Response {
    let Ok(client) = site.clients.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    // The page sends nothing; anything it sends is ignored.
    upgrade
        .max_frame_size(MAX_INCOMING_BYTES)
        .max_message_size(MAX_INCOMING_BYTES)
        .on_upgrade(move |socket| async move {
            serve_socket(socket, site).await;
            drop(client);
        })
}

async fn send_text(socket: &mut WebSocket, text: String) -> Result<(), ()> {
    match timeout(SEND_TIMEOUT, socket.send(Message::Text(text.into()))).await {
        Ok(Ok(())) => Ok(()),
        _ => Err(()),
    }
}

/// Serializes a snapshot on the blocking pool: it can be megabytes, and the
/// runtime workers also carry audio and turns. The agents are read from the
/// projection, not the rings, so they are scrubbed and clipped here, as an
/// `agents_state` record is.
async fn send_snapshot(socket: &mut WebSocket, site: &Site, snapshot: Snapshot) -> Result<(), ()> {
    let mut agents = (site.agents)();
    let text = tokio::task::spawn_blocking(move || {
        Clip::bound_agents(&mut agents);
        snapshot.to_json(&agents)
    })
    .await
    .map_err(|_| ())?;
    send_text(socket, text).await
}

async fn serve_socket(mut socket: WebSocket, site: Site) {
    let mut shutdown = site.shutdown.clone();
    if *shutdown.borrow_and_update() {
        return;
    }
    let (mut feed, snapshot) = Feed::attach(site.bus.clone());
    if send_snapshot(&mut socket, &site, snapshot).await.is_err() {
        return;
    }
    loop {
        let outgoing = tokio::select! {
            outgoing = feed.next() => outgoing,
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                Some(Ok(_)) => continue,
            },
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    let _ = timeout(SEND_TIMEOUT, socket.send(Message::Close(None))).await;
                    return;
                }
                continue;
            }
        };
        let sent = match outgoing {
            Some(Outgoing::Live(frame)) => send_text(&mut socket, frame.to_json()).await,
            Some(Outgoing::Snapshot(snapshot)) => send_snapshot(&mut socket, &site, snapshot).await,
            None => return,
        };
        if sent.is_err() {
            return;
        }
    }
}

#[cfg(test)]
#[path = "../tests/test_debug_listener.rs"]
mod tests;
