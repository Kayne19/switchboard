export const WAKE_PHRASE = "Hey Jarvis";
export const WAKE_SAMPLE_RATE = 16_000;
export const WAKE_FRAME_SAMPLES = 1_280;
export const VAD_TRAILING_SILENCE_MS = 900;
export const WAKE_SPEECH_GRACE_MS = 2_000;
export const MAX_HANDS_FREE_UTTERANCE_MS = 30_000;
export const FOLLOW_UP_LEASE_MS = 8_000;
export const PLAYBACK_DRAIN_DEBOUNCE_MS = 400;
export class HandsFreeController {
    options;
    getUserMedia;
    createAudioContext;
    createRecorder;
    createWorkletNode;
    now;
    setTimer;
    clearTimer;
    isForeground;
    detector;
    state = "off";
    enabled = false;
    runtimeToken = 0;
    wakeTimer = null;
    leaseTimer = null;
    leaseTickTimer = null;
    leaseDeadline = 0;
    leaseUsed = false;
    capture = null;
    stream = null;
    context = null;
    source = null;
    worklet = null;
    sink = null;
    pausedForPtt = false;
    constructor(options) {
        this.options = options;
        this.getUserMedia =
            options.getUserMedia ||
                ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
        this.createAudioContext =
            options.createAudioContext ||
                (() => new AudioContext({ sampleRate: WAKE_SAMPLE_RATE }));
        this.createRecorder =
            options.createRecorder ||
                ((stream, mime) => mime
                    ? new MediaRecorder(stream, { mimeType: mime })
                    : new MediaRecorder(stream));
        this.createWorkletNode =
            options.createWorkletNode ||
                ((context) => new AudioWorkletNode(context, "hands-free-vad"));
        this.detector = options.wakeDetector || null;
        this.detector?.onDetect(() => {
            if (this.enabled && this.state === "armed")
                this.beginWakeGrace();
        });
        this.detector?.onError?.((error) => {
            if (!this.enabled)
                return;
            this.enabled = false;
            this.runtimeToken++;
            this.clearWakeTimer();
            this.clearLeaseTimer();
            this.stopCapture(true);
            this.releaseRuntime();
            this.detector?.reset();
            this.publish("error", `Hands-free detector failed (${this.errorName(error)}).`);
        });
        this.now = options.now || (() => Date.now());
        this.setTimer =
            options.setTimeout ||
                ((handler, timeout) => setTimeout(handler, timeout));
        this.clearTimer = options.clearTimeout || ((timer) => clearTimeout(timer));
        this.isForeground =
            options.isForeground || (() => document.visibilityState === "visible");
        this.publish("off", "Hands-free is off.");
    }
    get currentState() {
        return this.state;
    }
    get isEnabled() {
        return this.enabled;
    }
    get isCapturing() {
        return this.capture !== null;
    }
    async enable() {
        if (this.enabled && this.state !== "error" && this.state !== "paused_ptt")
            return true;
        if (this.options.isPttActive() || !this.isForeground()) {
            this.publish("error", "Finish push-to-talk and keep this page visible first.");
            return false;
        }
        if (!this.supported()) {
            this.publish("error", "Hands-free needs a secure browser with local audio worklet support.");
            return false;
        }
        if (!this.detector) {
            this.publish("error", "Hands-free wake detector is unavailable.");
            return false;
        }
        this.enabled = true;
        this.publish("starting", "Starting local microphone listening. Ambient audio stays on this device.");
        const token = ++this.runtimeToken;
        try {
            await this.detector.load?.();
            if (!this.enabled || token !== this.runtimeToken)
                return false;
            this.context = this.createAudioContext();
            if (typeof this.context.audioWorklet?.addModule !== "function")
                throw new Error("audio worklet is unavailable");
            this.stream = await this.getUserMedia({ audio: true });
            if (!this.enabled ||
                token !== this.runtimeToken ||
                !this.isForeground()) {
                this.releaseStream();
                return false;
            }
            if (this.context.state === "suspended")
                await this.context.resume();
            await this.context.audioWorklet.addModule(this.options.workletUrl || "/vad-worklet.js");
            if (!this.enabled || token !== this.runtimeToken) {
                this.releaseRuntime();
                return false;
            }
            this.source = this.context.createMediaStreamSource(this.stream);
            this.worklet = this.createWorkletNode(this.context);
            const worklet = this.worklet;
            worklet.port.onmessage = (event) => {
                if (token !== this.runtimeToken || worklet !== this.worklet)
                    return;
                this.onWorkletMessage(event.data);
            };
            this.source.connect(worklet);
            this.sink = this.context.createGain();
            this.sink.gain.value = 0;
            worklet.connect(this.sink);
            this.sink.connect(this.context.destination);
            this.detector.reset();
            this.publish("armed", `Listening locally for “${WAKE_PHRASE}”.`);
            return true;
        }
        catch (error) {
            if (!this.enabled || token !== this.runtimeToken)
                return false;
            this.enabled = false;
            this.releaseRuntime();
            this.detector.reset();
            this.publish("error", `Hands-free could not start (${this.errorName(error)}).`);
            return false;
        }
    }
    disable(message = "Hands-free is off.") {
        this.enabled = false;
        this.pausedForPtt = false;
        this.runtimeToken++;
        this.clearWakeTimer();
        this.clearLeaseTimer();
        this.stopCapture(true);
        this.releaseRuntime();
        this.detector?.reset();
        this.publish("off", message);
    }
    pauseForPtt() {
        if (!this.enabled)
            return;
        this.pausedForPtt = true;
        this.runtimeToken++;
        this.clearWakeTimer();
        this.stopCapture(true);
        this.releaseRuntime();
        this.detector?.reset();
        this.publish("paused_ptt", "Hands-free paused for push-to-talk.");
    }
    resumeAfterPtt() {
        if (!this.pausedForPtt || !this.enabled)
            return;
        this.pausedForPtt = false;
        void this.enable();
    }
    openFollowUpLease(generation) {
        if (!this.enabled ||
            this.pausedForPtt ||
            generation !== this.options.currentEpoch() ||
            !this.options.isSnapshotReady() ||
            this.state === "error")
            return;
        this.clearLeaseTimer();
        this.worklet?.port.postMessage({ type: "reset_endpoint" });
        this.leaseUsed = false;
        this.leaseDeadline = this.now() + FOLLOW_UP_LEASE_MS;
        this.leaseTimer = this.setTimer(() => this.expireLease(), FOLLOW_UP_LEASE_MS);
        this.scheduleLeaseUpdate();
        this.publish("lease", "Follow-up listening is open for 8 seconds. No wake word needed.");
    }
    epochChanged() {
        if (!this.enabled)
            return;
        this.disable("Hands-free stopped because the call changed.");
    }
    supported() {
        return (window.isSecureContext &&
            typeof navigator.mediaDevices?.getUserMedia === "function" &&
            typeof AudioContext !== "undefined" &&
            typeof AudioWorkletNode !== "undefined" &&
            typeof MediaRecorder !== "undefined" &&
            this.recordingMime() !== "");
    }
    recordingMime() {
        const candidates = [
            "audio/webm;codecs=opus",
            "audio/ogg;codecs=opus",
            "audio/mp4",
        ];
        return candidates.find((mime) => MediaRecorder.isTypeSupported(mime)) || "";
    }
    onWorkletMessage(value) {
        if (!value || typeof value !== "object")
            return;
        const message = value;
        if (message.type === "energy") {
            if (typeof message.energy !== "number")
                return;
            return;
        }
        if (message.type === "audio") {
            if (!(this.state === "armed" || this.state === "wake_grace") ||
                !(message.samples instanceof Float32Array))
                return;
            this.detector?.process(message.samples);
            return;
        }
        if (message.type === "speech_start") {
            if (this.state === "wake_grace")
                this.beginCapture(false);
            else if (this.state === "lease")
                this.beginCapture(true);
            return;
        }
        if (message.type === "speech_end" && this.capture)
            this.stopCapture(false);
    }
    beginWakeGrace() {
        if (this.state !== "armed")
            return;
        this.worklet?.port.postMessage({ type: "reset_endpoint" });
        this.clearWakeTimer();
        this.wakeTimer = this.setTimer(() => {
            this.wakeTimer = null;
            if (this.state === "wake_grace") {
                this.detector?.reset();
                this.publish("armed", `Wake heard; speak within ${WAKE_SPEECH_GRACE_MS / 1000} seconds.`);
            }
        }, WAKE_SPEECH_GRACE_MS);
        this.publish("wake_grace", "Wake word heard. Speak now.");
    }
    beginCapture(lease) {
        if (!this.enabled || this.capture || !this.options.isSnapshotReady())
            return;
        if (this.options.isPttActive())
            return;
        const epoch = this.options.currentEpoch();
        const token = this.runtimeToken;
        let recorder;
        try {
            const mime = this.recordingMime();
            if (!mime)
                throw new Error("no supported recording MIME type");
            recorder = this.createRecorder(this.stream, mime);
        }
        catch (error) {
            this.publish("error", `Hands-free recording is unavailable (${this.errorName(error)}).`);
            this.disable();
            return;
        }
        const capture = {
            recorder,
            token,
            epoch,
            chunks: [],
            discard: false,
            lease,
        };
        this.capture = capture;
        if (lease)
            this.leaseUsed = true;
        recorder.ondataavailable = (event) => {
            if (this.capture !== capture ||
                capture.discard ||
                token !== this.runtimeToken)
                return;
            if (event.data.size)
                capture.chunks.push(event.data);
        };
        recorder.onstop = () => {
            if (this.capture !== capture || token !== this.runtimeToken)
                return;
            this.capture = null;
            if (capture.discard || !capture.chunks.length) {
                this.publish(capture.lease ? "awaiting_response" : "armed", "No utterance was retained.");
                return;
            }
            const blob = new Blob(capture.chunks, {
                type: recorder.mimeType || "audio/webm",
            });
            capture.chunks.length = 0;
            this.options.onClip(blob, blob.type, capture.epoch);
            this.publish("awaiting_response", "Utterance sent; waiting for the response.");
        };
        recorder.onerror = (event) => {
            if (this.capture !== capture || token !== this.runtimeToken)
                return;
            capture.discard = true;
            this.capture = null;
            this.publish("error", `Hands-free recording failed (${this.errorName(event.error)}).`);
            this.disable();
        };
        try {
            recorder.start();
        }
        catch (error) {
            capture.discard = true;
            this.capture = null;
            this.publish("error", `Hands-free recording failed (${this.errorName(error)}).`);
            this.disable();
            return;
        }
        this.clearWakeTimer();
        this.publish(lease ? "lease_capturing" : "capturing", "Capturing speech locally; silence will end it.");
        this.setTimer(() => {
            if (this.capture === capture && token === this.runtimeToken)
                this.stopCapture(false);
        }, MAX_HANDS_FREE_UTTERANCE_MS);
    }
    stopCapture(discard) {
        const capture = this.capture;
        if (!capture)
            return;
        capture.discard ||= discard;
        if (capture.recorder.state !== "inactive") {
            try {
                capture.recorder.stop();
            }
            catch {
                capture.discard = true;
                this.capture = null;
            }
        }
        else {
            this.capture = null;
        }
    }
    expireLease() {
        this.leaseTimer = null;
        if (this.leaseTickTimer !== null)
            this.clearTimer(this.leaseTickTimer);
        this.leaseTickTimer = null;
        this.leaseDeadline = 0;
        if (this.capture)
            this.capture.lease = false;
        this.leaseUsed = true;
        if (this.state === "lease") {
            this.publish("armed", "Follow-up window closed; wake word required again.");
        }
        else if (this.state === "lease_capturing") {
            this.publish("capturing", "Follow-up window closed; finishing the current utterance.");
        }
    }
    clearWakeTimer() {
        if (this.wakeTimer !== null)
            this.clearTimer(this.wakeTimer);
        this.wakeTimer = null;
    }
    clearLeaseTimer() {
        if (this.leaseTimer !== null)
            this.clearTimer(this.leaseTimer);
        if (this.leaseTickTimer !== null)
            this.clearTimer(this.leaseTickTimer);
        this.leaseTimer = null;
        this.leaseTickTimer = null;
        this.leaseDeadline = 0;
    }
    scheduleLeaseUpdate() {
        this.leaseTickTimer = this.setTimer(() => {
            this.leaseTickTimer = null;
            if (this.leaseDeadline <= 0 || this.leaseUsed)
                return;
            if (this.state === "lease" || this.state === "lease_capturing") {
                this.publish(this.state, "Follow-up listening is open for 8 seconds. No wake word needed.");
                this.scheduleLeaseUpdate();
            }
        }, 250);
    }
    releaseStream() {
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
    }
    releaseRuntime() {
        this.worklet?.port.close();
        this.worklet?.disconnect();
        this.source?.disconnect();
        this.sink?.disconnect();
        this.worklet = null;
        this.source = null;
        this.sink = null;
        this.releaseStream();
        const context = this.context;
        this.context = null;
        if (context)
            void context.close().catch(() => undefined);
    }
    publish(state, message) {
        this.state = state;
        this.options.onState({
            state,
            message,
            leaseRemainingMs: Math.max(0, this.leaseDeadline - this.now()),
        });
    }
    errorName(error) {
        return error instanceof Error ? error.name : "unknown error";
    }
}
