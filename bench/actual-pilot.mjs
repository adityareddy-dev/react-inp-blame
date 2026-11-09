// Functional validation. Results are diagnostics, not protocol overhead or accuracy grades.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { allApps } from './apps.mjs';
import { runOnce } from './bench.mjs';
import { verifySource } from './adapters/actual-build.mjs';

const app = allApps.actual;
const outIndex = process.argv.indexOf('--out');
const out = outIndex < 0 ? `results/pilot/actual-${Date.now()}.json` : process.argv[outIndex + 1];
verifySource();
const receipt = { started: new Date().toISOString(), purpose: 'functional pilot, no accuracy or protocol overhead claim',
  node: process.version, npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
  source: app.source, library: JSON.parse(execFileSync(process.execPath, ['verify-lib.mjs', '--json', '--app', 'actual'], { encoding: 'utf8' })),
  builds: {}, runs: [], failures: [], negativeControls: [] };
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
for (const [config, dist] of Object.entries(app.dists)) {
  const root = path.join(app.dir, dist);
  const files = fs.readdirSync(root, { recursive: true }).filter((f) => fs.statSync(path.join(root, f)).isFile()).sort();
  const hashes = Object.fromEntries(files.map((file) => [file, hash(fs.readFileSync(path.join(root, file)))]));
  const js = files.filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  assert.equal(js.includes('__REACT_INP_BLAME__'), config !== 'A', `${config} contains wrong library bytes`);
  const reactSources = files.filter((f) => f.endsWith('.js.map')).flatMap((f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')).sources)
    .filter((f) => /react-dom[\\/]cjs[\\/]react-dom-client\./.test(f));
  assert.ok(reactSources.some((f) => f.includes('.production.')), `${config} lacks production React evidence`);
  assert.ok(!reactSources.some((f) => f.includes('.development.')), `${config} contains development React`);
  receipt.builds[config] = { sha256: hash(JSON.stringify(hashes)), files: hashes, reactSources };
}
const browserPath = process.env.BENCH_CHROMIUM || chromium.executablePath();
const browser = await chromium.launch({ executablePath: browserPath });
receipt.browser = { version: browser.version(), executable: browserPath };
let fixtureHash;
try {
  for (const config of ['A', 'B', 'C']) {
    const server = await app.startServer(config, app.ports[config]);
    const url = `http://127.0.0.1:${app.ports[config]}/`;
    try {
      for (const caseId of [null, ...app.steps.map((s) => s.name.split(' ')[0])]) {
        let run;
        try {
          run = await runOnce({ browser, app, config, url, throttle: 1, runIndex: -3, warmup: false, caseId });
          assert.deepEqual(run.pageErrors, [], 'Page errors make the pilot invalid');
          assert.deepEqual(run.collectorErrors, [], 'Independent observer failed');
          assert.equal(run.overlayPresent, config === 'C');
          assert.equal(!!run.lib, config !== 'A');
          if (run.lib) assert.ok(!run.lib.error, run.lib.error);
          fixtureHash ??= run.readiness.fixtureSha256;
          assert.equal(run.readiness.fixtureSha256, fixtureHash, 'Reset changed the budget fixture');
          const served = {};
          for (const request of run.delivered) {
            const resource = new URL(request.url);
            assert.equal(resource.origin, new URL(url).origin, 'Non-local script requested');
            if (resource.protocol === 'blob:') {
              served[request.url] = { inMemoryWorker: true, wireBytes: request.bytes };
              continue;
            }
            assert.equal(resource.protocol, 'http:');
            const file = decodeURIComponent(resource.pathname).slice(1);
            const bytes = Buffer.from(await (await fetch(request.url)).arrayBuffer());
            assert.equal(hash(bytes), receipt.builds[config].files[file], `Served bytes differ: ${file}`);
            served[file] = { sha256: hash(bytes), wireBytes: request.bytes };
          }
          receipt.runs.push({ caseId, served, ...run });
          console.log(`PASS ${config} ${caseId ?? 'all 20 sequential'} reset=${fixtureHash.slice(0, 12)}`);
        } catch (error) {
          receipt.failures.push({ config, caseId, error: error.stack, cause: String(error.cause ?? ''), run });
          console.log(`FAIL ${config} ${caseId ?? 'sequential'}: ${error.message.split('\n')[0]}`);
        }
      }
      if (config === 'A') {
        for (const caseId of ['C12', 'C18']) {
          const context = await browser.newContext(app.contextOptions(config));
          try {
            const page = await context.newPage();
            await page.goto(url);
            await app.ready(page);
            const step = app.steps.find((s) => s.name.startsWith(caseId));
            const before = await step.before(page);
            if (caseId === 'C18') {
              // An optimistic DOM change without a stored change must still fail.
              await page.getByTestId('transaction-table').getByTestId('row').first().getByTestId('cleared')
                .evaluate((el) => { el.innerHTML += '<span>optimistic-only</span>'; });
            }
            let rejected = false;
            try { await step.assert(page, before); } catch (error) {
              rejected = true;
              receipt.negativeControls.push({ caseId, rejected: true, error: error.message });
            }
            assert.ok(rejected, `${caseId} passed without its intended state change`);
            console.log(`PASS negative control ${caseId}`);
          } catch (error) {
            receipt.failures.push({ config, caseId: `${caseId} negative control`, error: error.stack });
          } finally { await context.close(); }
        }
      }
    } finally { await new Promise((resolve) => server.close(resolve)); }
  }
} finally {
  await browser.close();
  receipt.finished = new Date().toISOString();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(receipt, null, 2));
}
console.log(`${receipt.runs.length} passed runs, ${receipt.failures.length} failures -> ${out}`);
if (receipt.failures.length) process.exitCode = 1;
