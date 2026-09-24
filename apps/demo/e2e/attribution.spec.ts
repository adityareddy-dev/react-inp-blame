import { expect, test } from '@playwright/test';
import type { CommitSummary, HookInfo, InteractionReport, Stats } from 'react-inp-blame';
import { clearReports, interact, settle, testAttribute, waitForFrames } from './page';

const prod = process.env.INP_MODE === 'prod';
// A render blamed from React's durations is measured; production builds have only counts to go on.
const renderConfidence = prod ? 'inferred' : 'measured';

test('hook is installed before React registers', async ({ page }) => {
  await page.goto('/#fine');
  await page.waitForSelector('[data-test=trigger]');
  const { stats, hook }: { stats: Stats; hook: HookInfo } = await page.evaluate(() => {
    const api = window.__REACT_INP_BLAME__;
    return { stats: api.stats(), hook: api.debug.hook() };
  });
  expect(stats.mode).toBe('shim');
  expect(hook.renderers.map((r) => r.rendererPackageName)).toContain('react-dom');
});

// install() runs before the app does, and Next.js warns when instrumentation-client takes over 16 ms.
// The budget here is under a third of that, which holds on a developer's machine (about 0.5 ms on the
// Windows PC this was written on) and on a shared CI runner alike.
const INSTALL_BUDGET_MS = 5;

test(`install() costs the page under ${INSTALL_BUDGET_MS} ms, the badge and panel loading after it`, async ({ page }) => {
  const loads: number[] = [];
  for (let i = 0; i < 5; i++) {
    // A new query string, so each goto loads the page rather than moving to its hash.
    await page.goto(`/?load=${i}#fine`);
    await page.waitForSelector('#react-inp-blame .badge');
    const stats: Stats = await page.evaluate(() => window.__REACT_INP_BLAME__.stats());
    loads.push(stats.installMs);
  }
  // Both calls the demo makes: the one the Vite plugin places ahead of the app, then install() in
  // SignInDemo.tsx. The median of five loads, because the first costs more than the reloads after it
  // and any single one can land on a busy moment of the machine.
  loads.sort((a, b) => a - b);
  await test.info().attach('install() over five loads, ms', { body: loads.map((ms) => ms.toFixed(2)).join(', '), contentType: 'text/plain' });
  expect(loads[2]).toBeLessThan(INSTALL_BUDGET_MS);
});

test('context storm: blames the OrderSummary subtree, LineItem x800', async ({ page }) => {
  const r = await interact(page, 'context-storm', () => page.click('[data-test=trigger]'));
  expect(r.commits.length).toBeGreaterThanOrEqual(1);
  const c = r.commits[0];
  expect(c.hasDurations).toBe(!prod);
  expect(c.hotPath).toContain('OrderSummary');
  expect(c.components[0].name).toBe('LineItem');
  expect(c.components[0].count).toBeGreaterThanOrEqual(800);
  expect(r.target?.component).toBe('ContextStorm');
  expect(r.explanation.blame).toMatchObject({ kind: 'render', name: 'OrderSummary', detail: `LineItem ×${c.components[0].count}`, confidence: renderConfidence });

  // The phases are the report's own numbers, and with this library's walk they make up the duration.
  const [waiting, working, updating] = r.explanation.phases.map((p) => p.ms);
  expect([waiting, working, updating]).toEqual([r.inputDelay, r.processing, r.presentation]);
  expect(waiting + working + r.walkMs + updating).toBeCloseTo(r.duration, 6);
  if (!prod) expect(r.processing).toBeGreaterThanOrEqual(c.total);
  // The one check on display text: there is a verdict to show.
  expect(r.verdict).toBeTruthy();
});

test('layout thrash: the forced layout is the verdict, the PriceTicker rows the sentence after it', async ({ page }) => {
  const r = await interact(page, 'layout-thrash', async () => {
    await page.click('[data-test=trigger]');
    // The long animation frame carrying the forced layout can arrive just after the report is
    // built (there is no settle timer); it folds into the report in place. Wait for it.
    await page
      .waitForFunction(
        () => {
          const last = window.__REACT_INP_BLAME__.last();
          return last && (last.frames ?? []).reduce((a, f) => a + f.forcedLayout, 0) > 4;
        },
        null,
        { timeout: 5_000 },
      )
      .catch(() => {});
  });
  expect(r.commits.length).toBeGreaterThanOrEqual(1);
  const names = r.commits[0].components.map((x) => x.name);
  expect(names).toContain('PriceTicker');
  expect(r.frames, 'Chromium reports long animation frames').not.toBeNull();
  const forced = r.frames!.reduce((a, f) => a + f.forcedLayout, 0);
  expect(forced).toBeGreaterThan(4);
  // What took the time changed and where it happened did not. The 400 layout effects reading
  // geometry are what this scenario is, and they outweigh the render they happen in; the subtree is
  // still named, because it is the file the reader has to open either way.
  expect(r.explanation.blame).toMatchObject({ kind: 'layout', name: 'LayoutThrash', detail: 'PriceTicker ×400', confidence: 'measured' });
  expect(r.explanation.blame.ms!).toBeGreaterThan(prod ? 4 : r.commits[0].total);
  // Forced layout is measured from a long animation frame, which a production build reports as fully
  // as a development one, so unlike the render blames this one keeps `measured` in both. That is the
  // claim the design doc's production column makes, checked here in the build it is about.
  if (prod) expect(r.commits[0].hasDurations).toBe(false);
});

