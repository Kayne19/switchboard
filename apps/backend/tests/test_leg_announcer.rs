use crate::api::{
    begin_alpha_candidate, frames_until, handle_text_frame, queued_frames, state, types_of,
    AppState,
};
use crate::module_calls::{agent_call_json, diagram_show, post_display_in_task};
use crate::pbx::OPERATOR;
use crate::pi_client::Activity;
use axum::http::StatusCode;
use serde_json::json;
use tokio::time::{timeout, Duration};

#[tokio::test]
async fn display_projection_route_reset() {
    let state = state();

    // Populate projection with objects, focus, speech
    let show = json!({
        "token": "operator",
        "action": {
            "op": "show",
            "id": "scene-obj",
            "type": "metric",
            "role": "primary",
            "data": {"label": "v", "value": "1"}
        }
    });
    let (code, _) = agent_call_json(&state, "/display", show).await;
    assert_eq!(code, StatusCode::OK);

    let focus = json!({
        "token": "operator",
        "action": {"op": "focus", "id": "scene-obj"}
    });
    let (code, _) = agent_call_json(&state, "/display", focus).await;
    assert_eq!(code, StatusCode::OK);

    // Check that projection is populated
    {
        let gate = state.0.display_gate.lock().await;
        assert_eq!(gate.projection.order.len(), 1);
        assert_eq!(gate.projection.focus_id.as_deref(), Some("scene-obj"));
    }

    // Trigger route reset by invoking announce_route on switchboard
    state.0.switchboard.lock().await.announce_route().await;

    // Verify projection is empty and snapshot returns empty
    {
        let gate = state.0.display_gate.lock().await;
        assert!(gate.projection.objects.is_empty());
        assert!(gate.projection.order.is_empty());
        assert_eq!(gate.projection.focus_id, None);
        assert!(gate.projection.speech.is_none());
        assert_eq!(gate.screen_state["stale"], true);
        assert!(gate.projection.snapshot_actions().is_empty());
    }
}

// A transfer is announced twice: when the incoming agent first shows life or
// acts (candidate promotion), and when the PBX settles the transfer after the
// intro turn (the route callback). Only the first may reset the caller's
// screen. The second used to reset it again, wiping whatever the new agent had
// already drawn and cutting off its first words (issue #22).

#[tokio::test]
async fn a_first_display_from_the_incoming_leg_survives_the_transfer_settling() {
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    begin_alpha_candidate(&state, "alpha-leg");

    // The incoming agent's first act is a drawing, which promotes its leg.
    let mut show = diagram_show();
    show["token"] = json!("alpha-leg");
    let handle = post_display_in_task(&state, show).await;
    let frames = frames_until(&mut connection, "display").await;
    assert_eq!(
        types_of(&frames),
        [
            "candidate",
            "candidate_cleared",
            "epoch",
            "status",
            "display"
        ]
    );
    let generation = frames[2]["generation"].as_u64().unwrap();
    assert_eq!(generation, 1);

    handle_text_frame(
        &state,
        connection.epoch,
        &mut None,
        &mut None,
        &json!({"type":"screen_state","view":"auto","has_visual":true,
               "visual_kind":"diagram","generation":generation,
               "applied_seq":frames[4]["seq"]})
        .to_string(),
    )
    .await
    .unwrap();
    let (_code, body) = timeout(Duration::from_secs(2), handle)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(body["rendered"], true);
    assert_eq!(
        types_of(&queued_frames(&mut connection)),
        ["screen_state_ack"]
    );

    // The intro turn ends and the PBX settles on the leg already on screen.
    settle_transfer(&state).await;

    assert_eq!(
        types_of(&queued_frames(&mut connection)),
        ["status"],
        "settling an announced leg must not reset the screen again"
    );
    assert!(state
        .0
        .display_gate
        .lock()
        .await
        .projection
        .objects
        .contains_key("d1"));
    let (_code, view) = agent_call_json(&state, "/view", json!({"token":"alpha-leg"})).await;
    assert_eq!(view["screen"]["has_visual"], true);
    assert_eq!(view["screen"]["confirmed"], true);
}

