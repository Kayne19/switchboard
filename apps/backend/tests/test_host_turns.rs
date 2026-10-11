use super::*;
use crate::app_state::{debug_events, scratch_root, state_with_agents};
use crate::delivery::Event;
use crate::module_calls::{diagram_show, module_call};
use crate::project_session::AgentCall;
use crate::turns::foreground_alpha_turn;
use serde_json::json;

#[cfg(unix)]
#[tokio::test]
async fn autonomous_turn_loses_to_caller_operation_and_its_side_effects_are_refused() {
    let root = scratch_root("autonomous-loses");
    let state = state_with_agents(&root);
    let (token, instance_id) = foreground_alpha_turn(&state).await;
    let operation = state
        .0
        .coordinator
        .begin_prompt(&state.0.coordinator.current_identity())
        .unwrap();
    handle_project_turn(
        &state,
        autonomous_turn(token.clone(), instance_id, Some("auto-loses")),
    )
    .await;
    let speak = module_call(
        &state,
        AgentCall {
            call: "speak".into(),
            token: token.clone(),
            turn_id: Some("auto-loses".into()),
            cause: Some("autonomous".into()),
            args: json!({"text":"must not speak"}),
        },
    )
    .await;
    assert_eq!(speak["status"], "refused");
    assert!(speak["reason"]
        .as_str()
        .unwrap()
        .contains("no switchboard turn"));
    let display = module_call(
        &state,
        AgentCall {
            call: "display".into(),
            token: token.clone(),
            turn_id: Some("auto-loses".into()),
            cause: Some("autonomous".into()),
            args: diagram_show(),
        },
    )
    .await;
    assert_eq!(display["status"], "refused");
    assert!(display["reason"]
        .as_str()
        .unwrap()
        .contains("no switchboard turn"));
    assert!(state
        .0
        .coordinator
        .accept_side_effect(&token, None, None)
        .is_ok());
    assert!(state.0.coordinator.finish_operation(&operation));
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn delayed_old_autonomous_call_is_refused_after_a_new_caller_operation() {
    let root = scratch_root("autonomous-stale-call");
    let state = state_with_agents(&root);
    let (token, instance_id) = foreground_alpha_turn(&state).await;
    handle_project_turn(
        &state,
        autonomous_turn(token.clone(), instance_id, Some("auto-old")),
    )
    .await;
    handle_project_turn(
        &state,
        ProjectTurn {
            instance_id,
            token: token.clone(),
            turn_id: Some("auto-old".into()),
            cause: "autonomous".into(),
            ended: true,
            text: String::new(),
        },
    )
    .await;
    let operation = state
        .0
        .coordinator
        .begin_prompt(&state.0.coordinator.current_identity())
        .unwrap();
    let stale = module_call(
        &state,
        AgentCall {
            call: "speak".into(),
            token,
            turn_id: Some("auto-old".into()),
            cause: Some("autonomous".into()),
            args: json!({"text":"late"}),
        },
    )
    .await;
    assert_eq!(stale["status"], "refused");
    assert!(stale["reason"]
        .as_str()
        .unwrap()
        .contains("no switchboard turn"));
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
    assert!(state.0.coordinator.finish_operation(&operation));
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn old_host_self_wake_is_refused_but_legacy_caller_calls_still_work() {
    let root = scratch_root("autonomous-legacy-host");
    let state = state_with_agents(&root);
    let (token, instance_id) = foreground_alpha_turn(&state).await;
    handle_project_turn(&state, autonomous_turn(token.clone(), instance_id, None)).await;
    let operation = state
        .0
        .coordinator
        .begin_prompt(&state.0.coordinator.current_identity())
        .unwrap();
    let stale = module_call(
        &state,
        AgentCall {
            call: "speak".into(),
            token: token.clone(),
            turn_id: None,
            cause: Some("autonomous".into()),
            args: json!({"text":"legacy self wake"}),
        },
    )
    .await;
    assert_eq!(stale["status"], "refused");
    assert!(stale["reason"]
        .as_str()
        .unwrap()
        .contains("no switchboard turn"));
    let legacy_display = module_call(
        &state,
        AgentCall {
            call: "display".into(),
            token,
            turn_id: None,
            cause: None,
            args: diagram_show(),
        },
    )
    .await;
    assert_eq!(legacy_display["status"], "accepted");
    assert!(state.0.coordinator.finish_operation(&operation));
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn an_autonomous_project_turn_is_traced_with_its_host_turn_id() {
    use crate::debug::DebugEvent;
    let root = scratch_root("autonomous-traced");
    let state = state_with_agents(&root);
    let (token, instance_id) = foreground_alpha_turn(&state).await;
    let generation = state.0.coordinator.generation();
    handle_project_turn(
        &state,
        autonomous_turn(token.clone(), instance_id, Some("auto-7")),
    )
    .await;
    handle_project_turn(
        &state,
        ProjectTurn {
            ended: true,
            ..autonomous_turn(token, instance_id, Some("auto-7"))
        },
    )
    .await;

    let turns: Vec<_> = debug_events(&state)
        .into_iter()
        .filter(|event| {
            matches!(
                event,
                DebugEvent::TurnStart { .. } | DebugEvent::TurnEnd { .. }
            )
        })
        .collect();
    assert_eq!(
        turns,
        vec![
            DebugEvent::TurnStart {
                agent: "alpha".into(),
                turn_id: "auto-7".into(),
                generation,
                utterance_id: None,
            },
            DebugEvent::TurnEnd {
                agent: "alpha".into(),
                turn_id: "auto-7".into(),
                generation,
                utterance_id: None,
            },
        ]
    );
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

// A host-reported turn, report by phase (#393, the application's side).
//
// The pump reports a project session's turn boundaries to the application
// (`handle_project_turn`). Each row puts the leg on the line in one phase,
// lands one report from alpha's session, and records what the application
// did: whether it admitted the report as a self-woken operation, the
// operation open on the line after it, the turns it traced, and the written
// reply the page was sent.
//
// Phases: `Idle` (alpha at rest), `Caller` (a caller operation, its host turn
// not yet bound), `CallerBound` (bound to `turn-c`), `SelfWoken` (alpha's
// `auto-1` admitted), `SelfWokenElsewhere` (`auto-1` admitted for another
// session instance), `SelfWokenRescued` (then a rescue and its settle),
// `SelfWokenReturned` (then the caller went back to the operator).
//
// Reports, all from alpha's session with alpha's token unless named:
// `CallerStart`/`CallerEnd` (`input`, `turn-c`), `SelfWokenStart`
// (`autonomous`, `auto-2`), `LegacyStart` (`autonomous`, no turn id),
// `ReconnectStart` (`unknown`, `auto-2`), `OtherCauseStart` (`schedule`,
// `auto-2`), `StaleStart` (`autonomous`, `auto-2`, another token), `RunEnd`
// (`autonomous` ended, `auto-1`, "Done."), `SilentRunEnd` (the same with no
// text), `OtherRunEnd` (`auto-9`), `ReconnectRunEnd` (`unknown` ended,
// `auto-1`, "Done.").

#[derive(Clone, Copy, Debug)]
enum HostPhase {
    Idle,
    Caller,
    CallerBound,
    SelfWoken,
    SelfWokenElsewhere,
    SelfWokenRescued,
    SelfWokenReturned,
}

#[derive(Clone, Copy, Debug)]
enum HostReport {
    CallerStart,
    CallerEnd,
    SelfWokenStart,
    LegacyStart,
    ReconnectStart,
    OtherCauseStart,
    StaleStart,
    RunEnd,
    SilentRunEnd,
    OtherRunEnd,
    ReconnectRunEnd,
}

/// What the application did with one report.
#[derive(Clone, Debug, PartialEq)]
struct HostOutcome {
    /// `handle_project_turn`'s answer: a self-woken start was admitted.
    admitted: bool,
    /// The operation open on the line after the report: `none`, or
    /// `caller`/`self-woken` with its host turn id (`-` for none).
    open: String,
    /// The turns traced on the debug page: `start`/`end`, agent, turn id.
    trace: Vec<String>,
    /// The written reply the page was sent: route, then text.
    reply: Option<String>,
}

fn host_outcome(admitted: bool, open: &str, trace: &[&str], reply: Option<&str>) -> HostOutcome {
    HostOutcome {
        admitted,
        open: open.to_owned(),
        trace: trace.iter().map(|line| (*line).to_owned()).collect(),
        reply: reply.map(str::to_owned),
    }
}

fn host_report(
    token: &str,
    instance_id: u64,
    cause: &str,
    turn_id: Option<&str>,
    ended: bool,
    text: &str,
) -> ProjectTurn {
    ProjectTurn {
        instance_id,
        token: token.to_owned(),
        turn_id: turn_id.map(str::to_owned),
        cause: cause.to_owned(),
        ended,
        text: text.to_owned(),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_host_reported_turn_moves_by_its_table() {
    use HostPhase::*;
    use HostReport::*;
    let none = host_outcome(false, "none", &[], None);
    let caller = host_outcome(false, "caller -", &[], None);
    let bound = host_outcome(false, "caller turn-c", &[], None);
    let held = host_outcome(false, "self-woken auto-1", &[], None);
    let table = [
        (Idle, CallerStart, none.clone()),
        (Idle, CallerEnd, none.clone()),
        (
            Idle,
            SelfWokenStart,
            host_outcome(true, "self-woken auto-2", &["start alpha auto-2"], None),
        ),
        (Idle, LegacyStart, none.clone()),
        (Idle, ReconnectStart, none.clone()),
        (Idle, OtherCauseStart, none.clone()),
        (Idle, StaleStart, none.clone()),
        (Idle, RunEnd, none.clone()),
        (Idle, SilentRunEnd, none.clone()),
        (Idle, OtherRunEnd, none.clone()),
        (Idle, ReconnectRunEnd, none.clone()),
        (Caller, CallerStart, bound.clone()),
        (Caller, CallerEnd, caller.clone()),
        (Caller, SelfWokenStart, caller.clone()),
        (Caller, LegacyStart, caller.clone()),
        (Caller, ReconnectStart, caller.clone()),
        (Caller, OtherCauseStart, caller.clone()),
        (Caller, StaleStart, caller.clone()),
        (Caller, RunEnd, caller.clone()),
        (Caller, SilentRunEnd, caller.clone()),
        (Caller, OtherRunEnd, caller.clone()),
        (Caller, ReconnectRunEnd, caller.clone()),
        (CallerBound, CallerStart, bound.clone()),
        (CallerBound, CallerEnd, none.clone()),
        (CallerBound, SelfWokenStart, bound.clone()),
        (CallerBound, LegacyStart, bound.clone()),
        (CallerBound, ReconnectStart, bound.clone()),
        (CallerBound, OtherCauseStart, bound.clone()),
        (CallerBound, StaleStart, bound.clone()),
        (CallerBound, RunEnd, bound.clone()),
        (CallerBound, SilentRunEnd, bound.clone()),
        (CallerBound, OtherRunEnd, bound.clone()),
        (CallerBound, ReconnectRunEnd, bound.clone()),
        (SelfWoken, CallerStart, held.clone()),
        (SelfWoken, CallerEnd, held.clone()),
        (SelfWoken, SelfWokenStart, held.clone()),
        (SelfWoken, LegacyStart, held.clone()),
        (SelfWoken, ReconnectStart, held.clone()),
        (SelfWoken, OtherCauseStart, held.clone()),
        (SelfWoken, StaleStart, held.clone()),
        (
            SelfWoken,
            RunEnd,
            host_outcome(false, "none", &["end alpha auto-1"], Some("alpha: Done.")),
        ),
        (
            SelfWoken,
            SilentRunEnd,
            host_outcome(false, "none", &["end alpha auto-1"], None),
        ),
        (SelfWoken, OtherRunEnd, held.clone()),
        (
            SelfWoken,
            ReconnectRunEnd,
            host_outcome(false, "none", &["end alpha auto-1"], Some("alpha: Done.")),
        ),
        (SelfWokenElsewhere, CallerStart, held.clone()),
        (SelfWokenElsewhere, CallerEnd, held.clone()),
        (SelfWokenElsewhere, SelfWokenStart, held.clone()),
        (SelfWokenElsewhere, LegacyStart, held.clone()),
        (SelfWokenElsewhere, ReconnectStart, held.clone()),
        (SelfWokenElsewhere, OtherCauseStart, held.clone()),
        (SelfWokenElsewhere, StaleStart, held.clone()),
        (SelfWokenElsewhere, RunEnd, held.clone()),
        (SelfWokenElsewhere, SilentRunEnd, held.clone()),
        (SelfWokenElsewhere, OtherRunEnd, held.clone()),
        (SelfWokenElsewhere, ReconnectRunEnd, held.clone()),
        (SelfWokenRescued, CallerStart, none.clone()),
        (SelfWokenRescued, CallerEnd, none.clone()),
        (SelfWokenRescued, SelfWokenStart, none.clone()),
        (SelfWokenRescued, LegacyStart, none.clone()),
        (SelfWokenRescued, ReconnectStart, none.clone()),
        (SelfWokenRescued, OtherCauseStart, none.clone()),
        (SelfWokenRescued, StaleStart, none.clone()),
        (SelfWokenRescued, RunEnd, none.clone()),
        (SelfWokenRescued, SilentRunEnd, none.clone()),
        (SelfWokenRescued, OtherRunEnd, none.clone()),
        (SelfWokenRescued, ReconnectRunEnd, none.clone()),
        (SelfWokenReturned, CallerStart, held.clone()),
        (SelfWokenReturned, CallerEnd, held.clone()),
        (SelfWokenReturned, SelfWokenStart, held.clone()),
        (SelfWokenReturned, LegacyStart, held.clone()),
        (SelfWokenReturned, ReconnectStart, held.clone()),
        (SelfWokenReturned, OtherCauseStart, held.clone()),
        (SelfWokenReturned, StaleStart, held.clone()),
        // The run outlived the leg it spoke for: its end still closes its
        // operation, and its words are written on the route now on the line.
        (
            SelfWokenReturned,
            RunEnd,
            host_outcome(
                false,
                "none",
                &["end operator auto-1"],
                Some("operator: Done."),
            ),
        ),
        (
            SelfWokenReturned,
            SilentRunEnd,
            host_outcome(false, "none", &["end operator auto-1"], None),
        ),
        (SelfWokenReturned, OtherRunEnd, held.clone()),
        (
            SelfWokenReturned,
            ReconnectRunEnd,
            host_outcome(
                false,
                "none",
                &["end operator auto-1"],
                Some("operator: Done."),
            ),
        ),
    ];
    let mut wrong = Vec::new();
    for (phase, report, want) in table {
        let got = host_report_row(phase, report).await;
        if got != want {
            wrong.push(format!(
                "{phase:?} x {report:?}: got {got:?}, want {want:?}"
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// Puts alpha's leg in `phase`, lands `report` from alpha's session, and
/// says what the application did with it.
#[cfg(unix)]
async fn host_report_row(phase: HostPhase, report: HostReport) -> HostOutcome {
    use crate::debug::DebugEvent;
    use HostPhase::*;
    use HostReport::*;
    let root = scratch_root("host-turn-table");
    let state = state_with_agents(&root);
    let (token, instance_id) = foreground_alpha_turn(&state).await;
    let coordinator = &state.0.coordinator;
    let mut caller_operation = None;
    match phase {
        Idle => {}
        Caller | CallerBound => {
            caller_operation = Some(
                coordinator
                    .begin_prompt(&coordinator.current_identity())
                    .expect("a caller operation")
                    .id,
            );
            if matches!(phase, CallerBound) {
                coordinator.bind_turn(&token, "turn-c").expect("bound");
            }
        }
        SelfWoken | SelfWokenElsewhere | SelfWokenRescued | SelfWokenReturned => {
            let instance = if matches!(phase, SelfWokenElsewhere) {
                instance_id + 1000
            } else {
                instance_id
            };
            let start = host_report(&token, instance, "autonomous", Some("auto-1"), false, "");
            assert!(handle_project_turn(&state, start).await, "auto-1 admitted");
        }
    }
    match phase {
        SelfWokenRescued => {
            let rescued = coordinator.begin_rescue("test rescue");
            coordinator.settle(rescued);
        }
        SelfWokenReturned => coordinator.return_to_operator(),
        _ => {}
    }
    let report = match report {
        CallerStart => host_report(&token, instance_id, "input", Some("turn-c"), false, ""),
        CallerEnd => host_report(&token, instance_id, "input", Some("turn-c"), true, ""),
        SelfWokenStart => host_report(&token, instance_id, "autonomous", Some("auto-2"), false, ""),
        LegacyStart => host_report(&token, instance_id, "autonomous", None, false, ""),
        ReconnectStart => host_report(&token, instance_id, "unknown", Some("auto-2"), false, ""),
        OtherCauseStart => host_report(&token, instance_id, "schedule", Some("auto-2"), false, ""),
        StaleStart => host_report(
            "old-token",
            instance_id,
            "autonomous",
            Some("auto-2"),
            false,
            "",
        ),
        RunEnd => host_report(
            &token,
            instance_id,
            "autonomous",
            Some("auto-1"),
            true,
            "Done.",
        ),
        SilentRunEnd => host_report(&token, instance_id, "autonomous", Some("auto-1"), true, " "),
        OtherRunEnd => host_report(
            &token,
            instance_id,
            "autonomous",
            Some("auto-9"),
            true,
            "Done.",
        ),
        ReconnectRunEnd => host_report(
            &token,
            instance_id,
            "unknown",
            Some("auto-1"),
            true,
            "Done.",
        ),
    };
    let traced = debug_events(&state).len();
    let written = state.0.transcript_log.lock().await.entries().len();
    let mut events = state.0.events.subscribe();

    let admitted = handle_project_turn(&state, report).await;

    let open = match coordinator.attach_steer(&coordinator.current_identity()) {
        Err(_) => "none".to_owned(),
        Ok(operation) => format!(
            "{} {}",
            if Some(operation.id) == caller_operation {
                "caller"
            } else {
                "self-woken"
            },
            operation.turn_id.as_deref().unwrap_or("-")
        ),
    };
    let trace = debug_events(&state)[traced..]
        .iter()
        .filter_map(|event| match event {
            DebugEvent::TurnStart { agent, turn_id, .. } => {
                Some(format!("start {agent} {turn_id}"))
            }
            DebugEvent::TurnEnd { agent, turn_id, .. } => Some(format!("end {agent} {turn_id}")),
            _ => None,
        })
        .collect();
    let mut reply = None;
    while let Ok(event) = events.try_recv() {
        let Event::Json(frame) = event else { continue };
        if frame["type"] == "reply" {
            assert_eq!(frame["voiced"], false, "a written reply is not voiced");
            reply = Some(format!(
                "{}: {}",
                frame["route"].as_str().unwrap_or_default(),
                frame["text"].as_str().unwrap_or_default()
            ));
        }
    }
    let entries = state.0.transcript_log.lock().await.entries();
    assert_eq!(
        entries.len() - written,
        usize::from(reply.is_some()),
        "the transcript keeps exactly the written reply"
    );
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
    HostOutcome {
        admitted,
        open,
        trace,
        reply,
    }
}
