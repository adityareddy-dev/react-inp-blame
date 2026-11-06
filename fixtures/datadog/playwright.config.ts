import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'datadog.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { browserName: 'chromium', baseURL: 'http://localhost:5222' },
  webServer: {
    command: 'npm run preview -- --port 5222 --strictPort',
    url: 'http://localhost:5222',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
