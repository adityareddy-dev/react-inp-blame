// twenty (github.com/twentyhq/twenty), the CRM: its React front, twenty-front, built by Vite from
// one source, A without the library and B with inpBlame() beside the React plugin (C adds the
// overlay, so run.mjs's default A,B,C works). All talk to one twenty server seeded with twenty's
// own dev seed (the Apple workspace, the seed's own user, companies and people).
//
// - The clone lives in clones/twenty unless TWENTY_ROOT points elsewhere. On Windows, point it at a
//   short path such as C:\tw: under bench\clones the deepest tracked paths pass the 260-character limit.
// - The server runs in Docker, from the image twenty's own Dockerfile builds out of the pristine
//   commit (`git archive HEAD`, so the bench patch is not in it). Its dev seed does not run natively
//   on Windows (it builds storage keys with path.join). The container reaches bench-pg and
//   bench-redis through host.docker.internal, uses the database twenty_bench and Redis logical
//   database 7, and listens on 127.0.0.1:3100. startServer starts it and close() removes it, so
//   the harness owns it; A and B share it through a reference count.
// - Each front is served by a small Node server here: the build's files, index.html for every
//   other path, and twenty's API prefixes (ApiPath in twenty-shared) proxied to the server with
//   the Host header kept. The front calls its own origin, so 5322 and 5323 each count as same
//   origin to the server and each gets its own host-only session cookie.
// - Sign-in happens outside the measured page. startServer checks the saved state against the
//   server and runs twenty-login.mjs's sign-in only when it is missing or no longer valid.
// - Setup order (run.mjs): install -> prepare (workspace packages, server image, database) ->
//   build per configuration. bench/README.md has the steps before that.

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settle, pollFor } from './helpers.mjs';
import { ensureSignedIn, statePath } from './twenty-login.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TWENTY_ROOT || path.join(HERE, 'clones', 'twenty');
const FRONT = path.join(ROOT, 'packages', 'twenty-front');
const DISTS = { A: 'bench-a', B: 'bench-b', C: 'bench-c' };
const PORTS = { A: 5322, B: 5323, C: 5324 };
const BENCH_CONFIG = { A: '', B: 'b', C: 'c' };

const API_PORT = 3100;
const DB = 'twenty_bench';
const REDIS_DB = 7;
const CONTAINER = 'twenty-bench-server';
const GIT_BASH = process.env.GIT_BASH || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash');
const LOGS = path.join(HERE, 'state', 'twenty-logs');

const commit = () => execFileSync('git', ['-C', ROOT, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
const image = () => `twenty-bench-server:${commit()}`;

// ---------------------------------------------------------------- the server, in Docker

// Same values for the seed and the server. APP_SECRET is a fixed local string: this database lives
// only in bench-pg on this machine.
function serverEnv() {
  return {
    NODE_PORT: '3000',
    PG_DATABASE_URL: `postgres://postgres:postgres@host.docker.internal:5432/${DB}`,
    REDIS_URL: `redis://host.docker.internal:6379/${REDIS_DB}`,
    REDIS_QUEUE_URL: `redis://host.docker.internal:6379/${REDIS_DB}`,
    APP_SECRET: 'bench-local-only-not-a-secret',
    SERVER_URL: `http://127.0.0.1:${API_PORT}`,
    FRONTEND_URL: `http://127.0.0.1:${PORTS.A}`,
    IS_MULTIWORKSPACE_ENABLED: 'false',
    SIGN_IN_PREFILLED: 'true',
    // Nothing reaches the internet during a run: no company logos from twenty-icons.com, no
    // telemetry, no analytics.
    ALLOW_REQUESTS_TO_TWENTY_ICONS: 'false',
    TELEMETRY_ENABLED: 'false',
    ANALYTICS_ENABLED: 'false',
    // The schema is set up by prepare; the server only serves.
    DISABLE_DB_MIGRATIONS: 'true',
    DISABLE_CRON_JOBS_REGISTRATION: 'true',
    LOG_LEVELS: 'error,warn',
  };
}

const envArgs = (env) => Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, ...opts });
}

function removeContainer() {
  docker(['rm', '-f', CONTAINER], { stdio: 'ignore' });
}

