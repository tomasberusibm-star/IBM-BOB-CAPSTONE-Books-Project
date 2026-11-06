// BSK/CHK-E2E: basket, address, gift-points redemption and payment confirmation in a real browser.
const DUNE = 'BK-DUNE-001'; // $9.99
const NEURO = 'BK-NEURO-001'; // $8.99
const DDIA = 'BK-DDIA-001'; // $44.99
const PRAG_EB = 'BK-PRAGPROG-EB'; // $35.99 e-book

const summary = () => cy.get('aside[aria-label="Order summary"]');
const useNewAddress = () => {
  cy.contains('label', 'Ship to a new address').click();
  cy.fillNewAddress();
  cy.contains('button', 'Use this address').click();
};
const pickCard = (value, type = 'Credit card') => {
  cy.contains('label', type).click();
  cy.get('#test-card').select(value);
};

describe('Basket', () => {
  it('shows an empty basket with a way back to the catalogue', () => {
    cy.newUser('emptybasket').then((user) => {
      cy.visitAs(user, '/basket');
      cy.contains('Your basket is empty').should('be.visible');
      cy.contains('a', 'Browse books').click();
      cy.location('pathname').should('eq', '/books');
    });
  });

  it('changes a quantity and updates the line total, items count and header badge', () => {
    cy.newUser('qty').then((user) => {
      cy.fillBasket(user, [[DUNE, 1]]);
      cy.visitAs(user, '/basket');
      cy.get('select[id^="qty-"]').select('3');

      cy.get('a[aria-label^="Basket"]').should('have.attr', 'aria-label', 'Basket, 3 items');
      cy.contains('li', 'Dune').should('contain.text', '$29.97');
      summary().should('contain.text', 'Items (3)').and('contain.text', '$29.97');
    });
  });

  it('removes a line and keeps the others', () => {
    cy.newUser('remove').then((user) => {
      cy.fillBasket(user, [[DUNE, 1], [NEURO, 1]]);
      cy.visitAs(user, '/basket');
      cy.get('button[aria-label="Remove Dune"]').click();

      cy.contains('li', 'Dune').should('not.exist');
      cy.contains('li', 'Neuromancer').should('be.visible');
      cy.get('a[aria-label^="Basket"]').should('have.attr', 'aria-label', 'Basket, 1 items');
    });
  });

  it('keeps the basket after a reload (it lives on the server)', () => {
    cy.newUser('persist').then((user) => {
      cy.fillBasket(user, [[DUNE, 2]]);
      cy.visitAs(user, '/basket');
      cy.contains('li', 'Dune').should('be.visible');
      cy.reload();
      cy.contains('li', 'Dune').should('be.visible');
      cy.get('select[id^="qty-"]').should('have.value', '2');
    });
  });
});

