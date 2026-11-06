import { afterAll, describe, expect, it } from '@jest/globals';
import { expectContract } from '../support/contract.js';
import { VISA, addToBasket, ageOrder, as, chooseAddress, closeDb, db, grantGiftPoints, newUser, pay, placeOrder, pointsBalance, productId, stockOf } from '../support/world.js';

afterAll(closeDb);

const DUNE = 'BK-DUNE-001'; //     $9.99
const NEURO = 'BK-NEURO-001'; //   $8.99
const EBOOK = 'BK-DDIA-EB'; //     $29.99, instant

const history = (user, query = '') => as(user).get(`/api/users/${user.id}/orders${query}`);
const reorder = (user, orderId) => as(user).post(`/api/orders/reorder/${orderId}`);
const cancel = (user, orderId, body) => as(user).post(`/api/orders/cancel/${orderId}`).send(body ?? {});
const statusOf = async (orderId) => (await db().query('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0].status;

describe('ORD-01 order history', () => {
  it('is empty for a customer who has not ordered', async () => {
    const user = await newUser('ord-none');
    const res = expectContract(await history(user), 'GET', '/api/users/{id}/orders');
    expect(res.body).toMatchObject({ items: [], total_items: 0, total_pages: 0, page: 1 });
  });

  it('lists the customer’s orders newest first, with items, totals and cancel flags', async () => {
    const user = await newUser('ord-list');
    const first = (await placeOrder(user, [[DUNE, 2]])).order;
    const second = (await placeOrder(user, [[NEURO, 1]])).order;
    const res = expectContract(await history(user), 'GET', '/api/users/{id}/orders');
    expect(res.body.items.map((o) => o.id)).toEqual([second.id, first.id]);
    expect(res.body.items[1]).toMatchObject({
      order_number: first.order_number,
      status: 'paid',
      total_amount: '24.97',
      can_cancel: true,
      can_reorder: true,
      items: [{ sku: DUNE, quantity: 2, line_total: '19.98' }],
    });
    expect(res.body.items[1].cancellable_until).toEqual(expect.any(String));
  });

  it('never shows another customer’s orders', async () => {
    const a = await newUser('ord-priv-a');
    const b = await newUser('ord-priv-b');
    await placeOrder(a, [[DUNE, 1]]);
    expect((await history(b)).body.items).toEqual([]);
    expect(expectContract(await as(b).get(`/api/users/${a.id}/orders`), 'GET', '/api/users/{id}/orders').status).toBe(403);
  });

  it('filters by status and paginates', async () => {
    const user = await newUser('ord-page');
    const orders = [];
    for (let i = 0; i < 3; i++) orders.push((await placeOrder(user, [[DUNE, 1]])).order);
    await cancel(user, orders[0].id);

    const page1 = expectContract(await history(user, '?page=1&page_size=2'), 'GET', '/api/users/{id}/orders');
    expect([page1.body.total_items, page1.body.total_pages, page1.body.items.length]).toEqual([3, 2, 2]);
    expect((await history(user, '?page=2&page_size=2')).body.items).toHaveLength(1);

    const cancelled = await history(user, '?status=cancelled');
    expect(cancelled.body.items.map((o) => o.id)).toEqual([orders[0].id]);
    expect((await history(user, '?status=paid')).body.total_items).toBe(2);
  });

  it.each(['?status=bogus', '?page=0', '?page_size=101'])('rejects the query %s [400]', async (query) => {
    const user = await newUser('ord-val');
    expect(expectContract(await history(user, query), 'GET', '/api/users/{id}/orders').status).toBe(400);
  });
});

describe('ORD-02 "Buy In Again"', () => {
  it('copies a past order into the basket [200]', async () => {
    const user = await newUser('re-basic');
    const { order } = await placeOrder(user, [[DUNE, 2], [NEURO, 1]]);
    expect((await as(user).get('/api/basket')).body.items).toEqual([]);

    const res = expectContract(await reorder(user, order.id), 'POST', '/api/orders/reorder/{orderId}');
    expect(res.status).toBe(200);
    expect(res.body.added.map((a) => a.quantity)).toEqual([2, 1]);
    expect(res.body.skipped).toEqual([]);
    expect(res.body.basket).toMatchObject({ item_count: 3, subtotal_amount: '28.97' });
    // the basket really changed, not only the response
    expect((await as(user).get('/api/basket')).body.item_count).toBe(3);
  });

  it('uses today’s prices, not the prices of the old order', async () => {
    const user = await newUser('re-price');
    const { order } = await placeOrder(user, [[DUNE, 2]]);
    await db().query('UPDATE products SET price = 10.49 WHERE sku = $1', [DUNE]);
    try {
      const res = await reorder(user, order.id);
      expect(res.body.basket.subtotal_amount).toBe('20.98');
      expect(res.body.basket.items[0].product.price).toBe('10.49');
      expect((await history(user)).body.items[0].items[0].unit_price).toBe('9.99'); // history is unchanged
    } finally {
      await db().query('UPDATE products SET price = 9.99 WHERE sku = $1', [DUNE]);
    }
  });

  it('adds to what is already in the basket', async () => {
    const user = await newUser('re-merge');
    const { order } = await placeOrder(user, [[DUNE, 2]]);
    await addToBasket(user, DUNE, 1);
    const res = await reorder(user, order.id);
    expect(res.body.basket.items).toHaveLength(1);
    expect(res.body.basket.items[0].quantity).toBe(3);
  });

  it('never goes above the stock on hand', async () => {
    const user = await newUser('re-cap');
    const { order } = await placeOrder(user, [[DUNE, 2]]);
    await db().query('UPDATE products SET stock_quantity = 1 WHERE sku = $1', [DUNE]);
    try {
      const res = await reorder(user, order.id);
      expect(res.status).toBe(200);
      expect(res.body.basket.items[0].quantity).toBe(1);
      expect(res.body.added[0].quantity).toBe(1);
    } finally {
      await db().query('UPDATE products SET stock_quantity = 300 WHERE sku = $1', [DUNE]);
    }
  });

  it('skips books that are withdrawn or sold out and says which and why', async () => {
    const user = await newUser('re-skip');
    const { order } = await placeOrder(user, [[DUNE, 1], [NEURO, 1]]);
    // Make the order contain a book that is out of stock now: it sold out after the purchase.
    await db().query('UPDATE products SET stock_quantity = 0 WHERE sku = $1', [DUNE]);
    await db().query('UPDATE products SET is_active = false WHERE sku = $1', [NEURO]);
    await db().query(
      `INSERT INTO order_items (order_id, product_id, product_sku, product_title, unit_price, quantity) SELECT $1, id, sku, title, price, 1 FROM products WHERE sku = $2`,
      [order.id, EBOOK],
    );
    try {
      const res = expectContract(await reorder(user, order.id), 'POST', '/api/orders/reorder/{orderId}');
      expect(res.status).toBe(200);
      expect(res.body.added.map((a) => a.product_id)).toEqual([await productId(EBOOK)]);
      const reasons = Object.fromEntries(res.body.skipped.map((s) => [s.title, s.reason]));
      expect(reasons).toMatchObject({ Neuromancer: 'product_unavailable', Dune: 'out_of_stock' });
    } finally {
      await db().query('UPDATE products SET stock_quantity = 300 WHERE sku = $1', [DUNE]);
      await db().query('UPDATE products SET is_active = true WHERE sku = $1', [NEURO]);
    }
  });

  it('is refused when nothing in the order can be bought again [409]', async () => {
    const user = await newUser('re-none');
    const { order } = await placeOrder(user, [[DUNE, 1]]);
    await db().query('UPDATE products SET is_active = false WHERE sku = $1', [DUNE]);
    try {
      expect((await history(user)).body.items[0].can_reorder).toBe(false);
      const res = expectContract(await reorder(user, order.id), 'POST', '/api/orders/reorder/{orderId}');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NOTHING_TO_REORDER');
    } finally {
      await db().query('UPDATE products SET is_active = true WHERE sku = $1', [DUNE]);
    }
  });

  it('works for delivered and cancelled orders too', async () => {
    const user = await newUser('re-status');
    const delivered = (await placeOrder(user, [[DUNE, 1]])).order;
    await db().query("UPDATE orders SET status = 'delivered' WHERE id = $1", [delivered.id]);
    const cancelled = (await placeOrder(user, [[NEURO, 1]])).order;
    await cancel(user, cancelled.id);
    expect((await reorder(user, delivered.id)).status).toBe(200);
    expect((await reorder(user, cancelled.id)).status).toBe(200);
  });

  it('the re-filled basket can go straight through checkout', async () => {
    const user = await newUser('re-checkout');
    const { order } = await placeOrder(user, [[DUNE, 1]]);
    await reorder(user, order.id);
    await chooseAddress(user);
    const res = await pay(user, { card: VISA });
    expect(res.status).toBe(201);
    expect((await history(user)).body.total_items).toBe(2);
  });

  it('only the owner can re-order [404], and a token is required [401]', async () => {
    const owner = await newUser('re-own');
    const other = await newUser('re-other');
    const { order } = await placeOrder(owner, [[DUNE, 1]]);
    expect(expectContract(await reorder(other, order.id), 'POST', '/api/orders/reorder/{orderId}').status).toBe(404);
    expect(expectContract(await reorder(owner, 999999999), 'POST', '/api/orders/reorder/{orderId}').status).toBe(404);
    expect((await as(owner).get('/api/basket')).body.items).toEqual([]); // nothing leaked into either basket
    expect((await as(other).get('/api/basket')).body.items).toEqual([]);
  });
});

describe('ORD-03 48-hour cancellation rule', () => {
  it('a fresh order is cancellable and reports when the window closes', async () => {
    const user = await newUser('can-flag');
    const { order } = await placeOrder(user, [[DUNE, 1]]);
    expect(order.can_cancel).toBe(true);
    const deadline = new Date(order.cancellable_until).getTime();
    const placed = new Date(order.placed_at).getTime();
    expect(deadline - placed).toBe(48 * 3_600_000);
  });

  it('cancelling restocks the books, refunds the card and marks the order cancelled [200]', async () => {
    const user = await newUser('can-ok');
    const { order } = await placeOrder(user, [[DUNE, 2]]);
    const stockBefore = await stockOf(DUNE);

    const res = expectContract(await cancel(user, order.id, { reason: 'Changed my mind' }), 'POST', '/api/orders/cancel/{orderId}');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: order.id, status: 'cancelled', can_cancel: false, cancellable_until: null });
    expect(res.body.cancelled_at).toEqual(expect.any(String));

    expect(await stockOf(DUNE)).toBe(stockBefore + 2);
    expect((await db().query('SELECT status FROM payments WHERE order_id = $1', [order.id])).rows[0].status).toBe('refunded');
    expect((await db().query('SELECT cancel_reason FROM orders WHERE id = $1', [order.id])).rows[0].cancel_reason).toBe('Changed my mind');
    expect((await history(user)).body.items[0]).toMatchObject({ status: 'cancelled', can_cancel: false });
  });

  it('gift points spent on the order are credited back', async () => {
    const user = await newUser('can-points');
    await grantGiftPoints(user, 1000);
    const { order } = await placeOrder(user, [[DUNE, 2]], { points: 500 });
    expect(await pointsBalance(user)).toBe(500);
    await cancel(user, order.id).then((r) => expect(r.status).toBe(200));
    expect(await pointsBalance(user)).toBe(1000);
  });

  it('a points-only order is cancelled without any card refund', async () => {
    const user = await newUser('can-pointsonly');
    await grantGiftPoints(user, 3000);
    const { order, payment } = await placeOrder(user, [[EBOOK, 1]], { card: null, points: 2999 });
    expect(payment).toBeNull();
    expect((await cancel(user, order.id)).status).toBe(200);
    expect(await pointsBalance(user)).toBe(3000);
  });

  it('is allowed up to the last minute: placed 47h59m ago', async () => {
    const user = await newUser('can-edge-in');
    const { order } = await placeOrder(user, [[DUNE, 1]]);
    await ageOrder(order.id, '47 hours 59 minutes');
    expect((await history(user)).body.items[0].can_cancel).toBe(true);
    expect((await cancel(user, order.id)).status).toBe(200);
  });

  it('is refused after 48 hours: placed 48h01m ago [409]', async () => {
    const user = await newUser('can-edge-out');
    const { order } = await placeOrder(user, [[DUNE, 1]]);
    await ageOrder(order.id, '48 hours 1 minute');
    const listed = (await history(user)).body.items[0];
    expect(listed).toMatchObject({ can_cancel: false, cancellable_until: null });

    const res = expectContract(await cancel(user, order.id), 'POST', '/api/orders/cancel/{orderId}');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CANCELLATION_WINDOW_EXPIRED');
    expect(await statusOf(order.id)).toBe('paid');
  });

  it('a refused cancellation changes nothing: stock, points and payment stay as they were', async () => {
    const user = await newUser('can-late-intact');
    await grantGiftPoints(user, 1000);
    const { order } = await placeOrder(user, [[DUNE, 2]], { points: 500 });
    await ageOrder(order.id, '3 days');
    const stock = await stockOf(DUNE);
    await cancel(user, order.id);
    expect(await stockOf(DUNE)).toBe(stock);
    expect(await pointsBalance(user)).toBe(500);
    expect((await db().query('SELECT status FROM payments WHERE order_id = $1', [order.id])).rows[0].status).toBe('captured');
  });

  it.each(['shipped', 'delivered', 'refunded'])('a %s order cannot be cancelled even inside the window [409]', async (status) => {
    const user = await newUser(`can-${status}`);
    const { order } = await placeOrder(user, [[DUNE, 1]]);
    await db().query('UPDATE orders SET status = $2 WHERE id = $1', [order.id, status]);
    const listed = (await history(user)).body.items[0];
    expect(listed.can_cancel).toBe(false);
    const res = expectContract(await cancel(user, order.id), 'POST', '/api/orders/cancel/{orderId}');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_NOT_CANCELLABLE');
    expect(await statusOf(order.id)).toBe(status);
  });

  it('cancelling twice is safe: the second call returns the cancelled order and restocks only once', async () => {
    const user = await newUser('can-twice');
    const { order } = await placeOrder(user, [[DUNE, 3]]);
    const stock = await stockOf(DUNE);
    expect((await cancel(user, order.id)).status).toBe(200);
    const again = expectContract(await cancel(user, order.id), 'POST', '/api/orders/cancel/{orderId}');
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('cancelled');
    expect(await stockOf(DUNE)).toBe(stock + 3);
  });

  it('a cancelled order cannot be paid for twice: it is no longer cancellable and its stock is back on sale', async () => {
    const user = await newUser('can-after');
    const { order } = await placeOrder(user, [[DUNE, 1]]);
    await cancel(user, order.id);
    expect((await history(user)).body.items[0].can_cancel).toBe(false);
  });

  it('only the owner can cancel [404]; anonymous callers get [401]; nothing changes', async () => {
    const owner = await newUser('can-own');
    const intruder = await newUser('can-intruder');
    const { order } = await placeOrder(owner, [[DUNE, 1]]);
    expect(expectContract(await cancel(intruder, order.id), 'POST', '/api/orders/cancel/{orderId}').status).toBe(404);
    expect(expectContract(await cancel(owner, 999999999), 'POST', '/api/orders/cancel/{orderId}').status).toBe(404);
    expect(await statusOf(order.id)).toBe('paid');
  });

  it.each([
    ['text order id', 'abc', {}],
    ['reason longer than 500 characters', null, { reason: 'x'.repeat(501) }],
    ['unknown field', null, { force: true }],
  ])('rejects %s [400]', async (_name, rawId, body) => {
    const user = await newUser('can-val');
    const { order } = await placeOrder(user, [[DUNE, 1]]);
    const res = await cancel(user, rawId ?? order.id, body);
    expect(res.status).toBe(400);
    expect(await statusOf(order.id)).toBe('paid');
  });
});

