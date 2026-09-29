import { expect, test } from "@playwright/test";
import { counter, documentNavigation, open, reportsAfter } from "./page";

// app/announce-navigations.tsx is docs/install.md's block for route changes, rendered in the root route. React
// Router renders a new route in a transition, after the click that started it, and the block's layout effect
// announces as that route commits, with no input being dispatched: the reports after it are placed at the new
// URL, and the link click names no navigation. If it ever comes out named, the docs are what is wrong.
test("reports follow route changes, and the link click is placed on the page it left", async ({ page }) => {
  const { problems } = await open(page);
  const home = await documentNavigation(page);
  const second = new URL("/second", home.url).href;

  // The second page takes 800 ms to commit. A click made meanwhile waits for the commit and lands on the new
  // page, so it is placed there, and names no navigation. An announcement from useEffect would run inside it.
  const committing = page.waitForEvent("console", (message) => message.text() === "second page committing");
  await page.getByRole("link", { name: "Second page", exact: true }).click();
  await committing;
  await page.mouse.click(5, 5);
  await page.getByRole("heading", { name: "Second page", exact: true }).waitFor();
  const [link, waited] = await reportsAfter(page, null, 2);
  expect(link.place).toEqual({ navigationURL: home.url, navigationType: home.type, startedNavigation: null });
  expect(waited.place).toEqual({ navigationURL: second, navigationType: "soft-navigation", startedNavigation: null });

  await page.getByRole("button", { name: "Slow", exact: true }).click();
  const [slow] = await reportsAfter(page, waited.interactionId, 1);
  expect(slow.place).toEqual({ navigationURL: second, navigationType: "soft-navigation", startedNavigation: null });

  // Back is a route change too, and the same effect announces it.
  await page.goBack();
  await counter(page, 0).waitFor();
  const back = await page.evaluate(() => location.href);
  await counter(page, 0).click();
  const [counted] = await reportsAfter(page, slow.interactionId, 1);
  expect(counted.place).toEqual({ navigationURL: back, navigationType: "soft-navigation", startedNavigation: null });

  expect(problems).toEqual([]);
});
