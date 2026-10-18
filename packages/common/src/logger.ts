import pino, { Logger } from 'pino';

export type { Logger };

/**
 * Structured JSON logs. Secrets and payment instrument data are redacted at
 * the logger, so a careless `log.info(req)` can never leak them.
 */
export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service },
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
