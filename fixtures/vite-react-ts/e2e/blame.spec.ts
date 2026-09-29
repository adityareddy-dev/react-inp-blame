import { expect, test } from '@playwright/test';
import { blamedRows, counter, hookState, open, showPanel } from './page';

// The app as a user has it: create-vite's react-ts template with the vite.config.ts from docs/install.md, and
// react-inp-blame installed from the packed tarball. The counter re-renders SlowList's 400 rows, so a click
// on it is slow and the time is in rendering.
test('a click is blamed on SlowList', async ({ page }) => {
  const dev = test.info().project.name === 'dev';
  const { problems, loads } = await open(page);
  try {
    const state = await hookState(page);
    if (dev) {
      // plugin-react's Fast Refresh preamble runs ahead of the library's install script on the dev
      // server, so its refresh stub is the hook: it keeps no renderers and has no onPostCommitFiberRoot
      // of its own, which chain() adds. The stub keeps nothing, so the library reads react-dom's commits
      // only if its inject wrapper was in place before react-dom registered (hook.ts, onCommit and
      // chain(); docs/interaction-attribution-design.md). The blame below is the check on that order.
      expect(state).toEqual({ preamble: true, libraryShim: false, reactDevtools: false, keptRenderers: 0, postCommit: true });
    } else {
      // A build has no preamble, so the install script runs first and the hook is the library's own.
      expect(state).toMatchObject({ preamble: false, libraryShim: true });
    }

    await counter(page, 0).click();
    await expect(counter(page, 1)).toBeVisible();
    await expect(page.locator('#react-inp-blame .badge')).toHaveAttribute('data-rating', /needs-improvement|poor/);

    await showPanel(page);
    const rows = blamedRows(page, 'SlowList');
    await expect(rows).toHaveCount(1);
    const blame = await rows.locator('.blame:not(.later)').textContent();
    const rendered = Number(/Row ×(\d+)/.exec(blame ?? '')?.[1]);
    expect(rendered, `the blame line reads "${blame}"`).toBeGreaterThanOrEqual(400);

    // Which build measured it, read through the page, since the config has no debugGlobal. The template's
    // main.tsx wraps the app in StrictMode, so in development the render blame says half of it is the second pass.
    const badge = page.locator('#react-inp-blame .badge');
    const devnote = page.locator('#react-inp-blame .panel .devnote');
    await rows.locator('.toggle').click();
    const strict = rows.locator('.note', { hasText: 'StrictMode renders each component twice in development' });
    if (dev) {
      await expect(badge.locator('.dev')).toHaveText('dev');
      await expect(devnote).toBeVisible();
      await expect(strict).toHaveCount(1);
    } else {
      await expect(badge.locator('.dev')).toHaveCount(0);
      await expect(devnote).toHaveCount(0);
      await expect(strict).toHaveCount(0);
    }

    expect(problems).toEqual([]);
  } finally {
    // Read last, so a reload any time during the test is counted. More than one means Vite reloaded the page.
    const count = loads();
    await test.info().attach('page loads', { body: String(count), contentType: 'text/plain' });
    console.log(`${test.info().project.name}: ${count} page load${count === 1 ? '' : 's'}`);
  }
});
