import { expect, test, type Page } from '@playwright/test';
import type { InteractionReport, Stats } from 'react-inp-blame';

const prod = process.env.INP_MODE === 'prod';

// React DevTools (the extension, the standalone app and react-devtools-inline share one installHook)
// and the Fast Refresh runtime each install or wrap window.__REACT_DEVTOOLS_GLOBAL_HOOK__. On
// devtools-hook.html each loads before or after the library, and three things are checked: React's
// commits still reach the library, stats() names the mode, and the tool itself still hears React,
// shown by its own record of mounted roots following the app as it mounts and unmounts.

/** Loads the page with the tools in `order`, clicks the cascading-effect button, and returns stats() with the click's report once its later render has joined. */
async function clickThrough(page: Page, order: string): Promise<{ stats: Stats; report: InteractionReport }> {
  await page.goto(`/devtools-hook.html?order=${order}`);
  await page.waitForSelector('[data-test=trigger]');
  await page.click('[data-test=trigger]');
  await page.waitForFunction(() => ((window as any).__REACT_INP__.last()?.followUps.length ?? 0) > 0, null, { timeout: 8_000 });
  return page.evaluate(() => ({ stats: (window as any).__REACT_INP__.stats(), report: (window as any).__REACT_INP__.last() }));
}

/** The later render the click's effect set off, as the library saw it: 400 Detail rows. */
function expectLaterRender(report: InteractionReport): void {
  const later = report.followUps[0];
  expect(later.components[0].name).toBe('Detail');
  expect(later.rendered).toBeGreaterThanOrEqual(400);
  expect(later.joinedBy).toBe('exact');
}

/** Mounted roots in React DevTools' own record, which its onCommitFiberRoot keeps. */
const devtoolsRoots = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const [rendererId] = hook.renderers.keys();
    return hook.getFiberRoots(rendererId).size;
  });

/** Mounted roots in Fast Refresh's record, which its wrapper of onCommitFiberRoot keeps. */
const refreshRoots = (page: Page): Promise<number> => page.evaluate(() => (window as any).__refreshRuntime._getMountedRootCount());

const unmount = (page: Page): Promise<void> => page.evaluate(() => (window as any).__unmountApp());

test.describe('React DevTools', () => {
  test('loaded first: the library chains onto its hook, and DevTools still hears every commit', async ({ page }) => {
    const { stats, report } = await clickThrough(page, 'devtools,library');
    expect(stats.mode).toBe('chained');
    expect(stats.renderers.map((r) => r.rendererPackageName)).toEqual(['react-dom']);
    expect(stats.devtoolsLockedOut).toBe(false);
    expectLaterRender(report);

    expect(await devtoolsRoots(page)).toBe(1);
    await unmount(page);
    expect(await devtoolsRoots(page)).toBe(0);
  });

  test('loaded after the library: it finds a hook already there and installs nothing, which stats() cannot see', async ({ page }) => {
    const { stats, report } = await clickThrough(page, 'library,devtools');
    expect(stats.mode).toBe('shim');
    expectLaterRender(report);

    // installHook returned as soon as it saw the global: the hook is still the library's, with no
    // DevTools record of roots behind it, so DevTools never hears from this React.
    const hook = await page.evaluate(() => {
      const current = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
      return { library: current.reactInpBlame === true, devtools: typeof current.getFiberRoots === 'function' };
    });
    expect(hook).toEqual({ library: true, devtools: false });
    // Nothing replaced the global, so there was nothing for the flag to notice.
    expect(stats.devtoolsLockedOut).toBe(false);
  });
});

test.describe('Fast Refresh', () => {
  test.skip(prod, 'the Fast Refresh runtime throws in a production bundle');

  test('loaded first: the library chains onto its stub, and Fast Refresh still sees the root mount and unmount', async ({ page }) => {
    const { stats, report } = await clickThrough(page, 'refresh,library');
    expect(stats.mode).toBe('chained');
    expect(stats.renderers.map((r) => r.rendererPackageName)).toEqual(['react-dom']);
    expectLaterRender(report);

    expect(await refreshRoots(page)).toBe(1);
    await unmount(page);
    expect(await refreshRoots(page)).toBe(0);
  });

  test("loaded after the library: it wraps the library's hook, and both keep hearing every commit", async ({ page }) => {
    const { stats, report } = await clickThrough(page, 'library,refresh');
    expect(stats.mode).toBe('shim');
    expect(stats.devtoolsLockedOut).toBe(false);
    expectLaterRender(report);

    expect(await refreshRoots(page)).toBe(1);
    await unmount(page);
    expect(await refreshRoots(page)).toBe(0);
  });
});
