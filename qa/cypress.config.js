import { defineConfig } from 'cypress';
import pg from 'pg';

// The runner (scripts/e2e.mjs) boots a throwaway database + API + web server and passes the
// base URL on the command line and the database URL through the environment. Nothing here
// points at a real system: when run by hand without the runner there is nothing to test.
let pool;
const db = () => (pool ??= new pg.Pool({ connectionString: process.env.QA_DATABASE_URL, max: 2 }));

export default defineConfig({
  video: false,
  screenshotOnRunFailure: true,
  screenshotsFolder: 'cypress/screenshots',
  downloadsFolder: 'cypress/downloads',
  viewportWidth: 1280,
  viewportHeight: 900,
  defaultCommandTimeout: 8000,
  retries: { runMode: 1, openMode: 0 },
  e2e: {
    specPattern: 'cypress/e2e/**/*.cy.js',
    supportFile: 'cypress/support/e2e.js',
    setupNodeEvents(on) {
      // Direct database access is limited to arranging state the public API cannot:
      // granting gift points, ageing an order for the 48-hour rule, and toggling catalogue rows.
      on('task', {
        async grantGiftPoints({ email, points }) {
          await db().query(
            `INSERT INTO gift_points_ledger (user_id, entry_type, points, note)
             SELECT id, 'earn', $2, 'e2e grant' FROM users WHERE email = $1`,
            [email, points],
          );
          return null;
        },
        async giftPointsBalance({ email }) {
          const { rows } = await db().query(
            `SELECT COALESCE((SELECT balance FROM gift_point_accounts a WHERE a.user_id = u.id), 0) AS b
               FROM users u WHERE email = $1`,
            [email],
          );
          return Number(rows[0].b);
        },
        async stockOf({ sku }) {
          const { rows } = await db().query('SELECT stock_quantity FROM products WHERE sku = $1', [sku]);
          return rows[0].stock_quantity;
        },
        async ageOrder({ orderNumber, interval }) {
          await db().query('UPDATE orders SET placed_at = now() - $2::interval WHERE order_number = $1', [orderNumber, interval]);
          return null;
        },
        async setProductActive({ sku, active }) {
          await db().query('UPDATE products SET is_active = $2 WHERE sku = $1', [sku, active]);
          return null;
        },
        async resetCatalogue() {
          await db().query('UPDATE products SET is_active = true');
          return null;
        },
      });
    },
  },
});
