use super::*;
use crate::hosts::{FakeHostAgent, Step};
use crate::lifecycle::Coordinator;
use crate::operator::fake_operator;
use crate::pbx::{
    board_on, board_with, on_alpha, project, prompts, says, scratch_dir, serve, transcript,
    two_model_catalog, until_named, HOST,
};
use crate::router::{Action, ConversationMode, Decision};
use serde_json::json;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex;
use tokio::time::Duration;

fn read_lines(path: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

#[tokio::test]
async fn transfer_ctx_ambiguous_project_returns_candidate_options() {
    let p1 = Project {
        id: "proj-a".into(),
        description: String::new(),
        aliases: vec!["shared".into()],
        host: None,
        cwd: String::new(),
        model: None,
        prepare: String::new(),
    };
    let p2 = Project {
        id: "proj-b".into(),
        description: String::new(),
        aliases: vec!["shared".into()],
        host: None,
        cwd: String::new(),
        model: None,
        prepare: String::new(),
    };

    let mut board = board_with(vec![p1, p2], true);
    let ctx = TransferContext {
        exact_caller_transcript: "transfer to shared".into(),
        derived_intent: String::new(),
    };

    let reply = board.transfer_ctx(&ctx, "shared", "", "").await;
    assert!(reply
        .to_speak
        .iter()
        .any(|s| s.contains("Which project did you mean by shared? It could be proj-a, proj-b.")));
    assert!(board
        .operator_note
        .as_deref()
        .unwrap_or("")
        .contains("Couldn't tell which project \"shared\" meant: proj-a, proj-b."));
}

#[tokio::test]
async fn a_takeover_of_an_unknown_project_names_the_ones_there_are() {
    let mut board = board_with(vec![project("alpha", ""), project("beta", "")], false);
    let reply = board.take_over("take over gamma", "gamma", Ok(None)).await;
    assert_eq!(
        reply.to_speak,
        ["I don't have a project called gamma. The ones I have are alpha, beta."]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_transfer_and_a_return_act_on_a_session_over_the_host_link() {
    let root = scratch_dir("transfer-return");
    let operator = fake_operator(&root);
    let mut board = board_on(
        vec![project("alpha", "test project")],
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
        two_model_catalog(),
    );
    let log = serve(
        &board,
        Box::new(|_, message| {
            if message.contains("we are done") {
                vec![
                    Step::Event(json!({"kind": "text", "text": "Alpha finished."})),
                    Step::Call("return_to_operator", json!({"summary": "work complete"})),
                ]
            } else {
                says("Alpha is ready.")
            }
        }),
    );
    // What the route callback finds when it is told the line has settled.
    let statuses = Arc::new(StdMutex::new(Vec::new()));
    let statuses_for_callback = Arc::clone(&statuses);
    let coordinator = board.coordinator();
    board.set_route_callback(Some(Arc::new(move || {
        let statuses = Arc::clone(&statuses_for_callback);
        let status = coordinator.status();
        Box::pin(async move {
            statuses.lock().unwrap().push(status);
        })
    })));

    let connected = board.handle("put me through").await;
    assert_eq!(connected.route, "alpha");
    assert_eq!(connected.text, "Alpha is ready.");
    assert_eq!(board.coordinator.route(), "alpha");
    // A resident session in the project's folder, on the call under a token
    // of its own.
    assert_eq!(
        log.named("create_session"),
        [json!({"project": "alpha", "config": {
            "cwd": "/srv/alpha", "provider": "anthropic", "model": "current", "thinking": "medium",
        }})]
    );
    let join = &log.named("join_call")[0];
    assert_eq!(join["session"], "s1");
    assert_eq!(join["speech_deadline_ms"], 25_000);
    assert_eq!(
        join["token"].as_str(),
        Some(board.coordinator.current_identity().token.as_str())
    );
    let announced = statuses.lock().unwrap().last().cloned().unwrap();
    assert_eq!(announced.route, "alpha");
    assert_eq!(announced.models.len(), 2);

    let returned = board.handle("we are done").await;
    // A host that still has the removed module receives a refusal. It cannot
    // move the caller or kill the live project leg.
    assert_eq!(returned.route, "alpha");
    assert!(returned.text.contains("Alpha finished."), "{returned:?}");
    assert_eq!(board.coordinator.route(), "alpha");
    assert!(board.agent.is_some());
    assert_eq!(log.named("kill").len(), 0);
    assert_eq!(
        log.module_replies()
            .iter()
            .map(|reply| reply["status"].clone())
            .collect::<Vec<_>>(),
        [json!("refused")]
    );
    assert_eq!(log.module_replies()[0]["reason"], "removed");
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn an_agent_to_agent_transfer_ends_the_old_session_after_the_new_one_is_up() {
    let root = scratch_dir("agent-to-agent");
    let operator = fake_operator(&root);
    let mut board = board_on(
        vec![
            project("alpha", "Alpha project"),
            project("beta", "Beta project"),
        ],
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
        two_model_catalog(),
    );
    let log = serve(
        &board,
        Box::new(|session, message| match (session, message) {
            ("s1", message) if message.contains("hand off") => vec![
                Step::Event(json!({"kind": "text", "text": "Alpha transferring to Beta."})),
                Step::Call(
                    "transfer_to_project",
                    json!({"project": "beta", "intent": "continue work"}),
                ),
            ],
            ("s1", _) => says("Alpha response."),
            _ => says("Beta response."),
        }),
    );

    let r1 = board.handle("connect me to alpha").await;
    assert_eq!(
        (r1.route.as_str(), r1.text.as_str()),
        ("alpha", "Alpha response.")
    );

    let r2 = board.handle("please hand off to beta").await;
    assert_eq!(r2.route, "alpha");
    assert_eq!(r2.text, "Alpha transferring to Beta.");
    assert!(r2.to_speak.is_empty());
    // The stale host's transfer signal is refused, so beta is never started.
    assert_eq!(log.named("create_session").len(), 1);
    assert!(log.named("kill").is_empty());
    assert_eq!(
        log.module_replies()
            .iter()
            .map(|reply| reply["status"].clone())
            .collect::<Vec<_>>(),
        [json!("refused")]
    );
    assert_eq!(log.module_replies()[0]["reason"], "removed");
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_transfer_to_a_host_that_is_not_connected_is_refused_with_the_reason() {
    let mut board = board_with(vec![project("alpha", "")], true);

    let reply = board
        .transfer_ctx(&transcript("look at alpha"), "alpha", "", "")
        .await;

    assert_eq!(reply.route, OPERATOR);
    // The reason is screen text; the caller hears plain words.
    assert_eq!(reply.to_speak, ["I couldn't open alpha."]);
    assert!(
        reply.text.contains("its host scriptorium is not connected"),
        "{}",
        reply.text
    );
    assert!(!board.coordinator.is_candidate());
    assert!(board
        .operator_note
        .as_deref()
        .unwrap()
        .starts_with("Couldn't open alpha:"));
}

#[tokio::test]
async fn a_transfer_resolves_a_bare_model_against_the_launch_catalog() {
    let mut board = board_with(vec![project("alpha", "")], true);
    let log = serve(&board, Box::new(|_, _| says("Ready.")));

    let reply = board
        .transfer_ctx(&transcript("connect me"), "alpha", "current", "high")
        .await;

    assert!(reply.error.is_none(), "transfer failed: {:?}", reply.error);
    assert_eq!(board.coordinator.status().model, "anthropic/current:high");
    assert_eq!(
        log.named("create_session")[0]["config"],
        json!({"cwd": "/srv/alpha", "provider": "anthropic", "model": "current", "thinking": "high"})
    );
    assert!(
        log.named("list_models").is_empty(),
        "the catalog came from prewarm"
    );
    board.shutdown().await;
}

#[tokio::test]
async fn the_route_follows_adoption_while_the_intro_turn_is_still_running() {
    use crate::lifecycle::ActivityDisposition;
    use crate::pi_client::Activity;

    let mut board = board_with(vec![project("alpha", "")], true);
    serve(
        &board,
        Box::new(|_, _| {
            vec![
                Step::Event(json!({"kind": "tool_start", "tool": "ipython", "call_id": "t1"})),
                Step::WaitFor("steer"),
                Step::Event(json!({"kind": "text", "text": "Alpha here."})),
            ]
        }),
    );
    // Promotion as the application does it: the candidate's own sign of life
    // adopts it. Each adoption is reported on a channel.
    let coordinator = board.coordinator();
    let (adopted_tx, mut adopted) = tokio::sync::mpsc::unbounded_channel();
    let promoting = coordinator.clone();
    board.set_activity_callback(Some(Arc::new(move |activity: Activity| {
        let coordinator = promoting.clone();
        let adopted = adopted_tx.clone();
        Box::pin(async move {
            if coordinator.classify_activity(&activity.leg) == ActivityDisposition::Promote {
                let _ = adopted.send(coordinator.adopt_candidate(&activity.leg));
            }
        })
    })));
    let control = board.session_control();
    let board = Arc::new(Mutex::new(board));
    let turn_board = Arc::clone(&board);
    let turn = tokio::spawn(async move {
        turn_board
            .lock()
            .await
            .transfer_ctx(&transcript("put me through"), "alpha", "", "")
            .await
    });

    adopted
        .recv()
        .await
        .expect("the incoming leg shows life")
        .expect("and is adopted");
    // The intro turn has not ended, yet the line already names alpha: what
    // the PBX reads, replies with, or hangs up from here on is alpha.
    assert_eq!(coordinator.route(), "alpha");
    let status = coordinator.status();
    assert_eq!(
        (status.route.as_str(), status.label.as_str()),
        ("alpha", "alpha")
    );
    assert_eq!(status.model, "anthropic/current:medium");
    assert_eq!(status.models.len(), 2);

    control
        .lock()
        .await
        .as_ref()
        .expect("the incoming leg is the live session")
        .steer("go on", None)
        .await
        .unwrap();
    let reply = turn.await.unwrap();

    assert_eq!(reply.route, "alpha");
    assert_eq!(reply.text, "Alpha here.");
    assert_eq!(coordinator.route(), "alpha");
    board.lock().await.shutdown().await;
}

// ---------------------------------------------------------------------------
// A transfer that cannot bring its leg up, and a hangup (#56). A failed
// transfer leaves the caller on the operator with a note saying why and rolls
// the candidate back; a hangup drops whatever leg is live. The operator here
// is a real process, so these check what it is told on its next turn rather
// than only the note waiting for it.

/// An operator that answers every prompt and appends each one to a log, so a
/// test can read what the switchboard told it.
#[cfg(unix)]
fn logging_operator(root: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let operator = root.join("fake-operator");
    let log = root.join("operator.log");
    crate::pi_client::write_executable_script(
        &operator,
        &format!(
            r#"while IFS= read -r line; do
  printf '%s\n' "$line" >> '{log}'
  printf '%s\n' '{{"type":"message_update","assistantMessageEvent":{{"type":"text_end","content":"Operator here."}}}}'
  printf '%s\n' '{{"type":"agent_settled"}}'
done
"#,
            log = log.display()
        ),
    );
    (operator, log)
}

/// The messages the operator was prompted with, oldest first.
fn operator_prompts(log: &std::path::Path) -> Vec<String> {
    read_lines(log)
        .iter()
        .map(|line| {
            let command: serde_json::Value = serde_json::from_str(line).unwrap();
            command["message"].as_str().unwrap().to_owned()
        })
        .collect()
}

/// A switchboard on `project` whose coordinator records its candidate
/// notices the way `AppState` relays them to the browser.
fn coordinated_board(
    project: Project,
    settings: &[(&str, &str)],
) -> (
    Switchboard,
    Coordinator,
    Arc<StdMutex<Vec<crate::lifecycle::CandidateNotice>>>,
) {
    let board = board_on(vec![project], settings, two_model_catalog());
    let mut coordinator = board.coordinator();
    let notices = Arc::new(StdMutex::new(Vec::new()));
    let recorded = Arc::clone(&notices);
    coordinator.set_candidate_callback(Arc::new(move |notice| {
        recorded.lock().unwrap().push(notice.clone());
    }));
    (board, coordinator, notices)
}

/// Everything a failed transfer must leave as it found it: the caller on the
/// operator's live session, no candidate, the generation where it was, and a
/// note for the operator that starts with `why`.
async fn assert_back_on_the_operator(
    board: &Switchboard,
    coordinator: &Coordinator,
    notices: &StdMutex<Vec<crate::lifecycle::CandidateNotice>>,
    generation: u64,
    why: &str,
) {
    assert_eq!(coordinator.route(), OPERATOR);
    assert!(board.agent.is_none() && coordinator.project_leg().is_none());
    let operator = board.operator.as_ref().expect("the operator keeps running");
    assert!(operator.alive().await);
    let operator = LegSession::Operator(operator.clone());
    assert!(
        board
            .active_session
            .lock()
            .await
            .as_ref()
            .is_some_and(|active| active.same_session(&operator)),
        "the operator must be the live session again, so a steer or a rescue reaches it"
    );

    assert!(!coordinator.is_candidate());
    assert_eq!(coordinator.candidate_identity(), None);
    assert_eq!(coordinator.generation(), generation);
    assert_eq!(coordinator.status().route, OPERATOR);
    assert_eq!(
        notices
            .lock()
            .unwrap()
            .iter()
            .map(|notice| notice.ended)
            .collect::<Vec<_>>(),
        [None, Some(crate::protocol::CandidateEnd::RolledBack)],
        "the browser is told the candidate began and that it ended"
    );

    let note = board.operator_note.as_deref().unwrap_or_default();
    assert!(
        note.starts_with(why),
        "{note:?} does not start with {why:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_transfer_whose_session_cannot_start_leaves_the_caller_on_the_operator_with_the_reason() {
    let root = scratch_dir("transfer-no-session");
    let (operator, operator_log) = logging_operator(&root);
    let (mut board, coordinator, notices) = coordinated_board(
        project("alpha", ""),
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
    );
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("never")));
    host.on_command = Some(Box::new(|name, _| {
        (name == "create_session").then(|| {
            Some(Err((
                "daemon_error".to_owned(),
                "cwd /srv/alpha does not exist".to_owned(),
            )))
        })
    }));
    host.serve(board.hosts().connect_fake(HOST));
    board.handle("hello").await;
    let generation = coordinator.generation();

    let reply = board
        .transfer_ctx(&transcript("put me through to alpha"), "alpha", "", "")
        .await;

    let error = reply.error.clone().expect("the transfer failed");
    assert_eq!(
        error,
        "could not start a session: cwd /srv/alpha does not exist"
    );
    assert_eq!(reply.route, OPERATOR);
    assert_eq!(reply.to_speak, ["I couldn't open alpha."]);
    assert!(reply.text.contains(&error), "{}", reply.text);
    assert_back_on_the_operator(
        &board,
        &coordinator,
        &notices,
        generation,
        &format!("Couldn't open alpha: {}.", error.trim_end_matches('.')),
    )
    .await;

    board.handle("what happened?").await;
    assert_eq!(
        operator_prompts(&operator_log).last().unwrap(),
        &format!(
            "[switchboard] Couldn't open alpha: {}.\n\nwhat happened?",
            error.trim_end_matches('.')
        )
    );
    assert_eq!(board.operator_note, None, "the note is delivered once");
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn an_intro_that_never_settles_is_dropped_at_the_turn_deadline() {
    let root = scratch_dir("transfer-silent");
    let (operator, operator_log) = logging_operator(&root);
    let (mut board, coordinator, notices) = coordinated_board(
        project("alpha", ""),
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
    );
    let log = serve(&board, Box::new(|_, _| vec![Step::Hold]));
    // The intro never settles, so the only thing that ends the transfer is
    // the deadline. Reaching it is the outcome under test, not a wait for
    // something else, so it can be short.
    board.set_project_turn_timeout_for_test(Duration::from_millis(200));
    board.handle("hello").await;
    let generation = coordinator.generation();

    let reply = board
        .transfer_ctx(&transcript("put me through to alpha"), "alpha", "", "")
        .await;

    assert_eq!(reply.error.as_deref(), Some("the agent stopped responding"));
    assert_eq!(reply.route, OPERATOR);
    assert_eq!(reply.to_speak, ["I couldn't open alpha."]);
    assert_back_on_the_operator(
        &board,
        &coordinator,
        &notices,
        generation,
        "Couldn't open alpha: the agent stopped responding.",
    )
    .await;
    // The silent session is not left running on its host.
    until_named(&log, "kill").await;
    until_named(&log, "abort").await;

    board.handle("what happened?").await;
    assert_eq!(
        operator_prompts(&operator_log).last().unwrap(),
        "[switchboard] Couldn't open alpha: the agent stopped responding.\n\nwhat happened?"
    );
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn hanging_up_an_operator_with_nothing_running_does_nothing() {
    let mut board = board_with(vec![], true);
    assert_eq!(board.force_hangup().await, None);
    assert_eq!(board.coordinator.route(), OPERATOR);
    assert_eq!(board.operator_note, None);
}

#[cfg(unix)]
#[tokio::test]
async fn hanging_up_the_operator_discards_its_process_and_the_next_turn_starts_another() {
    // The operator stays the route; a wedged operator process is simply
    // replaced on the next utterance.
    let root = scratch_dir("hangup-operator");
    let (operator, _) = logging_operator(&root);
    let mut board = board_on(
        vec![],
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
        two_model_catalog(),
    );
    board.handle("hello").await;
    let first = board.operator.clone().expect("the operator started");

    assert_eq!(board.force_hangup().await.as_deref(), Some(OPERATOR));

    assert!(!first.alive().await);
    assert!(board.operator.is_none());
    assert!(board.active_session.lock().await.is_none());
    assert_eq!(board.coordinator.route(), OPERATOR);
    assert_eq!(board.operator_note, None);
    let reply = board.handle("are you there?").await;
    assert_eq!(reply.text, "Operator here.");
    assert!(
        reply.voiced,
        "the operator reply should be voiced: {reply:?}"
    );
    let second = board.operator.as_ref().expect("a fresh operator");
    assert!(!second.same_session(&first));
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn hanging_up_a_project_leg_returns_the_caller_to_the_operator_and_tells_it_why() {
    let root = scratch_dir("hangup-project");
    let (operator, operator_log) = logging_operator(&root);
    let mut board = board_on(
        vec![project("alpha", "")],
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
        two_model_catalog(),
    );
    let log = serve(&board, Box::new(|_, _| says("On it.")));
    // The route the coordinator names each time the line is announced.
    let routes = Arc::new(StdMutex::new(Vec::new()));
    let announced = Arc::clone(&routes);
    let coordinator = board.coordinator();
    board.set_route_callback(Some(Arc::new(move || {
        announced.lock().unwrap().push(coordinator.route());
        Box::pin(async {})
    })));
    board.handle("hello").await;
    let reply = board
        .transfer_ctx(&transcript("put me through to alpha"), "alpha", "", "")
        .await;
    assert_eq!(reply.route, "alpha", "{reply:?}");
    let agent = board.agent.clone().expect("the project leg is live");

    assert_eq!(board.force_hangup().await.as_deref(), Some("alpha"));

    assert!(!agent.alive(), "the project leg was left running");
    assert_eq!(until_named(&log, "kill").await, [json!({"session": "s1"})]);
    assert_eq!(board.coordinator.route(), OPERATOR);
    assert!(board.agent.is_none() && board.coordinator.project_leg().is_none());
    let operator_session =
        LegSession::Operator(board.operator.clone().expect("the operator keeps running"));
    assert!(board
        .active_session
        .lock()
        .await
        .as_ref()
        .is_some_and(|active| active.same_session(&operator_session)));
    assert_eq!(*routes.lock().unwrap(), ["alpha", OPERATOR]);

    board.handle("I'm back").await;
    assert_eq!(
        operator_prompts(&operator_log).last().unwrap(),
        "[switchboard] The caller hung up alpha from the page.\n\nI'm back"
    );
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn at_most_one_session_per_project_stays_up() {
    let (mut board, log) = on_alpha(&[], Box::new(|_, _| says("On it."))).await;
    // Put through to alpha again from alpha: the old session ends.
    let reply = board
        .transfer_ctx(&transcript("again"), "alpha", "", "")
        .await;
    assert_eq!(reply.route, "alpha");
    assert_eq!(log.named("create_session").len(), 2);
    assert_eq!(until_named(&log, "kill").await, [json!({"session": "s1"})]);
    let names = log.names();
    let killed = names.iter().position(|name| name == "kill").unwrap();
    let created = names
        .iter()
        .rposition(|name| name == "create_session")
        .unwrap();
    assert!(
        killed < created,
        "two alpha sessions were up at once: {names:?}"
    );
    // Service shutdown ends the one left.
    board.shutdown().await;
    for _ in 0..500 {
        if log.named("kill").len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(
        log.named("kill"),
        [json!({"session": "s1"}), json!({"session": "s2"})]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn failed_transfer_adoption_returns_to_the_operator_and_cleans_up() {
    let mut board = board_with(vec![project("alpha", "")], false);
    let coordinator = board.coordinator();
    board.set_agent_state_callback(Some(Arc::new(move |notice| {
        if notice.project == "alpha" && notice.state == "busy" {
            // The candidate is staged before its intro prompt. Simulate a
            // competing lifecycle owner changing it before PBX adoption.
            coordinator.set_candidate_token_for_test("not-the-transfer-token");
        }
        Box::pin(async {})
    })));
    let log = serve(&board, Box::new(|_, _| says("ready")));

    let reply = board
        .transfer_ctx(&transcript("put me through"), "alpha", "", "")
        .await;

    assert!(reply.error.is_some(), "adoption must fail: {reply:?}");
    assert_eq!(reply.route, OPERATOR);
    assert!(board.agent.is_none());
    assert!(!board.coordinator.is_candidate());
    assert!(!board
        .coordinator
        .status()
        .route
        .eq_ignore_ascii_case("alpha"));
    assert_eq!(until_named(&log, "kill").await.len(), 1);
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn failed_transfer_intro_publishes_finished_instead_of_stuck_busy() {
    let mut board = board_on(vec![project("alpha", "")], &[], two_model_catalog());
    let notices = Arc::new(StdMutex::new(Vec::<String>::new()));
    let notices_for_callback = notices.clone();
    board.set_agent_state_callback(Some(Arc::new(move |notice| {
        let notices = notices_for_callback.clone();
        Box::pin(async move {
            notices
                .lock()
                .unwrap()
                .push(format!("{}:{}", notice.project, notice.state));
        })
    })));
    let mut fake = FakeHostAgent::new(Box::new(|_, _| says("never")));
    fake.on_command = Some(Box::new(|name, _| {
        (name == "prompt").then(|| Some(Err(("prompt_failed".into(), "intro failed".into()))))
    }));
    fake.serve(board.hosts().connect_fake(HOST));

    let reply = board
        .transfer_ctx(&transcript("put me through"), "alpha", "", "")
        .await;

    assert!(reply.error.is_some());
    assert!(board.agent.is_none());
    assert_eq!(
        notices.lock().unwrap().last().map(String::as_str),
        Some("alpha:finished")
    );
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_stopped_project_starts_fresh_after_close() {
    let (mut board, log) = on_alpha(&[], Box::new(|_, _| says("handled"))).await;
    let first = board.agent.as_ref().unwrap().session_id().to_owned();
    board.pending_stop = Some("alpha".into());
    let stopped = board
        .handle_decision("yes", &Decision::fallback("confirm"))
        .await;
    assert_eq!(stopped.route, OPERATOR);
    let resumed = board
        .transfer_ctx(&transcript("fresh alpha"), "alpha", "", "")
        .await;
    assert_eq!(resumed.route, "alpha");
    assert_ne!(board.agent.as_ref().unwrap().session_id(), first);
    assert_eq!(log.named("create_session").len(), 2);
    board.shutdown().await;
}

#[tokio::test]
async fn takeover_attaches_and_voice_briefs_then_hangup_detaches_without_kill() {
    let mut board = board_with(vec![project("alpha", "Alpha")], false);
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("Desk answered")));
    let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
    host.on_command = Some(Box::new(move |name, args| {
        let _ = command_tx.send(name.to_owned());
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [
                {"session":"desk-alpha","session_id":"desk-saved","cwd":"/srv/alpha","provenance":null,"busy":false,"model":"anthropic/current","thinking":"high"}
            ]}))));
        }
        if name == "attach" {
            return Some(Some(Ok(json!({
                "session":"desk-alpha","session_id":"desk-saved","name":"notes","project":"alpha","cwd":"/srv/alpha","provenance":"taken_over","busy":false,"turn_open":false,"model":"anthropic/current","thinking":"high","call_mode":null,"last_text":null
            }))));
        }
        let _ = args;
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let decision = Decision {
        action: Action::TakeOver,
        target: Some("alpha".into()),
        continue_or_fresh: Some(ConversationMode::Continue),
        confidence: 1.0,
        for_current_agent: 0.0,
        multi_target: false,
        unsure: false,
        confirm: false,
        reason: "test".into(),
    };
    let reply = board.handle_decision("take over alpha", &decision).await;
    assert_eq!(reply.route, "alpha");
    assert_eq!(reply.text, "Desk answered");
    let prompt = log.named("prompt");
    assert_eq!(prompt.len(), 1);
    assert!(prompt[0]["message"]
        .as_str()
        .unwrap()
        .contains("[SWITCHBOARD VOICE BRIEF]"));
    assert!(log.names().contains(&"attach".into()));
    for expected in ["list_sessions", "attach", "join_call", "prompt"] {
        assert_eq!(command_rx.recv().await.as_deref(), Some(expected));
    }
    board.force_hangup().await;
    assert_eq!(command_rx.recv().await.as_deref(), Some("abort"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("detach"));
    assert!(!log.names().contains(&"kill".into()));
}

#[tokio::test]
async fn takeover_backgrounds_an_existing_service_foreground_agent() {
    let mut board = board_with(
        vec![project("alpha", "Alpha"), project("beta", "Beta")],
        false,
    );
    let list_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let list_calls_for_host = list_calls.clone();
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("handled")));
    host.on_command = Some(Box::new(move |name, args| {
        if name == "list_sessions" {
            if list_calls_for_host.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                return Some(Some(Ok(json!({"sessions": []}))));
            }
            return Some(Some(Ok(json!({"sessions": [{
                "session":"desk-beta", "session_id":"desk-beta-saved", "cwd":"/srv/beta",
                "provenance":null, "busy":false, "model":"anthropic/current", "thinking":"medium"
            }]}))));
        }
        if name == "attach" {
            return Some(Some(Ok(json!({
                "session":"desk-beta", "session_id":"desk-beta-saved", "name":"notes",
                "project":"beta", "cwd":args["cwd"], "provenance":"taken_over", "busy":false,
                "turn_open":false, "model":"anthropic/current", "thinking":"medium"
            }))));
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
    let alpha = board.agent.clone().expect("alpha is foreground");
    let reply = board
        .handle_decision(
            "take over beta",
            &Decision {
                action: Action::TakeOver,
                target: Some("beta".into()),
                continue_or_fresh: Some(ConversationMode::Continue),
                confidence: 1.0,
                for_current_agent: 0.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "test".into(),
            },
        )
        .await;
    assert_eq!(reply.route, "beta");
    assert!(alpha.alive(), "the service-created foreground is resident");
    assert!(board
        .residents_for_test()
        .iter()
        .any(|(project, alive, _)| project == "alpha" && *alive));
    assert!(log
        .named("set_mode")
        .iter()
        .any(|args| args["mode"] == "background"));
    board.shutdown().await;
}

#[tokio::test]
async fn takeover_join_error_releases_the_taken_over_session_without_kill() {
    let mut board = board_with(vec![project("alpha", "Alpha")], false);
    let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("unused")));
    host.on_command = Some(Box::new(move |name, args| {
        let _ = command_tx.send(name.to_owned());
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [{
                "session":"desk-alpha", "session_id":"desk-saved", "cwd":"/srv/alpha",
                "provenance":null, "busy":false
            }]}))));
        }
        if name == "attach" {
            return Some(Some(Ok(json!({
                "session":"desk-alpha", "session_id":"desk-saved", "project":"alpha",
                "cwd":args["cwd"], "provenance":"taken_over", "busy":false,
                "turn_open":false, "model":"anthropic/current", "thinking":"medium"
            }))));
        }
        if name == "join_call" {
            return Some(Some(Err(("failed".into(), "join failed".into()))));
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let reply = board
        .handle_decision(
            "take over alpha",
            &Decision {
                action: Action::TakeOver,
                target: Some("alpha".into()),
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 0.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "test".into(),
            },
        )
        .await;
    assert_eq!(reply.route, OPERATOR);
    assert!(reply.text.contains("join failed"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("list_sessions"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("attach"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("join_call"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("abort"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("detach"));
    assert!(!log.names().contains(&"kill".into()));
    board.shutdown().await;
}

#[tokio::test]
async fn takeover_link_drop_during_attach_rolls_back_without_kill() {
    let mut board = board_with(vec![project("alpha", "Alpha")], false);
    let hosts = board.hosts();
    let disconnect = hosts.clone();
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("unused")));
    host.on_command = Some(Box::new(move |name, args| {
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [{
                "session":"desk-alpha", "session_id":"desk-saved", "cwd":"/srv/alpha",
                "provenance":null, "busy":false
            }]}))));
        }
        if name == "attach" {
            disconnect.disconnect_fake(HOST);
            return Some(None);
        }
        let _ = args;
        None
    }));
    let log = host.serve(hosts.connect_fake(HOST));
    let reply = board
        .handle_decision(
            "take over alpha",
            &Decision {
                action: Action::TakeOver,
                target: Some("alpha".into()),
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 0.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "test".into(),
            },
        )
        .await;
    assert_eq!(reply.route, OPERATOR);
    assert!(!log.names().contains(&"kill".into()));
    board.shutdown().await;
}

#[tokio::test]
async fn leaving_a_taken_over_leg_by_transfer_detaches_without_kill() {
    let mut board = board_with(
        vec![project("alpha", "Alpha"), project("beta", "Beta")],
        false,
    );
    let (detached_tx, detached_rx) = tokio::sync::oneshot::channel();
    let detached_tx = Arc::new(StdMutex::new(Some(detached_tx)));
    let detached_for_host = detached_tx.clone();
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("handled")));
    host.on_command = Some(Box::new(move |name, args| {
        if name == "detach" {
            if let Some(tx) = detached_for_host.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [{
                "session":"desk-alpha", "session_id":"desk-saved", "cwd":"/srv/alpha",
                "provenance":null, "busy":false, "model":"anthropic/current", "thinking":"medium"
            }]}))));
        }
        if name == "attach" {
            return Some(Some(Ok(json!({
                "session":"desk-alpha", "session_id":"desk-saved", "project":"alpha",
                "cwd":args["cwd"], "provenance":"taken_over", "busy":false,
                "turn_open":false, "model":"anthropic/current", "thinking":"medium"
            }))));
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    board
        .handle_decision(
            "take over alpha",
            &Decision {
                action: Action::TakeOver,
                target: Some("alpha".into()),
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 0.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "test".into(),
            },
        )
        .await;
    let reply = board
        .transfer_ctx(&transcript("beta"), "beta", "", "")
        .await;
    assert_eq!(reply.route, "beta");
    tokio::time::timeout(Duration::from_secs(1), detached_rx)
        .await
        .expect("taken-over transfer sends detach")
        .expect("detach notification");
    assert!(
        log.named("kill").is_empty(),
        "leaving a desk session never kills it"
    );
    board.shutdown().await;
}

