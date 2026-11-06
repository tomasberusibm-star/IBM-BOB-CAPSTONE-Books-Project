import { useState } from 'react';
import { Link, Navigate } from 'react-router';
import { api } from '../api/client.js';
import { AddressStep, CardPicker, useIdempotencyKey } from '../components/CheckoutParts.jsx';
import { BookCover } from '../components/ProductCard.jsx';
import { Badge, Button, DeliveryTag, EmptyState, ErrorState, LinkButton, Spinner } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useBasket } from '../context/BasketContext.jsx';
import { formatDateTime, formatMoney, newIdempotencyKey, toCents } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';

const cents = (c) => `${Math.trunc(c / 100)}.${String(c % 100).padStart(2, '0')}`;

function BasketLines({ basket, editable }) {
  const { setQuantity, remove } = useBasket();
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);

  async function run(productId, action) {
    setPending(productId);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err);
    } finally {
      setPending(null);
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-900">
          {error.message}
        </p>
      )}
      <ul className="divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
        {basket.items.map(({ product, quantity, line_total }) => (
          <li key={product.id} className="flex gap-4 p-4">
            <BookCover product={product} className="w-16 shrink-0" />
            <div className="min-w-0 flex-1">
              <Link to={`/books/${product.id}`} className="font-serif font-semibold hover:text-brand-700">
                {product.title}
              </Link>
              <p className="text-sm text-stone-600">{product.authors?.join(', ')}</p>
              <div className="mt-1">
                <DeliveryTag product={product} />
              </div>
              {editable && (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <label htmlFor={`qty-${product.id}`} className="text-sm">
                    Qty
                  </label>
                  <select
                    id={`qty-${product.id}`}
                    value={quantity}
                    disabled={pending === product.id}
                    onChange={(e) => run(product.id, () => setQuantity(product.id, Number(e.target.value)))}
                    className="rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm"
                  >
                    {Array.from({ length: Math.max(10, quantity) }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <Button variant="secondary" size="sm" disabled={pending === product.id} onClick={() => run(product.id, () => remove(product.id))} aria-label={`Remove ${product.title}`}>
                    Remove
                  </Button>
                </div>
              )}
              {!editable && <p className="mt-2 text-sm text-stone-600">Qty {quantity}</p>}
            </div>
            <p className="font-semibold">{formatMoney(line_total, basket.currency)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Totals with the gift-points discount applied. All arithmetic in whole cents. */
function Summary({ summary, pointsUsed, currency }) {
  const subtotal = toCents(summary.subtotal_amount);
  const discount = pointsUsed; // 1 point = 1 cent
  const due = toCents(summary.total_amount) - discount;
  const row = (label, value, strong) => (
    <div className={`flex justify-between ${strong ? 'border-t border-stone-200 pt-3 text-lg font-bold' : 'text-sm'}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <dl className="space-y-2">
      {row('Items', formatMoney(cents(subtotal), currency))}
      {row('Shipping', toCents(summary.shipping_amount) === 0 ? 'Free' : formatMoney(summary.shipping_amount, currency))}
      {toCents(summary.tax_amount) > 0 && row('Tax', formatMoney(summary.tax_amount, currency))}
      {discount > 0 && row(`Gift points (${pointsUsed.toLocaleString('en-US')})`, `-${formatMoney(cents(discount), currency)}`)}
      {row('Total to pay', formatMoney(cents(due), currency), true)}
    </dl>
  );
}

function GiftPoints({ summary, enabled, onToggle, points, onPoints }) {
  const max = summary.max_redeemable_points;
  const none = summary.gift_points_balance === 0;
  return (
    <section aria-labelledby="gp-heading" className="rounded-xl border border-stone-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 id="gp-heading" className="font-semibold">
            Gift points
          </h3>
          <p className="text-sm text-stone-600">
            Balance: <strong>{summary.gift_points_balance.toLocaleString('en-US')}</strong> points (each worth {formatMoney(summary.gift_point_value, summary.currency)}).
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="gp-heading"
          disabled={none}
          onClick={() => onToggle(!enabled)}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${enabled ? 'bg-brand-600' : 'bg-stone-300'}`}
        >
          <span aria-hidden="true" className={`absolute top-0.5 left-0.5 size-6 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : ''}`} />
        </button>
      </div>
      {none && <p className="mt-2 text-sm text-stone-500">You have no gift points yet. You earn points on eligible orders.</p>}
      {enabled && (
        <div className="mt-4">
          <label htmlFor="points" className="block text-sm font-medium">
            Points to use (max {max.toLocaleString('en-US')})
          </label>
          <div className="mt-1 flex items-center gap-3">
            <input
              id="points"
              type="number"
              inputMode="numeric"
              min={0}
              max={max}
              step={1}
              value={points}
              onChange={(e) => onPoints(Math.min(max, Math.max(0, Math.floor(Number(e.target.value) || 0))))}
              className="w-32 rounded-lg border border-stone-300 px-3 py-2"
            />
            <Button variant="secondary" size="sm" onClick={() => onPoints(max)}>
              Use maximum
            </Button>
          </div>
          <p className="mt-2 text-xs text-stone-500">Points can pay for books only, not shipping or tax.</p>
        </div>
      )}
    </section>
  );
}

function Confirmation({ result }) {
  const { order, payment } = result;
  return (
    <div className="mx-auto max-w-2xl py-6 text-center">
      <p className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-700" aria-hidden="true">
        ✓
      </p>
      <h1 className="mt-4 font-serif text-3xl font-bold">Thank you - your order is placed</h1>
      <p className="mt-2 text-stone-600">
        Order <strong>{order.order_number}</strong> &middot; {formatDateTime(order.placed_at)}
      </p>
      <div className="mt-6 rounded-xl border border-stone-200 bg-white p-5 text-left">
        <ul className="divide-y divide-stone-100 text-sm">
          {order.items.map((i) => (
            <li key={i.product_id} className="flex justify-between py-2">
              <span>
                {i.title} &times; {i.quantity}
                {i.tentative_delivery_date && <span className="block text-xs text-stone-500">Estimated delivery {i.tentative_delivery_date}</span>}
              </span>
              <span>{formatMoney(i.line_total, order.currency)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-3 space-y-1 border-t border-stone-200 pt-3 text-sm">
          <div className="flex justify-between"><dt>Shipping</dt><dd>{formatMoney(order.shipping_amount, order.currency)}</dd></div>
          {order.gift_points_redeemed > 0 && (
            <div className="flex justify-between"><dt>Gift points used ({order.gift_points_redeemed.toLocaleString('en-US')})</dt><dd>-{formatMoney(order.discount_amount, order.currency)}</dd></div>
          )}
          <div className="flex justify-between font-bold"><dt>Paid</dt><dd>{formatMoney(order.total_amount, order.currency)}</dd></div>
        </dl>
        <p className="mt-3 text-sm text-stone-600">
          {payment ? `Charged to your ${payment.card_type} card ending ${payment.card_last4}.` : 'Paid in full with gift points.'}{' '}
          Remaining gift points: <strong>{result.gift_points_balance.toLocaleString('en-US')}</strong>.
        </p>
      </div>
      <p className="mt-4 text-sm text-stone-600">Changed your mind? You can cancel within 48 hours from your order history.</p>
      <div className="mt-6 flex justify-center gap-3">
        <LinkButton to="/orders">View my orders</LinkButton>
        <LinkButton to="/books" variant="secondary">Keep shopping</LinkButton>
      </div>
    </div>
  );
}

export default function BasketPage() {
  const { isAuthenticated } = useAuth();
  const { basket, refresh, replace } = useBasket();
  const [confirmed, setConfirmed] = useState(null); // { summary, signature } once an address is confirmed
  const [addressBusy, setAddressBusy] = useState(false);
  const [addressError, setAddressError] = useState(null);
  const [editingAddress, setEditingAddress] = useState(true);
  const [usePoints, setUsePoints] = useState(false);
  const [points, setPoints] = useState(0);
  const [card, setCard] = useState({ card_type: 'credit', payment_token: '' });
  const [cardError, setCardError] = useState(null);
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState(null);
  const [result, setResult] = useState(null);
  const keyFor = useIdempotencyKey(newIdempotencyKey);

  const addresses = useAsync((signal) => (isAuthenticated ? api.addresses(signal) : Promise.resolve({ items: [] })), [isAuthenticated]);

  // The server prices the basket, so a summary is only valid for the basket it was computed from.
  const basketSignature = basket.items.map((i) => `${i.product.id}:${i.quantity}`).join(',');
  const summary = confirmed?.signature === basketSignature ? confirmed.summary : null;
  const showAddressForm = editingAddress || !summary;

  if (!isAuthenticated) return <Navigate to="/login" state={{ from: '/basket' }} replace />;
  if (result) return <Confirmation result={result} />;

  const pointsUsed = summary && usePoints ? Math.min(points, summary.max_redeemable_points) : 0;
  const due = summary ? toCents(summary.total_amount) - pointsUsed : 0;
  const needsCard = summary ? due > 0 : false;

  async function confirmAddress(body) {
    setAddressBusy(true);
    setAddressError(null);
    try {
      const s = await api.setCheckoutAddress(body);
      setConfirmed({ summary: s, signature: basketSignature });
      setEditingAddress(false);
      setPoints((p) => Math.min(p, s.max_redeemable_points));
      if (!s.max_redeemable_points) setUsePoints(false);
      addresses.reload();
    } catch (err) {
      setAddressError(err);
    } finally {
      setAddressBusy(false);
    }
  }

  async function placeOrder() {
    setPayError(null);
    setCardError(null);
    if (needsCard && !card.payment_token) {
      setCardError('Choose a test card to pay the remaining amount.');
      return;
    }
    const payload = {
      ...(pointsUsed > 0 ? { gift_points_to_redeem: pointsUsed } : {}),
      ...(needsCard ? { card: { payment_token: card.payment_token, card_type: card.card_type } } : {}),
    };
    setPayBusy(true);
    try {
      // Same payload => same key, so a retry after a dropped connection can never charge twice.
      const res = await api.pay(payload, keyFor(payload));
      replace({ ...basket, id: null, items: [], item_count: 0, subtotal_amount: '0.00' });
      setResult(res);
    } catch (err) {
      setPayError(err);
      if (['INSUFFICIENT_STOCK', 'PRODUCT_UNAVAILABLE', 'BASKET_EMPTY'].includes(err.code)) refresh();
    } finally {
      setPayBusy(false);
    }
  }

  if (basket.items.length === 0) {
    return (
      <EmptyState title="Your basket is empty" action={<LinkButton to="/books">Browse books</LinkButton>}>
        Add a few books and they will show up here. Past orders can be re-ordered in one click.
      </EmptyState>
    );
  }

  const chosen = addresses.data?.items.find((a) => a.id === summary?.shipping_address?.id) ?? summary?.shipping_address;

  return (
    <div>
      <h1 className="font-serif text-3xl font-bold">Basket and checkout</h1>
      <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-8">
          <section aria-labelledby="step-basket">
            <h2 id="step-basket" className="mb-3 flex items-center gap-2 text-lg font-semibold">
              <Badge tone="blue">1</Badge> Your items
            </h2>
            <BasketLines basket={basket} editable />
          </section>

          <section aria-labelledby="step-address">
            <h2 id="step-address" className="mb-3 flex items-center gap-2 text-lg font-semibold">
              <Badge tone={summary ? 'green' : 'blue'}>2</Badge> Shipping address
            </h2>
            <div className="rounded-xl border border-stone-200 bg-white p-5">
              {addresses.status === 'loading' && <Spinner label="Loading your addresses" />}
              {addresses.status === 'error' && <ErrorState error={addresses.error} onRetry={addresses.reload} title="Could not load your addresses" />}
              {addresses.status === 'ready' && !showAddressForm && chosen && (
                <div className="flex items-start justify-between gap-4 text-sm">
                  <p>
                    <strong>{chosen.recipient_name}</strong>
                    <br />
                    {chosen.line1}
                    {chosen.line2 ? `, ${chosen.line2}` : ''}
                    <br />
                    {chosen.city}
                    {chosen.region ? `, ${chosen.region}` : ''} {chosen.postal_code}, {chosen.country_code}
                  </p>
                  <Button variant="secondary" size="sm" onClick={() => setEditingAddress(true)}>
                    Change
                  </Button>
                </div>
              )}
              {addresses.status === 'ready' && showAddressForm && (
                <AddressStep key={addresses.data.items.map((a) => a.id).join(',')} addresses={addresses.data.items} selectedId={summary?.shipping_address?.id} onSubmit={confirmAddress} busy={addressBusy} error={addressError} />
              )}
            </div>
          </section>

          {summary && (
            <section aria-labelledby="step-payment" className="space-y-4">
              <h2 id="step-payment" className="flex items-center gap-2 text-lg font-semibold">
                <Badge tone="blue">3</Badge> Payment
              </h2>
              <GiftPoints
                summary={summary}
                enabled={usePoints}
                onToggle={(on) => {
                  setUsePoints(on);
                  if (on) setPoints(summary.max_redeemable_points);
                }}
                points={points}
                onPoints={setPoints}
              />
              <div className="rounded-xl border border-stone-200 bg-white p-5">
                {needsCard ? (
                  <CardPicker value={card} onChange={setCard} error={cardError} />
                ) : (
                  <p className="text-sm text-emerald-800">Your gift points cover the whole order - no card needed.</p>
                )}
              </div>
            </section>
          )}
        </div>

        <aside aria-label="Order summary" className="h-fit rounded-xl border border-stone-200 bg-white p-5 lg:sticky lg:top-24">
          <h2 className="mb-3 font-serif text-xl font-bold">Order summary</h2>
          {summary ? (
            <>
              <Summary summary={summary} pointsUsed={pointsUsed} currency={summary.currency} />
              {summary.tentative_delivery_date && <p className="mt-3 text-sm text-stone-600">Estimated delivery by {summary.tentative_delivery_date}</p>}
              {payError && (
                <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-900">
                  {payError.message}
                  {payError.code === 'PAYMENT_DECLINED' && ' You have not been charged.'}
                </p>
              )}
              <Button size="lg" className="mt-4 w-full" busy={payBusy} onClick={placeOrder}>
                {needsCard ? `Pay ${formatMoney(cents(due), summary.currency)}` : 'Place order'}
              </Button>
              <p className="mt-2 text-center text-xs text-stone-500">Safe to retry: a repeated click never charges twice.</p>
            </>
          ) : (
            <>
              <p className="flex justify-between text-sm">
                <span>Items ({basket.item_count})</span>
                <span>{formatMoney(basket.subtotal_amount, basket.currency)}</span>
              </p>
              <p className="mt-3 text-sm text-stone-600">Choose a shipping address to see delivery, shipping and your payment options.</p>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
