// Builds apps/next-demo the way `enabled` leaves it out, once with the next-client line in its
// instrumentation-client and once without it, and fails when the line brings the library into the build.
// On Next.js 15.3 to 16.2 that line is in every build, and a run withInpBlame leaves out sets
// REACT_INP_BLAME_NEXT to '' so that the bundler can fold the module to nothing. That fold is easy to lose
// (next-client caching the value in a variable is enough under webpack), and no other check would see it:
// every suite passes either way, and scripts/size.mjs measures /auto with a bundler that folds regardless.
//
//   INP_BUNDLER=webpack node scripts/next-left-out.mjs      # next build --webpack
//   INP_BUNDLER=turbopack node scripts/next-left-out.mjs    # next build --turbopack
//   node scripts/next-left-out.mjs                          # the bundler the installed Next.js defaults to
//
// It needs `npm run build` first, since the app resolves react-inp-blame to packages/core/dist, and the line
// in apps/next-demo/instrumentation-client.ts, as the next-older job in CI writes it. The file is moved aside
// for the second build and put back after it. Each build deletes apps/next-demo/.next first.
//
// Plain JavaScript on Node's own modules, like pack-smoke.mjs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'packages/core/dist');
const app = path.join(root, 'apps/next-demo');
// The name install() gives its debug global by default, in dist/index.js. A string, so it survives the
// minifier, and nothing but the library's own code holds it.
const MARKER = '__REACT_INP_BLAME__';
const LINE_MODULE = 'react-inp-blame/next-client';
// What the line may add, gzipped: the empty onRouterTransitionStart and the module's wrapping, which came
// to 74 B under webpack and 214 B under Turbopack on 16.3.5. The library it brought before was over 60 KB,
// with a copy in each client entry.
const ALLOWED = 2048;
// Next.js 15 bundles with webpack unless asked for Turbopack, and 16 the other way round, as in the app's
// playwright.config.ts.
const FLAG = process.env.INP_BUNDLER === 'webpack' ? ' --webpack' : process.env.INP_BUNDLER === 'turbopack' ? ' --turbopack' : '';

/** Every file under `dir`, recursively, whose name ends with `ext`. */
function filesUnder(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile() && entry.name.endsWith(ext)).map((entry) => path.join(entry.parentPath, entry.name));
}

/** The instrumentation-client Next.js would use in the app, src/ first, or null when it has none. */
function clientFile() {
  for (const sub of ['src', '']) {
    for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs']) {
      const file = path.join(app, sub, `instrumentation-client.${ext}`);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

/** Builds the app with the library left out, and what its page scripts come to: gzipped bytes, and the files holding the marker. */
function build(what) {
  fs.rmSync(path.join(app, '.next'), { recursive: true, force: true });
  const command = `npx next build${FLAG}`;
  console.log(`\n> ${command}, ${what}`);
  // npx goes through the shell: on Windows it is a .cmd, which Node refuses to spawn without one.
  const { status, error } = spawnSync(command, [], { cwd: app, shell: true, stdio: 'inherit', env: { ...process.env, INP_LEFT_OUT: '1' } });
  if (status !== 0) throw new Error(`${command} exited ${status}${error ? `: ${error.message}` : ''}`);
  const statics = path.join(app, '.next/static');
  let bytes = 0;
  const marked = [];
  for (const file of filesUnder(statics, '.js')) {
    const source = fs.readFileSync(file);
    bytes += zlib.gzipSync(source, { level: 9 }).length;
    if (source.includes(MARKER)) marked.push(path.relative(statics, file).split(path.sep).join('/'));
  }
  console.log(`${what}: ${bytes} B gzipped, the library's marker in ${marked.length ? marked.join(', ') : 'no file'}`);
  return { bytes, marked };
}

// A marker the library no longer has would pass every build below, so the check would prove nothing.
if (!filesUnder(dist, '.js').some((file) => fs.readFileSync(file, 'utf8').includes(MARKER))) {
  console.error(`next-left-out: no file in packages/core/dist holds ${MARKER}. Run npm run build first, or name the global install() creates now.`);
  process.exit(1);
}
const file = clientFile();
if (!file || !fs.readFileSync(file, 'utf8').includes(LINE_MODULE)) {
  console.error(`next-left-out: apps/next-demo has no instrumentation-client that loads ${LINE_MODULE}. Write the line there first, as CI does.`);
  process.exit(1);
}
const next = createRequire(path.join(app, 'package.json'))('next/package.json').version;

const withLine = build('with the line');
const aside = `${file}.left-out-check`;
fs.renameSync(file, aside);
let withoutLine;
try {
  withoutLine = build('without it');
} finally {
  fs.renameSync(aside, file);
}

const added = withLine.bytes - withoutLine.bytes;
const bundler = FLAG ? FLAG.slice(3) : 'its default bundler';
console.log(`\nNext.js ${next}, ${bundler}: the line adds ${added} B gzipped to a build withInpBlame leaves out.`);
const problems = [];
if (withLine.marked.length > 0 && withoutLine.marked.length === 0) {
  problems.push(`The line brings the library into the build: ${MARKER} is in ${withLine.marked.join(', ')}, and in no file without the line.`);
}
if (added > ALLOWED) problems.push(`That is over the ${ALLOWED} B the empty module may cost.`);
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
