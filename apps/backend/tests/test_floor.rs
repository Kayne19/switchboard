use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::Duration;


fn request(n: usize) -> FloorRequest {
    FloorRequest {
        project: "grape".into(),
        token: "grape-token".into(),
        message: format!("update {n}"),
        reason: "finished".into(),
    }
}

fn hooks(
    connected: Arc<AtomicBool>,
    live: Arc<AtomicBool>,
    gate: Arc<AtomicUsize>,
    released: mpsc::UnboundedSender<(String, bool)>,
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
        rewrite: Arc::new(move |request| {
            let text = request.message.clone();
            Box::pin(async move { Ok(text) }) as RewriteFuture
        }),
        release: Arc::new(move |request, text, announce| {
            let released = released.clone();
            Box::pin(async move {
                released
                    .send((format!("{text}:{}", request.message), announce))
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
    assert_eq!(results.recv().await.unwrap().0, "update 1:update 1");
    assert_eq!(results.recv().await.unwrap().0, "update 2:update 2");
    assert_eq!(floor.queue_len().await, 0);
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
    h.release = Arc::new(move |request, _text, _announce| {
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
    assert_eq!(event_rx.recv().await.as_deref(), Some("start:update 1"));
    assert!(event_rx.try_recv().is_err(), "second speaker started early");
    allow_first.send(()).unwrap();
    assert_eq!(event_rx.recv().await.as_deref(), Some("end:update 1"));
    assert_eq!(event_rx.recv().await.as_deref(), Some("start:update 2"));
    assert_eq!(event_rx.recv().await.as_deref(), Some("end:update 2"));
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
    assert_eq!(results.recv().await.unwrap().0, "update 1:update 1");
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
    tokio::time::sleep(Duration::from_millis(30)).await;
    yield_worker().await;
    assert_eq!(results.recv().await.unwrap().0, "update 1:update 1");
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
    assert_eq!(results.recv().await.unwrap().0, "update 1:update 1");
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
    assert_eq!(results.recv().await.unwrap().0, "update 1:update 1");
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
    h.rewrite = Arc::new(|_| {
        Box::pin(async {
            tokio::time::timeout(
                Duration::from_millis(20),
                std::future::pending::<Result<String, ()>>(),
            )
            .await
            .map_err(|_| ())
            .and_then(|result| result)
        }) as RewriteFuture
    });
    let floor_worker = floor.clone();
    let worker = tokio::spawn(async move { floor_worker.run(h).await });
    yield_worker().await;
    assert!(results.try_recv().is_err());
    tokio::time::sleep(Duration::from_millis(30)).await;
    yield_worker().await;
    assert_eq!(results.recv().await.unwrap().0, "update 1:update 1");
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
    let floor_worker = floor.clone();
    let worker = tokio::spawn(async move {
        floor_worker
            .run(hooks(
                connected.clone(),
                live.clone(),
                Arc::new(AtomicUsize::new(0)),
                released,
            ))
            .await;
    });
    yield_worker().await;
    let (_, announce) = results.recv().await.unwrap();
    assert!(!announce);
    floor.enqueue(request(2)).await;
    floor.caller_spoke().await;
    floor.force_quiet_for_test().await;
    yield_worker().await;
    let (_, announce) = results.recv().await.unwrap();
    assert!(announce);
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
    h.release = Arc::new(move |request, text, announce| {
        let release_floor = release_floor.clone();
        let release_connected = release_connected.clone();
        let actual = actual.clone();
        Box::pin(async move {
            actual
                .send((format!("{text}:{}", request.message), announce))
                .unwrap();
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
    assert_eq!(actual_results.recv().await.unwrap().0, "update 1:update 1");
    yield_worker().await;
    assert!(actual_results.try_recv().is_err());
    connected.store(true, Ordering::SeqCst);
    floor.set_page_connected(true).await;
    assert_eq!(actual_results.recv().await.unwrap().0, "update 2:update 2");
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
