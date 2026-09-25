import { expect, test } from '@playwright/test';
import type { Api, InteractionReport } from 'react-inp-blame';

declare global {
  interface Window {
    __REACT_INP_BLAME__: Api;
  }
}

// Next.js 14.2 has no instrumentation-client. withInpBlame puts the install first in webpack's client
// entries, `main-app` for the App Router's page and `main` for the Pages Router's, so it runs before
// react-dom loads and registers with the library's hook. A click re-renders SlowList's 400 rows.
const pages = [
  { router: 'App Router', path: '/' },
  { router: 'Pages Router', path: '/pages-router' },
];

for (const { router, path } of pages) {
  test(`${router}: the install runs before react-dom, and a click is blamed on SlowList`, async ({ page }) => {
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('console', (m) => {
      if (m.text().includes('[react-inp-blame]') && m.type() !== 'log') problems.push(m.text());
    });
    await page.goto(path);
    await page.waitForSelector('[data-test=trigger]');
    await page.waitForFunction(() => window.__REACT_INP_BLAME__ !== undefined);
    expect(await page.evaluate(() => window.__REACT_INP_BLAME__.stats().react)).toBe('reading');
    // Hydrated, so the click is the render's and not a wait for hydration. React puts its props on the button
    // while it renders, before the hydration commits, so the page is left until it has nothing more to do.
    await page.waitForFunction(() => Object.keys(document.querySelector('[data-test=trigger]')!).some((key) => key.startsWith('__reactProps$')));
    await page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 5000 })));
    await page.waitForTimeout(1500);
    await page.click('[data-test=trigger]');
    const handle = await page.waitForFunction(() => window.__REACT_INP_BLAME__.last());
    const r = (await handle.jsonValue()) as InteractionReport;
    expect(r.reactStatus).toBe('reading');
    expect(r.explanation.blame).toMatchObject({ kind: 'render', name: 'SlowList', detail: 'Row ×400' });
    expect(problems).toEqual([]);
  });
}
