use super::*;
use crate::app_state::{begin_alpha_candidate, state, AppState};
use crate::browser::{frames_until, handle_text_frame};
use crate::delivery::DeliveryConnection;
use crate::module_calls::{agent_call_json, post_display_in_task};
use crate::pbx::OPERATOR;
use crate::within;
use axum::http::StatusCode;

#[test]
fn a_later_primary_claim_takes_the_role_and_demotes_the_earlier_one() {
    // Mirrors the reducer in apps/frontend/src/controller/reducer.ts: only
    // the latest object shown with role:"primary" keeps it, and the one it
    // displaced stays on stage as secondary -- including in the snapshot a
    // reconnecting browser replays.
    let mut projection = DisplayProjection::default();
    let show = |id: &str, object_type: &str, role: Option<&str>| {
        let mut action = json!({"op":"show", "id":id, "type":object_type, "data":{"title":id}});
        if let Some(role) = role {
            action["role"] = json!(role);
        }
        action
    };

    projection.apply(&show("a", "diagram", Some("primary")), 1);
    projection.apply(&show("b", "code", Some("primary")), 2);
    let (_, kind, title, order) = projection.summary();
    assert_eq!(kind.as_deref(), Some("code"));
    assert_eq!(title.as_deref(), Some("b"));
    assert_eq!(order, vec!["a", "b"]);
    let replay = projection.snapshot_actions();
    assert_eq!(replay[0]["role"], "secondary");
    assert_eq!(replay[1]["role"], "primary");

    // An update that names no role leaves the primary where it is.
    projection.apply(&show("a", "diagram", None), 3);
    assert_eq!(projection.summary().1.as_deref(), Some("code"));

    // Re-claiming the role takes it back.
    projection.apply(&show("a", "diagram", Some("primary")), 4);
    assert_eq!(projection.summary().1.as_deref(), Some("diagram"));
    assert_eq!(projection.objects["b"].role.as_deref(), Some("secondary"));
}

#[test]
fn primary_metric_cluster_semantics_and_stable_claim_order() {
    // Primary metric cluster semantics (#38):
    // Metrics claiming primary join each other in a cluster.
    // A non-metric claim demotes all primary metrics.
    // A metric claim while a non-metric holds primary demotes the non-metric.
    // Removing one metric leaves the rest primary.
    // Cluster order is stable by claim order.
    let mut projection = DisplayProjection::default();
    let show_metric = |id: &str, label: &str, role: Option<&str>| {
        let mut action =
            json!({"op":"show", "id":id, "type":"metric", "data":{"label":label, "value":"10"}});
        if let Some(role) = role {
            action["role"] = json!(role);
        }
        action
    };
    let show_other = |id: &str, obj_type: &str, role: Option<&str>| {
        let mut action = json!({"op":"show", "id":id, "type":obj_type, "data":{"title":id}});
        if let Some(role) = role {
            action["role"] = json!(role);
        }
        action
    };

    // 1. Metric A claims primary
    projection.apply(&show_metric("m1", "CPU", Some("primary")), 1);
    assert_eq!(projection.objects["m1"].role.as_deref(), Some("primary"));

    // 2. Metric B claims primary -> joins metric A
    projection.apply(&show_metric("m2", "MEM", Some("primary")), 2);
    assert_eq!(projection.objects["m1"].role.as_deref(), Some("primary"));
    assert_eq!(projection.objects["m2"].role.as_deref(), Some("primary"));

    let (_, kind, title, _) = projection.summary();
    assert_eq!(kind.as_deref(), Some("metric"));
    assert_eq!(title.as_deref(), Some("CPU"));

    let replay = projection.snapshot_actions();
    assert_eq!(replay[0]["role"], "primary");
    assert_eq!(replay[1]["role"], "primary");

    // 3. Updating Metric A data preserves its leading position in claim order
    projection.apply(&show_metric("m1", "CPU", Some("primary")), 3);
    assert_eq!(projection.summary().2.as_deref(), Some("CPU"));

    // 4. Non-metric claims primary -> demotes all primary metrics
    projection.apply(&show_other("diag", "diagram", Some("primary")), 4);
    assert_eq!(projection.objects["diag"].role.as_deref(), Some("primary"));
    assert_eq!(projection.objects["m1"].role.as_deref(), Some("secondary"));
    assert_eq!(projection.objects["m2"].role.as_deref(), Some("secondary"));
    assert_eq!(projection.summary().1.as_deref(), Some("diagram"));

    // 5. Metric claim demotes non-metric primary
    projection.apply(&show_metric("m1", "CPU", Some("primary")), 5);
    assert_eq!(projection.objects["m1"].role.as_deref(), Some("primary"));
    assert_eq!(
        projection.objects["diag"].role.as_deref(),
        Some("secondary")
    );
    assert_eq!(projection.summary().1.as_deref(), Some("metric"));

    // 6. Metric B re-claims primary -> joins M1 at the end
    projection.apply(&show_metric("m2", "MEM", Some("primary")), 6);
    assert_eq!(projection.objects["m1"].role.as_deref(), Some("primary"));
    assert_eq!(projection.objects["m2"].role.as_deref(), Some("primary"));

    // 7. Removing one metric leaves the other primary
    projection.apply(&json!({"op":"hide", "id":"m1"}), 7);
    assert!(!projection.objects.contains_key("m1"));
    assert_eq!(projection.objects["m2"].role.as_deref(), Some("primary"));
    assert_eq!(projection.summary().2.as_deref(), Some("MEM"));
}