test('handler hog: no React render, the click handler is named', async ({ page }) => {
  const r = await interact(page, 'handler-hog', async () => {
    await page.click('[data-test=trigger]');
    // The blame here rests on the long animation frame that timed the handler, and that entry can arrive
    // after the report was built, as a revision of it. On React 17 it usually does.
    await waitForFrames(page);
  });
  expect(r.commits.length).toBe(0);
  expect(r.frames, 'the long animation frame that timed the handler never arrived').not.toEqual([]);
  // Handlers are plain functions, so their names only survive in dev; a production build leaves
  // the prop name. Components get displayName stamped instead.
  if (prod) expect(r.target?.handler).toBeTruthy();
  else expect(r.target?.handler).toBe('computeChecksum');
  // Long Animation Frames timed the handler's script, so the blame is measured even without a render.
  // The handler busy-waits 120 ms; its script's recorded duration rounds, so only half of that is required.
  expect(r.explanation.blame).toMatchObject({ kind: 'script', name: r.target?.handler, confidence: 'measured' });
  expect(r.explanation.blame.ms).toBeGreaterThanOrEqual(60);
});

test('big list: BigList re-renders thousands of Row', async ({ page }) => {
  const r = await interact(page, 'big-list', () => page.locator('[data-test=trigger]').pressSequentially('7'));
  expect(r.commits.length).toBeGreaterThanOrEqual(1);
  const c = r.commits[0];
  expect(c.hotPath[0]).toBe('BigList');
  expect(c.components[0].name).toBe('Row');
  expect(c.components[0].count).toBeGreaterThanOrEqual(100);
  expect(r.explanation.blame).toMatchObject({ kind: 'render', name: 'BigList', detail: `Row ×${c.components[0].count}`, confidence: renderConfidence });
});

test('lifted state: the unrelated Sidebar carries the cost', async ({ page }) => {
  const r = await interact(page, 'lifted-state', () => page.locator('[data-test=trigger]').pressSequentially('a'));
  expect(r.commits.length).toBeGreaterThanOrEqual(1);
  const c = r.commits[0];
  expect(c.hotPath).toContain('Sidebar');
  expect(c.components[0].name).toBe('NavItem');
  expect(c.components[0].count).toBeGreaterThanOrEqual(600);
  expect(r.explanation.blame).toMatchObject({ kind: 'render', name: 'Sidebar', detail: `NavItem ×${c.components[0].count}`, confidence: renderConfidence });
});

test('cascading effect: the heavy second render is named, before or after the paint', async ({ page }) => {
  const r = await interact(page, 'cascading-effect', () => page.click('[data-test=trigger]'));
  // In every React tested (17.0.2, 18.3.1, 19.3.0) the render the click's useEffect sets off lands
  // after the paint, so the heavy commit is a follow-up: React 18 and 19 run the effect in the click's
  // own task but render its state update at default priority in a later one, and React 17 defers the
  // effect as well. The check accepts either placement in case a build commits it before the paint.
  // Either way the tool has to name Detail.
  const all = [...r.commits, ...r.followUps];
  expect(all.length).toBeGreaterThanOrEqual(2);
  const heavy = all.reduce((a, b) => (b.rendered > a.rendered ? b : a));
  expect(heavy.components.map((x) => x.name)).toContain('Detail');
  expect(heavy.rendered).toBeGreaterThanOrEqual(400);
  expect(heavy.joinedBy).toBe('exact');
  if (r.followUps.includes(heavy)) expect(heavy.at).toBeGreaterThan(r.end);
  else expect(heavy.at).toBeLessThanOrEqual(r.end);
});

test('slow render: a click that spends 2.5 seconds inside React is blamed on the render, not on nothing', async ({ page }) => {
  // The render runs inside the click's own dispatch and commits seconds after the click. Joining a
  // commit only to an input it landed close behind used to drop it, and the report then said React
  // had not rendered anything, as a measurement.
  const r = await interact(page, 'slow-render', () => page.click('[data-test=trigger]', { timeout: 30_000 }));

  expect(r.duration).toBeGreaterThan(1_000);
  expect(r.commits.length, r.verdict).toBeGreaterThanOrEqual(1);
  expect(r.unjoinedCommits).toBe(0);
  const c = r.commits[0];
  expect(c.components[0].name).toBe('Section');
  expect(c.components[0].count).toBeGreaterThanOrEqual(250);
  expect(r.explanation.blame).toMatchObject({ kind: 'render', name: 'SlowRender', confidence: renderConfidence });
  expect(r.verdict).not.toContain("didn't render anything");
  expect(r.target?.component).toBe('SlowRender');

  // The overlay's short line says as much as the sentence does: a blame worked out from component
  // counts is shown as the likeliest reading, and one React timed itself is not hedged.
  await page.click('#react-inp-blame .badge');
  const blame = page.locator('#react-inp-blame .panel .row').first().locator('.blame').first();
  await expect(blame).toContainText('SlowRender');
  if (prod) await expect(blame).toContainText('most likely');
  else await expect(blame).not.toContainText('most likely');
  await page.keyboard.press('Escape');
});

