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

The REST contract is in [`api/openapi.yaml`](api/openapi.yaml) (13 endpoints: authentication,
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

## Status

Database schema, API contract and backend implemented and tested (92 tests against a real PostgreSQL).

## License

Released under the [MIT License](LICENSE).
