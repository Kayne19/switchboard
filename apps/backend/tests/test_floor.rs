use super::*;
use crate::debug::DebugEvent;
use crate::within;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::Duration;

fn request(n: usize) -> FloorRequest {
    FloorRequest {
        floor_id: 0,
        project: "grape".into(),
        token: "grape-token".into(),
        generation: 0,
        context: "caller: previous line".into(),
        message: format!("update {n}"),
        reason: "finished".into(),
        held_display: false,
    }
}

fn hooks(
    connected: Arc<AtomicBool>,
    live: Arc<AtomicBool>,
    gate: Arc<AtomicUsize>,
    released: mpsc::UnboundedSender<String>,
) -> FloorHooks {
    FloorHooks {
        connected: Arc::new(move || connected.load(Ordering::SeqCst)),
        live: Arc::new(move |_| live.load(Ordering::SeqCst)),
        gate: Arc::new(move |_| {
            let gate = gate.clone();
            Box::pin(async move {
                gate.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            }) as GateFuture
        }),
        rewrite: Arc::new(move |input| {
            let text = input.message.clone();
            Box::pin(async move { Ok(text) }) as RewriteFuture
        }),
        release: Arc::new(move |request, text| {
            let released = released.clone();
            Box::pin(async move {
                released
                    .send(format!("{text}:{}", request.message))
                    .unwrap();
                ReleaseOutcome::Played
            }) as ReleaseFuture
        }),
    }
}

