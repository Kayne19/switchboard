//! The caller page's WebSocket (`/ws`): registering and retiring a
//! connection, the snapshot it starts with, the frames it reads (the
//! command multiplexer and the screen state it reports), and the frames it
//! writes.
use crate::app_state::AppState;
use crate::caller_input::{
    cancel_stream_clip, end_stream_clip, handle_audio_frame, is_clip_id, parse_clip_header,
    parse_typed_turn, route_final_transcript, start_stream_clip, ClipHeader, StreamChunkHeader,
};
use crate::delivery::{DeliveryConnection, DeliveryFrame, Event};
use crate::display::{is_display_event, stamp_display_seq};
use crate::page_controls::current_status;
use crate::protocol::{CandidateEnd, ServerMessage};
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
#[cfg(test)]
use tokio::time::{timeout, Duration};
use tracing::Instrument;

impl AppState {
    pub async fn register_connection(&self) -> (DeliveryConnection, Vec<Value>, u64) {
        let mut gate = self.0.display_gate.lock().await;
        let connection = self.0.delivery.register();
        let epoch = connection.epoch;
        gate.active_epoch = Some(epoch);
        gate.screen_state["stale"] = json!(true);
        self.0.floor.set_page_connected(true).await;
        self.start_debug_call();
        let snapshot_actions = gate.projection.snapshot_actions();
        let watermark = gate.watermark;
        (connection, snapshot_actions, watermark)
    }

    pub async fn retire_connection(&self, epoch: u64) {
        {
            let mut gate = self.0.display_gate.lock().await;
            if gate.active_epoch == Some(epoch) || gate.active_epoch.is_none() {
                gate.active_epoch = None;
                gate.screen_state["stale"] = json!(true);
            }
        }
        self.0.delivery.retire(epoch);
        let connected = self.0.delivery.connected();
        self.0.floor.set_page_connected(connected).await;
        if !connected {
            self.end_debug_call("page_closed");
        }
    }
}

pub(crate) const MAX_WEBSOCKET_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

pub(crate) async fn ws(
    State(state): State<AppState>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    upgrade
        .max_message_size(MAX_WEBSOCKET_MESSAGE_BYTES)
        .max_frame_size(MAX_WEBSOCKET_MESSAGE_BYTES)
        .on_upgrade(move |socket| websocket(socket, state))
}
async fn websocket(socket: WebSocket, state: AppState) {
    let (connection, snapshot_actions, watermark) = state.register_connection().await;
    // Two tabs are two connections. Everything one does, and the work it
    // starts, logs under its id and the generation it joined at.
    let span = tracing::info_span!(
        "ws",
        connection = connection.epoch,
        joined_generation = state.0.coordinator.generation()
    );
    serve_connection(socket, state, connection, snapshot_actions, watermark)
        .instrument(span)
        .await;
}

async fn serve_connection(
    socket: WebSocket,
    state: AppState,
    connection: DeliveryConnection,
    snapshot_actions: Vec<Value>,
    watermark: u64,
) {
    let epoch = connection.epoch;
    let connected_at = std::time::Instant::now();
    tracing::info!("browser connected");
    let (mut sink, mut incoming) = socket.split();
    let mut frames = connection.receiver;
    let mut dropped = connection.dropped;
    let writer_state = state.clone();
    let deliver = async move {
        send_snapshot_sink(&mut sink, &writer_state, &snapshot_actions, watermark).await?;
        while let Some(frame) = frames.recv().await {
            match frame {
                DeliveryFrame::Event { sequence, event } => {
                    if sequence <= watermark && is_display_event(&event) {
                        tracing::trace!(
                            sequence,
                            epoch,
                            "discarding replayed display event <= watermark"
                        );
                        continue;
                    }
                    tracing::trace!(sequence, epoch, "delivering sequenced event");
                    send_event_sink(&mut sink, stamp_display_seq(event, sequence)).await?
                }
                DeliveryFrame::Message(message) => sink.send(message).await?,
            }
        }
        Ok::<(), axum::Error>(())
    };
    let mut writer = Box::pin(tokio::spawn(deliver.in_current_span()));
    let writer_id = writer.id();
    let mut shutdown = state.0.shutdown.subscribe();
    let mut pending_header: Option<ClipHeader> = None;
    let mut pending_stream_chunk: Option<StreamChunkHeader> = None;
    loop {
        tokio::select! {
            result = &mut writer => {
                if let Ok(Err(error)) = result { tracing::warn!(%error, "could not deliver an event to the browser"); }
                break;
            }
            _ = &mut dropped => {
                tracing::info!("delivery dropped the connection; closing its socket");
                break;
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() { break; }
            }
            received = incoming.next() => match received {
                Some(Ok(Message::Text(text))) => {
                    if handle_text_frame(&state, epoch, &mut pending_header, &mut pending_stream_chunk, text.as_ref()).await.is_err() { break; }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    if handle_audio_frame(&state, epoch, &mut pending_header, &mut pending_stream_chunk, bytes.to_vec()).await.is_err() { break; }
                }
                Some(Ok(Message::Ping(bytes))) => {
                    if !state.0.delivery.send(epoch, Message::Pong(bytes)) { break; }
                }
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Close(frame))) => {
                    tracing::info!(code = ?frame.as_ref().map(|frame| frame.code), "browser disconnected");
                    break;
                }
                Some(Err(error)) => { tracing::warn!(%error, "the websocket reader failed"); break; }
                None => break,
            },
        }
    }
    state.retire_connection(epoch).await;
    // The writer owns the only sink. Retiring first prevents new events from
    // being accepted while its final send is being canceled.
    writer.abort();
    tracing::info!(
        ?writer_id,
        connected_for = ?connected_at.elapsed(),
        "browser connection retired"
    );
}

