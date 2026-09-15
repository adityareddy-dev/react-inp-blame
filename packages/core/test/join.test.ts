import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReport, isLaterRender, refreshReport } from '../src/join.ts';
import type { CommitSummary, InputRecord } from '../src/types.ts';

// Hand-built PerformanceEventTiming-like entries. Durations are multiples of 8 the way the
// browser rounds them, except where the case under test says otherwise.
function entry(name: string, startTime: number, duration: number, processingStart: number, processingEnd: number, extra: Record<string, unknown> = {}) {
  return { name, interactionId: 7, startTime, duration, processingStart, processingEnd, target: null, ...extra };
}

function commit(at: number, inputTs: number, opts: Partial<CommitSummary> = {}): CommitSummary {
  return {
    at,
    sinceInput: at - inputTs,
    inputTs,
    gestureTs: inputTs,
    inputType: 'click',
    rendered: 30,
    truncated: false,
    roots: ['List'],
    hotPath: ['List'],
    components: [{ name: 'Row', count: 30, self: 20, total: 20 }],
    hasDurations: true,
    total: 30,
    walkMs: 0.2,
    priority: 1,
    didError: false,
    ...opts,
  };
}

function input(ts: number, type: string, extra: Partial<InputRecord> = {}): InputRecord {
  return { ts, type, gestureTs: ts, press: undefined, target: null, fiber: null, ...extra };
}

const longPress = [entry('pointerdown', 0, 32, 2, 6), entry('pointerup', 60, 16, 61, 62), entry('click', 61, 100, 62, 150)];

test('headline is the longest single entry, not the span of the whole interaction', () => {
  const r = buildReport(longPress, [], []);
  assert.equal(r.duration, 100);
  assert.equal(r.start, 61);
  assert.equal(r.end, 161);
  assert.equal(r.type, 'click');
  assert.equal(r.inputDelay, 1);
  assert.equal(r.processing, 88);
  assert.equal(r.presentation, 11);
  // The 61 ms the pointer was held before the click is kept, off the headline.
  assert.equal(r.holdMs, 61);
  assert.equal(r.explanation.headline, '100 ms click');
  assert.equal(r.explanation.phases.reduce((a, p) => a + p.ms, 0), 100);
});

test('entries painted within 8 ms of each other form one group, named by the best-known event', () => {
  const entries = [entry('pointerdown', 0, 24, 1, 3), entry('pointerup', 10, 16, 12, 13), entry('click', 11, 16, 13, 20)];
  const r = buildReport(entries, [], []);
  // The longest entry is the pointerdown; its paint group also holds the click, so it is a click.
  assert.equal(r.type, 'click');
  assert.equal(r.duration, 24);
  assert.equal(r.start, 0);
  assert.equal(r.inputDelay, 1);
  assert.equal(r.processing, 19);
  assert.equal(r.presentation, 4);
  assert.equal(r.holdMs, 3);
});

test('processing is clamped to the paint', () => {
  // processingEnd past the paint happens with a sync modal (alert) inside the handler.
  const r = buildReport([entry('click', 0, 40, 5, 300)], [], []);
  assert.equal(r.processing, 35);
  assert.equal(r.presentation, 0);
  assert.equal(r.end, 40);
});

test('an interaction with 150 ms of input delay still gets its commit and its follow-up', () => {
  const entries = [entry('click', 0, 232, 150, 200)];
  const sync = commit(190, 0);
  const later = commit(500, 0, { total: 40 });
  const r = buildReport(entries, [sync, later], []);
  assert.deepEqual(r.commits, [sync]);
  assert.equal(sync.joinedBy, 'exact');
  assert.deepEqual(r.followUps, [later]);
  assert.equal(r.inputDelay, 150);
  assert.equal(r.processing, 50);
  assert.equal(r.revision, 0);
});

test('two overlapping interactions never both claim one commit', () => {
  const a = entry('click', 0, 200, 5, 180);
  const b = entry('keydown', 100, 104, 180, 190, { interactionId: 14 });
  const c1 = commit(50, 0);
  const c2 = commit(185, 100, { inputType: 'keydown' });
  const ring = [input(0, 'click'), input(100, 'keydown')];
  const ra = buildReport([a], [c1, c2], [], ring);
  const rb = buildReport([b], [c1, c2], [], ring);
  assert.deepEqual(ra.commits, [c1]);
  assert.deepEqual(rb.commits, [c2]);
  assert.equal(c1.joinedBy, 'exact');
  assert.equal(c2.joinedBy, 'exact');
});

