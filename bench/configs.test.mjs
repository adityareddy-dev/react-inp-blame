// configs.test.mjs: both scripts refuse an app asked for a configuration it has no build of, and do
// it before anything builds or starts. Only dry runs, so no install, no build and no browser.
//
//   node --test configs.test.mjs      # or npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apps } from './apps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('the cohort contains exactly the five selected everyday apps', () => {
  assert.deepEqual(Object.keys(apps), [
    'actual', 'myfin', 'kresus', 'manage-my-damn-life-nextjs', 'reactive-resume',
  ]);
  assert.deepEqual(Object.values(apps).map((app) => app.repository), [
    'https://github.com/actualbudget/actual',
    'https://github.com/afaneca/myfin',
    'https://github.com/kresusapp/kresus',
    'https://github.com/intri-in/manage-my-damn-life-nextjs',
    'https://github.com/amruthpillai/reactive-resume',
  ]);
});

function dryRun(script, args, order) {
  const env = { ...process.env };
  if (order) env.BENCH_ORDER = order;
  else delete env.BENCH_ORDER;
  const r = spawnSync(process.execPath, [path.join(HERE, script), '--dry-run', ...args], {
    cwd: HERE,
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

for (const script of ['bench.mjs', 'run.mjs']) {
  test(`${script} lists the five apps in the default order`, () => {
    const r = dryRun(script, []);
    assert.equal(r.status, 0, r.out);
    const selection = JSON.parse(r.out);
    assert.deepEqual(selection.apps, Object.keys(apps));
    assert.deepEqual(selection.configs, ['A', 'B', 'C']);
  });

  test(`${script} refuses an unsupported configuration`, () => {
    const r = dryRun(script, ['--app', 'actual'], 'A,D');
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /actual has no configuration D \(it has A, B, C\)/);
  });

  test(`${script} takes a subset with BENCH_ORDER=A,B`, () => {
    const r = dryRun(script, ['--app', 'actual,myfin'], 'A,B');
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(JSON.parse(r.out).apps, ['actual', 'myfin']);
    assert.deepEqual(JSON.parse(r.out).configs, ['A', 'B']);
  });

  test(`${script} stops before installation or collection for every pending integration`, () => {
    for (const id of Object.keys(apps)) {
      const options = script === 'run.mjs' ? [[], ['--no-build']] : [[]];
      for (const flags of options) {
        const result = spawnSync(process.execPath, [path.join(HERE, script), '--app', id, ...flags], {
          cwd: HERE,
          encoding: 'utf8',
          timeout: 60000,
          env: { ...process.env, BENCH_ORDER: 'A,B,C' },
        });
        assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
        assert.ok(result.stderr.includes(`${id}: integration pending`), result.stderr);
        assert.doesNotMatch(result.stdout, /== install|== build|== bench/);
      }
    }
  });

  test(`${script} refuses an app that isn't there`, () => {
    const r = dryRun(script, ['--app', 'nope']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /no such app: nope/);
  });
}
