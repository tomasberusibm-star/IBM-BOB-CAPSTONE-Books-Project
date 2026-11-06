import { main } from './index.js';

try {
  main();
} catch (err) {
  // Configuration errors list setting names only, never values.
  console.error(err instanceof Error ? err.message : 'Failed to start');
  process.exit(1);
}
