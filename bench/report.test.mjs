// report.test.mjs: report.mjs and before-after.mjs over a small results file in the shape bench.mjs
// writes, the failure text a run can leave in it, and the address shadcn's next start listens on.
// Nothing installed, no browser, no server, the file is made up in a temp folder.
//
//   node --test report.test.mjs      # or npm test

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const temps = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

/** One run as bench.mjs records it, with the library in for every configuration but A. */
function run(app, config, runIndex, inp) {
  return {
    app,
    config,
    throttle: 1,
    runIndex,
    warmup: false,
    inp,
    totalInteractionMs: inp,
    interactions: [{ startTime: 10, duration: inp }],
    firstInput: null,
    loafBlockingMs: 0,
    loafCount: 0,
    readyMs: 500,
    heap: null,
    steps: [{ name: 'sort-lastName-asc', pageStart: 0, pageEnd: 1000 }],
    lib:
      config === 'A'
        ? null
        : {
            stats: { installMs: 1, walkTotalMs: 1, reportTotalMs: 1, walks: 1, mode: 'hook' },
            overheadTotalMs: 1,
            reportCount: 1,
            inp: { value: inp },
            reports: [
              {
                type: 'click',
                target: { label: 'Last Name' },
                blame: { kind: 'component', name: 'Table', detail: 'render', ms: inp / 2, confidence: 'high' },
                verdict: 'Table rendered',
                duration: inp,
                start: 10,
              },
            ],
          },
    console: [],
    pageErrors: [],
  };
}

/**
 * Writes a results file for `app` with `configs` and ten runs each, `inp(config, i)` for run i, and
 * returns its path. `skip` holds the `config:i` runs that failed and so are left out of the runs.
 */
function results({ app, configs, inp = (c, i) => 100 + 20 * i, skip = [], failures = [], libCheck = null }) {
  const runs = [];
  for (let i = 0; i < 10; i++) {
    for (const c of configs) if (!skip.includes(`${c}:${i}`)) runs.push(run(app, c, i, inp(c, i)));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-report-'));
  temps.push(dir);
  const file = path.join(dir, 'results', '2026-09-29T00-00-00-000Z.json');
  fs.mkdirSync(path.dirname(file));
  const data = {
    started: '2026-09-29T00:00:00.000Z',
    finished: '2026-09-29T01:00:00.000Z',
    args: { runs: 10, app, throttles: [1] },
    versions: {
      node: 'v24.0.0',
      chromium: '1',
      playwright: '1.59.1',
      os: 'test',
      tarball: null,
      npm: null,
      libCheck,
      apps: { [app]: { commit: 'c', react: '19.0.0', 'react-inp-blame': '0.12.0' } },
    },
    runs,
    failures,
  };
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

function node(script, file) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), file], { cwd: HERE, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return r.stdout;
}

test('tt-virtual-fix gets B and F, no A/B/C table and a pointer to before-after.mjs', () => {
  const md = node('report.mjs', results({ app: 'tt-virtual-fix', configs: ['B', 'F'] }));
  assert.doesNotMatch(md, /\| Metric \| A median/);
  assert.match(md, /\n\| \| B \| F \|\n/);
  assert.match(md, /node before-after\.mjs results\/2026-09-29T00-00-00-000Z\.json/);
});

test('the Source line names the results file without its folder', () => {
  const file = results({ app: 'tt-fuzzy', configs: ['A', 'B', 'C'] });
  const md = node('report.mjs', file);
  assert.match(md, /^Source: `2026-09-29T00-00-00-000Z\.json`$/m);
  assert.ok(!md.includes(path.dirname(file)));
});

test('a failure keeps its text with the home folder cut to ~, in both slash forms', () => {
  const home = os.homedir();
  const error = `ENOENT ${home}${path.sep}bench${path.sep}a.json, then ${home.replaceAll('\\', '/')}/bench/b.json`;
  const md = node(
    'report.mjs',
    results({ app: 'tt-fuzzy', configs: ['A', 'B', 'C'], skip: ['C:4'], failures: [{ app: 'tt-fuzzy', config: 'C', throttle: 1, runIndex: 4, error }] }),
  );
  const line = md.split('\n').find((l) => l.startsWith('- `tt-fuzzy` C x1 run 4:'));
  assert.ok(line, md);
  assert.ok(!line.includes(home) && !line.includes(home.replaceAll('\\', '/')), line);
  assert.match(line, /ENOENT ~.bench.a\.json, then ~\/bench\/b\.json$/);
});

test('twenty with no saved sign-in names the state file relative to bench/', async () => {
  const { apps } = await import('./apps-twenty.mjs');
  assert.throws(
    () => apps.twenty.contextOptions('never-built'),
    (err) => err.message.includes(`at ${path.join('state', 'twenty-never-built.json')};`) && !err.message.includes(HERE),
  );
});

