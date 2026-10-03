use super::*;
use crate::app_state::AppState;
use crate::app_state::{begin_alpha_candidate, emit, next_event_of, state};
use crate::caller_input::MAX_TYPED_TURN_CHARS;
use crate::delivery::{DeliveryFrame, Event, DELIVERY_QUEUE};
use crate::history::CALLER;
use crate::module_calls::{agent_call_json, diagram_show, post_display_in_task};
use crate::page_controls::cancel_active_operations;
use crate::pbx::OPERATOR;
use crate::protocol::{CandidateEnd, ServerMessage};
use axum::http::StatusCode;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};

#[tokio::test]
async fn typed_turn_is_logged_echoed_and_queued_like_a_transcript() {
    let state = state();
    let mut events = state.0.events.subscribe();
    let connection = state.0.delivery.register();
    let generation = state.0.coordinator.generation();
    let frame = json!({"type":"typed_turn", "id":"typed-1", "generation":generation, "text":"  deploy it  "});
    handle_text_frame(
        &state,
        connection.epoch,
        &mut None,
        &mut None,
        &frame.to_string(),
    )
    .await
    .unwrap();

    let echo = next_event_of(&mut events, "transcript").await;
    assert_eq!(echo["id"], "typed-1");
    assert_eq!(echo["text"], "deploy it");
    let entries = state.0.transcript_log.lock().await.entries();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].text, "deploy it");
    assert_eq!(entries[0].role, CALLER);
    assert_eq!(entries[0].id.as_deref(), Some("typed-1"));
    let mut turns = state.0.turns.take_receiver().await;
    let (id, text, turn_generation) = turns.try_recv().expect("typed turn is queued");
    assert_eq!(
        (id.as_str(), text.as_str(), turn_generation),
        ("typed-1", "deploy it", generation)
    );
}

#[tokio::test]
async fn typed_turn_from_a_retired_epoch_is_dropped() {
    let state = state();
    let mut events = state.0.events.subscribe();
    let connection = state.0.delivery.register();
    let old_generation = state.0.coordinator.generation();
    state.0.coordinator.begin_rescue("test rescue");
    let frame = json!({"type":"typed_turn", "id":"typed-old", "generation":old_generation, "text":"stale words"});
    handle_text_frame(
        &state,
        connection.epoch,
        &mut None,
        &mut None,
        &frame.to_string(),
    )
    .await
    .unwrap();

    let stale = next_event_of(&mut events, "error").await;
    assert_eq!(stale["code"], "stale_epoch");
    assert_eq!(stale["id"], "typed-old");
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
}

#[tokio::test]
async fn malformed_typed_turns_are_refused_on_the_connection() {
    let state = state();
    let mut connection = state.0.delivery.register();
    let epoch = connection.epoch;
    let generation = state.0.coordinator.generation();
    for frame in [
        json!({"type":"typed_turn", "id":"t", "generation":generation, "text":"   "}),
        json!({"type":"typed_turn", "id":"t", "generation":generation, "text":"x".repeat(MAX_TYPED_TURN_CHARS + 1)}),
        json!({"type":"typed_turn", "id":"", "generation":generation, "text":"hi"}),
        json!({"type":"typed_turn", "id":"t", "text":"hi"}),
    ] {
        handle_text_frame(&state, epoch, &mut None, &mut None, &frame.to_string())
            .await
            .unwrap();
        let reply = next_delivery(&mut connection).await;
        assert_eq!(reply["type"], "error", "{frame}");
    }
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
}

