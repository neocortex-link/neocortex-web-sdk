let shared: AudioContext | null = null;

/**
 * One AudioContext for the whole page. Browsers cap how many can exist, and a
 * context only starts running after a user gesture, so it is created once and
 * resumed from the first click or key press that reaches the SDK.
 */
export function getAudioContext(): AudioContext | null {
  if (shared) return shared;
  const Ctor =
    globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    shared = new Ctor();
  } catch {
    return null;
  }
  return shared;
}

/** Call from a click or key handler so speech that arrives later is allowed to play. */
export function primeAudio(): void {
  const context = getAudioContext();
  if (context?.state === "suspended") void context.resume().catch(() => {});
}