test('wall-clock overlap is only a flagged fallback for a commit no stamp explains', () => {
  const a = entry('click', 0, 200, 5, 180);
  // Stamped with an input the ring never saw; it ran between the handlers and the paint.
  const stray = commit(120, 999);
  const r = buildReport([a], [stray], [], [input(0, 'click')]);
  assert.deepEqual(r.commits, [stray]);
  assert.equal(stray.joinedBy, 'overlap');
  // A commit that ran during the input delay is what delayed us, not ours.
  const early = commit(3, 999);
  assert.deepEqual(buildReport([a], [early], [], [input(0, 'click')]).commits, []);
});

test('a commit stamped with the click joins the pointerdown report through the press stamp', () => {
  // Only the pointerdown was slow enough to be observed; the click's own entry never arrives.
  const pressed = [entry('pointerdown', 0, 40, 2, 30)];
  const afterClick = commit(400, 80, { gestureTs: 0, total: 40 });
  const r = buildReport(pressed, [afterClick], []);
  assert.deepEqual(r.followUps, [afterClick]);
  assert.equal(afterClick.joinedBy, 'exact');
});

test('a null entry target falls back to the node and fiber the ring kept at dispatch', () => {
  function Dialog() {}
  function CloseButton() {}
  function handleClose() {}
  const fiber = { tag: 0, elementType: CloseButton, memoizedProps: { onClick: handleClose }, return: { tag: 0, elementType: Dialog, memoizedProps: {}, return: null } };
  // A detached element: no parent, and React has already deleted its fiber expando.
  const node = { nodeType: 1, tagName: 'BUTTON', id: '', classList: { length: 0 }, textContent: ' Close ', parentNode: null, parentElement: null, getAttribute: () => null };
  const ring = [input(0, 'click', { target: node, fiber })];
  const r = buildReport([entry('click', 0, 120, 3, 100)], [], [], ring);
  assert.ok(r.target);
  assert.equal(r.target.selector, 'button');
  assert.equal(r.target.label, 'button "Close"');
  assert.equal(r.target.component, 'CloseButton');
  assert.deepEqual(r.target.owners, ['CloseButton', 'Dialog']);
  assert.equal(r.target.handler, 'handleClose');
  assert.equal(r.verdict.startsWith('120 ms click on button "Close" in CloseButton.'), true);
});

test('a late entry of a long press merges into the emitted report with a revision bump', () => {
  const r = buildReport(longPress.slice(0, 1), [], []);
  assert.equal(r.duration, 32);
  assert.equal(r.type, 'pointerdown');
  assert.equal(r.revision, 0);
  const sync = commit(140, 61);
  const headlineChanged = refreshReport(r, longPress, [sync], []);
  assert.equal(headlineChanged, true);
  assert.equal(r.duration, 100);
  assert.equal(r.type, 'click');
  assert.equal(r.revision, 1);
  assert.equal(r.entries.length, 3);
  assert.deepEqual(r.commits, [sync]);
  // A keyup that changes nothing still bumps the revision, so listeners see the entry list grow.
  assert.equal(refreshReport(r, longPress.concat(entry('keyup', 200, 16, 201, 202)), [sync], []), false);
  assert.equal(r.revision, 2);
});

test('later renders attach only by an exact stamp', () => {
  const r = buildReport([entry('click', 0, 120, 3, 100)], [], []);
  assert.equal(isLaterRender(r, commit(400, 0)), true);
  assert.equal(isLaterRender(r, commit(400, 0.8)), true);
  assert.equal(isLaterRender(r, commit(400, 2)), false);
  assert.equal(isLaterRender(r, commit(2000, 0)), false);
});

test('the rating follows the INP thresholds', () => {
  assert.equal(buildReport([entry('click', 0, 200, 1, 2)], [], []).explanation.rating, 'good');
  assert.equal(buildReport([entry('click', 0, 208, 1, 2)], [], []).explanation.rating, 'needs-work');
  assert.equal(buildReport([entry('click', 0, 504, 1, 2)], [], []).explanation.rating, 'poor');
});
