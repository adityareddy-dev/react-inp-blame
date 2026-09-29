// bench.mjs: what react-inp-blame costs on real open-source React apps, and what it finds there.
//
//   node bench.mjs                      # every app, 15 runs per configuration, both throttle passes
//   node bench.mjs --runs 3             # smoke run
//   node bench.mjs --app tt-fuzzy       # one app
//   node bench.mjs --dry-run            # print what a run would cover, then exit without a browser
//
// Three configurations of the SAME production build per app:
//   A  baseline, library absent from the bundle
//   B  library installed, defaults
//   C  library installed, overlay: true
// They are interleaved (A, B, C, A, B, C, ...) so machine drift hits all three equally.
// Two passes: unthrottled first, then 4x CPU throttling through CDP.
//
// Results land in results/<timestamp>.json. report.mjs turns that into markdown.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apps } from './apps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// BENCH_ORDER reorders the interleaving (a check that a cost follows the build, not its slot).
const CONFIGS = (process.env.BENCH_ORDER ?? 'A,B,C').split(',');
const VIEWPORT = { width: 1280, height: 900 };

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const out = { runs: 15, app: null, throttles: [1, 4], out: null, headed: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') out.runs = Number(argv[++i]);
    else if (a === '--app') out.app = argv[++i];
    else if (a === '--throttle') out.throttles = argv[++i].split(',').map(Number);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--headed') out.headed = true;
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`unknown flag ${a}`);
  }
  if (!Number.isInteger(out.runs) || out.runs < 1) throw new Error('--runs must be a positive integer');
  return out;
}

// ---------------------------------------------------------------- static server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Minimal static server. Cheaper and quieter than `vite preview`, which keeps a watcher alive. */
function serve(root, port) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = path.join(root, url === '/' ? 'index.html' : url);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------- in-page collector
//
// Runs before any of the app's own scripts, so it observes every interaction from the first one.
// Identical in A, B and C, so whatever it costs is common to all three.

const COLLECTOR = () => {
  const w = window;
  w.__bench = { events: [], loaf: [], firstInput: null, errors: [] };
  w.__benchLoadedAt = performance.now();
  w.__benchLastLongTask = 0;

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        w.__bench.events.push({
          name: e.name,
          entryType: e.entryType,
          startTime: e.startTime,
          duration: e.duration,
          processingStart: e.processingStart,
          processingEnd: e.processingEnd,
          interactionId: e.interactionId ?? 0,
        });
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  } catch (err) {
    w.__bench.errors.push('event observer: ' + err.message);
  }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        w.__bench.firstInput = {
          name: e.name,
          startTime: e.startTime,
          duration: e.duration,
          processingStart: e.processingStart,
          interactionId: e.interactionId ?? 0,
        };
      }
    }).observe({ type: 'first-input', buffered: true });
  } catch (err) {
    w.__bench.errors.push('first-input observer: ' + err.message);
  }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        w.__bench.loaf.push({
          startTime: e.startTime,
          duration: e.duration,
          blockingDuration: e.blockingDuration,
          renderStart: e.renderStart,
          styleAndLayoutStart: e.styleAndLayoutStart,
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch (err) {
    w.__bench.errors.push('loaf observer: ' + err.message);
  }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__benchLastLongTask = e.startTime + e.duration;
    }).observe({ type: 'longtask', buffered: true });
  } catch (err) {
    /* longtask is not essential; settle() falls back to load time */
  }
};

