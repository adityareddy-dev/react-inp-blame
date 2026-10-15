import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The five selected apps, in the amendment's order. Their order fixes the reserved ports.
const COHORT = [
  ['actual', 'Actual', 'actualbudget/actual'],
  ['myfin', 'myfin', 'afaneca/myfin'],
  ['kresus', 'Kresus', 'kresusapp/kresus'],
  ['manage-my-damn-life-nextjs', 'Manage My Damn Life', 'intri-in/manage-my-damn-life-nextjs'],
  ['reactive-resume', 'Reactive Resume', 'amruthpillai/reactive-resume'],
];

// The regression cohort (hyperdx and kaneo, from the 0.25.0 baseline) is not registered. The task
// names them, but the cohort is the five apps above, and their upstream repositories are not yet
// confirmed. Register them only after the user confirms the repositories and a dated amendment is
// committed.
const REGRESSION = [];

function entry(cohort, index, [id, title, repository]) {
  return {
    id,
    title,
    cohort,
    repository: `https://github.com/${repository}`,
    dir: path.join(HERE, 'clones', id),
    status: 'integration-pending',
    dists: { A: 'dist-a', B: 'dist-b', C: 'dist-c' },
    ports: { A: 5310 + index * 3, B: 5311 + index * 3, C: 5312 + index * 3 },
  };
}

/** Every app the harness knows, cohort and regression, keyed by id. */
export const allApps = Object.fromEntries([
  ...COHORT.map((a, i) => [a[0], entry('cohort', i, a)]),
  ...REGRESSION.map((a, i) => [a[0], entry('regression', COHORT.length + i, a)]),
]);

/** The five selected apps. The default for every run, and what the tests pin. */
export const apps = Object.fromEntries(COHORT.map((a) => [a[0], allApps[a[0]]]));
export const cohortIds = Object.keys(apps);

// An app's integration is bench/adapters/<id>.mjs: its build, server, reset, ready and steps. An
// adapter cannot move the app's directory, ports or output names, which are set above.
for (const app of Object.values(allApps)) {
  const file = path.join(HERE, 'adapters', `${app.id}.mjs`);
  if (!fs.existsSync(file)) continue;
  const adapter = (await import(pathToFileURL(file).href)).default;
  for (const key of ['id', 'cohort', 'dir', 'dists', 'ports']) {
    if (key in adapter && JSON.stringify(adapter[key]) !== JSON.stringify(app[key])) {
      throw new Error(`${app.id}: an adapter may not change ${key}`);
    }
  }
  Object.assign(app, adapter);
  app.status = adapter.status ?? 'integration-pending';
}

export function checkConfigs(appIds, configs) {
  if (!appIds.length || !configs.length) throw new Error('select at least one app and configuration');
  for (const id of appIds) {
    if (!Object.hasOwn(allApps, id)) throw new Error(`no such app: ${id}`);
    const available = Object.keys(allApps[id].ports);
    const missing = configs.filter((config) => !available.includes(config));
    if (missing.length) {
      throw new Error(`${id} has no configuration ${missing.join(', ')} (it has ${available.join(', ')})`);
    }
  }
}

export function checkReady(appIds) {
  for (const id of appIds) {
    if (allApps[id].status !== 'ready') {
      throw new Error(`${id}: integration pending; pin the upstream commit, add verified build/server setup and asserted interaction steps before collecting results`);
    }
  }
}