/// Each replayed show as `(id, role)`.
fn replay_shape(replay: &[Value]) -> Vec<(&str, Option<&str>)> {
    replay
        .iter()
        .map(|action| {
            (
                action["id"].as_str().unwrap_or_default(),
                action.get("role").and_then(Value::as_str),
            )
        })
        .collect()
}

#[test]
fn snapshot_actions_emits_primary_metrics_in_claim_order_even_if_created_earlier() {
    let mut projection = DisplayProjection::default();
    let show_metric = |id: &str, label: &str, role: Option<&str>| {
        let mut action =
            json!({"op":"show", "id":id, "type":"metric", "data":{"label":label, "value":"10"}});
        if let Some(role) = role {
            action["role"] = json!(role);
        }
        action
    };

    // Show m-sec as secondary, show m-prim as primary, then re-show m-sec claiming primary
    projection.apply(&show_metric("m-sec", "SECONDARY", Some("secondary")), 1);
    projection.apply(&show_metric("m-prim", "PRIMARY", Some("primary")), 2);
    projection.apply(&show_metric("m-sec", "SECONDARY", Some("primary")), 3);

    // Every object is replayed in show order, so a reconnecting browser
    // rebuilds the same agentOrder; m-sec claims the role only after m-prim,
    // so it rebuilds the same cluster order too. The browser test
    // `replaying the backend snapshot rebuilds show order and cluster order`
    // applies exactly this sequence.
    let replay = projection.snapshot_actions();
    assert_eq!(
        replay_shape(&replay),
        vec![
            ("m-sec", None),
            ("m-prim", Some("primary")),
            ("m-sec", Some("primary"))
        ]
    );

    let mut replayed = DisplayProjection::default();
    for (sequence, action) in replay.iter().enumerate() {
        replayed.apply(action, sequence as u64 + 1);
    }
    assert_eq!(replayed.order, projection.order);
    assert_eq!(replayed.snapshot_actions(), replay);
    assert_eq!(replayed.summary(), projection.summary());
}

