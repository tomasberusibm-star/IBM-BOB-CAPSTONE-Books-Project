import { afterAll, describe, expect, it } from '@jest/globals';
import { expectContract } from '../support/contract.js';
import {
  ADDRESS, DEBIT, DECLINED, PROVIDER_DOWN, VISA, addToBasket, as, chooseAddress, closeDb, db, grantGiftPoints, idempotencyKey,
  newUser, pay, placeOrder, pointsBalance, productId, stockOf,
} from '../support/world.js';

afterAll(closeDb);

const DUNE = 'BK-DUNE-001'; //            $9.99 paperback, stock tracked
const EBOOK = 'BK-DDIA-EB'; //            $29.99 e-book, instant, stock not tracked
const PAPERBACK_DDIA = 'BK-DDIA-001'; //  $44.99
const SOLD_OUT = 'BK-PGUR-001';
const ordersOf = async (user) => Number((await db().query('SELECT count(*) FROM orders WHERE user_id = $1', [user.dbId])).rows[0].count);

describe('BSK-01 basket management', () => {
  it('a new customer has an empty basket, and reading it creates nothing', async () => {
    const user = await newUser('bsk-empty');
    const res = expectContract(await as(user).get('/api/basket'), 'GET', '/api/basket');
    expect(res.body).toMatchObject({ id: null, items: [], item_count: 0, subtotal_amount: '0.00', currency: 'USD' });
    expect(Number((await db().query('SELECT count(*) FROM carts WHERE user_id = $1', [user.dbId])).rows[0].count)).toBe(0);
  });

  it('adds a book and prices the line exactly', async () => {
    const user = await newUser('bsk-add');
    const res = expectContract(await as(user).post('/api/basket/items').send({ product_id: await productId(DUNE), quantity: 2 }), 'POST', '/api/basket/items');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ quantity: 2, line_total: '19.98', product: { sku: DUNE, price: '9.99' } });
    expect(res.body).toMatchObject({ item_count: 2, subtotal_amount: '19.98' });
  });

  it('adding the same book again merges quantities', async () => {
    const user = await newUser('bsk-merge');
    await addToBasket(user, DUNE, 2);
    const basket = await addToBasket(user, DUNE, 1);
    expect(basket.items).toHaveLength(1);
    expect(basket.items[0].quantity).toBe(3);
    expect(basket.subtotal_amount).toBe('29.97');
  });

  it('sums mixed paperback and e-book lines without rounding drift', async () => {
    const user = await newUser('bsk-mixed');
    await addToBasket(user, DUNE, 3); // 29.97
    const basket = await addToBasket(user, EBOOK, 1); // + 29.99
    expect(basket.subtotal_amount).toBe('59.96');
    expect(basket.item_count).toBe(4);
  });

  it('changes a quantity and removes a line', async () => {
    const user = await newUser('bsk-edit');
    await addToBasket(user, DUNE, 1);
    await addToBasket(user, EBOOK, 1);
    const id = await productId(DUNE);

    const changed = expectContract(await as(user).patch(`/api/basket/items/${id}`).send({ quantity: 4 }), 'PATCH', '/api/basket/items/{productId}');
    expect(changed.body.items.find((i) => i.product.sku === DUNE)).toMatchObject({ quantity: 4, line_total: '39.96' });

    const removed = expectContract(await as(user).delete(`/api/basket/items/${id}`), 'DELETE', '/api/basket/items/{productId}');
    expect(removed.body.items.map((i) => i.product.sku)).toEqual([EBOOK]);
    expect(removed.body.subtotal_amount).toBe('29.99');
  });

  it('removing something that is not in the basket is harmless (idempotent)', async () => {
    const user = await newUser('bsk-rm');
    expect(expectContract(await as(user).delete(`/api/basket/items/${await productId(DUNE)}`), 'DELETE', '/api/basket/items/{productId}').status).toBe(200);
  });

  it('refuses a quantity above stock [409] and an unavailable book [409]', async () => {
    const user = await newUser('bsk-stock');
    const sold = expectContract(await as(user).post('/api/basket/items').send({ product_id: await productId(SOLD_OUT), quantity: 1 }), 'POST', '/api/basket/items');
    expect(sold.status).toBe(409);
    expect(sold.body.code).toBe('INSUFFICIENT_STOCK');

    await addToBasket(user, DUNE, 1);
    const stock = await stockOf(DUNE);
    const tooMany = expectContract(await as(user).patch(`/api/basket/items/${await productId(DUNE)}`).send({ quantity: stock + 1 }), 'PATCH', '/api/basket/items/{productId}');
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.code).toBe('INSUFFICIENT_STOCK');
  });

  it('an unknown or withdrawn book is 404; changing a book not in the basket is 404', async () => {
    const user = await newUser('bsk-404');
    expect(expectContract(await as(user).post('/api/basket/items').send({ product_id: 999999, quantity: 1 }), 'POST', '/api/basket/items').status).toBe(404);
    expect(expectContract(await as(user).patch(`/api/basket/items/${await productId(DUNE)}`).send({ quantity: 1 }), 'PATCH', '/api/basket/items/{productId}').status).toBe(404);
  });

  it.each([
    ['quantity 0', { product_id: 1, quantity: 0 }],
    ['quantity 1000', { product_id: 1, quantity: 1000 }],
    ['fractional quantity', { product_id: 1, quantity: 1.5 }],
    ['text product id', { product_id: 'x', quantity: 1 }],
    ['client-supplied price', { product_id: 1, quantity: 1, price: '0.01' }],
  ])('rejects %s [400]', async (_name, body) => {
    const user = await newUser('bsk-val');
    expect(expectContract(await as(user).post('/api/basket/items').send(body), 'POST', '/api/basket/items').status).toBe(400);
  });

  it('baskets are private: two customers never see each other’s items', async () => {
    const a = await newUser('bsk-a');
    const b = await newUser('bsk-b');
    await addToBasket(a, DUNE, 2);
    expect((await as(b).get('/api/basket')).body.items).toEqual([]);
  });
});

