import { afterAll, describe, expect, it } from '@jest/globals';
import { expectContract } from '../support/contract.js';
import { as, closeDb, db, http, newUser, productId } from '../support/world.js';

afterAll(closeDb);

const get = async (url, apiPath) => expectContract(await http().get(url), 'GET', apiPath);
const skus = (res) => res.body.items.map((p) => p.sku);
const categoryId = async (slug) => Number((await db().query('SELECT id FROM categories WHERE slug = $1', [slug])).rows[0].id);
const isoDay = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('CAT-01 categories and brands', () => {
  it('returns the category tree, nested', async () => {
    const res = await get('/api/categories', '/api/categories');
    expect(res.status).toBe(200);
    const nonFiction = res.body.items.find((c) => c.slug === 'non-fiction');
    const technology = nonFiction.children.find((c) => c.slug === 'technology');
    expect(technology.children.map((c) => c.slug).sort()).toEqual(['databases', 'software-engineering']);
    expect(res.body.items.find((c) => c.slug === 'fiction').children.map((c) => c.slug)).toEqual(['science-fiction']);
  });

  it('lists brands for the brand browser', async () => {
    const res = await get('/api/brands', '/api/brands');
    expect(res.body.items.map((b) => b.slug).sort()).toEqual(['ace', 'oreilly', 'pearson']);
  });

  it('is public: no token is needed to browse', async () => {
    for (const url of ['/api/categories', '/api/brands', '/api/products']) expect((await http().get(url)).status).toBe(200);
  });
});

describe('CAT-02 category filtering', () => {
  it('a parent category includes every book in its sub-categories (default)', async () => {
    const res = await get(`/api/categories/${await categoryId('non-fiction')}/products`, '/api/categories/{id}/products');
    expect(skus(res).sort()).toEqual(['BK-CLEANCODE-001', 'BK-DDIA-001', 'BK-DDIA-EB', 'BK-PGUR-001', 'BK-PRAGPROG-EB']);
  });

  it('can be restricted to the category itself with include_subcategories=false', async () => {
    const res = await get(`/api/categories/${await categoryId('non-fiction')}/products?include_subcategories=false`, '/api/categories/{id}/products');
    expect(res.body.total_items).toBe(0);
  });

  it('a leaf category returns only its own books', async () => {
    const res = await get(`/api/categories/${await categoryId('science-fiction')}/products?sort=title`, '/api/categories/{id}/products');
    expect(skus(res)).toEqual(['BK-DUNE-001', 'BK-NEURO-001']);
  });

  it('GET /api/products?category_id= gives the same result as the nested route', async () => {
    const id = await categoryId('databases');
    const nested = await get(`/api/categories/${id}/products`, '/api/categories/{id}/products');
    const flat = await get(`/api/products?category_id=${id}`, '/api/products');
    expect(skus(flat).sort()).toEqual(skus(nested).sort());
  });

  it('an unknown category is 404, a malformed id is 400', async () => {
    expect(expectContract(await http().get('/api/categories/99999/products'), 'GET', '/api/categories/{id}/products').status).toBe(404);
    expect(expectContract(await http().get('/api/categories/abc/products'), 'GET', '/api/categories/{id}/products').status).toBe(400);
  });
});

