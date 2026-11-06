/**
 * Exact money arithmetic. Amounts travel as decimal strings ("44.99") and are
 * calculated in integer cents; floats are never used for currency.
 */

export function toCents(money) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(money));
  if (!m) throw new TypeError('Invalid money amount');
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export function fromCents(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError('Invalid cents amount');
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
