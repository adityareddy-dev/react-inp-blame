// caldiy-login.mjs signs in to cal.diy once per build and saves Playwright storage state, so no
// run of the benchmark ever passes through the login page.
//
//   node caldiy-login.mjs          # A and B; starts `next start` for a build that is not answering
//   node caldiy-login.mjs B        # one build
//
// Each build is its own origin, A http://127.0.0.1:5325 and B http://127.0.0.1:5326, and bakes that
// origin into itself (NEXT_PUBLIC_WEBAPP_URL, NEXTAUTH_URL; see apps-caldiy.mjs). Cookies do not
// separate by port, so the two sign-ins never share a browser context: one context holding both
// would hold a single next-auth.session-token for 127.0.0.1, whichever came last. Each build gets
// its own sign-in in a fresh context and its own file, state/caldiy-A.json and state/caldiy-B.json,
// and bench.mjs hands each run the file of its own configuration through contextOptions.
//
// bench.mjs does not need this script run by hand: the app's startServer checks the saved state
// against the server it just started and signs in again only when the state is missing or no longer
// valid. The script is for doing it up front, or after the database was re-seeded.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localOrigin } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The user to sign in as: the repository seed's own, with the event types the benchmark walks through,
 * unless CALDIY_EMAIL and CALDIY_PASSWORD name another on your local cal.diy. Only ever sent to 127.0.0.1.
 */
export const user = () => ({
  email: process.env.CALDIY_EMAIL || 'pro@example.com',
  password: process.env.CALDIY_PASSWORD || 'pro',
});

export const statePath = (config) => path.join(HERE, 'state', `caldiy-${config}.json`);

/**
 * Whether the saved state still signs `origin` in as the seeded user. Asked of the server itself,
 * through next-auth's session route, with the saved cookies, so a changed NEXTAUTH_SECRET or a
 * re-seeded database shows up here rather than as a login page in the middle of a run.
 */
export async function stateIsValid(config, origin) {
  localOrigin(origin);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath(config), 'utf8'));
  } catch {
    return false;
  }
  const soon = Date.now() / 1000 + 24 * 3600;
  const cookie = (state.cookies ?? [])
    .filter((c) => c.domain === '127.0.0.1' && (c.expires === -1 || c.expires > soon))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  if (!cookie.includes('next-auth.session-token=')) return false;
  try {
    const res = await fetch(`${origin}/api/auth/session`, { headers: { cookie } });
    const body = await res.json();
    return body?.user?.email === user().email;
  } catch {
    return false;
  }
}

/** Signs in through the app's own login form in a fresh context and saves that context's state. */
export async function signIn(config, origin) {
  localOrigin(origin);
  const { email, password } = user();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(`${origin}/auth/login`, { waitUntil: 'load', timeout: 120000 });
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.locator('form[data-testid="login-form"] button[type="submit"]').click();
    await page.waitForURL(/\/event-types/, { timeout: 120000 });
    await page.locator('[data-testid="event-types"] li').first().waitFor({ timeout: 120000 });
    fs.mkdirSync(path.dirname(statePath(config)), { recursive: true });
    await context.storageState({ path: statePath(config) });
  } finally {
    await browser.close();
  }
  if (!(await stateIsValid(config, origin))) {
    throw new Error(`signed in to ${origin}, but the saved state does not hold a valid session`);
  }
}

/** Signs in only when the saved state is missing or no longer valid. Returns whether it signed in. */
export async function ensureSignedIn(config, origin) {
  if (await stateIsValid(config, origin)) return false;
  await signIn(config, origin);
  return true;
}

// ---------------------------------------------------------------- CLI

// Not a top-level await: apps-caldiy.mjs imports this module, and awaiting it here would deadlock.
async function main() {
  const { apps, startCalDiy } = await import('./apps-caldiy.mjs');
  const app = apps['cal-diy'];
  const configs = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(app.ports);
  for (const config of configs) {
    if (!app.ports[config]) throw new Error(`no configuration ${config}; cal-diy has ${Object.keys(app.ports).join(', ')}`);
    const origin = `http://127.0.0.1:${app.ports[config]}`;
    let server = null;
    try {
      await fetch(`${origin}/auth/login`, { redirect: 'manual' });
    } catch {
      server = await startCalDiy(config, { signIn: false });
    }
    try {
      await signIn(config, origin);
      console.log(`${config} ${origin} signed in -> ${path.relative(HERE, statePath(config))}`);
    } finally {
      if (server) await new Promise((r) => server.close(r));
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
