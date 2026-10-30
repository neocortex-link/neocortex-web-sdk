import type { EventLog } from "../core/types";

const MAX_CONTENT = 64;
const MAX_SENT = 20;

/**
 * Collects game events for characters to know about ("the player opened the
 * vault"). Follows the Unity SDK's rules: each entry is cut to 64 characters, and
 * a turn sends at most 20, highest priority first, then newest.
 *
 * The server proxy drops browser-sent events unless it is created with
 * `allowClientContext: true`.
 */
export class EventLogger {
  private entries: EventLog[] = [];

  push(content: string, priority: EventLog["priority"] = 1, date: Date = new Date()): void {
    const text = content.trim().slice(0, MAX_CONTENT);
    if (!text) return;
    this.entries.push({ content: text, priority, date: date.toISOString() });
    // Keep the backlog bounded; nothing past the top 20 is ever sent.
    if (this.entries.length > MAX_SENT * 5) this.entries = this.getLogs(MAX_SENT * 2);
  }

  getLogs(limit = MAX_SENT): EventLog[] {
    return [...this.entries]
      .sort((a, b) => b.priority - a.priority || (b.date ?? "").localeCompare(a.date ?? ""))
      .slice(0, limit);
  }

  clear(): void {
    this.entries = [];
  }
}
