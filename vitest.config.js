import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.js'],
    // Playwright e2e specs live under tests/e2e/ and use a different
    // runner; keep vitest off them.
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
