//! The host link over a real socket: an in-process service on 127.0.0.1 and
//! a tungstenite client standing in for the host agent.
use super::*;
use crate::app_state::AppState;
use crate::registry::Registry;
use crate::within;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use tokio::time::timeout;
use tower::ServiceExt;

type HostAgent =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type Wire = tokio_tungstenite::tungstenite::Message;

const TOKEN: &str = "test-token-scriptorium";

fn fast() -> Heartbeat {
    Heartbeat {
        interval: Duration::from_millis(40),
        missed_pong_limit: 3,
    }
}

/// A slow heartbeat, for tests that must not see a ping.
fn slow() -> Heartbeat {
    Heartbeat {
        interval: Duration::from_secs(60),
        missed_pong_limit: 3,
    }
}

fn tokens() -> HashMap<String, String> {
    HashMap::from([
        ("scriptorium".to_owned(), TOKEN.to_owned()),
        ("forge".to_owned(), "test-token-forge".to_owned()),
    ])
}

/// The whole service router with `hosts`, as `main` builds it.
fn state(hosts: Hosts) -> AppState {
    let config = crate::Config::for_tests(&[]);
    let registry = Registry::new(vec![]);
    // No projects, so no startup work: the prewarm only carries the hosts.
    let prewarm = crate::prewarm::Prewarm::start(&registry, hosts);
    AppState::new(
        crate::pbx::Switchboard::new(&config, registry, Arc::new(prewarm)),
        crate::history::TranscriptLog::new(10),
        crate::audio::Speaker::offline(100, Duration::from_millis(25_000)),
        crate::audio::SttAdapter::from_command(None),
        crate::audio::SttStreamAdapter::from_command(None),
    )
}

struct Served {
    state: AppState,
    address: std::net::SocketAddr,
    server: tokio::task::JoinHandle<()>,
}