#[tokio::test]
async fn display_projection_snapshot_watermark() {
    let state = state();

    // 1. Post two display actions to set up projection state
    for id in ["obj-1", "obj-2"] {
        let (code, _) = agent_call_json(
            &state,
            "/display",
            json!({
                "token": "operator",
                "action": {
                    "op": "show",
                    "id": id,
                    "type": "metric",
                    "role": "primary",
                    "data": {"label": id, "value": "100"}
                }
            }),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
    }

    // 2. Connect a WebSocket client
    let (mut connection, snapshot_actions, watermark) = state.register_connection().await;

    // Snapshot contains obj-1 and obj-2
    assert_eq!(snapshot_actions.len(), 2);
    assert_eq!(snapshot_actions[0]["id"], "obj-1");
    assert_eq!(snapshot_actions[1]["id"], "obj-2");

    // 3. Publish a fresh display action with sequence > watermark. A browser
    // is connected, so /display now waits for a render confirmation; ack it
    // promptly from the connection so this test does not stall.
    let epoch = connection.epoch;
    let handle = post_display_in_task(
        &state,
        json!({
            "token": "operator",
            "action": {
                "op": "show",
                "id": "obj-3",
                "type": "metric",
                "role": "secondary",
                "data": {"label": "obj-3", "value": "300"}
            }
        }),
    )
    .await;

    // In delivery connection receiver:
    // The fresh event obj-3 is queued in connection.receiver with sequence > watermark
    let frame = connection.receiver.recv().await.unwrap();
    let sequence = match frame {
        DeliveryFrame::Event { sequence, event } => {
            assert!(sequence > watermark);
            let Event::Json(val) = event else {
                panic!("expected json event")
            };
            assert_eq!(val["type"], "display");
            assert_eq!(val["action"]["id"], "obj-3");
            sequence
        }
        _ => panic!("expected event frame"),
    };

    handle_text_frame(
        &state,
        epoch,
        &mut None,
        &mut None,
        &json!({"type":"screen_state","view":"auto","has_visual":true,
               "visual_kind":"metric","applied_seq":sequence})
        .to_string(),
    )
    .await
    .unwrap();

    let (code, _) = timeout(Duration::from_secs(2), handle)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(code, StatusCode::OK);
}

#[tokio::test]
async fn display_projection_screen_state_retirement() {
    let state = state();
    let (conn1, _, _) = state.register_connection().await;
    let epoch1 = conn1.epoch;

    let mut pending_header = None;
    let mut pending_chunk = None;

    let current_gen = state.0.coordinator.generation();

    // 1. Connection 1 sends valid screen_state report
    handle_text_frame(
        &state,
        epoch1,
        &mut pending_header,
        &mut pending_chunk,
        &json!({
            "type": "screen_state",
            "view": "visual",
            "pinned": false,
            "has_visual": true,
            "visual_kind": "chart",
            "object_ids": ["chart-1"],
            "title": "CPU Metrics",
            "stale": false,
            "generation": current_gen,
        })
        .to_string(),
    )
    .await
    .unwrap();

    // Verify view tool sees the active report
    let (code, resp) =
        agent_call_json(&state, "/view", json!({"token": "operator", "target": ""})).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(resp["screen"]["view"], "visual");
    assert_eq!(resp["screen"]["visual_kind"], Value::Null);
    assert_eq!(resp["screen"]["stale"], false);

    // 2. Connection 1 is retired (browser disconnects)
    state.retire_connection(epoch1).await;
    let (code, resp) =
        agent_call_json(&state, "/view", json!({"token": "operator", "target": ""})).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        resp["screen"]["connected"], false,
        "retiring the only connection must report the browser as disconnected"
    );
    assert_eq!(
        resp["screen"]["stale"], false,
        "nothing was ever displayed, so an empty stage stays trivially confirmed"
    );

    // 4. Late report from retired connection 1 must be ignored!
    handle_text_frame(
        &state,
        epoch1,
        &mut pending_header,
        &mut pending_chunk,
        &json!({
            "type": "screen_state",
            "view": "theater",
            "pinned": true,
            "has_visual": true,
            "visual_kind": "diagram",
            "object_ids": ["diag-1"],
            "title": "Late Report",
            "stale": false,
            "generation": current_gen,
        })
        .to_string(),
    )
    .await
    .unwrap();

    // Verify late report was ignored
    let (_, resp) =
        agent_call_json(&state, "/view", json!({"token": "operator", "target": ""})).await;
    assert_eq!(
        resp["screen"]["view"], "visual",
        "report from retired epoch must be ignored"
    );
    assert_eq!(resp["screen"]["connected"], false);

    // 5. Connect connection 2 (epoch 2)
    let (conn2, _, _) = state.register_connection().await;
    let epoch2 = conn2.epoch;

    // Report with stale generation must be ignored!
    handle_text_frame(
        &state,
        epoch2,
        &mut pending_header,
        &mut pending_chunk,
        &json!({
            "type": "screen_state",
            "view": "theater",
            "pinned": false,
            "has_visual": true,
            "visual_kind": "chart",
            "object_ids": ["chart-2"],
            "title": "Stale Gen Report",
            "stale": false,
            "generation": 999,
        })
        .to_string(),
    )
    .await
    .unwrap();

    let (_, resp) =
        agent_call_json(&state, "/view", json!({"token": "operator", "target": ""})).await;
    assert_eq!(
        resp["screen"]["view"], "visual",
        "report with stale generation must be ignored"
    );

    // Report with current generation from active connection 2 succeeds
    handle_text_frame(
        &state,
        epoch2,
        &mut pending_header,
        &mut pending_chunk,
        &json!({
            "type": "screen_state",
            "view": "theater",
            "pinned": false,
            "has_visual": true,
            "visual_kind": "chart",
            "object_ids": ["chart-2"],
            "title": "Fresh Report",
            "stale": false,
            "generation": current_gen,
        })
        .to_string(),
    )
    .await
    .unwrap();

    let (_, resp) =
        agent_call_json(&state, "/view", json!({"token": "operator", "target": ""})).await;
    assert_eq!(resp["screen"]["view"], "theater");
    // Title is projection-derived, not echoed from the browser's report: no
    // display action was posted, so there is nothing to title.
    assert_eq!(resp["screen"]["title"], "");
    assert_eq!(resp["screen"]["stale"], false);
}

