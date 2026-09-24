import { defineConfig } from "@playwright/test";

// Run by scripts/vite-app.mjs --fixture react-router in a copy of this folder, after it has installed the
// packed tarball and run `npm run build`. React Router's dev server and `react-router-serve` of that
// build start together, one project for each, and neither is ever reused, so a server left on 5181 or
// 5182 by something else fails the run rather than being tested in place of this app.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "off",
    screenshot: "only-on-failure",
  },
  webServer: [
    { command: "npm run dev -- --port 5181 --strictPort", url: "http://localhost:5181", reuseExistingServer: false, timeout: 120_000, stdout: "pipe" },
    { command: "npm run start", env: { PORT: "5182" }, url: "http://localhost:5182", reuseExistingServer: false, timeout: 120_000 },
  ],
  projects: [
    { name: "dev", use: { browserName: "chromium", baseURL: "http://localhost:5181" } },
    { name: "prod", use: { browserName: "chromium", baseURL: "http://localhost:5182" } },
  ],
});
