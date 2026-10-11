use super::*;
use crate::browser::{frames_until, types_of};
use crate::delivery::Event;
use crate::module_calls::diagram_show;
use crate::page_controls::cancel_active_operations;
use crate::pbx::AgentStateNotice;
use crate::project_session::AgentCall;
use crate::protocol::AgentRequest;
use serde_json::Value;
use tokio::time::{timeout, Duration};

#[tokio::test]
async fn generation_mismatch_prevents_turn_spawn() {
    let state = state();
    let current = state.0.coordinator.generation();
    state.0.coordinator.begin_rescue("test bump");
    let result = spawn_registered_operation(&state, current, async move { 42 }).await;
    assert!(result.is_none());
}

#[tokio::test]
async fn shutdown_notifies_upgraded_connections_before_reaping_the_pbx() {
    let state = state();
    let mut shutdown_notice = state.0.shutdown.subscribe();
    timeout(Duration::from_secs(1), shutdown(&state))
        .await
        .expect("shutdown should finish without a live leg");
    timeout(Duration::from_secs(1), shutdown_notice.changed())
        .await
        .expect("websocket shutdown notice should be immediate")
        .unwrap();
    assert!(*shutdown_notice.borrow());
}

// Issue #70: the browser carries speech recorded while a leg was connecting
// to the next epoch only when that leg was adopted, so the clear notice must
// say which way the candidate ended.
#[tokio::test]
async fn the_candidate_clear_notice_says_how_the_candidate_ended() {
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    begin_alpha_candidate(&state, "alpha-leg");
    let frames = frames_until(&mut connection, "candidate").await;
    assert_eq!(frames.last().unwrap()["route"], "alpha");

    // A hangup while connecting: the clear notice comes first, then the epoch.
    cancel_active_operations(&state).await;
    let frames = frames_until(&mut connection, "epoch").await;
    assert_eq!(types_of(&frames), ["candidate_cleared", "epoch"]);
    assert_eq!(frames[0]["reason"], "rescued");
    assert_eq!(
        frames[0]["route"], "alpha",
        "it names the leg that was starting"
    );

    begin_alpha_candidate(&state, "alpha-leg-2");
    frames_until(&mut connection, "candidate").await;
    assert!(state.0.leg_announcer.promote_candidate("alpha-leg-2").await);
    let frames = frames_until(&mut connection, "epoch").await;
    assert_eq!(types_of(&frames), ["candidate_cleared", "epoch"]);
    assert_eq!(frames[0]["reason"], "adopted");
    assert_eq!(frames[0]["route"], "alpha");
    assert_eq!(frames[0]["generation"], frames[1]["generation"]);
}

#[tokio::test]
async fn stopping_a_background_agent_discards_its_held_display() {
    let state = state();
    state
        .0
        .coordinator
        .register_background("alpha", "background-token");
    assert_lifecycle_consistent(&state).await;
    let held = module_call(
        &state,
        AgentCall {
            call: "display".into(),
            token: "background-token".into(),
            turn_id: None,
            cause: None,
            args: diagram_show(),
        },
    )
    .await;
    assert_eq!(held["status"], "accepted");
    assert!(state
        .0
        .projection
        .displays
        .lock()
        .unwrap()
        .contains_key("alpha"));

    update_agent_state(
        &state,
        AgentStateNotice {
            project: "alpha".into(),
            state: AgentNotice::Finished,
        },
    )
    .await;
    assert!(!state
        .0
        .projection
        .displays
        .lock()
        .unwrap()
        .contains_key("alpha"));
    assert_lifecycle_consistent(&state).await;
}

#[tokio::test]
async fn failed_promotion_finished_notice_clears_the_held_display_projection() {
    let state = state();
    state
        .0
        .coordinator
        .register_background("alpha", "background-token");
    assert_lifecycle_consistent(&state).await;
    let held = module_call(
        &state,
        AgentCall {
            call: "display".into(),
            token: "background-token".into(),
            turn_id: None,
            cause: None,
            args: diagram_show(),
        },
    )
    .await;
    assert_eq!(held["status"], "accepted");

    // This is the projection side of a failed promotion: PBX's terminal
    // `finished` owner notice must release the resident's held scene.
    update_agent_state(
        &state,
        AgentStateNotice {
            project: "alpha".into(),
            state: AgentNotice::Finished,
        },
    )
    .await;
    assert!(state
        .0
        .projection
        .displays
        .lock()
        .unwrap()
        .get("alpha")
        .is_none());
    assert_lifecycle_consistent(&state).await;
}

