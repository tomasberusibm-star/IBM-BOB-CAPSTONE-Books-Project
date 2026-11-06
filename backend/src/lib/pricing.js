import { toCents } from './money.js';

/** 1 gift point is worth 1 cent (matches gift_points_value() in db/schema.sql). */
export const POINT_VALUE_CENTS = 1;

const PHYSICAL_FORMATS = new Set(['hardcover', 'paperback']);

/**
 * Prices a basket. Pure function - all amounts in integer cents.
 *  - shipping: flat rate for baskets containing physical books, free above the
 *    threshold, and free for digital-only baskets
 *  - tax: basis points of the subtotal, rounded half up
 *
 * @param {{price: string, quantity: number, format: string}[]} items
 */
export function priceOrder(items, config) {
  const subtotal = items.reduce((sum, i) => sum + toCents(i.price) * i.quantity, 0);
  const hasPhysical = items.some((i) => PHYSICAL_FORMATS.has(i.format));
  const shipping = hasPhysical && subtotal < config.freeShippingThresholdCents ? config.shippingFlatCents : 0;
  const tax = Math.round((subtotal * config.taxRateBps) / 10_000);
  return { subtotal, shipping, tax, total: subtotal + shipping + tax };
}
