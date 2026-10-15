// report.test.mjs: report.mjs over synthetic results in the shape bench.mjs writes.
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
function run(app, config, runIndex, inp, throttle = 1) {
  return {
    app,
    config,
    throttle,
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
 * Writes a results file for `app` with `configs` and ten runs each per pass in `throttles`,
 * `inp(config, i)` for run i, and returns its path. `skip` holds the runs that failed and so are left
 * out of the runs, `config:i` in every pass or `config:ixT` in the xT pass only. `each` can change a run.
 */
function results({ app, configs, throttles = [1], inp = (c, i) => 100 + 20 * i, skip = [], failures = [], libCheck = null, each = () => {} }) {
  const runs = [];
  for (const t of throttles) {
    for (let i = 0; i < 10; i++) {
      for (const c of configs) {
        if (skip.includes(`${c}:${i}`) || skip.includes(`${c}:${i}x${t}`)) continue;
        const r = run(app, c, i, inp(c, i), t);
        each(r);
        runs.push(r);
      }
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-report-'));
  temps.push(dir);
  const file = path.join(dir, 'results', '2026-09-29T00-00-00-000Z.json');
  fs.mkdirSync(path.dirname(file));
  const data = {
    started: '2026-09-29T00:00:00.000Z',
    finished: '2026-09-29T01:00:00.000Z',
    args: { runs: 10, app, throttles },
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

function node(script, file, ...args) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), file, ...args], { cwd: HERE, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return r.stdout;
}

test('the Source line names the results file without its folder', () => {
  const file = results({ app: 'synthetic', configs: ['A', 'B', 'C'] });
  const md = node('report.mjs', file);
  assert.match(md, /^Source: `2026-09-29T00-00-00-000Z\.json`$/m);
  assert.ok(!md.includes(path.dirname(file)));
});

test('a failure keeps its text with the home folder cut to ~, in both slash forms', () => {
  const home = os.homedir();
  const error = `ENOENT ${home}${path.sep}bench${path.sep}a.json, then ${home.replaceAll('\\', '/')}/bench/b.json`;
  const md = node(
    'report.mjs',
    results({ app: 'synthetic', configs: ['A', 'B', 'C'], skip: ['C:4'], failures: [{ app: 'synthetic', config: 'C', throttle: 1, runIndex: 4, error }] }),
  );
  const line = md.split('\n').find((l) => l.startsWith('- `synthetic` C x1 run 5:'));
  assert.ok(line, md);
  assert.ok(!line.includes(home) && !line.includes(home.replaceAll('\\', '/')), line);
  assert.match(line, /ENOENT ~.bench.a\.json, then ~\/bench\/b\.json$/);
});

test('a failure is numbered as the console numbered it, from 1, and a warm-up is called one', () => {
  const failures = [
    { app: 'synthetic', config: 'B', throttle: 1, runIndex: -1, warmup: true, error: 'warm-up timed out' },
    { app: 'synthetic', config: 'B', throttle: 1, runIndex: 2, error: 'step did nothing' },
  ];
  const md = node('report.mjs', results({ app: 'synthetic', configs: ['A', 'B', 'C'], skip: ['B:2'], failures }));
  assert.match(md, /^- `synthetic` B x1 warmup: warm-up timed out$/m);
  assert.match(md, /^- `synthetic` B x1 run 3: step did nothing$/m);
  assert.doesNotMatch(md, /run -1/);
});

test('the run count names each configuration when a failed run leaves them uneven', () => {
  const even = node('report.mjs', results({ app: 'synthetic', configs: ['A', 'B', 'C'] }));
  assert.match(even, /^10 runs per configuration \(A, B, C\)\.$/m);
  const uneven = node('report.mjs', results({ app: 'synthetic', configs: ['A', 'B', 'C'], skip: ['C:4'] }));
  assert.match(uneven, /^A 10, B 10, C 9 runs\.$/m);
  assert.doesNotMatch(uneven, /runs per configuration/);
});

test('the library check shows in the report, and a copy that differs is said at the top', () => {
  const check = (match) =>
    JSON.stringify({
      spec: 'react-inp-blame@0.12.0',
      files: 40,
      apps: { synthetic: { installed: 'fixture/node_modules/react-inp-blame', version: '0.12.0', match, differs: match ? [] : ['dist/index.js'], extra: [] } },
    });
  const top = (md) => md.slice(0, md.indexOf('## Configurations'));

  const ok = node('report.mjs', results({ app: 'synthetic', configs: ['A', 'B', 'C'], libCheck: check(true) }));
  assert.match(ok, /^\| react-inp-blame in synthetic \| matches `react-inp-blame@0\.12\.0` byte for byte \|$/m);
  assert.doesNotMatch(top(ok), /\*\*/);

  const bad = node('report.mjs', results({ app: 'synthetic', configs: ['A', 'B', 'C'], libCheck: check(false) }));
  assert.match(bad, /^\| react-inp-blame in synthetic \| DIFFERS from `react-inp-blame@0\.12\.0`: `dist\/index\.js` \|$/m);
  assert.match(top(bad), /\*\*The library check failed\.\*\*/);

  const none = node('report.mjs', results({ app: 'synthetic', configs: ['A', 'B', 'C'] }));
  assert.match(top(none), /\*\*The library was not checked\.\*\*/);
});

/** Every run of `configs` in the xT pass (every pass when `t` is null), as `skip` and as failures. */
function failed(app, configs, t = null) {
  const runs = configs.flatMap((c) => Array.from({ length: 10 }, (_, i) => [c, i]));
  return {
    skip: runs.map(([c, i]) => (t ? `${c}:${i}x${t}` : `${c}:${i}`)),
    failures: runs.map(([c, i]) => ({ app, config: c, throttle: t ?? 1, runIndex: i, error: 'timed out' })),
  };
}

test('a pass where every B run failed says so, not that B reported nothing and logged nothing', () => {
  const md = node('report.mjs', results({ app: 'synthetic', configs: ['A', 'B', 'C'], ...failed('synthetic', ['B']) }));
  assert.match(md, /^10 runs per configuration \(A, C\)\.$/m);
  assert.match(md, /^No B runs in this pass, see Failures\.$/m);
  assert.doesNotMatch(md, /No reports\./);
  assert.match(md, /^Nothing: no errors or warnings in A or C\. B had no runs to check, see Failures\.$/m);
});

test('a pass where every run failed says so once and prints nothing else for it', () => {
  const md = node('report.mjs', results({ app: 'synthetic', configs: ['A', 'B', 'C'], throttles: [1, 4], ...failed('synthetic', ['A', 'B', 'C'], 4) }));
  const pass = md.slice(md.indexOf('### 4x CPU throttling'));
  assert.equal(pass.trim(), '### 4x CPU throttling\n\nEvery run in this pass failed, see Failures.');
  assert.match(md.slice(0, md.indexOf('### 4x')), /^Nothing: no errors or warnings in any configuration\.$/m);
});

test('an app with no baseline gets no comparison table', () => {
  const md = node('report.mjs', results({ app: 'synthetic', configs: ['A', 'B', 'C'], ...failed('synthetic', ['A']) }));
  assert.match(md, /^No A runs in this pass, so no baseline to pair against and no A\/B\/C table\. See Failures\.$/m);
  assert.doesNotMatch(md, /\| metric \|/);
});

test('steps.mjs gives each configuration its own stats line', () => {
  const abc = node(
    'steps.mjs',
    results({
      app: 'synthetic',
      configs: ['A', 'B', 'C'],
      each: (r) => {
        if (r.config === 'C') r.lib.overheadTotalMs = 30;
      },
    }),
  );
  assert.match(abc, /^- sort-lastName-asc: A 190, B 190, C 190 \| B: 10x component Table render \[high\]$/m);
  assert.match(abc, /^  B stats \(median over 10 runs\): .*overheadTotalMs 1,/m);
  assert.match(abc, /^  C stats \(median over 10 runs\): .*overheadTotalMs 30,/m);
});