describe('CHK-01 shipping address selection', () => {
  it('prices the order: flat shipping under the free-shipping threshold', async () => {
    const user = await newUser('adr-ship');
    await addToBasket(user, DUNE, 2);
    const summary = expectContract(await as(user).post('/api/checkout/address').send({ address: ADDRESS }), 'POST', '/api/checkout/address');
    expect(summary.body).toMatchObject({ subtotal_amount: '19.98', shipping_amount: '4.99', tax_amount: '0.00', total_amount: '24.97', currency: 'USD' });
    expect(summary.body.shipping_address).toMatchObject({ recipient_name: 'Quinn Tester', city: 'Testville' });
    expect(summary.body.tentative_delivery_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shipping is free at $50 and for digital-only baskets', async () => {
    const digital = await newUser('adr-digital');
    await addToBasket(digital, EBOOK, 1);
    expect((await chooseAddress(digital)).shipping_amount).toBe('0.00');

    const big = await newUser('adr-big');
    await addToBasket(big, PAPERBACK_DDIA, 2); // 89.98
    expect((await chooseAddress(big)).shipping_amount).toBe('0.00');
  });

  it('lists saved addresses (default first) and accepts one by id', async () => {
    const user = await newUser('adr-saved');
    await addToBasket(user, DUNE, 1);
    await chooseAddress(user, { address: { ...ADDRESS, label: 'Home', save_to_address_book: true } });
    const list = expectContract(await as(user).get('/api/addresses'), 'GET', '/api/addresses');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ recipient_name: 'Quinn Tester', label: 'Home' });

    const summary = await chooseAddress(user, { address_id: list.body.items[0].id });
    expect(summary.shipping_address.id).toBe(list.body.items[0].id);
  });

  it('one-off addresses stay out of the address book unless the customer asks', async () => {
    const user = await newUser('adr-oneoff');
    await addToBasket(user, DUNE, 1);
    await chooseAddress(user);
    expect((await as(user).get('/api/addresses')).body.items).toEqual([]);
  });

  it('another customer’s saved address is not usable [404] and not listed', async () => {
    const owner = await newUser('adr-owner');
    const thief = await newUser('adr-thief');
    await addToBasket(owner, DUNE, 1);
    await chooseAddress(owner, { address: { ...ADDRESS, save_to_address_book: true } });
    const [{ id }] = (await as(owner).get('/api/addresses')).body.items;

    await addToBasket(thief, DUNE, 1);
    expect(expectContract(await as(thief).post('/api/checkout/address').send({ address_id: id }), 'POST', '/api/checkout/address').status).toBe(404);
    expect((await as(thief).get('/api/addresses')).body.items).toEqual([]);
  });

  it('an empty basket cannot be checked out [409]', async () => {
    const user = await newUser('adr-empty');
    const res = expectContract(await as(user).post('/api/checkout/address').send({ address: ADDRESS }), 'POST', '/api/checkout/address');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BASKET_EMPTY');
  });

  it.each([
    ['no address at all', {}],
    ['lower-case country code', { address: { ...ADDRESS, country_code: 'us' } }],
    ['missing street', { address: { ...ADDRESS, line1: '' } }],
    ['both id and address', { address_id: 1, address: ADDRESS }],
    ['unknown address field', { address: { ...ADDRESS, admin: true } }],
  ])('rejects %s [400]', async (_name, body) => {
    const user = await newUser('adr-val');
    await addToBasket(user, DUNE, 1);
    expect(expectContract(await as(user).post('/api/checkout/address').send(body), 'POST', '/api/checkout/address').status).toBe(400);
  });
});

