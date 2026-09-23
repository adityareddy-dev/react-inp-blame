import { defineConfig } from '@playwright/test';

// Run by scripts/vite-app.mjs in a copy of this folder, after it has installed the packed tarball and
// run `npm run build`. The dev server and `vite preview` of that build start together, one project for
// each. Neither is ever reused: a server left on 5179 or 5180 by something else fails the run rather
// than being tested in place of this app. The dev server's log is shown, so a run says whether Vite
// found a dependency late and reloaded the page.
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
    { command: 'npm run dev -- --port 5179 --strictPort', url: 'http://localhost:5179', reuseExistingServer: false, timeout: 120_000, stdout: 'pipe' },
    { command: 'npm run preview -- --port 5180 --strictPort', url: 'http://localhost:5180', reuseExistingServer: false, timeout: 120_000 },
  ],
  projects: [
    { name: 'dev', use: { browserName: 'chromium', baseURL: 'http://localhost:5179' } },
    // A build has nothing to hot-swap.
    { name: 'prod', use: { browserName: 'chromium', baseURL: 'http://localhost:5180' }, testIgnore: /fast-refresh\.spec\.ts$/ },
  ],
});
