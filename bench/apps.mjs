// App definitions for the benchmark.
//
// Each app declares where its three builds live, which ports they are served on, and a scripted
// interaction sequence. Every step must assert that the DOM actually changed: a step whose assert
// fails aborts the run loudly rather than quietly contributing a fast "interaction" that never
// happened.
//
// Ports are confined to 5310-5334.
//
// A static app declares `dists` and is served out of a directory. An app that needs its own
// server (a Next.js app, which has to run `next start`) declares `startServer(config, port)`
// instead and returns a handle bench.mjs can close.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { settle, pollFor, waitForHttp, killTree } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = (...p) => path.join(HERE, 'a', ...p);



/** Text of the "N Rows" line in the fuzzy example. */
const fzRowCount = (page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((d) =>
      /^[\d,]+ Rows$/.test(d.textContent?.trim() ?? ''),
    );
    return el ? el.textContent.trim() : null;
  });

export const apps = {
  'tt-fuzzy': {
    id: 'tt-fuzzy',
    title: 'TanStack Table, examples/react/filters-fuzzy',
    dir: A('fz'),
    dists: { A: 'dist-a', B: 'dist-b', C: 'dist-c' },
    ports: { A: 5310, B: 5311, C: 5312 },
    // The heavy work is the 500 ms-debounced global filter over 5,000 rows, which lands after the
    // keystroke has painted. That is deliberately the interesting case: the library claims to join
    // follow-up renders within 1.5 s back to the interaction that caused them.
    async ready(page) {
      await page.waitForSelector('table tbody tr', { timeout: 30000 });
      await page.waitForFunction(
        () => document.querySelectorAll('table tbody tr').length >= 10,
        null,
        { timeout: 30000 },
      );
      await settle(page);
    },
    steps: [
      {
        name: 'type-filter-6-keys',
        async run(page) {
          const input = page.locator('input[placeholder="Search all columns..."]');
          await input.click();
          // One key at a time, 120 ms apart: a fast typist, so the 500 ms debounce fires once,
          // after the last keystroke has already painted.
          await page.keyboard.type('Jonath', { delay: 120 });
          // Let the debounce fire and the filter render land.
          await page.waitForTimeout(1400);
        },
        async assert(page, before) {
          const val = await page
            .locator('input[placeholder="Search all columns..."]')
            .inputValue();
          if (val !== 'Jonath') throw new Error(`filter input is ${JSON.stringify(val)}, expected "Jonath"`);
          const after = await fzRowCount(page);
          if (after === before.rows) {
            throw new Error(`row count did not change from ${before.rows}; the filter never ran`);
          }
          return { rows: after };
        },
        async before(page) {
          return { rows: await fzRowCount(page) };
        },
      },
      {
        name: 'clear-filter',
        async before(page) {
          return { rows: await fzRowCount(page) };
        },
        async run(page) {
          const input = page.locator('input[placeholder="Search all columns..."]');
          await input.click();
          await page.keyboard.press('Control+a');
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(1400);
        },
        async assert(page, before) {
          const val = await page
            .locator('input[placeholder="Search all columns..."]')
            .inputValue();
          if (val !== '') throw new Error(`filter input is ${JSON.stringify(val)}, expected empty`);
          const after = await fzRowCount(page);
          if (after === before.rows) {
            throw new Error(`row count did not return from ${before.rows}; the clear never ran`);
          }
          return { rows: after };
        },
      },
      {
        name: 'sort-fullName',
        async before(page) {
          return {
            first: await page.locator('table tbody tr').first().innerText(),
          };
        },
        async run(page) {
          await page.locator('thead .sortable-header').nth(3).click();
          await page.waitForTimeout(900);
        },
        async assert(page, before) {
          const after = await page.locator('table tbody tr').first().innerText();
          const marked = await page.locator('thead .sortable-header').nth(3).innerText();
          if (!/🔼|🔽/.test(marked)) {
            throw new Error(`sort indicator missing from header: ${JSON.stringify(marked)}`);
          }
          if (after === before.first) {
            throw new Error('first row is unchanged after sorting; the sort never ran');
          }
          return {};
        },
      },
      {
        // This example paginates 10 rows, so at a 1280x900 viewport the document does not scroll
        // at all. Growing the page to 50 rows is itself a real interaction and it makes the
        // following scroll step meaningful instead of a silent no-op.
        name: 'page-size-50',
        async before(page) {
          return { rows: await page.locator('table tbody tr').count() };
        },
        async run(page) {
          await page.locator('.controls select').selectOption('50');
          await page.waitForTimeout(900);
        },
        async assert(page, before) {
          const after = await page.locator('table tbody tr').count();
          if (after <= before.rows) {
            throw new Error(`row count ${before.rows} -> ${after}; the page size change never ran`);
          }
          return {};
        },
      },
      {
        name: 'scroll-page',
        async before(page) {
          const h = await page.evaluate(() => document.documentElement.scrollHeight);
          if (h <= 900) throw new Error(`document is only ${h}px tall; nothing to scroll`);
          return { y: await page.evaluate(() => window.scrollY) };
        },
        async run(page) {
          for (let i = 0; i < 8; i++) {
            await page.mouse.wheel(0, 400);
            await page.waitForTimeout(80);
          }
          await page.waitForTimeout(600);
        },
        async assert(page, before) {
          const y = await page.evaluate(() => window.scrollY);
          if (y <= before.y) throw new Error(`page did not scroll (scrollY ${before.y} -> ${y})`);
          return {};
        },
      },
    ],
  },

  'tt-virtual': {
    id: 'tt-virtual',
    title: 'TanStack Table, examples/react/virtualized-rows',
    dir: A('vr'),
    dists: { A: 'dist-a', B: 'dist-b', C: 'dist-c' },
    ports: { A: 5313, B: 5314, C: 5315 },
    // This example has no filter input, so the sequence is adapted: two sorts over 200,000 rows
    // (the heavy interaction here), a scroll of the virtualised container, and one row checkbox.
    async ready(page) {
      await page.waitForSelector('table tbody tr', { timeout: 60000 });
      await page.waitForFunction(
        () => document.querySelectorAll('table tbody tr').length > 5,
        null,
        { timeout: 60000 },
      );
      await settle(page, 400, 60000);
    },
    steps: [
      {
        name: 'sort-lastName-asc',
        async before(page) {
          return { first: await page.locator('table tbody tr').first().innerText() };
        },
        async run(page) {
          await page.locator('thead .sortable-header').nth(3).click();
          await page.waitForTimeout(1500);
        },
        async assert(page, before) {
          const marked = await page.locator('thead .sortable-header').nth(3).innerText();
          if (!/🔼|🔽/.test(marked)) {
            throw new Error(`sort indicator missing from header: ${JSON.stringify(marked)}`);
          }
          const after = await page.locator('table tbody tr').first().innerText();
          if (after === before.first) {
            throw new Error('first row unchanged after sort; the sort never ran');
          }
          return { first: after };
        },
      },
      {
        name: 'sort-lastName-desc',
        async before(page) {
          return { first: await page.locator('table tbody tr').first().innerText() };
        },
        async run(page) {
          await page.locator('thead .sortable-header').nth(3).click();
          await page.waitForTimeout(1500);
        },
        async assert(page, before) {
          const after = await page.locator('table tbody tr').first().innerText();
          if (after === before.first) {
            throw new Error('first row unchanged after second sort; the sort never ran');
          }
          return {};
        },
      },
      {
        name: 'scroll-virtual-container',
        async before(page) {
          return {
            top: await page.locator('.container').evaluate((e) => e.scrollTop),
            first: await page.locator('table tbody tr').first().getAttribute('data-index'),
          };
        },
        async run(page) {
          const box = await page.locator('.container').boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          for (let i = 0; i < 10; i++) {
            await page.mouse.wheel(0, 600);
            await page.waitForTimeout(80);
          }
          await page.waitForTimeout(800);
        },
        async assert(page, before) {
          const top = await page.locator('.container').evaluate((e) => e.scrollTop);
          if (top <= before.top) throw new Error(`container did not scroll (${before.top} -> ${top})`);
          const first = await page.locator('table tbody tr').first().getAttribute('data-index');
          if (first === before.first) {
            throw new Error('virtualiser did not swap rows on scroll');
          }
          return {};
        },
      },
      {
        name: 'select-one-row',
        async before(page) {
          return {
            selected: await page.evaluate(() => {
              const el = [...document.querySelectorAll('p')].find((p) =>
                /rows selected/.test(p.textContent ?? ''),
              );
              return el ? el.textContent.trim() : null;
            }),
          };
        },
        async run(page) {
          await page.locator('table tbody tr input[type=checkbox]').first().click();
          await page.waitForTimeout(900);
        },
        async assert(page, before) {
          const after = await page.evaluate(() => {
            const el = [...document.querySelectorAll('p')].find((p) =>
              /rows selected/.test(p.textContent ?? ''),
            );
            return el ? el.textContent.trim() : null;
          });
          if (after === before.selected) {
            throw new Error(`selection text unchanged (${before.selected}); the click never ran`);
          }
          return {};
        },
      },
    ],
  },
};

