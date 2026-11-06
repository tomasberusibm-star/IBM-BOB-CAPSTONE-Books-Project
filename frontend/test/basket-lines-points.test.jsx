import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.js';
import { product, renderApp, signIn, signOut } from './utils.jsx';

const ADDRESS = { id: 11, recipient_name: 'Rita Reader', line1: '1 Library Lane', city: 'Springfield', region: 'IL', postal_code: '62701', country_code: 'US', is_default_shipping: true };

const line = (p, quantity) => ({ product: p, quantity, line_total: (Number(p.price) * quantity).toFixed(2) });
const basketOf = (...lines) => ({
  id: 3,
  currency: 'USD',
  items: lines,
  item_count: lines.reduce((n, l) => n + l.quantity, 0),
  subtotal_amount: lines.reduce((n, l) => n + Number(l.line_total), 0).toFixed(2),
});

const DUNE = product({ id: 1, title: 'Dune', price: '12.50' });
const NEURO = product({ id: 2, title: 'Neuromancer', price: '9.00' });

const summaryFor = (overrides = {}) => ({
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
  ...overrides,
});

const PAID = (extra = {}) => ({
  order: { id: 1, order_number: 'BK-0001', status: 'paid', currency: 'USD', total_amount: '29.00', discount_amount: '0.00', shipping_amount: '4.00', gift_points_redeemed: 0, placed_at: '2026-06-10T12:00:00Z', items: [] },
  payment: { card_type: 'credit', card_last4: '4242' },
  gift_points_balance: 1000,
  ...extra,
});

beforeEach(() => {
  signIn();
  vi.spyOn(api, 'basket').mockResolvedValue(basketOf(line(DUNE, 2)));
  vi.spyOn(api, 'addresses').mockResolvedValue({ items: [ADDRESS] });
  vi.spyOn(api, 'setCheckoutAddress').mockResolvedValue(summaryFor());
});

afterEach(() => {
  vi.restoreAllMocks();
  signOut();
});

const summary = () => within(screen.getByRole('complementary', { name: 'Order summary' }));

async function reachPayment(user) {
  renderApp('/basket');
  await user.click(await screen.findByRole('button', { name: 'Use this address' }));
  return screen.findByRole('switch', { name: /gift points/i });
}

