import type { Locator, Page } from '@playwright/test'

declare global {
  interface Window {
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: { reactInpBlame?: true }
  }
}

const BADGE = '#react-inp-blame .badge'
const PANEL = '#react-inp-blame .panel'

/**
 * Opens the app, and starts collecting what would mean something went wrong:
 * anything the page throws or logs as an error, and any warning the library logs.
 */
export async function open(page: Page): Promise<string[]> {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    const type = message.type()
    if (type === 'error' || (type === 'warning' && message.text().startsWith('[react-inp-blame]'))) problems.push(`${type}: ${message.text()}`)
  })
  await page.goto('/')
  await page.locator(BADGE).waitFor({ timeout: 30_000 })
  // Nothing left to do, so start-up work is not part of the first interaction.
  await page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 2000 })))
  return problems
}

/** The scripts the page loaded, by file name. */
export function scripts(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.scripts, (s) => s.src.split('/').pop() ?? '').filter(Boolean))
}

/** Whether React's DevTools hook is the library's own, which it is only when the install ran before react-dom. */
export function libraryHook(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.reactInpBlame === true)
}

/** The counter button. The name is matched whole because a panel row is a button too. */
export function counter(page: Page, count: number): Locator {
  return page.getByRole('button', { name: `Count is ${count}`, exact: true })
}

/** Opens the panel unless it is open already. */
export async function showPanel(page: Page): Promise<void> {
  const panel = page.locator(PANEL)
  if (await panel.isHidden()) await page.locator(BADGE).click()
  await panel.waitFor({ state: 'visible' })
}

/** The panel's rows whose blame names `name`, leaving out a line for a render after the paint. */
export function blamedRows(page: Page, name: string): Locator {
  return page.locator(`${PANEL} .row`).filter({ has: page.locator('.blame:not(.later) > b', { hasText: new RegExp(`^${name}$`) }) })
}
