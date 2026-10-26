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

fn audio_sent(page: &mut DeliveryConnection) -> Vec<String> {
    std::iter::from_fn(|| page.receiver.try_recv().ok())
        .map(|frame| match frame {
            DeliveryFrame::Event { event, .. } => match event {
                Event::AudioStart { sequence, .. } => format!("start {sequence}"),
                Event::AudioChunk { audio } => format!("chunk {audio:?}"),
                Event::AudioDone { sequence, .. } => format!("done {sequence}"),
                Event::Json(value) => value["type"].as_str().unwrap_or_default().to_owned(),
            },
            DeliveryFrame::Message(_) => "message".to_owned(),
        })
        .collect()
}

fn queue_and_page() -> (AudioQueue, DeliveryConnection) {
    let delivery = DeliveryState::new();
    let page = delivery.register();
    (AudioQueue::new(delivery), page)
}

#[test]
fn audio_queue_emits_reserved_sequences_in_order_and_drops_on_clear() {
    let (mut queue, mut page) = queue_and_page();
    let first = queue.reserve(3);
    let second = queue.reserve(3);
    queue.start(second, 3);
    queue.append(second, 3, vec![2]);
    queue.finish(second, 3);
    assert!(audio_sent(&mut page).is_empty());
    queue.start(first, 3);
    assert_eq!(audio_sent(&mut page), ["start 0"]);
    queue.append(first, 3, vec![1]);
    assert_eq!(audio_sent(&mut page), ["chunk [1]"]);
    queue.finish(first, 3);
    assert_eq!(
        audio_sent(&mut page),
        ["done 0", "start 1", "chunk [2]", "done 1"]
    );
    let stale = queue.reserve(3);
    queue.clear();
    queue.finish(stale, 3);
    assert!(audio_sent(&mut page).is_empty());
}

#[test]
fn audio_queue_barrier_waits_for_reserved_audio_before_it() {
    let (mut queue, mut page) = queue_and_page();
    let audio = queue.reserve(1);
    let marker = queue.reserve(1);
    queue.barrier(marker, 1, json!({"type":"barrier"}));
    assert!(audio_sent(&mut page).is_empty());
    queue.start(audio, 1);
    assert_eq!(audio_sent(&mut page), ["start 0"]);
    queue.finish(audio, 1);
    assert_eq!(audio_sent(&mut page), ["done 0", "barrier"]);
}

#[test]
fn audio_queue_cancellation_releases_following_audio() {
    let (mut queue, mut page) = queue_and_page();
    let first = queue.reserve(1);
    let second = queue.reserve(1);
    // An utterance given up before any audio closes its slot the same way.
    queue.finish(first, 1);
    assert_eq!(audio_sent(&mut page), ["start 0", "done 0"]);
    queue.start(second, 1);
    assert_eq!(audio_sent(&mut page), ["start 1"]);
    queue.append(second, 1, vec![7]);
    assert_eq!(audio_sent(&mut page), ["chunk [7]"]);
    queue.finish(second, 1);
    assert_eq!(audio_sent(&mut page), ["done 1"]);
}
