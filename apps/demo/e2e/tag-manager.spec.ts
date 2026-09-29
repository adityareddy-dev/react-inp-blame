import { expect, test } from '@playwright/test';
import { interact, waitForFrames } from './page';

const prod = process.env.INP_MODE === 'prod';

test("tag manager: a document listener React did not attach is blamed, not the button's onClick", async ({ page }) => {
  const r = await interact(page, 'tag-manager', async () => {
    await page.click('[data-test=trigger]');
    // The blame rests on the long animation frame that timed the listener, which can arrive as a revision.
    await waitForFrames(page);
  });
  expect(r.frames, 'the long animation frame that timed the listener never arrived').not.toEqual([]);
  expect(r.target?.handler).toBeTruthy();
  // The listener busy-waits 150 ms. A production build minifies its name, so there it goes by what ran it.
  expect(r.explanation.blame).toMatchObject({ kind: 'script', confidence: 'measured' });
  expect(r.explanation.blame.ms).toBeGreaterThanOrEqual(75);
  if (prod) expect(r.explanation.blame.name).toBe('#document.onclick');
  else {
    expect(r.explanation.blame.name).toBe('trackClick');
    expect(r.explanation.cause).toMatch(/^A listener React did not attach ran for about \d+ ms: trackClick \(/);
  }
});