#[tokio::test]
async fn a_connection_gets_epoch_status_history_and_scene_before_any_live_event() {
    let state = state();
    // Something in every part of the snapshot: an epoch that has moved, a
    // transcript, and an object on stage.
    state.0.coordinator.begin_rescue("an earlier rescue");
    state.0.coordinator.settle();
    let generation = state.0.coordinator.generation();
    state
        .0
        .transcript_log
        .lock()
        .await
        .add_with_id(CALLER, "put me through", OPERATOR, None);
    let mut show = diagram_show();
    show["token"] = json!(state.0.coordinator.current_identity().token);
    let (code, _) = agent_call_json(&state, "/display", show).await;
    assert_eq!(code, StatusCode::OK);
    let watermark = state.0.display_gate.lock().await.watermark;

    // Hold the transcript so the connection is registered but cannot finish
    // reading its snapshot, and publish a live event in that window.
    let served = Served::start(&state).await;
    let transcript = state.0.transcript_log.lock().await;
    let mut browser = served.connect().await;
    wait_until(|| state.0.delivery.connected()).await;
    assert!(emit(&state, Event::Json(json!({"type":"probe"}))));
    drop(transcript);

    let frames = json_until(&mut browser, "probe").await;
    assert_eq!(
        types_of(&frames),
        ["epoch", "status", "history", "display", "probe"]
    );
    assert_eq!(frames[0]["generation"], generation);
    assert_eq!(frames[1]["route"], OPERATOR);
    assert_eq!(frames[2]["entries"][0]["text"], "put me through");
    assert_eq!(frames[3]["action"]["id"], "d1");
    assert_eq!(
        frames[3]["seq"], watermark,
        "a replayed display carries the watermark, so the live stream's older displays are skipped"
    );
}

