import { expect, test, type Page } from '@playwright/test';
import type { InteractionReport } from 'react-inp-blame';

const prod = process.env.INP_MODE === 'prod';
const run = prod ? 'prod' : 'dev';

// app/tag-manager: the App Router hydrates the document, so React's own click listener and a tag manager's both
// run as "#document.onclick". A development build keeps both names, and React's is dispatchDiscreteEvent. A
// production build minifies both into files that say nothing, so there the tag manager is not told apart.

/** Clicks `selector` on app/tag-manager and returns the click's report, once a long animation frame has timed it. */
async function clicked(page: Page, selector: string): Promise<InteractionReport> {
  await page.goto('/tag-manager');
  await page.waitForSelector('body[data-subscribed]', { state: 'attached' });
  await page.click(selector);
  await page.waitForFunction(() => window.__REACT_INP_BLAME__.last(), null, { timeout: 8_000 });
  // The blame rests on the frame that timed the listener, which can arrive as a revision.
  await page.waitForFunction(() => (window.__REACT_INP_BLAME__.last()?.frames?.length ?? 0) > 0, null, { timeout: 5_000 }).catch(() => {});
  const r = await page.evaluate(() => window.__REACT_INP_BLAME__.last());
  if (!r) throw new Error('waited for a report and got none');
  await test.info().attach(`${run}: verdict`, { body: r.verdict, contentType: 'text/plain' });
  return r;
}

test("a tag manager's document listener is blamed by its name, not the button's onClick or React's own listener", async ({ page }) => {
  const r = await clicked(page, '[data-test=tracked]');
  expect(r.target?.handler).toBe('onClick');
  const blame = r.explanation.blame;
  expect(blame.name).not.toBe('dispatchDiscreteEvent');
  if (prod) {
    // Nothing tells the two listeners apart, so the handler keeps the verdict, or a script blame is the tag
    // manager's 150 ms and never React's own few.
    if (blame.kind === 'script') expect(blame.ms).toBeGreaterThanOrEqual(75);
    else expect(blame).toMatchObject({ kind: 'handler', name: 'onClick' });
  } else if (r.frames?.some((f) => f.scripts.length)) {
    expect(blame).toMatchObject({ kind: 'script', name: 'trackClick', confidence: 'measured' });
    expect(r.explanation.cause).toMatch(/^A listener React did not attach ran for about \d+ ms: trackClick \(/);
  } else {
    // A dev server whose frames list no scripts says nothing of whose the time was, so the handler is a reading.
    expect(blame).toMatchObject({ kind: 'handler', name: 'onClick', confidence: 'inferred' });
  }
});

test("a slow onClick with no other listener is still the handler's, React's own listener on the document being React's", async ({ page }) => {
  const r = await clicked(page, '[data-test=slow]');
  expect(r.explanation.blame).toMatchObject({ kind: 'handler', name: 'onClick' });
  // A production build times no render, so there the handler's time is left unsaid.
  if (!prod) expect(r.explanation.blame.ms).toBeGreaterThanOrEqual(75);
});
