import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestDatabase } from '../../backend/test/helpers/testDatabase.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOOPBACK = '127.0.0.1';

/** An unused TCP port on loopback. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, LOOPBACK, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Child processes must not inherit Electron's "run as plain node" switch (set by some editors). */
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function waitFor(url, child, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited early (code ${child.exitCode}). ${child.tail?.() ?? ''}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

function launch(args, { cwd, env }) {
  const child = spawn(process.execPath, args, { cwd, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const keep = (b) => {
    tail = (tail + b.toString()).slice(-1500);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.tail = () => tail;
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000).unref();
  });
}

/**
 * Boots a disposable copy of the whole system for black-box testing:
 *   - PostgreSQL on a Unix socket only (no TCP), loaded with db/schema.sql + db/seed.sql
 *   - the real API process (backend/src/server.js) on 127.0.0.1 with the MOCK card processor
 *   - optionally the Vite dev server (frontend) on 127.0.0.1, proxying /api to that API
 * Everything binds to loopback only; secrets are random per run and never written to disk.
 */
export async function startStack({ frontend = false } = {}) {
  const db = await startTestDatabase();
  let api;
  let web;
  try {
    const apiPort = await freePort();
    api = launch([path.join(root, 'backend/src/server.js')], {
      cwd: path.join(root, 'backend'),
      env: {
        NODE_ENV: 'development',
        HOST: LOOPBACK,
        PORT: String(apiPort),
        DATABASE_URL: db.databaseUrl,
        JWT_SECRET: randomBytes(48).toString('base64'),
        REQUIRE_EMAIL_VERIFICATION: 'false',
        PAYMENT_PROVIDER: 'mock',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_GENERAL_PER_MIN: '100000',
        RATE_LIMIT_AUTH_PER_MIN: '100000',
        LOGIN_MAX_FAILURES: '5',
        LOGIN_LOCK_MINUTES: '15',
        DELIVERY_LEAD_DAYS: '2',
        SHIPPING_FLAT_CENTS: '499',
        FREE_SHIPPING_THRESHOLD_CENTS: '5000',
        TAX_RATE_BPS: '0',
      },
    });
    const apiUrl = `http://${LOOPBACK}:${apiPort}`;
    await waitFor(`${apiUrl}/api/categories`, api, 'API');

    let appUrl = null;
    if (frontend) {
      const vite = path.join(root, 'frontend/node_modules/vite/bin/vite.js');
      if (!existsSync(vite)) throw new Error('Frontend dependencies missing: run "npm install" in frontend/');
      const webPort = await freePort();
      web = launch([vite, '--host', LOOPBACK, '--port', String(webPort), '--strictPort'], {
        cwd: path.join(root, 'frontend'),
        env: { API_TARGET: apiUrl },
      });
      appUrl = `http://${LOOPBACK}:${webPort}`;
      await waitFor(appUrl, web, 'Frontend');
    }

    return {
      apiUrl,
      appUrl,
      databaseUrl: db.databaseUrl,
      async stop() {
        await stopChild(web);
        await stopChild(api);
        await db.stop();
      },
    };
  } catch (err) {
    await stopChild(web);
    await stopChild(api);
    await db.stop();
    throw err;
  }
}
