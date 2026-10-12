import { expect, test, type Page } from '@playwright/test';
import type { HookInfo, InteractionReport, Stats } from 'react-inp-blame';

const prod = process.env.INP_MODE === 'prod';

// React DevTools (the extension, the standalone app and react-devtools-inline share one installHook)
// and the Fast Refresh runtime each install or wrap window.__REACT_DEVTOOLS_GLOBAL_HOOK__. On
// devtools-hook.html each loads before or after the library, and three things are checked: React's
// commits still reach the library, stats() names the mode, and the tool itself still hears React,
// shown by its own record of mounted roots following the app as it mounts and unmounts.

/** Loads the page with the tools in `order`, clicks the cascading-effect button, and returns stats(), the hook as the library sees it, and the click's report once its later render has joined. */
async function clickThrough(page: Page, order: string): Promise<{ stats: Stats; hook: HookInfo; report: InteractionReport }> {
  await page.goto(`/devtools-hook.html?order=${order}`);
  await page.waitForSelector('[data-test=trigger]');
  await page.click('[data-test=trigger]');
  await page.waitForFunction(() => (window.__REACT_INP_BLAME__.last()?.followUps.length ?? 0) > 0, null, { timeout: 8_000 });
  return page.evaluate(() => {
    const api = window.__REACT_INP_BLAME__;
    return { stats: api.stats(), hook: api.debug.hook(), report: api.last()! };
  });
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
const refreshRoots = (page: Page): Promise<number> => page.evaluate(() => window.__refreshRuntime!._getMountedRootCount());

const unmount = (page: Page): Promise<void> => page.evaluate(() => window.__unmountApp!());

test.describe('React DevTools', () => {
  test('loaded first: the library chains onto its hook, and DevTools still hears every commit', async ({ page }) => {
    const { stats, hook, report } = await clickThrough(page, 'devtools,library');
    expect(stats.mode).toBe('chained');
    expect(hook.renderers.map((r) => r.rendererPackageName)).toEqual(['react-dom']);
    expect(hook.devtoolsLockedOut).toBe(false);
    expectLaterRender(report);

    expect(await devtoolsRoots(page)).toBe(1);
    await unmount(page);
    expect(await devtoolsRoots(page)).toBe(0);
  });

  test('loaded after the library: it finds a hook already there and installs nothing, which the library cannot see', async ({ page }) => {
    const { stats, hook, report } = await clickThrough(page, 'library,devtools');
    expect(stats.mode).toBe('shim');
    expectLaterRender(report);

    // installHook returned as soon as it saw the global: the hook is still the library's, with no
    // DevTools record of roots behind it, so DevTools never hears from this React.
    const global = await page.evaluate(() => {
      const current = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
      return { library: current.reactInpBlame === true, devtools: typeof current.getFiberRoots === 'function' };
    });
    expect(global).toEqual({ library: true, devtools: false });
    // Nothing replaced the global, so there was nothing for the flag to notice.
    expect(hook.devtoolsLockedOut).toBe(false);
  });
});

test.describe('Fast Refresh', () => {
  test.skip(prod, 'the Fast Refresh runtime throws in a production bundle');

  test('loaded first: the library chains onto its stub, and Fast Refresh still sees the root mount and unmount', async ({ page }) => {
    const { stats, hook, report } = await clickThrough(page, 'refresh,library');
    expect(stats.mode).toBe('chained');
    expect(hook.renderers.map((r) => r.rendererPackageName)).toEqual(['react-dom']);
    expectLaterRender(report);

    expect(await refreshRoots(page)).toBe(1);
    await unmount(page);
    expect(await refreshRoots(page)).toBe(0);
  });

  test("loaded after the library: it wraps the library's hook, and both keep hearing every commit", async ({ page }) => {
    const { stats, hook, report } = await clickThrough(page, 'library,refresh');
    expect(stats.mode).toBe('shim');
    expect(hook.devtoolsLockedOut).toBe(false);
    expectLaterRender(report);

    expect(await refreshRoots(page)).toBe(1);
    await unmount(page);
    expect(await refreshRoots(page)).toBe(0);
  });
});

test('react-dom loaded before the library: stats(), the report, the badge and the panel say React is not being read', async ({ page }) => {
  await page.goto('/devtools-hook.html?order=react,library&badge');
  await page.waitForSelector('[data-test=trigger]');
  // The library cannot see the click's renders here, so the click is made slow by a listener of the page's
  // own, which is what gets it reported.
  await page.evaluate(() =>
    document.querySelector('[data-test=trigger]')!.addEventListener('click', () => {
      const end = performance.now() + 150;
      while (performance.now() < end) {
        // busy
      }
    }),
  );
  await page.click('[data-test=trigger]');
  const handle = await page.waitForFunction(() => window.__REACT_INP_BLAME__.last(), null, { timeout: 8_000 });
  const report = (await handle.jsonValue()) as InteractionReport;
  expect(await page.evaluate(() => window.__REACT_INP_BLAME__.stats().react)).toBe('installed-late');
  expect(report.reactStatus).toBe('installed-late');
  expect(report.commits).toEqual([]);
  // Nothing React did was seen, so the 150 ms is put on neither a handler nor a render: the setup is the cause.
  expect(report.explanation.blame).toMatchObject({ kind: 'none', confidence: 'inferred' });
  expect(report.explanation.cause).not.toMatch(/didn't render anything/);
  expect(report.explanation.notes.join(' ')).toContain('install() ran after react-dom loaded');
  const badge = page.locator('#react-inp-blame .badge');
  await expect(badge).toHaveAttribute('data-status', 'installed-late');
  await badge.click();
  await expect(page.locator('#react-inp-blame .panel .status')).toContainText('install() ran after react-dom loaded');
});

test('react-dom loaded before the library: the badge says so once the check after load finds React, before any click', async ({ page }) => {
  // React renders half a second after the badge is drawn, which says nothing is wrong then.
  await page.goto('/devtools-hook.html?order=react,library&badge&renderAfter=500');
  const badge = page.locator('#react-inp-blame .badge');
  await expect(badge).toHaveAttribute('data-status', 'ok');
  await page.waitForSelector('[data-test=trigger]');
  // The check runs 3 s after install; nothing is clicked.
  await expect(badge).toHaveAttribute('data-status', 'installed-late', { timeout: 6_000 });
  await expect(badge.locator('.mark')).toHaveCount(1);
});

test('the badge says nothing is wrong where React is read', async ({ page }) => {
  await page.goto('/devtools-hook.html?order=library&badge');
  await page.waitForSelector('[data-test=trigger]');
  await page.click('[data-test=trigger]');
  await page.waitForFunction(() => window.__REACT_INP_BLAME__.last(), null, { timeout: 8_000 });
  expect(await page.evaluate(() => window.__REACT_INP_BLAME__.stats().react)).toBe('reading');
  await expect(page.locator('#react-inp-blame .badge')).toHaveAttribute('data-status', /^(ok|no-frames)$/);
  await page.locator('#react-inp-blame .badge').click();
  await expect(page.locator('#react-inp-blame .panel .status.warn')).toHaveCount(0);
});


// The spike uses an isolated developer-test profile in installed Chrome, never a personal profile.
if (process.env.INP66_CHROME === '1') test.use({ channel: 'chrome' });

test.describe('INP-66 real unmount spike', () => {
  for (const kind of ['layout', 'passive', 'control', 'survivor', 'passive-first', 'passive-second']) {
    test(`captures real ${kind} cleanup and hook evidence without equating counts to time`, async ({ page, browser }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`/devtools-hook.html?order=library&inp66&cleanup=${kind}`);
      await expect.poll(() => page.evaluate(() => Boolean((window as any).__inp66Probe)), { timeout: 5_000 }).toBe(true);
      await page.locator('[data-test=probe-delete]').click();
      await page.waitForFunction(() => (window as any).__inp66Probe.events.some((event: any) => event.kind === 'fixture_cleanup_end' && event.phase === 'passive' && event.component === 'SecondCleanup'));
      await expect(page.locator('[data-test=surviving-sibling]')).toHaveText('1');
      const data = await page.evaluate(() => (window as any).__inp66Probe.snapshot());
      const events = data.events as Array<{ sequence: number; kind: string; at: number; [key: string]: any }>;
      const cleanupDurations = ['layout', 'passive'].map((phase) => {
        const start = events.find((event) => event.kind === 'fixture_cleanup_start' && event.phase === phase)!;
        const end = events.find((event) => event.kind === 'fixture_cleanup_end' && event.phase === phase)!;
        expect(start.component).toBe('NamedCleanup');
        expect(end.component).toBe('NamedCleanup');
        expect(end.at).toBeGreaterThanOrEqual(start.at);
        if (kind === phase) expect(end.at - start.at).toBeGreaterThanOrEqual(39);
        return { phase, measuredMs: end.at - start.at, requestedMs: start.requestedMs };
      });
      const secondStart = events.find((event) => event.kind === 'fixture_cleanup_start' && event.component === 'SecondCleanup')!;
      const secondEnd = events.find((event) => event.kind === 'fixture_cleanup_end' && event.component === 'SecondCleanup')!;
      cleanupDurations.push({ phase: 'passive-second', measuredMs: secondEnd.at - secondStart.at, requestedMs: secondStart.requestedMs });
      if (kind === 'passive-first') {
        expect(cleanupDurations.find((entry) => entry.phase === 'passive')!.measuredMs).toBeGreaterThanOrEqual(39);
        expect(secondStart.requestedMs).toBe(0);
      }
      if (kind === 'passive-second') {
        expect(secondEnd.at - secondStart.at).toBeGreaterThanOrEqual(39);
        expect(cleanupDurations.find((entry) => entry.phase === 'passive')!.requestedMs).toBe(0);
      }
      if (kind === 'survivor') {
        const start = events.find((event) => event.kind === 'fixture_render_start' && event.requestedMs === 40)!;
        const end = events.find((event) => event.kind === 'fixture_render_end' && event.sequence > start.sequence)!;
        expect(end.at - start.at).toBeGreaterThanOrEqual(39);
        expect(cleanupDurations.every((entry) => entry.requestedMs === 0)).toBe(true);
      }
      // Availability, names and ordering are recorded observations, never a forced positive feasibility result.
      const unmounts = data.hookOnly.filter((event: any) => event.kind === 'unmount_hook');
      const commits = data.hookOnly.filter((event: any) => event.kind === 'commit_hook');
      expect(commits.length).toBeGreaterThanOrEqual(2);
      expect(unmounts.find((event: any) => event.name === 'NamedCleanup')?.owners).toContain('DeletionOwner');
      expect(unmounts.find((event: any) => event.name === 'SecondCleanup')?.owners).toContain('DeletionOwner');
      expect(data.hookOnly.every((event: any) => !event.kind.startsWith('fixture_'))).toBe(true);
      expect(data.overflow).toBe(false);
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
      expect(errors).toEqual([]);
      await testInfo.attach(`inp66-${kind}-${prod ? 'prod' : 'dev'}`, {
        body: Buffer.from(JSON.stringify({ ...data, mode: prod ? 'prod' : 'dev', browserVersion: browser.version(),
          cleanupDurations, unmountCount: unmounts.length, commitCount: commits.length,
          measurementBoundary: 'Cleanup markers are fixture ground truth, not generic hook timing evidence.' }, null, 2)),
        contentType: 'application/json',
      });
    });
  }
});
