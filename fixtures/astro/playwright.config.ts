import { defineConfig } from '@playwright/test';

// Run by scripts/vite-app.mjs --fixture astro in a copy of this folder, after it has installed the packed
// tarball and run `npm run build`. `astro dev` and `astro preview` of that build start together, one project
// for each. Neither is ever reused, so a server left on 5200 or 5201 by something else fails the run rather
// than being tested in place of this app. `--ignore-lock` keeps both in the foreground: Astro 7 can move them
// to the background on its own, and Playwright takes a server that exits for one that failed.
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
    { command: 'npx astro dev --port 5200 --ignore-lock', url: 'http://localhost:5200', reuseExistingServer: false, timeout: 120_000, stdout: 'pipe' },
    { command: 'npx astro preview --port 5201 --ignore-lock', url: 'http://localhost:5201', reuseExistingServer: false, timeout: 120_000 },
  ],
  projects: [
    { name: 'dev', use: { browserName: 'chromium', baseURL: 'http://localhost:5200' } },
    { name: 'prod', use: { browserName: 'chromium', baseURL: 'http://localhost:5201' } },
  ],
});
