// schedule.test.mjs: the overhead run order matches the protocol's block design.
//
//   node --test schedule.test.mjs      # or npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockSchedule, permutations } from './schedule.mjs';

const CONFIGS = ['A', 'B', 'C'];

test('there are six permutations of A, B and C', () => {
  const perms = permutations(CONFIGS).map((p) => p.join(''));
  assert.deepEqual([...perms].sort(), ['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA']);
});

test('five blocks give 30 paired slots, each configuration once per slot', () => {
  const slots = blockSchedule('actual', 'x1', 5, CONFIGS);
  assert.equal(slots.length, 30);
  assert.deepEqual([...new Set(slots.map((s) => s.runIndex))].sort((a, b) => a - b), Array.from({ length: 30 }, (_, i) => i));
  for (const s of slots) assert.deepEqual([...s.order].sort(), CONFIGS);
});

test('each block holds every permutation once, and each configuration is first, middle and last twice', () => {
  const slots = blockSchedule('myfin', 'x4', 5, CONFIGS);
  for (let block = 1; block <= 5; block++) {
    const inBlock = slots.filter((s) => s.block === block);
    assert.equal(inBlock.length, 6);
    assert.deepEqual([...new Set(inBlock.map((s) => s.permutation))].sort(), ['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA']);
    for (const config of CONFIGS) {
      for (let position = 0; position < 3; position++) {
        const n = inBlock.filter((s) => s.order[position] === config).length;
        assert.equal(n, 2, `block ${block}: ${config} at position ${position}`);
      }
    }
  }
});

test('the order is fixed by SHA-256, so the same app and condition always give the same schedule', () => {
  const a = blockSchedule('kresus', 'x1', 5, CONFIGS).map((s) => s.permutation).join(' ');
  const b = blockSchedule('kresus', 'x1', 5, CONFIGS).map((s) => s.permutation).join(' ');
  assert.equal(a, b);
  const other = blockSchedule('kresus', 'x4', 5, CONFIGS).map((s) => s.permutation).join(' ');
  assert.notEqual(a, other, 'a different CPU condition gets its own order');
});
