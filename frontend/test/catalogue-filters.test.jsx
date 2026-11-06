import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.js';
import { product, renderApp, signOut } from './utils.jsx';

const CATEGORIES = {
  items: [
    { id: 1, name: 'Fiction', children: [{ id: 2, name: 'Science fiction', children: [] }] },
    {
      id: 3,
      name: 'Non-fiction',
      children: [{ id: 4, name: 'Technology', children: [{ id: 5, name: 'Databases', children: [] }] }],
    },
  ],
};
const BRANDS = {
  items: [
    { id: 1, slug: 'ace', name: 'Ace' },
    { id: 2, slug: 'oreilly', name: "O'Reilly" },
  ],
};
const page = (items, extra = {}) => ({ items, page: 1, page_size: 12, total_items: items.length, total_pages: 1, ...extra });

/** The query object of the most recent GET /products call. */
const lastQuery = () => api.products.mock.calls.at(-1)[0];

beforeEach(() => {
  vi.spyOn(api, 'categories').mockResolvedValue(CATEGORIES);
  vi.spyOn(api, 'brands').mockResolvedValue(BRANDS);
  vi.spyOn(api, 'products').mockResolvedValue(page([product({ id: 1, title: 'Dune' }), product({ id: 2, title: 'Neuromancer' })]));
  vi.spyOn(api, 'basket').mockResolvedValue({ items: [], item_count: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  signOut();
});

describe('Catalogue filtering (CAT)', () => {
  it('lists every book with no filters applied and a result count', async () => {
    renderApp('/books');
    expect(await screen.findByRole('link', { name: 'Dune' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'All books' })).toBeInTheDocument();
    expect(screen.getByText('2 books')).toBeInTheDocument();
    expect(lastQuery()).toMatchObject({ category_id: '', brand: [], sort: 'title', page: 1, page_size: 12 });
    expect(screen.queryByRole('button', { name: 'Clear all filters' })).not.toBeInTheDocument();
  });

  it('offers the whole category tree, indented by depth', async () => {
    renderApp('/books');
    const select = await screen.findByLabelText('Category');
    await waitFor(() => expect(select).toBeEnabled());
    const names = [...select.querySelectorAll('option')].map((o) => o.textContent.replaceAll('\u00A0', '').trim());
    expect(names).toEqual(['All categories', 'Fiction', 'Science fiction', 'Non-fiction', 'Technology', 'Databases']);
  });

  it('filters by a category chosen in the selector and retitles the page', async () => {
    const user = userEvent.setup();
    renderApp('/books');
    const select = await screen.findByLabelText('Category');
    await waitFor(() => expect(select).toBeEnabled());

    await user.selectOptions(select, '5');

    await waitFor(() => expect(lastQuery().category_id).toBe('5'));
    expect(await screen.findByRole('heading', { name: 'Databases' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear all filters' })).toBeInTheDocument();
  });

  it('starts from a category deep-link', async () => {
    renderApp('/books?category_id=2');
    expect(await screen.findByRole('heading', { name: 'Science fiction' })).toBeInTheDocument();
    expect(lastQuery().category_id).toBe('2');
  });

  it('combines several brands and un-ticking one removes it from the query', async () => {
    const user = userEvent.setup();
    renderApp('/books');
    await user.click(await screen.findByRole('checkbox', { name: 'Ace' }));
    await user.click(screen.getByRole('checkbox', { name: "O'Reilly" }));

    await waitFor(() => expect(lastQuery().brand).toEqual(['ace', 'oreilly']));
    expect(screen.getByRole('checkbox', { name: 'Ace' })).toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: 'Ace' }));
    await waitFor(() => expect(lastQuery().brand).toEqual(['oreilly']));
  });

  it('keeps a brand deep-link ticked', async () => {
    renderApp('/books?brand=oreilly');
    expect(await screen.findByRole('checkbox', { name: "O'Reilly" })).toBeChecked();
    expect(lastQuery().brand).toEqual(['oreilly']);
  });

  it('sorts, and omits the default sort from the URL state', async () => {
    const user = userEvent.setup();
    renderApp('/books');
    await screen.findByRole('link', { name: 'Dune' });

    await user.selectOptions(screen.getByLabelText('Sort by'), 'price_desc');
    await waitFor(() => expect(lastQuery().sort).toBe('price_desc'));

    await user.selectOptions(screen.getByLabelText('Sort by'), 'title');
    await waitFor(() => expect(lastQuery().sort).toBe('title'));
  });

  it('hides out-of-stock books on request', async () => {
    const user = userEvent.setup();
    renderApp('/books');
    await user.click(await screen.findByRole('checkbox', { name: 'Hide out-of-stock' }));
    await waitFor(() => expect(lastQuery().available_only).toBe(true));
  });

  it('turns a delivery window into a deliver_by date', async () => {
    const user = userEvent.setup();
    renderApp('/books');
    await screen.findByRole('link', { name: 'Dune' });

    await user.selectOptions(screen.getByLabelText('Delivery'), '3');

    await waitFor(() => expect(lastQuery().deliver_by).toMatch(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('shows the search term as the heading', async () => {
    renderApp('/books?q=dune');
    expect(await screen.findByRole('heading', { name: 'Results for "dune"' })).toBeInTheDocument();
    expect(lastQuery().q).toBe('dune');
  });

  it('clears every filter in one click', async () => {
    const user = userEvent.setup();
    renderApp('/books?category_id=2&brand=ace&available_only=true');
    await user.click(await screen.findByRole('button', { name: 'Clear all filters' }));

    await waitFor(() => expect(lastQuery()).toMatchObject({ category_id: '', brand: [], available_only: undefined }));
    expect(screen.queryByRole('button', { name: 'Clear all filters' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'All books' })).toBeInTheDocument();
  });

  it('explains an empty result and lets the visitor recover', async () => {
    const user = userEvent.setup();
    api.products.mockResolvedValueOnce(page([]));
    renderApp('/books?brand=ace');

    expect(await screen.findByText('No books match these filters')).toBeInTheDocument();
    expect(screen.getByText('0 books')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('link', { name: 'Dune' })).toBeInTheDocument();
  });

  it('uses the singular for exactly one match', async () => {
    api.products.mockResolvedValue(page([product({ id: 9, title: 'Solo' })]));
    renderApp('/books');
    expect(await screen.findByText('1 book')).toBeInTheDocument();
  });

  it('pages through results and returns to page 1 when a filter changes', async () => {
    const user = userEvent.setup();
    api.products.mockResolvedValue(page([product({ id: 1, title: 'Dune' })], { total_items: 30, total_pages: 3 }));
    renderApp('/books');

    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastQuery().page).toBe(2));

    await user.click(await screen.findByRole('checkbox', { name: 'Ace' }));
    await waitFor(() => expect(lastQuery()).toMatchObject({ page: 1, brand: ['ace'] }));
  });

  it('hides pagination when everything fits on one page', async () => {
    renderApp('/books');
    await screen.findByRole('link', { name: 'Dune' });
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument();
  });

  it('shows a retryable error if the catalogue cannot be loaded', async () => {
    const user = userEvent.setup();
    api.products.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.'));
    renderApp('/books');

    expect(await screen.findByText('Could not load books')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByRole('link', { name: 'Dune' })).toBeInTheDocument();
  });

  it('still lets visitors browse when the brand list fails', async () => {
    api.brands.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'x'));
    renderApp('/books');
    expect(await screen.findByText('Could not load brands.')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Dune' })).toBeInTheDocument();
  });
});
