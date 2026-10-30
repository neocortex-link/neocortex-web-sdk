/**
 * Remembers each conversation's session between page loads, so a character
 * keeps its memory of the player. Uses the same key names as the Unity SDK.
 */
export interface SessionStore {
  get(key: string): string | null;
  set(key: string, sessionId: string): void;
  clear(key: string): void;
}

const PREFIX = "neocortex-session-id_";

/** localStorage when it is available, memory otherwise (private windows, sandboxed iframes). */
export class LocalSessionStore implements SessionStore {
  private memory = new Map<string, string>();

  get(key: string): string | null {
    try {
      return globalThis.localStorage?.getItem(PREFIX + key) ?? this.memory.get(key) ?? null;
    } catch {
      return this.memory.get(key) ?? null;
    }
  }

  set(key: string, sessionId: string): void {
    this.memory.set(key, sessionId);
    try {
      globalThis.localStorage?.setItem(PREFIX + key, sessionId);
    } catch {
      // Storage is full or blocked; memory keeps the session for this page.
    }
  }

  clear(key: string): void {
    this.memory.delete(key);
    try {
      globalThis.localStorage?.removeItem(PREFIX + key);
    } catch {
      // Nothing stored to remove.
    }
  }
}

/** Forgets everything when the page closes. */
export class MemorySessionStore implements SessionStore {
  private map = new Map<string, string>();
  get(key: string) {
    return this.map.get(key) ?? null;
  }
  set(key: string, sessionId: string) {
    this.map.set(key, sessionId);
  }
  clear(key: string) {
    this.map.delete(key);
  }
}
