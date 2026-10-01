use super::*;
use std::sync::Mutex as StdMutex;

type FakeResponse = (StatusCode, Option<String>, Vec<u8>);

#[derive(Debug)]
struct FakeTtsTransport {
    responses: Arc<StdMutex<Vec<FakeResponse>>>,
    request: Arc<StdMutex<Option<TtsRequest>>>,
    requests: Arc<StdMutex<Vec<TtsRequest>>>,
}
impl TtsTransport for FakeTtsTransport {
    fn send_stream(&self, request: TtsRequest) -> TtsStreamFuture {
        *self.request.lock().unwrap() = Some(request.clone());
        self.requests.lock().unwrap().push(request);
        let (status, request_id, bytes) =
            self.responses.lock().unwrap().first().cloned().unwrap_or((
                StatusCode::OK,
                Some("fake-request-id".into()),
                Vec::new(),
            ));
        if !self.responses.lock().unwrap().is_empty() {
            self.responses.lock().unwrap().remove(0);
        }
        Box::pin(async move {
            let (sender, receiver) = mpsc::channel(bytes.len().saturating_add(1));
            for chunk in bytes.chunks(2) {
                let _ = sender.send(Ok(chunk.to_vec())).await;
            }
            Ok(TtsResponse {
                status,
                content_length: None,
                request_id,
                stream: Box::pin(ChunkReceiverStream {
                    receiver,
                    task: None,
                }) as TtsByteStream,
            })
        })
    }
}

fn speaker_with_response(
    status: StatusCode,
    bytes: &[u8],
) -> (Speaker, Arc<StdMutex<Option<TtsRequest>>>) {
    let values = HashMap::from([
        ("ELEVENLABS_API_KEY".into(), "test-secret".into()),
        ("ELEVENLABS_VOICE_ID".into(), "voice-a".into()),
        ("ELEVENLABS_MODEL_ID".into(), "model-a".into()),
    ]);
    let request = Arc::new(StdMutex::new(None));
    let mut speaker = Speaker::from_values(100, Duration::from_millis(25_000), &values);
    speaker.transport = Arc::new(FakeTtsTransport {
        responses: Arc::new(StdMutex::new(vec![(
            status,
            Some("fake-request-id".into()),
            bytes.to_vec(),
        )])),
        request: Arc::clone(&request),
        requests: Arc::new(StdMutex::new(Vec::new())),
    });
    (speaker, request)
}

fn speaker_with_responses(
    responses: Vec<(StatusCode, Option<&str>, &[u8])>,
) -> (Speaker, Arc<StdMutex<Vec<TtsRequest>>>) {
    let values = HashMap::from([
        ("ELEVENLABS_API_KEY".into(), "test-secret".into()),
        ("ELEVENLABS_VOICE_ID".into(), "voice-a".into()),
        ("ELEVENLABS_MODEL_ID".into(), "model-a".into()),
    ]);
    let request = Arc::new(StdMutex::new(None));
    let requests = Arc::new(StdMutex::new(Vec::new()));
    let responses = responses
        .into_iter()
        .map(|(status, request_id, bytes)| (status, request_id.map(str::to_owned), bytes.to_vec()))
        .collect();
    let mut speaker = Speaker::from_values(100, Duration::from_millis(25_000), &values);
    speaker.transport = Arc::new(FakeTtsTransport {
        responses: Arc::new(StdMutex::new(responses)),
        request,
        requests: Arc::clone(&requests),
    });
    (speaker, requests)
}

#[test]
fn clipping_preserves_sentence_and_max_shape() {
    let (mut speaker, _) = speaker_with_response(StatusCode::OK, b"");
    speaker.max_chars = 20;
    let result = speaker.clip_for_speech("One short sentence. Second sentence goes on and on.");
    assert_eq!(result, "One short sentence. — there's more on screen.");
}

