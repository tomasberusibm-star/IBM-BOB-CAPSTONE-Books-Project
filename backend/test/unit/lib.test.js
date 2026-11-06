import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { fromCents, toCents } from '../../src/lib/money.js';
import { priceOrder } from '../../src/lib/pricing.js';
import { createMockProvider } from '../../src/payments/provider.js';

describe('money', () => {
  it('converts decimal strings to integer cents and back without float error', () => {
    assert.equal(toCents('44.99'), 4499);
    assert.equal(toCents('0.1'), 10);
    assert.equal(toCents('7'), 700);
    assert.equal(fromCents(4499), '44.99');
    assert.equal(fromCents(5), '0.05');
    assert.equal(fromCents(toCents('19.99') * 3), '59.97');
  });

  it('rejects malformed amounts', () => {
    for (const bad of ['', '-1', '1.234', 'abc', '1e3']) assert.throws(() => toCents(bad), TypeError);
    assert.throws(() => fromCents(-1), RangeError);
    assert.throws(() => fromCents(1.5), RangeError);
  });
});

describe('priceOrder', () => {
  const cfg = { shippingFlatCents: 499, freeShippingThresholdCents: 5000, taxRateBps: 0 };

  it('charges flat shipping for a small physical basket', () => {
    const p = priceOrder([{ price: '9.99', quantity: 2, format: 'paperback' }], cfg);
    assert.deepEqual(p, { subtotal: 1998, shipping: 499, tax: 0, total: 2497 });
  });

  it('ships free at or above the threshold', () => {
    const p = priceOrder([{ price: '50.00', quantity: 1, format: 'hardcover' }], cfg);
    assert.equal(p.shipping, 0);
  });

  it('never charges shipping for digital-only baskets', () => {
    const p = priceOrder([{ price: '5.00', quantity: 1, format: 'ebook' }], cfg);
    assert.equal(p.shipping, 0);
    assert.equal(p.total, 500);
  });

  it('applies tax in basis points, rounded half up', () => {
    const p = priceOrder([{ price: '10.05', quantity: 1, format: 'ebook' }], { ...cfg, taxRateBps: 825 });
    assert.equal(p.tax, 83); // 1005 * 8.25% = 82.9125 -> 83
    assert.equal(p.total, 1088);
  });
});

describe('mock card processor', () => {
  it('approves valid tokens and parses brand and last4', async () => {
    const r = await createMockProvider().charge({ token: 'tok_visa_4242', amountCents: 100, idempotencyKey: 'a' });
    assert.equal(r.approved, true);
    assert.equal(r.brand, 'visa');
    assert.equal(r.last4, '4242');
  });

  it('declines tok_declined_* and fails on tok_error_*', async () => {
    const p = createMockProvider();
    assert.equal((await p.charge({ token: 'tok_declined_0002', amountCents: 100, idempotencyKey: 'b' })).approved, false);
    await assert.rejects(p.charge({ token: 'tok_error_0000', amountCents: 100, idempotencyKey: 'c' }));
  });

  it('is idempotent per key', async () => {
    const p = createMockProvider();
    const a = await p.charge({ token: 'tok_visa_4242', amountCents: 100, idempotencyKey: 'k' });
    const b = await p.charge({ token: 'tok_visa_4242', amountCents: 100, idempotencyKey: 'k' });
    assert.equal(a.reference, b.reference);
  });
});

describe('config', () => {
  const base = { DATABASE_URL: 'postgresql://u@127.0.0.1/db', JWT_SECRET: 'x'.repeat(32) };

  it('loads defaults', () => {
    const c = loadConfig(base);
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.requireEmailVerification, true);
  });

  it('refuses to bind to all interfaces', () => {
    assert.throws(() => loadConfig({ ...base, HOST: '0.0.0.0' }), /all interfaces/);
  });

  it('requires a long JWT secret and never echoes it', () => {
    assert.throws(() => loadConfig({ ...base, JWT_SECRET: 'short' }), (e) => /JWT_SECRET/.test(e.message) && !/short/.test(e.message));
  });

  it('enforces production safety rules', () => {
    assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production' }), /mock processor/);
    assert.throws(
      () => loadConfig({ ...base, NODE_ENV: 'production', DATABASE_URL: 'postgresql://u@db.example.com/x' }),
      /verify-full/,
    );
  });
});
