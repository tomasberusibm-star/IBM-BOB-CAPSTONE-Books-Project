import { randomUUID } from 'node:crypto';
import pino from 'pino';

/** Structured JSON logger. Secrets are redacted even if they are logged by mistake. */
export function createLogger(level = 'info') {
  return pino({
    level,
    base: { service: 'bookstore-api' },
    redact: {
      paths: [
        'req.headers.authorization',
        '*.password',
        '*.password_hash',
        '*.access_token',
        '*.payment_token',
        '*.token',
        '*.jwt_secret',
      ],
      censor: '[REDACTED]',
    },
  });
}

/** Assigns a request id and writes one structured access-log line per request (no bodies, no query strings). */
export function requestContext(logger) {
  return (req, res, next) => {
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info(
        {
          request_id: req.id,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          status: res.statusCode,
          duration_ms: Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10,
          user_id: req.user?.publicId,
        },
        'request',
      );
    });
    next();
  };
}
