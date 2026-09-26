import { expect, test } from '@playwright/test';
import type { HookInfo, InteractionReport, Stats } from 'react-inp-blame';
import { clearReports, interact, lastReport, waitForFrames } from './page';

const prod = process.env.INP_MODE === 'prod';

// Runs in Chromium, Firefox and WebKit. All three have Event Timing with interactionId (Chrome
// 96, Firefox 144, Safari 26.2); only Chromium has Long Animation Frames, so elsewhere a report
// says `frames: null` rather than an empty list that would read as "no long task".
test('reports name the component in any browser, with frames null where Long Animation Frames are missing', async ({ page, browserName }) => {
  await page.goto('/#context-storm');
  await page.waitForSelector('[data-test=trigger]');
  const { stats, hook }: { stats: Stats; hook: HookInfo } = await page.evaluate(() => {
    const api = window.__REACT_INP_BLAME__;
    return { stats: api.stats(), hook: api.debug.hook() };
  });
  expect(stats.mode).toBe('shim');
  expect(hook.renderers.map((r) => r.rendererPackageName)).toContain('react-dom');

  await clearReports(page);
  await page.click('[data-test=trigger]');
  const r = await lastReport(page);
  await test.info().attach(`${browserName}: verdict`, { body: r.verdict, contentType: 'text/plain' });
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
  // per-component times are left out, and the blame on the commit's total is inferred, as it is in a
  // production build, which has only counts to go on.
  const coarse = !prod && browserName !== 'chromium';
  expect(c.coarseClock).toBe(coarse);
  expect(c.hasDurations).toBe(!prod);
  expect(r.explanation.blame).toMatchObject({ kind: 'render', name: 'OrderSummary', detail: 'LineItem ×800', confidence: prod || coarse ? 'inferred' : 'measured' });
  if (coarse) {
    expect(c.components[0]).toMatchObject({ name: 'LineItem', self: null, total: null });
    // The commit's time in all: its render, and whatever committing it and its effects took. A
    // production build times no render, so there the blame has no milliseconds to check.
    expect(r.explanation.blame.ms!).toBeGreaterThanOrEqual(c.total);
    expect(r.explanation.blame.ms!).toBeLessThanOrEqual(r.processing);
  }
});

// The desktop scenarios attribution.spec.ts clicks, again in all three browsers and both builds.
// Firefox and WebKit have no Long Animation Frames to see a forced layout or a handler's script by,
// so where Chromium blames either, they blame the render React reported, or nothing where it had none.
test('layout thrash: the click is blamed on LayoutThrash and its 400 PriceTicker rows', async ({ page, browserName }) => {
  const r = await interact(page, 'layout-thrash', async () => {
    await page.click('[data-test=trigger]');
    if (browserName !== 'chromium') return;
    // As in attribution.spec.ts, the frame carrying the forced layout can revise the report after it is published.
    await page
      .waitForFunction(() => (window.__REACT_INP_BLAME__.last()?.frames ?? []).reduce((a, f) => a + f.forcedLayout, 0) > 4, null, { timeout: 5_000 })
      .catch(() => {});
  });
  expect(r.commits[0]?.components.map((x) => x.name)).toContain('PriceTicker');
  if (browserName === 'chromium') {
    expect(r.explanation.blame).toMatchObject({ kind: 'layout', name: 'LayoutThrash', detail: 'PriceTicker ×400', confidence: 'measured' });
  } else {
    // The forced layout is unknown, and the same rows carry the blame as a render.
    expect(r.frames).toBeNull();
    expect(r.explanation.blame).toMatchObject({ kind: 'render', name: 'LayoutThrash', detail: 'PriceTicker ×400', confidence: 'inferred' });
  }
});

test('handler hog: no React render, and the click is the handler that ran', async ({ page, browserName }) => {
  const r = await interact(page, 'handler-hog', async () => {
    await page.click('[data-test=trigger]');
    if (browserName === 'chromium') await waitForFrames(page);
  });
  expect(r.commits.length).toBe(0);
  if (prod) expect(r.target?.handler).toBeTruthy();
  else expect(r.target?.handler).toBe('computeChecksum');
  if (browserName === 'chromium') {
    expect(r.explanation.blame).toMatchObject({ kind: 'script', name: r.target?.handler, confidence: 'measured' });
    expect(r.explanation.blame.ms).toBeGreaterThanOrEqual(60);
  } else {
    // Nothing timed the script and React rendered nothing, so nothing is blamed.
    expect(r.frames).toBeNull();
    expect(r.explanation.blame).toMatchObject({ kind: 'none', name: null });
  }
});

test('slow render: a click that spends 2.5 seconds inside React is blamed on the render', async ({ page }) => {
  const r = await interact(page, 'slow-render', () => page.click('[data-test=trigger]', { timeout: 30_000 }));
  expect(r.commits.length, r.verdict).toBeGreaterThanOrEqual(1);
  expect(r.unjoinedCommits).toBe(0);
  expect(r.commits[0].components[0]).toMatchObject({ name: 'Section' });
  expect(r.target?.component).toBe('SlowRender');
  // Each section renders for 10 ms, which a clock in whole milliseconds times well enough, so a
  // development build's blame is measured in every browser.
  expect(r.commits[0].coarseClock).toBe(false);
  expect(r.explanation.blame).toMatchObject({ kind: 'render', name: 'SlowRender', detail: 'Section ×250', confidence: prod ? 'inferred' : 'measured' });
});

test('a browser that reports no event entries gets nothing installed, and a badge that says so', async ({ page }) => {
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
    mode: window.__REACT_INP_BLAME__.stats().mode,
    hook: '__REACT_DEVTOOLS_GLOBAL_HOOK__' in window,
    overlay: document.getElementById('react-inp-blame') != null,
  }));
  // The demo asks for the badge, so it is there to say this browser does not report INP.
  expect(installed).toEqual({ mode: 'unsupported', hook: false, overlay: true });
  const badge = page.locator('#react-inp-blame .badge');
  await expect(badge).toHaveAttribute('data-status', 'unsupported-browser');
  await expect(badge).toContainText('not measured');
  await badge.click();
  await expect(page.locator('#react-inp-blame .panel .status')).toContainText('does not report INP');
  // The install the Vite plugin adds and the demo's own install() call both ran; the reason is logged once.
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('no Event Timing interactionId');
});
