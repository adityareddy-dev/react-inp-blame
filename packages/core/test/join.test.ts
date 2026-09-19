import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachLaterRender, buildReport, isLaterRender, refreshReport, sealReport, type LabelSource } from '../src/join.ts';
import type { PageNavigation } from '../src/navigation.ts';
import type { CommitSummary, FrameSummary, InputRecord, ScriptSummary } from '../src/types.ts';

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
  return { ts, type, gestureTs: ts, press: undefined, target: null, owners: [], handler: null, ...extra };
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

/** The empty comment React's server renderer puts between two adjacent text children, kept by hydration. */
function separator(): Record<string, unknown> {
  return { nodeType: 8, nodeValue: '', parentNode: null, parentElement: null, nextSibling: null, firstChild: null };
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
  // The same button hydrated from server HTML, where React separated those three with empty comments.
  assert.equal(label(element('button', [text('Add to cart ('), separator(), text('3'), separator(), text(')')])), 'button "Add to cart (3)"');
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
  assert.equal(r.explanation.cause, 'React spent 417 ms re-rendering 801 components inside OrderSummary, mostly LineItem (800 of them).');
  assert.ok(r.explanation.notes.some((note) => note.includes('clock steps in whole milliseconds')));
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
