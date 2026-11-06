import { rateLimit } from 'express-rate-limit';
import { AppError, forbidden, unauthenticated } from './errors.js';

/** Wraps an async handler so rejections reach the Express error middleware. */
export const wrap = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/** Requires `Authorization: Bearer <token>` backed by a live session. Sets req.user and req.sessionId. */
export function requireAuth(auth) {
  return wrap(async (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(header);
    if (!m) throw unauthenticated();
    const session = await auth.authenticate(m[1]);
    if (!session) throw unauthenticated();
    req.user = { id: session.userId, publicId: session.publicId };
    req.sessionId = session.sessionId;
    next();
  });
}

/** Only the owner of /api/users/:id may proceed. */
export function requireSelf(req, _res, next) {
  if (req.params.id.toLowerCase() !== req.user.publicId) return next(forbidden());
  next();
}

/** Per-IP limiter returning the API's standard error body and Retry-After. */
export function limiter(limit) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      const seconds = Math.max(1, Math.ceil((req.rateLimit?.resetTime?.getTime() - Date.now()) / 1000) || 60);
      res.setHeader('Retry-After', String(seconds));
      res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.', request_id: req.id });
    },
  });
}

/** Requires JSON bodies on write requests that have one. */
export function requireJson(req, _res, next) {
  const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  if (hasBody && !req.is('application/json')) {
    return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.'));
  }
  next();
}
