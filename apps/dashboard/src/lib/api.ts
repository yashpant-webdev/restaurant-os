'use client';

/**
 * Talks to the backend services. In this demo, sign-in comes from the demo server
 * (an owner token); in production this is a Keycloak login and the URLs come from config.
 */
export interface Config {
  orderUrl: string;
  paymentUrl: string;
  analyticsUrl: string;
  outletId: string;
  outletName: string;
  tokens: { owner: string; cashier: string };
}

const DEMO_URL = process.env.NEXT_PUBLIC_DEMO_URL ?? 'http://localhost:4000';
let cfg: Promise<Config> | null = null;

export function config(force = false): Promise<Config> {
  if (!cfg || force) {
    cfg = fetch(`${DEMO_URL}/demo/config`).then((r) => {
      if (!r.ok) throw new Error('Backend not reachable. Start it with: npm run demo');
      return r.json();
    });
    cfg.catch(() => (cfg = null));
  }
  return cfg;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

type Service = 'order' | 'payment' | 'analytics';

/** JSON request with the owner's token; renews the token once if it expired. */
export async function api<T = unknown>(service: Service, path: string, init: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
  const c = await config();
  const base = { order: c.orderUrl, payment: c.paymentUrl, analytics: c.analyticsUrl }[service];
  const res = await fetch(base + path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${c.tokens.owner}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401 && !retried) {
    await config(true);
    return api(service, path, init, true);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'HTTP', data?.error?.message ?? `Request failed (${res.status})`, data?.error?.details);
  return data as T;
}

export const inr = (p: number) => (p < 0 ? '−' : '') + '₹' + (Math.abs(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const inr0 = (p: number) => (p < 0 ? '−' : '') + '₹' + Math.round(Math.abs(p) / 100).toLocaleString('en-IN');
export const lakh = (p: number) => (Math.abs(p) >= 10_000_000 ? `₹${(p / 10_000_000).toFixed(2)} L` : inr0(p));
export const istDay = (offset = 0) => new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);