describe('CHK-02 gift points redemption', () => {
  it('the summary shows balance, point value and the most points that can be used', async () => {
    const user = await newUser('gp-sum');
    await grantGiftPoints(user, 5000);
    await addToBasket(user, DUNE, 1); // $9.99 of books
    const summary = await chooseAddress(user);
    expect(summary).toMatchObject({ gift_points_balance: 5000, gift_point_value: '0.01', max_redeemable_points: 999 });
  });

  it('a customer with no points can redeem none', async () => {
    const user = await newUser('gp-none');
    await addToBasket(user, DUNE, 1);
    expect((await chooseAddress(user)).max_redeemable_points).toBe(0);
  });

  it('points reduce the total and the card is charged only the remainder', async () => {
    const user = await newUser('gp-split');
    await grantGiftPoints(user, 1000);
    await addToBasket(user, DUNE, 2); // 19.98 + 4.99 shipping = 24.97
    await chooseAddress(user);

    const res = expectContract(await pay(user, { gift_points_to_redeem: 500, card: VISA }), 'POST', '/api/checkout/payment');
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ status: 'paid', discount_amount: '5.00', total_amount: '19.97', gift_points_redeemed: 500 });
    expect(res.body.payment).toMatchObject({ status: 'captured', amount: '19.97' });
    expect(res.body).toMatchObject({ gift_points_redeemed: 500, gift_points_balance: 500 });
    expect(await pointsBalance(user)).toBe(500);
  });

  it('points can pay for books but never shipping: a physical order still needs a card [422]', async () => {
    const user = await newUser('gp-ship');
    await grantGiftPoints(user, 5000);
    await addToBasket(user, DUNE, 1); // 9.99 + 4.99
    await chooseAddress(user);
    const res = expectContract(await pay(user, { gift_points_to_redeem: 999 }), 'POST', '/api/checkout/payment');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PAYMENT_METHOD_REQUIRED');
    expect(await ordersOf(user)).toBe(0);
    expect(await pointsBalance(user)).toBe(5000);
  });

  it('points alone can pay for a digital order: no card, no payment record', async () => {
    const user = await newUser('gp-digital');
    await grantGiftPoints(user, 4000);
    await addToBasket(user, EBOOK, 1); // $29.99, free shipping
    await chooseAddress(user);
    const res = expectContract(await pay(user, { gift_points_to_redeem: 2999 }), 'POST', '/api/checkout/payment');
    expect(res.status).toBe(201);
    expect(res.body.payment).toBeNull();
    expect(res.body.order).toMatchObject({ status: 'paid', total_amount: '0.00', gift_points_redeemed: 2999 });
    expect(res.body.gift_points_balance).toBe(1001);
    expect(Number((await db().query('SELECT count(*) FROM payments WHERE order_id = $1', [res.body.order.id])).rows[0].count)).toBe(0);
  });

  it('a card sent when points already cover everything is refused [422]', async () => {
    const user = await newUser('gp-extra');
    await grantGiftPoints(user, 5000);
    await addToBasket(user, EBOOK, 1);
    await chooseAddress(user);
    const res = await pay(user, { gift_points_to_redeem: 2999, card: VISA });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CARD_NOT_REQUIRED');
    expect(await pointsBalance(user)).toBe(5000);
  });

  it('cannot redeem more than the balance [422]', async () => {
    const user = await newUser('gp-poor');
    await grantGiftPoints(user, 100);
    await addToBasket(user, DUNE, 1);
    await chooseAddress(user);
    const res = await pay(user, { gift_points_to_redeem: 101, card: VISA });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INSUFFICIENT_GIFT_POINTS');
  });

  it('cannot redeem more than the value of the books [422]', async () => {
    const user = await newUser('gp-over');
    await grantGiftPoints(user, 5000);
    await addToBasket(user, DUNE, 1); // $9.99
    await chooseAddress(user);
    const res = await pay(user, { gift_points_to_redeem: 1000, card: VISA }); // $10.00
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GIFT_POINTS_EXCEED_SUBTOTAL');
    expect(await ordersOf(user)).toBe(0);
    expect(await pointsBalance(user)).toBe(5000);
  });

  it.each([
    ['negative points', { gift_points_to_redeem: -5, card: VISA }],
    ['fractional points', { gift_points_to_redeem: 1.5, card: VISA }],
    ['points as text', { gift_points_to_redeem: '500', card: VISA }],
  ])('rejects %s [400]', async (_name, body) => {
    const user = await newUser('gp-val');
    await addToBasket(user, DUNE, 1);
    await chooseAddress(user);
    expect(expectContract(await pay(user, body), 'POST', '/api/checkout/payment').status).toBe(400);
  });

  it('two simultaneous checkouts can never spend the same points twice', async () => {
    const user = await newUser('gp-race');
    await grantGiftPoints(user, 800);
    await addToBasket(user, EBOOK, 1);
    await chooseAddress(user);
    const attempts = await Promise.all([1, 2].map(() => pay(user, { gift_points_to_redeem: 800, card: VISA })));
    expect(attempts.filter((r) => r.status === 201).length).toBeLessThanOrEqual(1);
    expect(await pointsBalance(user)).toBeGreaterThanOrEqual(0);
    expect(await ordersOf(user)).toBeLessThanOrEqual(1);
  });
});

