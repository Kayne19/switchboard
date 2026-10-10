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
async fn a_floor_event_between_the_check_and_the_wait_is_not_lost() {
    let floor = Floor::new(Duration::ZERO);
    let connected = Arc::new(AtomicBool::new(true));
    let live = Arc::new(AtomicBool::new(true));
    let (released, mut results) = mpsc::unbounded_channel();
    floor.set_page_connected(true).await;
    floor.enqueue(request(1)).await;
    let mut h = hooks(connected, live, Arc::new(AtomicUsize::new(0)), released);
    // The page's second check reads it gone, and it comes back before the
    // worker waits: the wake-up lands in the gap after the state is read.
    let checks = Arc::new(AtomicUsize::new(0));
    let racing = floor.clone();
    h.connected = Arc::new(move || {
        if checks.fetch_add(1, Ordering::SeqCst) == 1 {
            racing.changed.notify_waiters();
            return false;
        }
        true
    });
    let worker = tokio::spawn({
        let floor = floor.clone();
        async move { floor.run(h).await }
    });
    let released = tokio::time::timeout(Duration::from_secs(2), results.recv())
        .await
        .expect("the worker woke for the event it was about to wait for");
    assert_eq!(released.unwrap(), "update 1:update 1");
    worker.abort();
}

#[tokio::test]
async fn a_release_that_could_not_get_audio_tries_again_unprompted() {
    let floor = Floor::new(Duration::ZERO);
    let connected = Arc::new(AtomicBool::new(true));
    let live = Arc::new(AtomicBool::new(true));
    floor.set_page_connected(true).await;
    floor.enqueue(request(1)).await;
    let gates = Arc::new(AtomicUsize::new(0));
    let mut h = hooks(connected, live, gates.clone(), mpsc::unbounded_channel().0);
    // The first release finds every audio slot taken; nothing tells the
    // floor when one frees up.
    let (attempts, mut attempted) = mpsc::unbounded_channel();
    let tries = Arc::new(AtomicUsize::new(0));
    h.release = Arc::new(move |_, _| {
        let attempts = attempts.clone();
        let first = tries.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(async move {
            attempts.send(()).unwrap();
            if first {
                ReleaseOutcome::Retry
            } else {
                ReleaseOutcome::Played
            }
        }) as ReleaseFuture
    });
    let worker = tokio::spawn({
        let floor = floor.clone();
        async move { floor.run(h).await }
    });
    within("attempted", attempted.recv()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), attempted.recv())
        .await
        .expect("the release is tried again without a floor event");
    // The timer tries the release again, not the gate: nothing changed for
    // Jev to judge, and a timer must not keep asking it.
    assert_eq!(gates.load(Ordering::SeqCst), 1);
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

// The front request's phase x event table, written against the worker's
// behaviour before it became a machine (#395). Each row starts one worker on
// `update 1`, drives the front request into a phase through scripted hooks,
// applies one event and names what the worker does next: which hook it calls,
// or how the request leaves the floor. The hooks wait for the row to answer
// them, so a row decides when each gate, rewrite and release returns.

/// A hook call the worker made, with the row's way to answer it.
enum Call {
    Gate(String, oneshot::Sender<Result<bool, ()>>),
    Rewrite(FloorRewriteInput, oneshot::Sender<Result<String, ()>>),
    Release(String, oneshot::Sender<ReleaseOutcome>),
}

impl Call {
    fn name(&self) -> String {
        match self {
            Call::Gate(message, _) => format!("gate({message})"),
            Call::Rewrite(input, _) => format!("rewrite({}, quiet {})", input.message, input.quiet),
            Call::Release(words, _) => format!("release({words})"),
        }
    }
}

