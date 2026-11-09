import assert from 'node:assert/strict';
import path from 'node:path';
import { dir, source, library, install, prepare, build } from './actual-build.mjs';
import { serveActual } from './actual-server.mjs';

async function until(read, accept, message) {
  const deadline = Date.now() + 15000;
  do {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(message);
}
const text = (locator, expected) => until(() => locator.textContent(), (v) => v?.trim() === expected, `Expected ${expected}`);
const rows = (page) => page.getByTestId('transaction-table').getByTestId('row');
const first = (page) => rows(page).first();
const selectedMonth = (page) => page.getByTestId('selected-budget-month').first();
const cell = (page, category) => page.getByTestId('budget-table').getByTestId('row')
  .filter({ has: page.getByText(category, { exact: true }) }).first().getByTestId('budget').first();

async function budget(page) {
  await page.getByRole('link', { name: 'Budget', exact: true }).click();
  await page.getByTestId('budget-table').waitFor();
  // Playwright mode pins Today to January 2017. Restore through the app's own month picker.
  if (await selectedMonth(page).getAttribute('data-month') !== '2017-01') {
    await page.getByTitle('Today', { exact: true }).click();
  }
  await until(() => selectedMonth(page).getAttribute('data-month'), (v) => v === '2017-01', 'Initial budget month is not January 2017');
}
async function account(page, name = 'Bank of America') {
  await budget(page);
  await page.getByRole('link', { name: new RegExp(`^${name}`) }).click();
  await text(page.getByTestId('account-name'), name);
  const search = page.getByPlaceholder('Search');
  if (await search.inputValue()) {
    await search.fill('');
    await rows(page).first().waitFor();
  }
  await rows(page).first().waitFor();
}

async function transactions(page) {
  return page.evaluate(async () => (await window.$query(window.$q('transactions').select('*'))).data);
}

async function markedTransaction(page, note) {
  const id = await page.evaluate(async (note) => {
    const account = location.pathname.split('/').at(-1);
    const { data } = await window.$query(window.$q('transactions').select('*'));
    const target = data.find((t) => t.account === account && !t.reconciled && !t.is_parent && !t.is_child && !t.transfer_id);
    if (!target) throw new Error('Missing editable fixture transaction');
    await window.$send('transaction-update', { ...target, notes: note });
    return target.id;
  }, note);
  // Remount the table after the worker-side setup update.
  await account(page);
  await page.getByPlaceholder('Search').fill(note);
  await until(() => rows(page).allTextContents(), (v) => v.length === 1 && v[0].includes(note), 'Marked transaction search did not finish');
  return (await transactions(page)).find((t) => t.id === id);
}

export async function ready(page) {
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => window.__actionsForMenu?.createBudget && window.$query);
  // ManagementApp mounts this screen only after initialization and loading finish.
  // Exposed actions exist earlier, while startup can still reopen a budget.
  await page.getByRole('button', { name: 'Try the demo', exact: true }).waitFor();
  const result = await page.evaluate(() => window.__actionsForMenu.createBudget({ demoMode: true }));
  assert.ok(!result.error, JSON.stringify(result.error));
  await page.getByTestId('budget-table').waitFor();
  assert.equal(await page.getByTestId('budget-name').textContent(), 'Demo Budget');
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  assert.equal((await transactions(page)).length, 304, 'Wrong seeded transaction count');
  await text(page.getByTestId('sidebar-all-accounts-balance'), '43,108.00');
  await text(page.getByTestId('sidebar-on-budget-balance'), '20,918.00');
  await budget(page);
  return page.evaluate(async () => {
    const accounts = await window.$send('accounts-get');
    const { data } = await window.$query(window.$q('transactions').select('*'));
    const names = new Map(accounts.map((a) => [a.id, a.name]));
    const canonical = data.map((t) => JSON.stringify([names.get(t.account), t.date, t.amount, t.notes,
      t.cleared, t.reconciled, t.is_parent, t.is_child, t.starting_balance_flag])).sort();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical)));
    return { transactions: data.length, accounts: accounts.length,
      fixtureSha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') };
  });
}

function openAccount(id, label, title) {
  return {
    name: `${id} ${label}`,
    before: async (page) => { await budget(page); },
    run: (page) => page.getByRole('link', { name: new RegExp(`^${label}`) }).click(),
    assert: async (page) => {
      await text(page.getByTestId('account-name'), title);
      await rows(page).first().waitFor();
      assert.ok((await page.getByTestId('account-balance').textContent()).trim());
    },
  };
}
function monthStep(id, title, expected) {
  return {
    name: `${id} ${title}`,
    before: budget,
    run: (page) => page.getByTitle(title, { exact: true }).click(),
    assert: (page) => until(() => selectedMonth(page).getAttribute('data-month'), (v) => v === expected, `Month did not change to ${expected}`),
  };
}
function budgetStep(id, category, amount) {
  return {
    name: `${id} budget ${category}`,
    before: async (page) => {
      await budget(page);
      assert.notEqual((await cell(page, category).textContent()).trim(), amount, 'Budget already has target value');
    },
    run: async (page) => {
      await cell(page, category).click();
      const input = cell(page, category).locator('input');
      await input.fill(amount);
      await input.press('Enter');
    },
    assert: (page) => text(cell(page, category), amount),
  };
}

