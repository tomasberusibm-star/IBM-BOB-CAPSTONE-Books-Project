// Starts the whole app for a live demo: throwaway PostgreSQL + API (mock payments) + web UI,
// all on 127.0.0.1, with a demo customer who already has two past orders and some gift points.
//   npm run demo          (Ctrl-C to stop; everything is deleted on exit)
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { startStack } from '../support/stack.js';

const stack = await startStack({ frontend: true });
const password = `demo-${randomBytes(6).toString('hex')}-pass`; // random per run, printed below
const email = 'demo@example.com';
const pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });

const call = async (method, path, { token, body, key } = {}) => {
  const res = await fetch(stack.apiUrl + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
};

async function shutdown() {
  await pool.end().catch(() => {});
  await stack.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await call('POST', '/api/auth/register', { body: { email, password, first_name: 'Demo', last_name: 'Reader' } });
  const { access_token: token } = await call('POST', '/api/auth/login', { body: { email, password } });
  const { items } = await call('GET', '/api/products?page_size=100');
  const id = (sku) => items.find((p) => p.sku === sku).id;
  const address = { recipient_name: 'Demo Reader', line1: '1 Library Lane', city: 'Springfield', region: 'IL', postal_code: '62701', country_code: 'US', save_to_address_book: true };

  const buy = async (lines) => {
    for (const [sku, quantity] of lines) await call('POST', '/api/basket/items', { token, body: { product_id: id(sku), quantity } });
    await call('POST', '/api/checkout/address', { token, body: { address } });
    const { order } = await call('POST', '/api/checkout/payment', {
      token,
      key: `demo-${randomBytes(8).toString('hex')}`,
      body: { card: { payment_token: 'tok_visa_4242', card_type: 'credit' } },
    });
    return order;
  };

  const older = await buy([['BK-DUNE-001', 1], ['BK-NEURO-001', 1]]);
  await pool.query("UPDATE orders SET placed_at = now() - interval '3 days' WHERE order_number = $1", [older.order_number]); // outside the 48 h window
  await buy([['BK-CLEANCODE-001', 1]]); // recent: can still be cancelled
  await pool.query(
    `INSERT INTO gift_points_ledger (user_id, entry_type, points, note)
     SELECT id, 'earn', 1500, 'demo grant' FROM users WHERE email = $1`,
    [email],
  );

  console.log(`
  Bookshelf demo is running (local only, mock payments - no real card is used)

    Open:      ${stack.appUrl}
    Sign in:   ${email}
    Password:  ${password}

  Try:  browse /books and filter by category  ->  open a book and its related titles
        add to basket -> address -> use gift points (1,500 available) -> pay with a test card
        My orders: "Buy In Again", and cancel the recent order (the 3-day-old one is past 48 h)
  Test cards: Visa 4242 / Mastercard 0005 (approved), Visa 0002 (declined)

  Press Ctrl-C to stop; the demo database is deleted on exit.
`);
} catch (err) {
  console.error('Demo setup failed:', err.message);
  await shutdown();
}
