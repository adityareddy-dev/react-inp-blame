// Kresus (kresusapp/kresus, AGPL-3.0-or-later), pinned at 41d388f0293762a7d510392917b373f45fd29ee7.
//
// Kresus is an Express server that serves its React client from the same origin and needs a
// database and Woob 3.5 or later (its Python bank engine; the client shows a "install Woob" screen
// without it). Upstream locks dependencies with Yarn classic (yarn.lock v1, no packageManager field),
// so install uses Yarn 1 under Node 24. Local data is seeded through Kresus's own HTTP API once, at
// configuration A's build, dumped with pg_dump, and restored before every run. The three
// configurations run as three servers on three databases (kresus_a, kresus_b, kresus_c) of one
// PostgreSQL 16 instance started as the bench user on 127.0.0.1:5442.
//
// Configuration A has no library. B and C import react-inp-blame@1.0.0's Vite plugin with
// runtime: { debugGlobal: true } (C adds overlay: true) and enabled: true, because the plugin leaves
// itself out of a production build unless enabled is set.
//
// Status is ready after the 2026-10-15 protocol revision. Its ordered workload leaves out C07, C17 and C21, which
// depend on state from earlier cases (see the revision); every case passes alone on A, B and C.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree, pollFor, waitForHttp } from '../helpers.mjs';
import { yarnCommand } from './kresus-tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLONE = path.join(HERE, '..', 'clones', 'kresus');
const STATE = path.join(HERE, '..', 'state', 'kresus');
const BUILD_BENCH = path.join(CLONE, 'build', 'bench');
const PINNED_SHA = '41d388f0293762a7d510392917b373f45fd29ee7';
const LIB_INTEGRITY =
    'sha512-wEQcaqyjZaZ6rnIC7vqkK3eSX4Zl9Y1wBlIFjg1LlfwcsLmsU5li0gBtzxlXhEwiSFnRSU/arBduorTMltkgJg==';
const NODE24 = process.execPath;
const PATH24 = process.platform === 'win32' ? process.env.PATH : '/opt/node24/bin:/opt/node22/bin:/usr/local/bin:/usr/bin:/bin';
const PG_BIN = '/usr/lib/postgresql/16/bin';
const PG_PORT = 5442;
// The harness names configurations A, B and C when it starts servers and resets data, and passes
// BENCH_CONFIG ('', 'b', 'c') when it builds; both spellings map to the same database and dist.
const LETTER = { A: 'a', B: 'b', C: 'c', '': 'a', b: 'b', c: 'c' };

// ---------------------------------------------------------------- files written into the clone

// The bench-only Vite configuration. It stays under build/ because the upstream tsconfig excludes
// build/ and would otherwise type-check it. It imports the upstream vite.config.js unchanged.
const VITE_BENCH_CONFIG = `// Bench-only build configuration, written by bench/adapters/kresus.mjs.
import base from '../../vite.config.js';

const configuration = process.env.BENCH_CONFIG ?? '';

// The upstream outDir sits outside Vite's root (client/), so Vite would not empty it between
// configurations and stale chunks from an earlier build would be copied into the next dist.
base.build.emptyOutDir = true;

if (configuration === 'b' || configuration === 'c') {
    const { inpBlame } = await import('react-inp-blame/vite');
    const runtime = configuration === 'c' ? { debugGlobal: true, overlay: true } : { debugGlobal: true };
    // enabled defaults to 'development', which leaves the library out of a production build.
    // After the framework plugin, which is the first entry in the upstream list.
    base.plugins.splice(1, 0, inpBlame({ enabled: true, runtime }));
} else if (configuration !== '') {
    throw new Error('unknown BENCH_CONFIG ' + JSON.stringify(configuration));
}

export default base;
`;

// Runs one configuration's server from its dist directory, as bin/kresus.js does.
const LAUNCH = `// Bench-only launcher: runs one configuration's Kresus server from BENCH_KRESUS_DIST.
const fs = require('node:fs');
const path = require('node:path');

const dist = process.env.BENCH_KRESUS_DIST;
const state = process.env.BENCH_KRESUS_STATE;
if (!dist || !state) throw new Error('BENCH_KRESUS_DIST and BENCH_KRESUS_STATE are required');

// The sign-in for the local bench user, kept under bench/state/kresus and never on a command line.
const credentials = JSON.parse(fs.readFileSync(path.join(state, 'credentials.json'), 'utf8'));
process.env.KRESUS_AUTH = credentials.auth.user + ':' + credentials.auth.password;

const configurator = require(path.join(dist, 'server', 'config.js'));
configurator.apply({});

const server = require(path.join(dist, 'server'));
const dataDir = process.kresus.dataDir;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
process.umask(0o0077);
process.chdir(dataDir);
server.start();
`;

// The server's TypeScript project. It is the upstream tsconfig's options, with the sources limited to
// the server and shared folders, because the upstream one would also type-check the dist folders
// that live inside the clone and fail on their bundled JavaScript.
const BENCH_TSCONFIG = `{
    "compilerOptions": {
        "target": "es2018",
        "module": "commonjs",
        "lib": ["es6"],
        "allowJs": true,
        "checkJs": true,
        "outDir": "../../build",
        "rootDir": "../..",
        "incremental": false,
        "strict": true,
        "noImplicitAny": true,
        "strictNullChecks": true,
        "strictFunctionTypes": true,
        "strictPropertyInitialization": true,
        "noImplicitThis": true,
        "alwaysStrict": true,
        "noUnusedLocals": true,
        "noUnusedParameters": true,
        "noImplicitReturns": true,
        "noFallthroughCasesInSwitch": true,
        "useUnknownInCatchVariables": false,
        "types": ["node", "mocha"],
        "esModuleInterop": true,
        "resolveJsonModule": true,
        "experimentalDecorators": true,
        "emitDecoratorMetadata": true,
        "skipLibCheck": true
    },
    "include": ["../../global.d.ts", "../../server", "../../shared"],
    "exclude": ["../../client", "../../bin", "../../tests", "../../scripts", "../../build", "../../node_modules", "../../dist-a", "../../dist-b", "../../dist-c"]
}
`;

