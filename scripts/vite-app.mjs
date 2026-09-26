// Runs an app from fixtures/ the way a user has it: fixtures/vite-react-ts, the app `npm create vite --
// --template react-ts` makes with the vite.config.ts from docs/install.md pasted in, or with `--fixture` one of the
// frameworks that write their own HTML, each from its own template with the setup docs/install.md gives it. The
// script copies it out of the repo into the temp directory and installs its dependencies there from its
// own lockfile, with react-inp-blame from the tarball `npm pack` makes. It then builds the app and runs its
// Playwright specs on the dev server (for the Vite app, a Fast Refresh edit included) and on the build.
//
//   node scripts/vite-app.mjs                          # pack packages/core, then install and test
//   node scripts/vite-app.mjs --tarball <path>         # a tarball that already exists
//   node scripts/vite-app.mjs --fresh                  # no lockfile: every dependency as npm resolves it today
//   node scripts/vite-app.mjs --fixture react-router   # the React Router app, or tanstack-start, remix, astro, ...
//   node scripts/vite-app.mjs --pnpm                   # installed with pnpm, in the node_modules it makes by default
//   node scripts/vite-app.mjs -- --project=dev         # anything after -- goes to Playwright
//
// The copy is what makes it the user's install. Inside the repo the app could resolve react-inp-blame
// through the workspace link or the monorepo's node_modules, and would never see the package as npm
// hands it over: only what `files` lets in, reached through its exports map.
//
// With --pnpm the app is installed by the pnpm on the PATH instead. Its default node_modules is isolated:
// the app's folder holds only what its package.json names, each a link into node_modules/.pnpm, where a
// package finds only what it declares. The versions are still the ones in the fixture's npm lockfile,
// which `pnpm import` turns into pnpm's own before the install.
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
const PACKAGE = 'react-inp-blame';
/**
 * What differs between the apps. `readme` is the heading whose code blocks the fixture's `files` must
 * match, each block found by its first line, a comment that starts with the file's path. `reported` is
 * printed after the install, so a failure says which releases it happened with. `typecheck` checks what
 * the build leaves out: the specs and playwright.config.ts, which Playwright runs without checking.
 */
