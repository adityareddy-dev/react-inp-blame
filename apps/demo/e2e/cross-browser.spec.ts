import { expect, test } from '@playwright/test';
import type { InteractionReport, Stats } from 'react-inp-blame';

const prod = process.env.INP_MODE === 'prod';

// Runs in Chromium, Firefox and WebKit. All three have Event Timing with interactionId (Chrome
// 96, Firefox 144, Safari 26.2); only Chromium has Long Animation Frames, so elsewhere a report
// says `frames: null` rather than an empty list that would read as "no long task".
test('reports name the component in any browser, with frames null where Long Animation Frames are missing', async ({ page, browserName }) => {
  await page.goto('/#context-storm');
  await page.waitForSelector('[data-test=trigger]');
  const stats: Stats = await page.evaluate(() => (window as any).__REACT_INP__.stats());
  expect(stats.mode).toBe('shim');
  expect(stats.renderers.map((r) => r.rendererPackageName)).toContain('react-dom');

  await page.evaluate(() => (window as any).__REACT_INP__.clear());
  await page.click('[data-test=trigger]');
  await page.waitForFunction(() => (window as any).__REACT_INP__.last() != null, null, { timeout: 8_000 });
  const r: InteractionReport = await page.evaluate(() => (window as any).__REACT_INP__.last());
  console.log(`  [${browserName}] ${r.verdict}`);
  expect(r.commits.length).toBeGreaterThanOrEqual(1);
  const c = r.commits[0];
  expect(c.hotPath).toContain('OrderSummary');
  expect(r.target?.component).toBe('ContextStorm');
  if (browserName === 'chromium') {
    expect(Array.isArray(r.frames)).toBe(true);
  } else {
    expect(r.frames).toBeNull();
    expect(r.laterFrames).toBeNull();
  }

  // Firefox and WebKit step performance.now() by 1 ms on a page without cross-origin isolation, so a
  // development build reads each of the 800 line items as a whole number of milliseconds. Those
  // per-component times are left out, and the blame on the commit's total is inferred.
  const coarse = !prod && browserName !== 'chromium';
  expect(c.coarseClock).toBe(coarse);
  expect(c.hasDurations).toBe(!prod);
  if (coarse) {
    expect(c.components[0]).toMatchObject({ name: 'LineItem', self: null, total: null });
    expect(r.explanation.blame).toMatchObject({ kind: 'render', name: 'OrderSummary', confidence: 'inferred' });
    expect(r.explanation.blame.ms).toBe(c.total);
  }
});

test('a browser that reports no event entries gets nothing installed', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' && m.text().includes('[react-inp-blame]')) warnings.push(m.text());
  });
  // What Safari before 26.2 and Firefox before 144 look like to the library's gate.
  await page.addInitScript(() => {
    const types = PerformanceObserver.supportedEntryTypes.filter((t) => t !== 'event');
    Object.defineProperty(PerformanceObserver, 'supportedEntryTypes', { get: () => types, configurable: true });
  });
  await page.goto('/#context-storm');
  await page.waitForSelector('[data-test=trigger]');

  const installed = await page.evaluate(() => ({
    mode: (window as any).__REACT_INP__.stats().mode,
    hook: '__REACT_DEVTOOLS_GLOBAL_HOOK__' in window,
    overlay: document.getElementById('react-inp-blame') != null,
  }));
  expect(installed).toEqual({ mode: 'unsupported', hook: false, overlay: false });
  // The /auto import and the demo's own install() call both ran; the reason is logged once.
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('no Event Timing interactionId');
});
