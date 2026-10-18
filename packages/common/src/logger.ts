import pino, { Logger } from 'pino';

export type { Logger };

/**
 * Structured JSON logs. Secrets and payment instrument data are redacted at
 * the logger, so a careless `log.info(req)` can never leak them.
 */
/**
 * Errors are logged as type, message, code and stack only. Library errors (pg,
 * kafkajs, fetch) often carry the whole client/connection object as extra
 * properties; serialising those floods the logs and can leak connection details.
 */
export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  const e = err as Error & { code?: unknown; constraint?: unknown; cause?: unknown };
  return {
    type: e.name,
    message: e.message,
    ...(typeof e.code === 'string' || typeof e.code === 'number' ? { code: e.code } : {}),
    ...(typeof e.constraint === 'string' ? { constraint: e.constraint } : {}),
    stack: e.stack,
    ...(e.cause instanceof Error ? { cause: serializeError(e.cause) } : {}),
  };
}

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service },
    serializers: { err: serializeError },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-razorpay-signature"]',
        'headers.authorization',
        '*.password',
        '*.secret',
        '*.keySecret',
        '*.webhookSecret',
        '*.token',
        '*.accessToken',
        '*.card',
        '*.cardNumber',
        '*.cvv',
        '*.vpa',
      ],
      censor: '[REDACTED]',
    },
  });
}