export const steps = [
  openAccount('C01', 'Bank of America', 'Bank of America'),
  openAccount('C02', 'Ally Savings', 'Ally Savings'),
  openAccount('C03', 'HSBC', 'HSBC'),
  openAccount('C04', 'Roth IRA', 'Roth IRA'),
  openAccount('C05', 'Vanguard 401k', 'Vanguard 401k'),
  openAccount('C06', 'On budget', 'On Budget Accounts'),
  openAccount('C07', 'All accounts', 'All Accounts'),
  monthStep('C08', 'Next month', '2017-02'),
  monthStep('C09', 'Previous month', '2016-12'),
  budgetStep('C10', 'Food', '325.00'),
  budgetStep('C11', 'Restaurants', '123.00'),
  {
    name: 'C12 search Kroger',
    before: async (page) => {
      await account(page);
      const unfiltered = await rows(page).allTextContents();
      assert.ok(unfiltered.some((r) => !r.includes('Kroger')), 'Unfiltered rows contain no non-Kroger control');
      return unfiltered;
    },
    run: (page) => page.getByPlaceholder('Search').pressSequentially('Kroger'),
    assert: async (page, unfiltered) => {
      const filtered = await until(() => rows(page).allTextContents(), (v) => v.length > 0 && v.every((r) => r.includes('Kroger')), 'Search did not filter to Kroger');
      assert.notDeepEqual(filtered, unfiltered, 'Search did not change the result rows');
      assert.equal(await page.getByPlaceholder('Search').inputValue(), 'Kroger');
    },
  },
  {
    name: 'C13 search absent payee', before: (page) => account(page),
    run: (page) => page.getByPlaceholder('Search').pressSequentially('bench-no-such-payee'),
    assert: async (page) => {
      assert.equal(await page.getByPlaceholder('Search').inputValue(), 'bench-no-such-payee');
      await until(() => rows(page).count(), (n) => n === 0, 'Absent search still has rows');
    },
  },
  {
    name: 'C14 clear search',
    before: async (page) => {
      await account(page);
      await page.getByPlaceholder('Search').fill('bench-no-such-payee');
      await until(() => rows(page).count(), (n) => n === 0, 'Search setup did not finish');
    },
    run: async (page) => {
      await page.getByPlaceholder('Search').click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
    },
    assert: async (page) => {
      assert.equal(await page.getByPlaceholder('Search').inputValue(), '');
      await rows(page).first().waitFor();
    },
  },
  {
    name: 'C15 select transaction', before: (page) => account(page),
    run: (page) => first(page).getByTestId('select').click(),
    assert: (page) => text(page.getByTestId('transactions-select-button'), '1 transactions'),
  },
  {
    name: 'C16 open transaction entry', before: (page) => account(page),
    run: (page) => page.getByRole('button', { name: 'Add New', exact: true }).click(),
    assert: async (page) => {
      await page.getByTestId('new-transaction').waitFor();
      await page.getByTestId('add-button').waitFor();
    },
  },
  {
    name: 'C17 edit transaction note',
    before: async (page) => {
      await account(page);
      return markedTransaction(page, 'bench-note-target');
    },
    run: async (page) => {
      const row = first(page);
      await row.getByTestId('notes').click();
      const input = row.getByTestId('notes').getByRole('combobox');
      await input.fill('bench-edited-note');
      await input.press('Tab');
    },
    assert: async (page, before) => {
      // The search still matches the old note, so the changed row leaves the view.
      await until(async () => (await transactions(page)).find((t) => t.id === before.id)?.notes,
        (v) => v === 'bench-edited-note', 'Note was not persisted on the selected transaction');
    },
  },
  {
    name: 'C18 toggle cleared state',
    before: async (page) => {
      await account(page);
      const transaction = await markedTransaction(page, 'bench-cleared-target');
      return { id: transaction.id, cleared: transaction.cleared,
        dom: await rows(page).filter({ hasText: 'bench-cleared-target' }).first().getByTestId('cleared').innerHTML() };
    },
    run: (page) => rows(page).filter({ hasText: 'bench-cleared-target' }).first().getByTestId('cleared').getByTestId('cell-button').click(),
    assert: async (page, before) => {
      await until(async () => (await transactions(page)).find((t) => t.id === before.id)?.cleared,
        (v) => v === !before.cleared, `Stored cleared flag did not change for ${before.id}`);
      assert.notEqual(await rows(page).filter({ hasText: 'bench-cleared-target' }).first().getByTestId('cleared').innerHTML(), before.dom);
    },
  },
  {
    name: 'C19 open schedules', before: budget,
    run: (page) => page.getByRole('link', { name: 'Schedules', exact: true }).click(),
    assert: async (page) => {
      await page.getByRole('button', { name: 'Add new schedule', exact: true }).waitFor();
      await page.getByTestId('table').getByTestId('row').first().waitFor();
    },
  },
  {
    name: 'C20 open reports', before: budget,
    run: (page) => page.getByRole('link', { name: 'Reports', exact: true }).click(),
    assert: async (page) => {
      await page.getByTestId('reports-page').waitFor();
      await page.getByTestId('reports-page').getByRole('button', { name: /^Net/ }).waitFor();
    },
  },
];

export default {
  status: 'ready',
  source, library, install, prepare, build, ready, steps,
  measurementStatus: 'functional pilot; protocol overhead and accuracy collection pending',
  assetsDir: '.',
  contextOptions: () => ({ userAgent: 'playwright', serviceWorkers: 'block', locale: 'en-US', timezoneId: 'UTC' }),
  // Every harness run creates a new nonpersistent context. IndexedDB, OPFS and localStorage start empty.
  startServer: (config, port) => serveActual(path.join(dir, `dist-${config.toLowerCase()}`), port),
};
