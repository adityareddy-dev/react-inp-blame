import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// web-vitals' onINP runs in the page beside the library, from its IIFE build, reporting every change
// and observing at the library's own 16 ms threshold. After each interaction of a session the two
// have to name the same INP: the same latency, from the same interaction.
const webVitalsBuild = path.join(path.dirname(createRequire(import.meta.url).resolve('web-vitals')), 'web-vitals.iife.js');
// The build declares a `webVitals` variable, which an init script keeps to itself; put it on window.
const webVitalsScript = `${fs.readFileSync(webVitalsBuild, 'utf8')}\nwindow.webVitals = webVitals;`;

// Playwright's default headless shell reports nearly every click at 16 ms or more. Chromium's own
// headless mode paints a click that changes nothing within a frame, which the first input here must do.
test.use({ channel: 'chromium' });

interface Inp {
  value: number;
  interactionId: number;
  interactionCount: number;
}

/** Records web-vitals' INP reports, the page's first input, and when an Event Timing entry last arrived. Runs before any of the page's scripts. */
function watchInp(): void {
  const w = window as any;
  const seen = { reports: [] as Array<{ value: number; interactionId: number }>, lastEntryAt: 0, firstInput: null as number | null };
  w.__inpCheck = seen;
  w.webVitals.onINP((metric: any) => seen.reports.push({ value: metric.value, interactionId: metric.entries[0]?.interactionId }), { reportAllChanges: true, durationThreshold: 16 });
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries() as any[]) {
      seen.lastEntryAt = performance.now();
      if (e.entryType === 'first-input') seen.firstInput = e.duration;
    }
  });
  po.observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  po.observe({ type: 'first-input', buffered: true });
}

/** Runs one interaction, waits until web-vitals and the library have both taken whatever entries it produced, and compares their INP. */
async function interaction(page: Page, name: string, act: () => Promise<void>): Promise<Inp> {
  await act();
  // Entries come with the paint after the handlers, a frame or two apart (a keyup after its keydown);
  // a click that paints within 16 ms brings none. So wait for a quarter of a second without one.
  const acted: number = await page.evaluate(() => performance.now());
  await page.waitForFunction((since) => performance.now() - Math.max((window as any).__inpCheck.lastEntryAt, since) > 250, acted, { polling: 50 });
  // web-vitals takes each batch in an idle callback that waits at most a second, and so does this:
  // in Chromium's headless mode an idle callback without a limit sometimes never ran on this page.
  await page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 1000 })));
  const { vitals, library } = await page.evaluate(() => {
    const inp = (window as any).__REACT_INP_BLAME__.inp();
    const reports = (window as any).__inpCheck.reports;
    return { vitals: reports[reports.length - 1] ?? null, library: inp && { value: inp.value, interactionId: inp.interactionId, interactionCount: inp.interactionCount } };
  });
  console.log(`  ${name.padEnd(24)} web-vitals ${vitals?.value} ms (#${vitals?.interactionId}), react-inp-blame ${library?.value} ms (#${library?.interactionId}) of ${library?.interactionCount}`);
  expect(library && { value: library.value, interactionId: library.interactionId }, name).toEqual(vitals);
  return library;
}

test('page INP agrees with web-vitals after every interaction, from a quiet first click to past 50 interactions', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript({ content: webVitalsScript });
  await page.addInitScript(watchInp);
  await page.goto('/');
  await page.waitForSelector('[data-test=email]');
  // A few hundred ms after navigation the page's start-up work ends in a long animation frame of 60 to
  // 90 ms. A click that lands just before or after it waits for that frame and reads 16 ms or more, as 6
  // of 60 first clicks on a fresh browser did; after the badge is up and the page has had an idle
  // period and painted two frames, none of 120 did.
  await page.waitForSelector('#react-inp-blame .badge');
  await page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), { timeout: 1000 })));

  // A click that changes nothing paints within a frame: under the 16 ms floor it exists only as the
  // page's first-input entry, which both take.
  const quiet = await interaction(page, 'quiet first click', () => page.click('.wordmark'));
  const firstInput: number = await page.evaluate(() => (window as any).__inpCheck.firstInput);
  expect(firstInput, 'the first click, made once the page had settled, painted in 16 ms or more').toBeLessThan(16);
  expect(quiet.value).toBe(firstInput);

  for (const key of 'ada@example.com') await interaction(page, `email "${key}"`, () => page.locator('[data-test=email]').press(key));
  for (const key of 'Hunter2!') await interaction(page, `password "${key}"`, () => page.locator('[data-test=password]').press(key));
  const login = await interaction(page, 'log in', () => page.click('[data-test=login]'));
  await page.waitForSelector('[data-test=photos]');

  await interaction(page, 'open the lab', () => page.click('a[href="#lab/context-storm"]'));
  await interaction(page, 'add to cart', () => page.click('[data-test=trigger]'));
  await interaction(page, 'open "Done right"', () => page.click('.labnav a[href="#lab/fine"]'));
  // Cheap clicks until the page has had 55 interactions; some paint too quickly to be seen at all.
  const pageCount = () => page.evaluate(() => (performance as unknown as { interactionCount: number }).interactionCount);
  for (let n = 1; (await pageCount()) < 55; n++) {
    expect(n, 'clicks before the page counted 55 interactions').toBeLessThanOrEqual(60);
    await interaction(page, `add ${n}`, () => page.click('[data-test=trigger]'));
  }
  // A slow interaction makes both choose again at the new count: past 50 interactions INP is the
  // second longest, no longer the login click.
  await interaction(page, 'open "Context storm"', () => page.click('.labnav a[href="#lab/context-storm"]'));
  const last = await interaction(page, 'add to cart again', () => page.click('[data-test=trigger]'));
  expect(last.interactionCount).toBeGreaterThanOrEqual(50);
  expect(last.value).toBeLessThan(login.value);
});
