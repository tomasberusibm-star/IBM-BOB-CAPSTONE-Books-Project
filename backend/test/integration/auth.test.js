import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PASSWORD, startHarness } from '../helpers/harness.js';

let h;
before(async () => {
  h = await startHarness({ envExtra: { LOGIN_MAX_FAILURES: '3', LOGIN_LOCK_MINUTES: '15' } });
});
after(() => h.stop());

describe('registration', () => {
  it('creates an active account (dev mode) and never returns credentials', async () => {
    const email = `reg-${Date.now()}@example.com`;
    const res = await h.api('POST', '/api/auth/register', {
      body: { email: email.toUpperCase(), password: PASSWORD, first_name: 'Ann', last_name: 'Lee' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.email, email); // normalised to lower case
    assert.equal(res.body.status, 'active');
    assert.ok(!JSON.stringify(res.body).includes('password'));

    const { rows } = await h.pool.query(
      'SELECT password_hash FROM user_credentials c JOIN users u ON u.id = c.user_id WHERE u.email = $1',
      [email],
    );
    assert.match(rows[0].password_hash, /^\$argon2id\$/);
    assert.ok(!rows[0].password_hash.includes(PASSWORD));
  });

  it('rejects duplicate e-mail (case-insensitive) with 409', async () => {
    const u = await h.newUser('dup');
    const res = await h.api('POST', '/api/auth/register', {
      body: { email: u.email.toUpperCase(), password: PASSWORD, first_name: 'A', last_name: 'B' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'EMAIL_ALREADY_REGISTERED');
  });

  it('validates input: weak password, bad e-mail, unknown fields', async () => {
    const mk = (over) => ({ email: 'v@example.com', password: PASSWORD, first_name: 'A', last_name: 'B', ...over });
    for (const body of [mk({ password: 'short' }), mk({ email: 'not-an-email' }), mk({ role: 'admin' })]) {
      const res = await h.api('POST', '/api/auth/register', { body });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'VALIDATION_FAILED');
      assert.ok(res.body.request_id);
    }
  });

  it('rejects malformed JSON and wrong content type', async () => {
    const bad = await h.api('POST', '/api/auth/login', { raw: '{oops', headers: { 'Content-Type': 'application/json' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_JSON');
    const wrong = await h.api('POST', '/api/auth/login', { raw: 'a=b', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(wrong.status, 415);
  });

  it('keeps accounts inactive when e-mail verification is required', async () => {
    const strict = await startHarness({ db: { databaseUrl: h.config.databaseUrl }, envExtra: { REQUIRE_EMAIL_VERIFICATION: 'true' } });
    try {
      const email = `pending-${Date.now()}@example.com`;
      const reg = await strict.api('POST', '/api/auth/register', {
        body: { email, password: PASSWORD, first_name: 'P', last_name: 'Q' },
      });
      assert.equal(reg.body.status, 'pending_verification');
      const login = await strict.api('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
      assert.equal(login.status, 401);
    } finally {
      await strict.stop();
    }
  });
});

describe('login and sessions', () => {
  it('returns a bearer token and creates a session row', async () => {
    const u = await h.newUser('login');
    const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1', [u.id]);
    assert.equal(rows[0].n, 1);
    const res = await h.api('POST', '/api/auth/login', { body: { email: u.email, password: PASSWORD } });
    assert.equal(res.status, 200);
    assert.equal(res.body.token_type, 'Bearer');
    assert.equal(res.body.expires_in, 900);
    assert.equal(res.body.user.id, u.publicId);
  });

  it('gives the same 401 for unknown e-mail and wrong password', async () => {
    const u = await h.newUser('same');
    const a = await h.api('POST', '/api/auth/login', { body: { email: u.email, password: 'wrong-password-123' } });
    const b = await h.api('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'wrong-password-123' } });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.body.code, 'INVALID_CREDENTIALS');
    assert.equal(a.body.message, b.body.message);
  });

  it('locks the account after repeated failures, even for the correct password', async () => {
    const u = await h.newUser('lock');
    for (let i = 0; i < 3; i++) {
      await h.api('POST', '/api/auth/login', { body: { email: u.email, password: 'wrong-password-123' } });
    }
    const res = await h.api('POST', '/api/auth/login', { body: { email: u.email, password: PASSWORD } });
    assert.equal(res.status, 401);
    const { rows } = await h.pool.query(
      'SELECT failed_login_count, locked_until > now() AS locked FROM user_credentials WHERE user_id = $1',
      [u.id],
    );
    assert.equal(rows[0].locked, true);

    // after the lock expires a correct login works and resets the counter
    await h.pool.query("UPDATE user_credentials SET locked_until = now() - interval '1 minute' WHERE user_id = $1", [u.id]);
    const ok = await h.api('POST', '/api/auth/login', { body: { email: u.email, password: PASSWORD } });
    assert.equal(ok.status, 200);
    const after = await h.pool.query('SELECT failed_login_count, locked_until FROM user_credentials WHERE user_id = $1', [u.id]);
    assert.equal(after.rows[0].failed_login_count, 0);
    assert.equal(after.rows[0].locked_until, null);
  });

  it('audits attempts without storing passwords', async () => {
    const u = await h.newUser('audit');
    await h.api('POST', '/api/auth/login', { body: { email: u.email, password: 'wrong-password-123' } });
    const { rows } = await h.pool.query('SELECT succeeded FROM login_attempts WHERE email = $1 ORDER BY id', [u.email]);
    assert.deepEqual(rows.map((r) => r.succeeded), [true, false]);
  });

  it('protects endpoints: missing, malformed, forged and revoked tokens are all 401', async () => {
    const u = await h.newUser('tok');
    assert.equal((await h.api('GET', '/api/recommendations')).status, 401);
    assert.equal((await h.api('GET', '/api/recommendations', { token: 'not.a.jwt-but-long-enough-string' })).status, 401);

    const [head, , sig] = u.token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: u.publicId, sid: 'x' })).toString('base64url');
    assert.equal((await h.api('GET', '/api/recommendations', { token: `${head}.${forgedPayload}.${sig}` })).status, 401);

    assert.equal((await h.api('GET', '/api/recommendations', { token: u.token })).status, 200);
    assert.equal((await h.api('POST', '/api/auth/logout', { token: u.token })).status, 204);
    const after = await h.api('GET', '/api/recommendations', { token: u.token });
    assert.equal(after.status, 401); // logout takes effect immediately
    assert.equal(after.headers.get('www-authenticate'), 'Bearer');
  });

  it('rejects tokens of suspended users immediately', async () => {
    const u = await h.newUser('susp');
    await h.pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [u.id]);
    assert.equal((await h.api('GET', '/api/recommendations', { token: u.token })).status, 401);
  });

  it('rejects expired sessions', async () => {
    const u = await h.newUser('exp');
    await h.pool.query(
      "UPDATE user_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE user_id = $1",
      [u.id],
    );
    assert.equal((await h.api('GET', '/api/recommendations', { token: u.token })).status, 401);
  });

  it('only lets users read their own order history', async () => {
    const a = await h.newUser('ownA');
    const b = await h.newUser('ownB');
    assert.equal((await h.api('GET', `/api/users/${a.publicId}/orders`, { token: a.token })).status, 200);
    const other = await h.api('GET', `/api/users/${b.publicId}/orders`, { token: a.token });
    assert.equal(other.status, 403);
    const malformed = await h.api('GET', '/api/users/not-a-uuid/orders', { token: a.token });
    assert.equal(malformed.status, 400);
  });
});

describe('security headers and error hygiene', () => {
  it('sets hardening headers and hides the framework', async () => {
    const res = await h.api('GET', '/api/categories');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(res.headers.get('x-request-id'));
  });

  it('returns generic JSON 404s without internals', async () => {
    const res = await h.api('GET', '/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'NOT_FOUND');
    assert.ok(!JSON.stringify(res.body).includes('at '));
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After once the auth limit is exceeded', async () => {
    const limited = await startHarness({ db: { databaseUrl: h.config.databaseUrl }, envExtra: { RATE_LIMIT_AUTH_PER_MIN: '3' } });
    try {
      const statuses = [];
      let last;
      for (let i = 0; i < 5; i++) {
        last = await limited.api('POST', '/api/auth/login', { body: { email: 'x@example.com', password: 'whatever-password' } });
        statuses.push(last.status);
      }
      assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
      assert.equal(last.status, 429);
      assert.equal(last.body.code, 'RATE_LIMITED');
      assert.ok(Number(last.headers.get('retry-after')) >= 1);
    } finally {
      await limited.stop();
    }
  });
});