describe('CAT-03 brand browsing and combined filters', () => {
  it('filters by one brand', async () => {
    expect(skus(await get('/api/products?brand=ace', '/api/products')).sort()).toEqual(['BK-DUNE-001', 'BK-NEURO-001']);
  });

  it('accepts several brands, repeated or comma separated', async () => {
    const repeated = await get('/api/products?brand=ace&brand=pearson', '/api/products');
    const comma = await get('/api/products?brand=ace,pearson', '/api/products');
    expect(repeated.body.total_items).toBe(4);
    expect(skus(comma).sort()).toEqual(skus(repeated).sort());
  });

  it('combines category and brand (AND)', async () => {
    const databases = await categoryId('databases');
    const res = await get(`/api/categories/${databases}/products?brand=oreilly&sort=price_asc`, '/api/categories/{id}/products');
    expect(skus(res)).toEqual(['BK-DDIA-EB', 'BK-PGUR-001', 'BK-DDIA-001']);
    const none = await get(`/api/categories/${databases}/products?brand=ace`, '/api/categories/{id}/products');
    expect(none.body.items).toEqual([]);
  });

  it('every product carries the fields the product grid needs', async () => {
    const res = await get('/api/products', '/api/products');
    for (const p of res.body.items) {
      expect(p).toEqual(expect.objectContaining({ id: expect.any(Number), title: expect.any(String), price: expect.stringMatching(/^\d+\.\d{2}$/), currency: 'USD' }));
      expect(['in_stock', 'low_stock', 'out_of_stock', 'always_available']).toContain(p.availability);
      expect('tentative_delivery_date' in p).toBe(true);
    }
  });
});