#[tokio::test]
async fn the_incoming_legs_first_words_are_not_cut_off_by_the_transfer_settling() {
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    begin_alpha_candidate(&state, "alpha-leg");

    // The agent's first streamed text is the sign of life that promotes it,
    // and it may already be speaking when the intro turn ends.
    assert!(state.0.leg_announcer.promote_candidate("alpha-leg").await);
    assert_eq!(
        types_of(&queued_frames(&mut connection)),
        ["candidate", "candidate_cleared", "epoch", "status"]
    );

    // A second epoch would make the browser drop that speech and the words on
    // screen with it.
    settle_transfer(&state).await;
    assert_eq!(types_of(&queued_frames(&mut connection)), ["status"]);
}

#[tokio::test]
async fn returning_to_the_operator_still_clears_the_project_scene() {
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    begin_alpha_candidate(&state, "alpha-leg");
    let mut show = diagram_show();
    show["token"] = json!("alpha-leg");
    let handle = post_display_in_task(&state, show).await;
    frames_until(&mut connection, "display").await;
    handle.abort();
    settle_transfer(&state).await;
    queued_frames(&mut connection);

    // Handing back keeps the generation and changes the route. Hanging up the
    // project leg is the shortest way there.
    assert_eq!(
        state.0.switchboard.lock().await.force_hangup().await,
        Some("alpha".to_owned())
    );

    let returned = queued_frames(&mut connection);
    assert_eq!(types_of(&returned), ["epoch", "status"]);
    assert_eq!(returned[0]["generation"], 1);
    assert_eq!(returned[1]["route"], OPERATOR);
    assert!(state
        .0
        .display_gate
        .lock()
        .await
        .projection
        .objects
        .is_empty());
}

#[tokio::test]
async fn activity_from_a_leg_retired_by_a_rescue_is_not_published() {
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    begin_alpha_candidate(&state, "alpha-leg");
    assert!(state.0.leg_announcer.promote_candidate("alpha-leg").await);
    queued_frames(&mut connection);

    state
        .0
        .leg_announcer
        .on_activity(activity_from("alpha-leg", "start"))
        .await;
    assert_eq!(types_of(&queued_frames(&mut connection)), ["activity"]);

    // The rescue retires the leg before its process is reaped, and a tool
    // call it reports in that window must not reach the page.
    state.0.coordinator.begin_rescue("page rescue");
    state
        .0
        .leg_announcer
        .on_activity(activity_from("alpha-leg", "end"))
        .await;
    assert!(queued_frames(&mut connection).is_empty());
    state.0.coordinator.settle();
    state
        .0
        .leg_announcer
        .on_activity(activity_from("alpha-leg", "start"))
        .await;
    assert!(queued_frames(&mut connection).is_empty());
}

#[tokio::test]
async fn activity_from_a_process_that_is_not_the_candidate_does_not_promote_it() {
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    begin_alpha_candidate(&state, "alpha-leg");
    assert_eq!(types_of(&queued_frames(&mut connection)), ["candidate"]);

    // Neither the operator nor a stray process is the incoming leg, whatever
    // it reports.
    for leg in [OPERATOR, "beta-leg"] {
        state
            .0
            .leg_announcer
            .on_activity(activity_from(leg, "life"))
            .await;
    }
    assert_eq!(
        state
            .0
            .coordinator
            .candidate_identity()
            .map(|leg| leg.token),
        Some("alpha-leg".to_owned())
    );
    assert_eq!(state.0.coordinator.route(), OPERATOR);
    assert!(queued_frames(&mut connection).is_empty());

    // The operator is still on the line: its own tool calls are shown, and
    // they promote nothing.
    state
        .0
        .leg_announcer
        .on_activity(activity_from(OPERATOR, "start"))
        .await;
    assert_eq!(types_of(&queued_frames(&mut connection)), ["activity"]);
    assert!(state.0.coordinator.candidate_identity().is_some());

    // The candidate's own first sign of life adopts it.
    state
        .0
        .leg_announcer
        .on_activity(activity_from("alpha-leg", "life"))
        .await;
    assert_eq!(
        types_of(&queued_frames(&mut connection)),
        ["candidate_cleared", "epoch", "status"]
    );
    assert_eq!(state.0.coordinator.route(), "alpha");
}

/// The PBX finishing a transfer to the leg the coordinator already holds.
async fn settle_transfer(state: &AppState) {
    state.0.leg_announcer.announce_route().await;
}

/// RPC activity as the pi process started for `leg` reports it.
fn activity_from(leg: &str, state: &str) -> Activity {
    Activity {
        state: state.into(),
        tool: if state == "life" { "" } else { "bash" }.into(),
        detail: String::new(),
        label: "alpha".into(),
        leg: leg.into(),
    }
}