// Seeds configuration A's database through the Kresus API, then dumps the data. Run by build A.
const SEED = `// Bench-only seed: starts configuration A's server on an empty database, creates fixed local data
// through the Kresus HTTP API (pinned dates), and dumps the data to state/seed-data.sql.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const state = process.env.BENCH_KRESUS_STATE;
const dist = process.env.BENCH_KRESUS_DIST;
const port = Number(process.env.BENCH_KRESUS_PORT);
const credentials = JSON.parse(fs.readFileSync(path.join(state, 'credentials.json'), 'utf8'));
const pg = credentials.pg;
const database = 'kresus_a';
const psqlEnv = Object.assign({}, process.env, { PGPASSWORD: pg.adminPassword });
const admin = ['-h', '127.0.0.1', '-p', String(process.env.BENCH_PG_PORT), '-U', pg.admin];

function must(result, what) {
    if (result.status !== 0) throw new Error(what + ' failed: ' + String(result.stderr || result.stdout).slice(0, 400));
    return result;
}

// A fresh schema, so the seed is the same whatever ran before.
must(spawnSync('psql', admin.concat(['-d', database, '-v', 'ON_ERROR_STOP=1', '-q', '-c',
    'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION ' + pg.user]), { env: psqlEnv, encoding: 'utf8' }), 'schema reset');

const log = path.join(state, 'seed-a.log');
fs.writeFileSync(log, '');
const child = spawn(process.execPath, [path.join(__dirname, 'launch.cjs')], {
    detached: true,
    stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')],
    env: Object.assign({}, process.env, {
        BENCH_KRESUS_DIST: dist,
        BENCH_KRESUS_STATE: state,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(port),
        KRESUS_DIR: path.join(state, 'data-a'),
        KRESUS_DB_TYPE: 'postgres',
        KRESUS_DB_HOST: '127.0.0.1',
        KRESUS_DB_PORT: String(process.env.BENCH_PG_PORT),
        KRESUS_DB_NAME: database,
        KRESUS_DB_USERNAME: pg.user,
        KRESUS_DB_PASSWORD: pg.password,
        KRESUS_PYTHON_EXEC: path.join(state, 'woob-venv', 'bin', 'python'),
    }),
});

function stopServer() {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { child.kill('SIGKILL'); }
}

async function waitFor(check, what, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await check()) return;
        if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
        await new Promise((r) => setTimeout(r, 500));
    }
}

const auth = 'Basic ' + Buffer.from(credentials.auth.user + ':' + credentials.auth.password).toString('base64');
const base = 'http://127.0.0.1:' + port + '/api/';

async function call(method, route, body) {
    const res = await fetch(base + route, {
        method,
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = text;
    try { json = JSON.parse(text); } catch (err) { /* not JSON */ }
    if (res.status >= 300) throw new Error(method + ' ' + route + ' returned ' + res.status + ': ' + text.slice(0, 300));
    return json;
}

(async () => {
    await waitFor(() => fs.existsSync(log) && /Server is ready/.test(fs.readFileSync(log, 'utf8')), 'the server to be ready', 180000);

    // A manual access creates three accounts, Manual account #1 to #3, in EUR.
    await call('POST', 'accesses', { vendorId: 'manual', fields: [] });
    const first = await call('GET', 'all/');
    const checking = first.accounts[0].id;
    const savings = first.accounts[1].id;

    const category = {};
    for (const label of ['Groceries', 'Housing', 'Transport', 'Salary']) {
        const created = await call('POST', 'categories', { label, color: '#DB9320' });
        category[label] = created.id !== undefined ? created.id : created.category.id;
    }

    const rows = [
        [checking, '2026-09-02', -54.2, 'Supermarket', 'type.card', category.Groceries],
        [checking, '2026-09-05', 2100, 'Employer payroll', 'type.transfer', category.Salary],
        [checking, '2026-09-09', -850, 'Rent September', 'type.withdrawal', category.Housing],
        [checking, '2026-09-12', -23.6, 'Metro pass', 'type.card', category.Transport],
        [savings, '2026-09-15', -100, 'Savings transfer', 'type.internal_transfer', null],
    ];
    for (const [accountId, day, amount, label, type, categoryId] of rows) {
        await call('POST', 'transactions', {
            accountId,
            date: day + 'T12:00:00.000Z',
            amount,
            label,
            rawLabel: label,
            type,
            categoryId,
        });
    }
    stopServer();
    await new Promise((r) => setTimeout(r, 1000));

    must(spawnSync('pg_dump', admin.concat(['-d', database, '--data-only', '--no-owner', '--no-privileges', '-f',
        path.join(state, 'seed-data.sql')]), { env: psqlEnv, encoding: 'utf8' }), 'pg_dump');
    // The reset every run restores: empty every table of the public schema, then load the seed.
    const truncate = "DO $$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE'; END LOOP; END $$;\\n";
    fs.writeFileSync(path.join(state, 'reset.sql'), truncate + fs.readFileSync(path.join(state, 'seed-data.sql'), 'utf8'));
    console.log('seeded ' + rows.length + ' transactions into ' + database);
})().catch((err) => {
    stopServer();
    console.error(err.stack || err.message);
    process.exit(1);
});
`;

function writeBenchFiles() {
    fs.mkdirSync(BUILD_BENCH, { recursive: true });
    fs.writeFileSync(path.join(BUILD_BENCH, 'vite.bench.config.mjs'), VITE_BENCH_CONFIG);
    fs.writeFileSync(path.join(BUILD_BENCH, 'tsconfig.json'), BENCH_TSCONFIG);
    fs.writeFileSync(path.join(BUILD_BENCH, 'launch.cjs'), LAUNCH);
    fs.writeFileSync(path.join(BUILD_BENCH, 'seed.cjs'), SEED);
}

// What scripts/build/server.sh does, with the bench's TypeScript project in place of the upstream
// one (see BENCH_TSCONFIG): the shared JSON and the Woob Python code go next to the compiled server.
function buildServer(run, env) {
    const build = path.join(CLONE, 'build');
    fs.rmSync(path.join(build, 'server'), { recursive: true, force: true });
    fs.rmSync(path.join(build, 'build'), { recursive: true, force: true });
    const shared = path.join(build, 'server', 'shared');
    fs.mkdirSync(path.join(shared, 'locales'), { recursive: true });
    for (const file of fs.readdirSync(path.join(CLONE, 'shared'))) {
        if (file.endsWith('.json')) fs.copyFileSync(path.join(CLONE, 'shared', file), path.join(shared, file));
    }
    for (const file of fs.readdirSync(path.join(CLONE, 'shared', 'locales'))) {
        if (file.endsWith('.json')) fs.copyFileSync(path.join(CLONE, 'shared', 'locales', file), path.join(shared, 'locales', file));
    }
    const woob = path.join(build, 'server', 'providers', 'woob', 'py');
    fs.cpSync(path.join(CLONE, 'server', 'providers', 'woob', 'py'), woob, { recursive: true });
    fs.chmodSync(path.join(woob, 'main.py'), 0o755);
    run(NODE24, [path.join(CLONE, 'node_modules', 'typescript', 'bin', 'tsc'), '--build', '--force', 'build/bench/tsconfig.json'],
        { cwd: CLONE, env, shell: false });
    fs.rmSync(path.join(build, 'build'), { recursive: true, force: true });
}

// ---------------------------------------------------------------- credentials and PostgreSQL

// The local secrets, generated once and kept under bench/state/kresus (ignored by git). A missing
// section is added, so a file written before a section existed is completed rather than rejected.
function credentials() {
    const file = path.join(STATE, 'credentials.json');
    fs.mkdirSync(STATE, { recursive: true });
    const body = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const secret = () => crypto.randomBytes(18).toString('hex');
    const before = JSON.stringify(body);
    body.auth ??= { user: 'bench', password: secret() };
    body.pg ??= { admin: 'postgres', adminPassword: secret(), user: 'kresus', password: secret() };
    if (JSON.stringify(body) !== before) fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
    return body;
}

function psql(sql, { user, password, database }) {
    const r = spawnSync('psql', ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', user, '-d', database, '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
        env: { ...process.env, PATH: PATH24, PGPASSWORD: password },
        encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`psql failed: ${String(r.stderr).trim().slice(0, 400)}`);
    return r.stdout.trim();
}

