// capture.mjs: accuracy evidence for one app, one case at a time. Each case gets its own fresh run from
// the app's reset, runs only its own step, and is written to results/accuracy/<app>/<case>.json. Runs
// are sequential, never parallel. Configuration B is the production build with the library enabled and
// no overlay; the overlay does not change what the report says.
//
//   node capture.mjs --app <id> [--cases C01,C02] [--out <dir>]
//
// Nothing here grades. Each file holds what the harness saw independently (Event Timing, long animation
// frames, long tasks, the page's own clock) and the library's latest report per interactionId, with
// matching and the millisecond error. The React profile is not captured and says so.

import { chromium } from 'playwright';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allApps as apps } from './apps.mjs';
import { runOnce, serve } from './bench.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const appId = flag('--app', null);
const config = 'B';
const only = flag('--cases', null);
const outRoot = flag('--out', path.join(HERE, 'results', 'accuracy'));

const app = apps[appId];
if (!app) throw new Error(`no such app: ${appId ?? '(none)'}`);
if (!app.steps) throw new Error(`${appId} has no adapter yet`);
const cases = JSON.parse(fs.readFileSync(path.join(HERE, 'adapters', `${appId}.cases.json`), 'utf8'));
const wanted = only ? new Set(only.split(',')) : null;

// A step's window is the page's own clock on either side of it, as steps.mjs reads it.
const within = (t, s) => t >= s.pageStart && t <= s.pageEnd;
// Protocol: tolerance is the larger of 10 ms and 20% of the trace value.
const tolerance = (trace) => Math.max(10, 0.2 * trace);

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BENCH_CHROMIUM || undefined,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--force-device-scale-factor=1'],
});
const port = app.ports[config];
const server = app.startServer
  ? await app.startServer(config, port)
  : await serve(path.join(app.dir, app.dists[config]), port);
const url = `http://127.0.0.1:${port}${app.path ?? '/'}`;
const dir = path.join(outRoot, appId);
await fsp.mkdir(dir, { recursive: true });

const summary = [];
try {
  for (const c of cases) {
    if (wanted && !wanted.has(c.id)) continue;
    const captured = new Date().toISOString();
    let run = null;
    let error = null;
    try {
      run = await runOnce({ browser, app, config, url, throttle: 1, runIndex: -2, warmup: false, caseId: c.id });
    } catch (err) {
      error = String((err && err.message) || err).slice(0, 1000);
    }

    let evidence;
    if (!run) {
      // A setup failure or a failed assertion is kept with its cause, never dropped from the denominator.
      evidence = { status: 'setup-failure', error };
    } else {
      const step = run.steps[0];
      const interactions = run.interactions.filter((i) => within(i.startTime, step));
      const reports = (run.lib?.reports ?? []).filter((p) => within(p.start, step));
      // The latest report per interactionId is the one graded; earlier ones are kept.
      const latest = new Map();
      for (const p of reports) {
        const prev = latest.get(p.interactionId);
        if (!prev || p.end > prev.end) latest.set(p.interactionId, p);
      }
      const matched = [];
      const unmatchedReports = [];
      for (const p of reports) {
        const trace = interactions.find((i) => i.interactionId === p.interactionId);
        const isLatest = latest.get(p.interactionId) === p;
        if (!trace) {
          unmatchedReports.push({ interactionId: p.interactionId, duration: p.duration, latest: isLatest });
          continue;
        }
        if (!isLatest) continue;
        const signedErrorMs = p.duration - trace.duration;
        matched.push({
          interactionId: p.interactionId,
          traceDurationMs: trace.duration,
          reportDurationMs: p.duration,
          signedErrorMs: Math.round(signedErrorMs * 10) / 10,
          toleranceMs: tolerance(trace.duration),
          withinTolerance: Math.abs(signedErrorMs) <= tolerance(trace.duration),
        });
      }
      const reportedIds = new Set(reports.map((p) => p.interactionId));
      const interactionsWithoutReport = interactions.filter((i) => !reportedIds.has(i.interactionId));
      evidence = {
        status: 'captured',
        error,
        // Blank: a valid observed interaction with no usable output. Recorded, not dropped.
        blankOutput: interactions.length > 0 && reports.length === 0,
        matchingStatus: interactions.length === 0 ? 'no-interaction-observed' : unmatchedReports.length || interactionsWithoutReport.length ? 'partial' : 'matched',
        matched,
        unmatchedReports,
        interactionsWithoutReport: interactionsWithoutReport.map((i) => i.interactionId),
        independent: {
          interactionsInWindow: interactions,
          loafInWindow: run.loafEntries.filter((f) => within(f.startTime, step)),
          longTasksInWindow: run.longTaskEntries.filter((t) => within(t.startTime, step)),
          inpAcrossRun: run.inp,
        },
        libraryReports: reports.map((p) => ({ ...p, latest: latest.get(p.interactionId) === p })),
        reactProfile: { captured: false, reason: 'React profiling build not yet wired into the capture' },
        step: { name: step.name, wallMs: step.wallMs, pageStart: step.pageStart, pageEnd: step.pageEnd },
        pageErrors: run.pageErrors,
        console: run.console,
        delivered: run.delivered,
      };
    }

    const file = { schema: 'accuracy-evidence/1', app: appId, config, caseId: c.id, case: c, throttle: 1, captured, ...evidence };
    await fsp.writeFile(path.join(dir, `${c.id}.json`), JSON.stringify(file, null, 2));
    summary.push({ caseId: c.id, status: file.status, matchingStatus: file.matchingStatus ?? null, error: file.error || null });
    console.log(`${c.id} ${file.status}${file.matchingStatus ? ' ' + file.matchingStatus : ''}${file.error ? ' ' + file.error.split('\n')[0].slice(0, 160) : ''}`);
  }
} finally {
  await new Promise((r) => server.close(r));
  await browser.close();
}
await fsp.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ app: appId, config, generated: new Date().toISOString(), cases: summary }, null, 2));
console.log(`\n${summary.length} case(s) -> ${dir}`);
