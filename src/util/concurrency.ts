import { CancelledError } from './errors.js';

/** Counting semaphore with abortable acquisition. Limits can be changed at runtime. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void; reject: (e: unknown) => void; signal?: AbortSignal; onAbort?: () => void }> = [];

  constructor(private limit: number) {}

  get inUse(): number {
    return this.active;
  }

  get pending(): number {
    return this.waiters.length;
  }

  setLimit(n: number): void {
    this.limit = Math.max(1, n);
    this.drain();
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new CancelledError();
    if (this.active < this.limit) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const w: (typeof this.waiters)[number] = { resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new CancelledError());
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.waiters.push(w);
    });
    return this.releaser();
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length) {
      const w = this.waiters.shift()!;
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      this.active++;
      w.resolve();
    }
  }
}

/** Map with bounded concurrency, preserving order. Stops scheduling after first error. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed: unknown;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (failed === undefined) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        if (failed === undefined) failed = err;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failed !== undefined) throw failed;
  return results;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}
