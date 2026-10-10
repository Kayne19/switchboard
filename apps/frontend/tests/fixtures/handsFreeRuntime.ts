// A real HandsFreeController inside a CallRuntime test, over fakes of
// everything beneath it: the two detectors (the test fires them by hand), the
// microphone, the 16 kHz graph and the recorder. The runtime's own fake
// controller only records the calls it is given; this one has the lifecycle
// the page really runs, so a test sees how the two halves meet.
import { vi } from "vitest";
import {
  HandsFreeController,
  type SpeechEndpointer,
  type WakeDetector,
} from "../../src/hands_free";
import type { CallRuntimeOptions } from "../../src/runtime/callRuntime";

type Callback = () => void;

/**
 * The browser features `HandsFreeController.enable()` checks for, stubbed as
 * globals so that `vi.unstubAllGlobals()` takes every one of them away again.
 */
export function stubHandsFreeBrowser(): void {
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => undefined },
  });
  vi.stubGlobal("AudioContext", class {});
  vi.stubGlobal("AudioWorkletNode", class {});
  vi.stubGlobal("MediaRecorder", {
    isTypeSupported: (mime: string) => mime === "audio/webm;codecs=opus",
  });
}

function fakeGraph() {
  return {
    state: "running",
    destination: {},
    audioWorklet: { addModule: async () => undefined },
    resume: async () => undefined,
    close: async () => undefined,
    createMediaStreamSource: () => ({
      connect: () => undefined,
      disconnect: () => undefined,
    }),
    createGain: () => ({
      gain: { value: 1 },
      connect: () => undefined,
      disconnect: () => undefined,
    }),
  };
}

/**
 * Runtime options that build a real controller. `createRecorder` makes the
 * recorder for both push-to-talk and hands-free captures.
 */
export function realHandsFree(createRecorder: () => MediaRecorder) {
  let detect: Callback = () => undefined;
  let speechStart: Callback = () => undefined;
  let speechEnd: Callback = () => undefined;
  const detector = {
    load: async () => undefined,
    reset: () => undefined,
    process: () => undefined,
    onDetect: (callback: Callback) => {
      detect = callback;
      return () => undefined;
    },
    onError: () => () => undefined,
  };
  const endpointer = {
    load: async () => undefined,
    reset: () => undefined,
    process: () => undefined,
    onSpeechStart: (callback: Callback) => {
      speechStart = callback;
      return () => undefined;
    },
    onSpeechEnd: (callback: Callback) => {
      speechEnd = callback;
      return () => undefined;
    },
    onError: () => () => undefined,
  };
  const worklet = {
    port: { onmessage: null, close: () => undefined },
    connect: () => undefined,
    disconnect: () => undefined,
  };
  const stream = { getTracks: () => [{ stop: () => undefined }] };
  let controller: HandsFreeController | null = null;
  const options: Partial<CallRuntimeOptions> = {
    createRecorder,
    // The push-to-talk level meter's context.
    createAudioContext: () => fakeGraph() as unknown as AudioContext,
    loadWakeDetector: async () => detector as unknown as WakeDetector,
    loadSpeechEndpointer: async () => endpointer as unknown as SpeechEndpointer,
    createHandsFree: (runtimeOptions) => {
      controller = new HandsFreeController({
        ...runtimeOptions,
        getUserMedia: async () => stream as unknown as MediaStream,
        createAudioContext: () => fakeGraph() as unknown as AudioContext,
        createWorkletNode: () => worklet as unknown as AudioWorkletNode,
        createRecorder,
        isForeground: () => true,
      });
      return controller;
    },
  };
  return {
    options,
    controller: (): HandsFreeController => {
      if (!controller) throw new Error("hands-free was never turned on");
      return controller;
    },
    hear: () => detect(),
    speechStarts: () => speechStart(),
    speechEnds: () => speechEnd(),
  };
}
