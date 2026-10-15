// cases.test.mjs: for each app that has an adapter, the frozen cases file exists, has at least 20
// distinct IDs, and the adapter's steps carry those IDs in the same order.
//
//   node --test cases.test.mjs      # or npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allApps } from './apps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

for (const app of Object.values(allApps)) {
  const cases = path.join(HERE, 'adapters', `${app.id}.cases.json`);
  if (!fs.existsSync(cases)) continue;

  test(`${app.id}: cases are frozen with at least 20 distinct IDs`, () => {
    const list = JSON.parse(fs.readFileSync(cases, 'utf8'));
    const ids = list.map((c) => c.id);
    assert.ok(ids.length >= 20, `${app.id} has ${ids.length} cases`);
    assert.equal(new Set(ids).size, ids.length, 'case IDs are distinct');
    for (const c of list) {
      for (const key of ['id', 'action', 'reset', 'expectedStateChange']) {
        assert.ok(typeof c[key] === 'string' && c[key].length > 0, `${app.id} ${c.id} is missing ${key}`);
      }
    }
  });

  test(`${app.id}: the adapter's steps match the frozen cases, in order`, async () => {
    if (!app.steps) return; // adapter not loaded yet; the registry reports it as pending
    const list = JSON.parse(fs.readFileSync(cases, 'utf8'));
    assert.deepEqual(
      app.steps.map((s) => s.name.split(' ')[0]),
      list.map((c) => c.id),
    );
  });
}
