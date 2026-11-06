// Boots a throwaway system (temp PostgreSQL on a Unix socket + real API + Vite on loopback),
// runs the Cypress specs against it, and always tears everything down.
//   node scripts/e2e.mjs            headless run (CI)
//   node scripts/e2e.mjs --open     interactive Cypress runner
//   node scripts/e2e.mjs --spec cypress/e2e/auth.cy.js
import cypress from 'cypress';
import { startStack } from '../support/stack.js';

// Some editors set this for their own processes; it makes Electron (Cypress) behave like plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const open = args.includes('--open');
const specIdx = args.indexOf('--spec');
const spec = specIdx >= 0 ? args[specIdx + 1] : undefined;

const stack = await startStack({ frontend: true });
let exitCode = 1;
try {
  process.env.QA_DATABASE_URL = stack.databaseUrl;
  const options = {
    project: new URL('..', import.meta.url).pathname,
    config: { baseUrl: stack.appUrl },
    ...(spec ? { spec } : {}),
  };
  if (open) {
    await cypress.open(options);
    exitCode = 0;
  } else {
    const result = await cypress.run(options);
    exitCode = result.status === 'failed' || result.totalFailed > 0 ? 1 : 0;
  }
} catch (err) {
  console.error('E2E run failed:', err.message);
} finally {
  await stack.stop();
}
process.exit(exitCode);