// ---------------------------------------------------------------------------------------------
// excalidraw. A canvas app: React renders the chrome, the drawing itself is raster work in a
// rAF loop, so this is the case where most of an interaction's cost is NOT a React render.
// Element state is read back out of localStorage, which gives exact assertions.

const exElements = (page) =>
  page.evaluate(() => {
    try {
      const raw = localStorage.getItem('excalidraw');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

apps['excalidraw'] = {
  id: 'excalidraw',
  title: 'excalidraw/excalidraw, excalidraw-app',
  dir: path.join(HERE, 'clones', 'ex', 'excalidraw-app'),
  repoDir: path.join(HERE, 'clones', 'ex'),
  dists: { A: 'bdist-a', B: 'bdist-b', C: 'bdist-c' },
  ports: { A: 5316, B: 5317, C: 5318 },
  async ready(page) {
    await page.waitForSelector('canvas', { timeout: 60000 });
    await page.waitForSelector('[data-testid="toolbar-rectangle"]', { timeout: 60000 });
    await settle(page, 500, 60000);
  },
  steps: [
    {
      name: 'draw-60-rects',
      async before(page) {
        return { n: (await exElements(page)).length };
      },
      async run(page) {
        // 'r' selects the rectangle tool; Excalidraw reverts to selection after each shape
        // unless the tool is locked, so press it each time rather than depending on the lock.
        for (let i = 0; i < 60; i++) {
          await page.keyboard.press('r');
          const x = 260 + (i % 12) * 70;
          const y = 220 + Math.floor(i / 12) * 90;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x + 50, y + 55, { steps: 2 });
          await page.mouse.up();
        }
        await page.waitForTimeout(1200);
      },
      async assert(page, before) {
        const els = await exElements(page);
        if (els.length !== before.n + 60) {
          throw new Error(`expected ${before.n + 60} elements, localStorage has ${els.length}`);
        }
        return {};
      },
    },
    {
      name: 'select-all',
      async before(page) {
        return {};
      },
      async run(page) {
        await page.keyboard.press('Control+a');
        await page.waitForTimeout(700);
      },
      async assert(page) {
        const n = await page.evaluate(() => {
          try {
            const s = JSON.parse(localStorage.getItem('excalidraw-state') || '{}');
            return Object.keys(s.selectedElementIds || {}).length;
          } catch {
            return 0;
          }
        });
        if (n < 60) throw new Error(`select all selected ${n} elements, expected 60`);
        return {};
      },
    },
    {
      name: 'drag-selection',
      async before(page) {
        await settle(page, 400, 60000);
        const els = await exElements(page);
        return { x: els[0].x, y: els[0].y };
      },
      async run(page) {
        // Press inside the first rectangle and drag the whole selection.
        await page.mouse.move(285, 245);
        await page.mouse.down();
        for (let i = 1; i <= 12; i++) {
          await page.mouse.move(285 + i * 15, 245 + i * 8);
          await page.waitForTimeout(16);
        }
        await page.mouse.up();
        await page.waitForTimeout(1000);
      },
      async assert(page, before) {
        const els = await pollFor(
          () => exElements(page),
          (e) => e.length > 0 && Math.abs(e[0].x - before.x) >= 20,
          20000,
        );
        if (Math.abs(els[0].x - before.x) < 20) {
          throw new Error(`first element x ${before.x} -> ${els[0].x}; the drag never moved anything`);
        }
        return {};
      },
    },
    {
      name: 'undo',
      // Settle before reading the baseline: excalidraw commits the drag to its history through a
      // state update, and pressing Ctrl+Z before that lands undoes the wrong thing or nothing.
      // At 4x the drag step's fixed wait was not enough and this assertion caught it.
      async before(page) {
        await settle(page, 500, 60000);
        const els = await exElements(page);
        return { x: els[0].x };
      },
      async run(page) {
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(1000);
      },
      async assert(page, before) {
        const els = await pollFor(
          () => exElements(page),
          (e) => e.length > 0 && Math.abs(e[0].x - before.x) >= 1,
          20000,
        );
        if (Math.abs(els[0].x - before.x) < 1) {
          throw new Error(`first element x unchanged at ${before.x}; the undo never ran`);
        }
        return {};
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// shadcn-ui/ui, apps/v4, the docs site. The first Next.js app here, and the first one that is
// not a single client bundle: React 19.2, Next 16.3, App Router, every page server-rendered,
// most of the tree Server Components with islands of 'use client' under them.
//
// It is here because of the project's own open issue #6879, "Low INP score on mobile devices".
//
// Three `next build` outputs of the same source (.next-a/b/c) served by three `next start`
// processes, not a static directory: the App Router needs its server for RSC payloads, soft
// navigation and the search route the command menu calls.

const V4 = path.join(HERE, 'clones', 'ui', 'apps', 'v4');
const NEXT_BIN = path.join(V4, 'node_modules', 'next', 'dist', 'bin', 'next');



/** One `next start` on `port`, serving the build in `dist`. */
async function startNext(dist, port) {
  const child = spawn(process.execPath, [NEXT_BIN, 'start', '--port', String(port)], {
    cwd: V4,
    env: { ...process.env, BENCH_OUTDIR: dist, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = [];
  child.stdout.on('data', (d) => output.push(String(d)));
  child.stderr.on('data', (d) => output.push(String(d)));
  child.on('exit', (code) => {
    // A non-zero code after killTree is the kill itself, not a failure worth printing.
    if (code !== 0 && code !== null && !child.benchKilled) {
      process.stdout.write(`  next start (${dist}) exited ${code}\n${output.join('').slice(-2000)}\n`);
    }
  });
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);
  } catch (err) {
    killTree(child);
    throw new Error(`${err.message}\n${output.join('').slice(-2000)}`);
  }
  return { close: (done) => { killTree(child); setTimeout(done, 300); } };
}

/** The middle day cell of the page's first calendar demo, which names its month. */
const calendarMonth = (page) =>
  page.evaluate(() => {
    const cal = document.querySelector('[data-slot="calendar"]');
    if (!cal) return null;
    const days = [...cal.querySelectorAll('button[aria-label*=","]')].map((b) => b.getAttribute('aria-label'));
    return days.length ? days[Math.floor(days.length / 2)] : null;
  });

apps['shadcn-v4'] = {
  id: 'shadcn-v4',
  title: 'shadcn-ui/ui, apps/v4 docs site (Next.js 16.3, App Router)',
  dir: V4,
  repoDir: path.join(HERE, 'clones', 'ui'),
  dists: { A: '.next-a', B: '.next-b-new', C: '.next-c' },
  assetsDir: 'static',
  ports: { A: 5319, B: 5320, C: 5321 },
  // The Data Table page: a sortable TanStack Table demo above the fold, the installation tabs
  // below it, and the site chrome (command menu, theme toggle, mobile nav) around both.
  path: '/docs/components/base/data-table',
  startServer: (config, port) => startNext(apps['shadcn-v4'].dists[config], port),
  // pnpm, as the repository's CONTRIBUTING says. `--no-frozen-lockfile` because the patch adds
  // the library to apps/v4. esbuild's install script is blocked by pnpm 10 by default
  // and tsup needs its binary, so it is rebuilt explicitly.
  install(run) {
    const UI = path.join(HERE, 'clones', 'ui');
    run('corepack', ['pnpm', 'install', '--no-frozen-lockfile'], { cwd: UI });
    run('corepack', ['pnpm', 'rebuild', 'esbuild'], { cwd: UI });
    for (const pkg of ['@shadcn/react', '@shadcn/helpers', 'shadcn']) {
      run('corepack', ['pnpm', `--filter=${pkg}`, 'build'], { cwd: UI });
    }
  },
  // The generated component registry: `styles/<style>/ui` is gitignored and the app imports it,
  // so a fresh clone cannot build without this. It is the same source for A, B and C and takes
  // about 95 seconds, so it runs only when its output is missing.
  //
  // The repository runs this under bun (`bun run ./scripts/build-registry.mts`). There is no bun
  // on this machine, so it runs under tsx with tsconfig.registry-node.json, which exists only to
  // give tsx the `jsx: react-jsx` and path settings for files outside scripts/. The script itself
  // is unmodified and imports nothing from bun.
  prepare(run) {
    if (fs.existsSync(path.join(V4, 'styles', 'base-nova', 'ui'))) return;
    run('npx', ['tsx', '--tsconfig', './tsconfig.registry-node.json', './scripts/build-registry.mts'], {
      cwd: V4,
    });
  },
  build(run, env) {
    run(process.execPath, [NEXT_BIN, 'build'], { cwd: V4, env, shell: false });
  },
  async ready(page) {
    await page.waitForSelector('table tbody tr', { timeout: 60000 });
    await page.getByRole('button', { name: /Search documentation/ }).first().waitFor({ timeout: 60000 });
    await settle(page, 500, 60000);
  },
  steps: [
    {
      // The demo's only sortable column. TanStack Table re-sorts five rows, so whatever this
      // costs is React's work, not the sort's.
      name: 'data-table-sort-email',
      async before(page) {
        return { first: await page.locator('table tbody tr').first().innerText() };
      },
      async run(page) {
        await page.locator('table thead th button').first().click();
        await page.waitForTimeout(900);
      },
      async assert(page, before) {
        const after = await page.locator('table tbody tr').first().innerText();
        if (after === before.first) {
          throw new Error('first row unchanged after sorting Email; the sort never ran');
        }
        return {};
      },
    },
    {
      // The package-manager tabs under Installation. A tab switch swaps a syntax-highlighted
      // code block, which is the cheapest of the page's real re-renders.
      name: 'install-tabs-npm',
      async before(page) {
        const npm = page.locator('[data-slot="tabs-trigger"]', { hasText: /^npm$/ }).first();
        const state = await npm.getAttribute('data-state');
        if (state === 'active') throw new Error('the npm tab is already active; switching it proves nothing');
        return { state };
      },
      async run(page) {
        await page.locator('[data-slot="tabs-trigger"]', { hasText: /^npm$/ }).first().click();
        await page.waitForTimeout(700);
      },
      async assert(page) {
        const state = await page
          .locator('[data-slot="tabs-trigger"]', { hasText: /^npm$/ })
          .first()
          .getAttribute('data-state');
        if (state !== 'active') throw new Error(`npm tab is ${state}, not active; the tab never switched`);
        return {};
      },
    },
    {
      // The site-wide command menu. Each keystroke filters a client-side list and fires a
      // fetch to the docs search route, so the typing is the interesting part, not the open.
      name: 'command-menu-open-type',
      async before(page) {
        return {};
      },
      async run(page) {
        await page.getByRole('button', { name: /Search documentation/ }).first().click();
        await page.waitForSelector('[data-slot="command-input"]', { timeout: 20000 });
        await page.keyboard.type('calendar', { delay: 120 });
        await page.waitForTimeout(1600);
      },
      async assert(page) {
        const value = await page.locator('[data-slot="command-input"]').first().inputValue();
        if (value !== 'calendar') throw new Error(`command input is ${JSON.stringify(value)}, expected "calendar"`);
        const items = await page.locator('[data-slot="command-item"]').count();
        if (items === 0) throw new Error('the command menu returned no results; the search never ran');
        return {};
      },
    },
    {
      // Choosing a result is an App Router soft navigation: no new document, a fetched RSC
      // payload, and a whole new page rendered into the same React root.
      name: 'command-menu-go-calendar',
      async before(page) {
        return { url: page.url(), h1: await page.locator('h1').first().innerText() };
      },
      async run(page) {
        await page.locator('[data-slot="command-item"]').first().click();
        await page.waitForTimeout(2500);
      },
      async assert(page, before) {
        if (page.url() === before.url) throw new Error(`still on ${before.url}; the navigation never happened`);
        if (!/\/docs\/components\/base\/calendar$/.test(page.url())) {
          throw new Error(`navigated to ${page.url()}, expected the Calendar page`);
        }
        const h1 = await page.locator('h1').first().innerText();
        if (h1 !== 'Calendar') throw new Error(`heading is ${JSON.stringify(h1)}, expected "Calendar"`);
        return {};
      },
    },
    {
      // react-day-picker, eleven calendars deep on one page. Paging one month re-renders that
      // demo's whole grid.
      name: 'calendar-next-month',
      async before(page) {
        await settle(page, 400, 60000);
        const month = await calendarMonth(page);
        if (!month) throw new Error('no calendar demo on the page to page forward');
        return { month };
      },
      async run(page) {
        await page
          .locator('[data-slot="calendar"]')
          .first()
          .locator('button[aria-label="Go to the Next Month"]')
          .click();
        await page.waitForTimeout(900);
      },
      async assert(page, before) {
        const month = await calendarMonth(page);
        if (month === before.month) {
          throw new Error(`calendar still shows ${before.month}; the month never changed`);
        }
        return {};
      },
    },
    {
      // next-themes writes a class on <html>, which re-renders nothing in React but repaints
      // every custom property on the page.
      name: 'theme-toggle',
      async before(page) {
        return { dark: await page.evaluate(() => document.documentElement.classList.contains('dark')) };
      },
      async run(page) {
        await page.getByRole('button', { name: /Toggle theme/ }).first().click();
        await page.waitForTimeout(800);
      },
      async assert(page, before) {
        const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
        if (dark === before.dark) throw new Error(`<html> is still ${dark ? 'dark' : 'light'}; the theme never changed`);
        return {};
      },
    },
    {
      // The one step at a phone viewport, because #6879 is about mobile. The menu is a popover
      // holding the whole navigation: the sections, and every page of the current one.
      name: 'mobile-nav-open',
      async before(page) {
        await page.setViewportSize({ width: 390, height: 844 });
        await settle(page, 400, 60000);
        return { open: await page.locator('[data-slot="popover-content"]').count() };
      },
      async run(page) {
        await page.getByRole('button', { name: /Toggle Menu/ }).first().click();
        await page.waitForTimeout(1000);
      },
      async assert(page) {
        const links = await page.evaluate(() => {
          const el = document.querySelector('[data-slot="popover-content"][data-state="open"]');
          return el ? el.querySelectorAll('a').length : -1;
        });
        if (links < 10) {
          throw new Error(`the mobile nav popover is not open with its links (found ${links}); the menu never opened`);
        }
        return {};
      },
    },
  ],
};

// Apps kept in files of their own (added 2026-09-25): each exports `apps`, an object of the same
// shape as the entries above, and imports what it needs from helpers.mjs.
for (const f of ['apps-shadcn-sheet.mjs', 'apps-twenty.mjs', 'apps-caldiy.mjs']) {
  if (fs.existsSync(path.join(HERE, f))) Object.assign(apps, (await import(`./${f}`)).apps);
}

export { settle };

// The sort before and after: the virtualized table's sort, before (B, the 0.12.0 build) and after (F,
// the same build with patches/tt-virtual-sort.patch, a plain comparator on the last-name column), both
// with the library in. Run on its own: BENCH_ORDER=B,F node bench.mjs --app tt-virtual-fix. Build F with
// BENCH_CONFIG=b BENCH_OUTDIR=dist-f npx vite build in a/vr, with the patch applied, then revert it.
apps['tt-virtual-fix'] = { ...apps['tt-virtual'], id: 'tt-virtual-fix', dists: { B: 'dist-b', F: 'dist-f' }, ports: { B: 5333, F: 5334 } };

/**
 * Throws for an app that isn't here, or one asked for a configuration it has no build of, before
 * anything is built or started. cal-diy has only A and B, and tt-virtual-fix only B and F, so a
 * run over every app with the default A,B,C would get as far as either and fail there.
 */
export function checkConfigs(appIds, configs) {
  for (const id of appIds) {
    if (!apps[id]) throw new Error(`no such app: ${id}`);
    const has = Object.keys(apps[id].ports);
    const missing = configs.filter((c) => !has.includes(c));
    if (missing.length) {
      throw new Error(`${id} has no configuration ${missing.join(', ')} (it has ${has.join(', ')}): run it on its own with BENCH_ORDER=${has.join(',')}`);
    }
  }
}
