import { expect, test, type Page } from '@playwright/test';
import type { InteractionReport } from 'react-inp-blame';

const run = process.env.INP_MODE === 'prod' ? 'prod' : 'dev';

// app/hydration streams a Suspense boundary whose client component costs about 168 ms to hydrate.
// React schedules the hydration of a boundary the server revealed late on a low-priority task, so a
// click can land on the boundary's button while it is still server-rendered HTML. React 18 and 19
// then hydrate that boundary synchronously inside the click's own dispatch, which is the wait this
// library reports as its own part of the working time.

/** Longest the panel's HTML may take to arrive: the server holds it 300 ms, and a cold dev compile adds to that. */
const PANEL_TIMEOUT = 60_000;
/**
 * How long the page is held busy around the click. React's hydration of the boundary is a posted task
 * and waits behind it; a real input event is dispatched ahead of one, so the click still lands, and it
 * lands on a boundary that is still waiting. Deterministic where waiting for the right moment would be
 * a race against the machine.
 *
 * The hold plus the hydration is what the library's input window has to cover: about 350 ms here plus
 * 168 ms of hydrating, doubled by React's development double render, which is a third of the 1500 ms
 * default. The spec asserts that margin below rather than trusting the arithmetic.
 */
const HOLD_MS = 350;
/** The library's default inputWindow. A commit further than this from its input is not joined to it. */
const INPUT_WINDOW_MS = 1_500;

declare global {
  interface Window {
    /** Installed by the spec, below: keeps the main thread busy for `ms`, starting on the next task. */
    __holdMainThread(ms: number): void;
    /** Set by Panel's mount effect, so it cannot be there before React has hydrated the boundary. */
    __panelHydrated?: number;
  }
}

/** Long enough for the reports of every click before this one to have been delivered. */
const SETTLE_MS = 1_000;

/**
 * Clicks once every earlier click's report has arrived, and returns the report for this click. A
 * report reaches the page a task or two after its interaction ends, so a test that clicks to get the
 * page into a state and then clicks to measure can otherwise read the first click's report as the
 * second's, commits and all.
 */
async function clickAndReport(page: Page, selector: string): Promise<InteractionReport> {
  await page.waitForTimeout(SETTLE_MS);
  const seen = await page.evaluate(() => window.__REACT_INP_BLAME__.last()?.interactionId ?? null);
  await page.evaluate(() => window.__REACT_INP_BLAME__.clear());
  await page.click(selector);
  return reportAfter(page, seen);
}

/** Waits for a report of an interaction other than `seen`, and returns it. */
async function reportAfter(page: Page, seen: number | null): Promise<InteractionReport> {
  const handle = await page.waitForFunction(
    (id) => {
      const last = window.__REACT_INP_BLAME__.last();
      return last && last.interactionId !== id ? last : null;
    },
    seen,
    { timeout: 15_000 },
  );
  const report = await handle.jsonValue();
  if (!report) throw new Error('waited for a report and got none');
  return report;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__holdMainThread = (ms) => {
      setTimeout(() => {
        const end = performance.now() + ms;
        while (performance.now() < end) {
          // spin
        }
      }, 0);
    };
  });
});

/**
 * Clicks an element without running any script in the page first, so the click can be sent while the
 * main thread is held. Playwright's own click checks the element is actionable, which needs the thread.
 */
