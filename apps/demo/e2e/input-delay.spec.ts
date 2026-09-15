import { expect, test } from '@playwright/test';
import type { InteractionReport } from 'react-inp-blame';

// Commits join to interactions on Event.timeStamp, so a busy main thread between the input and its
// renders does not lose the join. A busy loop holds the main thread for 350 ms while a click on the
// cascading-effect button is injected with raw mouse events (page.mouse skips the page-side
// actionability checks the loop would otherwise block). Event Timing gives the click over 300 ms of
// input delay, and the render its effect sets off after the paint still has to attach to that
// report. The old code matched commits to interactions on performance.now() and lost them once the
// delay passed 100 ms; this proves it no longer does.
test('a click that waits over 150 ms to be handled still gets its later render', async ({ page }) => {
  await page.goto('/#cascading-effect');
  await page.waitForSelector('[data-test=trigger]');
  await page.waitForTimeout(300);
  const box = (await page.locator('[data-test=trigger]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => (window as any).__REACT_INP__.clear());

  const blocking = page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          const end = performance.now() + 350;
          while (performance.now() < end) {
            // spin: the click injected next is stuck behind this
          }
          resolve();
        }, 30),
      ),
  );
  await page.waitForTimeout(45);
  await page.mouse.down();
  await page.mouse.up();
  await blocking;

  await page.waitForFunction(() => ((window as any).__REACT_INP__.last()?.followUps.length ?? 0) > 0, null, { timeout: 8_000 });
  const click: InteractionReport = await page.evaluate(() => (window as any).__REACT_INP__.last());
  console.log(`  ${click.verdict}`);
  console.log(
    `  input delay ${Math.round(click.inputDelay)} ms, commits ${click.commits.map((c) => `${Math.round(c.at - click.start)}ms/${c.rendered}/${c.joinedBy}`).join(' ')}, follow-ups ${click.followUps.map((c) => `${Math.round(c.at - click.start)}ms/${c.rendered}/${c.joinedBy}`).join(' ')}`,
  );

  expect(click.inputDelay).toBeGreaterThanOrEqual(150);
  for (const c of [...click.commits, ...click.followUps]) expect(c.joinedBy).toBe('exact');
  const later = click.followUps[click.followUps.length - 1];
  expect(later.at).toBeGreaterThan(click.end);
  expect(later.components[0].name).toBe('Detail');
  expect(later.rendered).toBeGreaterThanOrEqual(400);
});
