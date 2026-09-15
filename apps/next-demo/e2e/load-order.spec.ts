import { expect, test } from '@playwright/test';

const prod = process.env.INP_MODE === 'prod';

// The question: does instrumentation-client.ts run early enough for React to register with
// the DevTools hook? Proof is functional: if the first interaction's report carries React
// commits, the hook was wired before React committed. In dev, durations being present
// proves more, that a hook existed when the root was created (that is what turns on
// ProfileMode). stats() says whether the hook is ours ('shim') or was already there.
test('instrumentation-client wires the hook early enough to see React commits', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-test=trigger]');
  await page.waitForTimeout(500);
  const stats = await page.evaluate(() => (window as any).__REACT_INP__?.stats());
  console.log(`  [${prod ? 'prod' : 'dev'}] stats after load: ${JSON.stringify(stats)}`);
  expect(stats, 'library not installed: instrumentation-client did not run').toBeTruthy();
  // Our own shim records injections. A pre-existing hook (React Fast Refresh installs a stub in
  // dev whose inject() never fills the renderers map) is judged by the functional check below.
  if (stats.mode === 'shim') {
    expect(stats.renderers, 'React never called hook.inject: react-dom evaluated before any hook existed').toBeGreaterThanOrEqual(1);
  }

  await page.evaluate(() => (window as any).__REACT_INP__.clear());
  await page.type('[data-test=trigger]', 'a');
  await page.waitForFunction(() => (window as any).__REACT_INP__.last() != null, null, { timeout: 8_000 });
  const r = await page.evaluate(() => (window as any).__REACT_INP__.last());
  console.log(`  [${prod ? 'prod' : 'dev'}] ${r.verdict}`);
  const all = [...r.commits, ...r.followUps];
  expect(all.length, 'no React commit recorded for the interaction').toBeGreaterThanOrEqual(1);
  const c = all[0];
  expect(c.rendered).toBeGreaterThanOrEqual(600);
  console.log(`  [${prod ? 'prod' : 'dev'}] hot path ${c.hotPath.join(' > ')}, top ${c.components[0].name}`);
  // Names must survive the production minifier: the displayName loader in next.config.ts
  // stamps them as string literals. Without it the prod report reads "n".
  expect(c.hotPath.join(' > ')).toContain('Sidebar');
  expect(c.components[0].name).toBe('NavItem');
  if (!prod) expect(c.hasDurations).toBe(true);
});