describe('Checkout: address', () => {
  it('does not price the order until an address is chosen', () => {
    cy.newUser('noaddr').then((user) => {
      cy.fillBasket(user, [[DUNE, 1]]);
      cy.visitAs(user, '/basket');
      summary().should('contain.text', 'Choose a shipping address');
      cy.contains('Total to pay').should('not.exist');
      cy.get('[role=switch]').should('not.exist');
    });
  });

  it('validates a new address before calling the server', () => {
    cy.newUser('badaddr').then((user) => {
      cy.fillBasket(user, [[DUNE, 1]]);
      cy.intercept('POST', '/api/checkout/address').as('address');
      cy.visitAs(user, '/basket');
      cy.contains('label', 'Ship to a new address').click();
      cy.contains('button', 'Use this address').click();

      cy.contains('Enter the recipient name.').should('be.visible');
      cy.contains('Enter the street address.').should('be.visible');
      cy.get('@address.all').should('have.length', 0);
    });
  });

  it('prices shipping: $4.99 under $50, free at $50 or more', () => {
    cy.newUser('shipping').then((user) => {
      cy.fillBasket(user, [[DUNE, 1]]);
      cy.visitAs(user, '/basket');
      useNewAddress();
      summary().should('contain.text', '$4.99').and('contain.text', '$14.98');
      cy.contains('button', 'Change').click();
      cy.contains('li', 'Dune').find('select').select('6'); // 6 x 9.99 = 59.94
      cy.get('a[aria-label^="Basket"]').should('have.attr', 'aria-label', 'Basket, 6 items'); // wait for the re-price
      cy.contains('button', 'Use this address').click();
      summary().contains('Shipping').parent().should('contain.text', 'Free');
      summary().should('contain.text', '$59.94');
    });
  });

  it('charges no shipping for an e-book-only basket', () => {
    cy.newUser('ebook').then((user) => {
      cy.fillBasket(user, [[PRAG_EB, 1]]);
      cy.visitAs(user, '/basket');
      useNewAddress();
      summary().contains('Shipping').parent().should('contain.text', 'Free');
      summary().contains('Total to pay').parent().should('contain.text', '$35.99');
    });
  });

  it('reuses a saved address on the next order', () => {
    cy.newUser('saved').then((user) => {
      cy.seedOrder(user, [[DUNE, 1]]);
      cy.fillBasket(user, [[NEURO, 1]]);
      cy.visitAs(user, '/basket');
      cy.contains('label', 'Quinn Tester').should('be.visible');
      cy.contains('button', 'Use this address').click();
      summary().should('contain.text', 'Total to pay');
    });
  });
});

describe('Checkout: gift points', () => {
  it('disables the switch and says why when the customer has no points', () => {
    cy.newUser('nopoints').then((user) => {
      cy.fillBasket(user, [[DUNE, 1]]);
      cy.visitAs(user, '/basket');
      useNewAddress();
      cy.get('[role=switch]').should('be.disabled');
      cy.contains('You have no gift points yet').should('be.visible');
    });
  });

  it('applies points to the books and lowers the amount to pay', () => {
    cy.newUser('points').then((user) => {
      cy.task('grantGiftPoints', { email: user.email, points: 500 });
      cy.fillBasket(user, [[DDIA, 1]]); // $44.99 + $4.99 shipping = $49.98
      cy.visitAs(user, '/basket');
      useNewAddress();

      summary().contains('Total to pay').parent().should('contain.text', '$49.98');
      cy.get('[role=switch]').should('have.attr', 'aria-checked', 'false').click();
      cy.get('[role=switch]').should('have.attr', 'aria-checked', 'true');
      cy.contains('Balance:').should('contain.text', '500');
      summary().should('contain.text', 'Gift points (500)').and('contain.text', '-$5.00');
      summary().contains('Total to pay').parent().should('contain.text', '$44.98');
      cy.contains('button', 'Pay $44.98').should('be.visible');
    });
  });

  it('lets the customer choose how many points to use, capped at the maximum', () => {
    cy.newUser('partial').then((user) => {
      cy.task('grantGiftPoints', { email: user.email, points: 500 });
      cy.fillBasket(user, [[DDIA, 1]]);
      cy.visitAs(user, '/basket');
      useNewAddress();
      cy.get('[role=switch]').click();

      cy.get('#points').type('{selectall}120');
      summary().should('contain.text', 'Gift points (120)').and('contain.text', '-$1.20');
      cy.get('#points').type('{selectall}99999');
      cy.get('#points').should('have.value', '500');
      cy.contains('button', 'Use maximum').click();
      cy.get('#points').should('have.value', '500');
      cy.contains('Points can pay for books only, not shipping or tax.').should('be.visible');
    });
  });

  it('removes the discount again when the switch is turned off', () => {
    cy.newUser('toggle').then((user) => {
      cy.task('grantGiftPoints', { email: user.email, points: 300 });
      cy.fillBasket(user, [[DDIA, 1]]);
      cy.visitAs(user, '/basket');
      useNewAddress();
      cy.get('[role=switch]').click();
      summary().should('contain.text', '-$3.00');
      cy.get('[role=switch]').click();
      summary().should('not.contain.text', 'Gift points (');
      summary().contains('Total to pay').parent().should('contain.text', '$49.98');
    });
  });

  it('never lets points pay for shipping: a small basket still needs a card', () => {
    cy.newUser('shipcard').then((user) => {
      cy.task('grantGiftPoints', { email: user.email, points: 10000 });
      cy.fillBasket(user, [[DUNE, 1]]); // $9.99 books + $4.99 shipping
      cy.visitAs(user, '/basket');
      useNewAddress();
      cy.get('[role=switch]').click();

      summary().should('contain.text', 'Gift points (999)');
      summary().contains('Total to pay').parent().should('contain.text', '$4.99');
      cy.get('#test-card').should('be.visible'); // a card is still needed for shipping
    });
  });

  it('pays in full with points when the basket ships free, and needs no card', () => {
    cy.newUser('allpoints').then((user) => {
      cy.task('grantGiftPoints', { email: user.email, points: 10000 });
      cy.fillBasket(user, [[PRAG_EB, 1]]); // e-book only: no shipping
      cy.visitAs(user, '/basket');
      useNewAddress();
      cy.get('[role=switch]').click();

      cy.contains('Your gift points cover the whole order - no card needed.').should('be.visible');
      cy.get('#test-card').should('not.exist');
      cy.contains('button', 'Place order').click();

      cy.contains('h1', 'your order is placed').should('be.visible');
      cy.contains('Paid in full with gift points.').should('be.visible');
      cy.contains('Remaining gift points:').should('contain.text', '6,401');
      cy.task('giftPointsBalance', { email: user.email }).should('eq', 6401);
    });
  });
});

