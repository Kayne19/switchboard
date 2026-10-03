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
fn elevenlabs_settings_are_parsed_once_with_their_defaults() {
    assert_eq!(
        Config::for_tests(&[]).tts,
        audio::TtsSettings {
            api_key: String::new(),
            voice_id: "21m00Tcm4TlvDq8ikWAM".into(),
            model_id: "eleven_multilingual_v2".into(),
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            speed: 1.0,
        }
    );
    let config = Config::for_tests(&[
        ("ELEVENLABS_API_KEY", " key "),
        ("ELEVENLABS_VOICE_ID", " voice "),
        ("ELEVENLABS_MODEL_ID", " model "),
        ("ELEVENLABS_STABILITY", " 0.25 "),
        ("ELEVENLABS_SIMILARITY_BOOST", "0.5"),
        ("ELEVENLABS_STYLE", "0.125"),
        ("ELEVENLABS_SPEED", "1.5"),
    ]);
    assert_eq!(
        config.tts,
        audio::TtsSettings {
            api_key: "key".into(),
            voice_id: "voice".into(),
            model_id: "model".into(),
            stability: 0.25,
            similarity_boost: 0.5,
            style: 0.125,
            speed: 1.5,
        }
    );
    let printed = format!("{:?}", config.tts);
    assert!(printed.contains("api_key_configured: true"), "{printed}");
    assert!(!printed.contains("\"key\""), "the key is never printed");
}

#[test]
fn non_finite_elevenlabs_numbers_fall_back_to_their_defaults() {
    let config = Config::for_tests(&[
        ("ELEVENLABS_STABILITY", "NaN"),
        ("ELEVENLABS_SIMILARITY_BOOST", "inf"),
        ("ELEVENLABS_STYLE", "1e40"),
        ("ELEVENLABS_SPEED", "fast"),
    ]);
    assert_eq!(config.tts.stability, 0.5);
    assert_eq!(config.tts.similarity_boost, 0.75);
    assert_eq!(config.tts.style, 0.0);
    assert_eq!(config.tts.speed, 1.0);
    assert_eq!(
        Config::for_tests(&[("ELEVENLABS_SPEED", "  ")]).tts.speed,
        1.0
    );
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
fn blank_values_mean_unset() {
    let defaults = Config::for_tests(&[]);
    for blank in ["", "   "] {
        let config = Config::for_tests(&[
            ("SWITCHBOARD_PI_BINARY", blank),
            ("SWITCHBOARD_AGENT_THINKING", blank),
            ("SWITCHBOARD_BIND", blank),
            ("SWITCHBOARD_CONFIG_DIR", blank),
            ("SWITCHBOARD_JEV_ACTION_THRESHOLD", blank),
            ("ELEVENLABS_SPEED", blank),
            ("SWITCHBOARD_SPEECH_DEADLINE_MS", blank),
            ("SWITCHBOARD_JEV_TIMEOUT_MS", blank),
            ("SWITCHBOARD_HISTORY_LIMIT", blank),
        ]);
        assert_eq!(config.pi_binary, "pi", "{blank:?}");
        assert_eq!(config.agent_thinking, "medium", "{blank:?}");
        assert_eq!(config.bind, defaults.bind, "{blank:?}");
        assert_eq!(config.projects_file, defaults.projects_file, "{blank:?}");
        assert_eq!(config.jev_action_threshold, 0.6, "{blank:?}");
        assert_eq!(config.tts.speed, 1.0, "{blank:?}");
        // A blank deadline is unset, not malformed: it does not stop startup.
        assert_eq!(config.speech_deadline_ms, 25_000, "{blank:?}");
        assert_eq!(config.jev_timeout_ms, 2_000, "{blank:?}");
        assert_eq!(config.history_limit, 200, "{blank:?}");
    }
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

#[tokio::test]
async fn a_debug_bind_failure_leaves_the_debug_listener_and_bus_off() {
    let bus = debug::DebugBus::off();
    let config = || debug::DebugConfig::from_config(&Config::for_tests(&[]));
    assert!(bind_debug_listener(None, &bus, config()).await.is_none());
    let taken = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = taken.local_addr().unwrap().to_string();
    assert!(bind_debug_listener(Some(&address), &bus, config())
        .await
        .is_none());
    assert!(bind_debug_listener(Some("not an address"), &bus, config())
        .await
        .is_none());
    assert!(!bus.enabled(), "no listener, so nothing is recorded");
    assert!(bind_debug_listener(Some("127.0.0.1:0"), &bus, config())
        .await
        .is_some());
    assert!(bus.enabled());
}

#[test]
fn the_debug_listener_is_off_unless_an_address_is_set() {
    let off = Config::from_values(&HashMap::new(), PathBuf::from("/tmp/env"));
    assert_eq!(off.debug_bind, None);
    for blank in ["", "   "] {
        let values = HashMap::from([("SWITCHBOARD_DEBUG_BIND".into(), blank.into())]);
        let config = Config::from_values(&values, PathBuf::from("/tmp/env"));
        assert_eq!(config.debug_bind, None, "{blank:?}");
    }
    let values = HashMap::from([("SWITCHBOARD_DEBUG_BIND".into(), " 0.0.0.0:8766 ".into())]);
    let config = Config::from_values(&values, PathBuf::from("/tmp/env"));
    assert_eq!(config.debug_bind.as_deref(), Some("0.0.0.0:8766"));
}
