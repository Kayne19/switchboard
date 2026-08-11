# Foreground hands-free listening

Hands-free is an explicit, default-off mode on the foreground page. Push-to-talk
remains manual: Talk/Space starts it, Send submits it, and Discard cancels it.
The two capture modes share microphone ownership, so push-to-talk pauses and
releases the hands-free graph.

## Real wake-word detector

Wake detection uses the pinned `openwakeword-wasm-browser@0.1.1` package with
its `hey_jarvis_v0.1.onnx` model. The browser loads the package runtime, ONNX
models, and ONNX Runtime Web WASM files from the committed `/openwakeword/`
static paths. The import map and `ortWasmPath` are same-origin; this path does
not use a CDN or runtime dependency download.

The package's public `start()` method owns its own microphone graph, which would
break PTT ownership and duplicate the controller's endpointing. The
`WakeWordDetectorAdapter` therefore feeds the package engine's serialized
16-kHz PCM processing seam while `vad-worklet.js` remains the separate speech
endpoint detector. Package inference is asynchronous and queued; reset stamps
a new detector generation so stale work cannot open a wake grace period after a
PTT pause, page rescue, or epoch change. Detector failures stop hands-free and
are announced in the accessible status region. There is no acoustic wake
heuristic fallback.

## Privacy boundary

After permission, microphone samples flow only into the browser's
`AudioWorklet` and local ONNX inference. The worklet transfers 16-kHz PCM frames
to the main-thread detector and separately posts energy and speech boundary
features. `MediaRecorder` is created only after the real model detects Hey
Jarvis followed by speech, or while the browser-local follow-up lease is
active. Only that completed clip enters the existing outbox and WebSocket
framing; detector PCM and model inputs never enter the server path.

## Timing and states

The local VAD uses 900 ms trailing silence, a 2 s wake-to-speech grace period,
and a 30 s utterance ceiling. A settled response opens one browser-local 8,000
ms follow-up lease after the server barrier and playback queue have both
settled, with a 400 ms drain debounce. The lease admits one no-wake utterance; a
later utterance needs Hey Jarvis again.

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
- `hey_jarvis_v0.1.onnx`, `melspectrogram.onnx`, `embedding_model.onnx`, and
  `silero_vad.onnx` are the package's OpenWakeWord model assets. OpenWakeWord
  documents its pretrained models under
  [CC BY-NC-SA 4.0](https://github.com/dscripka/openWakeWord#license), so these
  assets carry attribution, noncommercial-use, and ShareAlike obligations.
  This feature is not cleared for commercial deployment without reviewing the
  upstream model terms and obtaining any needed permission.
- `npm run build` copies these exact package and runtime assets into committed
  `static/openwakeword/` paths. Tests inspect asset presence and fake the engine
  and sessions; they never load the ONNX models or invoke network inference.
