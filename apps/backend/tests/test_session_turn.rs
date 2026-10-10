use super::*;
use serde_json::json;

fn collector() -> (Collector, tokio::sync::mpsc::UnboundedReceiver<TurnFrame>) {
    tokio::sync::mpsc::unbounded_channel()
}

fn self_woken_start(turn_id: &str) -> (TurnBoundary, TurnFrame) {
    let event = json!({"kind": "turn_start", "cause": "autonomous", "turn_id": turn_id});
    (
        TurnBoundary::opened(Some(turn_id.to_owned()), "autonomous".to_owned()),
        TurnFrame::Event { seq: 1, event },
    )
}

/// A prompt's end names the collector it let go of. Prompts take the
/// session's turn lock one at a time, so another prompt's end cannot reach
/// the turn today; if one did, it would not end the prompt being collected.
#[test]
fn the_end_of_a_prompt_not_being_collected_changes_nothing() {
    let mut turn = TurnState::new();
    let (current, _frames) = collector();
    let (earlier, _earlier_frames) = collector();
    assert!(turn
        .step(TurnEvent::PromptStarted(current.clone()))
        .is_empty());
    assert!(turn.step(TurnEvent::PromptEnded(earlier)).is_empty());
    assert!(turn.busy());
    let effects = turn.step(TurnEvent::Event {
        seq: 2,
        event: json!({"kind": "text", "text": "still mine", "turn_id": "t-1"}),
    });
    assert!(
        matches!(effects.as_slice(), [TurnEffect::Forward(to, _)] if to.same_channel(&current)),
        "the text goes to the prompt being collected"
    );
}

/// The application's answer to a self-woken start comes after the pump has
/// asked for it, and the caller's prompt may have let go of its collector
/// in between: an admitted start is then held alone, and a refused one
/// reaches nobody.
#[test]
fn an_answer_to_a_start_after_the_prompt_let_go_holds_or_drops_it() {
    for admitted in [true, false] {
        let mut turn = TurnState::new();
        let (prompt, _frames) = collector();
        turn.step(TurnEvent::PromptStarted(prompt.clone()));
        let (start, frame) = self_woken_start("auto-1");
        let asked = turn.step(TurnEvent::Event {
            seq: 1,
            event: json!({"kind": "turn_start", "cause": "autonomous", "turn_id": "auto-1"}),
        });
        assert!(matches!(asked.as_slice(), [TurnEffect::AskAdmission(..)]));
        turn.step(TurnEvent::PromptEnded(prompt));
        let answered = turn.step(TurnEvent::Admitted {
            admitted,
            start,
            frame,
        });
        assert!(answered.is_empty(), "admitted {admitted}");
        assert_eq!(turn.busy(), admitted, "admitted {admitted}");
        assert_eq!(
            turn.self_woken_cause().as_deref(),
            admitted.then_some("autonomous"),
            "admitted {admitted}"
        );
    }
}