#[tokio::test]
async fn stopping_a_taken_over_leg_detaches_without_kill() {
    let mut board = board_with(vec![project("alpha", "Alpha")], false);
    let (detached_tx, detached_rx) = tokio::sync::oneshot::channel();
    let detached_tx = Arc::new(StdMutex::new(Some(detached_tx)));
    let detached_for_host = detached_tx.clone();
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("handled")));
    host.on_command = Some(Box::new(move |name, args| {
        if name == "detach" {
            if let Some(tx) = detached_for_host.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [{
                "session":"desk-alpha", "session_id":"desk-saved", "cwd":"/srv/alpha",
                "provenance":null, "busy":false
            }]}))));
        }
        if name == "attach" {
            return Some(Some(Ok(json!({
                "session":"desk-alpha", "session_id":"desk-saved", "project":"alpha",
                "cwd":args["cwd"], "provenance":"taken_over", "busy":false,
                "turn_open":false, "model":"anthropic/current", "thinking":"medium"
            }))));
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let decision = Decision {
        action: Action::TakeOver,
        target: Some("alpha".into()),
        continue_or_fresh: None,
        confidence: 1.0,
        for_current_agent: 0.0,
        multi_target: false,
        unsure: false,
        confirm: false,
        reason: "test".into(),
    };
    board.handle_decision("take over alpha", &decision).await;
    let ask = board
        .handle_decision(
            "stop alpha",
            &Decision {
                action: Action::Stop,
                target: Some("alpha".into()),
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 0.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "voice stop".into(),
            },
        )
        .await;
    assert!(ask.text.contains("Say yes to confirm"));
    let stopped = board
        .handle_decision("yes", &Decision::fallback("confirmation"))
        .await;
    assert_eq!(stopped.route, OPERATOR);
    tokio::time::timeout(Duration::from_secs(1), detached_rx)
        .await
        .expect("stopping a taken-over leg sends detach")
        .expect("detach notification");
    assert!(
        log.named("kill").is_empty(),
        "stopping a desk session never kills it"
    );
    board.shutdown().await;
}