#[tokio::test]
async fn the_socket_answers_both_kinds_of_ping() {
    let state = state();
    let served = Served::start(&state).await;
    let mut browser = served.connect().await;
    json_until(&mut browser, "history").await;

    // The browser's heartbeat is a JSON frame, echoed with its fields.
    send_json_frame(
        &mut browser,
        json!({"type":"ping", "nonce":"beat-1", "time":1_700_000_000_000_u64}),
    )
    .await;
    assert_eq!(
        next_json(&mut browser).await,
        json!({"type":"pong", "nonce":"beat-1", "time":1_700_000_000_000_u64})
    );

    // A protocol ping, as a proxy might send. The WebSocket library queues
    // its own pong and the handler sends one too, so one or two arrive
    // depending on whether the second replaces the first before it is
    // flushed; what matters is that it is answered with the same payload.
    browser
        .send(Wire::Ping(b"are you there".to_vec().into()))
        .await
        .unwrap();
    send_json_frame(&mut browser, json!({"type":"ping", "nonce":"after"})).await;
    let mut pongs = Vec::new();
    loop {
        match next_wire(&mut browser).await {
            Wire::Pong(payload) => pongs.push(payload.to_vec()),
            Wire::Text(text) => {
                let frame: Value = serde_json::from_str(text.as_str()).unwrap();
                assert_eq!(frame["nonce"], "after", "{frame}");
                break;
            }
            other => panic!("unexpected frame {other:?}"),
        }
    }
    assert!(!pongs.is_empty(), "the protocol ping went unanswered");
    assert!(
        pongs.iter().all(|pong| pong == b"are you there"),
        "{pongs:?}"
    );
}

#[tokio::test]
async fn frames_the_socket_cannot_act_on_are_refused_without_hanging_up() {
    let state = state();
    let served = Served::start(&state).await;
    let mut browser = served.connect().await;
    json_until(&mut browser, "history").await;
    let error = |message: &str| json!({"type":"error", "message":message});

    browser.send(Wire::text("not json")).await.unwrap();
    assert_eq!(next_json(&mut browser).await, error("Invalid JSON frame."));
    browser.send(Wire::text("[1, 2]")).await.unwrap();
    assert_eq!(
        next_json(&mut browser).await,
        error("Invalid command shape.")
    );
    send_json_frame(&mut browser, json!({"type":"dance"})).await;
    assert_eq!(
        next_json(&mut browser).await,
        error("Unknown websocket command.")
    );
    send_json_frame(&mut browser, json!({"id":"no-type"})).await;
    assert_eq!(
        next_json(&mut browser).await,
        error("Unknown websocket command.")
    );
    browser.send(Wire::text("null")).await.unwrap();
    assert_eq!(
        next_json(&mut browser).await,
        error("Invalid command shape.")
    );
    // A type is a name: not a number standing for one, and not a name in
    // another case.
    for frame in [json!({"type":7}), json!({"type":"Ping", "nonce":"n"})] {
        send_json_frame(&mut browser, frame).await;
        assert_eq!(
            next_json(&mut browser).await,
            error("Unknown websocket command.")
        );
    }
    assert_still_answering(&mut browser, "after-bad-commands").await;

    // Audio is only taken after the header that names it. A header that is
    // refused names nothing, so the audio after it is refused as well.
    browser.send(Wire::binary(vec![1, 2, 3])).await.unwrap();
    let headerless = error("Audio arrived without a clip header.");
    assert_eq!(next_json(&mut browser).await, headerless);
    send_json_frame(&mut browser, json!({"type":"clip", "id":""})).await;
    assert_eq!(next_json(&mut browser).await, error("Invalid clip id."));
    browser.send(Wire::binary(vec![1, 2, 3])).await.unwrap();
    assert_eq!(next_json(&mut browser).await, headerless);
    assert_still_answering(&mut browser, "after-bad-audio").await;
    assert!(state.0.clips.accepted_is_empty().await);
}

