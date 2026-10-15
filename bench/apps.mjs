import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const apps = Object.fromEntries([
  ['actual', 'Actual', 'actualbudget/actual'],
  ['myfin', 'myfin', 'afaneca/myfin'],
  ['kresus', 'Kresus', 'kresusapp/kresus'],
  ['manage-my-damn-life-nextjs', 'Manage My Damn Life', 'intri-in/manage-my-damn-life-nextjs'],
  ['reactive-resume', 'Reactive Resume', 'amruthpillai/reactive-resume'],
].map(([id, title, repository], index) => [id, {
  id,
  title,
  repository: `https://github.com/${repository}`,
  dir: path.join(HERE, 'clones', id),
  status: 'integration-pending',
  dists: { A: 'dist-a', B: 'dist-b', C: 'dist-c' },
  ports: { A: 5310 + index * 3, B: 5311 + index * 3, C: 5312 + index * 3 },
}]));

export function checkConfigs(appIds, configs) {
  if (!appIds.length || !configs.length) throw new Error('select at least one app and configuration');
  for (const id of appIds) {
    if (!Object.hasOwn(apps, id)) throw new Error(`no such app: ${id}`);
    const available = Object.keys(apps[id].ports);
    const missing = configs.filter((config) => !available.includes(config));
    if (missing.length) {
      throw new Error(`${id} has no configuration ${missing.join(', ')} (it has ${available.join(', ')})`);
    }
  }
}

export function checkReady(appIds) {
  for (const id of appIds) {
    if (apps[id].status !== 'ready') {
      throw new Error(`${id}: integration pending; pin the upstream commit, add verified build/server setup and asserted interaction steps before collecting results`);
    }
  }
}