async function clickBlind(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no box to click`);
  await page.evaluate((ms) => window.__holdMainThread(ms), HOLD_MS);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Page loads before a test gives up on its click landing ahead of React's hydration of the panel. */
const ATTEMPTS = 3;

/**
 * Loads the page, clicks `selector` blind while the panel's boundary is still server-rendered HTML, and
 * returns the click's report. The click has to land before React hydrates the boundary, and on a fast
 * machine React can get there between the panel's HTML arriving and the hold starting. The panel's mount
 * effect says when it hydrated, so a load where that was before the click tested nothing, and the page is
 * loaded again.
 */
async function clickBeforeHydration(page: Page, selector: string): Promise<InteractionReport> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    await page.goto('/hydration');
    await page.waitForSelector('[data-test=panel-button]', { timeout: PANEL_TIMEOUT });
    await clickBlind(page, selector);
    const report = await reportAfter(page, null);
    const hydratedAt = await page.evaluate(() => window.__panelHydrated ?? null);
    if (hydratedAt === null || hydratedAt >= report.start) return report;
    await test.info().attach(`${run}: load ${attempt}, React hydrated the boundary before the click`, { body: report.verdict, contentType: 'text/plain' });
  }
  throw new Error(`React hydrated the boundary before the click on all ${ATTEMPTS} loads, so nothing was tested`);
}

test('a click on a boundary that has not hydrated is blamed on the hydration it waited for', async ({ page }) => {
  const r = await clickBeforeHydration(page, '[data-test=panel-button]');
  await test.info().attach(`${run}: hydration verdict`, { body: r.verdict, contentType: 'text/plain' });

  expect(r.hydration, 'the click was not seen as landing on HTML waiting to hydrate').toBeTruthy();
  expect(r.hydration!.kind).toBe('waited');
  expect(r.hydration!.scope).toBe('boundary');
  // A boundary has no name of its own, so it is named after the client component holding it. The name
  // survives the production minifier because withInpBlame adds the displayName loader.
  expect(r.hydration!.owner).toBe('PanelSection');
  expect(r.explanation.blame.kind).toBe('hydration');

  const hydrating = r.commits.filter((c) => c.hydratedTarget != null);
  expect(hydrating.length, 'no commit of the interaction hydrated the boundary the click landed in').toBe(1);
  // The whole thing, from the click to the commit that ended its wait, against the window a commit has
  // to land inside to be joined to its input at all. Attached so a machine that drifts towards the
  // edge says so in the run rather than in a flake months later.
  const sinceInput = hydrating[0].sinceInput;
  await test.info().attach(`${run}: ms from the click to the hydrating commit`, { body: `${Math.round(sinceInput)} of ${INPUT_WINDOW_MS}`, contentType: 'text/plain' });
  expect(sinceInput, 'the hydrating commit landed too near the edge of the input window for this to be a fair test').toBeLessThan(INPUT_WINDOW_MS / 2);
  // The panel is 24 rows of 7 ms, so hydrating it is about 168 ms, or twice that under React's
  // development double render. Both bounds are far clear of that either way.
  expect(hydrating[0].rendered).toBeGreaterThanOrEqual(24);
  if (r.hydration!.ms !== null) {
    expect(r.hydration!.ms).toBeGreaterThan(50);
    expect(r.hydration!.ms).toBeLessThan(2_000);
  }
  // The hydration is part of the working time, not a fourth phase beside it: the three phases still
  // add up to the interaction.
  const phases = r.explanation.phases;
  const working = phases[1];
  expect(working.parts?.[0]?.label).toBe(r.hydration!.ms === null ? undefined : 'Hydrating');
  expect(phases.reduce((a, p) => a + p.ms, 0) + r.walkMs).toBeCloseTo(r.duration, 5);
});

test('a click beside a boundary that is still server-rendered HTML is not blamed on that boundary', async ({ page }) => {
  // The hold keeps the main thread from React until after the click has been dispatched, so this click
  // lands beside a boundary that is still waiting rather than after it hydrated.
  const r = await clickBeforeHydration(page, '[data-test=outside-button]');
  await test.info().attach(`${run}: click beside the boundary verdict`, { body: r.verdict, contentType: 'text/plain' });

  expect(r.hydration, 'a click outside the boundary was blamed on the boundary waiting to hydrate').toBeNull();
  expect(r.explanation.blame.kind).not.toBe('hydration');
  expect(r.commits.filter((c) => c.hydratedTarget != null)).toHaveLength(0);
});

test('an ordinary click on the same page, after it has hydrated, is not blamed on hydration', async ({ page }) => {
  await page.goto('/hydration');
  await page.waitForSelector('[data-test=panel-button]', { timeout: PANEL_TIMEOUT });
  // The panel's own counter moving proves React handled the click, so the boundary has hydrated. A
  // click that lands while it is still waiting and that React cannot unblock is never dispatched, so
  // this clicks until one gets through rather than assuming the first one does.
  await expect
    .poll(
      async () => {
        await page.click('[data-test=panel-button]');
        return page.locator('[data-test=panel-clicks]').innerText();
      },
      { timeout: 20_000 },
    )
    .not.toBe('0');

  // Handled by React this time, not hydrated, and slow enough to be reported at the default threshold.
  const r = await clickAndReport(page, '[data-test=panel-button]');
  await test.info().attach(`${run}: ordinary click verdict`, { body: r.verdict, contentType: 'text/plain' });

  expect(r.hydration, 'a click after hydration was still called a hydration').toBeNull();
  expect(r.explanation.blame.kind).not.toBe('hydration');
});

test('a click that renders only outside the boundary is not blamed on the hydration that boundary had long ago', async ({ page }) => {
  // The case a verdict read from the fiber tree gets wrong. React hydrated this boundary once, at
  // load; its alternate fiber goes on saying "dehydrated" until a render passes through the
  // boundary's parent, and this click deliberately never does one. It bumps a counter held outside
  // the boundary, so the only component that re-renders is the badge above it.
  await page.goto('/hydration');
  await page.waitForSelector('[data-test=badge-button]', { timeout: PANEL_TIMEOUT });
  await expect
    .poll(
      async () => {
        await page.click('[data-test=badge-button]');
        return page.locator('[data-test=badge]').innerText();
      },
      { timeout: 20_000 },
    )
    .not.toBe('0');

  const r = await clickAndReport(page, '[data-test=badge-button]');
  await test.info().attach(`${run}: outside-the-boundary click verdict`, { body: r.verdict, contentType: 'text/plain' });

  expect(r.hydration, 'a click that rendered outside the boundary was called a hydration').toBeNull();
  expect(r.commits.filter((c) => c.hydratedTarget != null), 'a commit was credited with a hydration the click never waited for').toHaveLength(0);
  expect(r.explanation.blame.kind).not.toBe('hydration');
  expect(r.commits.length, 'the click rendered nothing the report kept').toBeGreaterThan(0);
});

test('a transition fired inside a long-hydrated boundary keeps its commit, which is not a hydration', async ({ page }) => {
  // Where a commit wrongly called a hydration is not just mislabelled but lost: the hook drops a
  // hydrating commit that landed outside an input's dispatch, because that is what page startup looks
  // like. A transition renders after the dispatch returns, so this click takes exactly that path.
  await page.goto('/hydration');
  await page.waitForSelector('[data-test=transition-button]', { timeout: PANEL_TIMEOUT });
  await expect
    .poll(
      async () => {
        await page.click('[data-test=transition-button]');
        return page.locator('[data-test=panel-deferred]').innerText();
      },
      { timeout: 20_000 },
    )
    .not.toBe('0');

  const r = await clickAndReport(page, '[data-test=transition-button]');
  await test.info().attach(`${run}: transition verdict`, { body: r.verdict, contentType: 'text/plain' });

  expect(r.hydration, 'a transition inside a boundary hydrated long ago was called a hydration').toBeNull();
  // The hook's own record, which is where the commit would have been dropped. The transition renders
  // after the dispatch and often after the report has been published, so this waits for it rather than
  // reading whatever has arrived by now.
  const commits = async () => page.evaluate(() => window.__REACT_INP_BLAME__.debug.commits().map((c) => ({ rendered: c.rendered, hydrated: c.hydrated, hydratedTarget: c.hydratedTarget })));
  await expect.poll(async () => (await commits()).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const kept = await commits();
  expect(kept.some((c) => c.hydrated || c.hydratedTarget != null), 'a transition was recorded as a hydration').toBe(false);
});

// Not covered here: a boundary that has finished hydrating in a time-sliced render and not yet
// committed, which needs two boundaries hydrating in one pass and a click inside a window a few
// milliseconds wide. Driving that from a route would be a race on every machine it ran on, so it is
// pinned by a unit test in packages/core/test/fiber.test.ts instead.
