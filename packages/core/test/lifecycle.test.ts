import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLifecycle, MAX_ENTRY_SETS, MAX_QUIET, MAX_REPORTS, type LifecycleOptions } from '../src/lifecycle.ts';
import type { CommitSummary, FrameSummary, InteractionReport } from '../src/types.ts';

// Interaction k has id 7k and starts at 1000 × id ms, so no two interactions overlap in time. Its
// handlers start 2 ms after the input and end 8 ms before the paint unless the case says otherwise.
function entry(id: number, name: string, duration: number, extra: Record<string, unknown> = {}) {
  const startTime = id * 1000;
  return { entryType: 'event', name, interactionId: id, startTime, duration, processingStart: startTime + 2, processingEnd: startTime + duration - 8, target: null, ...extra } as any;
}

/** A render stamped with the input at `inputTs`: 400 components in 60 ms, the kind a later render is made of. */
function commit(at: number, inputTs: number): CommitSummary {
  return {
    at,
    sinceInput: at - inputTs,
    inputTs,
    gestureTs: inputTs,
    inputType: 'click',
    rendered: 400,
    truncated: false,
    roots: ['Details'],
    hotPath: ['Details'],
    components: [{ name: 'Detail', count: 400, self: 60, total: 0.2 }],
    hasDurations: true,
    coarseClock: false,
    total: 60,
    walkMs: 0,
    priority: 3,
    didError: false,
  };
}

/** A long animation frame with the click's 110 ms handler in it, frozen the way the observer hands frames over. */
const slowFrame: FrameSummary = Object.freeze({
  start: 6990,
  duration: 140,
  blocking: 90,
  forcedLayout: 30,
  scripts: Object.freeze([Object.freeze({ invoker: 'BUTTON.onclick', name: '', source: '', start: 7002, duration: 110, forcedLayout: 30 })]),
});

/** A lifecycle at the default 40 ms threshold on a stopped clock, with every report it publishes recorded in order. */
function lifecycle(options: Partial<LifecycleOptions> = {}) {
  const commits: CommitSummary[] = [];
  const published: InteractionReport[] = [];
  const life = createLifecycle({
    threshold: 40,
    commits: () => commits,
    inputs: () => [],
    frames: null,
    interactionCount: null,
    labels: () => 'attributes',
    now: () => 0,
    publish: (r) => published.push(r),
    ...options,
  });
  /** What the DevTools hook does with a commit: record it, then hand it over. */
  const render = (c: CommitSummary) => {
    commits.push(c);
    life.onCommit(c);
  };
  return { life, published, render };
}

test('a quiet interaction is held back, and published once a render it caused lands after the paint', () => {
  const { life, published, render } = lifecycle();
  life.onEntries([entry(7, 'click', 24)]);
  assert.deepEqual(published, []);
  assert.deepEqual(life.reports(), []);

  const later = commit(7100, 7000);
  render(later);
  assert.equal(published.length, 1);
  const [r] = published;
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.duration, 24);
  assert.deepEqual(r.followUps, [{ ...later, joinedBy: 'exact' }]);
  assert.deepEqual(life.reports(), [r]);
});

test('a late entry publishes the next revision as a new report, and the revision before stays as it was', () => {
  const { life, published } = lifecycle();
  // A press held down: the pointerdown painted on its own, quick enough to stay quiet.
  life.onEntries([entry(7, 'pointerdown', 32)]);
  assert.deepEqual(published, []);

  // The click came with the paint after the release, and it was slow.
  life.onEntries([entry(7, 'click', 120, { startTime: 7080, processingStart: 7082, processingEnd: 7190 })]);
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'click');
  assert.equal(published[0].duration, 120);
  assert.equal(published[0].revision, 1);

  life.onEntries([entry(7, 'pointerup', 16, { startTime: 7079, processingStart: 7080, processingEnd: 7081 })]);
  const [before, after] = published;
  assert.notEqual(after, before);
  assert.equal(after.revision, 2);
  assert.equal(after.entries.length, 3);
  assert.equal(before.revision, 1);
  assert.equal(before.entries.length, 2);
  assert.equal(life.last(), after);
});

