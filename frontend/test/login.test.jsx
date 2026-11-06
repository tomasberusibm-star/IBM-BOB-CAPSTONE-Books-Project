import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api/client.js';
import { EMPTY_BASKET, USER, renderApp, signOut } from './utils.jsx';

beforeEach(() => {
  signOut();
  vi.spyOn(api, 'basket').mockResolvedValue(EMPTY_BASKET);
  vi.spyOn(api, 'categories').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'products').mockResolvedValue({ items: [], page: 1, total_pages: 0, total_items: 0 });
  vi.spyOn(api, 'recommendations').mockResolvedValue({ items: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  signOut();
});

describe('Login page', () => {
  it('validates before calling the API', async () => {
    const login = vi.spyOn(api, 'login');
    const user = userEvent.setup();
    renderApp('/login');

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter a valid e-mail address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it('shows the server message when credentials are wrong', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'E-mail or password is incorrect.'));
    const user = userEvent.setup();
    renderApp('/login');

    await user.type(screen.getByLabelText('E-mail'), 'reader@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail or password is incorrect.');
  });

  it('signs in and returns to the page the visitor came from', async () => {
    vi.spyOn(api, 'login').mockResolvedValue({ access_token: 'abc', user: USER });
    vi.spyOn(api, 'orders').mockResolvedValue({ items: [], page: 1, page_size: 5, total_items: 0, total_pages: 0 });
    const user = userEvent.setup();
    renderApp('/orders'); // protected: redirects to /login first

    await user.type(await screen.findByLabelText('E-mail'), 'reader@example.com');
    await user.type(screen.getByLabelText('Password'), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'My orders' })).toBeInTheDocument();
    expect(api.login).toHaveBeenCalledWith('reader@example.com', 'a-long-enough-password');
  });

  it('requires a 12+ character password when registering', async () => {
    const register = vi.spyOn(api, 'register');
    const user = userEvent.setup();
    renderApp('/login');

    await user.click(screen.getByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('First name'), 'Rita');
    await user.type(screen.getByLabelText('Last name'), 'Reader');
    await user.type(screen.getByLabelText('E-mail'), 'reader@example.com');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(screen.getByText('Use at least 12 characters.')).toBeInTheDocument());
    expect(register).not.toHaveBeenCalled();
  });
});
