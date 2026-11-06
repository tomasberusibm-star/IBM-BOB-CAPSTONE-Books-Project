import { LOW_STOCK_THRESHOLD } from './rules.js';

/**
 * Shared SQL fragments for the product summary shape used by the catalogue,
 * recommendations and basket. Expects the products table aliased as `p`.
 *
 * tentative_delivery_date comes from effective_delivery_date() in db/schema.sql:
 * stale (past) dates are never shown to customers.
 */
export function productColumns(leadDays) {
  // Interpolated into SQL text, so it must be a plain non-negative integer (validated by config).
  if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 365) throw new RangeError('Invalid delivery lead days');
  return `p.id, p.sku, p.title, p.authors, p.format, p.price,
    CASE WHEN p.stock_quantity IS NULL THEN 'always_available'
         WHEN p.stock_quantity = 0 THEN 'out_of_stock'
         WHEN p.stock_quantity <= ${LOW_STOCK_THRESHOLD} THEN 'low_stock'
         ELSE 'in_stock' END AS availability,
    effective_delivery_date(p.stock_quantity, p.tentative_delivery_date, ${leadDays}) AS tentative_delivery_date`;
}

export function shapeProduct(row, currency) {
  return {
    id: row.id,
    sku: row.sku,
    title: row.title,
    authors: row.authors,
    format: row.format,
    price: row.price,
    currency,
    availability: row.availability,
    tentative_delivery_date: row.tentative_delivery_date,
  };
}