describe('ORD-04 purchase → history → buy again → cancel (end to end through the API)', () => {
  it('follows the whole customer journey', async () => {
    const user = await newUser('journey');
    await grantGiftPoints(user, 1000);

    // browse and choose
    const catalogue = await as(user).get('/api/products?brand=ace');
    const dune = catalogue.body.items.find((p) => p.sku === DUNE);
    const related = await as(user).get(`/api/products/${dune.id}/related`);
    expect(related.body.items[0].product.sku).toBe(NEURO);

    // buy with points + card
    await addToBasket(user, DUNE, 1);
    await addToBasket(user, NEURO, 1);
    await chooseAddress(user);
    const bought = await pay(user, { gift_points_to_redeem: 300, card: VISA });
    expect(bought.status).toBe(201);
    expect(bought.body.order.total_amount).toBe('20.97'); // 18.98 + 4.99 - 3.00

    // history, buy again, cancel
    const listed = (await history(user)).body.items[0];
    expect(listed.id).toBe(bought.body.order.id);
    expect((await reorder(user, listed.id)).body.basket.item_count).toBe(2);
    expect((await cancel(user, listed.id)).body.status).toBe('cancelled');
    expect(await pointsBalance(user)).toBe(1000);

    // the order is still there to buy from again after cancellation
    expect((await reorder(user, listed.id)).body.basket.items.map((i) => i.quantity)).toEqual([2, 2]);
  });
});
