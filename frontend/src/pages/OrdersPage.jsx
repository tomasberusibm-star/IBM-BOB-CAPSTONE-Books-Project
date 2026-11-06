import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client.js';
import { Badge, Button, EmptyState, ErrorState, LinkButton, Pagination, Spinner } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useBasket } from '../context/BasketContext.jsx';
import { formatDateTime, formatMoney, ORDER_STATUS, timeLeft } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';

const PAGE_SIZE = 5;

const SKIP_REASON = {
  product_unavailable: 'no longer sold',
  out_of_stock: 'out of stock',
};

/** Result of "Buy In Again": what went into the basket and what could not. */
function ReorderResult({ result }) {
  if (result.error) {
    return (
      <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-900">
        {result.error.code === 'NOTHING_TO_REORDER'
          ? 'None of the books in this order are available right now, so nothing was added to your basket.'
          : result.error.message}
      </p>
    );
  }
  const { added, skipped } = result;
  return (
    <div role="status" className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
      <p>
        Added {added.length} {added.length === 1 ? 'book' : 'books'} to your basket at today&apos;s prices.{' '}
        <Link to="/basket" className="font-semibold underline underline-offset-2">
          Go to basket
        </Link>
      </p>
      {skipped.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-amber-900">
          {skipped.map((s) => (
            <li key={s.product_id}>
              {s.title} was not added ({SKIP_REASON[s.reason] ?? 'unavailable'}).
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CancelSection({ order, onCancelled }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api.cancelOrder(order.id);
      onCancelled(order);
    } catch (err) {
      setError(err);
      setConfirming(false);
      // The window may have closed while the page was open: reload so the button disappears.
      if (['CANCELLATION_WINDOW_EXPIRED', 'ORDER_NOT_CANCELLABLE'].includes(err.code)) onCancelled(order, err);
    } finally {
      setBusy(false);
    }
  }

  if (!order.can_cancel) {
    if (order.status === 'cancelled' || order.status === 'refunded') return null;
    const why = ['shipped', 'delivered'].includes(order.status)
      ? 'This order has shipped and can no longer be cancelled.'
      : 'The 48-hour cancellation window for this order has closed.';
    return <p className="text-sm text-stone-500">{why}</p>;
  }

  return (
    <div>
      <p className="text-sm text-stone-600">
        You can cancel this order for 48 hours after placing it ({timeLeft(order.cancellable_until)}).
      </p>
      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-red-50 p-3 text-sm text-red-900">
          {error.message}
        </p>
      )}
      {confirming ? (
        <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label={`Confirm cancelling order ${order.order_number}`}>
          <span className="text-sm font-medium">Cancel this order? Your payment and gift points will be returned.</span>
          <Button variant="danger" size="sm" busy={busy} onClick={cancel}>
            Yes, cancel order
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
            Keep order
          </Button>
        </div>
      ) : (
        <Button variant="danger" size="sm" className="mt-2" onClick={() => setConfirming(true)} aria-label={`Cancel order ${order.order_number}`}>
          Cancel order
        </Button>
      )}
    </div>
  );
}

function OrderCard({ order, onCancelled }) {
  const { replace } = useBasket();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const status = ORDER_STATUS[order.status] ?? { label: order.status, tone: 'stone' };

  async function buyAgain() {
    setBusy(true);
    setResult(null);
    try {
      const res = await api.reorder(order.id);
      replace(res.basket);
      setResult({ added: res.added, skipped: res.skipped });
    } catch (err) {
      setResult({ error: err });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl border border-stone-200 bg-white">
      <article aria-labelledby={`order-${order.id}`}>
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 bg-stone-50 px-5 py-3 text-sm">
          <div>
            <h2 id={`order-${order.id}`} className="font-semibold">
              Order {order.order_number}
            </h2>
            <p className="text-stone-600">Placed {formatDateTime(order.placed_at)}</p>
          </div>
          <div className="flex items-center gap-3">
            <Badge tone={status.tone}>{status.label}</Badge>
            <p className="text-right">
              <span className="block text-xs text-stone-500">Total</span>
              <strong>{formatMoney(order.total_amount, order.currency)}</strong>
            </p>
          </div>
        </header>

        <div className="space-y-4 p-5">
          <ul className="divide-y divide-stone-100 text-sm">
            {order.items.map((i) => (
              <li key={i.product_id} className="flex justify-between gap-4 py-2">
                <span>
                  <Link to={`/books/${i.product_id}`} className="font-medium hover:text-brand-700">
                    {i.title}
                  </Link>{' '}
                  <span className="text-stone-500">&times; {i.quantity}</span>
                </span>
                <span>{formatMoney(i.line_total, order.currency)}</span>
              </li>
            ))}
          </ul>
          {order.gift_points_redeemed > 0 && (
            <p className="text-sm text-stone-600">
              Gift points used: {order.gift_points_redeemed.toLocaleString('en-US')} (-{formatMoney(order.discount_amount, order.currency)})
            </p>
          )}

          <div className="flex flex-wrap items-start justify-between gap-4 border-t border-stone-100 pt-4">
            <CancelSection order={order} onCancelled={onCancelled} />
            <Button
              size="lg"
              busy={busy}
              disabled={!order.can_reorder}
              onClick={buyAgain}
              className="ml-auto"
              aria-label={`Buy In Again, order ${order.order_number}`}
            >
              Buy In Again
            </Button>
          </div>
          {!order.can_reorder && <p className="text-right text-xs text-stone-500">None of these books are currently sold.</p>}
          {result && <ReorderResult result={result} />}
        </div>
      </article>
    </li>
  );
}

export default function OrdersPage() {
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState(null);
  const orders = useAsync((signal) => api.orders(user.id, { page, page_size: PAGE_SIZE }, signal), [user.id, page]);

  function handleCancelled(order, err) {
    setNotice(err ? null : `Order ${order.order_number} was cancelled. Your payment and any gift points are being returned.`);
    orders.reload();
  }

  return (
    <div>
      <h1 className="font-serif text-3xl font-bold">My orders</h1>
      <p className="mt-1 text-stone-600">Re-order your favourites in one click, or cancel within 48 hours of placing an order.</p>

      {notice && (
        <p role="status" className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
          {notice}
        </p>
      )}

      <div className="mt-6">
        {orders.status === 'loading' && !orders.data && <Spinner label="Loading your orders" />}
        {orders.status === 'error' && <ErrorState error={orders.error} onRetry={orders.reload} title="Could not load your orders" />}
        {orders.data && orders.status !== 'error' && (
          <>
            {orders.data.items.length === 0 ? (
              <EmptyState title="No orders yet" action={<LinkButton to="/books">Browse books</LinkButton>}>
                When you place an order it will appear here.
              </EmptyState>
            ) : (
              <ul className="space-y-6" aria-busy={orders.loading || undefined}>
                {orders.data.items.map((order) => (
                  <OrderCard key={order.id} order={order} onCancelled={handleCancelled} />
                ))}
              </ul>
            )}
            <Pagination page={orders.data.page} totalPages={orders.data.total_pages} onChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
