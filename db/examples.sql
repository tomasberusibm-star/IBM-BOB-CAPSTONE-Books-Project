-- =============================================================================
-- Example queries against the sample data (run after schema.sql + seed.sql).
--   psql -v ON_ERROR_STOP=1 -d <database> -f db/examples.sql
-- Everything that writes runs inside a transaction that is rolled back.
-- =============================================================================

\echo '--- Category tree --------------------------------------------------------'
WITH RECURSIVE tree AS (
    SELECT id, name, slug, 0 AS depth, name::text AS path
    FROM categories WHERE parent_id IS NULL
    UNION ALL
    SELECT c.id, c.name, c.slug, t.depth + 1, t.path || ' > ' || c.name
    FROM categories c JOIN tree t ON c.parent_id = t.id
)
SELECT path FROM tree ORDER BY path;

\echo '--- Catalogue with brand, primary category and tentative delivery --------'
SELECT p.sku, p.title, b.name AS brand, c.name AS category, p.price,
       p.stock_quantity, p.tentative_delivery_date
FROM products p
JOIN brands b ON b.id = p.brand_id
LEFT JOIN product_categories pc ON pc.product_id = p.id AND pc.is_primary
LEFT JOIN categories c ON c.id = pc.category_id
WHERE p.is_active
ORDER BY p.sku;

\echo '--- Full-text search: "data" ---------------------------------------------'
SELECT sku, title FROM products WHERE search @@ websearch_to_tsquery('english', 'data');

\echo '--- Related products for Designing Data-Intensive Applications -----------'
SELECT r.relation, rp.title
FROM related_products r
JOIN products p  ON p.id  = r.product_id AND p.sku = 'BK-DDIA-001'
JOIN products rp ON rp.id = r.related_product_id
ORDER BY r.relation, r.sort_order;

\echo '--- Alice: order history -------------------------------------------------'
SELECT o.order_number, o.status, o.placed_at::date, o.subtotal_amount,
       o.gift_points_redeemed, o.total_amount
FROM orders o JOIN users u ON u.id = o.user_id
WHERE u.email = 'alice@example.com'
ORDER BY o.placed_at DESC;

\echo '--- Alice: "Buy it again" ------------------------------------------------'
SELECT v.title, v.times_ordered, v.total_quantity, v.last_ordered_at::date,
       v.last_unit_price, v.current_price, v.tentative_delivery_date
FROM v_buy_it_again v JOIN users u ON u.id = v.user_id
WHERE u.email = 'alice@example.com'
ORDER BY v.last_ordered_at DESC;

\echo '--- Alice: gift points ledger and balance --------------------------------'
SELECT l.created_at::date, l.entry_type, l.points, l.balance_after, l.note
FROM gift_points_ledger l JOIN users u ON u.id = l.user_id
WHERE u.email = 'alice@example.com' ORDER BY l.id;
SELECT balance FROM gift_point_accounts
WHERE user_id = (SELECT id FROM users WHERE email = 'alice@example.com');

\echo '--- Alice re-orders SEED-0001, then checks out redeeming 100 points ------'
BEGIN;
SELECT reorder_to_cart(u.id, o.id) AS items_added
FROM orders o JOIN users u ON u.id = o.user_id
WHERE o.order_number = 'SEED-0001';

SELECT place_order(u.id, a.id, 100, 4.99) AS new_order_id
FROM users u JOIN addresses a ON a.user_id = u.id AND a.is_default_shipping
WHERE u.email = 'alice@example.com';

SELECT order_number, status, subtotal_amount, shipping_amount, discount_amount, total_amount
FROM orders ORDER BY id DESC LIMIT 1;
SELECT balance FROM gift_point_accounts
WHERE user_id = (SELECT id FROM users WHERE email = 'alice@example.com');
ROLLBACK;
