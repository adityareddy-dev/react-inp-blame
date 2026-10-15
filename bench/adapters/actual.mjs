// Actual (actualbudget/actual) at d5d6035a8f5867717a80635d270fbe64e370ea08, MIT. The web client is
// static. The budget lives in the browser, so there is no server, database or sign-in: every run
// starts a fresh browser context, and ready() imports the pinned demo budget through the welcome
// screen. That import is the seed.
//
// The client needs cross-origin isolation (SharedArrayBuffer for its backend worker), which upstream
// declares in the _headers file its build copies into each dist. The harness's own static server
// does not send those headers, so startServer serves the dist with the rules from its _headers file.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLONE = path.join(HERE, '..', 'clones', 'actual');
const DESKTOP = path.join(CLONE, 'packages', 'desktop-client');
const DISTS = { A: 'dist-a', B: 'dist-b', C: 'dist-c' };
const SEED_ZIP = path.join(DESKTOP, 'e2e', 'data', 'actual-demo-budget.zip');
const SEED_SHA256 = 'f05e08a643d9bb7c8cf5cde28111d6e6f82ad0bd723d614c442388901f25dd53';
const BENCH_CONFIG_FILE = 'vite.bench.config.mts';

// Written into the clone, never committed. BENCH_CONFIG picks the configuration: '' is A (the library
// is not imported in any form), 'b' is B, 'c' is C.
const BENCH_CONFIG_SOURCE = `// Bench-only build configuration written by bench/adapters/actual.mjs. It is not upstream source and is
// never committed. BENCH_CONFIG selects the configuration: '' is A (library absent, not even imported),
// 'b' is B (library build plugin, debugGlobal), 'c' is C (as B, with the overlay).
import type { Plugin } from 'vite';

import baseConfig from './vite.config.mts';

const configuration = process.env.BENCH_CONFIG ?? '';

export default async (env: { mode: string; command: 'build' | 'serve' }) => {
  const config = await baseConfig(env as never);
  if (configuration === '') return config;
  if (configuration !== 'b' && configuration !== 'c') {
    throw new Error(\`unknown BENCH_CONFIG '\${configuration}'\`);
  }

  // Imported only on this branch, so configuration A never loads the library in any form.
  const { inpBlame } = await import('react-inp-blame/vite');
  const runtime =
    configuration === 'c'
      ? { debugGlobal: true, overlay: true }
      : { debugGlobal: true };

  const plugins = ((config.plugins ?? []) as unknown[])
    .flat(Infinity as 1)
    .filter(Boolean) as Plugin[];
  // After the framework plugin: the last of the @vitejs/plugin-react entries.
  let at = -1;
  plugins.forEach((plugin, i) => {
    if (plugin.name?.startsWith('vite:react')) at = i;
  });
  if (at < 0) throw new Error('no @vitejs/plugin-react entry to place the library after');
  // enabled defaults to 'development', which leaves a production build without the library, so it is named.
  plugins.splice(at + 1, 0, ...inpBlame({ enabled: 'production', runtime }));

  return { ...config, plugins };
};
`;

function writeBenchConfig() {
  fs.writeFileSync(path.join(DESKTOP, BENCH_CONFIG_FILE), BENCH_CONFIG_SOURCE);
}

// Netlify-style _headers: a path pattern at column 0, then indented "Name: value" lines.
function readHeaderRules(file) {
  const rules = [];
  let current = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: {} };
      rules.push(current);
      continue;
    }
    const colon = line.indexOf(':');
    current.headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return rules;
}

function patternMatches(pattern, urlPath) {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(urlPath);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
};

function startStaticServer(root, rules, port) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const resolved = path.resolve(root, '.' + (urlPath === '/' ? '/index.html' : urlPath));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    let file = resolved;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    const headers = { 'cache-control': 'no-store', 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' };
    for (const rule of rules) {
      if (patternMatches(rule.pattern, urlPath)) Object.assign(headers, rule.headers);
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, headers);
      res.end(buf);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        close(cb) {
          for (const socket of sockets) socket.destroy();
          server.close(cb);
        },
      }),
    );
  });
}

// ---- steps. Each case is one interaction; before() sets its precondition outside the timed window,
// run() performs the user's action, and assert() polls until the intended change is visible.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(read, ok, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await read();
    if (ok(last)) return last;
    if (Date.now() > deadline) break;
    await sleep(150);
  }
  throw new Error(`${what}; last read ${JSON.stringify(last)}`);
}

