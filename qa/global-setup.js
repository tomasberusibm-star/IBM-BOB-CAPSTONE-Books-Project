import { startStack } from './support/stack.js';

export default async function globalSetup() {
  const stack = await startStack();
  globalThis.__QA_STACK__ = stack;
  process.env.QA_API_URL = stack.apiUrl;
  process.env.QA_DATABASE_URL = stack.databaseUrl;
}
