import { defineConfig } from '@playwright/test'

// Run by scripts/vite-app.mjs --fixture rspack in a copy of this folder, after it has installed the packed
// tarball and run `npm run build`. The dev server and a production build served by rspack preview start
// together, one project for each. Neither is ever reused: a server left on 5220 or 5221 by something else
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
    { command: 'npm run dev -- --port 5220', url: 'http://localhost:5220', reuseExistingServer: false, timeout: 120_000 },
    { command: 'npm run preview -- --port 5221', url: 'http://localhost:5221', reuseExistingServer: false, timeout: 120_000 },
  ],
  projects: [
    { name: 'dev', use: { browserName: 'chromium', baseURL: 'http://localhost:5220' } },
    { name: 'prod', use: { browserName: 'chromium', baseURL: 'http://localhost:5221' } },
  ],
})
