// stats.test.mjs: the Wilson and Newcombe intervals, checked against values computed by hand.
//
//   node --test stats.test.mjs      # or npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRADES, newcombe, tally, wilson } from './stats.mjs';

const close = (a, b, eps = 0.001) => assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

test('wilson: 8 right of 62 is about 6.7% to 23.4%', () => {
  const w = wilson(8, 62);
  close(w.p, 8 / 62);
  close(w.lower, 0.067);
  close(w.upper, 0.234);
});

test('wilson: zero of zero has no interval, and out-of-range counts throw', () => {
  assert.equal(wilson(0, 0), null);
  assert.throws(() => wilson(3, 2), /not within/);
});

test('wilson: stays inside 0 and 1 at the extremes', () => {
  const none = wilson(0, 20);
  assert.equal(none.lower, 0);
  assert.ok(none.upper > 0 && none.upper < 0.2);
  const all = wilson(20, 20);
  assert.equal(all.upper, 1);
  assert.ok(all.lower > 0.8);
});

test('newcombe: a difference of 0.13 against 0.10 with the sample sizes given', () => {
  const d = newcombe(8, 62, 2, 20);
  close(d.difference, 8 / 62 - 0.1);
  assert.ok(d.lower < d.difference && d.difference < d.upper);
});

test('tally: counts every grade and rejects an unknown one', () => {
  const t = tally(['right', 'wrong', 'blank', 'right', 'cannot_tell', 'misleading']);
  assert.equal(t.n, 6);
  assert.equal(t.counts.right, 2);
  assert.deepEqual(Object.keys(t.counts), GRADES);
  assert.throws(() => tally(['right', 'maybe']), /unknown grade/);
});