describe('CAT-04 search, sorting and pagination', () => {
  it('full-text search matches title and description', async () => {
    expect(skus(await get('/api/products?q=cyberpunk', '/api/products'))).toEqual(['BK-NEURO-001']);
    expect((await get('/api/products?q=zzzznomatch', '/api/products')).body.items).toEqual([]);
  });

  it.each([
    ['price_asc', (a, b) => Number(a.price) - Number(b.price)],
    ['price_desc', (a, b) => Number(b.price) - Number(a.price)],
    ['title', (a, b) => a.title.localeCompare(b.title)],
  ])('sorts by %s', async (sort, compare) => {
    const items = (await get(`/api/products?sort=${sort}`, '/api/products')).body.items;
    const sorted = [...items].sort(compare);
    expect(items.map((p) => p.sku)).toEqual(sorted.map((p) => p.sku));
  });

  it('paginates with consistent totals and no overlap', async () => {
    const p1 = await get('/api/products?sort=price_desc&page=1&page_size=3', '/api/products');
    const p2 = await get('/api/products?sort=price_desc&page=2&page_size=3', '/api/products');
    const p3 = await get('/api/products?sort=price_desc&page=3&page_size=3', '/api/products');
    expect([p1.body.total_items, p1.body.total_pages, p1.body.page_size]).toEqual([7, 3, 3]);
    const all = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((p) => p.sku);
    expect(new Set(all).size).toBe(7);
    expect(p3.body.items).toHaveLength(1);
  });

  it.each([
    ['page_size above the limit', 'page_size=1000'],
    ['page 0', 'page=0'],
    ['unknown sort', 'sort=cheapest'],
    ['SQL in sort', 'sort=title;DROP TABLE products'],
    ['SQL in brand', "brand=ace';--"],
    ['non-date deliver_by', 'deliver_by=tomorrow'],
    ['non-boolean available_only', 'available_only=maybe'],
  ])('rejects %s [400]', async (_name, query) => {
    const res = expectContract(await http().get(`/api/products?${query}`), 'GET', '/api/products');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('treats SQL metacharacters in search text as plain text', async () => {
    const before = Number((await db().query('SELECT count(*) FROM products')).rows[0].count);
    const res = await get(`/api/products?q=${encodeURIComponent("'; DROP TABLE products; --")}`, '/api/products');
    expect(res.status).toBe(200);
    expect(Number((await db().query('SELECT count(*) FROM products')).rows[0].count)).toBe(before);
  });
});

describe('CAT-05 tentative delivery date tags', () => {
  const product = async (sku) => (await get(`/api/products/${await productId(sku)}`, '/api/products/{id}')).body;

  it('e-books are instant: no date, always available', async () => {
    const book = await product('BK-DDIA-EB');
    expect(book.tentative_delivery_date).toBeNull();
    expect(book.availability).toBe('always_available');
  });

  it('an in-stock paperback shows its stored future date', async () => {
    await db().query("UPDATE products SET tentative_delivery_date = CURRENT_DATE + 6 WHERE sku = 'BK-DUNE-001'");
    const book = await product('BK-DUNE-001');
    expect(book.availability).toBe('in_stock');
    expect(book.tentative_delivery_date).toBe(isoDay(6));
  });

  it('never shows a date in the past: falls back to today + the lead time', async () => {
    await db().query("UPDATE products SET tentative_delivery_date = CURRENT_DATE - 10 WHERE sku = 'BK-NEURO-001'");
    expect((await product('BK-NEURO-001')).tentative_delivery_date).toBe(isoDay(2));
  });

  it('an out-of-stock book shows its restock date, or null when unknown', async () => {
    const book = await product('BK-PGUR-001');
    expect(book.availability).toBe('out_of_stock');
    expect(book.tentative_delivery_date).toBe(isoDay(21));
    await db().query("UPDATE products SET tentative_delivery_date = CURRENT_DATE - 1 WHERE sku = 'BK-PGUR-001'");
    expect((await product('BK-PGUR-001')).tentative_delivery_date).toBeNull();
    await db().query("UPDATE products SET tentative_delivery_date = CURRENT_DATE + 21 WHERE sku = 'BK-PGUR-001'");
  });

  it('low stock is flagged at or below the threshold', async () => {
    await db().query("UPDATE products SET stock_quantity = 3 WHERE sku = 'BK-CLEANCODE-001'");
    expect((await product('BK-CLEANCODE-001')).availability).toBe('low_stock');
    await db().query("UPDATE products SET stock_quantity = 80 WHERE sku = 'BK-CLEANCODE-001'");
    expect((await product('BK-CLEANCODE-001')).availability).toBe('in_stock');
  });

  it('deliver_by keeps instant items and drops late or unknown ones; available_only hides sold-out books', async () => {
    await db().query("UPDATE products SET tentative_delivery_date = CURRENT_DATE + 6 WHERE sku = 'BK-DUNE-001'");
    const soon = skus(await get(`/api/products?deliver_by=${isoDay(3)}&sort=delivery`, '/api/products'));
    expect(soon).toEqual(expect.arrayContaining(['BK-DDIA-EB', 'BK-PRAGPROG-EB', 'BK-NEURO-001']));
    expect(soon).not.toContain('BK-DUNE-001');
    expect(soon).not.toContain('BK-PGUR-001');
    expect(['BK-DDIA-EB', 'BK-PRAGPROG-EB']).toContain(soon[0]);

    const inStock = skus(await get('/api/products?available_only=true', '/api/products'));
    expect(inStock).not.toContain('BK-PGUR-001');
  });
});

describe('CAT-06 product detail', () => {
  it('returns brand, categories and description, but never stock counts', async () => {
    const res = await get(`/api/products/${await productId('BK-DDIA-001')}`, '/api/products/{id}');
    expect(res.body.brand.slug).toBe('oreilly');
    expect(res.body.categories.map((c) => c.slug)).toEqual(['databases', 'software-engineering']);
    expect(res.body.categories[0].is_primary).toBe(true);
    expect(res.body.authors).toEqual(['Martin Kleppmann']);
    expect(res.body).not.toHaveProperty('stock_quantity');
  });

  it('unknown, malformed and withdrawn products are not served', async () => {
    expect((await get('/api/products/999999', '/api/products/{id}')).status).toBe(404);
    const id = await productId('BK-NEURO-001');
    await db().query("UPDATE products SET is_active = false WHERE id = $1", [id]);
    try {
      expect((await get(`/api/products/${id}`, '/api/products/{id}')).status).toBe(404);
      expect(skus(await get('/api/products', '/api/products'))).not.toContain('BK-NEURO-001');
    } finally {
      await db().query("UPDATE products SET is_active = true WHERE id = $1", [id]);
    }
  });
});

describe('CAT-07 related product selection', () => {
  const related = (id, query = '') => get(`/api/products/${id}/related${query}`, '/api/products/{id}/related');

  it('lists every relation configured for a book', async () => {
    const res = await related(await productId('BK-DDIA-001'));
    expect(res.body.items.map((i) => [i.relation, i.product.sku]).sort()).toEqual([
      ['other_format', 'BK-DDIA-EB'],
      ['similar', 'BK-PGUR-001'],
    ]);
  });

  it('related items are full product summaries, usable as cards (price, delivery tag)', async () => {
    const res = await related(await productId('BK-DUNE-001'));
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ relation: 'also_bought', product: { sku: 'BK-NEURO-001', price: '8.99' } });
    expect('tentative_delivery_date' in res.body.items[0].product).toBe(true);
  });

  it('can be restricted to one relation type', async () => {
    const res = await related(await productId('BK-DDIA-001'), '?relation=other_format');
    expect(res.body.items.map((i) => i.product.sku)).toEqual(['BK-DDIA-EB']);
    expect((await related(await productId('BK-DDIA-001'), '?relation=series')).body.items).toEqual([]);
  });

  it('honours limit and validates its inputs', async () => {
    const id = await productId('BK-DDIA-001');
    expect((await related(id, '?limit=1')).body.items).toHaveLength(1);
    for (const q of ['?limit=0', '?limit=51', '?relation=bogus']) expect((await related(id, q)).status).toBe(400);
  });

  it('a related book that is withdrawn disappears from the list', async () => {
    const pgur = await productId('BK-PGUR-001');
    await db().query('UPDATE products SET is_active = false WHERE id = $1', [pgur]);
    try {
      const res = await related(await productId('BK-DDIA-001'));
      expect(res.body.items.map((i) => i.product.sku)).toEqual(['BK-DDIA-EB']);
    } finally {
      await db().query('UPDATE products SET is_active = true WHERE id = $1', [pgur]);
    }
  });

  it('unknown product is 404', async () => {
    expect((await related(999999)).status).toBe(404);
  });
});