/// What a connection is told before any live event: the epoch, the line's
/// status, and the conversation. The epoch is preceded by an `adopted`
/// candidate notice when the leg on the line was adopted at it, which a tab
/// that was away for the adoption needs in order to carry speech recorded
/// while that leg was connecting (#70). Without it, the tab cannot tell an
/// adoption from the hangup that moves the epoch the same way.
async fn snapshot_messages(state: &AppState) -> Vec<ServerMessage> {
    let mut messages = Vec::with_capacity(5);
    let (generation, adopted_route) = state.0.coordinator.generation_and_adoption();
    if let Some(route) = adopted_route {
        messages.push(ServerMessage::CandidateCleared {
            route,
            generation,
            reason: CandidateEnd::Adopted,
        });
    }
    messages.push(ServerMessage::Epoch { generation });
    messages.push(ServerMessage::Status(current_status(state)));
    messages.push(ServerMessage::History {
        entries: state.0.transcript_log.lock().await.entries(),
    });
    let agents = state.0.projection.snapshot();
    if !agents.is_empty() {
        messages.push(ServerMessage::AgentsState { agents });
    }
    messages
}

async fn send_snapshot_sink(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    state: &AppState,
    snapshot_actions: &[Value],
    watermark: u64,
) -> Result<(), axum::Error> {
    for message in snapshot_messages(state).await {
        send_event_sink(sink, Event::Json(message.to_value())).await?;
    }
    for action in snapshot_actions {
        let replay = ServerMessage::Display {
            action: action.clone(),
            seq: Some(watermark),
        };
        send_event_sink(sink, Event::Json(replay.to_value())).await?;
    }
    Ok(())
}

/// `screen_state`: the browser's report of what it is showing. Updates the
/// view the agent's `view` tool reads and confirms or rejects the display
/// actions the browser has applied.
async fn apply_screen_state(
    state: &AppState,
    epoch: u64,
    command: crate::protocol::ScreenState,
) -> Result<(), ()> {
    let Some(view) = command.view.filter(|view| {
        matches!(
            view.as_str(),
            "auto" | "system" | "visual" | "comms" | "theater"
        )
    }) else {
        return send_message(state, epoch, ServerMessage::error("Invalid screen view.")).await;
    };
    let title = command
        .title
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect::<String>();
    let visual_kind = command
        .visual_kind
        .filter(|kind| crate::visual_protocol::CONTENT_TYPES.contains(&kind.as_str()))
        .map_or(Value::Null, Value::String);
    let object_ids = command.object_ids.unwrap_or_default();
    let pinned = command.pinned.unwrap_or(false);
    let has_visual = command.has_visual.unwrap_or(false);
    let stale = command.stale.unwrap_or(false);
    let report_gen = command
        .generation
        .unwrap_or_else(|| state.0.coordinator.generation());

    let current_gen = state.0.coordinator.generation();
    let active_ep = state.0.delivery.active_epoch();
    if active_ep != Some(epoch) || report_gen != current_gen {
        return Ok(());
    }
    let mut gate = state.0.display_gate.lock().await;

    let report = json!({
        "view": view,
        "pinned": pinned,
        "has_visual": has_visual,
        "visual_kind": visual_kind,
        "object_ids": object_ids,
        "title": title,
        "stale": stale,
        "generation": current_gen,
    });
    gate.screen_state = report;
    gate.report_epoch = Some(epoch);
    gate.report_generation = Some(current_gen);
    drop(gate);

    let applied_seq = command.applied_seq;
    let rejected = command.rejected.map(|rejection| {
        let reason = rejection
            .reason
            .unwrap_or_else(|| "the caller's screen could not render it".to_string());
        (rejection.seq, reason)
    });
    state.0.display_confirm.send_modify(|c| {
        if c.generation != current_gen {
            c.generation = current_gen;
            c.watermark = None;
        }
        if let Some(seq) = applied_seq {
            if c.watermark.is_none_or(|w| seq > w) {
                c.watermark = Some(seq);
            }
        }
        c.rejection = rejected.clone();
    });

    send_message(state, epoch, ServerMessage::ScreenStateAck).await
}