function portAnswers(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function startBackend() {
  // A container of this name is only ever ours, left behind by a run that was killed.
  removeContainer();
  if (await portAnswers(API_PORT)) {
    throw new Error(`something else already listens on 127.0.0.1:${API_PORT}; twenty's server needs it`);
  }
  const r = docker([
    'run', '-d', '--rm', '--name', CONTAINER,
    '-p', `127.0.0.1:${API_PORT}:3000`,
    ...envArgs(serverEnv()),
    image(),
  ]);
  if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr || r.stdout}`);
  try {
    await pollHealth(180000);
  } catch (err) {
    const logs = docker(['logs', '--tail', '60', CONTAINER]);
    removeContainer();
    throw new Error(`${err.message}\n${(logs.stdout || '') + (logs.stderr || '')}`.slice(-4000));
  }
}

async function pollHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/healthz`);
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`twenty's server never answered /healthz within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// One server for A and B: the first front to start brings it up, the last to close removes it.
let backend = null;
process.on('exit', () => { if (backend) removeContainer(); });

async function acquireBackend() {
  if (!backend) backend = { refs: 0, ready: startBackend() };
  const b = backend;
  b.refs++;
  try {
    await b.ready;
  } catch (err) {
    if (--b.refs === 0 && backend === b) backend = null;
    throw err;
  }
}

function releaseBackend() {
  if (!backend || --backend.refs > 0) return;
  backend = null;
  removeContainer();
}

// ---------------------------------------------------------------- the fronts

// twenty's API prefixes, read from the source so a new one is not silently served index.html.
function apiPrefixes() {
  const src = fs.readFileSync(path.join(ROOT, 'packages', 'twenty-shared', 'src', 'types', 'ApiPath.ts'), 'utf8');
  return new Set([...src.matchAll(/=\s*'([^']+)'/g)].map((m) => m[1]));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function serveStatic(root, req, res) {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(root, pathname === '/' ? 'index.html' : pathname);
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
}

// Streams both ways (graphql-sse holds a response open), and keeps the Host header, so the server
// sees the front's own origin.
function proxy(req, res) {
  const up = http.request(
    { host: '127.0.0.1', port: API_PORT, method: req.method, path: req.url, headers: req.headers },
    (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  req.pipe(up);
}

function tunnel(req, socket, head) {
  const up = net.connect(API_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
}

async function startFront(config, port) {
  const root = path.join(FRONT, DISTS[config]);
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    throw new Error(`missing build ${root}: run the build step for twenty first`);
  }
  const api = apiPrefixes();
  await acquireBackend();
  const server = http.createServer((req, res) => {
    const first = (req.url || '/').split('?')[0].split('/')[1];
    if (api.has(first)) proxy(req, res);
    else serveStatic(root, req, res);
  });
  server.on('upgrade', tunnel);
  server.requestTimeout = 0;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await ensureSignedIn(config, `http://127.0.0.1:${port}`);
  } catch (err) {
    server.close();
    releaseBackend();
    throw err;
  }
  let closed = false;
  return {
    close(done) {
      if (closed) return done();
      closed = true;
      server.close(() => {
        releaseBackend();
        done();
      });
      server.closeAllConnections();
    },
  };
}

// ---------------------------------------------------------------- setup

function bash(script, logName) {
  fs.mkdirSync(LOGS, { recursive: true });
  const log = path.join(LOGS, logName);
  const r = spawnSync(GIT_BASH, ['-c', `set -eo pipefail; ${script}`], {
    cwd: ROOT,
    stdio: ['ignore', fs.openSync(log, 'w'), fs.openSync(log, 'a')],
    windowsHide: true,
    env: { ...process.env, PATH: `${path.join(ROOT, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH}` },
  });
  if (r.status !== 0) {
    const tail = fs.readFileSync(log, 'utf8').slice(-3000);
    throw new Error(`${logName} failed (exit ${r.status}), log ${log}\n${tail}`);
  }
}

