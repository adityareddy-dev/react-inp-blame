import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachLaterRender, buildReport, isLaterRender, refreshReport, sealReport, type LabelSource } from '../src/join.ts';
import type { PageNavigation } from '../src/navigation.ts';
import type { CommitSummary, FrameSummary, InputRecord, InteractionReport, ScriptSummary } from '../src/types.ts';

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
    hydrated: false,
    hydratedTarget: null,
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
  return { ts, type, gestureTs: ts, press: undefined, target: null, owners: [], handler: null, dehydrated: null, work: { endedAt: ts, unjoined: [] }, ...extra };
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

/** `<!-- -->`, the comment React's server renderer puts between two adjacent text children, kept by hydration. */
function separator(): Record<string, unknown> {
  return { nodeType: 8, nodeValue: ' ', parentNode: null, parentElement: null, nextSibling: null, firstChild: null };
}

/** A Long Animation Frames script, as the observer summarises one. */
const script = (invoker: string, start: number, duration: number, forcedLayout = 0): ScriptSummary => ({ invoker, name: '', source: 'app.js', start, duration, forcedLayout });

/** A long animation frame holding these scripts. */
const frame = (start: number, duration: number, scripts: ScriptSummary[]): FrameSummary => ({ start, duration, blocking: Math.max(0, duration - 50), forcedLayout: scripts.reduce((a, s) => a + s.forcedLayout, 0), scripts });

/** The report as it is published: the data these arguments build, sealed. */
const report = (...args: Parameters<typeof buildReport>) => sealReport(buildReport(...args));

/** A commit as a report holds it: the same commit, stamped with how it joined. */
const joinedAs = (c: CommitSummary, joinedBy: 'exact' | 'overlap'): CommitSummary => ({ ...c, joinedBy });

const longPress = [entry('pointerdown', 0, 32, 2, 6), entry('pointerup', 60, 16, 61, 62), entry('click', 61, 100, 62, 150)];

test('headline is the longest single entry, not the span of the whole interaction', () => {
  const r = report(longPress, [], []);
  assert.equal(r.duration, 100);
  assert.equal(r.start, 61);
  assert.equal(r.end, 161);
  assert.equal(r.type, 'click');
  assert.equal(r.inputDelay, 1);
  assert.equal(r.processing, 88);
  assert.equal(r.presentation, 11);
  // The 61 ms the pointer was held before the click is kept, off the headline.
  assert.equal(r.holdMs, 61);
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
  assert.deepEqual(r.commits, [joinedAs(sync, 'exact')]);
  assert.deepEqual(r.followUps, [joinedAs(later, 'exact')]);
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
  assert.deepEqual(buildReport([a], [c1, c2], [], ring).commits, [joinedAs(c1, 'exact')]);
  assert.deepEqual(buildReport([b], [c1, c2], [], ring).commits, [joinedAs(c2, 'exact')]);
});

test('wall-clock overlap is only a flagged fallback for a commit no stamp explains', () => {
  const a = entry('click', 0, 200, 5, 180);
  // Stamped with an input the ring never saw; it ran between the handlers and the paint.
  const stray = commit(120, 999);
  assert.deepEqual(buildReport([a], [stray], [], [input(0, 'click')]).commits, [joinedAs(stray, 'overlap')]);
  // A commit that ran during the input delay is what delayed us, not ours.
  const early = commit(3, 999);
  assert.deepEqual(buildReport([a], [early], [], [input(0, 'click')]).commits, []);
});

test('a commit stamped with the click joins the pointerdown report through the press stamp', () => {
  // Only the pointerdown was slow enough to be observed; the click's own entry never arrives.
  const pressed = [entry('pointerdown', 0, 40, 2, 30)];
  const afterClick = commit(400, 80, { gestureTs: 0, total: 40 });
  assert.deepEqual(buildReport(pressed, [afterClick], []).followUps, [joinedAs(afterClick, 'exact')]);
});

