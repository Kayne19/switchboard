use super::*;

#[cfg(unix)]
fn fake_runtime() -> (std::path::PathBuf, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "switchboard-fake-pi-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let runtime = root.join("fake-pi");
    crate::pi_client::write_executable_script(
        &runtime,
        r##"operator=0
for arg in "$@"; do
if [ "$arg" = "--no-builtin-tools" ]; then operator=1; fi
done
count=0
while IFS= read -r line; do
count=$((count + 1))
if [ "$operator" -eq 1 ]; then
    if [ "$count" -eq 1 ]; then
        printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Connecting now."}}'
        printf '%s\n' '{"type":"tool_execution_start","toolName":"transfer_to_project","args":{"project":"alpha","intent":"inspect it"}}'
    else
        printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Operator has you again."}}'
    fi
else
    if [ "$count" -eq 1 ]; then
        printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Alpha is ready."}}'
    else
        printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Alpha finished."}}'
        printf '%s\n' '{"type":"tool_execution_start","toolName":"return_to_operator","args":{"summary":"work complete"}}'
    fi
fi
printf '%s\n' '{"type":"agent_settled"}'
done
"##,
    );
    (root, runtime)
}

fn board_with(projects: Vec<Project>, model_swaps: bool) -> Switchboard {
    let swaps = if model_swaps { "1" } else { "0" };
    board_on(
        projects,
        &[("SWITCHBOARD_MODEL_SWAPS", swaps)],
        two_model_catalog(),
    )
}

/// A switchboard over a prewarm that has already settled, every project's
/// catalog being `catalog`.
fn board_on(
    projects: Vec<Project>,
    settings: &[(&str, &str)],
    catalog: ModelCatalog,
) -> Switchboard {
    let config = crate::Config::for_tests(settings);
    let registry = Registry::new(projects);
    let prewarm = crate::prewarm::Prewarm::settled(&config, &registry, catalog);
    Switchboard::new(&config, registry, Arc::new(prewarm))
}

#[test]
fn leg_state_rejects_stale_session_tokens() {
    let leg = LiveLegState::new();
    leg.set_session("alpha", "new-session");
    assert!(!leg.report_thinking("old-session", "high"));
    assert!(leg.report_thinking("new-session", "high"));
}

#[test]
fn status_exposes_project_ids() {
    let project = Project {
        id: "alpha".into(),
        description: "Alpha project".into(),
        aliases: vec!["a".into()],
        host: None,
        cwd: "/srv/alpha".into(),
        runtime: "pi".into(),
        model: None,
        stage_extension: true,
        extra_args: vec![],
        prepare: String::new(),
    };
    let board = board_with(vec![project], true);
    assert_eq!(board.status()["projects"], serde_json::json!(["alpha"]));
}

#[test]
fn state_starts_on_operator() {
    let board = board_with(vec![], true);
    assert_eq!(board.route(), OPERATOR);
    assert_eq!(board.status()["route"], OPERATOR);
    assert_eq!(board.status()["models"], serde_json::json!([]));
}

#[test]
fn status_exposes_the_launch_catalog_for_the_current_project() {
    let project = Project {
        id: "alpha".into(),
        description: String::new(),
        aliases: vec![],
        host: None,
        cwd: String::new(),
        runtime: "pi".into(),
        model: None,
        stage_extension: true,
        extra_args: vec![],
        prepare: String::new(),
    };
    let mut board = board_with(vec![project.clone()], true);
    board.route = project.id.clone();
    board.project = Some(project);
    board.model_spec = "anthropic/current:high".into();
    board.leg_catalog = Some(ModelCatalog {
        entries: vec![crate::models::CatalogEntry {
            provider: "anthropic".into(),
            model: "current".into(),
            thinks: true,
        }],
        available: true,
        diagnostic: None,
    });
    assert_eq!(
        board.status()["models"],
        serde_json::json!([{"provider":"anthropic","model":"current","thinks":true}])
    );
}

