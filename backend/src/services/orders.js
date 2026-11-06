import { AppError, notFound, providerError } from '../errors.js';
import { withTransaction } from '../db.js';
import { toCents } from '../lib/money.js';
import { CANCEL_WINDOW_HOURS, CANCELLABLE_STATUSES, MAX_ITEM_QUANTITY } from '../lib/rules.js';
import { fetchBasket, lockOrCreateCart } from './basket.js';

/**
 * Columns of the API `Order` shape. Parameters $1 (cancellable statuses) and $2
 * (window hours) are always bound by the caller; further parameters start at $3.
 * Money and dates are cast to text so they reach the client exactly as stored.
 */
const ORDER_COLUMNS = `
  o.id, o.order_number, o.status, o.currency,
  o.subtotal_amount, o.shipping_amount, o.tax_amount, o.discount_amount, o.total_amount,
  o.gift_points_redeemed, o.placed_at, o.shipped_at, o.delivered_at, o.cancelled_at,
  o.shipping_address_id, o.shipping_address_snapshot,
  (o.status = ANY($1::order_status[]) AND now() <= o.placed_at + make_interval(hours => $2::int)) AS can_cancel,
  CASE WHEN o.status = ANY($1::order_status[]) AND now() <= o.placed_at + make_interval(hours => $2::int)
       THEN o.placed_at + make_interval(hours => $2::int) END AS cancellable_until,
  EXISTS (SELECT 1 FROM order_items x JOIN products p ON p.id = x.product_id
           WHERE x.order_id = o.id AND p.is_active) AS can_reorder,
  (SELECT COALESCE(json_agg(json_build_object(
            'product_id', oi.product_id, 'sku', oi.product_sku, 'title', oi.product_title,
            'unit_price', oi.unit_price::text, 'quantity', oi.quantity,
            'line_total', oi.line_total::text,
            'tentative_delivery_date', oi.tentative_delivery_date::text) ORDER BY oi.id), '[]'::json)
     FROM order_items oi WHERE oi.order_id = o.id) AS items`;

const windowParams = [CANCELLABLE_STATUSES, CANCEL_WINDOW_HOURS];

function shapeOrder(r) {
  const snapshot = r.shipping_address_snapshot ?? {};
  return {
    id: r.id,
    order_number: r.order_number,
    status: r.status,
    currency: r.currency,
    subtotal_amount: r.subtotal_amount,
    shipping_amount: r.shipping_amount,
    tax_amount: r.tax_amount,
    discount_amount: r.discount_amount,
    total_amount: r.total_amount,
    gift_points_redeemed: r.gift_points_redeemed,
    placed_at: r.placed_at,
    shipped_at: r.shipped_at,
    delivered_at: r.delivered_at,
    cancelled_at: r.cancelled_at,
    shipping_address: { ...(r.shipping_address_id ? { id: r.shipping_address_id } : {}), ...snapshot },
    items: r.items,
    can_cancel: r.can_cancel,
    cancellable_until: r.cancellable_until,
    can_reorder: r.can_reorder,
  };
}

/** Loads one order in API shape (no ownership check - callers scope by user first). */
export async function fetchOrder(db, orderId) {
  const { rows } = await db.query(`SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.id = $3`, [...windowParams, orderId]);
  return rows.length ? shapeOrder(rows[0]) : null;
}

