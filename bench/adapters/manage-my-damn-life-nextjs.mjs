// Adapter for manage-my-damn-life-nextjs (intri-in/manage-my-damn-life-nextjs, pinned 49dd7d5).
// Next.js 15.5 production builds with PostgreSQL 16 as the database (DB_DIALECT=postgres), a seeded local
// user, and the interaction steps frozen in manage-my-damn-life-nextjs.cases.json.
//
// Bench-only files written into the clone (never committed): next.config.js selects the build
// from BENCH_CONFIG/BENCH_OUTDIR, bench.next.base.js is the verbatim upstream config, and
// bench.next.library.js (B and C only) wraps it with the library's build plugin. src/instrumentation-client.ts
// exists only for B and C, because Next.js 15.5 needs it to load the library before hydration.
// public/bench/team-calendar.ics and public/bench/holiday-calendar.ics are the webcal fixtures the app
// fetches from its own origin.

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { killTree, pollFor, waitForHttp } from '../helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLONE = path.join(HERE, '..', 'clones', 'manage-my-damn-life-nextjs');
const STATE = path.join(HERE, '..', 'state', 'manage-my-damn-life-nextjs');
const req = createRequire(path.join(CLONE, 'package.json'));
const USER = 'bench-user';
const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//react-inp-blame bench fixture//EN
CALSCALE:GREGORIAN
BEGIN:VEVENT
UID:bench-team-0001@example.test
DTSTAMP:20260901T090000Z
DTSTART:20260915T090000Z
DTEND:20260915T093000Z
SUMMARY:Planning review
END:VEVENT
BEGIN:VEVENT
UID:bench-team-0002@example.test
DTSTAMP:20260901T090000Z
DTSTART:20261001T130000Z
DTEND:20261001T140000Z
SUMMARY:Design critique
END:VEVENT
BEGIN:VEVENT
UID:bench-team-0003@example.test
DTSTAMP:20260901T090000Z
DTSTART:20261014T100000Z
DTEND:20261014T103000Z
SUMMARY:Stand-up
END:VEVENT
BEGIN:VEVENT
UID:bench-team-0004@example.test
DTSTAMP:20260901T090000Z
DTSTART:20261016T150000Z
DTEND:20261016T160000Z
SUMMARY:Customer call
END:VEVENT
BEGIN:VEVENT
UID:bench-team-0005@example.test
DTSTAMP:20260901T090000Z
DTSTART:20261021T080000Z
DTEND:20261021T090000Z
SUMMARY:Release rehearsal
END:VEVENT
BEGIN:VEVENT
UID:bench-team-0006@example.test
DTSTAMP:20260901T090000Z
DTSTART:20261028T170000Z
DTEND:20261028T180000Z
SUMMARY:Retrospective
END:VEVENT
BEGIN:VEVENT
UID:bench-team-0007@example.test
DTSTAMP:20260901T090000Z
DTSTART:20261104T110000Z
DTEND:20261104T120000Z
SUMMARY:Budget check-in
END:VEVENT
BEGIN:VEVENT
UID:bench-team-0008@example.test
DTSTAMP:20260901T090000Z
DTSTART:20261118T140000Z
DTEND:20261118T150000Z
SUMMARY:Quarterly planning
END:VEVENT
END:VCALENDAR
`;
const HOLIDAY_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//react-inp-blame bench fixture//EN
CALSCALE:GREGORIAN
BEGIN:VEVENT
UID:bench-holiday-0001@example.test
DTSTAMP:20260901T090000Z
DTSTART:20261126T000000Z
DTEND:20261127T000000Z
SUMMARY:Thanksgiving
END:VEVENT
BEGIN:VEVENT
UID:bench-holiday-0002@example.test
DTSTAMP:20260901T090000Z
DTSTART:20261225T000000Z
DTEND:20261226T000000Z
SUMMARY:Christmas Day
END:VEVENT
END:VCALENDAR
`;
const SELECTOR_CONFIG = `// BENCH-ONLY selector, written by the harness adapter. Not committed.
// BENCH_CONFIG is '' (A, no library), 'b' or 'c'; BENCH_OUTDIR names the build output directory.
const base = require('./bench.next.base.js')
const mode = process.env.BENCH_CONFIG || ''
const config = { ...base, distDir: process.env.BENCH_OUTDIR || '.next' }
module.exports = mode === 'b' || mode === 'c' ? require('./bench.next.library.js')(config, mode) : config
`;
const LIBRARY_CONFIG = `// BENCH-ONLY, not committed. Loaded only for configurations B and C.
const { withInpBlame } = require('react-inp-blame/next')

module.exports = (config, mode) =>
  withInpBlame(config, {
    enabled: true,
    runtime: mode === 'c' ? { debugGlobal: true, overlay: true } : { debugGlobal: true },
  })
`;
const INSTRUMENTATION = `// BENCH-ONLY, not committed. Written for configurations B and C only.
export { onRouterTransitionStart } from 'react-inp-blame/next-client';
`;

