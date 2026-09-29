import { expect, test } from '@playwright/test'
import { counter, documentNavigation, open, reportAfter, settle, showPanel } from './page'

// A report keeps a URL's origin and path: the page opens on /?inp-blame, and its reports say /.
const withoutQuery = (url: string) => url.replace(/[?#].*$/, '')

// src/router.tsx is docs/install.md's block for route changes. TanStack Router's history tells the router of
// a Link click inside that click, and the router emits onBeforeNavigate before its first await, so the click
// that changes the route is named with it. The URL announced is the history's, the one the address bar shows.
test('reports follow route changes, and the link click names the navigation it started', async ({ page }) => {
  const { problems } = await open(page)
  const home = await documentNavigation(page)
  const second = new URL('/second', home.url).href

  await page.getByRole('link', { name: 'Second page', exact: true }).click()
  await page.getByRole('heading', { name: 'Second page', exact: true }).waitFor()
  await settle(page)
  const link = await reportAfter(page, null)
  expect(link.place).toEqual({ navigationURL: withoutQuery(home.url), navigationType: home.type, startedNavigation: { url: second, type: 'push' } })

  await page.getByRole('button', { name: 'Slow', exact: true }).click()
  const slow = await reportAfter(page, link.interactionId)
  expect(slow.place).toEqual({ navigationURL: second, navigationType: 'soft-navigation', startedNavigation: null })

  // Back is announced from the popstate, with no input being dispatched, at the URL the address bar shows,
  // /?inp-blame rather than TanStack Router's own /?inp-blame=, which the report keeps as /.
  await page.goBack()
  await counter(page, 0).waitFor()
  await settle(page)
  const back = await page.evaluate(() => location.href)
  await counter(page, 0).click()
  const counted = await reportAfter(page, slow.interactionId)
  expect(counted.place).toEqual({ navigationURL: withoutQuery(back), navigationType: 'soft-navigation', startedNavigation: null })

  // The link click's row in the panel says where it went.
  await showPanel(page)
  await page.locator(`#react-inp-blame .panel .row[data-id="${link.interactionId}"] .toggle`).click()
  await expect(page.locator(`#react-inp-blame .panel .row[data-id="${link.interactionId}"] .more .note`, { hasText: 'It started a navigation to /second.' })).toBeVisible()

  expect(problems).toEqual([])
})
