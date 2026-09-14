import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Records a Chrome trace around one slow click and checks that the library's
// performance.measure calls reached the trace with their `devtools` detail intact.
// That detail is what the Chrome Performance panel (128+) turns into custom tracks.
// The trace is kept under apps/demo/traces so it can be loaded in DevTools by hand.
test('measures carry the devtools track detail into a Chrome trace', async ({ browser, page }) => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../traces');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `context-storm-${process.env.INP_MODE === 'prod' ? 'prod' : 'dev'}.json`);

  await page.goto('/#context-storm');
  await page.waitForSelector('[data-test=trigger]');
  await page.waitForTimeout(300);
  await browser.startTracing(page, {
    path: file,
    screenshots: false,
    categories: [
      'blink.user_timing',
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'disabled-by-default-devtools.timeline.stack',
      'v8.execute',
      'toplevel',
      'loading',
      'blink',
    ],
  });
  await page.click('[data-test=trigger]');
  await page.waitForFunction(() => (window as any).__REACT_INP__.last() != null);
  await page.waitForTimeout(500);
  await browser.stopTracing();

  const trace = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events: any[] = trace.traceEvents ?? trace;
  const ours = events.filter(
    (e) => typeof e.cat === 'string' && e.cat.includes('blink.user_timing') && typeof e.name === 'string' && (/^(React|Later) render · /.test(e.name) || /^\d+ ms click · /.test(e.name)),
  );
  for (const e of ours) console.log(`  ${e.ph} ${e.name}  args=${JSON.stringify(e.args).slice(0, 200)}`);
  expect(ours.length).toBeGreaterThan(0);
  const withDetail = ours.filter((e) => JSON.stringify(e.args).includes('devtools'));
  expect(withDetail.length).toBeGreaterThan(0);
  console.log(`  trace: ${file}  (Chrome DevTools > Performance > Load profile)`);
});
