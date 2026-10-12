import { expect, test } from '@playwright/test';
import { lastReport, settle } from './page';

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

// React's development build runs slower than production, so there the badge says which build it measured,
// and the panel says to check a number in a production build. Neither shows in a production build.
test('overlay: a development build marks the badge dev, and the panel says to check in a production build', async ({ page }) => {
  await page.goto('/#handler-hog');
  await page.waitForSelector('[data-test=trigger]');
  const badge = page.locator('#react-inp-blame .badge');
  await badge.click();
  const panel = page.locator('#react-inp-blame .panel');
  await expect(panel.locator('.head')).toBeVisible();
  const note = panel.locator('.devnote');
  if (prod) {
    await expect(badge.locator('.dev')).toHaveCount(0);
    await expect(note).toHaveCount(0);
  } else {
    await expect(badge.locator('.dev')).toHaveText('dev');
    await expect(note).toHaveText('Development build. React runs slower here than in production, and StrictMode renders twice, so check anything amber or red in a production build.');
    await expect(note.locator('a')).toHaveAttribute('href', /\/docs\/install\.md#numbers-in-development$/);
  }
  await shot(page, `overlay-build-${prod ? 'prod' : 'dev'}`);
});

// The app's own chat button, fixed in the bottom right corner, was covered by the badge but for a sliver,
// and a click on it landed on the badge. With no position given, the badge now starts in a free corner.
test("overlay: with no position the badge leaves the corner the app's chat button holds, and a click on the button reaches it", async ({ page }) => {
  await page.goto('/devtools-hook.html?badge&widget');
  const wrap = page.locator('#react-inp-blame .wrap');
  await expect(page.locator('#react-inp-blame .badge')).toBeVisible();
  await expect(wrap).toHaveClass('wrap bl');
  await page.locator('[data-test=chat]').click({ timeout: 2_000 });
  await expect(page.locator('[data-test=chat]')).toHaveAttribute('data-clicks', '1');
  await expect(page.locator('#react-inp-blame .panel')).toBeHidden();
  // Where nothing holds it, bottom right as before.
  await page.goto('/devtools-hook.html?badge');
  await expect(page.locator('#react-inp-blame .badge')).toBeVisible();
  await expect(wrap).toHaveClass('wrap br');
});

// Hide for me takes the badge off for this browser alone. The library goes on reporting, and ?inp-blame
// brings the badge back.
test('overlay: Hide for me keeps the badge off across loads until ?inp-blame, and reports go on', async ({ page }) => {
  await page.goto('/devtools-hook.html?badge');
  await page.waitForSelector('[data-test=trigger]');
  const badge = page.locator('#react-inp-blame .badge');
  await badge.click();
  await page.locator('#react-inp-blame .hide').click();
  await expect(page.locator('#react-inp-blame')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('react-inp-blame'))).toBe('hidden');
  await settle(page);
  // The press on it was the panel's, not the page's: no report, and not in the page's INP or its count.
  expect(await page.evaluate(() => [window.__REACT_INP_BLAME__.reports().length, window.__REACT_INP_BLAME__.inp()?.interactionCount ?? 0])).toEqual([0, 0]);

  await page.reload();
  await page.waitForSelector('[data-test=trigger]');
  await page.click('[data-test=trigger]');
  await page.waitForFunction(() => window.__REACT_INP_BLAME__.reports().length > 0, null, { timeout: 8_000 });
  await expect(page.locator('#react-inp-blame')).toHaveCount(0);

  await page.goto('/devtools-hook.html?badge&inp-blame');
  await expect(badge).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('react-inp-blame'))).toBeNull();
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
  // A long animation frame that arrives late revises the report and redraws the panel, anywhere between
  // the key presses below. Every control keeps the focus across a redraw, as the next test checks.
  const badge = page.locator('#react-inp-blame .badge');
  const panel = page.locator('#react-inp-blame .panel');
  await badge.press('Enter');
  await expect(panel).toBeVisible();
  const row = panel.locator('.row').first();
  const header = row.locator('.toggle');
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

// A new report redraws the open panel, and so does Clear. The close button, Hide for me and Clear have the focus
// afterwards the way a row header does, and closing the panel from its button hands the focus to the
// badge, as Escape does.
test('overlay: close and Clear keep the focus when the panel redraws', async ({ page }) => {
  await page.goto('/#handler-hog');
  await page.waitForSelector('[data-test=trigger]');
  await settle(page);
  // A mouse press moves the focus to what was pressed, here the trigger button. The page here cancels
  // that, so a click on the trigger brings a report in while the focus stays in the panel.
  await page.evaluate(() => document.addEventListener('mousedown', (e) => e.preventDefault()));
  const trigger = page.locator('[data-test=trigger]');
  await trigger.click();
  await lastReport(page);

  const badge = page.locator('#react-inp-blame .badge');
  const panel = page.locator('#react-inp-blame .panel');
  const rows = panel.locator('.row');
  const close = panel.locator('.x');
  const clear = panel.locator('.clear');
  await badge.press('Enter');
  await expect(panel).toBeVisible();
  await expect(rows).toHaveCount(1);

  // The badge comes after the panel, so Shift+Tab from it lands on Clear, the panel's last control.
  await page.keyboard.press('Shift+Tab');
  await expect(clear).toBeFocused();
  await trigger.click();
  await expect(rows).toHaveCount(2);
  await expect(clear).toBeFocused();

  // Clear empties the list and redraws the panel, and the button just pressed keeps the focus.
  await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(0);
  await expect(clear).toBeFocused();

  // Hide for me is the control before Clear, and keeps the focus through a redraw the same way.
  const hide = panel.locator('.hide');
  await page.keyboard.press('Shift+Tab');
  await expect(hide).toBeFocused();
  await trigger.click();
  await expect(rows).toHaveCount(1);
  await expect(hide).toBeFocused();

  // With one row, Shift+Tab reaches its header before the close button.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();
  await trigger.click();
  await expect(rows).toHaveCount(2);
  await expect(close).toBeFocused();

  // Enter held on the close button. The first keydown closes the panel and moves the focus to the
  // badge, so the three repeats land on the badge, and a badge that clicked on each of them would
  // leave the panel open.
  for (let i = 0; i < 4; i++) await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await expect(panel).toBeHidden();
  await expect(badge).toBeFocused();

  // Held on the badge, Enter opens the panel once too.
  for (let i = 0; i < 4; i++) await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await expect(panel).toBeVisible();
  await expect(badge).toBeFocused();
});
