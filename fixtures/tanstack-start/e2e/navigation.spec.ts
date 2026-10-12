import { expect, test } from '@playwright/test'
import { counter, documentNavigation, lastReportId, open, reportAfter, settle, showPanel } from './page'

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

// The cases docs/install.md gives for checking the URL against the one last announced. TanStack Router's own
// hrefChanged compares with the last route that finished loading, and is false for Back before a slow loader and
// for a redirect to the page it was on, which left reports on a URL the page had left. The fromLocation wait is
// not pinned here: under TanStack Start the server redirects to a default validateSearch fills in, even on a
// route with ssr: false, and a Link to the route pushes the URL with the default in it, so the router never
// rewrites the address in the page. Only TanStack Router without Start does, as it first loads.
test("Start's server redirects to a validateSearch default on the landing page, the document's navigation is at it, and nothing is announced", async ({ page }) => {
  const { problems } = await open(page, '/search?inp-blame')
  await expect(page.getByRole('heading', { name: 'Search, all', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/[?&]tab=all\b/)
  const landed = await documentNavigation(page)
  expect(landed.url).toMatch(/[?&]tab=all\b/)
  await page.getByRole('button', { name: 'Slow', exact: true }).click()
  const slow = await reportAfter(page, null)
  expect(slow.place).toEqual({ navigationURL: withoutQuery(landed.url), navigationType: landed.type, startedNavigation: null })
  expect(problems).toEqual([])
})

test('Back pressed before a slow loader finished is announced', async ({ page }) => {
  const { problems } = await open(page)
  const home = await documentNavigation(page)
  await page.getByRole('link', { name: 'Slow loader', exact: true }).click()
  await expect(page).toHaveURL(/\/slow-loader$/)
  await page.goBack()
  await counter(page, 0).waitFor()
  await settle(page)
  const seen = await lastReportId(page)
  await counter(page, 0).click()
  const counted = await reportAfter(page, seen)
  expect(counted.place).toEqual({ navigationURL: withoutQuery(home.url), navigationType: 'soft-navigation', startedNavigation: null })
  // The loader had not finished: its page never showed.
  await expect(page.getByRole('heading', { name: 'Slow loader', exact: true })).toHaveCount(0)
  expect(problems).toEqual([])
})

test('a beforeLoad that redirects back to the page it was on is announced', async ({ page }) => {
  const { problems } = await open(page)
  const home = await documentNavigation(page)
  await page.getByRole('link', { name: 'Bounce', exact: true }).click()
  await expect(page).toHaveURL(new URL('/?inp-blame=', home.url).href)
  await counter(page, 0).waitFor()
  await settle(page)
  const seen = await lastReportId(page)
  await counter(page, 0).click()
  const counted = await reportAfter(page, seen)
  expect(counted.place).toEqual({ navigationURL: withoutQuery(home.url), navigationType: 'soft-navigation', startedNavigation: null })
  expect(problems).toEqual([])
})
