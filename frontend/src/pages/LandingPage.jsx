import { Link } from 'react-router';
import { api } from '../api/client.js';
import { BookCover, ProductGrid } from '../components/ProductCard.jsx';
import { EmptyState, ErrorState, LinkButton, Spinner } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useAsync } from '../lib/useAsync.js';

const REASON_TEXT = {
  related_to_purchase: 'Because of your past orders',
  same_category: 'In a category you like',
  popular_with_similar_customers: 'Popular with readers like you',
};

function Section({ title, action, children }) {
  return (
    <section className="mt-12">
      <div className="mb-4 flex items-end justify-between">
        <h2 className="font-serif text-2xl font-bold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Recommended() {
  const { data, status, error, reload } = useAsync((signal) => api.recommendations(8, signal), []);
  if (status === 'loading') return <Spinner label="Finding picks for you" />;
  if (status === 'error') return <ErrorState error={error} onRetry={reload} title="Could not load your recommendations" />;
  if (data.items.length === 0) {
    return (
      <EmptyState title="Recommendations appear after your first order">
        We suggest books based on what you have bought before. Browse the catalogue to get started.
      </EmptyState>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {data.items.map(({ product, reason }) => (
        <li key={product.id} className="flex flex-col">
          <p className="mb-1 text-xs font-medium tracking-wide text-brand-700 uppercase">{REASON_TEXT[reason]}</p>
          <ProductGrid products={[product]} />
        </li>
      ))}
    </ul>
  );
}

export default function LandingPage() {
  const { isAuthenticated, user } = useAuth();
  const categories = useAsync((signal) => api.categories(signal), []);
  const featured = useAsync((signal) => api.products({ sort: 'newest', page_size: 8 }, signal), []);

  return (
    <div>
      <section className="grid items-center gap-8 rounded-3xl bg-gradient-to-br from-brand-800 to-brand-600 px-8 py-12 text-white md:grid-cols-[1.4fr_1fr]">
        <div>
          <p className="text-sm font-medium tracking-widest text-white/70 uppercase">Bookshelf</p>
          <h1 className="mt-2 font-serif text-4xl leading-tight font-bold md:text-5xl">
            {isAuthenticated ? `Welcome back, ${user.first_name}.` : 'Your next favourite book is here.'}
          </h1>
          <p className="mt-4 max-w-xl text-lg text-white/85">
            Paperbacks delivered in days, e-books in seconds. Earn gift points on every order and buy your favourites again in one click.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <LinkButton to="/books" size="lg" variant="secondary">
              Browse the catalogue
            </LinkButton>
            {isAuthenticated ? (
              <Link to="/orders" className="inline-flex items-center rounded-lg border border-white/50 px-6 py-3 font-medium hover:bg-white/10">
                Buy again from my orders
              </Link>
            ) : (
              <Link to="/login" className="inline-flex items-center rounded-lg border border-white/50 px-6 py-3 font-medium hover:bg-white/10">
                Sign in
              </Link>
            )}
          </div>
        </div>
        <div aria-hidden="true" className="hidden justify-end gap-3 md:flex">
          {(featured.data?.items ?? []).slice(0, 3).map((p, i) => (
            <BookCover key={p.id} product={p} className={`w-28 ${i === 1 ? '-translate-y-4' : ''}`} />
          ))}
        </div>
      </section>

      <Section title="Shop by category">
        {categories.status === 'loading' && <Spinner label="Loading categories" />}
        {categories.status === 'error' && <ErrorState error={categories.error} onRetry={categories.reload} />}
        {categories.status === 'ready' && (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {categories.data.items.flatMap((top) =>
              top.children.length === 0
                ? [top]
                : top.children.flatMap((c) => (c.children.length ? c.children : [c])),
            ).map((c) => (
              <li key={c.id}>
                <Link to={`/books?category_id=${c.id}`} className="block rounded-xl border border-stone-200 bg-white p-5 font-medium hover:border-brand-600 hover:shadow-sm">
                  {c.name}
                  <span aria-hidden="true" className="float-right text-brand-600">&rarr;</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Recommended for you" action={isAuthenticated ? null : <Link to="/login" className="text-sm font-medium text-brand-700 underline underline-offset-2">Sign in for personal picks</Link>}>
        {isAuthenticated ? (
          <Recommended />
        ) : (
          <EmptyState title="Personal recommendations" action={<LinkButton to="/login">Sign in</LinkButton>}>
            Sign in and we will suggest books based on your order history.
          </EmptyState>
        )}
      </Section>

      <Section title="New and noteworthy" action={<Link to="/books?sort=newest" className="text-sm font-medium text-brand-700 underline underline-offset-2">See all</Link>}>
        {featured.status === 'loading' && <Spinner label="Loading books" />}
        {featured.status === 'error' && <ErrorState error={featured.error} onRetry={featured.reload} />}
        {featured.status === 'ready' && <ProductGrid products={featured.data.items} />}
      </Section>
    </div>
  );
}
