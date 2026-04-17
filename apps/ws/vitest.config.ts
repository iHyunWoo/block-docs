import { defineConfig } from 'vitest/config';

// Unit tests only — exclude anything suffixed `.integration.test.ts`.
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    exclude: ['src/__tests__/**/*.integration.test.ts', 'node_modules', 'dist'],
  },
});