test('a long animation frame that lands after the report is published as the next revision', () => {
  const frames: FrameSummary[] = [];
  const { life, published } = lifecycle({ frames });
  life.onEntries([entry(7, 'click', 120)]);
  frames.push(slowFrame);
  life.onFrame();
  const [before, after] = published;
  assert.deepEqual(before.frames, []);
  assert.deepEqual(after.frames, [slowFrame]);
  assert.equal(after.revision, 1);

  // The same frames again change nothing, so nothing is published.
  life.onFrame();
  assert.equal(published.length, 2);
});

test('every revision is frozen, down to its entries, commits, frames and explanation', () => {
  const { life, published, render } = lifecycle({ frames: [slowFrame] });
  life.onEntries([entry(7, 'click', 120)]);
  render(commit(7300, 7000));
  const r = published[1];
  const parts = { report: r, entries: r.entries, entry: r.entries[0], followUps: r.followUps, followUp: r.followUps[0], frames: r.frames, laterFrames: r.laterFrames, explanation: r.explanation, blame: r.explanation.blame, phases: r.explanation.phases, notes: r.explanation.notes };
  for (const [name, part] of Object.entries(parts)) assert.ok(Object.isFrozen(part), `${name} can be changed`);
  assert.throws(() => {
    (r as { duration: number }).duration = 1;
  }, TypeError);
});

test("a click on the library's own badge or panel is never reported, though INP counts it as web-vitals does", () => {
  const { life, published } = lifecycle();
  const badge = { nodeType: 1, tagName: 'DIV', id: 'react-inp-blame', classList: { length: 0 }, parentNode: null, parentElement: null, firstChild: null, getAttribute: () => null };
  life.onEntries([entry(7, 'click', 120, { target: badge })]);
  assert.deepEqual(published, []);
  assert.deepEqual(life.reports(), []);
  assert.equal(life.inp()?.interactionId, 7);
  assert.equal(life.inp()?.report, null);
});

test(`only the newest ${MAX_REPORTS} published reports are kept`, () => {
  const { life } = lifecycle();
  for (let k = 1; k <= MAX_REPORTS + 5; k++) life.onEntries([entry(7 * k, 'click', 120)]);
  const kept = life.reports();
  assert.equal(kept.length, MAX_REPORTS);
  assert.equal(kept[0].interactionId, 7 * 6);
  assert.equal(life.last()?.interactionId, 7 * (MAX_REPORTS + 5));
});

test(`only the newest ${MAX_QUIET} quiet interactions wait for a later render`, () => {
  const { life, published, render } = lifecycle();
  for (let k = 1; k <= MAX_QUIET + 1; k++) life.onEntries([entry(7 * k, 'click', 24)]);
  // The oldest was let go, so the render it caused has nothing to publish.
  render(commit(7000 + 100, 7000));
  assert.deepEqual(published, []);
  render(commit(7000 * (MAX_QUIET + 1) + 100, 7000 * (MAX_QUIET + 1)));
  assert.equal(published.length, 1);
});

test(`a late entry rebuilds its report only while its interaction is among the newest ${MAX_ENTRY_SETS} heard from`, () => {
  const { life, published } = lifecycle();
  life.onEntries([entry(7, 'pointerdown', 120)]);
  for (let k = 2; k <= MAX_ENTRY_SETS + 1; k++) life.onEntries([entry(7 * k, 'click', 24)]);
  life.onEntries([entry(7, 'pointerup', 16, { startTime: 7090, processingStart: 7091, processingEnd: 7092 })]);
  assert.equal(published.length, 1);
  assert.equal(published[0].revision, 0);
  assert.equal(published[0].entries.length, 1);
});