// ---------------------------------------------------------------- local state and clone files

const file = (...parts) => path.join(STATE, ...parts);
const keyOf = (config) => config.toLowerCase();

// The PostgreSQL 16 cluster listens on 127.0.0.1:5443 and is started outside the adapter. Its superuser and the
// app role's password come from credentials.json and are never printed. Each configuration has its own database.
const PG = { host: '127.0.0.1', port: 5443 };
const dbName = (key) => `mmdl_${key}`;
const servedPort = new Map(); // configuration -> port, so the reset can write this server's webcal link
function pgCredentials() {
  const creds = JSON.parse(fs.readFileSync(file('credentials.json'), 'utf8')).pg;
  if (!creds || !creds.admin || !creds.adminPassword || !creds.user || !creds.password) {
    throw new Error(`${file('credentials.json')} needs pg.admin, pg.adminPassword, pg.user and pg.password`);
  }
  return creds;
}
const pgClient = (database, user, password) => new (req('pg').Client)({ host: PG.host, port: PG.port, database, user, password });
const pgEnv = (key, creds) => ({
  DB_DIALECT: 'postgres',
  DB_HOST: PG.host,
  DB_PORT: String(PG.port),
  DB_NAME: dbName(key),
  DB_USER: creds.user,
  DB_PASS: creds.password,
});

function secrets() {
  fs.mkdirSync(STATE, { recursive: true });
  const make = (name, bytes) => {
    if (!fs.existsSync(file(name))) fs.writeFileSync(file(name), crypto.randomBytes(bytes).toString('hex'), { mode: 0o600 });
    return fs.readFileSync(file(name), 'utf8').trim();
  };
  const token = make('seed-session-token', 32);
  const password = make('seed-user-password', 16);
  return {
    token,
    password,
    aes: make('aes-password', 32),
    nextauth: make('nextauth-secret', 32),
    userhash: crypto.createHash('sha512').update(USER).digest('hex'),
  };
}

function prepareClone() {
  fs.mkdirSync(path.join(CLONE, 'public', 'bench'), { recursive: true });
  fs.writeFileSync(path.join(CLONE, 'public', 'bench', 'team-calendar.ics'), ICS);
  fs.writeFileSync(path.join(CLONE, 'public', 'bench', 'holiday-calendar.ics'), HOLIDAY_ICS);
  const base = path.join(CLONE, 'bench.next.base.js');
  if (!fs.existsSync(base)) {
    fs.writeFileSync(base, execFileSync('git', ['show', 'HEAD:next.config.js'], { cwd: CLONE }));
  }
  fs.writeFileSync(path.join(CLONE, 'next.config.js'), SELECTOR_CONFIG);
  fs.writeFileSync(path.join(CLONE, 'bench.next.library.js'), LIBRARY_CONFIG);
}

// Creates the app role and the configuration databases if they are missing. It runs as the superuser and
// changes nothing else on the cluster.
async function ensureDatabases(keys) {
  const c = pgCredentials();
  const admin = pgClient('postgres', c.admin, c.adminPassword);
  await admin.connect();
  try {
    const role = admin.escapeIdentifier(c.user);
    const roleExists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [c.user])).rowCount > 0;
    await admin.query(`${roleExists ? 'ALTER' : 'CREATE'} ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${admin.escapeLiteral(c.password)}`);
    for (const key of keys) {
      const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName(key)])).rowCount > 0;
      if (!exists) await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(dbName(key))} OWNER ${role}`);
    }
  } finally {
    await admin.end();
  }
}

// Runs the upstream Sequelize migrations on one configuration's database. Sequelize records each applied
// migration in SequelizeMeta, so a repeat run applies only the migrations that are new.
function migrate(key) {
  const creds = pgCredentials();
  const logFile = file(`migrate-${key}.log`);
  const log = fs.openSync(logFile, 'w');
  try {
    execFileSync(path.join(CLONE, 'node_modules', '.bin', 'sequelize-cli'), ['db:migrate', '--env', 'local'], {
      cwd: CLONE,
      env: { ...process.env, ...pgEnv(key, creds) },
      stdio: ['ignore', log, log],
    });
  } catch {
    throw new Error(`migrations for ${dbName(key)} failed; see ${logFile}`);
  } finally {
    fs.closeSync(log);
  }
}

// The rows one configuration starts from: a registered user with a login session, three labels, a filter, a
// template and a webcal subscription whose link names this configuration's port, with the fixture's events.
function seedRows(port) {
  const s = secrets();
  const bcrypt = req('bcryptjs');
  const ical = req('ical');
  const CREATED = '1760000000';
  const parsed = ical.parseICS(ICS);
  const events = Object.keys(parsed).filter((k) => parsed[k].type === 'VEVENT').map((k) => JSON.stringify(parsed[k]));
  return {
    user: [USER, 'bench-user@example.test', bcrypt.hashSync(s.password, 10), CREATED, '0', s.userhash, crypto.createHash('md5').update(USER).digest('hex')],
    session: [s.userhash, crypto.createHash('sha512').update(s.token).digest('hex'), CREATED],
    labels: [['Errands', '#2c7be5'], ['Health', '#00a86b'], ['Home', '#e67e22']],
    filter: ['Errands only', JSON.stringify({ labels: ['Errands'] })],
    template: ['Weekly review', 'TASK', JSON.stringify({ summary: 'Weekly review' })],
    webcal: ['Team calendar', `http://127.0.0.1:${port}/bench/team-calendar.ics`, '#6f42c1', '0', '2026-10-01T00:00:00.000Z'],
    events,
  };
}

