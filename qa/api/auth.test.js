import { afterAll, describe, expect, it } from '@jest/globals';
import { expectContract } from '../support/contract.js';
import { PASSWORD, as, closeDb, db, http, newUser } from '../support/world.js';

afterAll(closeDb);

const registration = (over = {}) => ({
  email: `auth-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`,
  password: PASSWORD,
  first_name: 'Ada',
  last_name: 'Lovelace',
  ...over,
});

describe('AUTH-01 registration', () => {
  it('creates an active account, normalises the e-mail and never returns credentials [201]', async () => {
    const body = registration();
    const res = expectContract(await http().post('/api/auth/register').send({ ...body, email: body.email.toUpperCase() }), 'POST', '/api/auth/register');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: body.email, first_name: 'Ada', last_name: 'Lovelace', status: 'active' });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|argon/i);
    expect(res.headers.location).toBe(`/api/users/${res.body.id}/orders`);
  });

  it('stores only a salted Argon2id hash of the password', async () => {
    const body = registration();
    await http().post('/api/auth/register').send(body).expect(201);
    const { rows } = await db().query('SELECT password_hash FROM user_credentials c JOIN users u ON u.id = c.user_id WHERE u.email = $1', [body.email]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0].password_hash).not.toContain(PASSWORD);
  });

  it('refuses a duplicate e-mail regardless of letter case [409]', async () => {
    const user = await newUser('dup');
    const res = expectContract(await http().post('/api/auth/register').send(registration({ email: user.email.toUpperCase() })), 'POST', '/api/auth/register');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it.each([
    ['password shorter than 12 characters', { password: 'short' }],
    ['malformed e-mail', { email: 'not-an-email' }],
    ['empty first name', { first_name: '   ' }],
    ['unknown field (mass-assignment attempt)', { role: 'admin' }],
    ['invalid phone number', { phone: 'call-me' }],
  ])('rejects %s [400]', async (_name, override) => {
    const res = expectContract(await http().post('/api/auth/register').send(registration(override)), 'POST', '/api/auth/register');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.request_id).toEqual(expect.any(String));
  });
});

describe('AUTH-02 login', () => {
  it('returns a short-lived bearer token and the user profile [200]', async () => {
    const user = await newUser('login');
    const res = expectContract(await http().post('/api/auth/login').send({ email: user.email, password: PASSWORD }), 'POST', '/api/auth/login');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, user: { id: user.id, email: user.email } });
    expect(res.body.access_token.split('.')).toHaveLength(3);
  });

  it('accepts the e-mail in any letter case', async () => {
    const user = await newUser('case');
    await http().post('/api/auth/login').send({ email: user.email.toUpperCase(), password: PASSWORD }).expect(200);
  });

  it('answers wrong password and unknown e-mail identically, so accounts cannot be enumerated [401]', async () => {
    const user = await newUser('enum');
    const wrongPassword = expectContract(await http().post('/api/auth/login').send({ email: user.email, password: 'definitely-wrong-1' }), 'POST', '/api/auth/login');
    const unknownUser = expectContract(await http().post('/api/auth/login').send({ email: 'nobody-here@example.com', password: 'definitely-wrong-1' }), 'POST', '/api/auth/login');
    expect([wrongPassword.status, unknownUser.status]).toEqual([401, 401]);
    expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPassword.body.message).toBe(unknownUser.body.message);
    expect(wrongPassword.headers['www-authenticate']).toBe('Bearer');
  });

  it.each([
    ['missing password', { email: 'a@example.com' }],
    ['missing e-mail', { password: 'whatever-pass-1' }],
    ['malformed e-mail', { email: 'nope', password: 'whatever-pass-1' }],
    ['unknown field', { email: 'a@example.com', password: 'whatever-pass-1', remember: true }],
  ])('rejects a login body with %s [400]', async (_name, body) => {
    const res = expectContract(await http().post('/api/auth/login').send(body), 'POST', '/api/auth/login');
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON [400] and non-JSON content [415] without leaking internals', async () => {
    const bad = await http().post('/api/auth/login').set('Content-Type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_JSON');
    const wrong = await http().post('/api/auth/login').set('Content-Type', 'text/plain').send('a=b');
    expect(wrong.status).toBe(415);
    expect(JSON.stringify([bad.body, wrong.body])).not.toMatch(/SyntaxError|node_modules|\bat\s.+\(/);
  });

  it('locks the account after repeated failures, even for the correct password [401]', async () => {
    const user = await newUser('lock');
    for (let i = 0; i < 5; i++) await http().post('/api/auth/login').send({ email: user.email, password: 'wrong-password-1' });
    const res = await http().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS'); // a lock looks like any other failure
  });

  it('a suspended customer cannot sign in [401]', async () => {
    const user = await newUser('susp');
    await db().query("UPDATE users SET status = 'suspended' WHERE id = $1", [user.dbId]);
    const res = await http().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(401);
  });
});

