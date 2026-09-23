// Runs fixtures/vite-react-ts, the app `npm create vite -- --template react-ts` makes with the README's
// vite.config.ts pasted in, the way a user has it. The script copies it out of the repo into the temp
// directory and installs its dependencies there from its own lockfile, with react-inp-blame from the
// tarball `npm pack` makes. It then builds the app and runs its Playwright specs on the dev server (a Fast
// Refresh edit included) and on `vite preview` of the build.
//
//   node scripts/vite-app.mjs                      # pack packages/core, then install and test
//   node scripts/vite-app.mjs --tarball <path>     # a tarball that already exists
//   node scripts/vite-app.mjs --fresh              # no lockfile: every dependency as npm resolves it today
//   node scripts/vite-app.mjs -- --project=dev     # anything after -- goes to Playwright
//
// The copy is what makes it the user's install. Inside the repo the app could resolve react-inp-blame
// through the workspace link or the monorepo's node_modules, and would never see the package as npm
// hands it over: only what `files` lets in, reached through its exports map.
//
// Plain JavaScript on Node's own modules, like pack-smoke.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'fixtures/vite-react-ts');
const PACKAGE = 'react-inp-blame';
// Printed after the install, so a failure says which releases it happened with.
const REPORTED = ['vite', '@vitejs/plugin-react', 'react', 'react-dom', 'typescript', '@playwright/test', PACKAGE];
// Left behind by a run in the fixture folder itself, and not part of the app.
const NOT_COPIED = new Set(['node_modules', 'dist', 'test-results', 'playwright-report']);

const quoted = (text) => `"${text}"`;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
/** CRLF from a Windows checkout and trailing spaces are not a difference anyone meant. */
const normalized = (text) =>
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd();

/** Runs a command with its output shown as it comes, and fails if it exits with anything but 0. */
function run(what, command, args, options) {
  console.log(`\n> ${what}`);
  const { status, error } = spawnSync(command, args, { stdio: 'inherit', ...options });
  assert.ok(status === 0, `${what} exited ${status}${error ? `: ${error.message}` : ''}`);
}

/**
 * npm goes through the shell: on Windows it is a .cmd, which Node refuses to spawn without one. The
 * command is one string because a shell is handed its arguments unescaped either way, so the caller
 * quotes every path in it.
 */
const npm = (command, cwd) => run(`npm ${command}`, `npm ${command}`, [], { cwd, shell: true });

/** The first ```ts block under the README's "Install with Vite" heading. */
function readmeViteConfig() {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  const section = readme.indexOf('\n## Install with Vite\n');
  assert.ok(section !== -1, 'README.md has no "## Install with Vite" heading, which scripts/vite-app.mjs reads the fixture\'s config from');
  const start = readme.indexOf('```ts\n', section);
  const end = readme.indexOf('\n```', start + 1);
  assert.ok(start !== -1 && end !== -1, 'README.md has no ```ts block under "## Install with Vite"');
  return readme.slice(start + '```ts\n'.length, end);
}

/** What has to hold before anything is installed, so a drift is named for the file that has to change. */
function guards() {
  const own = readJson(path.join(fixture, 'package.json')).devDependencies['@playwright/test'];
  const demo = readJson(path.join(root, 'apps/demo/package.json')).devDependencies['@playwright/test'];
  assert.ok(
    own === demo,
    `fixtures/vite-react-ts/package.json pins @playwright/test ${own} and apps/demo ${demo}. Change the fixture's to ${demo} and refresh its lock with \`npm install --package-lock-only\` in that folder, so both use the browsers CI installs.`,
  );
  const config = fs.readFileSync(path.join(fixture, 'vite.config.ts'), 'utf8');
  assert.ok(
    normalized(config) === normalized(readmeViteConfig()),
    'fixtures/vite-react-ts/vite.config.ts is not the vite.config.ts block under "## Install with Vite" in README.md. Copy the README block into the fixture, so the fixture tests what users paste.',
  );
}

