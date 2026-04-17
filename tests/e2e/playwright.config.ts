import { defineConfig } from '@playwright/test';

/**
 * Multi-instance E2E configuration.
 *
 * The demo stack exposes two Web instances (3001 / 3002) so tests can assert that
 * edits propagate across instances via Redis Pub/Sub. Each test typically opens
 * two browser contexts, one against each port.
 *
 * Assumes the stack is already running (`make up`). We do NOT start the stack
 * from Playwright because it's docker compose and has long readiness.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false, // tests share a single doc_id=1; run serially for clarity
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 8_000,
    navigationTimeout: 15_000,
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'multi-instance-chromium',
      use: {
        browserName: 'chromium',
      },
    },
  ],
});
