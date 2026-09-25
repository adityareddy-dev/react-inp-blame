import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a plain .mjs script, which has no types.
import { END, formatTable, parseTable, problems, replaceTable, START } from '../../../scripts/size-table.mjs';

const rows = [
  { key: 'auto', label: '`/auto`', minified: 59_012, gzip: 21_180 },
  { key: 'overlay', label: 'The badge', minified: 12_849, gzip: 4_772 },
];

test('the size table is written between its markers and read back to the tenth of a kilobyte', () => {
  const table = formatTable(rows, 'rolldown 1.2.8');
  assert.ok(table.startsWith(START) && table.endsWith(END));
  assert.match(table, /\| `\/auto` \| 59\.0 KB \| 21\.2 KB \|/);
  const readme = `# Title\n\nBefore.\n\n${START}\nold table\n${END}\n\nAfter.\n`;
  const written = replaceTable(readme, table);
  assert.ok(written.startsWith('# Title\n\nBefore.\n\n') && written.endsWith('\n\nAfter.\n'));
  assert.deepEqual(parseTable(written), [
    { label: '`/auto`', minified: 59, gzip: 21.2 },
    { label: 'The badge', minified: 12.8, gzip: 4.8 },
  ]);
  assert.equal(parseTable('# No table here'), null);
  assert.throws(() => replaceTable('# No table here', table), /no <!-- size:start -->/);
});

test('the check fails on a stale row, a missing one and a size over budget, and passes within 0.1 KB', () => {
  const current = parseTable(formatTable(rows, 'rolldown 1.2.8'));
  assert.deepEqual(problems(current, rows, { auto: 22.5, overlay: 5.5 }), []);
  // 0.1 KB either way is rounding, not a change.
  assert.deepEqual(problems(current, [{ ...rows[0]!, minified: 59_100 }, rows[1]!], {}), []);
  assert.match(problems(current, [{ ...rows[0]!, minified: 61_000 }, rows[1]!], {}).join('\n'), /`\/auto`: README.md says 59 \/ 21.2 KB, the build is 61 \/ 21.2 KB/);
  assert.match(problems(current, rows, { auto: 20 }).join('\n'), /21.2 KB gzipped is over its budget of 20 KB/);
  assert.match(problems(current, [...rows, { key: 'more', label: 'More', minified: 1000, gzip: 500 }], {}).join('\n'), /README.md has no row for More/);
  assert.deepEqual(problems(null, rows, {}), ['README.md has no size table between the markers']);
});