#[tokio::test]
async fn takeover_refuses_a_live_service_created_agent_before_attach() {
    let mut board = board_with(vec![project("alpha", "Alpha")], false);
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("unused")));
    host.on_command = Some(Box::new(|name, _| {
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [
                {"session":"service-alpha","session_id":"service-saved","cwd":"/srv/alpha","project":"alpha","provenance":"created","busy":false}
            ]}))));
        }
        if name == "attach" {
            panic!("takeover must not attach a service-created session");
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let decision = Decision {
        action: Action::TakeOver,
        target: Some("alpha".into()),
        continue_or_fresh: None,
        confidence: 1.0,
        for_current_agent: 0.0,
        multi_target: false,
        unsure: false,
        confirm: false,
        reason: "test".into(),
    };
    let reply = board.handle_decision("take over alpha", &decision).await;
    assert_eq!(reply.route, OPERATOR);
    assert!(reply.text.contains("service-created"));
    assert!(!log.names().contains(&"attach".into()));
    assert!(!board.coordinator.is_candidate());
}

#[tokio::test]
async fn failed_takeover_from_project_restores_foreground_for_steering() {
    let mut board = board_with(
        vec![project("alpha", "Alpha"), project("beta", "Beta")],
        false,
    );
    let list_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let list_calls_for_host = list_calls.clone();
    let prompt_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let prompt_calls_for_host = prompt_calls.clone();
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("Alpha stayed on the line")));
    host.on_command = Some(Box::new(move |name, args| {
        if name == "list_sessions" {
            if list_calls_for_host.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                return Some(Some(Ok(json!({"sessions": []}))));
            }
            return Some(Some(Ok(json!({"sessions": [{
                "session":"desk-beta", "session_id":"desk-beta-saved", "cwd":"/srv/beta",
                "provenance":null, "busy":false, "model":"anthropic/current", "thinking":"medium"
            }]}))));
        }
        if name == "attach" {
            return Some(Some(Ok(json!({
                "session":"desk-beta", "session_id":"desk-beta-saved", "project":"beta",
                "cwd":args["cwd"], "provenance":"taken_over", "busy":false,
                "turn_open":false, "model":"anthropic/current", "thinking":"medium"
            }))));
        }
        if name == "prompt"
            && prompt_calls_for_host.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1
        {
            return Some(Some(Err((
                "failed".into(),
                "takeover prompt failed".into(),
            ))));
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    board
        .transfer_ctx(&transcript("connect alpha"), "alpha", "", "")
        .await;
    assert_eq!(board.coordinator.route(), "alpha");

    let reply = board
        .handle_decision(
            "take over beta",
            &Decision {
                action: Action::TakeOver,
                target: Some("beta".into()),
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 0.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "test".into(),
            },
        )
        .await;
    assert_eq!(reply.route, "alpha");
    assert_eq!(board.route_label(), "alpha");
    assert_eq!(
        board
            .session_control()
            .lock()
            .await
            .as_ref()
            .map(LegSession::label),
        Some("alpha")
    );

    let continued = board
        .handle_decision(
            "continue alpha",
            &Decision {
                action: Action::Continue,
                target: None,
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 1.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "test".into(),
            },
        )
        .await;
    assert_eq!(continued.route, "alpha");
    assert_eq!(continued.text, "Alpha stayed on the line");
    let prompt_messages = prompts(&log);
    assert_eq!(prompt_messages.len(), 3);
    assert!(prompt_messages[2].contains("continue alpha"));
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn failed_takeover_from_operator_restores_operator_session() {
    let root = scratch_dir("takeover-operator-turn-failure");
    let operator = fake_operator(&root);
    let mut board = board_on(
        vec![project("alpha", "Alpha")],
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
        two_model_catalog(),
    );
    board.ensure_operator().await.expect("operator starts");
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("unused")));
    host.on_command = Some(Box::new(|name, args| {
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [{
                "session":"desk-alpha", "session_id":"desk-saved", "cwd":"/srv/alpha",
                "provenance":null, "busy":false, "model":"anthropic/current", "thinking":"medium"
            }]}))));
        }
        if name == "attach" {
            return Some(Some(Ok(json!({
                "session":"desk-alpha", "session_id":"desk-saved", "project":"alpha",
                "cwd":args["cwd"], "provenance":"taken_over", "busy":false,
                "turn_open":false, "model":"anthropic/current", "thinking":"medium"
            }))));
        }
        if name == "prompt" {
            return Some(Some(Err((
                "failed".into(),
                "operator takeover prompt failed".into(),
            ))));
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let reply = board
        .handle_decision(
            "take over alpha",
            &Decision {
                action: Action::TakeOver,
                target: Some("alpha".into()),
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 0.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "test".into(),
            },
        )
        .await;
    assert_eq!(reply.route, OPERATOR);
    assert!(reply.text.contains("operator takeover prompt failed"));
    assert_eq!(
        board
            .session_control()
            .lock()
            .await
            .as_ref()
            .map(LegSession::label),
        Some("operator")
    );
    assert!(!log.names().contains(&"kill".into()));
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn takeover_attach_failure_rolls_back_without_killing_the_desk_session() {
    let root = scratch_dir("takeover-operator-rollback");
    let operator = fake_operator(&root);
    let mut board = board_on(
        vec![project("alpha", "Alpha")],
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
        two_model_catalog(),
    );
    board.ensure_operator().await.expect("operator starts");
    assert_eq!(
        board
            .session_control()
            .lock()
            .await
            .as_ref()
            .map(LegSession::label),
        Some("operator")
    );
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("unused")));
    host.on_command = Some(Box::new(|name, _| {
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [
                {"session":"desk-alpha","session_id":"desk-saved","cwd":"/srv/alpha","provenance":null,"busy":false}
            ]}))));
        }
        if name == "attach" {
            return Some(Some(Err(("failed".into(), "desk disappeared".into()))));
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let decision = Decision {
        action: Action::TakeOver,
        target: Some("alpha".into()),
        continue_or_fresh: None,
        confidence: 1.0,
        for_current_agent: 0.0,
        multi_target: false,
        unsure: false,
        confirm: false,
        reason: "test".into(),
    };
    let reply = board.handle_decision("take over alpha", &decision).await;
    assert_eq!(reply.route, OPERATOR);
    assert!(reply.text.contains("desk disappeared"));
    assert!(!board.coordinator.is_candidate());
    assert!(!log.names().contains(&"kill".into()));
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn host_loss_closes_a_taken_over_session_without_killing_the_desk_process() {
    let board = board_with(vec![project("alpha", "Alpha")], false);
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
    let closed_tx = Arc::new(StdMutex::new(Some(closed_tx)));
    let callback_tx = closed_tx.clone();
    let host = FakeHostAgent::new(Box::new(|_, _| vec![]));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let launch = ProjectLaunch {
        host: HOST.into(),
        project: "alpha".into(),
        cwd: "/srv/alpha".into(),
        spec: "anthropic/current".into(),
        brief: String::new(),
        turn_timeout: Duration::from_secs(1),
        on_activity: None,
        on_module: None,
        on_turn: None,
        on_closed: Some(Arc::new(move |_, _, _| {
            let callback_tx = callback_tx.clone();
            Box::pin(async move {
                if let Some(tx) = callback_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            })
        })),
        debug: None,
    };
    let (session, _) = ProjectSession::attach(&board.hosts(), launch, "desk-alpha")
        .await
        .unwrap();
    session.join_call("desk-call", "Jev", 1_000).await.unwrap();
    board.hosts().disconnect_fake(HOST);
    closed_rx
        .await
        .expect("host loss closes the taken-over session");
    assert!(!session.alive());
    session.close();
    assert!(!log.names().contains(&"kill".into()));
}