/// A command of a known type is read field by field: a field that is missing
/// or of the wrong kind is taken as absent, a field no command declares is
/// ignored, and a key given twice keeps its last value. None of these refuses
/// the frame as a whole; each command decides what an absent field means.
#[tokio::test]
async fn a_known_command_reads_each_field_it_can_and_ignores_the_rest() {
    let state = state();
    let served = Served::start(&state).await;
    let mut browser = served.connect().await;
    json_until(&mut browser, "history").await;
    let hello_ack = |mse: bool| {
        json!({
            "type":"hello_ack", "version":1, "stt_streaming":false, "mse_mp3":mse,
        })
    };
    let both = json!({"stt_streaming":true, "mse_mp3":true});

    send_json_frame(
        &mut browser,
        json!({"type":"hello", "version":1, "capabilities":both, "extra":[1]}),
    )
    .await;
    assert_eq!(next_json(&mut browser).await, hello_ack(true));
    // A version or capability of the wrong kind is no version or capability.
    send_json_frame(
        &mut browser,
        json!({"type":"hello", "version":"1", "capabilities":both}),
    )
    .await;
    assert_eq!(next_json(&mut browser).await, hello_ack(false));
    send_json_frame(
        &mut browser,
        json!({"type":"hello", "version":1, "capabilities":{"stt_streaming":true, "mse_mp3":1}}),
    )
    .await;
    assert_eq!(next_json(&mut browser).await, hello_ack(false));
    send_json_frame(
        &mut browser,
        json!({"type":"hello", "version":1, "capabilities":[true, true, true]}),
    )
    .await;
    assert_eq!(next_json(&mut browser).await, hello_ack(false));

    // The last of a repeated key wins, the type included.
    browser
        .send(Wire::text(
            r#"{"type":"dance","type":"ping","nonce":"first","nonce":"last","time":5}"#,
        ))
        .await
        .unwrap();
    assert_eq!(
        next_json(&mut browser).await,
        json!({"type":"pong", "nonce":"last", "time":5})
    );

    // Each command answers an unusable field its own way.
    send_json_frame(
        &mut browser,
        json!({"type":"typed_turn", "id":"t1", "generation":"0", "text":"hi"}),
    )
    .await;
    assert_eq!(
        next_json(&mut browser).await,
        json!({"type":"error", "id":"t1", "message":"That message could not be sent."})
    );
    send_json_frame(&mut browser, json!({"type":"screen_state", "view":7})).await;
    assert_eq!(
        next_json(&mut browser).await,
        json!({"type":"error", "message":"Invalid screen view."})
    );
    send_json_frame(&mut browser, json!({"type":"stt_chunk", "clip_id":7})).await;
    assert_eq!(
        next_json(&mut browser).await,
        json!({"type":"error", "message":"Invalid streaming clip id."})
    );
    // Ending or cancelling a stream that names no clip is not answered.
    send_json_frame(&mut browser, json!({"type":"stt_end"})).await;
    send_json_frame(&mut browser, json!({"type":"stt_cancel", "clip_id":7})).await;
    assert_still_answering(&mut browser, "after-nameless-stream-commands").await;
}

/// `hello` is answered capability by capability. Speech is streamed only as
/// MSE mp3, so it streams to a page that says it can play that and goes whole
/// to one that cannot; `mse_mp3` is the one flag for it (#132 item 3 retired
/// `audio_streaming`, which every page sent equal to it and never read back).
#[tokio::test]
async fn hello_streams_speech_only_to_a_page_that_plays_mse_mp3() {
    let state = state();
    let served = Served::start(&state).await;
    let mut browser = served.connect().await;
    json_until(&mut browser, "history").await;

    for (mse_mp3, offered) in [(true, true), (false, false)] {
        send_json_frame(
            &mut browser,
            json!({
                "type":"hello", "version":1,
                "capabilities":{"stt_streaming":false, "mse_mp3":mse_mp3},
            }),
        )
        .await;
        let ack = next_json(&mut browser).await;
        assert_eq!(
            ack["mse_mp3"].as_bool(),
            Some(offered),
            "asked for mse_mp3 {mse_mp3}: {ack}"
        );
        assert!(
            ack.get("audio_streaming").is_none(),
            "the retired flag is not sent: {ack}"
        );
    }
}

