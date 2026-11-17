import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a plain .mjs script, which has no types.
import { END, formatTable, parseTable, problems, replaceTable, START } from '../../../scripts/size-table.mjs';

const rows = [
  { key: 'auto', label: '`/auto`', minified: 59_012, gzip: 21_180 },
  { key: 'overlay', label: 'The badge', minified: 12_849, gzip: 4_772 },
];

for (const lineEnding of ['\n', '\r\n']) {
  test(`the size table is written between its markers and read back to the tenth of a kilobyte (${lineEnding === '\n' ? 'LF' : 'CRLF'})`, () => {
    const tool = 'rolldown 1.2.8';
    const table = formatTable(rows, tool);
    assert.ok(table.startsWith(START) && table.endsWith(END));
    assert.match(table, /\| `\/auto` \| 59\.0 KB \| 21\.2 KB \|/);
    const before = `# Title${lineEnding}${lineEnding}Before.${lineEnding}${lineEnding}`;
    const after = `${lineEnding}${lineEnding}After.${lineEnding}`;
    const readme = `${before}${START}${lineEnding}old table${lineEnding}${END}${after}`;
    const written = replaceTable(readme, table);
    assert.equal(written.slice(0, before.length), before);
    assert.equal(written.slice(-after.length), after);
    if (lineEnding === '\r\n') {
      assert.equal(written.replaceAll('\r\n', '').includes('\n'), false);
    } else {
      assert.equal(written.includes('\r\n'), false);
    }
    assert.deepEqual(problems(written, rows, tool), []);
    assert.deepEqual(parseTable(written), [
      { label: '`/auto`', minified: 59, gzip: 21.2 },
      { label: 'The badge', minified: 12.8, gzip: 4.8 },
    ]);
    assert.equal(parseTable('# No table here'), null);
    assert.throws(() => replaceTable('# No table here', table), /no <!-- size:start -->/);
  });
}

for (const lineEnding of ['\n', '\r\n']) {
  test(`the check accepts ${lineEnding === '\n' ? 'LF' : 'CRLF'} tables without relaxing stale checks`, () => {
    const tool = 'rolldown 1.2.8';
    const readme = (table: string) => `# Title\n\n${table}\n`;
    const current = readme(formatTable(rows, tool)).replaceAll('\n', lineEnding);
    assert.deepEqual(problems(current, rows, tool), []);
    // A tenth of a kilobyte is a stale table too: 59.0 written where the build is 59.1.
    assert.match(problems(current, [{ ...rows[0]!, minified: 59_100 }, rows[1]!], tool).join('\n'), /`\/auto`: README.md says 59 \/ 21.2 KB, the build is 59.1 \/ 21.2 KB/);
    assert.match(problems(current, [{ ...rows[0]!, minified: 61_000 }, rows[1]!], tool).join('\n'), /`\/auto`: README.md says 59 \/ 21.2 KB, the build is 61 \/ 21.2 KB/);
    // Every size right, and the heading names another bundler version.
    assert.deepEqual(problems(current, rows, 'rolldown 1.3.0'), ["README.md's table is not what --write writes: its heading or its layout differs"]);
    assert.match(problems(current, [...rows, { key: 'more', label: 'More', minified: 1000, gzip: 500 }], tool).join('\n'), /README.md has no row for More/);
    assert.deepEqual(problems(current.replace('| --- | --- | --- |', '|---|---|---|'), rows, tool), ["README.md's table is not what --write writes: its heading or its layout differs"]);
    assert.deepEqual(problems('# No table here', rows, tool), ['README.md has no size table between the markers']);
  });
}
