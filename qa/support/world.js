import { randomBytes } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';

export const PASSWORD = 'qa-correct-horse-battery';
export const VISA = { payment_token: 'tok_visa_4242', card_type: 'credit' };
export const DEBIT = { payment_token: 'tok_mc_0005', card_type: 'debit' };
export const DECLINED = { payment_token: 'tok_declined_0002', card_type: 'credit' };
export const PROVIDER_DOWN = { payment_token: 'tok_error_0000', card_type: 'credit' };
export const ADDRESS = {
  recipient_name: 'Quinn Tester',
  line1: '1 Test Street',
  city: 'Testville',
  region: 'TS',
  postal_code: '12345',
  country_code: 'US',
};

/** Supertest agent bound to the API process started by global-setup.js. */
export const http = () => request(process.env.QA_API_URL);

let pool;
/** Direct database access. Used ONLY to arrange state the public API cannot (see qa/README.md). */
export const db = () => (pool ??= new pg.Pool({ connectionString: process.env.QA_DATABASE_URL, max: 2 }));
export const closeDb = async () => {
  await pool?.end();
  pool = undefined;
};

const auth = (token) => ({ Authorization: `Bearer ${token}` });
let counter = 0;

/** Registers and logs in a brand-new customer, so every test owns its data. */
export async function newUser(label = 'qa') {
  const email = `${label}-${Date.now()}-${++counter}-${randomBytes(3).toString('hex')}@example.com`;
  const reg = await http().post('/api/auth/register').send({ email, password: PASSWORD, first_name: 'Quinn', last_name: 'Tester' });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const login = await http().post('/api/auth/login').send({ email, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  const { rows } = await db().query('SELECT id FROM users WHERE email = $1', [email]);
  return { email, id: reg.body.id, dbId: rows[0].id, token: login.body.access_token };
}

export async function productId(sku) {
  const { rows } = await db().query('SELECT id FROM products WHERE sku = $1', [sku]);
  return Number(rows[0].id);
}
export const stockOf = async (sku) => (await db().query('SELECT stock_quantity FROM products WHERE sku = $1', [sku])).rows[0].stock_quantity;
export const pointsBalance = async (user) =>
  Number((await db().query('SELECT COALESCE((SELECT balance FROM gift_point_accounts WHERE user_id = $1), 0) AS b', [user.dbId])).rows[0].b);

/** Gives a customer gift points (earning rules are out of scope for the API under test). */
export async function grantGiftPoints(user, points) {
  await db().query("INSERT INTO gift_points_ledger (user_id, entry_type, points, note) VALUES ($1, 'earn', $2, 'qa grant')", [user.dbId, points]);
}

/** Moves an order's placement time into the past, to exercise the 48-hour rule without waiting. */
export async function ageOrder(orderId, interval) {
  await db().query(`UPDATE orders SET placed_at = now() - $2::interval WHERE id = $1`, [orderId, interval]);
}

export const as = (user) => ({
  get: (url) => http().get(url).set(auth(user.token)),
  post: (url) => http().post(url).set(auth(user.token)),
  patch: (url) => http().patch(url).set(auth(user.token)),
  delete: (url) => http().delete(url).set(auth(user.token)),
});

export async function addToBasket(user, sku, quantity = 1) {
  const res = await as(user).post('/api/basket/items').send({ product_id: await productId(sku), quantity });
  if (res.status !== 200) throw new Error(`addToBasket(${sku}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function chooseAddress(user, body = { address: ADDRESS }) {
  const res = await as(user).post('/api/checkout/address').send(body);
  if (res.status !== 200) throw new Error(`chooseAddress failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export const idempotencyKey = () => `qa-${randomBytes(12).toString('hex')}`;
export const pay = (user, body, key = idempotencyKey()) => as(user).post('/api/checkout/payment').set('Idempotency-Key', key).send(body);

/** Full purchase through the public API. Returns the PaymentResult body. */
export async function placeOrder(user, lines, { card = VISA, points = 0 } = {}) {
  for (const [sku, quantity] of lines) await addToBasket(user, sku, quantity);
  await chooseAddress(user);
  const res = await pay(user, { ...(points ? { gift_points_to_redeem: points } : {}), ...(card ? { card } : {}) });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
