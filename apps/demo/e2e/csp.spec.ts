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

/**
 * Everything reachable from the library's page-wide state (`globalThis[Symbol.for('react-inp-blame')]`) that
 * is a Trusted Types policy, by the path it was found at. A policy kept there is one any script on the page
 * can call, which would let it put any markup into any sink under the library's name.
 */
const policiesInSharedState = (page: Page) =>
  page.evaluate(() => {
    const found: string[] = [];
    const seen = new Set<object>();
    const Policy = (window as Window & { TrustedTypePolicy?: new () => object }).TrustedTypePolicy;
    const walk = (value: unknown, path: string) => {
      if ((typeof value !== 'object' && typeof value !== 'function') || value === null || seen.has(value)) return;
      seen.add(value);
      if ((Policy && value instanceof Policy) || typeof (value as { createHTML?: unknown }).createHTML === 'function') found.push(path);
      const entries: [unknown, unknown][] =
        value instanceof Map ? [...value.entries()] : value instanceof Set ? [...value].map((v, i) => [i, v]) : Object.entries(value);
      for (const [key, inner] of entries) walk(inner, `${path}.${String(key)}`);
    };
    walk((globalThis as Record<symbol, unknown>)[Symbol.for('react-inp-blame')], 'session');
    return found;
  });

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

// The badge and panel are built from elements and text, never from markup, so they need no Trusted Types
// policy: under the strictest directive, which allows no policy at all, they draw as they do anywhere.
// Creating a policy under `trusted-types 'none'` is itself a violation, so an empty violation list also says
// none was created.
test('under Trusted Types that allow no policy the badge and panel draw, with no policy and no violation', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' && m.text().includes('react-inp-blame')) warnings.push(m.text());
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await serveWith(page, `${STRICT}; require-trusted-types-for 'script'; trusted-types 'none'`);
  expectStyled(await drawn(page));
  // A second interaction redraws the open panel, and its row opens into the full explanation.
  await page.click('[data-test=trigger]');
  await lastReport(page);
  const rows = page.locator('#react-inp-blame .panel .row');
  await expect(rows).toHaveCount(2);
  await rows.first().click();
  await expect(rows.first().locator('.more')).toBeVisible();
  expect(await violations(page)).toEqual([]);
  expect(warnings).toEqual([]);
  expect(errors).toEqual([]);
  expect(await policiesInSharedState(page)).toEqual([]);
});

// A page set up for 0.9.0 to 0.11.0 still lists the name. The library no longer takes it, so the page's own
// script can, and the overlay keeps drawing beside a policy of that name it does not own.
test('a page that still lists react-inp-blame in trusted-types finds the name free, and no policy in the shared state', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' && m.text().includes('react-inp-blame')) warnings.push(m.text());
  });
  await serveWith(page, `${STRICT}; require-trusted-types-for 'script'; trusted-types react-inp-blame`);
  expectStyled(await drawn(page));
  expect(await policiesInSharedState(page)).toEqual([]);
  // Without 'allow-duplicates' a name can be taken once, so this throws if the library took it first.
  const taken = await page.evaluate(() => {
    const tt = (window as Window & { trustedTypes?: { createPolicy(name: string, rules: object): object } }).trustedTypes!;
    try {
      return !!tt.createPolicy('react-inp-blame', { createHTML: (s: string) => s });
    } catch (error) {
      return String(error);
    }
  });
  expect(taken).toBe(true);
  await page.click('[data-test=trigger]');
  await lastReport(page);
  await expect(page.locator('#react-inp-blame .panel .row')).toHaveCount(2);
  expect(await violations(page)).toEqual([]);
  expect(warnings).toEqual([]);
});