describe('CAT-08 personalised recommendations', () => {
  async function recordPurchase(user, sku, status = 'delivered') {
    const { rows } = await db().query(
      `INSERT INTO orders (user_id, shipping_address_snapshot, status, subtotal_amount, total_amount) VALUES ($1, '{}', $2, 10, 10) RETURNING id`,
      [user.dbId, status],
    );
    await db().query(
      `INSERT INTO order_items (order_id, product_id, product_sku, product_title, unit_price, quantity) SELECT $1, id, sku, title, price, 1 FROM products WHERE sku = $2`,
      [rows[0].id, sku],
    );
  }

  it('is empty for a customer with no purchases', async () => {
    const user = await newUser('rec-none');
    const res = expectContract(await as(user).get('/api/recommendations'), 'GET', '/api/recommendations');
    expect(res.body.items).toEqual([]);
  });

  it('suggests related books and never one the customer already bought', async () => {
    const user = await newUser('rec-buy');
    await recordPurchase(user, 'BK-DUNE-001');
    const res = expectContract(await as(user).get('/api/recommendations'), 'GET', '/api/recommendations');
    const suggested = res.body.items.map((i) => i.product.sku);
    expect(suggested).toContain('BK-NEURO-001');
    expect(suggested).not.toContain('BK-DUNE-001');
  });

  it('ignores cancelled orders', async () => {
    const user = await newUser('rec-cancel');
    await recordPurchase(user, 'BK-DUNE-001', 'cancelled');
    expect((await as(user).get('/api/recommendations')).body.items).toEqual([]);
  });

  it('validates limit', async () => {
    const user = await newUser('rec-limit');
    expect(expectContract(await as(user).get('/api/recommendations?limit=0'), 'GET', '/api/recommendations').status).toBe(400);
    expect(expectContract(await as(user).get('/api/recommendations?limit=51'), 'GET', '/api/recommendations').status).toBe(400);
  });
});
