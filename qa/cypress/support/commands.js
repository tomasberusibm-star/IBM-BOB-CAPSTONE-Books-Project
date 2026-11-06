// Custom commands shared by the E2E specs.
// Test data is created through the public API (cy.request), so each test owns a fresh customer
// and the UI under test is only used for the behaviour being verified.

export const PASSWORD = 'qa-correct-horse-battery';
export const ADDRESS = {
  recipient_name: 'Quinn Tester',
  line1: '1 Test Street',
  city: 'Testville',
  region: 'TS',
  postal_code: '12345',
  country_code: 'US',
};

const SESSION_KEY = 'bookshelf.session'; // same key the app mirrors to sessionStorage
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let counter = 0;

/** Registers + logs in a brand-new customer via the API. Yields { email, password, token, user }. */
Cypress.Commands.add('newUser', (label = 'e2e') => {
  const email = `${label}-${Date.now()}-${++counter}-${Math.random().toString(16).slice(2, 8)}@example.com`;
  cy.request('POST', '/api/auth/register', { email, password: PASSWORD, first_name: 'Quinn', last_name: 'Tester' });
  return cy
    .request('POST', '/api/auth/login', { email, password: PASSWORD })
    .its('body')
    .then((body) => ({ email, password: PASSWORD, token: body.access_token, user: body.user }));
});

/** Opens `path` already signed in as `user` (the app restores its session from sessionStorage). */
Cypress.Commands.add('visitAs', (user, path = '/') => {
  cy.visit(path, {
    onBeforeLoad(win) {
      win.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: user.token, user: user.user }));
    },
  });
});

const authed = (user) => ({ Authorization: `Bearer ${user.token}` });

/** sku -> product id, read from the public catalogue. */
Cypress.Commands.add('productIds', () =>
  cy.request('/api/products?page_size=100').then(({ body }) => Object.fromEntries(body.items.map((p) => [p.sku, p.id]))),
);

/** Puts books in the user's basket through the API. `lines` is [[sku, quantity], ...]. */
Cypress.Commands.add('fillBasket', (user, lines) => {
  cy.productIds().then((ids) => {
    for (const [sku, quantity] of lines) {
      cy.request({ method: 'POST', url: '/api/basket/items', headers: authed(user), body: { product_id: ids[sku], quantity } });
    }
  });
});

/**
 * Buys `lines` through the API with the approved Visa test card. Yields the order.
 * `points` > 0 first grants that many gift points and redeems them.
 */
Cypress.Commands.add('seedOrder', (user, lines, { points = 0 } = {}) => {
  if (points > 0) cy.task('grantGiftPoints', { email: user.email, points });
  cy.fillBasket(user, lines);
  cy.request({ method: 'POST', url: '/api/checkout/address', headers: authed(user), body: { address: { ...ADDRESS, save_to_address_book: true } } });
  const body = {
    ...(points > 0 ? { gift_points_to_redeem: points } : {}),
    card: { payment_token: 'tok_visa_4242', card_type: 'credit' },
  };
  return cy
    .request({
      method: 'POST',
      url: '/api/checkout/payment',
      headers: { ...authed(user), 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}` },
      body,
    })
    .its('body.order');
});

/** The product card whose title is exactly `title` (titles overlap, e.g. "...Applications" / "...(E-book)"). */
Cypress.Commands.add('card', (title) => cy.contains('article h3', new RegExp(`^${escapeRegExp(title)}$`)).closest('article'));

/** Asserts no product card has exactly this title (retries until the list settles). */
Cypress.Commands.add('noCard', (title) => cy.get('article h3').should(($h) => {
  expect($h.toArray().map((h) => h.textContent.trim())).not.to.include(title);
}));

/** The order-history entry for an order number. */
Cypress.Commands.add('orderCard', (orderNumber) => cy.contains('article h2', `Order ${orderNumber}`).closest('article'));

/** Fills the "ship to a new address" form (used by customers with no saved address). */
Cypress.Commands.add('fillNewAddress', (a = ADDRESS) => {
  cy.get('#a-name').type(a.recipient_name);
  cy.get('#a-line1').type(a.line1);
  cy.get('#a-city').type(a.city);
  cy.get('#a-region').type(a.region);
  cy.get('#a-postal').type(a.postal_code);
});

/** Signs in through the login form. */
Cypress.Commands.add('loginViaUi', (email, password) => {
  cy.get('#email').type(email);
  cy.get('#password').type(password, { log: false });
  cy.contains('button', /^Sign in$/).click();
});

/** Picks a category in the filter selector by its visible name (options are indented with non-breaking spaces). */
Cypress.Commands.add('chooseCategory', (name) => {
  cy.get('#category').should('be.enabled');
  cy.get('#category option')
    .filter((_, o) => o.textContent.replaceAll('\u00A0', '').trim() === name)
    .invoke('val')
    .then((value) => cy.get('#category').select(value));
});
