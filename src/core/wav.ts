/**
 * WAV helpers shared by the streamed-speech reader and the microphone.
 *
 * `/audio/stream` sends a WAV header that declares an unknown length, then raw
 * 16-bit PCM as it is synthesized. Browsers cannot read the `X-Sample-Rate`
 * header across origins, so the header is the only reliable place to learn the
 * format.
 */

export type WavFormat = { offset: number; sampleRate: number; channels: number };

/** Where the PCM starts, and what shape it is. Returns null until enough bytes have arrived. */
export function readWavHeader(bytes: Uint8Array): WavFormat | null {
  if (bytes.length < 12) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) =>
    String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let at = 12;
  let sampleRate = 24000;
  let channels = 1;

  // RIFF chunks are not fixed width, so walk them rather than assume 44 bytes.
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "data") return { offset: at + 8, sampleRate, channels };
    if (id === "fmt ") {
      if (at + 16 > bytes.length) return null;
      channels = view.getUint16(at + 10, true) || 1;
      sampleRate = view.getUint32(at + 12, true) || 24000;
    }
    // A streaming header can declare an unknown size; the data chunk is the only
    // one where that happens in practice, and it was handled above.
    if (size === 0xffffffff) return null;
    at += 8 + size + (size % 2);
  }
  return null;
}

export type PcmChunk = {
  sampleRate: number;
  /** One Float32Array per channel, samples in [-1, 1]. */
  channels: Float32Array[];
};

/**
 * Turns a byte stream of WAV into PCM chunks as the bytes arrive.
 *
 * Network chunks fall wherever they like, including in the middle of the header
 * or between the two bytes of a sample, so this holds back whatever is not yet a
 * whole frame.
 */
export class PcmStreamDecoder {
  private format: WavFormat | null = null;
  private pending: Uint8Array = new Uint8Array(0);

  get sampleRate(): number | undefined {
    return this.format?.sampleRate;
  }

  push(chunk: Uint8Array): PcmChunk | null {
    this.pending = concat(this.pending, chunk);

    if (!this.format) {
      this.format = readWavHeader(this.pending);
      if (!this.format) {
        // A body that is clearly not WAV will never become one.
        if (this.pending.length >= 12 && !startsWithRiff(this.pending)) {
          throw new Error("The speech stream is not WAV audio.");
        }
        return null;
      }
      this.pending = this.pending.subarray(this.format.offset);
    }

    const frameBytes = 2 * this.format.channels;
    const usable = this.pending.length - (this.pending.length % frameBytes);
    if (usable === 0) return null;

    const frames = this.pending.subarray(0, usable);
    this.pending = this.pending.slice(usable);
    return decodePcm16(frames, this.format.sampleRate, this.format.channels);
  }
}

function startsWithRiff(bytes: Uint8Array): boolean {
  return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
}

export function decodePcm16(bytes: Uint8Array, sampleRate: number, channelCount: number): PcmChunk {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameCount = Math.floor(bytes.length / (2 * channelCount));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount));

  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < channelCount; c++) {
      channels[c]![i] = view.getInt16((i * channelCount + c) * 2, true) / 32768;
    }
  }
  return { sampleRate, channels };
}

/** Encodes mono samples in [-1, 1] as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const write = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };

  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/** Linear resampling, which is plenty for speech headed to a transcriber. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio;
    const left = Math.floor(at);
    const right = Math.min(left + 1, samples.length - 1);
    const t = at - left;
    out[i] = (samples[left] ?? 0) * (1 - t) + (samples[right] ?? 0) * t;
  }
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a);
  merged.set(b, a.length);
  return merged;
}