/// One step of a row.
#[derive(Clone, Copy, Debug)]
enum Do {
    /// The page comes or goes: the floor is told and the hook agrees.
    Page(bool),
    CallerSpeaks,
    /// The caller last spoke longer than the threshold ago.
    QuietLine,
    /// Another request from another agent joins the queue.
    Enqueue(usize),
    /// The request's agent is no longer live.
    AgentGone,
    Sleep(u64),
    /// The next call is the gate, for this message; it waits for `Answer*`.
    ExpectGate(&'static str),
    AnswerGate(Result<bool, ()>),
    ExpectRewrite {
        quiet: bool,
    },
    AnswerRewrite(Result<&'static str, ()>),
    ExpectRelease(&'static str),
    AnswerRelease(ReleaseOutcome),
    /// The worker calls no hook for this many milliseconds.
    ExpectNothing(u64),
    /// `update 1` left the floor this way (`FloorReleased.how`).
    ExpectLeft(&'static str),
    /// `update 1` was held (`FloorHeld`).
    ExpectHeld,
    ExpectQueue(usize),
}

struct Row {
    name: &'static str,
    quiet_threshold_ms: u64,
    page: bool,
    steps: &'static [Do],
}

const PLAYED: ReleaseOutcome = ReleaseOutcome::Played;
const RETRY: ReleaseOutcome = ReleaseOutcome::Retry;
const DROP: ReleaseOutcome = ReleaseOutcome::Drop;
const LONG: u64 = 10_000;
const SHORT: u64 = 50;

const fn row(name: &'static str, quiet_threshold_ms: u64, page: bool, steps: &'static [Do]) -> Row {
    Row {
        name,
        quiet_threshold_ms,
        page,
        steps,
    }
}

const ROWS: &[Row] = &[
    // awaiting the page
    row(
        "awaiting_page + page comes -> gating",
        LONG,
        false,
        &[
            Do::ExpectNothing(100),
            Do::Page(true),
            Do::ExpectGate("update 1"),
        ],
    ),
    row(
        "awaiting_page + caller speaks, request queued -> still awaiting the page",
        LONG,
        false,
        &[
            Do::CallerSpeaks,
            Do::Enqueue(2),
            Do::ExpectNothing(100),
            Do::Page(true),
            Do::ExpectGate("update 1"),
        ],
    ),
    // gating
    row(
        "gating + yes on a busy line -> rewriting, not quiet",
        LONG,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(true)),
            Do::ExpectRewrite { quiet: false },
        ],
    ),
    row(
        "gating + yes on a quiet line -> rewriting, quiet",
        LONG,
        true,
        &[
            Do::QuietLine,
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(true)),
            Do::ExpectRewrite { quiet: true },
        ],
    ),
    row(
        "gating + no -> held until quiet",
        LONG,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(false)),
            Do::ExpectHeld,
            Do::ExpectNothing(100),
        ],
    ),
    row(
        "gating + failed -> held until quiet, as for no",
        LONG,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Err(())),
            Do::ExpectHeld,
            Do::ExpectNothing(100),
        ],
    ),
    row(
        "gating + yes after the agent went -> dropped before the rewrite",
        LONG,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AgentGone,
            Do::AnswerGate(Ok(true)),
            Do::ExpectLeft("dropped_agent_gone"),
            Do::ExpectNothing(SHORT),
            Do::ExpectQueue(0),
        ],
    ),
    row(
        "gating + page goes, then yes -> rewritten and handed to the release",
        LONG,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::Page(false),
            Do::AnswerGate(Ok(true)),
            Do::ExpectRewrite { quiet: false },
            Do::AnswerRewrite(Ok("said")),
            Do::ExpectRelease("said"),
        ],
    ),
    // awaiting quiet (held)
    row(
        "awaiting_quiet + quiet reached -> rewriting without the gate",
        SHORT,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(false)),
            Do::ExpectRewrite { quiet: true },
        ],
    ),
    row(
        "awaiting_quiet + caller speaks, request queued -> still held, gate not asked",
        LONG,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(false)),
            Do::CallerSpeaks,
            Do::Enqueue(2),
            Do::ExpectNothing(100),
        ],
    ),
    row(
        "awaiting_quiet + page goes and comes back after quiet -> rewriting without the gate",
        SHORT,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::Page(false),
            Do::AnswerGate(Ok(false)),
            Do::ExpectNothing(150),
            Do::Page(true),
            Do::ExpectRewrite { quiet: true },
        ],
    ),
    // rewriting
    row(
        "rewriting + text -> releasing those words",
        LONG,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(true)),
            Do::ExpectRewrite { quiet: false },
            Do::AnswerRewrite(Ok("said")),
            Do::ExpectRelease("said"),
        ],
    ),
    row(
        "rewriting + failure -> releasing the agent's own words",
        LONG,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(true)),
            Do::ExpectRewrite { quiet: false },
            Do::AnswerRewrite(Err(())),
            Do::ExpectRelease("update 1"),
        ],
    ),
    row(
        "rewriting + agent gone -> dropped, never released",
        LONG,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(true)),
            Do::ExpectRewrite { quiet: false },
            Do::AgentGone,
            Do::AnswerRewrite(Ok("said")),
            Do::ExpectLeft("dropped_agent_gone"),
            Do::ExpectNothing(SHORT),
            Do::ExpectQueue(0),
        ],
    ),
    // releasing
    row(
        "releasing + played -> left as gate_yes, next request gated",
        LONG,
        true,
        &[
            Do::Enqueue(2),
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(true)),
            Do::ExpectRewrite { quiet: false },
            Do::AnswerRewrite(Ok("said")),
            Do::ExpectRelease("said"),
            Do::AnswerRelease(PLAYED),
            Do::ExpectLeft("gate_yes"),
            Do::ExpectGate("update 2"),
        ],
    ),
    row(
        "releasing + played after a hold -> left as quiet_after_hold",
        SHORT,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(false)),
            Do::ExpectRewrite { quiet: true },
            Do::AnswerRewrite(Ok("said")),
            Do::ExpectRelease("said"),
            Do::AnswerRelease(PLAYED),
            Do::ExpectLeft("quiet_after_hold"),
            Do::ExpectQueue(0),
        ],
    ),
    row(
        "releasing + drop -> left as dropped_agent_gone",
        LONG,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(true)),
            Do::ExpectRewrite { quiet: false },
            Do::AnswerRewrite(Ok("said")),
            Do::ExpectRelease("said"),
            Do::AnswerRelease(DROP),
            Do::ExpectLeft("dropped_agent_gone"),
            Do::ExpectQueue(0),
        ],
    ),
    row(
        "releasing + retry with the page gone -> awaiting the page, then gated and rewritten again",
        LONG,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(true)),
            Do::ExpectRewrite { quiet: false },
            Do::AnswerRewrite(Ok("said")),
            Do::ExpectRelease("said"),
            Do::Page(false),
            Do::AnswerRelease(RETRY),
            Do::ExpectNothing(1_500),
            Do::Page(true),
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(true)),
            Do::ExpectRewrite { quiet: false },
        ],
    ),
    row(
        "releasing + retry with the page there -> the same words again, gate not asked",
        LONG,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(true)),
            Do::ExpectRewrite { quiet: false },
            Do::AnswerRewrite(Ok("said")),
            Do::ExpectRelease("said"),
            Do::AnswerRelease(RETRY),
            Do::ExpectNothing(300),
            Do::ExpectRelease("said"),
            Do::AnswerRelease(PLAYED),
            Do::ExpectLeft("gate_yes"),
        ],
    ),
    row(
        "releasing + floor event during it, then retry -> gating again",
        LONG,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(true)),
            Do::ExpectRewrite { quiet: false },
            Do::AnswerRewrite(Ok("said")),
            Do::ExpectRelease("said"),
            Do::Enqueue(2),
            Do::AnswerRelease(RETRY),
            Do::ExpectGate("update 1"),
        ],
    ),
    row(
        "releasing + retry after a hold, page gone and back -> rewriting without the gate",
        SHORT,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(false)),
            Do::ExpectRewrite { quiet: true },
            Do::AnswerRewrite(Ok("said")),
            Do::ExpectRelease("said"),
            Do::Page(false),
            Do::AnswerRelease(RETRY),
            Do::Sleep(100),
            Do::Page(true),
            Do::ExpectRewrite { quiet: true },
        ],
    ),
    // retrying the release
    row(
        "retrying_release + floor event -> gating again",
        LONG,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(true)),
            Do::ExpectRewrite { quiet: false },
            Do::AnswerRewrite(Ok("said")),
            Do::ExpectRelease("said"),
            Do::AnswerRelease(RETRY),
            Do::CallerSpeaks,
            Do::ExpectGate("update 1"),
        ],
    ),
    row(
        "retrying_release + timer with the agent gone -> the release decides",
        LONG,
        true,
        &[
            Do::ExpectGate("update 1"),
            Do::AnswerGate(Ok(true)),
            Do::ExpectRewrite { quiet: false },
            Do::AnswerRewrite(Ok("said")),
            Do::ExpectRelease("said"),
            Do::AgentGone,
            Do::AnswerRelease(RETRY),
            Do::ExpectRelease("said"),
            Do::AnswerRelease(DROP),
            Do::ExpectLeft("dropped_agent_gone"),
        ],
    ),
];