function ensureDatabases(c) {
    const admin = { user: c.pg.admin, password: c.pg.adminPassword, database: 'postgres' };
    const roles = psql(`SELECT count(*) FROM pg_roles WHERE rolname = '${c.pg.user}'`, admin);
    if (roles === '0') psql(`CREATE ROLE ${c.pg.user} LOGIN PASSWORD '${c.pg.password}'`, admin);
    for (const letter of ['a', 'b', 'c']) {
        const name = `kresus_${letter}`;
        if (psql(`SELECT count(*) FROM pg_database WHERE datname = '${name}'`, admin) === '0') {
            psql(`CREATE DATABASE ${name} OWNER ${c.pg.user}`, admin);
        }
    }
}

function ensureWoob(run) {
    const python = path.join(STATE, 'woob-venv', 'bin', 'python');
    if (!fs.existsSync(python)) {
        run('/usr/bin/python3', ['-m', 'venv', path.join(STATE, 'woob-venv')]);
        // Woob 3.5 or later is the minimum the client accepts; 3.7 is the release used here.
        run(python, ['-m', 'pip', 'install', '--quiet', 'woob==3.7']);
    }
}

// ---------------------------------------------------------------- the server and the runs

function serverEnv(c, letter, port) {
    return {
        ...process.env,
        PATH: PATH24,
        NODE_ENV: 'production',
        BENCH_KRESUS_DIST: path.join(CLONE, `dist-${letter}`),
        BENCH_KRESUS_STATE: STATE,
        HOST: '127.0.0.1',
        PORT: String(port),
        KRESUS_DIR: path.join(STATE, `data-${letter}`),
        KRESUS_DB_TYPE: 'postgres',
        KRESUS_DB_HOST: '127.0.0.1',
        KRESUS_DB_PORT: String(PG_PORT),
        KRESUS_DB_NAME: `kresus_${letter}`,
        KRESUS_DB_USERNAME: c.pg.user,
        KRESUS_DB_PASSWORD: c.pg.password,
        KRESUS_PYTHON_EXEC: path.join(STATE, 'woob-venv', 'bin', 'python'),
    };
}

const ROWS = 'input[placeholder="Add a custom label"]';
const labels = (page) => page.$$eval(ROWS, (els) => els.map((e) => e.value));
const origin = (page) => new URL(page.url()).origin;

async function stored(page) {
    const res = await page.request.get(`${origin(page)}/api/all/`);
    if (!res.ok()) throw new Error(`GET /api/all/ returned ${res.status()}`);
    return res.json();
}

async function go(page, target) {
    await page.evaluate((h) => {
        if (window.location.hash !== h) window.location.hash = h;
    }, target);
}

