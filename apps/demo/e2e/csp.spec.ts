import { expect, test, type Page } from '@playwright/test';
import { lastReport, settle } from './page';

// The badge and panel under a strict Content Security Policy: nonces for scripts and styles and no
// 'unsafe-inline', and then Trusted Types on top. The page is the demo as it is, served with the policy
// in a header and the nonce on each script and style of its HTML, as a server that sets a nonce per
// response would. Vite's development client reads the nonce from the csp-nonce meta tag for the styles
// it adds.

const NONCE = 'c3RyaWN0LWNzcC10ZXN0';
const STRICT = [
  "default-src 'self'",
  `script-src 'self' 'nonce-${NONCE}'`,
  `style-src 'self' 'nonce-${NONCE}'`,
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
].join('; ');

/** Serves every page with `policy`, and the nonce on the scripts and styles its HTML carries. */
async function serveWith(page: Page, policy: string): Promise<void> {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    const html = (await response.text())
      .replace(/<(script|style)\b/g, `<$1 nonce="${NONCE}"`)
      .replace('<head>', `<head><meta property="csp-nonce" nonce="${NONCE}">`);
    await route.fulfill({ response, body: html, headers: { ...response.headers(), 'content-security-policy': policy } });
  });
  // Every violation the page reports, whoever caused it.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as Window & { __violations?: string[] }).__violations = seen;
    document.addEventListener('securitypolicyviolation', (e) => seen.push(`${e.violatedDirective} ${e.blockedURI} ${e.sample}`.trim()));
  });
}

const violations = (page: Page) => page.evaluate(() => (window as Window & { __violations?: string[] }).__violations ?? []);

/** A slow click, then the badge and the panel's row for it, with the styles the browser applied to them. */
async function drawn(page: Page) {
  await page.goto('/#handler-hog');
  await page.waitForSelector('[data-test=trigger]');
  await settle(page);
  await page.click('[data-test=trigger]');
  await lastReport(page);
  const badge = page.locator('#react-inp-blame .badge');
  await expect(badge).toHaveAttribute('data-rating', /good|needs-improvement|poor/, { timeout: 10_000 });
  await badge.click();
  const row = page.locator('#react-inp-blame .panel .row').first();
  await expect(row).toBeVisible();
  // Off the badge, so its colour is not the hover one.
  await page.mouse.move(1, 1);
  return page.evaluate(() => {
    const root = document.getElementById('react-inp-blame')!.shadowRoot!;
    const css = (el: Element | null) => (el ? getComputedStyle(el) : null);
    const wrap = css(root.querySelector('.wrap'));
    const badge = root.querySelector<HTMLElement>('.badge')!;
    const bands = Array.from(root.querySelectorAll<HTMLElement>('.row .bar i'), (b) => b.getBoundingClientRect().width);
    return {
      rating: badge.dataset.rating!,
      position: wrap?.position,
      badgeBackground: css(badge)?.backgroundColor,
      badgeDot: css(badge.querySelector('.dot'))?.backgroundColor,
      rowDot: css(root.querySelector('.row .r1 .dot'))?.backgroundColor,
      rowTime: css(root.querySelector('.row .r1 .ms'))?.color,
      tag: css(root.querySelector('.head .tag'))?.backgroundColor,
      bands,
      barWidth: root.querySelector('.row .bar')!.getBoundingClientRect().width,
    };
  });
}

const COLOR = { good: 'rgb(34, 197, 94)', 'needs-improvement': 'rgb(245, 158, 11)', poor: 'rgb(239, 68, 68)' } as const;

function expectStyled(d: Awaited<ReturnType<typeof drawn>>) {
  // The shadow root's stylesheet applied: the badge is the dark pill in a fixed corner.
  expect(d.position).toBe('fixed');
  expect(d.badgeBackground).toBe('rgba(17, 19, 24, 0.94)');
  // The colours that depend on the rating, which used to be style attributes.
  const color = COLOR[d.rating as keyof typeof COLOR];
  expect(d.badgeDot).toBe(color);
  expect(d.tag).toBe(color);
  // A row's own rating can differ from the page's, so it only has to be one of the three.
  expect(Object.values(COLOR)).toContain(d.rowDot);
  expect(d.rowTime).toBe(d.rowDot);
  // The phase bar's bands have their widths, which used to be style attributes too, and fill the bar.
  expect(d.bands.some((w) => w > 0)).toBe(true);
  expect(d.bands.reduce((a, w) => a + w, 0)).toBeGreaterThan(d.barWidth * 0.9);
}

test('under a strict CSP the badge and panel are styled, and cause no violation', async ({ page }) => {
  await serveWith(page, STRICT);
  expectStyled(await drawn(page));
  expect(await violations(page)).toEqual([]);
});

test('under Trusted Types the badge and panel draw through a policy of their own name', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' && m.text().includes('react-inp-blame')) warnings.push(m.text());
  });
  await serveWith(page, `${STRICT}; require-trusted-types-for 'script'; trusted-types react-inp-blame`);
  expectStyled(await drawn(page));
  expect(await violations(page)).toEqual([]);
  expect(warnings.filter((w) => w.includes('could not be drawn'))).toEqual([]);
});

test('under Trusted Types that do not allow its policy the overlay says so once, and the reports still come', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' && m.text().includes('could not be drawn')) warnings.push(m.text());
  });
  await serveWith(page, `${STRICT}; require-trusted-types-for 'script'; trusted-types 'none'`);
  await page.goto('/#handler-hog');
  await page.waitForSelector('[data-test=trigger]');
  await settle(page);
  await page.click('[data-test=trigger]');
  const report = await lastReport(page);
  expect(report.duration).toBeGreaterThan(0);
  await expect.poll(() => warnings.length).toBe(1);
  expect(warnings[0]).toContain('trusted-types');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.click('[data-test=trigger]');
  await lastReport(page);
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
  expect(warnings).toHaveLength(1);
});
