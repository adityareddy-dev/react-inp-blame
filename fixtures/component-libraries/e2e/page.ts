import type { Page } from '@playwright/test';
import type { Api, InteractionReport } from 'react-inp-blame';

declare global {
  interface Window {
    /** The fixture installs with `debugGlobal: true`, which is how these specs read the library. */
    __REACT_INP_BLAME__: Api;
  }
}

/**
 * Opens the app and starts collecting what would mean something went wrong: anything the page throws, and
 * any warning or error the library logs.
 */
export async function open(page: Page): Promise<string[]> {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.text().includes('[react-inp-blame]') && message.type() !== 'log') problems.push(`${message.type()}: ${message.text()}`);
  });
  await page.goto('/');
  await page.waitForFunction(() => window.__REACT_INP_BLAME__ !== undefined);
  // Nothing from start-up in the next interaction.
  await page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 2000 })));
  await page.evaluate(() => window.__REACT_INP_BLAME__.clear());
  return problems;
}

/** Waits for a published report of a slow interaction and returns it, the newest one. */
export async function slowReport(page: Page): Promise<InteractionReport> {
  const handle = await page.waitForFunction(() => {
    const last = window.__REACT_INP_BLAME__.last();
    return last && last.duration >= 100 ? last : null;
  });
  return (await handle.jsonValue()) as InteractionReport;
}

/**
 * Clicks with the mouse on the middle of what `selector` finds, as a person would: the browser decides
 * which element is under the pointer. Playwright's own click refuses an SVG `<path>`.
 */
export async function clickOn(page: Page, selector: string): Promise<void> {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`${selector} is not on the screen`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
