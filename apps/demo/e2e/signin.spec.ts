import { expect, test, type Page } from '@playwright/test';
import type { InteractionReport } from 'react-inp-blame';
import { clearReports, settle, testAttribute } from './page';

const prod = process.env.INP_MODE === 'prod';

async function reports(page: Page): Promise<InteractionReport[]> {
  return page.evaluate(() => window.__REACT_INP_BLAME__.reports());
}

/** The reports of interactions on the element the demo marks `data-test="<name>"`. */
const on = (all: InteractionReport[], name: string) => all.filter((r) => r.target?.selector?.includes(testAttribute(name)));

const slowest = (all: InteractionReport[]) => all.reduce((a, b) => (b.duration > a.duration ? b : a));

/** The one whose handlers ran longest: a keystroke whose paint a busy machine held up is slower, and rightly blamed on painting. */
const busiest = (all: InteractionReport[]) => all.reduce((a, b) => (b.processing > a.processing ? b : a));

test('sign-in flow: email, password, log in, profile, each attributed to what took the time', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-test=email]');
  await settle(page);
  await clearReports(page);

  await page.locator('[data-test=email]').pressSequentially('ada@example.com', { delay: 60 });
  await page.locator('[data-test=password]').pressSequentially('Hunter2!', { delay: 60 });
  // Entries arrive with the paint after the keystroke, so the last one is still on its way.
  await page.waitForFunction(() => window.__REACT_INP_BLAME__.reports().some((r) => r.target?.selector?.includes('data-test="password"')), null, { timeout: 8_000 });
  const beforeClick = await reports(page);

  const emails = on(beforeClick, 'email');
  const passwords = on(beforeClick, 'password');
  expect(emails.length, 'no email keystroke was slow enough to report').toBeGreaterThanOrEqual(1);
  expect(passwords.length, 'no password keystroke was slow enough to report').toBeGreaterThanOrEqual(1);

  // Each email keystroke re-renders the phone preview's 1000 tiles.
  const e = slowest(emails);
  const eMain = [...e.commits, ...e.followUps][0];
  expect(eMain, 'email keystroke had no React render').toBeTruthy();
  expect(eMain.rendered).toBeGreaterThanOrEqual(1000);
  expect(e.explanation.blame).toMatchObject({ kind: 'render', name: 'FeedPreview', confidence: prod ? 'inferred' : 'measured' });

  // Each password keystroke scores the password for 110 ms in the change handler; production
  // builds name the handler by its prop and can only infer that it took the time.
  const p = busiest(passwords);
  expect(p.duration).toBeGreaterThanOrEqual(110);
  expect(p.explanation.blame).toMatchObject(prod ? { kind: 'handler', name: 'onChange', confidence: 'inferred' } : { kind: 'handler', name: 'onPasswordChange', confidence: 'measured' });

  // The login click hashes the password for 400 ms before the request goes out, and the profile
  // renders once the server answers, after the click's paint, joining the click's report.
  await page.click('[data-test=login]');
  await page.waitForSelector('[data-test=photos]', { timeout: 10_000 });
  await page.waitForFunction(() => (window.__REACT_INP_BLAME__.reports().find((r) => r.target?.selector?.includes('data-test="login"'))?.followUps.length ?? 0) > 0, null, { timeout: 10_000 });
  const [click] = on(await reports(page), 'login');
  expect(click, 'no report for the login click').toBeTruthy();
  await test.info().attach('verdicts', { body: [e, p, click!].map((r) => r.verdict).join('\n\n'), contentType: 'text/plain' });

  expect(click!.duration).toBeGreaterThanOrEqual(400);
  expect(click!.explanation.rating).not.toBe('good');
  expect(click!.explanation.blame).toMatchObject(prod ? { kind: 'handler', name: 'onClick', confidence: 'inferred' } : { kind: 'handler', name: 'handleLogin', confidence: 'measured' });

  const later = click!.followUps[click!.followUps.length - 1];
  expect(later.at).toBeGreaterThan(click!.end);
  expect(later.rendered).toBeGreaterThanOrEqual(240);
  expect(later.components.map((x) => x.name)).toContain('PhotoTile');
  expect(click!.revision).toBeGreaterThanOrEqual(1);

  const inp = await page.textContent('[data-test=inp]');
  expect(inp).toContain('Page INP so far');
  const journeyText = (await page.textContent('[data-test=journey]')) || '';
  expect(journeyText).toContain('Waiting for the server');
});
