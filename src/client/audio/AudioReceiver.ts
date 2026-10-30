import { encodeWav, resample } from "../../core/wav";
import { Emitter } from "../emitter";
import { getAudioContext } from "./context";

export type ReceiverState = "idle" | "listening" | "recording";

export type AudioReceiverEvents = {
  /** Microphone loudness, 0 to 1, about 20 times a second. */
  amplitude: number;
  state: ReceiverState;
  speechStarted: void;
  /** A finished recording, as a 16 kHz mono WAV. */
  recorded: Blob;
  permissionGranted: void;
  permissionDenied: Error;
  error: Error;
};

export type AudioReceiverOptions = {
  /** Record only while `press()` is held, instead of detecting speech. */
  pushToTalk?: boolean;
  /** Loudness (0 to 1) that counts as speech. */
  amplitudeThreshold?: number;
  /** Seconds of silence that end a recording. */
  maxWaitTime?: number;
  /** Longest recording, in seconds. */
  maxRecordingSeconds?: number;
  /** Keep listening for the next phrase after one is recorded. */
  keepListening?: boolean;
  /** A specific input device. Defaults to the one last selected, or the system default. */
  deviceId?: string;
};

const DEVICE_KEY = "neocortex-mic-device";
const OUTPUT_RATE = 16_000;
/** Audio kept from just before speech was detected, so the first syllable is not clipped. */
const PREROLL_SECONDS = 0.3;

const WORKLET_SOURCE = `
class NeocortexCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(2048); this.at = 0; }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.buffer[this.at++] = input[i];
        if (this.at === this.buffer.length) { this.port.postMessage(this.buffer.slice()); this.at = 0; }
      }
    }
    return true;
  }
}
registerProcessor("neocortex-capture", NeocortexCapture);
`;

/**
 * Records the player's voice, with automatic speech detection or push-to-talk.
 *
 * In detection mode it listens continuously, starts recording when loudness
 * crosses the threshold, and finishes after `maxWaitTime` seconds of silence.
 * Mirrors the Unity SDK's `NeocortexAudioReceiver`, on an AudioWorklet instead of
 * the deprecated ScriptProcessor.
 */
export class AudioReceiver extends Emitter<AudioReceiverEvents> {
  pushToTalk: boolean;
  amplitudeThreshold: number;
  maxWaitTime: number;
  maxRecordingSeconds: number;
  keepListening: boolean;

  private _state: ReceiverState = "idle";
  private _amplitude = 0;
  private deviceId?: string;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioNode | null = null;
  private sampleRate = 48_000;
  private recorded: Float32Array[] = [];
  private recordedFrames = 0;
  private preroll: Float32Array[] = [];
  private silentSeconds = 0;
  private lastAmplitudeEmit = 0;
  private starting: Promise<void> | null = null;
  /** Bumped by stop(), so a microphone that opens afterwards knows it is no longer wanted. */
  private generation = 0;
  private pressed = false;
  private static workletUrl: string | null = null;

  constructor(options: AudioReceiverOptions = {}) {
    super();
    this.pushToTalk = options.pushToTalk ?? false;
    this.amplitudeThreshold = options.amplitudeThreshold ?? 0.1;
    this.maxWaitTime = options.maxWaitTime ?? 1.2;
    this.maxRecordingSeconds = options.maxRecordingSeconds ?? 30;
    this.keepListening = options.keepListening ?? false;
    this.deviceId = options.deviceId ?? readStoredDevice();
  }

  get state(): ReceiverState {
    return this._state;
  }

  get amplitude(): number {
    return this._amplitude;
  }

  get isListening(): boolean {
    return this._state !== "idle";
  }

  get isRecording(): boolean {
    return this._state === "recording";
  }

