# Bookstore backend

Node.js 22+/Express 5 REST API on PostgreSQL. It implements the contract in
[`../api/openapi.yaml`](../api/openapi.yaml) on top of the schema in [`../db/schema.sql`](../db/schema.sql).

## Run locally

```bash
createdb books
psql -v ON_ERROR_STOP=1 -d books -f ../db/schema.sql
psql -v ON_ERROR_STOP=1 -d books -f ../db/seed.sql      # optional sample data

cp .env.example .env                                     # then set JWT_SECRET (openssl rand -base64 48)
npm install
node --env-file=.env src/server.js                       # http://127.0.0.1:8080
```

## Test

```bash
npm run lint
npm test          # 92 tests; starts a throw-away PostgreSQL (Unix socket only) - needs PostgreSQL 14+ binaries
```

`npm test` finds `initdb`/`postgres` on `PATH`; set `PG_BIN` to the PostgreSQL `bin` directory if needed.

## How the business rules are implemented

| Area | Where | Behaviour |
|---|---|---|
| Authentication and sessions | `src/services/auth.js` | Argon2id hashes; login creates a `user_sessions` row and returns an HS256 JWT bound to it. Every request is checked against the session row, so logout, suspension and expiry take effect immediately. Lockout after repeated failures; identical `401` for every login failure; constant-time work for unknown e-mails. |
| Catalogue filtering | `src/services/catalogue.js` | Filter by category (recursive, with subcategories), brand (one or many), full-text `q`, `available_only`, `deliver_by`; sort by title, price, newest, delivery. |
| Tentative delivery date | `effective_delivery_date()` in `db/schema.sql` | Instant items: `null`. In stock: stored date if still in the future, else today + `DELIVERY_LEAD_DAYS`. Out of stock: stored restock date if in the future, else `null`. A past date is never shown. |
| Recommendations | `src/services/recommendations.js` | One SQL statement scoring three signals from the caller's paid orders (curated related products, same category, customers who bought the same titles). Excludes already-bought, inactive and out-of-stock items. |
| Buy it again | `src/services/orders.js` | Copies a past order into the basket at current prices, merges quantities, caps at stock, reports skipped items. |
| 48-hour cancellation | `src/services/orders.js` | Allowed while `now() <= placed_at + 48h` and status is `pending_payment`/`paid`/`processing`. One transaction: restock, credit redeemed points back, refund captured payments, mark cancelled. Idempotent. |
| Checkout and payment | `src/services/checkout.js` | Atomic: lock basket and products, validate stock, price, redeem gift points, create order, charge the card for the remainder. A decline rolls everything back. Mandatory `Idempotency-Key`. If a charge succeeded but the order cannot be committed, the charge is refunded automatically. |

## Security notes

* Binds to loopback by default; `HOST=0.0.0.0` is refused at startup.
* Card numbers and CVV never reach the API: only a provider token is accepted (raw card fields fail validation) and only brand and last 4 digits are stored.
* All SQL is parameterised. Requests are validated with strict schemas (unknown fields rejected). Responses never include stack traces, SQL errors or provider messages.
* Secrets come from the environment only. Logs are structured JSON and redact credentials. Rate limiting is applied per IP, with a stricter limit on `/api/auth/*`.
* In `NODE_ENV=production` the server refuses to start with the mock card processor, with e-mail verification disabled, or with a remote database without `sslmode=verify-full`.

## Before going to production

* **Card processor:** `src/payments/provider.js` ships with a deterministic mock. Implement the same two methods (`charge`, `refund`) for your real provider (client-side tokenisation).
* **E-mail verification:** registration creates `pending_verification` accounts. There is no verification endpoint yet; `REQUIRE_EMAIL_VERIFICATION=false` activates accounts directly and is for development only.
* **Reverse proxy:** `trust proxy` is off. If you run behind a proxy, enable it for that proxy only, otherwise rate limits and login auditing see the proxy's address.
* **Housekeeping:** purge old `idempotency_keys`, `login_attempts` and expired `user_sessions` on a schedule.
* **Database role:** run the API as a role with only DML privileges, not as the schema owner.
