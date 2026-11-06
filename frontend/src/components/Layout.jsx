import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../context/AuthContext.jsx';
import { useBasket } from '../context/BasketContext.jsx';
import { buttonClass } from './ui.jsx';

const navLink = ({ isActive }) =>
  `rounded-md px-3 py-2 text-sm font-medium ${isActive ? 'bg-brand-50 text-brand-800' : 'text-stone-700 hover:bg-stone-100'}`;

function SearchBox() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  return (
    <form
      role="search"
      className="flex-1 sm:max-w-md"
      onSubmit={(e) => {
        e.preventDefault();
        const text = q.trim();
        navigate(text ? `/books?q=${encodeURIComponent(text)}` : '/books');
      }}
    >
      <label htmlFor="site-search" className="sr-only">
        Search books
      </label>
      <input
        id="site-search"
        type="search"
        value={q}
        maxLength={200}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search titles and descriptions"
        className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm placeholder:text-stone-400"
      />
    </form>
  );
}

export function Layout() {
  const { isAuthenticated, user, logout } = useAuth();
  const { basket } = useBasket();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-stone-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <Link to="/" className="font-serif text-xl font-bold tracking-tight text-brand-800">
            Bookshelf
          </Link>
          <nav aria-label="Main" className="flex items-center gap-1">
            <NavLink to="/" end className={navLink}>
              Home
            </NavLink>
            <NavLink to="/books" className={navLink}>
              Catalogue
            </NavLink>
            {isAuthenticated && (
              <NavLink to="/orders" className={navLink}>
                My orders
              </NavLink>
            )}
          </nav>
          <SearchBox />
          <div className="ml-auto flex items-center gap-2">
            <Link to="/basket" className={buttonClass('secondary', 'sm')} aria-label={`Basket, ${basket.item_count} items`}>
              Basket
              <span className="rounded-full bg-brand-600 px-2 text-xs font-semibold text-white" aria-hidden="true">
                {basket.item_count}
              </span>
            </Link>
            {isAuthenticated ? (
              <>
                <span className="hidden text-sm text-stone-600 md:inline">Hi, {user.first_name}</span>
                <button
                  type="button"
                  className={buttonClass('secondary', 'sm')}
                  onClick={async () => {
                    await logout();
                    navigate('/');
                  }}
                >
                  Sign out
                </button>
              </>
            ) : (
              <Link to="/login" className={buttonClass('primary', 'sm')}>
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Outlet />
      </main>

      <footer className="border-t border-stone-200 bg-white py-6 text-center text-sm text-stone-500">
        IBM BOB CAPSTONE Books Project &middot; training project
      </footer>
    </div>
  );
}
