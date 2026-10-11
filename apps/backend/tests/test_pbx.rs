use super::*;
use crate::hosts::Step;
use serde_json::json;
use std::sync::Mutex as StdMutex;

#[test]
fn status_exposes_project_ids() {
    let project = Project {
        id: "alpha".into(),
        description: "Alpha project".into(),
        aliases: vec!["a".into()],
        host: None,
        cwd: "/srv/alpha".into(),
        model: None,
        prepare: String::new(),
    };
    let board = board_with(vec![project], true);
    assert_eq!(board.coordinator.status().projects, ["alpha"]);
}

#[test]
fn state_starts_on_operator() {
    let board = board_with(vec![], true);
    assert_eq!(board.coordinator.route(), OPERATOR);
    assert_eq!(board.coordinator.status().route, OPERATOR);
    assert!(board.coordinator.status().models.is_empty());
}

#[test]
fn status_exposes_the_launch_catalog_for_the_current_project() {
    let project = Project {
        id: "alpha".into(),
        description: String::new(),
        aliases: vec![],
        host: None,
        cwd: String::new(),
        model: None,
        prepare: String::new(),
    };
    let board = board_with(vec![project.clone()], true);
    put_on(
        &board,
        &project.id,
        "anthropic/current:high",
        ModelCatalog {
            entries: vec![crate::models::CatalogEntry {
                provider: "anthropic".into(),
                model: "current".into(),
                thinks: true,
            }],
            available: true,
            diagnostic: None,
        },
    );
    assert_eq!(
        board.coordinator.status().models,
        [crate::protocol::ModelEntry {
            provider: "anthropic".into(),
            model: "current".into(),
            thinks: true,
        }]
    );
}

#[tokio::test]
async fn a_module_call_with_a_stale_call_token_is_refused() {
    let (mut board, log) = on_alpha(
        &[],
        Box::new(|_, message| {
            if message.contains("go back") {
                vec![
                    Step::CallWithToken("old-token".into(), "return_to_operator", json!({})),
                    Step::CallWithToken(String::new(), "speak", json!({"text": "hi"})),
                    Step::Event(json!({"kind": "text", "text": "Still here."})),
                ]
            } else {
                says("On it.")
            }
        }),
    )
    .await;

    let reply = board.handle("go back").await;

    assert_eq!(reply.route, "alpha", "a stale signal moved the caller");
    assert_eq!(reply.text, "Still here.");
    let replies = log.module_replies();
    assert_eq!(replies.len(), 2);
    for reply in replies {
        assert_eq!(
            (reply["status"].clone(), reply["reason"].clone()),
            (json!("refused"), json!("not_on_call"))
        );
    }
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_closed_agent_on_the_line_is_retired_to_the_operator() {
    let (mut board, _log) = on_alpha(&[], Box::new(|_, _| says("handled"))).await;
    let alpha = board.agent.clone().expect("alpha on the line");

    assert!(
        !board
            .retire_closed_foreground("alpha", alpha.session_id(), alpha.instance_id() + 1)
            .await,
        "another instance of the session is not the one on the line"
    );
    assert_eq!(board.coordinator.route(), "alpha");

    assert!(
        board
            .retire_closed_foreground("alpha", alpha.session_id(), alpha.instance_id())
            .await
    );
    assert_eq!(board.coordinator.route(), OPERATOR);
    assert!(board.agent.is_none());
    assert!(board
        .operator_note
        .as_deref()
        .is_some_and(|note| note.contains("alpha")));
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_closed_session_that_is_not_resident_is_reported_for_the_line() {
    let (mut board, _log) = on_alpha(&[], Box::new(|_, _| says("handled"))).await;
    let reported = Arc::new(StdMutex::new(Vec::<(String, String, u64)>::new()));
    let reported_for_callback = reported.clone();
    board.set_foreground_closed_callback(Some(Arc::new(move |project, session, instance| {
        reported_for_callback
            .lock()
            .unwrap()
            .push((project, session, instance));
        Box::pin(async {})
    })));
    let alpha = board.agent.clone().expect("alpha on the line");

    board.session_closed_callback()(
        "alpha".into(),
        alpha.session_id().into(),
        alpha.instance_id(),
    )
    .await;

    assert_eq!(
        reported.lock().unwrap().as_slice(),
        &[(
            "alpha".to_owned(),
            alpha.session_id().to_owned(),
            alpha.instance_id()
        )]
    );
    board.shutdown().await;
}

// The guard table. The active-session guard names the session steering and
// a page rescue act on: the leg on the line's, or the one coming up. Each
// row starts the call in one state, makes one change to the legs, and shows
// what the guard names after it, beside the route and the operator.

/// A switchboard on alpha and beta whose operator answers every line and
/// whose host refuses the next `prompt` while `refuse_prompt` is set.
#[cfg(unix)]
struct GuardScene {
    board: Switchboard,
    refuse_prompt: Arc<std::sync::atomic::AtomicBool>,
    root: std::path::PathBuf,
}

#[cfg(unix)]
async fn guard_scene(start: &str) -> GuardScene {
    use crate::hosts::FakeHostAgent;
    use std::sync::atomic::{AtomicBool, Ordering};
    let root = scratch_dir("guard-table");
    let operator = root.join("fake-operator");
    crate::pi_client::write_executable_script(
        &operator,
        r#"while IFS= read -r _line; do
  printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Operator here."}}'
  printf '%s\n' '{"type":"agent_settled"}'
done
"#,
    );
    let mut board = board_on(
        vec![project("alpha", ""), project("beta", "")],
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
        two_model_catalog(),
    );
    let refuse_prompt = Arc::new(AtomicBool::new(false));
    let armed = Arc::clone(&refuse_prompt);
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("ready")));
    host.on_command = Some(Box::new(move |name, _| {
        (name == "prompt" && armed.swap(false, Ordering::AcqRel))
            .then(|| Some(Err(("failed".into(), "prompt failed".into()))))
    }));
    host.serve(board.hosts().connect_fake(HOST));
    // How the call stands before the row's change.
    let (operator_up, on_alpha, rescued) = match start {
        "operator idle" => (false, false, false),
        "operator" => (true, false, false),
        "operator rescued" => (true, false, true),
        "alpha" => (false, true, false),
        "alpha, operator up" => (true, true, false),
        "alpha rescued" => (true, true, true),
        other => panic!("no start {other:?}"),
    };
    if operator_up {
        board.ensure_operator().await.expect("the operator starts");
    }
    if on_alpha {
        let reply = board
            .transfer_to(&transcript("look at alpha"), "alpha")
            .await;
        assert_eq!(reply.route, "alpha", "{reply:?}");
    }
    if rescued {
        // What a page rescue does to the guard (`release_rescued_work`):
        // retire the leg's generation, then take its session and end it.
        board.coordinator.begin_rescue("test rescue");
        let taken = board.session_control().lock().await.take();
        if let Some(session) = taken {
            session.close().await;
        }
    }
    GuardScene {
        board,
        refuse_prompt,
        root,
    }
}

