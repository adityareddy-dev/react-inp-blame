import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Blame } from 'react-inp-blame';
import type { ReactAttribution } from 'react-inp-blame/web-vitals';
import type { INPAttribution, INPMetricWithAttribution } from 'web-vitals/attribution';
import { settle, testAttribute } from './page';

// web-vitals' attribution build runs in the page beside the library, from its IIFE build, so the
// `generateTarget` option and the INP metric are the real ones rather than a stand-in.
const attributionBuild = path.join(path.dirname(createRequire(import.meta.url).resolve('web-vitals')), 'web-vitals.attribution.iife.js');
// The build declares a `webVitals` variable, which an init script keeps to itself; put it on window.
const webVitalsScript = `${fs.readFileSync(attributionBuild, 'utf8')}\nwindow.webVitals = webVitals;`;

/** The reported INP metrics, with the library's resolver supplying `attribution.interactionTarget`. Runs before any of the page's scripts. */
function watchInp(): void {
  const w = window as unknown as { webVitals: { onINP: (fn: (metric: unknown) => void, opts: unknown) => void }; __inpMetrics: unknown[] };
  w.__inpMetrics = [];
  w.webVitals.onINP((metric) => w.__inpMetrics.push(metric), {
    reportAllChanges: true,
    // The library observes at the browser's floor too, so both see the same interactions.
    durationThreshold: 16,
    // Looked up at call time: web-vitals asks for the target once the interaction is over, by which
    // point the page's own scripts have run.
    generateTarget: (node: Node | null) => window.__REACT_INP_BLAME_WEB_VITALS__?.generateTarget(node),
  });
}

/** The context storm takes hundreds of milliseconds in every build, so INP is far above the 40 ms the library reports from. */
const SLOW_ENOUGH_MS = 100;

test('component names ride web-vitals attribution, and the metric can be enriched from the same report', async ({ page }) => {
  await page.addInitScript({ content: webVitalsScript });
  await page.addInitScript(watchInp);
  await page.goto('/#context-storm');
  await page.waitForSelector('[data-test=trigger]');
  await settle(page);

  await page.click('[data-test=trigger]');
  // web-vitals hands its entries over in an idle callback, and the library publishes reports in a
  // task of their own, so wait for both rather than for a timeout.
  await page.waitForFunction(() => (window as unknown as { __inpMetrics: unknown[] }).__inpMetrics.length > 0, null, { timeout: 15_000 });
  await page.waitForFunction(() => window.__REACT_INP_BLAME__.last() !== null, null, { timeout: 15_000 });

  const seen = await page.evaluate(() => {
    const metrics = (window as unknown as { __inpMetrics: INPMetricWithAttribution[] }).__inpMetrics;
    // web-vitals' own metric type, so this call is the proof that attributeINP takes what web-vitals hands a callback.
    const metric = metrics[metrics.length - 1]!;
    // TypeScript's DOM library does not declare Event Timing's interactionId yet.
    const interactionId = metric.entries.map((e) => (e as { interactionId?: number }).interactionId).find(Boolean) ?? 0;
    const bridge = window.__REACT_INP_BLAME_WEB_VITALS__;
    if (!bridge) throw new Error('the demo has not put react-inp-blame/web-vitals on the window');
    const attribution: INPAttribution & { react: ReactAttribution | null } = bridge.attributeINP(metric);
    // What the library's own report says about the same interaction, to hold the enrichment against.
    const report = window.__REACT_INP_BLAME__.reports().find((r) => r.interactionId === interactionId) ?? null;
    // The entry names the heaviest commit, not the first: the slowest where React measured, else the
    // one that rendered most. Computed the same way here so the comparison is of the same commit.
    const weight = (c: { hasDurations: boolean; total: number; rendered: number }): number => (c.hasDurations ? c.total : c.rendered);
    const commits = report?.commits ?? [];
    const main = commits.length ? commits.reduce((a, b) => (weight(b) > weight(a) ? b : a)) : null;
    return {
      value: metric.value,
      interactionId,
      interactionTarget: attribution.interactionTarget,
      react: attribution.react,
      blame: (report?.explanation.blame ?? null) as Blame | null,
      hotPath: main?.hotPath ?? [],
    };
  });

  await test.info().attach('interactionTarget', { body: String(seen.interactionTarget), contentType: 'text/plain' });
  expect(seen.value).toBeGreaterThan(SLOW_ENOUGH_MS);

  // The component path lands in the field every consumer of web-vitals attribution already reads,
  // in place of web-vitals' own CSS selector.
  expect(seen.interactionTarget).toContain('ContextStorm');
  expect(seen.interactionTarget).toContain(`button[${testAttribute('trigger')}]`);

  // The same interaction, joined back to the library's report: the blame is the report's own.
  expect(seen.blame).not.toBeNull();
  expect(seen.react).not.toBeNull();
  expect(seen.react?.blame).toEqual(seen.blame);
  expect(seen.react?.interactionId).toBe(seen.interactionId);
  expect(seen.react?.schemaVersion).toBe(2);
  // Both sides non-empty, so the equality is of a real path rather than two empty lists.
  expect(seen.hotPath.length).toBeGreaterThan(0);
  expect(seen.react?.hotPath).toEqual(seen.hotPath);
  expect(seen.react?.hotPath).toContain('OrderSummary');
  expect(seen.react?.commits.rendered).toBeGreaterThan(0);
});
