// AUTH-E2E: sign-in, registration, protected pages and sign-out, as a visitor would do them.
describe('Authentication', () => {
  it('registers a new customer, signs them in and shows their name', () => {
    const email = `reg-${Date.now()}@example.com`;
    cy.visit('/login');
    cy.contains('button', 'Create an account').click();
    cy.get('#first_name').type('Rita');
    cy.get('#last_name').type('Reader');
    cy.get('#email').type(email);
    cy.get('#password').type('a-long-test-passphrase', { log: false });
    cy.contains('button', 'Create account').click();

    cy.location('pathname').should('eq', '/');
    cy.contains('Hi, Rita').should('be.visible');
    cy.contains('h1', 'Welcome back, Rita.').should('be.visible');
  });

  it('rejects a short password on registration without calling the server', () => {
    cy.intercept('POST', '/api/auth/register').as('register');
    cy.visit('/login');
    cy.contains('button', 'Create an account').click();
    cy.get('#first_name').type('Rita');
    cy.get('#last_name').type('Reader');
    cy.get('#email').type('short@example.com');
    cy.get('#password').type('too-short');
    cy.contains('button', 'Create account').click();

    cy.contains('Use at least 12 characters.').should('be.visible');
    cy.get('@register.all').should('have.length', 0);
  });

  it('signs in with valid credentials and returns to the home page', () => {
    cy.newUser('login').then((user) => {
      cy.visit('/login');
      cy.loginViaUi(user.email, user.password);

      cy.location('pathname').should('eq', '/');
      cy.contains('Hi, Quinn').should('be.visible');
      cy.contains('a', 'My orders').should('be.visible');
      cy.contains('a', 'Sign in').should('not.exist');
    });
  });

  it('keeps the token out of localStorage and the URL', () => {
    cy.newUser('storage').then((user) => {
      cy.visit('/login');
      cy.loginViaUi(user.email, user.password);
      cy.contains('Hi, Quinn').should('be.visible');
      cy.window().then((win) => {
        expect(win.localStorage.length, 'localStorage entries').to.eq(0);
        expect(win.location.href).not.to.contain(user.token);
      });
    });
  });

  it('shows one generic error for a wrong password and stays on the login page', () => {
    cy.newUser('wrongpw').then((user) => {
      cy.visit('/login');
      cy.loginViaUi(user.email, 'definitely-the-wrong-password');

      cy.get('[role=alert]').should('contain.text', 'Invalid e-mail or password.');
      cy.location('pathname').should('eq', '/login');
      cy.contains('Hi, ').should('not.exist');
    });
  });

  it('gives the same error for an unknown e-mail (no account enumeration)', () => {
    cy.visit('/login');
    cy.loginViaUi('nobody-here@example.com', 'definitely-the-wrong-password');
    cy.get('[role=alert]').should('have.text', 'Invalid e-mail or password.');
  });

  it('validates the form before submitting', () => {
    cy.intercept('POST', '/api/auth/login').as('login');
    cy.visit('/login');
    cy.contains('button', /^Sign in$/).click();

    cy.contains('Enter a valid e-mail address.').should('be.visible');
    cy.contains('Enter your password.').should('be.visible');
    cy.get('@login.all').should('have.length', 0);
  });

  it('locks the account after repeated failures, even for the right password', () => {
    cy.newUser('lock').then((user) => {
      cy.visit('/login');
      for (let i = 0; i < 5; i++) {
        cy.get('#email').clear().type(user.email);
        cy.get('#password').clear().type('wrong-password-attempt');
        cy.contains('button', /^Sign in$/).click();
        cy.get('[role=alert]').should('be.visible');
      }
      cy.get('#email').clear().type(user.email);
      cy.get('#password').clear().type(user.password, { log: false });
      cy.contains('button', /^Sign in$/).click();

      cy.get('[role=alert]').should('contain.text', 'Invalid e-mail or password.');
      cy.location('pathname').should('eq', '/login');
    });
  });

  it('sends a signed-out visitor from /orders to login, then back to /orders after signing in', () => {
    cy.newUser('guard').then((user) => {
      cy.visit('/orders');
      cy.location('pathname').should('eq', '/login');
      cy.loginViaUi(user.email, user.password);

      cy.location('pathname').should('eq', '/orders');
      cy.contains('h1', 'My orders').should('be.visible');
    });
  });

  it('sends a signed-out visitor from /basket to login', () => {
    cy.visit('/basket');
    cy.location('pathname').should('eq', '/login');
  });

  it('ignores an off-site redirect target', () => {
    cy.newUser('redir').then((user) => {
      cy.visit('/login', { onBeforeLoad: () => {} });
      cy.window().then((win) => win.history.replaceState({ usr: { from: '//evil.example/steal' } }, ''));
      cy.loginViaUi(user.email, user.password);
      cy.location('hostname').should('not.eq', 'evil.example');
    });
  });

  it('signs out, drops the session and re-protects the pages', () => {
    cy.newUser('logout').then((user) => {
      cy.visitAs(user, '/orders');
      cy.contains('h1', 'My orders').should('be.visible');
      cy.contains('button', 'Sign out').click();

      // Signing out on a protected page lands on the login page (the route guard reacts first).
      cy.location('pathname').should('eq', '/login');
      cy.contains('a', 'Sign in').should('be.visible');
      cy.window().its('sessionStorage').invoke('getItem', 'bookshelf.session').should('be.null');
      cy.visit('/orders');
      cy.location('pathname').should('eq', '/login');
    });
  });

  it('the server revokes the token on sign-out', () => {
    cy.newUser('revoke').then((user) => {
      cy.visitAs(user, '/');
      cy.contains('button', 'Sign out').click();
      cy.contains('a', 'Sign in').should('be.visible');
      cy.request({ url: '/api/basket', headers: { Authorization: `Bearer ${user.token}` }, failOnStatusCode: false })
        .its('status')
        .should('eq', 401);
    });
  });

  it('signs the user out when the server rejects an expired or revoked token', () => {
    cy.newUser('expired').then((user) => {
      cy.visitAs({ ...user, token: 'not-a-valid-token' }, '/orders');
      cy.location('pathname').should('eq', '/login');
      cy.contains('a', 'Sign in').should('be.visible');
    });
  });
});
