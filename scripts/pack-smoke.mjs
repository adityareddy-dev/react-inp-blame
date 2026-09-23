// Installs the package the way its users get it, as the tarball `npm pack` makes, into throwaway apps
// under the temp directory, and checks it there. Every other check in this repo but vite-app.mjs
// resolves react-inp-blame through the workspace link, which cannot see a file left out of `files`, an
// exports target that does not exist, or a peer range npm refuses to install.
//
//   node scripts/pack-smoke.mjs                     # pack packages/core, then every gating fixture
//   node scripts/pack-smoke.mjs bare vite-oldest    # these fixtures only
//   node scripts/pack-smoke.mjs next-canary         # allowed to break, so it runs only when named
//   node scripts/pack-smoke.mjs --tarball <path>    # a tarball that already exists
//
// Plain JavaScript on Node's own modules, because CI runs it on Node 20.19, the oldest Node the package
// promises, and that one cannot strip TypeScript.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = 'react-inp-blame';
// The key install() creates React's DevTools hook under. It is a string, so it survives a minifier, and
// a page with no React on it can only have got it from the library.
const HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

const functions = (...names) => Object.fromEntries(names.map((name) => [name, 'function']));

// What loading each subpath has to give: the public names the READMEs document, by `typeof`. A subpath
// the installed exports map has and this does not fails the run, so a new one cannot ship unchecked.
// `whole` is for a module that is one value rather than a set of names. `import` hands that value over
// as `default` and `require()` as what it returns, and the names are looked for on it.
const EXPECTED = {
  '.': { names: functions('install', 'mountOverlay', 'onInteraction', 'fiberFromNode', 'ownerChain', 'handlerName') },
  // Exports nothing: importing it installs, which in these apps means loading with no `window` and not throwing.
  './auto': { names: {} },
  './next': { names: functions('withInpBlame') },
  './next-client': { names: functions('onRouterTransitionStart') },
  './web-vitals': { names: functions('generateTarget', 'attributeINP') },
  './vite': { names: functions('inpBlame') },
  './display-names-loader': { whole: 'function', names: functions('stamp', 'componentNames') },
  './package.json': { whole: 'object', names: { name: 'string' } },
};

// The two ways into a package, run as children of this Node from the app. Each loads every specifier of
// the plan file it is handed and prints what it found in the shape of EXPECTED, so the assertions stay
// in this file. A specifier that cannot be loaded is reported with its error rather than skipped: Node
// 20.19 is the floor because it has require(esm) without a flag, so requiring the ESM entries is part
// of the promise.
const LOADERS = {
  'load.mjs': `import fs from 'node:fs';

const found = {};
for (const { specifier, whole, names } of JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))) {
  try {
    const namespace = await import(specifier, specifier.endsWith('.json') ? { with: { type: 'json' } } : undefined);
    const value = whole ? namespace.default : namespace;
    const types = Object.fromEntries(names.map((name) => [name, typeof value?.[name]]));
    found[specifier] = whole ? { whole: typeof value, names: types } : { names: types };
  } catch (error) {
    found[specifier] = { error: String(error) };
  }
}
console.log(JSON.stringify(found));
`,
  'load.cjs': `const fs = require('node:fs');

const found = {};
for (const { specifier, whole, names } of JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))) {
  try {
    const value = require(specifier);
    const types = Object.fromEntries(names.map((name) => [name, typeof value?.[name]]));
    found[specifier] = whole ? { whole: typeof value, names: types } : { names: types };
  } catch (error) {
    found[specifier] = { error: String(error) };
  }
}
console.log(JSON.stringify(found));
`,
};

// Calls the wrapper the way the README's next.config does, and prints what came of it.
const NEXT_CONFIG = `import { withInpBlame } from '${PACKAGE}/next';

// What the wrapper prints goes into the answer, so the check can read it beside the config.
const warnings = [];
console.warn = (message) => warnings.push(String(message));
try {
  console.log(JSON.stringify({ config: withInpBlame({}), warnings }));
} catch (error) {
  console.log(JSON.stringify({ refusal: error.message, warnings }));
}
`;

