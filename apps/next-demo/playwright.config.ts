import { defineConfig } from '@playwright/test';

const prod = process.env.INP_MODE === 'prod';
const port = prod ? 5198 : 5199;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${port}`, trace: 'off' },
  projects: [{ name: prod ? 'next-prod' : 'next-dev', use: {} }],
  webServer: {
    command: prod ? `npx next build && npx next start --port ${port}` : `npx next dev --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
