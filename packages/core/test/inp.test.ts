import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInpTracker, rateInp } from '../src/inp.ts';

// Interaction k gets id 7k (Chrome spaces ids by 7) and a latency that grows with k, so the
// worst interaction is always the newest and the p98 pick is easy to name.
const latency = (k: number) => 100 + k * 8;

function feed(n: number) {
  const t = createInpTracker();
  for (let k = 1; k <= n; k++) t.add({ interactionId: 7 * k, duration: latency(k) });
  return t;
}

test('under 50 interactions INP is the worst one', () => {
  const t = feed(3);
  assert.deepEqual(t.estimate(), { id: 21, value: latency(3), interactionCount: 3 });
});

test('at 60 interactions INP is the second worst', () => {
  const t = feed(60);
  assert.deepEqual(t.estimate(), { id: 7 * 59, value: latency(59), interactionCount: 60 });
});

test('at 120 interactions INP is the third worst', () => {
  const t = feed(120);
  assert.deepEqual(t.estimate(), { id: 7 * 118, value: latency(118), interactionCount: 120 });
});

test('only the 10 longest interactions are kept', () => {
  const t = feed(120);
  // 500 interactions would index the 10th worst; with 120 seen the index is capped at 9.
  for (let k = 121; k <= 500; k++) t.add({ interactionId: 7 * k, duration: 8 });
  assert.equal(t.count(), 500);
  assert.equal(t.estimate()!.value, latency(120 - 9));
});

test('the count comes from id spacing, so unseen interactions in between still count', () => {
  const t = createInpTracker();
  t.add({ interactionId: 7, duration: 40 });
  t.add({ interactionId: 70, duration: 48 });
  assert.equal(t.count(), 10);
  assert.equal(t.estimate()!.interactionCount, 10);
});

test('an interaction keeps its longest entry; ids of 0 are ignored', () => {
  const t = createInpTracker();
  t.add({ interactionId: 0, duration: 900 });
  t.add({ interactionId: 7, duration: 40 });
  t.add({ interactionId: 7, duration: 120 });
  t.add({ interactionId: 7, duration: 56 });
  assert.deepEqual(t.estimate(), { id: 7, value: 120, interactionCount: 1 });
});

test('reset forgets the candidates and restarts the count', () => {
  const t = feed(5);
  t.reset();
  assert.equal(t.estimate(), null);
  assert.equal(t.count(), 0);
  t.add({ interactionId: 7 * 6, duration: 64 });
  assert.deepEqual(t.estimate(), { id: 42, value: 64, interactionCount: 1 });
});

test('rating follows the INP thresholds', () => {
  assert.equal(rateInp(200), 'good');
  assert.equal(rateInp(201), 'needs-work');
  assert.equal(rateInp(500), 'needs-work');
  assert.equal(rateInp(501), 'poor');
});
