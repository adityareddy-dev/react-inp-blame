import { expect, test, type Page } from '@playwright/test';
import type { InteractionReport } from 'react-inp-blame';
import { clearReports, settle } from './page';

const prod = process.env.INP_MODE === 'prod';

// src/Ambient.tsx: a quick Save button, and beside it 400 components that re-render when the window
// crosses 600 px (through a media query, and through `resize`), when the pointer enters a card and when
// a list scrolls. Each spec clicks Save, causes one of those renders 400 ms later, well inside the
// 1.5 s inputWindow, and waits past the window. Until 0.7.0 the render joined the click as its later
// render, and a quick click was published as a slow one.

async function clickSaveThen(page: Page, cause: () => Promise<void>, rendered: string): Promise<InteractionReport[]> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#ambient');
  await page.waitForSelector('[data-test=trigger]');
  await settle(page);
  await clearReports(page);
  await page.click('[data-test=trigger]');
  await expect(page.locator('[data-test=trigger]')).toHaveText('Save (1)');
  await page.waitForTimeout(400);
  await cause();
  // The render happened: this is what a report would have joined.
  await page.waitForSelector(rendered);
  await page.waitForTimeout(2_000);
  return page.evaluate(() => window.__REACT_INP_BLAME__.reports());
}

/** Every component a report says was rendered, in its commits and its later renders. */
const renderedIn = (r: InteractionReport): string[] => [...r.commits, ...r.followUps].flatMap((c) => c.components.map((x) => x.name));

function expectNoneJoined(reports: InteractionReport[]): void {
  for (const r of reports) {
    expect(renderedIn(r), r.verdict).not.toContain('Cell');
    expect(r.followUps, r.verdict).toEqual([]);
  }
}

test('a render at a breakpoint, from a media query and from resize, is not the last click\'s', async ({ page }) => {
  const reports = await clickSaveThen(page, () => page.setViewportSize({ width: 400, height: 900 }), '[data-test=breakpoint][data-label=narrow] >> nth=0');
  await expect(page.locator('[data-test=width]')).toHaveAttribute('data-label', 'narrow');
  expectNoneJoined(reports);
});

/**
 * Whether this page's React says whose a hover's or a scroll's render is. React 17 renders inside the
 * event, in any build. React 18 and 19 render it in a task of their own, where only React 19's development
 * and profiling builds say, by the priority they commit it with (README, Known limits).
 */
async function tellsHovers(page: Page): Promise<boolean> {
  await page.goto('/#ambient');
  await page.waitForSelector('[data-test=trigger]');
  const version = await page.evaluate(() => window.__REACT_INP_BLAME__.debug.hook().renderers[0]?.version ?? '');
  const major = Number(version.split('.')[0]);
  return major === 17 || (major >= 19 && !prod);
}

test("a hover card's render is not the last click's", async ({ page }) => {
  test.skip(!(await tellsHovers(page)), 'React 18, and React 19 in production, cannot tell a hover\'s render from an effect\'s');
  const reports = await clickSaveThen(page, () => page.hover('[data-test=hover-card]'), '[data-test=hover]');
  expectNoneJoined(reports);
});

test("a scrolled list's render is not the last click's", async ({ page }) => {
  test.skip(!(await tellsHovers(page)), 'React 18, and React 19 in production, cannot tell a scroll\'s render from an effect\'s');
  const reports = await clickSaveThen(
    page,
    async () => {
      await page.hover('[data-test=scroll-list]');
      await page.mouse.wheel(0, 300);
    },
    '[data-test=scroll]',
  );
  expectNoneJoined(reports);
});
