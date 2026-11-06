-- =============================================================================
-- Sample seed data. Apply AFTER db/schema.sql:
--   psql -v ON_ERROR_STOP=1 -d <database> -f db/seed.sql
--
-- All data is fictional. The password hashes below are NOT real hashes of any
-- password - they only satisfy the format constraint. Never seed real credentials.
-- =============================================================================

BEGIN;

-- Brands (publishers) ---------------------------------------------------------
INSERT INTO brands (slug, name) VALUES
    ('oreilly',  'O''Reilly Media'),
    ('ace',      'Ace Books'),
    ('pearson',  'Pearson');

-- Categories ------------------------------------------------------------------
INSERT INTO categories (slug, name, sort_order) VALUES
    ('fiction',     'Fiction',     1),
    ('non-fiction', 'Non-Fiction', 2);

INSERT INTO categories (parent_id, slug, name, sort_order)
SELECT p.id, v.slug, v.name, v.sort_order
FROM (VALUES
    ('fiction',     'science-fiction',      'Science Fiction',      1),
    ('non-fiction', 'technology',           'Technology',           1)
) AS v(parent_slug, slug, name, sort_order)
JOIN categories p ON p.slug = v.parent_slug;

INSERT INTO categories (parent_id, slug, name, sort_order)
SELECT p.id, v.slug, v.name, v.sort_order
FROM (VALUES
    ('technology', 'databases',            'Databases',            1),
    ('technology', 'software-engineering', 'Software Engineering', 2)
) AS v(parent_slug, slug, name, sort_order)
JOIN categories p ON p.slug = v.parent_slug;

-- Products --------------------------------------------------------------------
-- tentative_delivery_date is relative to the load date so the sample never goes stale.
INSERT INTO products (sku, slug, isbn13, brand_id, title, authors, description, format,
                      price, stock_quantity, tentative_delivery_date, published_on)
SELECT v.sku, v.slug, v.isbn13, b.id, v.title, v.authors, v.description, v.format::product_format,
       v.price, v.stock, v.delivery, v.published_on
FROM (VALUES
    ('BK-DDIA-001',      'designing-data-intensive-applications',        '9781449373320', 'oreilly',
     'Designing Data-Intensive Applications', ARRAY['Martin Kleppmann'],
     'The big ideas behind reliable, scalable, and maintainable systems.', 'paperback',
     44.99, 120, CURRENT_DATE + 2, DATE '2017-03-16'),
    ('BK-DDIA-EB',       'designing-data-intensive-applications-ebook',  NULL,            'oreilly',
     'Designing Data-Intensive Applications (E-book)', ARRAY['Martin Kleppmann'],
     'Digital edition, available instantly.', 'ebook',
     29.99, NULL, NULL, DATE '2017-03-16'),
    ('BK-DUNE-001',      'dune',                                          '9780441172719', 'ace',
     'Dune', ARRAY['Frank Herbert'],
     'A landmark science fiction novel set on the desert planet Arrakis.', 'paperback',
     9.99, 300, CURRENT_DATE + 2, DATE '1990-09-01'),
    ('BK-NEURO-001',     'neuromancer',                                   '9780441569595', 'ace',
     'Neuromancer', ARRAY['William Gibson'],
     'The novel that defined cyberpunk.', 'paperback',
     8.99, 150, CURRENT_DATE + 3, DATE '1984-07-01'),
    ('BK-CLEANCODE-001', 'clean-code',                                    '9780132350884', 'pearson',
     'Clean Code', ARRAY['Robert C. Martin'],
     'A handbook of agile software craftsmanship.', 'paperback',
     39.99, 80, CURRENT_DATE + 4, DATE '2008-08-01'),
    ('BK-PRAGPROG-EB',   'the-pragmatic-programmer-ebook',                NULL,            'pearson',
     'The Pragmatic Programmer (E-book)', ARRAY['David Thomas', 'Andrew Hunt'],
     'Your journey to mastery - digital edition.', 'ebook',
     35.99, NULL, NULL, DATE '2019-09-13'),
    ('BK-PGUR-001',      'postgresql-up-and-running',                     '9781491963418', 'oreilly',
     'PostgreSQL: Up and Running', ARRAY['Regina Obe', 'Leo Hsu'],
     'A practical guide to the advanced open source database. Currently out of stock.', 'paperback',
     34.99, 0, CURRENT_DATE + 21, DATE '2017-12-01')
) AS v(sku, slug, isbn13, brand_slug, title, authors, description, format,
       price, stock, delivery, published_on)