describe('CHK-03 payment and order confirmation', () => {
  it('a credit-card payment creates a paid order and returns the confirmation', async () => {
    const user = await newUser('pay-ok');
    await addToBasket(user, DUNE, 2);
    await chooseAddress(user);
    const stockBefore = await stockOf(DUNE);

    const res = expectContract(await pay(user, { card: VISA }), 'POST', '/api/checkout/payment');
    expect(res.status).toBe(201);
    const { order, payment } = res.body;
    expect(order).toMatchObject({ status: 'paid', subtotal_amount: '19.98', shipping_amount: '4.99', total_amount: '24.97', gift_points_redeemed: 0, can_cancel: true, can_reorder: true });
    expect(order.order_number).toMatch(/^BK-\d{10}$/);
    expect(order.items).toMatchObject([{ sku: DUNE, quantity: 2, unit_price: '9.99', line_total: '19.98' }]);
    expect(order.shipping_address.city).toBe('Testville');
    expect(payment).toMatchObject({ status: 'captured', method: 'card', amount: '24.97', card_brand: 'visa', card_last4: '4242', card_type: 'credit' });

    expect(await stockOf(DUNE)).toBe(stockBefore - 2);
    expect((await as(user).get('/api/basket')).body.items).toEqual([]); // basket emptied
  });

  it('a debit card is recorded as debit', async () => {
    const user = await newUser('pay-debit');
    const result = await placeOrder(user, [[DUNE, 1]], { card: DEBIT });
    expect(result.payment).toMatchObject({ card_type: 'debit', card_brand: 'mastercard', card_last4: '0005' });
  });

  it('the confirmation appears in the order history immediately', async () => {
    const user = await newUser('pay-hist');
    const { order } = await placeOrder(user, [[DUNE, 1]]);
    const history = expectContract(await as(user).get(`/api/users/${user.id}/orders`), 'GET', '/api/users/{id}/orders');
    expect(history.body.items.map((o) => o.id)).toEqual([order.id]);
  });

  it('never stores or echoes the card token or any card number', async () => {
    const user = await newUser('pay-secret');
    await addToBasket(user, DUNE, 1);
    await chooseAddress(user);
    const res = await pay(user, { card: VISA });
    expect(JSON.stringify(res.body)).not.toContain('tok_visa');
    const { rows } = await db().query('SELECT * FROM payments WHERE order_id = $1', [res.body.order.id]);
    expect(JSON.stringify(rows)).not.toContain('tok_visa');
    expect(Object.keys(rows[0])).not.toEqual(expect.arrayContaining(['card_number', 'cvv', 'pan']));
  });

  it('later catalogue price changes do not alter a placed order', async () => {
    const user = await newUser('pay-snap');
    const { order } = await placeOrder(user, [[DUNE, 1]]);
    await db().query("UPDATE products SET price = 99.00 WHERE sku = $1", [DUNE]);
    try {
      const history = await as(user).get(`/api/users/${user.id}/orders`);
      expect(history.body.items[0].items[0].unit_price).toBe('9.99');
      expect(history.body.items[0].total_amount).toBe(order.total_amount);
    } finally {
      await db().query("UPDATE products SET price = 9.99 WHERE sku = $1", [DUNE]);
    }
  });

  it('a declined card creates no order, keeps the basket, stock and points untouched [402]', async () => {
    const user = await newUser('pay-decl');
    await grantGiftPoints(user, 500);
    await addToBasket(user, DUNE, 1);
    await chooseAddress(user);
    const stockBefore = await stockOf(DUNE);

    const res = expectContract(await pay(user, { gift_points_to_redeem: 300, card: DECLINED }), 'POST', '/api/checkout/payment');
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('PAYMENT_DECLINED');
    expect(await ordersOf(user)).toBe(0);
    expect(await stockOf(DUNE)).toBe(stockBefore);
    expect(await pointsBalance(user)).toBe(500);
    expect((await as(user).get('/api/basket')).body.item_count).toBe(1);
  });

  it('after a decline the customer can pay again with another card', async () => {
    const user = await newUser('pay-retry');
    await addToBasket(user, DUNE, 1);
    await chooseAddress(user);
    expect((await pay(user, { card: DECLINED })).status).toBe(402);
    expect((await pay(user, { card: VISA })).status).toBe(201);
  });

  it('a payment-provider outage is a generic 502 and creates nothing', async () => {
    const user = await newUser('pay-down');
    await addToBasket(user, DUNE, 1);
    await chooseAddress(user);
    const res = expectContract(await pay(user, { card: PROVIDER_DOWN }), 'POST', '/api/checkout/payment');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/mock|unavailable|stack/i);
    expect(await ordersOf(user)).toBe(0);
  });

  it('checkout steps are enforced: basket, then address, then payment', async () => {
    const user = await newUser('pay-order');
    expect((await pay(user, { card: VISA })).body.code).toBe('BASKET_EMPTY');
    await addToBasket(user, DUNE, 1);
    const noAddress = expectContract(await pay(user, { card: VISA }), 'POST', '/api/checkout/payment');
    expect(noAddress.status).toBe(409);
    expect(noAddress.body.code).toBe('ADDRESS_REQUIRED');
  });

  it('raw card data is rejected outright [400]', async () => {
    const user = await newUser('pay-raw');
    await addToBasket(user, DUNE, 1);
    await chooseAddress(user);
    const res = await pay(user, { card: { ...VISA, number: '4242424242424242', cvv: '123', expiry: '12/30' } });
    expect(res.status).toBe(400);
    expect(await ordersOf(user)).toBe(0);
  });

  it.each([
    ['empty body', {}],
    ['unknown card type', { card: { payment_token: 'tok_visa_4242', card_type: 'gold' } }],
    ['token with illegal characters', { card: { payment_token: 'bad token!', card_type: 'debit' } }],
    ['unknown top-level field', { card: VISA, discount: 100 }],
  ])('rejects %s [400]', async (_name, body) => {
    const user = await newUser('pay-val');
    await addToBasket(user, DUNE, 1);
    await chooseAddress(user);
    expect(expectContract(await pay(user, body), 'POST', '/api/checkout/payment').status).toBe(400);
  });
});