// The workspace packages twenty-front imports from their dist, in three stages.
// - nx builds four of them as upstream does.
// - twenty-sdk's nx build fails on Windows: nx runs its commands through cmd.exe, which does not
//   strip the single quotes around its rimraf globs, and rimraf 6 wants --glob for them anyway.
//   Its three commands run here in Git Bash, the last with --glob.
// - The renderer waits on twenty-sdk, so its own targets run here too, minus the declaration step
//   (tsgo), which fails on Windows with DOM type errors. Neither Vite nor the front reads them.
const NX = 'NX_DAEMON=false NX_NO_CLOUD=true NX_TUI=false node node_modules/nx/dist/bin/nx.js';
const SDK_DTS_GLOBS = ['sdk', 'define/**/*.d.ts', 'define/**/*.d.ts.map', 'billing/**/*.d.ts', 'billing/**/*.d.ts.map',
  'front-component/**/*.d.ts', 'front-component/**/*.d.ts.map', 'logic-function/**/*.d.ts', 'logic-function/**/*.d.ts.map',
  'utils/**/*.d.ts', 'utils/**/*.d.ts.map'].map((g) => `'dist/${g}'`).join(' ');
const PACKAGES = [
  {
    done: ['twenty-shared/dist', 'twenty-ui/dist', 'twenty-emails/dist', 'twenty-client-sdk/dist'],
    log: 'build-packages.log',
    script: `${NX} run-many -t build build:individual -p twenty-shared twenty-ui twenty-emails twenty-client-sdk --outputStyle=stream`,
  },
  {
    done: ['twenty-sdk/dist'],
    log: 'build-twenty-sdk.log',
    script: [
      'cd packages/twenty-sdk',
      'npx rimraf dist',
      ...['node', 'define', 'billing', 'front-component', 'logic-function', 'utils', 'browser'].map((c) => `npx vite build -c vite.config.${c}.ts`),
      'tsgo -p tsconfig.lib.json --declaration --emitDeclarationOnly --noEmit false --outDir dist --rootDir src',
      'npx tsc-alias -p tsconfig.lib.json --outDir dist',
      `npx rimraf --glob ${SDK_DTS_GLOBS}`,
      'npx rollup -c rollup.config.sdk-dts.mjs',
    ].join(' && '),
  },
  {
    done: ['twenty-front-component-renderer/dist'],
    log: 'build-renderer.log',
    script: [
      'cd packages/twenty-front-component-renderer',
      'tsx -r tsconfig-paths/register scripts/remote-dom/generate-remote-dom-elements.ts',
      'tsx -r tsconfig-paths/register scripts/front-component-sandbox/build-sandbox-document.ts',
      'npx rimraf dist',
      'npx vite build -c vite.config.ts',
    ].join(' && '),
  },
];

function psql(sql) {
  const r = docker(['exec', 'bench-pg', 'psql', '-U', 'postgres', '-d', DB, '-tAc', sql]);
  return r.status === 0 ? r.stdout.trim() : null;
}

// Seeded means the Apple workspace has its people. The seed command exits 0 even when it fails
// part way, so this is asked of the database rather than taken from the exit code.
const APPLE_PEOPLE = 'SELECT count(*) FROM "workspace_1wgvd1injqtife6y4rvfbu3h5".person';

function seeded() {
  const n = Number(psql(APPLE_PEOPLE));
  return Number.isFinite(n) && n > 100;
}

