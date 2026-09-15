import { expect, test } from '@playwright/test';
import type { InteractionReport } from 'react-inp-blame';

// Commits join to interactions on Event.timeStamp, so a slow main thread between the input and
// its renders does not lose the join. A busy loop runs for 600 ms while the login gesture is
// injected with raw mouse events (page.mouse skips the page-side actionability checks that the
// loop would otherwise block). Event Timing gives the interaction ~580 ms of input delay, and
// the profile render the click kicks off still has to attach to that report. The old code
// matched commits to interactions on performance.now() and lost the follow-up once the delay
// passed 100 ms; this proves it no longer does.
test('a click with 150 ms of input delay still gets its follow-up render', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-test=email]');
  await page.fill('[data-test=email]', 'ada@example.com');
  await page.fill('[data-test=password]', 'Hunter2!');
  await page.waitForTimeout(300);
  const box = (await page.locator('[data-test=login]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => (window as any).__REACT_INP__.clear());

  const blocking = page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          const end = performance.now() + 600;
          while (performance.now() < end) {
            // spin: the login gesture injected next is stuck behind this
          }
          resolve();
        }, 30),
      ),
  );
  await page.waitForTimeout(45);
  await page.mouse.down();
  await page.mouse.up();
  await blocking;

  await page.waitForSelector('[data-test=photos]', { timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const r = (window as any).__REACT_INP__.reports().find((x: any) => x.target?.selector?.includes('data-test=login'));
      return !!r && r.followUps.length > 0;
    },
    null,
    { timeout: 8_000 },
  );
  const click: InteractionReport = await page.evaluate(() =>
    (window as any).__REACT_INP__.reports().find((r: InteractionReport) => r.target?.selector?.includes('data-test=login')),
  );
  console.log(`  ${click.verdict}`);
  console.log(
    `  input delay ${Math.round(click.inputDelay)} ms, commits ${click.commits.map((c) => `${Math.round(c.at - click.start)}ms/${c.rendered}/${c.joinedBy}`).join(' ')}, follow-ups ${click.followUps.map((c) => `${Math.round(c.at - click.start)}ms/${c.rendered}/${c.joinedBy}`).join(' ')}`,
  );

  expect(click.inputDelay).toBeGreaterThanOrEqual(150);
  for (const c of [...click.commits, ...click.followUps]) expect(c.joinedBy).toBe('exact');
  const later = click.followUps[click.followUps.length - 1];
  expect(later.rendered).toBeGreaterThanOrEqual(240);
  expect(click.verdict).toContain('after the screen updated');
});