fn scripted_hooks(
    connected: Arc<AtomicBool>,
    live: Arc<AtomicBool>,
    calls: mpsc::UnboundedSender<Call>,
) -> FloorHooks {
    let gate_calls = calls.clone();
    let rewrite_calls = calls.clone();
    FloorHooks {
        connected: Arc::new(move || connected.load(Ordering::SeqCst)),
        live: Arc::new(move |_| live.load(Ordering::SeqCst)),
        gate: Arc::new(move |request| {
            let (answer, answered) = oneshot::channel();
            gate_calls
                .send(Call::Gate(request.message.clone(), answer))
                .unwrap();
            Box::pin(async move {
                // unbounded: the row answers the gate when it chooses.
                answered.await.unwrap_or(Err(()))
            }) as GateFuture
        }),
        rewrite: Arc::new(move |input| {
            let (answer, answered) = oneshot::channel();
            rewrite_calls.send(Call::Rewrite(input, answer)).unwrap();
            Box::pin(async move {
                // unbounded: the row answers the rewrite when it chooses.
                answered.await.unwrap_or(Err(()))
            }) as RewriteFuture
        }),
        release: Arc::new(move |_, words| {
            let (answer, answered) = oneshot::channel();
            calls.send(Call::Release(words, answer)).unwrap();
            Box::pin(async move {
                // unbounded: the row answers the release when it chooses.
                answered.await.unwrap_or(ReleaseOutcome::Retry)
            }) as ReleaseFuture
        }),
    }
}

