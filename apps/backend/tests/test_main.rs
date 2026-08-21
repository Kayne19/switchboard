use super::*;

#[test]
fn reads_switchboard_names_and_defaults() {
    let values = HashMap::from([
        ("SWITCHBOARD_CONFIG_DIR".into(), "/tmp/switchboard".into()),
        ("SWITCHBOARD_MODEL_SWAPS".into(), "false".into()),
        (
            "SWITCHBOARD_SELF_URL".into(),
            "http://localhost:8765/".into(),
        ),
        ("SWITCHBOARD_HISTORY_LIMIT".into(), "12".into()),
    ]);
    let config = Config::from_values(&values, PathBuf::from("/tmp/env"));
    assert_eq!(
        config.projects_file,
        PathBuf::from("/tmp/switchboard/projects.json")
    );
    assert!(!config.model_swaps);
    assert_eq!(config.self_url, "http://localhost:8765");
    assert_eq!(config.history_limit, 12);
}

#[test]
fn non_finite_numeric_configuration_falls_back_safely() {
    let values = HashMap::from([
        ("SWITCHBOARD_IDLE_TIMEOUT".into(), "NaN".into()),
        ("SWITCHBOARD_IDLE_POLL".into(), "inf".into()),
        ("SWITCHBOARD_MAX_SPOKEN_CHARS".into(), "-inf".into()),
        ("SWITCHBOARD_HISTORY_LIMIT".into(), "12.5".into()),
    ]);
    let config = Config::from_values(&values, PathBuf::from("/tmp/env"));
    assert_eq!(config.idle_timeout, 3600.0);
    assert_eq!(config.idle_poll, 30.0);
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