#[cfg(unix)]
/// A leg's session as a row shows it: whose it is, and whether it has ended.
async fn leg_shown(session: &LegSession) -> String {
    let ended = if session.alive().await { "" } else { " ended" };
    format!("{}{ended}", session.label())
}

#[cfg(unix)]
async fn guard_row(start: &str, change: &str) -> String {
    use std::sync::atomic::Ordering;
    let mut scene = guard_scene(start).await;
    let board = &mut scene.board;
    match change {
        "operator starts" => {
            board.ensure_operator().await.expect("the operator starts");
        }
        "operator fails" => {
            board.recover_operator("test failure".into()).await;
        }
        "agent dropped" => board.drop_agent().await,
        "hangup" => {
            board.force_hangup().await;
        }
        "alpha closed on host" => {
            if let Some(alpha) = board.agent.clone() {
                board
                    .retire_closed_foreground("alpha", alpha.session_id(), alpha.instance_id())
                    .await;
            }
        }
        "beta commits" | "beta abandoned" => {
            scene
                .refuse_prompt
                .store(change == "beta abandoned", Ordering::Release);
            board
                .transfer_to(&transcript("put me through to beta"), "beta")
                .await;
        }
        "shutdown" => board.shutdown().await,
        other => panic!("no change {other:?}"),
    }
    let guard = match board.session_control().lock().await.clone() {
        None => "none".to_owned(),
        Some(session) => leg_shown(&session).await,
    };
    let operator = match board.operator.clone() {
        None => "none".to_owned(),
        Some(session) => leg_shown(&LegSession::Operator(session)).await,
    };
    let row = format!(
        "{start} | {change} => guard {guard} | route {} | operator {operator}",
        board.coordinator.route()
    );
    scene.board.shutdown().await;
    let _ = std::fs::remove_dir_all(&scene.root);
    row
}

