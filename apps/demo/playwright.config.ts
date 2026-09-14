import { defineConfig } from '@playwright/test';

const prod = process.env.INP_MODE === 'prod';
const port = Number(process.env.INP_PORT) || (prod ? 5178 : 5177);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1280, height: 900 },
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: prod ? `npx vite build && npx vite preview --port ${port} --strictPort` : `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: `${process.env.INP_LABEL || 'chromium'}-${prod ? 'prod' : 'dev'}`, use: {} }],
});