#[test]
fn snapshot_replay_keeps_show_order_when_claim_order_differs() {
    // A cluster re-claimed in the opposite order to its show order: the
    // replay must not swap the metrics' positions, or a later demotion would
    // lay the rail out differently after a reconnect.
    let mut projection = DisplayProjection::default();
    let show = |id: &str, object_type: &str, role: Option<&str>| {
        let mut action =
            json!({"op":"show", "id":id, "type":object_type, "data":{"label":id, "value":"1"}});
        if let Some(role) = role {
            action["role"] = json!(role);
        }
        action
    };
    projection.apply(&show("m1", "metric", Some("primary")), 1);
    projection.apply(&show("m2", "metric", Some("primary")), 2);
    projection.apply(&show("diag", "diagram", Some("primary")), 3);
    projection.apply(&show("m2", "metric", Some("primary")), 4);
    projection.apply(&show("m1", "metric", Some("primary")), 5);
    assert_eq!(projection.summary().2.as_deref(), Some("m2"));

    // The browser test `replaying the backend snapshot rebuilds show order
    // and cluster order` applies exactly this sequence.
    let replay = projection.snapshot_actions();
    assert_eq!(
        replay_shape(&replay),
        vec![
            ("m1", None),
            ("m2", Some("primary")),
            ("diag", Some("secondary")),
            ("m1", Some("primary")),
        ]
    );
    let mut replayed = DisplayProjection::default();
    for (sequence, action) in replay.iter().enumerate() {
        replayed.apply(action, sequence as u64 + 1);
    }
    assert_eq!(replayed.order, vec!["m1", "m2", "diag"]);
    assert_eq!(replayed.summary(), projection.summary());

    // The same later demotion leaves both projections alike.
    let chart = show("chart", "chart", Some("primary"));
    projection.apply(&chart, 6);
    replayed.apply(&chart, 99);
    assert_eq!(replayed.snapshot_actions(), projection.snapshot_actions());
}

#[test]
fn the_primary_metric_cap_matches_the_browser_reducer() {
    // The browser applies the same cluster rule with its own constant; if
    // the two caps differ, /view and the page disagree on which metrics hold
    // the primary viewport.
    let reducer = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/apps/frontend/src/controller/reducer.ts"
    ))
    .expect("read the browser reducer");
    let declared = reducer.lines().find_map(|line| {
        line.trim()
            .strip_prefix("export const MAX_PRIMARY_METRICS = ")
            .and_then(|rest| rest.trim_end_matches(';').parse::<usize>().ok())
    });
    assert_eq!(declared, Some(MAX_PRIMARY_METRICS));
}

#[test]
fn primary_metric_cluster_is_capped_and_the_earliest_claim_gives_way() {
    let mut projection = DisplayProjection::default();
    let show_metric = |id: &str| json!({"op":"show", "id":id, "type":"metric", "role":"primary", "data":{"label":id, "value":"1"}});
    for n in 0..MAX_PRIMARY_METRICS {
        projection.apply(&show_metric(&format!("m{n}")), n as u64 + 1);
    }
    let primaries = |projection: &DisplayProjection| {
        let mut ids: Vec<String> = projection
            .order
            .iter()
            .filter(|id| projection.objects[*id].role.as_deref() == Some("primary"))
            .cloned()
            .collect();
        ids.sort();
        ids
    };
    assert_eq!(primaries(&projection).len(), MAX_PRIMARY_METRICS);

    // Updating a member of a full cluster evicts nobody.
    projection.apply(&show_metric("m3"), 20);
    assert_eq!(primaries(&projection).len(), MAX_PRIMARY_METRICS);
    assert_eq!(projection.objects["m0"].role.as_deref(), Some("primary"));

    // One more claimant demotes the earliest claim, m0, which stays on stage.
    projection.apply(&show_metric("extra"), 21);
    assert_eq!(primaries(&projection).len(), MAX_PRIMARY_METRICS);
    assert_eq!(projection.objects["m0"].role.as_deref(), Some("secondary"));
    assert_eq!(projection.objects["extra"].role.as_deref(), Some("primary"));
    assert_eq!(projection.summary().2.as_deref(), Some("m1"));
}

#[test]
fn a_primary_that_changes_type_reclaims_the_role_under_its_new_type() {
    let mut projection = DisplayProjection::default();
    let show = |id: &str, object_type: &str, role: Option<&str>| {
        let mut action =
            json!({"op":"show", "id":id, "type":object_type, "data":{"title":id, "label":id}});
        if let Some(role) = role {
            action["role"] = json!(role);
        }
        action
    };
    projection.apply(&show("m1", "metric", Some("primary")), 1);
    projection.apply(&show("m2", "metric", Some("primary")), 2);
    // m1 becomes a chart without naming a role: it keeps primary, and a
    // chart never shares the viewport with the metric cluster.
    projection.apply(&show("m1", "chart", None), 3);
    assert_eq!(projection.objects["m1"].role.as_deref(), Some("primary"));
    assert_eq!(projection.objects["m2"].role.as_deref(), Some("secondary"));
    let (_, kind, title, _) = projection.summary();
    assert_eq!(kind.as_deref(), Some("chart"));
    assert_eq!(title.as_deref(), Some("m1"));
}

