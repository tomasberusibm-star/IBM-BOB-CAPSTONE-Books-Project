import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../context/AuthContext.jsx';
import { useBasket } from '../context/BasketContext.jsx';
import { formatMoney } from '../lib/format.js';
import { Button, DeliveryTag, StockNote } from './ui.jsx';

/** Deterministic, accessible placeholder cover (the API has no cover images). */
const COVER_TONES = [
  'from-brand-700 to-brand-800',
  'from-emerald-700 to-emerald-900',
  'from-amber-700 to-amber-900',
  'from-violet-700 to-violet-900',
  'from-rose-700 to-rose-900',
  'from-stone-700 to-stone-900',
];

export function BookCover({ product, className = '' }) {
  const tone = COVER_TONES[product.id % COVER_TONES.length];
  return (
    <div
      aria-hidden="true"
      className={`relative flex aspect-[3/4] flex-col justify-between overflow-hidden rounded-md bg-gradient-to-br ${tone} p-4 text-white shadow-sm ${className}`}
    >
      <p className="font-serif text-lg leading-tight font-semibold [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:5] overflow-hidden">
        {product.title}
      </p>
      <p className="truncate text-xs text-white/80">{product.authors?.join(', ')}</p>
      <span className="absolute inset-y-0 left-0 w-2 bg-black/20" />
    </div>
  );
}

/**
 * "Add to basket" that sends signed-out visitors to the login page (and back afterwards).
 */
export function AddToBasketButton({ product, size = 'md', className = '' }) {
  const { isAuthenticated } = useAuth();
  const { add } = useBasket();
  const navigate = useNavigate();
  const [state, setState] = useState({ busy: false, done: false, error: null });
  const soldOut = product.availability === 'out_of_stock';

  async function onClick() {
    if (!isAuthenticated) return navigate('/login', { state: { from: `/books/${product.id}` } });
    setState({ busy: true, done: false, error: null });
    try {
      await add(product.id, 1);
      setState({ busy: false, done: true, error: null });
    } catch (error) {
      setState({ busy: false, done: false, error });
    }
  }

  return (
    <div className={className}>
      <Button size={size} busy={state.busy} disabled={soldOut} onClick={onClick} className="w-full">
        {soldOut ? 'Out of stock' : state.done ? 'Added - add another' : 'Add to basket'}
      </Button>
      <p role="status" className="mt-1 min-h-4 text-xs text-stone-600">
        {state.done && 'Added to your basket.'}
        {state.error && <span className="text-red-700">{state.error.message}</span>}
      </p>
    </div>
  );
}

export function ProductCard({ product }) {
  return (
    <article className="group flex flex-col rounded-xl border border-stone-200 bg-white p-4 transition-shadow hover:shadow-md">
      <Link to={`/books/${product.id}`} className="block rounded-md" aria-label={`${product.title}, details`}>
        <BookCover product={product} className="transition-transform group-hover:-translate-y-0.5" />
      </Link>
      <div className="mt-3 flex flex-1 flex-col">
        <h3 className="font-serif text-base leading-snug font-semibold">
          <Link to={`/books/${product.id}`} className="hover:text-brand-700">
            {product.title}
          </Link>
        </h3>
        <p className="mt-0.5 text-sm text-stone-600">{product.authors?.join(', ')}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <DeliveryTag product={product} />
          <span className="text-xs text-stone-500 capitalize">{product.format}</span>
        </div>
        <StockNote product={product} />
        <p className="mt-auto pt-3 text-lg font-semibold">{formatMoney(product.price, product.currency)}</p>
      </div>
      <AddToBasketButton product={product} size="sm" className="mt-2" />
    </article>
  );
}

export function ProductGrid({ products }) {
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {products.map((p) => (
        <li key={p.id}>
          <ProductCard product={p} />
        </li>
      ))}
    </ul>
  );
}
