import { productColumns, shapeProduct } from '../lib/productSql.js';
import { PURCHASED_STATUSES } from '../lib/rules.js';

/**
 * Recommendation engine - one SQL statement, three signals from the user's purchases:
 *
 *   related_to_purchase            curated related_products of what they bought
 *                                  (series 5 > also_bought 4 > similar 3 > accessory 2 > other_format 1)
 *   same_category                  other books in categories they buy from (1 per shared purchase)
 *   popular_with_similar_customers books bought by OTHER customers who bought the same
 *                                  titles (0.5 per distinct customer; only aggregates leave the DB)
 *
 * Scores add up per candidate; the strongest single signal becomes `reason` and the
 * purchased product behind it `based_on_product_id`. Already-purchased, inactive and
 * out-of-stock products are excluded. A user without purchases gets an empty list.
 */
export function createRecommendationService({ pool, config }) {
  const cols = productColumns(config.deliveryLeadDays);

  const SQL = `
    WITH bought AS (
      SELECT DISTINCT oi.product_id
        FROM orders o JOIN order_items oi ON oi.order_id = o.id
       WHERE o.user_id = $1 AND o.status = ANY($2::order_status[])
    ),
    cand AS (
      SELECT r.related_product_id AS product_id, 'related_to_purchase'::text AS reason, b.product_id AS based_on,
             CASE r.relation WHEN 'series' THEN 5 WHEN 'also_bought' THEN 4 WHEN 'similar' THEN 3
                             WHEN 'accessory' THEN 2 ELSE 1 END::numeric AS score,
             1 AS reason_rank
        FROM bought b JOIN related_products r ON r.product_id = b.product_id
      UNION ALL
      SELECT pc2.product_id, 'same_category', b.product_id, 1::numeric, 2
        FROM bought b
        JOIN product_categories pc1 ON pc1.product_id = b.product_id
        JOIN product_categories pc2 ON pc2.category_id = pc1.category_id AND pc2.product_id <> b.product_id
      UNION ALL
      SELECT x.product_id, 'popular_with_similar_customers', x.based_on, 0.5::numeric, 3
        FROM (SELECT DISTINCT o1.user_id AS other_user, oi2.product_id, b.product_id AS based_on
                FROM bought b
                JOIN order_items oi1 ON oi1.product_id = b.product_id
                JOIN orders o1 ON o1.id = oi1.order_id AND o1.user_id <> $1 AND o1.status = ANY($2::order_status[])
                JOIN orders o2 ON o2.user_id = o1.user_id AND o2.status = ANY($2::order_status[])
                JOIN order_items oi2 ON oi2.order_id = o2.id AND oi2.product_id <> b.product_id) x
    ),
    fresh AS (
      SELECT * FROM cand c WHERE NOT EXISTS (SELECT 1 FROM bought b WHERE b.product_id = c.product_id)
    ),
    total AS (
      SELECT product_id, sum(score) AS score FROM fresh GROUP BY product_id
    ),
    best AS (
      SELECT DISTINCT ON (product_id) product_id, reason, based_on
        FROM fresh ORDER BY product_id, score DESC, reason_rank, based_on
    )
    SELECT ${cols}, best.reason, best.based_on
      FROM total
      JOIN best USING (product_id)
      JOIN products p ON p.id = total.product_id
     WHERE p.is_active AND (p.stock_quantity IS NULL OR p.stock_quantity > 0)
     ORDER BY total.score DESC, p.published_on DESC NULLS LAST, p.id
     LIMIT $3`;

  return {
    async forUser(userId, limit) {
      const { rows } = await pool.query(SQL, [userId, PURCHASED_STATUSES, limit]);
      return rows.map((r) => ({
        product: shapeProduct(r, config.currency),
        reason: r.reason,
        based_on_product_id: r.based_on,
      }));
    },
  };
}
