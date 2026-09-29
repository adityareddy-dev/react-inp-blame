// configs.test.mjs: both scripts refuse an app asked for a configuration it has no build of, and do
// it before anything builds or starts. Only dry runs, so no install, no build and no browser.
//
//   node --test configs.test.mjs      # or npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
  test(`${script} refuses every app in the default order, since cal-diy has no C`, () => {
    const r = dryRun(script, []);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /cal-diy has no configuration C \(it has A, B\)/);
  });

  test(`${script} refuses tt-virtual-fix in the default order`, () => {
    const r = dryRun(script, ['--app', 'tt-virtual-fix']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /tt-virtual-fix has no configuration A, C \(it has B, F\)/);
  });

  test(`${script} takes tt-virtual-fix with BENCH_ORDER=B,F`, () => {
    const r = dryRun(script, ['--app', 'tt-virtual-fix'], 'B,F');
    assert.equal(r.status, 0, r.out);
  });

  test(`${script} takes cal-diy with BENCH_ORDER=A,B`, () => {
    const r = dryRun(script, ['--app', 'cal-diy'], 'A,B');
    assert.equal(r.status, 0, r.out);
  });

  test(`${script} takes apps that have A, B and C in the default order`, () => {
    const r = dryRun(script, ['--app', 'tt-fuzzy,twenty']);
    assert.equal(r.status, 0, r.out);
  });

  test(`${script} refuses an app that isn't there`, () => {
    const r = dryRun(script, ['--app', 'nope']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /no such app: nope/);
  });
}
