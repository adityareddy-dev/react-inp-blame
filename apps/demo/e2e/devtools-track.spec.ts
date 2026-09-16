import { expect, test, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settle } from './page';

const prod = process.env.INP_MODE === 'prod';

/** An entry the Chrome Performance panel draws in a custom track, as the trace holds it. */
interface TrackEntry {
  via: 'measure' | 'timeStamp';
  name: string;
  track: string;
  group: string | undefined;
  color: string;
  tooltip?: string;
}

/**
 * The track entries in a trace, from both ways of making one: a `performance.measure` with a
 * `devtools` detail is a blink.user_timing begin event carrying the detail as JSON; a
 * `console.timeStamp` with a track is a "TimeStamp" event in devtools.timeline, with the track in
 * its data.
 */
function trackEntries(trace: any): TrackEntry[] {
  const found: TrackEntry[] = [];
  for (const e of (trace.traceEvents ?? trace) as any[]) {
    const data = e.args?.data;
    if (e.name === 'TimeStamp' && data?.track) {
      found.push({ via: 'timeStamp', name: data.message, track: data.track, group: data.trackGroup, color: data.color });
    } else if (typeof e.cat === 'string' && e.cat.includes('blink.user_timing') && e.ph === 'b' && typeof e.args?.detail === 'string') {
      const devtools = JSON.parse(e.args.detail).devtools;
      if (devtools?.track) found.push({ via: 'measure', name: e.name, track: devtools.track, group: devtools.trackGroup, color: devtools.color, tooltip: devtools.tooltipText });
    }
  }
  return found;
}

/**
 * Where the trace is written: the test's own output folder, or `apps/demo/traces` when INP_KEEP_TRACE
 * asks for it, which is where the design notes say to look for one to open in the Performance panel.
 */
function traceFile(name: string): string {
  if (!process.env.INP_KEEP_TRACE) return test.info().outputPath(name);
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../traces');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

/**
 * Records a Chrome trace around one slow click in the context storm, stopping once the library
 * has drawn its entries, and returns the trace with the measures still in the page's User Timing
 * buffer.
 */
async function traceSlowClick(browser: Browser, page: Page, file?: string): Promise<{ entries: TrackEntry[]; measuresLeft: string[] }> {
  await page.goto('/#context-storm');
  await page.waitForSelector('[data-test=trigger]');
  await settle(page);
  await browser.startTracing(page, {
    path: file,
    screenshots: false,
    categories: ['blink.user_timing', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-devtools.timeline.stack', 'v8.execute', 'toplevel', 'loading', 'blink'],
  });
  await page.click('[data-test=trigger]');
  await page.waitForFunction(() => window.__REACT_INP_BLAME__.last() != null);
  // The library draws once the page is idle. An idle callback queued now runs after the one it queued with the report.
  await settle(page);
  const trace = JSON.parse((await browser.stopTracing()).toString('utf8'));
  const measuresLeft = await page.evaluate(() => performance.getEntriesByType('measure').map((m) => m.name));
  return { entries: trackEntries(trace), measuresLeft };
}

const ours = (entries: TrackEntry[]) => entries.filter((e) => e.group === 'react-inp-blame');

// The track group, the track names and the colours are what the README tells people to look for, so
// they are checked exactly. Entry names and tooltips are display text like the verdict: they are only
// checked for the component and the track they have to name.

test("the click gets its own track beside React's, and its render is drawn only where React draws none", async ({ browser, page }) => {
  const file = traceFile(`context-storm-${prod ? 'prod' : 'dev'}.json`);
  const { entries, measuresLeft } = await traceSlowClick(browser, page, file);
  await test.info().attach('track entries', { body: ours(entries).map((e) => `${e.via} ${e.group} / ${e.track}: ${e.color} ${e.name}`).join('\n'), contentType: 'text/plain' });

  const clicks = ours(entries).filter((e) => e.track === 'Interaction blame');
  expect(clicks).toHaveLength(1);
  // Its tooltip is the verdict, which only a measure can carry.
  expect(clicks[0]).toMatchObject({ via: 'measure', color: 'warning' });
  expect(clicks[0].name).toContain('OrderSummary');
  expect(clicks[0].tooltip).toContain('OrderSummary');

  const renders = ours(entries).filter((e) => e.track === 'React renders');
  const reactsOwn = entries.filter((e) => e.track === 'Components ⚛');
  if (prod) {
    // A production build measures nothing and draws no track of its own, so the render goes in ours, through console.timeStamp.
    expect(reactsOwn).toHaveLength(0);
    expect(renders.length).toBeGreaterThanOrEqual(1);
    expect(renders[0]).toMatchObject({ via: 'timeStamp', color: 'primary' });
    expect(renders[0].name).toContain('OrderSummary');
  } else {
    // React 19.3 in development draws every component render it measured; a render track of ours would repeat it.
    expect(reactsOwn.length).toBeGreaterThan(0);
    expect(renders).toHaveLength(0);
    expect(clicks[0].tooltip).toContain('Components ⚛');
  }
  expect(measuresLeft.filter((name) => clicks.some((e) => e.name === name))).toEqual([]);
});

test.describe('in Chrome before 134', () => {
  // console.timeStamp draws no tracks there, React's or anyone's, so every entry has to be a measure.
  test.use({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36' });

  test('the click and its render are both performance.measure entries, cleared from the buffer once drawn', async ({ browser, page }) => {
    const { entries, measuresLeft } = await traceSlowClick(browser, page);
    expect(
      ours(entries)
        .map((e) => `${e.via} ${e.track}: ${e.color}`)
        .sort(),
    ).toEqual(['measure Interaction blame: warning', 'measure React renders: primary']);
    expect(measuresLeft.filter((name) => ours(entries).some((e) => e.name === name))).toEqual([]);
  });
});
