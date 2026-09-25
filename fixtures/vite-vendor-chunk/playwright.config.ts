import { defineConfig } from '@playwright/test';

// Run by scripts/vite-app.mjs --fixture vite-vendor-chunk in a copy of this folder, after it has installed
// the packed tarball and run `npm run build`. The dev server and `vite preview` of that build start
// together, one project for each. Neither is ever reused: a server left on 5204 or 5205 by something else
// fails the run rather than being tested in place of this app. The vendor chunk only exists in the build,
// so the prod project is the one that matters.
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
    { command: 'npm run dev -- --port 5204 --strictPort', url: 'http://localhost:5204', reuseExistingServer: false, timeout: 120_000, stdout: 'pipe' },
    { command: 'npm run preview -- --port 5205 --strictPort', url: 'http://localhost:5205', reuseExistingServer: false, timeout: 120_000 },
  ],
  projects: [
    { name: 'dev', use: { browserName: 'chromium', baseURL: 'http://localhost:5204' } },
    { name: 'prod', use: { browserName: 'chromium', baseURL: 'http://localhost:5205' } },
  ],
});
