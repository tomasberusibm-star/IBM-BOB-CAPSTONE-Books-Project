import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function findBin(name) {
  const dirs = [
    process.env.PG_BIN,
    ...(process.env.PATH ?? '').split(path.delimiter),
    '/opt/homebrew/opt/postgresql@17/bin',
    '/usr/lib/postgresql/17/bin',
    '/usr/pgsql-17/bin',
  ].filter(Boolean);
  for (const d of dirs) if (existsSync(path.join(d, name))) return path.join(d, name);
  throw new Error(`PostgreSQL binary "${name}" not found. Install PostgreSQL 14+ or set PG_BIN.`);
}

/**
 * Starts a throw-away PostgreSQL cluster that listens on a Unix socket only (no TCP),
 * loads db/schema.sql and db/seed.sql, and returns a stop() function that deletes it.
 */
export async function startTestDatabase() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bkpg-'));
  const data = path.join(dir, 'data');
  const user = userInfo().username;
  execFileSync(findBin('initdb'), ['-D', data, '-A', 'trust', '-U', user, '-E', 'UTF8'], { stdio: 'ignore' });

  const server = spawn(
    findBin('postgres'),
    ['-D', data, '-c', 'listen_addresses=', '-c', `unix_socket_directories=${dir}`, '-c', 'fsync=off', '-c', 'synchronous_commit=off'],
    { stdio: 'ignore' },
  );

  const connectionString = `postgresql://${encodeURIComponent(user)}@${encodeURIComponent(dir)}/postgres`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const c = new pg.Client({ connectionString });
      await c.connect();
      await c.query('CREATE DATABASE books');
      await c.end();
      break;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const databaseUrl = `postgresql://${encodeURIComponent(user)}@${encodeURIComponent(dir)}/books`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(readFileSync(path.join(root, 'db/schema.sql'), 'utf8'));
  await admin.query(readFileSync(path.join(root, 'db/seed.sql'), 'utf8'));
  await admin.end();

  return {
    databaseUrl,
    async stop() {
      server.kill('SIGINT');
      await new Promise((resolve) => {
        server.once('exit', resolve);
        setTimeout(resolve, 5000).unref();
      });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