// Two pages, each with a script of its own, and both importing the same module. That gives the build a
// chunk both entries import, which is where react-dom lands in a real app and where the page's install
// used to lose the race. What the pages do is beside the point; the order of their script tags is not.
const VITE_PAGES = ['index', 'second'];
const vitePage = (name) => `<!doctype html>
<html lang="en">
  <head>
    <title>pack-smoke ${name}</title>
  </head>
  <body>
    <script type="module" src="/src/${name}.js"></script>
  </body>
</html>
`;
const VITE_SHARED = "export const label = 'pack-smoke';\n";
// The marker says which built file is the page's own entry, whatever the bundler named it.
const VITE_MARKER = '__packSmokePage';
const viteEntry = (name) => `import { label } from './shared.js';\n\nwindow.${VITE_MARKER} = '${name}:' + label;\n`;
const VITE_CONFIG = `import path from 'node:path';
import { inpBlame } from '${PACKAGE}/vite';

export default {
  plugins: [inpBlame({ enabled: true })],
  build: { rollupOptions: { input: { ${VITE_PAGES.map((name) => `${name}: path.resolve('${name}.html')`).join(', ')} } } },
};
`;

const quoted = (text) => `"${text}"`;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
/** The package.json of a package the app has installed. */
const installed = (app, name) => readJson(path.join(app, 'node_modules', name, 'package.json'));
const specifierOf = (subpath) => PACKAGE + subpath.slice(1);

/**
 * Runs a command and returns what it printed. Any exit but 0 fails with all of its output, which for
 * npm is where the ERESOLVE report is.
 */
function run(what, command, args, options) {
  const { status, stdout, stderr, error } = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.ok(status === 0, [`${what} exited ${status}`, stdout, stderr, error].filter(Boolean).join('\n').trimEnd());
  return stdout;
}

/**
 * npm goes through the shell: on Windows it is a .cmd, which Node refuses to spawn without one. The
 * command is one string because a shell is handed its arguments unescaped either way, so the caller
 * quotes every path and package spec in it.
 */
const npm = (command, cwd) => run(`npm ${command}`, `npm ${command}`, [], { cwd, shell: true });

/** A child of this same Node, the version under test, run from the app. */
const node = (app, args, env = process.env) => run(`node ${args.join(' ')}`, process.execPath, args, { cwd: app, env });

/** Packs packages/core into a directory of its own and returns the tarball. `prepack` builds it first. */
function pack() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-smoke-tarball-'));
  npm(`pack -w packages/core --pack-destination ${quoted(dir)}`, root);
  // Found by listing the directory: the build's output shares npm's stdout with the file name.
  const [tarball] = fs.readdirSync(dir).filter((file) => file.endsWith('.tgz'));
  return path.join(dir, tarball);
}

/** Every file an exports entry points at under any condition, with the path of conditions that leads to it. */
function targets(entry, where) {
  if (typeof entry === 'string') return [{ file: entry, where }];
  if (entry === null || typeof entry !== 'object') return [];
  return Object.entries(entry).flatMap(([condition, inner]) => targets(inner, `${where}.${condition}`));
}

/** Whether an exports entry maps `condition` at any depth. */
function maps(entry, condition) {
  if (entry === null || typeof entry !== 'object') return false;
  return Object.hasOwn(entry, condition) || Object.values(entry).some((inner) => maps(inner, condition));
}

/**
 * Looks at the files rather than trusting the loads that follow, because of the `types` targets:
 * nothing ever executes a declaration file.
 */
function assertFilesExist(dir, manifest) {
  const promised = [
    ...['main', 'types'].map((field) => ({ file: manifest[field], where: field })),
    ...Object.entries(manifest.exports).flatMap(([subpath, entry]) => targets(entry, `exports["${subpath}"]`)),
  ].filter(({ file }) => typeof file === 'string');
  const missing = promised.filter(({ file }) => !fs.existsSync(path.join(dir, file)));
  assert.ok(missing.length === 0, missing.map(({ file, where }) => `${where} points at ${file}, which is not in the package`).join('\n'));
}

