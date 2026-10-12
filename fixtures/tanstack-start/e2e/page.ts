import type { Locator, Page } from '@playwright/test'
import type { Api, InteractionReport } from 'react-inp-blame'

declare global {
  interface Window {
    /** Set by the Fast Refresh preamble TanStack Start adds on the dev server. */
    $RefreshSig$?: unknown
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
      reactInpBlame?: true
      renderers?: unknown
    }
  }
}

const BADGE = '#react-inp-blame .badge'
const PANEL = '#react-inp-blame .panel'

/** Waits until the page has nothing left to do, so that its start-up work is not part of the next interaction. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 2000 })))
}

/**
 * Opens the app with the badge asked for, once it has hydrated, and starts collecting what would mean
 * something went wrong: anything the page throws or logs as an error, and any warning the library logs.
 */
export async function open(page: Page, url = '/?inp-blame'): Promise<{ problems: string[]; loads: () => number }> {
  const problems: string[] = []
  let loads = 0
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    const type = message.type()
    if (type === 'error' || (type === 'warning' && message.text().startsWith('[react-inp-blame]'))) problems.push(`${type}: ${message.text()}`)
  })
  page.on('load', () => loads++)
  await page.goto(url)
  // A dev server that has just started optimizes its dependencies on the first visit, and can reload the page.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.locator(BADGE).waitFor({ timeout: 30_000 })
      await page.locator('body[data-hydrated]').waitFor({ timeout: 30_000 })
      await settle(page)
      break
    } catch (error) {
      if (attempt === 3 || !/context was destroyed|navigat/i.test(String(error))) throw error
      await page.waitForLoadState('load')
    }
  }
  return { problems, loads: () => loads }
}

/** The counter. Matched whole, because a panel row is a button too and its name quotes the label of the one clicked. */
export function counter(page: Page, count: number): Locator {
  return page.getByRole('button', { name: `Count is ${count}`, exact: true })
}

/** Opens the panel unless it is open already. */
export async function showPanel(page: Page): Promise<void> {
  const panel = page.locator(PANEL)
  if (await panel.isHidden()) await page.locator(BADGE).click()
  await panel.waitFor({ state: 'visible' })
}

/** The panel's rows whose blame names `name`, leaving out the lines for renders after the paint. */
export function blamedRows(page: Page, name: string): Locator {
  return page
    .locator(`${PANEL} .row`)
    .filter({ has: page.locator('.blame:not(.later) > b', { hasText: new RegExp(`^${name}$`) }) })
}

/** Who owns React's DevTools hook, read from the hook itself. */
export function hookState(page: Page) {
  return page.evaluate(() => {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__
    return {
      preamble: typeof window.$RefreshSig$ === 'function',
      libraryShim: hook?.reactInpBlame === true,
      keptRenderers: hook?.renderers instanceof Map ? hook.renderers.size : null,
    }
  })
}

/** Where a report says its interaction happened, and the navigation it started. */
export type Place = Pick<InteractionReport, 'navigationURL' | 'navigationType' | 'startedNavigation'>

/**
 * Waits for a report of an interaction other than `seen` and returns its id and where it was placed, at its
 * latest revision. docs/install.md's config has no `debugGlobal`, so this reads the installed API from the
 * library's own page state, which is kept on `globalThis` under `Symbol.for('react-inp-blame')`.
 */
export async function reportAfter(page: Page, seen: number | null): Promise<{ interactionId: number; place: Place }> {
  const handle = await page.waitForFunction(
    (id) => {
      type Session = { slots: { install?: { installed: { api: Api } | null } } }
      const session = (globalThis as unknown as Record<symbol, Session | undefined>)[Symbol.for('react-inp-blame')]
      const last = session?.slots.install?.installed?.api.last()
      if (!last || last.interactionId === id) return null
      const { interactionId, navigationURL, navigationType, startedNavigation } = last
      return { interactionId, place: { navigationURL, navigationType, startedNavigation } }
    },
    seen,
    { timeout: 8_000 },
  )
  const report = await handle.jsonValue()
  // waitForFunction only resolves on a truthy value, which its type does not say.
  if (!report) throw new Error('waited for a report and got none')
  return report
}

/** The id of the newest report so far, or null before the first, for `reportAfter` to wait past. */
export function lastReportId(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    type Session = { slots: { install?: { installed: { api: Api } | null } } }
    const session = (globalThis as unknown as Record<symbol, Session | undefined>)[Symbol.for('react-inp-blame')]
    return session?.slots.install?.installed?.api.last()?.interactionId ?? null
  })
}

/** The URL and type of the document's own navigation, named the way the library and web-vitals name it. */
export function documentNavigation(page: Page): Promise<{ url: string; type: Place['navigationType'] }> {
  return page.evaluate(() => {
    const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
    return { url: entry.name, type: entry.type.replace(/_/g, '-') as Place['navigationType'] }
  })
}
