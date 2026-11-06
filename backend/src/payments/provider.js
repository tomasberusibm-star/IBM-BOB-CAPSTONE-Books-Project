import { randomUUID } from 'node:crypto';

/**
 * Card processor abstraction. A real integration (Stripe, Adyen, ...) implements the
 * same two methods and receives the single-use `payment_token` created by the
 * provider's client SDK - the API never sees a card number or CVV.
 *
 *   charge({ token, amountCents, idempotencyKey })
 *       -> { approved: true, reference, brand, last4 } | { approved: false }
 *       throws on provider/network failure
 *   refund({ reference, amountCents, idempotencyKey }) -> { reference }
 *
 * Both calls must be idempotent for the same idempotencyKey.
 */

const TOKEN = /^tok_([a-z]+)(?:_[a-z]+)*_(\d{4})$/;
const BRAND_NAMES = { visa: 'visa', mc: 'mastercard', amex: 'amex' };

/**
 * Deterministic development/test processor.
 *   tok_visa_4242 / tok_mc_debit_0005 -> approved (brand + last4 parsed from the token)
 *   tok_declined_*                    -> declined
 *   tok_error_*                       -> provider outage (throws)
 */
export function createMockProvider() {
  const charges = new Map();
  const refunds = new Map();

  return {
    name: 'mock',

    async charge({ token, amountCents, idempotencyKey }) {
      if (!Number.isInteger(amountCents) || amountCents <= 0) throw new RangeError('Invalid amount');
      if (charges.has(idempotencyKey)) return charges.get(idempotencyKey);
      if (token.startsWith('tok_error')) throw new Error('mock provider unavailable');

      const m = token.startsWith('tok_declined') ? null : TOKEN.exec(token);
      const result = m
        ? { approved: true, reference: `mock_ch_${randomUUID()}`, brand: BRAND_NAMES[m[1]] ?? m[1], last4: m[2] }
        : { approved: false };
      charges.set(idempotencyKey, result);
      return result;
    },

    async refund({ reference, idempotencyKey }) {
      if (!reference?.startsWith('mock_ch_')) throw new Error('unknown charge reference');
      if (!refunds.has(idempotencyKey)) refunds.set(idempotencyKey, { reference: `mock_re_${randomUUID()}` });
      return refunds.get(idempotencyKey);
    },
  };
}

export function createPaymentProvider(config) {
  if (config.paymentProvider === 'mock') return createMockProvider();
  throw new Error('Unsupported payment provider');
}
