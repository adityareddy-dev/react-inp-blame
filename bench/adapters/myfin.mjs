// myfin (afaneca/myfin, GPL-3.0), frontend pinned at 18377ad3f78057e519cf880a35f13831514821e6
// (package myfin-web 10.7.0). Its API is afaneca/myfin-api (GPL-3.0), pinned at
// 3b6936a9b707650d48986f8a16fde02b02615868 (tag 5.5.0), run on MariaDB 10.11 at 127.0.0.1:5451.
//
// The frontend is a static single-page app whose API origin is compiled in at build time. For a run,
// this adapter starts the backend on 127.0.0.1:5325 (one process, shared by configurations A, B and C
// and reference-counted, because bench.mjs opens all three servers before a run), serves the
// configuration's dist on its page port, restores the database to a seed before every run, and signs
// in as the seeded local user through the app's own POST /auth, storing the session as the app does.
//
// Fixtures and choices the steps depend on (see the notes that accompany this adapter):
//   - The seeded user starts in the light theme (myfin.uiMode). The app's default is dark, which would
//     make the dark-theme selection in C23 change nothing.
//   - The add-account form needs an account type to save, so C08 selects Current account.
//   - The API's per-client limit (100 requests a minute) is not changed. Each step waits for the window
//     to reset when the server's own headers show too little room for it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Same directories apps.mjs assigns. An adapter may not change them.
const DIR = path.join(HERE, '..', 'clones', 'myfin');
const STATE = path.join(HERE, '..', 'state', 'myfin');
const CRED = path.join(STATE, 'credentials.json');
const RUN = path.join(STATE, 'run');
const DATA = path.join(STATE, 'mariadb');

// The backend: a clone of afaneca/myfin-api, checked out at the pin below. MYFIN_API_SOURCE can name a local copy.
const BACKEND_SOURCE = process.env.MYFIN_API_SOURCE || 'https://github.com/afaneca/myfin-api.git';
const BACKEND_DIR = path.join(HERE, '..', 'clones', 'myfin-api');
const BACKEND_SHA = '3b6936a9b707650d48986f8a16fde02b02615868';

const DB_PORT = 5451;
const DB_NAME = 'myfin';
const API_PORT = 5325;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
// The page ports apps.mjs assigns to myfin. Repeated here because an adapter cannot import apps.mjs.
const PAGE_PORTS = { A: 5313, B: 5314, C: 5315 };
const DISTS = { A: 'dist-a', B: 'dist-b', C: 'dist-c' };

// The library pin for B and C, exactly as npm 10 writes it for react-inp-blame@1.0.0.
const LIB_NAME = 'react-inp-blame';
const LIB_VERSION = '1.0.0';
const LIB_LOCK_ENTRY = {
  version: '1.0.0',
  resolved: 'https://registry.npmjs.org/react-inp-blame/-/react-inp-blame-1.0.0.tgz',
  integrity: 'sha512-wEQcaqyjZaZ6rnIC7vqkK3eSX4Zl9Y1wBlIFjg1LlfwcsLmsU5li0gBtzxlXhEwiSFnRSU/arBduorTMltkgJg==',
  license: 'MIT',
  engines: { node: '>=20.19' },
  peerDependencies: { astro: '*', next: '*', react: '*', 'react-dom': '*', vite: '*' },
  peerDependenciesMeta: {
    astro: { optional: true },
    next: { optional: true },
    react: { optional: true },
    'react-dom': { optional: true },
    vite: { optional: true },
  },
};

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// Proposed origin of the backend API, compiled into every configuration as VITE_MYFIN_BASE_API_URL
// (src/config/index.ts reads it at build time). 5325 is inside the contract's 5310-5330 range and no
// cohort app uses it.
const API_BUILD_ORIGIN = API_ORIGIN;

// Bench-only build configuration, written into the clone. It extends the upstream vite.config.ts.
// The library plugin needs enabled: 'production', because enabled defaults to 'development' and that
// default leaves the plugin out of a production build.
const BENCH_VITE_CONFIG = `// Bench-only build configuration written by bench/adapters/myfin.mjs. Not part of the upstream project.
import { defineConfig } from 'vite';
import base from './vite.config';

const config = process.env.BENCH_CONFIG ?? '';
const outDir = process.env.BENCH_OUTDIR ?? 'dist';

export default defineConfig(async () => {
  const plugins = [...(base.plugins ?? [])];
  if (config === 'b' || config === 'c') {
    const { inpBlame } = await import('react-inp-blame/vite');
    const runtime = config === 'c' ? { debugGlobal: true, overlay: true } : { debugGlobal: true };
    // The upstream list is [react(...), version()]: the library plugin goes after the framework plugin.
    plugins.splice(1, 0, inpBlame({ enabled: 'production', runtime }));
  } else if (config !== '') {
    throw new Error(\`unknown BENCH_CONFIG '\${config}'\`);
  }
  return {
    ...base,
    plugins,
    build: { ...base.build, outDir },
  };
});
`;

// ---------------------------------------------------------------- frontend clone

/** Throws unless the frontend clone is at the pinned commit. */
function checkPinnedCommit() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DIR, encoding: 'utf8' }).trim();
  if (head !== '18377ad3f78057e519cf880a35f13831514821e6') {
    throw new Error(`myfin clone is at ${head}, not the pinned 18377ad3f78057e519cf880a35f13831514821e6`);
  }
}

/**
 * Adds react-inp-blame@1.0.0 to the manifest and lockfile, in sorted position, and changes nothing
 * else. Idempotent. `npm install` would rewrite about 40 unrelated lockfile entries under npm 10, so
 * the entry is written directly and `npm ci` then verifies it against the registry tarball.
 */
function applyLibraryPin() {
  const pkgFile = path.join(DIR, 'package.json');
  const lockFile = path.join(DIR, 'package-lock.json');
  // Inserts a key before the first existing key that sorts after it, as npm does.
  const insertSorted = (obj, key, value) => {
    const out = {};
    let done = false;
    for (const k of Object.keys(obj)) {
      if (!done && k > key) {
        out[key] = value;
        done = true;
      }
      out[k] = obj[k];
    }
    if (!done) out[key] = value;
    return out;
  };

  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  if (pkg.dependencies[LIB_NAME] === undefined) {
    pkg.dependencies = insertSorted(pkg.dependencies, LIB_NAME, LIB_VERSION);
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  } else if (pkg.dependencies[LIB_NAME] !== LIB_VERSION) {
    throw new Error(`package.json pins ${LIB_NAME} at ${pkg.dependencies[LIB_NAME]}, not ${LIB_VERSION}`);
  }

  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  if (!lock.packages[''].dependencies[LIB_NAME]) {
    lock.packages[''].dependencies = insertSorted(lock.packages[''].dependencies, LIB_NAME, LIB_VERSION);
  }
  if (!lock.packages[`node_modules/${LIB_NAME}`]) {
    lock.packages = insertSorted(lock.packages, `node_modules/${LIB_NAME}`, LIB_LOCK_ENTRY);
    fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  }
}

/** Writes the bench-only build configuration and keeps it out of the clone's git status. */
function writeBenchConfig() {
  fs.writeFileSync(path.join(DIR, 'vite.bench.config.ts'), BENCH_VITE_CONFIG);
  const exclude = path.join(DIR, '.git', 'info', 'exclude');
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!current.split('\n').includes('vite.bench.config.ts')) {
    fs.appendFileSync(exclude, 'vite.bench.config.ts\n');
  }
}