// The transaction list is virtualized: it renders only the rows in view, so counting DOM rows caps at
// the viewport. Its scroll height is one row height per transaction, so the total is that height over a
// row's height. A list shorter than the viewport is not virtualized and its rendered rows are the total.
async function rowTotalOnce(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="transaction-table"] [data-testid="row"]')];
    if (!rows.length) return 0;
    const rowHeight = rows[0].getBoundingClientRect().height;
    for (let el = rows[0]; el && el !== document.body; el = el.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) {
        return Math.round(el.scrollHeight / rowHeight);
      }
    }
    return rows.length;
  });
}

// The total once two reads a moment apart agree, so a value taken mid-update is not used.
async function stableRowTotal(page) {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const n = await rowTotalOnce(page);
    if (n === last) return n;
    last = n;
    await sleep(250);
  }
  return last;
}

async function firstRowSignature(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-testid="transaction-table"] [data-testid="row"]');
    return row ? row.textContent.replace(/\s+/g, ' ').trim() : '';
  });
}

const isShown = (locator) => locator.first().isVisible().catch(() => false);

async function textOf(locator) {
  if (!(await isShown(locator))) return '';
  return ((await locator.first().textContent({ timeout: 5000 })) ?? '').trim();
}

function amount(text) {
  const clean = String(text).replace(/,/g, '').trim();
  if (clean === '' || !Number.isFinite(Number(clean))) throw new Error(`not an amount: ${JSON.stringify(text)}`);
  return Number(clean);
}

const cents = (n) => Math.round(n * 100);

const headerText = (page) => textOf(page.getByTestId('account-name'));
const balanceText = (page) => textOf(page.getByTestId('account-balance'));
const txTable = (page) => page.getByTestId('transaction-table');
const txRows = (page) => txTable(page).getByTestId('row');
const accountLink = (page, name) => page.getByRole('link', { name: new RegExp(`^${name}`) });

// Every link outside the open dialogs: the sidebar and the page, not the links a dialog adds while open.
const sidebarLinks = (page) =>
  page.getByRole('link').evaluateAll((els) =>
    els.filter((el) => !el.closest('[role="dialog"]')).map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
  );

async function onBudgetPage(page) {
  if (!(await isShown(page.getByTestId('budget-table')))) {
    await page.getByRole('link', { name: 'Budget', exact: true }).click();
  }
  await page.getByTestId('budget-table').waitFor({ state: 'visible', timeout: 15000 });
}

async function onAccountPage(page, name) {
  if ((await headerText(page)) !== name) await accountLink(page, name).click();
  await until(() => headerText(page), (t) => t === name, `account page ${name} did not open`);
  // The transaction rows render after the header, so wait for them before anyone counts them.
  await until(() => txRows(page).count(), (n) => n > 0, `account page ${name} shows no transaction rows`, 20000);
}

async function onSettingsPage(page) {
  if (!(await isShown(page.getByTestId('settings')))) {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
  }
  await page.getByTestId('settings').waitFor({ state: 'visible', timeout: 15000 });
}

async function closeOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const open =
      (await isShown(page.getByRole('combobox', { name: 'Command Bar' }))) ||
      (await isShown(page.locator('[data-popover]'))) ||
      (await isShown(page.getByRole('dialog')));
    if (!open) return;
    await page.keyboard.press('Escape');
    await sleep(200);
  }
}

async function removeAllFilters(page) {
  for (let i = 0; i < 10 && (await page.getByRole('button', { name: 'Delete filter' }).count()) > 0; i++) {
    await page.getByRole('button', { name: 'Delete filter' }).first().click();
  }
}

async function applyPayeeFilter(page, payee) {
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByTestId('filters-select-tooltip').getByRole('button', { name: 'Payee', exact: true }).click();
  const menu = page.getByTestId('filters-menu-tooltip');
  const field = menu.getByLabel('Payee');
  await field.click();
  // The text is entered into the Payee field in one input event. Typing it key by key made the app's virtualised
  // transaction table show stale rows after Apply in most runs. The list the text narrows covers Apply until one
  // of its items is chosen, so the typed payee is chosen from it.
  await field.fill(payee);
  await page.getByTestId(`${payee}-payee-item`).click();
  await menu.getByRole('button', { name: 'Apply', exact: true }).click();
}

