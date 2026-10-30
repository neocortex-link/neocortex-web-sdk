import type { PcmChunk } from "../../core/wav";
import { getAudioContext, primeAudio } from "./context";

export type PlayOptions = {
  /** Called once sound actually starts. */
  onStart?: () => void;
  signal?: AbortSignal;
};

/**
 * Plays a character's voice while it is still being synthesized.
 *
 * An `<audio>` element can only play a clip that has fully arrived, so streamed
 * speech is scheduled block by block through Web Audio instead. A short
 * prebuffer keeps a slow first block from stuttering. Ported from the Neocortex
 * site's mascot player.
 */
export class StreamingAudioPlayer {
  private readonly prebufferSeconds: number;
  private sources = new Set<AudioBufferSourceNode>();
  private analyser: AnalyserNode | null = null;
  private levelBuffer: Float32Array<ArrayBuffer> | null = null;
  private stopCurrent: (() => void) | null = null;
  private volumeNode: GainNode | null = null;
  private _volume = 1;

  constructor(options: { prebufferSeconds?: number } = {}) {
    this.prebufferSeconds = options.prebufferSeconds ?? 0.15;
  }

  /** Unlocks audio output. Call from a user gesture before the first reply arrives. */
  prime(): void {
    primeAudio();
  }

  get isPlaying(): boolean {
    return this.sources.size > 0 || this.stopCurrent !== null;
  }

  get volume(): number {
    return this._volume;
  }

  set volume(value: number) {
    this._volume = Math.max(0, Math.min(1, value));
    if (this.volumeNode) this.volumeNode.gain.value = this._volume;
  }

  /** How loud the speech is right now, 0 to 1. Drive a mouth or a level meter with it. */
  getLevel(): number {
    if (!this.analyser || !this.levelBuffer || this.sources.size === 0) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (const sample of this.levelBuffer) sum += sample * sample;
    return Math.min(1, Math.sqrt(sum / this.levelBuffer.length) * 4);
  }

  /** Plays streamed PCM. Resolves once the last block has finished playing (or on stop). */
  async play(chunks: AsyncIterable<PcmChunk>, options: PlayOptions = {}): Promise<void> {
    const context = getAudioContext();
    if (!context) throw new Error("Web Audio is not available in this browser.");
    if (context.state === "suspended") await context.resume().catch(() => {});
    this.stop();

    const output = this.output(context);
    let stopped = false;
    let playHead = 0;
    let started = false;
    const waiting: PcmChunk[] = [];
    let waitingSeconds = 0;

    let finish: (() => void) | null = null;
    const stop = () => {
      stopped = true;
      finish?.();
      for (const source of this.sources) {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      }
      this.sources.clear();
    };
    this.stopCurrent = stop;
    options.signal?.addEventListener("abort", stop, { once: true });

    const schedule = (chunk: PcmChunk) => {
      const frames = chunk.channels[0]?.length ?? 0;
      if (frames === 0) return;
      const buffer = context.createBuffer(chunk.channels.length, frames, chunk.sampleRate);
      chunk.channels.forEach((data, channel) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, channel));

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(output);
      // Kept ahead of the clock so blocks abut rather than overlap.
      playHead = Math.max(playHead, context.currentTime);
      source.start(playHead);
      playHead += buffer.duration;
      this.sources.add(source);
      source.onended = () => this.sources.delete(source);
    };

    const begin = () => {
      started = true;
      playHead = context.currentTime;
      for (const chunk of waiting) schedule(chunk);
      waiting.length = 0;
      options.onStart?.();
    };

    try {
      for await (const chunk of chunks) {
        if (stopped) break;
        if (started) {
          schedule(chunk);
          continue;
        }
        waiting.push(chunk);
        waitingSeconds += (chunk.channels[0]?.length ?? 0) / chunk.sampleRate;
        if (waitingSeconds >= this.prebufferSeconds) begin();
      }
    } finally {
      // Whatever is left is shorter than the prebuffer, so play it rather than drop it.
      if (!stopped && !started && waiting.length) begin();
    }

    if (!stopped) {
      await new Promise<void>((resolve) => {
        const remaining = Math.max(0, playHead - context.currentTime);
        // onended on the last source can be skipped by some browsers; the clock is the backstop.
        const timer = setTimeout(resolve, remaining * 1000 + 100);
        finish = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    if (this.stopCurrent === stop) this.stopCurrent = null;
  }

  /** Plays a whole clip, such as the result of `generateAudio`. */
  async playBlob(blob: Blob, options: PlayOptions = {}): Promise<void> {
    const context = getAudioContext();
    if (!context) throw new Error("Web Audio is not available in this browser.");
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    async function* once() {
      yield { sampleRate: buffer.sampleRate, channels };
    }
    await this.play(once(), options);
  }

  stop(): void {
    const stop = this.stopCurrent;
    this.stopCurrent = null;
    stop?.();
  }

  private output(context: AudioContext): AudioNode {
    if (!this.volumeNode) {
      this.volumeNode = context.createGain();
      this.volumeNode.gain.value = this._volume;
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 512;
      this.levelBuffer = new Float32Array(this.analyser.fftSize);
      this.volumeNode.connect(this.analyser);
      this.analyser.connect(context.destination);
    }
    return this.volumeNode;
  }
}