test('slow render: a keystroke that spends 2.5 seconds inside React is the key press\'s work, not an unjoined commit', async ({ page }) => {
  // React runs a text field's onChange from the native `input` event, which the browser dispatches
  // inside the keydown. Reading only the events Event Timing gives an interactionId to left
  // `window.event` unrecognised there, so the render of the keystroke was not stamped with the key
  // press and the report said React had rendered something it could not tie to the typing.
  const r = await interact(page, 'slow-render', () => page.type('[data-test=tag]', 'x', { timeout: 30_000 }));

  expect(r.unjoinedCommits, r.verdict).toBe(0);
  expect(r.commits.length + r.followUps.length, r.verdict).toBeGreaterThanOrEqual(1);
  const c = [...r.commits, ...r.followUps].reduce((a, b) => (b.rendered > a.rendered ? b : a));
  expect(c.components[0].name).toBe('Section');
  expect(c.components[0].count).toBeGreaterThanOrEqual(250);
  expect(r.verdict).not.toContain('could not be tied to');
  if (!prod) expect(r.target?.handler).toBe('retitle');
});

test('slow render: ticking a checkbox is the onChange handler, which React fires from the click', async ({ page }) => {
  // A checkbox has no change event of its own in React: ChangeEventPlugin reads the click. Looking
  // only for an onClick left every checkbox in the demo reporting no handler at all.
  const r = await interact(page, 'slow-render', () => page.click('[data-test=archived]', { timeout: 30_000 }));

  expect(r.target?.selector).toContain(testAttribute('archived'));
  if (prod) expect(r.target?.handler).toBeTruthy();
  else expect(r.target?.handler).toBe('includeArchived');
  expect(r.explanation.blame.kind).toBe('render');
});

// The sign-in page's "What took time" panel re-renders whenever it hears a report. Those renders land
// after the interaction's paint with no input of their own, so they would be stamped with the input the
// report belongs to and join it as its later render, which publishes a revision, which re-renders the
// panel again: a loop on any page that shows its own reports.
test("the page's own panel, which renders every report it hears, is never part of one", async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.waitForSelector('[data-test=email]');
  await settle(page);
  await clearReports(page);

  // A keystroke in each field in turn, so the panel grows a row per switch: by the sixth it re-renders
  // 26 components, over the 25 that make a later render worth reporting where there are no durations.
  const typing: Array<[field: string, key: string]> = [
    ['email', 'a'],
    ['password', 'b'],
    ['email', 'c'],
    ['password', 'd'],
    ['email', 'e'],
    ['password', 'f'],
  ];
  for (const [i, [field, key]] of typing.entries()) {
    await page.locator(`[data-test=${field}]`).press(key);
    await page.waitForFunction((reported) => window.__REACT_INP_BLAME__.reports().length >= reported, i + 1, { timeout: 8_000 });
  }
  await settle(page);

  const panel = ['GroupEntry', 'Entry', 'PhaseBar', 'Pill'];
  const renderedPanel = (c: CommitSummary) => c.components.some((x) => panel.includes(x.name));
  const reports: InteractionReport[] = await page.evaluate(() => window.__REACT_INP_BLAME__.reports());
  const walked: CommitSummary[] = await page.evaluate(() => window.__REACT_INP_BLAME__.debug.commits());
  await test.info().attach('reports', { body: reports.map((r) => `${r.revision} revisions: ${r.verdict}`).join('\n'), contentType: 'text/plain' });

  expect(reports.flatMap((r) => [...r.commits, ...r.followUps]).filter(renderedPanel), 'a panel render joined a report').toEqual([]);
  expect(walked.filter(renderedPanel).length, 'a panel render was walked').toBe(0);
  expect(errors, 'the page threw while reports were delivered').toEqual([]);
});

test('control: the well-built version stays cheap', async ({ page }) => {
  await page.goto('/#fine');
  await page.waitForSelector('[data-test=trigger]');
  await settle(page);
  await clearReports(page);
  await page.click('[data-test=trigger]');

  // The click's own commit proves the library heard it, whether or not the interaction was slow
  // enough to be reported at all.
  const walked = await page.waitForFunction(() => window.__REACT_INP_BLAME__.debug.commits()[0] ?? null, null, { timeout: 8_000 });
  const commit: CommitSummary = await walked.jsonValue();
  expect(commit.rendered).toBeLessThanOrEqual(3);
  const r: InteractionReport | null = await page.evaluate(() => window.__REACT_INP_BLAME__.last());
  if (r) expect(r.duration, r.verdict).toBeLessThan(100);
});
