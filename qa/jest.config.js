// Jest runs as native ES modules (see the "test:api" script), so no Babel transform is needed.
// One shared system under test is started in global-setup.js; test files run one at a time
// because they share that database (each test creates its own users to stay independent).
export default {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/api/**/*.test.js'],
  transform: {},
  maxWorkers: 1,
  testTimeout: 30_000,
  globalSetup: '<rootDir>/global-setup.js',
  globalTeardown: '<rootDir>/global-teardown.js',
  clearMocks: true,
};