pub(crate) async fn handle_text_frame(
    state: &AppState,
    epoch: u64,
    pending_header: &mut Option<ClipHeader>,
    pending_stream_chunk: &mut Option<StreamChunkHeader>,
    text: &str,
) -> Result<(), ()> {
    use crate::protocol::{ClientMessage, UnreadableFrame};
    let command = match ClientMessage::parse(text) {
        Ok(command) => command,
        Err(unreadable) => {
            let message = match unreadable {
                UnreadableFrame::NotJson => "Invalid JSON frame.",
                UnreadableFrame::NotAnObject => "Invalid command shape.",
                UnreadableFrame::UnknownType => "Unknown websocket command.",
            };
            return send_message(state, epoch, ServerMessage::error(message)).await;
        }
    };

    match command {
        ClientMessage::Hello {
            version,
            capabilities,
        } => {
            let version = version.unwrap_or(0);
            let stream_requested = capabilities
                .as_ref()
                .and_then(|caps| caps.stt_streaming)
                .unwrap_or(false);
            let mse_requested = capabilities
                .as_ref()
                .and_then(|caps| caps.mse_mp3)
                .unwrap_or(false);
            send_message(
                state,
                epoch,
                ServerMessage::HelloAck {
                    version: 1,
                    stt_streaming: version == 1
                        && stream_requested
                        && state.0.stt_stream.configured(),
                    // Speech is streamed only as MSE mp3, so it streams to a
                    // page that can play that and goes whole to one that cannot.
                    mse_mp3: version == 1 && mse_requested,
                },
            )
            .await
        }
        ClientMessage::SttStart {
            clip_id,
            generation,
            mime,
        } => {
            pending_header.take();
            start_stream_clip(state, epoch, clip_id, generation, mime).await
        }
        ClientMessage::SttChunk {
            clip_id,
            generation,
            sequence,
        } => {
            let Some(id) = clip_id.filter(|id| is_clip_id(id)) else {
                return send_message(
                    state,
                    epoch,
                    ServerMessage::error("Invalid streaming clip id."),
                )
                .await;
            };
            // A chunk header without a generation is refused like one without
            // a usable id; the audio frame that follows it then arrives
            // without a header and is answered as such.
            let Some(generation) = generation else {
                return send_message(
                    state,
                    epoch,
                    ServerMessage::error_for(id, "Streaming chunk has no generation."),
                )
                .await;
            };
            let sequence = sequence.unwrap_or(u64::MAX);
            *pending_stream_chunk = Some((id, generation, sequence));
            Ok(())
        }
        ClientMessage::SttEnd {
            clip_id,
            generation,
        } => end_stream_clip(state, epoch, clip_id, generation).await,
        ClientMessage::SttCancel {
            clip_id,
            generation,
        } => cancel_stream_clip(state, clip_id, generation).await,
        ClientMessage::ScreenState(report) => apply_screen_state(state, epoch, report).await,
        ClientMessage::Ping { nonce, time } => {
            send_message(state, epoch, ServerMessage::Pong { nonce, time }).await
        }
        ClientMessage::TypedTurn {
            id,
            generation,
            text,
        } => {
            let Some((turn, generation, text)) =
                parse_typed_turn(id.as_deref(), generation, text.as_deref())
            else {
                return send_message(
                    state,
                    epoch,
                    ServerMessage::Error {
                        id,
                        code: None,
                        message: "That message could not be sent.".into(),
                    },
                )
                .await;
            };
            tracing::info!(turn = %turn, generation, chars = text.chars().count(), "typed turn");
            // A typed turn is a transcript that needs no transcription, so it
            // takes the same path as a streamed one: epoch check, log, echo,
            // then steer or queue. It runs off this reader because that path
            // waits on `operation_transition`, which a transfer can hold for
            // seconds, and the reader must keep answering pings meanwhile.
            let state = state.clone();
            tokio::spawn(
                async move { route_final_transcript(&state, &turn, generation, text).await }
                    .in_current_span(),
            );
            Ok(())
        }
        ClientMessage::Clip {
            id,
            mime,
            generation,
        } => {
            let Some(header) = parse_clip_header(id, mime, generation) else {
                pending_header.take();
                return send_message(state, epoch, ServerMessage::error("Invalid clip id.")).await;
            };
            *pending_header = Some(header);
            Ok(())
        }
    }
}

