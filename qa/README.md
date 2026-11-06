# QA suite

Automated tests for the four areas in the test brief, derived from [`api/openapi.yaml`](../api/openapi.yaml)
and the user journeys. Everything runs against a **disposable system that the tests start themselves**:

- PostgreSQL on a Unix socket only (no TCP), loaded from `db/schema.sql` + `db/seed.sql`
- the real API process (`backend/src/server.js`) on `127.0.0.1` with the **mock** card processor
- for browser tests, the Vite dev server on `127.0.0.1`, proxying `/api` to that API

Ports are random, the JWT secret is random per run and never written to disk, and everything is removed
afterwards. No real card, database or network service is touched.

## Running

Requires Node 22.22+ (or 24+) and PostgreSQL 14+ binaries on the machine (`initdb`, `pg_ctl`).

```bash
cd backend  && npm install      # the API under test
cd frontend && npm install      # the UI under test (also provides RTL unit tests: npm test)
cd qa       && npm install

npm run test:api                # Jest + Supertest   (API, validated against the OpenAPI contract)
npm run test:e2e                # Cypress, headless  (real browser, whole stack)
npm run test:e2e:open           # Cypress interactive runner
node scripts/e2e.mjs --spec cypress/e2e/orders.cy.js    # a single spec
npm run lint
```

If your shell exports `ELECTRON_RUN_AS_NODE` (some editors do), Cypress refuses to start. The runner removes
it for its own processes; if you call `npx cypress` directly, use `env -u ELECTRON_RUN_AS_NODE npx cypress ...`.

## Layers

| Layer | Tool | Where | What it proves |
|---|---|---|---|
| Backend integration | `node:test` | `backend/test` | Services and SQL behave (96 tests) |
| **API contract and behaviour** | **Jest + Supertest** | `qa/api` | The deployed API matches the OpenAPI spec and the business rules (167 tests) |
| Component / page | Vitest + React Testing Library | `frontend/test` | Each page behaves for every API outcome, API mocked (88 tests) |
| **End to end** | **Cypress** | `qa/cypress/e2e` | The real UI + API + database work together in a browser (75 tests) |

**Contract checking.** Every Supertest response is validated against the OpenAPI response schema for that
operation and status (`support/contract.js`, Ajv). A response with an undocumented status, a missing required
field or a value outside an enum fails the test, so the spec and the implementation cannot drift apart.

**Test isolation.** Every test registers its own customer, so tests do not depend on each other or on seed
users. Suites run one at a time because they share one database. Tests that must change a shared row (stock,
`is_active`, delivery dates) restore it.

**Direct database access** is used only to arrange state the public API deliberately cannot produce: granting
gift points (earning rules are out of scope), moving an order's `placed_at` into the past (to test the
48-hour rule without waiting), and toggling stock / `is_active`. Assertions go through the API or the UI;
the database is read only to confirm side effects such as the points balance or stock level.

## Traceability

| Area | Requirement | API tests (`qa/api`) | Browser tests (`qa/cypress/e2e`) | RTL (`frontend/test`) |
|---|---|---|---|---|
| Authentication | Register, login, logout, lock-out, token handling, protected routes | `auth.test.js` AUTH-01..04 | `auth.cy.js` | `login.test.jsx` |
| Catalogue | Categories, brands, search, sort, pagination, delivery tags, product detail | `catalogue.test.js` CAT-01..06 | `catalogue.cy.js` | `catalogue.test.jsx`, `catalogue-filters.test.jsx`, `product.test.jsx` |
| Related products | `similar`, `also_bought`, `other_format`; withdrawn books hidden; recommendations | `catalogue.test.js` CAT-07, CAT-08 | `catalogue.cy.js` (product page) | `product.test.jsx`, `landing.test.jsx` |
| Basket | Add, change quantity, remove, stock limits | `checkout.test.js` BSK-01 | `checkout.cy.js` (Basket) | `basket-lines-points.test.jsx` |
| Checkout | Address, shipping, gift points, card, idempotent confirmation | `checkout.test.js` CHK-01..04 | `checkout.cy.js` | `basket.test.jsx`, `basket-lines-points.test.jsx` |
| Orders | History, **Buy In Again**, **48-hour cancellation** | `orders.test.js` ORD-01..04 | `orders.cy.js` | `orders.test.jsx` |

### Business rules asserted

| Rule | Where |
|---|---|
| 1 gift point = 1 cent; points pay for books only, never shipping or tax | CHK-02, `checkout.cy.js` |
| Redemption is capped by balance and by the book subtotal; negative, fractional and over-balance requests are rejected | CHK-02 |
| Points that cover the whole order need no card; otherwise a card is required (credit or debit) | CHK-02/03 |
| Shipping $4.99, free from $50 or for digital-only baskets | CHK-01, `checkout.cy.js` |
| A declined card or provider outage leaves no order, no stock change and no points spent | CHK-03, `checkout.cy.js` |
| Repeating a payment with the same `Idempotency-Key` returns the same order and charges once; reusing a key with a different body is refused | CHK-04 |
| Cancellation is allowed up to 48 h after placing (tested at 47 h 59 min and 48 h 1 min) and only in `pending_payment`, `paid`, `processing` | ORD-03, `orders.cy.js` |
| Cancelling returns stock and gift points, and is idempotent | ORD-03, `orders.cy.js` |
| Buy In Again adds still-sold books at today's price, merges with the basket, reports skipped items, and refuses when nothing is left | ORD-02, `orders.cy.js` |
| Customers see only their own orders | AUTH-03, ORD-01, `orders.cy.js` |
| Login failures are indistinguishable (no account enumeration); the token never reaches `localStorage` or a URL | AUTH-02, `auth.cy.js` |

## Findings and decisions

- **No defects were found in the application during this work.** Every failure seen while building the suite
  was a defect in a test (wrong selector, wrong assumption about a default). They were fixed in the tests.
- **Number input quirk:** in the gift-points field, clearing the box sets it to `0`, so typing straight after
  `clear()` produces `0120`/`1200`. The value is still clamped to the maximum, so nothing unsafe happens, but a
  user selecting-all and overwriting is the smoother path. The Cypress test uses select-all to mirror that.
- **Address book:** `save_to_address_book` defaults to `false` in the API (the UI sends `true`); the E2E helper
  asks for it explicitly when a test needs a saved address.
- **Test cards:** `tok_visa_4242`, `tok_mc_0005`, `tok_amex_0001` are approved; `tok_declined_*` is declined;
  `tok_error_*` simulates a provider outage. These are mock-processor tokens, not card numbers.

## Dependency audit

`npm audit` in `qa/` reports **0 high/critical** and **5 low** advisories, all through `deepmerge <= 4.3.1`
inside `jest-config` (a dev-only test runner dependency). No fixed version exists in the Jest 30 line; the only
"fix" npm offers is a breaking downgrade to Jest 25, which is itself end-of-life, so it was not applied.
`glob` and `minimatch` are pinned through `overrides` to patched versions. Re-check when Jest releases a fix.
These packages are never shipped or run in production.
