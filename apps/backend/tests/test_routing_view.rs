use super::*;
use crate::hosts::FakeHostAgent;
use crate::pbx::{board_with, project, says, HOST};
use serde_json::json;
use std::sync::Arc;
use tokio::time::Duration;

#[tokio::test]
async fn desk_session_hosts_are_listed_concurrently() {
    let alpha = project("alpha", "Alpha");
    let mut beta = project("beta", "Beta");
    beta.host = Some("other".into());
    let board = board_with(vec![alpha.clone(), beta.clone()], false);
    let other_started = Arc::new(tokio::sync::Notify::new());
    let other_started_for_host = other_started.clone();
    let mut blocked = FakeHostAgent::new(Box::new(|_, _| vec![]));
    blocked.on_command = Some(Box::new(|name, _| {
        if name == "list_sessions" {
            return Some(None);
        }
        None
    }));
    let mut fast = FakeHostAgent::new(Box::new(|_, _| vec![]));
    fast.on_command = Some(Box::new(move |name, _| {
        if name == "list_sessions" {
            other_started_for_host.notify_one();
            return Some(Some(Ok(json!({"sessions": []}))));
        }
        None
    }));
    let hosts = board.hosts();
    blocked.serve(hosts.connect_fake(HOST));
    fast.serve(hosts.connect_fake("other"));
    let query = tokio::spawn(Switchboard::live_desk_sessions_from(
        hosts.clone(),
        Arc::clone(&board.registry),
    ));
    tokio::time::timeout(Duration::from_secs(1), other_started.notified())
        .await
        .expect("the second host was queried while the first was pending");
    hosts.disconnect_fake(HOST);
    let sessions = query.await.expect("desk listing completes after host loss");
    assert!(sessions.is_empty());
}

#[tokio::test]
async fn takeover_lists_only_registered_foreign_desk_sessions() {
    let board = board_with(vec![project("alpha", "Alpha")], false);
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("desk")));
    host.on_command = Some(Box::new(|name, _| {
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [
                {"session":"desk-alpha","session_id":"desk-saved","cwd":"/srv/alpha","provenance":null,"busy":false},
                {"session":"other","session_id":"other-saved","cwd":"/srv/other","provenance":null,"busy":false},
                {"session":"service","session_id":"service-saved","cwd":"/srv/alpha","provenance":"created","busy":false}
            ]}))));
        }
        None
    }));
    let _log = host.serve(board.hosts().connect_fake(HOST));
    let sessions = board.live_desk_sessions().await;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].project, "alpha");
    assert_eq!(sessions[0].state, "idle");
    assert_eq!(sessions[0].provenance, "taken_over");
}