/** Packs packages/core into a directory of its own and returns the tarball. `prepack` builds it first. */
function pack() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-app-tarball-'));
  npm(`pack -w packages/core --pack-destination ${quoted(dir)}`, root);
  // Found by listing the directory: the build's output shares npm's stdout with the file name.
  const [tarball] = fs.readdirSync(dir).filter((file) => file.endsWith('.tgz'));
  assert.ok(tarball, `npm pack left no tarball in ${dir}`);
  return path.join(dir, tarball);
}

/**
 * The package the app got has to be the tarball. The version alone cannot say so while the registry has
 * the same one, so it is also where npm says it came from, and that it is a folder rather than a link.
 */
function assertTarballInstalled(app) {
  const dir = path.join(app, 'node_modules', PACKAGE);
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  assert.ok(stat?.isDirectory() && !stat.isSymbolicLink(), `node_modules/${PACKAGE} in ${app} is not a folder npm unpacked`);
  const entry = readJson(path.join(app, 'node_modules/.package-lock.json')).packages[`node_modules/${PACKAGE}`];
  assert.ok(entry?.resolved?.startsWith('file:'), `npm installed ${PACKAGE} from ${entry?.resolved}, not from the tarball`);
  const expected = readJson(path.join(root, 'packages/core/package.json')).version;
  const { version } = readJson(path.join(dir, 'package.json'));
  assert.ok(version === expected, `the app has ${PACKAGE} ${version}, and packages/core is ${expected}`);
}

function main() {
  // Everything after the first -- is Playwright's, so its options need no declaring here.
  const argv = process.argv.slice(2);
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const playwright = split === -1 ? [] : argv.slice(split + 1);
  const { values } = parseArgs({ args: own, options: { tarball: { type: 'string' }, fresh: { type: 'boolean', default: false } } });

  guards();
  const tarball = values.tarball === undefined ? pack() : path.resolve(values.tarball);
  assert.ok(fs.existsSync(tarball), `${tarball} does not exist`);

  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-app-'));
  console.log(`${path.basename(tarball)} into ${app}${values.fresh ? ', dependencies resolved today' : ''}, on Node ${process.version}`);
  try {
    fs.cpSync(fixture, app, { recursive: true, filter: (source) => !NOT_COPIED.has(path.basename(source)) });
    if (values.fresh) {
      // One install of everything, as a new app gets it on the day this runs.
      fs.rmSync(path.join(app, 'package-lock.json'));
      npm(`install --no-audit --no-fund ${quoted(tarball)}`, app);
    } else {
      npm('ci --no-audit --no-fund', app);
      // In place of the registry's react-inp-blame, leaving the app's package.json and lock as they were.
      npm(`install --no-save --no-audit --no-fund ${quoted(tarball)}`, app);
    }
    assertTarballInstalled(app);
    const versions = REPORTED.map((name) => `${name} ${readJson(path.join(app, 'node_modules', name, 'package.json')).version}`);
    console.log(`\nInstalled: ${versions.join(', ')}`);

    // A step of its own, so a type error in the README's config reads as one.
    npm('run build', app);
    // The specs and playwright.config.ts, which the build's `tsc -b` leaves out and Playwright runs
    // without checking.
    run('tsc -p tsconfig.e2e.json', process.execPath, [path.join(app, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.e2e.json'], { cwd: app });
    const cli = path.join(app, 'node_modules/@playwright/test', readJson(path.join(app, 'node_modules/@playwright/test/package.json')).bin.playwright);
    run(['playwright test', ...playwright].join(' '), process.execPath, [cli, 'test', ...playwright], {
      cwd: app,
      env: { ...process.env, VITE_APP_COPY: '1' },
    });
  } catch (error) {
    console.error(`\nFAILED, the app is left in ${app} and the tarball is ${tarball}`);
    throw error;
  }

  // Retried because Windows can hold a file for a moment after the process that used it has gone. A
  // folder that still will not go is only disk space, so it does not fail a run that passed.
  const leftovers = values.tarball === undefined ? [app, path.dirname(tarball)] : [app];
  for (const dir of leftovers) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (error) {
      console.warn(`Could not remove ${dir}: ${error.message}`);
    }
  }
}

try {
  main();
} catch (error) {
  const readable = error instanceof assert.AssertionError || String(error.code).startsWith('ERR_PARSE_ARGS');
  console.error(readable ? error.message : error.stack);
  process.exitCode = 1;
}
