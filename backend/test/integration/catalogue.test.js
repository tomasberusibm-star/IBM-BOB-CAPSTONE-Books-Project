import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startHarness } from '../helpers/harness.js';

let h;
const iso = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

before(async () => {
  h = await startHarness();
});
after(() => h.stop());

describe('categories and brands', () => {
  it('returns the category tree', async () => {
    const res = await h.api('GET', '/api/categories');
    assert.equal(res.status, 200);
    const tech = res.body.items.find((c) => c.slug === 'non-fiction').children.find((c) => c.slug === 'technology');
    assert.deepEqual(tech.children.map((c) => c.slug).sort(), ['databases', 'software-engineering']);
  });

  it('lists brands', async () => {
    const res = await h.api('GET', '/api/brands');
    assert.deepEqual(res.body.items.map((b) => b.slug).sort(), ['ace', 'oreilly', 'pearson']);
  });
});

describe('product filtering', () => {
  const skus = (res) => res.body.items.map((p) => p.sku);

  it('filters by category including subcategories by default', async () => {
    const nonFiction = (await h.pool.query("SELECT id FROM categories WHERE slug = 'non-fiction'")).rows[0].id;
    const all = await h.api('GET', `/api/categories/${nonFiction}/products`);
    assert.equal(all.status, 200);
    assert.deepEqual(skus(all).sort(), ['BK-CLEANCODE-001', 'BK-DDIA-001', 'BK-DDIA-EB', 'BK-PGUR-001', 'BK-PRAGPROG-EB']);

    const direct = await h.api('GET', `/api/categories/${nonFiction}/products?include_subcategories=false`);
    assert.equal(direct.body.total_items, 0); // products only sit in leaf categories
  });

  it('filters by brand (repeated and comma-separated)', async () => {
    assert.deepEqual(skus(await h.api('GET', '/api/products?brand=ace')).sort(), ['BK-DUNE-001', 'BK-NEURO-001']);
    const two = await h.api('GET', '/api/products?brand=ace,pearson');
    assert.equal(two.body.total_items, 4);
    const two2 = await h.api('GET', '/api/products?brand=ace&brand=pearson');
    assert.equal(two2.body.total_items, 4);
  });

  it('combines category and brand filters', async () => {
    const databases = (await h.pool.query("SELECT id FROM categories WHERE slug = 'databases'")).rows[0].id;
    const res = await h.api('GET', `/api/categories/${databases}/products?brand=oreilly&sort=price_asc`);
    assert.deepEqual(skus(res), ['BK-DDIA-EB', 'BK-PGUR-001', 'BK-DDIA-001']);
    const none = await h.api('GET', `/api/categories/${databases}/products?brand=ace`);
    assert.equal(none.body.total_items, 0);
  });

  it('supports full-text search, sorting and pagination', async () => {
    assert.deepEqual(skus(await h.api('GET', '/api/products?q=cyberpunk')), ['BK-NEURO-001']);
    const p1 = await h.api('GET', '/api/products?sort=price_desc&page=1&page_size=3');
    assert.equal(p1.body.total_items, 7);
    assert.equal(p1.body.total_pages, 3);
    assert.deepEqual(skus(p1), ['BK-DDIA-001', 'BK-CLEANCODE-001', 'BK-PRAGPROG-EB']);
    const p3 = await h.api('GET', '/api/products?sort=price_desc&page=3&page_size=3');
    assert.equal(p3.body.items.length, 1);
  });

  it('404s for an unknown category and 400s for bad parameters', async () => {
    assert.equal((await h.api('GET', '/api/categories/99999/products')).status, 404);
    assert.equal((await h.api('GET', '/api/products?page_size=1000')).status, 400);
    assert.equal((await h.api('GET', '/api/products?sort=evil;DROP')).status, 400);
    assert.equal((await h.api('GET', "/api/products?brand=ace';--")).status, 400);
    assert.equal((await h.api('GET', '/api/products?deliver_by=tomorrow')).status, 400);
  });

  it('treats SQL metacharacters in search text as plain text', async () => {
    const res = await h.api('GET', `/api/products?q=${encodeURIComponent("'; DROP TABLE products; --")}`);
    assert.equal(res.status, 200);
    assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM products')).rows[0].n, 7);
  });
});

