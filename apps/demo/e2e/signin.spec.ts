import { expect, test, type Page } from '@playwright/test';
import type { InteractionReport } from 'inpector';

const prod = process.env.INP_MODE === 'prod';

async function reports(page: Page): Promise<InteractionReport[]> {
  return page.evaluate(() => (window as any).__REACT_INP__.reports());
}

test('sign-in flow: email, password, log in, profile, each attributed in plain words', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('[data-test=email]');
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as any).__REACT_INP__.clear());

  await page.type('[data-test=email]', 'ada@example.com', { delay: 60 });
  await page.type('[data-test=password]', 'Hunter2!', { delay: 60 });
  await page.waitForTimeout(400);
  const beforeClick = await reports(page);

  const emails = beforeClick.filter((r) => r.target?.selector?.includes('data-test=email'));
  const passwords = beforeClick.filter((r) => r.target?.selector?.includes('data-test=password'));
  expect(emails.length, 'no email keystroke was slow enough to report').toBeGreaterThanOrEqual(1);
  expect(passwords.length, 'no password keystroke was slow enough to report').toBeGreaterThanOrEqual(1);

  const e = emails.reduce((a, b) => (b.duration > a.duration ? b : a));
  console.log(`  email:    ${e.verdict}`);
  const eMain = [...e.commits, ...e.followUps][0];
  expect(eMain, 'email keystroke had no React render').toBeTruthy();
  expect(eMain.rendered).toBeGreaterThanOrEqual(1000);
  if (!prod) expect(e.verdict).toContain('FeedPreview');

  const p = passwords.reduce((a, b) => (b.duration > a.duration ? b : a));
  console.log(`  password: ${p.verdict}`);
  expect(p.duration).toBeGreaterThanOrEqual(80);
  if (!prod) {
    expect(p.target?.handler).toBe('onPasswordChange');
    expect(p.verdict).toContain('onPasswordChange');
    expect(p.explanation.cause).toMatch(/handler onPasswordChange ran for/);
  }

  await page.click('[data-test=login]');
  await page.waitForSelector('[data-test=photos]', { timeout: 10_000 });
  await page.waitForTimeout(700);
  const after = await reports(page);
  const click = after.find((r) => r.target?.selector?.includes('data-test=login'));
  expect(click, 'no report for the login click').toBeTruthy();
  console.log(`  login:    ${click!.verdict}`);
  expect(click!.duration).toBeGreaterThanOrEqual(200);
  expect(click!.explanation.rating).not.toBe('good');
  if (!prod) {
    expect(click!.target?.handler).toBe('handleLogin');
    expect(click!.explanation.cause).toMatch(/handler handleLogin ran for/);
  }
  expect(click!.followUps.length, 'the profile render did not attach to the click').toBeGreaterThanOrEqual(1);
  const later = click!.followUps[click!.followUps.length - 1];
  expect(later.rendered).toBeGreaterThanOrEqual(240);
  expect(click!.verdict).toContain('after the screen updated');
  if (!prod) expect(later.components.map((x) => x.name)).toContain('PhotoTile');
  expect(click!.revision).toBeGreaterThanOrEqual(1);

  const inp = await page.textContent('[data-test=inp]');
  console.log(`  panel:    ${inp?.replace(/\s+/g, ' ').trim()}`);
  expect(inp).toContain('Page INP so far');
  const journeyText = (await page.textContent('[data-test=journey]')) || '';
  expect(journeyText).toContain('Waiting for the server');
});
