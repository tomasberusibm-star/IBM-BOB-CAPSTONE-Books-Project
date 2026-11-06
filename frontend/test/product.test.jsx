import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.js';
import { product, renderApp, signIn, signOut } from './utils.jsx';

const DDIA = {
  ...product({ id: 10, sku: 'BK-DDIA-001', title: 'Designing Data-Intensive Applications', authors: ['Martin Kleppmann'], price: '44.99' }),
  description: 'The big ideas behind reliable systems.',
  isbn13: '9781449373320',
  published_on: '2017-03-16',
  brand: { id: 2, slug: 'oreilly', name: "O'Reilly" },
  categories: [{ id: 5, name: 'Databases' }],
};

const RELATED = {
  items: [
    { relation: 'similar', product: product({ id: 12, title: 'Patterns of Distributed Systems' }) },
    { relation: 'other_format', product: product({ id: 11, title: 'DDIA (e-book)', format: 'ebook', availability: 'always_available' }) },
    { relation: 'also_bought', product: product({ id: 13, title: 'Clean Code' }) },
  ],
};

beforeEach(() => {
  vi.spyOn(api, 'product').mockResolvedValue(DDIA);
  vi.spyOn(api, 'related').mockResolvedValue(RELATED);
  vi.spyOn(api, 'basket').mockResolvedValue({ items: [], item_count: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  signOut();
});

describe('Product page and related-product selection (CAT)', () => {
  it('shows the book details with links back into the catalogue', async () => {
    renderApp('/books/10');
    expect(await screen.findByRole('heading', { level: 1, name: 'Designing Data-Intensive Applications' })).toBeInTheDocument();
    expect(screen.getByText('by Martin Kleppmann')).toBeInTheDocument();
    expect(screen.getByText('$44.99')).toBeInTheDocument();
    expect(screen.getByText('9781449373320')).toBeInTheDocument();
    expect(screen.getByText('BK-DDIA-001')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "O'Reilly" })).toHaveAttribute('href', '/books?brand=oreilly');
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', { name: 'Databases' })).toHaveAttribute('href', '/books?category_id=5');
    expect(api.product).toHaveBeenCalledWith('10', expect.anything());
  });

  it('groups related books by relation, in a fixed order, with a heading each', async () => {
    renderApp('/books/10');
    expect(await screen.findByRole('heading', { name: 'You might also like' })).toBeInTheDocument();

    const headings = (await screen.findAllByRole('heading', { level: 3 }))
      .map((h) => h.textContent)
      .filter((t) => ['Also available as', 'Customers also bought', 'Similar books'].includes(t));
    expect(headings).toEqual(['Also available as', 'Customers also bought', 'Similar books']);

    const section = screen.getByRole('region', { name: 'You might also like' });
    expect(within(section).getByRole('link', { name: 'DDIA (e-book)' })).toHaveAttribute('href', '/books/11');
    expect(within(section).getByRole('link', { name: 'Clean Code' })).toHaveAttribute('href', '/books/13');
    expect(api.related).toHaveBeenCalledWith(10, expect.anything());
  });

  it('omits groups that have no members', async () => {
    api.related.mockResolvedValue({ items: [RELATED.items[0]] });
    renderApp('/books/10');
    expect(await screen.findByRole('heading', { name: 'Similar books' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Also available as' })).not.toBeInTheDocument();
  });

  it('renders no related section at all when there is nothing to suggest', async () => {
    api.related.mockResolvedValue({ items: [] });
    renderApp('/books/10');
    await screen.findByRole('heading', { level: 1 });
    await vi.waitFor(() => expect(api.related).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'You might also like' })).not.toBeInTheDocument();
  });

  it('keeps the book usable if only the suggestions fail', async () => {
    api.related.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.'));
    renderApp('/books/10');
    expect(await screen.findByText('Could not load related books')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Designing Data-Intensive Applications' })).toBeInTheDocument();
  });

  it('shows a friendly not-found view for an unknown book', async () => {
    api.product.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Product not found'));
    renderApp('/books/9999');
    expect(await screen.findByRole('heading', { name: 'Book not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the catalogue' })).toHaveAttribute('href', '/books');
    expect(api.related).not.toHaveBeenCalled();
  });

  it('shows a retryable error (not "not found") for a server failure', async () => {
    api.product.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.'));
    renderApp('/books/10');
    expect(await screen.findByText('Could not load this book')).toBeInTheDocument();
    expect(screen.queryByText('Book not found')).not.toBeInTheDocument();
  });

  it('sends a signed-out visitor to sign in instead of adding to the basket', async () => {
    const add = vi.spyOn(api, 'addToBasket');
    const user = userEvent.setup();
    renderApp('/books/10');
    await user.click(await screen.findByRole('button', { name: 'Add to basket' }));

    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(add).not.toHaveBeenCalled();
  });

  it('adds to the basket when signed in and updates the header count', async () => {
    signIn();
    const add = vi.spyOn(api, 'addToBasket').mockResolvedValue({ items: [], item_count: 1, subtotal_amount: '44.99' });
    const user = userEvent.setup();
    renderApp('/books/10');

    await user.click(await screen.findByRole('button', { name: 'Add to basket' }));

    expect(add).toHaveBeenCalledWith(10, 1);
    expect(await screen.findByText('Added to your basket.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Basket, 1 items' })).toBeInTheDocument();
  });

  it('refuses to add a sold-out book', async () => {
    api.product.mockResolvedValue({ ...DDIA, availability: 'out_of_stock', tentative_delivery_date: '2026-07-01' });
    renderApp('/books/10');
    expect(await screen.findByRole('button', { name: 'Out of stock' })).toBeDisabled();
  });

  it('surfaces the server message when adding fails', async () => {
    signIn();
    vi.spyOn(api, 'addToBasket').mockRejectedValue(new ApiError(409, 'INSUFFICIENT_STOCK', 'Only 1 copy is left.'));
    const user = userEvent.setup();
    renderApp('/books/10');
    await user.click(await screen.findByRole('button', { name: 'Add to basket' }));
    expect(await screen.findByText('Only 1 copy is left.')).toBeInTheDocument();
  });
});