// Pulled out of the page at the end of a run. Computes INP the standard way, independently of
// anything the library does, so B and C are not scored by the thing under test.
const HARVEST = () => {
  const b = window.__bench;

  // One latency per interactionId: the longest Event Timing entry in that group, which is how
  // web-vitals measures it. Entries with interactionId 0 are not interactions for INP.
  const byId = new Map();
  for (const e of b.events) {
    if (!e.interactionId) continue;
    const prev = byId.get(e.interactionId);
    if (prev === undefined || e.duration > prev.duration) byId.set(e.interactionId, e);
  }
  const groups = [...byId.entries()].map(([id, e]) => ({
    interactionId: id,
    name: e.name,
    startTime: e.startTime,
    duration: e.duration,
  }));
  const sorted = [...groups].sort((x, y) => y.duration - x.duration);

  // INP: the worst interaction, or, past 50 interactions, the one at index floor(count / 50)
  // among the 10 longest. performance.interactionCount counts every interaction, including the
  // ones below our 16 ms threshold.
  const count = performance.interactionCount ?? groups.length;
  const kept = sorted.slice(0, 10);
  const inp = kept.length ? kept[Math.min(Math.floor(count / 50), kept.length - 1)] : null;

  const heap = performance.memory
    ? {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
      }
    : null;

  // What the library says about itself and about this page. Absent in A.
  let lib = null;
  const api = window.__REACT_INP_BLAME__;
  if (api) {
    const slim = (r) => ({
      interactionId: r.interactionId,
      type: r.type,
      duration: r.duration,
      holdMs: r.holdMs,
      inputDelay: r.inputDelay,
      processing: r.processing,
      walkMs: r.walkMs,
      presentation: r.presentation,
      overheadMs: r.overheadMs,
      revision: r.revision,
      target: r.target
        ? {
            selector: r.target.selector,
            label: r.target.label,
            component: r.target.component,
            handler: r.target.handler,
            owners: r.target.owners,
          }
        : null,
      start: r.start,
      end: r.end,
      reactStatus: r.reactStatus ?? null,
      pointerType: r.pointerType ?? null,
      kind: r.explanation?.blame?.kind ?? null,
      navigationURL: r.navigationURL ?? null,
      navigationType: r.navigationType ?? null,
      startedNavigation: r.startedNavigation ?? null,
      unjoinedCommits: r.unjoinedCommits ?? null,
      rendered: Array.isArray(r.commits) ? r.commits.reduce((n, c) => n + (c.rendered || 0), 0) : null,
      hotPath: Array.isArray(r.commits) && r.commits.length ? r.commits[r.commits.length - 1].hotPath : null,
      phases: r.explanation?.phases ?? null,
      commits: Array.isArray(r.commits) ? r.commits.length : null,
      followUps: Array.isArray(r.followUps) ? r.followUps.length : null,
      frames: r.frames === null ? null : r.frames.length,
      blame: r.explanation?.blame ?? null,
      rating: r.explanation?.rating ?? null,
      headline: r.explanation?.headline ?? null,
      where: r.explanation?.where ?? null,
      cause: r.explanation?.cause ?? null,
      notes: r.explanation?.notes ?? null,
      verdict: r.verdict ?? null,
    });
    try {
      const reports = api.reports().map(slim);
      const est = api.inp();
      lib = {
        stats: api.stats(),
        reportCount: reports.length,
        reports,
        overheadTotalMs: reports.reduce((s, r) => s + (r.overheadMs || 0), 0),
        inp: est
          ? {
              value: est.value,
              rating: est.rating,
              interactionId: est.interactionId,
              interactionCount: est.interactionCount,
            }
          : null,
      };
    } catch (err) {
      lib = { error: String(err && err.message) };
    }
  }

  return {
    interactionCount: count,
    interactions: groups.sort((x, y) => x.startTime - y.startTime),
    totalInteractionMs: groups.reduce((s, g) => s + g.duration, 0),
    inp: inp ? inp.duration : null,
    inpInteraction: inp,
    eventEntryCount: b.events.length,
    firstInput: b.firstInput,
    loafCount: b.loaf.length,
    loafBlockingMs: b.loaf.reduce((s, f) => s + (f.blockingDuration || 0), 0),
    loafTotalMs: b.loaf.reduce((s, f) => s + (f.duration || 0), 0),
    heap,
    collectorErrors: b.errors,
    overlayPresent: !!document.getElementById('react-inp-blame'),
    lib,
  };
};

// ---------------------------------------------------------------- one run

