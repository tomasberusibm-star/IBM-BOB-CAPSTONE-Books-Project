# IBM BOB CAPSTONE Books Project

A public training project built with IBM Bob as a capstone exercise.

## Database (PostgreSQL 14+)

```bash
createdb books
psql -v ON_ERROR_STOP=1 -d books -f db/schema.sql   # tables, constraints, indexes, functions
psql -v ON_ERROR_STOP=1 -d books -f db/seed.sql     # fictional sample data
psql -v ON_ERROR_STOP=1 -d books -f db/examples.sql # sample queries (writes are rolled back)
```

The seed data is fictional and contains no real credentials.

## API (OpenAPI 3.0)

The REST contract is in [`api/openapi.yaml`](api/openapi.yaml) (20 operations: authentication,
catalogue and recommendations, order history / "Buy it again" / cancellation, basket and checkout).
Statuses and enums match the database schema.

```bash
npx @redocly/cli@2.76.0 lint api/openapi.yaml      # validate
npx @redocly/cli@2.76.0 preview-docs api/openapi.yaml   # browse the docs locally
```

## Backend (Node.js / Express)

[`backend/`](backend/) implements the API on top of the schema: authentication and sessions, catalogue
filtering with delivery-date logic, order-history recommendations, "Buy it again", the 48-hour
cancellation window, and checkout with gift points plus card payments. See
[`backend/README.md`](backend/README.md) for setup, tests and production notes.

## Frontend (React + Tailwind CSS)

[`frontend/`](frontend/) is the storefront: login, landing page with recommendations, catalogue with
category and brand browsing and delivery-date tags, product detail with related books, basket and
checkout (address, credit/debit card, gift points) and order history with **Buy In Again** and 48-hour
cancellation. See [`frontend/README.md`](frontend/README.md).

```bash
cd backend  && npm install && npm start      # API on 127.0.0.1:8080 (see backend/README.md)
cd frontend && npm install && npm run dev    # UI on http://127.0.0.1:5173
```

## Status

Database schema, API contract, backend (96 tests against a real PostgreSQL) and frontend (37 tests,
plus an end-to-end browser walkthrough against the live API) are implemented. Payments use a mock
processor: no real card is ever charged.

## License

Released under the [MIT License](LICENSE).
