// Runs react-inp-blame/otel through the web SDKs docs/opentelemetry.md has a setup for, from the package as
// npm hands it over. The script copies fixtures/otel into the temp directory, installs it there from its own
// lockfile with react-inp-blame from the tarball `npm pack` makes, and then:
//
//   - runs the fixture's contract.mjs, which feeds one slow click to each SDK's own web-vitals in Node and
//     checks the INP record or span it sends carries the blame of the library's report on that click
//   - writes every ts block of docs/opentelemetry.md whose first line is a path comment into the copy at that
//     path, and compiles them with the fixture's types.ts under its strict tsconfig.json
//
//   node scripts/otel-contract.mjs                    # pack packages/core, then install and check
//   node scripts/otel-contract.mjs --tarball <path>   # a tarball that already exists
//   node scripts/otel-contract.mjs --fresh            # no lockfile: every package at its latest release today
//
// The SDKs are 0.x, and their web vitals code sits under experimental paths, so --fresh is the run that
// finds out the day a release moves a hook, a type or the time an INP record is stamped with. A caret range
// on a 0.x version takes patches only, so --fresh asks for each package's latest rather than for the ranges.
//
// Plain JavaScript on Node's own modules, like vite-app.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = 'react-inp-blame';
const FIXTURE = path.join(root, 'fixtures/otel');
const DOC = 'docs/opentelemetry.md';
/** Printed after the install, so a failure says which releases it happened with. */
const REPORTED = [
  '@opentelemetry/sdk-logs',
  '@opentelemetry/browser-instrumentation',
  '@elastic/opentelemetry-browser',
  '@embrace-io/web-sdk',
  '@honeycombio/opentelemetry-web',
  '@grafana/faro-web-sdk',
  'web-vitals',
  'typescript',
  PACKAGE,
];
// Left behind by a run in the fixture folder itself.
const NOT_COPIED = new Set(['node_modules', 'src']);

const quoted = (text) => `"${text}"`;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Runs a command with its output shown as it comes, and fails if it exits with anything but 0. */
function run(what, command, args, options) {
  console.log(`\n> ${what}`);
  const { status, error } = spawnSync(command, args, { stdio: 'inherit', ...options });
  assert.ok(status === 0, `${what} exited ${status}${error ? `: ${error.message}` : ''}`);
}

/** npm goes through the shell: on Windows it is a .cmd, which Node refuses to spawn without one. */
const npm = (command, cwd) => run(`npm ${command}`, `npm ${command}`, [], { cwd, shell: true });

/**
 * The page's setup blocks: each ```ts block whose first line is a comment naming a file under src/, as
 * `// src/telemetry.ts`. A block without one, like the Next.js config, is prose and is not compiled.
 */
function docBlocks() {
  const doc = fs.readFileSync(path.join(root, DOC), 'utf8').replace(/\r\n/g, '\n');
  const blocks = [];
  for (const [, code] of doc.matchAll(/\n```ts\n([\s\S]*?)\n```/g)) {
    const file = /^\/\/ (src\/[\w./-]+\.ts)$/.exec(code.split('\n', 1)[0])?.[1];
    if (!file) continue;
    assert.ok(!blocks.some((b) => b.file === file), `${DOC} has two blocks that start with // ${file}. Give each its own path.`);
    blocks.push({ file, code: `${code}\n` });
  }
  // One for each setup the contract runs: the web SDK, Embrace, Elastic, Honeycomb and Faro.
  assert.ok(blocks.length >= 5, `${DOC} has ${blocks.length} ts blocks that start with a // src/... comment, where it had one for each of five setups`);
  return blocks;
}

/** Packs packages/core into a directory of its own and returns the tarball. `prepack` builds it first. */
function pack() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-contract-tarball-'));
  npm(`pack -w packages/core --pack-destination ${quoted(dir)}`, root);
  const [tarball] = fs.readdirSync(dir).filter((file) => file.endsWith('.tgz'));
  assert.ok(tarball, `npm pack left no tarball in ${dir}`);
  return path.join(dir, tarball);
}

/** The package the copy got has to be the tarball, which the version alone cannot say while npm has the same one. */
function assertTarballInstalled(app) {
  const dir = path.join(app, 'node_modules', PACKAGE);
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  assert.ok(stat?.isDirectory() && !stat.isSymbolicLink(), `node_modules/${PACKAGE} in ${app} is not a folder npm unpacked`);
  const entry = readJson(path.join(app, 'node_modules/.package-lock.json')).packages[`node_modules/${PACKAGE}`];
  assert.ok(entry?.resolved?.startsWith('file:'), `npm installed ${PACKAGE} from ${entry?.resolved}, not from the tarball`);
  const expected = readJson(path.join(root, 'packages/core/package.json')).version;
  const { version } = readJson(path.join(dir, 'package.json'));
  assert.ok(version === expected, `the copy has ${PACKAGE} ${version}, and packages/core is ${expected}`);
}

function main() {
  const { values } = parseArgs({
    options: {
      tarball: { type: 'string' },
      fresh: { type: 'boolean', default: false },
    },
  });
  // Read before anything is installed, so a page without its blocks fails in a second.
  const blocks = docBlocks();
  const tarball = values.tarball === undefined ? pack() : path.resolve(values.tarball);
  assert.ok(fs.existsSync(tarball), `${tarball} does not exist`);

  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-'));
  console.log(`${path.basename(tarball)} into ${app}, the SDKs in fixtures/otel${values.fresh ? ', each at its latest release' : ''}, on Node ${process.version}`);
  try {
    fs.cpSync(FIXTURE, app, { recursive: true, filter: (source) => !NOT_COPIED.has(path.basename(source)) });
    if (values.fresh) {
      fs.rmSync(path.join(app, 'package-lock.json'));
      const manifest = readJson(path.join(app, 'package.json'));
      const latest = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
        .filter((name) => name !== PACKAGE)
        .map((name) => `${name}@latest`);
      npm(`install --no-audit --no-fund ${latest.join(' ')} ${quoted(tarball)}`, app);
    } else {
      npm('ci --no-audit --no-fund', app);
      // In place of the registry's react-inp-blame, leaving the copy's package.json and lock as they were.
      npm(`install --no-save --no-audit --no-fund ${quoted(tarball)}`, app);
    }
    assertTarballInstalled(app);
    const versions = REPORTED.map((name) => `${name} ${readJson(path.join(app, 'node_modules', name, 'package.json')).version}`);
    console.log(`\nInstalled: ${versions.join(', ')}`);

    run('node contract.mjs', process.execPath, ['contract.mjs'], { cwd: app });

    for (const { file, code } of blocks) {
      fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
      fs.writeFileSync(path.join(app, file), code);
    }
    console.log(`\nFrom ${DOC}: ${blocks.map((b) => b.file).join(', ')}`);
    run('tsc -p tsconfig.json', process.execPath, [path.join(app, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: app });
  } catch (error) {
    console.error(`\nFAILED, the copy is left in ${app} and the tarball is ${tarball}`);
    throw error;
  }

  // Retried because Windows can hold a file for a moment after the process that used it has gone.
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
