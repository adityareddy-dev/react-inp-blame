import { test } from '@playwright/test';
import '../e2e/page';

// Headed walkthrough for a person to watch:
//   INP_TOUR=1 npx playwright test --headed
// It is a Playwright project of its own, which the config only defines when INP_TOUR is set, so a
// normal run neither collects nor skips it. The waits are the pace of the walkthrough, not a way of
// waiting for the library: it runs the sign-in flow slowly, then the anti-pattern lab, then parks with
// the browser open so you can record a Performance profile and look at the "react-inp-blame" tracks.
test.describe.configure({ timeout: 0 });

test('tour', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-test=email]');
  await page.waitForTimeout(2500);
  await page.locator('[data-test=email]').pressSequentially('ada.lovelace@example.com', { delay: 110 });
  await page.waitForTimeout(1500);
  await page.locator('[data-test=password]').pressSequentially('Hunter2!', { delay: 160 });
  await page.waitForTimeout(1500);
  await page.click('[data-test=login]');
  await page.waitForSelector('[data-test=photos]', { timeout: 10_000 });
  await page.waitForTimeout(1200);
  for (const r of await page.evaluate(() => window.__REACT_INP_BLAME__.reports())) console.log(`  ${r.verdict}`);
  await page.waitForTimeout(9000);

  const lab: Array<[string, string]> = [
    ['context-storm', 'click'],
    ['layout-thrash', 'click'],
    ['handler-hog', 'click'],
    ['big-list', 'type:7'],
    ['lifted-state', 'type:adi'],
    ['cascading-effect', 'click'],
    ['fine', 'click'],
  ];
  for (const [scenario, action] of lab) {
    await page.goto(`/#lab/${scenario}`);
    await page.waitForSelector('[data-test=trigger]');
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__REACT_INP_BLAME__.clear());
    if (action === 'click') await page.click('[data-test=trigger]');
    else await page.locator('[data-test=trigger]').pressSequentially(action.slice(5), { delay: 500 });
    await page.waitForFunction(() => window.__REACT_INP_BLAME__.last() != null, null, { timeout: 8_000 }).catch(() => {});
    const r = await page.evaluate(() => window.__REACT_INP_BLAME__.last());
    console.log(`  [${scenario}] ${r ? r.verdict : 'no report, the interaction stayed under the threshold'}`);
    await page.waitForTimeout(4500);
  }

  await page.goto('/');
  await page.waitForSelector('[data-test=email]');
  console.log('\n  Browser stays open. In it: Cmd+Opt+I, Performance tab, Record, sign in again, Stop.');
  console.log('  Look for the "react-inp-blame" group and its Interaction blame track, beside React\'s own Scheduler and Components tracks.');
  console.log('  Close the browser or press Resume in the Playwright Inspector to end the tour.\n');
  await page.pause();
});