#[test]
fn stream_admission_is_bounded_and_optional() {
    let adapter = SttStreamAdapter::from_command(None);
    assert!(!adapter.configured());
    assert_eq!(
        adapter.try_start("clip".into(), 1, "audio/webm;codecs=opus".into()),
        Err("streaming STT is not configured")
    );
    let configured = SttStreamAdapter::from_command(Some("true".into()));
    assert!(configured
        .try_chunk("clip".into(), 1, 0, vec![0; STREAM_CHUNK_LIMIT + 1])
        .is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn stream_worker_delivers_multiple_chunks_to_one_process() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-stt-stream-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let capture = root.join("frames");
    let worker = root.join("worker");
    crate::pi_client::write_executable_script(
        &worker,
        &format!(
            "printf '%s\\n' '{{\"type\":\"ready\"}}'\ncat > '{}'\n",
            capture.display()
        ),
    );
    let adapter = SttStreamAdapter::from_command(Some(worker.display().to_string()));
    let mut results = adapter.take_results().await.unwrap();
    adapter
        .try_start("clip".into(), 4, "audio/webm;codecs=opus".into())
        .unwrap();
    adapter
        .try_chunk("clip".into(), 4, 0, b"one".to_vec())
        .unwrap();
    adapter
        .try_chunk("other".into(), 4, 1, b"two".to_vec())
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(1);
    let frames = loop {
        if let Ok(bytes) = std::fs::read(&capture) {
            if bytes.len() >= 16 {
                break bytes;
            }
        }
        assert!(
            Instant::now() < deadline,
            "worker did not receive both chunks"
        );
        sleep(Duration::from_millis(5)).await;
    };
    assert_eq!(frames[0], b's');
    assert!(frames.windows(3).any(|window| window == b"one"));
    assert!(frames.windows(3).any(|window| window == b"two"));
    assert!(frames.windows(5).any(|window| window == b"other"));
    assert!(results.try_recv().is_err());
    drop(results);
    drop(adapter);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn stream_worker_reports_malformed_output() {
    let adapter = SttStreamAdapter::from_command(Some(
        "printf '{\"type\":\"ready\"}\\nmalformed\\n'; cat >/dev/null".into(),
    ));
    let mut results = adapter.take_results().await.unwrap();
    adapter
        .try_start("clip".into(), 1, "audio/webm;codecs=opus".into())
        .unwrap();
    let result = timeout(Duration::from_secs(1), results.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        result,
        StreamResult::WorkerError(message)
            if message.contains("malformed JSON")
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn stream_worker_restarts_after_malformed_output() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-stt-restart-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let counter = root.join("counter");
    let capture = root.join("retry");
    let worker = root.join("worker");
    crate::pi_client::write_executable_script(
        &worker,
        &format!(
            "if [ ! -e '{}' ]; then : > '{}'; printf '%s\\n' '{{\"type\":\"ready\"}}' malformed; sleep 1; exit 0; fi\nprintf '%s\\n' '{{\"type\":\"ready\"}}'\ncat > '{}'\n",
            counter.display(),
            counter.display(),
            capture.display()
        ),
    );
    let adapter = SttStreamAdapter::from_command(Some(worker.display().to_string()));
    let mut results = adapter.take_results().await.unwrap();
    adapter
        .try_start("clip".into(), 1, "audio/webm;codecs=opus".into())
        .unwrap();
    let first_error = loop {
        let res = timeout(Duration::from_secs(5), results.recv())
            .await
            .expect("recv timeout")
            .expect("channel closed");
        if let StreamResult::WorkerError(msg) = res {
            break msg;
        }
    };
    assert!(first_error.contains("malformed JSON"));
    adapter
        .try_chunk("clip".into(), 1, 0, b"retry".to_vec())
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    let frames = loop {
        if let Ok(bytes) = std::fs::read(&capture) {
            if bytes.windows(5).any(|window| window == b"retry") {
                break bytes;
            }
        }
        assert!(Instant::now() < deadline, "worker did not restart");
        sleep(Duration::from_millis(5)).await;
    };
    assert!(frames.windows(5).any(|window| window == b"retry"));
    drop(results);
    drop(adapter);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn stream_worker_preserves_partial_and_final_turn_boundaries() {
    let adapter = SttStreamAdapter::from_command(Some(
        "printf '%s\\n' '{\"type\":\"ready\"}' '{\"type\":\"partial\",\"clip_id\":\"clip\",\"generation\":2,\"sequence\":0,\"text\":\"hel\"}' '{\"type\":\"final\",\"clip_id\":\"clip\",\"generation\":2,\"sequence\":1,\"text\":\"hello\"}'; cat >/dev/null".into(),
    ));
    let mut results = adapter.take_results().await.unwrap();
    adapter
        .try_start("clip".into(), 2, "audio/webm;codecs=opus".into())
        .unwrap();
    let partial = timeout(Duration::from_secs(1), results.recv())
        .await
        .unwrap()
        .unwrap();
    let final_result = timeout(Duration::from_secs(1), results.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        partial,
        StreamResult::Partial(StreamClip {
            clip_id,
            generation: 2,
            sequence: 0,
            text
        }) if clip_id == "clip" && text == "hel"
    ));
    assert!(matches!(
        final_result,
        StreamResult::Final(StreamClip {
            clip_id,
            generation: 2,
            sequence: 1,
            text
        }) if clip_id == "clip" && text == "hello"
    ));
}

#[tokio::test]
async fn missing_sidecar_is_clear() {
    let error = SttAdapter::from_command(None)
        .transcribe(b"webm")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("SWITCHBOARD_STT_COMMAND"));
}

#[tokio::test]
async fn stt_sidecar_covers_success_failure_and_timeout() {
    let adapter = SttAdapter::from_command(Some("tr '[:lower:]' '[:upper:]'".into()));
    assert_eq!(
        adapter.transcribe(b"heard words\n").await.unwrap(),
        "HEARD WORDS"
    );

    let failed = SttAdapter::from_command(Some("printf 'decoder broke' >&2; exit 7".into()))
        .transcribe(b"webm")
        .await
        .unwrap_err();
    assert!(failed.to_string().contains("decoder broke"));

    // A megabyte cannot fit a pipe buffer and this sidecar never reads it,
    // so the write is certain to break. The caller must still be told why
    // the sidecar failed rather than being handed the broken pipe that
    // failure caused. Real clips are this large, so this is the ordinary
    // path for a sidecar that rejects its input, not a rare one.
    let fast_failure = SttAdapter::from_command(Some("printf 'model missing' >&2; exit 3".into()))
        .transcribe(&vec![0u8; 1 << 20])
        .await
        .unwrap_err();
    assert!(fast_failure.to_string().contains("model missing"));
    assert!(!fast_failure.to_string().contains("Broken pipe"));

    let timed_out = SttAdapter {
        command: Some("sleep 60".into()),
        timeout: Duration::from_millis(20),
    }
    .transcribe(b"webm")
    .await
    .unwrap_err();
    assert_eq!(timed_out.to_string(), "STT sidecar timed out");
}

#[tokio::test]
async fn tts_stream_preserves_provider_chunk_boundaries_and_request_contract() {
    let (speaker, request) = speaker_with_response(StatusCode::OK, b"abcdef");
    let mut stream = speaker
        .stream_until("Hello", Instant::now() + Duration::from_secs(1))
        .await
        .unwrap();
    let mut chunks = Vec::new();
    while let Some(chunk) = stream.next().await {
        chunks.push(chunk.unwrap());
    }
    assert_eq!(chunks, vec![b"ab".to_vec(), b"cd".to_vec(), b"ef".to_vec()]);
    assert_eq!(
        request.lock().unwrap().as_ref().unwrap().url,
        "https://api.elevenlabs.io/v1/text-to-speech/voice-a/stream?output_format=mp3_44100_128"
    );
}

#[tokio::test]
async fn tts_adapter_sends_expected_request_and_surfaces_http_failure() {
    let deadline = Instant::now() + Duration::from_secs(1);
    let (speaker, request) = speaker_with_response(StatusCode::OK, b"mp3");
    let mut stream = speaker.stream_until("Hello there", deadline).await.unwrap();
    let mut audio = Vec::new();
    while let Some(chunk) = stream.next().await {
        audio.extend(chunk.unwrap());
    }
    assert_eq!(audio, b"mp3");
    let request = request.lock().unwrap().clone().unwrap();
    assert_eq!(request.api_key, "test-secret");
    assert_eq!(request.body["text"], "Hello there");
    assert_eq!(request.body["model_id"], "model-a");

    let (speaker, _) = speaker_with_response(StatusCode::TOO_MANY_REQUESTS, b"slow down");
    let Err(error) = speaker.stream_until("Hello", deadline).await else {
        panic!("a 429 must not start an audio stream");
    };
    assert!(error.to_string().contains("429 Too Many Requests"));
    assert!(error.to_string().contains("slow down"));
}

#[tokio::test]
async fn tts_continuity_request_is_capped_and_commits_metadata_after_drain() {
    let (speaker, requests) =
        speaker_with_responses(vec![(StatusCode::OK, Some("request-4"), b"audio")]);
    let continuity = TtsContinuity::previous_request_ids(
        ["request-1", "request-2", "request-3", "request-4"],
        Some("previous words".into()),
    );
    let stream = speaker
        .stream_until_with_continuity(
            "next words",
            Instant::now() + Duration::from_secs(1),
            continuity,
        )
        .await
        .unwrap();
    assert_eq!(stream.metadata().request_id.as_deref(), Some("request-4"));
    let metadata = stream.drain().await.unwrap();
    assert_eq!(metadata.request_id.as_deref(), Some("request-4"));
    let body = &requests.lock().unwrap()[0].body;
    assert_eq!(
        body["previous_request_ids"],
        serde_json::json!(["request-2", "request-3", "request-4"])
    );
    assert!(body.get("previous_text").is_none());
    assert!(body.get("enable_logging").is_none());
}

#[tokio::test]
async fn tts_id_refusal_retries_once_with_previous_text_only() {
    let (speaker, requests) = speaker_with_responses(vec![
        (StatusCode::BAD_REQUEST, None, b"expired request id"),
        (StatusCode::OK, Some("fresh-id"), b"audio"),
    ]);
    let continuity =
        TtsContinuity::previous_request_ids(["old-id"], Some("the previous sentence".into()));
    let stream = speaker
        .stream_until_with_continuity(
            "next sentence",
            Instant::now() + Duration::from_secs(1),
            continuity,
        )
        .await
        .unwrap();
    stream.drain().await.unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].body["previous_request_ids"],
        serde_json::json!(["old-id"])
    );
    assert!(requests[0].body.get("previous_text").is_none());
    assert_eq!(requests[1].body["previous_text"], "the previous sentence");
    assert!(requests[1].body.get("previous_request_ids").is_none());
}

#[tokio::test]
async fn tts_retry_is_not_used_for_server_failure_and_v3_is_fresh_only() {
    let (speaker, requests) = speaker_with_responses(vec![(
        StatusCode::INTERNAL_SERVER_ERROR,
        None,
        b"server failure",
    )]);
    let continuity = TtsContinuity::previous_request_ids(["old-id"], Some("old words".into()));
    assert!(speaker
        .stream_until_with_continuity("next", Instant::now() + Duration::from_secs(1), continuity,)
        .await
        .is_err());
    assert_eq!(requests.lock().unwrap().len(), 1);

    let (mut v3, requests) =
        speaker_with_responses(vec![(StatusCode::OK, Some("v3-id"), b"audio")]);
    v3.model_id = "eleven_v3".into();
    let stream = v3
        .stream_until_with_continuity(
            "fresh",
            Instant::now() + Duration::from_secs(1),
            TtsContinuity::previous_request_ids(["stale-id"], Some("stale text".into())),
        )
        .await
        .unwrap();
    stream.drain().await.unwrap();
    let body = &requests.lock().unwrap()[0].body;
    assert!(body.get("previous_request_ids").is_none());
    assert!(body.get("previous_text").is_none());
}