#[test]
fn transfer_model_requests_obey_the_swap_gate_and_pin_defaults() {
    let project = Project {
        id: "alpha".into(),
        description: String::new(),
        aliases: vec![],
        host: None,
        cwd: String::new(),
        runtime: "pi".into(),
        model: Some("anthropic/default".into()),
        stage_extension: true,
        extra_args: vec![],
        prepare: String::new(),
    };
    let unlisted = ModelCatalog::unavailable("listing failed");

    let disabled = board_with(vec![project.clone()], false);
    assert_eq!(
        disabled.select_transfer_model(&project, &unlisted, "other/requested", "high"),
        Ok("anthropic/default:medium".into())
    );

    let enabled = board_with(vec![project.clone()], true);
    assert_eq!(
        enabled.select_transfer_model(&project, &unlisted, "", ""),
        Ok("anthropic/default:medium".into())
    );
    assert_eq!(
        enabled.select_transfer_model(&project, &unlisted, "other/requested:high", ""),
        Ok("other/requested:high".into())
    );
}

#[test]
fn transfer_handoff_is_silent_but_model_notes_and_failures_are_spoken() {
    let board = board_with(vec![], true);
    let reply = board.reply_with_turn(Turn {
        text: "Ready.".into(),
        signals: vec![],
        failed: false,
        error: String::new(),
    });
    assert_eq!(reply.to_speak, ["Ready."]);

    let failed =
        board.reply_transfer_error("The project did not answer.".into(), Some("failed".into()));
    assert_eq!(failed.to_speak, ["The project did not answer."]);
}

#[tokio::test]
async fn model_swap_refuses_unknown_catalog_model_without_replacing_live_spec() {
    let project = Project {
        id: "alpha".into(),
        description: String::new(),
        aliases: vec![],
        host: None,
        cwd: String::new(),
        runtime: "pi".into(),
        model: None,
        stage_extension: false,
        extra_args: Vec::new(),
        prepare: String::new(),
    };
    let mut board = board_with(vec![project.clone()], true);
    board.project = Some(project);
    board.route = "alpha".into();
    board.model_spec = "anthropic/current:high".into();

    let reply = board.set_model("anthropic/missing").await;

    assert!(reply.error.is_some());
    assert_eq!(board.model_spec, "anthropic/current:high");
}

