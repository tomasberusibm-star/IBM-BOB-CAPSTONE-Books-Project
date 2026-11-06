import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createMockProvider } from '../../src/payments/provider.js';
import { startHarness } from '../helpers/harness.js';

let h;
let provider;
const charges = [];
const refunds = [];

before(async () => {
  provider = createMockProvider();
  const charge = provider.charge.bind(provider);
  const refund = provider.refund.bind(provider);
  provider.charge = async (a) => {
    charges.push(a);
    return charge(a);
  };
  provider.refund = async (a) => {
    refunds.push(a);
    return refund(a);
  };
  h = await startHarness({ provider });
});
after(() => h.stop());

const VISA = { payment_token: 'tok_visa_4242', card_type: 'credit' };
const stockOf = async (sku) => (await h.pool.query('SELECT stock_quantity FROM products WHERE sku = $1', [sku])).rows[0].stock_quantity;
const balance = async (u) => (await h.pool.query('SELECT COALESCE((SELECT balance FROM gift_point_accounts WHERE user_id = $1), 0) AS b', [u.id])).rows[0].b;
const count = async (table, u) => (await h.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [u.id])).rows[0].n;

async function giveGiftPoints(u, n) {
  await h.pool.query("INSERT INTO gift_points_ledger (user_id, entry_type, points, note) VALUES ($1, 'earn', $2, 'test')", [u.id, n]);
}
async function addToBasket(u, sku, quantity = 1) {
  const res = await h.api('POST', '/api/basket/items', { token: u.token, body: { product_id: await h.sku(sku), quantity } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
const ADDRESS = {
  recipient_name: 'Test User', line1: '1 Test Street', city: 'Testville', postal_code: '12345', country_code: 'US',
};
async function setAddress(u, body = { address: ADDRESS }) {
  const res = await h.api('POST', '/api/checkout/address', { token: u.token, body });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
const pay = (u, body, key = h.idemKey()) =>
  h.api('POST', '/api/checkout/payment', { token: u.token, body, headers: { 'Idempotency-Key': key } });

describe('basket', () => {
  it('adds items, merges quantities and prices lines exactly', async () => {
    const u = await h.newUser('bk1');
    await addToBasket(u, 'BK-DUNE-001', 2);
    const b = await addToBasket(u, 'BK-DUNE-001', 1);
    assert.equal(b.items.length, 1);
    assert.equal(b.items[0].quantity, 3);
    assert.equal(b.items[0].line_total, '29.97');
    assert.equal(b.subtotal_amount, '29.97');
    assert.equal(b.item_count, 3);
  });

  it('refuses more than the stock and unknown or inactive products', async () => {
    const u = await h.newUser('bk2');
    const over = await h.api('POST', '/api/basket/items', { token: u.token, body: { product_id: await h.sku('BK-PGUR-001'), quantity: 1 } });
    assert.equal(over.status, 409);
    assert.equal(over.body.code, 'INSUFFICIENT_STOCK');
    assert.equal((await h.api('POST', '/api/basket/items', { token: u.token, body: { product_id: 999999, quantity: 1 } })).status, 404);
  });

  it('validates the body', async () => {
    const u = await h.newUser('bk3');
    for (const body of [{ product_id: 1, quantity: 0 }, { product_id: 1, quantity: 1000 }, { product_id: 1, quantity: 1.5 }, { product_id: 'x', quantity: 1 }, { product_id: 1, quantity: 1, price: 0 }]) {
      assert.equal((await h.api('POST', '/api/basket/items', { token: u.token, body })).status, 400);
    }
    assert.equal((await h.api('POST', '/api/basket/items', { body: { product_id: 1, quantity: 1 } })).status, 401);
  });
});

describe('checkout address', () => {
  it('prices the basket: flat shipping below the threshold', async () => {
    const u = await h.newUser('ad1');
    await addToBasket(u, 'BK-DUNE-001', 2);
    const s = await setAddress(u);
    assert.equal(s.subtotal_amount, '19.98');
    assert.equal(s.shipping_amount, '4.99');
    assert.equal(s.total_amount, '24.97');
    assert.equal(s.gift_points_balance, 0);
    assert.equal(s.max_redeemable_points, 0);
    assert.equal(s.shipping_address.city, 'Testville');
    assert.equal(s.tentative_delivery_date, (await h.api('GET', `/api/products/${await h.sku('BK-DUNE-001')}`)).body.tentative_delivery_date);
  });

  it('free shipping at the threshold and for digital-only baskets', async () => {
    const u = await h.newUser('ad2');
    await addToBasket(u, 'BK-DDIA-EB', 1);
    assert.equal((await setAddress(u)).shipping_amount, '0.00');
    await addToBasket(u, 'BK-DDIA-001', 1); // 29.99 + 44.99 = 74.98 >= 50
    assert.equal((await setAddress(u)).shipping_amount, '0.00');
  });

  it('limits redeemable points to the balance and to the subtotal', async () => {
    const u = await h.newUser('ad3');
    await giveGiftPoints(u, 5000);
    await addToBasket(u, 'BK-DUNE-001', 1); // 9.99
    const s = await setAddress(u);
    assert.equal(s.gift_points_balance, 5000);
    assert.equal(s.max_redeemable_points, 999);
  });

  it('accepts a saved address, and rejects someone else’s', async () => {
    const a = await h.newUser('ad4a');
    const b = await h.newUser('ad4b');
    await addToBasket(a, 'BK-DUNE-001');
    const saved = (await h.pool.query(
      "INSERT INTO addresses (user_id, recipient_name, line1, city, postal_code, country_code) VALUES ($1,'A','1 St','C','1','US') RETURNING id", [a.id])).rows[0].id;
    const other = (await h.pool.query(
      "INSERT INTO addresses (user_id, recipient_name, line1, city, postal_code, country_code) VALUES ($1,'B','1 St','C','1','US') RETURNING id", [b.id])).rows[0].id;
    assert.equal((await setAddress(a, { address_id: saved })).shipping_address.id, saved);
    assert.equal((await h.api('POST', '/api/checkout/address', { token: a.token, body: { address_id: other } })).status, 404);
  });

  it('keeps one-off addresses out of the address book unless asked', async () => {
    const u = await h.newUser('ad5');
    await addToBasket(u, 'BK-DUNE-001');
    await setAddress(u);
    await setAddress(u, { address: { ...ADDRESS, save_to_address_book: true } });
    const rows = (await h.pool.query('SELECT is_saved FROM addresses WHERE user_id = $1 ORDER BY id', [u.id])).rows;
    assert.deepEqual(rows.map((r) => r.is_saved), [false, true]);
  });

  it('409s on an empty basket and 400s on invalid addresses', async () => {
    const u = await h.newUser('ad6');
    const empty = await h.api('POST', '/api/checkout/address', { token: u.token, body: { address: ADDRESS } });
    assert.equal(empty.status, 409);
    assert.equal(empty.body.code, 'BASKET_EMPTY');
    await addToBasket(u, 'BK-DUNE-001');
    for (const body of [{}, { address: { ...ADDRESS, country_code: 'usa' } }, { address_id: 1, address: ADDRESS }, { address: { ...ADDRESS, admin: true } }]) {
      assert.equal((await h.api('POST', '/api/checkout/address', { token: u.token, body })).status, 400);
    }
  });
});

describe('payment - card', () => {
  it('places a paid order, stores only card brand/last4, reduces stock, closes the basket', async () => {
    const u = await h.newUser('pc1');
    await addToBasket(u, 'BK-DUNE-001', 2);
    await setAddress(u);
    const stock = await stockOf('BK-DUNE-001');

    const res = await pay(u, { card: VISA });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { order, payment } = res.body;
    assert.equal(order.status, 'paid');
    assert.equal(order.subtotal_amount, '19.98');
    assert.equal(order.total_amount, '24.97');
    assert.equal(order.gift_points_redeemed, 0);
    assert.equal(order.items[0].quantity, 2);
    assert.equal(order.shipping_address.city, 'Testville');
    assert.equal(order.can_cancel, true);
    assert.match(order.order_number, /^BK-\d{10}$/);

    assert.deepEqual([payment.status, payment.amount, payment.card_brand, payment.card_last4, payment.card_type], ['captured', '24.97', 'visa', '4242', 'credit']);
    assert.ok(!JSON.stringify(res.body).includes('tok_visa_4242'), 'token is never echoed');

    assert.equal(await stockOf('BK-DUNE-001'), stock - 2);
    const cart = (await h.pool.query('SELECT status FROM carts WHERE user_id = $1', [u.id])).rows[0];
    assert.equal(cart.status, 'converted');
    const stored = (await h.pool.query('SELECT * FROM payments WHERE order_id = $1', [order.id])).rows[0];
    assert.ok(!Object.values(stored).some((v) => String(v).includes('tok_visa')), 'no token persisted');

    // basket is empty afterwards, a new one starts fresh
    assert.equal((await h.api('POST', '/api/checkout/address', { token: u.token, body: { address: ADDRESS } })).body.code, 'BASKET_EMPTY');
  });

  it('snapshots prices and address: later catalogue/address changes do not alter the order', async () => {
    const u = await h.newUser('pc2');
    await addToBasket(u, 'BK-NEURO-001', 1);
    const addr = await setAddress(u);
    const res = await pay(u, { card: { payment_token: 'tok_mc_debit_0005', card_type: 'debit' } });
    assert.equal(res.body.payment.card_brand, 'mastercard');
    await h.pool.query("UPDATE products SET price = 99.00 WHERE sku = 'BK-NEURO-001'");
    await h.pool.query("UPDATE addresses SET city = 'Elsewhere' WHERE id = $1", [addr.shipping_address.id]);
    const hist = await h.api('GET', `/api/users/${u.publicId}/orders`, { token: u.token });
    assert.equal(hist.body.items[0].items[0].unit_price, '8.99');
    assert.equal(hist.body.items[0].shipping_address.city, 'Testville');
    await h.pool.query("UPDATE products SET price = 8.99 WHERE sku = 'BK-NEURO-001'");
  });

  it('a declined card creates nothing: no order, no stock change, basket intact, points untouched', async () => {
    const u = await h.newUser('pc3');
    await giveGiftPoints(u, 500);
    await addToBasket(u, 'BK-DUNE-001', 1);
    await setAddress(u);
    const stock = await stockOf('BK-DUNE-001');

    const res = await pay(u, { gift_points_to_redeem: 300, card: { payment_token: 'tok_declined_0002', card_type: 'credit' } });
    assert.equal(res.status, 402);
    assert.equal(res.body.code, 'PAYMENT_DECLINED');
    assert.equal(await count('orders', u), 0);
    assert.equal(await stockOf('BK-DUNE-001'), stock);
    assert.equal(await balance(u), 500, 'points not deducted');
    assert.equal((await h.pool.query('SELECT status FROM carts WHERE user_id = $1', [u.id])).rows[0].status, 'active');
  });

  it('a provider outage returns 502 without leaking details and creates nothing', async () => {
    const u = await h.newUser('pc4');
    await addToBasket(u, 'BK-DUNE-001', 1);
    await setAddress(u);
    const res = await pay(u, { card: { payment_token: 'tok_error_0000', card_type: 'credit' } });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'PAYMENT_PROVIDER_ERROR');
    assert.ok(!JSON.stringify(res.body).includes('mock provider'));
    assert.equal(await count('orders', u), 0);
  });

  it('requires an address, a non-empty basket and a valid Idempotency-Key', async () => {
    const u = await h.newUser('pc5');
    assert.equal((await pay(u, { card: VISA })).body.code, 'BASKET_EMPTY');
    await addToBasket(u, 'BK-DUNE-001');
    assert.equal((await pay(u, { card: VISA })).body.code, 'ADDRESS_REQUIRED');
    await setAddress(u);
    const noKey = await h.api('POST', '/api/checkout/payment', { token: u.token, body: { card: VISA } });
    assert.equal(noKey.status, 400);
    const shortKey = await pay(u, { card: VISA }, 'short');
    assert.equal(shortKey.status, 400);
    assert.equal(await count('orders', u), 0);
  });

  it('rejects raw card data and malformed payment bodies', async () => {
    const u = await h.newUser('pc6');
    await addToBasket(u, 'BK-DUNE-001');
    await setAddress(u);
    const raw = await pay(u, { card: { number: '4242424242424242', cvv: '123', card_type: 'credit', payment_token: 'tok_visa_4242' } });
    assert.equal(raw.status, 400);
    for (const body of [{}, { card: { payment_token: 'tok_visa_4242', card_type: 'gold' } }, { card: { payment_token: 'bad token!', card_type: 'debit' } }, { gift_points_to_redeem: -5, card: VISA }, { gift_points_to_redeem: 1.5, card: VISA }]) {
      assert.equal((await pay(u, body)).status, 400, JSON.stringify(body));
    }
    assert.equal(await count('orders', u), 0);
  });
});

describe('payment - gift points', () => {
  it('splits payment between points and card; charges the card only for the remainder', async () => {
    const u = await h.newUser('gp1');
    await giveGiftPoints(u, 1000);
    await addToBasket(u, 'BK-DUNE-001', 2); // 19.98 + 4.99 shipping
    await setAddress(u);
    charges.length = 0;

    const res = await pay(u, { gift_points_to_redeem: 500, card: VISA });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.order.gift_points_redeemed, 500);
    assert.equal(res.body.order.discount_amount, '5.00');
    assert.equal(res.body.order.total_amount, '19.97'); // 24.97 - 5.00
    assert.equal(res.body.payment.amount, '19.97');
    assert.equal(charges.at(-1).amountCents, 1997);
    assert.equal(res.body.gift_points_redeemed, 500);
    assert.equal(res.body.gift_points_balance, 500);
    assert.equal(await balance(u), 500);
    const ledger = (await h.pool.query("SELECT points, order_id FROM gift_points_ledger WHERE user_id = $1 AND entry_type = 'redeem'", [u.id])).rows;
    assert.deepEqual(ledger, [{ points: -500, order_id: res.body.order.id }]);
  });

  it('points alone can pay when shipping and tax are zero (digital basket) - no card, no payment row', async () => {
    const u = await h.newUser('gp2');
    await giveGiftPoints(u, 4000);
    await addToBasket(u, 'BK-DDIA-EB', 1); // 29.99, digital: free shipping
    await setAddress(u);
    charges.length = 0;

    const res = await pay(u, { gift_points_to_redeem: 2999 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.order.status, 'paid');
    assert.equal(res.body.order.total_amount, '0.00');
    assert.equal(res.body.payment, null);
    assert.equal(charges.length, 0, 'the card processor is never called');
    assert.equal(await balance(u), 1001);
    const rows = (await h.pool.query('SELECT 1 FROM payments WHERE order_id = $1', [res.body.order.id])).rowCount;
    assert.equal(rows, 0, 'no payment row when no card was charged');
  });

  it('requires a card when points do not cover shipping, and refuses an unnecessary card', async () => {
    const u = await h.newUser('gp3');
    await giveGiftPoints(u, 5000);
    await addToBasket(u, 'BK-DUNE-001', 1); // 9.99 + 4.99 shipping
    await setAddress(u);
    const noCard = await pay(u, { gift_points_to_redeem: 999 });
    assert.equal(noCard.status, 422);
    assert.equal(noCard.body.code, 'PAYMENT_METHOD_REQUIRED');

    const d = await h.newUser('gp3d');
    await giveGiftPoints(d, 5000);
    await addToBasket(d, 'BK-DDIA-EB', 1);
    await setAddress(d);
    const extra = await pay(d, { gift_points_to_redeem: 2999, card: VISA });
    assert.equal(extra.status, 422);
    assert.equal(extra.body.code, 'CARD_NOT_REQUIRED');
    assert.equal(await balance(d), 5000);
  });

  it('refuses more points than the balance or than the item subtotal', async () => {
    const u = await h.newUser('gp4');
    await giveGiftPoints(u, 100);
    await addToBasket(u, 'BK-DUNE-001', 1);
    await setAddress(u);
    const poor = await pay(u, { gift_points_to_redeem: 101, card: VISA });
    assert.equal(poor.status, 422);
    assert.equal(poor.body.code, 'INSUFFICIENT_GIFT_POINTS');

    await giveGiftPoints(u, 5000);
    const tooMany = await pay(u, { gift_points_to_redeem: 1000, card: VISA }); // 10.00 > 9.99
    assert.equal(tooMany.status, 422);
    assert.equal(tooMany.body.code, 'GIFT_POINTS_EXCEED_SUBTOTAL');
    assert.equal(await count('orders', u), 0);
    assert.equal(await balance(u), 5100);
  });

  it('concurrent checkouts can never spend the same points twice', async () => {
    const u = await h.newUser('gp5');
    await giveGiftPoints(u, 1000);
    await addToBasket(u, 'BK-DDIA-EB', 1); // 29.99 digital
    await setAddress(u);
    // Two different keys racing for the same basket and the same 1000 points.
    const results = await Promise.all([
      pay(u, { gift_points_to_redeem: 1000, card: VISA }),
      pay(u, { gift_points_to_redeem: 1000, card: VISA }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 201).length, 1, JSON.stringify(results.map((r) => r.body.code)));
    assert.equal(await count('orders', u), 1);
    assert.equal(await balance(u), 0);
  });
});

describe('payment - idempotency and stock', () => {
  it('replaying the same key returns the original order and charges once', async () => {
    const u = await h.newUser('id1');
    await addToBasket(u, 'BK-DUNE-001', 1);
    await setAddress(u);
    charges.length = 0;
    const key = h.idemKey();

    const first = await pay(u, { card: VISA }, key);
    const replay = await pay(u, { card: VISA }, key);
    assert.equal(first.status, 201);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(replay.body, first.body);
    assert.equal(charges.length, 1);
    assert.equal(await count('orders', u), 1);
  });

  it('the same key with a different request is rejected', async () => {
    const u = await h.newUser('id2');
    await addToBasket(u, 'BK-DUNE-001', 1);
    await setAddress(u);
    const key = h.idemKey();
    assert.equal((await pay(u, { card: VISA }, key)).status, 201);
    const other = await pay(u, { card: { payment_token: 'tok_mc_debit_0005', card_type: 'debit' } }, key);
    assert.equal(other.status, 422);
    assert.equal(other.body.code, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('simultaneous identical requests create exactly one order', async () => {
    const u = await h.newUser('id3');
    await addToBasket(u, 'BK-DUNE-001', 1);
    await setAddress(u);
    charges.length = 0;
    const key = h.idemKey();
    const [a, b, c] = await Promise.all([pay(u, { card: VISA }, key), pay(u, { card: VISA }, key), pay(u, { card: VISA }, key)]);
    assert.deepEqual([a.status, b.status, c.status], [201, 201, 201]);
    assert.equal(a.body.order.id, b.body.order.id);
    assert.equal(b.body.order.id, c.body.order.id);
    assert.equal(charges.length, 1);
    assert.equal(await count('orders', u), 1);
  });

  it('a failed attempt can be retried with the same key', async () => {
    const u = await h.newUser('id4');
    await addToBasket(u, 'BK-DUNE-001', 1);
    await setAddress(u);
    const key = h.idemKey();
    assert.equal((await pay(u, { card: { payment_token: 'tok_declined_0002', card_type: 'credit' } }, key)).status, 402);
    // different body => different hash; the failed attempt left no key row behind, so this is a fresh attempt
    assert.equal((await pay(u, { card: VISA }, key)).status, 201);
  });

  it('never oversells the last copy when two customers check out together', async () => {
    await h.pool.query("UPDATE products SET stock_quantity = 1 WHERE sku = 'BK-NEURO-001'");
    const a = await h.newUser('st1a');
    const b = await h.newUser('st1b');
    for (const u of [a, b]) {
      await addToBasket(u, 'BK-NEURO-001', 1);
      await setAddress(u);
    }
    const [ra, rb] = await Promise.all([pay(a, { card: VISA }), pay(b, { card: VISA })]);
    assert.deepEqual([ra.status, rb.status].sort(), [201, 409]);
    const loser = ra.status === 409 ? ra : rb;
    assert.equal(loser.body.code, 'INSUFFICIENT_STOCK');
    assert.equal(await stockOf('BK-NEURO-001'), 0);
    await h.pool.query("UPDATE products SET stock_quantity = 150 WHERE sku = 'BK-NEURO-001'");
  });

  it('compensates: refunds the card if the order cannot be committed after a successful charge', async () => {
    const u = await h.newUser('cm1');
    await addToBasket(u, 'BK-DUNE-001', 1);
    await setAddress(u);
    // Make the final step fail AFTER the card was charged.
    await h.pool.query(`
      CREATE OR REPLACE FUNCTION test_fail_paid() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated commit-time failure'; END $$;
      CREATE TRIGGER test_fail_paid BEFORE UPDATE ON orders FOR EACH ROW
        WHEN (NEW.status = 'paid') EXECUTE FUNCTION test_fail_paid();`);
    refunds.length = 0;
    try {
      const res = await pay(u, { card: VISA });
      assert.equal(res.status, 500);
      assert.ok(!JSON.stringify(res.body).includes('simulated'));
      assert.equal(refunds.length, 1, 'the charge was refunded');
      assert.equal(await count('orders', u), 0);
    } finally {
      await h.pool.query('DROP TRIGGER test_fail_paid ON orders; DROP FUNCTION test_fail_paid()');
    }
    // and the customer can simply try again
    const retry = await pay(u, { card: VISA });
    assert.equal(retry.status, 201);
  });
});
