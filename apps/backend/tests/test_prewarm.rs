//! Startup work over the host link: a fake host agent on a `FakeLink` stands
//! in for each host.
use super::*;
use crate::hosts::{FakeHostAgent, FakeLog, Heartbeat, Override};
use std::sync::Mutex as StdMutex;
use tokio::time::timeout;

fn hosts() -> Hosts {
    Hosts::new(HashMap::new(), Heartbeat::default())
}

fn project(host: Option<&str>, prepare: &str) -> Project {
    Project {
        id: "alpha".into(),
        description: String::new(),
        aliases: vec![],
        host: host.map(str::to_owned),
        cwd: "/srv/alpha".into(),
        runtime: "pi".into(),
        model: None,
        stage_extension: false,
        extra_args: vec![],
        prepare: prepare.into(),
    }
}

/// A host agent that answers every command by default, `on_command` first.
fn agent(on_command: Option<Override>) -> FakeHostAgent {
    let mut agent = FakeHostAgent::new(Box::new(|_, _| Vec::new()));
    agent.on_command = on_command;
    agent
}

/// Waits until `log` has seen `count` commands called `name`.
async fn until_commands(log: &FakeLog, name: &str, count: usize) {
    for _ in 0..500 {
        if log.named(name).len() >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("never saw {count} {name} commands: {:?}", log.names());
}

#[tokio::test]
async fn startup_work_runs_on_the_host_as_soon_as_it_links() {
    let hosts = hosts();
    let alpha = project(Some("scriptorium"), "make warm");
    let prewarm = Prewarm::start(&Registry::new(vec![alpha.clone()]), hosts.clone());
    // Nothing to reach yet: a transfer is refused, and names why.
    let refused = prewarm.launch_plan(&alpha).await.unwrap_err();
    assert!(
        refused.contains("scriptorium is not connected"),
        "{refused}"
    );

    let on_command: Override = Box::new(|name, _| {
        (name == "run_prepare").then(|| {
            Some(Ok(json!({
                "outcome": "failed", "exit_code": 3, "signal": null,
                "stdout": "warming", "stderr": "cache miss", "truncated": false, "duration_ms": 40,
            })))
        })
    });
    let log = agent(Some(on_command)).serve(hosts.connect_fake("scriptorium"));
    let plan = prewarm.launch_plan(&alpha).await.unwrap();

    assert_eq!(plan.host, "scriptorium");
    assert!(plan.catalog.available);
    assert_eq!(
        plan.catalog.resolve("next", "").unwrap().spec(),
        "anthropic/next"
    );
    let report = plan.prepare_report.unwrap();
    assert_eq!(report.outcome, PrepareOutcome::Nonzero);
    assert_eq!(report.exit_code, Some(3));
    assert_eq!(
        (report.stdout.as_str(), report.stderr.as_str()),
        ("warming", "cache miss")
    );
    assert_eq!(
        log.named("run_prepare"),
        [json!({"cwd": "/srv/alpha", "command": "make warm", "timeout_ms": 120_000})]
    );
    prewarm.shutdown();
}

#[tokio::test]
async fn a_project_without_a_host_is_refused_without_setup() {
    let alpha = project(None, "");
    let prewarm = Prewarm::start(&Registry::new(vec![alpha.clone()]), hosts());
    let refused = prewarm.launch_plan(&alpha).await.unwrap_err();
    assert!(refused.contains("has no host"), "{refused}");
    prewarm.shutdown();
}

#[tokio::test]
async fn a_settled_prepare_is_final_even_across_links() {
    let hosts = hosts();
    let alpha = project(Some("scriptorium"), "make warm");
    let prewarm = Prewarm::start(&Registry::new(vec![alpha.clone()]), hosts.clone());
    let first = hosts.connect_fake("scriptorium");
    let first_epoch = first.epoch;
    let log = agent(None).serve(first);
    prewarm.launch_plan(&alpha).await.unwrap();
    // A new link, as after a host-agent restart: the catalog is listed
    // again, the prepare command is not.
    let second = agent(None).serve(hosts.connect_fake("scriptorium"));
    assert!(hosts.link_epoch("scriptorium").unwrap() > first_epoch);
    until_commands(&second, "list_models", 1).await;
    prewarm.launch_plan(&alpha).await.unwrap();
    assert_eq!(log.named("run_prepare").len(), 1);
    assert!(second.named("run_prepare").is_empty());
    prewarm.shutdown();
}

#[tokio::test]
async fn a_prepare_cut_off_by_a_lost_link_runs_on_the_next_one() {
    let hosts = hosts();
    let alpha = project(Some("scriptorium"), "make warm");
    let prewarm = Prewarm::start(&Registry::new(vec![alpha.clone()]), hosts.clone());
    // The first host agent never finishes the prepare command.
    let silent: Override = Box::new(|name, _| (name == "run_prepare").then_some(None));
    let first = hosts.connect_fake("scriptorium");
    let first_hosts = hosts.clone();
    let log = agent(Some(silent)).serve(first);
    until_commands(&log, "run_prepare", 1).await;
    let waiting = {
        let (prewarm, alpha) = (prewarm.clone(), alpha.clone());
        tokio::spawn(async move { prewarm.launch_plan(&alpha).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    // The link goes away: the waiting transfer is told, and the command
    // runs again once the host is back.
    first_hosts.disconnect_fake("scriptorium");
    let refused = timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap();
    assert!(refused.unwrap_err().contains("disconnected"));
    let again = agent(None).serve(hosts.connect_fake("scriptorium"));
    until_commands(&again, "run_prepare", 1).await;
    let plan = prewarm.launch_plan(&alpha).await.unwrap();
    assert_eq!(
        plan.prepare_report.unwrap().outcome,
        PrepareOutcome::Success
    );
    prewarm.shutdown();
}

#[tokio::test]
async fn a_failed_listing_leaves_an_unavailable_catalog_that_says_why() {
    let hosts = hosts();
    let alpha = project(Some("scriptorium"), "");
    let prewarm = Prewarm::start(&Registry::new(vec![alpha.clone()]), hosts.clone());
    let failing: Override = Box::new(|name, _| {
        (name == "list_models").then(|| {
            Some(Err((
                "daemon_error".to_owned(),
                "the model registry could not be read".to_owned(),
            )))
        })
    });
    agent(Some(failing)).serve(hosts.connect_fake("scriptorium"));
    let plan = prewarm.launch_plan(&alpha).await.unwrap();
    assert!(!plan.catalog.available);
    assert!(plan
        .catalog
        .diagnostic
        .unwrap()
        .contains("the model registry could not be read"));
    prewarm.shutdown();
}

#[tokio::test]
async fn transfers_wait_for_the_catalog_without_listing_it_themselves() {
    let hosts = hosts();
    let alpha = project(Some("scriptorium"), "");
    let prewarm = Prewarm::start(&Registry::new(vec![alpha.clone()]), hosts.clone());
    // The listing is held until the test releases it.
    let held = Arc::new(StdMutex::new(true));
    let gate = Arc::clone(&held);
    let slow: Override =
        Box::new(move |name, _| (name == "list_models" && *gate.lock().unwrap()).then_some(None));
    let log = agent(Some(slow)).serve(hosts.connect_fake("scriptorium"));
    until_commands(&log, "list_models", 1).await;
    let waiters: Vec<_> = (0..3)
        .map(|_| {
            let (prewarm, alpha) = (prewarm.clone(), alpha.clone());
            tokio::spawn(async move { prewarm.launch_plan(&alpha).await })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(waiters.iter().all(|waiter| !waiter.is_finished()));
    assert_eq!(
        log.named("list_models").len(),
        1,
        "one listing serves every transfer"
    );
    prewarm.shutdown();
    for waiter in waiters {
        waiter.abort();
    }
}

#[test]
fn prepare_results_map_to_reports() {
    let report = prepare_report(
        &json!({"outcome": "timed_out", "exit_code": null, "signal": "SIGKILL", "stdout": "", "stderr": "slow", "truncated": false, "duration_ms": 120004}),
        7,
    );
    assert_eq!(report.outcome, PrepareOutcome::TimedOut);
    assert_eq!(report.exit_code, None);
    assert_eq!(report.timestamp_unix_ms, 7);
    assert_eq!(report.duration_ms, 120_004);
    assert_eq!(
        prepare_report(&json!({"outcome": "succeeded", "exit_code": 0}), 0).outcome,
        PrepareOutcome::Success
    );
}
