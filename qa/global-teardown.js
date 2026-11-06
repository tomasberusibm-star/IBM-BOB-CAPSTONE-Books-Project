export default async function globalTeardown() {
  await globalThis.__QA_STACK__?.stop();
}
