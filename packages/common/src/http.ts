import { sleep } from './db';
import { UpstreamError } from './errors';
import type { Logger } from './logger';

/**
 * Circuit breaker: after `threshold` consecutive failures the circuit opens
 * and calls fail immediately for `cooldownMs`, instead of piling up threads
 * waiting on a dead dependency. Then one trial call is let through.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;

  constructor(
    readonly name: string,
    private readonly threshold = 5,
    private readonly cooldownMs = 10_000,
  ) {}

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.failures < this.threshold) return 'closed';
    return Date.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open';
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === 'open' || (state === 'half-open' && this.trialInFlight)) {
      throw new UpstreamError(`${this.name} is unavailable (circuit open)`);
    }
    const isTrial = state === 'half-open';
    if (isTrial) this.trialInFlight = true;
    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (err) {
      if (!(err instanceof NonRetryableHttpError)) {
        this.failures++;
        if (this.failures >= this.threshold) this.openedAt = Date.now();
      }
      throw err;
    } finally {
      if (isTrial) this.trialInFlight = false;
    }
  }
}

/** A 4xx response: the request itself is wrong, so retrying won't help and it doesn't trip the breaker. */
export class NonRetryableHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`HTTP ${status}`);
  }
}

export interface HttpResponse<T = unknown> {
  status: number;
  body: T;
}

/**
 * Outbound HTTP with the safety rails every network call needs:
 * timeout per attempt, retry with exponential backoff + jitter (only for
 * requests that are idempotent), Retry-After support and a circuit breaker.
 */
export class ResilientHttpClient {
  readonly breaker: CircuitBreaker;

  constructor(
    private readonly baseUrl: string,
    private readonly log: Logger,
    private readonly opts: { name: string; timeoutMs?: number; retries?: number; defaultHeaders?: Record<string, string> },
  ) {
    this.breaker = new CircuitBreaker(opts.name);
  }

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    init: { body?: unknown; headers?: Record<string, string>; idempotent: boolean },
  ): Promise<HttpResponse<T>> {
    const retries = init.idempotent ? (this.opts.retries ?? 3) : 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.breaker.exec(() => this.once<T>(method, path, init));
      } catch (err) {
        if (err instanceof NonRetryableHttpError) return { status: err.status, body: err.body as T };
        const retryable = !(err instanceof UpstreamError) || err.retryable;
        if (!retryable || attempt >= retries || this.breaker.state === 'open') {
          if (err instanceof UpstreamError) throw err;
          throw new UpstreamError(`${this.opts.name} request failed: ${(err as Error).message}`);
        }
        const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
        const delay = retryAfterMs ?? Math.min(200 * 2 ** attempt, 3_000) * (0.5 + Math.random());
        this.log.warn({ attempt, delay, target: this.opts.name, path }, 'retrying upstream call');
        await sleep(delay);
      }
    }
  }

  private async once<T>(method: string, path: string, init: { body?: unknown; headers?: Record<string, string> }): Promise<HttpResponse<T>> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: { 'content-type': 'application/json', ...this.opts.defaultHeaders, ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5_000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON body */
    }
    if (res.status === 429 || res.status >= 500) {
      const err = new UpstreamError(`${this.opts.name} responded ${res.status}`) as UpstreamError & { retryAfterMs?: number };
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = Math.min(ra * 1000, 10_000);
      throw err;
    }
    if (res.status >= 400) throw new NonRetryableHttpError(res.status, body);
    return { status: res.status, body: body as T };
  }
}
