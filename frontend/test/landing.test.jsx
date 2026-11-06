import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.js';
import { product, renderApp, signIn, signOut } from './utils.jsx';

const CATEGORIES = {
  items: [
    { id: 1, name: 'Fiction', children: [{ id: 2, name: 'Science fiction', children: [] }] },
    { id: 3, name: 'Non-fiction', children: [{ id: 4, name: 'Technology', children: [{ id: 5, name: 'Databases', children: [] }, { id: 6, name: 'Software engineering', children: [] }] }] },
  ],
};

beforeEach(() => {
  vi.spyOn(api, 'categories').mockResolvedValue(CATEGORIES);
  vi.spyOn(api, 'products').mockResolvedValue({ items: [product({ id: 1, title: 'Dune' })], page: 1, total_items: 1, total_pages: 1 });
  vi.spyOn(api, 'basket').mockResolvedValue({ items: [], item_count: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  signOut();
});

describe('Landing page', () => {
  it('links to leaf categories only', async () => {
    renderApp('/');
    const section = (await screen.findByRole('heading', { name: 'Shop by category' })).closest('section');
    const links = await within(section).findAllByRole('link');
    expect(links.map((a) => [a.textContent.replace('→', '').trim(), a.getAttribute('href')])).toEqual([
      ['Science fiction', '/books?category_id=2'],
      ['Databases', '/books?category_id=5'],
      ['Software engineering', '/books?category_id=6'],
    ]);
  });

  it('invites a signed-out visitor to sign in for recommendations and does not call the API', async () => {
    const recs = vi.spyOn(api, 'recommendations');
    renderApp('/');
    expect(await screen.findByText('Personal recommendations')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your next favourite book is here.' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^sign in/i }).length).toBeGreaterThan(0);
    expect(recs).not.toHaveBeenCalled();
  });

  it('greets a signed-in reader and explains why each book is recommended', async () => {
    signIn();
    vi.spyOn(api, 'recommendations').mockResolvedValue({
      items: [
        { reason: 'related_to_purchase', product: product({ id: 21, title: 'Neuromancer' }) },
        { reason: 'popular_with_similar_customers', product: product({ id: 22, title: 'Clean Code' }) },
      ],
    });
    renderApp('/');

    expect(await screen.findByRole('heading', { name: 'Welcome back, Rita.' })).toBeInTheDocument();
    expect(await screen.findByText('Because of your past orders')).toBeInTheDocument();
    expect(screen.getByText('Popular with readers like you')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Neuromancer' })).toHaveAttribute('href', '/books/21');
    expect(api.recommendations).toHaveBeenCalledWith(8, expect.anything());
  });

  it('explains that recommendations need a first order', async () => {
    signIn();
    vi.spyOn(api, 'recommendations').mockResolvedValue({ items: [] });
    renderApp('/');
    expect(await screen.findByText('Recommendations appear after your first order')).toBeInTheDocument();
  });

  it('shows an error for recommendations without hiding the rest of the page', async () => {
    signIn();
    vi.spyOn(api, 'recommendations').mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.'));
    renderApp('/');
    expect(await screen.findByText('Could not load your recommendations')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Dune' })).toBeInTheDocument();
  });
});