async fn yield_worker() {
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn queue_order_and_one_speaker_at_a_time() {
    let floor = Floor::new(Duration::ZERO);
    let connected = Arc::new(AtomicBool::new(true));
    let live = Arc::new(AtomicBool::new(true));
    let gates = Arc::new(AtomicUsize::new(0));
    let (released, mut results) = mpsc::unbounded_channel();
    floor.set_page_connected(true).await;
    floor.enqueue(request(1)).await;
    floor.enqueue(request(2)).await;
    let floor_worker = floor.clone();
    let worker_connected = connected.clone();
    let worker_live = live.clone();
    let worker_gates = gates.clone();
    let worker = tokio::spawn(async move {
        floor_worker
            .run(hooks(worker_connected, worker_live, worker_gates, released))
            .await;
    });
    yield_worker().await;
    assert_eq!(gates.load(Ordering::SeqCst), 2);
    assert_eq!(
        within("results", results.recv()).await.unwrap(),
        "update 1:update 1"
    );
    assert_eq!(
        within("results", results.recv()).await.unwrap(),
        "update 2:update 2"
    );
    assert_eq!(floor.queue_len().await, 0);
    worker.abort();
}

#[tokio::test]
async fn an_agent_keeps_one_request_waiting_however_often_it_asks() {
    let floor = Floor::new(Duration::ZERO);
    let bus = crate::debug::DebugBus::new();
    let floor = floor.with_debug(bus.clone());
    // No page: nothing is released while the agent asks again and again.
    for n in 1..=1_000 {
        floor.enqueue(request(n)).await;
    }
    // The front, which may already be on its way out, and the newest.
    assert_eq!(floor.queue_len().await, 2);
    let replaced = debug_events(&bus)
        .into_iter()
        .filter(|event| matches!(event, DebugEvent::FloorReleased { how, .. } if how == "replaced"))
        .count();
    assert_eq!(replaced, 998);

    let connected = Arc::new(AtomicBool::new(true));
    let live = Arc::new(AtomicBool::new(true));
    let (released, mut results) = mpsc::unbounded_channel();
    floor.set_page_connected(true).await;
    let worker = tokio::spawn({
        let floor = floor.clone();
        let h = hooks(connected, live, Arc::new(AtomicUsize::new(0)), released);
        async move { floor.run(h).await }
    });
    assert_eq!(
        within("results", results.recv()).await.unwrap(),
        "update 1:update 1"
    );
    assert_eq!(
        within("results", results.recv()).await.unwrap(),
        "update 1000:update 1000"
    );
    worker.abort();
}

#[tokio::test]
async fn releases_record_no_overlapping_speakers() {
    let floor = Floor::new(Duration::ZERO);
    let connected = Arc::new(AtomicBool::new(true));
    let live = Arc::new(AtomicBool::new(true));
    let (events, mut event_rx) = mpsc::unbounded_channel();
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let (allow_first, allow_signal) = oneshot::channel();
    let allow_signal = Arc::new(Mutex::new(Some(allow_signal)));
    let mut h = hooks(
        connected,
        live,
        Arc::new(AtomicUsize::new(0)),
        mpsc::unbounded_channel().0,
    );
    let maximum_for_release = maximum.clone();
    h.release = Arc::new(move |request, _text| {
        let events = events.clone();
        let active = active.clone();
        let maximum = maximum_for_release.clone();
        let allow_signal = allow_signal.clone();
        Box::pin(async move {
            let now = active.fetch_add(1, Ordering::SeqCst) + 1;
            maximum.fetch_max(now, Ordering::SeqCst);
            events.send(format!("start:{}", request.message)).unwrap();
            if request.message == "update 1" {
                if let Some(signal) = allow_signal.lock().await.take() {
                    // unbounded: the fake speaker holds the floor until the test releases it.
                    let _ = signal.await;
                }
            }
            events.send(format!("end:{}", request.message)).unwrap();
            active.fetch_sub(1, Ordering::SeqCst);
            ReleaseOutcome::Played
        }) as ReleaseFuture
    });
    floor.set_page_connected(true).await;
    floor.enqueue(request(1)).await;
    floor.enqueue(request(2)).await;
    let floor_worker = floor.clone();
    let worker = tokio::spawn(async move { floor_worker.run(h).await });
    assert_eq!(
        within("event_rx", event_rx.recv()).await.as_deref(),
        Some("start:update 1")
    );
    assert!(event_rx.try_recv().is_err(), "second speaker started early");
    allow_first.send(()).unwrap();
    assert_eq!(
        within("event_rx", event_rx.recv()).await.as_deref(),
        Some("end:update 1")
    );
    assert_eq!(
        within("event_rx", event_rx.recv()).await.as_deref(),
        Some("start:update 2")
    );
    assert_eq!(
        within("event_rx", event_rx.recv()).await.as_deref(),
        Some("end:update 2")
    );
    assert_eq!(maximum.load(Ordering::SeqCst), 1);
    worker.abort();
}

#[tokio::test]
async fn gate_negative_answer_holds_until_the_next_quiet_moment() {
    let floor = Floor::new(Duration::from_millis(20));
    let connected = Arc::new(AtomicBool::new(true));
    let live = Arc::new(AtomicBool::new(true));
    let calls = Arc::new(AtomicUsize::new(0));
    let (released, mut results) = mpsc::unbounded_channel();
    floor.set_page_connected(true).await;
    floor.caller_spoke().await;
    floor.force_not_quiet_for_test().await;
    floor.enqueue(request(1)).await;
    let calls_for_gate = calls.clone();
    let mut h = hooks(connected, live, calls.clone(), released);
    h.gate = Arc::new(move |_| {
        let calls = calls_for_gate.clone();
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(false)
        }) as GateFuture
    });
    let floor_worker = floor.clone();
    let worker = tokio::spawn(async move {
        floor_worker.run(h).await;
    });
    yield_worker().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(results.try_recv().is_err());
    floor.force_quiet_for_test().await;
    yield_worker().await;
    assert_eq!(
        within("results", results.recv()).await.unwrap(),
        "update 1:update 1"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    worker.abort();
}