/**
 * Loads the subpaths of `expected` with both loaders and holds what each found against it. The plan
 * stays in the app, so a failure can be run again there by hand.
 */
function assertLoads(app, planFile, expected, flags = []) {
  const plan = Object.entries(expected).map(([subpath, { whole, names }]) => ({
    specifier: specifierOf(subpath),
    whole: whole !== undefined,
    names: Object.keys(names),
  }));
  fs.writeFileSync(path.join(app, planFile), `${JSON.stringify(plan, null, 2)}\n`);
  for (const loader of Object.keys(LOADERS)) {
    const args = [...flags, loader, planFile];
    const found = JSON.parse(node(app, args));
    for (const [subpath, shape] of Object.entries(expected)) {
      const specifier = specifierOf(subpath);
      // Node prints how the two shapes differ under this message.
      assert.deepEqual(found[specifier], shape, `node ${args.join(' ')}: ${specifier}`);
    }
  }
}

/** The checks every app gets, on the copy npm installed. */
function assertPackage(app) {
  const dir = path.join(app, 'node_modules', PACKAGE);
  const manifest = readJson(path.join(dir, 'package.json'));
  const subpaths = Object.keys(manifest.exports);
  const unexpected = subpaths.filter((subpath) => !Object.hasOwn(EXPECTED, subpath));
  const gone = Object.keys(EXPECTED).filter((subpath) => !subpaths.includes(subpath));
  assert.ok(unexpected.length === 0, `exports has ${unexpected.join(', ')}, which EXPECTED in scripts/pack-smoke.mjs says nothing about`);
  assert.ok(gone.length === 0, `exports no longer has ${gone.join(', ')}`);

  assertFilesExist(dir, manifest);
  for (const [file, source] of Object.entries(LOADERS)) fs.writeFileSync(path.join(app, file), source);
  assertLoads(app, 'plan.json', EXPECTED);

  // One no-op module stands in for every subpath that maps `react-server`, so it has to export the
  // names of all of them at once. No real entry does: `.` has no onRouterTransitionStart, /next-client
  // has no install and /auto has nothing, so a map that still led to them could not pass this.
  // `typeof install` could, and so could calling it: with no `window` the real install() is inert too.
  const onServer = subpaths.filter((subpath) => maps(manifest.exports[subpath], 'react-server'));
  assert.ok(onServer.length > 0, 'no subpath maps the react-server condition any more');
  const names = Object.assign({}, ...onServer.map((subpath) => EXPECTED[subpath].names));
  const noOp = Object.fromEntries(onServer.map((subpath) => [subpath, { names }]));
  assertLoads(app, 'plan.react-server.json', noOp, ['--conditions=react-server']);
}

/** `bare`: the package has no dependencies and npm leaves optional peers out, so it arrives alone. */
function arrivesAlone(app) {
  const others = fs.readdirSync(path.join(app, 'node_modules')).filter((name) => !name.startsWith('.') && name !== PACKAGE);
  assert.ok(others.length === 0, `npm installed ${others.join(', ')} with the package, which has no dependencies and only optional peers`);
}

/**
 * What withInpBlame({}) does in the app under `next dev`, the run its default `enabled` covers.
 * Next.js sets NODE_ENV before it reads the config, so that is all `next dev` means here.
 */
function wrapNextConfig(app) {
  fs.writeFileSync(path.join(app, 'next-config.mjs'), NEXT_CONFIG);
  return JSON.parse(node(app, ['next-config.mjs'], { ...process.env, NODE_ENV: 'development' }));
}

/**
 * The design is "installs anywhere, explains itself at run time". The install was the first half, and
 * this is the second: below instrumentationClientInject the wrapper still goes to work, and prints the
 * line that installs the library from the app's instrumentation-client.
 */
