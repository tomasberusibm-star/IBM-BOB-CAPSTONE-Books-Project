import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { saveSession } from '../src/api/client.js';
import { AppRoutes } from '../src/App.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';
import { BasketProvider } from '../src/context/BasketContext.jsx';

export const USER = { id: 7, email: 'reader@example.com', first_name: 'Rita', last_name: 'Reader', status: 'active' };

export const EMPTY_BASKET = { id: null, items: [], item_count: 0, subtotal_amount: '0.00', currency: 'USD' };

export function signIn() {
  saveSession({ token: 'test-token', user: USER });
}

export function signOut() {
  saveSession(null);
}

export function product(overrides = {}) {
  return {
    id: 1,
    sku: 'BK-1',
    title: 'The Test Book',
    authors: ['Ada Author'],
    format: 'paperback',
    price: '12.50',
    currency: 'USD',
    availability: 'in_stock',
    tentative_delivery_date: null,
    ...overrides,
  };
}

/** Renders the whole app (providers + routes) at `path`, like the browser would. */
export function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <BasketProvider>
          <AppRoutes />
        </BasketProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}
