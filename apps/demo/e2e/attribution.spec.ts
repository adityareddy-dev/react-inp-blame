import { expect, test, type Page } from '@playwright/test';
import type { InteractionReport } from 'inpector';

const prod = process.env.INP_MODE === 'prod';

async function interact(page: Page, scenario: string, act: () => Promise<void>): Promise<InteractionReport> {
  await page.goto(`/#${scenario}`);
  await page.waitForSelector('[data-test=trigger]');
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as any).__REACT_INP__.clear());
  await act();
  await page.waitForFunction(() => (window as any).__REACT_INP__.last() != null, null, { timeout: 8_000 });
  const r: InteractionReport = await page.evaluate(() => (window as any).__REACT_INP__.last());
  const all: any[] = await page.evaluate(() => (window as any).__REACT_INP__.allCommits());
  console.log(`  [${scenario}] ${r.verdict}  (overhead ${r.overheadMs.toFixed(2)}ms)`);
  console.log(`    window 0..${Math.round(r.duration)}ms; in window ${r.commits.map((c) => `${Math.round(c.at - r.start)}ms/${c.rendered}`).join(' ')} | follow-ups ${r.followUps.map((c) => `${Math.round(c.at - r.start)}ms/${c.rendered}`).join(' ')} | all ${all.map((c) => `${Math.round(c.at - r.start)}ms/${c.rendered}`).join(' ')}`);
  return r;
}

test('hook is installed before React registers', async ({ page }) => {
  await page.goto('/#fine');
  await page.waitForSelector('[data-test=trigger]');
  const stats = await page.evaluate(() => (window as any).__REACT_INP__.stats());
  expect(stats.mode).toBe('shim');
  expect(stats.renderers).toBeGreaterThanOrEqual(1);
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
  expect(r.verdict).toContain('OrderSummary');
});

test('layout thrash: PriceTicker rows plus forced layout', async ({ page }) => {
  const r = await interact(page, 'layout-thrash', () => page.click('[data-test=trigger]'));
  expect(r.commits.length).toBeGreaterThanOrEqual(1);
  const names = r.commits[0].components.map((x) => x.name);
  expect(names).toContain('PriceTicker');
  const forced = r.frames.reduce((a, f) => a + f.forcedLayout, 0);
  expect(forced).toBeGreaterThan(4);
  expect(r.verdict).toContain('recalculating layout');
});

test('handler hog: no React render, the click handler is named', async ({ page }) => {
  const r = await interact(page, 'handler-hog', () => page.click('[data-test=trigger]'));
  expect(r.commits.length).toBe(0);
  expect(r.verdict).toContain("didn't render");
  // Handlers are plain functions, so their names only survive in dev. Production needs
  // source maps or a build transform; components get displayName stamped instead.
  if (prod) expect(r.target?.handler).toBeTruthy();
  else {
    expect(r.target?.handler).toBe('computeChecksum');
    expect(r.verdict).toContain('computeChecksum');
  }
});

test('big list: BigList re-renders thousands of Row', async ({ page }) => {
  const r = await interact(page, 'big-list', () => page.type('[data-test=trigger]', '7'));
  expect(r.commits.length).toBeGreaterThanOrEqual(1);
  const c = r.commits[0];
  expect(c.hotPath[0]).toBe('BigList');
  expect(c.components[0].name).toBe('Row');
  expect(c.components[0].count).toBeGreaterThanOrEqual(100);
});

test('lifted state: the unrelated Sidebar carries the cost', async ({ page }) => {
  const r = await interact(page, 'lifted-state', () => page.type('[data-test=trigger]', 'a'));
  expect(r.commits.length).toBeGreaterThanOrEqual(1);
  const c = r.commits[0];
  expect(c.hotPath).toContain('Sidebar');
  expect(c.components[0].name).toBe('NavItem');
  expect(c.components[0].count).toBeGreaterThanOrEqual(600);
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
  expect(r.verdict).toContain('Detail');
  expect(r.followUps.length ? r.verdict.includes('after the screen updated') : r.verdict.includes('times before the screen updated')).toBe(true);
  console.log(`    cascading effect landed ${r.followUps.length ? 'AFTER the paint (follow-up)' : 'BEFORE the paint (in window)'}`);
});

test('control: the well-built version stays cheap', async ({ page }) => {
  await page.goto('/#fine');
  await page.waitForSelector('[data-test=trigger]');
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as any).__REACT_INP__.clear());
  await page.click('[data-test=trigger]');
  await page.waitForTimeout(600);
  const r: InteractionReport | null = await page.evaluate(() => (window as any).__REACT_INP__.last());
  if (r) {
    console.log(`  [fine] ${r.verdict}`);
    expect(r.duration).toBeLessThan(100);
    const rendered = r.commits.reduce((a, c) => a + c.rendered, 0);
    expect(rendered).toBeLessThanOrEqual(3);
  }
});
