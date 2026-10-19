import {
  ArgumentsHost,
  CanActivate,
  Catch,
  createParamDecorator,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  INestApplication,
  Injectable,
  LoggerService,
  PipeTransform,
  SetMetadata,
  Inject,
} from '@nestjs/common';
import { Reflector, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import helmet from 'helmet';
import { ZodTypeAny, z } from 'zod';
import { JwtVerifier, Principal, Role } from './auth';
import { AppError, ForbiddenError, UnauthorizedError, ValidationError } from './errors';
import type { Logger } from './logger';

export const JWT_VERIFIER = Symbol('JWT_VERIFIER');
export const LOGGER = Symbol('LOGGER');
const IS_PUBLIC = 'ros:isPublic';
const ROLES = 'ros:roles';

/** Marks a route as not needing a user token (health checks, signed webhooks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const p = ctx.switchToHttp().getRequest<{ principal?: Principal }>().principal;
  if (!p) throw new UnauthorizedError();
  return p;
});

/** Global guard: every route requires a valid token unless marked @Public(). Deny by default. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(JWT_VERIFIER) private readonly verifier: JwtVerifier,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; principal?: Principal }>();
    const header = req.headers.authorization ?? '';
    const match = /^Bearer ([A-Za-z0-9\-_.]+)$/.exec(header);
    if (!match) throw new UnauthorizedError();
    req.principal = await this.verifier.verify(match[1]!);
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (roles && !req.principal.roles.some((r) => roles.includes(r))) {
      throw new ForbiddenError(`Requires role: ${roles.join(' or ')}`);
    }
    return true;
  }
}

/** Validates and strips unknown fields from request input with a zod schema. */
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}
  transform(value: unknown): z.infer<S> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new ValidationError(
        'Request validation failed',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return parsed.data;
  }
}

/**
 * One place that turns every error into a safe HTTP response. Known errors
 * keep their code/message; unknown errors are logged with a request id and
 * the client only sees "Internal error" plus that id. The process keeps running.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly log: Logger) {}

  catch(err: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<{ status(n: number): { json(b: unknown): void }; headersSent?: boolean }>();
    const req = ctx.getRequest<{ requestId?: string; method?: string; url?: string }>();
    if (res.headersSent) return;
    const requestId = req.requestId;

    if (err instanceof AppError) {
      if (err.httpStatus >= 500) this.log.warn({ err, requestId }, err.message);
      res.status(err.httpStatus).json({ error: { code: err.code, message: err.message, details: err.details, requestId } });
      return;
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const code = status === 429 ? 'RATE_LIMITED' : status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR';
      res.status(status).json({ error: { code, message: err.message, requestId } });
      return;
    }
    // body-parser errors (malformed JSON, payload too large) carry a 4xx `status`
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: { code: 'BAD_REQUEST', message: 'Malformed request', requestId } });
      return;
    }
    this.log.error({ err, requestId, method: req.method, url: req.url }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error', requestId } });
  }
}

class PinoNestLogger implements LoggerService {
  constructor(private readonly pino: Logger) {}
  log(message: unknown, context?: string) {
    this.pino.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string) {
    this.pino.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string) {
    this.pino.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string) {
    this.pino.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    this.pino.trace({ context }, String(message));
  }
}

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Creates a hardened Nest HTTP app: security headers, body limits, request ids, safe errors. */
export async function createHttpApp(
  module: unknown,
  opts: { log: Logger; corsOrigins: string[] | ((origin: string) => boolean); bodyLimit?: string },
): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(module as never, {
    rawBody: true, // webhook signatures are computed over the exact raw bytes
    bodyParser: false,
    logger: new PinoNestLogger(opts.log),
  });
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind the gateway/ingress, for correct client IPs in rate limiting
  app.use(helmet());
  app.useBodyParser('json', { limit: opts.bodyLimit ?? '100kb' });
  const allowed = opts.corsOrigins;
  app.enableCors({
    origin: typeof allowed === 'function' ? (o, cb) => cb(null, !!o && allowed(o)) : allowed.length ? allowed : false,
    credentials: false,
  });
  app.use((req: { headers: Record<string, string>; requestId?: string; method: string; originalUrl: string }, res: { setHeader(k: string, v: string): void; on(e: string, f: () => void): void; statusCode: number }, next: () => void) => {
    const incoming = req.headers['x-request-id'];
    req.requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      opts.log.info({ requestId: req.requestId, method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Math.round(ms) }, 'request');
    });
    next();
  });
  app.useGlobalFilters(new AllExceptionsFilter(opts.log));
  return app;
}

/**
 * Process-level crash policy. On SIGTERM (Kubernetes rollout) we stop taking
 * traffic, finish in-flight work and close pools. On an unhandled error we do
 * NOT limp on in an unknown state: we log it, shut down cleanly and exit with
 * code 1, and Kubernetes starts a fresh replica while the others keep serving.
 */
export function installProcessGuards(log: Logger, shutdown: () => Promise<void>, graceMs = 15_000): void {
  let stopping = false;
  const stop = (reason: string, code: number, err?: unknown) => {
    if (stopping) return;
    stopping = true;
    if (err) log.fatal({ err, reason }, 'fatal error; shutting down');
    else log.info({ reason }, 'shutting down');
    setTimeout(() => process.exit(code), graceMs).unref();
    shutdown()
      .catch((e) => log.error({ err: e }, 'error during shutdown'))
      .finally(() => process.exit(code));
  };
  process.on('SIGTERM', () => stop('SIGTERM', 0));
  process.on('SIGINT', () => stop('SIGINT', 0));
  process.on('unhandledRejection', (err) => stop('unhandledRejection', 1, err));
  process.on('uncaughtException', (err) => stop('uncaughtException', 1, err));
}
