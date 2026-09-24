import { test, type Page } from '@playwright/test';
import type { Api, InteractionReport } from 'react-inp-blame';

declare global {
  interface Window {
    /** The demo installs with `debugGlobal: true`, which is how these specs read the library. */
    __REACT_INP_BLAME__: Api;
  }
}

/** Waits until the page has nothing left to do, so that its start-up work is not part of the next interaction. */
export async function settle(page: Page): Promise<void> {
  // WebKit has no requestIdleCallback, so there half a second stands in for it.
  await page.evaluate(
    () => new Promise<void>((resolve) => ('requestIdleCallback' in window ? requestIdleCallback(() => resolve(), { timeout: 2000 }) : setTimeout(resolve, 500))),
  );
}

/** Drops every report and commit from before now, so a test sees only the interaction it makes. */
export async function clearReports(page: Page): Promise<void> {
  await page.evaluate(() => window.__REACT_INP_BLAME__.clear());
}

/** How a report's selector names an element the demo marks with `data-test`. */
export const testAttribute = (value: string): string => `data-test="${value}"`;

/** Opens a scenario, makes one interaction in it, and returns the report. The verdict is attached to the test rather than printed. */
export async function interact(page: Page, scenario: string, act: () => Promise<void>): Promise<InteractionReport> {
  await page.goto(`/#${scenario}`);
  await page.waitForSelector('[data-test=trigger]');
  await settle(page);
  await clearReports(page);
  await act();
  const r = await lastReport(page);
  await test.info().attach(`${scenario}: verdict`, { body: `${r.verdict}\n\nmeasuring it cost ${r.overheadMs.toFixed(2)} ms`, contentType: 'text/plain' });
  return r;
}

/** Waits for the newest published report and returns it. */
export async function lastReport(page: Page, timeout = 8_000): Promise<InteractionReport> {
  const handle = await page.waitForFunction(() => window.__REACT_INP_BLAME__.last(), null, { timeout });
  return found(await handle.jsonValue());
}

/** Waits until the newest published report has a later render joined to it, and returns it. */
export async function reportWithLaterRender(page: Page, timeout = 8_000): Promise<InteractionReport> {
  const handle = await page.waitForFunction(
    () => {
      const last = window.__REACT_INP_BLAME__.last();
      return last && last.followUps.length ? last : null;
    },
    null,
    { timeout },
  );
  return found(await handle.jsonValue());
}

/**
 * Waits until a long animation frame has joined the newest report. There is no settle timer: a report is
 * built from the entries in hand, and a frame that arrives after it folds into the next revision. Gives up
 * quietly, so a scenario that produced no frame still fails on what it asserts rather than here.
 */
export async function waitForFrames(page: Page, timeout = 5_000): Promise<void> {
  await page
    .waitForFunction(() => (window.__REACT_INP_BLAME__.last()?.frames?.length ?? 0) > 0, null, { timeout })
    .catch(() => {});
}

/** waitForFunction only resolves on a truthy value, which its type does not say. */
function found(report: InteractionReport | null): InteractionReport {
  if (!report) throw new Error('waited for a report and got none');
  return report;
}
