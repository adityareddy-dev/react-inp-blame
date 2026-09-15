import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachLaterRender, buildReport, isLaterRender, refreshReport } from '../src/join.ts';
import type { CommitSummary, FrameSummary, InputRecord } from '../src/types.ts';

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
    coarseClock: false,
    total: 30,
    walkMs: 0,
    priority: 1,
    didError: false,
    ...opts,
  };
}

function input(ts: number, type: string, extra: Partial<InputRecord> = {}): InputRecord {
  return { ts, type, gestureTs: ts, press: undefined, target: null, fiber: null, ...extra };
}

/** A detached DOM element as the label reads it. Its textContent throws: a label must never need all of it. */
function element(tag: string, children: Record<string, unknown>[], attributes: Record<string, string> = {}): Record<string, unknown> {
  const el: Record<string, unknown> = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: '',
    classList: { length: 0 },
    parentNode: null,
    parentElement: null,
    nextSibling: null,
    firstChild: children[0] ?? null,
    getAttribute: (name: string) => attributes[name] ?? null,
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      throw new Error('the label read the whole textContent');
    },
  });
  children.forEach((child, i) => {
    child.parentNode = el;
    child.parentElement = el;
    child.nextSibling = children[i + 1] ?? null;
  });
  return el;
}

function text(value: string): Record<string, unknown> {
  return { nodeType: 3, nodeValue: value, parentNode: null, parentElement: null, nextSibling: null, firstChild: null };
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
  const node = element('button', [text(' Close ')]);
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
  refreshReport(r, longPress, [sync], []);
  assert.equal(r.duration, 100);
  assert.equal(r.type, 'click');
  assert.equal(r.revision, 1);
  assert.equal(r.entries.length, 3);
  assert.deepEqual(r.commits, [sync]);
  assert.equal(r.explanation.headline, '100 ms click');
  // A keyup that changes nothing else still bumps the revision, so listeners see the entry list grow.
  refreshReport(r, longPress.concat(entry('keyup', 200, 16, 201, 202)), [sync], []);
  assert.equal(r.duration, 100);
  assert.equal(r.entries.length, 4);
  assert.equal(r.revision, 2);
});

test("processing leaves out this library's own walk during the handlers, and the explanation says so", () => {
  // Handlers ran from 5 to 100 ms and the paint came at 120. Walking the click's commit at 50 ms
  // took 3 ms; the later render's 2 ms walk came after the paint, outside the interaction.
  const sync = commit(50, 0, { walkMs: 3 });
  const later = commit(400, 0, { walkMs: 2, total: 40 });
  const r = buildReport([entry('click', 0, 120, 5, 100)], [sync, later], []);
  assert.equal(r.walkMs, 3);
  assert.equal(r.processing, 92);
  assert.equal(r.inputDelay + r.processing + r.walkMs + r.presentation, r.duration);
  assert.equal(r.overheadMs, 5);
  assert.match(r.verdict, /The 120 ms includes 3 ms that react-inp-blame itself spent reading what React rendered; it is not counted as working time\./);
  // A walk still running when the handlers ended counts only up to their end.
  assert.equal(buildReport([entry('click', 0, 120, 5, 100)], [commit(98, 0, { walkMs: 4 })], []).walkMs, 2);
});

test('the label is the aria-label or the first run of text, at most 40 characters, never the whole textContent', () => {
  const label = (target: Record<string, unknown>) => buildReport([entry('click', 0, 120, 3, 100, { target })], [], []).target!.label;
  // React renders `Add to cart ({count})` as three adjacent text nodes.
  assert.equal(label(element('button', [text('Add to cart ('), text('3'), text(')')])), 'button "Add to cart (3)"');
  assert.equal(label(element('button', [element('svg', []), text('  Close  ')])), 'button "Close"');
  assert.equal(label(element('button', [text('×')], { 'aria-label': 'Remove item' })), 'button "Remove item"');
  assert.equal(label(element('p', [text('A'.repeat(60))])), `p "${'A'.repeat(40)}"`);
  // A click on a table body of 3000 rows reads the first row's text and stops.
  const rows = Array.from({ length: 3000 }, (_, i) => element('tr', [text(`Row ${i}`)]));
  assert.equal(label(element('tbody', rows)), 'tbody "Row 0"');
});