describe('AUTH-03 protected endpoints and sessions', () => {
  const protectedEndpoints = [
    ['GET', '/api/recommendations'],
    ['GET', '/api/basket'],
    ['GET', '/api/addresses'],
    ['POST', '/api/basket/items'],
    ['POST', '/api/checkout/address'],
    ['POST', '/api/checkout/payment'],
    ['POST', '/api/orders/reorder/1'],
    ['POST', '/api/orders/cancel/1'],
    ['GET', '/api/users/00000000-0000-4000-8000-000000000000/orders'],
  ];

  it.each(protectedEndpoints)('%s %s requires a token [401]', async (method, url) => {
    const res = await http()[method.toLowerCase()](url).send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('rejects garbage, wrong-scheme and forged tokens [401]', async () => {
    const user = await newUser('forge');
    const [head, , sig] = user.token.split('.');
    const forgedClaims = Buffer.from(JSON.stringify({ sub: user.id, sid: 'forged' })).toString('base64url');
    for (const header of ['Bearer not.a.jwt-but-long-enough-string', `Bearer ${head}.${forgedClaims}.${sig}`, `Basic ${Buffer.from('a:b').toString('base64')}`, 'Bearer']) {
      const res = await http().get('/api/basket').set('Authorization', header);
      expect(res.status).toBe(401);
    }
  });

  it('logout revokes the token immediately [204 then 401]', async () => {
    const user = await newUser('logout');
    await as(user).get('/api/basket').expect(200);
    const out = expectContract(await as(user).post('/api/auth/logout'), 'POST', '/api/auth/logout');
    expect(out.status).toBe(204);
    expect((await as(user).get('/api/basket')).status).toBe(401);
  });

  it('a second login does not break the first session', async () => {
    const user = await newUser('multi');
    const second = await http().post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    await as(user).get('/api/basket').expect(200);
    await http().get('/api/basket').set('Authorization', `Bearer ${second.body.access_token}`).expect(200);
  });

  it('an expired session is refused [401]', async () => {
    const user = await newUser('expired');
    await db().query("UPDATE user_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE user_id = $1", [user.dbId]);
    expect((await as(user).get('/api/basket')).status).toBe(401);
  });

  it('customers can read only their own order history [403]', async () => {
    const alice = await newUser('own-a');
    const bob = await newUser('own-b');
    expectContract(await as(alice).get(`/api/users/${alice.id}/orders`), 'GET', '/api/users/{id}/orders');
    const res = expectContract(await as(alice).get(`/api/users/${bob.id}/orders`), 'GET', '/api/users/{id}/orders');
    expect(res.status).toBe(403);
    expect(expectContract(await as(alice).get('/api/users/not-a-uuid/orders'), 'GET', '/api/users/{id}/orders').status).toBe(400);
  });
});

describe('AUTH-04 transport and error hygiene', () => {
  it('sends hardening headers and hides the framework', async () => {
    const res = await http().get('/api/categories');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('unknown routes return a generic JSON 404', async () => {
    const res = await http().get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toMatch(/node_modules|\.js:\d+/);
  });
});