#[tokio::test]
async fn display_frames_carry_the_delivery_sequence() {
    let action = json!({"type":"display","action":{"op":"clear"}});
    let stamped = stamp_display_seq(Event::Json(action), 7);
    let Event::Json(value) = stamped else {
        panic!("expected json event")
    };
    assert_eq!(value.get("seq").and_then(Value::as_u64), Some(7));
    assert_eq!(value.get("type").and_then(Value::as_str), Some("display"));

    // Non-display events are untouched.
    let other = stamp_display_seq(Event::Json(json!({"type":"epoch","generation":3})), 9);
    let Event::Json(value) = other else {
        panic!("expected json event")
    };
    assert!(value.get("seq").is_none());
}

#[test]
fn matches_the_shared_display_precedence_fixture() {
    // The precedence rule -- which object is primary, its kind and title, and
    // which ids are visible -- is implemented here and, on purpose, again in
    // the browser's sceneModel.ts (see docs/architecture.md's known
    // non-purity). apps/frontend/tests/unit/displayPrecedence.test.ts checks
    // the browser side against the same cases; a mismatch here means the two
    // have disagreed on what the stage shows.
    let fixtures_str =
        std::fs::read_to_string("apps/frontend/tests/fixtures/display-precedence.json")
            .expect("canonical display-precedence.json fixture must load");
    let fixtures: Value = serde_json::from_str(&fixtures_str).unwrap();

    for case in fixtures["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut projection = DisplayProjection::default();
        for (sequence, action) in case["actions"].as_array().unwrap().iter().enumerate() {
            projection.apply(action, sequence as u64 + 1);
        }
        let (has_visual, kind, title, visible_ids) = projection.summary();
        let expected = &case["expected"];

        assert_eq!(
            has_visual,
            expected["has_visual"].as_bool().unwrap(),
            "has_visual mismatch for case '{name}'"
        );
        assert_eq!(
            kind.as_deref(),
            expected["kind"].as_str(),
            "kind mismatch for case '{name}'"
        );
        assert_eq!(
            title.as_deref(),
            expected["title"].as_str(),
            "title mismatch for case '{name}'"
        );
        let expected_ids: Vec<String> = expected["visible_ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            visible_ids, expected_ids,
            "visible_ids mismatch for case '{name}'"
        );
    }
}

#[test]
fn confirm_state_keeps_the_newest_rejections_until_the_generation_moves() {
    let mut confirm = ConfirmState::default();
    for seq in 0..(MAX_KEPT_REJECTIONS as u64 + 2) {
        confirm.reject(seq, format!("reason {seq}"));
    }
    assert_eq!(confirm.rejection(0), None, "the oldest past the bound goes");
    assert_eq!(confirm.rejection(1), None);
    let newest = MAX_KEPT_REJECTIONS as u64 + 1;
    assert_eq!(confirm.rejection(2), Some("reason 2"));
    assert_eq!(
        confirm.rejection(newest),
        Some(format!("reason {newest}").as_str())
    );
    confirm.begin_generation(4);
    assert_eq!((confirm.generation, confirm.watermark), (4, None));
    assert_eq!(confirm.rejection(newest), None);
}

// The gate's phase x event table (#376, #377). The gate holds, per leg, the
// stage (its objects and the watermark of the newest display applied to it),
// the screen the page last reported (fresh or stale) and what the page has
// confirmed in the current generation. Each step below is one event and the
// change it makes to what the gate's readers see; a field a step does not
// set is unchanged by it.

/// What the gate holds, as its readers see it.
#[derive(Clone, Debug, PartialEq)]
struct Seen {
    leg: Option<(String, u64)>,
    objects: Vec<String>,
    watermark: u64,
    view: String,
    stale: bool,
    confirmed: (u64, Option<u64>),
}