// Deterministic reset for one configuration, in one transaction: every application table is emptied with its
// identities restarted, then refilled from the seed rows in the same order as before. The server keeps its pool,
// and its next statement reads the committed rows.
async function resetFromSeed(config) {
  const port = servedPort.get(config);
  if (port === undefined) throw new Error(`no server was started for configuration ${config}`);
  const seed = seedRows(port);
  const creds = pgCredentials();
  const db = pgClient(dbName(keyOf(config)), creds.user, creds.password);
  await db.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'SequelizeMeta'`);
    if (rows.length) await db.query(`TRUNCATE ${rows.map((r) => db.escapeIdentifier(r.tablename)).join(', ')} RESTART IDENTITY CASCADE`);
    const { rows: [{ users_id: uid }] } = await db.query('INSERT INTO users (username, email, password, created, level, userhash, id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING users_id', seed.user);
    const userid = String(uid);
    await db.query('INSERT INTO ssid_table (userhash, ssid, created) VALUES ($1,$2,$3)', seed.session);
    for (const [name, colour] of seed.labels) await db.query('INSERT INTO labels (name, colour, userid) VALUES ($1,$2,$3)', [name, colour, userid]);
    await db.query('INSERT INTO custom_filters (name, filtervalue, userid) VALUES ($1,$2,$3)', [...seed.filter, userid]);
    await db.query('INSERT INTO templates (userid, name, type, data) VALUES ($1,$2,$3,$4)', [userid, ...seed.template]);
    const { rows: [{ id: wid }] } = await db.query(
      'INSERT INTO webcal_accounts (userid, name, link, colour, "updateInterval", "lastFetched") VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [userid, ...seed.webcal],
    );
    for (const data of seed.events) await db.query('INSERT INTO webcal_events (webcal_accounts_id, data) VALUES ($1,$2)', [String(wid), data]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await db.end();
  }
}

const authFor = (s) => 'Basic ' + Buffer.from(`${s.userhash}:${s.token}`).toString('base64');

// ---------------------------------------------------------------- page helpers

const pathOf = (page) => new URL(page.url()).pathname.replace(/\/+$/, '');
const visibleText = (page, text) => page.locator(':visible', { hasText: text }).first();

async function navbar(page, route, marker) {
  if (pathOf(page).startsWith(route)) return;
  await page.locator(`nav a[href="${route}"]`).first().click();
  await page.waitForURL((u) => u.pathname.replace(/\/+$/, '').startsWith(route), { timeout: 20000 });
  await visibleText(page, marker).waitFor({ timeout: 20000 });
}

async function settingsMenu(page, label, route, marker) {
  if (pathOf(page).startsWith(route)) return;
  await page.locator('nav a.dropdown-toggle').first().click();
  await page.locator('.dropdown-item', { hasText: label }).first().click();
  await page.waitForURL((u) => u.pathname.replace(/\/+$/, '').startsWith(route), { timeout: 20000 });
  await visibleText(page, marker).waitFor({ timeout: 20000 });
}

// A toast counts for a step only if it appeared after the step's `before`, so a toast left on screen by an
// earlier step cannot satisfy the step's claim.
const markToasts = (page) => page.evaluate(() => {
  window.__benchToastsBefore = new Set(document.querySelectorAll('.Toastify__toast'));
});
const newToasts = (page) => page.evaluate(() => {
  const seen = window.__benchToastsBefore || new Set();
  return [...document.querySelectorAll('.Toastify__toast')].filter((t) => !seen.has(t)).map((t) => t.innerText.replace(/\s+/g, ' '));
});
const sampleText = (page) => page.evaluate(() => ((document.body.innerText.match(/Sample Output for Date and Time:[^\n]*/) || ['-'])[0]));
const cal = (page) => page.evaluate(() => ({
  view: (document.querySelector('select:has(option[value="listWeek"])') || {}).value ?? null,
  title: (document.querySelector('.fc-toolbar-title') || { innerText: '-' }).innerText,
  headers: document.querySelectorAll('.fc-col-header-cell').length,
  daygrid: document.querySelectorAll('.fc-daygrid-body').length,
  list: document.querySelectorAll('.fc-list').length,
  timegrid: document.querySelectorAll('.fc-timegrid').length,
}));
const viewSelect = (page) => page.locator('select:has(option[value="listWeek"])').first();
// A toolbar title holds one date (Day View) or two (a range), each written in the date format; the default is DD/MM/YYYY.
const titleDates = (title) => (title.match(/\d{2}\/\d{2}\/\d{4}/g) || []).map((d) => Date.UTC(+d.slice(6), +d.slice(3, 5) - 1, +d.slice(0, 2)));
const isRange = (title) => titleDates(title).length === 2;
const isFullMonth = (title) => {
  if (!isRange(title)) return false;
  const [start, end] = titleDates(title).map((t) => new Date(t));
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  return start.getUTCDate() === 1 && end.getUTCDate() === lastDay && end.getUTCMonth() === start.getUTCMonth();
};
const modalOpen = (page) => page.evaluate(() => document.querySelectorAll('.modal.show').length > 0);
const webcalForm = (page) => page.locator('input.form-control[maxlength="50"]:not([type="number"])');

// Waits for `read` to satisfy `ok`, so an assertion sees a change that the app shows a moment later.
async function expectState(label, read, ok, before) {
  const last = await pollFor(read, ok, 15000, 200);
  if (!ok(last)) throw new Error(`${label}: state did not change (before ${JSON.stringify(before)}, after ${JSON.stringify(last)})`);
  return last;
}

async function clickCardIcon(page, heading, index) {
  const handle = await page.evaluateHandle(([h, i]) => {
    const head = [...document.querySelectorAll('h3')].find((e) => e.textContent.trim() === h);
    if (!head) return null;
    let c = head;
    for (let k = 0; k < 6 && c; k++) {
      if (c.querySelector('svg')) break;
      c = c.parentElement;
    }
    return c ? c.querySelectorAll('svg')[i] || null : null;
  }, [heading, index]);
  const el = handle.asElement();
  if (!el) throw new Error(`no "${heading}" card icon ${index} on the page`);
  await el.click({ timeout: 10000 });
}

const cardPresent = (page, heading) => page.evaluate((h) => [...document.querySelectorAll('h3')].some((e) => e.textContent.trim() === h), heading);

async function serverWebcalNames(page, auth) {
  return page.evaluate(async (a) => {
    const r = await fetch('/api/webcal/get', { headers: { authorization: a } });
    const j = await r.json();
    return ((j.data && j.data.message) || []).map((w) => w.name);
  }, auth);
}

const themeAttr = (page) => page.evaluate(() => document.documentElement.getAttribute('data-bs-theme'));
const toggleIcon = (page) => page.locator('nav .ms-auto svg').nth(2);

// ---------------------------------------------------------------- the adapter

const SETTINGS = { route: '/accounts/settings', label: 'Settings', marker: 'General Settings' };
const WEBCAL = { route: '/webcal/manage', label: 'WebCAL Manager', marker: 'Update Interval' };
const TEMPLATES = { route: '/templates/manage', label: 'Template Manager', marker: 'Weekly review' };
const FILTERS = { route: '/filters/manage', label: 'Manage Filters', marker: 'Add New Filter' };
const CALENDAR = { route: '/calendar/view' };
const TASKS = { route: '/tasks/list', marker: 'Gantt View' };

const goCalendar = (page) => navbar(page, CALENDAR.route, 'Show Tasks');
const goTasks = (page) => navbar(page, TASKS.route, TASKS.marker);
const goSettings = (page) => settingsMenu(page, SETTINGS.label, SETTINGS.route, SETTINGS.marker);
const goWebcal = (page) => settingsMenu(page, WEBCAL.label, WEBCAL.route, WEBCAL.marker);
const goTemplates = (page) => settingsMenu(page, TEMPLATES.label, TEMPLATES.route, TEMPLATES.marker);
const goFilters = (page) => settingsMenu(page, FILTERS.label, FILTERS.route, FILTERS.marker);

const gantt = (page) => page.getByRole('button', { name: 'Gantt View', exact: true });
const taskView = (page) => page.getByRole('button', { name: 'Task View', exact: true });
const ganttActive = (page) => gantt(page).evaluate((el) => el.className.includes('btn-secondary'));
// Each view button is 'active' (btn-secondary), 'inactive' (btn-outline-secondary) or 'missing'.
const viewState = (page) => page.evaluate(() => {
  const state = (name) => {
    const b = [...document.querySelectorAll('button')].find((e) => e.textContent.trim() === name);
    if (!b) return 'missing';
    if (b.classList.contains('btn-secondary')) return 'active';
    if (b.classList.contains('btn-outline-secondary')) return 'inactive';
    return 'other';
  };
  return { gantt: state('Gantt View'), task: state('Task View') };
});

export default {
  path: '/setup?redirect=/calendar/view/',
  assetsDir: 'static',
  // Set after the 2026-10-15 protocol revision: every frozen claim is kept or asserted, and the ordered workload passes on A, B and C.
  status: 'ready',

  install(run) {
    run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: CLONE });
  },

  prepare() {
    prepareClone();
  },

  build(run, env) {
    prepareClone();
    const instrumentation = path.join(CLONE, 'src', 'instrumentation-client.ts');
    if (env.BENCH_CONFIG === '') fs.rmSync(instrumentation, { force: true });
    else fs.writeFileSync(instrumentation, INSTRUMENTATION);
    try {
      run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['next', 'build'], { cwd: CLONE, env: { ...env, NEXT_TELEMETRY_DISABLED: '1' } });
    } finally {
      execFileSync('git', ['checkout', '--', 'next-env.d.ts'], { cwd: CLONE });
    }
  },

  async startServer(config, port) {
    const key = keyOf(config);
    secrets();
    prepareClone();
    const creds = pgCredentials();
    await ensureDatabases([key]);
    migrate(key);
    servedPort.set(config, port);
    const env = {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      BENCH_CONFIG: config === 'A' ? '' : key,
      BENCH_OUTDIR: `dist-${key}`,
      ...pgEnv(key, creds),
      AES_PASSWORD: secrets().aes,
      NEXTAUTH_SECRET: secrets().nextauth,
      NEXTAUTH_URL: `http://127.0.0.1:${port}/`,
      USE_NEXT_AUTH: 'false',
      ENFORCE_SESSION_TIMEOUT: 'true',
      MAX_SESSION_LENGTH: '315360000',
      MAX_CONCURRENT_LOGINS_ALLOWED: '3',
      DISABLE_USER_REGISTRATION: 'true',
    };
    const log = fs.openSync(file(`next-${key}.log`), 'w');
    const child = spawn(process.execPath, [path.join(CLONE, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port), '-H', '127.0.0.1'], {
      cwd: CLONE,
      env,
      detached: true,
      stdio: ['ignore', log, log],
    });
    try {
      await waitForHttp(`http://127.0.0.1:${port}/login`, 180000);
    } catch (err) {
      killTree(child);
      throw err;
    }
    return {
      close(cb) {
        killTree(child);
        if (child.exitCode !== null || child.signalCode !== null) cb();
        else child.once('exit', () => cb());
      },
    };
  },

  async beforeRun(config) {
    await resetFromSeed(config);
  },

  contextOptions() {
    const s = secrets();
    const cookie = (name, value) => ({ name, value, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' });
    return { storageState: { cookies: [cookie('USERHASH', s.userhash), cookie('SSID', s.token), cookie('MMDL_USERNAME', USER)], origins: [] } };
  },

  async ready(page) {
    await page.waitForURL((u) => u.pathname.replace(/\/+$/, '').startsWith(CALENDAR.route), { timeout: 120000 });
    await page.locator('.fc-toolbar-title').first().waitFor({ timeout: 120000 });
    await page.waitForFunction((u) => document.body.innerText.includes(u), USER, { timeout: 60000 });
    const view = await viewSelect(page).inputValue();
    if (view !== 'timeGridDay') throw new Error(`expected the Day View at start, found ${view}`);
    await page.locator('#show_tasks_switch').waitFor({ timeout: 60000 });
  },

  steps: [
    // ------------------------------------------------ Calendar View
    {
      name: 'C01 select Week View',
      async before(page) {
        await goCalendar(page);
        if ((await cal(page)).view === 'timeGridWeek') await viewSelect(page).selectOption('timeGridDay');
        return cal(page);
      },
      async run(page) {
        await viewSelect(page).selectOption('timeGridWeek');
      },
      async assert(page, before) {
        await expectState('C01', () => cal(page), (s) => s.view === 'timeGridWeek' && s.headers === 7 && s.title !== before.title && isRange(s.title), before);
      },
    },
    {
      name: 'C02 select Month View',
      async before(page) {
        await goCalendar(page);
        if ((await cal(page)).view === 'dayGridMonth') await viewSelect(page).selectOption('timeGridWeek');
        return cal(page);
      },
      async run(page) {
        await viewSelect(page).selectOption('dayGridMonth');
      },
      async assert(page, before) {
        await expectState('C02', () => cal(page), (s) => s.view === 'dayGridMonth' && s.daygrid > 0 && s.title !== before.title && isFullMonth(s.title), before);
      },
    },
    {
      name: 'C03 select List View',
      async before(page) {
        await goCalendar(page);
        if ((await cal(page)).view === 'listWeek') await viewSelect(page).selectOption('timeGridDay');
        return cal(page);
      },
      async run(page) {
        await viewSelect(page).selectOption('listWeek');
      },
      async assert(page, before) {
        await expectState('C03', () => cal(page), (s) => s.view === 'listWeek' && s.list > 0, before);
      },
    },
    {
      name: 'C04 select Day View',
      async before(page) {
        await goCalendar(page);
        if ((await cal(page)).view === 'timeGridDay') await viewSelect(page).selectOption('timeGridWeek');
        return cal(page);
      },
      async run(page) {
        await viewSelect(page).selectOption('timeGridDay');
      },
      async assert(page, before) {
        await expectState('C04', () => cal(page), (s) => s.view === 'timeGridDay' && s.headers === 1 && s.timegrid > 0, before);
      },
    },
    {
      name: 'C05 next period',
      async before(page) {
        await goCalendar(page);
        return cal(page);
      },
      async run(page) {
        await page.locator('.fc-next-button').first().click();
      },
      async assert(page, before) {
        await expectState('C05', () => cal(page), (s) => s.title !== before.title && titleDates(s.title)[0] > titleDates(before.title)[0], before);
      },
    },
    {
      name: 'C06 previous period',
      async before(page) {
        await goCalendar(page);
        return cal(page);
      },
      async run(page) {
        await page.locator('.fc-prev-button').first().click();
      },
      async assert(page, before) {
        await expectState('C06', () => cal(page), (s) => s.title !== before.title && titleDates(s.title)[0] < titleDates(before.title)[0], before);
      },
    },
    {
      name: 'C07 toggle Show Tasks off',
      async before(page) {
        await goCalendar(page);
        return page.locator('#show_tasks_switch').isChecked();
      },
      async run(page) {
        await page.locator('label', { hasText: 'Show Tasks' }).first().click();
      },
      async assert(page, before) {
        await expectState('C07', () => page.locator('#show_tasks_switch').isChecked(), (c) => c !== before, before);
      },
    },
    {
      name: 'C08 toggle Show Tasks on',
      async before(page) {
        await goCalendar(page);
        return page.locator('#show_tasks_switch').isChecked();
      },
      async run(page) {
        await page.locator('label', { hasText: 'Show Tasks' }).first().click();
      },
      async assert(page, before) {
        await expectState('C08', () => page.locator('#show_tasks_switch').isChecked(), (c) => c !== before, before);
      },
    },
    {
      name: 'C09 open Add from Templates',
      async before(page) {
        await goCalendar(page);
        if (await modalOpen(page)) await page.keyboard.press('Escape');
        return modalOpen(page);
      },
      async run(page) {
        await page.getByRole('button', { name: 'Add from Templates', exact: true }).click();
      },
      async assert(page, before) {
        await expectState('C09', () => page.evaluate(() => (document.querySelector('.modal.show') || { innerText: '' }).innerText), (t) => t.includes('Weekly review') && t.includes('Add from Templates'), before);
      },
    },
    {
      name: 'C10 close the template dialog with Escape',
      async before(page) {
        await goCalendar(page);
        if (!(await modalOpen(page))) await page.getByRole('button', { name: 'Add from Templates', exact: true }).click();
        await expectState('C10 open', () => modalOpen(page), (o) => o, false);
        return modalOpen(page);
      },
      async run(page) {
        await page.keyboard.press('Escape');
      },
      async assert(page, before) {
        await expectState('C10', () => modalOpen(page), (o) => !o, before);
      },
    },

    // ------------------------------------------------ Settings
    {
      name: 'C11 change the starting day of the week',
      async before(page) {
        await goSettings(page);
        await markToasts(page);
        return page.locator('select:has(option[value="6"])').first().inputValue();
      },
      async run(page) {
        const current = await page.locator('select:has(option[value="6"])').first().inputValue();
        const target = current === '0' ? '1' : '0';
        await page.locator('select:has(option[value="6"])').first().selectOption(target);
        await page.getByRole('button', { name: 'Save', exact: true }).first().click();
      },
      async assert(page, before) {
        // The run picks Sunday (0) unless Sunday is already selected, then Monday (1).
        await expectState('C11', () => page.locator('select:has(option[value="6"])').first().inputValue(), (v) => v === (before === '0' ? '1' : '0'), before);
        await expectState('C11 toast', () => newToasts(page), (ts) => ts.some((t) => t.includes('Updated successfully!')), before);
      },
    },
    {
      name: 'C12 change the date format',
      async before(page) {
        await goSettings(page);
        await markToasts(page);
        return { sample: await sampleText(page), format: await page.locator('input.form-control').nth(1).inputValue() };
      },
      async run(page) {
        const current = await page.locator('input.form-control').nth(1).inputValue();
        const target = current === 'YYYY-MM-DD' ? 'DD/MM/YYYY' : 'YYYY-MM-DD';
        await page.locator('input.form-control').nth(1).fill(target);
        await page.getByRole('button', { name: 'Save', exact: true }).nth(1).click();
      },
      async assert(page, before) {
        await expectState('C12', () => sampleText(page), (s) => s !== before.sample && (before.format === 'YYYY-MM-DD' ? /Sample Output[^\n]*\d{2}\/\d{2}\/\d{4}/.test(s) : /\d{4}-\d{2}-\d{2}/.test(s)), before);
        await expectState('C12 toast', () => newToasts(page), (ts) => ts.some((t) => t.includes('Date Format: Updated successfully!')), before);
      },
    },
    {
      name: 'C13 change the time format',
      async before(page) {
        await goSettings(page);
        await markToasts(page);
        return { sample: await sampleText(page), format: await page.locator('input.form-control').nth(2).inputValue() };
      },
      async run(page) {
        const current = await page.locator('input.form-control').nth(2).inputValue();
        const target = current === 'hh:mm A' ? 'HH:mm' : 'hh:mm A';
        await page.locator('input.form-control').nth(2).fill(target);
        await page.getByRole('button', { name: 'Save', exact: true }).nth(1).click();
      },
      async assert(page, before) {
        await expectState('C13', () => sampleText(page), (s) => s !== before.sample && (before.format === 'hh:mm A' ? !/(AM|PM)/.test(s) : /(AM|PM)/.test(s)), before);
        await expectState('C13 toast', () => newToasts(page), (ts) => ts.some((t) => t.includes('Time Format: Updated successfully!')), before);
      },
    },
    {
      name: 'C14 toggle Nuke Local Data on Logout',
      async before(page) {
        await goSettings(page);
        return page.locator('#default-nukedexie_checkbox').isChecked();
      },
      async run(page) {
        await page.locator('#default-nukedexie_checkbox').click();
      },
      async assert(page, before) {
        await expectState('C14', () => page.locator('#default-nukedexie_checkbox').isChecked(), (c) => c !== before, before);
      },
    },

    // ------------------------------------------------ WebCAL Manager
    {
      name: 'C15 open the WebCAL add form',
      async before(page) {
        await goWebcal(page);
        if (await webcalForm(page).isVisible()) await page.getByRole('button', { name: 'Close', exact: true }).click();
        return webcalForm(page).isVisible();
      },
      async run(page) {
        await page.getByRole('button', { name: 'Add', exact: true }).click();
      },
      async assert(page, before) {
        await expectState('C15', () => webcalForm(page).isVisible(), (v) => v && !before, before);
        await expectState('C15 fields', () => page.evaluate(() => ({
          link: !!document.querySelector('input.form-control[maxlength="1000"]'),
          interval: !!document.querySelector('input.form-control[type="number"]'),
          addReplaced: ![...document.querySelectorAll('div[style*="text-align: right"] button')].some((b) => b.textContent.trim() === 'Add'),
        })), (s) => s.link && s.interval && s.addReplaced, before);
      },
    },
    {
      name: 'C16 add the Holiday calendar webcal',
      async before(page) {
        await goWebcal(page);
        if (!(await webcalForm(page).isVisible())) await page.getByRole('button', { name: 'Add', exact: true }).click();
        await markToasts(page);
        return cardPresent(page, 'Holiday calendar');
      },
      async run(page) {
        const origin = new URL(page.url()).origin;
        await webcalForm(page).fill('Holiday calendar');
        await page.locator('input.form-control[maxlength="1000"]').fill(`${origin}/bench/holiday-calendar.ics`);
        await page.getByRole('button', { name: 'Add', exact: true }).click();
      },
      async assert(page, before) {
        await expectState('C16', () => cardPresent(page, 'Holiday calendar'), (card) => card, before);
        await expectState('C16 toast', () => newToasts(page), (ts) => ts.some((t) => t.includes('Done!')), before);
      },
    },
    {
      name: 'C17 sync the Team calendar webcal',
      async before(page) {
        await goWebcal(page);
        await markToasts(page);
        return cardPresent(page, 'Team calendar');
      },
      async run(page) {
        await clickCardIcon(page, 'Team calendar', 0);
      },
      async assert(page, before) {
        await expectState('C17', () => newToasts(page), (ts) => ts.some((t) => t.includes('Sync done!')), before);
      },
    },
    {
      name: 'C18 delete the Team calendar webcal',
      async before(page) {
        await goWebcal(page);
        await markToasts(page);
        return (await serverWebcalNames(page, authFor(secrets()))).includes('Team calendar');
      },
      async run(page) {
        await clickCardIcon(page, 'Team calendar', 1);
      },
      async assert(page, before) {
        await expectState('C18 toast', () => newToasts(page), (ts) => ts.some((t) => t.includes('Deleted successfully.')), before);
        await expectState('C18', () => serverWebcalNames(page, authFor(secrets())), (names) => !names.includes('Team calendar'), before);
      },
    },

    // ------------------------------------------------ Template Manager
    {
      name: 'C19 delete the Weekly review template',
      async before(page) {
        await goTemplates(page);
        await markToasts(page);
        return cardPresent(page, 'Weekly review');
      },
      async run(page) {
        await clickCardIcon(page, 'Weekly review', 0);
      },
      async assert(page, before) {
        await expectState('C19', () => cardPresent(page, 'Weekly review'), (present) => !present, before);
        await expectState('C19 toast', () => newToasts(page), (ts) => ts.some((t) => t.includes('Deleted successfully.')), before);
      },
    },

    // ------------------------------------------------ Manage Filters
    {
      name: 'C20 open the new filter form',
      async before(page) {
        await goFilters(page);
        const nameField = page.locator('input[placeholder="Enter filter name."]');
        if (await nameField.isVisible()) await page.getByRole('button', { name: 'Close', exact: true }).click();
        return nameField.isVisible();
      },
      async run(page) {
        await page.getByRole('button', { name: 'Add New Filter', exact: true }).click();
      },
      async assert(page, before) {
        await expectState('C20', () => page.locator('input[placeholder="Enter filter name."]').isVisible(), (v) => v && !before, before);
        await expectState('C20 save', () => page.getByRole('button', { name: 'Save', exact: true }).first().isVisible(), (v) => v, before);
      },
    },

    // ------------------------------------------------ Task View
    {
      name: 'C21 switch the task view to Gantt',
      async before(page) {
        await goTasks(page);
        if (await ganttActive(page)) await taskView(page).click();
        return ganttActive(page);
      },
      async run(page) {
        await gantt(page).click();
      },
      async assert(page, before) {
        await expectState('C21', () => viewState(page), (s) => s.gantt === 'active' && s.task === 'inactive' && !before, before);
      },
    },
    {
      name: 'C22 switch the task view back to the list',
      async before(page) {
        await goTasks(page);
        if (!(await ganttActive(page))) await gantt(page).click();
        return ganttActive(page);
      },
      async run(page) {
        await taskView(page).click();
      },
      async assert(page, before) {
        await expectState('C22', () => viewState(page), (s) => s.task === 'active' && s.gantt === 'inactive' && before, before);
      },
    },
    {
      name: 'C23 toggle the Filters accordion',
      async before(page) {
        await goTasks(page);
        return page.locator('button.accordion-button', { hasText: 'Filters' }).first().getAttribute('aria-expanded');
      },
      async run(page) {
        await page.locator('button.accordion-button', { hasText: 'Filters' }).first().click();
      },
      async assert(page, before) {
        await expectState('C23', () => page.locator('button.accordion-button', { hasText: 'Filters' }).first().getAttribute('aria-expanded'), (v) => v !== before, before);
      },
    },

    // ------------------------------------------------ Theme
    {
      name: 'C24 toggle dark mode',
      async before(page) {
        return themeAttr(page);
      },
      async run(page) {
        await toggleIcon(page).click();
      },
      async assert(page, before) {
        await expectState('C24', () => themeAttr(page), (t) => t !== before && (t === 'dark' || t === 'light'), before);
      },
    },
  ],
};
