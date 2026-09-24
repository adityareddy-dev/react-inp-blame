import { expect, test, type Page } from '@playwright/test';
import type { InteractionReport } from 'react-inp-blame';
import { interact, testAttribute, waitForFrames } from './page';

const prod = process.env.INP_MODE === 'prod';

// The desktop attribution checks again, tapped on a phone: a Pixel 7 in Chromium with its CPU slowed
// four times, as Lighthouse slows it for a mobile run, and an iPhone 15 in WebKit. Both have a touch
// screen and a phone's viewport, so a tap is the pointer and touch events a phone sends and the click
// it makes from them. The tool has to blame what it blames for a mouse click in attribution.spec.ts.
// WebKit gets no CPU slowdown (that goes through Chromium's DevTools protocol), no Long Animation
// Frames and a clock in whole milliseconds, so there forced layout and a handler's script go unseen
// and every render blame is inferred, as in cross-browser.spec.ts.
test.beforeEach(async ({ page, browserName }) => {
  if (browserName !== 'chromium') return;
  // Set once on the page, it holds across the navigations the test makes.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
});

const renderConfidence = (browserName: string) => (prod || browserName !== 'chromium' ? 'inferred' : 'measured');

/**
 * Waits for the click a tap ends in to join the newest report. Chromium paints the pointerdown and
 * pointerup before it runs the click, and their entries can come before the click's: a report built
 * from them alone, when they are slow or a later render makes it worth publishing, gets the click as a
 * revision. Gives up quietly, so a tap that never became a click fails on what the test asserts rather
 * than here.
 */
async function waitForClick(page: Page): Promise<void> {
  await page
    .waitForFunction(() => window.__REACT_INP_BLAME__.last()?.entries.some((e) => e.name === 'click'), null, { timeout: 8_000 })
    .catch(() => {});
}

/** Taps the element and waits for the report to hold the tap's click. */
async function tap(page: Page, selector: string): Promise<void> {
  await page.locator(selector).tap();
  await waitForClick(page);
}

test('a tap is one interaction, named after its click, on the button that was tapped', async ({ page, browserName }) => {
  const r = await interact(page, 'context-storm', () => tap(page, '[data-test=trigger]'));

  // pointerdown, pointerup and the click a phone makes from the touch share one interactionId, so the
  // tap is one report, named after its click as a mouse click's is. The touch events, and the mouse
  // events a phone sends for pages that listen only for a mouse, have no interactionId and stay out of it.
  const reports: InteractionReport[] = await page.evaluate(() => window.__REACT_INP_BLAME__.reports());
  expect(reports.map((x) => x.interactionId)).toEqual([r.interactionId]);
  const names = r.entries.map((e) => e.name);
  expect(names).toContain('click');
  expect(names.filter((n) => !['pointerdown', 'pointerup', 'click'].includes(n))).toEqual([]);
  expect(r.type).toBe('click');
  // Playwright's tap lifts the finger at once, so none of it is a finger resting on the screen.
  expect(r.holdMs).toBeLessThan(100);

  // The label is the button's text in a development build and, where labels come from attributes only, its data-test.
  expect(r.target?.selector).toContain(testAttribute('trigger'));
  expect(r.target?.label).toMatch(prod ? /^button "trigger"$/ : /^button "Add to cart \(\d+\)"$/);
  expect(r.target?.component).toBe('ContextStorm');

  const c = r.commits[0];
  expect(c?.hotPath).toContain('OrderSummary');
  expect(c?.components[0].name).toBe('LineItem');
  expect(c?.components[0].count).toBeGreaterThanOrEqual(800);
  expect(r.explanation.blame).toMatchObject({ kind: 'render', name: 'OrderSummary', confidence: renderConfidence(browserName) });
});