test('the verdict is built on first read and again after a later render attaches', () => {
  const r = buildReport([entry('click', 0, 120, 3, 100)], [commit(50, 0)], []);
  assert.doesNotMatch(r.verdict, /after the screen updated/);
  attachLaterRender(r, commit(400, 0, { total: 40 }), []);
  assert.match(r.verdict, /A second React render landed 280 ms after the screen updated/);
  // A copy of the report carries the explanation like any other field.
  assert.equal(JSON.parse(JSON.stringify(r)).verdict, r.verdict);
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

/** The ring after a click on a "Log in" button whose onClick is `handler`, owned by SignInPage. */
function loginClick(handler: () => void): InputRecord[] {
  function SignInPage() {}
  const fiber = { tag: 0, elementType: SignInPage, memoizedProps: { onClick: handler }, return: null };
  return [input(0, 'click', { target: element('button', [text('Log in')]) as unknown as Node, fiber: fiber as unknown as InputRecord['fiber'] })];
}

test('a blame says whether it was measured or inferred', () => {
  // Handlers ran from 3 to 100 ms and the screen updated at 120.
  const slowClick = [entry('click', 0, 120, 3, 100)];
  const blame = (commits: CommitSummary[], frames: FrameSummary[] | null = [], inputs: InputRecord[] = [input(0, 'click')]) => {
    const { kind, confidence } = buildReport(slowClick, commits, frames, inputs).explanation.blame;
    return `${kind} ${confidence}`;
  };
  // React's own durations, for a commit joined by the click's stamp and walked in full.
  assert.equal(blame([commit(50, 0, { total: 90 })]), 'render measured');
  assert.equal(blame([commit(50, 0, { total: 2 })]), 'handler measured');
  // The same render judged by counts, by overlapping the handlers, or from a walk cut short.
  assert.equal(blame([commit(50, 0, { hasDurations: false, total: 0, rendered: 800 })]), 'render inferred');
  assert.equal(blame([commit(50, 999, { total: 90 })]), 'render inferred');
  assert.equal(blame([commit(50, 0, { total: 90, truncated: true })]), 'render inferred');
  // A production build that re-rendered two components beside a named handler.
  assert.equal(blame([commit(50, 0, { hasDurations: false, total: 0, rendered: 2 })], [], loginClick(function handleLogin() {})), 'handler inferred');
  // The browser measured waiting and painting itself; with no commit and no Long Animation Frames, nothing rules scripts out.
  assert.equal(buildReport([entry('click', 0, 120, 80, 100)], [], []).explanation.blame.confidence, 'measured');
  assert.equal(buildReport([entry('click', 0, 40, 5, 10)], [], []).explanation.blame.confidence, 'measured');
  assert.equal(buildReport([entry('click', 0, 40, 5, 10)], [], null).explanation.blame.confidence, 'inferred');
});

test('a render under 1 ms reads "under 1 ms", and a handler known by its prop name reads "the onClick handler"', () => {
  const slowClick = [entry('click', 0, 120, 3, 100)];
  const development = buildReport(slowClick, [commit(50, 0, { total: 0.3, rendered: 2 })], [], loginClick(function handleLogin() {}));
  assert.equal(development.explanation.cause, "The click handler handleLogin ran for about 97 ms; React's own render took under 1 ms.");
  // A minifier leaves the handler a one-letter name, so the name reported is the prop's.
  const minified = () => {};
  Object.defineProperty(minified, 'name', { value: 'l' });
  const production = buildReport(slowClick, [commit(50, 0, { hasDurations: false, total: 0, rendered: 2 })], [], loginClick(minified));
  assert.equal(production.target?.handler, 'onClick');
  assert.equal(production.explanation.cause, 'The onClick handler most likely took the 97 ms: React re-rendered only 2 components. A profiling build of React would give exact numbers.');
});

test('a commit timed by a clock too coarse for its components is blamed on its total, as inferred, with no per-component milliseconds', () => {
  const coarse = commit(430, 0, {
    coarseClock: true,
    total: 417,
    rendered: 801,
    roots: ['ContextStorm'],
    hotPath: ['ContextStorm', 'OrderSummary'],
    components: [{ name: 'LineItem', count: 800, self: null, total: null }],
  });
  const r = buildReport([entry('click', 0, 456, 3, 440)], [coarse], null);
  assert.deepEqual(r.explanation.blame, { kind: 'render', name: 'OrderSummary', detail: 'LineItem ×800', ms: 417, confidence: 'inferred' });
  assert.equal(r.explanation.cause, 'React spent 417 ms re-rendering 801 components inside OrderSummary, mostly LineItem (800 of them).');
  assert.ok(r.explanation.notes.some((note) => note.includes('clock steps in whole milliseconds')));
});
