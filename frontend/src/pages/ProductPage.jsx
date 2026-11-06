import { Link, useParams } from 'react-router';
import { api } from '../api/client.js';
import { AddToBasketButton, BookCover, ProductCard } from '../components/ProductCard.jsx';
import { Badge, DeliveryTag, ErrorState, Spinner } from '../components/ui.jsx';
import { formatDate, formatMoney } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';

const RELATION_TITLE = {
  other_format: 'Also available as',
  series: 'More in this series',
  also_bought: 'Customers also bought',
  similar: 'Similar books',
  accessory: 'Goes well with',
};
const RELATION_ORDER = ['other_format', 'series', 'also_bought', 'similar', 'accessory'];

function RelatedProducts({ productId }) {
  const { data, status, error, reload } = useAsync((signal) => api.related(productId, signal), [productId]);
  if (status === 'loading') return <Spinner label="Loading suggestions" />;
  if (status === 'error') return <ErrorState error={error} onRetry={reload} title="Could not load related books" />;
  if (data.items.length === 0) return null;

  const groups = RELATION_ORDER.map((relation) => [relation, data.items.filter((i) => i.relation === relation)]).filter(([, items]) => items.length > 0);
  return (
    <section aria-labelledby="related-heading" className="mt-14">
      <h2 id="related-heading" className="font-serif text-2xl font-bold">
        You might also like
      </h2>
      {groups.map(([relation, items]) => (
        <div key={relation} className="mt-6">
          <h3 className="mb-3 text-sm font-semibold tracking-wide text-stone-600 uppercase">{RELATION_TITLE[relation]}</h3>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {items.map(({ product }) => (
              <li key={product.id}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

export default function ProductPage() {
  const { id } = useParams();
  const { data: product, status, error, reload } = useAsync((signal) => api.product(id, signal), [id]);

  if (status === 'loading') return <Spinner label="Loading book" />;
  if (status === 'error') {
    return error.status === 404 ? (
      <div className="py-16 text-center">
        <h1 className="font-serif text-3xl font-bold">Book not found</h1>
        <p className="mt-2 text-stone-600">It may have been withdrawn from sale.</p>
        <Link to="/books" className="mt-4 inline-block text-brand-700 underline underline-offset-2">
          Back to the catalogue
        </Link>
      </div>
    ) : (
      <ErrorState error={error} onRetry={reload} title="Could not load this book" />
    );
  }

  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-6 text-sm text-stone-600">
        <Link to="/books" className="hover:underline">
          Catalogue
        </Link>
        {product.categories[0] && (
          <>
            {' / '}
            <Link to={`/books?category_id=${product.categories[0].id}`} className="hover:underline">
              {product.categories[0].name}
            </Link>
          </>
        )}
      </nav>

      <div className="grid gap-10 md:grid-cols-[18rem_1fr]">
        <BookCover product={product} className="mx-auto w-full max-w-72" />

        <div>
          <h1 className="font-serif text-3xl leading-tight font-bold md:text-4xl">{product.title}</h1>
          <p className="mt-1 text-lg text-stone-600">by {product.authors.join(', ') || 'Unknown author'}</p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Badge tone="stone" className="capitalize">{product.format}</Badge>
            <Link to={`/books?brand=${product.brand.slug}`} className="text-sm text-brand-700 underline underline-offset-2">
              {product.brand.name}
            </Link>
            {product.categories.map((c) => (
              <Link key={c.id} to={`/books?category_id=${c.id}`} className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs text-stone-700 hover:bg-stone-200">
                {c.name}
              </Link>
            ))}
          </div>

          <p className="mt-6 text-3xl font-bold">{formatMoney(product.price, product.currency)}</p>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <DeliveryTag product={product} />
            {product.availability === 'low_stock' && <span className="text-sm font-medium text-amber-800">Only a few left</span>}
          </div>

          <AddToBasketButton product={product} className="mt-5 max-w-xs" />

          {product.description && <p className="mt-8 max-w-prose leading-relaxed text-stone-800">{product.description}</p>}

          <dl className="mt-8 grid max-w-md grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            {product.isbn13 && (
              <>
                <dt className="text-stone-500">ISBN-13</dt>
                <dd>{product.isbn13}</dd>
              </>
            )}
            {product.published_on && (
              <>
                <dt className="text-stone-500">Published</dt>
                <dd>{formatDate(product.published_on)}</dd>
              </>
            )}
            <dt className="text-stone-500">SKU</dt>
            <dd>{product.sku}</dd>
          </dl>
        </div>
      </div>

      <RelatedProducts productId={product.id} />
    </div>
  );
}