/// The guard's four answers: the leg on the line's live session, the
/// project's on a project route and the operator's on the operator's, a
/// bring-up's session over either, and nothing for a session that ended.
#[cfg(unix)]
#[tokio::test]
async fn the_guard_names_a_bring_up_else_the_live_session_on_the_line() {
    let mut scene = guard_scene("alpha, operator up").await;
    let board = &scene.board;
    let alpha = board.agent.clone().expect("alpha is on the line");
    let named = |leg: Option<LegSession>| leg.map(|leg| leg.label().to_owned());

    assert_eq!(
        named(board.leg_on_line(None).await).as_deref(),
        Some("alpha")
    );

    board.coordinator.return_to_operator();
    assert_eq!(
        named(board.leg_on_line(None).await).as_deref(),
        Some(OPERATOR)
    );
    assert_eq!(
        named(board.leg_on_line(Some(&alpha)).await).as_deref(),
        Some("alpha"),
        "a bring-up's session is named over the leg on the line"
    );

    board
        .operator
        .as_ref()
        .expect("the operator runs")
        .close()
        .await;
    assert_eq!(named(board.leg_on_line(None).await), None);

    scene.board.shutdown().await;
    let _ = std::fs::remove_dir_all(&scene.root);
}

#[cfg(unix)]
const GUARD_STARTS: [&str; 6] = [
    "operator idle",
    "operator",
    "operator rescued",
    "alpha",
    "alpha, operator up",
    "alpha rescued",
];

#[cfg(unix)]
const GUARD_CHANGES: [&str; 8] = [
    "operator starts",
    "operator fails",
    "agent dropped",
    "hangup",
    "alpha closed on host",
    "beta commits",
    "beta abandoned",
    "shutdown",
];

#[cfg(unix)]
#[tokio::test]
async fn every_change_to_the_legs_leaves_the_guard_as_the_table_says() {
    let mut rows = Vec::new();
    for start in GUARD_STARTS {
        for change in GUARD_CHANGES {
            rows.push(guard_row(start, change).await);
        }
    }
    let expected: Vec<&str> = GUARD_TABLE.trim().lines().map(str::trim).collect();
    if rows != expected {
        eprintln!("{}", rows.join("\n"));
    }
    assert_eq!(rows, expected);
}

#[cfg(unix)]
const GUARD_TABLE: &str = r#"
operator idle | operator starts => guard operator | route operator | operator operator
operator idle | operator fails => guard none | route operator | operator none
operator idle | agent dropped => guard none | route operator | operator none
operator idle | hangup => guard none | route operator | operator none
operator idle | alpha closed on host => guard none | route operator | operator none
operator idle | beta commits => guard beta | route beta | operator none
operator idle | beta abandoned => guard none | route operator | operator none
operator idle | shutdown => guard none | route operator | operator none
operator | operator starts => guard operator | route operator | operator operator
operator | operator fails => guard none | route operator | operator none
operator | agent dropped => guard operator | route operator | operator operator
operator | hangup => guard none | route operator | operator none
operator | alpha closed on host => guard operator | route operator | operator operator
operator | beta commits => guard beta | route beta | operator operator
operator | beta abandoned => guard operator | route operator | operator operator
operator | shutdown => guard none | route operator | operator none
operator rescued | operator starts => guard operator | route operator | operator operator
operator rescued | operator fails => guard none | route operator | operator none
operator rescued | agent dropped => guard none | route operator | operator operator ended
operator rescued | hangup => guard none | route operator | operator none
operator rescued | alpha closed on host => guard none | route operator | operator operator ended
operator rescued | beta commits => guard beta | route beta | operator operator ended
operator rescued | beta abandoned => guard none | route operator | operator operator ended
operator rescued | shutdown => guard none | route operator | operator none
alpha | operator starts => guard alpha | route alpha | operator operator
alpha | operator fails => guard alpha | route alpha | operator none
alpha | agent dropped => guard none | route operator | operator none
alpha | hangup => guard none | route operator | operator none
alpha | alpha closed on host => guard none | route operator | operator none
alpha | beta commits => guard beta | route beta | operator none
alpha | beta abandoned => guard alpha | route alpha | operator none
alpha | shutdown => guard none | route alpha | operator none
alpha, operator up | operator starts => guard alpha | route alpha | operator operator
alpha, operator up | operator fails => guard alpha | route alpha | operator none
alpha, operator up | agent dropped => guard operator | route operator | operator operator
alpha, operator up | hangup => guard operator | route operator | operator operator
alpha, operator up | alpha closed on host => guard operator | route operator | operator operator
alpha, operator up | beta commits => guard beta | route beta | operator operator
alpha, operator up | beta abandoned => guard alpha | route alpha | operator operator
alpha, operator up | shutdown => guard none | route alpha | operator none
alpha rescued | operator starts => guard none | route alpha | operator operator
alpha rescued | operator fails => guard none | route alpha | operator none
alpha rescued | agent dropped => guard operator | route operator | operator operator
alpha rescued | hangup => guard operator | route operator | operator operator
alpha rescued | alpha closed on host => guard operator | route operator | operator operator
alpha rescued | beta commits => guard beta | route beta | operator operator
alpha rescued | beta abandoned => guard none | route alpha | operator operator
alpha rescued | shutdown => guard none | route alpha | operator none
"#;