fn other_request(n: usize) -> FloorRequest {
    let mut request = request(n);
    request.project = format!("agent-{n}");
    request.token = format!("agent-{n}-token");
    request
}

async fn run_row(row: &Row) {
    let bus = crate::debug::DebugBus::new();
    let floor = Floor::new(Duration::from_millis(row.quiet_threshold_ms)).with_debug(bus.clone());
    let connected = Arc::new(AtomicBool::new(row.page));
    let live = Arc::new(AtomicBool::new(true));
    let (calls, mut called) = mpsc::unbounded_channel();
    floor.set_page_connected(row.page).await;
    floor.enqueue(request(1)).await;
    let worker = tokio::spawn({
        let floor = floor.clone();
        let hooks = scripted_hooks(connected.clone(), live.clone(), calls);
        async move { floor.run(hooks).await }
    });
    let mut gate = None;
    let mut rewrite = None;
    let mut release = None;
    let name = row.name;
    for (index, step) in row.steps.iter().enumerate() {
        let at = format!("{name}: step {index} {step:?}");
        match *step {
            Do::Page(on) => {
                connected.store(on, Ordering::SeqCst);
                floor.set_page_connected(on).await;
            }
            Do::CallerSpeaks => floor.caller_spoke().await,
            Do::QuietLine => floor.force_quiet_for_test().await,
            Do::Enqueue(n) => floor.enqueue(other_request(n)).await,
            Do::AgentGone => live.store(false, Ordering::SeqCst),
            Do::Sleep(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
            Do::ExpectGate(message) => match within("a gate call", called.recv()).await {
                Some(Call::Gate(asked, answer)) if asked == message => gate = Some(answer),
                other => panic!("{at}: got {:?}", other.map(|call| call.name())),
            },
            Do::AnswerGate(answer) => {
                let _ = gate.take().expect(&at).send(answer);
            }
            Do::ExpectRewrite { quiet } => match within("a rewrite call", called.recv()).await {
                Some(Call::Rewrite(input, answer)) if input.quiet == quiet && input.message == "update 1" => {
                    rewrite = Some(answer)
                }
                other => panic!("{at}: got {:?}", other.map(|call| call.name())),
            },
            Do::AnswerRewrite(answer) => {
                let _ = rewrite
                    .take()
                    .expect(&at)
                    .send(answer.map(str::to_owned));
            }
            Do::ExpectRelease(words) => match within("a release call", called.recv()).await {
                Some(Call::Release(said, answer)) if said == words => release = Some(answer),
                other => panic!("{at}: got {:?}", other.map(|call| call.name())),
            },
            Do::AnswerRelease(outcome) => {
                let _ = release.take().expect(&at).send(outcome);
            }
            Do::ExpectNothing(ms) => {
                if let Ok(call) = tokio::time::timeout(Duration::from_millis(ms), called.recv()).await {
                    panic!("{at}: got {:?}", call.map(|call| call.name()));
                }
            }
            Do::ExpectLeft(how) => {
                within("the front request leaving", async {
                    loop {
                        let left = debug_events(&bus).into_iter().find_map(|event| match event {
                            DebugEvent::FloorReleased { how, floor_id, .. }
                                if floor_id.as_deref() == Some("floor-1") =>
                            {
                                Some(how)
                            }
                            _ => None,
                        });
                        if let Some(left) = left {
                            assert_eq!(left, how, "{at}");
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
            }
            Do::ExpectHeld => {
                within("the hold", async {
                    while !debug_events(&bus).iter().any(|event| {
                        matches!(event, DebugEvent::FloorHeld { floor_id, .. } if floor_id.as_deref() == Some("floor-1"))
                    }) {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
            }
            Do::ExpectQueue(len) => {
                // The front leaves the queue just after its trace.
                within("the queue length", async {
                    while floor.queue_len().await != len {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
            }
        }
    }
    worker.abort();
}

#[tokio::test]
async fn the_front_request_phase_by_event_table() {
    for row in ROWS {
        run_row(row).await;
    }
}
