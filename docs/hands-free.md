# Foreground hands-free listening

Hands-free is an explicit, default-off mode on the foreground page. Push-to-talk
remains manual: the Damocles presence starts a turn and sends it. The two
capture modes share microphone ownership, so push-to-talk pauses and releases
the hands-free graph.

The call runtime (`apps/frontend/src/runtime/callRuntime.ts`) owns the
controller: `toggleHandsFree()` loads the detector on first use and enables or
disables listening, and the controller's state is published as the runtime's
`handsFree`, `handsFreeStatus`, and `handsFreeLease` fields. Nothing on the
page draws `handsFreeStatus`, so a state of `error` (a refusal, a microphone
hands-free could not get, a detector that could not load or that failed) is
also the runtime's error status, which the page puts on screen as it does a
push-to-talk failure.

The page's one control for it is MODE, in the CHANNEL / MODE stack the scene
shell draws in every page's bottom-left corner (#180,
`apps/frontend/src/primitives/ChannelStack.tsx`). It reads `handsFree` from
the registered voice runtime and switches it by calling `toggleHandsFree()`;
while listening it names the wake word (`MODE / HANDS-FREE · HEY JARVIS`).
The page holds no listening state of its own, and the refusals below stay the
runtime's. A switch while the line is down, or while a start is still under
way, does nothing and says nothing (`toggleHandsFree` returns at once). A
switch with push-to-talk active is refused by the controller and reported in
`handsFreeStatus`. The demo page registers no runtime, so the control is
disabled there.

## Real wake-word detector

Wake detection uses the pinned `openwakeword-wasm-browser@0.1.1` package with
two models trained for this lab, `damocles_v0.1.onnx` and `damo_v0.1.onnx`
(`docs/wake-word-training.md`). Either one wakes the page: "Damocles", or
"Damo" said as day-mo or dammo. `apps/frontend/src/wake_models.ts` is the one
place their files and thresholds are written; `damo` is short enough to collide
with everyday speech, so it is held to a stricter score. The package engine
carries a single `detectionThreshold`, so it runs at the lower of the two and
`isWakeDetection` holds each event to its own model. A score between the two
thresholds is not a detection, but it does start the engine's shared 2 s
cooldown, exactly as a real detection would.

The browser loads the package runtime, ONNX
models, and ONNX Runtime Web WASM files from the committed `/openwakeword/`
static paths through the import map in `apps/frontend/index.html`; Vite marks
the package external, so the bundle carries neither the engine nor its own
ONNX Runtime. The import map and `ortWasmPath` are same-origin; this path does
not use a CDN or runtime dependency download.

The package's public `start()` method owns its own microphone graph, which would
break PTT ownership and duplicate the controller's endpointing. The
`WakeWordDetectorAdapter` therefore feeds the package engine's serialized
16-kHz PCM processing seam. Package inference is asynchronous and queued; reset
stamps a new detector generation so stale work cannot open a wake grace period
after a PTT pause, page rescue, or epoch change. Detector failures stop
hands-free and are reported in `handsFreeStatus`. There is no acoustic wake
heuristic fallback.

## Speech endpointing with Silero VAD

Endpointing is Silero VAD, the `silero_vad.onnx` model the same openWakeWord
package ships. `apps/frontend/src/silero_vad.ts` loads it on the same ONNX
Runtime Web the wake engine uses, through the same import map and
`/openwakeword/` static paths, and feeds it the v4 signature the committed
model declares: `input`, a scalar `sr`, and the recurrent state as `h` and `c`
shaped `[2, 1, 64]`, with `output`, `hn` and `cn` back. The adapter carries
`hn`/`cn` into the next window, so the state runs with the speech.

`apps/frontend/src/speech_endpoint.ts` is the endpoint itself. It cuts the
controller's 1,280-sample frames into Silero's 512-sample (32 ms) windows,
scores each one, and reports a speech start and a speech end. Inference is
asynchronous and queued, as the wake detector's is, and a reset stamps a new
generation so a window scored before a reset cannot start or end a turn after
it. The endpointer is reset where the wake detector is: on enable, on a wake
grace period, when an expired grace period re-arms, when a turn brings no
reply, on a follow-up lease, on a PTT pause, and on disable or an epoch change.

