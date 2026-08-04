/**
 * Client-side pacing.
 *
 * Hudu documents a 300/minute limit but documents no `429`, no `Retry-After`
 * and no `X-RateLimit-*` header anywhere (docs/reference/spec-defects.md A8),
 * so the server cannot be relied on to say when the line is crossed. Every
 * assertion here runs against an injected clock: the suite proves the pacing
 * arithmetic without spending any of the time it schedules.
 */

import { describe, expect, it } from 'vitest';

import {
  backoffDelayMs,
  parseRetryAfter,
  Semaphore,
  TokenBucket,
} from '../../src/api/rate-limit.js';
import { fakeClock } from '../helpers/fixtures.js';

describe('TokenBucket', () => {
  it('starts full: capacity requests are available with no wait', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(3, clock);

    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();

    expect(clock.slept).toEqual([]);
  });

  it('reports a wait once the bucket is empty', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(60, clock); // one token per 1000ms

    for (let index = 0; index < 60; index += 1) await bucket.acquire();

    expect(bucket.delayUntilAvailable()).toBe(1000);
  });

  it('waits, rather than over-issuing, when the bucket is empty', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(60, clock);

    for (let index = 0; index < 60; index += 1) await bucket.acquire();
    expect(clock.slept).toEqual([]);

    await bucket.acquire();

    expect(clock.slept).toEqual([1000]);
  });

  it('refills over elapsed time', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(60, clock);

    for (let index = 0; index < 60; index += 1) await bucket.acquire();
    expect(bucket.delayUntilAvailable()).toBe(1000);

    clock.advance(5_000); // five tokens back

    for (let index = 0; index < 5; index += 1) await bucket.acquire();
    expect(clock.slept).toEqual([]);
    expect(bucket.delayUntilAvailable()).toBe(1000);
  });

  it('never refills above capacity', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, clock);

    clock.advance(10 * 60_000); // ten minutes of idle time

    await bucket.acquire();
    await bucket.acquire();

    expect(clock.slept).toEqual([]);
    expect(bucket.delayUntilAvailable()).toBeGreaterThan(0);
  });

  it('rejects a non-positive rate rather than dividing by zero', () => {
    expect(() => new TokenBucket(0, fakeClock())).toThrow(RangeError);
    expect(() => new TokenBucket(-1, fakeClock())).toThrow(RangeError);
  });
});

describe('Semaphore', () => {
  it('bounds the number of simultaneously running tasks', async () => {
    const semaphore = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];

    const task = (): Promise<void> =>
      semaphore.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running -= 1;
      });

    const all = [task(), task(), task(), task(), task()];

    // Let the first batch start, then drain one gate at a time.
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
      releases.shift()?.();
      await Promise.resolve();
    }
    while (releases.length > 0) {
      releases.shift()?.();
      await Promise.resolve();
    }

    await Promise.all(all);

    expect(peak).toBeLessThanOrEqual(2);
    expect(semaphore.active).toBe(0);
  });

  it('releases the slot when the task throws', async () => {
    const semaphore = new Semaphore(1);

    await expect(semaphore.run(() => Promise.reject(new Error('handler blew up')))).rejects.toThrow(
      'handler blew up',
    );

    expect(semaphore.active).toBe(0);

    // A leaked slot would make this hang forever; it must simply run.
    await expect(semaphore.run(() => Promise.resolve('next'))).resolves.toBe('next');
  });

  it('releases the slot when acquire is used directly', async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    expect(semaphore.active).toBe(1);
    release();
    expect(semaphore.active).toBe(0);
  });

  it('hands a queued waiter the slot in FIFO order', async () => {
    const semaphore = new Semaphore(1);
    const order: number[] = [];

    const first = semaphore.run(async () => {
      order.push(1);
      await Promise.resolve();
    });
    const second = semaphore.run(() => {
      order.push(2);
      return Promise.resolve();
    });
    const third = semaphore.run(() => {
      order.push(3);
      return Promise.resolve();
    });

    await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects a non-positive limit', () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-08-04T12:00:00Z');

  it('reads a delay in seconds', () => {
    expect(parseRetryAfter('5', now)).toBe(5000);
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter('  30  ', now)).toBe(30_000);
  });

  it('reads an HTTP date', () => {
    expect(parseRetryAfter('Tue, 04 Aug 2026 12:00:10 GMT', now)).toBe(10_000);
  });

  it('clamps a date already in the past to zero', () => {
    expect(parseRetryAfter('Tue, 04 Aug 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('returns undefined for garbage rather than NaN', () => {
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('', now)).toBeUndefined();
    expect(parseRetryAfter('12 parsecs', now)).toBeUndefined();
    expect(parseRetryAfter('{}', now)).toBeUndefined();
  });

  it('never yields a negative or NaN delay, whatever the header says', () => {
    // `Date.parse` accepts some surprising strings — '-1' among them — so the
    // guarantee that matters is the clamp, not the rejection.
    for (const header of ['-1', '99999999999999999999', 'soon', '1e3', '0.5', 'Mon']) {
      const parsed = parseRetryAfter(header, now);
      if (parsed !== undefined) {
        expect(Number.isNaN(parsed), `parseRetryAfter(${header}) returned NaN`).toBe(false);
        expect(
          parsed,
          `parseRetryAfter(${header}) returned a negative delay`,
        ).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('returns undefined when the header is absent', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe('backoffDelayMs', () => {
  it('stays within the exponential ceiling for the attempt', () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ceiling = Math.min(20_000, 500 * 2 ** attempt);
      for (let sample = 0; sample < 50; sample += 1) {
        const delay = backoffDelayMs(attempt);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(Math.max(1, ceiling));
      }
    }
  });

  it('is jittered rather than fixed, so parallel callers do not retry in lockstep', () => {
    const samples = new Set(Array.from({ length: 100 }, () => backoffDelayMs(4)));
    expect(samples.size).toBeGreaterThan(1);
  });

  it('honours an explicit cap', () => {
    for (let sample = 0; sample < 50; sample += 1) {
      expect(backoffDelayMs(10, 500, 1000)).toBeLessThan(1000);
    }
  });
});
