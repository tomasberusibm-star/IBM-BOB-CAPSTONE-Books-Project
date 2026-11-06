import { ZodError } from 'zod';

/** An expected, client-visible failure. Messages must be safe to show to end users. */
export class AppError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code stable machine-readable code
   * @param {string} message safe human-readable message
   * @param {{field: string, issue: string}[]} [details] field-level problems
   * @param {Record<string, string>} [headers] extra response headers
   */
  constructor(status, code, message, details, headers) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export const notFound = () => new AppError(404, 'NOT_FOUND', 'The requested resource was not found.');
export const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
export const forbidden = () => new AppError(403, 'FORBIDDEN', 'You do not have access to this resource.');
export const basketEmpty = () => new AppError(409, 'BASKET_EMPTY', 'The basket is empty.');
export const providerError = () =>
  new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment could not be processed. Please try again.');

export function notFoundHandler(_req, _res, next) {
  next(notFound());
}

/** Express error middleware. Logs details server-side; returns only generic, safe bodies. */
export function errorHandler(logger) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);

    let status = 500;
    let body = { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' };

    if (err instanceof AppError) {
      status = err.status;
      body = { code: err.code, message: err.message };
      if (err.details) body.details = err.details;
      for (const [k, v] of Object.entries(err.headers ?? {})) res.setHeader(k, v);
    } else if (err instanceof ZodError) {
      status = 400;
      body = {
        code: 'VALIDATION_FAILED',
        message: 'The request is invalid.',
        details: err.issues.map((i) => ({ field: i.path.join('.') || '(body)', issue: i.message })),
      };
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      body = { code: 'INVALID_JSON', message: 'The request body is not valid JSON.' };
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      body = { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' };
    } else if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
      status = err.status;
      body = { code: 'BAD_REQUEST', message: 'The request could not be processed.' };
    } else {
      logger.error({ err, request_id: req.id }, 'unhandled error');
    }

    if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(status).json({ ...body, request_id: req.id });
  };
}