export function createOrderService({ pool, config, provider, logger }) {
  return {
    /** Order history, newest first. */
    async listForUser(userId, { status, page, pageSize }) {
      const { rows: count } = await pool.query(
        `SELECT count(*)::int AS n FROM orders o
          WHERE o.user_id = $1 AND ($2::order_status IS NULL OR o.status = $2::order_status)`,
        [userId, status ?? null],
      );
      const total = count[0].n;
      // $1-$2 are bound inside ORDER_COLUMNS (cancellation window); the filters follow.
      const { rows } = await pool.query(
        `SELECT ${ORDER_COLUMNS} FROM orders o
          WHERE o.user_id = $3 AND ($4::order_status IS NULL OR o.status = $4::order_status)
          ORDER BY o.placed_at DESC, o.id DESC LIMIT $5 OFFSET $6`,
        [...windowParams, userId, status ?? null, pageSize, (page - 1) * pageSize],
      );
      return {
        page,
        page_size: pageSize,
        total_items: total,
        total_pages: Math.ceil(total / pageSize),
        items: rows.map(shapeOrder),
      };
    },

    /**
     * "Buy it again": copies a past order's items into the active basket at CURRENT
     * prices. Quantities add to what is already in the basket (max 999, never above
     * tracked stock). Items no longer sold or out of stock are skipped and reported.
     */
    async reorder(userId, orderId) {
      return withTransaction(pool, async (db) => {
        const { rows: owned } = await db.query('SELECT 1 FROM orders WHERE id = $1 AND user_id = $2', [orderId, userId]);
        if (owned.length === 0) throw notFound();

        const cartId = await lockOrCreateCart(db, userId);
        const { rows: lines } = await db.query(
          `SELECT oi.product_id, oi.product_title, oi.quantity AS wanted,
                  p.is_active, p.stock_quantity, COALESCE(ci.quantity, 0) AS in_basket
             FROM order_items oi
             JOIN products p ON p.id = oi.product_id
             LEFT JOIN cart_items ci ON ci.cart_id = $2 AND ci.product_id = oi.product_id
            WHERE oi.order_id = $1
            ORDER BY oi.id`,
          [orderId, cartId],
        );

        const added = [];
        const skipped = [];
        for (const l of lines) {
          if (!l.is_active) {
            skipped.push({ product_id: l.product_id, title: l.product_title, reason: 'product_unavailable' });
            continue;
          }
          const ceiling = Math.min(MAX_ITEM_QUANTITY, l.stock_quantity ?? MAX_ITEM_QUANTITY);
          const newQty = Math.min(l.in_basket + l.wanted, ceiling);
          if (newQty <= l.in_basket) {
            skipped.push({ product_id: l.product_id, title: l.product_title, reason: 'out_of_stock' });
            continue;
          }
          await db.query(
            `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)
             ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
            [cartId, l.product_id, newQty],
          );
          added.push({ product_id: l.product_id, quantity: newQty - l.in_basket });
        }

        if (added.length === 0) {
          throw new AppError(409, 'NOTHING_TO_REORDER', 'None of the items in this order are currently available.');
        }
        return { basket: await fetchBasket(db, cartId, config), added, skipped };
      });
    },

    /**
     * Cancels an order placed at most 48 hours ago that has not shipped yet.
     * One transaction: returns stock, credits redeemed gift points back, refunds
     * captured card payments, marks the order cancelled. Idempotent for an already
     * cancelled order. Refunds use a per-payment idempotency key, so a retry after
     * a failure can never refund twice.
     */
    async cancel(userId, orderId, reason) {
      return withTransaction(pool, async (db) => {
        const { rows } = await db.query(
          `SELECT status, gift_points_redeemed,
                  now() > placed_at + make_interval(hours => $3::int) AS window_expired
             FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [orderId, userId, CANCEL_WINDOW_HOURS],
        );
        if (rows.length === 0) throw notFound();
        const o = rows[0];

        if (o.status === 'cancelled') return fetchOrder(db, orderId);
        if (!CANCELLABLE_STATUSES.includes(o.status)) {
          throw new AppError(409, 'ORDER_NOT_CANCELLABLE', 'This order can no longer be cancelled.');
        }
        if (o.window_expired) {
          throw new AppError(
            409,
            'CANCELLATION_WINDOW_EXPIRED',
            `Orders can only be cancelled within ${CANCEL_WINDOW_HOURS} hours of being placed.`,
          );
        }

        // Return stock (products locked in id order to avoid deadlocks with checkout).
        await db.query(
          `SELECT 1 FROM products
            WHERE id IN (SELECT product_id FROM order_items WHERE order_id = $1)
            ORDER BY id FOR UPDATE`,
          [orderId],
        );
        await db.query(
          `UPDATE products p SET stock_quantity = p.stock_quantity + oi.quantity
             FROM order_items oi
            WHERE oi.order_id = $1 AND oi.product_id = p.id AND p.stock_quantity IS NOT NULL`,
          [orderId],
        );

        if (o.gift_points_redeemed > 0) {
          await db.query(
            `INSERT INTO gift_points_ledger (user_id, order_id, entry_type, points, note)
             VALUES ($1, $2, 'refund', $3, 'Order cancelled')`,
            [userId, orderId, o.gift_points_redeemed],
          );
        }

        const { rows: payments } = await db.query(
          "SELECT id, amount, provider_reference FROM payments WHERE order_id = $1 AND status = 'captured' ORDER BY id FOR UPDATE",
          [orderId],
        );
        for (const p of payments) {
          try {
            await provider.refund({
              reference: p.provider_reference,
              amountCents: toCents(p.amount),
              idempotencyKey: `refund-payment-${p.id}`,
            });
          } catch (err) {
            logger.error({ err, order_id: orderId, payment_id: p.id }, 'refund failed');
            throw providerError();
          }
          await db.query("UPDATE payments SET status = 'refunded' WHERE id = $1", [p.id]);
        }

        await db.query(
          "UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1",
          [orderId, reason ?? null],
        );
        return fetchOrder(db, orderId);
      });
    },
  };
}
