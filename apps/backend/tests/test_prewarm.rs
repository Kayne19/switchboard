use super::*;
use crate::pi_client::write_executable_script;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::ReadBuf;

#[test]
fn control_socket_path_fits_in_sun_path() {
    // ssh binds "<control_path>.XXXXXXXXXXXXXXXX" (17 extra bytes) and the
    // kernel caps sun_path at 108 including the NUL.
    let path = Path::new("/var/lib/switchboard")
        .join("ssh")
        .join("control")
        .join(format!("{}.sock", host_hash("scriptorium")));
    assert!(
        path.to_string_lossy().len() + 17 < 108,
        "control path too long: {}",
        path.display()
    );
}

fn uuid_like_test() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

fn test_config(root: &Path) -> crate::Config {
    crate::Config {
        env_file: root.join("env"),
        state_dir: root.join("state"),
        config_dir: root.join("config"),
        projects_file: root.join("projects.json"),
        operator_prompt: root.join("prompt.md"),
        operator_extension: None,
        agent_extension: None,
        persona: "".into(),
        stt_command: None,
        stt_stream_command: None,
        bind: "127.0.0.1:0".into(),
        pi_binary: "pi".into(),
        ssh_program: "ssh".into(),
        operator_model: None,
        agent_model: None,
        agent_thinking: "medium".into(),
        remote_cache_dir: ".cache/switchboard".into(),
        model_swaps: true,
        speak_url: "".into(),
        state_url: "".into(),
        diagram_url: "".into(),
        self_url: "".into(),
        idle_timeout: 300.0,
        idle_poll: 10.0,
        max_spoken_chars: 1000,
        speech_deadline_ms: 25000,
        history_limit: 100,
        session: "test-session".into(),
        environment: HashMap::new(),
    }
}

fn fake_pi_script(root: &Path) -> PathBuf {
    let runtime = root.join("fake-pi");
    write_executable_script(
        &runtime,
        "printf 'provider model alias default thinks\\ncustom pi-model pi-model yes yes\\n'",
    );
    runtime
}

struct ReadThenError {
    emitted: bool,
}

impl tokio::io::AsyncRead for ReadThenError {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.emitted {
            Poll::Ready(Err(io::Error::other("simulated channel read failure")))
        } else {
            self.emitted = true;
            buf.put_slice(b"partial catalog");
            Poll::Ready(Ok(()))
        }
    }
}

#[tokio::test]
async fn output_reader_keeps_partial_data_after_a_read_error() {
    let mut reader = ReadThenError { emitted: false };
    assert_eq!(drain_bounded(&mut reader, 4096).await, "partial catalog");
}

fn fake_ssh_script(root: &Path) -> PathBuf {
    let ssh = root.join("fake-ssh");
    write_executable_script(
        &ssh,
        r#"for arg in "$@"; do
if [ "$arg" = "-O" ] || [ "$arg" = "check" ] || [ "$arg" = "exit" ]; then
    exit 0
fi
done
exit 0
"#,
    );
    ssh
}