function explainsThisNext(app) {
  const { config, refusal, warnings } = wrapNextConfig(app);
  const { version } = installed(app, 'next');
  assert.ok(refusal === undefined, `withInpBlame({}) beside next ${version} threw: ${refusal}`);
  assert.ok(!config.instrumentationClientInject, `withInpBlame({}) beside next ${version} wrote instrumentationClientInject, which that Next.js does not have: ${JSON.stringify(config)}`);
  // The version numbers are the unit tests' to pin. What has to hold here is that the warning names
  // the Next.js it found and the line to add.
  const told = warnings.some((warning) => warning.includes(version) && warning.includes(`${PACKAGE}/next-client`));
  assert.ok(told, `withInpBlame({}) beside next ${version} did not print the line for instrumentation-client: ${JSON.stringify(warnings)}`);
}

/** At the floor or past it, a canary included, the wrapper goes to work instead of throwing. */
function wrapsNextConfig(app) {
  const { config, refusal } = wrapNextConfig(app);
  assert.ok(refusal === undefined, `withInpBlame({}) beside next ${installed(app, 'next').version} threw: ${refusal}`);
  // The key the floor exists for. A config that came back untouched would not have it.
  const injected = config.instrumentationClientInject?.includes(`${PACKAGE}/next-client`);
  assert.ok(injected, `withInpBlame({}) did not add ${PACKAGE}/next-client to instrumentationClientInject: ${JSON.stringify(config)}`);
}

// A bundled `import './chunk.js'`, with or without names in front of it, as a minifier leaves it.
const STATIC_IMPORT = /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;

/** The code of every module the page's scripts load, following the static imports the bundler wrote. */
function scriptsOf(dist, page) {
  const queue = [...page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(([, src]) => src.replace(/^\//, ''));
  const seen = new Set();
  const code = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file) || !fs.existsSync(path.join(dist, file))) continue;
    seen.add(file);
    const source = fs.readFileSync(path.join(dist, file), 'utf8');
    code.push(source);
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith('.')) queue.push(path.posix.join(path.posix.dirname(file), specifier));
    }
  }
  return code;
}

/**
 * A real `vite build`, because whether this Vite honours the form the plugin's `transformIndexHtml`
 * hook is written in shows only in the pages it builds. Both pages have to install, and to install
 * first: the plugin gives each one a script of its own ahead of the page's, and deferred module
 * scripts run in document order, each graph evaluated in full before the next one starts. Inside a
 * single entry there is no such guarantee, and with two pages sharing a chunk the bundler used to
 * settle it the wrong way round.
 */
