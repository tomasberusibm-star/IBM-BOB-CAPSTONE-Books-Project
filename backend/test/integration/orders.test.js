import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createMockProvider } from '../../src/payments/provider.js';
import { startHarness } from '../helpers/harness.js';

let h;
const refundCalls = [];

before(async () => {
  const provider = createMockProvider();
  const refund = provider.refund.bind(provider);
  provider.refund = async (args) => {
    refundCalls.push(args);
    return refund(args);
  };
  h = await startHarness({ provider });
});
after(() => h.stop());

/** Inserts a past order (with items) directly; returns its id. */
async function seedOrder(user, lines, { status = 'delivered', hoursAgo = 1, points = 0, withPayment = false } = {}) {
  const subtotal = lines.reduce((s, [sku, qty]) => s + qty * priceOf[sku], 0);
  const discount = points / 100;
  const total = subtotal - discount;
  const { rows } = await h.pool.query(
    `INSERT INTO orders (user_id, shipping_address_snapshot, status, subtotal_amount, discount_amount,
                         gift_points_redeemed, total_amount, placed_at)
     VALUES ($1, '{"recipient_name":"T"}', $2, $3, $4, $5, $6, now() - make_interval(hours => $7::int)) RETURNING id`,
    [user.id, status, subtotal.toFixed(2), discount.toFixed(2), points, total.toFixed(2), hoursAgo],
  );
  const orderId = rows[0].id;
  for (const [sku, qty] of lines) {
    await h.pool.query(
      `INSERT INTO order_items (order_id, product_id, product_sku, product_title, unit_price, quantity)
       SELECT $1, id, sku, title, price, $3 FROM products WHERE sku = $2`,
      [orderId, sku, qty],
    );
  }
  if (withPayment && total > 0) {
    await h.pool.query(
      `INSERT INTO payments (order_id, method, status, amount, provider, provider_reference, card_last4, captured_at)
       VALUES ($1, 'card', 'captured', $2, 'mock', $3, '4242', now())`,
      [orderId, total.toFixed(2), `mock_ch_seed_${orderId}`],
    );
  }
  return orderId;
}
const priceOf = { 'BK-DUNE-001': 9.99, 'BK-NEURO-001': 8.99, 'BK-CLEANCODE-001': 39.99, 'BK-DDIA-EB': 29.99, 'BK-PGUR-001': 34.99 };

const stockOf = async (sku) => (await h.pool.query('SELECT stock_quantity FROM products WHERE sku = $1', [sku])).rows[0].stock_quantity;
const points = async (user) => (await h.pool.query('SELECT COALESCE((SELECT balance FROM gift_point_accounts WHERE user_id = $1), 0) AS b', [user.id])).rows[0].b;