#[cfg(unix)]
#[tokio::test]
async fn page_model_swap_preserves_requested_thinking() {
    let (root, runtime) = fake_runtime();
    let project = Project {
        id: "alpha".into(),
        description: String::new(),
        aliases: vec![],
        host: None,
        cwd: root.to_string_lossy().into_owned(),
        runtime: runtime.to_string_lossy().into_owned(),
        model: None,
        stage_extension: false,
        extra_args: Vec::new(),
        prepare: String::new(),
    };
    let mut board = board_with(vec![project.clone()], true);
    board.project = Some(project.clone());
    board.route = "alpha".into();
    board.model_spec = "anthropic/current:high".into();

    let reply = board.set_model("anthropic/next").await;

    assert!(reply.error.is_none());
    assert_eq!(board.status()["model"], "anthropic/next:high");
    board.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn transfer_model_selection_honors_thinking_without_model() {
    let project = Project {
        id: "alpha".into(),
        description: String::new(),
        aliases: vec![],
        host: None,
        cwd: String::new(),
        runtime: "pi".into(),
        model: Some("anthropic/current".into()),
        stage_extension: true,
        extra_args: vec![],
        prepare: String::new(),
    };
    let board = board_with(vec![project.clone()], true);
    assert_eq!(
        board.select_transfer_model(&project, &two_model_catalog(), "", "high"),
        Ok("anthropic/current:high".into())
    );
}

#[tokio::test]
async fn transfer_ctx_ambiguous_project_returns_candidate_options() {
    let p1 = Project {
        id: "proj-a".into(),
        description: String::new(),
        aliases: vec!["shared".into()],
        host: None,
        cwd: String::new(),
        runtime: "pi".into(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: String::new(),
    };
    let p2 = Project {
        id: "proj-b".into(),
        description: String::new(),
        aliases: vec!["shared".into()],
        host: None,
        cwd: String::new(),
        runtime: "pi".into(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: String::new(),
    };

    let mut board = board_with(vec![p1, p2], true);
    let ctx = TransferContext {
        exact_caller_transcript: "transfer to shared".into(),
        derived_intent: String::new(),
        direct_page_transfer_context: None,
        selected_project_id: None,
        return_operator_note: None,
        project_summary: None,
    };

    let reply = board.transfer_ctx(&ctx, "shared", "", "").await;
    assert!(reply
        .to_speak
        .iter()
        .any(|s| s.contains("Which project did you mean by shared? Candidates: proj-a, proj-b.")));
    assert!(board
        .operator_note
        .as_deref()
        .unwrap_or("")
        .contains("was ambiguous"));
}

#[cfg(unix)]
#[tokio::test]
async fn fake_pi_process_completes_transfer_and_return_lifecycle() {
    let (root, runtime) = fake_runtime();
    let project = Project {
        id: "alpha".into(),
        description: "test project".into(),
        aliases: vec!["alpha project".into()],
        host: None,
        cwd: root.to_string_lossy().into_owned(),
        runtime: runtime.to_string_lossy().into_owned(),
        model: Some("anthropic/current".into()),
        stage_extension: false,
        extra_args: Vec::new(),
        prepare: String::new(),
    };
    let mut board = board_on(
        vec![project],
        &[("SWITCHBOARD_PI_BINARY", &runtime.to_string_lossy())],
        two_model_catalog(),
    );
    let statuses = Arc::new(StdMutex::new(Vec::new()));
    let statuses_for_callback = Arc::clone(&statuses);
    board.set_route_callback(Some(Arc::new(move |status| {
        let statuses = Arc::clone(&statuses_for_callback);
        Box::pin(async move {
            statuses.lock().unwrap().push(status);
        })
    })));

    let connected = board.handle("put me through").await;
    assert_eq!(connected.route, "alpha");
    assert_eq!(connected.text, "Alpha is ready.");
    assert_eq!(board.route(), "alpha");
    let first_project_status = statuses
        .lock()
        .unwrap()
        .iter()
        .find(|status| status["route"] == "alpha")
        .cloned()
        .expect("project status should be announced");
    assert_ne!(
        first_project_status["models_diagnostic"],
        "model catalog has not been loaded"
    );

    let returned = board.handle("we are done").await;
    assert_eq!(returned.route, OPERATOR);
    assert!(returned.text.contains("Alpha finished."));
    assert!(returned.text.contains("Operator has you again."));
    assert_eq!(board.route(), OPERATOR);

    board.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn unicode_payload_preserved_in_transfer_context_and_intro_prompt() {
    let unicode_text = "Caller voice text with Unicode: 🌐 🚀 日本語, emoji, and quote \"hello\".";
    let context = TransferContext {
        exact_caller_transcript: unicode_text.to_owned(),
        derived_intent: "intent with 日本語".to_owned(),
        direct_page_transfer_context: None,
        selected_project_id: Some("alpha".to_owned()),
        return_operator_note: None,
        project_summary: None,
    };
    let project = Project {
        id: "alpha".into(),
        description: "Alpha project".into(),
        aliases: vec![],
        host: None,
        cwd: "/srv/alpha".into(),
        runtime: "pi".into(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: String::new(),
    };
    let intro = build_intro_prompt(&context, &project, None);
    assert!(intro.contains(unicode_text));
    assert!(intro.contains("intent with 日本語"));
    assert!(intro.contains(&format!("Bytes: {}", unicode_text.len())));
}

#[test]
fn model_fallback_preserves_qualified_and_rejects_bare_when_catalog_unavailable() {
    let project = Project {
        id: "alpha".into(),
        description: String::new(),
        aliases: vec![],
        host: None,
        cwd: String::new(),
        runtime: "pi".into(),
        model: None,
        stage_extension: false,
        extra_args: Vec::new(),
        prepare: String::new(),
    };
    let board = board_with(vec![project.clone()], true);
    let unlisted = ModelCatalog::unavailable("listing failed");

    assert_eq!(
        board.select_transfer_model(&project, &unlisted, "anthropic/claude-3-5-sonnet", "high"),
        Ok("anthropic/claude-3-5-sonnet:high".into())
    );
    let bare = board.select_transfer_model(&project, &unlisted, "claude-3-5-sonnet", "high");
    assert!(bare.unwrap_err().contains("listing failed"));
}

#[cfg(unix)]
#[tokio::test]
async fn direct_agent_to_agent_transfer_context_and_no_prepended_text() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-direct-transfer-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let runtime = root.join("fake-pi");
    crate::pi_client::write_executable_script(
        &runtime,
        r##"mode=""
for arg in "$@"; do
if [ "$arg" = "--no-builtin-tools" ]; then mode="operator"; fi
done
count=0
while IFS= read -r line; do
count=$((count + 1))
if [ "$mode" = "operator" ]; then
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Handoff to alpha."}}'
    printf '%s\n' '{"type":"tool_execution_start","toolName":"transfer_to_project","args":{"project":"alpha","intent":"start work"}}'
else
    if [ "$count" -eq 1 ]; then
        if echo "$line" | grep -q "ID: beta"; then
            printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Beta response."}}'
        else
            printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Alpha response."}}'
        fi
    else
        if echo "$line" | grep -q "ID: beta"; then
            printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Beta done."}}'
        else
            printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Alpha transferring to Beta."}}'
            printf '%s\n' '{"type":"tool_execution_start","toolName":"transfer_to_project","args":{"project":"beta","intent":"continue work"}}'
        fi
    fi
fi
printf '%s\n' '{"type":"agent_settled"}'
done
"##,
    );

    let alpha = Project {
        id: "alpha".into(),
        description: "Alpha project".into(),
        aliases: vec![],
        host: None,
        cwd: root.to_string_lossy().into_owned(),
        runtime: runtime.to_string_lossy().into_owned(),
        model: None,
        stage_extension: false,
        extra_args: Vec::new(),
        prepare: String::new(),
    };
    let beta = Project {
        id: "beta".into(),
        description: "Beta project".into(),
        aliases: vec![],
        host: None,
        cwd: root.to_string_lossy().into_owned(),
        runtime: runtime.to_string_lossy().into_owned(),
        model: None,
        stage_extension: false,
        extra_args: Vec::new(),
        prepare: String::new(),
    };

    let mut board = board_on(
        vec![alpha, beta],
        &[
            ("SWITCHBOARD_PI_BINARY", &runtime.to_string_lossy()),
            ("SWITCHBOARD_AGENT_MODEL", "anthropic/current"),
        ],
        two_model_catalog(),
    );

    let r1 = board.handle("connect me to alpha").await;
    assert_eq!(r1.route, "alpha");
    assert_eq!(r1.text, "Alpha response.");

    // Direct agent-to-agent transfer: Alpha transfers to Beta
    let r2 = board.handle("please hand off to beta").await;
    assert_eq!(r2.route, "beta");
    assert_eq!(r2.text, "Beta response.");
    assert_eq!(r2.to_speak, vec!["Beta response."]);
    assert!(!r2.text.contains("Alpha transferring to Beta."));

    board.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn display_pbx_env_and_token_rotation() {
    let board = board_on(
        vec![],
        &[("SWITCHBOARD_DISPLAY_URL", "http://127.0.0.1:8765/display")],
        two_model_catalog(),
    );

    assert_eq!(board.display_url, "http://127.0.0.1:8765/display");

    // Verify agent_env passes SWITCHBOARD_DISPLAY_URL
    let env = board.agent_env("test-leg-token-123");
    assert_eq!(
        env.get("SWITCHBOARD_DISPLAY_URL").map(String::as_str),
        Some("http://127.0.0.1:8765/display")
    );
    assert_eq!(
        env.get("SWITCHBOARD_SESSION_TOKEN").map(String::as_str),
        Some("test-leg-token-123")
    );

    // Verify token rotation
    let rotated_env = board.agent_env("test-rotated-token-456");
    assert_eq!(
        rotated_env
            .get("SWITCHBOARD_SESSION_TOKEN")
            .map(String::as_str),
        Some("test-rotated-token-456")
    );
    assert_eq!(
        rotated_env
            .get("SWITCHBOARD_DISPLAY_URL")
            .map(String::as_str),
        Some("http://127.0.0.1:8765/display")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn return_to_operator_carries_handback_note() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-handback-note-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let runtime = root.join("fake-pi");
    crate::pi_client::write_executable_script(
        &runtime,
        r##"operator=0
for arg in "$@"; do
if [ "$arg" = "--no-builtin-tools" ]; then operator=1; fi
done
count=0
while IFS= read -r line; do
count=$((count + 1))
if [ "$operator" -eq 1 ]; then
    if [ "$count" -eq 1 ]; then
        printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Connecting now."}}'
        printf '%s\n' '{"type":"tool_execution_start","toolName":"transfer_to_project","args":{"project":"alpha","intent":"test","model":"anthropic/current"}}'
    else
        case "$line" in
            *"work complete"*) marker="NOTE_DELIVERED" ;;
            *) marker="NOTE_MISSING" ;;
        esac
        printf '%s\n' "{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_end\",\"content\":\"$marker\"}}"
    fi
else
    if [ "$count" -eq 1 ]; then
        printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Agent ready."}}'
    else
        printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Agent done."}}'
        printf '%s\n' '{"type":"tool_execution_start","toolName":"return_to_operator","args":{"summary":"work complete"}}'
    fi
fi
printf '%s\n' '{"type":"agent_settled"}'
done
"##,
    );

    let project = Project {
        id: "alpha".into(),
        description: "test project".into(),
        aliases: vec!["alpha project".into()],
        host: None,
        cwd: root.to_string_lossy().into_owned(),
        runtime: runtime.to_string_lossy().into_owned(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: String::new(),
    };
    // The operator runs the same fake runtime as the project leg.
    let mut board = board_on(
        vec![project.clone()],
        &[("SWITCHBOARD_PI_BINARY", &runtime.to_string_lossy())],
        two_model_catalog(),
    );

    // Operator transfers to alpha.
    let transfer_reply = board.handle("put me through").await;
    assert_eq!(
        board.route(),
        "alpha",
        "transfer failed; reply text: {:?}, error: {:?}",
        transfer_reply.text,
        transfer_reply.error
    );

    // Agent returns to operator with summary "work complete".
    let return_reply = board.handle("we are done").await;
    assert_eq!(board.route(), OPERATOR);
    // The operator's second prompt must contain the handback note; the fake-pi
    // emits NOTE_DELIVERED only if it saw "work complete" in that prompt line.
    assert!(
        return_reply.text.contains("NOTE_DELIVERED"),
        "operator did not receive handback note; got: {:?}",
        return_reply.text
    );

    board.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn a_transfer_resolves_a_bare_model_against_the_launch_catalog() {
    let (root, runtime) = fake_runtime();
    let project = Project {
        id: "alpha".into(),
        description: "test project".into(),
        aliases: vec![],
        host: None,
        cwd: root.to_string_lossy().into_owned(),
        runtime: runtime.to_string_lossy().into_owned(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: String::new(),
    };
    let mut board = board_with(vec![project.clone()], true);

    let ctx = TransferContext {
        exact_caller_transcript: "connect me".into(),
        derived_intent: String::new(),
        direct_page_transfer_context: None,
        selected_project_id: None,
        return_operator_note: None,
        project_summary: None,
    };

    let reply = board.transfer_ctx(&ctx, "alpha", "current", "").await;
    assert!(reply.error.is_none(), "transfer failed: {:?}", reply.error);
    assert_eq!(board.route(), "alpha");
    assert!(
        board.model_spec.contains("anthropic/current"),
        "model_spec did not resolve bare name; got: {:?}",
        board.model_spec
    );

    board.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}

// ---------------------------------------------------------------------------
// Prewarm is the only owner of launch setup. These drive the PBX through a
// prewarm whose startup work has already settled (`Prewarm::settled`) and
// check that a transfer or redial does no setup of its own.

#[cfg(unix)]
fn scratch_dir(label: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("switchboard-{label}-{}", uuid_like()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// An ssh stand-in that records every remote command it is given, one line
/// each, and runs only agent launches (`... exec <runtime> ...`), locally.
/// Anything else -- extension staging, a catalog listing -- is recorded and
/// refused, so a test can see that it was attempted without it touching this
/// machine.
#[cfg(unix)]
fn recording_ssh(root: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let ssh = root.join("fake-ssh");
    let log = root.join("ssh.log");
    crate::pi_client::write_executable_script(
        &ssh,
        &format!(
            r#"for last; do :; done
printf '%s\n' "$(printf '%s' "$last" | tr '\n' ' ')" >> '{log}'
case "$last" in
  *"exec "*) exec sh -c "$last" ;;
  *) exit 1 ;;
esac
"#,
            log = log.display()
        ),
    );
    (ssh, log)
}

/// A project runtime that answers every prompt and records any
/// `--list-models` call, so a test can tell whether the catalog was listed
/// live rather than taken from prewarm.
#[cfg(unix)]
fn recording_runtime(root: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let runtime = root.join("fake-project-pi");
    let log = root.join("listings.log");
    crate::pi_client::write_executable_script(
        &runtime,
        &format!(
            r#"if [ "$1" = "--list-models" ]; then
  printf 'listed\n' >> '{log}'
  printf 'provider model alias default thinks\nanthropic current current yes yes\nanthropic next next no yes\n'
  exit 0
fi
while IFS= read -r line; do
  printf '%s\n' '{{"type":"message_update","assistantMessageEvent":{{"type":"text_end","content":"On it."}}}}'
  printf '%s\n' '{{"type":"agent_settled"}}'
done
"#,
            log = log.display()
        ),
    );
    (runtime, log)
}

fn two_model_catalog() -> ModelCatalog {
    ModelCatalog {
        entries: ["current", "next"]
            .into_iter()
            .map(|model| crate::models::CatalogEntry {
                provider: "anthropic".into(),
                model: model.into(),
                thinks: true,
            })
            .collect(),
        available: true,
        diagnostic: None,
    }
}

fn project_on(host: Option<&str>, cwd: &std::path::Path, runtime: &std::path::Path) -> Project {
    Project {
        id: "alpha".into(),
        description: String::new(),
        aliases: vec![],
        host: host.map(str::to_owned),
        cwd: cwd.to_string_lossy().into_owned(),
        runtime: runtime.to_string_lossy().into_owned(),
        model: Some("anthropic/current".into()),
        stage_extension: true,
        extra_args: vec![],
        prepare: String::new(),
    }
}

fn transcript(text: &str) -> TransferContext {
    TransferContext {
        exact_caller_transcript: text.into(),
        ..TransferContext::default()
    }
}

fn read_lines(path: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

#[cfg(unix)]
#[tokio::test]
async fn a_sentinel_extension_launches_the_remote_leg_without_staging_anything() {
    let root = scratch_dir("sentinel");
    let (ssh, ssh_log) = recording_ssh(&root);
    let (runtime, _) = recording_runtime(&root);
    let extension = root.join("agent-switchboard.ts");
    std::fs::write(&extension, "export default () => {};").unwrap();
    let config = crate::Config::for_tests(&[
        ("SWITCHBOARD_SSH_PROGRAM", &ssh.to_string_lossy()),
        ("SWITCHBOARD_AGENT_EXTENSION", &extension.to_string_lossy()),
        (
            "SWITCHBOARD_STATE_DIR",
            &root.join("state").to_string_lossy(),
        ),
    ]);
    let project = project_on(Some("fake-host"), &root, &runtime);
    let registry = Registry::new(vec![project.clone()]);
    // Startup could not stage the extension on this host.
    let prewarm = crate::prewarm::Prewarm::settled(&config, &registry, two_model_catalog());
    let mut board = Switchboard::new(&config, registry, Arc::new(prewarm));

    let reply = board
        .transfer_ctx(&transcript("look at alpha"), "alpha", "", "")
        .await;

    assert_eq!(reply.route, "alpha", "{reply:?}");
    assert_eq!(reply.error, None);
    let commands = read_lines(&ssh_log);
    assert_eq!(
        commands.len(),
        1,
        "the transfer should run the agent and nothing else: {commands:#?}"
    );
    assert!(commands[0].contains("exec "));
    assert!(
        !commands[0].contains("'-e'"),
        "no extension was staged, so none may be loaded: {}",
        commands[0]
    );
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn a_redial_resolves_against_the_launch_catalog_without_listing_models() {
    let root = scratch_dir("redial-catalog");
    let (runtime, listings) = recording_runtime(&root);
    let config = crate::Config::for_tests(&[(
        "SWITCHBOARD_STATE_DIR",
        &root.join("state").to_string_lossy(),
    )]);
    let project = project_on(None, &root, &runtime);
    let registry = Registry::new(vec![project.clone()]);
    let prewarm = crate::prewarm::Prewarm::settled(&config, &registry, two_model_catalog());
    let mut board = Switchboard::new(&config, registry, Arc::new(prewarm));

    let reply = board
        .transfer_ctx(&transcript("look at alpha"), "alpha", "", "")
        .await;
    assert_eq!(reply.route, "alpha", "{reply:?}");
    let reply = board.set_model("next").await;

    assert_eq!(reply.error, None, "{reply:?}");
    assert_eq!(board.model_spec, "anthropic/next:medium");
    assert_eq!(
        read_lines(&listings),
        Vec::<String>::new(),
        "the model catalog was listed at redial time instead of taken from prewarm"
    );
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn a_redial_that_cannot_reach_the_host_refuses_and_keeps_the_live_leg() {
    let root = scratch_dir("redial-degraded");
    let (ssh, ssh_log) = recording_ssh(&root);
    let (runtime, _) = recording_runtime(&root);
    let config = crate::Config::for_tests(&[
        ("SWITCHBOARD_SSH_PROGRAM", &ssh.to_string_lossy()),
        (
            "SWITCHBOARD_STATE_DIR",
            &root.join("state").to_string_lossy(),
        ),
    ]);
    let mut project = project_on(Some("fake-host"), &root, &runtime);
    project.stage_extension = false;
    let registry = Registry::new(vec![project.clone()]);
    let prewarm = Arc::new(crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        two_model_catalog(),
    ));
    let mut board = Switchboard::new(&config, registry, Arc::clone(&prewarm));
    let reply = board
        .transfer_ctx(&transcript("look at alpha"), "alpha", "", "")
        .await;
    assert_eq!(reply.route, "alpha", "{reply:?}");
    let live_session = board.session_id.clone();

    prewarm.settle_transport(
        "fake-host",
        crate::prewarm::TransportState::Degraded {
            generation: 1,
            reason: "master connection lost".into(),
        },
    );
    let reply = board.redial("anthropic/next", "", "", false).await;

    assert!(reply.error.is_some(), "{reply:?}");
    assert_eq!(board.route(), "alpha");
    assert_eq!(board.session_id, live_session);
    assert_eq!(board.model_spec, "anthropic/current:medium");
    assert_eq!(
        read_lines(&ssh_log).len(),
        1,
        "the redial opened a connection of its own instead of refusing"
    );
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn an_unavailable_catalog_admits_a_qualified_model_and_refuses_a_bare_one() {
    for (agent_model, admitted) in [("anthropic/current", true), ("current", false)] {
        let root = scratch_dir("catalog-unavailable");
        let (runtime, _) = recording_runtime(&root);
        let config = crate::Config::for_tests(&[
            ("SWITCHBOARD_AGENT_MODEL", agent_model),
            (
                "SWITCHBOARD_STATE_DIR",
                &root.join("state").to_string_lossy(),
            ),
        ]);
        let mut project = project_on(None, &root, &runtime);
        project.model = None;
        let registry = Registry::new(vec![project.clone()]);
        let prewarm = crate::prewarm::Prewarm::settled(&config, &registry, two_model_catalog());
        prewarm.settle_catalog(
            &project,
            crate::prewarm::CatalogState::Unavailable {
                reason: "listing timed out".into(),
            },
        );
        let mut board = Switchboard::new(&config, registry, Arc::new(prewarm));

        let reply = board
            .transfer_ctx(&transcript("look at alpha"), "alpha", "", "")
            .await;

        if admitted {
            assert_eq!(reply.route, "alpha", "{reply:?}");
            assert_eq!(board.model_spec, "anthropic/current:medium");
        } else {
            assert_eq!(reply.route, OPERATOR, "{reply:?}");
            let error = reply.error.unwrap_or_default();
            assert!(error.contains("bare model"), "{error}");
        }
        board.shutdown().await;
        let _ = std::fs::remove_dir_all(root);
    }
}
