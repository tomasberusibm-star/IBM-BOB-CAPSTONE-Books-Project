import { createHash, randomUUID } from 'node:crypto';
import { AppError, basketEmpty, notFound, providerError } from '../errors.js';
import { withTransaction } from '../db.js';
import { fromCents } from '../lib/money.js';
import { POINT_VALUE_CENTS, priceOrder } from '../lib/pricing.js';
import { insufficientStock } from './basket.js';
import { fetchOrder } from './orders.js';

const ADDRESS_COLUMNS =
  'id, label, recipient_name, line1, line2, city, region, postal_code, country_code, phone';

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

/** Basket lines with live product data. With lock=true products are row-locked in id order (deadlock-free). */
async function loadLines(db, cartId, config, { lock }) {
  if (lock) {
    await db.query(
      `SELECT 1 FROM products WHERE id IN (SELECT product_id FROM cart_items WHERE cart_id = $1) ORDER BY id FOR UPDATE`,
      [cartId],
    );
  }
  const { rows } = await db.query(
    `SELECT ci.product_id, ci.quantity, p.sku, p.title, p.price, p.format, p.is_active, p.stock_quantity,
            effective_delivery_date(p.stock_quantity, p.tentative_delivery_date, ${Number(config.deliveryLeadDays)}) AS delivery_date
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = $1 ORDER BY ci.added_at, ci.product_id`,
    [cartId],
  );
  return rows;
}

function assertBuyable(lines) {
  if (lines.length === 0) throw basketEmpty();
  if (lines.some((l) => !l.is_active)) {
    throw new AppError(409, 'PRODUCT_UNAVAILABLE', 'The basket contains products that are no longer available.');
  }
  if (lines.some((l) => l.stock_quantity !== null && l.stock_quantity < l.quantity)) throw insufficientStock();
}

