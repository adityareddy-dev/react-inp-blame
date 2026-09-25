import { expect, test } from '@playwright/test';
import { blamedRows, counter, hookState, open, showPanel } from './page';

// fixtures/vite-react-ts on Vite 7 and React 18, whose react-dom connects to the DevTools hook as it
// loads, with every dependency sent to one vendor chunk. In a build the page's install script imports
// the library; if the library sat in the vendor chunk beside react-dom, react-dom would run first and
// nothing would be blamed. The counter re-renders SlowList's 400 rows, so a click on it is slow.
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

    expect(problems).toEqual([]);
  } finally {
    // Read last, so a reload any time during the test is counted. More than one means Vite reloaded the page.
    const count = loads();
    await test.info().attach('page loads', { body: String(count), contentType: 'text/plain' });
    console.log(`${test.info().project.name}: ${count} page load${count === 1 ? '' : 's'}`);
  }
});