const FIXTURES = {
  'vite-react-ts': {
    readme: '## Install with Vite',
    files: ['vite.config.ts'],
    reported: ['vite', '@vitejs/plugin-react', 'react', 'react-dom', 'typescript', '@playwright/test', PACKAGE],
    typecheck: (app) => run('tsc -p tsconfig.e2e.json', process.execPath, [path.join(app, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.e2e.json'], { cwd: app }),
  },
  'react-router': {
    readme: '## Install with React Router',
    files: ['vite.config.ts'],
    reported: ['react-router', '@react-router/dev', 'vite', 'react', 'react-dom', 'typescript', '@playwright/test', PACKAGE],
    // The template's own check, route types first. Its tsconfig takes in every file, the specs included.
    typecheck: (app) => npm('run typecheck', app),
  },
  // React Router 7 on React 18, where the main react-dom module connects to the DevTools hook as it loads
  // and a route module can load it before the client entry does. The README's config holds there too.
  'react-router-7': {
    readme: '## Install with React Router',
    files: ['vite.config.ts'],
    reported: ['react-router', '@react-router/dev', 'vite', 'react', 'react-dom', 'typescript', '@playwright/test', PACKAGE],
    typecheck: (app) => npm('run typecheck', app),
  },
  'tanstack-start': {
    readme: '## Install with TanStack Start',
    files: ['vite.config.ts', 'src/client.tsx'],
    reported: ['@tanstack/react-start', '@tanstack/react-router', 'vite', '@vitejs/plugin-react', 'react', 'react-dom', 'typescript', '@playwright/test', PACKAGE],
    // The template has no check of its own. Its tsconfig takes in every file, the specs and the route tree
    // the build generates included.
    typecheck: (app) => run('tsc -p tsconfig.json', process.execPath, [path.join(app, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: app }),
  },
  // The create-vite app on Vite 7 (Rollup) and React 18 with a manualChunks rule sending node_modules to one
  // vendor chunk: the build where the page's install used to run after react-dom. No README block of its own.
  'vite-vendor-chunk': {
    readme: '## Install with Vite',
    files: [],
    reported: ['vite', '@vitejs/plugin-react', 'react', 'react-dom', 'typescript', '@playwright/test', PACKAGE],
    typecheck: (app) => run('tsc -p tsconfig.e2e.json', process.execPath, [path.join(app, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.e2e.json'], { cwd: app }),
  },
  // The same app on Vite 8 (Rolldown) with a codeSplitting group sending node_modules to one vendor chunk,
  // and Radix's Portal, which imports react-dom, in the page: the vendor chunk runs react-dom as it loads.
  // The library used to sit there too, so on React 18 the install ran after react-dom. No README block.
  'vite-vendor-groups': {
    readme: '## Install with Vite',
    files: [],
    reported: ['vite', 'rolldown', '@vitejs/plugin-react', 'react', 'react-dom', '@radix-ui/react-portal', 'typescript', '@playwright/test', PACKAGE],
    typecheck: (app) => run('tsc -p tsconfig.e2e.json', process.execPath, [path.join(app, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.e2e.json'], { cwd: app }),
  },
  // The Vite app with styled-components, @emotion/styled, lucide-react and Radix's DropdownMenu, whose own
  // components used to be what a report named. Its config adds debugGlobal to the README's, so no block.
  'component-libraries': {
    readme: '## Install with Vite',
    files: [],
    reported: ['vite', '@vitejs/plugin-react', 'react', 'react-dom', 'styled-components', '@emotion/styled', 'lucide-react', '@radix-ui/react-dropdown-menu', '@playwright/test', PACKAGE],
    typecheck: (app) => run('tsc -p tsconfig.e2e.json', process.execPath, [path.join(app, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.e2e.json'], { cwd: app }),
  },
  // Next.js 14.2, which has no instrumentation-client: withInpBlame installs through webpack's client entries.
  'next-14': {
    readme: '## Install with Next.js 14.2 or later',
    files: [],
    reported: ['next', 'react', 'react-dom', 'typescript', '@playwright/test', PACKAGE],
    typecheck: (app) => run('tsc -p tsconfig.json', process.execPath, [path.join(app, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: app }),
  },
  // webpack 5 and babel-loader on React 18.3, set up as the README's webpack paragraph says, with a vendor chunk
  // holding react-dom and the library. The README has no block for it: the setup is one import and one rule.
  webpack: {
    readme: '## Install with Vite',
    files: [],
    reported: ['webpack', 'webpack-dev-server', 'babel-loader', '@babel/core', 'react', 'react-dom', 'typescript', '@playwright/test', PACKAGE],
    typecheck: (app) => run('tsc -p tsconfig.json', process.execPath, [path.join(app, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: app }),
  },
  // Remix 2, on the React 18 its template brings. @remix-run/react imports react-router-dom, which imports
  // react-dom, so the root route loads react-dom before the client entry does.
  remix: {
    readme: '## Install with Remix',
    files: ['vite.config.ts'],
    reported: ['@remix-run/react', '@remix-run/dev', 'vite', 'react', 'react-dom', 'typescript', '@playwright/test', PACKAGE],
    typecheck: (app) => npm('run typecheck', app),
  },
  astro: {
    readme: '## Install with Astro',
    files: ['astro.config.mjs'],
    reported: ['astro', '@astrojs/react', 'vite', 'react', 'react-dom', 'typescript', '@playwright/test', PACKAGE],
    // `astro check`, which the template suggests: the .astro page as well as the islands, the specs and the config.
    typecheck: (app) => npm('run check', app),
  },
};
// Left behind by a run in the fixture folder itself, and not part of the app.
const NOT_COPIED = new Set(['node_modules', 'dist', 'build', '.react-router', '.astro', '.next', '.next-dev', 'test-results', 'playwright-report']);

const quoted = (text) => `"${text}"`;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
/** CRLF from a Windows checkout and trailing spaces are not a difference anyone meant. */
const normalized = (text) =>
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    // Comments lined up in a column are the same code with the spaces before them changed.
    .map((line) => line.trimEnd().replace(/(\S)\s+\/\/ /, '$1 // '))
    .join('\n')
    .trimEnd();

/**
 * The README's block as the README says to keep it in production: `enabled: true`, with the overlay only on
 * request. CI builds the framework apps for production too, so their config is this form of the block.
 */
function forProduction(block) {
  return block.replace(/^(\s*)runtime: \{ overlay: true \},.*$/m, (_, indent) => {
    const quote = block.includes('"react-inp-blame/') ? '"' : "'";
    return (
      `${indent}enabled: true, // production builds too; the default is development only\n` +
      `${indent}runtime: { overlay: ${quote}query${quote} }, // the badge only on request, such as ?inp-blame in the URL`
    );
  });
}

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
/** pnpm, through the shell for the same reason. */
const pnpm = (command, cwd) => run(`pnpm ${command}`, `pnpm ${command}`, [], { cwd, shell: true });

/** The pnpm on the PATH, for the log, so a failure says which one installed the app. */
function pnpmVersion() {
  const { status, stdout } = spawnSync('pnpm --version', [], { shell: true, encoding: 'utf8' });
  assert.ok(status === 0, '--pnpm needs pnpm on the PATH, for example from `npm install --global pnpm`');
  return stdout.trim();
}

/** The ```ts, ```tsx or ```js block under `heading` in docs/install.md whose first line is a comment naming `file`. */
function readmeBlock(heading, file) {
  const readme = fs.readFileSync(path.join(root, 'docs/install.md'), 'utf8').replace(/\r\n/g, '\n');
  const section = readme.indexOf(`\n${heading}\n`);
  assert.ok(section !== -1, `docs/install.md has no "${heading}" heading, which scripts/vite-app.mjs reads the fixture's ${file} from`);
  const next = readme.indexOf('\n## ', section + 1);
  const blocks = readme.slice(section, next === -1 ? undefined : next).matchAll(/\n```(?:tsx?|js)\n([\s\S]*?)\n```/g);
  const block = [...blocks].find(([, code]) => {
    const first = code.split('\n', 1)[0];
    return first === `// ${file}` || first.startsWith(`// ${file},`);
  });
  assert.ok(block, `docs/install.md has no \`\`\`ts or \`\`\`js block under "${heading}" that starts with the comment // ${file}`);
  return block[1];
}

/** What has to hold before anything is installed, so a drift is named for the file that has to change. */
function guards(name) {
  const { readme, files } = FIXTURES[name];
  const fixture = path.join(root, 'fixtures', name);
  const own = readJson(path.join(fixture, 'package.json')).devDependencies['@playwright/test'];
  const demo = readJson(path.join(root, 'apps/demo/package.json')).devDependencies['@playwright/test'];
  assert.ok(
    own === demo,
    `fixtures/${name}/package.json pins @playwright/test ${own} and apps/demo ${demo}. Change the fixture's to ${demo} and refresh its lock with \`npm install --package-lock-only\` in that folder, so both use the browsers CI installs.`,
  );
  for (const file of files) {
    const code = fs.readFileSync(path.join(fixture, file), 'utf8');
    const block = readmeBlock(readme, file);
    assert.ok(
      normalized(code) === normalized(block) || normalized(code) === normalized(forProduction(block)),
      `fixtures/${name}/${file} is not the ${file} block under "${readme}" in docs/install.md. Copy the block into the fixture, so the fixture tests what users paste.`,
    );
  }
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
 * The app's top-level packages from pnpm are links into node_modules/.pnpm, one for each dependency its
 * package.json names and nothing more: the layout where a package that imports what it never declared
 * fails, as it would for a pnpm user. pnpm names the folder of a package it took from a file after the
 * file, so the link's target also says the library came from the tarball.
 */
function assertIsolated(app) {
  const modules = fs.realpathSync(path.join(app, 'node_modules'));
  const link = path.join(modules, PACKAGE);
  const stat = fs.lstatSync(link, { throwIfNoEntry: false });
  assert.ok(stat?.isSymbolicLink(), `node_modules/${PACKAGE} in ${app} is not a link into node_modules/.pnpm, so pnpm did not lay out an isolated node_modules`);
  const target = fs.realpathSync(link);
  assert.ok(
    target.startsWith(path.join(modules, '.pnpm', `${PACKAGE}@file+`)),
    `pnpm installed ${PACKAGE} at ${target}, not from the tarball into node_modules/.pnpm`,
  );
  const manifest = readJson(path.join(app, 'package.json'));
  const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }));
  const top = fs
    .readdirSync(modules)
    .filter((name) => !name.startsWith('.'))
    .flatMap((name) => (name.startsWith('@') ? fs.readdirSync(path.join(modules, name)).map((inner) => `${name}/${inner}`) : [name]));
  const undeclared = top.filter((name) => !declared.has(name));
  assert.ok(
    undeclared.length === 0,
    `pnpm put ${undeclared.join(', ')} in the app's node_modules, which its package.json does not name, so the layout is not the isolated one`,
  );
}

/**
 * The same install through pnpm. pnpm reads no npm lockfile, so `pnpm import` writes pnpm's own from the
 * fixture's first, and the app gets the versions npm locked. `pnpm add` then puts the tarball in place of
 * the registry's react-inp-blame. It has no --no-save, so it writes the path into the copy's package.json,
 * which is thrown away after the run.
 */
function pnpmInstall(app, tarball, fresh) {
  if (!fresh) pnpm('import', app);
  fs.rmSync(path.join(app, 'package-lock.json'));
  pnpm(`add ${quoted(tarball)}`, app);
}

/**
 * The package the app got has to be the tarball. The version alone cannot say so while the registry has
 * the same one, so it is also where npm says it came from, and that it is a folder rather than a link.
 * From pnpm it is a link, and where it leads says the same.
 */
function assertTarballInstalled(app, withPnpm) {
  const dir = path.join(app, 'node_modules', PACKAGE);
  if (withPnpm) {
    assertIsolated(app);
  } else {
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    assert.ok(stat?.isDirectory() && !stat.isSymbolicLink(), `node_modules/${PACKAGE} in ${app} is not a folder npm unpacked`);
    const entry = readJson(path.join(app, 'node_modules/.package-lock.json')).packages[`node_modules/${PACKAGE}`];
    assert.ok(entry?.resolved?.startsWith('file:'), `npm installed ${PACKAGE} from ${entry?.resolved}, not from the tarball`);
  }
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
  const { values } = parseArgs({
    args: own,
    options: {
      tarball: { type: 'string' },
      fresh: { type: 'boolean', default: false },
      fixture: { type: 'string', default: 'vite-react-ts' },
      pnpm: { type: 'boolean', default: false },
    },
  });
  const name = values.fixture;
  assert.ok(Object.hasOwn(FIXTURES, name), `--fixture is ${Object.keys(FIXTURES).join(' or ')}, not ${name}`);
  const fixture = path.join(root, 'fixtures', name);

  guards(name);
  const installer = values.pnpm ? `, installed with pnpm ${pnpmVersion()}` : '';
  const tarball = values.tarball === undefined ? pack() : path.resolve(values.tarball);
  assert.ok(fs.existsSync(tarball), `${tarball} does not exist`);

  const app = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  console.log(`${path.basename(tarball)} into ${app}, the app in fixtures/${name}${values.fresh ? ', dependencies resolved today' : ''}, on Node ${process.version}${installer}`);
  try {
    fs.cpSync(fixture, app, { recursive: true, filter: (source) => !NOT_COPIED.has(path.basename(source)) });
    if (values.pnpm) {
      pnpmInstall(app, tarball, values.fresh);
    } else if (values.fresh) {
      // One install of everything, as a new app gets it on the day this runs.
      fs.rmSync(path.join(app, 'package-lock.json'));
      npm(`install --no-audit --no-fund ${quoted(tarball)}`, app);
    } else {
      npm('ci --no-audit --no-fund', app);
      // In place of the registry's react-inp-blame, leaving the app's package.json and lock as they were.
      npm(`install --no-save --no-audit --no-fund ${quoted(tarball)}`, app);
    }
    assertTarballInstalled(app, values.pnpm);
    const versions = FIXTURES[name].reported.map((name) => `${name} ${readJson(path.join(app, 'node_modules', name, 'package.json')).version}`);
    console.log(`\nInstalled: ${versions.join(', ')}`);

    // A step of its own, so a type error in the README's config reads as one.
    (values.pnpm ? pnpm : npm)('run build', app);
    FIXTURES[name].typecheck(app);
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
