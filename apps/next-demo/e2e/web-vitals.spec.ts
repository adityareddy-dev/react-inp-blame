import { expect, test, type Page } from '@playwright/test';
import type { InteractionReport } from 'react-inp-blame';
import type { ReactAttribution } from 'react-inp-blame/web-vitals';

const prod = process.env.INP_MODE === 'prod';
const run = prod ? 'prod' : 'dev';

// app/vitals is the README's Next.js snippet: useReportWebVitals, with attributeINP adding the React side.
// The web-vitals Next.js vendors reports INP only once the page is hidden, so the test hides it the way
// web-vitals' own tests do, by answering `hidden` and dispatching the event.
//
// It hides the page only once web-vitals has taken the entries in. Every current web-vitals reads
// delivered entries in an idle callback, and on hide it reports before running a callback still waiting,
// so a page hidden in that gap reports no INP at all. That is web-vitals' to fix, and there is no metric
// then for this library to add to.

interface Reported {
  name: 'INP';
  value: number;
  entries: { interactionId: number; name: string }[];
  attribution: { react: ReactAttribution | null };
}

async function ready(page: Page): Promise<void> {
  await page.goto('/vitals');
  await page.waitForSelector('body[data-subscribed][data-vitals]', { state: 'attached' });
}

/** The newest report of each interaction, oldest interaction first, once there are `count` of them. */
async function interactions(page: Page, count: number): Promise<InteractionReport[]> {
  const handle = await page.waitForFunction(
    (n) => {
      const byId = new Map<number, InteractionReport>();
      for (const r of window.__REACT_INP_BLAME__.reports()) byId.set(r.interactionId, r);
      return byId.size >= n ? [...byId.values()] : null;
    },
    count,
    { timeout: 8_000 },
  );
  return (await handle.jsonValue()) as InteractionReport[];
}

/**
 * Hides the page after web-vitals has read the entries the library already has. Both observe the same
 * Event Timing entries and hear them in the same task, so an idle callback posted now runs after the
 * one web-vitals posted when it heard them.
 */
async function hide(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => resolve())));
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test('the INP useReportWebVitals reports carries the report for that interaction, not the latest one', async ({ page }) => {
  await ready(page);
  await page.click('[data-test=slow]');
  await page.locator('[data-test=quick]').press('a');
  const [click, key] = await interactions(page, 2);
  expect(click.type).toBe('click');
  expect(key.type).toMatch(/^key/);

  await hide(page);
  const handle = await page.waitForFunction(() => window.__INP_METRICS__?.at(-1), null, { timeout: 8_000 });
  const metric = (await handle.jsonValue()) as Reported;
  await test.info().attach(`${run}: attribution`, { body: JSON.stringify(metric.attribution, null, 2), contentType: 'application/json' });
  // Next.js hands over the build without attribution, so `react` is all there is.
  expect(Object.keys(metric.attribution)).toEqual(['react']);
  expect(metric.entries[0].interactionId, 'web-vitals chose another interaction as INP').toBe(click.interactionId);
  const react = metric.attribution.react;
  expect(react, 'no report for the INP interaction').not.toBeNull();
  expect(react!.interactionId).toBe(click.interactionId);
  expect(react!.blame).toEqual(click.explanation.blame);
  expect(react!.blame.kind).toBe('render');
  expect(react!.handler).toBe('onClick');
  expect(react!.commits.rendered).toBeGreaterThanOrEqual(400);
  // Names survive the production minifier through the displayName loader withInpBlame adds.
  expect(react!.hotPath).toEqual(['VitalsPage', 'Rows']);
  expect(react!.components[0].name).toBe('Row');
  if (!prod) expect(react!.commits.ms).not.toBeNull();
});
