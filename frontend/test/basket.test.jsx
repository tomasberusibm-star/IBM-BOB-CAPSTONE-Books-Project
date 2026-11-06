import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.js';
import { product, renderApp, signIn, signOut } from './utils.jsx';

const BASKET = {
  id: 3,
  currency: 'USD',
  item_count: 2,
  subtotal_amount: '25.00',
  items: [{ product: product(), quantity: 2, line_total: '25.00' }],
};

const ADDRESS = {
  id: 11,
  recipient_name: 'Rita Reader',
  line1: '1 Library Lane',
  city: 'Springfield',
  region: 'IL',
  postal_code: '62701',
  country_code: 'US',
  is_default_shipping: true,
};

// $25.00 of books + $4.00 shipping. 1,000 points = $10.00, usable on books only.
const SUMMARY = {
  currency: 'USD',
  subtotal_amount: '25.00',
  shipping_amount: '4.00',
  tax_amount: '0.00',
  total_amount: '29.00',
  gift_points_balance: 1000,
  gift_point_value: '0.01',
  max_redeemable_points: 1000,
  tentative_delivery_date: '2026-06-14',
  shipping_address: ADDRESS,
};

const ORDER = {
  id: 90,
  order_number: 'BK-0090',
  status: 'paid',
  currency: 'USD',
  total_amount: '19.00',
  discount_amount: '10.00',
  shipping_amount: '4.00',
  gift_points_redeemed: 1000,
  placed_at: '2026-06-10T12:00:00Z',
  items: [{ product_id: 1, title: 'The Test Book', quantity: 2, line_total: '25.00', tentative_delivery_date: null }],
};

beforeEach(() => {
  signIn();
  vi.spyOn(api, 'basket').mockResolvedValue(BASKET);
  vi.spyOn(api, 'addresses').mockResolvedValue({ items: [ADDRESS] });
  vi.spyOn(api, 'setCheckoutAddress').mockResolvedValue(SUMMARY);
});

afterEach(() => {
  vi.restoreAllMocks();
  signOut();
});

async function reachPayment(user) {
  renderApp('/basket');
  await user.click(await screen.findByRole('button', { name: 'Use this address' }));
  return screen.findByRole('switch', { name: /gift points/i });
}

const summary = () => within(screen.getByRole('complementary', { name: 'Order summary' }));

describe('Basket and checkout', () => {
  it('sends signed-out visitors to the login page', async () => {
    signOut();
    renderApp('/basket');
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });

  it('prices the order only after an address is confirmed', async () => {
    const user = userEvent.setup();
    renderApp('/basket');

    expect(await screen.findByText(/Choose a shipping address/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use this address' }));

    expect(api.setCheckoutAddress).toHaveBeenCalledWith({ address_id: 11 });
    expect(await summary().findByText('Total to pay')).toBeInTheDocument();
    expect(summary().getByText('$29.00')).toBeInTheDocument();
  });

  it('applies gift points to the books only and updates the total', async () => {
    const user = userEvent.setup();
    const toggle = await reachPayment(user);
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(summary().getByText('Gift points (1,000)')).toBeInTheDocument();
    expect(summary().getByText('-$10.00')).toBeInTheDocument();
    expect(summary().getByText('$19.00')).toBeInTheDocument(); // 29.00 - 10.00

    await user.click(toggle);
    expect(summary().queryByText('-$10.00')).not.toBeInTheDocument();
  });

  it('asks for a card when the total is not fully covered, and sends the chosen card type', async () => {
    const pay = vi.spyOn(api, 'pay').mockResolvedValue({
      order: { ...ORDER, order_number: 'BK-0100', gift_points_redeemed: 0, discount_amount: '0.00', total_amount: '29.00' },
      payment: { card_type: 'debit', card_last4: '4242' },
      gift_points_balance: 1000,
    });
    const user = userEvent.setup();
    await reachPayment(user);

    await user.click(screen.getByRole('button', { name: /^Pay / }));
    expect(await screen.findByText('Choose a test card to pay the remaining amount.')).toBeInTheDocument();
    expect(pay).not.toHaveBeenCalled();

    await user.click(screen.getByRole('radio', { name: 'Debit card' }));
    await user.selectOptions(screen.getByLabelText('Test card'), 'tok_visa_4242');
    await user.click(screen.getByRole('button', { name: /^Pay / }));

    expect(await screen.findByRole('heading', { name: /your order is placed/ })).toBeInTheDocument();
    expect(pay).toHaveBeenCalledTimes(1);
    expect(pay.mock.calls[0][0]).toEqual({ card: { payment_token: 'tok_visa_4242', card_type: 'debit' } });
    expect(pay.mock.calls[0][1]).toMatch(/^[0-9a-f-]{36}$/); // Idempotency-Key
    expect(screen.getByText(/card ending 4242/)).toBeInTheDocument();
  });

  it('never asks for raw card details', async () => {
    const user = userEvent.setup();
    await reachPayment(user);
    expect(screen.queryByLabelText(/card number/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/cvv|cvc|security code/i)).not.toBeInTheDocument();
    expect(screen.getByText(/real card details are never entered/i)).toBeInTheDocument();
  });

  it('pays with points alone when they cover the whole order', async () => {
    vi.spyOn(api, 'setCheckoutAddress').mockResolvedValue({
      ...SUMMARY,
      subtotal_amount: '8.00',
      shipping_amount: '0.00',
      total_amount: '8.00',
      gift_points_balance: 5000,
      max_redeemable_points: 800,
    });
    const pay = vi.spyOn(api, 'pay').mockResolvedValue({
      order: { ...ORDER, gift_points_redeemed: 800, discount_amount: '8.00', total_amount: '0.00' },
      payment: null,
      gift_points_balance: 4200,
    });
    const user = userEvent.setup();
    const toggle = await reachPayment(user);
    await user.click(toggle);

    expect(screen.getByText(/gift points cover the whole order/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Place order' }));

    await screen.findByRole('heading', { name: /your order is placed/ });
    expect(pay.mock.calls[0][0]).toEqual({ gift_points_to_redeem: 800 });
    expect(screen.getByText(/Paid in full with gift points/)).toBeInTheDocument();
  });

  it('shows a declined payment without losing the checkout', async () => {
    vi.spyOn(api, 'pay').mockRejectedValue(new ApiError(402, 'PAYMENT_DECLINED', 'Your card was declined.'));
    const user = userEvent.setup();
    await reachPayment(user);
    await user.selectOptions(screen.getByLabelText('Test card'), 'tok_declined_0002');
    await user.click(screen.getByRole('button', { name: /^Pay / }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your card was declined.');
    expect(alert).toHaveTextContent('You have not been charged.');
    await waitFor(() => expect(screen.getByRole('button', { name: /^Pay / })).toBeEnabled());
  });
});
