/**
 * Client-side request pacing.
 *
 * Hudu documents a limit of 300 requests per minute and documents no 429
 * response, no `Retry-After`, and no `X-RateLimit-*` headers anywhere in its
 * OpenAPI description. We therefore cannot rely on the server telling us we are
 * over the line — the only safe posture is to stay under it ourselves.
 *
 * Two independent controls, because they solve different problems:
 *   - a token bucket bounds the long-run *rate*;
 *   - a semaphore bounds *concurrency*, so a burst of parallel tool calls
 *     cannot open thirty sockets at once even while the bucket has tokens.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Never hold the process open for a pacing delay.
      timer.unref();
    }),
};

/** A refilling token bucket. One token is one request. */
export class TokenBucket {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #clock: Clock;
  #tokens: number;
  #lastRefill: number;

  public constructor(perMinute: number, clock: Clock = systemClock) {
    if (perMinute <= 0) throw new RangeError('perMinute must be greater than zero');
    this.#capacity = perMinute;
    this.#refillPerMs = perMinute / 60_000;
    this.#clock = clock;
    this.#tokens = perMinute;
    this.#lastRefill = clock.now();
  }

  #refill(): void {
    const now = this.#clock.now();
    const elapsed = now - this.#lastRefill;
    if (elapsed <= 0) return;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillPerMs);
    this.#lastRefill = now;
  }

  /** Milliseconds until a token is available; 0 when one is available now. */
  public delayUntilAvailable(): number {
    this.#refill();
    if (this.#tokens >= 1) return 0;
    return Math.ceil((1 - this.#tokens) / this.#refillPerMs);
  }

  /** Wait until a token is free, then consume it. */
  public async acquire(): Promise<void> {
    for (;;) {
      const delay = this.delayUntilAvailable();
      if (delay === 0) {
        this.#tokens -= 1;
        return;
      }
      await this.#clock.sleep(delay);
    }
  }
}

/** A counting semaphore bounding in-flight requests. */
export class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #queue: (() => void)[] = [];

  public constructor(limit: number) {
    if (limit <= 0) throw new RangeError('limit must be greater than zero');
    this.#limit = limit;
  }

  public get active(): number {
    return this.#active;
  }

  public async acquire(): Promise<() => void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return this.#release;
    }
    await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#active += 1;
    return this.#release;
  }

  readonly #release = (): void => {
    this.#active -= 1;
    const next = this.#queue.shift();
    if (next) next();
  };

  /** Run `fn` while holding a slot, releasing it even if `fn` throws. */
  public async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Full-jitter exponential backoff.
 *
 * Full jitter rather than a fixed ramp: several tool calls that trip the same
 * limit at the same moment must not retry in lockstep.
 */
export function backoffDelayMs(attempt: number, baseMs = 500, capMs = 20_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/** Parse a `Retry-After` header, which may be seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - now);
}
