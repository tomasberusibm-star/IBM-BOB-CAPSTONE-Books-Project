/** Display helpers. Money arrives as decimal strings and is never turned into floats for arithmetic. */

export function formatMoney(amount, currency = 'USD') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
}

/** Whole cents from a decimal string such as "44.99". */
export function toCents(amount) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount));
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : 0;
}

const parseDate = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
};

/**
 * Delivery tag for a product card/detail.
 *  - instant (null date, tracked-free items like e-books): "Instant download"
 *  - out of stock with no date: "Delivery date unknown"
 */
export function deliveryLabel(product, today = new Date()) {
  const { tentative_delivery_date: date, availability } = product;
  if (availability === 'always_available') return { tone: 'instant', text: 'Instant download' };
  if (!date) return { tone: 'unknown', text: availability === 'out_of_stock' ? 'Out of stock' : 'Delivery date unknown' };

  const target = parseDate(date);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((target - start) / 86_400_000);
  const when = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(target);

  if (availability === 'out_of_stock') return { tone: 'backorder', text: `Back in stock ${when}` };
  if (days <= 0) return { tone: 'soon', text: 'Arrives today' };
  if (days === 1) return { tone: 'soon', text: `Arrives tomorrow, ${when}` };
  return { tone: days <= 3 ? 'soon' : 'normal', text: `Arrives ${when}` };
}

export function formatDateTime(iso) {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function formatDate(iso) {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(iso));
}

/** "2 days 4 hours left" style text for the cancellation window. */
export function timeLeft(untilIso, now = Date.now()) {
  const ms = new Date(untilIso).getTime() - now;
  if (ms <= 0) return 'expired';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 1) return `${hours}h ${minutes}m left`;
  return `${Math.max(1, minutes)}m left`;
}

export const ORDER_STATUS = {
  pending_payment: { label: 'Awaiting payment', tone: 'amber' },
  paid: { label: 'Paid', tone: 'blue' },
  processing: { label: 'Processing', tone: 'blue' },
  shipped: { label: 'Shipped', tone: 'violet' },
  delivered: { label: 'Delivered', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'stone' },
  refunded: { label: 'Refunded', tone: 'stone' },
};

/** A fresh random key for one payment attempt (see Idempotency-Key in the API contract). */
export function newIdempotencyKey() {
  return crypto.randomUUID();
}