async function runOnce({ browser, app, config, url, throttle, runIndex, warmup }) {
  // An app can add to the context: a signed-in app brings its storage state (per configuration,
  // since each build is its own origin), a phone app its viewport and touch.
  const extra = app.contextOptions ? await app.contextOptions(config) : {};
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    bypassCSP: false,
    ...extra,
  });
  const console_ = [];
  const pageErrors = [];
  try {
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') {
        console_.push({ type: m.type(), text: m.text().slice(0, 600) });
      }
    });
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message).slice(0, 600)));

    await page.addInitScript(COLLECTOR);

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });

    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await app.ready(page);
    const readyMs = Date.now() - t0;

    // Configuration C is only meaningful if the badge is actually on the page. Its code arrives by
    // dynamic import after install() returns, so wait for the host element rather than assuming it.
    if (config === 'C') {
      await page.waitForSelector('#react-inp-blame', { state: 'attached', timeout: 20000 });
    }

    const stepResults = [];
    const pageNow = () => page.evaluate(() => performance.now());
    for (const step of app.steps) {
      const before = step.before ? await step.before(page) : {};
      // The page's own clock on either side of the step, so a report can be tied back to the
      // step that caused it: Event Timing start times are on this clock too.
      const pageStart = await pageNow();
      const s0 = Date.now();
      await step.run(page);
      const wallMs = Date.now() - s0;
      const pageEnd = await pageNow();
      // Loud on purpose: a step that did not change the DOM is not an interaction, and counting
      // it as a fast one would quietly bias every number downwards.
      await step.assert(page, before);
      stepResults.push({ name: step.name, wallMs, pageStart, pageEnd });
    }

    const data = await page.evaluate(HARVEST);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    if (config !== 'A' && !data.lib) {
      throw new Error(`configuration ${config} has no window.__REACT_INP_BLAME__: the library did not install`);
    }
    if (config === 'A' && data.lib) {
      throw new Error('configuration A has the library on the page; the baseline build is wrong');
    }

    return {
      app: app.id,
      config,
      throttle,
      runIndex,
      warmup,
      readyMs,
      steps: stepResults,
      console: console_,
      pageErrors,
      ...data,
    };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- versions

