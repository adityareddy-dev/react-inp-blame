import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { blamedRows, counter, open, settle, showPanel } from './page';

const APP = fileURLToPath(new URL('../src/App.tsx', import.meta.url));

// The dev server only (playwright.config.ts leaves this out of the prod project). An edit to the
// component that holds the counter is swapped in by Fast Refresh, and the library goes on blaming the
// next click as it did the first.
test('after a Fast Refresh edit the state is kept, and the next click is still blamed on SlowList', async ({ page }) => {
  test.skip(process.env.VITE_APP_COPY !== '1', 'edits src/App.tsx, so it runs only in the temp copy scripts/vite-app.mjs makes');
  const original = fs.readFileSync(APP, 'utf8');
  try {
    const { problems } = await open(page);
    await counter(page, 0).click();
    await expect(counter(page, 1)).toBeVisible();
    await showPanel(page);
    await expect(blamedRows(page, 'SlowList')).toHaveCount(1);

    await page.evaluate(() => {
      window.__notReloaded = true;
    });
    fs.writeFileSync(APP, original.replace('<h1>Get started</h1>', '<h1>Get started, edited</h1>'));
    await expect(page.getByRole('heading', { name: 'Get started, edited' })).toBeVisible({ timeout: 15_000 });
    // The count lives in App's own useState, so it surviving the edit means App was refreshed, not remounted.
    await expect(counter(page, 1)).toBeVisible();
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);

    // A sanity check: no row appears without an input behind it. It does not show that the hot update
    // went unreported. A commit joined to an earlier input shows up as a `.blame.later` line on that
    // input's row, and here the badge click that opened the panel is the newest input, so the hot
    // update's commit cannot reach the counter's row whatever the library does with it.
    await settle(page);
    await expect(page.locator('#react-inp-blame .panel .row')).toHaveCount(1);

    await counter(page, 1).click();
    await expect(counter(page, 2)).toBeVisible();
    await expect(blamedRows(page, 'SlowList')).toHaveCount(2);

    expect(problems).toEqual([]);
  } finally {
    fs.writeFileSync(APP, original);
  }
});
