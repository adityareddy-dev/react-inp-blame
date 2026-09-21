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
  // A key press with nothing focused lands on the body, whose first text is often the noscript line.
  assert.equal(label(element('body', [element('noscript', [text('You need to enable JavaScript to run this app.')]), element('div', [text('Companies')])])), 'body "Companies"');
  assert.equal(label(element('body', [element('noscript', [text('You need to enable JavaScript.')]), element('script', [text('var a = 1')])])), 'body');
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

test('a click on an icon is labelled by the control it is inside, and its selector stays the element it landed on', () => {
  // The hamburger of a menu button: the click lands on a line of its svg.
  const line = element('line', []);
  element('button', [element('svg', [element('g', [line])])], { 'data-testid': 'main-menu-trigger' });
  assert.equal(labelOf(line, 'attributes'), 'button "main-menu-trigger"');
  assert.equal(buildReport([entry('click', 0, 120, 3, 100, { target: line })], [], []).target?.selector, 'line');

  // A div given a role is a control too.
  const glyph = element('span', []);
  element('div', [glyph], { role: 'menuitem', 'aria-label': 'Export image' });
  assert.equal(labelOf(glyph, 'attributes'), 'div "Export image"');

  // Nothing close by that a click activates: the element keeps its own label.
  const cell = element('td', [], { 'data-test': 'email-cell' });
  element('tr', [cell]);
  assert.equal(labelOf(cell, 'attributes'), 'td "email-cell"');

  // A link six levels up is a card around the content, not the thing that was clicked.
  const deep = element('em', []);
  element('a', [element('div', [element('div', [element('div', [element('div', [element('p', [deep])])])])])], { 'aria-label': 'Open article' });
  assert.equal(labelOf(deep, 'attributes'), 'em');
});

test('a selector names the test attribute it was built from, with its value quoted', () => {
  const selectorOf = (target: Record<string, unknown>) => buildReport([entry('click', 0, 120, 3, 100, { target })], [], []).target?.selector;
  assert.equal(selectorOf(element('button', [], { 'data-testid': 'add to cart' })), 'button[data-testid="add to cart"]');
  assert.equal(selectorOf(element('input', [], { 'data-test': 'say "hi"' })), 'input[data-test="say \\"hi\\""]');
});

/** What a click on a button the ring saw inside `owners` reports as its component and its `where`. */
function clickedInside(owners: string[]): { component: string | null; owners: readonly string[]; where: string | null } {
  const ring = [input(0, 'click', { target: element('button', []) as unknown as Node, owners })];
  const r = report([entry('click', 0, 120, 3, 100)], [], [], ring);
  return { component: r.target?.component ?? null, owners: r.target?.owners ?? [], where: r.explanation.where };
}

test('where names the nearest owner a reader could go and look for, and the whole chain stays in the data', () => {
  // The innermost owner of a real app's element is usually its design system's, and in a production
  // build it is often a name the minifier chose. These chains are the shadcn/ui documentation site's.
  const table = ['header', 'TableHead', 'TableRow', 'TableHeader', 'Table', 'DataTableDemo'];
  assert.deepEqual(clickedInside(table), { component: 'TableHead', owners: table, where: 'button in TableHead' });

  // A component name is capitalised, by React's own rule. `header` is a column definition's render
  // function taking its name from the property it was assigned to, and it reads as an HTML tag.
  assert.equal(clickedInside(['header', 'Toolbar']).component, 'Toolbar');
  // A dotted name counts only when every part of it does: `Primitive.button` names the element that
  // was clicked, so "button in Primitive.button" says nothing the reader did not write themselves.
  assert.equal(clickedInside(['Primitive.button', 'Primitive.span.SlotClone', 'RovingFocusGroupItem']).component, 'RovingFocusGroupItem');
  // One and two character names are what a minifier leaves on a dependency that ships no displayName.
  assert.equal(clickedInside(['_', 'ee', 'V', 'Q', 'Root', 'Calendar', 'CalendarDemo']).component, 'Root');
  // The nearest owner is usually the readable one, and then nothing moves.
  assert.equal(clickedInside(['Button', 'ModeSwitcher', 'x', 'f']).component, 'Button');
  // With nothing readable in the chain the nearest is still named: a name is never invented.
  assert.deepEqual(clickedInside(['$', '_']), { component: '$', owners: ['$', '_'], where: 'button in $' });
  assert.deepEqual(clickedInside([]), { component: null, owners: [], where: 'button' });
});

