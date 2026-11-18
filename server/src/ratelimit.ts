// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Token-bucket rate limits, kept in memory per key (an IP address, a token
 * hash, an account).  A bucket holds up to `burst` requests and refills at
 * `perSecond`; idle buckets are forgotten by `sweep` so the map stays small.
 */

export class RateLimiter {
  readonly perSecond: number;
  readonly burst: number;
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(perSecond: number, burst: number) {
    this.perSecond = perSecond;
    this.burst = burst;
  }

  /** Takes `cost` from the key's bucket; false (and nothing taken) when it is empty. */
  take(key: string, cost = 1, nowMs = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, at: nowMs };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + ((nowMs - b.at) / 1000) * this.perSecond);
      b.at = nowMs;
    }
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  /** True when the key's bucket holds at least one request (nothing taken). */
  has(key: string, nowMs = Date.now()): boolean {
    const b = this.buckets.get(key);
    return !b || b.tokens + ((nowMs - b.at) / 1000) * this.perSecond >= 1;
  }

  /** Forgets buckets that are full again. */
  sweep(nowMs = Date.now()): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((nowMs - b.at) / 1000) * this.perSecond >= this.burst) this.buckets.delete(k);
    }
  }
}

/** A limiter allowing `n` per minute with a burst of `n` (at least 1). */
export const perMinute = (n: number): RateLimiter => new RateLimiter(n / 60, Math.max(1, n));
export const perHour = (n: number): RateLimiter => new RateLimiter(n / 3600, Math.max(1, n));
