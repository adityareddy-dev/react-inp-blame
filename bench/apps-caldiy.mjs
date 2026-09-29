// cal.diy (github.com/calcom/cal.diy), apps/web: the signed-in side of a scheduling app. Next.js
// 16.2, React 18.2 in package.json (the App Router runs the React that Next.js bundles), App Router
// pages with tRPC and React Query underneath, and a Pages Router beside them. Postgres behind it.
//
// Two configurations only, A and B, each its own `next build` into its own distDir and its own
// `next start`: A on 5325, B on 5326. Run it with BENCH_ORDER=A,B, since bench.mjs defaults to A,B,C.
//
// What makes this app unlike the others here:
//
// - It needs a database, and a signed-in user. The database is `calendso` in the Docker container
//   bench-pg, migrated and seeded with the repository's own seed (the seed's own user and their
//   ten event types, see caldiy-login.mjs). `prepare` does that when it is missing.
// - It bakes its public URL into the build (NEXT_PUBLIC_WEBAPP_URL, NEXTAUTH_URL and friends), so
//   each build is built and started with its own origin, http://127.0.0.1:5325 or :5326. Neither
//   URL is in the clone's .env, so a build can never pick up the other one's.
// - Sign-in happens outside the measured page: caldiy-login.mjs signs in once per build origin and
//   saves Playwright storage state (state/caldiy-A.json, state/caldiy-B.json); contextOptions hands
//   each run the file of its own build. startServer checks the saved state against the server it
//   just started and signs in again only when it is missing or no longer valid.
// - Next.js 16.2 has no `instrumentationClientInject`, so the README's setup for 15.3 to 16.2 needs a
//   line in apps/web/instrumentation-client.ts as well as the wrapper. That line would ship in A too
//   if it stayed in the file, so `build` writes the file per configuration (A untouched, B with the
//   line) and puts the original back afterwards.
// - The steps change data (an event type's Hidden switch) and have to leave it as they found it.
//   They switch it off and back on; contextOptions puts it back before each run in case a failed
//   run stopped in between.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { settle, pollFor, waitForHttp, killTree } from './helpers.mjs';
import { ensureSignedIn, statePath, user } from './caldiy-login.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'clones', 'caldiy');
const WEB = path.join(ROOT, 'apps', 'web');
const NEXT_BIN = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
const YARN = path.join(ROOT, '.yarn', 'releases', 'yarn-4.12.0.cjs');
const INSTRUMENTATION_CLIENT = path.join(WEB, 'instrumentation-client.ts');

const COMMIT = '54343aa685ae8f33159d2f485ec4a57bad5c574a';
const DB = 'calendso';
const PG = 'bench-pg';
const PORTS = { A: 5325, B: 5326 };
const DISTS = { A: '.next-a', B: '.next-b' };
const originOf = (config) => `http://127.0.0.1:${PORTS[config]}`;

// No telemetry from Next.js, cal.diy, turbo, Prisma or husky, at build time or at run time.
const QUIET = {
  NEXT_TELEMETRY_DISABLED: '1',
  CALCOM_TELEMETRY_DISABLED: '1',
  TURBO_TELEMETRY_DISABLED: '1',
  DO_NOT_TRACK: '1',
  CHECKPOINT_DISABLE: '1',
  HUSKY: '0',
};

/** Everything that carries the app's own origin. Given to `next build` and `next start` alike. */
function urlEnv(config) {
  const origin = originOf(config);
  return {
    NEXT_PUBLIC_WEBAPP_URL: origin,
    NEXT_PUBLIC_WEBSITE_URL: origin,
    NEXTAUTH_URL: `${origin}/api/auth`,
    NEXT_PUBLIC_EMBED_LIB_URL: `${origin}/embed/embed.js`,
  };
}

