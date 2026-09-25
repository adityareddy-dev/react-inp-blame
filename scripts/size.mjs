// What the library costs a page to download, measured on packages/core/dist, and the README's table of it.
//
//   npm run build && node scripts/size.mjs            # print the sizes
//   node scripts/size.mjs --write                     # and write them into README.md's table
//   node scripts/size.mjs --check                     # fail when the table is stale or a size is over budget
//
// Each bundle is built with the rolldown the repo has, for the browser, as minified ESM, and gzipped at
// zlib's default level. The budgets, in gzipped kilobytes, are in scripts/size-budget.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import zlib from 'node:zlib';
import { rolldown } from 'rolldown';
import { formatTable, parseTable, problems, replaceTable } from './size-table.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'packages/core/dist');
const README = path.join(root, 'README.md');
const BEFORE = '\0size:before-react-dom';
// What has to run before react-dom loads: the DevTools hook and what it calls as React registers and
// commits. Every export is kept, so this is the most of it a page can get.
const BEFORE_MODULES = ['hook', 'fiber', 'observe', 'session', 'version', 'warn'];

const ROWS = [
  { key: 'auto', label: '`react-inp-blame/auto`: everything that loads with the page', input: { auto: path.join(dist, 'auto.js') }, part: 'entry' },
  { key: 'overlay', label: 'The badge and panel, a chunk loaded by `import()` only when shown', input: { auto: path.join(dist, 'auto.js') }, part: 'dynamic' },
  {
    key: 'before',
    label: 'Of `/auto`, what has to run before react-dom: the hook, the fiber reading, the observers',
    input: { before: BEFORE },
    part: 'entry',
  },
  {
    key: 'web-vitals',
    label: '`react-inp-blame/web-vitals`, on top of `/auto`',
    input: { auto: path.join(dist, 'auto.js'), 'web-vitals': path.join(dist, 'web-vitals.js') },
    part: 'web-vitals',
  },
];

/** The chunks of one build, by file name. */
async function build(input) {
  const bundle = await rolldown({
    input,
    platform: 'browser',
    logLevel: 'silent',
    plugins: [
      {
        name: 'before-react-dom',
        resolveId: (id) => (id === BEFORE ? id : null),
        load: (id) => (id === BEFORE ? BEFORE_MODULES.map((m) => `export * from ${JSON.stringify(path.join(dist, `${m}.js`))};`).join('\n') : null),
      },
    ],
  });
  try {
    const { output } = await bundle.generate({ format: 'es', minify: true });
    return new Map(output.filter((o) => o.type === 'chunk').map((chunk) => [chunk.fileName, chunk]));
  } finally {
    await bundle.close();
  }
}

/** The chunks a row counts: an entry and what it imports, the chunks only `import()` reaches, or the web-vitals entry's own. */
function counted(chunks, part) {
  const entries = [...chunks.values()].filter((c) => c.isEntry);
  if (part === 'web-vitals') return entries.filter((c) => c.name === 'web-vitals');
  const reached = new Set();
  const pending = entries.map((c) => c.fileName);
  while (pending.length) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    pending.push(...(chunks.get(file)?.imports ?? []));
  }
  const statics = [...reached].map((file) => chunks.get(file));
  return part === 'entry' ? statics : [...chunks.values()].filter((c) => !reached.has(c.fileName));
}

async function measure() {
  const rows = [];
  for (const row of ROWS) {
    const chunks = counted(await build(row.input), row.part);
    if (!chunks.length) throw new Error(`${row.label}: the build made no chunk to measure`);
    const code = chunks.map((c) => c.code);
    rows.push({
      key: row.key,
      label: row.label,
      minified: code.reduce((a, c) => a + Buffer.byteLength(c), 0),
      gzip: code.reduce((a, c) => a + zlib.gzipSync(c).length, 0),
    });
  }
  return rows;
}

async function main() {
  const { values } = parseArgs({ options: { write: { type: 'boolean', default: false }, check: { type: 'boolean', default: false } } });
  if (!fs.existsSync(path.join(dist, 'auto.js'))) throw new Error('packages/core/dist has no auto.js: run npm run build first');
  const rolldownVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/rolldown/package.json'), 'utf8')).version;
  const rows = await measure();
  const table = formatTable(rows, `rolldown ${rolldownVersion}`);
  console.log(table);
  const readme = fs.readFileSync(README, 'utf8');
  if (values.write) {
    fs.writeFileSync(README, replaceTable(readme, table));
    console.log('\nREADME.md updated.');
  }
  if (values.check) {
    const budget = JSON.parse(fs.readFileSync(path.join(root, 'scripts/size-budget.json'), 'utf8'));
    const found = problems(parseTable(readme), rows, budget);
    if (found.length) {
      console.error(`\n${found.join('\n')}\n\nRun \`npm run build && node scripts/size.mjs --write\` and commit README.md, or look at what made the bundle grow.`);
      process.exitCode = 1;
    }
  }
}

await main();