#[tokio::test]
async fn gate_rejection_requires_a_new_quiet_period() {
    let floor = Floor::new(Duration::from_millis(20));
    let connected = Arc::new(AtomicBool::new(true));
    let live = Arc::new(AtomicBool::new(true));
    let calls = Arc::new(AtomicUsize::new(0));
    let (released, mut results) = mpsc::unbounded_channel();
    floor.set_page_connected(true).await;
    floor.force_quiet_for_test().await;
    floor.enqueue(request(1)).await;
    let calls_for_gate = calls.clone();
    let mut h = hooks(connected, live, calls.clone(), released);
    h.gate = Arc::new(move |_| {
        let calls = calls_for_gate.clone();
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(false)
        }) as GateFuture
    });
    let floor_worker = floor.clone();
    let worker = tokio::spawn(async move { floor_worker.run(h).await });
    yield_worker().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(results.try_recv().is_err());
    floor.force_quiet_for_test().await;
    yield_worker().await;
    assert_eq!(
        within("results", results.recv()).await.unwrap(),
        "update 1:update 1"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    worker.abort();
}

#[tokio::test]
async fn gate_timeout_is_treated_as_a_hold_then_quiet_releases() {
    let floor = Floor::new(Duration::from_secs(1));
    let connected = Arc::new(AtomicBool::new(true));
    let live = Arc::new(AtomicBool::new(true));
    let (released, mut results) = mpsc::unbounded_channel();
    let (gate_done, gate_signal) = oneshot::channel();
    let gate_signal = Arc::new(Mutex::new(Some(gate_signal)));
    floor.set_page_connected(true).await;
    floor.caller_spoke().await;
    floor.enqueue(request(1)).await;
    let mut h = hooks(connected, live, Arc::new(AtomicUsize::new(0)), released);
    h.gate = Arc::new(move |_| {
        let gate_signal = gate_signal.clone();
        Box::pin(async move {
            if let Some(signal) = gate_signal.lock().await.take() {
                // unbounded: the fake gate holds its answer until the test releases it.
                let _ = signal.await;
            }
            Err(())
        }) as GateFuture
    });
    let floor_worker = floor.clone();
    let worker = tokio::spawn(async move { floor_worker.run(h).await });
    yield_worker().await;
    assert!(results.try_recv().is_err());
    gate_done.send(()).unwrap();
    yield_worker().await;
    assert!(results.try_recv().is_err());
    floor.force_quiet_for_test().await;
    yield_worker().await;
    assert_eq!(
        within("results", results.recv()).await.unwrap(),
        "update 1:update 1"
    );
    worker.abort();
}

#[tokio::test]
async fn rewrite_receives_held_display_status() {
    let floor = Floor::new(Duration::ZERO);
    let connected = Arc::new(AtomicBool::new(true));
    let live = Arc::new(AtomicBool::new(true));
    let (released, mut results) = mpsc::unbounded_channel();
    let (flags, mut flags_rx) = mpsc::unbounded_channel();
    floor.set_page_connected(true).await;
    let mut held_request = request(1);
    held_request.held_display = true;
    floor.enqueue(held_request).await;
    let mut h = hooks(connected, live, Arc::new(AtomicUsize::new(0)), released);
    h.rewrite = Arc::new(move |input| {
        flags.send(input.held_display).unwrap();
        Box::pin(async move { Ok(input.message) }) as RewriteFuture
    });
    let worker = tokio::spawn({
        let floor = floor.clone();
        async move { floor.run(h).await }
    });
    assert_eq!(within("flags_rx", flags_rx.recv()).await, Some(true));
    assert_eq!(
        within("results", results.recv()).await.unwrap(),
        "update 1:update 1"
    );
    worker.abort();
}

