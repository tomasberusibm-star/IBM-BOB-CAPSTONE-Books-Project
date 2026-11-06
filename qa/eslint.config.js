import js from '@eslint/js';
import globals from 'globals';

const cypressGlobals = { cy: 'readonly', Cypress: 'readonly', expect: 'readonly', assert: 'readonly' };
const mochaGlobals = { describe: 'readonly', it: 'readonly', before: 'readonly', after: 'readonly', beforeEach: 'readonly', afterEach: 'readonly', context: 'readonly' };

export default [
  { ignores: ['node_modules/**', 'cypress/screenshots/**', 'cypress/downloads/**', 'cypress/videos/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
  {
    files: ['api/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
  {
    files: ['cypress/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...cypressGlobals, ...mochaGlobals } },
  },
];