async function fillCell(page, cell, value) {
  await cell.click();
  const input = cell.getByRole('textbox');
  await input.pressSequentially(value);
  await page.keyboard.press('Tab');
}

async function setColumn(page, columnId, visible) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Manage table columns' }).click();
  const modal = page.getByTestId('transaction-table-columns-modal');
  await modal.waitFor({ state: 'visible' });
  const toggle = modal.locator(`#toggle-column-${columnId}`);
  if ((await toggle.isChecked()) !== visible) await modal.locator(`label[for="toggle-column-${columnId}"]`).click();
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
}

async function budgetRow(page, category) {
  const rows = page.getByTestId('budget-table').getByTestId('row');
  const index = await rows.evaluateAll(
    (els, name) => els.findIndex((el) => el.querySelector('[data-testid="category-name"]')?.textContent?.trim() === name),
    category,
  );
  if (index < 0) throw new Error(`no budget row named ${category}`);
  return rows.nth(index);
}

const budgetCellText = async (page, category) => textOf((await budgetRow(page, category)).getByTestId('budget').first());
const budgetBalanceText = async (page, category) => textOf((await budgetRow(page, category)).getByTestId('balance'));
const budgetTotal = (page) => textOf(page.getByTestId('budget-totals').getByTestId(/total-budgeted$/));

function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

const openAccountStep = (id, label, header, balance) => ({
  name: `${id} open ${label}`,
  before: async (page) => ({ header: await headerText(page) }),
  run: async (page) => {
    await accountLink(page, label).click();
  },
  assert: async (page, before) => {
    if (before.header === header) throw new Error(`${id}: ${header} was already open, so nothing changed`);
    await until(
      async () => ({ header: await headerText(page), balance: await balanceText(page) }),
      (s) => s.header === header && s.balance === balance,
      `${id}: expected header ${header} with balance ${balance}`,
    );
  },
});

// A column's cells are the rows' cells with its test ID; the header cell carries the same ID, so the
// header is checked on its own, under transaction-table-header.
const columnHeader = (page, label) => page.getByTestId('transaction-table-header').getByText(label, { exact: true });

const columnStep = (id, columnId, label) => ({
  name: `${id} hide ${label} column`,
  before: async (page) => {
    await onAccountPage(page, 'Ally Savings');
    await removeAllFilters(page);
    await setColumn(page, columnId, true);
    if (!(await isShown(columnHeader(page, label)))) {
      throw new Error(`${id}: the ${label} column header is not shown before the change`);
    }
    const cells = await txRows(page).getByTestId(columnId).count();
    if (cells === 0) throw new Error(`${id}: no row has a ${label} cell before the change`);
    return { cells };
  },
  run: async (page) => {
    await setColumn(page, columnId, false);
  },
  assert: async (page, before) => {
    await until(
      () => txRows(page).getByTestId(columnId).count(),
      (n) => n === 0,
      `${id}: rows still have ${label} cells (had ${before.cells})`,
    );
    await until(
      () => isShown(columnHeader(page, label)),
      (shown) => !shown,
      `${id}: the ${label} column header is still shown`,
    );
  },
});

