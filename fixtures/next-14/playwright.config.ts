import { defineConfig } from '@playwright/test';

// Run by scripts/vite-app.mjs --fixture next-14 in a copy of this folder, after it has installed the packed
// tarball and run `npm run build`. `next dev` and `next start` of that build start together, one project for
// each, on ports of their own; neither is ever reused.
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'off', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'NEXT_DIST_DIR=.next-dev npm run dev -- --port 5208', url: 'http://localhost:5208', reuseExistingServer: false, timeout: 180_000 },
    { command: 'npm run start -- --port 5209', url: 'http://localhost:5209', reuseExistingServer: false, timeout: 180_000 },
  ],
  projects: [
    { name: 'dev', use: { browserName: 'chromium', baseURL: 'http://localhost:5208' } },
    { name: 'prod', use: { browserName: 'chromium', baseURL: 'http://localhost:5209' } },
  ],
});