JOIN brands b ON b.slug = v.brand_slug;

-- Product <-> category --------------------------------------------------------
INSERT INTO product_categories (product_id, category_id, is_primary)
SELECT p.id, c.id, v.is_primary
FROM (VALUES
    ('BK-DDIA-001',      'databases',            true),
    ('BK-DDIA-001',      'software-engineering', false),
    ('BK-DDIA-EB',       'databases',            true),
    ('BK-DUNE-001',      'science-fiction',      true),
    ('BK-NEURO-001',     'science-fiction',      true),
    ('BK-CLEANCODE-001', 'software-engineering', true),
    ('BK-PRAGPROG-EB',   'software-engineering', true),
    ('BK-PGUR-001',      'databases',            true)
) AS v(sku, category_slug, is_primary)
JOIN products   p ON p.sku  = v.sku
JOIN categories c ON c.slug = v.category_slug;

-- Related products ------------------------------------------------------------
INSERT INTO related_products (product_id, related_product_id, relation, sort_order)
SELECT a.id, b.id, v.relation::relation_type, v.sort_order
FROM (VALUES
    ('BK-DDIA-001',      'BK-DDIA-EB',       'other_format', 1),
    ('BK-DDIA-EB',       'BK-DDIA-001',      'other_format', 1),
    ('BK-DDIA-001',      'BK-PGUR-001',      'similar',      1),
    ('BK-PGUR-001',      'BK-DDIA-001',      'similar',      1),
    ('BK-DUNE-001',      'BK-NEURO-001',     'also_bought',  1),
    ('BK-NEURO-001',     'BK-DUNE-001',      'also_bought',  1),
    ('BK-CLEANCODE-001', 'BK-PRAGPROG-EB',   'also_bought',  1),
    ('BK-PRAGPROG-EB',   'BK-CLEANCODE-001', 'also_bought',  1)
) AS v(sku, related_sku, relation, sort_order)
JOIN products a ON a.sku = v.sku
JOIN products b ON b.sku = v.related_sku;

-- Users & credentials ---------------------------------------------------------
INSERT INTO users (email, first_name, last_name, status, email_verified_at, last_login_at) VALUES
    ('alice@example.com', 'Alice', 'Example', 'active', now() - interval '90 days', now() - interval '1 day'),
    ('bob@example.com',   'Bob',   'Example', 'active', now() - interval '45 days', now() - interval '2 hours');

INSERT INTO user_credentials (user_id, password_hash)
SELECT id, '$argon2id$v=19$m=65536,t=3,p=4$SEED_ONLY_NOT_A_REAL_SALT$SEED_ONLY_NOT_A_REAL_HASH'
FROM users;

-- One live session for Bob (token hash is 32 arbitrary bytes, not a real token).
INSERT INTO user_sessions (user_id, token_hash, ip_address, user_agent, expires_at)
SELECT id, decode(repeat('ab', 32), 'hex'), '203.0.113.10', 'Seed Browser/1.0', now() + interval '30 days'
FROM users WHERE email = 'bob@example.com';

INSERT INTO login_attempts (user_id, email, succeeded, ip_address)
SELECT id, email, true, '203.0.113.10' FROM users WHERE email = 'bob@example.com';

-- Addresses (203.0.113.0/24 and "Example" values are documentation placeholders)
INSERT INTO addresses (user_id, label, recipient_name, line1, city, region, postal_code,
                       country_code, is_default_shipping)
SELECT u.id, v.label, v.recipient_name, v.line1, v.city, v.region, v.postal_code,
       v.country_code, v.is_default
FROM (VALUES
    ('alice@example.com', 'Home', 'Alice Example', '1 Example Street',  'Springfield', 'IL', '62701', 'US', true),
    ('alice@example.com', 'Work', 'Alice Example', '2 Sample Avenue',   'Springfield', 'IL', '62702', 'US', false),
    ('bob@example.com',   'Home', 'Bob Example',   '3 Placeholder Road','Portland',    'OR', '97201', 'US', true)
) AS v(email, label, recipient_name, line1, city, region, postal_code, country_code, is_default)
JOIN users u ON u.email = v.email;

