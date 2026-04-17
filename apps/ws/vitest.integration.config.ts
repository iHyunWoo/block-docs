import { defineConfig } from 'vitest/config';

// Integration suite — anything suffixed `.integration.test.ts`.
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.integration.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