// The clone's root .env (gitignored there), which next.config.ts, Prisma and the seed all read.
// Local database, dummy local-only secrets. The public URLs are deliberately not in it: see urlEnv.
const DOTENV = `# Benchmark only (react-inp-blame bench, apps-caldiy.mjs). Local database, dummy local secrets.
# The public URLs are deliberately absent: they differ per build (A 127.0.0.1:5325, B 127.0.0.1:5326)
# and are passed in the environment of \`next build\` and \`next start\` for each one.
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/${DB}"
DATABASE_DIRECT_URL="postgresql://postgres:postgres@127.0.0.1:5432/${DB}"
NEXTAUTH_SECRET="bench-local-only-nextauth-secret-0001"
CALENDSO_ENCRYPTION_KEY="bench-local-only-encryption-0001"
CRON_API_KEY="bench-local-only-cron-key-0001"
CRON_ENABLE_APP_SYNC=false
CALCOM_TELEMETRY_DISABLED=1
NEXT_TELEMETRY_DISABLED=1
EMAIL_FROM="notifications@yourselfhostedcal.com"
EMAIL_FROM_NAME="Cal.diy"
EMAIL_SERVER_HOST="localhost"
EMAIL_SERVER_PORT=1025
NEXT_PUBLIC_APP_NAME="Cal.diy"
NEXT_PUBLIC_SUPPORT_MAIL_ADDRESS="help@cal.diy"
NEXT_PUBLIC_COMPANY_NAME="Cal.com, Inc."
API_KEY_PREFIX=cal_
TASKER_ENABLE_WEBHOOKS=0
TASKER_ENABLE_EMAILS=0
`;

/**
 * Writes DOTENV to `dotenv`. A .env of the user's own (say one made from cal.diy's .env.example) is
 * moved to .env.before-bench first, once. If that file is taken already, it stops and names both
 * rather than lose either. An older text of the harness's own is simply replaced.
 */
export function writeDotenv(dotenv) {
  if (fs.existsSync(dotenv)) {
    const text = fs.readFileSync(dotenv, 'utf8');
    if (text === DOTENV) return;
    if (!text.startsWith(DOTENV.slice(0, DOTENV.indexOf(')') + 1))) {
      const kept = `${dotenv}.before-bench`;
      if (fs.existsSync(kept)) {
        throw new Error(`${path.relative(HERE, dotenv)} is not the benchmark's, and ${path.relative(HERE, kept)} already holds an earlier one. Move one of them away and run again`);
      }
      fs.renameSync(dotenv, kept);
      console.log(`moved your ${path.relative(HERE, dotenv)} to ${path.relative(HERE, kept)} and wrote the benchmark's own`);
    }
  }
  fs.writeFileSync(dotenv, DOTENV);
}

/** The signed-in user's email as a SQL string literal, any single quote in it doubled. */
const userEmailSql = () => `'${user().email.replaceAll("'", "''")}'`;

/** One SQL statement in the benchmark database, through the container's own psql. */
function psql(sql, db = DB) {
  const r = spawnSync('docker', ['exec', PG, 'psql', '-U', 'postgres', '-d', db, '-tAc', sql], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`psql failed: ${sql}\n${r.stderr}`);
  return r.stdout.trim();
}

// ---------------------------------------------------------------- instrumentation-client.ts

// The README for 15.3 to 16.2: "If the file already exports an onRouterTransitionStart, as Sentry's
// setup has it do, call this one from yours". cal.diy's does, so the one-line re-export would be a
// duplicate export; B gets the README's other form instead, the import plus a call in the existing
// function. Everything else in the file, Sentry's guard included, is left as it is.
const LINE_IMPORT = `import { onRouterTransitionStart as inpBlame } from "react-inp-blame/next-client";`;

function withNextClientLine(original) {
  let s = original.replace(/\r\n/g, '\n');
  const swap = (from, to) => {
    if (s.split(from).length !== 2) throw new Error(`instrumentation-client.ts has changed: ${JSON.stringify(from)} not found once`);
    s = s.replace(from, to);
  };
  swap(`import { initBotId } from "botid/client/core";\n`, `import { initBotId } from "botid/client/core";\n${LINE_IMPORT}\n`);
  swap(
    `export function onRouterTransitionStart(url: string, navigationType: "push" | "replace" | "traverse") {\n`,
    `export const onRouterTransitionStart: typeof inpBlame = (url, navigationType, event) => {\n  inpBlame(url, navigationType, event);\n`,
  );
  swap(
    `    Sentry.captureRouterTransitionStart(url, navigationType);\n  }\n}\n`,
    `    Sentry.captureRouterTransitionStart(url, navigationType);\n  }\n};\n`,
  );
  return s;
}