  /** Seconds of silence so far in the current recording, for a countdown ring. */
  get silenceProgress(): number {
    return this._state === "recording" && !this.pushToTalk ? Math.min(1, this.silentSeconds / this.maxWaitTime) : 0;
  }

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && !!getAudioContext();
  }

  /** Lists microphones. Labels are only filled in once permission has been granted. */
  static async devices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  }

  /** Switches microphone, remembering the choice for next time. */
  async selectDevice(deviceId: string): Promise<void> {
    this.deviceId = deviceId || undefined;
    try {
      if (deviceId) localStorage.setItem(DEVICE_KEY, deviceId);
      else localStorage.removeItem(DEVICE_KEY);
    } catch {
      // Not remembered; still used for this page.
    }
    if (this.stream) {
      const wasState = this._state;
      this.stop();
      await this.start();
      if (wasState === "recording" && this.pushToTalk) this.press();
    }
  }

  /** Opens the microphone. In detection mode, recording begins when the player speaks. */
  start(): Promise<void> {
    if (this.stream) return Promise.resolve();
    // A second click while the permission prompt is up joins the first request
    // instead of opening a second microphone.
    this.starting ??= this.open().finally(() => (this.starting = null));
    return this.starting;
  }

  private async open(): Promise<void> {
    const generation = this.generation;
    const context = getAudioContext();
    if (!context || !navigator.mediaDevices?.getUserMedia) {
      const error = new Error("This browser cannot record audio.");
      this.emit("error", error);
      throw error;
    }
    if (context.state === "suspended") await context.resume().catch(() => {});

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      // A remembered device that was unplugged should not lock the player out.
      if (this.deviceId && (error as Error)?.name === "OverconstrainedError") {
        this.deviceId = undefined;
        return this.open();
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      this.emit(failure.name === "NotAllowedError" ? "permissionDenied" : "error", failure);
      throw failure;
    }

    // stop() was called while the prompt was up: close what just opened.
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.emit("permissionGranted", undefined);

    const source = context.createMediaStreamSource(stream);
    const node = await this.createCapture(context);
    if (generation !== this.generation) {
      node.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.sampleRate = context.sampleRate;
    this.stream = stream;
    this.source = source;
    this.node = node;
    source.connect(node);
    this.setState("listening");
  }

  /** Closes the microphone, including one still waiting on permission. A recording in progress is discarded. */
  stop(): void {
    this.generation++;
    this.pressed = false;
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = this.source = this.node = null;
    this.resetRecording();
    this._amplitude = 0;
    this.setState("idle");
  }

  /** Push-to-talk: start recording. Opens the microphone if needed. */
  async press(): Promise<void> {
    this.pressed = true;
    if (!this.stream) await this.start();
    // Released while the microphone was opening: record nothing.
    if (this.pressed && this.stream) this.beginRecording();
  }

  /** Push-to-talk: stop recording and emit what was said. */
  release(): void {
    this.pressed = false;
    if (this._state === "recording") this.finishRecording();
  }

  private async createCapture(context: AudioContext): Promise<AudioNode> {
    if (context.audioWorklet) {
      try {
        AudioReceiver.workletUrl ??= URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
        await context.audioWorklet.addModule(AudioReceiver.workletUrl);
        const node = new AudioWorkletNode(context, "neocortex-capture");
        node.port.onmessage = (event: MessageEvent<Float32Array>) => this.onFrames(event.data);
        return node;
      } catch {
        // A strict Content-Security-Policy can refuse blob: modules; fall through.
      }
    }
    // Fallback for browsers or pages where AudioWorklet is unavailable.
    const processor = context.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (event) => this.onFrames(event.inputBuffer.getChannelData(0).slice());
    processor.connect(context.destination);
    return processor;
  }

  private onFrames(frames: Float32Array): void {
    let sum = 0;
    for (const sample of frames) sum += sample * sample;
    this._amplitude = Math.min(1, Math.sqrt(sum / frames.length) * 10);
    const seconds = frames.length / this.sampleRate;

    const now = performance.now();
    if (now - this.lastAmplitudeEmit > 50) {
      this.lastAmplitudeEmit = now;
      this.emit("amplitude", this._amplitude);
    }

    if (this._state === "listening") {
      if (this.pushToTalk) return;
      this.preroll.push(frames);
      while (this.preroll.length * frames.length > PREROLL_SECONDS * this.sampleRate) this.preroll.shift();
      if (this._amplitude >= this.amplitudeThreshold) this.beginRecording();
      return;
    }

    if (this._state !== "recording") return;
    this.recorded.push(frames);
    this.recordedFrames += frames.length;

    if (!this.pushToTalk) {
      this.silentSeconds = this._amplitude < this.amplitudeThreshold ? this.silentSeconds + seconds : 0;
      if (this.silentSeconds >= this.maxWaitTime) return this.finishRecording();
    }
    if (this.recordedFrames / this.sampleRate >= this.maxRecordingSeconds) this.finishRecording();
  }

  private beginRecording(): void {
    if (this._state === "recording") return;
    this.recorded = [...this.preroll];
    this.recordedFrames = this.recorded.reduce((n, f) => n + f.length, 0);
    this.preroll = [];
    this.silentSeconds = 0;
    this.setState("recording");
    this.emit("speechStarted", undefined);
  }

  private finishRecording(): void {
    const merged = new Float32Array(this.recordedFrames);
    let at = 0;
    for (const frames of this.recorded) {
      merged.set(frames, at);
      at += frames.length;
    }
    this.resetRecording();

    if (this.keepListening && this.stream) this.setState("listening");
    else this.stop();

    // Anything shorter than a fifth of a second is a click, not speech.
    if (merged.length < this.sampleRate * 0.2) return;
    const wav = encodeWav(resample(merged, this.sampleRate, OUTPUT_RATE), OUTPUT_RATE);
    this.emit("recorded", new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }));
  }

  private resetRecording(): void {
    this.recorded = [];
    this.recordedFrames = 0;
    this.preroll = [];
    this.silentSeconds = 0;
  }

  private setState(state: ReceiverState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit("state", state);
  }
}

function readStoredDevice(): string | undefined {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
