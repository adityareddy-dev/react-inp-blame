// smoke.mjs: runs one app's adapter once per configuration and reports each step's assertion. It does
// not score anything and does not need the app to be `ready`, so it is for checking an integration
// before the cases are frozen, or after. Timing is not measured here; bench.mjs does that.
//
//   node smoke.mjs --app <id> [--config A,B,C]
//
// BENCH_CHROMIUM names the browser binary, as bench.mjs does.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allApps } from './apps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const appId = argv.includes('--app') ? argv[argv.indexOf('--app') + 1] : null;
const configs = argv.includes('--config') ? argv[argv.indexOf('--config') + 1].split(',') : ['A', 'B', 'C'];
const app = allApps[appId];
if (!app) throw new Error(`no such app: ${appId ?? '(none)'}`);
if (!app.steps) throw new Error(`${appId} has no adapter yet: write bench/adapters/${appId}.mjs first`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

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
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BENCH_CHROMIUM || undefined,
  args: ['--force-device-scale-factor=1'],
});

let failed = 0;
try {
  for (const config of configs) {
    console.log(`\n== ${appId} configuration ${config}`);
    const port = app.ports[config];
    const server = app.startServer
      ? await app.startServer(config, port)
      : await serve(path.join(app.dir, app.dists[config]), port);
    try {
      if (app.beforeRun) await app.beforeRun(config);
      const extra = app.contextOptions ? await app.contextOptions(config) : {};
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', ...extra });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e && e.message).slice(0, 300)));
      try {
        await page.goto(`http://127.0.0.1:${port}${app.path ?? '/'}`, { waitUntil: 'load', timeout: 120000 });
        await app.ready(page);
        console.log('  ready: ok');
        const library = await page.evaluate(() => !!window.__REACT_INP_BLAME__);
        console.log(`  library on page: ${library}`);
        for (const step of app.steps) {
          try {
            const before = step.before ? await step.before(page) : {};
            await step.run(page);
            await step.assert(page, before);
            console.log(`  PASS ${step.name}`);
          } catch (err) {
            failed++;
            console.log(`  FAIL ${step.name}: ${String(err && err.message).split('\n')[0].slice(0, 300)}`);
          }
        }
        console.log(`  page errors: ${pageErrors.length}${pageErrors.length ? ' ' + JSON.stringify(pageErrors.slice(0, 3)) : ''}`);
      } catch (err) {
        failed++;
        console.log(`  NOT READY: ${String(err && err.message).split('\n')[0].slice(0, 300)}`);
      } finally {
        await context.close();
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${failed} failing assertion(s) or readiness failure(s)`);
if (failed) process.exitCode = 1;
