import type { NeocortexClient } from "../core/client";
import { isNeocortexError } from "../core/errors";
import type { ChatLine } from "../core/types";
import type { StreamingAudioPlayer } from "./audio/StreamingAudioPlayer";

export type SpeakOptions = {
  characterId: string;
  lines: ChatLine[];
  /** Synthesize and play each line. Otherwise lines are paced by reading time. */
  voice: boolean;
  /** Wait between text lines so they appear as separate thoughts. */
  pace: boolean;
  language?: string;
  signal: AbortSignal;
  onLineStart: (index: number) => void;
  onSpeechError: (error: unknown) => void;
};

/** How long a line stays on its own before the next one, when nothing is spoken. */
export function readingTime(text: string): number {
  return Math.min(2500, 400 + text.length * 25);
}

/**
 * Plays a reply line by line, in the character's voice when asked.
 *
 * While one line plays, the next line's speech is already being requested, so
 * there is no gap between lines. Streaming falls back to whole clips when the
 * server does not offer it, and a line that fails to synthesize is shown as text
 * rather than stalling the reply.
 */
export class LineSpeaker {
  private streaming = true;

  constructor(
    private readonly client: NeocortexClient,
    private readonly player: StreamingAudioPlayer,
  ) {}

  async speak(options: SpeakOptions): Promise<void> {
    const { lines, signal } = options;
    if (!options.voice) {
      for (let i = 0; i < lines.length && !signal.aborted; i++) {
        options.onLineStart(i);
        if (options.pace && i < lines.length - 1) await wait(readingTime(lines[i]!.text), signal);
      }
      return;
    }

    let next: Promise<Playable | null> | null = null;
    const request = (index: number) => this.fetchLine(options, lines[index]!).catch((error) => {
      options.onSpeechError(error);
      return null;
    });

    for (let i = 0; i < lines.length && !signal.aborted; i++) {
      const current = await (next ?? request(i));
      next = i + 1 < lines.length ? request(i + 1) : null;

      if (!current) {
        options.onLineStart(i);
        await wait(readingTime(lines[i]!.text), signal);
        continue;
      }
      let announced = false;
      const announce = () => {
        if (announced) return;
        announced = true;
        options.onLineStart(i);
      };
      try {
        await current.play(announce);
      } catch (error) {
        options.onSpeechError(error);
      }
      announce();
    }
    if (signal.aborted) this.player.stop();
  }

  private async fetchLine(options: SpeakOptions, line: ChatLine): Promise<Playable | null> {
    const message = line.spokenText || line.text;
    if (!message.trim()) return null;
    const base = {
      characterId: options.characterId,
      message,
      emotion: line.emotion,
      language: options.language,
      speechToken: line.speechToken,
    };

    if (this.streaming) {
      try {
        const stream = await this.client.streamAudio(base, { signal: options.signal });
        return {
          play: (onStart) => this.player.play(stream.chunks, { onStart, signal: options.signal }),
        };
      } catch (error) {
        // Older servers do not offer streaming; use whole clips from now on.
        const unsupported = isNeocortexError(error) && error.status === 404 && (!error.code || error.code === "not_found");
        if (!unsupported) throw error;
        this.streaming = false;
      }
    }
    const clip = await this.client.generateAudio({ ...base, format: "mp3" }, { signal: options.signal });
    return { play: (onStart) => this.player.playBlob(clip, { onStart, signal: options.signal }) };
  }
}

type Playable = { play(onStart: () => void): Promise<void> };

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    // The conversation's signal outlives every line, so take the listener off again.
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
