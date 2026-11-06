import { randomBytes } from 'node:crypto';
import { loadConfig } from '../../src/config.js';
import { buildContext } from '../../src/index.js';
import { createLogger } from '../../src/logger.js';
import { startTestDatabase } from './testDatabase.js';

export const PASSWORD = 'correct-horse-battery-staple';

export const testEnv = (databaseUrl, extra = {}) => ({
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  JWT_SECRET: randomBytes(48).toString('base64'),
  REQUIRE_EMAIL_VERIFICATION: 'false',
  RATE_LIMIT_GENERAL_PER_MIN: '100000',
  RATE_LIMIT_AUTH_PER_MIN: '100000',
  DELIVERY_LEAD_DAYS: '2',
  SHIPPING_FLAT_CENTS: '499',
  FREE_SHIPPING_THRESHOLD_CENTS: '5000',
  TAX_RATE_BPS: '0',
  LOG_LEVEL: 'silent',
  ...extra,
});

/** Boots the real app (real PostgreSQL, mock card processor) on an ephemeral loopback port. */
export async function startHarness({ envExtra = {}, provider, db } = {}) {
  const own = db ? null : await startTestDatabase();
  const database = db ?? own;
  const config = loadConfig(testEnv(database.databaseUrl, envExtra));
  const ctx = buildContext(config, createLogger('silent'), { provider });
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let counter = 0;

  async function api(method, path, { token, body, headers = {}, raw } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }

  /** Registers + logs in a fresh user. Returns identifiers and a bearer token. */
  async function newUser(label = 'user') {
    const email = `${label}-${Date.now()}-${++counter}@example.com`;
    const reg = await api('POST', '/api/auth/register', {
      body: { email, password: PASSWORD, first_name: 'Test', last_name: 'User' },
    });
    if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
    const login = await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
    const { rows } = await ctx.pool.query('SELECT id FROM users WHERE email = $1', [email]);
    return { email, publicId: reg.body.id, id: rows[0].id, token: login.body.access_token };
  }

  const sku = async (code) => (await ctx.pool.query('SELECT id FROM products WHERE sku = $1', [code])).rows[0].id;
  const idemKey = () => `test-${randomBytes(12).toString('hex')}`;
  const pool = ctx.pool;

  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await ctx.pool.end();
    if (own) await own.stop();
  }

  return { api, newUser, sku, idemKey, pool, config, stop, services: ctx.services, base };
}