#[tokio::test]
async fn local_catalog_and_prepare_prewarm() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-test-prewarm-local-{}",
        uuid_like_test()
    ));
    let _ = std::fs::create_dir_all(&root);

    let runtime = fake_pi_script(&root);

    let project = Project {
        id: "local-proj".into(),
        description: "test".into(),
        aliases: vec![],
        host: None,
        cwd: root.to_string_lossy().into_owned(),
        runtime: runtime.to_string_lossy().into_owned(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: "echo prepare_done".into(),
    };

    let registry = Registry::new(vec![project.clone()]);
    let mut config = test_config(&root);
    config.pi_binary = runtime.to_string_lossy().into_owned();

    let prewarm = Prewarm::start(&config, &registry).await;

    let readiness = prewarm
        .await_project(&project)
        .await
        .expect("project readiness");
    assert_eq!(readiness.transport_generation, 0);

    let prep = readiness.prepare_report.expect("prepare report");
    assert_eq!(prep.outcome, PrepareOutcome::Success);
    assert!(prep.stdout.contains("prepare_done"));

    let cat = readiness.catalog.expect("catalog");
    assert!(cat.available);
    assert_eq!(cat.entries.len(), 1);

    prewarm.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn host_deduplication_and_canonicalization() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-test-prewarm-dedup-{}",
        uuid_like_test()
    ));
    let _ = std::fs::create_dir_all(&root);

    let proj1 = Project {
        id: "p1".into(),
        description: "".into(),
        aliases: vec![],
        host: Some(" host.example.com ".into()),
        cwd: "/tmp".into(),
        runtime: "pi".into(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: "".into(),
    };
    let proj2 = Project {
        id: "p2".into(),
        description: "".into(),
        aliases: vec![],
        host: Some("host.example.com".into()),
        cwd: "/tmp".into(),
        runtime: "pi".into(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: "".into(),
    };

    let registry = Registry::new(vec![proj1, proj2]);
    let ssh = fake_ssh_script(&root);
    let mut config = test_config(&root);
    config.ssh_program = ssh.to_string_lossy().into_owned();

    let prewarm = Prewarm::start(&config, &registry).await;
    assert_eq!(prewarm.inner.transports.read().await.len(), 1);
    assert!(prewarm
        .inner
        .transports
        .read()
        .await
        .contains_key("host.example.com"));

    prewarm.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

fn fake_failing_ssh_script(root: &Path) -> PathBuf {
    let ssh = root.join("fake-failing-ssh");
    write_executable_script(&ssh, "exit 1\n");
    ssh
}

#[tokio::test]
async fn remote_transport_degraded_on_ssh_failure_returns_error_to_await_project() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-test-prewarm-degraded-{}",
        uuid_like_test()
    ));
    let _ = std::fs::create_dir_all(&root);

    let proj = Project {
        id: "p1".into(),
        description: "".into(),
        aliases: vec![],
        host: Some("remote.example.com".into()),
        cwd: "/tmp".into(),
        runtime: "pi".into(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: "".into(),
    };

    let registry = Registry::new(vec![proj.clone()]);
    let ssh = fake_failing_ssh_script(&root);
    let mut config = test_config(&root);
    config.ssh_program = ssh.to_string_lossy().into_owned();

    let prewarm = Prewarm::start(&config, &registry).await;

    let res = timeout(Duration::from_secs(5), prewarm.await_project(&proj)).await;
    assert!(
        res.is_ok(),
        "await_project should return within timeout, not hang"
    );
    let readiness_res = res.unwrap();
    assert!(
        readiness_res.is_err(),
        "should return readiness error on degraded transport"
    );
    let err = readiness_res.unwrap_err();
    assert!(
        err.contains("transport degraded"),
        "error should mention transport degraded: {err}"
    );

    prewarm.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn failed_prepare_is_terminal_and_launchable() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-test-prewarm-failprep-{}",
        uuid_like_test()
    ));
    let _ = std::fs::create_dir_all(&root);

    let runtime = fake_pi_script(&root);

    let project = Project {
        id: "fail-prep".into(),
        description: "test".into(),
        aliases: vec![],
        host: None,
        cwd: root.to_string_lossy().into_owned(),
        runtime: runtime.to_string_lossy().into_owned(),
        model: Some("anthropic/claude-3-5-sonnet".into()),
        stage_extension: false,
        extra_args: vec![],
        prepare: "echo error_out >&2; exit 42".into(),
    };

    let registry = Registry::new(vec![project.clone()]);
    let mut config = test_config(&root);
    config.pi_binary = runtime.to_string_lossy().into_owned();

    let prewarm = Prewarm::start(&config, &registry).await;
    let readiness = prewarm
        .await_project(&project)
        .await
        .expect("project readiness");

    let prep = readiness.prepare_report.expect("prepare report");
    assert_eq!(prep.outcome, PrepareOutcome::Nonzero);
    assert_eq!(prep.exit_code, Some(42));
    assert!(prep.stderr.contains("error_out"));

    prewarm.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn startup_returns_before_delayed_work() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-test-prewarm-async-start-{}",
        uuid_like_test()
    ));
    let _ = std::fs::create_dir_all(&root);

    let runtime = fake_pi_script(&root);

    let project = Project {
        id: "slow-prep".into(),
        description: "test".into(),
        aliases: vec![],
        host: None,
        cwd: root.to_string_lossy().into_owned(),
        runtime: runtime.to_string_lossy().into_owned(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: "sleep 0.5".into(),
    };

    let registry = Registry::new(vec![project.clone()]);
    let mut config = test_config(&root);
    config.pi_binary = runtime.to_string_lossy().into_owned();

    let start_time = Instant::now();
    let prewarm = Prewarm::start(&config, &registry).await;
    let elapsed = start_time.elapsed();

    assert!(elapsed < Duration::from_millis(150));

    let readiness = prewarm.await_project(&project).await.unwrap();
    assert_eq!(
        readiness.prepare_report.unwrap().outcome,
        PrepareOutcome::Success
    );

    prewarm.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn transport_generation_mismatch_and_reconnect() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-test-prewarm-gen-mismatch-{}",
        uuid_like_test()
    ));
    let _ = std::fs::create_dir_all(&root);

    let proj = Project {
        id: "p1".into(),
        description: "".into(),
        aliases: vec![],
        host: Some("remote.example.com".into()),
        cwd: "/tmp".into(),
        runtime: "pi".into(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: "".into(),
    };

    let registry = Registry::new(vec![proj]);
    let ssh = fake_ssh_script(&root);
    let mut config = test_config(&root);
    config.ssh_program = ssh.to_string_lossy().into_owned();

    let prewarm = Prewarm::start(&config, &registry).await;

    let transport_lock = prewarm
        .inner
        .transports
        .read()
        .await
        .get("remote.example.com")
        .cloned()
        .unwrap();
    {
        let guard = transport_lock.lock().await;
        guard.state_tx.send_replace(TransportState::Ready {
            generation: 1,
            control_path: Some(guard.control_path.clone()),
        });
    }

    let client_res = prewarm.client_for("remote.example.com", 1);
    assert!(client_res.is_ok());

    let stale_res = prewarm.client_for("remote.example.com", 2);
    assert!(stale_res.is_err());
    assert!(stale_res
        .unwrap_err()
        .contains("transport generation mismatch"));

    {
        let mut guard = transport_lock.lock().await;
        guard.generation = 2;
        guard.state_tx.send_replace(TransportState::Ready {
            generation: 2,
            control_path: Some(guard.control_path.clone()),
        });
    }

    let old_gen_res = prewarm.client_for("remote.example.com", 1);
    assert!(old_gen_res.is_err());

    let new_gen_res = prewarm.client_for("remote.example.com", 2);
    assert!(new_gen_res.is_ok());

    prewarm.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn injected_ssh_program_in_prewarm() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-test-injected-ssh-{}",
        uuid_like_test()
    ));
    let _ = std::fs::create_dir_all(&root);

    let custom_ssh = fake_ssh_script(&root);

    let proj = Project {
        id: "p1".into(),
        description: "".into(),
        aliases: vec![],
        host: Some("remote.example.com".into()),
        cwd: "/tmp".into(),
        runtime: "pi".into(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: "".into(),
    };

    let registry = Registry::new(vec![proj]);
    let mut config = test_config(&root);
    config.ssh_program = custom_ssh.to_string_lossy().into_owned();

    let prewarm = Prewarm::start(&config, &registry).await;

    let transport_lock = prewarm
        .inner
        .transports
        .read()
        .await
        .get("remote.example.com")
        .cloned()
        .unwrap();
    {
        let guard = transport_lock.lock().await;
        guard.state_tx.send_replace(TransportState::Ready {
            generation: 1,
            control_path: Some(guard.control_path.clone()),
        });
    }

    let opts = prewarm.client_for("remote.example.com", 1).unwrap();
    assert_eq!(opts.ssh_program, custom_ssh.to_string_lossy());
    let base_args = opts.base_args();
    assert!(base_args.contains(&"ControlMaster=no".into()));

    prewarm.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn prepare_caching_nonzero_exit_not_retried() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-test-prepare-cached-{}",
        uuid_like_test()
    ));
    let _ = std::fs::create_dir_all(&root);

    let runtime = fake_pi_script(&root);

    let counter_file = root.join("prep_counter.txt");
    let prep_script = format!(
        "count=0\nif [ -f {} ]; then count=$(cat {}); fi\nprintf '%s' \"$((count + 1))\" > {}\nprintf 'failed output\\n' >&2\nexit 5\n",
        crate::pi_client::shell_quote(&counter_file.to_string_lossy()),
        crate::pi_client::shell_quote(&counter_file.to_string_lossy()),
        crate::pi_client::shell_quote(&counter_file.to_string_lossy()),
    );

    let project = Project {
        id: "counter-prep".into(),
        description: "test".into(),
        aliases: vec![],
        host: None,
        cwd: root.to_string_lossy().into_owned(),
        runtime: runtime.to_string_lossy().into_owned(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: prep_script,
    };

    let registry = Registry::new(vec![project.clone()]);
    let mut config = test_config(&root);
    config.pi_binary = runtime.to_string_lossy().into_owned();

    let prewarm = Prewarm::start(&config, &registry).await;

    let r1 = prewarm.await_project(&project).await.unwrap();
    let prep1 = r1.prepare_report.unwrap();
    assert_eq!(prep1.outcome, PrepareOutcome::Nonzero);
    assert_eq!(prep1.exit_code, Some(5));
    assert!(prep1.stderr.contains("failed output"));
    assert_eq!(std::fs::read_to_string(&counter_file).unwrap(), "1");

    let r2 = prewarm.await_project(&project).await.unwrap();
    let prep2 = r2.prepare_report.unwrap();
    assert_eq!(prep2, prep1);
    assert_eq!(std::fs::read_to_string(&counter_file).unwrap(), "1");

    prewarm.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn no_duplicate_prewarm_work_on_concurrent_or_late_transfers() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-test-no-dup-prewarm-{}",
        uuid_like_test()
    ));
    let _ = std::fs::create_dir_all(&root);

    let runtime = fake_pi_script(&root);

    let counter_file = root.join("prep_count.txt");
    let prep_script = format!(
        "count=0\nif [ -f {} ]; then count=$(cat {}); fi\nprintf '%s' \"$((count + 1))\" > {}\nsleep 0.2\n",
        crate::pi_client::shell_quote(&counter_file.to_string_lossy()),
        crate::pi_client::shell_quote(&counter_file.to_string_lossy()),
        crate::pi_client::shell_quote(&counter_file.to_string_lossy()),
    );

    let project = Project {
        id: "shared-prep".into(),
        description: "test".into(),
        aliases: vec![],
        host: None,
        cwd: root.to_string_lossy().into_owned(),
        runtime: runtime.to_string_lossy().into_owned(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: prep_script,
    };

    let registry = Registry::new(vec![project.clone()]);
    let mut config = test_config(&root);
    config.pi_binary = runtime.to_string_lossy().into_owned();

    let prewarm = Prewarm::start(&config, &registry).await;

    let p_clone1 = project.clone();
    let p_clone2 = project.clone();
    let pre1 = prewarm.clone();
    let pre2 = prewarm.clone();

    let task1 = tokio::spawn(async move { pre1.await_project(&p_clone1).await });
    let task2 = tokio::spawn(async move { pre2.await_project(&p_clone2).await });

    let (res1, res2) = tokio::join!(task1, task2);
    assert_eq!(
        res1.unwrap().unwrap().prepare_report.unwrap().outcome,
        PrepareOutcome::Success
    );
    assert_eq!(
        res2.unwrap().unwrap().prepare_report.unwrap().outcome,
        PrepareOutcome::Success
    );

    assert_eq!(std::fs::read_to_string(&counter_file).unwrap(), "1");

    tokio::time::sleep(Duration::from_millis(100)).await;
    let res3 = prewarm.await_project(&project).await.unwrap();
    assert_eq!(
        res3.prepare_report.unwrap().outcome,
        PrepareOutcome::Success
    );
    assert_eq!(std::fs::read_to_string(&counter_file).unwrap(), "1");

    prewarm.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn prepare_shutdown_reaps_child_process() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-test-prep-shutdown-{}",
        uuid_like_test()
    ));
    let _ = std::fs::create_dir_all(&root);

    let runtime = fake_pi_script(&root);
    let pid_file = root.join("prep.pid");
    let hanging_script = format!(
        "echo $$ > {}\nsleep 300\n",
        crate::pi_client::shell_quote(&pid_file.to_string_lossy())
    );
    let project = Project {
        id: "hang-prep".into(),
        description: "test".into(),
        aliases: vec![],
        host: None,
        cwd: root.to_string_lossy().into_owned(),
        runtime: runtime.to_string_lossy().into_owned(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: hanging_script,
    };

    let registry = Registry::new(vec![project]);
    let mut config = test_config(&root);
    config.pi_binary = runtime.to_string_lossy().into_owned();
    let prewarm = Prewarm::start(&config, &registry).await;

    for _ in 0..100 {
        if pid_file.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(pid_file.exists(), "prepare child did not start");
    let pid: i32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();

    prewarm.shutdown().await;

    #[cfg(unix)]
    {
        for _ in 0..100 {
            if unsafe { libc::kill(pid, 0) != 0 } {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            unsafe { libc::kill(pid, 0) != 0 },
            "prepare child should be killed and reaped during shutdown"
        );
    }

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn stage_extension_opt_out() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-test-stage-opt-out-{}",
        uuid_like_test()
    ));
    let _ = std::fs::create_dir_all(&root);

    let ext_file = root.join("agent.ts");
    std::fs::write(&ext_file, "console.log('hi');").unwrap();

    let ssh = fake_ssh_script(&root);

    let project = Project {
        id: "no-stage".into(),
        description: "test".into(),
        aliases: vec![],
        host: Some("remote.example.com".into()),
        cwd: "/tmp".into(),
        runtime: "pi".into(),
        model: Some("anthropic/claude-3-5-sonnet".into()),
        stage_extension: false,
        extra_args: vec![],
        prepare: "".into(),
    };

    let registry = Registry::new(vec![project.clone()]);
    let mut config = test_config(&root);
    config.ssh_program = ssh.to_string_lossy().into_owned();
    config.agent_extension = Some(ext_file.to_string_lossy().into_owned());

    let prewarm = Prewarm::start(&config, &registry).await;

    let readiness = prewarm.await_project(&project).await.unwrap();
    assert!(matches!(
        readiness.artifact_decision,
        ArtifactDecision::None
    ));

    prewarm.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn digest_mismatch_and_lkg_retention() {
    let root =
        std::env::temp_dir().join(format!("switchboard-test-digest-lkg-{}", uuid_like_test()));
    let _ = std::fs::create_dir_all(&root);

    let cdir = root.join("extensions");
    std::fs::create_dir_all(&cdir).unwrap();

    let filename = "agent.ts";
    let target = cdir.join(filename);
    let manifest = cdir.join("agent.ts.digest");

    std::fs::write(&target, "LKG extension content").unwrap();
    std::fs::write(&manifest, "old-digest").unwrap();

    let expected_digest = "0000000000000000000000000000000000000000000000000000000000000000";
    let nonce = "test-nonce";

    let script = format!(
        "umask 077 && CDIR=\"{}\" && mkdir -p \"$CDIR\" && \
         TMP=\"$CDIR/.{filename}.{nonce}.tmp\" && \
         TARGET=\"$CDIR/{filename}\" && \
         MANIFEST=\"$CDIR/{filename}.digest\" && \
         LKG=\"$CDIR/{filename}.lkg\" && \
         LKG_MAN=\"$CDIR/{filename}.digest.lkg\" && \
         cat > \"$TMP\" && \
         REM_DIGEST=$(sha256sum \"$TMP\" 2>/dev/null | awk '{{print $1}}') && \
         if [ -z \"$REM_DIGEST\" ]; then REM_DIGEST=$(shasum -a 256 \"$TMP\" 2>/dev/null | awk '{{print $1}}'); fi && \
         if [ \"$REM_DIGEST\" != \"{expected_digest}\" ]; then rm -f \"$TMP\"; exit 2; fi && \
         chmod 0600 \"$TMP\" && \
         if [ -f \"$TARGET\" ]; then cp -f \"$TARGET\" \"$LKG\" 2>/dev/null || true; cp -f \"$MANIFEST\" \"$LKG_MAN\" 2>/dev/null || true; fi && \
         printf '%s' \"$REM_DIGEST\" > \"$TMP.digest\" && \
         chmod 0600 \"$TMP.digest\" && \
         mv -f \"$TMP\" \"$TARGET\" && \
         mv -f \"$TMP.digest\" \"$MANIFEST\" && \
         printf '%s' \"$TARGET\"",
        cdir.to_string_lossy()
    );

    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();

    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(b"corrupted payload").await;
    }

    let out = child.wait_with_output().await.unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "LKG extension content"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn unsafe_filename_shell_quoting() {
    let root =
        std::env::temp_dir().join(format!("switchboard-test-unsafe-fn-{}", uuid_like_test()));
    let _ = std::fs::create_dir_all(&root);
    let cdir = root.join("extensions");
    std::fs::create_dir_all(&cdir).unwrap();

    let unsafe_filename = "agent;touch-bad.ts";
    let payload = b"test payload";
    let source_digest = format!("{:x}", Sha256::digest(payload));

    let cache_dir_q = crate::pi_client::shell_quote(&cdir.to_string_lossy());
    let fname_q = crate::pi_client::shell_quote(unsafe_filename);
    let nonce_q = crate::pi_client::shell_quote("nonce-123");

    let script = format!(
        "umask 077 && FN={fname_q} && NONCE={nonce_q} && CDIR={cache_dir_q} && mkdir -p \"$CDIR\" && \
         TMP=\"$CDIR/.$FN.$NONCE.tmp\" && \
         TARGET=\"$CDIR/$FN\" && \
         MANIFEST=\"$CDIR/$FN.digest\" && \
         LKG=\"$CDIR/$FN.lkg\" && \
         LKG_MAN=\"$CDIR/$FN.digest.lkg\" && \
         cat > \"$TMP\" && \
         REM_DIGEST=$(sha256sum \"$TMP\" 2>/dev/null | awk '{{print $1}}') && \
         if [ -z \"$REM_DIGEST\" ]; then REM_DIGEST=$(shasum -a 256 \"$TMP\" 2>/dev/null | awk '{{print $1}}'); fi && \
         if [ \"$REM_DIGEST\" != \"{source_digest}\" ]; then rm -f \"$TMP\"; exit 2; fi && \
         chmod 0600 \"$TMP\" && \
         if [ -f \"$TARGET\" ]; then cp -f \"$TARGET\" \"$LKG\" 2>/dev/null || true; cp -f \"$MANIFEST\" \"$LKG_MAN\" 2>/dev/null || true; fi && \
         printf '%s' \"$REM_DIGEST\" > \"$TMP.digest\" && \
         chmod 0600 \"$TMP.digest\" && \
         mv -f \"$TMP\" \"$TARGET\" && \
         mv -f \"$TMP.digest\" \"$MANIFEST\" && \
         printf '%s' \"$TARGET\""
    );

    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();

    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(payload).await;
    }

    let out = child.wait_with_output().await.unwrap();
    assert!(out.status.success());
    let target_file = cdir.join(unsafe_filename);
    assert!(target_file.is_file());
    assert_eq!(std::fs::read(&target_file).unwrap(), payload);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn bounded_shutdown() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-test-bounded-shutdown-{}",
        uuid_like_test()
    ));
    let _ = std::fs::create_dir_all(&root);

    let proj = Project {
        id: "p1".into(),
        description: "".into(),
        aliases: vec![],
        host: Some("remote.example.com".into()),
        cwd: "/tmp".into(),
        runtime: "pi".into(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: "".into(),
    };

    let registry = Registry::new(vec![proj]);
    let ssh = fake_ssh_script(&root);
    let mut config = test_config(&root);
    config.ssh_program = ssh.to_string_lossy().into_owned();

    let prewarm = Prewarm::start(&config, &registry).await;

    let start = Instant::now();
    prewarm.shutdown().await;
    let elapsed = start.elapsed();

    assert!(elapsed < Duration::from_secs(1));

    let _ = std::fs::remove_dir_all(root);
}