describe('CHK-04 payment confirmation is safe to retry (Idempotency-Key)', () => {
  it('requires a well-formed key [400]', async () => {
    const user = await newUser('idem-req');
    await addToBasket(user, DUNE, 1);
    await chooseAddress(user);
    expect((await as(user).post('/api/checkout/payment').send({ card: VISA })).status).toBe(400);
    expect((await pay(user, { card: VISA }, 'short')).status).toBe(400);
    expect(await ordersOf(user)).toBe(0);
  });

  it('replaying the same request returns the same order and charges once', async () => {
    const user = await newUser('idem-replay');
    await addToBasket(user, DUNE, 1);
    await chooseAddress(user);
    const key = idempotencyKey();
    const first = await pay(user, { card: VISA }, key);
    const second = await pay(user, { card: VISA }, key);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.body.order.id).toBe(first.body.order.id);
    expect(second.body.payment.id).toBe(first.body.payment.id);
    expect(await ordersOf(user)).toBe(1);
  });

  it('reusing a key for a different request is rejected [422]', async () => {
    const user = await newUser('idem-diff');
    await addToBasket(user, DUNE, 1);
    await chooseAddress(user);
    const key = idempotencyKey();
    await pay(user, { card: VISA }, key);
    const res = await pay(user, { card: DEBIT }, key);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a double click (two identical simultaneous requests) creates exactly one order', async () => {
    const user = await newUser('idem-race');
    await addToBasket(user, DUNE, 1);
    await chooseAddress(user);
    const key = idempotencyKey();
    const results = await Promise.all([pay(user, { card: VISA }, key), pay(user, { card: VISA }, key)]);
    expect(results.map((r) => r.status).every((s) => [201, 409].includes(s))).toBe(true);
    expect(await ordersOf(user)).toBe(1);
  });

  it('a failed attempt can be retried with the same key', async () => {
    const user = await newUser('idem-fail');
    await addToBasket(user, DUNE, 1);
    await chooseAddress(user);
    const key = idempotencyKey();
    expect((await pay(user, { card: DECLINED }, key)).status).toBe(402);
    expect((await pay(user, { card: DECLINED }, key)).status).toBe(402);
    expect(await ordersOf(user)).toBe(0);
  });

  it('two customers cannot buy the last copy together (no overselling)', async () => {
    await db().query("UPDATE products SET stock_quantity = 1 WHERE sku = $1", [DUNE]);
    try {
      const [a, b] = await Promise.all([newUser('last-a'), newUser('last-b')]);
      for (const u of [a, b]) {
        await addToBasket(u, DUNE, 1);
        await chooseAddress(u);
      }
      const results = await Promise.all([pay(a, { card: VISA }), pay(b, { card: VISA })]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await stockOf(DUNE)).toBe(0);
    } finally {
      await db().query("UPDATE products SET stock_quantity = 300 WHERE sku = $1", [DUNE]);
    }
  });
});
