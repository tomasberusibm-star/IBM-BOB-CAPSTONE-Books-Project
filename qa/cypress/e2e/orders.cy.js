// ORD-E2E: order history, "Buy In Again" and the 48-hour cancellation rule.
const DUNE = 'BK-DUNE-001';
const NEURO = 'BK-NEURO-001';
const PRAG_EB = 'BK-PRAGPROG-EB';

afterEach(() => {
  cy.task('resetCatalogue');
});

describe('Order history', () => {
  it('shows an empty state for a customer with no orders', () => {
    cy.newUser('noorders').then((user) => {
      cy.visitAs(user, '/orders');
      cy.contains('No orders yet').should('be.visible');
      cy.contains('a', 'Browse books').should('have.attr', 'href', '/books');
    });
  });

  it('lists orders newest first with status, items and total', () => {
    cy.newUser('list').then((user) => {
      cy.seedOrder(user, [[DUNE, 2]]).then((first) => {
        cy.seedOrder(user, [[NEURO, 1]]).then((second) => {
          cy.visitAs(user, '/orders');
          cy.get('article h2').then(($h) => {
            expect($h.toArray().map((h) => h.textContent)).to.deep.equal([`Order ${second.order_number}`, `Order ${first.order_number}`]);
          });
          cy.orderCard(first.order_number).within(() => {
            cy.contains('Dune');
            cy.contains('× 2');
            cy.contains('Paid');
            cy.contains('$24.97'); // 2 x 9.99 + 4.99
          });
        });
      });
    });
  });

  it('only shows the signed-in customer their own orders', () => {
    cy.newUser('owner').then((owner) => {
      cy.seedOrder(owner, [[DUNE, 1]]).then((mine) => {
        cy.newUser('other').then((other) => {
          cy.visitAs(other, '/orders');
          cy.contains('No orders yet').should('be.visible');
          cy.contains(mine.order_number).should('not.exist');
        });
      });
    });
  });

  it('shows the gift points used on an order', () => {
    cy.newUser('histpts').then((user) => {
      cy.seedOrder(user, [[PRAG_EB, 1]], { points: 500 }).then((order) => {
        cy.visitAs(user, '/orders');
        cy.orderCard(order.order_number).should('contain.text', 'Gift points used: 500').and('contain.text', '-$5.00');
      });
    });
  });
});

describe('Buy In Again', () => {
  it('puts every book from a past order into the basket at the current price', () => {
    cy.newUser('again').then((user) => {
      cy.seedOrder(user, [[DUNE, 2], [NEURO, 1]]).then((order) => {
        cy.visitAs(user, '/orders');
        cy.orderCard(order.order_number).contains('button', 'Buy In Again').click();

        cy.contains('[role=status]', 'Added 2 books to your basket').should('be.visible');
        cy.get('a[aria-label^="Basket"]').should('have.attr', 'aria-label', 'Basket, 3 items');
        cy.contains('a', 'Go to basket').click();

        cy.location('pathname').should('eq', '/basket');
        cy.contains('li', 'Dune').find('select').should('have.value', '2');
        cy.contains('li', 'Neuromancer').find('select').should('have.value', '1');
      });
    });
  });

  it('can go straight through checkout afterwards', () => {
    cy.newUser('againpay').then((user) => {
      cy.seedOrder(user, [[DUNE, 1]]).then((order) => {
        cy.visitAs(user, '/orders');
        cy.orderCard(order.order_number).contains('button', 'Buy In Again').click();
        cy.contains('a', 'Go to basket').click();
        cy.contains('button', 'Use this address').click();
        cy.contains('label', 'Credit card').click();
        cy.get('#test-card').select('tok_visa_4242');
        cy.contains('button', /^Pay /).click();
        cy.contains('h1', 'your order is placed').should('be.visible');
      });
    });
  });

  it('adds to what is already in the basket instead of replacing it', () => {
    cy.newUser('againmerge').then((user) => {
      cy.seedOrder(user, [[DUNE, 1]]).then((order) => {
        cy.fillBasket(user, [[DUNE, 1], [NEURO, 1]]);
        cy.visitAs(user, '/orders');
        cy.orderCard(order.order_number).contains('button', 'Buy In Again').click();
        cy.contains('a', 'Go to basket').click();

        cy.contains('li', 'Dune').find('select').should('have.value', '2');
        cy.contains('li', 'Neuromancer').find('select').should('have.value', '1');
      });
    });
  });

  it('skips a book that is no longer sold and says so', () => {
    cy.newUser('againskip').then((user) => {
      cy.seedOrder(user, [[DUNE, 1], [NEURO, 1]]).then((order) => {
        cy.task('setProductActive', { sku: NEURO, active: false });
        cy.visitAs(user, '/orders');
        cy.orderCard(order.order_number).contains('button', 'Buy In Again').click();

        cy.contains('[role=status]', 'Added 1 book to your basket').should('be.visible');
        cy.contains('Neuromancer was not added (no longer sold).').should('be.visible');
        cy.get('a[aria-label^="Basket"]').should('have.attr', 'aria-label', 'Basket, 1 items');
      });
    });
  });

  it('is disabled when none of the books are sold any more', () => {
    cy.newUser('againnone').then((user) => {
      cy.seedOrder(user, [[DUNE, 1]]).then((order) => {
        cy.task('setProductActive', { sku: DUNE, active: false });
        cy.visitAs(user, '/orders');
        cy.orderCard(order.order_number).within(() => {
          cy.contains('button', 'Buy In Again').should('be.disabled');
          cy.contains('None of these books are currently sold.').should('be.visible');
        });
      });
    });
  });
});