describe('Checkout: payment and confirmation', () => {
  it('asks for a card before paying and never asks for raw card details', () => {
    cy.newUser('needcard').then((user) => {
      cy.fillBasket(user, [[DUNE, 1]]);
      cy.visitAs(user, '/basket');
      useNewAddress();
      cy.get('input[autocomplete*="cc-"], input[name*="card" i][type=text], input[name*="cvv" i]').should('not.exist');
      cy.contains('real card details are never entered').should('be.visible');

      cy.contains('button', /^Pay /).click();
      cy.contains('Choose a test card to pay the remaining amount.').should('be.visible');
    });
  });

  it('pays with a CREDIT test card and shows the confirmation', () => {
    cy.newUser('credit').then((user) => {
      cy.fillBasket(user, [[DUNE, 1], [NEURO, 1]]);
      cy.visitAs(user, '/basket');
      useNewAddress();
      pickCard('tok_visa_4242', 'Credit card');
      cy.contains('button', 'Pay $23.97').click(); // 9.99 + 8.99 + 4.99

      cy.contains('h1', 'your order is placed').should('be.visible');
      cy.contains('strong', /^BK-/).should('be.visible');
      cy.contains('Dune × 1');
      cy.contains('Neuromancer × 1');
      cy.contains('Charged to your credit card ending 4242.').should('be.visible');
      cy.get('a[aria-label^="Basket"]').should('have.attr', 'aria-label', 'Basket, 0 items');
    });
  });

  it('pays with a DEBIT test card', () => {
    cy.newUser('debit').then((user) => {
      cy.fillBasket(user, [[DUNE, 1]]);
      cy.visitAs(user, '/basket');
      useNewAddress();
      pickCard('tok_mc_0005', 'Debit card');
      cy.contains('button', /^Pay /).click();

      cy.contains('Charged to your debit card ending 0005.').should('be.visible');
    });
  });

  it('combines gift points and a card, and the points leave the balance', () => {
    cy.newUser('mixed').then((user) => {
      cy.task('grantGiftPoints', { email: user.email, points: 1000 });
      cy.fillBasket(user, [[DDIA, 1]]);
      cy.visitAs(user, '/basket');
      useNewAddress();
      cy.get('[role=switch]').click();
      pickCard('tok_visa_4242');
      cy.contains('button', 'Pay $39.98').click(); // 44.99 - 10.00 + 4.99

      cy.contains('h1', 'your order is placed').should('be.visible');
      cy.contains('Gift points used (1,000)').should('be.visible');
      cy.contains('dt', 'Paid').parent().should('contain.text', '$39.98');
      cy.contains('Remaining gift points:').should('contain.text', '0');
      cy.task('giftPointsBalance', { email: user.email }).should('eq', 0);
    });
  });

  it('shows a declined card, keeps the basket and lets the customer retry with another card', () => {
    cy.newUser('declined').then((user) => {
      cy.fillBasket(user, [[DUNE, 1]]);
      cy.visitAs(user, '/basket');
      useNewAddress();
      pickCard('tok_declined_0002');
      cy.contains('button', /^Pay /).click();

      cy.get('aside [role=alert]').should('contain.text', 'declined').and('contain.text', 'You have not been charged.');
      cy.contains('li', 'Dune').should('be.visible');
      cy.get('a[aria-label^="Basket"]').should('have.attr', 'aria-label', 'Basket, 1 items');

      cy.get('#test-card').select('tok_visa_4242');
      cy.contains('button', /^Pay /).click();
      cy.contains('h1', 'your order is placed').should('be.visible');
    });
  });

  it('does not take points or stock for a declined payment', () => {
    cy.newUser('declinedpts').then((user) => {
      cy.task('grantGiftPoints', { email: user.email, points: 400 });
      cy.fillBasket(user, [[DDIA, 1]]);
      cy.visitAs(user, '/basket');
      useNewAddress();
      cy.get('[role=switch]').click();
      pickCard('tok_declined_0002');
      cy.contains('button', /^Pay /).click();

      cy.get('aside [role=alert]').should('contain.text', 'declined');
      cy.task('giftPointsBalance', { email: user.email }).should('eq', 400);
    });
  });

  it('reports a payment-provider outage without placing an order', () => {
    cy.newUser('outage').then((user) => {
      cy.fillBasket(user, [[DUNE, 1]]);
      cy.visitAs(user, '/basket');
      useNewAddress();
      cy.intercept('POST', '/api/checkout/payment', { statusCode: 502, body: { code: 'PAYMENT_PROVIDER_ERROR', message: 'Payment is temporarily unavailable. Please try again.' } });
      pickCard('tok_visa_4242');
      cy.contains('button', /^Pay /).click();

      cy.get('aside [role=alert]').should('contain.text', 'temporarily unavailable').and('not.contain.text', 'You have not been charged.');
      cy.contains('h1', 'your order is placed').should('not.exist');
    });
  });

  it('sends the same Idempotency-Key when the identical payment is retried', () => {
    cy.newUser('idem').then((user) => {
      cy.fillBasket(user, [[DUNE, 1]]);
      cy.visitAs(user, '/basket');
      useNewAddress();
      let calls = 0;
      cy.intercept('POST', '/api/checkout/payment', (req) => {
        calls += 1;
        req.alias = `pay${calls}`;
        if (calls === 1) req.reply({ statusCode: 502, body: { code: 'PAYMENT_PROVIDER_ERROR', message: 'Payment is temporarily unavailable.' } });
        else req.continue();
      });
      pickCard('tok_visa_4242');
      cy.contains('button', /^Pay /).click();
      cy.get('aside [role=alert]').should('be.visible');
      cy.contains('button', /^Pay /).click();

      cy.contains('h1', 'your order is placed').should('be.visible');
      cy.get('@pay1').its('request.headers.idempotency-key').then((first) => {
        cy.get('@pay2').its('request.headers.idempotency-key').should('eq', first);
      });
    });
  });

  it('lists the new order in the order history', () => {
    cy.newUser('history').then((user) => {
      cy.fillBasket(user, [[NEURO, 1]]);
      cy.visitAs(user, '/basket');
      useNewAddress();
      pickCard('tok_visa_4242');
      cy.contains('button', /^Pay /).click();
      cy.contains('strong', /^BK-/).invoke('text').then((orderNumber) => {
        cy.contains('a', 'View my orders').click();
        cy.location('pathname').should('eq', '/orders');
        cy.orderCard(orderNumber).should('contain.text', 'Neuromancer').and('contain.text', 'Paid');
      });
    });
  });
});
