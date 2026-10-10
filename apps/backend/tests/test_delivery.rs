use super::*;
use crate::within;
use serde_json::json;

#[tokio::test]
async fn delivery_registration_captures_live_events_for_snapshot_barrier() {
    let delivery = DeliveryState::new();
    let mut connection = delivery.register();
    delivery.publish(Event::Json(json!({"type":"status"})));
    let Some(DeliveryFrame::Event {
        sequence,
        event: Event::Json(value),
    }) = within("connection.receiver", connection.receiver.recv()).await
    else {
        panic!("registered connection should receive live event");
    };
    assert_eq!(sequence, 0);
    assert_eq!(value["type"], "status");
    delivery.retire(connection.epoch);
    assert!(!delivery.connected());
}

#[tokio::test]
async fn a_connection_a_full_queue_behind_is_dropped_and_told_so() {
    let delivery = DeliveryState::new();
    let mut lagging = delivery.register();
    let mut keeping_up = delivery.register();
    for n in 0..DELIVERY_QUEUE {
        assert!(delivery.publish(Event::Json(json!({"n": n}))));
        assert!(keeping_up.receiver.try_recv().is_ok());
    }
    assert!(lagging.dropped.try_recv().is_err());
    assert!(delivery.publish(Event::Json(json!({"n": DELIVERY_QUEUE}))));
    assert!(keeping_up.receiver.try_recv().is_ok());
    assert!(
        matches!(
            lagging.dropped.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ),
        "the lagging connection is told it was dropped"
    );
    assert!(matches!(
        keeping_up.dropped.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    delivery.retire(keeping_up.epoch);
    assert!(!delivery.connected());
}

#[test]
fn audio_queue_emits_reserved_sequences_in_order_and_drops_on_clear() {
    let mut queue = AudioQueue::new();
    let first = queue.reserve(3);
    let second = queue.reserve(3);
    assert!(queue.start(second, 3).is_empty());
    assert!(queue.append(second, 3, vec![2]).is_empty());
    assert!(queue.finish(second, 3).is_empty());
    assert!(matches!(
        queue.start(first, 3).as_slice(),
        [Event::AudioStart { sequence: 0, .. }]
    ));
    assert!(matches!(
        queue.append(first, 3, vec![1]).as_slice(),
        [Event::AudioChunk { audio }] if audio == &[1]
    ));
    let events = queue.finish(first, 3);
    assert!(matches!(
        events.as_slice(),
        [
            Event::AudioDone { sequence: 0, .. },
            Event::AudioStart { sequence: 1, .. },
            Event::AudioChunk { audio },
            Event::AudioDone { sequence: 1, .. }
        ] if audio == &[2]
    ));
    let stale = queue.reserve(3);
    queue.clear();
    assert!(queue.finish(stale, 3).is_empty());
}

#[test]
fn audio_queue_barrier_waits_for_reserved_audio_before_it() {
    let mut queue = AudioQueue::new();
    let audio = queue.reserve(1);
    let marker = queue.reserve(1);
    assert!(queue
        .barrier(marker, 1, json!({"type":"barrier"}))
        .is_empty());
    assert!(matches!(
        queue.start(audio, 1).as_slice(),
        [Event::AudioStart { sequence: 0, .. }]
    ));
    let events = queue.finish(audio, 1);
    assert!(matches!(
        events.as_slice(),
        [
            Event::AudioDone { sequence: 0, .. },
            Event::Json(value)
        ] if value["type"] == "barrier"
    ));
}

#[test]
fn audio_queue_cancellation_releases_following_audio() {
    let mut queue = AudioQueue::new();
    let first = queue.reserve(1);
    let second = queue.reserve(1);
    assert!(matches!(
        queue.cancel(first, 1).as_slice(),
        [
            Event::AudioStart { sequence: 0, .. },
            Event::AudioDone { sequence: 0, .. }
        ]
    ));
    assert!(matches!(
        queue.start(second, 1).as_slice(),
        [Event::AudioStart { sequence: 1, .. }]
    ));
    assert!(matches!(
        queue.append(second, 1, vec![7]).as_slice(),
        [Event::AudioChunk { audio }] if audio == &[7]
    ));
    let events = queue.finish(second, 1);
    assert!(matches!(
        events.as_slice(),
        [Event::AudioDone { sequence: 1, .. }]
    ));
}
