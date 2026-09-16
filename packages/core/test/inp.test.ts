import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInpTracker, rateInp, type TimedInteraction } from '../src/inp.ts';

// Interaction k gets id 7k (Chrome spaces ids by 7), starts at 1000k ms and has a latency that
// grows with k, so the worst interaction is always the newest and the p98 pick is easy to name.
const latency = (k: number) => 100 + k * 8;
const interaction = (k: number, duration = latency(k), entryType = 'event'): TimedInteraction => ({ entryType, interactionId: 7 * k, startTime: 1000 * k, duration });

/** A tracker on a browser without `performance.interactionCount`, fed interactions 1 to n one batch each. */
function feed(n: number) {
  const t = createInpTracker(null);
  for (let k = 1; k <= n; k++) t.add([interaction(k)]);
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
  for (let k = 121; k <= 500; k++) t.add([interaction(k, 8)]);
  assert.deepEqual(t.estimate(), { id: 7 * 111, value: latency(120 - 9), interactionCount: 500 });
});

test('the count comes from id spacing, so unseen interactions in between still count', () => {
  const t = createInpTracker(null);
  t.add([interaction(1, 40)]);
  t.add([interaction(10, 48)]);
  assert.equal(t.estimate()?.interactionCount, 10);
});

test("the spacing counts event entries only: a first-input entry does not widen it, as in web-vitals' polyfill", () => {
  const t = createInpTracker(null);
  // The page's first input, quick enough that only its first-input entry exists.
  t.add([interaction(1, 8, 'first-input')]);
  t.add([interaction(3, 120)]);
  t.add([interaction(4, 64)]);
  assert.equal(t.estimate()?.interactionCount, 2);
});

test('where the browser counts interactions itself, its count picks the candidate', () => {
  const t = createInpTracker(() => 120);
  for (let k = 1; k <= 3; k++) t.add([interaction(k)]);
  assert.deepEqual(t.estimate(), { id: 7, value: latency(1), interactionCount: 120 });
});

test('a batch is taken in the order its entries were presented, so equal latencies rank as they do in web-vitals', () => {
  const t = createInpTracker(null);
  // Delivered second-interaction first, but the first interaction's frame was presented earlier.
  t.add([
    { entryType: 'event', interactionId: 14, startTime: 1010, duration: 56 },
    { entryType: 'event', interactionId: 7, startTime: 1000, duration: 56 },
  ]);
  assert.equal(t.estimate()?.id, 7);
});

test('an interaction of equal latency taking the candidate place does not move INP to it, as in web-vitals', () => {
  let count = 99;
  const t = createInpTracker(() => count);
  t.add([interaction(3, 300)]);
  t.add([interaction(5, 200)]);
  t.add([interaction(7, 200)]);
  assert.equal(t.estimate()?.id, 7 * 5);
  // At 100 interactions the candidate is the third longest, the second 200 ms one: same value, so web-vitals reports nothing new.
  count = 100;
  t.add([interaction(9, 50)]);
  assert.deepEqual(t.estimate(), { id: 7 * 5, value: 200, interactionCount: 100 });
});

test('when the page is hidden, INP is chosen again at the interaction count by then, as web-vitals reports it', () => {
  let count = 0;
  const t = createInpTracker(() => count);
  for (const [k, duration] of [
    [1, 304],
    [2, 200],
    [3, 104],
  ] as const) {
    count = k;
    t.add([interaction(k, duration)]);
  }
  assert.deepEqual(t.estimate(), { id: 7, value: 304, interactionCount: 3 });
  // A hundred more interactions that each painted under 16 ms: the browser counts them, the observer never sees them.
  count = 103;
  assert.equal(t.estimate()?.id, 7);
  t.update();
  assert.deepEqual(t.estimate(), { id: 21, value: 104, interactionCount: 103 });
});

test('after a navigation, interactions counted but too quick to be observed read as one 8 ms interaction, as in web-vitals', () => {
  let count = 1;
  const t = createInpTracker(() => count);
  t.add([interaction(1, 304)]);
  // A restore from the back/forward cache, then three quick taps and the page is hidden.
  t.reset('navigation');
  count = 4;
  t.update();
  assert.deepEqual(t.estimate(), { id: null, value: 8, interactionCount: 3 });
  // clear() is not a navigation, and web-vitals has nothing like it: there the estimate stays empty.
  t.reset('clear');
  count = 7;
  t.update();
  assert.equal(t.estimate(), null);
});

test('an interaction keeps its longest entry; ids of 0 are ignored', () => {
  const t = createInpTracker(null);
  t.add([interaction(0, 900)]);
  t.add([interaction(1, 40), interaction(1, 120)]);
  t.add([interaction(1, 56)]);
  assert.deepEqual(t.estimate(), { id: 7, value: 120, interactionCount: 1 });
});

test('reset forgets the candidates and restarts the count', () => {
  const t = feed(5);
  t.reset('clear');
  assert.equal(t.estimate(), null);
  t.add([interaction(6, 64)]);
  assert.deepEqual(t.estimate(), { id: 42, value: 64, interactionCount: 1 });
});

test("the rating follows INP's thresholds, in web-vitals' words", () => {
  assert.equal(rateInp(200), 'good');
  assert.equal(rateInp(201), 'needs-improvement');
  assert.equal(rateInp(500), 'needs-improvement');
  assert.equal(rateInp(501), 'poor');
});
