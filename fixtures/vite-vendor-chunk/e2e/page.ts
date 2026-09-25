import type { Locator, Page } from '@playwright/test';

declare global {
  interface Window {
    /** Set by @vitejs/plugin-react's Fast Refresh preamble, which only the dev server adds. */
    $RefreshSig$?: unknown;
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
      reactInpBlame?: true;
      getFiberRoots?: unknown;
      renderers?: unknown;
      onPostCommitFiberRoot?: unknown;
    };
    /** Set by fast-refresh.spec.ts before an edit, and gone if the page reloaded. */
    __notReloaded?: boolean;
  }
}

const BADGE = '#react-inp-blame .badge';
const PANEL = '#react-inp-blame .panel';

/** Waits until the page has nothing left to do, so that its start-up work is not part of the next interaction. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 2000 })));
}

/**
 * Opens the app with the badge asked for, and starts collecting what would mean something went wrong:
 * anything the page throws or logs as an error, and any warning the library logs. `loads` counts the
 * page's load events, so a spec can say whether the dev server reloaded the page on the first visit,
 * which it does when it finds a dependency its first optimize missed.
 */
export async function open(page: Page): Promise<{ problems: string[]; loads: () => number }> {
  const problems: string[] = [];
  let loads = 0;
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    const type = message.type();
    if (type === 'error' || (type === 'warning' && message.text().startsWith('[react-inp-blame]'))) problems.push(`${type}: ${message.text()}`);
  });
  page.on('load', () => loads++);
  await page.goto('/?inp-blame');
  // A dev server that has just started optimizes its dependencies on the first visit, which can take a while.
  for (let attempt = 1; ; attempt++) {
    await page.locator(BADGE).waitFor({ timeout: 30_000 });
    try {
      await settle(page);
      break;
    } catch (error) {
      // A reload between the badge and the idle callback takes the page's context with it. The
      // reloaded page gets the same wait.
      if (attempt === 3 || !/context was destroyed|navigat/i.test(String(error))) throw error;
      await page.waitForLoadState('load');
    }
  }
  return { problems, loads: () => loads };
}

/**
 * The template's counter button. The name is matched whole because a panel row is a button too, and
 * its name quotes the label of the button that was clicked.
 */
export function counter(page: Page, count: number): Locator {
  return page.getByRole('button', { name: `Count is ${count}`, exact: true });
}

/** Opens the panel unless it is open already. */
export async function showPanel(page: Page): Promise<void> {
  const panel = page.locator(PANEL);
  if (await panel.isHidden()) await page.locator(BADGE).click();
  await panel.waitFor({ state: 'visible' });
}

/**
 * The panel's rows whose blame names `name`. The `<b>` is `explanation.blame.name` as the overlay
 * renders it; a line for a render after the paint has the class `later` and is left out.
 */
export function blamedRows(page: Page, name: string): Locator {
  return page
    .locator(`${PANEL} .row`)
    .filter({ has: page.locator('.blame:not(.later) > b', { hasText: new RegExp(`^${name}$`) }) });
}

/**
 * Who owns React's DevTools hook, read from the hook itself: the README's config has no debugGlobal,
 * so the library's own view of it is not on the page.
 */
export function hookState(page: Page) {
  return page.evaluate(() => {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    return {
      preamble: typeof window.$RefreshSig$ === 'function',
      libraryShim: hook?.reactInpBlame === true,
      reactDevtools: typeof hook?.getFiberRoots === 'function',
      keptRenderers: hook?.renderers instanceof Map ? hook.renderers.size : null,
      postCommit: typeof hook?.onPostCommitFiberRoot === 'function',
    };
  });
}