impl Served {
    async fn start(heartbeat: Heartbeat) -> Self {
        let state = state(Hosts::new(tokens(), heartbeat));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = state.clone().router(None);
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            state,
            address,
            server,
        }
    }

    async fn dial(&self) -> HostAgent {
        let (agent, _) = tokio_tungstenite::connect_async(format!("ws://{}/host", self.address))
            .await
            .unwrap();
        agent
    }

    /// Dials and says `hello`; returns the socket and the service's answer.
    async fn hello(&self, host: &str, token: &str, protocol: Value) -> (HostAgent, Value) {
        let mut agent = self.dial().await;
        send(
            &mut agent,
            json!({
                "type": "hello",
                "host_id": host,
                "token": token,
                "protocol": protocol,
                "git_sha": "d95f029",
                "boot_id": "5c2e9a0b41d7",
                "prime_agent": {"client_version": "0.9.5", "daemon_version": "0.9.6", "daemon_protocol": 7},
            }),
        )
        .await;
        let answer = next_json(&mut agent).await;
        (agent, answer)
    }

    async fn healthz(&self) -> Value {
        let response = self
            .state
            .clone()
            .router(None)
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn host(&self, id: &str) -> Value {
        self.healthz().await["hosts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|host| host["host"] == id)
            .cloned()
            .unwrap()
    }

    /// Polls `/healthz` until `ready` holds for host `id`.
    async fn until_host(&self, id: &str, ready: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..200 {
            let host = self.host(id).await;
            if ready(&host) {
                return host;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "host {id} never reached the expected state: {}",
            self.host(id).await
        );
    }
}

impl Drop for Served {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn send(agent: &mut HostAgent, frame: Value) {
    agent
        .send(Wire::Text(frame.to_string().into()))
        .await
        .unwrap();
}

async fn next_wire(agent: &mut HostAgent) -> Option<Wire> {
    timeout(Duration::from_secs(5), agent.next())
        .await
        .expect("a frame before the deadline")
        .map(|frame| frame.expect("a readable frame"))
}

async fn next_json(agent: &mut HostAgent) -> Value {
    match next_wire(agent).await {
        Some(Wire::Text(text)) => serde_json::from_str(text.as_str()).unwrap(),
        other => panic!("expected a text frame, got {other:?}"),
    }
}

/// The close code the service ends the link with, skipping text frames.
async fn close_code(agent: &mut HostAgent) -> Option<u16> {
    loop {
        match next_wire(agent).await {
            Some(Wire::Close(frame)) => return frame.map(|frame| u16::from(frame.code)),
            Some(Wire::Text(_)) | Some(Wire::Ping(_)) | Some(Wire::Pong(_)) => continue,
            Some(other) => panic!("unexpected frame {other:?}"),
            None => return None,
        }
    }
}

/// Reads frames, answering the service's pings, until one satisfies `want`.
async fn until_frame(agent: &mut HostAgent, want: impl Fn(&Value) -> bool) -> Value {
    loop {
        let frame = next_json(agent).await;
        if frame["type"] == "ping" {
            send(agent, json!({"type": "pong"})).await;
        }
        if want(&frame) {
            return frame;
        }
    }
}

#[tokio::test]
async fn hosts_welcome_a_host_with_its_token_and_report_it_on_healthz() {
    let served = Served::start(slow()).await;
    let before = served.healthz().await;
    assert_eq!(
        before["hosts"],
        json!([
            {"host":"forge","connected":false,"epoch":null,"synced":false,"protocol":null,
             "protocol_status":null,"git_sha":null,"prime_agent":null},
            {"host":"scriptorium","connected":false,"epoch":null,"synced":false,"protocol":null,
             "protocol_status":null,"git_sha":null,"prime_agent":null},
        ])
    );

    let (mut agent, welcome) = served.hello("scriptorium", TOKEN, json!(1)).await;
    assert_eq!(
        welcome,
        json!({"type":"welcome","epoch":1,"protocol":1,"cursors":{}})
    );
    send(&mut agent, json!({"type":"synced","epoch":1})).await;
    let host = served
        .until_host("scriptorium", |host| host["synced"] == true)
        .await;
    assert_eq!(
        host,
        json!({"host":"scriptorium","connected":true,"epoch":1,"synced":true,"protocol":1,
               "protocol_status":"compatible","git_sha":"d95f029",
               "prime_agent":{"client_version":"0.9.5","daemon_version":"0.9.6","daemon_protocol":7}})
    );
    // The token never reaches /healthz.
    assert!(!served.healthz().await.to_string().contains(TOKEN));

    agent.close(None).await.unwrap();
    let host = served
        .until_host("scriptorium", |host| host["connected"] == false)
        .await;
    assert_eq!(
        host["git_sha"], "d95f029",
        "the last hello is still reported"
    );
}

#[tokio::test]
async fn hosts_refuse_a_bad_token_or_an_unknown_host() {
    let served = Served::start(slow()).await;
    for (host, token) in [
        ("scriptorium", "wrong"),
        ("scriptorium", "test-token-forge"),
        ("elsewhere", TOKEN),
    ] {
        let (mut agent, refused) = served.hello(host, token, json!(1)).await;
        assert_eq!(
            refused,
            json!({"type":"refused","reason":"bad_token","message":"unknown host or token"})
        );
        assert_eq!(close_code(&mut agent).await, Some(CLOSE_POLICY));
    }
    let host = served.host("scriptorium").await;
    assert_eq!(host["connected"], false);
    assert_eq!(
        host["git_sha"],
        Value::Null,
        "an unauthenticated hello is not reported"
    );
}

#[tokio::test]
async fn hosts_refuse_an_incompatible_protocol_and_report_it() {
    let served = Served::start(slow()).await;
    for protocol in [json!(2), json!(0), json!("1"), Value::Null] {
        let (mut agent, refused) = served.hello("scriptorium", TOKEN, protocol.clone()).await;
        assert_eq!(refused["type"], "refused");
        assert_eq!(refused["reason"], "incompatible_protocol", "{protocol}");
        assert_eq!(
            refused["message"],
            format!("host-link protocol {protocol} is not supported")
        );
        assert_eq!(close_code(&mut agent).await, Some(CLOSE_POLICY));
    }
    let (_agent, _) = served.hello("forge", "test-token-forge", json!(7)).await;
    let host = served.host("forge").await;
    assert_eq!(host["connected"], false);
    assert_eq!(host["protocol"], 7);
    assert_eq!(host["protocol_status"], "incompatible");
    assert_eq!(host["git_sha"], "d95f029");
}

#[test]
fn hosts_protocol_status_names_outdated_between_oldest_and_current() {
    assert_eq!(protocol_status(Some(HOST_LINK_PROTOCOL)), "compatible");
    assert_eq!(
        protocol_status(Some(HOST_LINK_PROTOCOL + 1)),
        "incompatible"
    );
    assert_eq!(protocol_status(None), "incompatible");
    // Once the service speaks 3 and still accepts 2, a host on 2 is outdated.
    assert_eq!(protocol_status_within(Some(3), 2, 3), "compatible");
    assert_eq!(protocol_status_within(Some(2), 2, 3), "outdated");
    assert_eq!(protocol_status_within(Some(1), 2, 3), "incompatible");
    assert_eq!(protocol_status_within(Some(4), 2, 3), "incompatible");
}

#[tokio::test]
async fn hosts_close_a_socket_that_sends_no_hello() {
    let served = Served::start(fast()).await;
    let mut agent = served.dial().await;
    send(&mut agent, json!({"type":"ping"})).await;
    assert_eq!(close_code(&mut agent).await, Some(CLOSE_PROTOCOL_ERROR));
    let mut silent = served.dial().await;
    assert_eq!(close_code(&mut silent).await, Some(CLOSE_PROTOCOL_ERROR));
}

#[tokio::test]
async fn hosts_fence_the_older_link_when_a_newer_one_is_accepted() {
    let served = Served::start(slow()).await;
    let (mut older, welcome) = served.hello("scriptorium", TOKEN, json!(1)).await;
    assert_eq!(welcome["epoch"], 1);
    send(
        &mut older,
        json!({"type":"event","session":"a1b2","cursor":"boot:1","event":{"kind":"turn_start","cause":"input"}}),
    )
    .await;
    send(&mut older, json!({"type":"synced","epoch":1})).await;
    served
        .until_host("scriptorium", |host| host["synced"] == true)
        .await;

    let (mut newer, welcome) = served.hello("scriptorium", TOKEN, json!(1)).await;
    assert_eq!(welcome["type"], "welcome");
    assert_eq!(welcome["epoch"], 2, "a newer link gets a larger epoch");
    assert_eq!(welcome["cursors"], json!({"a1b2":"boot:1"}));
    assert_eq!(close_code(&mut older).await, Some(CLOSE_FENCED));

    // The new link is not synced until it says so for its own epoch; a
    // `synced` carrying the fenced epoch is stale.
    let host = served.host("scriptorium").await;
    assert_eq!(
        (
            host["connected"].clone(),
            host["epoch"].clone(),
            host["synced"].clone()
        ),
        (json!(true), json!(2), json!(false))
    );
    send(&mut newer, json!({"type":"synced","epoch":1})).await;
    // Frames on one link are applied in order: the pong means the stale
    // `synced` before it was seen, and ignored.
    send(&mut newer, json!({"type":"ping"})).await;
    until_frame(&mut newer, |frame| frame["type"] == "pong").await;
    assert_eq!(served.host("scriptorium").await["synced"], false);
    send(
        &mut newer,
        json!({"type":"event","session":"c3d4","cursor":"boot:2","event":{"kind":"text","text":"hi"}}),
    )
    .await;
    send(&mut newer, json!({"type":"synced","epoch":2})).await;
    served
        .until_host("scriptorium", |host| host["synced"] == true)
        .await;
    let (mut third, welcome) = served.hello("scriptorium", TOKEN, json!(1)).await;
    assert_eq!(welcome["epoch"], 3);
    assert_eq!(welcome["cursors"], json!({"a1b2":"boot:1","c3d4":"boot:2"}));
    assert_eq!(close_code(&mut newer).await, Some(CLOSE_FENCED));

    // The fenced link's end does not unlink the current one.
    let host = served
        .until_host("scriptorium", |host| host["epoch"] == 3)
        .await;
    assert_eq!(host["connected"], true);
    send(&mut third, json!({"type":"synced","epoch":3})).await;
    served
        .until_host("scriptorium", |host| host["synced"] == true)
        .await;
}

#[tokio::test]
async fn hosts_ignore_frames_from_a_fenced_link() {
    let hosts = Hosts::new(tokens(), slow());
    let hello = |kind: &str| Hello {
        kind: kind.to_owned(),
        host_id: "scriptorium".to_owned(),
        token: TOKEN.to_owned(),
        protocol: json!(1),
        git_sha: None,
        prime_agent: None,
    };
    let (older, mut older_frames) = mpsc::unbounded_channel();
    assert_eq!(hosts.admit(hello("hello"), older), Ok(1));
    let (newer, _newer_frames) = mpsc::unbounded_channel();
    assert_eq!(hosts.admit(hello("hello"), newer), Ok(2));
    // The older link got its welcome, then the fence.
    assert!(matches!(
        within("older_frames", older_frames.recv()).await,
        Some(Message::Text(_))
    ));
    assert!(matches!(
        within("older_frames", older_frames.recv()).await,
        Some(Message::Close(Some(CloseFrame {
            code: CLOSE_FENCED,
            ..
        })))
    ));
    assert!(within("older_frames", older_frames.recv()).await.is_none());

    // An event and a `synced` still in flight on the fenced link change nothing.
    hosts.on_frame(
        "scriptorium",
        1,
        &json!({"type":"event","session":"a1b2","cursor":"boot:9","event":{"kind":"text"}})
            .to_string(),
    );
    hosts.on_frame(
        "scriptorium",
        1,
        &json!({"type":"synced","epoch":1}).to_string(),
    );
    hosts.release("scriptorium", 1, "fenced");
    let status = hosts.status();
    let host = status
        .as_array()
        .unwrap()
        .iter()
        .find(|host| host["host"] == "scriptorium")
        .unwrap();
    assert_eq!(
        (
            host["connected"].clone(),
            host["epoch"].clone(),
            host["synced"].clone()
        ),
        (json!(true), json!(2), json!(false))
    );
    let state = hosts.0.hosts.lock().unwrap();
    assert!(state["scriptorium"].cursors.is_empty());
}

#[tokio::test]
async fn hosts_welcome_a_reconnect_with_the_last_cursor_per_session() {
    let served = Served::start(slow()).await;
    let (mut agent, _) = served.hello("scriptorium", TOKEN, json!(1)).await;
    for frame in [
        json!({"type":"event","session":"a1b2","cursor":"boot:3","event":{"kind":"turn_start","cause":"input"}}),
        json!({"type":"event","session":"a1b2","cursor":"boot:4","event":{"kind":"turn_end"},"replayed":true}),
        json!({"type":"snapshot","session":"e5f6","cursor":"boot:5","info":{"session":"e5f6"}}),
        json!({"type":"event","session":"dead","cursor":"boot:6","event":{"kind":"turn_start","cause":"input"}}),
        json!({"type":"event","session":"dead","cursor":"boot:7","event":{"kind":"session_closed","reason":"killed"}}),
        // Frames the service does not act on yet keep the link up.
        json!({"type":"reply","id":"c1","epoch":1,"ok":true,"result":null}),
        json!({"type":"module_call","id":"m1","session":"a1b2","token":"t","call":"speak","args":{}}),
        json!({"type":"something_newer"}),
        json!({"type":"synced","epoch":1}),
    ] {
        send(&mut agent, frame).await;
    }
    agent.send(Wire::Text("not json".into())).await.unwrap();
    served
        .until_host("scriptorium", |host| host["synced"] == true)
        .await;
    agent.close(None).await.unwrap();
    served
        .until_host("scriptorium", |host| host["connected"] == false)
        .await;

    let (_agent, welcome) = served.hello("scriptorium", TOKEN, json!(1)).await;
    assert_eq!(welcome["epoch"], 2);
    assert_eq!(
        welcome["cursors"],
        json!({"a1b2":"boot:4","e5f6":"boot:5"}),
        "a closed session is forgotten"
    );
}

#[tokio::test]
async fn hosts_heartbeat_keeps_a_link_that_answers() {
    let served = Served::start(fast()).await;
    let (mut agent, _) = served.hello("scriptorium", TOKEN, json!(1)).await;
    // The service answers the host's pings too.
    send(&mut agent, json!({"type":"ping"})).await;
    until_frame(&mut agent, |frame| frame["type"] == "pong").await;
    // Well past the drop window (3 × 40 ms), answering every ping.
    let mut pings = 0;
    while pings < 8 {
        let frame = until_frame(&mut agent, |frame| frame["type"] == "ping").await;
        assert_eq!(frame, json!({"type":"ping"}));
        pings += 1;
    }
    assert_eq!(served.host("scriptorium").await["connected"], true);
}

#[tokio::test]
async fn hosts_heartbeat_drops_a_link_that_misses_three_pongs() {
    let served = Served::start(fast()).await;
    let (mut agent, _) = served.hello("scriptorium", TOKEN, json!(1)).await;
    served
        .until_host("scriptorium", |host| host["connected"] == true)
        .await;
    let mut pings = 0;
    let code = loop {
        match next_wire(&mut agent).await {
            Some(Wire::Text(text)) => {
                let frame: Value = serde_json::from_str(text.as_str()).unwrap();
                assert_eq!(frame["type"], "ping");
                pings += 1;
            }
            Some(Wire::Close(frame)) => break frame.map(|frame| u16::from(frame.code)),
            other => panic!("unexpected frame {other:?}"),
        }
    };
    assert_eq!(code, Some(CLOSE_HEARTBEAT));
    assert_eq!(pings, 3, "dropped after three unanswered pings");
    served
        .until_host("scriptorium", |host| host["connected"] == false)
        .await;
}

#[tokio::test]
async fn hosts_close_links_on_shutdown() {
    let served = Served::start(slow()).await;
    let (mut agent, _) = served.hello("scriptorium", TOKEN, json!(1)).await;
    crate::app_state::shutdown(&served.state).await;
    assert_eq!(close_code(&mut agent).await, Some(CLOSE_GOING_AWAY));
}

#[tokio::test]
async fn hosts_send_commands_on_the_current_link_and_match_their_replies() {
    let served = Served::start(slow()).await;
    let hosts = served.state.0.switchboard.lock().await.hosts();
    let not_connected = hosts
        .command(
            "scriptorium",
            "list_models",
            json!({}),
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
    assert_eq!(not_connected.code, "not_connected");

    let (mut agent, _) = served.hello("scriptorium", TOKEN, json!(1)).await;
    served
        .until_host("scriptorium", |host| host["connected"] == true)
        .await;
    let asking = {
        let hosts = hosts.clone();
        tokio::spawn(async move {
            hosts
                .command(
                    "scriptorium",
                    "list_models",
                    json!({}),
                    Duration::from_secs(5),
                )
                .await
        })
    };
    let command = until_frame(&mut agent, |frame| frame["type"] == "command").await;
    assert_eq!(
        (
            command["name"].clone(),
            command["epoch"].clone(),
            command["args"].clone()
        ),
        (json!("list_models"), json!(1), json!({}))
    );
    // A reply for another epoch is not this command's.
    send(
        &mut agent,
        json!({"type":"reply","id":command["id"],"epoch":9,"ok":true,"result":{}}),
    )
    .await;
    send(
        &mut agent,
        json!({"type":"reply","id":command["id"],"epoch":1,"ok":true,"result":{"models":[]}}),
    )
    .await;
    let reply = timeout(Duration::from_secs(5), asking)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(reply.result, json!({"models":[]}));

    // An error reply carries the host agent's code and message.
    let failing = {
        let hosts = hosts.clone();
        tokio::spawn(async move {
            hosts
                .command(
                    "scriptorium",
                    "kill",
                    json!({"session":"x"}),
                    Duration::from_secs(5),
                )
                .await
        })
    };
    let command = until_frame(&mut agent, |frame| frame["type"] == "command").await;
    send(
        &mut agent,
        json!({"type":"reply","id":command["id"],"epoch":1,"ok":false,
               "error":{"code":"refused","message":"session x was taken over"}}),
    )
    .await;
    let error = timeout(Duration::from_secs(5), failing)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(
        (error.code.as_str(), error.message.as_str()),
        ("refused", "session x was taken over")
    );

    // A command whose link goes away is told so.
    let lost = {
        let hosts = hosts.clone();
        tokio::spawn(async move {
            hosts
                .command(
                    "scriptorium",
                    "list_models",
                    json!({}),
                    Duration::from_secs(5),
                )
                .await
        })
    };
    until_frame(&mut agent, |frame| frame["type"] == "command").await;
    drop(agent);
    let error = timeout(Duration::from_secs(5), lost)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "link_lost");
}

#[tokio::test]
async fn hosts_route_session_frames_and_refuse_module_calls_nobody_waits_for() {
    let served = Served::start(slow()).await;
    let hosts = served.state.0.switchboard.lock().await.hosts();
    let (mut agent, _) = served.hello("scriptorium", TOKEN, json!(1)).await;
    served
        .until_host("scriptorium", |host| host["connected"] == true)
        .await;

    // No one listens to session a1: its module call is refused at once.
    send(
        &mut agent,
        json!({"type":"module_call","id":"m1","session":"a1","token":"t","call":"speak","args":{"text":"hi"}}),
    )
    .await;
    let reply = until_frame(&mut agent, |frame| frame["type"] == "module_reply").await;
    assert_eq!(
        reply,
        json!({"type":"module_reply","id":"m1","status":"refused","reason":"not_on_call"})
    );

    let mut frames = hosts.subscribe("scriptorium", "a1");
    send(
        &mut agent,
        json!({"type":"event","session":"a1","cursor":"b:1","event":{"kind":"text","text":"hello"}}),
    )
    .await;
    send(
        &mut agent,
        json!({"type":"module_call","id":"m2","session":"a1","token":"t","call":"view","args":{}}),
    )
    .await;
    let Some(SessionFrame::Event { event, .. }) = timeout(Duration::from_secs(5), frames.recv())
        .await
        .unwrap()
    else {
        panic!("the event comes first");
    };
    assert_eq!(event, json!({"kind":"text","text":"hello"}));
    let Some(SessionFrame::ModuleCall(call)) = timeout(Duration::from_secs(5), frames.recv())
        .await
        .unwrap()
    else {
        panic!("then the module call");
    };
    assert_eq!((call.token.as_str(), call.call.as_str()), ("t", "view"));
    call.answer(
        json!({"status":"delivered","reason":null,"result":{"screen":{"has_visual":false}}}),
    );
    let reply = until_frame(&mut agent, |frame| frame["type"] == "module_reply").await;
    assert_eq!(
        reply,
        json!({"type":"module_reply","id":"m2","status":"delivered","reason":null,
               "result":{"screen":{"has_visual":false}}})
    );
}

/// Sends `raw` as one text frame, as a host agent whose JSON the service
/// cannot read would.
async fn send_raw(agent: &mut HostAgent, raw: String) {
    agent.send(Wire::Text(raw.into())).await.unwrap();
}

/// Values a host agent's JSON can hold and serde_json cannot read, each with
/// the reason the service gives: a lone surrogate (half of an emoji), a
/// number beyond a double, and nesting deeper than serde_json reads.
fn unreadable_values() -> Vec<(String, &'static str)> {
    vec![
        (
            r#""\ud83d""#.to_owned(),
            "a string holds half of a UTF-16 surrogate pair",
        ),
        // A trailing half alone, and a leading half before something else.
        (
            r#""\ude00""#.to_owned(),
            "a string holds half of a UTF-16 surrogate pair",
        ),
        (
            r#""\ud83d\u0041""#.to_owned(),
            "a string holds half of a UTF-16 surrogate pair",
        ),
        (
            "1e400".to_owned(),
            "a number is beyond what a double can hold",
        ),
        (
            format!("{}1{}", "[".repeat(200), "]".repeat(200)),
            "arrays and objects nest deeper than the service reads (127 levels)",
        ),
    ]
}

// The depth the reason names, and the skill module holds a call to, is the
// depth serde_json reads: a frame nested MAX_FRAME_DEPTH deep is read, one
// level more is not. The reason said 128, the level serde_json refuses.
#[test]
fn the_depth_the_service_reads_is_the_depth_it_names() {
    let nested = |depth: usize| format!("{}1{}", "[".repeat(depth), "]".repeat(depth));
    assert!(serde_json::from_str::<Value>(&nested(MAX_FRAME_DEPTH)).is_ok());
    let error = serde_json::from_str::<Value>(&nested(MAX_FRAME_DEPTH + 1)).unwrap_err();
    assert_eq!(
        parse_cause(&error),
        format!("arrays and objects nest deeper than the service reads ({MAX_FRAME_DEPTH} levels)")
    );
}

// A module call the service cannot read is refused at once, by its id, with
// the reason. It used to be dropped, and the agent heard `failed` only when
// the host agent stopped waiting, 30 s later.
#[tokio::test]
async fn hosts_refuse_a_module_call_they_cannot_read_at_once() {
    let served = Served::start(slow()).await;
    let hosts = served.state.0.switchboard.lock().await.hosts();
    let (mut agent, _) = served.hello("scriptorium", TOKEN, json!(1)).await;
    served
        .until_host("scriptorium", |host| host["connected"] == true)
        .await;
    // Session a1 is listened to, so a readable call would reach it.
    let mut frames = hosts.subscribe("scriptorium", "a1");
    for (n, (value, cause)) in unreadable_values().into_iter().enumerate() {
        let id = format!("m{n}");
        send_raw(
            &mut agent,
            format!(
                r#"{{"type":"module_call","id":"{id}","session":"a1","token":"t","call":"display","args":{{"action":{{"op":"say","text":{value}}}}}}}"#
            ),
        )
        .await;
        let reply = until_frame(&mut agent, |frame| frame["type"] == "module_reply").await;
        assert_eq!(
            (reply["id"].as_str(), reply["status"].as_str()),
            (Some(id.as_str()), Some("refused")),
            "{reply}"
        );
        let reason = reply["reason"].as_str().unwrap();
        assert_eq!(reason, format!("this call cannot be read: {cause}"));
    }
    assert!(
        frames.try_recv().is_err(),
        "an unreadable call reaches no session"
    );
}

// A call for a session whose listener has gone is refused as not on a call,
// as when nobody ever listened; it used to come back `failed` with no reason.
#[tokio::test]
async fn hosts_refuse_a_module_call_whose_session_stopped_listening() {
    let served = Served::start(slow()).await;
    let hosts = served.state.0.switchboard.lock().await.hosts();
    let (mut agent, _) = served.hello("scriptorium", TOKEN, json!(1)).await;
    served
        .until_host("scriptorium", |host| host["connected"] == true)
        .await;
    drop(hosts.subscribe("scriptorium", "a1"));
    send(
        &mut agent,
        json!({"type":"module_call","id":"m1","session":"a1","token":"t","call":"speak","args":{"text":"hi"}}),
    )
    .await;
    let reply = until_frame(&mut agent, |frame| frame["type"] == "module_reply").await;
    assert_eq!(
        reply,
        json!({"type":"module_reply","id":"m1","status":"refused","reason":"not_on_call"})
    );
}

// A reply the service cannot read fails its command at once. It used to be
// dropped, so the command waited out its whole deadline.
#[tokio::test]
async fn hosts_fail_a_command_whose_reply_they_cannot_read_at_once() {
    let served = Served::start(slow()).await;
    let hosts = served.state.0.switchboard.lock().await.hosts();
    let (mut agent, _) = served.hello("scriptorium", TOKEN, json!(1)).await;
    served
        .until_host("scriptorium", |host| host["connected"] == true)
        .await;
    for (value, cause) in unreadable_values() {
        let asking = {
            let hosts = hosts.clone();
            tokio::spawn(async move {
                hosts
                    .command(
                        "scriptorium",
                        "list_saved_sessions",
                        json!({"cwd": "/srv/homelab"}),
                        Duration::from_secs(60),
                    )
                    .await
            })
        };
        let command = until_frame(&mut agent, |frame| frame["type"] == "command").await;
        // A first message cut inside a surrogate pair, say.
        send_raw(
            &mut agent,
            format!(
                r#"{{"type":"reply","id":"{}","epoch":1,"ok":true,"result":{{"sessions":[{{"first_message":{value}}}]}}}}"#,
                command["id"].as_str().unwrap()
            ),
        )
        .await;
        let error = timeout(Duration::from_secs(5), asking)
            .await
            .expect("answered at once, not at the command's deadline")
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, "unreadable_reply");
        assert_eq!(
            error.message,
            format!("host scriptorium answered, but the service cannot read the reply: {cause}")
        );
    }
}

// A frame with nothing to answer by is logged with why it was dropped, and
// the link goes on.
#[tokio::test]
async fn hosts_log_an_unreadable_frame_they_cannot_answer_and_go_on() {
    use tracing_subscriber::{layer::SubscriberExt, EnvFilter};
    let hosts = Hosts::new(tokens(), slow());
    let mut link = hosts.connect_fake("scriptorium");
    let mut frames = hosts.subscribe("scriptorium", "a1");
    let bus = crate::debug::DebugBus::new();
    let subscriber = tracing_subscriber::registry()
        .with(EnvFilter::new("switchboard=info"))
        .with(crate::debug::DebugLogLayer::new(bus.clone()));
    tracing::subscriber::with_default(subscriber, || {
        hosts.on_frame(
            "scriptorium",
            link.epoch,
            r#"{"type":"event","session":"a1","cursor":"b:1","event":{"kind":"text","text":"\ud83d"}}"#,
        );
        hosts.on_frame("scriptorium", link.epoch, "not json");
        // A module call without an id: nothing can be answered.
        hosts.on_frame(
            "scriptorium",
            link.epoch,
            r#"{"type":"module_call","session":"a1","call":"speak","args":{"text":"\ud83d"}}"#,
        );
    });
    let logs: Vec<_> = bus
        .snapshot()
        .logs
        .iter()
        .map(|log| {
            (
                log.level.clone(),
                log.fields["frame"].clone(),
                log.fields["session"].clone(),
                log.fields["cause"].clone(),
            )
        })
        .collect();
    let dropped = |frame: &str, session: &str, cause: &str| {
        (
            "WARN".to_owned(),
            json!(frame),
            json!(session),
            json!(cause),
        )
    };
    assert_eq!(
        logs,
        vec![
            dropped(
                "event",
                "a1",
                "a string holds half of a UTF-16 surrogate pair"
            ),
            dropped("unknown", "", "expected ident"),
            dropped(
                "module_call",
                "a1",
                "a string holds half of a UTF-16 surrogate pair"
            ),
        ]
    );
    assert!(bus.snapshot().logs.iter().all(|log| log.message
        == "host sent a frame the service cannot read and nothing in it can be answered; dropped"));
    // The link still carries the session's next frames.
    link.send(
        json!({"type":"event","session":"a1","cursor":"b:2","event":{"kind":"text","text":"ok"}}),
    );
    let Ok(SessionFrame::Event { event, .. }) = frames.try_recv() else {
        panic!("the readable event is delivered");
    };
    assert_eq!(event["text"], "ok");
    assert!(
        timeout(Duration::from_millis(50), link.recv())
            .await
            .is_err(),
        "nothing was answered"
    );
}

#[test]
fn hosts_load_the_tokens_file() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-hosts-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("host-tokens.json");
    std::fs::write(
        &path,
        r#"{"scriptorium":" tok-a\n","forge":"","":"tok-c","lab":7}"#,
    )
    .unwrap();
    let hosts = Hosts::load(&path, slow());
    assert_eq!(
        hosts.0.tokens,
        HashMap::from([("scriptorium".to_owned(), "tok-a".to_owned())])
    );

    std::fs::write(&path, "[]").unwrap();
    assert!(Hosts::load(&path, slow()).0.tokens.is_empty());
    assert!(Hosts::load(&root.join("missing.json"), slow())
        .0
        .tokens
        .is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn hosts_tokens_file_defaults_under_the_config_dir() {
    let config = crate::Config::for_tests(&[]);
    assert_eq!(
        config.host_tokens_file,
        std::path::PathBuf::from("/etc/switchboard/host-tokens.json")
    );
    let config = crate::Config::for_tests(&[("SWITCHBOARD_CONFIG_DIR", "/srv/sb")]);
    assert_eq!(
        config.host_tokens_file,
        std::path::PathBuf::from("/srv/sb/host-tokens.json")
    );
    let config =
        crate::Config::for_tests(&[("SWITCHBOARD_HOST_TOKENS_FILE", "/run/sb/tokens.json")]);
    assert_eq!(
        config.host_tokens_file,
        std::path::PathBuf::from("/run/sb/tokens.json")
    );
}

/// The debug events published so far, oldest first.
fn debug_events(bus: &crate::debug::DebugBus) -> Vec<crate::debug::DebugEvent> {
    bus.events_for_test()
}

#[tokio::test]
async fn hosts_report_link_up_and_down_but_not_a_fenced_close() {
    use crate::debug::DebugEvent;
    let hosts = Hosts::new(tokens(), slow());
    let bus = crate::debug::DebugBus::new();
    hosts.set_debug_bus(bus.clone());
    let hello = || Hello {
        kind: "hello".to_owned(),
        host_id: "scriptorium".to_owned(),
        token: TOKEN.to_owned(),
        protocol: json!(1),
        git_sha: None,
        prime_agent: None,
    };
    let (older, _older_frames) = mpsc::unbounded_channel();
    assert_eq!(hosts.admit(hello(), older), Ok(1));
    let (newer, _newer_frames) = mpsc::unbounded_channel();
    assert_eq!(hosts.admit(hello(), newer), Ok(2));
    // The fenced link closing is not a disconnect: link 2 is up.
    hosts.release("scriptorium", 1, "fenced");
    hosts.release("scriptorium", 2, "disconnected");
    let link = |connected| DebugEvent::HostLink {
        host: "scriptorium".into(),
        connected,
    };
    assert_eq!(
        debug_events(&bus),
        vec![link(true), link(true), link(false)]
    );
}
