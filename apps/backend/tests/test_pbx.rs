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
    Switchboard::new(
        &crate::Config::for_tests(&[
            ("SWITCHBOARD_MODEL_SWAPS", swaps),
            ("SWITCHBOARD_REMOTE_CACHE_DIR", ".cache"),
        ]),
        Registry::new(projects),
    )
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
fn status_exposes_cached_models_for_the_current_project() {
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
    board.catalogs.insert(
        ":pi".into(),
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
        board.status()["models"],
        serde_json::json!([{"provider":"anthropic","model":"current","thinks":true}])
    );
}

#[tokio::test]
async fn transfer_model_requests_obey_the_swap_gate_and_pin_defaults() {
    let project = Project {
        id: "alpha".into(),
        description: String::new(),
        aliases: vec![],
        host: None,
        cwd: String::new(),
        runtime: "definitely-missing-pi".into(),
        model: Some("anthropic/default".into()),
        stage_extension: true,
        extra_args: vec![],
        prepare: String::new(),
    };

    let mut disabled = board_with(vec![project.clone()], false);
    let (model, note) = disabled
        .select_transfer_model(&project, "other/requested", "high")
        .await;
    assert_eq!(model, "anthropic/default:medium");
    assert!(note.is_empty());

    let mut enabled = board_with(vec![project.clone()], true);
    let (model, note) = enabled.select_transfer_model(&project, "", "").await;
    assert_eq!(model, "anthropic/default:medium");
    assert!(note.is_empty());
    assert!(enabled.catalogs.contains_key(":definitely-missing-pi"));

    let (model, note) = enabled
        .select_transfer_model(&project, "other/requested:high", "")
        .await;
    assert_eq!(model, "other/requested:high");
    assert!(note.is_empty());
}

#[tokio::test]
async fn missing_extension_is_recorded_per_candidate_for_cleanup() {
    let board = board_with(vec![], true);
    assert_eq!(board.stage_extension("host-a", "candidate-a").await, None);
    assert_eq!(board.stage_extension("host-a", "candidate-b").await, None);
    assert_eq!(board.staged_extensions.lock().await.len(), 2);
}