function buildsWithVite(app) {
  const dist = path.join(app, 'dist');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.writeFileSync(path.join(app, 'src/shared.js'), VITE_SHARED);
  for (const name of VITE_PAGES) {
    fs.writeFileSync(path.join(app, `${name}.html`), vitePage(name));
    fs.writeFileSync(path.join(app, `src/${name}.js`), viteEntry(name));
  }
  fs.writeFileSync(path.join(app, 'vite.config.mjs'), VITE_CONFIG);
  node(app, [path.join('node_modules/vite', installed(app, 'vite').bin.vite), 'build']);

  for (const name of VITE_PAGES) {
    const page = fs.readFileSync(path.join(dist, `${name}.html`), 'utf8');
    // Each script tag stands for everything it loads, since a module's imports are evaluated before
    // its body. One of those graphs installs the library and one is the page's own code.
    const graphs = [...page.matchAll(/<script\b[^>]*\bsrc="[^"]+"/g)].map(([tag]) => scriptsOf(dist, tag).join('\n'));
    const installs = graphs.findIndex((code) => code.includes(HOOK_KEY));
    const own = graphs.findIndex((code) => code.includes(VITE_MARKER));
    assert.ok(installs !== -1, `nothing ${name}.html loads installs the library:\n${page}`);
    assert.ok(own !== -1, `no script of ${name}.html is the page's own entry:\n${page}`);
    assert.ok(installs < own, `${name}.html installs no earlier than its own entry, so react-dom can win:\n${page}`);
  }
}

// Next.js is named alone because npm installs the peers a package asks for: each app gets the react and
// react-dom its Next.js wants, a canary's included, with no version guessed here.
const NEXT_APP = ['next', 'react', 'react-dom'];
// The Next.js the e2e suites run, read from their app so the two never drift apart.
const nextDemo = readJson(path.join(root, 'apps/next-demo/package.json'));

// `install` is what npm is asked for along with the tarball, `beside` is what then has to be in the app,
// and `check` is what the fixture adds to the checks every app gets.
const FIXTURES = {
  // All four peers are optional, so with none of them the package still has to install and load.
  bare: { install: [], beside: [], check: arrivesAlone },
  // Older than instrumentationClientInject. The peer range the wrapper once had made npm refuse the install.
  'next-15': { install: ['next@15'], beside: NEXT_APP, check: explainsThisNext },
  'next-current': { install: [`next@${nextDemo.dependencies.next}`], beside: NEXT_APP, check: wrapsNextConfig },
  // No document names an oldest Vite, so this is 5, the floor the peer range had before it became `*`.
  'vite-oldest': { install: ['vite@5'], beside: ['vite'], check: buildsWithVite },
  // A canary is allowed to break, so this one runs only when named. CI names it in the job that may fail.
  'next-canary': { install: ['next@canary'], beside: NEXT_APP, check: wrapsNextConfig, gating: false },
};

/** Installs into the app and checks it. Returns what npm put beside the package, with versions. */
function smoke(name, tarball, app) {
  const { install, beside, check } = FIXTURES[name];
  const manifest = { name: `pack-smoke-${name}`, private: true, type: 'module' };
  fs.writeFileSync(path.join(app, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // One install of the tarball and everything beside it, resolved together as an app's own would be.
  // This is the ERESOLVE guard, and only a real install is one: reading the peer ranges back proves nothing.
  npm(['install --no-audit --no-fund', quoted(tarball), ...install.map(quoted)].join(' '), app);
  const versions = beside.map((dependency) => {
    assert.ok(fs.existsSync(path.join(app, 'node_modules', dependency)), `npm did not install ${dependency} into the app`);
    return `${dependency} ${installed(app, dependency).version}`;
  });
  assertPackage(app);
  check(app);
  return versions;
}

const indented = (text) => text.replace(/^/gm, '  ');
/** A failed assertion or a mistyped option is its message. Anything else is a fault in this script, and keeps its stack. */
function described(error) {
  const readable = error instanceof assert.AssertionError || String(error.code).startsWith('ERR_PARSE_ARGS');
  return readable ? error.message : error.stack;
}

function main() {
  const { values, positionals } = parseArgs({ options: { tarball: { type: 'string' } }, allowPositionals: true });
  const names = positionals.length ? positionals : Object.keys(FIXTURES).filter((name) => FIXTURES[name].gating !== false);
  const unknown = names.filter((name) => !Object.hasOwn(FIXTURES, name));
  assert.ok(unknown.length === 0, `No fixture is named ${unknown.join(', ')}. There are ${Object.keys(FIXTURES).join(', ')}.`);

  const tarball = values.tarball === undefined ? pack() : path.resolve(values.tarball);
  assert.ok(fs.existsSync(tarball), `${tarball} does not exist`);
  console.log(`${path.basename(tarball)} on Node ${process.version}`);

  const failed = [];
  for (const name of names) {
    const started = Date.now();
    const app = fs.mkdtempSync(path.join(os.tmpdir(), `pack-smoke-${name}-`));
    try {
      const versions = smoke(name, tarball, app);
      const seconds = Math.round((Date.now() - started) / 1000);
      console.log(`${name}: ok in ${seconds} s${versions.length ? `, beside ${versions.join(', ')}` : ''}`);
    } catch (error) {
      failed.push(name);
      console.error(`${name}: FAILED, app left in ${app}\n${indented(described(error))}`);
      continue;
    }
    // Retried because Windows can hold a file for a moment after the process that used it has gone.
    fs.rmSync(app, { recursive: true, force: true, maxRetries: 5 });
  }

  if (failed.length) {
    console.error(`Failed: ${failed.join(', ')}. The tarball is ${tarball}`);
    process.exitCode = 1;
  } else if (values.tarball === undefined) {
    fs.rmSync(path.dirname(tarball), { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(described(error));
  process.exitCode = 1;
}
