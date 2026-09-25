import { expect, test } from '@playwright/test';
import type { InteractionReport } from 'react-inp-blame';
import { clearReports, settle } from './page';

const prod = process.env.INP_MODE === 'prod';

// src/Budget.tsx: a click re-renders Orders (3,000 rows) and then Metrics (6,000), past the walk's budget of
// 5,000 components. Metrics did twice the work. Until 0.7.0 a production build, which has only counts to go
// on, blamed Orders, the subtree the walk reached first and counted in full.
test('a render past the walk budget is not blamed on the subtree the walk reached first', async ({ page }) => {
  await page.goto('/#budget');
  await page.waitForSelector('[data-test=trigger]');
  await settle(page);
  await clearReports(page);
  await page.click('[data-test=trigger]');
  await expect(page.locator('[data-test=trigger]')).toHaveText('Refresh (1)');
  const handle = await page.waitForFunction(() => window.__REACT_INP_BLAME__.last());
  const r = (await handle.jsonValue()) as InteractionReport;
  await test.info().attach('verdict', { body: r.verdict, contentType: 'text/plain' });
  expect(r.commits.some((c) => c.truncated)).toBe(true);
  expect(r.explanation.blame.kind).toBe('render');
  // Development builds have React's durations, which cover every subtree whether the walk reached it or not.
  if (prod) expect(r.explanation.blame.name).toBe('Budget');
  else expect(r.explanation.blame.name).toBe('Metrics');
  expect(r.verdict).not.toMatch(/mostly Order\b/);
});