test('a null entry target falls back to the node, the components and the handler the ring read at dispatch', () => {
  // A detached element: by the time the entry arrives, React has cleared the fiber it had.
  const node = element('button', [text(' Close ')]);
  const ring = [input(0, 'click', { target: node as unknown as Node, owners: ['CloseButton', 'Dialog'], handler: 'handleClose' })];
  const r = report([entry('click', 0, 120, 3, 100)], [], [], ring, 'text');
  assert.deepEqual(r.target, { selector: 'button', label: 'button "Close"', component: 'CloseButton', owners: ['CloseButton', 'Dialog'], handler: 'handleClose' });
  assert.equal(r.verdict.startsWith('120 ms click on button "Close" in CloseButton.'), true);
});

test('a late entry of a long press makes the next revision, rebuilt from every entry, and leaves the one before as it was', () => {
  const first = buildReport(longPress.slice(0, 1), [], []);
  assert.equal(first.duration, 32);
  assert.equal(first.type, 'pointerdown');
  assert.equal(first.revision, 0);
  const sync = commit(140, 61);
  const second = refreshReport(first, longPress, [sync], []);
  assert.equal(second.duration, 100);
  assert.equal(second.type, 'click');
  assert.equal(second.revision, 1);
  assert.equal(second.entries.length, 3);
  assert.deepEqual(second.commits, [joinedAs(sync, 'exact')]);
  assert.equal(first.duration, 32);
  assert.equal(first.entries.length, 1);
  // A keyup that changes nothing else is still a revision, so listeners see the entry list grow.
  const third = refreshReport(second, longPress.concat(entry('keyup', 200, 16, 201, 202)), [sync], []);
  assert.equal(third.duration, 100);
  assert.equal(third.entries.length, 4);
  assert.equal(third.revision, 2);
});

test("processing leaves out this library's own walk during the handlers, and the explanation says so", () => {
  // Handlers ran from 5 to 100 ms and the paint came at 120. Walking the click's commit at 50 ms
  // took 3 ms; the later render's 2 ms walk came after the paint, outside the interaction.
  const sync = commit(50, 0, { walkMs: 3 });
  const later = commit(400, 0, { walkMs: 2, total: 40 });
  const r = report([entry('click', 0, 120, 5, 100)], [sync, later], []);
  assert.equal(r.walkMs, 3);
  assert.equal(r.processing, 92);
  assert.equal(r.inputDelay + r.processing + r.walkMs + r.presentation, r.duration);
  assert.equal(r.overheadMs, 5);
  assert.match(r.verdict, /The 120 ms includes 3 ms that react-inp-blame itself spent reading what React rendered; it is not counted as working time\./);
  // A walk still running when the handlers ended counts only up to their end.
  assert.equal(buildReport([entry('click', 0, 120, 5, 100)], [commit(98, 0, { walkMs: 4 })], []).walkMs, 2);
});

/** The label of a click on `target`, with labels from `labels`. */
const labelOf = (target: Record<string, unknown>, labels: LabelSource) => buildReport([entry('click', 0, 120, 3, 100, { target })], [], [], [], labels).target?.label;

test('with text allowed, the label is the aria-label or the first run of text, at most 40 characters, never the whole textContent', () => {
  const label = (target: Record<string, unknown>) => labelOf(target, 'text');
  // React renders `Add to cart ({count})` as three adjacent text nodes.
  assert.equal(label(element('button', [text('Add to cart ('), text('3'), text(')')])), 'button "Add to cart (3)"');
  // The same button hydrated from server HTML, where React separated those three with `<!-- -->`.
  assert.equal(label(element('button', [text('Add to cart ('), separator(), text('3'), separator(), text(')')])), 'button "Add to cart (3)"');
  // Skipping separators is not a way to walk a whole element: the run stops after a fixed number of siblings.
  const separated = [text('Hi'), ...Array.from({ length: 40 }, separator), text('there')];
  assert.equal(label(element('span', separated)), 'span "Hi"');
  assert.equal(label(element('button', [element('svg', []), text('  Close  ')])), 'button "Close"');
  assert.equal(label(element('button', [text('×')], { 'aria-label': 'Remove item' })), 'button "Remove item"');
  assert.equal(label(element('p', [text('A'.repeat(60))])), `p "${'A'.repeat(40)}"`);
  // A click on a table body of 3000 rows reads the first row's text and stops.
  const rows = Array.from({ length: 3000 }, (_, i) => element('tr', [text(`Row ${i}`)]));
  assert.equal(label(element('tbody', rows)), 'tbody "Row 0"');
});

