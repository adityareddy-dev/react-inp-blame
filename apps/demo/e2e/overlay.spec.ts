import { expect, test } from '@playwright/test';
import { settle } from './page';

const prod = process.env.INP_MODE === 'prod';

/** Takes a screenshot into the test's own output folder and attaches it, so a run can be judged by eye. */
async function shot(page: import('@playwright/test').Page, name: string): Promise<void> {
  const file = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await test.info().attach(name, { path: file, contentType: 'image/png' });
}

// The on-page overlay: a badge with the page's INP, and a panel that names the component
// behind each slow interaction.
test('overlay: the badge shows the page INP and the panel blames the right thing', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-test=email]');
  const badge = page.locator('#react-inp-blame .badge');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('INP');
  await shot(page, `overlay-idle-${prod ? 'prod' : 'dev'}`);

  await page.locator('[data-test=email]').pressSequentially('ada@example.com', { delay: 60 });
  await page.locator('[data-test=password]').pressSequentially('Hunter2!', { delay: 60 });
  await page.click('[data-test=login]');
  await page.waitForSelector('[data-test=photos]', { timeout: 10_000 });
  // The badge shows the page's INP, which the login click has just made the worst interaction.
  await expect(badge).toHaveAttribute('data-rating', /needs-improvement|poor/, { timeout: 10_000 });
  await expect(badge).toContainText(/\d+ ms/);
  await shot(page, `overlay-badge-${prod ? 'prod' : 'dev'}`);

  await badge.click();
  const panel = page.locator('#react-inp-blame .panel');
  await expect(panel).toBeVisible();
  const rows = panel.locator('.row');
  expect(await rows.count()).toBeGreaterThanOrEqual(3);
  const first = rows.first();
  // The row is titled by the button's label: its text in a development build, and in production,
  // where labels come from attributes only, its data-test.
  await expect(first).toContainText(prod ? 'login' : 'Log in');
  if (!prod) await expect(first).toContainText('handleLogin');
  await first.click();
  await expect(first.locator('.more')).toBeVisible();
  await shot(page, `overlay-open-${prod ? 'prod' : 'dev'}`);

  const head = panel.locator('.head');
  await expect(head).toContainText(/\d+\s*ms/);
  await expect(head).toContainText('Page INP so far');

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await settle(page);
});