describe('tentative delivery date logic', () => {
  const find = async (sku) => (await h.api('GET', `/api/products/${await h.sku(sku)}`)).body;

  it('instant for e-books (stock not tracked): null date, always available', async () => {
    const p = await find('BK-DDIA-EB');
    assert.equal(p.tentative_delivery_date, null);
    assert.equal(p.availability, 'always_available');
  });

  it('in stock with a future stored date: shows the stored date', async () => {
    await h.pool.query("UPDATE products SET tentative_delivery_date = CURRENT_DATE + 6 WHERE sku = 'BK-DUNE-001'");
    const p = await find('BK-DUNE-001');
    assert.equal(p.tentative_delivery_date, iso(6));
    assert.equal(p.availability, 'in_stock');
  });

  it('in stock with a stale (past) stored date: falls back to today + lead days', async () => {
    await h.pool.query("UPDATE products SET tentative_delivery_date = CURRENT_DATE - 10 WHERE sku = 'BK-NEURO-001'");
    assert.equal((await find('BK-NEURO-001')).tentative_delivery_date, iso(2));
    await h.pool.query("UPDATE products SET tentative_delivery_date = NULL WHERE sku = 'BK-NEURO-001'");
    assert.equal((await find('BK-NEURO-001')).tentative_delivery_date, iso(2));
  });

  it('out of stock: restock date when known, otherwise null', async () => {
    const p = await find('BK-PGUR-001');
    assert.equal(p.availability, 'out_of_stock');
    assert.equal(p.tentative_delivery_date, iso(21));
    await h.pool.query("UPDATE products SET tentative_delivery_date = CURRENT_DATE - 1 WHERE sku = 'BK-PGUR-001'");
    assert.equal((await find('BK-PGUR-001')).tentative_delivery_date, null);
    await h.pool.query("UPDATE products SET tentative_delivery_date = CURRENT_DATE + 21 WHERE sku = 'BK-PGUR-001'");
  });

  it('reports low_stock at or below the threshold', async () => {
    await h.pool.query("UPDATE products SET stock_quantity = 5 WHERE sku = 'BK-CLEANCODE-001'");
    assert.equal((await find('BK-CLEANCODE-001')).availability, 'low_stock');
    await h.pool.query("UPDATE products SET stock_quantity = 80 WHERE sku = 'BK-CLEANCODE-001'");
  });

  it('filters with deliver_by and available_only; sorts by delivery', async () => {
    await h.pool.query("UPDATE products SET tentative_delivery_date = CURRENT_DATE + 6 WHERE sku = 'BK-DUNE-001'");
    const within3 = await h.api('GET', `/api/products?deliver_by=${iso(3)}&sort=delivery`);
    const s = within3.body.items.map((p) => p.sku);
    assert.ok(s.includes('BK-DDIA-EB') && s.includes('BK-PRAGPROG-EB'), 'instant items always qualify');
    assert.ok(!s.includes('BK-DUNE-001'), 'dated 6 days out: too late');
    assert.ok(!s.includes('BK-PGUR-001'), 'out of stock for 21 days: too late');
    assert.ok(s.includes('BK-NEURO-001'));
    assert.ok(['BK-DDIA-EB', 'BK-PRAGPROG-EB'].includes(s[0]), 'instant items sort first');

    const avail = await h.api('GET', '/api/products?available_only=true');
    assert.ok(!avail.body.items.some((p) => p.sku === 'BK-PGUR-001'));
  });
});

describe('product detail and related products', () => {
  it('returns brand, categories and no stock counts', async () => {
    const p = (await h.api('GET', `/api/products/${await h.sku('BK-DDIA-001')}`)).body;
    assert.equal(p.brand.slug, 'oreilly');
    assert.equal(p.currency, 'USD');
    assert.deepEqual(p.categories.map((c) => c.slug), ['databases', 'software-engineering']);
    assert.equal(p.categories[0].is_primary, true);
    assert.ok(!('stock_quantity' in p));
  });

  it('404s for unknown and inactive products', async () => {
    assert.equal((await h.api('GET', '/api/products/999999')).status, 404);
    await h.pool.query("UPDATE products SET is_active = false WHERE sku = 'BK-NEURO-001'");
    assert.equal((await h.api('GET', `/api/products/${await h.sku('BK-NEURO-001')}`)).status, 404);
    await h.pool.query("UPDATE products SET is_active = true WHERE sku = 'BK-NEURO-001'");
  });

  it('lists related products, optionally by relation', async () => {
    const id = await h.sku('BK-DDIA-001');
    const all = await h.api('GET', `/api/products/${id}/related`);
    assert.deepEqual(all.body.items.map((i) => i.relation).sort(), ['other_format', 'similar']);
    const one = await h.api('GET', `/api/products/${id}/related?relation=other_format`);
    assert.equal(one.body.items.length, 1);
    assert.equal(one.body.items[0].product.sku, 'BK-DDIA-EB');
    assert.equal((await h.api('GET', `/api/products/${id}/related?relation=bogus`)).status, 400);
    assert.equal((await h.api('GET', '/api/products/999999/related')).status, 404);
  });
});

