import { AppError, notFound } from '../errors.js';
import { withTransaction } from '../db.js';
import { fromCents, toCents } from '../lib/money.js';
import { MAX_ITEM_QUANTITY } from '../lib/rules.js';
import { productColumns, shapeProduct } from '../lib/productSql.js';

export const insufficientStock = () =>
  new AppError(409, 'INSUFFICIENT_STOCK', 'Not enough stock for the requested quantity.');

/**
 * Returns the id of the user's active basket, creating it on first use. The conflict
 * branch updates the row, which also takes a row lock: concurrent basket operations
 * for one user are serialised for the rest of the transaction.
 */
export async function lockOrCreateCart(db, userId) {
  const { rows } = await db.query(
    `INSERT INTO carts (user_id) VALUES ($1)
     ON CONFLICT (user_id) WHERE status = 'active' DO UPDATE SET updated_at = now()
     RETURNING id`,
    [userId],
  );
  return rows[0].id;
}

/** Full basket representation (OpenAPI `Basket`). */
export async function fetchBasket(db, cartId, config) {
  const { rows } = await db.query(
    `SELECT ci.quantity, ${productColumns(config.deliveryLeadDays)}
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = $1
      ORDER BY ci.added_at, p.id`,
    [cartId],
  );
  let subtotal = 0;
  let count = 0;
  const items = rows.map((r) => {
    const line = toCents(r.price) * r.quantity;
    subtotal += line;
    count += r.quantity;
    return { product: shapeProduct(r, config.currency), quantity: r.quantity, line_total: fromCents(line) };
  });
  return { id: cartId, items, item_count: count, subtotal_amount: fromCents(subtotal), currency: config.currency };
}

export function createBasketService({ pool, config }) {
  return {
    async addItem(userId, { product_id, quantity }) {
      return withTransaction(pool, async (db) => {
        const cartId = await lockOrCreateCart(db, userId);

        const { rows: prod } = await db.query(
          'SELECT stock_quantity FROM products WHERE id = $1 AND is_active FOR SHARE',
          [product_id],
        );
        if (prod.length === 0) throw notFound();
        const stock = prod[0].stock_quantity;

        const { rows: cur } = await db.query(
          'SELECT quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2',
          [cartId, product_id],
        );
        const wanted = Math.min((cur[0]?.quantity ?? 0) + quantity, MAX_ITEM_QUANTITY);
        if (stock !== null && wanted > stock) throw insufficientStock();

        await db.query(
          `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)
           ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
          [cartId, product_id, wanted],
        );
        return fetchBasket(db, cartId, config);
      });
    },
  };
}