test('the run count names each configuration when a failed run leaves them uneven', () => {
  const even = node('report.mjs', results({ app: 'tt-fuzzy', configs: ['A', 'B', 'C'] }));
  assert.match(even, /^10 runs per configuration \(A, B, C\)\.$/m);
  const uneven = node('report.mjs', results({ app: 'tt-fuzzy', configs: ['A', 'B', 'C'], skip: ['C:4'] }));
  assert.match(uneven, /^A 10, B 10, C 9 runs\.$/m);
  assert.doesNotMatch(uneven, /runs per configuration/);
  const fix = node('report.mjs', results({ app: 'tt-virtual-fix', configs: ['B', 'F'], skip: ['B:2'] }));
  assert.match(fix, /^B 9, F 10 runs\.$/m);
});

test('the library check shows in the report, and a copy that differs is said at the top', () => {
  const check = (match) =>
    JSON.stringify({
      spec: 'react-inp-blame@0.12.0',
      files: 40,
      apps: { 'tt-fuzzy': { installed: 'a/tt/node_modules/react-inp-blame', version: '0.12.0', match, differs: match ? [] : ['dist/index.js'], extra: [] } },
    });
  const top = (md) => md.slice(0, md.indexOf('## Configurations'));

  const ok = node('report.mjs', results({ app: 'tt-fuzzy', configs: ['A', 'B', 'C'], libCheck: check(true) }));
  assert.match(ok, /^\| react-inp-blame in tt-fuzzy \| matches `react-inp-blame@0\.12\.0` byte for byte \|$/m);
  assert.doesNotMatch(top(ok), /\*\*/);

  const bad = node('report.mjs', results({ app: 'tt-fuzzy', configs: ['A', 'B', 'C'], libCheck: check(false) }));
  assert.match(bad, /^\| react-inp-blame in tt-fuzzy \| DIFFERS from `react-inp-blame@0\.12\.0`: `dist\/index\.js` \|$/m);
  assert.match(top(bad), /\*\*The library check failed\.\*\*/);

  const none = node('report.mjs', results({ app: 'tt-fuzzy', configs: ['A', 'B', 'C'] }));
  assert.match(top(none), /\*\*The library was not checked\.\*\*/);
});

test('before-after.mjs pairs B and F by run index, so a failed run shifts nothing', () => {
  // F equals B at every run index, so every true pair differs by 0. B's run 2 failed.
  const out = node('before-after.mjs', results({ app: 'tt-virtual-fix', configs: ['B', 'F'], skip: ['B:2'] }));
  assert.match(out, /^## x1, 9 paired runs, left out for want of a partner: F 1$/m);
  assert.match(out, /^- INP: B 200, F 200, F − B 0 \[0, 0\]$/m);
});

test('before-after.mjs says so when a pass has no B runs', () => {
  const skip = Array.from({ length: 10 }, (_, i) => `B:${i}`);
  const out = node('before-after.mjs', results({ app: 'tt-virtual-fix', configs: ['B', 'F'], skip }));
  assert.match(out, /^## x1, no B runs, so nothing to compare$/m);
});

test("shadcn's next start listens on 127.0.0.1 only, as cal-diy's does", () => {
  // Swaps the harness's own spawn for one that throws its arguments, so nothing starts. Only the
  // shadcn entries: cal-diy's startServer runs its backend before it gets to next start.
  const child = `
    import { registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const stub = 'data:text/javascript,' + encodeURIComponent(
      "export * from 'node:child_process'; export function spawn(cmd, args) { throw new Error(JSON.stringify(args.slice(1))); }",
    );
    const own = /\\/bench\\/[^/]+\\.mjs$/;
    registerHooks({
      resolve: (spec, ctx, next) =>
        spec === 'node:child_process' && own.test(ctx.parentURL ?? '') ? { url: stub, shortCircuit: true } : next(spec, ctx),
    });
    const { apps } = await import(pathToFileURL(${JSON.stringify(path.join(HERE, 'apps.mjs'))}).href);
    for (const id of ['shadcn-v4', 'shadcn-sheet', 'shadcn-sheet-phone']) {
      await apps[id].startServer('A', 5999).then(
        () => console.log(id, 'started'),
        (err) => console.log(id, err.message.split('\\n')[0]),
      );
    }
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { cwd: HERE, encoding: 'utf8', timeout: 60000 });
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 3, `${r.stdout}${r.stderr}`);
  for (const line of lines) {
    const [id, json] = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)];
    const args = JSON.parse(json);
    assert.equal(args[0], 'start', line);
    assert.equal(args[args.indexOf('--hostname') + 1], '127.0.0.1', `${id}: ${line}`);
  }
});