describe('order history', () => {
  it('lists only the caller’s orders, newest first, with items and cancel flags', async () => {
    const u = await h.newUser('hist');
    const old = await seedOrder(u, [['BK-DUNE-001', 2]], { hoursAgo: 100 });
    const recent = await seedOrder(u, [['BK-NEURO-001', 1]], { status: 'paid', hoursAgo: 2 });
    await seedOrder(await h.newUser('hist-other'), [['BK-DUNE-001', 1]]);

    const res = await h.api('GET', `/api/users/${u.publicId}/orders`, { token: u.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.total_items, 2);
    assert.deepEqual(res.body.items.map((o) => o.id), [recent, old]);

    const [r, o] = res.body.items;
    assert.equal(r.can_cancel, true);
    assert.ok(r.cancellable_until);
    assert.equal(o.can_cancel, false);
    assert.equal(o.cancellable_until, null);
    assert.equal(o.items[0].line_total, '19.98');
    assert.equal(o.items[0].sku, 'BK-DUNE-001');
    assert.equal(o.can_reorder, true);
  });

  it('filters by status and paginates', async () => {
    const u = await h.newUser('hist2');
    for (let i = 0; i < 3; i++) await seedOrder(u, [['BK-DUNE-001', 1]], { hoursAgo: 10 + i });
    await seedOrder(u, [['BK-DUNE-001', 1]], { status: 'shipped', hoursAgo: 5 });
    const shipped = await h.api('GET', `/api/users/${u.publicId}/orders?status=shipped`, { token: u.token });
    assert.equal(shipped.body.total_items, 1);
    const page = await h.api('GET', `/api/users/${u.publicId}/orders?page=2&page_size=3`, { token: u.token });
    assert.equal(page.body.items.length, 1);
    assert.equal(page.body.total_pages, 2);
    assert.equal((await h.api('GET', `/api/users/${u.publicId}/orders?status=bogus`, { token: u.token })).status, 400);
  });
});

describe('Buy It Again (reorder)', () => {
  it('copies a past order into the basket at current prices', async () => {
    const u = await h.newUser('re1');
    const orderId = await seedOrder(u, [['BK-DUNE-001', 2], ['BK-NEURO-001', 1]]);
    await h.pool.query("UPDATE products SET price = 10.49 WHERE sku = 'BK-DUNE-001'");

    const res = await h.api('POST', `/api/orders/reorder/${orderId}`, { token: u.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.added.map((a) => a.quantity), [2, 1]);
    assert.deepEqual(res.body.skipped, []);
    assert.equal(res.body.basket.item_count, 3);
    assert.equal(res.body.basket.subtotal_amount, '29.97'); // 2 x 10.49 + 8.99, not the old 9.99
    await h.pool.query("UPDATE products SET price = 9.99 WHERE sku = 'BK-DUNE-001'");
  });

  it('adds to existing basket quantities and never exceeds tracked stock', async () => {
    const u = await h.newUser('re2');
    const orderId = await seedOrder(u, [['BK-DUNE-001', 2]]);
    await h.api('POST', '/api/basket/items', { token: u.token, body: { product_id: await h.sku('BK-DUNE-001'), quantity: 1 } });
    const res = await h.api('POST', `/api/orders/reorder/${orderId}`, { token: u.token });
    assert.equal(res.body.basket.items[0].quantity, 3);

    await h.pool.query("UPDATE products SET stock_quantity = 4 WHERE sku = 'BK-DUNE-001'");
    const again = await h.api('POST', `/api/orders/reorder/${orderId}`, { token: u.token });
    assert.equal(again.body.basket.items[0].quantity, 4, 'capped at stock');
    assert.equal(again.body.added[0].quantity, 1);
    await h.pool.query("UPDATE products SET stock_quantity = 300 WHERE sku = 'BK-DUNE-001'");
  });

  it('skips unavailable and out-of-stock items and reports them', async () => {
    const u = await h.newUser('re3');
    const orderId = await seedOrder(u, [['BK-DUNE-001', 1], ['BK-NEURO-001', 1], ['BK-PGUR-001', 1]]);
    await h.pool.query("UPDATE products SET is_active = false WHERE sku = 'BK-NEURO-001'");
    const res = await h.api('POST', `/api/orders/reorder/${orderId}`, { token: u.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.added.map((a) => a.product_id), [await h.sku('BK-DUNE-001')]);
    const reasons = Object.fromEntries(res.body.skipped.map((s) => [s.title, s.reason]));
    assert.equal(reasons.Neuromancer, 'product_unavailable');
    assert.equal(reasons['PostgreSQL: Up and Running'], 'out_of_stock');
    await h.pool.query("UPDATE products SET is_active = true WHERE sku = 'BK-NEURO-001'");
  });

  it('409s when nothing can be re-ordered', async () => {
    const u = await h.newUser('re4');
    const orderId = await seedOrder(u, [['BK-PGUR-001', 1]]);
    const res = await h.api('POST', `/api/orders/reorder/${orderId}`, { token: u.token });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'NOTHING_TO_REORDER');
  });

  it('hides other customers’ orders behind 404 and requires auth', async () => {
    const a = await h.newUser('re5a');
    const b = await h.newUser('re5b');
    const orderId = await seedOrder(a, [['BK-DUNE-001', 1]]);
    assert.equal((await h.api('POST', `/api/orders/reorder/${orderId}`, { token: b.token })).status, 404);
    assert.equal((await h.api('POST', `/api/orders/reorder/${orderId}`)).status, 401);
    assert.equal((await h.api('POST', '/api/orders/reorder/abc', { token: a.token })).status, 400);
  });
});

describe('48-hour cancellation window', () => {
  it('cancels a fresh paid order: restocks, credits points back, refunds the card', async () => {
    const u = await h.newUser('can1');
    const orderId = await seedOrder(u, [['BK-DUNE-001', 2]], { status: 'paid', hoursAgo: 1, points: 200, withPayment: true });
    await h.pool.query(
      "INSERT INTO gift_points_ledger (user_id, order_id, entry_type, points, note) VALUES ($1, NULL, 'earn', 300, 'seed')",
      [u.id],
    );
    await h.pool.query(
      "INSERT INTO gift_points_ledger (user_id, order_id, entry_type, points, note) VALUES ($1, $2, 'redeem', -200, 'seed')",
      [u.id, orderId],
    );
    assert.equal(await points(u), 100);
    const stockBefore = await stockOf('BK-DUNE-001');
    refundCalls.length = 0;

    const res = await h.api('POST', `/api/orders/cancel/${orderId}`, { token: u.token, body: { reason: 'Changed my mind' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'cancelled');
    assert.ok(res.body.cancelled_at);
    assert.equal(res.body.can_cancel, false);

    assert.equal(await stockOf('BK-DUNE-001'), stockBefore + 2);
    assert.equal(await points(u), 300, 'redeemed points credited back');
    assert.equal(refundCalls.length, 1);
    const pay = (await h.pool.query('SELECT status FROM payments WHERE order_id = $1', [orderId])).rows[0];
    assert.equal(pay.status, 'refunded');
    const o = (await h.pool.query('SELECT cancel_reason FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(o.cancel_reason, 'Changed my mind');
  });

  it('allows cancellation up to the window edge and refuses just after it', async () => {
    const u = await h.newUser('can2');
    const inside = await seedOrder(u, [['BK-DUNE-001', 1]], { status: 'paid', hoursAgo: 47 });
    const outside = await seedOrder(u, [['BK-DUNE-001', 1]], { status: 'paid', hoursAgo: 49 });

    assert.equal((await h.api('POST', `/api/orders/cancel/${inside}`, { token: u.token })).status, 200);

    const late = await h.api('POST', `/api/orders/cancel/${outside}`, { token: u.token });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'CANCELLATION_WINDOW_EXPIRED');
    assert.equal((await h.pool.query('SELECT status FROM orders WHERE id = $1', [outside])).rows[0].status, 'paid');
  });

  it('exact boundary: 47h59m is allowed, 48h01m is not', async () => {
    const u = await h.newUser('can3');
    const mk = async (interval) => {
      const id = await seedOrder(u, [['BK-DUNE-001', 1]], { status: 'paid', hoursAgo: 0 });
      await h.pool.query(`UPDATE orders SET placed_at = now() - interval '${interval}' WHERE id = $1`, [id]);
      return id;
    };
    assert.equal((await h.api('POST', `/api/orders/cancel/${await mk('47 hours 59 minutes')}`, { token: u.token })).status, 200);
    const late = await h.api('POST', `/api/orders/cancel/${await mk('48 hours 1 minute')}`, { token: u.token });
    assert.equal(late.body.code, 'CANCELLATION_WINDOW_EXPIRED');
  });

  it('refuses orders that already shipped or were delivered, even inside the window', async () => {
    const u = await h.newUser('can4');
    for (const status of ['shipped', 'delivered', 'refunded']) {
      const id = await seedOrder(u, [['BK-DUNE-001', 1]], { status, hoursAgo: 1 });
      const res = await h.api('POST', `/api/orders/cancel/${id}`, { token: u.token });
      assert.equal(res.status, 409, status);
      assert.equal(res.body.code, 'ORDER_NOT_CANCELLABLE');
    }
  });

  it('is idempotent: cancelling twice returns 200 and restocks once', async () => {
    const u = await h.newUser('can5');
    const id = await seedOrder(u, [['BK-DUNE-001', 3]], { status: 'paid', hoursAgo: 1 });
    const before = await stockOf('BK-DUNE-001');
    assert.equal((await h.api('POST', `/api/orders/cancel/${id}`, { token: u.token })).status, 200);
    const again = await h.api('POST', `/api/orders/cancel/${id}`, { token: u.token });
    assert.equal(again.status, 200);
    assert.equal(again.body.status, 'cancelled');
    assert.equal(await stockOf('BK-DUNE-001'), before + 3);
  });

  it('cannot cancel someone else’s order (404) or without a token (401)', async () => {
    const a = await h.newUser('can6a');
    const b = await h.newUser('can6b');
    const id = await seedOrder(a, [['BK-DUNE-001', 1]], { status: 'paid', hoursAgo: 1 });
    assert.equal((await h.api('POST', `/api/orders/cancel/${id}`, { token: b.token })).status, 404);
    assert.equal((await h.api('POST', `/api/orders/cancel/${id}`)).status, 401);
    assert.equal((await h.pool.query('SELECT status FROM orders WHERE id = $1', [id])).rows[0].status, 'paid');
  });

  it('rolls everything back when the refund fails, so the order stays cancellable', async () => {
    const failing = createMockProvider();
    failing.refund = async () => {
      throw new Error('provider down');
    };
    const hf = await startHarness({ db: { databaseUrl: h.config.databaseUrl }, provider: failing });
    try {
      const u = await hf.newUser('can7');
      const id = await seedOrder(u, [['BK-DUNE-001', 1]], { status: 'paid', hoursAgo: 1, withPayment: true });
      const before = await stockOf('BK-DUNE-001');
      const res = await hf.api('POST', `/api/orders/cancel/${id}`, { token: u.token });
      assert.equal(res.status, 502);
      assert.equal(res.body.code, 'PAYMENT_PROVIDER_ERROR');
      assert.ok(!JSON.stringify(res.body).includes('provider down'));
      assert.equal((await h.pool.query('SELECT status FROM orders WHERE id = $1', [id])).rows[0].status, 'paid');
      assert.equal(await stockOf('BK-DUNE-001'), before);
    } finally {
      await hf.stop();
    }
  });
});
