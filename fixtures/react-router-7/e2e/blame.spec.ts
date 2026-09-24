import { expect, test } from "@playwright/test";
import { blamedRows, counter, hookState, open, showPanel } from "./page";

// React Router 7's template moved to React 18, with react-inp-blame installed from the packed tarball and a
// route that imports react-dom. React Router writes the page itself, so nothing goes through the Vite
// plugin's script: app/inp-blame.ts, first in app/root.tsx, is the install, and it only works if it runs
// before react-dom does. React Router imports the root route's module before any other route's and before
// the client entry. The blame below is the check on that.
test("a click is blamed on SlowList", async ({ page }) => {
  const dev = test.info().project.name === "dev";
  const { problems, loads } = await open(page);
  try {
    const state = await hookState(page);
    // On the dev server the Fast Refresh runtime makes the hook and the library chains onto it; a build
    // has no such runtime, so the hook is the library's own.
    expect(state).toMatchObject({ preamble: dev, libraryShim: !dev });

    await counter(page, 0).click();
    await expect(counter(page, 1)).toBeVisible();
    await expect(page.locator("#react-inp-blame .badge")).toHaveAttribute("data-rating", /needs-improvement|poor/);

    await showPanel(page);
    const rows = blamedRows(page, "SlowList");
    await expect(rows).toHaveCount(1);
    const blame = await rows.locator(".blame:not(.later)").textContent();
    const rendered = Number(/Row ×(\d+)/.exec(blame ?? "")?.[1]);
    expect(rendered, `the blame line reads "${blame}"`).toBeGreaterThanOrEqual(400);

    expect(problems).toEqual([]);
  } finally {
    const count = loads();
    await test.info().attach("page loads", { body: String(count), contentType: "text/plain" });
    console.log(`${test.info().project.name}: ${count} page load${count === 1 ? "" : "s"}`);
  }
});
