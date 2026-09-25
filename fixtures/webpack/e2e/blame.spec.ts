import { expect, test } from '@playwright/test'
import { blamedRows, counter, libraryHook, open, scripts, showPanel } from './page'

// The README's webpack setup: `import 'react-inp-blame/auto'` first in the entry, and the names loader. The
// build puts react-dom and the library in one vendor chunk the page loads before the entry's own, and
// webpack runs a module when it is first required rather than when its chunk loads, so the install still
// runs before react-dom. In a production build terser renames every component, so a blame that reads
// SlowList is the loader's displayName. The counter re-renders SlowList's 400 rows, so a click on it is slow.
test('a click is blamed on SlowList, with react-dom in the vendor chunk', async ({ page }) => {
  const problems = await open(page)
  expect(await scripts(page)).toEqual(expect.arrayContaining([expect.stringMatching(/^vendor\./), expect.stringMatching(/^main\./)]))
  expect(await libraryHook(page)).toBe(true)

  await counter(page, 0).click()
  await expect(counter(page, 1)).toBeVisible()
  await expect(page.locator('#react-inp-blame .badge')).toHaveAttribute('data-rating', /needs-improvement|poor/)

  await showPanel(page)
  const rows = blamedRows(page, 'SlowList')
  await expect(rows).toHaveCount(1)
  const blame = await rows.locator('.blame:not(.later)').textContent()
  const rendered = Number(/Row ×(\d+)/.exec(blame ?? '')?.[1])
  expect(rendered, `the blame line reads "${blame}"`).toBeGreaterThanOrEqual(400)
  expect(problems).toEqual([])
})