// ---------------------------------------------------------------- backend clone and install

/** Clones the backend at the pin if needed, and verifies the checkout. */
function ensureBackendClone() {
  if (!fs.existsSync(path.join(BACKEND_DIR, '.git'))) {
    execFileSync('git', ['clone', '-q', BACKEND_SOURCE, BACKEND_DIR], { stdio: 'inherit' });
  }
  execFileSync('git', ['-C', BACKEND_DIR, 'checkout', '-q', '--detach', BACKEND_SHA], { stdio: 'inherit' });
  const head = execFileSync('git', ['-C', BACKEND_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== BACKEND_SHA) throw new Error(`backend clone is at ${head}, not ${BACKEND_SHA}`);
}

/** Lazily loads a module from the backend's own node_modules, so the adapter never bundles a copy. */
const backendRequire = (name) => createRequire(path.join(BACKEND_DIR, 'package.json'))(name);

// ---------------------------------------------------------------- state and credentials

const benchIds = () => {
  const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith('bench:'));
  const [, , uid, gid] = line.split(':');
  return { uid: Number(uid), gid: Number(gid) };
};
const isRoot = () => process.getuid?.() === 0;

/** Hands a path under the state directory to the bench user when this process is root. */
function ownForBench(p) {
  if (!isRoot()) return;
  const { uid, gid } = benchIds();
  execFileSync('chown', ['-R', `${uid}:${gid}`, p]);
}

/** The command and arguments that run as the unprivileged bench user, when this process is root. */
const asBench = (cmd, args) =>
  isRoot() ? ['runuser', ['-u', 'bench', '--', cmd, ...args]] : [cmd, args];

/**
 * The local state's credentials, created once with random secrets and kept mode 600. The database
 * password is for the app's own user; the login is the seeded local user. Nothing here leaves the
 * machine, and bench/state is gitignored.
 */