#[tokio::test]
async fn a_clip_is_its_header_and_the_audio_frame_after_it() {
    let state = state();
    let served = Served::start(&state).await;
    let mut browser = served.connect().await;
    json_until(&mut browser, "history").await;
    let generation = state.0.coordinator.generation();
    let header =
        json!({"type":"clip", "id":"clip-1", "mime":"audio/webm", "generation":generation});

    send_json_frame(&mut browser, header.clone()).await;
    browser.send(Wire::binary(vec![4, 5, 6])).await.unwrap();
    assert_eq!(
        next_json(&mut browser).await,
        json!({"type":"accepted", "id":"clip-1"})
    );
    let mut clips = state.0.clips.take_receiver().await;
    let clip = clips.try_recv().expect("the clip reached the clip worker");
    assert_eq!(
        (clip.id.as_str(), clip.audio.as_slice(), clip.generation),
        ("clip-1", &[4_u8, 5, 6][..], generation)
    );

    // The header is used up by the frame it named.
    browser.send(Wire::binary(vec![7])).await.unwrap();
    assert_eq!(
        next_json(&mut browser).await,
        json!({"type":"error", "message":"Audio arrived without a clip header."})
    );

    // A reconnecting browser resends what it has not seen acknowledged; the
    // same id is acknowledged again but not transcribed twice.
    send_json_frame(&mut browser, header).await;
    browser.send(Wire::binary(vec![4, 5, 6])).await.unwrap();
    assert_eq!(
        next_json(&mut browser).await,
        json!({"type":"accepted", "id":"clip-1"})
    );
    assert!(matches!(
        clips.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn a_connection_that_falls_a_queue_behind_is_dropped_and_a_reconnect_is_whole_again() {
    // Each connection has a bounded queue. A browser that stops draining it
    // is retired rather than waited on, so it cannot stall the call; it
    // loses the events past the bound and recovers them by reconnecting,
    // which delivers a fresh snapshot.
    let state = state();
    state
        .0
        .transcript_log
        .lock()
        .await
        .add_with_id(CALLER, "still here", OPERATOR, None);
    let served = Served::start(&state).await;

    // Holding the transcript keeps the connection's writer on its snapshot,
    // so nothing leaves its queue.
    let transcript = state.0.transcript_log.lock().await;
    let mut lagging = served.connect().await;
    wait_until(|| state.0.delivery.connected()).await;
    for n in 0..DELIVERY_QUEUE {
        assert!(
            emit(&state, Event::Json(json!({"type":"probe", "n":n}))),
            "{n}"
        );
    }
    assert!(
        !emit(
            &state,
            Event::Json(json!({"type":"probe", "n":DELIVERY_QUEUE}))
        ),
        "one past the bound is not delivered"
    );
    assert!(
        !state.0.delivery.connected(),
        "the lagging socket is retired"
    );
    drop(transcript);

    // It still gets its snapshot and what it had queued, then the socket
    // closes.
    let frames = json_until(&mut lagging, "history").await;
    assert_eq!(types_of(&frames), ["epoch", "status", "history"]);
    for n in 0..DELIVERY_QUEUE {
        assert_eq!(next_json(&mut lagging).await["n"], n);
    }
    let end = timeout(Duration::from_secs(5), lagging.next())
        .await
        .expect("the retired socket closes");
    assert!(
        matches!(end, None | Some(Err(_)) | Some(Ok(Wire::Close(_)))),
        "{end:?}"
    );

    let mut browser = served.connect().await;
    let frames = json_until(&mut browser, "history").await;
    assert_eq!(types_of(&frames), ["epoch", "status", "history"]);
    assert_eq!(frames[2]["entries"][0]["text"], "still here");
    assert!(emit(
        &state,
        Event::Json(json!({"type":"probe", "n":"live"}))
    ));
    assert_eq!(next_json(&mut browser).await["n"], "live");
}

// Issue #70, for a tab that was away: it misses the live clear notice, so the
// snapshot has to say whether the epoch it announces is an adoption's.
#[tokio::test]
async fn a_snapshot_names_the_adoption_only_while_the_adopted_leg_is_on_the_line() {
    let state = state();
    assert_eq!(
        snapshot_types(&snapshot_messages(&state).await),
        ["epoch", "status", "history"]
    );

    begin_alpha_candidate(&state, "alpha-leg");
    assert!(state.0.leg_announcer.promote_candidate("alpha-leg").await);
    let generation = state.0.coordinator.generation();
    let snapshot = snapshot_messages(&state).await;
    assert_eq!(
        snapshot_types(&snapshot),
        ["candidate_cleared", "epoch", "status", "history"]
    );
    assert_eq!(
        snapshot[0],
        ServerMessage::CandidateCleared {
            route: "alpha".into(),
            generation,
            reason: CandidateEnd::Adopted,
        }
    );
    assert_eq!(snapshot[1], ServerMessage::Epoch { generation });

    // The caller hangs up: the epoch moves, and it is not an adoption's.
    cancel_active_operations(&state).await;
    assert_eq!(
        snapshot_types(&snapshot_messages(&state).await),
        ["epoch", "status", "history"]
    );
}

type Browser =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

type Wire = tokio_tungstenite::tungstenite::Message;

/// The router listening on 127.0.0.1; stops accepting when dropped.
struct Served {
    address: std::net::SocketAddr,
    server: tokio::task::JoinHandle<()>,
}

impl Served {
    async fn start(state: &AppState) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = state.clone().router(None);
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self { address, server }
    }

    async fn connect(&self) -> Browser {
        let (browser, _) = tokio_tungstenite::connect_async(format!("ws://{}/ws", self.address))
            .await
            .unwrap();
        browser
    }
}

impl Drop for Served {
    fn drop(&mut self) {
        self.server.abort();
    }
}

/// The next frame the browser reads, failing the test if none arrives.
async fn next_wire(browser: &mut Browser) -> Wire {
    timeout(Duration::from_secs(5), browser.next())
        .await
        .expect("a frame before the deadline")
        .expect("an open socket")
        .expect("a readable frame")
}

async fn next_json(browser: &mut Browser) -> Value {
    match next_wire(browser).await {
        Wire::Text(text) => serde_json::from_str(text.as_str()).unwrap(),
        other => panic!("expected a text frame, got {other:?}"),
    }
}

/// Frames up to and including the first of type `until`.
async fn json_until(browser: &mut Browser, until: &str) -> Vec<Value> {
    let mut frames = Vec::new();
    loop {
        let frame = next_json(browser).await;
        let done = frame["type"] == until;
        frames.push(frame);
        if done {
            return frames;
        }
    }
}

async fn send_json_frame(browser: &mut Browser, value: Value) {
    browser.send(Wire::text(value.to_string())).await.unwrap();
}

/// Sends a heartbeat and expects its answer, which is how these tests show
/// the connection is still up after something it refused.
async fn assert_still_answering(browser: &mut Browser, nonce: &str) {
    send_json_frame(browser, json!({"type":"ping", "nonce":nonce})).await;
    assert_eq!(
        next_json(browser).await,
        json!({"type":"pong", "nonce":nonce, "time":null})
    );
}

/// Waits for `condition`, failing the test if it never holds.
async fn wait_until(condition: impl Fn() -> bool) {
    timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("the condition never held");
}

fn snapshot_types(messages: &[ServerMessage]) -> Vec<String> {
    messages
        .iter()
        .map(|message| message.to_value()["type"].as_str().unwrap().to_owned())
        .collect()
}
