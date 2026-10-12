// The Radix Sheet on the shadcn/ui docs site, on its own page, at a desktop size and at a phone
// size with touch. This is the open a flame chart of it showed as four whole-document style recalcs
// from four Radix pieces taking turns, and the one their issue #6879 names.
//
// Both entries serve the builds shadcn-v4 makes (.next-a, .next-b-new, .next-c), so they build
// nothing of their own: run them in the same `run.mjs` as shadcn-v4, or after it.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settle, waitForHttp, killTree } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V4 = path.join(HERE, 'clones', 'ui', 'apps', 'v4');
const NEXT_BIN = path.join(V4, 'node_modules', 'next', 'dist', 'bin', 'next');
const DISTS = { A: '.next-a', B: '.next-b-new', C: '.next-c' };

async function startNext(dist, port) {
  const child = spawn(process.execPath, [NEXT_BIN, 'start', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd: V4,
    env: { ...process.env, BENCH_OUTDIR: dist, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = [];
  child.stdout.on('data', (d) => output.push(String(d)));
  child.stderr.on('data', (d) => output.push(String(d)));
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);
  } catch (err) {
    killTree(child);
    throw new Error(`${err.message}\n${output.join('').slice(-2000)}`);
  }
  return { close: (done) => { killTree(child); setTimeout(done, 300); } };
}

const trigger = (page) => page.getByRole('button', { name: 'Open', exact: true }).first();
const sheet = (page) => page.getByRole('dialog', { name: 'Edit profile' });

function entry(id, { phone }) {
  const press = (loc) => (phone ? loc.tap() : loc.click());
  return {
    id,
    title: `shadcn-ui/ui docs, the Radix Sheet page, ${phone ? '390x844 phone, touch' : 'desktop'}`,
    dir: V4,
    repoDir: path.join(HERE, 'clones', 'ui'),
    dists: DISTS,
    assetsDir: 'static',
    ports: phone ? { A: 5330, B: 5331, C: 5332 } : { A: 5327, B: 5328, C: 5329 },
    path: '/docs/components/radix/sheet',
    // The phone check: an iPhone-sized screen at DPR 3 with touch, so the open is a tap.
    contextOptions: phone
      ? () => ({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
      : undefined,
    startServer: (config, port) => startNext(DISTS[config], port),
    install() {},
    prepare() {},
    build() {},
    async ready(page) {
      await trigger(page).waitFor({ timeout: 60000 });
      await trigger(page).scrollIntoViewIfNeeded();
      await settle(page, 1000, 60000);
    },
    steps: [
      {
        name: 'sheet-open',
        async before(page) {
          if (await sheet(page).count()) throw new Error('the sheet is already open');
          return {};
        },
        async run(page) {
          await press(trigger(page));
          await sheet(page).waitFor({ state: 'visible', timeout: 20000 });
          await page.waitForTimeout(800);
        },
        async assert(page) {
          if (!(await sheet(page).isVisible())) throw new Error('the sheet did not open');
          return {};
        },
      },
      {
        // Closing through its own button, the way a phone user would, and the way a desktop user
        // with a mouse would too.
        name: 'sheet-close',
        async run(page) {
          await press(sheet(page).getByRole('button', { name: 'Close' }).last());
          await sheet(page).waitFor({ state: 'detached', timeout: 20000 });
          await page.waitForTimeout(600);
        },
        async assert(page) {
          if (await sheet(page).count()) throw new Error('the sheet is still open');
          return {};
        },
      },
    ],
  };
}

export const apps = {
  'shadcn-sheet': entry('shadcn-sheet', { phone: false }),
  'shadcn-sheet-phone': entry('shadcn-sheet-phone', { phone: true }),
};
