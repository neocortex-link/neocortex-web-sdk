import type { NeocortexClient } from "../core/client";
import type { NeocortexError } from "../core/errors";
import type { UsageResponse } from "../core/types";
import { Emitter } from "./emitter";
import { type ClientSource, resolveClient, toNeocortexError } from "./shared";

export type UsageGateEvents = {
  updated: UsageResponse;
  lowCredits: UsageResponse;
  creditsEmpty: UsageResponse;
  playerOverLimit: UsageResponse;
  characterOverLimit: UsageResponse;
  /** The check itself failed. Conversations stay allowed. */
  error: NeocortexError;
};

export type UsageGateOptions = ClientSource & {
  characterId?: string;
  /** Seconds between server checks; calls inside this window reuse the last answer. */
  minRefreshSeconds?: number;
};

/**
 * Tells you whether there are credits left before you offer a conversation, so
 * a game can fall back to scripted lines instead of showing errors. Fails open:
 * if the check itself fails, conversations stay available.
 */
export class UsageGate extends Emitter<UsageGateEvents> {
  readonly client: NeocortexClient;
  characterId?: string;
  minRefreshSeconds: number;

  private last: UsageResponse | null = null;
  private lastAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<UsageResponse | null> | null = null;

  constructor(options: UsageGateOptions = {}) {
    super();
    this.client = resolveClient(options);
    this.characterId = options.characterId;
    this.minRefreshSeconds = options.minRefreshSeconds ?? 30;
  }

  get usage(): UsageResponse | null {
    return this.last;
  }

  /** False only when the last check said credits or this player's or character's allowance ran out. */
  canUse(): boolean {
    if (!this.last) return true;
    return this.last.status !== "empty" && !this.last.player?.overLimit && !this.last.character?.overLimit;
  }

  async refresh(force = false): Promise<UsageResponse | null> {
    if (!force && this.last && Date.now() - this.lastAt < this.minRefreshSeconds * 1000) return this.last;
    this.inFlight ??= this.load().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  startAutoRefresh(seconds = this.minRefreshSeconds): void {
    this.stopAutoRefresh();
    void this.refresh(true);
    this.timer = setInterval(() => void this.refresh(true), Math.max(5, seconds) * 1000);
  }

  stopAutoRefresh(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async load(): Promise<UsageResponse | null> {
    try {
      const usage = await this.client.usage(this.characterId ? { characterId: this.characterId } : {});
      this.last = usage;
      this.lastAt = Date.now();
      this.emit("updated", usage);
      if (usage.status === "low") this.emit("lowCredits", usage);
      if (usage.status === "empty") this.emit("creditsEmpty", usage);
      if (usage.player?.overLimit) this.emit("playerOverLimit", usage);
      if (usage.character?.overLimit) this.emit("characterOverLimit", usage);
      return usage;
    } catch (error) {
      this.emit("error", toNeocortexError(error));
      return this.last;
    }
  }
}