describe('Basket line management (BSK)', () => {
  it('changes a quantity through the API and shows the new line total', async () => {
    const setQty = vi.spyOn(api, 'setQuantity').mockResolvedValue(basketOf(line(DUNE, 3)));
    const user = userEvent.setup();
    renderApp('/basket');

    await user.selectOptions(await screen.findByLabelText('Qty'), '3');

    expect(setQty).toHaveBeenCalledWith(1, 3);
    expect((await screen.findAllByText('$37.50')).length).toBeGreaterThanOrEqual(1); // line total (and items row)
    expect(screen.getByLabelText('Qty')).toHaveValue('3');
  });

  it('removes a line and falls back to the empty-basket view', async () => {
    const remove = vi.spyOn(api, 'removeFromBasket').mockResolvedValue(basketOf());
    const user = userEvent.setup();
    renderApp('/basket');

    await user.click(await screen.findByRole('button', { name: 'Remove Dune' }));

    expect(remove).toHaveBeenCalledWith(1);
    expect(await screen.findByText('Your basket is empty')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse books' })).toHaveAttribute('href', '/books');
  });

  it('keeps the other lines when one is removed', async () => {
    api.basket.mockResolvedValue(basketOf(line(DUNE, 1), line(NEURO, 1)));
    vi.spyOn(api, 'removeFromBasket').mockResolvedValue(basketOf(line(NEURO, 1)));
    const user = userEvent.setup();
    renderApp('/basket');

    await user.click(await screen.findByRole('button', { name: 'Remove Dune' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove Dune' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Remove Neuromancer' })).toBeInTheDocument();
  });

  it('shows the server message when a quantity change is refused', async () => {
    vi.spyOn(api, 'setQuantity').mockRejectedValue(new ApiError(409, 'INSUFFICIENT_STOCK', 'Only 2 copies are in stock.'));
    const user = userEvent.setup();
    renderApp('/basket');

    await user.selectOptions(await screen.findByLabelText('Qty'), '5');

    expect(await screen.findByRole('alert')).toHaveTextContent('Only 2 copies are in stock.');
    expect(screen.getByLabelText('Qty')).toHaveValue('2');
  });

  it('discards the priced summary when the basket changes, forcing the address step again', async () => {
    vi.spyOn(api, 'setQuantity').mockResolvedValue(basketOf(line(DUNE, 3)));
    const user = userEvent.setup();
    await reachPayment(user);
    expect(summary().getByText('$29.00')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Qty'), '3');

    expect(await screen.findByRole('button', { name: 'Use this address' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /gift points/i })).not.toBeInTheDocument();
    expect(summary().queryByText('Total to pay')).not.toBeInTheDocument();
  });
});

describe('Gift points edge cases (CHK)', () => {
  it('lets the shopper redeem part of their balance, never above the maximum', async () => {
    const user = userEvent.setup();
    const toggle = await reachPayment(user);
    await user.click(toggle);

    const input = screen.getByLabelText(/Points to use \(max 1,000\)/);
    expect(input).toHaveValue(1000); // defaults to the maximum

    await user.clear(input);
    await user.type(input, '300');
    expect(summary().getByText('Gift points (300)')).toBeInTheDocument();
    expect(summary().getByText('-$3.00')).toBeInTheDocument();
    expect(summary().getByText('$26.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay $26.00' })).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '999999');
    expect(input).toHaveValue(1000);
    expect(summary().getByText('$19.00')).toBeInTheDocument();
  });

  it('"Use maximum" restores the largest redeemable amount', async () => {
    const user = userEvent.setup();
    await user.click(await reachPayment(user));
    const input = screen.getByLabelText(/Points to use/);
    await user.clear(input);
    await user.type(input, '5');
    expect(summary().getByText('$28.95')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use maximum' }));
    expect(input).toHaveValue(1000);
  });

  it('never goes negative or fractional', async () => {
    const user = userEvent.setup();
    await user.click(await reachPayment(user));
    const input = screen.getByLabelText(/Points to use/);

    await user.clear(input);
    await user.type(input, '-50');
    expect(Number(input.value)).toBeGreaterThanOrEqual(0);

    await user.clear(input);
    await user.type(input, '12.9');
    expect(Number.isInteger(Number(input.value))).toBe(true);
  });

  it('states that points cover books only', async () => {
    const user = userEvent.setup();
    await user.click(await reachPayment(user));
    expect(screen.getByText('Points can pay for books only, not shipping or tax.')).toBeInTheDocument();
  });

  it('disables the switch and explains it when the balance is zero', async () => {
    api.setCheckoutAddress.mockResolvedValue(summaryFor({ gift_points_balance: 0, max_redeemable_points: 0 }));
    const user = userEvent.setup();
    const toggle = await reachPayment(user);

    expect(toggle).toBeDisabled();
    expect(screen.getByText(/You have no gift points yet/)).toBeInTheDocument();
  });

  it('caps redemption at the book subtotal when the balance is larger', async () => {
    api.setCheckoutAddress.mockResolvedValue(summaryFor({ gift_points_balance: 50000, max_redeemable_points: 2500 }));
    const user = userEvent.setup();
    await user.click(await reachPayment(user));

    expect(screen.getByLabelText(/Points to use \(max 2,500\)/)).toHaveValue(2500);
    expect(summary().getByText('Gift points (2,500)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay $4.00' })).toBeInTheDocument();
  });

  it('sends the partial redemption together with the card', async () => {
    const pay = vi.spyOn(api, 'pay').mockResolvedValue(PAID({ order: { ...PAID().order, gift_points_redeemed: 400 } }));
    const user = userEvent.setup();
    await user.click(await reachPayment(user));
    const input = screen.getByLabelText(/Points to use/);
    await user.clear(input);
    await user.type(input, '400');
    await user.selectOptions(screen.getByLabelText('Test card'), 'tok_visa_4242');
    await user.click(screen.getByRole('button', { name: /^Pay / }));

    await screen.findByRole('heading', { name: /your order is placed/ });
    expect(pay.mock.calls[0][0]).toEqual({
      gift_points_to_redeem: 400,
      card: { payment_token: 'tok_visa_4242', card_type: 'credit' },
    });
  });

  it('does not send points once the switch is turned back off', async () => {
    const pay = vi.spyOn(api, 'pay').mockResolvedValue(PAID());
    const user = userEvent.setup();
    const toggle = await reachPayment(user);
    await user.click(toggle);
    await user.click(toggle);
    await user.selectOptions(screen.getByLabelText('Test card'), 'tok_mc_0005');
    await user.click(screen.getByRole('button', { name: /^Pay / }));

    await screen.findByRole('heading', { name: /your order is placed/ });
    expect(pay.mock.calls[0][0]).toEqual({ card: { payment_token: 'tok_mc_0005', card_type: 'credit' } });
  });
});

