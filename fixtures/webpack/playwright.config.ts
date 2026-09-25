import { defineConfig } from '@playwright/test'

// Run by scripts/vite-app.mjs --fixture webpack in a copy of this folder, after it has installed the packed
// tarball and run `npm run build`. The dev server and a production build served by webpack-dev-server start
// together, one project for each. Neither is ever reused: a server left on 5210 or 5211 by something else
// fails the run rather than being tested in place of this app.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: [
    { command: 'npm run dev -- --port 5210', url: 'http://localhost:5210', reuseExistingServer: false, timeout: 120_000 },
    { command: 'npm run preview -- --port 5211', url: 'http://localhost:5211', reuseExistingServer: false, timeout: 120_000 },
  ],
  projects: [
    { name: 'dev', use: { browserName: 'chromium', baseURL: 'http://localhost:5210' } },
    { name: 'prod', use: { browserName: 'chromium', baseURL: 'http://localhost:5211' } },
  ],
})