function seed() {
  docker(['exec', 'bench-pg', 'dropdb', '-U', 'postgres', '--if-exists', DB], { stdio: 'inherit' });
  const c = docker(['exec', 'bench-pg', 'createdb', '-U', 'postgres', DB], { stdio: 'inherit' });
  if (c.status !== 0) throw new Error(`createdb ${DB} failed`);
  // Redis db 7 is ours only; clear what a previous database left cached there.
  docker(['exec', 'bench-redis', 'redis-cli', '-n', String(REDIS_DB), 'FLUSHDB'], { stdio: 'ignore' });
  // twenty's `nx database:reset` (seed configuration), minus ClickHouse, inside the server image.
  const steps = [
    'node dist/database/scripts/setup-db.js',
    'node dist/command/command run-instance-commands --force --include-slow',
    'node dist/command/command cache:flush',
    'node dist/command/command workspace:seed:dev',
  ].join(' && ');
  fs.mkdirSync(LOGS, { recursive: true });
  const log = path.join(LOGS, 'seed.log');
  const r = spawnSync(
    'docker',
    ['run', '--rm', '--name', `${CONTAINER}-seed`, ...envArgs(serverEnv()), '--entrypoint', 'sh', image(), '-c', steps],
    { stdio: ['ignore', fs.openSync(log, 'w'), fs.openSync(log, 'a')], windowsHide: true },
  );
  if (r.status !== 0 || !seeded()) {
    throw new Error(`seeding ${DB} failed (exit ${r.status}), log ${log}\n${fs.readFileSync(log, 'utf8').slice(-3000)}`);
  }
  // The seed's person avatars and workspace logos are https://twentyhq.github.io/placeholder-images/...
  // Blanked so a run never fetches from the internet; chips and the workspace switcher fall back to
  // initials, as for a record without a picture.
  const schemas = psql(`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'workspace\\_%'`);
  for (const s of (schemas || '').split('\n').filter(Boolean)) {
    psql(`UPDATE "${s}".person SET "avatarUrl" = '' WHERE "avatarUrl" LIKE 'http%'`);
  }
  psql(`UPDATE core.workspace SET logo = '' WHERE logo LIKE 'http%'`);
  // And nothing cached from before that change survives into the server.
  docker(['exec', 'bench-redis', 'redis-cli', '-n', String(REDIS_DB), 'FLUSHDB'], { stdio: 'ignore' });
  // A new database means new sessions: the saved sign-ins are no good now.
  for (const c of Object.keys(DISTS)) fs.rmSync(statePath(c), { force: true });
}

// ---------------------------------------------------------------- page

// A loaded row: skeleton rows carry the same test id but no record chip yet.
const chips = (page, object) => page.locator(`[data-testid^="row-id-"] a[href^="/object/${object}/"]`);
const selectAll = (page) => page.getByRole('checkbox', { name: 'Select all rows' });
const checkedRows = (page) =>
  page.evaluate(() => {
    const boxes = [...document.querySelectorAll('[role="checkbox"][aria-label="Select row"]')];
    return { total: boxes.length, checked: boxes.filter((b) => b.getAttribute('aria-checked') === 'true').length };
  });
const closePanel = (page) => page.getByRole('button', { name: 'Close side panel' });
const commandInput = (page) => page.getByPlaceholder('Type anything...');
const panelParam = (page) => new URL(page.url()).searchParams.get('panel');

// The record table's column headers, left to right. Row drag handles live inside rows; the header
// handles do not.
const headerOrder = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-dnd-sortable-handle="true"]')]
      .filter((h) => h.closest('[id^="record-table-"]') && !h.closest('[data-testid^="row-id-"]'))
      .map((h) => ({ name: h.innerText.trim(), x: h.getBoundingClientRect().left }))
      .sort((a, b) => a.x - b.x)
      .map((h) => h.name),
  );

// Drags a header by its handle and drops it over a quarter or three quarters of the way across
// another, the way a hand does it: press, move in small steps past dnd-kit's 8 px activation
// distance, release.
async function dragHeader(page, name, overName, fraction) {
  const handle = (n) => page.locator('[data-dnd-sortable-handle="true"]').filter({ hasText: n }).first();
  const from = await handle(name).boundingBox();
  const over = await handle(overName).boundingBox();
  if (!from || !over) throw new Error(`no header handle for ${name} or ${overName}`);
  const x0 = from.x + from.width / 2;
  const y = from.y + from.height / 2;
  const x1 = over.x + over.width * fraction;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / 10, y);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

// Throws unless `ok` holds within 20 s. The condition is the assertion; the time is only how long
// a 4x-throttled page is given to get there, after the measured window.
async function expectSoon(what, read, ok, timeoutMs = 20000) {
  const last = await pollFor(read, ok, timeoutMs);
  if (!ok(last)) throw new Error(`${what}; last seen ${JSON.stringify(last)}`);
  return last;
}

const MOVED = 'Emails';
// Set by the drag steps' before(), which bench.mjs does not pass on to run(), so that run() starts
// with the drag itself rather than a read of the page.
let dragOver = null;

