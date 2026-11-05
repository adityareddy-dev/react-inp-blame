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

test('the published recipe sends the slow click as a vital on its RUM view', async ({ page }, testInfo) => {
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
    expect(events.some((event) => event.type === 'view' && event.view.name === 'after-click' && event.view.id !== vital.view.id)).toBe(true);
    expect(vital.view.url).toBe('http://localhost:5222/');
    expect(problems).toEqual([]);
    console.log(`INP ${vital.vital!.duration / 1e6} ms, ${vital.context!.blame.name}, view ${vital.view.id}`);
  } finally {
    const payload = testInfo.outputPath('rum-payload.ndjson');
    await writeFile(payload, events.map((event) => JSON.stringify(event)).join('\n'));
    await testInfo.attach('rum-payload', { path: payload, contentType: 'application/x-ndjson' });
  }
});