/** Every .js under the build's static chunks: does any of it mention the library? */
function buildMentionsLibrary(dist) {
  const root = path.join(WEB, dist, 'static');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (walk(p)) return true;
      } else if (e.name.endsWith('.js')) {
        const text = fs.readFileSync(p, 'utf8');
        if (text.includes('__REACT_INP_BLAME__') || text.includes('react-inp-blame')) return true;
      }
    }
    return false;
  };
  return walk(root);
}

// ---------------------------------------------------------------- server

/**
 * One `next start` for `config`, on its own origin. With `signIn`, the saved sign-in state for that
 * build is checked against the running server and renewed if it is missing or invalid.
 */
export async function startCalDiy(config, { signIn = true, port = PORTS[config] } = {}) {
  if (port !== PORTS[config]) throw new Error(`cal-diy ${config} is built for port ${PORTS[config]}, not ${port}`);
  const origin = originOf(config);
  const child = spawn(process.execPath, [NEXT_BIN, 'start', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd: WEB,
    env: {
      ...process.env,
      ...QUIET,
      ...urlEnv(config),
      BENCH_CONFIG: config === 'A' ? '' : config.toLowerCase(),
      BENCH_OUTDIR: DISTS[config],
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = [];
  child.stdout.on('data', (d) => output.push(String(d)));
  child.stderr.on('data', (d) => output.push(String(d)));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null && !child.benchKilled) {
      process.stdout.write(`  next start (${DISTS[config]}) exited ${code}\n${output.join('').slice(-2000)}\n`);
    }
  });
  try {
    await waitForHttp(`${origin}/auth/login`, 180000);
    if (signIn && (await ensureSignedIn(config, origin))) {
      process.stdout.write(`  cal-diy ${config}: signed in as ${user().email}, state saved\n`);
    }
  } catch (err) {
    killTree(child);
    throw new Error(`${err.message}\n${output.join('').slice(-2000)}`);
  }
  return { close: (done) => { killTree(child); setTimeout(done, 300); } };
}

// ---------------------------------------------------------------- page helpers

const EVENT = { title: '30min', slug: '30min' };
let userTimeZone = null;

const titleOf30 = (page) => page.locator('[data-testid^="event-type-title-"]', { hasText: /^30min$/ }).first();
const rowOf30 = (page) => page.locator('[data-testid="event-types"] > li').filter({ has: titleOf30(page) }).first();
const hiddenSwitch = (page) => rowOf30(page).locator('button[role="switch"]').first();
const searchInput = (page) => page.locator('input[type="search"]').first();
const listTitles = (page) =>
  page.locator('[data-testid="event-types"] > li [data-testid^="event-type-title-"]').allInnerTexts();
const advancedSwitch = (page) => page.locator('[data-testid="requires-booker-email-verification"]').first();

/** Clicks the Hidden switch and waits for the server to have saved it. */
async function flipHidden(page) {
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/trpc/eventTypesHeavy/update') && r.request().method() === 'POST',
    { timeout: 60000 },
  );
  saved.catch(() => {}); // if the click throws, that is the error worth reporting
  await hiddenSwitch(page).click();
  const res = await saved;
  if (!res.ok()) throw new Error(`saving the Hidden switch failed: HTTP ${res.status()}`);
}

/** The event type's hidden flag as the database has it. */
const hiddenInDb = () =>
  psql(
    `SELECT hidden FROM "EventType" WHERE slug = '${EVENT.slug}' AND "userId" = (SELECT id FROM users WHERE email = ${userEmailSql()})`,
  );

// A soft navigation keeps the document, so a marker put on window before it is still there after.
// A hard navigation would also have thrown away the collector's entries, so this is checked.
const markDocument = (page) => page.evaluate(() => (window.__caldiyDoc = (window.__caldiyDoc || 0) + 1));
const sameDocument = (page, mark) => page.evaluate((m) => window.__caldiyDoc === m, mark);

// ---------------------------------------------------------------- the app

