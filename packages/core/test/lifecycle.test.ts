import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLifecycle, KEPT_SLOWEST, MAX_ENTRY_SETS, MAX_QUIET, MAX_REPORTS, type LifecycleOptions } from '../src/lifecycle.ts';
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
    hydrated: false,
    truncated: false,
    roots: ['Details'],
    hotPath: ['Details'],
    components: [{ name: 'Detail', count: 400, self: 60, total: 0.2 }],
    hasDurations: true,
    coarseClock: false,
    total: 60,
    startedAt: null,
    effectsStartedAt: null,
    effectsEndedAt: null,
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

/** A lifecycle at the default 40 ms threshold and 1500 ms input window on a stopped clock, with every report it publishes recorded in order. */
function lifecycle(options: Partial<LifecycleOptions> = {}) {
  const commits: CommitSummary[] = [];
  const published: InteractionReport[] = [];
  const life = createLifecycle({
    threshold: 40,
    inputWindow: 1500,
    commits: () => commits,
    inputs: () => [],
    navigations: () => [],
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

/** An element with this id, as the observer hands a target over. */
const elementWithId = (id: string) => ({ nodeType: 1, tagName: 'DIV', id, classList: { length: 0 }, parentNode: null, parentElement: null, firstChild: null, getAttribute: () => null });

test('a quiet interaction is held back, and published once a render it caused lands after the paint', () => {
  const { life, published, render } = lifecycle();
  life.onEntries([entry(7, 'click', 24)]);
  assert.deepEqual(published, []);
  assert.deepEqual(life.reports(), []);

  const later = commit(7100, 7000);
  render(later);
  assert.equal(published.length, 1);
  const [r] = published;
  assert.equal(r?.schemaVersion, 3);
  assert.equal(r?.duration, 24);
  assert.deepEqual(r?.followUps, [{ ...later, joinedBy: 'exact' }]);
  assert.deepEqual(life.reports(), [r]);
});

test("a later render joins within the page's inputWindow of the paint, however long the page made it", () => {
  // The click painted at 7024 and its render landed 2 s after that.
  const late = commit(9024, 7000);
  const byDefault = lifecycle();
  byDefault.life.onEntries([entry(7, 'click', 24)]);
  byDefault.render(late);
  assert.deepEqual(byDefault.published, []);

  const longer = lifecycle({ inputWindow: 3000 });
  longer.life.onEntries([entry(7, 'click', 24)]);
  longer.render(late);
  assert.equal(longer.published.length, 1);
  assert.deepEqual(longer.published[0]?.followUps, [{ ...late, joinedBy: 'exact' }]);
});

test('a quiet mouse click is not published for the render of a click Enter made on the same button later', () => {
  // A ring where the click Enter made carries the mouse click's pointerdown as its press, and its render
  // that stamp, 2.6 s after the mouse click painted. The hook recorded it that way until it tied a
  // keyboard click to its key, and a release whose press it can only guess at still takes the newest one.
  const input = (ts: number, type: string, gestureTs: number, press: string | number) => ({ ts, type, gestureTs, press, target: null, owners: [], handler: null, dehydrated: null, work: { endedAt: ts, unjoined: [] } });
  const ring = [input(7000, 'pointerdown', 7000, 1), input(7080, 'pointerup', 7000, 1), input(7081, 'click', 7000, 1), input(9600, 'keydown', 9600, 'Enter'), input(9601, 'click', 7000, -1)];
  const { life, published, render } = lifecycle({ inputs: () => ring });
  life.onEntries([entry(7, 'pointerdown', 24)]);
  render({ ...commit(9610, 9601), gestureTs: 7000 });
  assert.deepEqual(published, []);
});

test("a quick press is not published for the render its own release made, which INP timed, but is for one after it", () => {
  // A 32 ms pointerdown on excalidraw's canvas, then the pointerup that ends the stroke, rendering inside
  // its own dispatch 38 ms after the press painted. That render is inside the pointerup's entry.
  const input = (ts: number, type: string) => ({ ts, type, gestureTs: 7000, press: 1, target: null, owners: [], handler: null, dehydrated: null, work: { endedAt: ts, ownEndedAt: ts, unjoined: [] } });
  const ring = [input(7000, 'pointerdown'), input(7060, 'pointerup')];
  const { life, published, render } = lifecycle({ inputs: () => ring });
  life.onEntries([entry(7, 'pointerdown', 32)]);
  render({ ...commit(7070, 7060), gestureTs: 7000, inputType: 'pointerup', inDispatch: true });
  assert.deepEqual(published, []);
  life.onEntries([entry(7, 'pointerup', 24, { startTime: 7060, processingStart: 7061, processingEnd: 7072 })]);
  assert.deepEqual(published, []);
  // A render its effects make after the release painted is one INP left out.
  render({ ...commit(7400, 7060), gestureTs: 7000, inputType: 'pointerup' });
  assert.equal(published.length, 1);
  assert.deepEqual(published[0]?.followUps.map((c) => c.at), [7070, 7400]);
});

test('a late entry publishes the next revision as a new report, and the revision before stays as it was', () => {
  const { life, published } = lifecycle();
  // A press held down: the pointerdown painted on its own, quick enough to stay quiet.
  life.onEntries([entry(7, 'pointerdown', 32)]);
  assert.deepEqual(published, []);

  // The click came with the paint after the release, and it was slow.
  life.onEntries([entry(7, 'click', 120, { startTime: 7080, processingStart: 7082, processingEnd: 7190 })]);
  assert.equal(published.length, 1);
  assert.equal(published[0]?.type, 'click');
  assert.equal(published[0]?.duration, 120);
  assert.equal(published[0]?.revision, 1);

  life.onEntries([entry(7, 'pointerup', 16, { startTime: 7079, processingStart: 7080, processingEnd: 7081 })]);
  const [before, after] = published;
  assert.notEqual(after, before);
  assert.equal(after?.revision, 2);
  assert.equal(after?.entries.length, 3);
  assert.equal(before?.revision, 1);
  assert.equal(before?.entries.length, 2);
  assert.equal(life.last(), after);
});

test("the page's first input, heard as its first-input entry and then as its event entry, is one entry in its report", () => {
  const { life, published } = lifecycle();
  life.onEntries([entry(7, 'pointerdown', 56, { entryType: 'first-input' })]);
  life.onEntries([entry(7, 'pointerdown', 56)]);
  assert.equal(published.length, 1);
  assert.equal(life.last()?.entries.length, 1);
});

test('a long animation frame that lands after the report is published as the next revision', () => {
  const frames: FrameSummary[] = [];
  const { life, published } = lifecycle({ frames });
  life.onEntries([entry(7, 'click', 120)]);
  frames.push(slowFrame);
  life.onFrame();
  const [before, after] = published;
  assert.deepEqual(before?.frames, []);
  assert.deepEqual(after?.frames, [slowFrame]);
  assert.equal(after?.revision, 1);

  // The same frames again change nothing, so nothing is published.
  life.onFrame();
  assert.equal(published.length, 2);
});

test('a long animation frame is folded into every published report it overlaps, not only the newest', () => {
  // Control and z pressed 8 ms apart for an undo. z's handler ran for 59 ms in the frame both painted in,
  // and Control's report, the older one, said only that its screen took 70 ms to update.
  const undo: FrameSummary = Object.freeze({
    start: 7000,
    duration: 76,
    blocking: 26,
    forcedLayout: 0,
    scripts: Object.freeze([Object.freeze({ invoker: 'DOCUMENT.onkeydown', name: '', source: '', start: 7009, duration: 59, forcedLayout: 0 })]),
  });
  const frames: FrameSummary[] = [];
  const { life, published } = lifecycle({ frames });
  life.onEntries([entry(7, 'keydown', 72, { processingStart: 7001, processingEnd: 7002 }), entry(14, 'keydown', 64, { startTime: 7008, processingStart: 7009, processingEnd: 7068 })]);
  assert.equal(life.reports()[0]?.explanation.blame.name, null);
  frames.push(undo);
  life.onFrame();
  assert.equal(published.length, 4);
  assert.deepEqual(
    life.reports().map((r) => [r.interactionId, r.revision, r.frames?.length]),
    [
      [7, 1, 1],
      [14, 1, 1],
    ],
  );
  // Its blame now names the script that held the frame.
  const blame = life.reports()[0]?.explanation.blame;
  assert.deepEqual(blame && [blame.kind, blame.name, blame.ms], ['painting', 'DOCUMENT.onkeydown', 70]);
});

test("a report keeps its long animation frames once the page's store of recent frames has let them go", () => {
  const frames: FrameSummary[] = [slowFrame];
  const { life, published } = lifecycle({ frames });
  life.onEntries([entry(7, 'click', 120)]);
  assert.deepEqual(published[0]?.frames, [slowFrame]);
  // Minutes later, 60 unrelated long frames have pushed it out of the store, which keeps the newest 60.
  for (let i = 0; i < 60; i++) {
    frames.push(Object.freeze({ start: 60_000 + i * 5_000, duration: 60, blocking: 10, forcedLayout: 0, scripts: Object.freeze([]) }));
    frames.splice(0, frames.length - 60);
    life.onFrame();
  }
  assert.equal(frames.includes(slowFrame), false);
  assert.equal(published.length, 1, 'a revision was published with nothing new in it');
  assert.deepEqual(life.last()?.frames, [slowFrame]);
});

test('every revision is frozen, down to its entries, commits, frames and explanation', () => {
  const { life, published, render } = lifecycle({ frames: [slowFrame] });
  life.onEntries([entry(7, 'click', 120)]);
  render(commit(7300, 7000));
  const r = published[1];
  assert.ok(r);
  const parts = { report: r, entries: r.entries, entry: r.entries[0], followUps: r.followUps, followUp: r.followUps[0], frames: r.frames, laterFrames: r.laterFrames, explanation: r.explanation, blame: r.explanation.blame, phases: r.explanation.phases, notes: r.explanation.notes };
  for (const [name, part] of Object.entries(parts)) assert.ok(Object.isFrozen(part), `${name} can be changed`);
  assert.throws(() => {
    (r as { duration: number }).duration = 1;
  }, TypeError);
});

test("a click on the library's own badge or panel is never reported, though INP counts it as web-vitals does", () => {
  const { life, published } = lifecycle();
  life.onEntries([entry(7, 'click', 120, { target: elementWithId('react-inp-blame') })]);
  assert.deepEqual(published, []);
  assert.deepEqual(life.reports(), []);
  assert.equal(life.inp()?.interactionId, 7);
  assert.equal(life.inp()?.report, null);
  // The page's own element with an id that merely starts the same way is the page's.
  life.onEntries([entry(14, 'click', 120, { target: elementWithId('react-inp-blame-docs') })]);
  assert.equal(published.length, 1);
});

test(`past ${MAX_REPORTS} published reports the oldest goes first, but never one of the ${KEPT_SLOWEST} slowest`, () => {
  // A 304 ms key press, then sixty quick interactions, as drawing sixty rectangles in excalidraw makes.
  // Kept first in, first out, the key press was the first to go.
  const { life } = lifecycle();
  life.onEntries([entry(7, 'keydown', 304)]);
  for (let k = 2; k <= MAX_REPORTS + 11; k++) life.onEntries([entry(7 * k, 'click', 48)]);
  const kept = life.reports().map((r) => r.interactionId);
  assert.equal(kept.length, MAX_REPORTS);
  // The key press, and of the clicks as slow as each other the oldest.
  assert.deepEqual(kept.slice(0, KEPT_SLOWEST), Array.from({ length: KEPT_SLOWEST }, (_, i) => 7 * (i + 1)));
  assert.equal(kept[KEPT_SLOWEST], 7 * 22);
  assert.equal(life.last()?.interactionId, 7 * (MAX_REPORTS + 11));
});

test("past the limit the report of the page's INP is kept too, though it is neither new nor among the slowest", () => {
  const { life } = lifecycle({ interactionCount: () => 1 });
  // Ten slow clicks before a navigation, then the INP of the page it went to, and quick clicks after it.
  for (let k = 1; k <= KEPT_SLOWEST; k++) life.onEntries([entry(7 * k, 'click', 304)]);
  life.onNavigation(7000 * KEPT_SLOWEST + 500);
  const inpId = 7 * (KEPT_SLOWEST + 1);
  life.onEntries([entry(inpId, 'click', 104)]);
  for (let k = KEPT_SLOWEST + 2; k <= MAX_REPORTS + 30; k++) life.onEntries([entry(7 * k, 'click', 48)]);
  assert.equal(life.inp()?.interactionId, inpId);
  const kept = life.reports().map((r) => r.interactionId);
  assert.equal(kept.length, MAX_REPORTS);
  assert.ok(kept.includes(inpId));
  assert.equal(life.inp()?.report?.interactionId, inpId);
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
  assert.equal(published[0]?.revision, 0);
  assert.equal(published[0]?.entries.length, 1);
});

test('a navigation starts the INP estimate over from the interactions that begin after it, and lets go of quiet ones', () => {
  const { life, published, render } = lifecycle();
  life.onEntries([entry(7, 'click', 120)]);
  life.onEntries([entry(14, 'click', 24)]);
  assert.equal(life.inp()?.interactionId, 7);

  life.onNavigation(20_500);
  assert.equal(life.inp(), null);
  // The quiet click was let go, so a render stamped with its input publishes nothing.
  render(commit(14_100, 14_000));
  assert.equal(published.length, 1);

  // A click that began just before the navigation and is heard after it is reported, but not counted.
  life.onEntries([entry(21, 'click', 200, { startTime: 20_400, processingStart: 20_402, processingEnd: 20_592 })]);
  life.onEntries([entry(28, 'click', 64)]);
  assert.equal(published.length, 3);
  assert.equal(life.inp()?.interactionId, 28);
});

test('hiding the page chooses INP again at the interaction count by then', () => {
  let count = 0;
  const { life } = lifecycle({ interactionCount: () => count });
  for (const [k, duration] of [
    [1, 304],
    [2, 200],
    [3, 104],
  ] as const) {
    count = k;
    life.onEntries([entry(7 * k, 'click', duration)]);
  }
  count = 103;
  assert.equal(life.inp()?.interactionId, 7);
  life.onHidden();
  const inp = life.inp();
  assert.deepEqual(inp && { value: inp.value, interactionId: inp.interactionId, interactionCount: inp.interactionCount }, { value: 104, interactionId: 21, interactionCount: 103 });
});
