use super::*;

#[test]
fn reads_switchboard_names_and_defaults() {
    let values = HashMap::from([
        ("SWITCHBOARD_CONFIG_DIR".into(), "/tmp/switchboard".into()),
        ("SWITCHBOARD_MODEL_SWAPS".into(), "false".into()),
        ("SWITCHBOARD_HISTORY_LIMIT".into(), "12".into()),
    ]);
    let config = Config::from_values(&values, PathBuf::from("/tmp/env"));
    assert_eq!(
        config.projects_file,
        PathBuf::from("/tmp/switchboard/projects.json")
    );
    assert!(!config.model_swaps);
    assert_eq!(config.history_limit, 12);
}

#[test]
fn non_finite_numeric_configuration_falls_back_safely() {
    let values = HashMap::from([
        ("SWITCHBOARD_MAX_SPOKEN_CHARS".into(), "-inf".into()),
        ("SWITCHBOARD_HISTORY_LIMIT".into(), "12.5".into()),
    ]);
    let config = Config::from_values(&values, PathBuf::from("/tmp/env"));
    assert_eq!(config.max_spoken_chars, 700);
    assert_eq!(config.history_limit, 200);
}

#[test]
fn env_file_parser_keeps_audio_secrets_available() {
    let path = std::env::temp_dir().join(format!("switchboard-env-{}", std::process::id()));
    fs::write(
        &path,
        "export ELEVENLABS_API_KEY='secret#value'\nSWITCHBOARD_PI_BINARY=pi-custom # deployed binary\nQUOTED=\"line\\nvalue\"\nUNCHANGED=a#b\n9INVALID=no\n",
    )
    .unwrap();
    let values = load_env_file(&path);
    let _ = fs::remove_file(path);
    assert_eq!(
        values.get("SWITCHBOARD_PI_BINARY"),
        Some(&"pi-custom".to_owned())
    );
    assert_eq!(
        values.get("ELEVENLABS_API_KEY"),
        Some(&"secret#value".to_owned())
    );
    assert_eq!(values.get("QUOTED"), Some(&"line\nvalue".to_owned()));
    assert_eq!(values.get("UNCHANGED"), Some(&"a#b".to_owned()));
    assert!(!values.contains_key("9INVALID"));
}

#[test]
fn speech_deadline_is_parsed_once_with_its_default() {
    assert_eq!(Config::for_tests(&[]).speech_deadline_ms, 25_000);
    let config = Config::for_tests(&[("SWITCHBOARD_SPEECH_DEADLINE_MS", " 9000 ")]);
    assert_eq!(config.speech_deadline(), std::time::Duration::from_secs(9));
}

#[test]
#[should_panic(expected = "SWITCHBOARD_SPEECH_DEADLINE_MS must be a positive integer")]
fn invalid_speech_deadline_stops_startup() {
    Config::for_tests(&[("SWITCHBOARD_SPEECH_DEADLINE_MS", "invalid")]);
}

#[test]
fn jev_settings_enter_only_through_config() {
    let config = Config::for_tests(&[
        ("SWITCHBOARD_JEV_KEY_FILE", "/outside/key"),
        ("SWITCHBOARD_JEV_URL", "http://127.0.0.1:9/v1/systemone"),
        ("SWITCHBOARD_JEV_TIMEOUT_MS", "900"),
        ("SWITCHBOARD_JEV_FOR_CURRENT_AGENT_LOWER", "0.31"),
        ("SWITCHBOARD_JEV_FOR_CURRENT_AGENT_UPPER", "0.71"),
        ("SWITCHBOARD_JEV_ACTION_THRESHOLD", "0.61"),
        ("SWITCHBOARD_JEV_SUMMARY_TOKEN_BUDGET", "1234"),
    ]);
    assert_eq!(config.jev_key_file, PathBuf::from("/outside/key"));
    assert_eq!(config.jev_url, "http://127.0.0.1:9/v1/systemone");
    assert_eq!(config.jev_timeout_ms, 900);
    assert_eq!(config.jev_for_current_agent_lower, 0.31);
    assert_eq!(config.jev_for_current_agent_upper, 0.71);
    assert_eq!(config.jev_action_threshold, 0.61);
    assert_eq!(config.jev_summary_token_budget, 1234);
}

#[test]
fn floor_quiet_threshold_is_parsed_by_config_only() {
    assert_eq!(Config::for_tests(&[]).floor_quiet_threshold_ms, 10_000);
    let config = Config::for_tests(&[("SWITCHBOARD_FLOOR_QUIET_THRESHOLD_MS", "321")]);
    assert_eq!(config.floor_quiet_threshold_ms, 321);
}