#[tokio::test]
async fn rewrite_error_uses_the_original_message() {
    let floor = Floor::new(Duration::ZERO);
    let connected = Arc::new(AtomicBool::new(true));
    let live = Arc::new(AtomicBool::new(true));
    let (released, mut results) = mpsc::unbounded_channel();
    floor.set_page_connected(true).await;
    floor.enqueue(request(1)).await;
    let mut h = hooks(connected, live, Arc::new(AtomicUsize::new(0)), released);
    h.rewrite = Arc::new(|_| Box::pin(async { Err(()) }) as RewriteFuture);
    let floor_worker = floor.clone();
    let worker = tokio::spawn(async move { floor_worker.run(h).await });
    yield_worker().await;
    assert_eq!(
        within("results", results.recv()).await.unwrap(),
        "update 1:update 1"
    );
    worker.abort();
}

#[tokio::test]
async fn rewrite_timeout_uses_the_original_message() {
    let floor = Floor::new(Duration::ZERO);
    let connected = Arc::new(AtomicBool::new(true));
    let live = Arc::new(AtomicBool::new(true));
    let (released, mut results) = mpsc::unbounded_channel();
    floor.set_page_connected(true).await;
    floor.enqueue(request(1)).await;
    let mut h = hooks(connected, live, Arc::new(AtomicUsize::new(0)), released);
    let (timed_out, mut timeout_events) = mpsc::unbounded_channel();
    h.rewrite = Arc::new(move |_| {
        let timed_out = timed_out.clone();
        Box::pin(async move {
            let result = tokio::time::timeout(
                Duration::from_millis(20),
                std::future::pending::<Result<String, ()>>(),
            )
            .await
            .map_err(|_| ())
            .and_then(|result| result);
            timed_out.send(()).unwrap();
            result
        }) as RewriteFuture
    });
    let floor_worker = floor.clone();
    let worker = tokio::spawn(async move { floor_worker.run(h).await });
    yield_worker().await;
    assert!(results.try_recv().is_err());
    within("timeout_events", timeout_events.recv())
        .await
        .unwrap();
    yield_worker().await;
    assert_eq!(
        within("results", results.recv()).await.unwrap(),
        "update 1:update 1"
    );
    worker.abort();
}

#[tokio::test]
async fn announcement_is_first_only_after_quiet_threshold() {
    let floor = Floor::new(Duration::from_secs(1));
    let connected = Arc::new(AtomicBool::new(true));
    let live = Arc::new(AtomicBool::new(true));
    let (released, mut results) = mpsc::unbounded_channel();
    floor.set_page_connected(true).await;
    floor.caller_spoke().await;
    floor.force_not_quiet_for_test().await;
    floor.enqueue(request(1)).await;
    // The quiet flag reaches the rewrite, which decides whether to ease in;
    // release is only handed the finished line.
    let mut h = hooks(
        connected.clone(),
        live.clone(),
        Arc::new(AtomicUsize::new(0)),
        released,
    );
    let (rewrites, mut rewrite_inputs) = mpsc::unbounded_channel();
    h.rewrite = Arc::new(move |input| {
        rewrites.send(input.quiet).unwrap();
        let text = input.message.clone();
        Box::pin(async move { Ok(text) }) as RewriteFuture
    });
    let floor_worker = floor.clone();
    let worker = tokio::spawn(async move { floor_worker.run(h).await });
    yield_worker().await;
    assert_eq!(
        within("results", results.recv()).await.unwrap(),
        "update 1:update 1"
    );
    assert!(!within("rewrite_inputs", rewrite_inputs.recv())
        .await
        .unwrap());
    floor.enqueue(request(2)).await;
    floor.caller_spoke().await;
    floor.force_quiet_for_test().await;
    yield_worker().await;
    assert_eq!(
        within("results", results.recv()).await.unwrap(),
        "update 2:update 2"
    );
    assert!(within("rewrite_inputs", rewrite_inputs.recv())
        .await
        .unwrap());
    worker.abort();
}

