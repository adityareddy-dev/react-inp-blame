import { defineConfig } from '@playwright/test';

const prod = process.env.INP_MODE === 'prod';
const webpack = process.env.INP_BUNDLER === 'webpack';
const port = prod ? (webpack ? 5197 : 5198) : 5199;
const flag = webpack ? ' --webpack' : '';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${port}`, trace: 'off' },
  projects: [{ name: prod ? (webpack ? 'next-prod-webpack' : 'next-prod') : 'next-dev', use: {} }],
  webServer: {
    command: prod ? `npx next build${flag} && npx next start --port ${port}` : `npx next dev${flag} --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
