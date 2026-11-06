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

## Status

Database schema and API contract complete; implementation to be defined.

## License

Released under the [MIT License](LICENSE).