#[cfg(unix)]
#[tokio::test]
async fn agents_state_publishes_idle_after_turn_and_finished_after_hangup() {
    let root = scratch_root("agents-state-lifecycle");
    let state = state_with_agents(&root);
    let mut events = state.0.events.subscribe();
    let context = crate::pbx::TransferContext {
        exact_caller_transcript: "put me through to alpha".into(),
        ..Default::default()
    };
    let reply = state
        .0
        .switchboard
        .lock()
        .await
        .transfer_to(&context, "alpha")
        .await;
    assert_eq!(reply.route, "alpha");
    assert_lifecycle_consistent(&state).await;
    let agents = state.0.projection.snapshot();
    assert_eq!(
        agents
            .iter()
            .find(|agent| agent.project == "alpha")
            .map(|agent| agent.state.as_str()),
        Some("idle")
    );
    let lifecycle_events: Vec<Value> = std::iter::from_fn(|| events.try_recv().ok())
        .filter_map(|event| match event {
            Event::Json(value) if value["type"] == "agents_state" => Some(value),
            _ => None,
        })
        .collect();
    assert!(lifecycle_events
        .iter()
        .any(|event| event["agents"][0]["state"] == "busy"));
    assert!(lifecycle_events
        .iter()
        .any(|event| event["agents"][0]["state"] == "idle"));

    state.0.switchboard.lock().await.force_hangup().await;
    assert_lifecycle_consistent(&state).await;
    assert_eq!(state.0.projection.snapshot()[0].state, "finished");
    assert!(std::iter::from_fn(|| events.try_recv().ok()).any(|event| {
        matches!(event, Event::Json(value) if value["type"] == "agents_state" && value["agents"][0]["state"] == "finished")
    }));
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

/// What moves the agent projection, as the PBX and the floor send it.
#[derive(Clone, Copy, Debug)]
enum ProjectionEvent {
    Busy,
    Idle,
    Finished,
    /// The floor queued a request with this message (`Waiting::Asked`).
    Asked(&'static str),
    /// The floor spoke the agent's last request (`Waiting::Spoken`).
    Spoken,
}

fn apply_projection_event(projection: &AgentProjection, event: ProjectionEvent) {
    let notice = |state: AgentNotice| AgentStateNotice {
        project: "alpha".into(),
        state,
    };
    let _change = match event {
        ProjectionEvent::Busy => projection.notice(&notice(AgentNotice::Busy)),
        ProjectionEvent::Idle => projection.notice(&notice(AgentNotice::Idle)),
        ProjectionEvent::Finished => projection.notice(&notice(AgentNotice::Finished)),
        ProjectionEvent::Asked(message) => projection.waiting(
            "alpha".into(),
            AgentRequest {
                message: message.into(),
                reason: "finished".into(),
            },
        ),
        ProjectionEvent::Spoken => projection.floor_released("alpha"),
    };
}

/// The agent projection's phase x event table: the phase the page shows
/// for a resident after each event, the request it shows as waiting, and
/// whether the agent's held display survives. `None` is an agent the page
/// does not list. Row (`waiting`, `busy`) is the projection half of #388:
/// a busy notice ends the waiting mark while the floor still holds the
/// request.
#[tokio::test]
async fn the_agent_projection_moves_by_its_table() {
    use ProjectionEvent::{Asked, Busy, Finished, Idle, Spoken};
    type Row = (
        &'static [ProjectionEvent],
        ProjectionEvent,
        Option<&'static str>,
        Option<&'static str>,
    );
    let rows: &[Row] = &[
        // (to reach the phase, event, phase after, waiting request after)
        (&[], Busy, Some("busy"), None),
        (&[], Idle, Some("idle"), None),
        (&[], Finished, Some("finished"), None),
        (&[], Asked("first"), Some("waiting"), Some("first")),
        (&[], Spoken, None, None),
        (&[Busy], Busy, Some("busy"), None),
        (&[Busy], Idle, Some("idle"), None),
        (&[Busy], Finished, Some("finished"), None),
        (&[Busy], Asked("first"), Some("waiting"), Some("first")),
        (&[Busy], Spoken, Some("busy"), None),
        (&[Idle], Busy, Some("busy"), None),
        (&[Idle], Idle, Some("idle"), None),
        (&[Idle], Finished, Some("finished"), None),
        (&[Idle], Asked("first"), Some("waiting"), Some("first")),
        (&[Idle], Spoken, Some("idle"), None),
        (&[Asked("first")], Busy, Some("busy"), None),
        (&[Asked("first")], Idle, Some("waiting"), Some("first")),
        (&[Asked("first")], Finished, Some("finished"), None),
        (
            &[Asked("first")],
            Asked("second"),
            Some("waiting"),
            Some("second"),
        ),
        (&[Asked("first")], Spoken, Some("idle"), None),
        (&[Finished], Busy, Some("busy"), None),
        (&[Finished], Idle, Some("idle"), None),
        (&[Finished], Finished, Some("finished"), None),
        (&[Finished], Asked("first"), Some("waiting"), Some("first")),
        (&[Finished], Spoken, Some("finished"), None),
    ];
    for &(reach, event, phase, request) in rows {
        let state = state();
        let projection = state.0.projection.clone();
        for &step in reach {
            apply_projection_event(&projection, step);
        }
        projection
            .hold_display("alpha".into(), &diagram_show()["action"])
            .expect("the held stage takes a diagram");
        apply_projection_event(&projection, event);

        let agents = projection.snapshot();
        let alpha = agents.iter().find(|agent| agent.project == "alpha");
        let row = format!("{reach:?} then {event:?}");
        assert_eq!(alpha.map(|agent| agent.state.as_str()), phase, "{row}");
        assert_eq!(
            alpha.and_then(|agent| agent.pending_request.as_ref().map(|r| r.message.as_str())),
            request,
            "{row}"
        );
        assert_eq!(
            projection.has_held_display("alpha"),
            !matches!(event, Finished),
            "{row}: only a finished notice drops the held display"
        );
    }
}

/// The projection lists its agents by project, whatever order they came in.
#[tokio::test]
async fn the_agent_projection_lists_agents_by_project() {
    let state = state();
    let projection = state.0.projection.clone();
    for project in ["gamma", "alpha", "beta"] {
        let _change = projection.notice(&AgentStateNotice {
            project: project.into(),
            state: AgentNotice::Busy,
        });
    }
    let _change = projection.waiting(
        "delta".into(),
        AgentRequest {
            message: "done".into(),
            reason: "finished".into(),
        },
    );
    let projects: Vec<String> = projection
        .snapshot()
        .into_iter()
        .map(|agent| agent.project)
        .collect();
    assert_eq!(projects, ["alpha", "beta", "delta", "gamma"]);
}
