import { defineConfig } from '@playwright/test';

// E2E config — only the extension.spec.js suite. Vitest unit tests run
// separately via `npm test`. Browser binary install is opt-in (run
// `npm run test:e2e:install` once).
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    actionTimeout: 5_000,
  },
});