async fn seen(state: &AppState) -> Seen {
    let gate = state.0.display_gate.lock().await;
    let confirm = gate.confirmations.borrow().clone();
    Seen {
        leg: gate
            .scene_leg
            .as_ref()
            .map(|leg| (leg.route.clone(), leg.generation)),
        objects: gate.projection.order.clone(),
        watermark: gate.watermark,
        view: gate.screen.view.clone(),
        stale: gate.screen.stale,
        confirmed: (confirm.generation, confirm.watermark),
    }
}

/// The screen as Jev's routing summary and the floor gate are given it.
async fn screen_json(state: &AppState) -> Value {
    state.0.display_gate.lock().await.screen.to_value()
}

/// The page on `epoch` reports its screen.
async fn report(state: &AppState, epoch: u64, report: Value) {
    let mut frame = report;
    frame["type"] = json!("screen_state");
    handle_text_frame(state, epoch, &mut None, &mut None, &frame.to_string())
        .await
        .unwrap();
}

/// An agent shows a metric while a page is connected: the call waits for the
/// page to confirm it. Returns the call and the display's `seq`.
async fn show_metric(
    state: &AppState,
    page: &mut DeliveryConnection,
    token: &str,
    id: &str,
) -> (tokio::task::JoinHandle<(StatusCode, Value)>, u64) {
    let call = post_display_in_task(
        state,
        json!({"token": token, "action": {"op": "show", "id": id, "type": "metric",
               "data": {"label": id, "value": "1"}}}),
    )
    .await;
    let frames = frames_until(page, "display").await;
    let seq = frames.last().unwrap()["seq"].as_u64().unwrap();
    (call, seq)
}

async fn assert_rendered(call: tokio::task::JoinHandle<(StatusCode, Value)>) {
    let (code, body) = within("the display call", call).await.unwrap();
    assert_eq!((code, &body["rendered"]), (StatusCode::OK, &json!(true)));
}

