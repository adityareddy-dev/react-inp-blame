import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { counter, settle } from './page';
import type {} from '../src/datadog';

interface RumEvent {
  type: string;
  date: number;
  view: { id: string; name?: string; url: string; interaction_to_next_paint?: number };
  vital?: { name: string; type: string; duration: number };
  context?: {
    rating: string;
    target: string;
    blame: { kind: string; name: string; confidence: string };
    react_build: string;
  };
}

test('the published recipe keeps the first vital when a later hidden-page report is slower', async ({ page }, testInfo) => {
  const events: RumEvent[] = [];
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await page.route('**/rum?*', async (route) => {
    const body = route.request().postData();
    if (body) events.push(...body.trim().split('\n').map((line) => JSON.parse(line) as RumEvent));
    await route.fulfill({ status: 202, body: '' });
  });
  // No SDK traffic, including telemetry, leaves the local fixture.
  await page.route(/^https?:\/\/(?!localhost:5222(?:\/|$))/, (route) => route.abort());
  await page.goto('/');
  await counter(page, 0).waitFor();
  await settle(page);
  const clickStarted = await page.evaluate(() => performance.timeOrigin + performance.now());
  await counter(page, 0).click();
  await expect(counter(page, 1)).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => {
    const observer = new PerformanceObserver((list) => {
      if (list.getEntries().some((entry) => (entry as PerformanceEventTiming).interactionId > 0 && entry.duration >= 200)) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe({ type: 'event', buffered: true, durationThreshold: 16 });
  }));
  await settle(page);
  const viewChangedAt = await page.evaluate(() => {
    const now = performance.timeOrigin + performance.now();
    window.startNextRumView();
    return now;
  });
  // Keep the page alive while its hidden-page callbacks send the payload.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const vitals = () => events.filter((event) => event.type === 'vital' && event.vital?.name === 'inp');
  try {
    await expect.poll(() => vitals().length, { timeout: 40_000 }).toBe(1);
    const vital = vitals()[0];
    expect(vital.view.name).toBe('slow-click');
    expect(vital.vital?.type).toBe('duration');
    expect(vital.vital!.duration).toBeGreaterThan(200_000_000);
    expect(vital.context).toMatchObject({
      target: 'App (button.counter)',
      blame: { kind: 'render', name: 'SlowList', confidence: 'inferred' },
      react_build: 'production',
    });
    expect(vital.date).toBeGreaterThanOrEqual(clickStarted - 10);
    expect(vital.date).toBeLessThan(viewChangedAt);
    await expect.poll(() => events.some((event) =>
      event.type === 'view' && event.view.id === vital.view.id &&
      event.view.interaction_to_next_paint === vital.vital!.duration,
    )).toBe(true);
    const nextView = events.find((event) => event.type === 'view' && event.view.name === 'after-click' && event.view.id !== vital.view.id);
    expect(nextView).toBeDefined();
    expect(vital.view.url).toBe('http://localhost:5222/');

    const [firstReport] = await page.evaluate(() => window.inpReports);
    expect(firstReport.value * 1e6).toBe(vital.vital!.duration);
    await page.evaluate((duration) => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      document.querySelector('button.counter')!.addEventListener('click', () => {
        const end = performance.now() + duration + 250;
        while (performance.now() < end) { /* a slower interaction after returning to the tab */ }
      }, { once: true });
    }, firstReport.value);
    await settle(page);
    const secondClickStarted = await page.evaluate(() => performance.now());
    await counter(page, 1).click();
    await expect(counter(page, 2)).toBeVisible();
    await page.evaluate(({ startTime, duration }) => new Promise<void>((resolve) => {
      const observer = new PerformanceObserver((list) => {
        if (list.getEntries().some((entry) => entry.startTime >= startTime &&
          (entry as PerformanceEventTiming).interactionId > 0 && entry.duration > duration)) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe({ type: 'event', buffered: true, durationThreshold: 16 });
    }), { startTime: secondClickStarted, duration: firstReport.value });
    await settle(page);
    await page.evaluate(() => {
      // Ending the view makes the SDK publish its latest native INP.
      window.startNextRumView();
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => window.inpReports.length)).toBe(2);
    const [, secondReport] = await page.evaluate(() => window.inpReports);
    expect(secondReport.id).toBe(firstReport.id);
    expect(secondReport.value).toBeGreaterThan(firstReport.value);
    await expect.poll(() => events.some((event) =>
      event.type === 'view' && event.view.id === nextView!.view.id &&
      event.view.interaction_to_next_paint === secondReport.value * 1e6,
    ), { timeout: 40_000 }).toBe(true);
    expect(vitals()).toEqual([vital]);
    expect(vital.vital!.duration).toBe(firstReport.value * 1e6);
    expect(problems).toEqual([]);
    console.log(`INP ${firstReport.value} → ${secondReport.value} ms, one vital on view ${vital.view.id}`);
  } finally {
    const payload = testInfo.outputPath('rum-payload.ndjson');
    await writeFile(payload, events.map((event) => JSON.stringify(event)).join('\n'));
    await testInfo.attach('rum-payload', { path: payload, contentType: 'application/x-ndjson' });
    const reports = testInfo.outputPath('inp-reports.json');
    await writeFile(reports, JSON.stringify(await page.evaluate(() => window.inpReports)));
    await testInfo.attach('inp-reports', { path: reports, contentType: 'application/json' });
  }
});
