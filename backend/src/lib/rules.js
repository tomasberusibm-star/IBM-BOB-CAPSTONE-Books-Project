/** Business constants shared by services. */

/** Customers may cancel an order within this many hours of placing it. */
export const CANCEL_WINDOW_HOURS = 48;

/** Order statuses in which cancellation is still possible (before shipping). */
export const CANCELLABLE_STATUSES = ['pending_payment', 'paid', 'processing'];

/** Statuses that count as a completed purchase for "buy again" and recommendations. */
export const PURCHASED_STATUSES = ['paid', 'processing', 'shipped', 'delivered'];

/** Maximum units of one product in a basket (matches cart_items CHECK). */
export const MAX_ITEM_QUANTITY = 999;

/** Stock level at or below which a product is reported as `low_stock`. */
export const LOW_STOCK_THRESHOLD = 5;
