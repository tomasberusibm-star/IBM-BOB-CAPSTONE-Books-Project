import { z } from 'zod';

const bool = (def) =>
  z
    .enum(['true', 'false'])
    .default(def)
    .transform((v) => v === 'true');

const intFrom = (def, min, max) => z.coerce.number().int().min(min).max(max).default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: intFrom(8080, 0, 65535),
  DATABASE_URL: z.string().min(1, 'is required'),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: intFrom(900, 60, 86400),
  REQUIRE_EMAIL_VERIFICATION: bool('true'),
  PAYMENT_PROVIDER: z.enum(['mock']).default('mock'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Business rules
  CURRENCY: z.string().regex(/^[A-Z]{3}$/).default('USD'),
  DELIVERY_LEAD_DAYS: intFrom(2, 0, 60),
  SHIPPING_FLAT_CENTS: intFrom(499, 0, 100000),
  FREE_SHIPPING_THRESHOLD_CENTS: intFrom(5000, 0, 100000000),
  TAX_RATE_BPS: intFrom(0, 0, 10000),

  // Abuse protection (requests per minute per client IP)
  RATE_LIMIT_GENERAL_PER_MIN: intFrom(300, 1, 100000),
  RATE_LIMIT_AUTH_PER_MIN: intFrom(10, 1, 100000),
  LOGIN_MAX_FAILURES: intFrom(5, 1, 100),
  LOGIN_LOCK_MINUTES: intFrom(15, 1, 1440),
});

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '*', '']);
const LOOPBACK_DB_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Validates the environment and returns a camelCase config object.
 * Throws a single Error listing every problem; never echoes secret values.
 */
export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration: ${problems.join('; ')}`);
  }
  const e = parsed.data;
  const problems = [];

  if (WILDCARD_HOSTS.has(e.HOST)) {
    problems.push('HOST: binding to all interfaces is not allowed; use 127.0.0.1 or a specific internal IP');
  }

  let dbUrl;
  try {
    dbUrl = new URL(e.DATABASE_URL);
  } catch {
    problems.push('DATABASE_URL: is not a valid URL');
  }

  if (e.NODE_ENV === 'production') {
    if (e.PAYMENT_PROVIDER === 'mock') problems.push('PAYMENT_PROVIDER: the mock processor is not allowed in production');
    if (!e.REQUIRE_EMAIL_VERIFICATION) problems.push('REQUIRE_EMAIL_VERIFICATION: must be true in production');
    if (dbUrl && !LOOPBACK_DB_HOSTS.has(dbUrl.hostname) && dbUrl.searchParams.get('sslmode') !== 'verify-full') {
      problems.push('DATABASE_URL: non-local databases require sslmode=verify-full');
    }
  }

  if (problems.length > 0) throw new Error(`Invalid configuration: ${problems.join('; ')}`);

  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    jwtSecret: e.JWT_SECRET,
    accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
    requireEmailVerification: e.REQUIRE_EMAIL_VERIFICATION,
    paymentProvider: e.PAYMENT_PROVIDER,
    logLevel: e.LOG_LEVEL,
    currency: e.CURRENCY,
    deliveryLeadDays: e.DELIVERY_LEAD_DAYS,
    shippingFlatCents: e.SHIPPING_FLAT_CENTS,
    freeShippingThresholdCents: e.FREE_SHIPPING_THRESHOLD_CENTS,
    taxRateBps: e.TAX_RATE_BPS,
    rateLimitGeneralPerMin: e.RATE_LIMIT_GENERAL_PER_MIN,
    rateLimitAuthPerMin: e.RATE_LIMIT_AUTH_PER_MIN,
    loginMaxFailures: e.LOGIN_MAX_FAILURES,
    loginLockMinutes: e.LOGIN_LOCK_MINUTES,
  };
}
