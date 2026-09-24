import { defineConfig } from "@playwright/test";

// Run by scripts/vite-app.mjs --fixture react-router-7 in a copy of this folder, after it has installed the
// packed tarball and run `npm run build`. React Router's dev server and `react-router-serve` of that
// build start together, one project for each, and neither is ever reused, so a server left on 5185 or
// 5186 by something else fails the run rather than being tested in place of this app.
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
    { command: "npm run dev -- --port 5185 --strictPort", url: "http://localhost:5185", reuseExistingServer: false, timeout: 120_000, stdout: "pipe" },
    { command: "npm run start", env: { PORT: "5186" }, url: "http://localhost:5186", reuseExistingServer: false, timeout: 120_000 },
  ],
  projects: [
    { name: "dev", use: { browserName: "chromium", baseURL: "http://localhost:5185" } },
    { name: "prod", use: { browserName: "chromium", baseURL: "http://localhost:5186" } },
  ],
});
