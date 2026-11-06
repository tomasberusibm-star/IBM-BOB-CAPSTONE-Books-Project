// CAT-E2E: browsing the catalogue, filtering by category/brand/delivery, and related products.
describe('Catalogue browsing', () => {
  afterEach(() => {
    cy.task('resetCatalogue');
  });

  it('lists the seeded books on the catalogue page with prices and delivery tags', () => {
    cy.visit('/books');
    cy.contains('h1', 'All books').should('be.visible');
    cy.get('[role=status]').contains('7 books');
    cy.card('Dune').within(() => {
      cy.contains('$9.99');
      cy.contains('Arrives');
    });
    cy.card('The Pragmatic Programmer (E-book)').contains('Instant download');
  });

  it('marks the sold-out book and disables its add button', () => {
    cy.visit('/books');
    cy.card('PostgreSQL: Up and Running').within(() => {
      cy.contains('Back in stock');
      cy.contains('button', 'Out of stock').should('be.disabled');
    });
  });

  it('opens a book from the landing page category tiles', () => {
    cy.visit('/');
    cy.contains('a', 'Science Fiction').click();
    cy.location('search').should('match', /category_id=\d+/);
    cy.contains('h1', 'Science Fiction').should('be.visible');
    cy.card('Dune').should('be.visible');
    cy.card('Neuromancer').should('be.visible');
    cy.noCard('Clean Code');
  });

  describe('category filtering', () => {
    it('a parent category includes every book in its sub-categories', () => {
      cy.visit('/books');
      cy.chooseCategory('Non-Fiction');

      cy.contains('h1', 'Non-Fiction').should('be.visible');
      cy.get('[role=status]').contains('5 books');
      cy.card('Clean Code').should('be.visible');
      cy.noCard('Dune');
    });

    it('narrows to a leaf category', () => {
      cy.visit('/books');
      cy.chooseCategory('Databases');

      cy.get('[role=status]').contains('3 books');
      cy.card('Designing Data-Intensive Applications').should('be.visible');
      cy.card('PostgreSQL: Up and Running').should('be.visible');
      cy.noCard('Clean Code');
    });

    it('survives a reload because the filter lives in the URL', () => {
      cy.visit('/books');
      cy.chooseCategory('Science Fiction');
      cy.contains('h1', 'Science Fiction');
      cy.reload();
      cy.contains('h1', 'Science Fiction').should('be.visible');
      cy.get('#category').find(':selected').should('contain.text', 'Science Fiction');
    });

    it('lets the visitor go back to everything', () => {
      cy.visit('/books');
      cy.chooseCategory('Databases');
      cy.contains('button', 'Clear all filters').click();

      cy.contains('h1', 'All books').should('be.visible');
      cy.get('[role=status]').contains('7 books');
      cy.contains('button', 'Clear all filters').should('not.exist');
    });
  });

  describe('brand, availability and delivery filters', () => {
    it('combines brands with a category', () => {
      cy.visit('/books');
      cy.chooseCategory('Databases');
      cy.contains('label', "O'Reilly").find('input').check();

      cy.get('[role=status]').contains('3 books');
      cy.contains('label', 'Pearson').find('input').check();
      cy.noCard('Clean Code'); // Pearson, but not in Databases
    });

    it('shows books from several brands at once', () => {
      cy.visit('/books');
      cy.contains('label', 'Ace').find('input').check();
      cy.card('Dune').should('be.visible');
      cy.get('[role=status]').contains('2 books');
      cy.contains('label', 'Pearson').find('input').check();
      cy.get('[role=status]').contains('4 books');
      cy.card('Clean Code').should('be.visible');
      cy.location('search').should('match', /brand=ace/).and('match', /brand=pearson/);
    });

    it('hides out-of-stock books', () => {
      cy.visit('/books');
      cy.contains('label', 'Hide out-of-stock').find('input').check();
      cy.get('[role=status]').contains('6 books');
      cy.noCard('PostgreSQL: Up and Running');
    });

    it('filters by delivery window', () => {
      cy.visit('/books');
      cy.get('#deliver').select('Within 3 days');
      // Dune (+2) and Neuromancer (+3) and both e-books qualify; Clean Code (+4) does not.
      cy.card('Dune').should('be.visible');
      cy.noCard('Clean Code');
      cy.card('The Pragmatic Programmer (E-book)').should('be.visible');
    });

    it('explains an empty result and recovers', () => {
      cy.visit('/books');
      cy.contains('label', 'Ace').find('input').check();
      cy.chooseCategory('Databases');

      cy.contains('No books match these filters').should('be.visible');
      cy.get('[role=status]').contains('0 books');
      cy.contains('main button', 'Clear filters').click();
      cy.get('[role=status]').contains('7 books');
    });
  });

  describe('search and sorting', () => {
    it('searches titles and descriptions from the header', () => {
      cy.visit('/');
      cy.get('#site-search').type('cyberpunk{enter}');
      cy.contains('h1', 'Results for "cyberpunk"').should('be.visible');
      cy.card('Neuromancer').should('be.visible');
      cy.get('[role=status]').contains('1 book');
    });

    it('sorts by price, high to low', () => {
      cy.visit('/books');
      cy.get('#sort').select('Price: high to low');
      cy.get('article h3').first().should('contain.text', 'Designing Data-Intensive Applications');
      cy.get('article h3').last().should('contain.text', 'Neuromancer');
    });

    it('sorts by price, low to high', () => {
      cy.visit('/books?sort=price_asc');
      cy.get('article h3').first().should('contain.text', 'Neuromancer');
    });
  });

  describe('product page and related products', () => {
    it('opens a book from the catalogue and shows its details', () => {
      cy.visit('/books');
      cy.card('Designing Data-Intensive Applications').contains('a', 'Designing Data-Intensive Applications').click();

      cy.contains('h1', 'Designing Data-Intensive Applications').should('be.visible');
      cy.contains('by Martin Kleppmann');
      cy.contains('$44.99');
      cy.contains('9781449373320');
      cy.contains('nav a', 'Databases').should('have.attr', 'href').and('match', /category_id=\d+/);
    });

    it('groups related books by relation and navigates to one', () => {
      cy.visit('/books');
      cy.card('Designing Data-Intensive Applications').contains('a', 'Designing Data-Intensive Applications').click();

      cy.contains('h2', 'You might also like').should('be.visible');
      cy.contains('h3', 'Also available as').should('be.visible');
      cy.contains('h3', 'Similar books').should('be.visible');

      cy.contains('h3', 'Also available as')
        .parent()
        .contains('a', 'Designing Data-Intensive Applications (E-book)')
        .click();
      cy.contains('h1', 'Designing Data-Intensive Applications (E-book)').should('be.visible');
      cy.contains('Instant download');
      // and the e-book points back to the paperback
      cy.contains('h3', 'Also available as').parent().contains('a', /^Designing Data-Intensive Applications$/);
    });

    it('suggests what other customers bought', () => {
      cy.visit('/books');
      cy.card('Dune').contains('a', 'Dune').click();
      cy.contains('h3', 'Customers also bought').parent().contains('a', 'Neuromancer').should('be.visible');
    });

    it('does not suggest a book that has been withdrawn from sale', () => {
      cy.task('setProductActive', { sku: 'BK-PGUR-001', active: false });
      cy.visit('/books');
      cy.card('Designing Data-Intensive Applications').contains('a', 'Designing Data-Intensive Applications').click();
      cy.contains('h3', 'Also available as').should('be.visible');
      cy.contains('a', 'PostgreSQL: Up and Running').should('not.exist');
    });

    it('shows a friendly not-found page for an unknown book', () => {
      cy.visit('/books/999999');
      cy.contains('h1', 'Book not found').should('be.visible');
      cy.contains('a', 'Back to the catalogue').click();
      cy.location('pathname').should('eq', '/books');
    });

    it('asks a signed-out visitor to sign in before adding to the basket, then returns to the book', () => {
      cy.newUser('addguest').then((user) => {
        cy.visit('/books');
        cy.card('Dune').contains('a', 'Dune').click();
        cy.contains('button', 'Add to basket').click();

        cy.location('pathname').should('eq', '/login');
        cy.loginViaUi(user.email, user.password);
        cy.location('pathname').should('match', /^\/books\/\d+$/);
        cy.contains('h1', 'Dune').should('be.visible');
      });
    });

    it('adds a book to the basket when signed in and updates the header count', () => {
      cy.newUser('add').then((user) => {
        cy.visitAs(user, '/books');
        cy.card('Dune').contains('button', 'Add to basket').click();
        cy.contains('Added to your basket.').should('be.visible');
        cy.get('a[aria-label^="Basket"]').should('have.attr', 'aria-label', 'Basket, 1 items');
      });
    });
  });
});
