import { expect, test, type Page } from '@playwright/test';
import type { CommitSummary, HookInfo, InteractionReport, Stats } from 'react-inp-blame';

const prod = process.env.INP_MODE === 'prod';
// A render blamed from React's durations is measured; production builds have only counts to go on.
const renderConfidence = prod ? 'inferred' : 'measured';

async function interact(page: Page, scenario: string, act: () => Promise<void>): Promise<InteractionReport> {
  await page.goto(`/#${scenario}`);
  await page.waitForSelector('[data-test=trigger]');
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as any).__REACT_INP_BLAME__.clear());
  await act();
  await page.waitForFunction(() => (window as any).__REACT_INP_BLAME__.last() != null, null, { timeout: 8_000 });
  const r: InteractionReport = await page.evaluate(() => (window as any).__REACT_INP_BLAME__.last());
  const all: CommitSummary[] = await page.evaluate(() => (window as any).__REACT_INP_BLAME__.debug.commits());
  console.log(`  [${scenario}] ${r.verdict}  (overhead ${r.overheadMs.toFixed(2)}ms)`);
  console.log(`    window 0..${Math.round(r.duration)}ms; in window ${r.commits.map((c) => `${Math.round(c.at - r.start)}ms/${c.rendered}`).join(' ')} | follow-ups ${r.followUps.map((c) => `${Math.round(c.at - r.start)}ms/${c.rendered}`).join(' ')} | all ${all.map((c) => `${Math.round(c.at - r.start)}ms/${c.rendered}`).join(' ')}`);
  return r;
}

test('hook is installed before React registers', async ({ page }) => {
  await page.goto('/#fine');
  await page.waitForSelector('[data-test=trigger]');
  const { stats, hook }: { stats: Stats; hook: HookInfo } = await page.evaluate(() => {
    const api = (window as any).__REACT_INP_BLAME__;
    return { stats: api.stats(), hook: api.debug.hook() };
  });
  expect(stats.mode).toBe('shim');
  expect(hook.renderers.map((r) => r.rendererPackageName)).toContain('react-dom');
});

test('install() costs the page under 2 ms, the badge and panel loading after it', async ({ page }) => {
  const loads: number[] = [];
  for (let i = 0; i < 5; i++) {
    // A new query string, so each goto loads the page rather than moving to its hash.
    await page.goto(`/?load=${i}#fine`);
    await page.waitForSelector('#react-inp-blame .badge');
    const stats: Stats = await page.evaluate(() => (window as any).__REACT_INP_BLAME__.stats());
    loads.push(stats.installMs);
  }
  // Both calls the demo makes: the /auto import, then install({ overlay }) in main.tsx. The median
  // of five loads, because the first costs more than the reloads after it and any single one can
  // land on a busy moment of the machine.
  loads.sort((a, b) => a - b);
  console.log(`  install() over five loads: ${loads.map((ms) => ms.toFixed(1)).join(', ')} ms`);
  expect(loads[2]).toBeLessThan(2);
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

test('layout thrash: PriceTicker rows plus forced layout', async ({ page }) => {
  const r = await interact(page, 'layout-thrash', async () => {
    await page.click('[data-test=trigger]');
    // The long animation frame carrying the forced layout can arrive just after the report is
    // built (there is no settle timer); it folds into the report in place. Wait for it.
    await page
      .waitForFunction(
        () => {
          const last = (window as any).__REACT_INP_BLAME__.last();
          return last && last.frames.reduce((a: number, f: any) => a + f.forcedLayout, 0) > 4;
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
  expect(r.explanation.blame).toMatchObject({ kind: 'render', name: 'LayoutThrash', detail: 'PriceTicker ×400', confidence: renderConfidence });
});

test('handler hog: no React render, the click handler is named', async ({ page }) => {
  const r = await interact(page, 'handler-hog', () => page.click('[data-test=trigger]'));
  expect(r.commits.length).toBe(0);
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
  // In every React tested (17.0.2, 18.3.1, 19.3.0) the click's useEffect ran after the
  // paint, so the heavy commit is a follow-up. The check accepts either placement in case
  // a build flushes it before the paint. Either way the tool has to name Detail.
  const all = [...r.commits, ...r.followUps];
  expect(all.length).toBeGreaterThanOrEqual(2);
  const heavy = all.reduce((a, b) => (b.rendered > a.rendered ? b : a));
  expect(heavy.components.map((x) => x.name)).toContain('Detail');
  expect(heavy.rendered).toBeGreaterThanOrEqual(400);
  expect(heavy.joinedBy).toBe('exact');
  if (r.followUps.includes(heavy)) expect(heavy.at).toBeGreaterThan(r.end);
  else expect(heavy.at).toBeLessThanOrEqual(r.end);
  console.log(`    cascading effect landed ${r.followUps.includes(heavy) ? 'AFTER the paint (follow-up)' : 'BEFORE the paint (in window)'}`);
});

test('control: the well-built version stays cheap', async ({ page }) => {
  await page.goto('/#fine');
  await page.waitForSelector('[data-test=trigger]');
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as any).__REACT_INP_BLAME__.clear());
  await page.click('[data-test=trigger]');
  await page.waitForTimeout(600);
  const r: InteractionReport | null = await page.evaluate(() => (window as any).__REACT_INP_BLAME__.last());
  if (r) {
    console.log(`  [fine] ${r.verdict}`);
    expect(r.duration).toBeLessThan(100);
    const rendered = r.commits.reduce((a, c) => a + c.rendered, 0);
    expect(rendered).toBeLessThanOrEqual(3);
  }
});
