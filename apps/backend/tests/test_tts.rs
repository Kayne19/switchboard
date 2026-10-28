use super::*;
use crate::within;
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

/// The settings the request-contract tests assert on, parsed the way the
/// service parses them.
fn test_settings() -> TtsSettings {
    crate::Config::for_tests(&[
        ("ELEVENLABS_API_KEY", "test-secret"),
        ("ELEVENLABS_VOICE_ID", "voice-a"),
        ("ELEVENLABS_MODEL_ID", "model-a"),
    ])
    .tts
}

fn speaker_with_response(
    status: StatusCode,
    bytes: &[u8],
) -> (Speaker, Arc<StdMutex<Option<TtsRequest>>>) {
    let request = Arc::new(StdMutex::new(None));
    let mut speaker = Speaker::new(100, Duration::from_millis(25_000), test_settings());
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
    let request = Arc::new(StdMutex::new(None));
    let requests = Arc::new(StdMutex::new(Vec::new()));
    let responses = responses
        .into_iter()
        .map(|(status, request_id, bytes)| (status, request_id.map(str::to_owned), bytes.to_vec()))
        .collect();
    let mut speaker = Speaker::new(100, Duration::from_millis(25_000), test_settings());
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

#[tokio::test]
async fn tts_stream_preserves_provider_chunk_boundaries_and_request_contract() {
    let (speaker, request) = speaker_with_response(StatusCode::OK, b"abcdef");
    let mut stream = speaker
        .stream_until("Hello", Instant::now() + Duration::from_secs(1))
        .await
        .unwrap();
    let mut chunks = Vec::new();
    while let Some(chunk) = within("stream", stream.next()).await {
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
    while let Some(chunk) = within("stream", stream.next()).await {
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
    v3.tts.model_id = "eleven_v3".into();
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

/// Answers every request with `status` and a body that never ends: the
/// headers arrive, then the connection stays open with no bytes.
type OpenBody = mpsc::Sender<Result<Vec<u8>, TtsError>>;

#[derive(Debug)]
struct StalledBodyTransport {
    status: StatusCode,
    open: StdMutex<Vec<OpenBody>>,
}
impl TtsTransport for StalledBodyTransport {
    fn send_stream(&self, _request: TtsRequest) -> TtsStreamFuture {
        let (sender, receiver) = mpsc::channel(1);
        // Held, not dropped: a dropped sender would end the body.
        self.open.lock().unwrap().push(sender);
        let status = self.status;
        Box::pin(async move {
            Ok(TtsResponse {
                status,
                content_length: None,
                request_id: None,
                stream: Box::pin(ChunkReceiverStream {
                    receiver,
                    task: None,
                }) as TtsByteStream,
            })
        })
    }
}

#[tokio::test]
async fn a_refusal_whose_body_stalls_ends_at_the_speech_deadline() {
    // A server failure, and an id refusal read before the retry.
    let cases = [
        (StatusCode::INTERNAL_SERVER_ERROR, TtsContinuity::Fresh),
        (
            StatusCode::BAD_REQUEST,
            TtsContinuity::previous_request_ids(["old-id"], Some("old words".into())),
        ),
    ];
    for (status, continuity) in cases {
        let mut speaker = Speaker::new(100, Duration::from_millis(25_000), test_settings());
        speaker.transport = Arc::new(StalledBodyTransport {
            status,
            open: StdMutex::new(Vec::new()),
        });
        let deadline = Instant::now() + Duration::from_millis(100);
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            speaker.stream_until_with_continuity("Hello", deadline, continuity),
        )
        .await
        .unwrap_or_else(|_| {
            panic!("a {status} body that stalls held the speech request past its deadline")
        });
        assert!(
            matches!(result, Err(TtsError::Deadline)),
            "{status}: a stalled refusal must end as the deadline"
        );
    }
}