describe('recommendations', () => {
  /** Inserts a paid order directly - recommendations only read order history. */
  async function seedPurchase(user, skus, status = 'delivered') {
    const { rows } = await h.pool.query(
      `INSERT INTO orders (user_id, shipping_address_snapshot, status, subtotal_amount, total_amount)
       VALUES ($1, '{}', $2, 10, 10) RETURNING id`,
      [user.id, status],
    );
    for (const s of skus) {
      await h.pool.query(
        `INSERT INTO order_items (order_id, product_id, product_sku, product_title, unit_price, quantity)
         SELECT $1, id, sku, title, price, 1 FROM products WHERE sku = $2`,
        [rows[0].id, s],
      );
    }
  }

  it('requires authentication', async () => {
    assert.equal((await h.api('GET', '/api/recommendations')).status, 401);
  });

  it('returns nothing for a user without purchases', async () => {
    const u = await h.newUser('rec0');
    assert.deepEqual((await h.api('GET', '/api/recommendations', { token: u.token })).body.items, []);
  });

  it('suggests related and same-category books, never ones already bought', async () => {
    const u = await h.newUser('rec1');
    await seedPurchase(u, ['BK-DUNE-001']);
    const res = await h.api('GET', '/api/recommendations', { token: u.token });
    assert.equal(res.status, 200);
    const items = res.body.items;
    assert.ok(!items.some((i) => i.product.sku === 'BK-DUNE-001'));
    const neuro = items.find((i) => i.product.sku === 'BK-NEURO-001');
    assert.ok(neuro, 'curated also_bought + same category');
    assert.equal(neuro.reason, 'related_to_purchase');
    assert.equal(neuro.based_on_product_id, await h.sku('BK-DUNE-001'));
    assert.equal(items[0].product.sku, 'BK-NEURO-001', 'strongest signal first');
    // Books from unrelated categories appear only through the weaker collaborative signal
    // (seeded customer Alice bought Dune together with them) and rank below the curated match.
    for (const sku of ['BK-CLEANCODE-001', 'BK-DDIA-001']) {
      const i = items.find((x) => x.product.sku === sku);
      assert.equal(i?.reason, 'popular_with_similar_customers', sku);
    }
  });

  it('ignores unpaid and cancelled orders', async () => {
    const u = await h.newUser('rec2');
    await seedPurchase(u, ['BK-DUNE-001'], 'cancelled');
    await seedPurchase(u, ['BK-DUNE-001'], 'pending_payment');
    assert.deepEqual((await h.api('GET', '/api/recommendations', { token: u.token })).body.items, []);
  });

  it('adds collaborative signal from other customers and skips out-of-stock items', async () => {
    const other = await h.newUser('recOther');
    await seedPurchase(other, ['BK-CLEANCODE-001', 'BK-NEURO-001']);
    const u = await h.newUser('rec3');
    await seedPurchase(u, ['BK-CLEANCODE-001']);
    const res = await h.api('GET', '/api/recommendations', { token: u.token });
    const neuro = res.body.items.find((i) => i.product.sku === 'BK-NEURO-001');
    assert.ok(neuro);
    assert.equal(neuro.reason, 'popular_with_similar_customers');
    assert.ok(!res.body.items.some((i) => i.product.sku === 'BK-PGUR-001'), 'out of stock is never recommended');

    // only aggregates leave the database - no other customer's data
    assert.ok(!JSON.stringify(res.body).includes(other.email));
  });

  it('honours limit and validates it', async () => {
    const u = await h.newUser('rec4');
    await seedPurchase(u, ['BK-DDIA-001', 'BK-DUNE-001']);
    const res = await h.api('GET', '/api/recommendations?limit=1', { token: u.token });
    assert.equal(res.body.items.length, 1);
    assert.equal((await h.api('GET', '/api/recommendations?limit=0', { token: u.token })).status, 400);
  });
});