#[tokio::test]
async fn the_gate_moves_through_its_phases_one_event_at_a_time() {
    let state = state();
    let mut want = Seen {
        leg: None,
        objects: vec![],
        watermark: 0,
        view: "auto".into(),
        stale: false,
        confirmed: (0, None),
    };
    assert_eq!(seen(&state).await, want, "the gate a call starts with");
    assert_eq!(
        screen_json(&state).await,
        json!({"view": "auto", "pinned": false, "has_visual": false, "visual_kind": null,
               "object_ids": [], "title": "", "stale": false, "generation": 0}),
        "the screen before any page reports"
    );

    // No leg announced yet: the operator's stage at generation 0.
    let (mut first, _, _) = state.register_connection().await;
    want.stale = true;
    assert_eq!(seen(&state).await, want, "a page connects");

    let (call, seq) = show_metric(&state, &mut first, OPERATOR, "m1").await;
    want.objects = vec!["m1".into()];
    want.watermark = seq;
    assert_eq!(seen(&state).await, want, "a display is applied");

    report(
        &state,
        first.epoch,
        json!({"view": "visual", "has_visual": true, "visual_kind": "metric",
               "object_ids": ["m1"], "title": "m1", "generation": 0, "applied_seq": seq}),
    )
    .await;
    assert_rendered(call).await;
    want.view = "visual".into();
    want.stale = false;
    want.confirmed = (0, Some(seq));
    assert_eq!(seen(&state).await, want, "the active page reports");
    assert_eq!(
        screen_json(&state).await,
        json!({"view": "visual", "pinned": false, "has_visual": true, "visual_kind": "metric",
               "object_ids": ["m1"], "title": "m1", "stale": false, "generation": 0}),
        "the screen as the page reported it"
    );

    for ignored in [
        json!({"view": "theater", "generation": 999, "applied_seq": seq + 5}),
        json!({"view": "theater", "applied_seq": seq + 5}),
    ] {
        report(&state, first.epoch, ignored.clone()).await;
        assert_eq!(seen(&state).await, want, "ignored: {ignored}");
    }

    let (mut second, _, _) = state.register_connection().await;
    want.stale = true;
    assert_eq!(seen(&state).await, want, "a second page connects");

    report(
        &state,
        first.epoch,
        json!({"view": "comms", "generation": 0}),
    )
    .await;
    assert_eq!(
        seen(&state).await,
        want,
        "the page that is not active reports"
    );

    report(
        &state,
        second.epoch,
        json!({"view": "theater", "generation": 0}),
    )
    .await;
    want.view = "theater".into();
    want.stale = false;
    assert_eq!(
        seen(&state).await,
        want,
        "the active page reports, confirming nothing"
    );

    state.retire_connection(first.epoch).await;
    assert_eq!(
        seen(&state).await,
        want,
        "the page that is not active retires"
    );

    // The first announcement of the leg on the line resets the stage. The
    // watermark stays: sequences are the delivery's, not the leg's.
    state.0.leg_announcer.announce_route().await;
    want.leg = Some((OPERATOR.into(), 0));
    want.objects = vec![];
    want.stale = true;
    want.confirmed = (0, None);
    assert_eq!(seen(&state).await, want, "the leg on the line is announced");

    let (call, seq) = show_metric(&state, &mut second, OPERATOR, "m2").await;
    report(
        &state,
        second.epoch,
        json!({"view": "visual", "generation": 0, "applied_seq": seq}),
    )
    .await;
    assert_rendered(call).await;
    want.objects = vec!["m2".into()];
    want.watermark = seq;
    want.view = "visual".into();
    want.stale = false;
    want.confirmed = (0, Some(seq));
    assert_eq!(seen(&state).await, want, "a display on the announced leg");

    state.0.leg_announcer.announce_route().await;
    assert_eq!(seen(&state).await, want, "the same leg is announced again");

    // A rescue moves the generation without announcing a leg: the gate is
    // left alone until the page reports at the new generation, which starts
    // that generation's confirmations.
    let rescue = state.0.coordinator.begin_rescue("a table row");
    state.0.coordinator.settle(rescue);
    let rescued = state.0.coordinator.generation();
    assert_eq!(seen(&state).await, want, "a rescue");
    report(
        &state,
        second.epoch,
        json!({"view": "visual", "generation": rescued}),
    )
    .await;
    want.confirmed = (rescued, None);
    assert_eq!(
        seen(&state).await,
        want,
        "the page reports at the rescued generation"
    );

    // A background agent's held scene is replayed into the stage of the leg
    // that brings it forward, each action sequenced like a live show.
    state
        .0
        .coordinator
        .register_background("alpha", "background-token");
    let (code, held) = agent_call_json(
        &state,
        "/display",
        json!({"token": "background-token", "action": {"op": "show", "id": "h1",
               "type": "metric", "data": {"label": "h1", "value": "1"}}}),
    )
    .await;
    assert_eq!((code, &held["held"]), (StatusCode::OK, &json!(true)));
    assert_eq!(
        seen(&state).await,
        want,
        "a background agent's display is held"
    );

    begin_alpha_candidate(&state, "alpha-leg");
    assert!(state.0.leg_announcer.promote_candidate("alpha-leg").await);
    let replayed = frames_until(&mut second, "display").await;
    let alpha = state.0.coordinator.generation();
    want.leg = Some(("alpha".into(), alpha));
    want.objects = vec!["h1".into()];
    want.watermark = replayed.last().unwrap()["seq"].as_u64().unwrap();
    want.stale = true;
    want.confirmed = (alpha, None);
    assert_eq!(seen(&state).await, want, "a transfer's leg is announced");

    state.retire_connection(second.epoch).await;
    assert_eq!(
        seen(&state).await,
        want,
        "the active page retires, already stale"
    );
    let (third, _, _) = state.register_connection().await;
    report(
        &state,
        third.epoch,
        json!({"view": "visual", "generation": alpha}),
    )
    .await;
    want.stale = false;
    assert_eq!(seen(&state).await, want, "a new page reports");
    state.retire_connection(third.epoch).await;
    want.stale = true;
    assert_eq!(seen(&state).await, want, "the active page retires");

    // Returning to the operator keeps the generation and changes the route.
    state.0.leg_announcer.announce_route().await;
    assert_eq!(
        seen(&state).await,
        want,
        "the transfer settles on the leg already announced"
    );
    assert_eq!(
        state.0.switchboard.lock().await.force_hangup().await,
        Some("alpha".to_owned())
    );
    want.leg = Some((OPERATOR.into(), alpha));
    want.objects = vec![];
    assert_eq!(
        seen(&state).await,
        want,
        "the caller returns to the operator"
    );
}
