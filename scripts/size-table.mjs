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

// More than 0.1 KB apart, as the tenths the table holds compare: 59.1 and 59.0 are not.
const off = (a, b) => Math.abs(Math.round(a * 10) - Math.round(b * 10)) > 1;

/**
 * What is wrong with the README's table against what was measured, and against the budget: a row missing
 * or off by more than 0.1 KB, or a gzipped size over its budget. Empty when all is well.
 */
export function problems(readmeRows, measured, budget) {
  const out = [];
  if (!readmeRows) return ['README.md has no size table between the markers'];
  for (const row of measured) {
    const written = readmeRows.find((r) => r.label === row.label);
    const minified = Number(kb(row.minified));
    const gzip = Number(kb(row.gzip));
    if (!written) out.push(`README.md has no row for ${row.label}`);
    else if (off(written.minified, minified) || off(written.gzip, gzip)) {
      out.push(`${row.label}: README.md says ${written.minified} / ${written.gzip} KB, the build is ${minified} / ${gzip} KB`);
    }
    const limit = budget[row.key];
    if (limit !== undefined && gzip > limit) out.push(`${row.label}: ${gzip} KB gzipped is over its budget of ${limit} KB`);
  }
  if (readmeRows.length !== measured.length) out.push(`README.md's table has ${readmeRows.length} rows, the script measures ${measured.length}`);
  return out;
}
