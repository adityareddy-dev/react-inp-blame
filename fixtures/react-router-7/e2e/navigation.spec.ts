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

// A navigation to the page it is on, as a link to it makes, gets a key of its own from React Router, but the
// URL does not change, so the block announces nothing, and the reports after it stay on the document's
// navigation.
test("a navigation to the page it is on is not a route change", async ({ page }) => {
  const { problems } = await open(page);
  const home = await documentNavigation(page);
  const here = page.getByRole("button", { name: "This page", exact: true });

  await page.getByRole("button", { name: "Save", exact: true }).click();
  const [saved] = await reportsAfter(page, null, 1);
  const body = page.locator("body");
  const key = await body.getAttribute("data-location");
  await here.click();
  await expect(body).not.toHaveAttribute("data-location", key ?? "");
  expect(await page.evaluate(() => location.href)).toBe(home.url);
  // The navigation changes nothing the page shows, and headless Chrome reports an interaction at the next
  // paint, so the click after it is the counter's, which paints.
  await counter(page, 0).click();
  const [navigated, counted] = await reportsAfter(page, saved.interactionId, 2);
  expect(navigated.place).toEqual({ navigationURL: home.url, navigationType: home.type, startedNavigation: null });
  expect(counted.place).toEqual({ navigationURL: home.url, navigationType: home.type, startedNavigation: null });

  expect(problems).toEqual([]);
});