test("with attributes only, the label comes from what the page's code wrote on the element, never from the text it shows", () => {
  const label = (target: Record<string, unknown>) => labelOf(target, 'attributes');
  // What a button shows can be a person's name.
  assert.equal(label(element('button', [text('Remove Ada Lovelace')])), 'button');
  assert.equal(label(element('button', [text('Remove Ada Lovelace')], { 'data-testid': 'remove-member' })), 'button "remove-member"');
  assert.equal(label(element('td', [text('ada@example.com')], { 'data-test': 'email-cell' })), 'td "email-cell"');
  assert.equal(label(element('button', [text('×')], { 'aria-label': 'Remove member', 'data-test': 'remove' })), 'button "Remove member"');
  assert.equal(label(element('input', [], { placeholder: 'Search members', 'data-test': 'search' })), 'input "Search members"');
  assert.equal(label(element('div', [], { 'aria-label': 'B'.repeat(60) })), `div "${'B'.repeat(40)}"`);
});

test('a selector names the test attribute it was built from, with its value quoted', () => {
  const selectorOf = (target: Record<string, unknown>) => buildReport([entry('click', 0, 120, 3, 100, { target })], [], []).target?.selector;
  assert.equal(selectorOf(element('button', [], { 'data-testid': 'add to cart' })), 'button[data-testid="add to cart"]');
  assert.equal(selectorOf(element('input', [], { 'data-test': 'say "hi"' })), 'input[data-test="say \\"hi\\""]');
});

test('each revision is explained on first read, and a later render makes a new revision with its own verdict', () => {
  const data = buildReport([entry('click', 0, 120, 3, 100)], [commit(50, 0)], []);
  const later = commit(400, 0, { total: 40 });
  const next = attachLaterRender(data, later, []);
  assert.ok(next);
  const before = sealReport(data);
  const after = sealReport(next);
  assert.deepEqual([before.followUps.length, after.followUps.length], [0, 1]);
  assert.doesNotMatch(before.verdict, /after the screen updated/);
  assert.match(after.verdict, /A second React render landed 280 ms after the screen updated/);
  assert.equal(after.revision, 1);
  // The same render again is no revision at all.
  assert.equal(attachLaterRender(next, later, []), null);
  // A copy of the report carries the explanation like any other field.
  assert.equal(JSON.parse(JSON.stringify(after)).verdict, after.verdict);
});

test('later renders attach only by an exact stamp', () => {
  const r = buildReport([entry('click', 0, 120, 3, 100)], [], []);
  assert.equal(isLaterRender(r, commit(400, 0)), true);
  assert.equal(isLaterRender(r, commit(400, 0.8)), true);
  assert.equal(isLaterRender(r, commit(400, 2)), false);
  assert.equal(isLaterRender(r, commit(2000, 0)), false);
});

