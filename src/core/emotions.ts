/**
 * The emotions a character can express.
 *
 * Chat replies spell these in camelCase (`happy`), while the audio endpoints take
 * them in UPPERCASE (`HAPPY`). The SDK speaks camelCase everywhere and converts at
 * the edge, so callers never have to remember which endpoint wants which.
 */
export const EMOTIONS = [
  "neutral",
  "happy",
  "pleased",
  "disappointed",
  "upset",
  "amazed",
  "curious",
  "confused",
  "alarmed",
  "fascinated",
  "impressed",
  "annoyed",
  "angry",
  "confident",
  "reassured",
  "concerned",
  "scared",
] as const;

export type Emotion = (typeof EMOTIONS)[number];

const known = new Set<string>(EMOTIONS);

/** Reads whatever casing the server sent, falling back to neutral for anything unknown. */
export function toEmotion(value: string | null | undefined): Emotion {
  const lower = (value ?? "").toLowerCase();
  return known.has(lower) ? (lower as Emotion) : "neutral";
}

/** The spelling the audio endpoints expect. */
export function toAudioEmotion(value: string | null | undefined): string {
  return toEmotion(value).toUpperCase();
}