export function createCheckoutService({ pool, config, provider, logger }) {
  const pricing = (lines) => priceOrder(lines.map((l) => ({ price: l.price, quantity: l.quantity, format: l.format })), config);

  return {
    /** The user's address book (one-off checkout addresses are not listed), default first. */
    async listAddresses(userId) {
      const { rows } = await pool.query(
        `SELECT ${ADDRESS_COLUMNS}, is_default_shipping FROM addresses
          WHERE user_id = $1 AND is_saved ORDER BY is_default_shipping DESC, id`,
        [userId],
      );
      return rows;
    },

    /**
     * Step 1: choose the shipping address (saved id or new address) and price the
     * basket. Safe to call repeatedly to change the address before paying.
     */
    async setAddress(userId, { address_id, address }) {
      return withTransaction(pool, async (db) => {
        const { rows: carts } = await db.query(
          "SELECT id FROM carts WHERE user_id = $1 AND status = 'active' FOR UPDATE",
          [userId],
        );
        if (carts.length === 0) throw basketEmpty();
        const cartId = carts[0].id;

        const lines = await loadLines(db, cartId, config, { lock: false });
        assertBuyable(lines);

        let saved;
        if (address_id !== undefined) {
          const { rows } = await db.query(`SELECT ${ADDRESS_COLUMNS} FROM addresses WHERE id = $1 AND user_id = $2`, [address_id, userId]);
          if (rows.length === 0) throw notFound();
          saved = rows[0];
        } else {
          const { rows } = await db.query(
            `INSERT INTO addresses (user_id, label, recipient_name, line1, line2, city, region, postal_code, country_code, phone, is_saved)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING ${ADDRESS_COLUMNS}`,
            [
              userId, address.label ?? null, address.recipient_name, address.line1, address.line2 ?? null,
              address.city, address.region ?? null, address.postal_code, address.country_code,
              address.phone ?? null, address.save_to_address_book ?? false,
            ],
          );
          saved = rows[0];
        }
        await db.query('UPDATE carts SET shipping_address_id = $2 WHERE id = $1', [cartId, saved.id]);

        const price = pricing(lines);
        const { rows: acct } = await db.query('SELECT balance FROM gift_point_accounts WHERE user_id = $1', [userId]);
        const balance = acct[0]?.balance ?? 0;
        const dates = lines.map((l) => l.delivery_date).filter(Boolean).sort();

        return {
          shipping_address: saved,
          subtotal_amount: fromCents(price.subtotal),
          shipping_amount: fromCents(price.shipping),
          tax_amount: fromCents(price.tax),
          total_amount: fromCents(price.total),
          currency: config.currency,
          gift_points_balance: balance,
          max_redeemable_points: Math.min(balance, Math.floor(price.subtotal / POINT_VALUE_CENTS)),
          gift_point_value: fromCents(POINT_VALUE_CENTS),
          tentative_delivery_date: dates.length ? dates[dates.length - 1] : null,
        };
      });
    },

    /**
     * Step 2: place the order and take payment atomically.
     *
     * Inside ONE database transaction: replay check (Idempotency-Key) -> lock basket and
     * products -> validate stock -> price -> redeem gift points -> create order -> reduce
     * stock -> charge the card for the remainder -> record payment -> store the response.
     * A decline, provider error or any later failure rolls everything back, so points are
     * never deducted without an order. If the card WAS charged but a later step (including
     * COMMIT) fails, the charge is refunded before the error is returned.
     *
     * Gift points cover the item subtotal only (not shipping or tax), so a points-only
     * payment succeeds only when shipping and tax are zero; otherwise a card is required.
     */
    async pay(userId, idempotencyKey, { gift_points_to_redeem: points = 0, card }) {
      const requestHash = sha256Hex(JSON.stringify([points, card?.payment_token ?? null, card?.card_type ?? null]));
      let charge = null; // set once the card is charged; used for compensation
      // Unique per attempt: a retry after a compensated (refunded) charge must create a NEW charge,
      // never get the refunded one back from the provider's own idempotency cache.
      const attemptId = randomUUID();

      try {
        return await withTransaction(pool, async (db) => {
          // 1. Replay protection. A concurrent request with the same key blocks on this
          //    insert until the first transaction finishes, then takes the replay branch.
          const claimed = await db.query(
            'INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [userId, idempotencyKey, requestHash],
          );
          if (claimed.rowCount === 0) {
            const { rows } = await db.query(
              'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
              [userId, idempotencyKey],
            );
            const stored = rows[0];
            if (!stored || stored.request_hash !== requestHash) {
              throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.');
            }
            if (!stored.response_body) {
              throw new AppError(409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed.');
            }
            return { status: stored.response_status, body: stored.response_body, replayed: true };
          }

          // 2. Basket, address, stock.
          const { rows: carts } = await db.query(
            "SELECT id, shipping_address_id FROM carts WHERE user_id = $1 AND status = 'active' FOR UPDATE",
            [userId],
          );
          if (carts.length === 0) throw basketEmpty();
          const cart = carts[0];
          const lines = await loadLines(db, cart.id, config, { lock: true });
          assertBuyable(lines);

          if (cart.shipping_address_id === null) {
            throw new AppError(409, 'ADDRESS_REQUIRED', 'Select a shipping address before paying.');
          }
          const { rows: addr } = await db.query(
            'SELECT address_snapshot(a) AS snapshot FROM addresses a WHERE a.id = $1 AND a.user_id = $2',
            [cart.shipping_address_id, userId],
          );
          if (addr.length === 0) throw new AppError(409, 'ADDRESS_REQUIRED', 'Select a shipping address before paying.');

          // 3. Price and validate the payment combination.
          const price = pricing(lines);
          const discount = points * POINT_VALUE_CENTS;
          if (discount > price.subtotal) {
            throw new AppError(422, 'GIFT_POINTS_EXCEED_SUBTOTAL', 'Gift points cannot exceed the value of the items in the basket.');
          }
          const due = price.total - discount;
          if (due > 0 && !card) {
            throw new AppError(422, 'PAYMENT_METHOD_REQUIRED', 'A card is required to pay the remaining amount.');
          }
          if (due === 0 && card) {
            throw new AppError(422, 'CARD_NOT_REQUIRED', 'Gift points cover the full amount; do not supply a card.');
          }

          // 4. Gift points (row lock serialises concurrent spending of one balance).
          if (points > 0) {
            const { rows: acct } = await db.query('SELECT balance FROM gift_point_accounts WHERE user_id = $1 FOR UPDATE', [userId]);
            if ((acct[0]?.balance ?? 0) < points) {
              throw new AppError(422, 'INSUFFICIENT_GIFT_POINTS', 'The gift points balance is too low.');
            }
          }

          // 5. Order, items, stock.
          const { rows: ord } = await db.query(
            `INSERT INTO orders (user_id, shipping_address_id, shipping_address_snapshot, status, currency,
                                 subtotal_amount, shipping_amount, tax_amount, gift_points_redeemed,
                                 discount_amount, total_amount)
             VALUES ($1, $2, $3, 'pending_payment', $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
            [
              userId, cart.shipping_address_id, addr[0].snapshot, config.currency,
              fromCents(price.subtotal), fromCents(price.shipping), fromCents(price.tax),
              points, fromCents(discount), fromCents(due),
            ],
          );
          const orderId = ord[0].id;

          for (const l of lines) {
            await db.query(
              `INSERT INTO order_items (order_id, product_id, product_sku, product_title, unit_price, quantity, tentative_delivery_date)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [orderId, l.product_id, l.sku, l.title, l.price, l.quantity, l.delivery_date],
            );
            if (l.stock_quantity !== null) {
              await db.query('UPDATE products SET stock_quantity = stock_quantity - $2 WHERE id = $1', [l.product_id, l.quantity]);
            }
          }
          if (points > 0) {
            await db.query(
              `INSERT INTO gift_points_ledger (user_id, order_id, entry_type, points, note)
               VALUES ($1, $2, 'redeem', $3, 'Redeemed at checkout')`,
              [userId, orderId, -points],
            );
          }

          // 6. Card charge for the remainder.
          let paymentRow = null;
          if (due > 0) {
            let result;
            try {
              result = await provider.charge({
                token: card.payment_token,
                amountCents: due,
                idempotencyKey: `charge-${attemptId}`,
              });
            } catch (err) {
              logger.error({ err, user_id: userId }, 'payment provider error');
              throw providerError();
            }
            if (!result.approved) {
              throw new AppError(402, 'PAYMENT_DECLINED', 'The payment was declined. Please use another card.');
            }
            charge = { reference: result.reference, amountCents: due };

            const { rows: pay } = await db.query(
              `INSERT INTO payments (order_id, method, status, amount, currency, provider, provider_reference,
                                     card_brand, card_last4, card_type, captured_at)
               VALUES ($1, 'card', 'captured', $2, $3, $4, $5, $6, $7, $8, now())
               RETURNING id, status, method, amount, currency, card_brand, card_last4, card_type`,
              [orderId, fromCents(due), config.currency, provider.name, result.reference, result.brand, result.last4, card.card_type],
            );
            paymentRow = pay[0];
          }

          // 7. Finalise.
          await db.query("UPDATE orders SET status = 'paid' WHERE id = $1", [orderId]);
          await db.query("UPDATE carts SET status = 'converted' WHERE id = $1", [cart.id]);

          const { rows: bal } = await db.query('SELECT balance FROM gift_point_accounts WHERE user_id = $1', [userId]);
          const body = {
            order: await fetchOrder(db, orderId),
            payment: paymentRow,
            gift_points_redeemed: points,
            gift_points_balance: bal[0]?.balance ?? 0,
          };
          // Round-trip through JSON so the stored/replayed copy is identical to what is sent.
          const stored = JSON.parse(JSON.stringify(body));
          await db.query(
            'UPDATE idempotency_keys SET response_status = 201, response_body = $3 WHERE user_id = $1 AND key = $2',
            [userId, idempotencyKey, stored],
          );
          return { status: 201, body: stored, replayed: false };
        });
      } catch (err) {
        if (charge) {
          // The card was charged but the order did not commit: give the money back.
          try {
            await provider.refund({
              reference: charge.reference,
              amountCents: charge.amountCents,
              idempotencyKey: `compensate-${attemptId}`,
            });
          } catch (refundErr) {
            logger.fatal(
              { err: refundErr, user_id: userId, provider_reference: charge.reference },
              'MANUAL ACTION REQUIRED: card charged but order failed and refund failed',
            );
          }
        }
        throw err;
      }
    },
  };
}
