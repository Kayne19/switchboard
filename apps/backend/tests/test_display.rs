use super::*;

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
