import { createRemoteJWKSet, jwtVerify, SignJWT, JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { ForbiddenError, UnauthorizedError } from './errors';

export const Role = z.enum(['owner', 'manager', 'cashier', 'captain', 'service']);
export type Role = z.infer<typeof Role>;

const Claims = z.object({
  sub: z.string().min(1),
  tid: z.string().uuid(),
  /** Outlet ids the user may act on, or ["*"] for every outlet in the tenant. */
  outlets: z.array(z.string()).min(1),
  roles: z.array(Role).min(1),
});

export interface Principal {
  userId: string;
  tenantId: string;
  outletIds: string[] | '*';
  roles: Role[];
  /** Raw bearer token, forwarded on service-to-service calls (token relay). */
  token: string;
}

export interface JwtVerifierOptions {
  mode: 'hs256' | 'jwks';
  secret?: string;
  jwksUrl?: string;
  issuer: string;
  audience: string;
}

/**
 * Verifies access tokens. Production: RS256 tokens from Keycloak, keys fetched
 * (and cached/rotated) from its JWKS endpoint. Dev/test: HS256 shared secret.
 * Algorithms are pinned, so "alg: none" and algorithm-confusion attacks fail.
 */
export class JwtVerifier {
  private readonly key: Uint8Array | JWTVerifyGetKey;
  private readonly algorithms: string[];

  constructor(private readonly opts: JwtVerifierOptions) {
    if (opts.mode === 'jwks') {
      if (!opts.jwksUrl) throw new Error('jwksUrl required');
      this.key = createRemoteJWKSet(new URL(opts.jwksUrl), { cooldownDuration: 30_000, timeoutDuration: 3_000 });
      this.algorithms = ['RS256', 'ES256'];
    } else {
      if (!opts.secret || opts.secret.length < 32) throw new Error('JWT secret must be at least 32 characters');
      this.key = new TextEncoder().encode(opts.secret);
      this.algorithms = ['HS256'];
    }
  }

  async verify(token: string): Promise<Principal> {
    let payload: unknown;
    try {
      const res = await jwtVerify(token, this.key as Uint8Array, {
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        algorithms: this.algorithms,
        clockTolerance: 30,
        requiredClaims: ['exp', 'sub'],
      });
      payload = res.payload;
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }
    const claims = Claims.safeParse(payload);
    if (!claims.success) throw new UnauthorizedError('Token is missing required claims');
    const c = claims.data;
    return {
      userId: c.sub,
      tenantId: c.tid,
      outletIds: c.outlets.includes('*') ? '*' : c.outlets,
      roles: c.roles,
      token,
    };
  }
}

export function assertOutletAccess(p: Principal, outletId: string): void {
  if (p.outletIds !== '*' && !p.outletIds.includes(outletId)) throw new ForbiddenError('No access to this outlet');
}

export function assertRole(p: Principal, ...allowed: Role[]): void {
  if (!p.roles.some((r) => allowed.includes(r))) throw new ForbiddenError(`Requires role: ${allowed.join(' or ')}`);
}

/** Dev/test only: mints HS256 tokens. Refuses to run in production. */
export async function signDevToken(
  secret: string,
  claims: { sub: string; tid: string; outlets: string[]; roles: Role[] },
  opts: { issuer: string; audience: string; expiresIn?: string },
): Promise<string> {
  if (process.env.NODE_ENV === 'production') throw new Error('signDevToken is disabled in production');
  return new SignJWT({ tid: claims.tid, outlets: claims.outlets, roles: claims.roles })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(new TextEncoder().encode(secret));
}
