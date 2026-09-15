import { expect, test } from '@playwright/test';
import type { Stats } from 'react-inp-blame';

const prod = process.env.INP_MODE === 'prod';

// The question: does instrumentation-client.ts run early enough for React to register with
// the DevTools hook? Proof is functional: if the first interaction's report carries React
// commits, the hook was wired before React committed. stats() says whether the hook is ours
// ('shim') or was already there ('chained', Fast Refresh's stub in dev).
test('instrumentation-client wires the hook early enough to see React commits', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-test=trigger]');
  await page.waitForTimeout(500);
  const stats: Stats = await page.evaluate(() => (window as any).__REACT_INP__?.stats());
  console.log(`  [${prod ? 'prod' : 'dev'}] stats after load: ${JSON.stringify(stats)}`);
  expect(stats, 'library not installed: instrumentation-client did not run').toBeTruthy();
  // The library records what react-dom hands inject(), on its own hook and through one it chains
  // onto, so react-dom showing up here means install() ran before react-dom registered.
  expect(stats.renderers.map((r) => r.rendererPackageName), 'react-dom registered before install() ran').toContain('react-dom');

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