#[tokio::test]
async fn queued_work_waits_without_a_page_and_disconnect_holds_the_rest() {
    let floor = Floor::new(Duration::ZERO);
    let connected = Arc::new(AtomicBool::new(false));
    let live = Arc::new(AtomicBool::new(true));
    let (released, mut results) = mpsc::unbounded_channel();
    floor.enqueue(request(1)).await;
    floor.enqueue(request(2)).await;
    let mut h = hooks(
        connected.clone(),
        live,
        Arc::new(AtomicUsize::new(0)),
        released,
    );
    let release_floor = floor.clone();
    let release_connected = connected.clone();
    let (actual, mut actual_results) = mpsc::unbounded_channel();
    h.release = Arc::new(move |request, text| {
        let release_floor = release_floor.clone();
        let release_connected = release_connected.clone();
        let actual = actual.clone();
        Box::pin(async move {
            actual.send(format!("{text}:{}", request.message)).unwrap();
            if request.message == "update 1" {
                release_connected.store(false, Ordering::SeqCst);
                release_floor.set_page_connected(false).await;
            }
            ReleaseOutcome::Played
        }) as ReleaseFuture
    });
    let floor_worker = floor.clone();
    let worker = tokio::spawn(async move { floor_worker.run(h).await });
    yield_worker().await;
    assert!(results.try_recv().is_err());
    connected.store(true, Ordering::SeqCst);
    floor.set_page_connected(true).await;
    yield_worker().await;
    assert_eq!(
        within("actual_results", actual_results.recv())
            .await
            .unwrap(),
        "update 1:update 1"
    );
    yield_worker().await;
    assert!(actual_results.try_recv().is_err());
    connected.store(true, Ordering::SeqCst);
    floor.set_page_connected(true).await;
    assert_eq!(
        within("actual_results", actual_results.recv())
            .await
            .unwrap(),
        "update 2:update 2"
    );
    worker.abort();
}

#[tokio::test]
async fn dead_or_promoted_agent_is_dropped_before_release() {
    let floor = Floor::new(Duration::ZERO);
    let connected = Arc::new(AtomicBool::new(true));
    let live = Arc::new(AtomicBool::new(true));
    let (released, mut results) = mpsc::unbounded_channel();
    floor.set_page_connected(true).await;
    floor.enqueue(request(1)).await;
    let mut h = hooks(
        connected,
        live.clone(),
        Arc::new(AtomicUsize::new(0)),
        released,
    );
    let live_after_rewrite = live.clone();
    h.rewrite = Arc::new(move |_| {
        live_after_rewrite.store(false, Ordering::SeqCst);
        Box::pin(async { Ok("rewritten".into()) }) as RewriteFuture
    });
    let floor_worker = floor.clone();
    let worker = tokio::spawn(async move {
        floor_worker.run(h).await;
    });
    yield_worker().await;
    assert!(results.try_recv().is_err());
    assert_eq!(floor.queue_len().await, 0);
    worker.abort();
}

#[tokio::test]
async fn rewrite_receives_conversation_project_quiet_and_message() {
    let floor = Floor::new(Duration::ZERO);
    let connected = Arc::new(AtomicBool::new(true));
    let live = Arc::new(AtomicBool::new(true));
    let (input_tx, mut input_rx) = mpsc::unbounded_channel();
    let (released, mut results) = mpsc::unbounded_channel();
    floor.set_page_connected(true).await;
    floor.enqueue(request(1)).await;
    let mut h = hooks(connected, live, Arc::new(AtomicUsize::new(0)), released);
    h.rewrite = Arc::new(move |input| {
        input_tx
            .send((input.context, input.project, input.quiet, input.message))
            .unwrap();
        Box::pin(async { Ok("spoken result".into()) }) as RewriteFuture
    });
    let worker = tokio::spawn({
        let floor = floor.clone();
        async move { floor.run(h).await }
    });
    assert_eq!(
        within("input_rx", input_rx.recv()).await.unwrap(),
        (
            "caller: previous line".to_owned(),
            "grape".to_owned(),
            true,
            "update 1".to_owned()
        )
    );
    assert_eq!(
        within("results", results.recv()).await.unwrap(),
        "spoken result:update 1"
    );
    worker.abort();
}

