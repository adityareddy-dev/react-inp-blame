import { expect, test, type Page } from '@playwright/test';
import type { HookInfo, InpEstimate, InteractionReport, Stats } from 'react-inp-blame';

const prod = process.env.INP_MODE === 'prod';
const run = prod ? 'prod' : 'dev';

// withInpBlame adds react-inp-blame/next-client to instrumentationClientInject, and Next.js imports that
// module before hydration; below 16.3, CI's next-older job has instrumentation-client.ts re-export it.
// Whether that is early enough is shown by what follows: react-dom registered with the library's hook,
// and the page's first keystroke is reported with React's commits. next.config.ts asks for the debug
// global, which is how these tests read the library.

/**
 * Waits until app/last-interaction.tsx has subscribed to reports, which its effect does once hydration
 * has committed. The hydration commit itself is nobody's interaction: the library joins a hydration to an
 * input only when React hydrated inside that input's dispatch, so a key pressed while React is still
 * hydrating is reported without it.
 */
async function subscribed(page: Page): Promise<void> {
  await page.waitForSelector('body[data-subscribed]', { state: 'attached' });
}

/** Waits for a report of an interaction other than `seen`, and returns it. */
async function reportAfter(page: Page, seen: number | null): Promise<InteractionReport> {
  const handle = await page.waitForFunction(
    (id) => {
      const last = window.__REACT_INP_BLAME__.last();
      return last && last.interactionId !== id ? last : null;
    },
    seen,
    { timeout: 8_000 },
  );
  const report = await handle.jsonValue();
  // waitForFunction only resolves on a truthy value, which its type does not say.
  if (!report) throw new Error('waited for a report and got none');
  return report;
}

const placeOf = (r: InteractionReport) => ({ navigationURL: r.navigationURL, navigationType: r.navigationType, startedNavigation: r.startedNavigation });

test('the injected module installs before react-dom, and the first keystroke is attributed', async ({ page }) => {
  await page.goto('/');
  await subscribed(page);
  const installed: { stats: Stats; hook: HookInfo } | null = await page.evaluate(() => {
    const api = window.__REACT_INP_BLAME__;
    return api ? { stats: api.stats(), hook: api.debug.hook() } : null;
  });
  expect(installed, 'library not installed: the injected module did not run').toBeTruthy();
  // The library records what react-dom hands inject(), on its own hook and through one it chains
  // onto, so react-dom showing up here means install() ran before react-dom registered.
  expect(installed!.hook.renderers.map((r) => r.rendererPackageName), 'react-dom registered before install() ran').toContain('react-dom');

  await page.locator('[data-test=trigger]').press('a');
  const r = await reportAfter(page, null);
  await test.info().attach(`${run}: verdict`, { body: r.verdict, contentType: 'text/plain' });
  expect(await page.evaluate(() => window.__REACT_INP_BLAME__.reports().length), 'the keystroke was not the page’s first report').toBe(1);
  const all = [...r.commits, ...r.followUps];
  expect(all.length, 'no React commit recorded for the interaction').toBeGreaterThanOrEqual(1);
  const c = all[0];
  expect(c.rendered).toBeGreaterThanOrEqual(600);
  // Names must survive the production minifier: the displayName loader withInpBlame adds stamps them
  // as string literals. Without it the prod report reads "n".
  expect(c.hotPath.join(' > '), 'the displayName loader did not stamp the components').toContain('Sidebar');
  expect(c.components[0].name).toBe('NavItem');
  if (!prod) expect(c.hasDurations).toBe(true);
});

test('application code hears every report through onInteraction, the same as the debug global', async ({ page }) => {
  await page.goto('/');
  await subscribed(page);
  let seen: number | null = null;
  for (const key of ['a', 'b']) {
    await page.locator('[data-test=trigger]').press(key);
    const { interactionId } = await reportAfter(page, seen);
    // app/last-interaction.tsx writes the id of each report it hears to <body>.
    await expect.poll(() => page.evaluate(() => document.body.dataset.lastInteraction), `the application did not hear report ${interactionId}`).toBe(String(interactionId));
    seen = interactionId;
  }
});

test('a link click that starts a navigation is named with it, and the page it opens starts its INP over', async ({ page }) => {
  await page.goto('/');
  await subscribed(page);
  const home = page.url();
  const second = new URL('/second', home).href;
  await page.click('[data-test=navigate]');
  // Rendered on the client, so it is in the document only once React has committed it.
  await page.waitForSelector('[data-test=slow]');

  const link = await reportAfter(page, null);
  await test.info().attach(`${run}: link verdict`, { body: link.verdict, contentType: 'text/plain' });
  expect(placeOf(link)).toEqual({ navigationURL: home, navigationType: 'navigate', startedNavigation: { url: second, type: 'push' } });
  // Named after the page that wrote <Link>, not next/link's LinkComponent that renders the <a> for it.
  expect(link.target?.component, link.target?.owners.join(' < ')).toBe('Page');
  // The click began before the navigation it started, so it is not part of the INP of the page it opened.
  const opened: InpEstimate | null = await page.evaluate(() => window.__REACT_INP_BLAME__.inp());
  expect(opened).toBeNull();

  await page.click('[data-test=slow]');
  const slow = await reportAfter(page, link.interactionId);
  expect(placeOf(slow)).toEqual({ navigationURL: second, navigationType: 'soft-navigation', startedNavigation: null });
  const inp: InpEstimate | null = await page.evaluate(() => window.__REACT_INP_BLAME__.inp());
  expect(inp?.interactionId).toBe(slow.interactionId);
});
