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

## Status

Database schema complete; application layer to be defined.

## License

Released under the [MIT License](LICENSE).
