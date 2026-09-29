import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a plain .mjs script, which has no types.
import { committed, differences, snapshot } from '../../../scripts/api-snapshot.mjs';

test('the types every entry point publishes are the ones committed in api/', () => {
  const current: Map<string, string> = snapshot();
  // Every entry of the exports map is in it, and what they import.
  for (const name of ['index.d.ts', 'auto.d.ts', 'next-client.d.ts', 'web-vitals.d.ts', 'types.d.ts', 'next.d.cts', 'vite.d.mts', 'astro.d.mts', 'display-names-loader.d.cts']) {
    assert.ok(current.has(name), `${name} is in the snapshot`);
  }
  assert.ok(![...current.values()].some((text) => text.includes('/**')), 'comments are left out');
  const found = differences(current, committed());
  assert.deepEqual(found, [], `${found.join('\n')}\n\nIf the change is meant, run node scripts/api-snapshot.mjs --write and commit api/.`);
});

test('a type that changed, a file that came and one that went are each named, and line endings are not a change', () => {
  const saved = new Map([
    ['index.d.ts', 'export declare function install(): Api;\r\n'],
    ['types.d.ts', 'export type Rating = "good";\n'],
    ['gone.d.ts', 'export {};\n'],
  ]);
  const current = new Map([
    ['index.d.ts', 'export declare function install(): Api;\n'],
    ['types.d.ts', 'export type Rating = "good" | "poor";\n'],
    ['otel.d.ts', 'export {};\n'],
  ]);
  assert.deepEqual(differences(current, saved), ['types.d.ts differs from api/types.d.ts', 'otel.d.ts is published and not in api/', 'api/gone.d.ts is no longer published']);
});