function navStep(name, label, object) {
  return {
    name,
    async before(page) {
      if (new URL(page.url()).pathname.startsWith(`/objects/${label.toLowerCase()}`)) {
        throw new Error(`already on ${label}`);
      }
      return {};
    },
    async run(page) {
      await page.getByRole('link', { name: label, exact: true }).first().click();
      await page.waitForTimeout(300);
    },
    async assert(page) {
      await expectSoon(
        `${label} never showed its records`,
        async () => ({ path: new URL(page.url()).pathname, rows: await chips(page, object).count() }),
        (v) => v.path === `/objects/${label.toLowerCase()}` && v.rows > 0,
      );
      return {};
    },
  };
}

export const apps = {
  twenty: {
    id: 'twenty',
    title: 'twenty CRM front (twenty-front), People, Companies and Opportunities in the seeded Apple workspace',
    dir: FRONT,
    repoDir: ROOT,
    dists: DISTS,
    ports: PORTS,
    path: '/objects/people',
    startServer: (config, port) => startFront(config, port),
    contextOptions(config) {
      const file = statePath(config);
      if (!fs.existsSync(file)) throw new Error(`no saved sign-in at ${file}; startServer should have made it`);
      return { storageState: file };
    },
    install(run) {
      // twenty's .yarnrc.yml holds new packages back for three days and hardens the install
      // against lockfile changes. Both are lifted for this one install, which adds
      // react-inp-blame to the lockfile (0.12.0 on 2026-09-25, 0.13.0 on 2026-09-26, each inside the gate).
      run('node', ['.yarn/releases/yarn-4.13.0.cjs', 'install'], {
        cwd: ROOT,
        env: { ...process.env, YARN_NPM_MINIMAL_AGE_GATE: '0', YARN_ENABLE_HARDENED_MODE: '0' },
      });
    },
    prepare() {
      for (const p of PACKAGES) {
        if (!p.done.every((d) => fs.existsSync(path.join(ROOT, 'packages', d)))) bash(p.script, p.log);
      }
      if (docker(['image', 'inspect', image()], { stdio: 'ignore' }).status !== 0) {
        bash(
          `git archive --format=tar HEAD | docker build --target twenty-server -f packages/twenty-docker/twenty/Dockerfile -t ${image()} -`,
          'docker-build.log',
        );
      }
      if (!seeded()) seed();
    },
    build(run, env) {
      const config = Object.keys(BENCH_CONFIG).find((c) => BENCH_CONFIG[c] === (env.BENCH_CONFIG || ''));
      run('node', [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
        cwd: FRONT,
        env: {
          ...env,
          NODE_ENV: 'production',
          NODE_OPTIONS: '--max-old-space-size=8192',
          BENCH_OUTDIR: DISTS[config],
        },
      });
    },
    async ready(page) {
      const onLogin = () => /\/welcome|\/sign-in|\/verify/.test(page.url());
      await pollFor(
        async () => (onLogin() ? 'login' : await chips(page, 'person').count()),
        (v) => v === 'login' || v > 0,
        60000,
      );
      if (onLogin()) throw new Error(`landed on ${page.url()}: the saved sign-in is not valid for this build`);
      if (!(await chips(page, 'person').count())) throw new Error('the People table never showed a record');
      await settle(page, 500, 60000);
    },
    steps: [
      {
        name: 'select-all',
        async before(page) {
          const s = await checkedRows(page);
          if (!s.total || s.checked) throw new Error(`expected rows and none selected, got ${JSON.stringify(s)}`);
          return {};
        },
        async run(page) {
          await selectAll(page).click();
          await page.waitForTimeout(300);
        },
        async assert(page) {
          await expectSoon('select all did not select every row', () => checkedRows(page), (s) => s.total > 0 && s.checked === s.total);
          return {};
        },
      },
      {
        name: 'unselect-all',
        async run(page) {
          await selectAll(page).click();
          await page.waitForTimeout(300);
        },
        async assert(page) {
          await expectSoon('unselect all left rows selected', () => checkedRows(page), (s) => s.total > 0 && s.checked === 0);
          return {};
        },
      },
      {
        // The Name column's chip opens the record in the side panel (?panel=/object/person/<id>).
        name: 'open-record-chip',
        async before(page) {
          if (panelParam(page)) throw new Error('the side panel is already open');
          const chip = chips(page, 'person').first();
          return { href: await chip.getAttribute('href'), name: (await chip.innerText()).split('\n').pop().trim() };
        },
        async run(page) {
          await chips(page, 'person').first().click();
          await page.waitForTimeout(300);
        },
        async assert(page, before) {
          const id = before.href.split('?')[0];
          await expectSoon(
            `the chip did not open ${before.name} in the side panel`,
            async () => ({ panel: panelParam(page), close: await closePanel(page).isVisible(), title: await page.locator('aside').getByText(before.name, { exact: true }).count() }),
            (v) => v.panel === id && v.close && v.title > 0,
          );
          return {};
        },
      },
      {
        name: 'close-record',
        async run(page) {
          await closePanel(page).click();
          await page.waitForTimeout(300);
        },
        async assert(page) {
          await expectSoon('the side panel did not close', async () => ({ panel: panelParam(page), close: await closePanel(page).isVisible() }), (v) => !v.panel && !v.close);
          return {};
        },
      },
      {
        name: 'command-menu-open',
        async run(page) {
          await page.keyboard.press('Control+k');
          await page.waitForTimeout(300);
        },
        async assert(page) {
          await expectSoon(
            'Ctrl+K did not open the command menu with its input focused',
            () => commandInput(page).evaluate((el) => el === document.activeElement).catch(() => false),
            (v) => v === true,
          );
          return {};
        },
      },
      {
        // One key at a time, as a person types; the menu filters its commands on each key.
        name: 'command-menu-type',
        async before(page) {
          if (!(await page.getByText('Create Company', { exact: true }).count())) {
            throw new Error('the command menu does not list its commands before typing');
          }
          return {};
        },
        async run(page) {
          await commandInput(page).pressSequentially('goo', { delay: 150 });
          await page.waitForTimeout(300);
        },
        async assert(page) {
          await expectSoon(
            'typing did not filter the command menu',
            async () => ({ value: await commandInput(page).inputValue(), unfiltered: await page.getByText('Create Company', { exact: true }).count() }),
            (v) => v.value === 'goo' && v.unfiltered === 0,
          );
          return {};
        },
      },
      {
        name: 'command-menu-close',
        async run(page) {
          await closePanel(page).click();
          await page.waitForTimeout(300);
        },
        async assert(page) {
          await expectSoon('the command menu did not close', () => commandInput(page).count(), (n) => n === 0);
          return {};
        },
      },
      {
        // twenty issue #23918. The new order is saved to the view, so the next step drags it back
        // and every run starts from the same columns.
        name: 'column-drag',
        async before(page) {
          const order = await headerOrder(page);
          const i = order.indexOf(MOVED);
          if (i < 0 || i + 1 >= order.length) throw new Error(`no column to the right of ${MOVED}: ${order.join(', ')}`);
          dragOver = order[i + 1];
          return { order, over: dragOver };
        },
        async run(page) {
          await dragHeader(page, MOVED, dragOver, 0.75);
          await page.waitForTimeout(300);
        },
        async assert(page, before) {
          const want = [...before.order];
          const i = want.indexOf(MOVED);
          [want[i], want[i + 1]] = [want[i + 1], want[i]];
          await expectSoon(`${MOVED} did not move past ${before.over}`, () => headerOrder(page), (o) => o.join('|') === want.join('|'));
          return {};
        },
      },
      {
        name: 'column-drag-back',
        async before(page) {
          const order = await headerOrder(page);
          const i = order.indexOf(MOVED);
          if (i < 1) throw new Error(`no column to the left of ${MOVED}: ${order.join(', ')}`);
          dragOver = order[i - 1];
          return { order, over: dragOver };
        },
        async run(page) {
          await dragHeader(page, MOVED, dragOver, 0.25);
          await page.waitForTimeout(300);
        },
        async assert(page, before) {
          const want = [...before.order];
          const i = want.indexOf(MOVED);
          [want[i - 1], want[i]] = [want[i], want[i - 1]];
          await expectSoon(`${MOVED} did not move back before ${before.over}`, () => headerOrder(page), (o) => o.join('|') === want.join('|'));
          return {};
        },
      },
      navStep('nav-companies', 'Companies', 'company'),
      navStep('nav-opportunities', 'Opportunities', 'opportunity'),
      navStep('nav-people', 'People', 'person'),
    ],
  },
};
