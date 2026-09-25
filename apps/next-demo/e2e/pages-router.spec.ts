import { expect, test } from '@playwright/test';
import type { InteractionReport } from 'react-inp-blame';

const run = process.env.INP_MODE === 'prod' ? 'prod' : 'dev';

// pages/pages-router.tsx is a Pages Router page. Its production entry loads instrumentation-client before
// react-dom, but on `next dev` from 15.3 its entry, next-dev.js under webpack and next-dev-turbopack.js
// under Turbopack, loads react-dom first. withInpBlame puts the install ahead of it there, so React is
// read on this page under every bundler and in every run, and a click re-rendering 400 rows is SlowList's.
test('on a Pages Router page the install runs before react-dom, and a click is blamed on SlowList', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (m) => {
    if (m.text().includes('[react-inp-blame]') && m.type() !== 'log') problems.push(m.text());
  });
  await page.goto('/pages-router');
  await page.waitForSelector('[data-test=trigger]');
  await page.waitForFunction(() => window.__REACT_INP_BLAME__ !== undefined);
  // Hydrated, so the click is the render's and not a wait for hydration.
  await page.waitForFunction(() => Object.keys(document.querySelector('[data-test=trigger]')!).some((key) => key.startsWith('__reactProps$')));
  await page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 5000 })));
  const renderers = await page.evaluate(() => window.__REACT_INP_BLAME__.debug.hook().renderers.map((r) => r.rendererPackageName));
  expect(renderers, 'react-dom registered before install() ran').toContain('react-dom');
  expect(await page.evaluate(() => window.__REACT_INP_BLAME__.stats().react)).toBe('reading');

  await page.click('[data-test=trigger]');
  const handle = await page.waitForFunction(() => window.__REACT_INP_BLAME__.last(), null, { timeout: 8_000 });
  const r = (await handle.jsonValue()) as InteractionReport;
  await test.info().attach(`${run}: verdict`, { body: r.verdict, contentType: 'text/plain' });
  expect(r.reactStatus).toBe('reading');
  expect(r.explanation.blame).toMatchObject({ kind: 'render', name: 'SlowList', detail: 'Row ×400' });
  expect(problems).toEqual([]);
});
