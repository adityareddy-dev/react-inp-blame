import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { runOnce, drainObservers } from './bench.mjs';
import { serveActual } from './adapters/actual-server.mjs';

test('final scenario and isolated capture retain the last trusted event and published report', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-drain-'));
  fs.cpSync(new URL('./npm-lib/1.0.0/package/dist/', import.meta.url), path.join(root, 'library'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html><button id="setup">setup</button><button id="click">pending</button>
    <script type="module">
      if (location.search.includes('library')) {
        const {install} = await import('/library/index.js');
        install({debugGlobal:true, overlay:false});
      }
      document.querySelector('#setup').onclick = () => {
        const start = performance.now(); while(performance.now() - start < 90) {}
      };
      document.querySelector('#click').onclick = () => {
        const start = performance.now(); while(performance.now() - start < 90) {}
        document.querySelector('#click').textContent = 'changed';
      };
      window.ready = true;
    </script>`);
  const server = await serveActual(root, 0);
  const browser = await chromium.launch({ executablePath: process.env.BENCH_CHROMIUM || undefined });
  try {
    const step = {
      name: 'C02 final scenario',
      before: (page) => page.locator('#setup').click(),
      run: (page) => page.locator('#click').click(),
      assert: async (page) => assert.equal(await page.locator('#click').textContent(), 'changed'),
    };
    const app = { id: 'drain-test', ready: (page) => page.waitForFunction(() => window.ready), steps: [
      { name: 'C01 setup control', run: async () => {}, assert: async () => {} }, step,
    ] };
    const observations = [];
    for (const config of ['A', 'B']) {
      for (let i = 0; i < 6; i++) {
        const isolated = i % 2 === 1;
        const run = await runOnce({ browser, app, config, throttle: 1, runIndex: i, warmup: false,
          caseId: isolated ? 'C02' : null,
          url: `http://127.0.0.1:${server.address().port}/${config === 'B' ? '?library' : ''}` });
        const last = run.steps.at(-1);
        const events = run.interactions.filter((e) => e.startTime >= last.pageStart && e.startTime <= last.pageEnd);
        observations.push({ config, isolated, events: events.length, duration: events[0]?.duration, wallMs: last.wallMs, drain: run.drain });
        assert.equal(events.length, 1, JSON.stringify(observations));
        assert.ok(events[0].duration >= 80 && events[0].duration < 250, JSON.stringify(observations));
        assert.ok(run.drain.startedAt >= last.pageEnd);
        assert.ok(run.drain.waitedMs >= 250);
        assert.equal(run.scenarioInteractions.length, 1);
        assert.equal(run.setupInteractions.length, 1);
        if (config === 'B') assert.ok(run.lib.reports.some((r) => r.interactionId === events[0].interactionId), JSON.stringify(observations));
      }
    }
    const out = new URL('./results/pilot/drain-regression.json', import.meta.url);
    fs.mkdirSync(new URL('./results/pilot/', import.meta.url), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ browser: browser.version(), observations }, null, 2));
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
    await assert.rejects(drainObservers(page), /did not settle within 2000ms/);
    await context.close();
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
