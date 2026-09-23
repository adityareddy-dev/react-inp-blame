import { expect, test } from '@playwright/test';
import { lastReport, settle, waitForFrames } from './page';

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

// The panel from the keyboard. A row's header comes after the close button in the Tab order and opens
// its row on Enter or Space, once however long the key is held. Escape closes the panel and moves the
// focus to the badge.
test('overlay: rows work from the keyboard, and Escape hands the focus back to the badge', async ({ page }) => {
  await page.goto('/#handler-hog');
  await page.waitForSelector('[data-test=trigger]');
  await settle(page);
  await page.click('[data-test=trigger]');
  await lastReport(page);
  // A long animation frame that arrives late revises the report, and a revision redraws the panel, so
  // the frame is waited for before any key is pressed.
  await waitForFrames(page);

  const badge = page.locator('#react-inp-blame .badge');
  const panel = page.locator('#react-inp-blame .panel');
  await badge.press('Enter');
  await expect(panel).toBeVisible();
  const row = panel.locator('.row').first();
  const header = row.locator('.toggle');
  // A redraw gives the focus back to a row header only, so one landing between here and the Tab would
  // send the Tab out of the overlay. Waiting for the frames above makes that unlikely, not impossible.
  await panel.locator('.x').focus();
  await expect(panel.locator('.x')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(header).toBeFocused();
  await expect(header).toHaveAttribute('aria-expanded', 'false');

  // Each press redraws the panel, and the header it was pressed on has the focus again afterwards.
  await page.keyboard.press('Enter');
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(row.locator('.more')).toBeVisible();
  await expect(header).toBeFocused();
  await page.keyboard.press('Space');
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(row.locator('.more')).toBeHidden();
  await expect(header).toBeFocused();

  // A held key: one keydown, then three more with `repeat` set. Four is even, so a row that toggled on
  // every one of them would end up closed again.
  for (let i = 0; i < 4; i++) await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(header).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(badge).toBeFocused();
});
