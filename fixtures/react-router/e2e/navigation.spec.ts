import { expect, test } from "@playwright/test";
import { counter, documentNavigation, open, reportAfter, settle } from "./page";

// app/announce-navigations.tsx is docs/install.md's block for route changes, rendered in the root route. React
// Router renders a new route in a transition, after the click that started it, so the effect that announces
// runs once the route has committed, with no input being dispatched: the reports after it are placed at the
// new URL, and the link click names no navigation. If it ever comes out named, the docs are what is wrong.
test("reports follow route changes, and the link click is placed on the page it left", async ({ page }) => {
  const { problems } = await open(page);
  const home = await documentNavigation(page);
  const second = new URL("/second", home.url).href;

  await page.getByRole("link", { name: "Second page", exact: true }).click();
  await page.getByRole("heading", { name: "Second page", exact: true }).waitFor();
  // The effect has run by the time the page is idle. Without this it could run inside the next click.
  await settle(page);
  const link = await reportAfter(page, null);
  expect(link.place).toEqual({ navigationURL: home.url, navigationType: home.type, startedNavigation: null });

  await page.getByRole("button", { name: "Slow", exact: true }).click();
  const slow = await reportAfter(page, link.interactionId);
  expect(slow.place).toEqual({ navigationURL: second, navigationType: "soft-navigation", startedNavigation: null });

  // Back is a route change too, and the same effect announces it.
  await page.goBack();
  await counter(page, 0).waitFor();
  await settle(page);
  const back = await page.evaluate(() => location.href);
  await counter(page, 0).click();
  const counted = await reportAfter(page, slow.interactionId);
  expect(counted.place).toEqual({ navigationURL: back, navigationType: "soft-navigation", startedNavigation: null });

  expect(problems).toEqual([]);
});