-- Order history ---------------------------------------------------------------
-- Totals follow: total = subtotal + shipping + tax - discount(points).
INSERT INTO orders (order_number, user_id, shipping_address_id, shipping_address_snapshot, status,
                    subtotal_amount, shipping_amount, tax_amount, gift_points_redeemed,
                    discount_amount, total_amount, placed_at, shipped_at, delivered_at)
SELECT v.order_number, u.id, a.id, address_snapshot(a), v.status::order_status,
       v.subtotal, v.shipping, 0, v.points, gift_points_value(v.points), v.total,
       now() - v.age, now() - v.age + interval '1 day',
       CASE WHEN v.status = 'delivered' THEN now() - v.age + interval '4 days' END
FROM (VALUES
    ('SEED-0001', 'alice@example.com', 'delivered', 64.97, 4.99,   0, 69.96, interval '60 days'),
    ('SEED-0002', 'alice@example.com', 'delivered', 49.98, 0.00, 200, 47.98, interval '20 days'),
    ('SEED-0003', 'bob@example.com',   'shipped',   27.97, 4.99,   0, 32.96, interval '3 days')
) AS v(order_number, email, status, subtotal, shipping, points, total, age)
JOIN users u     ON u.email = v.email
JOIN addresses a ON a.user_id = u.id AND a.is_default_shipping;

INSERT INTO order_items (order_id, product_id, product_sku, product_title, unit_price, quantity)
SELECT o.id, p.id, p.sku, p.title, p.price, v.quantity
FROM (VALUES
    ('SEED-0001', 'BK-DDIA-001',      1),
    ('SEED-0001', 'BK-DUNE-001',      2),
    ('SEED-0002', 'BK-CLEANCODE-001', 1),
    ('SEED-0002', 'BK-DUNE-001',      1),
    ('SEED-0003', 'BK-NEURO-001',     2),
    ('SEED-0003', 'BK-DUNE-001',      1)
) AS v(order_number, sku, quantity)
JOIN orders   o ON o.order_number = v.order_number
JOIN products p ON p.sku = v.sku;

INSERT INTO payments (order_id, method, status, amount, provider, provider_reference,
                      card_brand, card_last4, created_at, captured_at)
SELECT o.id, 'card', 'captured', o.total_amount, 'seed-psp', 'seed-txn-' || o.order_number,
       'visa', '4242', o.placed_at, o.placed_at
FROM orders o;

-- Gift points ledger (inserted in chronological order; the trigger keeps balances) ----
INSERT INTO gift_points_ledger (user_id, order_id, entry_type, points, note, created_at)
SELECT u.id, o.id, v.entry_type::points_entry, v.points, v.note, v.created_at
FROM (VALUES
    ('alice@example.com', NULL,        'earn',    250, 'Sign-up bonus',          now() - interval '90 days'),
    ('alice@example.com', 'SEED-0001', 'earn',     64, 'Points for order',       now() - interval '56 days'),
    ('alice@example.com', 'SEED-0002', 'redeem', -200, 'Redeemed at checkout',   now() - interval '20 days'),
    ('alice@example.com', 'SEED-0002', 'earn',     47, 'Points for order',       now() - interval '16 days')
) AS v(email, order_number, entry_type, points, note, created_at)
JOIN users u ON u.email = v.email
LEFT JOIN orders o ON o.order_number = v.order_number
ORDER BY v.created_at;

-- Active basket for Bob ---------------------------------------------------------
INSERT INTO carts (user_id) SELECT id FROM users WHERE email = 'bob@example.com';

INSERT INTO cart_items (cart_id, product_id, quantity)
SELECT c.id, p.id, v.quantity
FROM (VALUES ('BK-CLEANCODE-001', 1), ('BK-PRAGPROG-EB', 1)) AS v(sku, quantity)
JOIN products p ON p.sku = v.sku
JOIN carts c ON c.status = 'active' AND c.user_id = (SELECT id FROM users WHERE email = 'bob@example.com');

COMMIT;
