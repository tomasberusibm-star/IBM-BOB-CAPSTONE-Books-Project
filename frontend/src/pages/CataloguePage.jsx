import { useSearchParams } from 'react-router';
import { api } from '../api/client.js';
import { ProductGrid } from '../components/ProductCard.jsx';
import { Button, EmptyState, ErrorState, Pagination, Spinner } from '../components/ui.jsx';
import { useAsync } from '../lib/useAsync.js';

const SORTS = [
  ['title', 'Title A-Z'],
  ['price_asc', 'Price: low to high'],
  ['price_desc', 'Price: high to low'],
  ['newest', 'Newest first'],
  ['delivery', 'Fastest delivery'],
];

const DELIVERY = [
  ['', 'Any time'],
  ['1', 'Within 1 day'],
  ['3', 'Within 3 days'],
  ['7', 'Within a week'],
];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return iso(d);
};

/** Flattens the category tree into [{id, name, depth}] for the selector. */
function flatten(nodes, depth = 0) {
  return nodes.flatMap((n) => [{ id: n.id, name: n.name, depth }, ...flatten(n.children, depth + 1)]);
}

export default function CataloguePage() {
  const [params, setParams] = useSearchParams();
  const categoryId = params.get('category_id') ?? '';
  const brands = params.getAll('brand');
  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'title';
  const availableOnly = params.get('available_only') === 'true';
  const deliverDays = params.get('deliver_days') ?? '';
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);

  const categories = useAsync((signal) => api.categories(signal), []);
  const brandList = useAsync((signal) => api.brands(signal), []);

  const deliverBy = deliverDays ? inDays(Number(deliverDays)) : undefined;
  const products = useAsync(
    (signal) =>
      api.products(
        { category_id: categoryId, brand: brands, q, sort, available_only: availableOnly || undefined, deliver_by: deliverBy, page, page_size: 12 },
        signal,
      ),
    [categoryId, brands.join(','), q, sort, availableOnly, deliverBy, page],
  );

  function update(changes, { keepPage = false } = {}) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      next.delete(key);
      for (const v of [value].flat()) if (v !== '' && v !== undefined && v !== null && v !== false) next.append(key, String(v));
    }
    if (!keepPage) next.delete('page');
    setParams(next);
  }

  const toggleBrand = (slug) => update({ brand: brands.includes(slug) ? brands.filter((b) => b !== slug) : [...brands, slug] });
  const filtersActive = Boolean(categoryId || brands.length || q || availableOnly || deliverDays);
  const flat = categories.data ? flatten(categories.data.items) : [];
  const currentCategory = flat.find((c) => String(c.id) === categoryId);

  return (
    <div>
      <h1 className="font-serif text-3xl font-bold">{currentCategory ? currentCategory.name : q ? `Results for "${q}"` : 'All books'}</h1>

      <div className="mt-6 grid gap-8 lg:grid-cols-[16rem_1fr]">
        <aside aria-label="Filters" className="space-y-6">
          <div>
            <label htmlFor="category" className="block text-sm font-semibold">
              Category
            </label>
            <select
              id="category"
              value={categoryId}
              onChange={(e) => update({ category_id: e.target.value })}
              disabled={categories.status !== 'ready'}
              className="mt-1 block w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5"
            >
              <option value="">All categories</option>
              {flat.map((c) => (
                <option key={c.id} value={c.id}>
                  {'\u00A0\u00A0'.repeat(c.depth)}
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <fieldset>
            <legend className="text-sm font-semibold">Brand</legend>
            {brandList.status === 'loading' && <p className="mt-2 text-sm text-stone-500">Loading brands…</p>}
            {brandList.status === 'error' && <p className="mt-2 text-sm text-red-700">Could not load brands.</p>}
            <ul className="mt-2 space-y-2">
              {(brandList.data?.items ?? []).map((b) => (
                <li key={b.id}>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input type="checkbox" className="size-4 rounded border-stone-300 accent-brand-600" checked={brands.includes(b.slug)} onChange={() => toggleBrand(b.slug)} />
                    {b.name}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          <div>
            <label htmlFor="deliver" className="block text-sm font-semibold">
              Delivery
            </label>
            <select id="deliver" value={deliverDays} onChange={(e) => update({ deliver_days: e.target.value })} className="mt-1 block w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5">
              {DELIVERY.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 rounded border-stone-300 accent-brand-600" checked={availableOnly} onChange={(e) => update({ available_only: e.target.checked })} />
              Hide out-of-stock
            </label>
          </div>

          {filtersActive && (
            <Button variant="secondary" size="sm" onClick={() => setParams(new URLSearchParams())}>
              Clear all filters
            </Button>
          )}
        </aside>

        <section aria-label="Products">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p role="status" className="text-sm text-stone-600">
              {products.status === 'ready' ? `${products.data.total_items} book${products.data.total_items === 1 ? '' : 's'}` : '\u00A0'}
            </p>
            <div className="flex items-center gap-2">
              <label htmlFor="sort" className="text-sm font-medium">
                Sort by
              </label>
              <select id="sort" value={sort} onChange={(e) => update({ sort: e.target.value === 'title' ? '' : e.target.value })} className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm">
                {SORTS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {products.status === 'loading' && !products.data && <Spinner label="Loading books" />}
          {products.status === 'error' && <ErrorState error={products.error} onRetry={products.reload} title="Could not load books" />}
          {products.data && products.status !== 'error' && (
            <div className={products.loading ? 'opacity-60 transition-opacity' : undefined} aria-busy={products.loading}>
              {products.data.items.length === 0 ? (
                <EmptyState title="No books match these filters" action={<Button variant="secondary" onClick={() => setParams(new URLSearchParams())}>Clear filters</Button>}>
                  Try removing a brand or choosing a wider delivery window.
                </EmptyState>
              ) : (
                <>
                  <ProductGrid products={products.data.items} />
                  <Pagination page={products.data.page} totalPages={products.data.total_pages} onChange={(p) => update({ page: p }, { keepPage: true })} />
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
