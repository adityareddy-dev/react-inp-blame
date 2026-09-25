// The README's bundle size table, as scripts/size.mjs writes and checks it. Kept apart from the script so
// the unit tests can read and write a table without building anything.

export const START = '<!-- size:start -->';
export const END = '<!-- size:end -->';

/** Bytes as the table gives them: kilobytes of 1000 bytes, as Vite prints them, to one decimal. */
export const kb = (bytes) => (bytes / 1000).toFixed(1);

/**
 * The table for `rows`, each `{ label, minified, gzip }` in bytes, between the markers. `tool` names the
 * bundler and its version, which the heading says the sizes were measured with.
 */
export function formatTable(rows, tool) {
  const lines = [
    START,
    `| Bundle (${tool}, minified ESM, gzip at zlib's default level) | Minified | Gzip |`,
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.label} | ${kb(row.minified)} KB | ${kb(row.gzip)} KB |`),
    END,
  ];
  return lines.join('\n');
}

/** The rows of the table between the markers in `readme`, as `{ label, minified, gzip }` in kilobytes; null without the markers. */
export function parseTable(readme) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start) return null;
  const rows = [];
  for (const line of readme.slice(start + START.length, end).split('\n')) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const match = cells.length === 3 && /^([\d.]+) KB$/.exec(cells[1]) && /^([\d.]+) KB$/.exec(cells[2]);
    if (!match) continue;
    rows.push({ label: cells[0], minified: Number.parseFloat(cells[1]), gzip: Number.parseFloat(cells[2]) });
  }
  return rows;
}

/** `readme` with the table between the markers replaced by `table`. */
export function replaceTable(readme, table) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start) throw new Error(`README.md has no ${START} ... ${END} block for the size table`);
  return readme.slice(0, start) + table + readme.slice(end + END.length);
}

/** The table between the markers in `readme`, markers included, as written; null without them. */
export function writtenTable(readme) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  return start < 0 || end < start ? null : readme.slice(start, end + END.length);
}

/**
 * What is wrong with the README's table against what was measured, and against the budget. The table has to
 * be exactly what `--write` would put there, so a row a tenth of a kilobyte off is stale too, and so is a
 * heading that names another bundler version. A gzipped size over its budget is a problem of its own.
 * `tool` is the bundler and its version, as `formatTable` takes it. Empty when all is well.
 */
export function problems(readme, measured, budget, tool) {
  const readmeRows = parseTable(readme);
  if (!readmeRows) return ['README.md has no size table between the markers'];
  const stale = [];
  const over = [];
  for (const row of measured) {
    const written = readmeRows.find((r) => r.label === row.label);
    const minified = Number(kb(row.minified));
    const gzip = Number(kb(row.gzip));
    if (!written) stale.push(`README.md has no row for ${row.label}`);
    else if (written.minified !== minified || written.gzip !== gzip) {
      stale.push(`${row.label}: README.md says ${written.minified} / ${written.gzip} KB, the build is ${minified} / ${gzip} KB`);
    }
    const limit = budget[row.key];
    if (limit !== undefined && gzip > limit) over.push(`${row.label}: ${gzip} KB gzipped is over its budget of ${limit} KB`);
  }
  if (readmeRows.length !== measured.length) stale.push(`README.md's table has ${readmeRows.length} rows, the script measures ${measured.length}`);
  // Every row matches and the table still differs: the heading, or how it is laid out.
  if (!stale.length && writtenTable(readme) !== formatTable(measured, tool)) stale.push("README.md's table is not what --write writes: its heading or its layout differs");
  return [...stale, ...over];
}