/// The debug events published so far, oldest first.
fn debug_events(bus: &crate::debug::DebugBus) -> Vec<DebugEvent> {
    bus.events_for_test()
}

#[tokio::test]
async fn the_floor_traces_one_message_from_request_to_release_under_one_id() {
    let bus = crate::debug::DebugBus::new();
    let floor = Floor::new(Duration::ZERO).with_debug(bus.clone());
    let (released, mut results) = mpsc::unbounded_channel();
    let mut h = hooks(
        Arc::new(AtomicBool::new(true)),
        Arc::new(AtomicBool::new(true)),
        Arc::new(AtomicUsize::new(0)),
        released,
    );
    // Jev says no once: the message is held, then released at the next quiet
    // moment without asking again.
    h.gate = Arc::new(|_| Box::pin(async { Ok(false) }) as GateFuture);
    h.rewrite = Arc::new(|input| {
        let text = format!("Grape says: {}", input.message);
        Box::pin(async move { Ok(text) }) as RewriteFuture
    });
    floor.set_page_connected(true).await;
    floor.enqueue(request(1)).await;
    let worker_floor = floor.clone();
    let worker = tokio::spawn(async move { worker_floor.run(h).await });
    assert_eq!(
        within("results", results.recv()).await.unwrap(),
        "Grape says: update 1:update 1"
    );
    worker.abort();

    let id = Some("floor-1".to_owned());
    let events = debug_events(&bus);
    assert_eq!(
        events[0],
        DebugEvent::FloorRequest {
            agent: "grape".into(),
            message: "update 1".into(),
            floor_id: id.clone(),
        }
    );
    assert!(matches!(
        &events[1],
        DebugEvent::FloorGate { agent, answer, floor_id, .. }
            if agent == "grape" && answer == "no" && *floor_id == id
    ));
    assert_eq!(
        events[2],
        DebugEvent::FloorHeld {
            agent: "grape".into(),
            message: "update 1".into(),
            floor_id: id.clone(),
        }
    );
    assert!(matches!(
        &events[3],
        DebugEvent::FloorRewrite { original, rewritten, floor_id, .. }
            if original == "update 1" && rewritten == "Grape says: update 1" && *floor_id == id
    ));
    assert_eq!(
        events[4],
        DebugEvent::FloorReleased {
            agent: "grape".into(),
            how: "quiet_after_hold".into(),
            floor_id: id,
        }
    );
    assert_eq!(events.len(), 5);
}

#[tokio::test]
async fn the_floor_traces_a_gate_yes_release_and_a_dropped_message() {
    let bus = crate::debug::DebugBus::new();
    let floor = Floor::new(Duration::ZERO).with_debug(bus.clone());
    let live = Arc::new(AtomicBool::new(true));
    let (released, mut results) = mpsc::unbounded_channel();
    let h = hooks(
        Arc::new(AtomicBool::new(true)),
        live.clone(),
        Arc::new(AtomicUsize::new(0)),
        released,
    );
    floor.set_page_connected(true).await;
    floor.enqueue(request(1)).await;
    let worker_floor = floor.clone();
    let worker = tokio::spawn(async move { worker_floor.run(h).await });
    within("results", results.recv()).await.unwrap();
    live.store(false, Ordering::SeqCst);
    floor.enqueue(request(2)).await;
    while floor.queue_len().await > 0 {
        tokio::task::yield_now().await;
    }
    worker.abort();
    let released: Vec<_> = debug_events(&bus)
        .into_iter()
        .filter_map(|event| match event {
            DebugEvent::FloorReleased { how, floor_id, .. } => Some((how, floor_id)),
            _ => None,
        })
        .collect();
    assert_eq!(
        released,
        vec![
            ("gate_yes".to_owned(), Some("floor-1".to_owned())),
            ("dropped_agent_gone".to_owned(), Some("floor-2".to_owned())),
        ]
    );
}