test('a render that came after a newer interaction had started is not a follow-up of the older one', () => {
  // Sorting a table and then changing its page size a second later: the page-size render is stamped
  // with whatever input the ring last held, which used to hand it to the sort click, and the sort was
  // reported as having re-rendered the whole table a second after it had finished.
  const sortClick = [entry('click', 0, 120, 3, 100)];
  const pageSizeRender = commit(1100, 0, { total: 400, rendered: 417 });
  const sortOnly = [input(0, 'click')];
  const thenPageSize = [input(0, 'click'), input(1000, 'pointerdown')];

  assert.equal(isLaterRender(buildReport(sortClick, [], [], sortOnly), pageSizeRender, sortOnly), true);
  assert.equal(isLaterRender(buildReport(sortClick, [], [], thenPageSize), pageSizeRender, thenPageSize), false);
  // Same through buildReport, which is where a report already built picks its follow-ups up.
  assert.deepEqual(buildReport(sortClick, [pageSizeRender], [], sortOnly).followUps, [joinedAs(pageSizeRender, 'exact')]);
  assert.deepEqual(buildReport(sortClick, [pageSizeRender], [], thenPageSize).followUps, []);

  // A render before that newer input still belongs to the click that caused it.
  const own = commit(900, 0, { total: 40 });
  assert.deepEqual(buildReport(sortClick, [own], [], thenPageSize).followUps, [joinedAs(own, 'exact')]);
  // The interaction's own later entries are not a newer interaction: a press, a release and a click
  // are one gesture, and a render after the last of them is still this gesture's.
  const gesture = [input(0, 'pointerdown', { gestureTs: 0 }), input(60, 'pointerup', { gestureTs: 0 }), input(61, 'click', { gestureTs: 0 })];
  const afterPress = buildReport(longPress, [commit(700, 61, { total: 40 })], [], gesture);
  assert.equal(afterPress.followUps.length, 1);
  // Only the pointerdown was slow enough to be observed, so the pointerup and the click that finished
  // the same gesture are known only by the press they released. They are not a newer interaction.
  const pressOnly = buildReport(longPress.slice(0, 1), [commit(700, 61, { gestureTs: 0, total: 40 })], [], gesture);
  assert.equal(pressOnly.followUps.length, 1);
});

test('a follow-up window is measured from the paint, so a slow interaction still gets the render that followed it', () => {
  // A 2.5 s interaction painting at 2503 ms, with its own follow-up 200 ms later. Measured from the
  // start of the interaction the follow-up is 2.7 s old and would be thrown away.
  const slow = [entry('click', 0, 2503, 3, 2480)];
  const after = commit(2700, 0, { total: 40 });
  assert.deepEqual(buildReport(slow, [after], [], [input(0, 'click')]).followUps, [joinedAs(after, 'exact')]);
  // Past the window from the paint it is still dropped.
  assert.deepEqual(buildReport(slow, [commit(4100, 0, { total: 40 })], [], [input(0, 'click')]).followUps, []);
});

test("the rating follows INP's thresholds", () => {
  assert.equal(report([entry('click', 0, 200, 1, 2)], [], []).explanation.rating, 'good');
  assert.equal(report([entry('click', 0, 208, 1, 2)], [], []).explanation.rating, 'needs-improvement');
  assert.equal(report([entry('click', 0, 504, 1, 2)], [], []).explanation.rating, 'poor');
});

/** The ring after a click at `ts` on a "Log in" button owned by SignInPage, whose onClick the ring named `handler` at dispatch. */
function loginClick(handler: string, ts = 0): InputRecord[] {
  return [input(ts, 'click', { target: element('button', [text('Log in')]) as unknown as Node, owners: ['SignInPage'], handler })];
}

