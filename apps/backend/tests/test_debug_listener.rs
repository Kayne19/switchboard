use super::*;
use crate::debug::host_link;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message as Wire;

async fn next_json(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Value {
    loop {
        let message = timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("frame in time")
            .expect("open socket")
            .expect("frame");
        if let Wire::Text(text) = message {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

/// A listener serving the debug router on a loopback port.
async fn serve_debug() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown, shutdown_rx) = watch::channel(false);
    let app = router(DebugBus::new(), Vec::new, shutdown_rx);
    let server = tokio::spawn(async move {
        let _shutdown = shutdown;
        let _ = axum::serve(listener, app).await;
    });
    (address, server)
}

#[tokio::test]
async fn a_frame_over_the_incoming_bound_is_refused_from_its_header() {
    // #231: the frame bound is checked on a frame's header, before its
    // payload is buffered; the message bound only after. A client that
    // announces a large frame is closed on the header alone.
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (address, server) = serve_debug().await;
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream
        .write_all(
            format!(
                "GET /ws HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\n\
                 Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
                 Sec-WebSocket-Version: 13\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).await.unwrap();
        head.push(byte[0]);
    }
    assert!(
        head.starts_with(b"HTTP/1.1 101"),
        "{}",
        String::from_utf8_lossy(&head)
    );
    // A masked text frame that announces 1 MiB, and none of its payload.
    let mut header = vec![0x81, 0x80 | 127];
    header.extend_from_slice(&(1u64 << 20).to_be_bytes());
    header.extend_from_slice(&[1, 2, 3, 4]);
    stream.write_all(&header).await.unwrap();
    let closed = timeout(Duration::from_secs(1), async {
        let mut buffer = [0u8; 4096];
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
        }
    })
    .await;
    assert!(
        closed.is_ok(),
        "the listener waits for the announced payload"
    );
    server.abort();
}

#[tokio::test]
async fn the_debug_listener_serves_a_bounded_number_of_sockets() {
    let (address, server) = serve_debug().await;
    let url = format!("ws://{address}/ws");
    let mut sockets = Vec::new();
    for _ in 0..MAX_CLIENTS {
        let (mut socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        assert_eq!(next_json(&mut socket).await["type"], "snapshot");
        sockets.push(socket);
    }
    let refused = |result| match result {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => response.status().as_u16(),
        Ok(_) => 101,
        Err(error) => panic!("upgrade failed: {error}"),
    };
    assert_eq!(refused(tokio_tungstenite::connect_async(&url).await), 503);
    // A socket that closes frees its place.
    sockets.pop().unwrap().close(None).await.unwrap();
    let reopened = timeout(Duration::from_secs(5), async {
        loop {
            if refused(tokio_tungstenite::connect_async(&url).await) == 101 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(reopened.is_ok(), "a freed place is not reused");
    server.abort();
}

/// The status the debug socket answers an upgrade from `origin` with.
async fn upgrade_status(origin: Option<&str>) -> u16 {
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Error};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (_shutdown, shutdown_rx) = watch::channel(false);
    let app = router(DebugBus::new(), Vec::new, shutdown_rx);
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
async fn the_debug_socket_accepts_only_its_own_origin() {
    assert_eq!(upgrade_status(None).await, 101);
    assert_eq!(upgrade_status(Some("http://{address}")).await, 101);
    assert_eq!(upgrade_status(Some("HTTP://{address}")).await, 101);
    for foreign in [
        "http://evil.example",
        "http://evil.example:8766",
        "https://{address}.evil.example",
        "null",
        "file://",
    ] {
        assert_eq!(upgrade_status(Some(foreign)).await, 403, "{foreign}");
    }
}

#[tokio::test]
async fn the_debug_socket_sends_a_snapshot_then_live_frames_then_closes_on_shutdown() {
    let bus = DebugBus::new();
    bus.publish(host_link(1));
    bus.publish_log("INFO".into(), "t".into(), "before".into(), json!({}));
    let (shutdown, shutdown_rx) = watch::channel(false);
    let agents = || {
        vec![AgentState {
            project: "alpha".into(),
            state: "idle".into(),
            pending_request: None,
        }]
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = router(bus.clone(), agents, shutdown_rx);
    let server = tokio::spawn(async move { axum::serve(listener, app).await });

    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/ws"))
        .await
        .unwrap();
    let snapshot = next_json(&mut socket).await;
    assert_eq!(snapshot["type"], "snapshot");
    assert_eq!(snapshot["last_seq"], 2);
    assert_eq!(snapshot["events"][0]["kind"], "host_link");
    assert_eq!(snapshot["logs"][0]["message"], "before");
    assert_eq!(snapshot["agents"][0]["project"], "alpha");

    bus.publish(host_link(3));
    bus.publish_log("INFO".into(), "t".into(), "after".into(), json!({}));
    let event = next_json(&mut socket).await;
    assert_eq!(
        (event["type"].clone(), event["seq"].clone()),
        (json!("event"), json!(3))
    );
    assert_eq!(event["host"], "host-3");
    let log = next_json(&mut socket).await;
    assert_eq!(
        (log["type"].clone(), log["seq"].clone()),
        (json!("log"), json!(4))
    );

    // Writes from the page are ignored; the socket is read-only.
    socket
        .send(Wire::Text("{\"type\":\"hangup\"}".into()))
        .await
        .unwrap();
    bus.publish(host_link(5));
    assert_eq!(next_json(&mut socket).await["seq"], 5);

    shutdown.send_replace(true);
    let closed = timeout(Duration::from_secs(5), async {
        loop {
            match socket.next().await {
                Some(Ok(Wire::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "the debug socket closes on shutdown");
    server.abort();
}

#[tokio::test]
async fn a_snapshot_scrubs_and_clips_the_agents_it_sends() {
    let agents = || {
        vec![AgentState {
            project: "alpha".into(),
            state: "waiting".into(),
            pending_request: Some(crate::protocol::AgentRequest {
                message: format!(
                    "api_key=sk-live-1234567890abcdef {}",
                    "x".repeat(4 * 1024 * 4)
                ),
                reason: "finished".into(),
            }),
        }]
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (_shutdown, shutdown_rx) = watch::channel(false);
    let app = router(DebugBus::new(), agents, shutdown_rx);
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/ws"))
        .await
        .unwrap();
    let snapshot = next_json(&mut socket).await;
    let message = snapshot["agents"][0]["pending_request"]["message"]
        .as_str()
        .unwrap();
    assert!(message.contains("[redacted]"), "{}", &message[..80]);
    assert!(!message.contains("sk-live"));
    assert!(message.ends_with("…[clipped]"));
    assert!(message.len() <= 4 * 1024 + "…[clipped]".len());
    server.abort();
}
