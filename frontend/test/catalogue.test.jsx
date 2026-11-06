import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductCard } from '../src/components/ProductCard.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';
import { BasketProvider } from '../src/context/BasketContext.jsx';
import { product, signOut } from './utils.jsx';

function renderCard(p) {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <BasketProvider>
          <ProductCard product={p} />
        </BasketProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  signOut();
});

describe('ProductCard', () => {
  it('shows title, author, price and a tentative delivery date tag', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 10));
    renderCard(product({ tentative_delivery_date: '2026-06-12' }));

    expect(screen.getByRole('link', { name: 'The Test Book' })).toHaveAttribute('href', '/books/1');
    // the author also appears on the decorative (aria-hidden) cover, so ignore that copy
    expect(screen.getAllByText('Ada Author').some((el) => !el.closest('[aria-hidden="true"]'))).toBe(true);
    expect(screen.getByText('$12.50')).toBeInTheDocument();
    expect(screen.getByText('Arrives Fri, Jun 12')).toBeInTheDocument();
  });

  it('tags e-books as an instant download', () => {
    renderCard(product({ format: 'ebook', availability: 'always_available' }));
    expect(screen.getByText('Instant download')).toBeInTheDocument();
  });

  it('warns about low stock', () => {
    renderCard(product({ availability: 'low_stock', tentative_delivery_date: '2026-06-12' }));
    expect(screen.getByText('Only a few left')).toBeInTheDocument();
  });

  it('disables adding a sold-out book and says when it is back', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 10));
    renderCard(product({ availability: 'out_of_stock', tentative_delivery_date: '2026-07-01' }));

    expect(screen.getByText('Back in stock Wed, Jul 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Out of stock' })).toBeDisabled();
  });
});
