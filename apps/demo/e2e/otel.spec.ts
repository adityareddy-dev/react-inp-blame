import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { InteractionReport } from 'react-inp-blame';
import type { INPMetricWithAttribution } from 'web-vitals/attribution';
import { settle } from './page';

// web-vitals' attribution build runs in the page beside the library, as in web-vitals.spec.ts, and from an
// init script, so its listener for the page hiding is in place before the library's, as it is where the
// telemetry is set up first. Every SDK react-inp-blame/otel has a recipe for reports INP from it.
const attributionBuild = path.join(path.dirname(createRequire(import.meta.url).resolve('web-vitals')), 'web-vitals.attribution.iife.js');
const webVitalsScript = `${fs.readFileSync(attributionBuild, 'utf8')}\nwindow.webVitals = webVitals;`;

type Attributes = Record<string, unknown>;

/**
 * INP as the SDKs report it: once, as the page hides. Each report goes through the entry at that moment,
 * shaped the way each SDK hands it over, since the demo installs none of them: the SDK's own log record,
 * the record the instrumentation's hook sees, Embrace's, Honeycomb's span and Faro's interaction_time.
 */
function watchInp(): void {
  type Otel = NonNullable<Window['__REACT_INP_BLAME_OTEL__']>;
  type Metric = { name: string; value: number; delta: number; rating: string; id: string; navigationType: string; entries: object[]; attribution: { interactionTime: number } };
  const w = window as unknown as { webVitals: { onINP: (fn: (metric: Metric) => void, opts: unknown) => void }; __otelSeen: { metric: Metric; routes: Record<string, Attributes> }[] };
  w.__otelSeen = [];
  w.webVitals.onINP(
    (metric) => {
      const otel = window.__REACT_INP_BLAME_OTEL__ as Otel;
      const time = metric.attribution.interactionTime;
      // The attributes OpenTelemetry's web vitals instrumentation puts on its browser.web_vital record.
      const vital = () => ({
        'browser.web_vital.name': metric.name.toLowerCase(),
        'browser.web_vital.value': metric.value,
        'browser.web_vital.delta': metric.delta,
        'browser.web_vital.rating': metric.rating,
        'browser.web_vital.id': metric.id,
        'browser.web_vital.navigation_type': metric.navigationType,
      });
      // The page's time as seconds and nanoseconds since the epoch, as the SDKs store it.
      const epoch = performance.timeOrigin + time;
      const hrTime: [number, number] = [Math.trunc(epoch / 1e3), Math.round((epoch % 1e3) * 1e6)];
      const withSetAttributes = <T extends { attributes: Attributes }>(record: T) =>
        Object.assign(record, {
          setAttributes(attributes: Attributes) {
            Object.assign(record.attributes, attributes);
            return record;
          },
        });
      const processor = new otel.InpBlameLogRecordProcessor();
      // The SDK's own record, as a processor first in `processors` gets it.
      const sdk = withSetAttributes({ hrTime, attributes: vital() as Attributes });
      processor.onEmit(sdk);
      // The plain record applyCustomLogRecordData gets, stamped with interactionTime in ms.
      const hooked: { attributes: Attributes; timestamp: number } = { attributes: vital(), timestamp: time };
      hooked.attributes = { ...hooked.attributes, ...otel.inpBlameAttributes(hooked) };
      // Embrace's record, stamped with an HrTime of its own.
      const embrace = withSetAttributes({ attributes: vital() as Attributes, timestamp: hrTime });
      processor.onEmit(embrace);
      // Honeycomb's INP span, handed the whole metric.
      const span = withSetAttributes({ attributes: {} as Attributes });
      span.setAttributes(otel.inpBlameAttributes(metric));
      // Faro's measurement, whose context takes strings.
      const faro = Object.fromEntries(Object.entries(otel.inpBlameAttributes(time)).map(([name, value]) => [name, String(value)]));
      w.__otelSeen.push({ metric, routes: { sdk: sdk.attributes, hook: hooked.attributes, embrace: embrace.attributes, honeycomb: span.attributes, faro } });
    },
    // The library observes at the browser's floor too, so both see the same interactions.
    { durationThreshold: 16 },
  );
}

test('react-inp-blame/otel puts the report\'s blame on the INP record or span each SDK sends', async ({ page }) => {
  await page.addInitScript({ content: webVitalsScript });
  await page.addInitScript(watchInp);
  await page.goto('/?otel#context-storm');
  await page.waitForSelector('[data-test=trigger]');
  await page.waitForFunction(() => window.__REACT_INP_BLAME_OTEL__ !== undefined, null, { timeout: 15_000 });
  await settle(page);

  await page.click('[data-test=trigger]');
  await page.waitForFunction(() => window.__REACT_INP_BLAME__.last() !== null, null, { timeout: 15_000 });
  // web-vitals takes the click's entries in an idle callback. A page hidden before that reports nothing,
  // since the hide's own report runs first and finds no INP yet.
  await settle(page);
  // An automated tab stays visible when another opens, so the page hides the way the browser says it has.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
  await page.waitForFunction(() => (window as unknown as { __otelSeen: unknown[] }).__otelSeen.length > 0, null, { timeout: 15_000 });

  const { seen, report } = await page.evaluate(() => {
    const all = (window as unknown as { __otelSeen: { metric: INPMetricWithAttribution; routes: Record<string, Attributes> }[] }).__otelSeen;
    const seen = all[all.length - 1]!;
    // TypeScript's DOM library does not declare Event Timing's interactionId yet.
    const interactionId = seen.metric.entries.map((e) => (e as { interactionId?: number }).interactionId).find(Boolean) ?? 0;
    const report: InteractionReport | null = window.__REACT_INP_BLAME__.reports().find((r) => r.interactionId === interactionId) ?? null;
    return { seen: { routes: seen.routes, value: seen.metric.value }, report: report && { blame: report.explanation.blame, label: report.target?.label ?? null } };
  });

  await test.info().attach('attributes', { body: JSON.stringify(seen.routes, null, 2), contentType: 'application/json' });
  expect(report).not.toBeNull();
  expect(report!.blame.name).toBeTruthy();
  // The label is the text the privacy check looks for, and the demo's button has one in every build.
  expect(report!.label).toBeTruthy();
  const labelText = /"(.+)"/.exec(report!.label!)?.[1] ?? report!.label!;
  for (const [route, attributes] of Object.entries(seen.routes)) {
    const ours = Object.fromEntries(Object.entries(attributes).filter(([name]) => name.startsWith('react_inp_blame.')));
    expect(ours['react_inp_blame.status'], route).toBe('matched');
    expect(ours['react_inp_blame.blame.kind'], route).toBe(report!.blame.kind);
    expect(ours['react_inp_blame.blame.name'], route).toBe(report!.blame.name);
    for (const value of Object.values(ours)) expect(String(value), route).not.toContain(labelText);
  }
});