describe('Payment confirmation and failure (CHK)', () => {
  it('confirms the order, empties the basket badge and offers the order history', async () => {
    vi.spyOn(api, 'pay').mockResolvedValue(PAID());
    const user = userEvent.setup();
    await reachPayment(user);
    await user.selectOptions(screen.getByLabelText('Test card'), 'tok_visa_4242');
    await user.click(screen.getByRole('button', { name: /^Pay / }));

    expect(await screen.findByRole('heading', { name: /your order is placed/ })).toBeInTheDocument();
    expect(screen.getByText('BK-0001')).toBeInTheDocument();
    expect(screen.getByText(/card ending 4242/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Basket, 0 items' })).toBeInTheDocument();
  });

  it('reuses the idempotency key when the same payment is retried after a failure', async () => {
    const pay = vi
      .spyOn(api, 'pay')
      .mockRejectedValueOnce(new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'Payment is temporarily unavailable.'))
      .mockResolvedValueOnce(PAID());
    const user = userEvent.setup();
    await reachPayment(user);
    await user.selectOptions(screen.getByLabelText('Test card'), 'tok_visa_4242');

    await user.click(screen.getByRole('button', { name: /^Pay / }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Payment is temporarily unavailable.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('You have not been charged.');

    await user.click(screen.getByRole('button', { name: /^Pay / }));
    await screen.findByRole('heading', { name: /your order is placed/ });

    expect(pay).toHaveBeenCalledTimes(2);
    expect(pay.mock.calls[1][1]).toBe(pay.mock.calls[0][1]);
  });

  it('uses a fresh idempotency key when the payment details change', async () => {
    const pay = vi.spyOn(api, 'pay').mockRejectedValueOnce(new ApiError(402, 'PAYMENT_DECLINED', 'Your card was declined.')).mockResolvedValueOnce(PAID());
    const user = userEvent.setup();
    await reachPayment(user);
    await user.selectOptions(screen.getByLabelText('Test card'), 'tok_declined_0002');
    await user.click(screen.getByRole('button', { name: /^Pay / }));
    await screen.findByRole('alert');

    await user.selectOptions(screen.getByLabelText('Test card'), 'tok_visa_4242');
    await user.click(screen.getByRole('button', { name: /^Pay / }));
    await screen.findByRole('heading', { name: /your order is placed/ });

    expect(pay.mock.calls[1][1]).not.toBe(pay.mock.calls[0][1]);
  });

  it('re-reads the basket when stock ran out during checkout', async () => {
    vi.spyOn(api, 'pay').mockRejectedValue(new ApiError(409, 'INSUFFICIENT_STOCK', 'Dune is no longer available in that quantity.'));
    const user = userEvent.setup();
    await reachPayment(user);
    await user.selectOptions(screen.getByLabelText('Test card'), 'tok_visa_4242');
    const before = api.basket.mock.calls.length;

    await user.click(screen.getByRole('button', { name: /^Pay / }));

    expect(await screen.findByRole('alert')).toHaveTextContent('no longer available');
    await waitFor(() => expect(api.basket.mock.calls.length).toBeGreaterThan(before));
  });

  it('shows an address error and stays on the address step', async () => {
    api.setCheckoutAddress.mockRejectedValue(new ApiError(422, 'VALIDATION_FAILED', 'Please check the address.'));
    const user = userEvent.setup();
    renderApp('/basket');
    await user.click(await screen.findByRole('button', { name: 'Use this address' }));

    expect(await screen.findByText('Please check the address.')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /gift points/i })).not.toBeInTheDocument();
  });
});
