import { defineConfig, devices } from '@playwright/test';

const prod = process.env.INP_MODE === 'prod';
const mode = prod ? 'prod' : 'dev';
const port = Number(process.env.INP_PORT) || (prod ? 5178 : 5177);
const crossBrowser = /cross-browser\.spec\.ts$/;
const phone = /phone\.spec\.ts$/;

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
  projects: [
    // Every spec but the phone one runs in Chromium; most need it (Long Animation Frames, the Chrome trace).
    { name: `${process.env.INP_LABEL || 'chromium'}-${mode}`, use: { browserName: 'chromium' }, testIgnore: phone },
    // Firefox and WebKit have Event Timing but no Long Animation Frames, so only the checks written for any browser run there.
    { name: `firefox-${mode}`, use: { browserName: 'firefox' }, testMatch: crossBrowser },
    { name: `webkit-${mode}`, use: { browserName: 'webkit' }, testMatch: crossBrowser },
    // Taps on a touch screen at a phone's size, the Android one with its CPU slowed as well.
    { name: `android-${mode}`, use: { ...devices['Pixel 7'] }, testMatch: phone },
    { name: `iphone-${mode}`, use: { ...devices['iPhone 15'] }, testMatch: phone },
    // The narrowest screen in common use, 360 px, for the panel alone: the other two are wider than it needs.
    { name: `galaxy-${mode}`, use: { ...devices['Galaxy S8'] }, testMatch: phone, grep: /the panel fits/ },
    // The headed walkthrough in ./tour is for a person to watch, so it is a project of its own that
    // only exists when INP_TOUR asks for it: a normal run neither collects it nor reports it skipped.
    ...(process.env.INP_TOUR ? [{ name: 'tour', testDir: './tour', use: { browserName: 'chromium' as const } }] : []),
  ],
});