test('a blame says whether it was measured or inferred', () => {
  // Handlers ran from 3 to 100 ms and the screen updated at 120.
  const slowClick = [entry('click', 0, 120, 3, 100)];
  const blame = (commits: CommitSummary[], frames: FrameSummary[] | null = [], inputs: InputRecord[] = [input(0, 'click')]) => {
    const { kind, confidence } = report(slowClick, commits, frames, inputs).explanation.blame;
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
  assert.equal(blame([commit(50, 0, { hasDurations: false, total: 0, rendered: 2 })], [], loginClick('handleLogin')), 'handler inferred');
  // The browser measured waiting and painting itself; with no commit and no Long Animation Frames, nothing rules scripts out.
  assert.equal(report([entry('click', 0, 120, 80, 100)], [], []).explanation.blame.confidence, 'measured');
  assert.equal(report([entry('click', 0, 40, 5, 10)], [], []).explanation.blame.confidence, 'measured');
  assert.equal(report([entry('click', 0, 40, 5, 10)], [], null).explanation.blame.confidence, 'inferred');
});

test('a render under 1 ms reads "under 1 ms", and a handler known only by its prop reads "the onClick handler"', () => {
  const slowClick = [entry('click', 0, 120, 3, 100)];
  const development = report(slowClick, [commit(50, 0, { total: 0.3, rendered: 2 })], [], loginClick('handleLogin'));
  assert.equal(development.explanation.cause, "The click handler handleLogin ran for about 97 ms; React's own render took under 1 ms.");
  // A minifier leaves the handler a one-letter name, so what the ring names it by is its prop.
  const production = report(slowClick, [commit(50, 0, { hasDurations: false, total: 0, rendered: 2 })], [], loginClick('onClick'));
  assert.equal(production.explanation.cause, 'The onClick handler most likely took the 97 ms: React re-rendered only 2 components. A profiling build of React would give exact numbers.');
});

test('a script the input waited behind is not its handler, and counts only for its part inside the interaction', () => {
  // A click at 1000 waited behind an analytics task that ran from 745 to 1045. Its own handler ran from
  // 1045 to 1065, rendering 2 components in 1 ms, and the screen updated at 1096.
  const waitedBehind = [frame(700, 400, [script('TimerHandler:setTimeout', 745, 300), script('DIV#root.onclick', 1045, 20)])];
  const r = report([entry('click', 1000, 96, 1045, 1065)], [commit(1060, 1000, { total: 1, rendered: 2 })], waitedBehind, loginClick('handleLogin', 1000));
  assert.deepEqual(r.explanation.blame, { kind: 'script', name: 'TimerHandler:setTimeout', detail: null, ms: 45, confidence: 'measured' });

  // Another click waited behind a task that forced 45 ms of layout, in the same frame as its own 60 ms
  // handler. That layout was not the handler's, so it is not taken out of the handler's time.
  const sameFrame = [frame(850, 254, [script('TimerHandler:setTimeout', 870, 160, 45), script('DIV#root.onclick', 1030, 60)])];
  const handled = report([entry('click', 1000, 104, 1030, 1090)], [commit(1088, 1000, { total: 2, rendered: 2 })], sameFrame, loginClick('handleLogin', 1000));
  assert.deepEqual(handled.explanation.blame, { kind: 'handler', name: 'handleLogin', detail: 'SignInPage', ms: 58, confidence: 'measured' });

  // A third click, handled from 1005 to 1065 and painted at 1104, while a task queued at 1070 ran on
  // until 1370. Only the 34 ms of it before the paint is inside the interaction; the rest came after
  // the screen had updated and is nothing the person waited for.
  const ranPast = [frame(1000, 400, [script('TimerHandler:setTimeout', 1070, 300)])];
  const overran = report([entry('click', 1000, 104, 1005, 1065)], [], ranPast, loginClick('handleLogin', 1000));
  assert.deepEqual(overran.explanation.blame, { kind: 'script', name: 'TimerHandler:setTimeout', detail: null, ms: 34, confidence: 'measured' });
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
  const r = report([entry('click', 0, 456, 3, 440)], [coarse], null);
  assert.deepEqual(r.explanation.blame, { kind: 'render', name: 'OrderSummary', detail: 'LineItem ×800', ms: 417, confidence: 'inferred' });
  assert.equal(r.commits[0]?.coarseClock, true);
  // Inferred, so the sentence hedges. The remedy is the clock, not the build, and it is the note that
  // names it: a profiling build would not make this commit's components timeable.
  assert.match(r.explanation.cause, /most likely/);
  assert.doesNotMatch(r.explanation.cause, /profiling build/);
  assert.ok(r.explanation.notes.some((note) => note.includes('clock steps in whole milliseconds')));
});

test('every sentence a blame can produce reads as inferred when the blame is inferred, and as a finding only when it was measured', () => {
  // The audit: whatever branch the explanation takes, the sentence and the confidence say the same
  // thing. An inferred blame names something the library worked out, so the sentence hedges; a
  // measured one does not hedge, because hedging a measurement makes every sentence worthless.
  const slow = [entry('click', 0, 120, 3, 100)];
  const ring = loginClick('handleLogin');
  const hydrated = (opts: Partial<CommitSummary>) => commit(50, 0, { hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' }, rendered: 40, total: 90, ...opts });
  const unjoinable = [input(0, 'click', { work: { endedAt: 0, unjoined: [50] } })];
  const cases: [string, InteractionReport][] = [
    ['hydration measured', report(slow, [hydrated({})], [], ring)],
    ['hydration inferred', report(slow, [hydrated({ hasDurations: false, total: 0, components: [] })], [], ring)],
    ['handler measured', report(slow, [commit(50, 0, { total: 2 })], [], ring)],
    ['handler inferred', report(slow, [commit(50, 999, { total: 2 })], [], ring)],
    ['handler counted', report(slow, [commit(50, 0, { hasDurations: false, total: 0, rendered: 2 })], [], ring)],
    ['render measured', report(slow, [commit(50, 0, { total: 90 })], [], ring)],
    ['render truncated', report(slow, [commit(50, 0, { total: 90, truncated: true })], [], ring)],
    ['render counted', report(slow, [commit(50, 0, { hasDurations: false, total: 0, rendered: 800 })], [], ring)],
    ['waiting', report([entry('click', 0, 400, 380, 385)], [], [], ring)],
    ['painting', report([entry('click', 0, 400, 3, 10)], [], [], ring)],
    ['script measured', report([entry('click', 1000, 96, 1045, 1065)], [], [frame(700, 400, [script('TimerHandler:setTimeout', 745, 300)])], loginClick('handleLogin', 1000))],
    ['script unjoined', report(slow, [], [frame(0, 119, [script('TimerHandler:setTimeout', 4, 90)])], unjoinable)],
    ['nothing stood out', report([entry('click', 0, 40, 5, 10)], [], [], ring)],
    ['no long task record', report([entry('click', 0, 40, 5, 10)], [], null, ring)],
  ];
  const seen = new Set<string>();
  for (const [name, r] of cases) {
    const { kind, confidence } = r.explanation.blame;
    seen.add(kind);
    if (kind === 'none') {
      // Nothing is named, so there is nothing to hedge either way.
      assert.doesNotMatch(r.explanation.cause, /most likely/, name);
    } else if (confidence === 'inferred') {
      assert.match(r.explanation.cause, /most likely/, name);
      assert.match(r.verdict, /most likely/, name);
    } else {
      assert.doesNotMatch(r.explanation.cause, /most likely/, name);
      // A measurement never offers the remedy for not having measured.
      assert.doesNotMatch(r.explanation.cause, /profiling build/, name);
    }
    // The remedy is named only where a build with no durations is what made it a reading.
    if (/profiling build/.test(r.explanation.cause)) assert.equal(r.commits.some((x) => !x.hasDurations), true, name);
  }
  // Every kind of blame the explanation can reach was audited.
  assert.deepEqual([...seen].sort(), ['handler', 'hydration', 'none', 'painting', 'render', 'script', 'waiting']);
});

test('a commit that hydrated is described as hydrating, not re-rendering', () => {
  const r = report([entry('click', 0, 120, 3, 100)], [commit(50, 0, { hydrated: true, total: 90 })], []);
  assert.equal(r.explanation.cause, 'React spent 90 ms hydrating 30 components inside List, mostly Row (30 of them, 20 ms).');
});

test('a report is placed in the navigation its interaction began in, and names the soft navigation its input started', () => {
  const home: PageNavigation = { url: 'https://shop.example/', type: 'navigate', start: 0, router: null };
  // A link pressed at 990 ms and clicked at 1000: the router announced the cart while the click was dispatched.
  const cart: PageNavigation = { url: 'https://shop.example/cart', type: 'soft-navigation', start: 1004, router: { type: 'push', input: { inputTs: 1000, gestureTs: 990 } } };
  const placeOf = (entries: ReturnType<typeof entry>[]) => {
    const { navigationURL, navigationType, startedNavigation } = buildReport(entries, [], [], [], 'attributes', [home, cart]);
    return { navigationURL, navigationType, startedNavigation };
  };
  const toCart = { url: cart.url, type: 'push' };

  assert.deepEqual(placeOf([entry('pointerdown', 990, 16, 991, 993), entry('click', 1000, 64, 1002, 1050)]), { navigationURL: home.url, navigationType: 'navigate', startedNavigation: toCart });
  // Only the press was slow enough to be observed; the click it released still names the navigation.
  assert.deepEqual(placeOf([entry('pointerdown', 990, 24, 991, 1006)]), { navigationURL: home.url, navigationType: 'navigate', startedNavigation: toCart });
  assert.deepEqual(placeOf([entry('click', 3000, 64, 3002, 3050)]), { navigationURL: cart.url, navigationType: 'soft-navigation', startedNavigation: null });
});

test('a click that waited for React to hydrate the boundary it landed in is blamed on that, and the wait is part of the working time', () => {
  // 120 ms click: 3 ms before the handler could start, then React hydrating the boundary the button
  // was inside, then the paint.
  const hydration = commit(50, 0, { hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' }, rendered: 40, total: 90 });
  const r = report([entry('click', 0, 120, 3, 100)], [hydration], []);

  assert.deepEqual(r.hydration, { kind: 'waited', scope: 'boundary', owner: 'ProductPage', ms: 90 });
  assert.equal(r.explanation.cause, 'The click landed on server-rendered HTML that had not been hydrated yet, so React hydrated the Suspense boundary in ProductPage first: 90 ms of the 97 ms of working time.');
  assert.deepEqual(r.explanation.blame, { kind: 'hydration', name: 'the Suspense boundary in ProductPage', detail: 'Row ×30', ms: 90, confidence: 'measured' });

  // The hydration is a named part of the working time, so the three phases still add up to the interaction.
  const phases = r.explanation.phases;
  assert.deepEqual(phases.map((p) => [p.label, p.ms]), [['Waiting', 3], ['Working', 97], ['Updating the screen', 20]]);
  assert.deepEqual(phases[1]?.parts, [{ label: 'Hydrating', ms: 90, hint: 'React hydrating server-rendered HTML the interaction landed on, before it could be handled.' }]);
});

test('a production build says React hydrated the boundary and stops short of saying how long it took', () => {
  const hydration = commit(50, 0, { hydrated: true, hydratedTarget: { scope: 'root', owner: null }, rendered: 40, hasDurations: false, total: 0, components: [] });
  const r = report([entry('click', 0, 120, 3, 100)], [hydration], []);

  assert.deepEqual(r.hydration, { kind: 'waited', scope: 'root', owner: null, ms: null });
  assert.equal(r.explanation.blame.confidence, 'inferred');
  assert.match(r.explanation.cause, /most likely/);
  assert.match(r.explanation.cause, /records no render durations/);
  assert.match(r.explanation.cause, /A profiling build of React would give exact numbers\./);
  assert.equal(r.explanation.blame.ms, null);
  assert.equal(r.explanation.phases[1]?.parts, undefined);
});

test('a hydration commit the interaction did not wait for is a note, not the blame', () => {
  // A boundary elsewhere on the page hydrated during the click: hydratedTarget is null, so the
  // ordinary render blame stands and the hydration is only worth a sentence.
  const elsewhere = commit(50, 0, { hydrated: true, total: 90 });
  const r = report([entry('click', 0, 120, 3, 100)], [elsewhere], []);
  assert.equal(r.hydration, null);
  assert.equal(r.explanation.blame.kind, 'render');
});

test('a click on HTML React never hydrated says so first, and still says where the time went', () => {
  // React stops an event at a boundary it has not reached, so almost no working time goes by: the
  // 400 ms was spent waiting for the main thread. The blame stays on that, because that is what a
  // blame is for; the hydration is the sentence in front of it.
  const button = input(0, 'click', { dehydrated: { scope: 'boundary', owner: 'ProductPage' } });
  const r = report([entry('click', 0, 400, 380, 385)], [], [], [button]);

  assert.deepEqual(r.hydration, { kind: 'not-hydrated', scope: 'boundary', owner: 'ProductPage', ms: null });
  assert.equal(
    r.explanation.cause,
    'This click landed on server-rendered HTML that React had not hydrated yet, so React did not dispatch it and no React handler ran for it. The click waited 380 ms before its handler could start: the main thread was busy with something else.',
  );
  assert.deepEqual(r.explanation.blame, { kind: 'waiting', name: null, detail: null, ms: 380, confidence: 'measured' });
});

test('a hydration too small to be the story is a note beside the ordinary blame, not the blame', () => {
  // 8 ms of hydrating in front of a 369 ms handler. The boundary is still reported on r.hydration and
  // still shown in the phase bar; what it is not is the answer to why the click was slow.
  const hydration = commit(50, 0, { hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' }, rendered: 3, total: 8 });
  const r = report([entry('click', 0, 400, 3, 380)], [hydration], []);

  assert.deepEqual(r.hydration, { kind: 'waited', scope: 'boundary', owner: 'ProductPage', ms: 8 });
  assert.equal(r.explanation.blame.kind, 'handler');
  assert.ok(r.explanation.notes.includes('It landed on server-rendered HTML that had not been hydrated yet, and React hydrated the Suspense boundary in ProductPage during it. That was not what took the time here.'));
  assert.deepEqual(r.explanation.phases[1]?.parts?.map((p) => [p.label, p.ms]), [['Hydrating', 8]]);
});

test('a commit that rendered no component at all is not described as a re-render of none', () => {
  // React commits with nothing rendered: a retry that found the boundary still blocked, which is what
  // a click on HTML React cannot hydrate leaves behind.
  const empty = commit(50, 0, { rendered: 0, components: [], total: 90, roots: ['app'], hotPath: ['app'] });
  const r = report([entry('click', 0, 120, 3, 100)], [empty], []);
  assert.equal(r.explanation.cause, 'React spent 90 ms committing without rendering a component.');
});

test('a production build does not say the hydration was not what took the time, having measured neither', () => {
  // Same note without durations. Whether the hydration or the handler took the 97 ms is exactly what
  // this build cannot say, so the note stops at what happened.
  const hydration = commit(50, 0, { hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' }, rendered: 1, hasDurations: false, total: 0, components: [] });
  const r = report([entry('click', 0, 120, 3, 100)], [hydration], [], loginClick('handleLogin'));

  assert.deepEqual(r.hydration, { kind: 'waited', scope: 'boundary', owner: 'ProductPage', ms: null });
  assert.equal(r.explanation.blame.kind, 'handler');
  assert.ok(r.explanation.notes.includes('It landed on server-rendered HTML that had not been hydrated yet, and React hydrated the Suspense boundary in ProductPage during it.'));
  assert.equal(r.explanation.notes.some((n) => n.includes('That was not what took the time here')), false);
});

test('the commit that hydrated is not counted as one of the renders before the screen updated', () => {
  // Hydrating a boundary and then rendering what the handler changed is two commits, and the second
  // is the only render. Counting both would send every such click looking for an effect loop.
  const hydration = commit(50, 0, { hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' }, rendered: 3, total: 8 });
  const handled = commit(70, 0, { rendered: 4, total: 12 });
  const r = report([entry('click', 0, 400, 3, 380)], [hydration, handled], []);

  assert.equal(r.commits.length, 2);
  assert.equal(r.explanation.notes.some((n) => n.includes('React rendered')), false);
  // Two commits that are both ordinary renders still earn the note.
  const twice = report([entry('click', 0, 400, 3, 380)], [commit(50, 0, { rendered: 3, total: 8 }), handled], []);
  assert.ok(twice.explanation.notes.some((n) => n.includes('React rendered 2 times before the screen updated')));
});

test('a press before hydration and a click after it is not a click on HTML React never hydrated', () => {
  // The pointerdown landed on HTML that was waiting; by the click React had hydrated it and handled
  // it. Reading the newest input of the interaction, not the first, is what keeps the two apart.
  const entries = [entry('pointerdown', 0, 40, 1, 5), entry('click', 20, 100, 22, 100)];
  const waiting = input(0, 'pointerdown', { dehydrated: { scope: 'root', owner: null } });
  const handled = input(20, 'click', { handler: 'onClick' });
  assert.equal(report(entries, [], [], [waiting, handled]).hydration, null);
  // Both still waiting is the case the sentence is for.
  assert.equal(report(entries, [], [], [waiting, input(20, 'click', { dehydrated: { scope: 'root', owner: null } })]).hydration?.kind, 'not-hydrated');
});
