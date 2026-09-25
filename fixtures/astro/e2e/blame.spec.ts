import { expect, test } from '@playwright/test';
import { blamedRows, counter, hookState, open, showPanel } from './page';

// The app as a user has it: Astro's minimal template with @astrojs/react, the README's Astro setup, and
// react-inp-blame installed from the packed tarball. Astro writes the page itself, so nothing goes through
// the Vite plugin's script: the integration's before-hydration script is the install, and it only works
// if it runs before an island's renderer loads react-dom. The blame below is the check on that.
test('a click is blamed on SlowList, in the island it rendered in', async ({ page }) => {
  const dev = test.info().project.name === 'dev';
  const { problems, loads } = await open(page);
  try {
    const state = await hookState(page);
    // On the dev server @astrojs/react's Fast Refresh preamble runs first among the before-hydration
    // scripts and makes the hook, and the library chains onto it; a build has no such runtime, so the hook
    // is the library's own.
    expect(state).toMatchObject({ preamble: dev, libraryShim: !dev });
    // The second island has hydrated too, so the page has two React roots when the counter is clicked.
    await page.locator('body[data-idle-note]').waitFor();

    await counter(page, 0).click();
    await expect(counter(page, 1)).toBeVisible();
    await expect(page.locator('#react-inp-blame .badge')).toHaveAttribute('data-rating', /needs-improvement|poor/);

    await showPanel(page);
    const rows = blamedRows(page, 'SlowList');
    await expect(rows).toHaveCount(1);
    const blame = await rows.locator('.blame:not(.later)').textContent();
    const rendered = Number(/Row ×(\d+)/.exec(blame ?? '')?.[1]);
    expect(rendered, `the blame line reads '${blame}'`).toBeGreaterThanOrEqual(400);

    expect(problems).toEqual([]);
  } finally {
    const count = loads();
    await test.info().attach('page loads', { body: String(count), contentType: 'text/plain' });
    console.log(`${test.info().project.name}: ${count} page load${count === 1 ? '' : 's'}`);
  }
});

// The install runs as soon as the first island's element is parsed, whatever its directive, and React may
// not load for a long while after, or at all. The library must not take that for an install that came too
// late, which it says after 3 s when no react-dom has registered.
test('a page whose only island hydrates when it scrolls into view gets no warning, before or after it hydrates', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    const type = message.type();
    if (type === 'error' || (type === 'warning' && message.text().startsWith('[react-inp-blame]'))) problems.push(`${type}: ${message.text()}`);
  });
  await page.goto('/below-the-fold?inp-blame');
  // The badge mounts once install() has run, and the check comes 3 s after that, however long a cold dev
  // server took to get there.
  await page.locator('#react-inp-blame .badge').waitFor();
  const installed = await page.evaluate(() => performance.now());
  await page.waitForFunction((since) => performance.now() > since + 3500, installed, { timeout: 10_000 });
  expect(await page.locator('body[data-visible-note]').count()).toBe(0);
  expect(problems).toEqual([]);

  await page.locator('.visible-note').scrollIntoViewIfNeeded();
  await page.locator('body[data-visible-note]').waitFor();
  expect(problems).toEqual([]);
});