function tryExec(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * verify-lib.mjs over the run's own apps, as JSON. It exits 1 when an app's copy differs from the
 * release, and that JSON is what says which, so it is kept rather than dropped to null.
 */
function libCheck(appIds) {
  try {
    return execSync(`node verify-lib.mjs --json --app ${appIds.join(',')}`, { cwd: HERE, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (error) {
    return error.stdout?.toString().trim() || null;
  }
}

/** Every .js file under `root`, recursively: its total size and the per-file sizes. */
function jsBytes(root) {
  const files = {};
  let totalJsBytes = 0;
  const walk = (dir, prefix) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
        continue;
      }
      const size = fs.statSync(path.join(dir, entry.name)).size;
      files[rel] = size;
      if (entry.name.endsWith('.js')) totalJsBytes += size;
    }
  };
  walk(root, '');
  return { totalJsBytes, files };
}

// A workspace app (excalidraw-app) has its packages hoisted to the repo root, so look up the tree.
function pkgVersion(dir, name) {
  for (let d = dir; ; d = path.dirname(d)) {
    try {
      return JSON.parse(fs.readFileSync(path.join(d, 'node_modules', name, 'package.json'), 'utf8')).version;
    } catch {
      if (d === HERE || path.dirname(d) === d) return null;
    }
  }
}

async function collectVersions(browser, appIds) {
  const tarball = process.env.BENCH_TARBALL ? path.join(HERE, process.env.BENCH_TARBALL) : null;
  const npmLib = process.env.BENCH_NPM_LIB ?? 'react-inp-blame@0.12.0';
  const per = {};
  for (const id of appIds) {
    const dir = apps[id].dir;
    per[id] = {
      commit: tryExec('git rev-parse HEAD', apps[id].repoDir ?? path.join(HERE, 'clones', 'tt')),
      react: pkgVersion(dir, 'react'),
      'react-dom': pkgVersion(dir, 'react-dom'),
      vite: pkgVersion(dir, 'vite'),
      next: pkgVersion(dir, 'next'),
      '@tanstack/react-table': pkgVersion(dir, '@tanstack/react-table'),
      'react-inp-blame': pkgVersion(dir, 'react-inp-blame'),
      bundleBytes: Object.fromEntries(
        Object.entries(apps[id].dists).map(([c, d]) => [
          c,
          // Vite writes one flat `assets/`; Next writes a tree under `static/`. Walking the
          // whole build directory covers both and needs no per-app rule.
          jsBytes(path.join(dir, d, apps[id].assetsDir ?? 'assets')),
        ]),
      ),
    };
  }
  return {
    node: process.version,
    playwright: JSON.parse(fs.readFileSync(path.join(HERE, 'node_modules', 'playwright-core', 'package.json'), 'utf8')).version,
    chromium: browser.version(),
    chromiumPath: chromium.executablePath(),
    os: `${process.platform} ${process.arch}`,
    tarball: tarball
      ? {
          path: tarball,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'),
          bytes: fs.statSync(tarball).size,
        }
      : null,
    npm: tryExec(`npm view ${npmLib} version dist.integrity dist.shasum --json`, HERE),
    libCheck: libCheck(appIds),
    apps: per,
  };
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appIds = args.app ? args.app.split(',') : Object.keys(apps);
  for (const id of appIds) if (!apps[id]) throw new Error(`no such app: ${id}`);
  if (args.dryRun) {
    console.log(JSON.stringify({ runs: args.runs, throttles: args.throttles, apps: appIds, configs: CONFIGS }));
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--force-device-scale-factor=1',
      '--js-flags=--expose-gc',
    ],
  });

  const versions = await collectVersions(browser, appIds);
  const started = new Date().toISOString();
  const runs = [];
  const failures = [];

  try {
    for (const id of appIds) {
      const app = apps[id];
      // One server per configuration, so a run never pays for a server restart.
      const servers = [];
      for (const c of CONFIGS) {
        // An app that brings its own server (a Next.js app has to run `next start`) starts it
        // here; everything else is a directory of static files.
        if (app.startServer) {
          servers.push(await app.startServer(c, app.ports[c]));
          continue;
        }
        const root = path.join(app.dir, app.dists[c]);
        if (!fs.existsSync(path.join(root, 'index.html'))) {
          throw new Error(`missing build ${root}: run the build step for ${id} first`);
        }
        servers.push(await serve(root, app.ports[c]));
      }
      const urlFor = (c) => `http://127.0.0.1:${app.ports[c]}${app.path ?? '/'}`;

      try {
        for (const throttle of args.throttles) {
          // Warm up once per cell and throw it away: first paint, first compile, cold caches.
          for (const c of CONFIGS) {
            process.stdout.write(`  warmup ${id} ${c} x${throttle}\n`);
            try {
              await runOnce({ browser, app, config: c, url: urlFor(c), throttle, runIndex: -1, warmup: true });
            } catch (err) {
              // Recorded, not fatal: one app that cannot warm up must not cost the other apps
              // their whole pass.
              process.stdout.write(`  warmup FAILED: ${err.message}\n`);
              failures.push({ app: id, config: c, throttle, runIndex: -1, warmup: true, error: String(err && err.message) });
            }
          }
          for (let i = 0; i < args.runs; i++) {
            for (const c of CONFIGS) {
              process.stdout.write(`  ${id} ${c} x${throttle} run ${i + 1}/${args.runs} ... `);
              try {
                const r = await runOnce({ browser, app, config: c, url: urlFor(c), throttle, runIndex: i, warmup: false });
                runs.push(r);
                process.stdout.write(
                  `INP ${r.inp === null ? 'n/a' : r.inp.toFixed(0)}ms  total ${r.totalInteractionMs.toFixed(0)}ms  loaf ${r.loafCount}\n`,
                );
              } catch (err) {
                process.stdout.write(`FAILED: ${err.message}\n`);
                failures.push({ app: id, config: c, throttle, runIndex: i, error: String(err && err.message) });
              }
            }
          }
        }
      } finally {
        for (const s of servers) await new Promise((r) => s.close(r));
      }
    }
  } finally {
    await browser.close();
  }

  const outDir = path.join(HERE, 'results');
  await fsp.mkdir(outDir, { recursive: true });
  const outFile = args.out ?? path.join(outDir, `${started.replace(/[:.]/g, '-')}.json`);
  await fsp.writeFile(
    outFile,
    JSON.stringify(
      {
        started,
        finished: new Date().toISOString(),
        args,
        versions,
        caveat:
          'Numbers are only as quiet as the machine that produced them. Record what else was running.',
        runs,
        failures,
      },
      null,
      2,
    ),
  );
  console.log(`\n${runs.length} runs, ${failures.length} failures -> ${outFile}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