test('layout thrash: the tap is blamed on LayoutThrash and its 400 PriceTicker rows', async ({ page, browserName }) => {
  const r = await interact(page, 'layout-thrash', async () => {
    await tap(page, '[data-test=trigger]');
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
    // Without Long Animation Frames the forced layout is unknown, and the same rows carry the blame as a render.
    expect(r.frames).toBeNull();
    expect(r.explanation.blame).toMatchObject({ kind: 'render', name: 'LayoutThrash', detail: 'PriceTicker ×400', confidence: 'inferred' });
  }
});

test('handler hog: no React render, and the tap is the handler that ran', async ({ page, browserName }) => {
  const r = await interact(page, 'handler-hog', async () => {
    await tap(page, '[data-test=trigger]');
    if (browserName === 'chromium') await waitForFrames(page);
  });
  expect(r.commits.length).toBe(0);
  if (prod) expect(r.target?.handler).toBeTruthy();
  else expect(r.target?.handler).toBe('computeChecksum');
  if (browserName === 'chromium') {
    // The handler busy-waits 120 ms on the page's clock, which the CPU slowdown does not stretch.
    expect(r.explanation.blame).toMatchObject({ kind: 'script', name: r.target?.handler, confidence: 'measured' });
    expect(r.explanation.blame.ms).toBeGreaterThanOrEqual(60);
  } else {
    // Nothing timed the script, so nothing is blamed on it, and nothing on React either.
    expect(r.frames).toBeNull();
    expect(r.explanation.blame.kind).not.toBe('render');
  }
});

test('cascading effect: the heavy second render the tap sets off is named', async ({ page, browserName }) => {
  const r = await interact(page, 'cascading-effect', async () => {
    await page.locator('[data-test=trigger]').tap();
    // Only Chromium waits for the click. WebKit, when it paints the tap before Detail's render, can
    // report the page's first pointerdown alone, the one entry a browser reports however quick it was,
    // and never a click, which was too quick to be observed. The render joins that report instead.
    if (browserName === 'chromium') await waitForClick(page);
  });
  // As on the desktop, Detail's render can land before or after the paint; either way it is named.
  const all = [...r.commits, ...r.followUps];
  // A report of that pointerdown alone ends at its paint, and the tap's own commit, the click's re-render
  // of CascadingEffect, lands within a millisecond of it. Just after, it is too small to be a later
  // render and is left out, so Detail's render can be all the report holds.
  const pointerdownOnly = browserName !== 'chromium' && r.type === 'pointerdown';
  expect(all.length).toBeGreaterThanOrEqual(pointerdownOnly ? 1 : 2);
  const heavy = all.reduce((a, b) => (b.rendered > a.rendered ? b : a));
  expect(heavy.components.map((x) => x.name)).toContain('Detail');
  expect(heavy.rendered).toBeGreaterThanOrEqual(400);
  expect(heavy.joinedBy).toBe('exact');
});

test('slow render: tapping a checkbox is the onChange handler React fires from the click', async ({ page }) => {
  const r = await interact(page, 'slow-render', () => tap(page, '[data-test=archived]'));
  expect(r.target?.selector).toContain(testAttribute('archived'));
  if (prod) expect(r.target?.handler).toBeTruthy();
  else expect(r.target?.handler).toBe('includeArchived');
  expect(r.unjoinedCommits, r.verdict).toBe(0);
  expect(r.commits[0]?.components[0]).toMatchObject({ name: 'Section' });
  expect(r.explanation.blame).toMatchObject({ kind: 'render', name: 'SlowRender' });
});

// A finger usually rests on the screen for a moment before it lifts. The pointerdown is presented while
// it rests and the click only after it lifts; INP counts the slower of the two, and the rest of the
// span is holdMs. Playwright's tap lifts at once, so the touch is sent through the DevTools protocol.
const HOLD_MS = 250;

test(`a finger held down ${HOLD_MS} ms is kept out of the headline, in holdMs`, async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the touch is held through the DevTools protocol, which is Chromium only');
  const r = await interact(page, 'handler-hog', async () => {
    const cdp = await page.context().newCDPSession(page);
    const box = await page.locator('[data-test=trigger]').boundingBox();
    if (!box) throw new Error('the trigger has no box to touch');
    const touch = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
    await page.waitForTimeout(HOLD_MS);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await waitForClick(page);
    await waitForFrames(page);
  });
  const click = r.entries.find((e) => e.name === 'click');
  expect(click, r.entries.map((e) => e.name).join(', ')).toBeTruthy();
  expect(r.entries[0].name).toBe('pointerdown');
  // The headline is the click's own time, and the finger's rest is beside it rather than in it.
  expect(r.type).toBe('click');
  expect(r.duration).toBe(click!.duration);
  expect(r.holdMs).toBeGreaterThanOrEqual(HOLD_MS * 0.8);
  expect(r.explanation.blame).toMatchObject({ kind: 'script', name: r.target?.handler, confidence: 'measured' });
});