#[test]
fn transfer_handoff_is_silent_but_model_notes_and_failures_are_spoken() {
    let board = board_with(vec![], true);
    let reply = board.reply_with_transfer_turn(Turn {
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
    board.catalogs.insert(
        ":pi".into(),
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
    board.catalogs.insert(
        crate::models::CatalogKey::for_project(&project).to_key_string(),
        ModelCatalog {
            entries: vec![
                crate::models::CatalogEntry {
                    provider: "anthropic".into(),
                    model: "current".into(),
                    thinks: true,
                },
                crate::models::CatalogEntry {
                    provider: "anthropic".into(),
                    model: "next".into(),
                    thinks: true,
                },
            ],
            available: true,
            diagnostic: None,
        },
    );

    let reply = board.set_model("anthropic/next").await;

    assert!(reply.error.is_none());
    assert_eq!(board.status()["model"], "anthropic/next:high");
    board.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn transfer_model_selection_honors_thinking_without_model() {
    let project = Project {
        id: "alpha".into(),
        description: String::new(),
        aliases: vec![],
        host: None,
        cwd: String::new(),
        runtime: "pi".into(),
        model: Some("anthropic/claude-3-5-sonnet".into()),
        stage_extension: true,
        extra_args: vec![],
        prepare: String::new(),
    };

    let mut board = board_with(vec![project.clone()], true);
    board.catalogs.insert(
        ":pi".into(),
        ModelCatalog {
            entries: vec![crate::models::CatalogEntry {
                provider: "anthropic".into(),
                model: "claude-3-5-sonnet".into(),
                thinks: true,
            }],
            available: true,
            diagnostic: None,
        },
    );

    let (model, note) = board.select_transfer_model(&project, "", "high").await;
    assert_eq!(model, "anthropic/claude-3-5-sonnet:high");
    assert!(note.is_empty());
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
        model: None,
        stage_extension: false,
        extra_args: Vec::new(),
        prepare: String::new(),
    };
    let mut board = Switchboard::new(
        &crate::Config::for_tests(&[("SWITCHBOARD_PI_BINARY", &runtime.to_string_lossy())]),
        Registry::new(vec![project]),
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

#[cfg(unix)]
#[tokio::test]
async fn fake_ssh_stages_the_extension_and_returns_its_remote_path() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-stage-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let extension = root.join("agent.ts");
    std::fs::write(&extension, "export default 'staged';\n").unwrap();
    let ssh = root.join("fake-ssh");
    crate::pi_client::write_executable_script(
        &ssh,
        &format!(
            "HOME={}; export HOME\nfor arg in \"$@\"; do command=$arg; done\nexec sh -c \"$command\"\n",
            crate::pi_client::shell_quote(&home.to_string_lossy())
        ),
    );

    let board = Switchboard::new(
        &crate::Config::for_tests(&[("SWITCHBOARD_AGENT_EXTENSION", &extension.to_string_lossy())]),
        Registry::new(Vec::new()),
    );
    let staged = board
        .upload_extension_with(&ssh.to_string_lossy(), "fake-host")
        .await
        .unwrap();
    assert_eq!(
        staged,
        home.join(".cache/switchboard/agent.fake-host.ts")
            .to_string_lossy()
    );
    assert_eq!(
        std::fs::read_to_string(&staged).unwrap(),
        "export default 'staged';\n"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn staging_survives_a_remote_that_stops_reading_before_the_extension_ends() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-earlyclose-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    // Far larger than a pipe buffer, so a remote that stops reading early
    // is guaranteed to break the write rather than merely maybe breaking it.
    let extension = root.join("agent.ts");
    std::fs::write(&extension, "x".repeat(1 << 20)).unwrap();

    // Succeeds, reports the staged path, but consumes only the first bytes.
    let succeeds = root.join("fake-ssh-ok");
    crate::pi_client::write_executable_script(
        &succeeds,
        "head -c 16 > /dev/null\nprintf '%s' /remote/agent.ts\nexit 0\n",
    );
    // Fails the way a missing directory or denied permission would.
    let fails = root.join("fake-ssh-fail");
    crate::pi_client::write_executable_script(
        &fails,
        "printf 'mkdir: permission denied\\n' >&2\nexit 1\n",
    );

    let board = || {
        Switchboard::new(
            &crate::Config::for_tests(&[(
                "SWITCHBOARD_AGENT_EXTENSION",
                &extension.to_string_lossy(),
            )]),
            Registry::new(Vec::new()),
        )
    };

    // The broken pipe is the remote's choice, not a staging failure. Before
    // this was fixed the write error short-circuited and the caller was told
    // staging had failed.
    assert_eq!(
        board()
            .upload_extension_with(&succeeds.to_string_lossy(), "fake-host")
            .await
            .as_deref(),
        Some("/remote/agent.ts")
    );
    // A remote that genuinely fails still falls back to the sentinel, and
    // now does so on the strength of its exit status rather than the write.
    assert_eq!(
        board()
            .upload_extension_with(&fails.to_string_lossy(), "fake-host")
            .await,
        None
    );
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

    // Catalog unavailable (None)
    let qualified =
        board.resolve_model_with_catalog(&project, None, "anthropic/claude-3-5-sonnet", "high");
    assert!(qualified.is_ok());
    let choice = qualified.unwrap();
    assert_eq!(choice.provider, "anthropic");
    assert_eq!(choice.model, "claude-3-5-sonnet");
    assert_eq!(choice.thinking, "high");

    let bare = board.resolve_model_with_catalog(&project, None, "claude-3-5-sonnet", "high");
    assert!(bare.is_err());

    // Catalog marked unavailable (ModelCatalog::unavailable)
    let unavail_cat = ModelCatalog {
        entries: vec![],
        available: false,
        diagnostic: Some("listing failed".into()),
    };
    let qualified_unavail =
        board.resolve_model_with_catalog(&project, Some(&unavail_cat), "openai/gpt-4o", "medium");
    assert!(qualified_unavail.is_ok());
    let bare_unavail =
        board.resolve_model_with_catalog(&project, Some(&unavail_cat), "gpt-4o", "medium");
    assert!(bare_unavail.is_err());
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

    let mut board = Switchboard::new(
        &crate::Config::for_tests(&[("SWITCHBOARD_PI_BINARY", &runtime.to_string_lossy())]),
        Registry::new(vec![alpha, beta]),
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
async fn no_live_setup_when_prewarm_attached() {
    let temp_dir = std::env::temp_dir().join(format!("switchboard-prewarm-test-{}", uuid_like()));
    std::fs::create_dir_all(&temp_dir).unwrap();
    let state_dir = temp_dir.join("state");
    let config =
        crate::Config::for_tests(&[("SWITCHBOARD_STATE_DIR", &state_dir.to_string_lossy())]);

    let project = Project {
        id: "local_proj".into(),
        description: "Local Project".into(),
        aliases: vec![],
        host: None,
        cwd: temp_dir.to_string_lossy().into_owned(),
        runtime: "pi".into(),
        model: Some("anthropic/claude-3-5-sonnet".into()),
        stage_extension: false,
        extra_args: vec![],
        prepare: "echo 'prepare executed'".into(),
    };

    let registry = Registry::new(vec![project.clone()]);
    let prewarm = Arc::new(crate::prewarm::Prewarm::start(&config, &registry).await);
    let mut board = board_with(vec![project.clone()], true);
    board.set_prewarm(prewarm.clone());

    // Select model uses prewarm catalog snapshot without live catalog fetch
    let (model, note) = board.select_transfer_model(&project, "", "").await;
    assert_eq!(model, "anthropic/claude-3-5-sonnet:medium");
    assert!(note.is_empty());

    let readiness = prewarm.await_project(&project).await.unwrap();
    assert_eq!(readiness.transport_generation, 0);

    let _ = std::fs::remove_dir_all(temp_dir);
}

#[tokio::test]
async fn display_pbx_env_and_token_rotation() {
    let board = Switchboard::new(
        &crate::Config::for_tests(&[("SWITCHBOARD_DISPLAY_URL", "http://127.0.0.1:8765/display")]),
        Registry::new(vec![]),
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
    // Use Switchboard::new directly so the operator process also uses the
    // fake-pi binary (board_with hardcodes "pi" as the operator runtime).
    let mut board = Switchboard::new(
        &crate::Config::for_tests(&[("SWITCHBOARD_PI_BINARY", &runtime.to_string_lossy())]),
        Registry::new(vec![project.clone()]),
    );

    // Pre-seed an available catalog so the transfer can resolve the bare
    // model name (without this, load_catalog fetches an unavailable catalog
    // from the fake-pi and the transfer fails with "no model was named").
    board.catalogs.insert(
        crate::models::CatalogKey::for_project(&project).to_key_string(),
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
async fn non_prewarmed_transfer_resolves_bare_model() {
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

    // Pre-seed the catalog so load_catalog (Vacant entry) skips the real fetch.
    board.catalogs.insert(
        crate::models::CatalogKey::for_project(&project).to_key_string(),
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

    let ctx = TransferContext {
        exact_caller_transcript: "connect me".into(),
        derived_intent: String::new(),
        direct_page_transfer_context: None,
        selected_project_id: None,
        return_operator_note: None,
        project_summary: None,
    };

    // Transfer with a bare model name — previously failed with
    // "catalog unavailable to resolve bare model" on non-prewarm paths.
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