test('a short or uncapitalised name is only ever passed over for one that is better, never dropped', () => {
  // Real components are named this way and the rule reads them as minifier output or as HTML tags.
  // Skipping one costs nothing while something better is above it, and the test is what is above,
  // not the name: with nothing better there, the name is printed as it is.
  for (const name of ['H1', 'H2', 'Li', 'Td', 'Tr', 'Ul', 'motion.div', 'styled.button']) {
    assert.equal(clickedInside([name]).component, name, `${name} alone in the chain`);
    assert.equal(clickedInside([name, 'x', '$']).component, name, `${name} with nothing readable above it`);
    assert.equal(clickedInside([name, 'ProductCard']).component, 'ProductCard', `${name} below a component with a fuller name`);
  }

  // The honest limit of the rule. A short capitalised name is what a minifier leaves as often as it
  // is what someone typed, and nothing in a name says which; both of these are taken at face value.
  assert.equal(clickedInside(['Abc', 'ProductCard']).component, 'Abc');
  assert.equal(clickedInside(['Xe1', 'ProductCard']).component, 'Xe1');
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

test('forced layout the browser measured outranks a render no build timed', () => {
  // Switching a tabbed code block on a documentation site: a 128 ms click whose 116 ms of working
  // time was 108 ms of the browser recalculating layout, measured from a long animation frame,
  // against a render a production build of React records no duration for at all. Blaming the render
  // sends the reader memoising components when the fix is a layout read.
  const tabs = [entry('click', 0, 128, 2, 118)];
  const thrash = [frame(0, 128, [script('DIV#root.onmousedown', 2, 116, 108)])];
  const rerender = commit(60, 0, {
    hasDurations: false,
    total: 0,
    rendered: 181,
    roots: ['Tabs'],
    hotPath: ['Tabs', 'RovingFocusGroupCollectionSlot.SlotClone'],
    components: [{ name: 'TabsTrigger', count: 16, self: null, total: null }],
  });
  const r = report(tabs, [rerender], thrash, [input(0, 'click')]);

  // Nothing names the read that forced the layout, but the subtree it happened in is held and is the
  // only thing here a reader can open a file on, so it is what the blame carries.
  assert.deepEqual(r.explanation.blame, {
    kind: 'layout',
    name: 'RovingFocusGroupCollectionSlot.SlotClone',
    detail: 'TabsTrigger ×16',
    ms: 108,
    confidence: 'measured',
  });
  assert.equal(
    r.explanation.cause,
    'The browser spent 108 ms of the 116 ms spent handling the click recalculating layout, leaving 8 ms for' +
      " React's render and commit, its layout effects and the click handler together." +
      // Where the layout happened and where React was working are two records, and only the first is
      // the browser's. The sentence carries both, so the subtree is never the only thing named.
      ' It was charged to DIV#root.onmousedown.' +
      ' React was re-rendering 181 components inside RovingFocusGroupCollectionSlot.SlotClone, mostly TabsTrigger (16 of them).' +
      " That happens when code reads an element's size right after changing styles, often in a layout effect.",
  );
  // The note would say the same thing a second time.
  assert.equal(r.explanation.notes.some((note) => note.includes('recalculating layout')), false);

  // Half the working time is what makes it the answer rather than a note: under that the render keeps the blame.
  const little = report(tabs, [rerender], [frame(0, 128, [script('DIV#root.onmousedown', 2, 116, 40)])], [input(0, 'click')]);
  assert.equal(little.explanation.blame.kind, 'render');
  assert.ok(little.explanation.notes.some((note) => note.includes('recalculating layout')));

  // A render React did time, and timed higher than the layout, keeps it too.
  const timed = report(tabs, [commit(60, 0, { total: 110, rendered: 181 })], thrash, [input(0, 'click')]);
  assert.equal(timed.explanation.blame.kind, 'render');
});

test('without render durations a forced layout under a long task still takes the blame from 25 ms', () => {
  // Opening a sheet on a documentation site, production build: a 64 ms click, 55 ms of working time,
  // 47 ms of it layout. At a 50 ms floor the same click came back a render on one run and a layout
  // on the next, on a millisecond or two of difference.
  const open = [entry('click', 0, 64, 2, 57)];
  const counted = commit(30, 0, { hasDurations: false, total: 0, rendered: 59, roots: ['Dialog'], hotPath: ['Dialog', 'DismissableLayer'] });
  const layout = (forced: number) => report(open, [counted], [frame(0, 64, [script('#document.onclick', 2, 55, forced)])], [input(0, 'click')]).explanation.blame;

  assert.deepEqual({ kind: layout(47).kind, ms: layout(47).ms, confidence: layout(47).confidence }, { kind: 'layout', ms: 47, confidence: 'measured' });
  assert.equal(layout(50).kind, 'layout');
  // Half the window still has to be layout.
  assert.equal(layout(26).kind, 'render');

  // Under 25 ms it did not make anything slow, whatever share of a short window it holds.
  const quick = report([entry('click', 0, 40, 2, 32)], [counted], [frame(0, 40, [script('#document.onclick', 2, 30, 24)])], [input(0, 'click')]);
  assert.equal(quick.explanation.blame.kind, 'render');

  // A build that times its renders keeps the long task floor: two measured numbers are a fair fight.
  const timed = report(open, [commit(30, 0, { total: 4, rendered: 59 })], [frame(0, 64, [script('#document.onclick', 2, 55, 47)])], [input(0, 'click')]);
  assert.equal(timed.explanation.blame.kind, 'script');

  // A click that waited 300 ms behind another task and then spent 26 of its 50 ms on layout was slow
  // in the wait, with or without a commit.
  const behind = report(
    [entry('click', 0, 352, 300, 350)],
    [],
    [frame(0, 352, [script('other.task', 0, 300, 0), script('#document.onclick', 300, 50, 26)])],
    [input(0, 'click')],
  );
  assert.equal(behind.explanation.blame.kind, 'waiting');
});

test('a forced layout apportioned across the edge of the working time is the likeliest reading, not a measurement', () => {
  // The API gives a script's forced layout as one total and never says when in the script it
  // happened, so a script that ran on past the handlers has its layout shared out by time. That
  // share is an estimate, and a blame built on it says so.
  const tabs = [entry('click', 0, 128, 2, 118)];
  const overran = [frame(0, 200, [script('DIV#root.onmousedown', 2, 180, 170)])];
  const r = report(tabs, [], overran, [input(0, 'click')]);
  assert.equal(r.explanation.blame.kind, 'layout');
  assert.equal(r.explanation.blame.confidence, 'inferred');
  assert.match(r.explanation.cause, /most likely/);
  // No commit joined, so the only record of where it happened is the script the browser charged the
  // layout to. That is the browser's own label for it, and there is nothing better held to use.
  assert.equal(r.explanation.blame.name, 'DIV#root.onmousedown');
  assert.equal(r.explanation.blame.detail, null);
});

test('a layout forced from inside a render body is not reported as time the render was left out of', () => {
  // The browser charges forced layout to the script it happened in, and React's render durations are
  // taken separately, so reading geometry in a render body puts the same milliseconds in both. The
  // remainder bounds nothing then, and printing it contradicted the sentence about the render next.
  const r = report(
    [entry('click', 0, 128, 2, 118)],
    [commit(60, 0, { total: 107, rendered: 181, roots: ['Tabs'], hotPath: ['Tabs', 'Measured'], components: [{ name: 'Row', count: 40, self: 90, total: 90 }] })],
    [frame(0, 128, [script('DIV#root.onmousedown', 2, 116, 108)])],
    [input(0, 'click')],
  );
  assert.equal(r.explanation.blame.kind, 'layout');
  assert.match(r.explanation.cause, /which overlaps React's own render/);
  assert.doesNotMatch(r.explanation.cause, /leaving/);
});

test("the share a forced layout has to reach is taken over the window it was counted in, the library's own walk included", () => {
  // Scripts are counted to the end of the walk this library does inside the same task, and the walk
  // is taken back out of the working time, so the two figures cover different spans. Measuring the
  // share against the shorter one let a long walk carry a layout over the line.
  const click = [entry('click', 0, 200, 2, 122)];
  const walked = commit(60, 0, { walkMs: 20 });
  const thrash = (forced: number) => [frame(0, 130, [script('DIV#root.onmousedown', 2, 120, forced)])];

  // 100 ms of working time, 20 of walk, 52 ms of layout: half of the working time, not half of the
  // 120 the layout was measured across.
  const under = report(click, [walked], thrash(52), [input(0, 'click')]);
  assert.equal(under.explanation.blame.kind, 'render');
  assert.ok(under.explanation.notes.some((note) => note.includes('recalculating layout')));

  const over = report(click, [walked], thrash(62), [input(0, 'click')]);
  assert.equal(over.explanation.blame.kind, 'layout');
});

test('a forced layout is never reported as more of the working time than the working time it was measured across', () => {
  // The scripts are counted to the end of the library's own walk and the working time has that walk
  // taken back out, so printing one against the other read "110 ms of the 100 ms of working time".
  const r = report(
    [entry('click', 0, 200, 0, 120)],
    [commit(90, 0, { walkMs: 20, hasDurations: false, total: 0, rendered: 40 })],
    [frame(0, 130, [script('DIV#root.onclick', 0, 118, 110)])],
    [input(0, 'click')],
  );
  assert.equal(r.explanation.blame.kind, 'layout');
  assert.match(r.explanation.cause, /110 ms of the 120 ms/);
  assert.doesNotMatch(r.explanation.cause, /of the 100 ms/);
});

test('a rung the screen update closes still says what it would have named', () => {
  // A 200 ms render inside a 425 ms interaction, beaten by 215 ms of screen update. The screen
  // update is the right verdict and the render is still worth knowing about, and the note that
  // usually carries the screen update is suppressed here precisely because the screen update won.
  const rendered = report([entry('click', 0, 425, 0, 210)], [commit(100, 0, { total: 200, rendered: 300 })], []);
  assert.equal(rendered.explanation.blame.kind, 'painting');
  assert.ok(
    rendered.explanation.notes.some((note) => note.includes('200 ms') && note.includes('Row')),
    `expected a note naming the render, got ${JSON.stringify(rendered.explanation.notes)}`,
  );

  // The same for the handler rung: 100 ms of the 110 ms of working time outside React, and 120 ms
  // of screen update after it.
  const handled = report([entry('click', 0, 230, 0, 110)], [commit(40, 0, { total: 10, rendered: 30 })], [], loginClick('handleLogin'));
  assert.equal(handled.explanation.blame.kind, 'painting');
  assert.ok(
    handled.explanation.notes.some((note) => note.includes('handleLogin') && note.includes('100 ms')),
    `expected a note naming the handler, got ${JSON.stringify(handled.explanation.notes)}`,
  );
});

test('a layout blame names a React subtree only while the commit it came from is tied to this interaction', () => {
  // The forced layout is the browser's measurement whatever React did. The name beside it is not:
  // it comes from a commit, and a commit React made during the interaction that could not be tied
  // to it leaves no way to know the layout happened in the subtree being named.
  const tabs = [entry('click', 0, 128, 2, 118)];
  const thrash = [frame(0, 128, [script('DIV#root.onmousedown', 2, 116, 108)])];
  const rerender = commit(60, 0, { hasDurations: false, total: 0, rendered: 181, roots: ['Tabs'], hotPath: ['Tabs', 'TabsList'], components: [{ name: 'TabsTrigger', count: 16, self: null, total: null }] });

  const loose = report(tabs, [rerender], thrash, [input(0, 'click', { work: { endedAt: 0, unjoined: [60] } })]);
  // The number and the invoker are both the browser's, so nothing in the blame is a reading and the
  // confidence stays what the measurement is. What is dropped is the name that was not measured.
  assert.deepEqual(loose.explanation.blame, { kind: 'layout', name: 'DIV#root.onmousedown', detail: null, ms: 108, confidence: 'measured' });

  // A production build times no render, which says nothing about whether the commit is this
  // interaction's. Those names are still good and are still printed.
  const tight = report(tabs, [rerender], thrash, [input(0, 'click')]);
  assert.equal(tight.explanation.blame.name, 'TabsList');
  assert.equal(tight.explanation.blame.detail, 'TabsTrigger ×16');
  assert.equal(tight.explanation.blame.confidence, 'measured');

  // A commit joined by overlapping the interaction in time, or one whose walk was cut short, is the
  // same missing evidence in a different form.
  const overlapped = report(tabs, [{ ...rerender, inputTs: 999, gestureTs: 999, sinceInput: 0 }], thrash, [input(0, 'click')]);
  assert.equal(overlapped.commits[0].joinedBy, 'overlap');
  assert.equal(overlapped.explanation.blame.name, 'DIV#root.onmousedown');
  const cut = report(tabs, [{ ...rerender, truncated: true }], thrash, [input(0, 'click')]);
  assert.equal(cut.explanation.blame.name, 'DIV#root.onmousedown');
});

test('a layout blame says which script the browser charged the layout to, whatever the commit is called', () => {
  // The blame's name is the subtree the reader can open a file on, and the browser charged the
  // layout to something else entirely: an observer callback that ran inside the same window. The
  // name alone would send the reader to the wrong file, so the sentence carries the invoker.
  const r = report(
    [entry('click', 0, 200, 2, 122)],
    [commit(60, 0, { total: 10, rendered: 4, roots: ['Header'], hotPath: ['Header', 'ThemeToggle'], components: [{ name: 'Icon', count: 4, self: 2, total: 2 }] })],
    [frame(0, 130, [script('DIV#root.onclick', 2, 18, 0), script('IntersectionObserver.callback', 25, 95, 70)])],
    [input(0, 'click')],
  );
  assert.equal(r.explanation.blame.kind, 'layout');
  assert.equal(r.explanation.blame.name, 'ThemeToggle');
  assert.match(r.explanation.cause, /It was charged to IntersectionObserver\.callback\./);

  // With nothing but the invoker to go on the blame is named after it, and the sentence still says
  // so: the cause is read on its own, by people who never see the blame's fields.
  const alone = report([entry('click', 0, 200, 2, 122)], [], [frame(0, 130, [script('IntersectionObserver.callback', 25, 95, 70)])], [input(0, 'click')]);
  assert.equal(alone.explanation.blame.name, 'IntersectionObserver.callback');
  assert.match(alone.explanation.cause, /It was charged to IntersectionObserver\.callback\./);
});

test('a forced layout several scripts share is not credited to the largest of them', () => {
  // Two scripts forcing layout in the same window. Naming one of them beside the total tells the
  // reader that script cost 220 ms when it cost 120, and sends them to optimise the wrong one.
  const r = report(
    [entry('click', 0, 400, 2, 302)],
    [commit(60, 0, { total: 10, rendered: 4, roots: ['Header'], hotPath: ['Header', 'ThemeToggle'], components: [{ name: 'Icon', count: 4, self: 2, total: 2 }] })],
    [frame(0, 320, [script('DIV#root.onclick', 2, 140, 120), script('IntersectionObserver.callback', 150, 140, 100)])],
    [input(0, 'click')],
  );
  assert.equal(r.explanation.blame.kind, 'layout');
  assert.equal(r.explanation.blame.ms, 220);
  // The share, not the total, beside the name of the script that holds it.
  assert.match(r.explanation.cause, /120 ms of it was charged to DIV#root\.onclick\./);

  // And where the blame has only an invoker to be named after, no one script holds enough of the
  // total to wear it: 80 of 225 is not where the layout happened, it is where some of it happened.
  const spread = report(
    [entry('click', 0, 500, 2, 402)],
    [],
    [frame(0, 420, [script('DIV#root.onclick', 2, 100, 80), script('IntersectionObserver.callback', 110, 100, 75), script('ResizeObserver.callback', 220, 100, 70)])],
    [input(0, 'click')],
  );
  assert.equal(spread.explanation.blame.kind, 'layout');
  assert.equal(Math.round(spread.explanation.blame.ms!), 225);
  assert.equal(spread.explanation.blame.name, null);
  assert.match(spread.explanation.cause, /80 ms of it was charged to DIV#root\.onclick\./);

  // One script holding effectively all of it is still named plainly, with no share to split out.
  const single = report(
    [entry('click', 0, 400, 2, 202)],
    [],
    [frame(0, 220, [script('DIV#root.onclick', 2, 140, 120), script('IntersectionObserver.callback', 150, 50, 2)])],
    [input(0, 'click')],
  );
  assert.equal(single.explanation.blame.name, 'DIV#root.onclick');
  assert.match(single.explanation.cause, /It was charged to DIV#root\.onclick\./);
});

test('the note standing in for a closed rung is hedged exactly as that rung would have been', () => {
  // The note says what the verdict would have been, so it is worth no more than that verdict was.
  // A commit that only overlapped the interaction in time, one walked short of the end, and one
  // beside commits that could not be tied to the interaction are all readings, not measurements.
  const click = [entry('click', 0, 425, 0, 210)];
  const heavy = commit(100, 0, { total: 200, rendered: 300 });
  const noteOf = (r: InteractionReport) => r.explanation.notes.find((n) => n.includes('before that.')) ?? '';

  assert.match(noteOf(report(click, [heavy], [])), /^React still spent 200 ms re-rendering/);
  assert.match(noteOf(report(click, [{ ...heavy, inputTs: 999, gestureTs: 999 }], [], [input(0, 'click')])), /most likely/);
  assert.match(noteOf(report(click, [{ ...heavy, truncated: true }], [])), /most likely/);
  assert.match(noteOf(report(click, [heavy], [], [input(0, 'click', { work: { endedAt: 0, unjoined: [100] } })])), /most likely/);

  // The handler note is hedged on the same evidence its own rung is.
  const handled = [entry('click', 0, 230, 0, 110)];
  const small = commit(40, 0, { total: 10, rendered: 30 });
  const handlerNote = (r: InteractionReport) => r.explanation.notes.find((n) => n.includes('handleLogin')) ?? '';
  assert.doesNotMatch(handlerNote(report(handled, [small], [], loginClick('handleLogin'))), /most likely/);
  assert.match(handlerNote(report(handled, [{ ...small, truncated: true }], [], loginClick('handleLogin'))), /most likely/);
});

test('the note standing in for a closed rung is not printed when no rung was closed', () => {
  // Hydration is decided above the screen-update comparison, so nothing was closed by it. Printing
  // the note anyway reported the same 200 ms twice, once as the verdict and once as a leftover.
  const r = report(
    [entry('click', 0, 700, 0, 300)],
    [commit(100, 0, { total: 200, rendered: 300, hydrated: true, hydratedTarget: 'Shell' })],
    [],
    [input(0, 'click', { dehydrated: { boundary: 'Shell', kind: 'waited', ms: 200 } as never })],
  );
  assert.equal(r.explanation.blame.kind, 'hydration');
  assert.equal(
    r.explanation.notes.some((n) => n.startsWith('React still')),
    false,
    `expected no closed-rung note, got ${JSON.stringify(r.explanation.notes)}`,
  );
});

test('the note standing in for a closed render rung counts the commit it names, not every commit', () => {
  // The rung it replaces blames one commit and prints that commit's own total. Summing every commit
  // into the note put 200 ms beside a phrase describing the 80 ms one.
  const r = report(
    [entry('click', 0, 425, 0, 210)],
    [commit(40, 0, { total: 60, rendered: 20 }), commit(70, 0, { total: 60, rendered: 20 }), commit(100, 0, { total: 80, rendered: 300 })],
    [],
  );
  assert.equal(r.explanation.blame.kind, 'painting');
  const note = r.explanation.notes.find((n) => n.startsWith('React still')) ?? '';
  assert.match(note, /React still spent 80 ms re-rendering 300 components/);
  assert.doesNotMatch(note, /200 ms/);
});

test('the layout sentence names one window, and the numbers in it add up to that window', () => {
  // The scripts are counted to the end of the library's own walk; the working time has that walk
  // taken back out; the Working phase and the walk note both say so. Printing the layout against
  // one of those and subtracting against the other gave three numbers for one window.
  const r = report(
    [entry('click', 0, 200, 0, 120)],
    [commit(90, 0, { walkMs: 20, hasDurations: false, total: 0, rendered: 40 })],
    [frame(0, 130, [script('DIV#root.onclick', 0, 118, 110)])],
    [input(0, 'click')],
  );
  assert.equal(r.explanation.blame.kind, 'layout');
  // 110 and 10 make the 120 the sentence names, and what the 10 covers includes the walk, because
  // the window it is taken from does.
  assert.match(r.explanation.cause, /110 ms of the 120 ms spent handling the click/);
  assert.match(r.explanation.cause, /leaving 10 ms for/);
  assert.match(r.explanation.cause, /read of what React rendered/);
  assert.doesNotMatch(r.explanation.cause, /120 ms of working time/);

  // With no walk worth counting the window is the working time and the sentence says nothing extra.
  const clean = report([entry('click', 0, 200, 0, 120)], [commit(90, 0, { hasDurations: false, total: 0, rendered: 40 })], [frame(0, 130, [script('DIV#root.onclick', 0, 118, 110)])], [input(0, 'click')]);
  assert.match(clean.explanation.cause, /110 ms of the 120 ms spent handling the click/);
  assert.doesNotMatch(clean.explanation.cause, /read of what React rendered/);
});

test('two interactions of the same shape get the same verdict, whatever the component counts', () => {
  // Paging a calendar forward one month and toggling the page's theme: both an 88 ms click, both a
  // handful of milliseconds of working time and 82 ms of the screen updating. The only difference is
  // how many components the joined commit touched, and the render was tested before the screen
  // update, so one came back a render and inferred and the other painting and measured.
  const click = [entry('click', 0, 88, 1, 6)];
  const ring = loginClick('onClick');
  const paging = commit(4, 0, {
    hasDurations: false,
    total: 0,
    rendered: 332,
    roots: ['Calendar'],
    hotPath: ['Calendar', '$'],
    components: [{ name: 'et', count: 113, self: null, total: null }],
  });
  const toggling = commit(4, 0, { hasDurations: false, total: 0, rendered: 2, components: [] });

  const calendar = report(click, [paging], [], ring);
  const theme = report(click, [toggling], [], ring);
  const painting = { kind: 'painting', name: null, detail: null, ms: 82, confidence: 'measured' };
  assert.deepEqual(calendar.explanation.blame, painting);
  assert.deepEqual(theme.explanation.blame, painting);
  assert.equal(calendar.explanation.cause, theme.explanation.cause);

  // A render is still the answer where the working time is what the interaction spent.
  const working = report([entry('click', 0, 120, 3, 100)], [paging], [], ring);
  assert.equal(working.explanation.blame.kind, 'render');
});

test('the screen update takes the blame off a rung only by taking it, never by emptying the ladder', () => {
  // 100 ms of working time against a 95 ms screen update. The screen update is longer than the
  // render it would displace and shorter than the working time that render sat in, which used to be
  // the one gap where the ladder rejected the render and then rejected the screen update too.
  const measured = report([entry('click', 0, 200, 5, 105)], [commit(60, 0, { total: 90, rendered: 300 })], []);
  assert.deepEqual(measured.explanation.blame, { kind: 'render', name: 'List', detail: 'Row ×30', ms: 90, confidence: 'measured' });

  // The same shape with long animation frames recorded, where the fall was further: past the screen
  // update to the script the render itself ran inside, which blames the handler for React's work.
  const observed = report(
    [entry('click', 0, 400, 5, 205)],
    [commit(60, 0, { total: 190, rendered: 300 })],
    [frame(0, 400, [script('DIV#root.onclick', 5, 199)])],
  );
  assert.deepEqual(observed.explanation.blame, { kind: 'render', name: 'List', detail: 'Row ×30', ms: 190, confidence: 'measured' });

  // And the screen update still wins where it is longer than everything the working time holds.
  const painted = report([entry('click', 0, 200, 5, 45)], [commit(20, 0, { total: 30, rendered: 300 })], []);
  assert.equal(painted.explanation.blame.kind, 'painting');
  assert.equal(painted.explanation.blame.ms, 155);
});

test('a measured forced layout is not unseated by a screen update shorter than the time it ran in', () => {
  // A production build: 120 ms of working time, 70 of it recalculating layout, and a 78 ms screen
  // update. 78 beats the 70 without beating the 120 the 70 happened inside, and the layout used to
  // lose to that and land on the script it was charged to, which is the whole defect again.
  const r = report(
    [entry('click', 0, 200, 2, 122)],
    [commit(60, 0, { hasDurations: false, total: 0, rendered: 3, components: [{ name: 'Row', count: 3, self: null, total: null }] })],
    [frame(0, 130, [script('DIV#root.onclick', 2, 120, 70)])],
    [input(0, 'click')],
  );
  assert.deepEqual(r.explanation.blame, { kind: 'layout', name: 'List', detail: 'Row ×3', ms: 70, confidence: 'measured' });
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

test('an input that waited behind a script says which script, and gives it the blame only when it filled most of the wait', () => {
  // A key pressed at 7011 while a debounced filter, started by a timer at 6655, ran on until 7772. The
  // key's own handler ran from 7773 to 7778 and the screen updated at 7811.
  const debounce = { ...script('TimerHandler:setTimeout', 6655, 1117), source: 'deps/debouncer.js' };
  const busy = [frame(6651, 1123, [debounce, script('INPUT.onkeydown', 7773, 5)])];
  const r = report([entry('keydown', 7011, 800, 7773, 7778)], [], busy, []);
  assert.equal(
    r.explanation.cause,
    'The key press waited 762 ms before its handler could start: a script (TimerHandler:setTimeout, deps/debouncer.js) was already running when the key press came and held the main thread for 761 ms of that wait.',
  );
  assert.deepEqual(r.explanation.blame, { kind: 'waiting', name: 'TimerHandler:setTimeout', detail: null, ms: 762, confidence: 'measured' });

  // A click at 1000 whose handler started at 1380. A 30 ms timer ran inside that wait, from 1100; the
  // browser listed nothing else. The timer is in the sentence with its own figure, and is not the blame.
  const small = report([entry('click', 1000, 400, 1380, 1385)], [], [frame(1090, 60, [script('TimerHandler:setTimeout', 1100, 30)])], []);
  assert.match(small.explanation.cause, /a script \(TimerHandler:setTimeout, app\.js\) ran first and held the main thread for 30 ms of that wait\.$/);
  assert.deepEqual(small.explanation.blame, { kind: 'waiting', name: null, detail: null, ms: 380, confidence: 'measured' });

  // A script that ran through the whole wait is said to, rather than repeating the figure.
  const through = report([entry('click', 1000, 400, 1380, 1385)], [], [frame(900, 490, [script('TimerHandler:setTimeout', 905, 480)])], []);
  assert.match(through.explanation.cause, /was already running when the click came and held the main thread for all of that wait\.$/);

  // With no script on record the sentence says only what was measured.
  const bare = report([entry('click', 1000, 400, 1380, 1385)], [], [], []);
  assert.match(bare.explanation.cause, /the main thread was busy with something else\.$/);
  assert.equal(bare.explanation.blame.name, null);
});

test('a slow listener React did not attach is named by what the browser recorded for it', () => {
  // An undo shortcut bound on the document: the key's handlers ran from 7467 to 7672, React rendered
  // for 15 ms of that, and the browser charged 116 ms to the document's keydown listener.
  const shortcut = { ...script('#document.onkeydown', 7475, 116), source: 'editor/shortcuts.ts' };
  const undo = [frame(7467, 270, [shortcut, script('FrameRequestCallback', 7680, 40)])];
  const pressed = [input(7467, 'keydown', { target: element('div', []) as unknown as Node, owners: ['App'] })];
  const r = report([entry('keydown', 7467, 312, 7467, 7672)], [commit(7600, 7467, { total: 15, rendered: 161 })], undo, pressed);
  assert.match(r.explanation.cause, /^Code outside React \(the key press handler or other scripts\) ran for about 190 ms; /);
  assert.match(r.explanation.cause, / The longest script the browser recorded in that time was #document\.onkeydown \(editor\/shortcuts\.ts\), 116 ms\.$/);
  assert.deepEqual(r.explanation.blame, { kind: 'handler', name: '#document.onkeydown', detail: null, ms: 190, confidence: 'measured' });

  // A handler React does name keeps its name, and the sentence says nothing about the listener it
  // was dispatched from: that one is React's own, on the root.
  const named = report([entry('click', 1000, 230, 1002, 1200)], [commit(1150, 1000, { total: 4, rendered: 2 })], [frame(1000, 230, [script('DIV#root.onclick', 1002, 198)])], loginClick('handleLogin', 1000));
  assert.equal(named.explanation.blame.name, 'handleLogin');
  assert.doesNotMatch(named.explanation.cause, /longest script/);

  // A listener that held under half of the time being blamed is in the sentence and is not the name.
  const minor = [frame(7467, 270, [{ ...shortcut, duration: 60 }])];
  const partly = report([entry('keydown', 7467, 312, 7467, 7672)], [commit(7600, 7467, { total: 15, rendered: 161 })], minor, pressed);
  assert.match(partly.explanation.cause, /#document\.onkeydown \(editor\/shortcuts\.ts\), 60 ms\.$/);
  assert.equal(partly.explanation.blame.name, null);
  assert.equal(partly.explanation.blame.detail, 'App');
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
    ['layout measured', report([entry('click', 0, 128, 2, 118)], [], [frame(0, 128, [script('DIV#root.onclick', 2, 116, 108)])], ring)],
    ['layout apportioned', report([entry('click', 0, 128, 2, 118)], [], [frame(0, 200, [script('DIV#root.onclick', 2, 180, 170)])], ring)],
    ['waiting', report([entry('click', 0, 400, 380, 385)], [], [], ring)],
    ['waiting behind a script', report([entry('click', 1000, 400, 1380, 1385)], [], [frame(900, 490, [script('TimerHandler:setTimeout', 905, 470)])], loginClick('handleLogin', 1000))],
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
  assert.deepEqual([...seen].sort(), ['handler', 'hydration', 'layout', 'none', 'painting', 'render', 'script', 'waiting']);
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