export const apps = {
  'cal-diy': {
    id: 'cal-diy',
    title: 'cal.diy apps/web, signed in (Next.js 16.2, App Router, tRPC)',
    dir: WEB,
    repoDir: ROOT,
    dists: DISTS,
    assetsDir: 'static',
    ports: PORTS,
    path: '/event-types',
    startServer: (config, port) => startCalDiy(config, { port }),

    // Each run starts signed in, from its own build's state. Before that, the one row the steps
    // write to is put back the way the seed has it, in case an earlier run failed between switching
    // it off and switching it back on. Normally this changes nothing, and says so when it does.
    async contextOptions(config) {
      const fixed = psql(
        `WITH fixed AS (UPDATE "EventType" SET hidden = false WHERE slug = '${EVENT.slug}' AND hidden = true AND "userId" = (SELECT id FROM users WHERE email = ${userEmailSql()}) RETURNING id) SELECT id FROM fixed`,
      );
      if (fixed) process.stdout.write(`(reset: event type ${fixed} was left hidden by an earlier run) `);
      const state = statePath(config);
      if (!fs.existsSync(state)) throw new Error(`no sign-in state at ${path.relative(HERE, state)}; startServer should have written it`);
      // The browser's time zone is the signed-in user's own (the seed's Europe/London). Otherwise
      // the app opens a "Want to update your timezone?" dialog over the page on every load, and
      // what it shows depends on the machine the benchmark runs on.
      userTimeZone ??= psql(`SELECT "timeZone" FROM users WHERE email = ${userEmailSql()}`);
      return { storageState: state, timezoneId: userTimeZone };
    },

    // The clone is made and changed by hand (bench/README.md has the commands and says what changes);
    // this only reads it. Then yarn 4 from the repository's own .yarn/releases (what corepack would
    // run), at the root.
    install(run) {
      if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
        throw new Error(
          `no clone at ${ROOT}. Make it first:\n` +
            `  git clone https://github.com/calcom/cal.diy.git clones/caldiy\n` +
            `  git -C clones/caldiy checkout ${COMMIT}`,
        );
      }
      if (!fs.readFileSync(path.join(WEB, 'package.json'), 'utf8').includes('"react-inp-blame"')) {
        throw new Error(`${ROOT} is not set up for the benchmark yet: make the changes bench/README.md lists for cal.diy first`);
      }
      run(process.execPath, [YARN, 'install'], { cwd: ROOT, env: { ...process.env, ...QUIET }, shell: false });
    },

    // Everything the two builds share: the clone's .env, written whenever its text isn't DOTENV (see
    // writeDotenv), then each other part only when it is missing: the database (created, migrated,
    // seeded by the repository's own seed), and the three steps the repository's Dockerfile runs
    // before `next build` (the tRPC types, the embed bundle, the app store's static files).
    prepare(run) {
      const env = { ...process.env, ...QUIET };
      writeDotenv(path.join(ROOT, '.env'));

      if (psql(`SELECT 1 FROM pg_database WHERE datname = '${DB}'`, 'postgres') !== '1') {
        run('docker', ['exec', PG, 'createdb', '-U', 'postgres', DB], { shell: false });
      }
      // Idempotent, and quick when there is nothing to apply.
      run(process.execPath, [YARN, 'workspace', '@calcom/prisma', 'db-deploy'], { cwd: ROOT, env, shell: false });
      if (psql(`SELECT count(*) FROM users WHERE email = ${userEmailSql()}`) === '0') {
        run(process.execPath, [YARN, 'db-seed'], { cwd: path.join(ROOT, 'packages', 'prisma'), env, shell: false });
      }

      if (!fs.existsSync(path.join(ROOT, 'packages', 'trpc', 'types', 'server'))) {
        run(process.execPath, [YARN, 'workspace', '@calcom/trpc', 'run', 'build'], { cwd: ROOT, env, shell: false });
      }
      if (!fs.existsSync(path.join(WEB, 'public', 'embed', 'embed.js'))) {
        run(process.execPath, [YARN, 'workspace', '@calcom/embed-core', 'run', 'build'], { cwd: ROOT, env, shell: false });
      }
      if (!fs.existsSync(path.join(WEB, 'public', 'app-store'))) {
        run(process.execPath, [YARN, 'workspace', '@calcom/web', 'run', 'copy-app-store-static'], { cwd: ROOT, env, shell: false });
      }
    },

    // `next build` in apps/web, as the repository's own build script runs it, minus the Sentry
    // release upload that follows it there. instrumentation-client.ts is written for this build and
    // put back afterwards; a build killed half way leaves B's version behind, which the next build
    // notices and undoes from git before it reads the file.
    build(run, env) {
      const config = { '': 'A', b: 'B' }[env.BENCH_CONFIG ?? ''];
      if (!config) throw new Error(`cal-diy has no configuration ${JSON.stringify(env.BENCH_CONFIG)}; it builds A and B only`);
      if (fs.readFileSync(INSTRUMENTATION_CLIENT, 'utf8').includes(LINE_IMPORT)) {
        run('git', ['checkout', '--', 'apps/web/instrumentation-client.ts'], { cwd: ROOT, shell: false });
      }
      const original = fs.readFileSync(INSTRUMENTATION_CLIENT, 'utf8');
      fs.writeFileSync(INSTRUMENTATION_CLIENT, config === 'B' ? withNextClientLine(original) : original);
      try {
        run(process.execPath, [NEXT_BIN, 'build'], {
          cwd: WEB,
          env: { ...env, ...QUIET, ...urlEnv(config), NODE_OPTIONS: '--max-old-space-size=12288' },
          shell: false,
        });
      } finally {
        fs.writeFileSync(INSTRUMENTATION_CLIENT, original);
      }
      // The whole point of A is that nothing from the library reaches the browser.
      const mentions = buildMentionsLibrary(DISTS[config]);
      if (config === 'A' && mentions) throw new Error('build A carries react-inp-blame in its client chunks');
      if (config === 'B' && !mentions) throw new Error('build B carries nothing from react-inp-blame in its client chunks');
    },

    async ready(page) {
      if (/\/auth\/login/.test(page.url())) {
        throw new Error('landed on the login page: the saved sign-in state is not valid for this build');
      }
      await page.locator('[data-testid="event-types"] > li').nth(4).waitFor({ timeout: 60000 });
      await hiddenSwitch(page).waitFor({ timeout: 60000 });
      await searchInput(page).waitFor({ timeout: 60000 });
      await settle(page, 500, 60000);
    },

    steps: [
      {
        // The Hidden switch on one row of the list. The click runs an optimistic update through
        // React Query's cache, so the whole list re-renders before the save has even left.
        name: 'hide-event-type',
        async before(page) {
          const state = await hiddenSwitch(page).getAttribute('aria-checked');
          if (state !== 'true') throw new Error(`${EVENT.title} is already hidden (aria-checked ${state}); the reset did not work`);
          return {};
        },
        async run(page) {
          await flipHidden(page);
        },
        async assert(page) {
          const state = await pollFor(() => hiddenSwitch(page).getAttribute('aria-checked'), (s) => s === 'false', 20000);
          if (state !== 'false') throw new Error(`Hidden switch is aria-checked ${state} after switching it off`);
          const db = await pollFor(async () => hiddenInDb(), (v) => v === 't', 20000);
          if (db !== 't') throw new Error(`the database still has ${EVENT.title} visible (hidden = ${db}); the save never landed`);
          return {};
        },
      },
      {
        // The same switch back on, which also puts the data back the way the run found it.
        name: 'show-event-type',
        async run(page) {
          await flipHidden(page);
        },
        async assert(page) {
          const state = await pollFor(() => hiddenSwitch(page).getAttribute('aria-checked'), (s) => s === 'true', 20000);
          if (state !== 'true') throw new Error(`Hidden switch is aria-checked ${state} after switching it back on`);
          const db = await pollFor(async () => hiddenInDb(), (v) => v === 'f', 20000);
          if (db !== 'f') throw new Error(`the database still has ${EVENT.title} hidden (hidden = ${db}); the run did not restore it`);
          return {};
        },
      },
      {
        // The search box above the list, a key at a time. Every key re-renders everything under the
        // search context at once; the server-side filter lands after a 500 ms debounce.
        name: 'search-type-30m',
        async before(page) {
          return { rows: (await listTitles(page)).length };
        },
        async run(page) {
          await searchInput(page).click();
          await page.keyboard.type('30m', { delay: 120 });
        },
        async assert(page, before) {
          const value = await searchInput(page).inputValue();
          if (value !== '30m') throw new Error(`search box holds ${JSON.stringify(value)}, expected "30m"`);
          const titles = await pollFor(
            () => listTitles(page),
            (t) => t.length > 0 && t.length < before.rows && t.every((x) => /30m/i.test(x)),
            30000,
          );
          if (!(titles.length > 0 && titles.length < before.rows && titles.every((x) => /30m/i.test(x)))) {
            throw new Error(`the list never filtered: ${before.rows} rows before, now ${JSON.stringify(titles)}`);
          }
          return {};
        },
      },
      {
        // Opening the one result: an App Router soft navigation to the event type's editor.
        name: 'open-event-type',
        async before(page) {
          return { mark: await markDocument(page) };
        },
        async run(page) {
          await titleOf30(page).click();
        },
        async assert(page, before) {
          const url = await pollFor(async () => page.url(), (u) => /\/event-types\/\d+\?tabName=setup/.test(u), 60000);
          if (!/\/event-types\/\d+\?tabName=setup/.test(url)) throw new Error(`still on ${url}; the editor never opened`);
          const title = page.locator('[data-testid="event-title"]');
          await title.waitFor({ timeout: 60000 });
          const value = await title.inputValue();
          if (value !== EVENT.title) throw new Error(`the editor's title is ${JSON.stringify(value)}, expected "${EVENT.title}"`);
          if (!(await sameDocument(page, before.mark))) throw new Error('the editor opened with a full page load, not a soft navigation');
          return {};
        },
      },
      {
        // One letter in the title field of the editor's form. Never saved: the form is left dirty
        // and the run leaves the page without saving.
        name: 'event-title-type-letter',
        async before(page) {
          await settle(page, 400, 60000);
          return {};
        },
        async run(page) {
          await page.locator('[data-testid="event-title"]').click();
          await page.keyboard.press('x');
        },
        async assert(page) {
          const value = await page.locator('[data-testid="event-title"]').inputValue();
          if (value !== `${EVENT.title}x`) throw new Error(`title is ${JSON.stringify(value)}, expected "${EVENT.title}x"`);
          return {};
        },
      },
      {
        // The editor's Advanced tab, from the vertical tab list: a soft navigation to the same page
        // with ?tabName=advanced, which mounts the tab's form section.
        name: 'advanced-tab',
        async before(page) {
          return { mark: await markDocument(page) };
        },
        async run(page) {
          await page.locator('a[href*="tabName=advanced"]').filter({ visible: true }).first().click();
        },
        async assert(page, before) {
          const url = await pollFor(async () => page.url(), (u) => u.includes('tabName=advanced'), 30000);
          if (!url.includes('tabName=advanced')) throw new Error(`URL is ${url}; the Advanced tab never opened`);
          await advancedSwitch(page).waitFor({ timeout: 60000 });
          if (!(await sameDocument(page, before.mark))) throw new Error('the tab opened with a full page load');
          return {};
        },
      },
      {
        // One switch on the Advanced tab ("Requires booker email verification"). Form state only,
        // never saved.
        name: 'advanced-switch',
        async before(page) {
          await settle(page, 400, 60000);
          return { state: await advancedSwitch(page).getAttribute('aria-checked') };
        },
        async run(page) {
          await advancedSwitch(page).click();
        },
        async assert(page, before) {
          const state = await pollFor(() => advancedSwitch(page).getAttribute('aria-checked'), (s) => s !== before.state, 20000);
          if (state === before.state) throw new Error(`the switch is still aria-checked ${state}; it never flipped`);
          return {};
        },
      },
      {
        // The editor's back arrow: a soft navigation back to the list, leaving the unsaved edits.
        // The list comes back whole (the search lived in the page that was left) and with the
        // Hidden switch on, which is the state the run started from.
        name: 'back-to-event-types',
        async before(page) {
          return { mark: await markDocument(page) };
        },
        async run(page) {
          await page.locator('[data-testid="go-back-button"]').first().click();
        },
        async assert(page, before) {
          const url = await pollFor(async () => page.url(), (u) => /\/event-types(\?|$)/.test(u), 60000);
          if (!/\/event-types(\?|$)/.test(url)) throw new Error(`URL is ${url}; the list never came back`);
          const titles = await pollFor(() => listTitles(page), (t) => t.length >= 5, 60000);
          if (titles.length < 5) throw new Error(`the list has ${titles.length} rows after going back`);
          const state = await hiddenSwitch(page).getAttribute('aria-checked');
          if (state !== 'true') throw new Error(`${EVENT.title} is hidden after the run (aria-checked ${state})`);
          if (!(await sameDocument(page, before.mark))) throw new Error('went back with a full page load');
          return {};
        },
      },
    ],
  },
};
