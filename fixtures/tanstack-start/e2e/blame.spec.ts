import { expect, test } from '@playwright/test'
import { blamedRows, counter, hookState, open, showPanel } from './page'

// The app as a user has it: TanStack Start's blank template with the README's TanStack Start setup, and
// react-inp-blame installed from the packed tarball. TanStack Start writes the page itself, so nothing
// goes through the Vite plugin's script: its `entry` puts the install first in src/client.tsx, and it
// only works if it runs before react-dom does. The blame below is the check on that.
test('a click is blamed on SlowList', async ({ page }) => {
  const dev = test.info().project.name === 'dev'
  const { problems, loads } = await open(page)
  try {
    const state = await hookState(page)
    // On the dev server plugin-react's Fast Refresh preamble makes the hook and the library chains onto it; a build
    // has no such runtime, so the hook is the library's own.
    expect(state).toMatchObject({ preamble: dev, libraryShim: !dev })

    await counter(page, 0).click()
    await expect(counter(page, 1)).toBeVisible()
    await expect(page.locator('#react-inp-blame .badge')).toHaveAttribute('data-rating', /needs-improvement|poor/)

    await showPanel(page)
    const rows = blamedRows(page, 'SlowList')
    await expect(rows).toHaveCount(1)
    const blame = await rows.locator('.blame:not(.later)').textContent()
    const rendered = Number(/Row ×(\d+)/.exec(blame ?? '')?.[1])
    expect(rendered, `the blame line reads '${blame}'`).toBeGreaterThanOrEqual(400)

    expect(problems).toEqual([])
  } finally {
    const count = loads()
    await test.info().attach('page loads', { body: String(count), contentType: 'text/plain' })
    console.log(`${test.info().project.name}: ${count} page load${count === 1 ? '' : 's'}`)
  }
})
