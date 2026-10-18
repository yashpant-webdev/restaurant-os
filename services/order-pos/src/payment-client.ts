import { Logger, ResilientHttpClient, signDevToken, UpstreamError } from '@ros/common';
import type { PaymentMethod } from '@ros/contracts';

/** Supplies a short-lived token the order service uses to call other services for a tenant. */
export interface ServiceTokenProvider {
  tokenFor(tenantId: string): Promise<string>;
}

/** Dev/test: signs HS256 service tokens with the shared secret (refuses to run in production). */
export class DevServiceTokenProvider implements ServiceTokenProvider {
  private readonly cache = new Map<string, { token: string; exp: number }>();
  constructor(private readonly cfg: { secret: string; issuer: string; audience: string }) {}

  async tokenFor(tenantId: string): Promise<string> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.exp > Date.now() + 60_000) return hit.token;
    const token = await signDevToken(
      this.cfg.secret,
      { sub: 'svc:order-pos', tid: tenantId, outlets: ['*'], roles: ['service'] },
      { issuer: this.cfg.issuer, audience: this.cfg.audience, expiresIn: '10m' },
    );
    this.cache.set(tenantId, { token, exp: Date.now() + 10 * 60_000 });
    return token;
  }
}

export interface RemotePayment {
  id: string;
  status: 'PENDING' | 'CAPTURED' | 'FAILED' | 'CANCELLED';
  amountPaise: number;
  checkout: unknown;
}

export class PaymentRejected extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`payment service rejected request (${status})`);
  }
}

/**
 * Client for the payment service. Creating a payment is retried safely because
 * the payment id is generated here and the payment service deduplicates by it.
 */
export class PaymentClient {
  private readonly http: ResilientHttpClient;

  constructor(baseUrl: string, private readonly tokens: ServiceTokenProvider, log: Logger) {
    this.http = new ResilientHttpClient(baseUrl, log, { name: 'payment-service', timeoutMs: 5_000, retries: 3 });
  }

  async create(tenantId: string, input: { id: string; orderId: string; outletId: string; method: PaymentMethod; amountPaise: number }): Promise<RemotePayment> {
    const res = await this.http.request<RemotePayment>('POST', '/payments', {
      idempotent: true,
      body: input,
      headers: { authorization: `Bearer ${await this.tokens.tokenFor(tenantId)}` },
    });
    if (res.status >= 400) throw new PaymentRejected(res.status, res.body);
    return res.body;
  }

  async cancel(tenantId: string, paymentId: string): Promise<RemotePayment> {
    const res = await this.http.request<RemotePayment>('POST', `/payments/${paymentId}/cancel`, {
      idempotent: true,
      headers: { authorization: `Bearer ${await this.tokens.tokenFor(tenantId)}` },
    });
    if (res.status >= 400) throw new PaymentRejected(res.status, res.body);
    return res.body;
  }

  async get(tenantId: string, paymentId: string): Promise<RemotePayment | undefined> {
    const res = await this.http.request<RemotePayment>('GET', `/payments/${paymentId}`, {
      idempotent: true,
      headers: { authorization: `Bearer ${await this.tokens.tokenFor(tenantId)}` },
    });
    if (res.status === 404) return undefined;
    if (res.status >= 400) throw new UpstreamError(`payment lookup failed (${res.status})`);
    return res.body;
  }
}
