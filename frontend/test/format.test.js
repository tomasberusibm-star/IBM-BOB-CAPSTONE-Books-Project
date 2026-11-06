import { describe, expect, it } from 'vitest';
import { deliveryLabel, formatMoney, timeLeft, toCents } from '../src/lib/format.js';
import { safeRedirect } from '../src/pages/LoginPage.jsx';

describe('toCents', () => {
  it('converts decimal strings without floating point drift', () => {
    expect(toCents('44.99')).toBe(4499);
    expect(toCents('0.10')).toBe(10);
    expect(toCents('5')).toBe(500);
    expect(toCents('5.5')).toBe(550);
    expect(toCents('19.99')).toBe(1999);
  });

  it('returns 0 for anything that is not a plain amount', () => {
    expect(toCents('abc')).toBe(0);
    expect(toCents('-1.00')).toBe(0);
    expect(toCents(undefined)).toBe(0);
  });
});

describe('formatMoney', () => {
  it('formats USD and tolerates bad input', () => {
    expect(formatMoney('1234.5', 'USD')).toBe('$1,234.50');
    expect(formatMoney('nope')).toBe('');
  });
});

describe('deliveryLabel', () => {
  const today = new Date(2026, 5, 10); // 10 June 2026

  it('says instant download for always-available items', () => {
    expect(deliveryLabel({ availability: 'always_available', tentative_delivery_date: null }, today)).toEqual({
      tone: 'instant',
      text: 'Instant download',
    });
  });

  it('handles same-day, next-day and later dates', () => {
    expect(deliveryLabel({ availability: 'in_stock', tentative_delivery_date: '2026-06-10' }, today).text).toBe('Arrives today');
    expect(deliveryLabel({ availability: 'in_stock', tentative_delivery_date: '2026-06-11' }, today).text).toMatch(/^Arrives tomorrow, /);
    const later = deliveryLabel({ availability: 'in_stock', tentative_delivery_date: '2026-06-20' }, today);
    expect(later.text).toBe('Arrives Sat, Jun 20');
    expect(later.tone).toBe('normal');
  });

  it('labels back-ordered and unknown dates in words, not colour alone', () => {
    expect(deliveryLabel({ availability: 'out_of_stock', tentative_delivery_date: '2026-07-01' }, today).text).toBe('Back in stock Wed, Jul 1');
    expect(deliveryLabel({ availability: 'out_of_stock', tentative_delivery_date: null }, today).text).toBe('Out of stock');
    expect(deliveryLabel({ availability: 'in_stock', tentative_delivery_date: null }, today).text).toBe('Delivery date unknown');
  });
});

describe('timeLeft', () => {
  const now = Date.parse('2026-06-10T12:00:00Z');

  it('reports hours and minutes, then minutes only, then expired', () => {
    expect(timeLeft('2026-06-12T08:30:00Z', now)).toBe('44h 30m left');
    expect(timeLeft('2026-06-10T12:20:00Z', now)).toBe('20m left');
    expect(timeLeft('2026-06-10T12:00:10Z', now)).toBe('1m left');
    expect(timeLeft('2026-06-10T11:59:00Z', now)).toBe('expired');
  });
});

describe('safeRedirect', () => {
  it('allows same-site paths', () => {
    expect(safeRedirect('/orders')).toBe('/orders');
    expect(safeRedirect('/books?q=dune')).toBe('/books?q=dune');
  });

  it('rejects open-redirect attempts', () => {
    expect(safeRedirect('https://evil.example')).toBe('/');
    expect(safeRedirect('//evil.example')).toBe('/');
    expect(safeRedirect('/\\evil.example')).toBe('/');
    expect(safeRedirect('javascript:alert(1)')).toBe('/');
    expect(safeRedirect(undefined)).toBe('/');
    expect(safeRedirect({ a: 1 })).toBe('/');
  });
});
