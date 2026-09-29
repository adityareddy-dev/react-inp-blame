// twenty-login.mjs: signs in to twenty once per build origin and saves Playwright storage state,
// so no run of the benchmark ever passes through the login page.
//
//   node twenty-login.mjs          # A and B; starts the fronts (and the server) if not answering
//   node twenty-login.mjs B        # one build
//
// A is http://127.0.0.1:5322 and B http://127.0.0.1:5323. twenty keeps the session in an httpOnly
// cookie (user-session) that is host-only, and cookies do not separate by port, so each build signs
// in in a fresh context of its own and gets its own file: state/twenty-A.json, state/twenty-B.json.
// bench.mjs hands each run its configuration's file through contextOptions.
//
// bench.mjs does not need this run by hand: the app's startServer checks the saved state against
// the server it just started and signs in again only when the state is missing or no longer valid
// (a re-seeded database, a changed APP_SECRET, an expired session).

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localOrigin } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The user to sign in as: the dev seed's own (twenty-e2e-testing/.env.example), unless TWENTY_EMAIL and
 * TWENTY_PASSWORD name another on your local twenty. Only ever sent to 127.0.0.1.
 * tim@apple.dev is twenty's upstream seed account, published in its repository, not anyone's own sign-in.
 */
export const user = () => ({
  email: process.env.TWENTY_EMAIL || 'tim@apple.dev',
  password: process.env.TWENTY_PASSWORD || 'tim@apple.dev',
});

export const statePath = (config) => path.join(HERE, 'state', `twenty-${config}.json`);

/**
 * Whether the saved state still signs `origin` in as the seeded user. Asked of the server itself,
 * through the front's own origin and with the saved cookie, so a re-seeded database shows up here
 * rather than as a login page in the middle of a run.
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
  if (!cookie) return false;
  try {
    const res = await fetch(`${origin}/metadata`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ query: '{ currentUser { email } }' }),
    });
    const body = await res.json();
    return body?.data?.currentUser?.email === user().email;
  } catch {
    return false;
  }
}

/** Signs in through twenty's own login form in a fresh context and saves that context's state. */
export async function signIn(config, origin) {
  localOrigin(origin);
  const { email, password } = user();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${origin}/`, { waitUntil: 'load', timeout: 120000 });
    // The same path as twenty's e2e login setup (twenty-e2e-testing/tests/login.setup.ts).
    const withEmail = page.getByRole('button', { name: 'Continue with Email' });
    await withEmail.or(page.getByPlaceholder('Email')).first().waitFor({ timeout: 60000 });
    if (await withEmail.isVisible()) await withEmail.click();
    await page.getByPlaceholder('Email').fill(email, { timeout: 30000 });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByPlaceholder('Password').fill(password, { timeout: 30000 });
    await page.getByRole('button', { name: 'Sign in' }).click();
    // The seed's own user belongs to two seeded workspaces; when twenty asks, pick Apple.
    const chooser = page.getByText('Choose a workspace');
    const signedIn = () => /\/objects\//.test(page.url());
    const deadline = Date.now() + 90000;
    while (!signedIn()) {
      if (await chooser.isVisible().catch(() => false)) {
        await page.getByText('Apple', { exact: true }).click();
      }
      if (Date.now() > deadline) throw new Error(`sign-in never reached a record page; stuck on ${page.url()}`);
      await page.waitForTimeout(250);
    }
    await page.locator('[data-testid^="row-id-"]').first().waitFor({ timeout: 60000 });
    fs.mkdirSync(path.dirname(statePath(config)), { recursive: true });
    await context.storageState({ path: statePath(config) });
    await context.close();
  } finally {
    await browser.close();
  }
  if (!(await stateIsValid(config, origin))) {
    throw new Error(`signed in on ${origin}, but the saved state does not pass the server check`);
  }
}

/** Signs in only when the saved state is missing or no longer valid for `origin`. */
export async function ensureSignedIn(config, origin) {
  if (await stateIsValid(config, origin)) return false;
  await signIn(config, origin);
  return true;
}

// ---------------------------------------------------------------- command line

// No top-level await: apps-twenty.mjs imports this module, and a module still waiting at the top
// level would never finish loading for it.
async function main() {
  const { apps } = await import('./apps-twenty.mjs');
  const app = apps.twenty;
  const configs = process.argv.slice(2).length ? process.argv.slice(2) : ['A', 'B'];
  const servers = [];
  try {
    // startServer signs in as part of starting, which is the whole job here.
    for (const c of configs) {
      const t0 = Date.now();
      servers.push(await app.startServer(c, app.ports[c]));
      console.log(`twenty ${c}: signed in, ${statePath(c)} (${Date.now() - t0} ms)`);
    }
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