export default {
  // Set after the 2026-10-15 protocol revision: the ordered workload passes on A, B and C, and every case passes alone.
  // C06 and C08 read the transaction list's total height, which stands in for the virtualised row count; the
  // cases file says so in its wording.
  status: 'ready',

  install(run) {
    // The upstream's own Yarn 4.17.1 (yarnPath in .yarnrc.yml) and its lockfile, unchanged.
    run('yarn', ['install', '--immutable'], { cwd: CLONE });
  },

  prepare() {
    writeBenchConfig();
  },

  build(run, env) {
    writeBenchConfig();
    // --mode browser is the upstream's web build (`yarn build:browser`, which netlify-release.yml runs). The
    // default mode resolves the electron-renderer build instead, which never sets window.Actual.
    run('yarn', ['workspace', '@actual-app/web', 'exec', 'vite', 'build', '--mode', 'browser', '--config', BENCH_CONFIG_FILE,
      '--outDir', path.join(CLONE, env.BENCH_OUTDIR), '--emptyOutDir'], { cwd: CLONE, env });
  },

  assetsDir: 'static',

  startServer(config, port) {
    const root = path.join(CLONE, DISTS[config]);
    const rules = readHeaderRules(path.join(root, '_headers'));
    return startStaticServer(root, rules, port);
  },

  async beforeRun() {
    // Each run has a fresh browser context, so no budget data survives it. The seed itself must still be
    // the pinned file: a different zip would change every expected value.
    const digest = crypto.createHash('sha256').update(fs.readFileSync(SEED_ZIP)).digest('hex');
    if (digest !== SEED_SHA256) throw new Error(`seed ${SEED_ZIP} has sha256 ${digest}, expected ${SEED_SHA256}`);
  },

  async ready(page) {
    // Pin the page's clock, so the current month and new transactions' dates are the same on every run day.
    // The timers keep running; only Date.now() and new Date() are fixed.
    await page.clock.setFixedTime(new Date('2026-10-15T12:00:00Z'));
    // The welcome screen's import, as the upstream e2e suite does it: the Actual format, then the file.
    await page.getByRole('button', { name: 'Import my budget' }).click();
    await page.getByRole('button', { name: 'Actual Import a file exported from Actual' }).click();
    const chooser = page.waitForEvent('filechooser', { timeout: 30000 });
    await page.getByRole('button', { name: 'Select file...' }).click();
    await (await chooser).setFiles(SEED_ZIP);
    await page.getByTestId('budget-table').waitFor({ state: 'visible', timeout: 60000 });
    // The seeded sidebar is the initial state. Without it the import did not happen.
    await page.getByRole('link', { name: /^Ally Savings/ }).waitFor({ state: 'visible', timeout: 30000 });
  },

  steps: [
    openAccountStep('C01', 'Ally Savings', 'Ally Savings', '1,772.80'),
    openAccountStep('C02', 'Roth IRA', 'Roth IRA', '2,745.81'),
    openAccountStep('C03', 'Mortgage', 'Mortgage', '-318,541.44'),
    openAccountStep('C04', 'All accounts', 'All Accounts', '-47,998.09'),

    {
      name: 'C05 filter payee Kroger',
      before: async (page) => {
        await onAccountPage(page, 'Ally Savings');
        await removeAllFilters(page);
        return { rows: await stableRowTotal(page) };
      },
      run: async (page) => {
        await applyPayeeFilter(page, 'Kroger');
      },
      assert: async (page, before) => {
        const rows = await until(
          () => stableRowTotal(page),
          (n) => n > 0 && n < before.rows,
          `C05: rows did not drop below ${before.rows}`,
        );
        // The rows can still be re-rendering when the count settles, so the payee cells are polled as well.
        await until(
          async () => {
            const payees = await txTable(page).getByTestId('payee').allTextContents();
            return payees.map((p) => p.trim()).filter((p) => p !== 'Kroger');
          },
          (notKroger) => notKroger.length === 0,
          'C05: payees other than Kroger remain',
        );
        if (rows < 1) throw new Error('C05: no rows remain');
      },
    },

    {
      name: 'C06 delete payee filter',
      before: async (page) => {
        await onAccountPage(page, 'Ally Savings');
        await removeAllFilters(page);
        const unfiltered = await stableRowTotal(page);
        await applyPayeeFilter(page, 'Kroger');
        const filtered = await stableRowTotal(page);
        if (filtered >= unfiltered) throw new Error('C06: the payee filter did not narrow the rows, so there is nothing to delete');
        return { unfiltered, filtered };
      },
      run: async (page) => {
        await page.getByRole('button', { name: 'Delete filter' }).first().click();
      },
      assert: async (page, before) => {
        await until(
          () => page.getByRole('button', { name: 'Delete filter' }).count(),
          (n) => n === 0,
          'C06: a filter chip remains',
        );
        await until(
          () => stableRowTotal(page),
          (n) => n === before.unfiltered,
          `C06: row count did not return to ${before.unfiltered} (filtered was ${before.filtered})`,
        );
        await until(
          async () => (await txTable(page).getByTestId('payee').allTextContents()).some((p) => p.trim() !== 'Kroger'),
          (s) => s,
          'C06: no payee other than Kroger is listed after the filter is deleted',
        );
      },
    },

    {
      name: 'C07 add expense Kroger 12.34',
      before: async (page) => {
        await onAccountPage(page, 'Ally Savings');
        await removeAllFilters(page);
        const balance = await balanceText(page);
        if (balance !== '1,772.80') throw new Error(`C07: expected the seeded balance 1,772.80, read ${balance}`);
        return { balance };
      },
      run: async (page) => {
        await page.getByRole('button', { name: 'Add New' }).click();
        const row = page.getByTestId('new-transaction').getByTestId('row').first();
        await fillCell(page, row.getByTestId('debit'), '12.34');
        await fillCell(page, row.getByTestId('payee'), 'Kroger');
        await page.getByTestId('add-button').click();
      },
      assert: async (page) => {
        await until(
          () => balanceText(page),
          (t) => t === '1,760.46',
          'C07: the account balance did not fall to 1,760.46',
        );
        await until(
          async () => ({ payee: await textOf(txRows(page).first().getByTestId('payee')), debit: await textOf(txRows(page).first().getByTestId('debit')) }),
          (s) => s.payee === 'Kroger' && s.debit === '12.34',
          'C07: the first row is not Kroger with debit 12.34',
        );
      },
    },

    {
      name: 'C08 delete first transaction',
      before: async (page) => {
        await onAccountPage(page, 'Ally Savings');
        await removeAllFilters(page);
        const first = txRows(page).first();
        const debit = (await textOf(first.getByTestId('debit'))) || '';
        const credit = (await textOf(first.getByTestId('credit'))) || '';
        if (!debit && !credit) throw new Error('C08: the first row has no amount to check the change against');
        return {
          rows: await stableRowTotal(page),
          balance: amount(await balanceText(page)),
          first: await firstRowSignature(page),
          delta: (debit ? amount(debit) : 0) - (credit ? amount(credit) : 0),
        };
      },
      run: async (page) => {
        await txRows(page).first().getByTestId('select').click();
        await page.getByTestId('transactions-select-button').click();
        await page.getByTestId('transactions-select-tooltip').getByRole('button', { name: /^Delete/ }).click();
        const confirm = page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true });
        try {
          await confirm.waitFor({ state: 'visible', timeout: 1500 });
          await confirm.click();
        } catch {
          /* no confirmation for this delete */
        }
      },
      assert: async (page, before) => {
        await until(
          () => stableRowTotal(page),
          (n) => n === before.rows - 1,
          `C08: row count did not drop from ${before.rows}`,
        );
        await until(
          () => firstRowSignature(page),
          (sig) => sig !== before.first,
          'C08: the first row is still the one that was deleted',
        );
        await until(
          async () => amount(await balanceText(page)),
          (b) => cents(b - before.balance) === cents(before.delta),
          `C08: the balance did not change by ${before.delta.toFixed(2)} (was ${before.balance.toFixed(2)})`,
        );
      },
    },

    columnStep('C09', 'notes', 'Notes'),
    columnStep('C10', 'category', 'Category'),

    {
      name: 'C11 open budget from account',
      before: async (page) => {
        await onAccountPage(page, 'Ally Savings');
        await removeAllFilters(page);
      },
      run: async (page) => {
        await page.getByRole('link', { name: 'Budget', exact: true }).click();
      },
      assert: async (page) => {
        await until(
          () => isShown(page.getByTestId('budget-table')),
          (shown) => shown,
          'C11: the budget table did not show',
        );
        await until(() => isShown(page.getByTestId('account-name')), (shown) => !shown, 'C11: the account header is still shown');
      },
    },

    {
      name: 'C12 set Food budget to 100',
      before: async (page) => {
        await onBudgetPage(page);
        const food = await budgetCellText(page, 'Food');
        return { food: amount(food), total: amount(await budgetTotal(page)) };
      },
      run: async (page) => {
        const cell = (await budgetRow(page, 'Food')).getByTestId('budget').first();
        await cell.click();
        const input = cell.locator('input');
        await input.waitFor({ state: 'visible' });
        await input.fill('100');
        await input.press('Enter');
      },
      assert: async (page, before) => {
        await until(
          () => budgetCellText(page, 'Food'),
          (t) => t === '100.00',
          'C12: the Food budget for this month did not read 100.00',
        );
        await until(
          async () => amount(await budgetTotal(page)),
          (t) => cents(t - before.total) === cents(100 - before.food),
          `C12: the budgeted total did not change by ${(100 - before.food).toFixed(2)}`,
        );
      },
    },

    {
      name: 'C13 transfer Restaurants balance to Food',
      before: async (page) => {
        await onBudgetPage(page);
        const restaurants = amount(await budgetBalanceText(page, 'Restaurants'));
        if (restaurants <= 0) throw new Error(`C13: Restaurants has no positive balance to transfer (${restaurants})`);
        return { restaurants, food: amount(await budgetBalanceText(page, 'Food')) };
      },
      run: async (page) => {
        const row = await budgetRow(page, 'Restaurants');
        await row.getByTestId('balance').getByTestId(/^budget/).click();
        await page.getByRole('button', { name: 'Transfer to another category' }).click();
        await page.getByPlaceholder('(none)').click();
        await page.keyboard.type('Food');
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: 'Transfer', exact: true }).click();
      },
      assert: async (page, before) => {
        await until(
          () => budgetBalanceText(page, 'Restaurants'),
          (t) => t === '0.00',
          'C13: the Restaurants balance did not read 0.00',
        );
        await until(
          async () => amount(await budgetBalanceText(page, 'Food')),
          (f) => cents(f - before.food) === cents(before.restaurants),
          `C13: the Food balance did not rise by ${before.restaurants.toFixed(2)}`,
        );
      },
    },

    {
      name: 'C14 next month',
      before: async (page) => {
        await onBudgetPage(page);
        const month = await page.getByTestId('selected-budget-month').getAttribute('data-month');
        if (!month) throw new Error('C14: the selected month has no data-month');
        return { month };
      },
      run: async (page) => {
        await page.getByTitle('Next month').click();
      },
      assert: async (page, before) => {
        const expected = nextMonth(before.month);
        await until(
          () => page.getByTestId('selected-budget-month').getAttribute('data-month'),
          (m) => m === expected,
          `C14: the selected month did not move from ${before.month} to ${expected}`,
        );
      },
    },

    {
      name: 'C15 open reports',
      before: async (page) => onBudgetPage(page),
      run: async (page) => {
        await page.getByRole('link', { name: 'Reports', exact: true }).click();
      },
      assert: async (page) => {
        await until(() => isShown(page.getByTestId('reports-page')), (s) => s, 'C15: the reports page did not show');
        await until(() => isShown(page.getByTestId('budget-table')), (s) => !s, 'C15: the budget table is still shown');
      },
    },

    {
      name: 'C16 open schedules',
      before: async (page) => onBudgetPage(page),
      run: async (page) => {
        await page.getByRole('link', { name: 'Schedules', exact: true }).click();
      },
      assert: async (page) => {
        await until(
          () => isShown(page.getByRole('button', { name: 'Add new schedule' })),
          (s) => s,
          'C16: the schedules page did not show',
        );
        await until(() => isShown(page.getByTestId('budget-table')), (s) => !s, 'C16: the budget table is still shown');
      },
    },

    {
      name: 'C17 open settings',
      before: async (page) => onBudgetPage(page),
      run: async (page) => {
        await page.getByRole('link', { name: 'Settings', exact: true }).click();
      },
      assert: async (page) => {
        await until(() => isShown(page.getByTestId('settings')), (s) => s, 'C17: the settings page did not show');
        await until(
          () => isShown(page.getByRole('navigation', { name: 'Settings' })),
          (s) => s,
          'C17: the settings section navigation did not show',
        );
        await until(() => isShown(page.getByTestId('budget-table')), (s) => !s, 'C17: the budget table is still shown');
      },
    },

    {
      name: 'C18 settings Rules section',
      before: async (page) => {
        await onSettingsPage(page);
        const general = await isShown(page.getByTestId('settings').getByRole('button', { name: 'Export data' }));
        if (!general) throw new Error('C18: the General section is not showing before the change');
      },
      run: async (page) => {
        await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Rules', exact: true }).click();
      },
      assert: async (page) => {
        await until(
          () => page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Rules', exact: true }).getAttribute('aria-current'),
          (v) => v === 'page',
          'C18: the Rules section is not selected in the settings navigation',
        );
        await until(
          () => isShown(page.getByRole('button', { name: /^Create new rule$/ })),
          (s) => s,
          'C18: the Rules content did not show',
        );
        await until(
          () => isShown(page.getByTestId('settings').getByRole('button', { name: 'Export data' })),
          (s) => !s,
          'C18: the General content is still shown',
        );
      },
    },

    {
      name: 'C19 settings Payees section',
      before: async (page) => onSettingsPage(page),
      run: async (page) => {
        await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Payees', exact: true }).click();
      },
      assert: async (page) => {
        await until(
          () => page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Payees', exact: true }).getAttribute('aria-current'),
          (v) => v === 'page',
          'C19: the Payees section is not selected in the settings navigation',
        );
        await until(
          () => page.getByTestId('table').getByTestId('row').filter({ hasText: 'Kroger' }).count(),
          (n) => n > 0,
          'C19: the payee list does not show Kroger',
        );
      },
    },

    {
      name: 'C20 command bar search Ally',
      before: async (page) => {
        await onBudgetPage(page);
        await closeOverlays(page);
      },
      run: async (page) => {
        await page.keyboard.press('ControlOrMeta+k');
        await page.keyboard.type('Ally');
      },
      assert: async (page) => {
        await until(
          () => isShown(page.getByRole('combobox', { name: 'Command Bar' })),
          (s) => s,
          'C20: the command bar did not open',
        );
        await until(
          () => page.getByRole('combobox', { name: 'Command Bar' }).evaluate((input) => {
            const scope = input.closest('[role="dialog"], [data-popover], body') ?? document.body;
            return [...scope.querySelectorAll('[role="option"], [role="listbox"] *')].some((el) => el.textContent?.includes('Ally Savings'));
          }).catch(() => false),
          (s) => s,
          'C20: the results do not list Ally Savings',
        );
      },
    },

    {
      name: 'C21 open help menu',
      before: async (page) => {
        await onBudgetPage(page);
        await closeOverlays(page);
      },
      run: async (page) => {
        await page.getByTestId('help-menu-button').click();
      },
      assert: async (page) => {
        await until(
          () => isShown(page.locator('[data-popover]')),
          (s) => s,
          'C21: the help menu did not open',
        );
        await until(
          () => page.locator('[role="menu"] button').count(),
          (n) => n >= 1,
          'C21: the help menu lists no items',
        );
      },
    },

    {
      name: 'C22 open notifications',
      before: async (page) => {
        await closeOverlays(page);
      },
      run: async (page) => {
        await page.getByTestId('notifications-button').click();
      },
      assert: async (page) => {
        await until(() => page.url().endsWith('/notifications'), (s) => s, 'C22: the notifications view did not open');
        // The page title is text in the page header, not an ARIA heading. The span excludes the notifications
        // button's tooltip and the link of the same name in the content.
        await until(
          () => isShown(page.locator('span').filter({ hasText: /^Notifications$/ })),
          (s) => s,
          'C22: the notifications view did not show its own heading',
        );
      },
    },

    {
      name: 'C23 open add account dialog',
      before: async (page) => {
        await closeOverlays(page);
        await onBudgetPage(page);
      },
      run: async (page) => {
        await page.getByRole('button', { name: 'Add account', exact: true }).click();
      },
      assert: async (page) => {
        const dialog = page.getByRole('dialog').filter({ hasText: 'Add account' });
        await until(() => isShown(dialog), (s) => s, 'C23: the Add account dialog did not open');
        // The heading's accessible name includes the dialog's Close button ("Add account Close").
        await until(
          () => isShown(dialog.getByRole('heading', { name: /^Add account/ })),
          (s) => s,
          'C23: the Add account dialog has no "Add account" heading',
        );
        await until(
          async () =>
            (await isShown(dialog.getByLabel(/^Name/).first())) && (await isShown(dialog.getByLabel(/^Balance/).first())),
          (s) => s,
          'C23: the dialog has no Name and Balance fields',
        );
      },
    },

    {
      name: 'C24 cancel add account dialog',
      before: async (page) => {
        const dialog = page.getByRole('dialog').filter({ hasText: 'Add account' });
        if (!(await isShown(dialog))) {
          await page.getByRole('button', { name: 'Add account', exact: true }).click();
          await until(() => isShown(dialog), (s) => s, 'C24: the Add account dialog did not open before cancelling');
        }
        return { names: await sidebarLinks(page) };
      },
      run: async (page) => {
        await page.getByRole('dialog').filter({ hasText: 'Add account' }).getByRole('button', { name: 'Cancel', exact: true }).click();
      },
      assert: async (page, before) => {
        await until(
          () => isShown(page.getByRole('dialog').filter({ hasText: 'Add account' })),
          (s) => !s,
          'C24: the Add account dialog is still visible',
        );
        await until(
          () => sidebarLinks(page),
          (names) => JSON.stringify(names) === JSON.stringify(before.names),
          'C24: the sidebar changed after cancelling',
        );
      },
    },
  ],
};