pub(crate) async fn send_message(
    state: &AppState,
    epoch: u64,
    message: ServerMessage,
) -> Result<(), ()> {
    state
        .0
        .delivery
        .send(epoch, Message::Text(message.to_value().to_string().into()))
        .then_some(())
        .ok_or(())
}
async fn send_event_sink(
    socket: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    event: Event,
) -> Result<(), axum::Error> {
    match event {
        Event::Json(value) => socket.send(Message::Text(value.to_string().into())).await,
        Event::AudioStart {
            generation,
            sequence,
            mime,
            format,
        } => {
            let message = ServerMessage::AudioStart {
                generation,
                sequence,
                mime,
                format,
            };
            socket
                .send(Message::Text(message.to_value().to_string().into()))
                .await
        }
        Event::AudioChunk { audio } => socket.send(Message::Binary(audio.into())).await,
        Event::AudioDone {
            generation,
            sequence,
        } => {
            let message = ServerMessage::AudioDone {
                generation,
                sequence,
                done: true,
            };
            socket
                .send(Message::Text(message.to_value().to_string().into()))
                .await
        }
    }
}

/// A delivery frame as the browser would read it; display frames carry the
/// sequence the socket writer stamps on them.
#[cfg(test)]
pub(crate) fn frame_json(frame: DeliveryFrame) -> Option<Value> {
    match frame {
        DeliveryFrame::Event { sequence, event } => match stamp_display_seq(event, sequence) {
            Event::Json(value) => Some(value),
            _ => None,
        },
        DeliveryFrame::Message(Message::Text(text)) => Some(serde_json::from_str(&text).unwrap()),
        DeliveryFrame::Message(_) => None,
    }
}

/// Receives frames up to and including the first of type `until`.
#[cfg(test)]
pub(crate) async fn frames_until(connection: &mut DeliveryConnection, until: &str) -> Vec<Value> {
    let mut frames = Vec::new();
    loop {
        let frame = timeout(Duration::from_secs(2), connection.receiver.recv())
            .await
            .expect("a frame before the deadline")
            .expect("an open connection");
        let Some(value) = frame_json(frame) else {
            continue;
        };
        let done = value["type"] == until;
        frames.push(value);
        if done {
            return frames;
        }
    }
}

/// Every frame already waiting on the connection.
#[cfg(test)]
pub(crate) fn queued_frames(connection: &mut DeliveryConnection) -> Vec<Value> {
    std::iter::from_fn(|| connection.receiver.try_recv().ok())
        .filter_map(frame_json)
        .collect()
}

#[cfg(test)]
pub(crate) fn types_of(frames: &[Value]) -> Vec<&str> {
    frames
        .iter()
        .filter_map(|frame| frame["type"].as_str())
        .collect()
}

#[cfg(test)]
pub(crate) async fn next_delivery(connection: &mut DeliveryConnection) -> Value {
    let Some(DeliveryFrame::Message(Message::Text(text))) = connection.receiver.recv().await else {
        panic!("expected a websocket response");
    };
    serde_json::from_str(&text).unwrap()
}

#[cfg(test)]
#[path = "../tests/test_browser.rs"]
mod tests;
