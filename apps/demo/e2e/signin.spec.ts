import { expect, test, type Page } from '@playwright/test';
import type { InteractionReport } from 'react-inp-blame';

const prod = process.env.INP_MODE === 'prod';

async function reports(page: Page): Promise<InteractionReport[]> {
  return page.evaluate(() => (window as any).__REACT_INP_BLAME__.reports());
}

test('sign-in flow: email, password, log in, profile, each attributed to what took the time', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-test=email]');
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as any).__REACT_INP_BLAME__.clear());

  await page.locator('[data-test=email]').pressSequentially('ada@example.com', { delay: 60 });
  await page.locator('[data-test=password]').pressSequentially('Hunter2!', { delay: 60 });
  await page.waitForTimeout(400);
  const beforeClick = await reports(page);

  const emails = beforeClick.filter((r) => r.target?.selector?.includes('data-test=email'));
  const passwords = beforeClick.filter((r) => r.target?.selector?.includes('data-test=password'));
  expect(emails.length, 'no email keystroke was slow enough to report').toBeGreaterThanOrEqual(1);
  expect(passwords.length, 'no password keystroke was slow enough to report').toBeGreaterThanOrEqual(1);

  // Each email keystroke re-renders the phone preview's 1000 tiles.
  const e = emails.reduce((a, b) => (b.duration > a.duration ? b : a));
  console.log(`  email:    ${e.verdict}`);
  const eMain = [...e.commits, ...e.followUps][0];
  expect(eMain, 'email keystroke had no React render').toBeTruthy();
  expect(eMain.rendered).toBeGreaterThanOrEqual(1000);
  expect(e.explanation.blame).toMatchObject({ kind: 'render', name: 'FeedPreview', confidence: prod ? 'inferred' : 'measured' });

  // Each password keystroke scores the password for 110 ms in the change handler; production
  // builds name the handler by its prop and can only infer that it took the time.
  const p = passwords.reduce((a, b) => (b.duration > a.duration ? b : a));
  console.log(`  password: ${p.verdict}`);
  expect(p.duration).toBeGreaterThanOrEqual(110);
  expect(p.explanation.blame).toMatchObject(prod ? { kind: 'handler', name: 'onChange', confidence: 'inferred' } : { kind: 'handler', name: 'onPasswordChange', confidence: 'measured' });

  // The login click hashes the password for 400 ms before the request goes out.
  await page.click('[data-test=login]');
  await page.waitForSelector('[data-test=photos]', { timeout: 10_000 });
  await page.waitForTimeout(700);
  const after = await reports(page);
  const click = after.find((r) => r.target?.selector?.includes('data-test=login'));
  expect(click, 'no report for the login click').toBeTruthy();
  console.log(`  login:    ${click!.verdict}`);
  expect(click!.duration).toBeGreaterThanOrEqual(400);
  expect(click!.explanation.rating).not.toBe('good');
  expect(click!.explanation.blame).toMatchObject(prod ? { kind: 'handler', name: 'onClick', confidence: 'inferred' } : { kind: 'handler', name: 'handleLogin', confidence: 'measured' });

  // The profile renders once the server answers, after the click's paint, and joins its report.
  expect(click!.followUps.length, 'the profile render did not attach to the click').toBeGreaterThanOrEqual(1);
  const later = click!.followUps[click!.followUps.length - 1];
  expect(later.at).toBeGreaterThan(click!.end);
  expect(later.rendered).toBeGreaterThanOrEqual(240);
  expect(later.components.map((x) => x.name)).toContain('PhotoTile');
  expect(click!.revision).toBeGreaterThanOrEqual(1);

  const inp = await page.textContent('[data-test=inp]');
  console.log(`  panel:    ${inp?.replace(/\s+/g, ' ').trim()}`);
  expect(inp).toContain('Page INP so far');
  const journeyText = (await page.textContent('[data-test=journey]')) || '';
  expect(journeyText).toContain('Waiting for the server');
});
