import { useRef, useState } from 'react';
import { Button, FieldError, TextField } from './ui.jsx';

/**
 * Card payment selector (Credit / Debit).
 *
 * SECURITY: this component never collects a card number, expiry or CVV, and the API would
 * reject them. In production, mount the payment provider's hosted card fields here (Stripe
 * Elements, Adyen Drop-in, ...); the provider returns a single-use token which is passed to
 * onChange as `payment_token`. Card data then never touches this page or our servers.
 *
 * For the training project (mock processor) a set of TEST CARDS stands in for the hosted
 * fields; their tokens are accepted/declined deterministically by the mock processor.
 */
export const TEST_CARDS = [
  { token: 'tok_visa_4242', label: 'Visa ending 4242', note: 'Approved' },
  { token: 'tok_mc_0005', label: 'Mastercard ending 0005', note: 'Approved' },
  { token: 'tok_amex_0001', label: 'Amex ending 0001', note: 'Approved' },
  { token: 'tok_declined_0002', label: 'Visa ending 0002', note: 'Always declined' },
];

export function CardPicker({ value, onChange, error }) {
  const { card_type: cardType, payment_token: token } = value;
  return (
    <fieldset>
      <legend className="text-sm font-semibold">Card type</legend>
      <div role="radiogroup" aria-label="Card type" className="mt-2 grid grid-cols-2 gap-3">
        {[
          ['credit', 'Credit card'],
          ['debit', 'Debit card'],
        ].map(([v, label]) => (
          <label key={v} className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm ${cardType === v ? 'border-brand-600 bg-brand-50' : 'border-stone-300 bg-white'}`}>
            <input type="radio" name="card_type" value={v} checked={cardType === v} onChange={() => onChange({ ...value, card_type: v })} className="accent-brand-600" />
            {label}
          </label>
        ))}
      </div>

      <div className="mt-4 rounded-lg border border-dashed border-amber-400 bg-amber-50 p-4">
        <p className="text-sm font-semibold text-amber-900">Test mode - no real card is used</p>
        <p className="mt-1 text-xs text-amber-900/80">
          This training store uses a mock payment processor. Choose a test card; real card details are never entered or sent here.
        </p>
        <label htmlFor="test-card" className="mt-3 block text-sm font-medium">
          Test card
        </label>
        <select
          id="test-card"
          value={token}
          onChange={(e) => onChange({ ...value, payment_token: e.target.value })}
          aria-invalid={error ? true : undefined}
          className="mt-1 block w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5"
        >
          <option value="">Select a test card…</option>
          {TEST_CARDS.map((c) => (
            <option key={c.token} value={c.token}>
              {c.label} ({c.note})
            </option>
          ))}
        </select>
        <FieldError>{error}</FieldError>
      </div>
    </fieldset>
  );
}

const EMPTY_ADDRESS = { recipient_name: '', line1: '', line2: '', city: '', region: '', postal_code: '', country_code: 'US', phone: '', save_to_address_book: true };

/** Choose a saved address or enter a new one. Calls onSubmit({address_id}|{address}). */
export function AddressStep({ addresses, selectedId, onSubmit, busy, error }) {
  const hasSaved = addresses.length > 0;
  const [choice, setChoice] = useState(selectedId ?? (hasSaved ? addresses[0].id : 'new'));
  const [form, setForm] = useState(EMPTY_ADDRESS);
  const [errors, setErrors] = useState({});
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));

  function submit(event) {
    event.preventDefault();
    if (choice !== 'new') return onSubmit({ address_id: choice });

    const e = {};
    if (!form.recipient_name.trim()) e.recipient_name = 'Enter the recipient name.';
    if (!form.line1.trim()) e.line1 = 'Enter the street address.';
    if (!form.city.trim()) e.city = 'Enter the city.';
    if (!form.postal_code.trim()) e.postal_code = 'Enter the postal code.';
    if (!/^[A-Za-z]{2}$/.test(form.country_code)) e.country_code = 'Use a 2-letter country code, e.g. US.';
    setErrors(e);
    if (Object.keys(e).length > 0) return;

    const trimmed = (v) => (v.trim() === '' ? undefined : v.trim());
    onSubmit({
      address: {
        recipient_name: form.recipient_name.trim(),
        line1: form.line1.trim(),
        line2: trimmed(form.line2),
        city: form.city.trim(),
        region: trimmed(form.region),
        postal_code: form.postal_code.trim(),
        country_code: form.country_code.toUpperCase(),
        phone: trimmed(form.phone),
        save_to_address_book: form.save_to_address_book,
      },
    });
  }

  return (
    <form onSubmit={submit} noValidate>
      {error && (
        <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-900">
          {error.message}
        </p>
      )}
      <fieldset>
        <legend className="sr-only">Shipping address</legend>
        <div className="space-y-3">
          {addresses.map((a) => (
            <label key={a.id} className={`flex cursor-pointer gap-3 rounded-lg border p-4 text-sm ${choice === a.id ? 'border-brand-600 bg-brand-50' : 'border-stone-300 bg-white'}`}>
              <input type="radio" name="address" checked={choice === a.id} onChange={() => setChoice(a.id)} className="mt-1 accent-brand-600" />
              <span>
                <span className="block font-medium">
                  {a.recipient_name} {a.label && <span className="font-normal text-stone-500">({a.label})</span>}
                  {a.is_default_shipping && <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 text-xs">Default</span>}
                </span>
                <span className="block text-stone-700">
                  {a.line1}
                  {a.line2 ? `, ${a.line2}` : ''}, {a.city}
                  {a.region ? `, ${a.region}` : ''} {a.postal_code}, {a.country_code}
                </span>
              </span>
            </label>
          ))}
          <label className={`flex cursor-pointer items-center gap-3 rounded-lg border p-4 text-sm font-medium ${choice === 'new' ? 'border-brand-600 bg-brand-50' : 'border-stone-300 bg-white'}`}>
            <input type="radio" name="address" checked={choice === 'new'} onChange={() => setChoice('new')} className="accent-brand-600" />
            Ship to a new address
          </label>
        </div>
      </fieldset>

      {choice === 'new' && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <TextField id="a-name" label="Recipient name" autoComplete="name" value={form.recipient_name} onChange={set('recipient_name')} error={errors.recipient_name} maxLength={150} />
          </div>
          <div className="sm:col-span-2">
            <TextField id="a-line1" label="Address line 1" autoComplete="address-line1" value={form.line1} onChange={set('line1')} error={errors.line1} maxLength={200} />
          </div>
          <div className="sm:col-span-2">
            <TextField id="a-line2" label="Address line 2 (optional)" autoComplete="address-line2" value={form.line2} onChange={set('line2')} maxLength={200} />
          </div>
          <TextField id="a-city" label="City" autoComplete="address-level2" value={form.city} onChange={set('city')} error={errors.city} maxLength={100} />
          <TextField id="a-region" label="State / region (optional)" autoComplete="address-level1" value={form.region} onChange={set('region')} maxLength={100} />
          <TextField id="a-postal" label="Postal code" autoComplete="postal-code" value={form.postal_code} onChange={set('postal_code')} error={errors.postal_code} maxLength={20} />
          <TextField id="a-country" label="Country code" autoComplete="country" value={form.country_code} onChange={set('country_code')} error={errors.country_code} maxLength={2} hint="2 letters, e.g. US" />
          <div className="sm:col-span-2">
            <TextField id="a-phone" label="Phone (optional)" type="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} maxLength={32} />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={form.save_to_address_book} onChange={(e) => setForm((f) => ({ ...f, save_to_address_book: e.target.checked }))} className="size-4 accent-brand-600" />
            Save this address for next time
          </label>
        </div>
      )}

      <Button type="submit" busy={busy} className="mt-5">
        Use this address
      </Button>
    </form>
  );
}

/** Keeps one Idempotency-Key per distinct payment request (see the API contract). */
export function useIdempotencyKey(newKey) {
  const ref = useRef({ fingerprint: null, key: null });
  return (payload) => {
    const fingerprint = JSON.stringify(payload);
    if (ref.current.fingerprint !== fingerprint) ref.current = { fingerprint, key: newKey() };
    return ref.current.key;
  };
}
