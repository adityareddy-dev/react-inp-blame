import { expect, test, type Page } from '@playwright/test';
import type { InteractionReport } from 'react-inp-blame';

const run = process.env.INP_MODE === 'prod' ? 'prod' : 'dev';

// app/server/page.tsx: buttons that wait on the server, through a Server Action or a route handler, then
// render 300 slow rows with what came back. The click paints at once with its pending text, so it is quick
// and INP does not count the wait; the rows are a later render. Within inputWindow (1.5 s from the paint) the
// report carries that render as a follow-up and says how long after the paint it landed; past it, nothing
// holds the render, as the README's Known limits say.

async function open(page: Page): Promise<void> {
  // A route handler compiles on its first request under `next dev`, which would add seconds to the first wait.
  await page.request.get('/api/slow?ms=0');
  await page.goto('/server');
  await page.waitForSelector('body[data-subscribed]', { state: 'attached' });
}

/** Every report the page has, once `button`'s rows are in the document and a second more has passed. */
async function reportsAfter(page: Page, button: string): Promise<InteractionReport[]> {
  await page.click(`[data-test=${button}]`);
  await page.waitForSelector(`[data-test=${button}-done]`, { timeout: 10_000 });
  await page.waitForTimeout(1000);
  return page.evaluate(() => window.__REACT_INP_BLAME__.reports());
}

for (const [button, owner, how] of [
  ['action-short', 'ActionButton', 'a Server Action'],
  ['fetch-short', 'FetchButton', 'a route handler'],
] as const) {
  test(`a click that waits 400 ms on ${how} carries the render of what came back, named after the app's components`, async ({ page }) => {
    await open(page);
    const reports = await reportsAfter(page, button);
    expect(reports, 'one report, for the click').toHaveLength(1);
    const [r] = reports;
    await test.info().attach(`${run}: verdict`, { body: r!.verdict, contentType: 'text/plain' });
    expect(r!.target?.component).toBe(owner);
    // Quick in itself: the report is published for the heavy render that joined it, which INP leaves out.
    expect(r!.explanation.blame.kind).not.toBe('render');
    const later = r!.followUps.find((c) => c.hotPath.at(-1) === 'Rows');
    expect(later, 'the rows are a follow-up of the click').toBeTruthy();
    expect(later!.hotPath.slice(-2)).toEqual([owner, 'Rows']);
    // Under `next dev` a Server Action's result renders from the App Router's Router down, through a dozen of
    // Next.js's own boundaries per segment. They are passed like any library's layers, so the sentence names
    // the rows and not the page segment's ErrorBoundary.
    expect(r!.verdict).toMatch(/A second React render landed \d+ ms after the screen updated: .*inside Rows, mostly Row \(300 of the \d+/);
    expect(r!.verdict).not.toMatch(/ErrorBoundary|from Router down/);
  });
}

for (const [button, how] of [
  ['action-long', 'a Server Action'],
  ['fetch-long', 'a route handler'],
] as const) {
  test(`a click that waits 2 s on ${how} is past inputWindow, and no report holds the render of what came back`, async ({ page }) => {
    await open(page);
    const reports = await reportsAfter(page, button);
    await test.info().attach(`${run}: reports`, { body: JSON.stringify(reports.map((r) => r.verdict)), contentType: 'application/json' });
    expect(reports.flatMap((r) => [...r.commits, ...r.followUps]).filter((c) => c.hotPath.includes('Rows'))).toEqual([]);
  });
}
