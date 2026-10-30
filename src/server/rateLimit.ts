/**
 * Per-user request limits for the proxy.
 *
 * The in-memory limiter is right for a single long-running server. Across several
 * instances or on serverless hosts each instance counts on its own, so pass a
 * limiter backed by a shared store (Redis, Upstash, Cloudflare KV...) instead.
 */

export type RateLimitResult = { allowed: boolean; retryAfter: number };

export interface RateLimiter {
  take(key: string): RateLimitResult | Promise<RateLimitResult>;
}

export type RateLimitOptions = {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
};

/** A sliding-window counter per key, held in memory. */
export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, number[]>();
  private lastSweep = Date.now();

  constructor(private readonly options: RateLimitOptions = { limit: 30, windowSeconds: 60 }) {}

  take(key: string): RateLimitResult {
    const now = Date.now();
    const windowMs = this.options.windowSeconds * 1000;
    this.sweep(now, windowMs);

    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < windowMs);
    if (recent.length >= this.options.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfter: 0 };
  }

  /** Drops idle keys now and then so memory does not grow with every visitor ever seen. */
  private sweep(now: number, windowMs: number) {
    if (now - this.lastSweep < windowMs) return;
    this.lastSweep = now;
    for (const [key, times] of this.hits) {
      if (times.every((at) => now - at >= windowMs)) this.hits.delete(key);
    }
  }
}
