/**
 * Thin fetch wrapper for the bookstore API.
 *
 * Token handling: the access token (15 minutes, bound to a server-side session) is kept in
 * memory and mirrored to sessionStorage, which is cleared when the tab closes. It is never
 * put in localStorage, URLs, or logs. React escapes all rendered text, so there is no raw
 * HTML injection anywhere in this app, which is the main way a stored token would be stolen.
 */

const STORAGE_KEY = 'bookshelf.session';

let session = null; // { token, user }
let onUnauthorized = () => {};

export function loadSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    session = parsed && typeof parsed.token === 'string' && parsed.user?.id ? parsed : null;
  } catch {
    session = null;
  }
  return session;
}

export function saveSession(next) {
  session = next;
  try {
    if (next) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable (private mode): the in-memory session still works for this page load
  }
}

export const getSession = () => session;

/** Called when the server rejects the token (expired, revoked, logged out elsewhere). */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  constructor(status, code, message, details, requestId) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? [];
    this.requestId = requestId;
  }
}

const NETWORK_MESSAGE = 'Cannot reach the server. Check your connection and try again.';

/**
 * @param {string} path e.g. '/api/products'
 * @param {{method?: string, body?: unknown, query?: Record<string, unknown>, headers?: Record<string, string>, auth?: boolean, signal?: AbortSignal}} [opts]
 */
export async function request(path, { method = 'GET', body, query, headers = {}, auth = true, signal } = {}) {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }

  const h = { Accept: 'application/json', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (auth && session?.token) h.Authorization = `Bearer ${session.token}`;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', NETWORK_MESSAGE);
  }

  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON error page from a proxy: fall through to the generic error below
  }

  if (!res.ok) {
    if (res.status === 401 && auth && session) {
      saveSession(null);
      onUnauthorized();
    }
    throw new ApiError(
      res.status,
      data?.code ?? 'HTTP_ERROR',
      data?.message ?? 'Something went wrong. Please try again.',
      data?.details,
      data?.request_id,
    );
  }
  return data;
}

/** Endpoint helpers - one function per API operation used by the UI. */
export const api = {
  login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password }, auth: false }),
  register: (body) => request('/api/auth/register', { method: 'POST', body, auth: false }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),

  categories: () => request('/api/categories', { auth: false }),
  brands: () => request('/api/brands', { auth: false }),
  products: (query, signal) => request('/api/products', { query, auth: false, signal }),
  product: (id, signal) => request(`/api/products/${encodeURIComponent(id)}`, { auth: false, signal }),
  related: (id, signal) => request(`/api/products/${encodeURIComponent(id)}/related`, { query: { limit: 8 }, auth: false, signal }),
  recommendations: (limit = 8, signal) => request('/api/recommendations', { query: { limit }, signal }),

  basket: (signal) => request('/api/basket', { signal }),
  addToBasket: (product_id, quantity = 1) => request('/api/basket/items', { method: 'POST', body: { product_id, quantity } }),
  setQuantity: (productId, quantity) => request(`/api/basket/items/${encodeURIComponent(productId)}`, { method: 'PATCH', body: { quantity } }),
  removeFromBasket: (productId) => request(`/api/basket/items/${encodeURIComponent(productId)}`, { method: 'DELETE' }),

  addresses: (signal) => request('/api/addresses', { signal }),
  setCheckoutAddress: (body) => request('/api/checkout/address', { method: 'POST', body }),
  pay: (body, idempotencyKey) =>
    request('/api/checkout/payment', { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } }),

  orders: (userId, query, signal) => request(`/api/users/${encodeURIComponent(userId)}/orders`, { query, signal }),
  reorder: (orderId) => request(`/api/orders/reorder/${encodeURIComponent(orderId)}`, { method: 'POST' }),
  cancelOrder: (orderId, reason) =>
    request(`/api/orders/cancel/${encodeURIComponent(orderId)}`, { method: 'POST', body: reason ? { reason } : undefined }),
};
