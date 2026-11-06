import { Link } from 'react-router';
import { deliveryLabel } from '../lib/format.js';

/** Small, dependency-free UI building blocks shared across pages. */

export function Spinner({ label = 'Loading' }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-16 text-stone-500">
      <span aria-hidden="true" className="size-5 animate-spin rounded-full border-2 border-stone-300 border-t-brand-600" />
      <span>{label}…</span>
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Something went wrong' }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
      <h2 className="font-semibold text-red-900">{title}</h2>
      <p className="mt-1 text-sm text-red-800">{error?.message ?? 'Please try again.'}</p>
      {error?.requestId && <p className="mt-1 text-xs text-red-700/70">Reference: {error.requestId}</p>}
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-4 rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800">
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="rounded-xl border border-dashed border-stone-300 bg-white p-10 text-center">
      <h2 className="font-serif text-xl font-semibold">{title}</h2>
      {children && <p className="mx-auto mt-2 max-w-md text-stone-600">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

const BUTTON = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/50',
  secondary: 'border border-stone-300 bg-white text-stone-800 hover:bg-stone-50 disabled:text-stone-400',
  danger: 'border border-red-300 bg-white text-red-700 hover:bg-red-50 disabled:text-red-300',
  dark: 'bg-stone-900 text-white hover:bg-stone-800 disabled:bg-stone-900/50',
};
const SIZE = { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2.5 text-sm', lg: 'px-6 py-3 text-base' };

export function buttonClass(variant = 'primary', size = 'md', extra = '') {
  return `inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed ${BUTTON[variant]} ${SIZE[size]} ${extra}`;
}

export function Button({ variant, size, className, busy, children, ...props }) {
  return (
    <button type="button" {...props} disabled={props.disabled || busy} aria-busy={busy || undefined} className={buttonClass(variant, size, className)}>
      {busy && <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

export function LinkButton({ to, variant, size, className, children }) {
  return (
    <Link to={to} className={buttonClass(variant, size, className)}>
      {children}
    </Link>
  );
}

const TONES = {
  instant: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20',
  soon: 'bg-sky-50 text-sky-800 ring-sky-600/20',
  normal: 'bg-stone-100 text-stone-700 ring-stone-500/20',
  backorder: 'bg-amber-50 text-amber-900 ring-amber-600/30',
  unknown: 'bg-stone-100 text-stone-600 ring-stone-500/20',
  amber: 'bg-amber-50 text-amber-900 ring-amber-600/30',
  blue: 'bg-sky-50 text-sky-800 ring-sky-600/20',
  violet: 'bg-violet-50 text-violet-800 ring-violet-600/20',
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20',
  stone: 'bg-stone-100 text-stone-700 ring-stone-500/20',
};

export function Badge({ tone = 'stone', children, className = '' }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]} ${className}`}>{children}</span>;
}

/** Tentative delivery date tag. Always text, never colour alone. */
export function DeliveryTag({ product }) {
  const { tone, text } = deliveryLabel(product);
  return <Badge tone={tone}>{text}</Badge>;
}

export function StockNote({ product }) {
  if (product.availability === 'low_stock') return <span className="text-xs font-medium text-amber-800">Only a few left</span>;
  return null;
}

export function FieldError({ id, children }) {
  if (!children) return null;
  return (
    <p id={id} className="mt-1 text-sm text-red-700">
      {children}
    </p>
  );
}

export function TextField({ label, id, error, hint, ...props }) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-stone-800">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={[error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined}
        {...props}
        className="mt-1 block w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-stone-900 placeholder:text-stone-400 aria-invalid:border-red-500"
      />
      {hint && !error && (
        <p id={hintId} className="mt-1 text-xs text-stone-500">
          {hint}
        </p>
      )}
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}

export function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Pagination" className="mt-8 flex items-center justify-center gap-3">
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Previous
      </Button>
      <span className="text-sm text-stone-600" aria-current="page">
        Page {page} of {totalPages}
      </span>
      <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        Next
      </Button>
    </nav>
  );
}
