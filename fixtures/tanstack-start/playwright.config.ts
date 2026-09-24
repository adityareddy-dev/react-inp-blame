import { defineConfig } from '@playwright/test'

// Run by scripts/vite-app.mjs --fixture tanstack-start in a copy of this folder, after it has installed the
// packed tarball and run `npm run build`. The dev server and `vite preview` of that build, which TanStack
// Start renders on the server like the dev server, start together, one project for each. Neither is ever
// reused, so a server left on 5183 or 5184 by something else fails the run rather than being tested in
// place of this app. The template's dev script pins port 3000, so the commands call Vite directly.
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
    { command: 'npx vite dev --port 5183 --strictPort', url: 'http://localhost:5183', reuseExistingServer: false, timeout: 120_000, stdout: 'pipe' },
    { command: 'npx vite preview --port 5184 --strictPort', url: 'http://localhost:5184', reuseExistingServer: false, timeout: 120_000 },
  ],
  projects: [
    { name: 'dev', use: { browserName: 'chromium', baseURL: 'http://localhost:5183' } },
    { name: 'prod', use: { browserName: 'chromium', baseURL: 'http://localhost:5184' } },
  ],
})