The two detectors share one ONNX Runtime Web instance, and its `run` is not
re-entrant across sessions: a session that runs while another session's run
is still awaiting corrupts that run's inputs, and both fail ("failed to call
OrtRun()", "unaligned memory access"; Chromium can crash the tab). Each
detector's own queue does not prevent this, because the controller feeds every
frame to both. So every session create and run on the page goes through
`runInference` (`apps/frontend/src/inference_queue.ts`): one at a time, in the
order asked. Without it, the first frames after "armed" failed the endpointer,
and hands-free let go of the microphone and turned itself off in every engine
(#213).

`vad-worklet.js` is the capture seam only: it posts 16-kHz PCM frames and the
level the voice indicator reads. There is no energy-threshold endpointer
beside the model, and no fallback to one: a model that cannot load or cannot
score stops hands-free and reports it in `handsFreeStatus`, as a wake-detector
failure does (`docs/architecture.md` rule 9).

## Privacy boundary

After permission, microphone samples flow only into the browser's
`AudioWorklet` and local ONNX inference. The worklet transfers 16-kHz PCM frames
to the main-thread wake detector and speech endpointer, and separately posts
the frame energy. The energy messages drive the live voice indicator while the
caller is listening. Push-to-talk uses a short-lived `AnalyserNode` on its
microphone stream for the same indicator; neither level path sends samples to
the server. `MediaRecorder` is created only after a real model detects a
wake word followed by speech, or while the browser-local follow-up lease is
active. Only that completed clip enters the existing outbox and WebSocket
framing; detector PCM and model inputs never enter the server path.

## Timing and states

The local VAD uses 900 ms trailing silence, a 2 s wake-to-speech grace period,
and a 30 s utterance ceiling. A window above `SPEECH_START_PROBABILITY` (0.5)
starts speech and only a window below `SPEECH_END_PROBABILITY` (0.35) counts
towards the trailing silence, so a quiet syllable does not cut the caller off.
Those two thresholds and every timing here are written once, in
`apps/frontend/src/hands_free.ts`. A settled response opens one browser-local 8,000
ms follow-up lease after the server barrier and playback queue have both
settled, with a 400 ms drain debounce. The lease admits one no-wake utterance; a
later utterance needs a wake word again.

A turn that brings no successful reply opens no lease, so it re-arms the wake
word instead (`HandsFreeController.endAwaitedTurn`): the server's `error` for
the clip hands-free sent (Whisper heard nothing, the usual false trigger), a
`final_response_audio_closed` with `success: false`, or `routing_unavailable`.
So does an utterance the page could not send (`onClip` returns false: the
snapshot is not ready, the epoch moved, or the outbox is full) and a capture
that kept nothing. Without that exit, hands-free waited in `awaiting_response`,
where no frame reaches the wake detector, and MODE said HANDS-FREE while
nothing could wake it (#258).

The server emits one `final_response_audio_closed` event per completed input
turn, after a response-scoped queue marker has passed all earlier audio slots.
Its `response_id`, generation, and production success are not used as heartbeat
or reconnect state. Individual `speak`, `spoken`, `audio_start`, and `audio_done`
events never open or extend the lease.

Capture is discarded on permission failure, hidden/pagehide, disconnect,
hangup, route/epoch change, or push-to-talk interruption. Secure contexts with
`getUserMedia`, a 16-kHz `AudioContext`, `AudioWorkletNode`, and a supported
`MediaRecorder` MIME are required. Reduced-motion settings do not change
listening behavior or accessibility announcements.

## Asset provenance and licenses

- The JavaScript wrapper is `openwakeword-wasm-browser@0.1.1`, MIT licensed,
  from [dnavarrom/openwakeword_wasm](https://github.com/dnavarrom/openwakeword_wasm).
  `package-lock.json` pins its npm tarball integrity and its
  `onnxruntime-web` dependency; the staged
  ONNX Runtime Web bundle is MIT licensed by Microsoft.
- `silero_vad.onnx` is [Silero VAD](https://github.com/snakers4/silero-vad),
  MIT licensed by the Silero Team, which the package redistributes.
- `melspectrogram.onnx` and `embedding_model.onnx` are the package's
  OpenWakeWord model assets. OpenWakeWord documents its pretrained models
  under
  [CC BY-NC-SA 4.0](https://github.com/dscripka/openWakeWord#license), so these
  assets carry attribution, noncommercial-use, and ShareAlike obligations.
  This feature is not cleared for commercial deployment without reviewing the
  upstream model terms and obtaining any needed permission.
- `damocles_v0.1.onnx` and `damo_v0.1.onnx` are ours, trained by
  `training/wake-words` (`docs/wake-word-training.md`). The heads are our work;
  they are trained against, and at inference sit on top of, the CC BY-NC-SA
  feature extractor above, so they inherit its ShareAlike reading and the same
  noncommercial limit. They are committed in `training/wake-words/models/` and
  staged from there, not from the package.
- `npm run build` copies these exact package and runtime assets, and our two
  keyword models, into committed `static/openwakeword/` paths. Tests inspect
  asset presence and fake the engine and sessions; they never load the ONNX
  models or invoke network inference.
