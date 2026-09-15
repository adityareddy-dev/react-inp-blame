import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const prod = process.env.INP_MODE === 'prod';
const mode = prod ? 'prod' : 'dev';

// The on-page overlay: a badge with the page's INP, and a panel that names the component
// behind each slow interaction. Screenshots land in apps/demo/shots (gitignored) so the
// look can be judged by eye.
test('overlay: the badge shows the page INP and the panel blames the right thing', async ({ page }) => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../shots');
  fs.mkdirSync(dir, { recursive: true });

  await page.goto('/');
  await page.waitForSelector('[data-test=email]');
  const badge = page.locator('#react-inp-blame .badge');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('INP');
  await page.screenshot({ path: path.join(dir, `overlay-idle-${mode}.png`) });

  await page.type('[data-test=email]', 'ada@example.com', { delay: 60 });
  await page.type('[data-test=password]', 'Hunter2!', { delay: 60 });
  await page.click('[data-test=login]');
  await page.waitForSelector('[data-test=photos]', { timeout: 10_000 });
  await page.waitForTimeout(900);

  const badgeText = (await badge.textContent()) || '';
  console.log(`  badge: ${badgeText.replace(/\s+/g, ' ').trim()}`);
  expect(badgeText).toMatch(/\d+ ms/);
  expect(await badge.getAttribute('data-rating')).not.toBe('good');
  await page.screenshot({ path: path.join(dir, `overlay-badge-${mode}.png`) });

  await badge.click();
  const panel = page.locator('#react-inp-blame .panel');
  await expect(panel).toBeVisible();
  const rows = panel.locator('.row');
  expect(await rows.count()).toBeGreaterThanOrEqual(3);
  const first = rows.first();
  await expect(first).toContainText('Log in');
  if (!prod) await expect(first).toContainText('handleLogin');
  console.log(`  first row: ${((await first.textContent()) || '').replace(/\s+/g, ' ').trim()}`);
  await first.click();
  await expect(first.locator('.more')).toBeVisible();
  await page.screenshot({ path: path.join(dir, `overlay-open-${mode}.png`) });

  const head = ((await panel.locator('.head').textContent()) || '').replace(/\s+/g, ' ').trim();
  console.log(`  head: ${head}`);
  expect(head).toMatch(/\d+\s*ms/);
  expect(head).toContain('Page INP so far');

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});