// The balance shown next to an account in the side menu, as a number.
async function menuBalance(page, accountId) {
    const text = await page.$eval(`a[href="#/view/account/${accountId}/reports"]`, (a) => a.textContent);
    // The number that ends in "€", not the digits of the account's own name ("#1").
    const match = text.match(/(?<![\d#])(-?\d[\d\s  ]*,\d{2})\s*€/);
    if (!match) throw new Error(`no balance in menu entry: ${JSON.stringify(text)}`);
    return Number(match[1].replace(/[\s  ]/g, '').replace(',', '.'));
}

// The value shown in a react-select control that sits after the given field label.
const selected = (page, fieldLabel) =>
    page
        .locator(`xpath=//label[normalize-space()="${fieldLabel}"]/following::div[contains(@class,"single-value")][1]`)
        .textContent({ timeout: 5000 })
        .catch(() => '');


// The search panel and its filter survive a visit to another page, so each visit to the list starts
// by closing the panel, which leaves the list unfiltered.
async function openReports(page) {
    await go(page, '#/view/account/1/reports');
    await page.locator('button[aria-label="Add a transaction"]').waitFor({ state: 'visible', timeout: 20000 });
    const close = page.getByRole('button', { name: 'Clear and close', exact: true });
    if (await close.isVisible().catch(() => false)) await clickAt(page, close);
    const rows = await pollFor(() => labels(page), (r) => r.length > 0, 20000);
    if (rows.length === 0) throw new Error('account #1 list did not load');
}

async function openTransaction(page, id, expectedLabel) {
    await go(page, `#/view/account/1/transactions/${id}`);
    const value = await pollFor(
        () => page.inputValue('#label').catch(() => ''),
        (v) => v === expectedLabel,
        20000,
    );
    if (value !== expectedLabel) throw new Error(`transaction ${id} shows ${JSON.stringify(value)}, expected ${expectedLabel}`);
}

async function categoryNames(page) {
    return page.$$eval('table tbody tr td:nth-child(2)', (cells) => cells.map((c) => c.textContent.trim()).filter(Boolean));
}

async function openCategories(page) {
    await go(page, '#/categories');
    await pollFor(() => categoryNames(page), (r) => r.length > 0, 20000);
}

function expectChange(what, before, after) {
    if (JSON.stringify(before) === JSON.stringify(after)) throw new Error(`${what} did not change (${JSON.stringify(after)})`);
}

// A real mouse click at a point of the element that the element itself receives. Some toolbars
// are partly covered by the account summary at the harness's viewport, so the element's centre is
// not always clickable; a synthetic element.click() would not produce the input events INP needs.
async function clickAt(page, locator) {
    await locator.waitFor({ state: 'visible', timeout: 20000 });
    const handle = await locator.elementHandle();
    const point = await handle.evaluate((node) => {
        node.scrollIntoView({ block: 'center' });
        const r = node.getBoundingClientRect();
        for (const fy of [0.5, 0.3, 0.7]) {
            for (const fx of [0.5, 0.8, 0.2, 0.9]) {
                const x = r.x + r.width * fx;
                const y = r.y + r.height * fy;
                // The topmost element here is the node, one of its descendants, or one of its
                // ancestors (react-select's input is a few pixels wide inside its container).
                const top = document.elementFromPoint(x, y);
                if (top && (top === node || node.contains(top) || top.contains(node))) return [x, y];
            }
        }
        return null;
    });
    if (!point) {
        const html = await handle.evaluate((node) => node.outerHTML.slice(0, 160));
        throw new Error(`no point of the element receives a click: ${html}`);
    }
    await page.mouse.click(point[0], point[1]);
}

// Replaces the text of an input with real key presses.
async function typeInto(page, locator, text) {
    await clickAt(page, locator);
    await page.keyboard.press('Control+A');
    await page.keyboard.type(text);
}

// Types into a react-select combobox and clicks the option whose text ends with the given text,
// optionally followed by a parenthesised suffix, matched case-sensitively. Typing "Deposit" also
// matches "Cash deposit", which this does not select. An account is listed as
// "Manual Bank / Manual account #1 (EUR)".
async function pickFrom(page, input, text, { byKeyboard = false } = {}) {
    await clickAt(page, input);
    await page.keyboard.type(text);
    if (byKeyboard) {
        // The typed text leaves one matching option, which is the focused one.
        await page.keyboard.press('Enter');
        return;
    }
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const option = page
        .locator('[role="option"], [class*="Select__option"]')
        .filter({ hasText: new RegExp(`${escaped}( \\(.*\\))?$`) })
        .first();
    await clickAt(page, option);
}

// Picks an option of the react-select control that follows the given field label.
function pickOption(page, fieldLabel, text) {
    return pickFrom(page, page.locator(`xpath=//label[normalize-space()="${fieldLabel}"]/following::input[@role="combobox"][1]`), text);
}

// The page's text with every run of whitespace, including no-break spaces, as one space.
const bodyText = async (page) => (await page.textContent('body')).replace(/\s+/g, ' ');

// Waits until the notifications from earlier actions have closed, since one can cover a control.
const clearToasts = (page) => page.waitForSelector('.Toastify__toast', { state: 'detached', timeout: 15000 }).catch(() => {});

// The side menu's text: the access entries, the account and currency balances, and the custom views.
const menuText = (page) => page.$$eval('nav', (els) => els.map((e) => e.innerText).join(' | '));

// The reports list's rows: the custom-label field of each row, and the category cell at the row's end.
function listRows(page) {
    return page.$$eval('table tbody tr', (trs) => trs
        .filter((tr) => tr.querySelector('input[placeholder="Add a custom label"]'))
        .map((tr) => {
            const cells = tr.querySelectorAll('td');
            return {
                label: tr.querySelector('input[placeholder="Add a custom label"]').value,
                category: cells[cells.length - 1].innerText.trim(),
            };
        }));
}

// The budget table's row for a category, found by its name.
const budgetRow = (page, name) => page.locator('tr').filter({ has: page.getByText(name, { exact: true }) }).first();

// The planned-budget column of the table's Total row, as text.
const plannedTotal = (page) => page.locator('tr:has(th:text-is("Total")) th').nth(2).textContent();

// Each budget-month button of a transaction, with whether it is marked active.
const budgetMonths = (page) => page.$$eval('button.budget-assignment', (bs) =>
    bs.map((b) => ({ label: b.innerText.trim(), active: /\bactive\b/.test(b.className) })));

// ---------------------------------------------------------------- the adapter

export default {
    // Set after the 2026-10-15 protocol revision; see the header.
    status: 'ready',
    id: 'kresus',
    // The default install is the upstream's: Yarn 1 with yarn.lock, under Node 24.
    install(run) {
        const head = spawnSync('git', ['-C', CLONE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
        if (head !== PINNED_SHA) throw new Error(`the clone is at ${head}, not the pinned ${PINNED_SHA}`);
        const env = { ...process.env, PATH: PATH24 };
        const yarn = (args) => {
            const planned = yarnCommand(args);
            run(planned.command, planned.args, { cwd: CLONE, env, shell: planned.shell });
        };
        const pkg = JSON.parse(fs.readFileSync(path.join(CLONE, 'package.json'), 'utf8'));
        if (!pkg.devDependencies || !pkg.devDependencies['react-inp-blame']) {
            yarn(['add', 'react-inp-blame@1.0.0', '--dev', '--exact', '--network-timeout', '600000']);
        }
        yarn(['install', '--frozen-lockfile', '--network-timeout', '600000']);
        if (!fs.readFileSync(path.join(CLONE, 'yarn.lock'), 'utf8').includes(LIB_INTEGRITY)) {
            throw new Error('yarn.lock does not pin react-inp-blame@1.0.0 to the expected integrity');
        }
    },

    // PostgreSQL 16 as the bench user, on 127.0.0.1:5442, with its data under bench/state/kresus.
    prepare(run) {
        if (process.platform === 'win32') {
            throw new Error('Kresus native Windows service setup is unsupported: prepare requires Linux PostgreSQL 16 (chown/runuser) and Woob');
        }
        const c = credentials();
        const pgdata = path.join(STATE, 'pgdata');
        if (!fs.existsSync(path.join(pgdata, 'PG_VERSION'))) {
            const pwfile = path.join(STATE, 'pg-admin.pw');
            fs.writeFileSync(pwfile, `${c.pg.adminPassword}\n`, { mode: 0o600 });
            run('chown', ['-R', 'bench:bench', STATE]);
            run('runuser', ['-u', 'bench', '--', path.join(PG_BIN, 'initdb'), '-D', pgdata, '-U', c.pg.admin,
                '--pwfile', pwfile, '-A', 'scram-sha-256', '-E', 'UTF8', '--no-locale']);
            fs.appendFileSync(path.join(pgdata, 'postgresql.conf'),
                `\nport = ${PG_PORT}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\n`);
            fs.unlinkSync(pwfile);
        }
        run('chown', ['-R', 'bench:bench', pgdata]);
        if (spawnSync(path.join(PG_BIN, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(PG_PORT)]).status !== 0) {
            run('runuser', ['-u', 'bench', '--', path.join(PG_BIN, 'pg_ctl'), '-D', pgdata,
                '-l', path.join(STATE, 'postgres.log'), '-o', `-p ${PG_PORT}`, '-w', 'start']);
        }
        ensureDatabases(c);
        ensureWoob(run);
    },

    // Builds one configuration as dist-a, dist-b or dist-c. The client is Vite's production build,
    // the server is the upstream's build:server script, and both are copied into the dist.
    build(run, env) {
        const config = env.BENCH_CONFIG ?? '';
        writeBenchFiles();
        const buildEnv = { ...process.env, PATH: PATH24, NODE_ENV: 'production', BENCH_CONFIG: config };
        run(NODE24, [path.join(CLONE, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--mode', 'production',
            '--config', 'build/bench/vite.bench.config.mjs'], { cwd: CLONE, env: buildEnv, shell: false });
        buildServer(run, buildEnv);
        const out = path.join(CLONE, env.BENCH_OUTDIR);
        fs.rmSync(out, { recursive: true, force: true });
        fs.mkdirSync(out, { recursive: true });
        for (const part of ['client', 'server', 'shared', 'package.json']) {
            fs.cpSync(path.join(CLONE, 'build', part), path.join(out, part), { recursive: true });
        }
        if (config === '') {
            // Configuration A seeds the database once; every run restores that seed.
            run(NODE24, [path.join(BUILD_BENCH, 'seed.cjs')], {
                cwd: CLONE,
                shell: false,
                env: {
                    ...buildEnv,
                    BENCH_KRESUS_STATE: STATE,
                    BENCH_KRESUS_DIST: out,
                    BENCH_KRESUS_PORT: '5316',
                    BENCH_PG_PORT: String(PG_PORT),
                },
            });
        }
    },

    assetsDir: 'client/assets',

    // Starts the configuration's server on its port and resolves when it is serving. Kresus runs its
    // migrations on start, so the server is only ready once it logs that it is ready.
    async startServer(config, port) {
        const letter = LETTER[config];
        const c = credentials();
        const log = path.join(STATE, `server-${letter}.log`);
        const out = fs.openSync(log, 'a');
        const child = spawn(NODE24, [path.join(BUILD_BENCH, 'launch.cjs')], {
            cwd: CLONE,
            detached: true,
            stdio: ['ignore', out, out],
            env: serverEnv(c, letter, port),
        });
        const deadline = Date.now() + 180000;
        for (;;) {
            if (fs.readFileSync(log, 'utf8').includes("Server is ready, let's start the show!")) break;
            if (child.exitCode !== null || Date.now() > deadline) {
                killTree(child);
                throw new Error(`kresus ${letter} did not become ready; see ${log}`);
            }
            await new Promise((r) => setTimeout(r, 500));
        }
        await waitForHttp(`http://127.0.0.1:${port}/`);
        return {
            close(cb) {
                killTree(child);
                child.once('exit', () => cb());
                if (child.exitCode !== null) cb();
            },
        };
    },

    // Restores the seed into this configuration's database before every run.
    beforeRun(config) {
        const letter = LETTER[config];
        const c = credentials();
        const reset = path.join(STATE, 'reset.sql');
        if (!fs.existsSync(reset)) throw new Error('no seed yet: build configuration A first');
        const r = spawnSync('psql', ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', c.pg.user, '-d', `kresus_${letter}`,
            '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', reset], {
            env: { ...process.env, PATH: PATH24, PGPASSWORD: c.pg.password },
            encoding: 'utf8',
        });
        if (r.status !== 0) throw new Error(`restoring the seed failed: ${String(r.stderr).slice(0, 400)}`);
    },

    // The local bench user signs in with HTTP basic auth, and only ever for 127.0.0.1.
    contextOptions() {
        const c = credentials();
        return { httpCredentials: { username: c.auth.user, password: c.auth.password } };
    },

    async ready(page) {
        const rows = await pollFor(() => labels(page), (r) => r.length === 4, 60000);
        if (rows.length !== 4) throw new Error(`initial list shows ${rows.length} rows, expected the four account #1 rows`);
    },

    steps: [
        {
            name: 'C01 search the account #1 list for Supermarket',
            before: async (page) => {
                await openReports(page);
                return { rows: await labels(page) };
            },
            run: async (page) => {
                await clickAt(page, page.locator('button[aria-label="Search"]'));
                await typeInto(page, page.locator('#keywords'), 'Supermarket');
            },
            assert: async (page, before) => {
                const after = await pollFor(() => labels(page), (r) => r.length === 1, 10000);
                if (before.rows.length !== 4) throw new Error(`expected four rows before, got ${before.rows.length}`);
                if (after.length !== 1 || after[0] !== 'Supermarket') {
                    throw new Error(`expected only the Supermarket row, got ${JSON.stringify(after)}`);
                }
            },
        },
        {
            name: 'C02 search the account #1 list for a label that matches nothing',
            before: async (page) => {
                await openReports(page);
                return { rows: await labels(page) };
            },
            run: async (page) => {
                await clickAt(page, page.locator('button[aria-label="Search"]'));
                await typeInto(page, page.locator('#keywords'), 'zzz-no-match');
            },
            assert: async (page, before) => {
                const after = await pollFor(() => labels(page), (r) => r.length === 0, 10000);
                if (after.length !== 0) throw new Error(`expected no rows, got ${JSON.stringify(after)}`);
                if (before.rows.length === 0) throw new Error('the list was already empty before the search');
                const body = await pollFor(() => bodyText(page), (t) => t.includes('No transaction found'), 10000);
                if (!body.includes('No transaction found')) throw new Error('the empty-result message is not shown');
            },
        },
        {
            name: 'C03 add a 12.40 expense labelled Bench pharmacy',
            before: async (page) => {
                await openReports(page);
                return { rows: await labels(page), balance: await menuBalance(page, 1) };
            },
            run: async (page) => {
                await clickAt(page, page.locator('button[aria-label="Add a transaction"]'));
                await typeInto(page, page.locator('#label'), 'Bench pharmacy');
                // The form's sign defaults to Minus, so 12.40 is stored as -12.40.
                await typeInto(page, page.locator('#amount'), '12.40');
                // The form defaults to today's date, which the balance does not count yet; a pinned
                // past date keeps the balance change visible.
                await typeInto(page, page.locator('#date'), '09/20/2026');
                await page.keyboard.press('Tab');
                await clickAt(page, page.getByRole('button', { name: 'Create', exact: true }));
            },
            assert: async (page, before) => {
                if (before.rows.length !== 4) throw new Error(`expected four rows before, got ${before.rows.length}`);
                if (Math.abs(before.balance - 1172.2) >= 0.005) throw new Error(`balance was ${before.balance} before, expected 1172.20`);
                const after = await pollFor(() => labels(page), (r) => r.includes('Bench pharmacy'), 15000);
                if (!after.includes('Bench pharmacy')) throw new Error('the new transaction is not in the list');
                if (after.length !== before.rows.length + 1) {
                    throw new Error(`expected ${before.rows.length + 1} rows, got ${after.length}`);
                }
                const balance = await pollFor(() => menuBalance(page, 1), (b) => Math.abs(b - 1159.8) < 0.005, 10000);
                if (Math.abs(balance - 1159.8) >= 0.005) throw new Error(`balance is ${balance}, expected 1159.80`);
                const tx = (await stored(page)).transactions.find((t) => t.label === 'Bench pharmacy');
                if (!tx || tx.amount !== -12.4) throw new Error(`stored amount is ${tx && tx.amount}, expected -12.4`);
            },
        },
        {
            name: 'C04 set the category of Rent September to Groceries',
            before: async (page) => {
                await openTransaction(page, 3, 'Rent September');
                return { category: await selected(page, 'Category') };
            },
            run: async (page) => {
                await pickOption(page, 'Category', 'Groceries');
            },
            assert: async (page, before) => {
                const after = await pollFor(() => selected(page, 'Category'), (v) => v === 'Groceries', 10000);
                if (after !== 'Groceries') throw new Error(`category shows ${JSON.stringify(after)}`);
                if (before.category !== 'Housing') throw new Error(`the category was ${JSON.stringify(before.category)} before, expected Housing`);
                expectChange('the category', before.category, after);
                const data = await stored(page);
                const groceries = data.categories.find((c) => c.label === 'Groceries');
                const tx = data.transactions.find((t) => t.id === 3);
                if (!groceries || !tx || tx.categoryId !== groceries.id) throw new Error('the category was not stored');
                await openReports(page);
                const row = (await listRows(page)).find((r) => r.label === 'Rent September');
                if (!row) throw new Error('the account #1 list has no Rent September row');
                if (row.category !== 'Groceries') throw new Error(`the Rent September row shows ${JSON.stringify(row.category)}`);
            },
        },
        {
            name: 'C05 change the type of Employer payroll from Transfer to Deposit',
            before: async (page) => {
                await openTransaction(page, 2, 'Employer payroll');
                return { type: await selected(page, 'Type') };
            },
            run: async (page) => {
                await pickOption(page, 'Type', 'Deposit');
            },
            assert: async (page, before) => {
                const after = await pollFor(() => selected(page, 'Type'), (v) => v === 'Deposit', 10000);
                if (after !== 'Deposit') throw new Error(`type shows ${JSON.stringify(after)}`);
                if (before.type !== 'Transfer') throw new Error(`the type was ${JSON.stringify(before.type)} before, expected Transfer`);
                expectChange('the type', before.type, after);
                const tx = (await stored(page)).transactions.find((t) => t.id === 2);
                if (!tx || tx.type !== 'type.deposit') throw new Error(`stored type is ${tx && tx.type}`);
            },
        },
        {
            name: 'C06 rename the Supermarket transaction to Weekly shop',
            before: async (page) => {
                await openReports(page);
                const rows = await labels(page);
                await openTransaction(page, 1, 'Supermarket');
                return { rows };
            },
            run: async (page) => {
                await typeInto(page, page.locator('#label'), 'Weekly shop');
                await page.keyboard.press('Tab');
            },
            assert: async (page, before) => {
                const tx = await pollFor(async () => (await stored(page)).transactions.find((t) => t.id === 1),
                    (t) => t && t.customLabel === 'Weekly shop', 10000);
                if (!tx || tx.customLabel !== 'Weekly shop') throw new Error(`stored label is ${tx && tx.customLabel}`);
                // The list keeps the row's place: the custom label shows where Supermarket was.
                if (!before.rows.includes('Supermarket')) throw new Error('Supermarket was not in the list before the rename');
                const expected = before.rows.map((l) => (l === 'Supermarket' ? 'Weekly shop' : l));
                await openReports(page);
                const rows = await labels(page);
                if (JSON.stringify(rows) !== JSON.stringify(expected)) {
                    throw new Error(`the account #1 list shows ${JSON.stringify(rows)}, expected ${JSON.stringify(expected)}`);
                }
            },
        },
        {
            name: 'C07 delete the Metro pass transaction',
            before: async (page) => {
                await openTransaction(page, 4, 'Metro pass');
                return { count: (await stored(page)).transactions.filter((t) => t.accountId === 1).length };
            },
            run: async (page) => {
                await clickAt(page, page.locator('button.danger', { hasText: 'Delete this transaction' }));
                await clickAt(page, page.locator('button.danger', { hasText: /^Confirm$/ }));
            },
            assert: async (page, before) => {
                const after = await pollFor(async () => (await stored(page)).transactions,
                    (list) => !list.some((t) => t.id === 4), 10000);
                // The app returns to the account's list after a delete. The list is read once it is shown.
                await openReports(page);
                const rows = await labels(page);
                if (after.some((t) => t.id === 4)) throw new Error('the Metro pass transaction is still stored');
                if (before.count !== 4) throw new Error(`account #1 had ${before.count} transactions before, expected four`);
                const left = after.filter((t) => t.accountId === 1).length;
                if (left !== before.count - 1) throw new Error(`${left} account #1 transactions left, expected ${before.count - 1}`);
                if (rows.length !== left || rows.includes('Metro pass')) {
                    throw new Error(`the account #1 list shows ${JSON.stringify(rows)}`);
                }
            },
        },
        {
            name: 'C08 create an auto-categorization rule from Rent September',
            before: async (page) => {
                await openTransaction(page, 3, 'Rent September');
                const res = await page.request.get(`${origin(page)}/api/rules`);
                return { rules: (await res.json()).length };
            },
            run: async (page) => {
                await clickAt(page, page.getByRole('button', { name: 'Create auto-categorization rule', exact: true }));
                await page.locator('#rule-label').waitFor({ timeout: 20000 });
                await clickAt(page, page.locator('input[type="submit"][value="Create rule"]'));
            },
            assert: async (page, before) => {
                // Saving returns to the rules list. The checks wait for the list to show the rule, so a late
                // redirect cannot move the next step, and only then compare against the seed.
                const rules = await pollFor(async () => (await (await page.request.get(`${origin(page)}/api/rules`)).json()),
                    (r) => r.length === before.rules + 1, 10000);
                const shown = await pollFor(() => bodyText(page), (t) => t.includes('contains Rent September'), 10000);
                await pollFor(() => page.evaluate(() => window.location.hash), (h) => h.startsWith('#/rules'), 10000);
                if (before.rules !== 0) throw new Error(`${before.rules} rules before, expected none`);
                if (rules.length !== before.rules + 1) throw new Error(`${rules.length} rules, expected ${before.rules + 1}`);
                const labelled = rules.some((r) => r.conditions.some((c) => c.type === 'label_matches_text' && c.value === 'Rent September'));
                if (!labelled) throw new Error('the new rule has no condition on the Rent September label');
                if (!shown.includes('contains Rent September')) throw new Error('the rules list does not show the Rent September rule');
            },
        },
        {
            name: 'C09 add a category named Pets',
            before: async (page) => {
                await openCategories(page);
                return { names: await categoryNames(page) };
            },
            run: async (page) => {
                await clickAt(page, page.locator('button[aria-label="Add a category"]'));
                await typeInto(page, page.locator('#title'), 'Pets');
                await clickAt(page, page.locator('input[type="submit"][value="Save"]'));
            },
            assert: async (page, before) => {
                if (before.names.length !== 4) throw new Error(`${before.names.length} categories before, expected the four seeded`);
                const after = await pollFor(() => categoryNames(page), (n) => n.includes('Pets'), 10000);
                if (!after.includes('Pets')) throw new Error(`categories are ${JSON.stringify(after)}`);
                if (after.length !== 5) throw new Error(`${after.length} categories, expected 5`);
            },
        },
        {
            name: 'C10 rename the Groceries category to Food',
            before: async (page) => {
                await openCategories(page);
                return { names: await categoryNames(page) };
            },
            run: async (page) => {
                const row = page.locator('tr').filter({ has: page.getByText('Groceries', { exact: true }) });
                await clickAt(page, row.locator('button[aria-label="Update category"]'));
                await typeInto(page, page.locator('#title'), 'Food');
                await clickAt(page, page.locator('input[type="submit"][value="Save"]'));
            },
            assert: async (page, before) => {
                const after = await pollFor(() => categoryNames(page), (n) => n.includes('Food'), 10000);
                if (!after.includes('Food') || after.includes('Groceries')) throw new Error(`categories are ${JSON.stringify(after)}`);
                const table = await page.evaluate(() => document.querySelector('table').innerText);
                if (table.includes('Groceries')) throw new Error('the categories table still shows Groceries');
                if (!before.names.includes('Groceries')) throw new Error('Groceries was not listed before the rename');
            },
        },
        {
            name: 'C11 add the default categories',
            before: async (page) => {
                await openCategories(page);
                return { count: (await categoryNames(page)).length };
            },
            run: async (page) => {
                await clickAt(page, page.locator('button[aria-label="add default"]'));
            },
            assert: async (page, before) => {
                const after = await pollFor(() => categoryNames(page), (n) => n.length > before.count, 15000);
                if (after.length <= before.count) throw new Error(`still ${after.length} categories`);
                if (after.length <= 4) throw new Error(`${after.length} categories, not more than the four seeded`);
            },
        },
        {
            name: 'C12 set a planned budget of 300 for Groceries',
            before: async (page) => {
                await go(page, '#/view/account/1/budget');
                await budgetRow(page, 'Groceries').waitFor({ timeout: 20000 });
                return { total: await plannedTotal(page) };
            },
            run: async (page) => {
                // The Plus button is the row's sign control: it reads Plus, and a click turns it to Minus.
                await clickAt(page, budgetRow(page, 'Groceries').getByRole('button', { name: 'Plus', exact: true }));
                await typeInto(page, budgetRow(page, 'Groceries').locator('input').first(), '300');
                await page.keyboard.press('Enter');
            },
            assert: async (page, before) => {
                const sign = await pollFor(() => budgetRow(page, 'Groceries').locator('button.clickable').first().innerText(),
                    (s) => s.trim() === 'Minus', 10000);
                if (sign.trim() !== 'Minus') throw new Error(`the Groceries sign reads ${JSON.stringify(sign)}`);
                const planned = await budgetRow(page, 'Groceries').locator('input').first().inputValue();
                if (Number(planned) !== 300) throw new Error(`the Groceries planned budget field holds ${JSON.stringify(planned)}`);
                const total = await pollFor(() => plannedTotal(page), (t) => t.trim() === '-300.00', 10000);
                if (total.trim() !== '-300.00') throw new Error(`planned total shows ${JSON.stringify(total)}`);
                if (before.total.trim() !== '0.00') throw new Error(`planned total was ${JSON.stringify(before.total)} before, expected 0.00`);
                expectChange('the planned total', before.total.trim(), total.trim());
            },
        },
        {
            name: 'C13 choose the Last year chart period',
            before: async (page) => {
                await go(page, '#/view/account/1/charts/all');
                await page.locator('input#period').waitFor({ timeout: 20000 });
                return { period: await page.locator('input#period').inputValue() };
            },
            run: async (page) => {
                await clickAt(page, page.getByRole('button', { name: 'Last year', exact: true }));
            },
            assert: async (page, before) => {
                // The period buttons are not marked as selected; the period field shows the range.
                const now = new Date();
                const current = `${String(now.getMonth() + 1).padStart(2, '0')}/01/${now.getFullYear()}`;
                if (!before.period.startsWith(current)) throw new Error(`the period was ${before.period}, expected the current month from ${current}`);
                const after = await pollFor(() => page.locator('input#period').inputValue(),
                    (v) => v !== before.period, 10000);
                const year = now.getFullYear() - 1;
                if (after !== `01/01/${year} to 12/31/${year}`) {
                    throw new Error(`the period is ${after}, expected the previous calendar year`);
                }
            },
        },
        {
            name: 'C14 open the balance chart tab',
            before: async (page) => {
                await go(page, '#/view/account/1/charts/all');
                await page.locator('a[href="#/view/account/1/charts/balance"]').first().waitFor({ timeout: 20000 });
                return { hash: await page.evaluate(() => window.location.hash) };
            },
            run: async (page) => {
                await clickAt(page, page.getByRole('link', { name: 'balance', exact: true }));
            },
            assert: async (page, before) => {
                const hash = await pollFor(() => page.evaluate(() => window.location.hash), (h) => h.endsWith('/charts/balance'), 10000);
                if (!hash.endsWith('/charts/balance')) throw new Error(`hash is ${hash}`);
                const tab = await pollFor(() => page.getByRole('link', { name: 'balance', exact: true }).getAttribute('class'),
                    (c) => /\bactive\b/.test(c || ''), 10000);
                if (!/\bactive\b/.test(tab || '')) throw new Error(`the balance tab is not selected: class ${JSON.stringify(tab)}`);
                expectChange('the hash', before.hash, hash);
            },
        },
        {
            name: 'C15 create a view named Household with accounts #1 and #2',
            before: async (page) => {
                await go(page, '#/settings/views');
                await page.locator('a[href="#/settings/views/new"]').waitFor({ timeout: 20000 });
                const body = await bodyText(page);
                return { empty: body.includes('You have no custom views yet.') };
            },
            run: async (page) => {
                await clickAt(page, page.locator('a[href="#/settings/views/new"]'));
                await typeInto(page, page.locator('#custom-label-text'), 'Household');
                await pickFrom(page, page.locator('#view-combobox'), 'Manual account #1', { byKeyboard: true });
                await pickFrom(page, page.locator('#view-combobox'), 'Manual account #2', { byKeyboard: true });
                // Close the account menu, which covers the form's Save button.
                await page.keyboard.press('Escape');
                await clickAt(page, page.locator('input[type="submit"][value="Save"]'));
            },
            assert: async (page, before) => {
                if (!before.empty) throw new Error('the views list did not say "You have no custom views yet." before the step');
                const menu = await pollFor(() => menuText(page), (t) => t.includes('Household'), 10000);
                if (!menu.includes('Household')) throw new Error('the menu does not list Household');
                if (menu.includes('You have no custom views yet.')) throw new Error('the menu still says there are no custom views');
                const text = await pollFor(() => bodyText(page), (t) => t.includes('Household'), 10000);
                if (!text.includes('Household')) throw new Error('the views page does not list Household');
                if (text.includes('You have no custom views yet.')) throw new Error('the page still says there are no custom views');
            },
        },
        {
            name: 'C16 create a monthly recurring expense Gym of 30 on account #1',
            before: async (page) => {
                await go(page, '#/recurring-transactions/account/1');
                await page.locator('button[aria-label="New recurring transaction"]').waitFor({ timeout: 20000 });
                return { count: (await stored(page)).recurringTransactions.length };
            },
            run: async (page) => {
                await clickAt(page, page.locator('button[aria-label="New recurring transaction"]'));
                await typeInto(page, page.locator('#recurring-transaction-label'), 'Gym');
                await clickAt(page, page.locator('#recurring-transaction-amount-sign'));
                await typeInto(page, page.locator('#recurring-transaction-amount'), '30');
                await clickAt(page, page.locator('input[type="submit"][value="Save"]'));
            },
            assert: async (page, before) => {
                const list = await pollFor(async () => (await stored(page)).recurringTransactions,
                    (r) => r.some((x) => x.label === 'Gym'), 10000);
                const gym = list.find((x) => x.label === 'Gym');
                if (!gym) throw new Error('the Gym recurring transaction is not stored');
                if (list.length !== before.count + 1) throw new Error(`${list.length} recurring transactions, expected ${before.count + 1}`);
                if (gym.amount !== -30) throw new Error(`the Gym amount is ${gym.amount}, expected -30`);
                // The form's month list is empty by default, which the model stores as every month.
                if (gym.listOfMonths !== 'all') throw new Error(`the Gym months are ${gym.listOfMonths}, expected every month`);
                const rows = await pollFor(() => page.$$eval('table tbody tr', (trs) => trs.map((tr) => tr.innerText)),
                    (r) => r.some((t) => /\bGym\b/.test(t)), 10000);
                if (!rows.some((t) => /\bGym\b/.test(t))) throw new Error('the recurring transactions list has no Gym row');
            },
        },
        {
            name: 'C17 create a rule that sends labels containing Metro to Transport',
            before: async (page) => {
                await go(page, '#/rules');
                await page.locator('button[aria-label="New rule"]').waitFor({ timeout: 20000 });
                const res = await page.request.get(`${origin(page)}/api/rules`);
                const body = await bodyText(page);
                return { rules: (await res.json()).length, empty: body.includes("You haven't set any rules yet!") };
            },
            run: async (page) => {
                await clickAt(page, page.locator('button[aria-label="New rule"]'));
                await typeInto(page, page.locator('#rule-label'), 'Metro');
                await pickFrom(page, page.locator('#rule-category'), 'Transport');
                await clickAt(page, page.locator('input[type="submit"][value="Create rule"]'));
            },
            assert: async (page, before) => {
                // Saving returns to the rules list. The checks wait for the list to show the new rule, so a late
                // redirect cannot move the next step, and only then compare against the seed.
                const after = await pollFor(async () => (await (await page.request.get(`${origin(page)}/api/rules`)).json()).length,
                    (n) => n === before.rules + 1, 10000);
                const shown = await pollFor(() => bodyText(page), (t) => t.includes('contains Metro then categorize it as Transport'), 10000);
                await pollFor(() => page.evaluate(() => window.location.hash), (h) => h.startsWith('#/rules'), 10000);
                if (before.rules !== 0 || !before.empty) throw new Error("the rules list did not say \"You haven't set any rules yet!\" before");
                if (after !== before.rules + 1) throw new Error(`${after} rules, expected ${before.rules + 1}`);
                if (!shown.includes('contains Metro then categorize it as Transport')) throw new Error('the rules list does not show the new rule');
                if (shown.includes("You haven't set any rules yet!")) throw new Error('the rules list still says there are no rules');
            },
        },
        {
            name: 'C18 rename the Manual Bank access to Bench bank',
            before: async (page) => {
                await go(page, '#/accesses');
                await clearToasts(page);
                await clickAt(page, page.locator('a[href="#/accesses/edit-access/1"]'));
                await page.locator('#custom-label-text').waitFor({ timeout: 20000 });
                return {};
            },
            run: async (page) => {
                await typeInto(page, page.locator('#custom-label-text'), 'Bench bank');
                await page.keyboard.press('Tab');
            },
            assert: async (page) => {
                const access = await pollFor(async () => (await stored(page)).accesses.find((a) => a.id === 1),
                    (a) => a && a.customLabel === 'Bench bank', 10000);
                if (!access || access.customLabel !== 'Bench bank') throw new Error(`stored access label is ${access && access.customLabel}`);
                const header = await pollFor(() => bodyText(page), (t) => t.includes('Edit current access: Bench bank'), 10000);
                if (!header.includes('Edit current access: Bench bank')) throw new Error('the access page header does not show Bench bank');
                const menu = await pollFor(() => menuText(page), (t) => t.includes('Bench bank'), 10000);
                if (!menu.includes('Bench bank') || menu.includes('Manual Bank')) throw new Error(`the menu access entry reads ${JSON.stringify(menu)}`);
            },
        },
        {
            name: 'C19 give Manual account #3 the custom label Savings wallet',
            before: async (page) => {
                await go(page, '#/accesses');
                await clearToasts(page);
                await clickAt(page, page.locator('a[href="#/accesses/edit-account/3"]'));
                await page.locator('#custom-label-text').waitFor({ timeout: 20000 });
                return {};
            },
            run: async (page) => {
                await typeInto(page, page.locator('#custom-label-text'), 'Savings wallet');
                await clickAt(page, page.getByRole('button', { name: 'Save', exact: true }));
            },
            assert: async (page) => {
                const account = await pollFor(async () => (await stored(page)).accounts.find((a) => a.id === 3),
                    (a) => a && a.customLabel === 'Savings wallet', 10000);
                if (!account || account.customLabel !== 'Savings wallet') throw new Error(`stored label is ${account && account.customLabel}`);
                // The account's side-menu entry is shown on the dashboard, not on the accesses pages.
                await go(page, '#/dashboard');
                const entry = await pollFor(() => page.evaluate(() => {
                    const a = document.querySelector('a[href="#/view/account/3/reports"]');
                    return a ? a.innerText : '';
                }), (t) => t.startsWith('Savings wallet'), 10000);
                if (!entry.startsWith('Savings wallet') || entry.includes('Manual account #3')) {
                    throw new Error(`the side menu entry for account #3 reads ${JSON.stringify(entry)}`);
                }
            },
        },
        {
            name: 'C20 open Manual account #2 from the side menu',
            before: async (page) => {
                await go(page, '#/dashboard');
                await page.locator('a[href="#/view/account/2/reports"]').first().waitFor({ timeout: 20000 });
                return { hash: await page.evaluate(() => window.location.hash) };
            },
            run: async (page) => {
                await clickAt(page, page.locator('a[href="#/view/account/2/reports"]').first());
            },
            assert: async (page, before) => {
                const rows = await pollFor(() => labels(page), (r) => r.includes('Savings transfer'), 10000);
                const hash = await page.evaluate(() => window.location.hash);
                if (!hash.startsWith('#/view/account/2/')) throw new Error(`hash is ${hash}`);
                if (!rows.includes('Savings transfer')) throw new Error(`rows are ${JSON.stringify(rows)}`);
                const active = await page.evaluate(() => [...document.querySelectorAll('a[href="#/view/account/2/reports"]')]
                    .some((a) => /\bactive\b/.test(a.className)));
                if (!active) throw new Error('the side menu does not mark Manual account #2 as the active entry');
                expectChange('the hash', before.hash, hash);
            },
        },
        {
            name: 'C21 open the EUR global view',
            before: async (page) => {
                await go(page, '#/dashboard');
                await page.locator('a[href="#/view/currency/EUR/reports"]').first().waitFor({ timeout: 20000 });
                return { hash: await page.evaluate(() => window.location.hash) };
            },
            run: async (page) => {
                await clickAt(page, page.locator('a[href="#/view/currency/EUR/reports"]').first());
            },
            assert: async (page, before) => {
                const hash = await pollFor(() => page.evaluate(() => window.location.hash), (h) => h.startsWith('#/view/currency/EUR/'), 10000);
                if (!hash.startsWith('#/view/currency/EUR/')) throw new Error(`hash is ${hash}`);
                const rows = await pollFor(() => labels(page), (r) => r.includes('Savings transfer'), 10000);
                if (!rows.includes('Savings transfer')) throw new Error('the EUR view does not list the account #2 transaction');
                const menu = await pollFor(() => menuText(page), (t) => /Total\s+1\s*072,20\s*€/.test(t), 10000);
                if (!/Total\s+1\s*072,20\s*€/.test(menu)) throw new Error('the side menu does not show the Total of 1 072,20 €');
                expectChange('the hash', before.hash, hash);
            },
        },
        {
            name: 'C22 switch the language to Français',
            before: async (page) => {
                await go(page, '#/settings/customization');
                await page.locator('#locale-selector').waitFor({ timeout: 20000 });
                return { locale: await page.locator('#locale-selector').inputValue() };
            },
            run: async (page) => {
                await clickAt(page, page.locator('#locale-selector'));
                await page.locator('#locale-selector').selectOption({ label: 'Français' });
            },
            assert: async (page, before) => {
                const setting = await pollFor(async () => (await stored(page)).settings.find((s) => s.key === 'locale'),
                    (s) => s && s.value === 'fr', 10000);
                if (!setting || setting.value !== 'fr') throw new Error('the locale setting was not stored as fr');
                const selector = await pollFor(() => page.locator('#locale-selector').inputValue(), (v) => v === 'fr', 10000);
                if (selector !== 'fr') throw new Error(`the language selector reads ${selector}`);
                expectChange('the language selector', before.locale, selector);
                // The side menu's sections are shown in French on an account page: Reports is Relevé.
                await go(page, '#/view/account/1/reports');
                const shown = await pollFor(() => page.$$eval('a[href="#/view/account/1/reports"]',
                    (els) => els.some((e) => e.innerText.trim() === 'Relevé' && e.getClientRects().length > 0)), (ok) => ok, 10000);
                if (!shown) throw new Error('Reports is not shown as Relevé');
            },
        },
        {
            name: 'C23 set the budget month of Rent September to Previous',
            before: async (page) => {
                await openTransaction(page, 3, 'Rent September');
                return { months: await budgetMonths(page) };
            },
            run: async (page) => {
                // The first of the three buttons is Previous. Its label follows the app's language, which an
                // earlier case may have changed in the same page, so the button is found by its place.
                await clickAt(page, page.locator('button.budget-assignment').first());
            },
            assert: async (page, before) => {
                if (before.months.some((m) => m.active)) throw new Error(`a budget month was already selected: ${JSON.stringify(before.months)}`);
                const after = await pollFor(() => budgetMonths(page), (ms) => ms.length > 0 && ms[0].active, 10000);
                if (!after.length || !after[0].active) throw new Error(`Previous is not selected: ${JSON.stringify(after)}`);
                expectChange('the budget month buttons', before.months, after);
            },
        },
    ],
};