function loadCredentials() {
  fs.mkdirSync(STATE, { recursive: true });
  if (!fs.existsSync(CRED)) {
    const bcrypt = backendRequire('bcrypt');
    const loginPassword = crypto.randomBytes(12).toString('hex');
    const creds = {
      db: { user: 'myfin', password: crypto.randomBytes(16).toString('hex'), name: DB_NAME, port: DB_PORT },
      login: {
        username: 'bench',
        password: loginPassword,
        email: 'bench@example.com',
        passwordHash: bcrypt.hashSync(loginPassword, 10),
      },
    };
    fs.writeFileSync(CRED, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
    ownForBench(STATE);
  }
  const creds = JSON.parse(fs.readFileSync(CRED, 'utf8'));
  if (!creds.login.passwordHash) {
    creds.login.passwordHash = backendRequire('bcrypt').hashSync(creds.login.password, 10);
    fs.writeFileSync(CRED, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
    ownForBench(CRED);
  }
  return creds;
}

// ---------------------------------------------------------------- database

const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts MariaDB 10.11 on 127.0.0.1:5451 as the bench user if it is not already listening. The data
 * directory is initialised once. The bootstrap SQL creates the app database and user from the
 * credentials file, and runs at each start, so it is idempotent.
 */
async function ensureDatabase(creds) {
  if (await portOpen(DB_PORT)) return;
  fs.mkdirSync(RUN, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  const sock = path.join(RUN, 'mysqld.sock');
  const { escape } = backendRequire('mysql2');
  const pw = escape(creds.db.password);
  const init = [
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    `CREATE USER IF NOT EXISTS 'myfin'@'127.0.0.1' IDENTIFIED BY ${pw};`,
    `CREATE USER IF NOT EXISTS 'myfin'@'localhost' IDENTIFIED BY ${pw};`,
    `ALTER USER 'myfin'@'127.0.0.1' IDENTIFIED BY ${pw};`,
    `ALTER USER 'myfin'@'localhost' IDENTIFIED BY ${pw};`,
    `GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO 'myfin'@'127.0.0.1';`,
    `GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO 'myfin'@'localhost';`,
    'FLUSH PRIVILEGES;',
  ].join('\n') + '\n';
  const initFile = path.join(RUN, 'init.sql');
  fs.writeFileSync(initFile, init, { mode: 0o600 });
  ownForBench(STATE);

  if (!fs.existsSync(path.join(DATA, 'mysql'))) {
    const args = ['--no-defaults', `--datadir=${DATA}`, '--basedir=/usr', '--auth-root-authentication-method=normal', '--skip-test-db'];
    if (isRoot()) args.push('--user=bench');
    const [cmd, cmdArgs] = asBench('mariadb-install-db', args);
    execFileSync(cmd, cmdArgs, { stdio: ['ignore', fs.openSync(path.join(RUN, 'install-db.log'), 'w'), 'inherit'] });
    ownForBench(STATE);
  }

  const args = [
    '--no-defaults',
    `--datadir=${DATA}`,
    `--port=${DB_PORT}`,
    '--bind-address=127.0.0.1',
    `--socket=${sock}`,
    `--pid-file=${path.join(RUN, 'mariadb.pid')}`,
    `--log-error=${path.join(RUN, 'mariadb.err.log')}`,
    `--init-file=${initFile}`,
    '--skip-name-resolve',
    '--innodb-buffer-pool-size=256M',
  ];
  if (isRoot()) args.push('--user=bench');
  const [cmd, cmdArgs] = asBench('mariadbd', args);
  const log = fs.openSync(path.join(RUN, 'mariadb.out.log'), 'a');
  const child = spawn(cmd, cmdArgs, { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  for (let i = 0; i < 120; i += 1) {
    if (await portOpen(DB_PORT)) return;
    await sleep(500);
  }
  throw new Error(`MariaDB did not listen on 127.0.0.1:${DB_PORT}; see ${RUN}/mariadb.err.log`);
}

const dbConnection = async (creds) => {
  const mysql = backendRequire('mysql2/promise');
  return mysql.createConnection({
    host: '127.0.0.1',
    port: DB_PORT,
    user: creds.db.user,
    password: creds.db.password,
    database: DB_NAME,
    multipleStatements: true,
  });
};

let schemaReady = null;
/** Runs the backend's own migrations (its db:deploy script) once per process. Idempotent. */
function ensureSchema(creds) {
  schemaReady ??= (async () => {
    const env = {
      ...process.env,
      DB_NAME,
      DB_USER: creds.db.user,
      DB_PW: creds.db.password,
      DB_HOST: '127.0.0.1',
      DB_PORT: String(DB_PORT),
    };
    execFileSync(NPM, ['run', 'db:deploy'], { cwd: BACKEND_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

// The seed. Every date is pinned: transactions fall on fixed days of 2025 and 2026, and budgets, goals
// and rules are fixed. Money is integer cents, as the backend stores it. Timestamps are Unix seconds.
const at = (y, m, d, h = 12) => Math.floor(Date.UTC(y, m - 1, d, h) / 1000);
const SEED_MONTHS = [
  [2025, 11], [2025, 12], [2026, 1], [2026, 2], [2026, 3], [2026, 4], [2026, 5], [2026, 6], [2026, 7], [2026, 8], [2026, 9], [2026, 10],
];
const OPEN_MONTHS = new Set(['2026-9', '2026-10']);
const ACCOUNTS = [
  { account_id: 1, name: 'Current account', type: 'CHEAC', exclude_from_budgets: 0 },
  { account_id: 2, name: 'Savings', type: 'SAVAC', exclude_from_budgets: 0 },
  { account_id: 3, name: 'Credit card', type: 'CREAC', exclude_from_budgets: 0 },
  { account_id: 4, name: 'Wallet', type: 'WALLET', exclude_from_budgets: 0 },
  { account_id: 5, name: 'Brokerage', type: 'INVAC', exclude_from_budgets: 1 },
];
const ENTITIES = [
  { entity_id: 1, name: 'Supermarket' },
  { entity_id: 2, name: 'Employer Ltd' },
  { entity_id: 3, name: 'Electric utility' },
  { entity_id: 4, name: 'Coffee shop' },
  { entity_id: 5, name: 'Bookshop' },
];
const CATEGORIES = [
  { category_id: 1, name: 'Groceries', type: 'E' },
  { category_id: 2, name: 'Dining out', type: 'E' },
  { category_id: 3, name: 'Housing', type: 'E' },
  { category_id: 4, name: 'Transport', type: 'E' },
  { category_id: 5, name: 'Leisure', type: 'E' },
  { category_id: 6, name: 'Salary', type: 'I' },
];
const TAGS = [
  { tag_id: 1, name: 'Holiday' },
  { tag_id: 2, name: 'Work' },
  { tag_id: 3, name: 'Recurring' },
];

/** The seeded transactions: seven per month, each with a unique description that names its month. */
function seedTransactions() {
  const out = [];
  let id = 1;
  SEED_MONTHS.forEach(([y, m], i) => {
    const tag = `${y}-${m}`;
    const push = (row) => out.push({ transaction_id: id++, ...row });
    push({ date_timestamp: at(y, m, 1), amount: 4000, type: 'E', description: `Metro monthly pass ${tag}`, entities_entity_id: null, accounts_account_from_id: 4, accounts_account_to_id: null, categories_category_id: 4, is_essential: 1, tags: [] });
    push({ date_timestamp: at(y, m, 3), amount: 4200 + ((i * 73) % 900), type: 'E', description: `Weekly shop at Supermarket ${tag}`, entities_entity_id: 1, accounts_account_from_id: 1, accounts_account_to_id: null, categories_category_id: 1, is_essential: 1, tags: [] });
    push({ date_timestamp: at(y, m, 5), amount: 230000, type: 'I', description: `Monthly salary ${tag}`, entities_entity_id: 2, accounts_account_from_id: null, accounts_account_to_id: 1, categories_category_id: 6, is_essential: 0, tags: [2] });
    push({ date_timestamp: at(y, m, 8), amount: 350 + ((i * 31) % 200), type: 'E', description: `Bakery breakfast ${tag}`, entities_entity_id: 4, accounts_account_from_id: 4, accounts_account_to_id: null, categories_category_id: 2, is_essential: 0, tags: [] });
    push({ date_timestamp: at(y, m, 10), amount: 6400 + ((i * 57) % 500), type: 'E', description: `Electricity bill ${tag}`, entities_entity_id: 3, accounts_account_from_id: 1, accounts_account_to_id: null, categories_category_id: 3, is_essential: 1, tags: [3] });
    push({ date_timestamp: at(y, m, 12), amount: 50000, type: 'T', description: `Transfer to savings ${tag}`, entities_entity_id: null, accounts_account_from_id: 1, accounts_account_to_id: 2, categories_category_id: null, is_essential: 0, tags: [] });
    push({ date_timestamp: at(y, m, 14), amount: 1899, type: 'E', description: `Bookshop visit ${tag}`, entities_entity_id: 5, accounts_account_from_id: 3, accounts_account_to_id: null, categories_category_id: 5, is_essential: 0, tags: [1] });
  });
  return out;
}

/** The complete seed as SQL: every table truncated, then the seeded rows, with foreign keys off. */
function buildSeedSql(creds, tables) {
  const { escape } = backendRequire('mysql2');
  const lit = (v) => (v === null || v === undefined ? 'NULL' : escape(v));
  const insert = (table, rows) =>
    rows.map((r) => {
      const cols = Object.keys(r);
      return `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map((c) => lit(r[c])).join(', ')});`;
    });

  const trx = seedTransactions();
  const balance = Object.fromEntries(ACCOUNTS.map((a) => [a.account_id, 0]));
  for (const t of trx) {
    if (t.accounts_account_to_id) balance[t.accounts_account_to_id] += t.amount;
    if (t.accounts_account_from_id) balance[t.accounts_account_from_id] -= t.amount;
  }

  const monthKey = (ts) => {
    const d = new Date(ts * 1000);
    return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
  };
  const budgets = SEED_MONTHS.map(([y, m], i) => ({
    budget_id: i + 1,
    month: m,
    year: y,
    observations: null,
    is_open: OPEN_MONTHS.has(`${y}-${m}`) ? 1 : 0,
    initial_balance: 0,
    users_user_id: 1,
  }));
  const budgetCategories = [];
  for (const b of budgets) {
    for (const c of CATEGORIES) {
      const inMonth = trx.filter((t) => t.categories_category_id === c.category_id && monthKey(t.date_timestamp) === `${b.year}-${b.month}`);
      const current = inMonth.reduce((s, t) => s + t.amount, 0);
      budgetCategories.push({
        budgets_budget_id: b.budget_id,
        budgets_users_user_id: 1,
        categories_category_id: c.category_id,
        planned_amount_debit: c.type === 'E' ? 50000 : 0,
        planned_amount_credit: c.type === 'I' ? 230000 : 0,
        current_amount: current,
      });
    }
  }

  const now = at(2026, 10, 1);
  const goals = [
    { goal_id: 1, name: 'Emergency fund', description: 'Six months of essential costs', priority: 1, amount: 1000000, due_date: at(2027, 6, 30), is_archived: 0, created_at: at(2026, 1, 5), updated_at: now, users_user_id: 1 },
    { goal_id: 2, name: 'New laptop', description: null, priority: 2, amount: 150000, due_date: null, is_archived: 0, created_at: at(2026, 2, 10), updated_at: now, users_user_id: 1 },
    { goal_id: 3, name: 'Holiday', description: 'Two weeks away', priority: 3, amount: 80000, due_date: at(2026, 8, 31), is_archived: 0, created_at: at(2026, 1, 20), updated_at: now, users_user_id: 1 },
  ];
  const goalAccounts = [
    { goals_goal_id: 1, accounts_account_id: 2, match_type: 'absolute', match_value: 250000 },
    { goals_goal_id: 2, accounts_account_id: 2, match_type: 'absolute', match_value: 40000 },
    { goals_goal_id: 3, accounts_account_id: 2, match_type: 'absolute', match_value: 80000 },
  ];
  const rules = [
    { rule_id: 1, matcher_description_operator: 'CONTAINS', matcher_description_value: 'Supermarket', assign_category_id: 1, assign_entity_id: 1, users_user_id: 1, assign_is_essential: 1 },
    { rule_id: 2, matcher_description_operator: 'CONTAINS', matcher_description_value: 'Bakery', assign_category_id: 2, assign_entity_id: 4, users_user_id: 1, assign_is_essential: 0 },
    { rule_id: 3, matcher_description_operator: 'CONTAINS', matcher_description_value: 'Electricity', assign_category_id: 3, assign_entity_id: 3, users_user_id: 1, assign_is_essential: 1 },
  ];
  const users = [
    { user_id: 1, username: creds.login.username, password: creds.login.passwordHash, email: creds.login.email, is_demo: 0, sessionkey: null, sessionkey_mobile: null, trustlimit: null, trustlimit_mobile: null, last_update_timestamp: 0, currency: 'EUR' },
  ];
  const accounts = ACCOUNTS.map((a) => ({
    ...a,
    description: null,
    status: 'Ativa',
    users_user_id: 1,
    current_balance: balance[a.account_id],
    created_timestamp: at(2025, 10, 1),
    updated_timestamp: now,
    color_gradient: null,
  }));
  const categories = CATEGORIES.map((c) => ({ ...c, users_user_id: 1, description: null, color_gradient: null, icon_key: 'category', status: 'Ativa', exclude_from_budgets: 0 }));
  const entities = ENTITIES.map((e) => ({ ...e, users_user_id: 1 }));
  const tags = TAGS.map((t) => ({ ...t, description: null, users_user_id: 1 }));
  const trxTags = trx.flatMap((t) => t.tags.map((tagId) => ({ transactions_transaction_id: t.transaction_id, tags_tag_id: tagId })));
  const trxRows = trx.map(({ tags, ...row }) => ({ ...row, is_essential: row.is_essential ? 1 : 0 }));

  const truncate = tables.map((t) => `TRUNCATE TABLE \`${t}\`;`);
  const load = [
    ...insert('users', users),
    ...insert('accounts', accounts),
    ...insert('entities', entities),
    ...insert('categories', categories),
    ...insert('tags', tags),
    ...insert('transactions', trxRows),
    ...insert('transaction_has_tags', trxTags),
    ...insert('budgets', budgets),
    ...insert('budgets_has_categories', budgetCategories),
    ...insert('goals', goals),
    ...insert('goal_has_account', goalAccounts),
    ...insert('rules', rules),
  ];
  return ['SET FOREIGN_KEY_CHECKS=0;', ...truncate, ...load, 'SET FOREIGN_KEY_CHECKS=1;'].join('\n');
}

/** Restores the seed: every table truncated, then the seeded rows. Runs before every run. */
async function restoreSeed(creds) {
  const conn = await dbConnection(creds);
  try {
    const [rows] = await conn.query(
      "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_name <> '_prisma_migrations' ORDER BY table_name",
      [DB_NAME],
    );
    const tables = rows.map((r) => r.t);
    await conn.query(buildSeedSql(creds, tables));
    const [[users]] = await conn.query('SELECT COUNT(*) AS n FROM users');
    if (users.n !== 1) throw new Error(`seed restore left ${users.n} users, expected 1`);
  } finally {
    await conn.end();
  }
}

// ---------------------------------------------------------------- backend API

let backendProc = null;
let backendRefs = 0;
let backendStarting = null;

async function waitForHttp(url, proc, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`the myfin API exited before it answered (see ${RUN}/api.log)`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`the myfin API did not answer at ${url} within ${ms} ms`);
    await sleep(300);
  }
}

// The entry the harness starts. It is src/server.ts with the listen address restricted to 127.0.0.1:
// the upstream server calls app.listen(PORT) with no host, which listens on every interface. It is
// written into the backend's build output (dist/), not the upstream source, by install().
const BENCH_SERVER = `// Bench-only entry written by bench/adapters/myfin.mjs. Not part of the upstream project.
// src/server.ts, except that it listens on 127.0.0.1 only.
import 'dotenv/config.js';
process.env.TZ = 'Etc/UTC';
const { default: app } = await import('./app.js');
const { default: DemoAccountScheduler } = await import('./utils/demoAccountScheduler.js');
const PORT = process.env.PORT || 3001;
DemoAccountScheduler.start();
app.listen(PORT, '127.0.0.1', () => {
  console.log(\`MyFin server listening on 127.0.0.1:\${PORT}\`);
});
`;
const BENCH_SERVER_FILE = path.join(BACKEND_DIR, 'dist', 'bench-server.js');
const API_PID = path.join(RUN, 'api.pid');

/** Writes the bench entry into the backend build output. */
function writeBenchServer() {
  fs.writeFileSync(BENCH_SERVER_FILE, BENCH_SERVER);
}

/** Stops a backend this adapter started in an earlier process that did not exit cleanly. */
async function reclaimStaleBackend() {
  if (!(await portOpen(API_PORT))) return;
  let pid = null;
  try {
    pid = Number(fs.readFileSync(API_PID, 'utf8').trim());
  } catch {
    pid = null;
  }
  let ours = false;
  if (pid) {
    try {
      ours = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('bench-server.js');
    } catch {
      ours = false;
    }
  }
  if (!ours) {
    throw new Error(`127.0.0.1:${API_PORT} is already listening and is not a bench API; the myfin API needs that port`);
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 40 && (await portOpen(API_PORT)); i += 1) await sleep(250);
  if (await portOpen(API_PORT)) throw new Error(`a stale bench API (pid ${pid}) still holds ${API_PORT}`);
}

async function launchBackend(creds) {
  await reclaimStaleBackend();
  await ensureDatabase(creds);
  await ensureSchema(creds);
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DB_NAME,
    DB_USER: creds.db.user,
    DB_PW: creds.db.password,
    DB_HOST: '127.0.0.1',
    DB_PORT: String(DB_PORT),
    PORT: String(API_PORT),
    LOGGING: 'false',
    BYPASS_SESSION_CHECK: 'false',
    ENABLE_USER_SIGNUP: 'false',
    TRUST_PROXY: '1',
    SMTP_HOST: '',
    SMTP_PORT: '',
    SMTP_SECURE: '',
    SMTP_USER: '',
    SMTP_PASSWORD: '',
    SMTP_FROM: '',
  };
  writeBenchServer();
  fs.mkdirSync(RUN, { recursive: true });
  const log = fs.openSync(path.join(RUN, 'api.log'), 'a');
  // A process group of its own, so closing it kills the whole tree.
  const proc = spawn(process.execPath, ['dist/bench-server.js'], { cwd: BACKEND_DIR, env, detached: true, stdio: ['ignore', log, log] });
  fs.writeFileSync(API_PID, `${proc.pid}\n`);
  backendProc = proc;
  await waitForHttp(`${API_ORIGIN}/`, proc, 60000);
}

async function killTree(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, 5000);
  await exited;
  clearTimeout(timer);
}

async function acquireBackend(creds) {
  backendRefs += 1;
  try {
    if (!backendStarting) backendStarting = launchBackend(creds);
    await backendStarting;
  } catch (err) {
    backendRefs -= 1;
    if (backendRefs === 0) {
      const proc = backendProc;
      backendProc = null;
      backendStarting = null;
      if (proc) await killTree(proc);
    }
    throw err;
  }
}

async function releaseBackend() {
  backendRefs -= 1;
  if (backendRefs > 0) return;
  backendRefs = 0;
  const proc = backendProc;
  backendProc = null;
  backendStarting = null;
  if (proc) await killTree(proc);
}

// ---------------------------------------------------------------- static pages

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/** Serves one dist directory on 127.0.0.1:port, with the single-page fallback to index.html. */
function serveStatic(root, port) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = path.join(root, url === '/' ? 'index.html' : url);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------- page helpers

const need = (cond, message) => {
  if (!cond) throw new Error(message);
};

/** Polls an async check until it returns a truthy value, or throws `message` after `ms`. */
async function until(check, message, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(message);
    await sleep(150);
  }
}

// The API's own per-client limit (src/middlewares/rateLimiter.ts: 100 requests a minute, fixed window,
// reported in X-RateLimit-* headers). The adapter reads those headers from the page's responses and waits
// for the window to reset before a step that could exhaust it. The limit itself is not changed.
const rateBudget = { remaining: null, reset: 0 };

function noteRateHeaders(headers) {
  const remaining = headers['x-ratelimit-remaining'];
  const reset = headers['x-ratelimit-reset'];
  if (remaining !== undefined && reset !== undefined) {
    rateBudget.remaining = Number(remaining);
    rateBudget.reset = Number(reset);
  }
}

/** Waits until the API window has room for a step, as the server reports it. */
async function paceForRateLimit(need = 30) {
  if (rateBudget.remaining === null) return;
  const now = Date.now() / 1000;
  if (now >= rateBudget.reset) {
    rateBudget.remaining = null;
    return;
  }
  if (rateBudget.remaining < need) {
    await sleep((rateBudget.reset - now) * 1000 + 250);
    rateBudget.remaining = null;
  }
}

const hashOf = (page) => page.evaluate(() => location.hash);

async function closeDialogs(page) {
  for (let i = 0; i < 3; i += 1) {
    if ((await page.getByRole('dialog').count()) === 0) return;
    await page.keyboard.press('Escape');
    await sleep(350);
  }
}

const bodyRowsNow = (page) =>
  page.evaluate(() => {
    const grid = document.querySelector('[role="grid"]');
    if (!grid) return [];
    return [...grid.querySelectorAll('[role="row"]')]
      .filter((r) => !r.querySelector('[role="columnheader"]') && r.getBoundingClientRect().height > 0)
      .map((r) => r.innerText.replace(/\s+/g, ' ').trim());
  });

/**
 * The body rows of the page's grid, read once the grid has stopped changing: a data grid lays its rows
 * out after the data arrives, so a read taken in the middle of that can count a partial set.
 */
async function bodyRows(page) {
  let last = await bodyRowsNow(page);
  for (let i = 0; i < 30; i += 1) {
    await sleep(120);
    const next = await bodyRowsNow(page);
    if (JSON.stringify(next) === JSON.stringify(last)) return next;
    last = next;
  }
  return last;
}

/** The grid footer's range, such as "1–20 of 84". */
const pageRange = (page) =>
  page.evaluate(() => {
    const m = document.body.innerText.match(/(\d+)–(\d+) of (\d+)/);
    return m ? { from: Number(m[1]), to: Number(m[2]), total: Number(m[3]) } : null;
  });

const mainText = (page) => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));

async function dashboardReady(page) {
  await page.getByText('Net Worth', { exact: true }).first().waitFor({ timeout: 60000 });
  await page.getByText('Operating Funds', { exact: true }).first().waitFor({ timeout: 60000 });
}

/** Waits for the page's own grid, identified by its header, and for its rows. */
const gridFor = (header) => async (page) => {
  await until(
    () =>
      page.evaluate((h) => {
        const g = document.querySelector('[role="grid"]');
        return !!g && g.innerText.replace(/\s+/g, ' ').startsWith(h);
      }, header),
    `the ${header} grid did not render`,
    60000,
  );
  await until(async () => (await bodyRows(page)).length > 0, 'the grid rendered no rows', 60000);
};

/** Moves the page to a route from a clean state: no dialog open, and the route remounted. */
async function open(page, target, ready) {
  await closeDialogs(page);
  // Leave the current route first, so that its grid is unmounted before the target's is awaited.
  await page.evaluate(() => {
    location.hash = '#/dashboard';
  });
  await until(
    () => page.evaluate(() => document.body.innerText.toLowerCase().includes('monthly overview')),
    'the dashboard did not render',
    30000,
  );
  if (target !== '#/dashboard') {
    await page.evaluate((h) => {
      location.hash = h;
    }, target);
  }
  // The app checks the session on each route, and may redirect once that check settles.
  await page.waitForLoadState('networkidle', { timeout: 30000 });
  await ready(page);
}

const dialogOf = (page) => page.getByRole('dialog').first();

async function expectDialogClosed(page) {
  await until(async () => (await page.getByRole('dialog').count()) === 0, 'the dialog did not close after saving', 10000);
}

/** Opens an add dialog, types a name into its name field and submits it. */
async function addNamed(page, buttonName, name) {
  await page.getByRole('button', { name: buttonName }).click();
  const dlg = dialogOf(page);
  await dlg.waitFor();
  await dlg.locator('#name').fill(name);
  await dlg.locator('button[type="submit"]').click();
}

/** The first body row's description cell, read from the grid's data-field cell. */
const firstTrxDescription = (page) =>
  page.evaluate(() => document.querySelector('[role="row"][data-rowindex="0"] [data-field="description"]')?.innerText.split('\n')[0].trim() ?? null);

/** The first body row's value cell, the amount chip such as "€18.99". */
const firstTrxAmount = (page) =>
  page.evaluate(() => document.querySelector('[role="row"][data-rowindex="0"] [data-field="value"]')?.innerText.trim() ?? null);

/** The digits of a formatted amount, as a positive number, so "€2,500.00" and "2500" compare equal. */
const amountDigits = (text) => Math.abs(Number(String(text).replace(/[^0-9.]/g, '')));


/** The dashboard's income and expense distribution, the part of the summary that depends on the month. */
const dashboardDistribution = (page) =>
  page.evaluate(() => {
    const t = document.body.innerText;
    const start = t.indexOf('INCOME DISTRIBUTION');
    const end = t.indexOf('INVESTMENT PORTFOLIO');
    return start >= 0 && end > start ? t.slice(start, end).replace(/\s+/g, ' ') : '';
  });

// The account type the add form needs to save (its type CHEAC is the current account).
const ACCOUNT_TYPE_OPTION = /^Current account$/;

// ---------------------------------------------------------------- the cases

const STEPS = [
  {
    name: 'C01 open Transactions from the sidebar',
    before: (page) => open(page, '#/dashboard', dashboardReady),
    run: (page) => page.locator('a[href="#/transactions"]').first().click(),
    assert: async (page) => {
      await until(async () => (await hashOf(page)) === '#/transactions', 'the URL hash did not become #/transactions');
      await page.getByRole('heading', { name: 'Transactions', exact: true }).waitFor({ timeout: 10000 });
      need((await bodyRows(page)).length > 0, 'the transactions table lists no rows');
      need(((await pageRange(page)) ?? { total: 0 }).total > 0, 'the pagination total is empty');
    },
  },
  {
    name: 'C02 open the add transaction dialog',
    before: async (page) => {
      await open(page, '#/transactions', gridFor('Date Flow'));
      return { rows: (await bodyRows(page)).length, range: await pageRange(page) };
    },
    run: (page) => page.getByRole('button', { name: 'ADD TRANSACTION' }).click(),
    assert: async (page, before) => {
      const dlg = dialogOf(page);
      await dlg.waitFor({ timeout: 10000 });
      need(await dlg.getByRole('heading', { name: 'Add new transaction' }).isVisible(), 'the add dialog has no add-mode heading');
      need((await dlg.locator('#description').inputValue()) === '', 'the description field is not empty');
      need((await bodyRows(page)).length === before.rows, 'the table row count changed when the dialog opened');
      need(JSON.stringify(await pageRange(page)) === JSON.stringify(before.range), 'the pagination total changed when the dialog opened');
    },
  },
  {
    name: 'C03 search transactions by a word from a description',
    before: async (page) => {
      await open(page, '#/transactions', gridFor('Date Flow'));
      return { total: (await pageRange(page)).total };
    },
    run: (page) => page.locator('#search').fill('Bakery'),
    assert: async (page, before) => {
      await until(async () => (await pageRange(page))?.total !== before.total, 'the filtered total did not change after the search');
      const after = await pageRange(page);
      need(after.total < before.total, `the filtered total ${after.total} is not lower than ${before.total}`);
      const rows = await bodyRows(page);
      need(rows.length > 0, 'the search returned no rows');
      need(rows.every((r) => r.toLowerCase().includes('bakery')), 'a visible row does not contain the search word');
    },
  },
  {
    name: 'C04 go to the next page of transactions',
    before: async (page) => {
      await open(page, '#/transactions', gridFor('Date Flow'));
      return { first: (await bodyRows(page))[0], range: await pageRange(page) };
    },
    run: (page) => page.getByRole('button', { name: 'Go to next page' }).click(),
    assert: async (page, before) => {
      await until(async () => (await pageRange(page))?.from !== before.range.from, 'the pagination range did not change');
      const after = await pageRange(page);
      need(after.from === before.range.from + 20, `the range starts at ${after.from}, not on the second page`);
      await until(async () => (await bodyRows(page))[0] !== before.first, 'the first visible row is the same as on the first page');
    },
  },
  {
    name: 'C05 open the edit dialog of the first transaction',
    before: async (page) => {
      await open(page, '#/transactions', gridFor('Date Flow'));
      const description = await firstTrxDescription(page);
      need(description, 'the first row has no description cell');
      const amount = await firstTrxAmount(page);
      need(amount, 'the first row has no amount cell');
      return { description, amount, rows: await bodyRows(page) };
    },
    run: (page) => page.locator('[role="row"][data-rowindex="0"] button[aria-label="Edit"]').click(),
    assert: async (page, before) => {
      const dlg = dialogOf(page);
      await dlg.waitFor({ timeout: 10000 });
      need(await dlg.getByRole('heading', { name: /^Edit transaction #/ }).isVisible(), 'the dialog is not in edit mode');
      need((await dlg.locator('#description').inputValue()) === before.description, 'the description is not prefilled from the row');
      const prefilled = await dlg.locator('input[type="text"]').first().inputValue();
      need(
        prefilled !== '' && amountDigits(before.amount) > 0 && amountDigits(prefilled) === amountDigits(before.amount),
        `the amount is not prefilled from the row (dialog "${prefilled}", row "${before.amount}")`,
      );
      const now = await bodyRows(page);
      const at = before.rows.findIndex((r, i) => r !== now[i]);
      need(at < 0 && now.length === before.rows.length, `the table changed while the dialog was open (row ${at}: ${JSON.stringify(before.rows[at])} -> ${JSON.stringify(now[at])}, ${before.rows.length} -> ${now.length} rows)`);
    },
  },
  {
    name: 'C06 delete the first transaction',
    before: async (page) => {
      await open(page, '#/transactions', gridFor('Date Flow'));
      const description = await firstTrxDescription(page);
      need(description, 'the first row has no description cell');
      return { total: (await pageRange(page)).total, description };
    },
    run: async (page) => {
      await page.locator('[role="row"][data-rowindex="0"] button[aria-label="Delete"]').click();
      const dlg = dialogOf(page);
      await dlg.waitFor({ timeout: 10000 });
      await dlg.getByRole('button', { name: /^delete$/i }).click();
    },
    assert: async (page, before) => {
      await until(async () => (await pageRange(page))?.total === before.total - 1, 'the total did not drop by one');
      need(!(await bodyRows(page)).some((r) => r.includes(before.description)), `the deleted row "${before.description}" is still listed`);
    },
  },
  {
    name: 'C07 add a transaction with a description, amount, account and category',
    before: async (page) => {
      await open(page, '#/transactions', gridFor('Date Flow'));
      return { total: (await pageRange(page)).total };
    },
    run: async (page) => {
      await page.getByRole('button', { name: 'ADD TRANSACTION' }).click();
      const dlg = dialogOf(page);
      await dlg.waitFor();
      await dlg.locator('input[type="text"]').first().fill('25.50');
      await dlg.locator('#description').fill('Bench lunch test');
      await dlg.locator('#account_from').click();
      await page.getByRole('option', { name: 'Current account', exact: true }).click();
      await dlg.locator('#category').click();
      await page.getByRole('option', { name: 'Dining out', exact: true }).click();
      await dlg.locator('button[type="submit"]').click();
    },
    assert: async (page, before) => {
      await expectDialogClosed(page);
      await until(async () => (await pageRange(page))?.total === before.total + 1, 'the total did not rise by one');
      need((await bodyRows(page)).some((r) => r.includes('Bench lunch test')), 'the new transaction is not listed');
    },
  },
  {
    name: 'C08 add an account',
    before: async (page) => {
      await open(page, '#/accounts', gridFor('Color Name Balance'));
      return { rows: (await bodyRows(page)).length };
    },
    run: async (page) => {
      await page.getByRole('button', { name: 'ADD ACCOUNT' }).click();
      const dlg = dialogOf(page);
      await dlg.waitFor();
      await dlg.locator('#name').fill('Bench account');
      // The form needs an account type to save; the case names only the account name.
      await dlg.locator('#type').click();
      await page.getByRole('option', { name: ACCOUNT_TYPE_OPTION }).first().click();
      await dlg.locator('button[type="submit"]').click();
    },
    assert: async (page, before) => {
      await expectDialogClosed(page);
      await until(async () => (await bodyRows(page)).length === before.rows + 1, 'the account list did not gain one entry');
      need((await bodyRows(page)).some((r) => r.includes('Bench account')), 'the new account is not listed');
    },
  },
  {
    name: 'C09 select the Debt tab of accounts',
    before: async (page) => {
      await open(page, '#/accounts', gridFor('Color Name Balance'));
      return { rows: await bodyRows(page) };
    },
    run: (page) => page.getByRole('tab', { name: /^debt$/i }).click(),
    assert: async (page, before) => {
      await until(async () => (await page.getByRole('tab', { name: /^debt$/i }).getAttribute('aria-selected')) === 'true', 'the Debt tab is not selected');
      await until(async () => (await bodyRows(page)).join('|') !== before.rows.join('|'), 'the listed accounts did not change');
      const debt = await bodyRows(page);
      need(debt.length > 0 && debt.length < before.rows.length, 'the Debt tab does not list fewer accounts than All');
    },
  },
  {
    name: 'C10 search accounts by part of a name',
    before: async (page) => {
      await open(page, '#/accounts', gridFor('Color Name Balance'));
      return { rows: (await bodyRows(page)).length };
    },
    run: (page) => page.locator('#search').fill('Sav'),
    assert: async (page, before) => {
      await until(async () => (await bodyRows(page)).length < before.rows, 'the visible account count did not fall');
      const rows = await bodyRows(page);
      need(rows.length > 0 && rows.every((r) => r.toLowerCase().includes('sav')), 'a visible account does not contain the search text');
    },
  },
  {
    name: 'C11 add a category',
    before: async (page) => {
      await open(page, '#/categories', gridFor('Color Name Description'));
      return { rows: (await bodyRows(page)).length };
    },
    run: (page) => addNamed(page, 'ADD CATEGORY', 'Bench category'),
    assert: async (page, before) => {
      await expectDialogClosed(page);
      await until(async () => (await bodyRows(page)).length === before.rows + 1, 'the category list did not gain one row');
      need((await bodyRows(page)).some((r) => r.includes('Bench category')), 'the new category is not listed');
    },
  },
  {
    name: 'C12 add a tag',
    before: async (page) => {
      await open(page, '#/tags', gridFor('Name Description Actions'));
      return { rows: (await bodyRows(page)).length };
    },
    run: (page) => addNamed(page, 'ADD TAG', 'Bench tag'),
    assert: async (page, before) => {
      await expectDialogClosed(page);
      await until(async () => (await bodyRows(page)).length === before.rows + 1, 'the tag list did not gain one entry');
      need((await bodyRows(page)).some((r) => r.includes('Bench tag')), 'the new tag is not listed');
    },
  },
  {
    name: 'C13 rename the first entity',
    before: async (page) => {
      await open(page, '#/entities', gridFor('Name Actions'));
      return { first: (await bodyRows(page))[0] };
    },
    run: async (page) => {
      await page.locator('[role="row"][data-rowindex="0"] button[aria-label="Edit"], [role="grid"] [role="row"]:nth-child(2) button[aria-label="Edit"]').first().click();
      const dlg = dialogOf(page);
      await dlg.waitFor();
      await dlg.locator('#name').fill('Supermarket Plus');
      await dlg.locator('button[type="submit"]').click();
    },
    assert: async (page, before) => {
      await expectDialogClosed(page);
      await until(async () => (await bodyRows(page))[0] === 'Supermarket Plus', 'the first entity does not show the new name');
      need((await bodyRows(page))[0] !== before.first, 'the first entity still shows its old name');
    },
  },
  {
    name: 'C14 search rules by part of their text',
    before: async (page) => {
      await open(page, '#/rules', gridFor('Conditions Result'));
      return { rows: (await bodyRows(page)).length };
    },
    run: (page) => page.locator('#search').fill('Bakery'),
    assert: async (page, before) => {
      await until(async () => (await bodyRows(page)).length < before.rows, 'the visible rule rows did not fall');
      const rows = await bodyRows(page);
      need(rows.length > 0 && rows.every((r) => r.toLowerCase().includes('bakery')), 'a visible rule does not contain the search text');
    },
  },
  {
    name: 'C15 open the details of the first budget',
    before: async (page) => {
      await open(page, '#/budgets', gridFor('Month Observations'));
      return { first: (await bodyRows(page))[0] };
    },
    run: (page) => page.locator('button[aria-label="See More"]').first().click(),
    assert: async (page, before) => {
      await until(async () => /^#\/budget\/\d+$/.test(await hashOf(page)), 'the URL hash did not become a budget details route');
      await until(async () => (await mainText(page)).includes('Monthly budget'), 'the details page is not the budget details page');
      // The row reads "October 10/2026 ..."; the details page must show that month and year.
      const shown = before.first.match(/^([A-Za-z]+) \d{1,2}\/(\d{4})/);
      need(shown && (await mainText(page)).includes(`${shown[1]} ${shown[2]}`), `the details page does not show the month of the first row (${before.first.slice(0, 40)})`);
    },
  },
  {
    name: 'C16 tick Only opened on the budgets list',
    before: async (page) => {
      await open(page, '#/budgets', gridFor('Month Observations'));
      return { rows: (await bodyRows(page)).length };
    },
    run: (page) => page.locator('label', { hasText: 'Only Opened' }).click(),
    assert: async (page, before) => {
      await until(async () => (await page.locator('label', { hasText: 'Only Opened' }).locator('input[type="checkbox"]').isChecked()), 'the Only Opened checkbox is not checked');
      await until(async () => (await bodyRows(page)).length < before.rows, 'the visible budget rows did not fall');
    },
  },
  {
    name: 'C17 switch budgets to the matrix view',
    before: async (page) => {
      await open(page, '#/budgets', gridFor('Month Observations'));
    },
    run: (page) => page.locator('button[aria-label="Matrix view"]').click(),
    assert: async (page) => {
      await until(async () => (await hashOf(page)) === '#/budgets/matrix', 'the URL hash did not become #/budgets/matrix');
      await until(async () => /(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}/.test(await mainText(page)), 'the matrix shows no month columns');
      need((await mainText(page)).includes('Budgeted'), 'the matrix grid did not render');
    },
  },
  {
    name: 'C18 select the Completed view of goals',
    before: async (page) => {
      await open(page, '#/goals', gridFor('Name Priority'));
      return { rows: await bodyRows(page) };
    },
    run: (page) => page.getByRole('tab', { name: /^completed/i }).click(),
    assert: async (page, before) => {
      await until(async () => (await page.getByRole('tab', { name: /^completed/i }).getAttribute('aria-selected')) === 'true', 'the Completed view is not selected');
      await until(async () => (await bodyRows(page)).length < before.rows.length, 'the visible goals did not fall');
      const rows = await bodyRows(page);
      need(rows.length > 0 && rows.every((r) => r.includes('Completed')), 'a visible goal is not completed');
    },
  },
  {
    name: 'C19 open the add goal dialog',
    before: async (page) => {
      await open(page, '#/goals', gridFor('Name Priority'));
      return { rows: await bodyRows(page) };
    },
    run: (page) => page.getByRole('button', { name: 'NEW GOAL' }).click(),
    assert: async (page, before) => {
      const dlg = dialogOf(page);
      await dlg.waitFor({ timeout: 10000 });
      need(await dlg.getByRole('heading', { name: 'Add new goal' }).isVisible(), 'the add-goal dialog did not open');
      need(JSON.stringify(await bodyRows(page)) === JSON.stringify(before.rows), 'the goal list changed');
    },
  },
  {
    name: 'C20 select the Expenses tab of stats',
    before: async (page) => {
      await open(page, '#/stats', (p) => p.getByRole('tab', { name: /^expenses$/i }).waitFor({ timeout: 60000 }));
      return { text: await mainText(page) };
    },
    run: (page) => page.getByRole('tab', { name: /^expenses$/i }).click(),
    assert: async (page, before) => {
      await until(async () => (await page.getByRole('tab', { name: /^expenses$/i }).getAttribute('aria-selected')) === 'true', 'the Expenses tab is not selected');
      await until(async () => (await mainText(page)) !== before.text, 'the panel did not change');
      need((await mainText(page)).includes('Choose a category'), 'the expenses panel is not shown');
    },
  },
  {
    name: 'C21 select the Year by year tab of stats',
    before: async (page) => {
      await open(page, '#/stats', (p) => p.getByRole('tab', { name: /^expenses$/i }).waitFor({ timeout: 60000 }));
      return { text: await mainText(page) };
    },
    run: (page) => page.getByRole('tab', { name: /year-by-year/i }).click(),
    assert: async (page, before) => {
      await until(async () => (await page.getByRole('tab', { name: /year-by-year/i }).getAttribute('aria-selected')) === 'true', 'the Year by year tab is not selected');
      await until(async () => (await mainText(page)) !== before.text, 'the previous panel was not replaced');
      const text = await mainText(page);
      need(text.includes('Income By Category') && text.includes('Expenses By Category'), 'the year-by-year tables are not shown');
      // The tables are for the year the selector holds, so the selector must show one year.
      const year = await page.locator('#select-year').inputValue();
      need(/^\d{4}$/.test(year), `the year-by-year tab shows no chosen year (selector "${year}")`);
    },
  },
  {
    name: 'C22 change the dashboard month to the previous month',
    before: async (page) => {
      await open(page, '#/dashboard', dashboardReady);
      const label = await page.locator('button[aria-label^="Choose date"]').getAttribute('aria-label');
      const distribution = await dashboardDistribution(page);
      return { label, distribution };
    },
    run: async (page) => {
      await page.locator('button[aria-label^="Choose date"]').click();
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const dlg = dialogOf(page);
      await dlg.waitFor();
      const checked = await dlg.locator('[role="radio"][aria-checked="true"]').getAttribute('aria-label');
      const previous = months[(months.indexOf(checked) + 11) % 12];
      await dlg.locator(`[role="radio"][aria-label="${previous}"]`).click();
      await page.keyboard.press('Escape');
    },
    assert: async (page, before) => {
      // The picker's label names its selected day, such as "Choose date, selected date is Oct 1, 2026".
      // After the change it must name the previous month.
      const short = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const shown = before.label.match(/([A-Za-z]{3}) \d{1,2}, (\d{4})/);
      need(shown, `the picker label "${before.label}" names no month`);
      const idx = short.indexOf(shown[1]);
      need(idx >= 0, `the picker label names an unknown month ${shown[1]}`);
      const prevName = short[(idx + 11) % 12];
      const prevYear = idx === 0 ? Number(shown[2]) - 1 : Number(shown[2]);
      const currentLabel = () => page.locator('button[aria-label^="Choose date"]').getAttribute('aria-label');
      await until(async () => new RegExp(`${prevName} \\d{1,2}, ${prevYear}`).test((await currentLabel()) ?? ''), `the month label did not change to ${prevName} ${prevYear}`);
      await until(async () => (await dashboardDistribution(page)) !== before.distribution, 'the category distribution did not change');
    },
  },
  {
    name: 'C23 select the dark theme on profile',
    before: async (page) => {
      await open(page, '#/profile', (p) => p.locator('#theme-header').waitFor({ timeout: 60000 }));
      await page.locator('#theme-header').click();
      await page.locator('input[name="theme-radio-buttons-group"][value="dark"]').waitFor({ state: 'attached', timeout: 10000 });
      return { background: await page.evaluate(() => getComputedStyle(document.body).backgroundColor) };
    },
    run: (page) => page.locator('label', { has: page.locator('input[name="theme-radio-buttons-group"][value="dark"]') }).click(),
    assert: async (page, before) => {
      await until(async () => page.locator('input[name="theme-radio-buttons-group"][value="dark"]').isChecked(), 'the dark theme option is not checked');
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      need(background !== before.background, `the page background stayed ${background}`);
    },
  },
  {
    name: 'C24 select French on profile',
    before: async (page) => {
      await open(page, '#/profile', (p) => p.locator('#language-header').waitFor({ timeout: 60000 }));
      await page.locator('#language-header').click();
      await page.locator('input[name="radio-buttons-group"][value="fr"]').waitFor({ state: 'attached', timeout: 10000 });
    },
    run: (page) => page.locator('label', { has: page.locator('input[name="radio-buttons-group"][value="fr"]') }).click(),
    assert: async (page) => {
      await until(async () => page.locator('input[name="radio-buttons-group"][value="fr"]').isChecked(), 'the Français option is not checked');
      const text = await mainText(page);
      need(text.includes('Gestion du profil'), 'the Profile heading is not in French');
      need((await page.evaluate(() => document.body.innerText)).includes('Tableau de bord'), 'the sidebar labels are not in French');
    },
  },
];

for (const step of STEPS) {
  const before = step.before;
  step.before = async (page) => {
    await paceForRateLimit();
    return before(page);
  };
}

export default {
  // Set after the 2026-10-15 protocol revision: the ordered workload passes on A, B and C, and every case passes alone.
  status: 'ready',
  ready: async (page) => {
    page.on('response', (r) => {
      if (r.url().startsWith(API_ORIGIN)) noteRateHeaders(r.headers());
    });
    await dashboardReady(page);
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    need((await hashOf(page)) === '#/dashboard', 'the start route did not settle on the dashboard');
  },
  steps: STEPS,
  install(run) {
    checkPinnedCommit();
    applyLibraryPin();
    run(NPM, ['ci', '--no-audit', '--no-fund'], { cwd: DIR });
    ensureBackendClone();
    run(NPM, ['ci', '--no-audit', '--no-fund'], { cwd: BACKEND_DIR });
    run(NPM, ['run', 'build'], { cwd: BACKEND_DIR });
    writeBenchServer();
  },
  build(run, env) {
    checkPinnedCommit();
    writeBenchConfig();
    // The upstream build script is "tsc && vite build". The bench config replaces vite.config.ts for
    // this build only, and BENCH_CONFIG and BENCH_OUTDIR select the configuration and output.
    run(NPX, ['tsc'], { cwd: DIR, env });
    run(NPX, ['vite', 'build', '--config', 'vite.bench.config.ts'], {
      cwd: DIR,
      env: { ...env, VITE_MYFIN_BASE_API_URL: API_BUILD_ORIGIN },
    });
  },
  async startServer(config, port) {
    const creds = loadCredentials();
    await acquireBackend(creds);
    let page;
    try {
      page = await serveStatic(path.join(DIR, DISTS[config]), port);
    } catch (err) {
      await releaseBackend();
      throw err;
    }
    return {
      close(cb) {
        page.close(() => {
          releaseBackend().then(() => cb?.());
        });
        page.closeAllConnections?.();
      },
    };
  },
  async beforeRun(config) {
    const creds = loadCredentials();
    await ensureDatabase(creds);
    await ensureSchema(creds);
    await restoreSeed(creds);
  },
  async contextOptions(config) {
    const creds = loadCredentials();
    // The app's own sign-in: POST /auth with the seeded local user, against 127.0.0.1 only.
    const res = await fetch(`${API_ORIGIN}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: creds.login.username, password: creds.login.password }),
    });
    if (!res.ok) throw new Error(`sign-in as the seeded user failed: HTTP ${res.status}`);
    const body = await res.json();
    const { accounts, is_demo, ...rest } = body;
    // The same record the app's useLogin stores: the session without accounts, plus language and version.
    const session = {
      ...rest,
      language: 'en',
      apiVersion: res.headers.get('api-version') ?? '',
      is_demo: is_demo === 1 || is_demo === '1' || is_demo === true,
    };
    const origin = `http://127.0.0.1:${PAGE_PORTS[config]}`;
    return {
      storageState: {
        cookies: [],
        origins: [
          {
            origin,
            localStorage: [
              { name: 'myfin.sessionData', value: JSON.stringify(session) },
              { name: 'myfin.accounts', value: JSON.stringify(accounts) },
              { name: 'i18nextLng', value: 'en' },
              // The app's default theme is dark. The seeded user starts in the light theme, so that the
              // dark selection in C23 changes the page background, as its expectation requires.
              { name: 'myfin.uiMode', value: 'light' },
            ],
          },
        ],
      },
    };
  },
};