describe('48-hour cancellation rule', () => {
  it('offers cancel to a fresh order, with the time left, and asks for confirmation', () => {
    cy.newUser('cancelfresh').then((user) => {
      cy.seedOrder(user, [[DUNE, 1]]).then((order) => {
        cy.visitAs(user, '/orders');
        cy.orderCard(order.order_number).within(() => {
          cy.contains('You can cancel this order for 48 hours after placing it').should('be.visible');
          cy.get(`button[aria-label="Cancel order ${order.order_number}"]`).click();
          cy.contains('Cancel this order?').should('be.visible');
          cy.contains('button', 'Keep order').click();
          cy.contains('Cancel this order?').should('not.exist');
          cy.contains('Paid').should('be.visible');
        });
      });
    });
  });

  it('cancels an order placed 47 hours ago and returns the stock and gift points', () => {
    cy.newUser('cancelok').then((user) => {
      cy.seedOrder(user, [[PRAG_EB, 1]], { points: 500 }).then((order) => {
        cy.task('ageOrder', { orderNumber: order.order_number, interval: '47 hours' });
        cy.task('giftPointsBalance', { email: user.email }).should('eq', 0);
        cy.visitAs(user, '/orders');
        cy.orderCard(order.order_number).within(() => {
          cy.get(`button[aria-label="Cancel order ${order.order_number}"]`).click();
          cy.contains('button', 'Yes, cancel order').click();
        });

        cy.contains('[role=status]', `Order ${order.order_number} was cancelled.`).should('be.visible');
        cy.orderCard(order.order_number).within(() => {
          cy.contains('Cancelled').should('be.visible');
          cy.contains('button', /^Cancel order/).should('not.exist');
        });
        cy.task('giftPointsBalance', { email: user.email }).should('eq', 500);
      });
    });
  });

  it('puts the books back on the shelf when a paperback order is cancelled', () => {
    cy.newUser('cancelstock').then((user) => {
      cy.task('stockOf', { sku: 'BK-CLEANCODE-001' }).then((before) => {
        cy.seedOrder(user, [['BK-CLEANCODE-001', 2]]).then((order) => {
          cy.task('stockOf', { sku: 'BK-CLEANCODE-001' }).should('eq', before - 2);
          cy.visitAs(user, '/orders');
          cy.orderCard(order.order_number).within(() => {
            cy.contains('button', /^Cancel order/).click();
            cy.contains('button', 'Yes, cancel order').click();
          });
          cy.contains('was cancelled').should('be.visible');
          cy.task('stockOf', { sku: 'BK-CLEANCODE-001' }).should('eq', before);
        });
      });
    });
  });

  it('hides cancel and explains once the 48 hours are over', () => {
    cy.newUser('cancelold').then((user) => {
      cy.seedOrder(user, [[DUNE, 1]]).then((order) => {
        cy.task('ageOrder', { orderNumber: order.order_number, interval: '49 hours' });
        cy.visitAs(user, '/orders');
        cy.orderCard(order.order_number).within(() => {
          cy.contains('The 48-hour cancellation window for this order has closed.').should('be.visible');
          cy.contains('button', /^Cancel order/).should('not.exist');
          cy.contains('button', 'Buy In Again').should('be.enabled'); // re-ordering is still allowed
        });
      });
    });
  });

  it('is still cancellable just inside the window and not just outside it', () => {
    cy.newUser('edge').then((user) => {
      cy.seedOrder(user, [[DUNE, 1]]).then((inside) => {
        cy.seedOrder(user, [[NEURO, 1]]).then((outside) => {
          cy.task('ageOrder', { orderNumber: inside.order_number, interval: '47 hours 59 minutes' });
          cy.task('ageOrder', { orderNumber: outside.order_number, interval: '48 hours 1 minute' });
          cy.visitAs(user, '/orders');
          cy.orderCard(inside.order_number).contains('button', /^Cancel order/).should('be.visible');
          cy.orderCard(outside.order_number).contains('button', /^Cancel order/).should('not.exist');
        });
      });
    });
  });

  it('shows the server message if the window closes while the page is open', () => {
    cy.newUser('race').then((user) => {
      cy.seedOrder(user, [[DUNE, 1]]).then((order) => {
        cy.visitAs(user, '/orders');
        cy.orderCard(order.order_number).contains('button', /^Cancel order/).should('be.visible');
        // the window closes after the page was rendered
        cy.task('ageOrder', { orderNumber: order.order_number, interval: '49 hours' });
        cy.orderCard(order.order_number).within(() => {
          cy.contains('button', /^Cancel order/).click();
          cy.contains('button', 'Yes, cancel order').click();
        });

        cy.orderCard(order.order_number).should('contain.text', 'The 48-hour cancellation window for this order has closed.');
        cy.orderCard(order.order_number).contains('button', /^Cancel order/).should('not.exist');
      });
    });
  });
});
