import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.js';
import { EMPTY_BASKET, USER, renderApp, signIn, signOut } from './utils.jsx';

const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();

function order(overrides = {}) {
  return {
    id: 90,
    order_number: 'BK-0090',
    status: 'paid',
    currency: 'USD',
    total_amount: '29.00',
    discount_amount: '0.00',
    gift_points_redeemed: 0,
    placed_at: new Date(Date.now() - 3_600_000).toISOString(),
    items: [{ product_id: 1, title: 'The Test Book', quantity: 2, line_total: '25.00' }],
    can_cancel: true,
    cancellable_until: inHours(47),
    can_reorder: true,
    ...overrides,
  };
}

const page = (items) => ({ items, page: 1, page_size: 5, total_items: items.length, total_pages: 1 });

beforeEach(() => {
  signIn();
  vi.spyOn(api, 'basket').mockResolvedValue(EMPTY_BASKET);
});

afterEach(() => {
  vi.restoreAllMocks();
  signOut();
});

describe('Order history', () => {
  it('requires sign-in', async () => {
    signOut();
    renderApp('/orders');
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });

  it('loads the signed-in user\u2019s orders with status, items and total', async () => {
    const orders = vi.spyOn(api, 'orders').mockResolvedValue(page([order()]));
    renderApp('/orders');

    expect(await screen.findByRole('heading', { name: 'Order BK-0090' })).toBeInTheDocument();
    expect(orders.mock.calls[0].slice(0, 2)).toEqual([USER.id, { page: 1, page_size: 5 }]);
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'The Test Book' })).toHaveAttribute('href', '/books/1');
    expect(screen.getByText('$29.00')).toBeInTheDocument();
  });

  it('shows an empty state with no orders', async () => {
    vi.spyOn(api, 'orders').mockResolvedValue(page([]));
    renderApp('/orders');
    expect(await screen.findByRole('heading', { name: 'No orders yet' })).toBeInTheDocument();
  });

  it('shows an error with a retry when loading fails', async () => {
    const orders = vi.spyOn(api, 'orders').mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.'));
    orders.mockResolvedValue(page([order()]));
    const user = userEvent.setup();
    renderApp('/orders');

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Order BK-0090' })).toBeInTheDocument();
  });

  describe('Buy In Again', () => {
    it('adds the order back into the basket and links to it', async () => {
      vi.spyOn(api, 'orders').mockResolvedValue(page([order()]));
      const reorder = vi.spyOn(api, 'reorder').mockResolvedValue({
        basket: { id: 3, currency: 'USD', item_count: 2, subtotal_amount: '25.00', items: [] },
        added: [{ product_id: 1, quantity: 2 }],
        skipped: [],
      });
      const user = userEvent.setup();
      renderApp('/orders');

      await user.click(await screen.findByRole('button', { name: 'Buy In Again, order BK-0090' }));

      expect(reorder).toHaveBeenCalledWith(90);
      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent('Added 1 book to your basket');
      expect(within(status).getByRole('link', { name: 'Go to basket' })).toHaveAttribute('href', '/basket');
      // the header badge follows the basket returned by the server
      expect(screen.getByRole('link', { name: 'Basket, 2 items' })).toBeInTheDocument();
    });

    it('reports books that could not be re-added', async () => {
      vi.spyOn(api, 'orders').mockResolvedValue(page([order()]));
      vi.spyOn(api, 'reorder').mockResolvedValue({
        basket: EMPTY_BASKET,
        added: [{ product_id: 1, quantity: 2 }],
        skipped: [{ product_id: 5, title: 'Gone Book', reason: 'product_unavailable' }],
      });
      const user = userEvent.setup();
      renderApp('/orders');
      await user.click(await screen.findByRole('button', { name: /Buy In Again/ }));

      expect(await screen.findByText('Gone Book was not added (no longer sold).')).toBeInTheDocument();
    });

    it('explains when nothing is available any more', async () => {
      vi.spyOn(api, 'orders').mockResolvedValue(page([order()]));
      vi.spyOn(api, 'reorder').mockRejectedValue(new ApiError(409, 'NOTHING_TO_REORDER', 'None available.'));
      const user = userEvent.setup();
      renderApp('/orders');
      await user.click(await screen.findByRole('button', { name: /Buy In Again/ }));

      expect(await screen.findByRole('alert')).toHaveTextContent('nothing was added to your basket');
    });

    it('is disabled when no book in the order is still sold', async () => {
      vi.spyOn(api, 'orders').mockResolvedValue(page([order({ can_reorder: false })]));
      renderApp('/orders');
      expect(await screen.findByRole('button', { name: /Buy In Again/ })).toBeDisabled();
    });
  });

  describe('Cancellation (48-hour window)', () => {
    it('offers cancel only inside the window, with a confirmation step', async () => {
      const orders = vi.spyOn(api, 'orders').mockResolvedValue(page([order()]));
      const cancel = vi.spyOn(api, 'cancelOrder').mockResolvedValue(order({ status: 'cancelled', can_cancel: false }));
      const user = userEvent.setup();
      renderApp('/orders');

      expect(await screen.findByText(/You can cancel this order for 48 hours/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Cancel order BK-0090' }));
      expect(cancel).not.toHaveBeenCalled(); // nothing happens until confirmed

      orders.mockResolvedValue(page([order({ status: 'cancelled', can_cancel: false, cancellable_until: null })]));
      await user.click(screen.getByRole('button', { name: 'Yes, cancel order' }));

      expect(cancel).toHaveBeenCalledWith(90);
      expect(await screen.findByText(/Order BK-0090 was cancelled/)).toBeInTheDocument();
      expect(screen.getByText('Cancelled')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Cancel order/ })).not.toBeInTheDocument();
    });

    it('lets the customer back out of the confirmation', async () => {
      vi.spyOn(api, 'orders').mockResolvedValue(page([order()]));
      const cancel = vi.spyOn(api, 'cancelOrder');
      const user = userEvent.setup();
      renderApp('/orders');

      await user.click(await screen.findByRole('button', { name: 'Cancel order BK-0090' }));
      await user.click(screen.getByRole('button', { name: 'Keep order' }));

      expect(cancel).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Cancel order BK-0090' })).toBeInTheDocument();
    });

    it('hides cancel once the window has closed', async () => {
      const placed = new Date(Date.now() - 72 * 3_600_000).toISOString();
      vi.spyOn(api, 'orders').mockResolvedValue(page([order({ placed_at: placed, can_cancel: false, cancellable_until: null })]));
      renderApp('/orders');

      expect(await screen.findByText('The 48-hour cancellation window for this order has closed.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Cancel order/ })).not.toBeInTheDocument();
    });

    it('hides cancel for shipped orders and says why', async () => {
      vi.spyOn(api, 'orders').mockResolvedValue(page([order({ status: 'shipped', can_cancel: false, cancellable_until: null })]));
      renderApp('/orders');

      expect(await screen.findByText('This order has shipped and can no longer be cancelled.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Cancel order/ })).not.toBeInTheDocument();
    });

    it('shows the server message if the window closed while the page was open', async () => {
      const orders = vi.spyOn(api, 'orders').mockResolvedValue(page([order()]));
      vi.spyOn(api, 'cancelOrder').mockRejectedValue(
        new ApiError(409, 'CANCELLATION_WINDOW_EXPIRED', 'Orders can only be cancelled within 48 hours of being placed.'),
      );
      const user = userEvent.setup();
      renderApp('/orders');

      await user.click(await screen.findByRole('button', { name: 'Cancel order BK-0090' }));
      orders.mockResolvedValue(page([order({ can_cancel: false, cancellable_until: null })]));
      await user.click(screen.getByRole('button', { name: 'Yes, cancel order' }));

      expect(await screen.findByText('The 48-hour cancellation window for this order has closed.')).toBeInTheDocument();
    });
  });
});
