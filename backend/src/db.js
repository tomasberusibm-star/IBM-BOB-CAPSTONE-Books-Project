import pg from 'pg';

// bigint (int8) ids and counts fit comfortably in a JS number for this domain.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
// Keep DATE columns as 'YYYY-MM-DD' strings; the default parser applies the server time zone.
pg.types.setTypeParser(1082, (v) => v);
// numeric stays a string (exact decimals) - money is never converted to float.

/** @param {import('pg').PoolConfig} options */
export function createPool(options) {
  return new pg.Pool({
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    application_name: 'bookstore-api',
    ...options,
  });
}

/**
 * Runs fn inside a transaction on a dedicated connection.
 * Commits when fn resolves, rolls back when it throws.
 */
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // the connection is broken; release() below discards it
    }
    throw err;
  } finally {
    client.release();
  }
}
