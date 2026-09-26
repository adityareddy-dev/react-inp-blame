import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heaviest, mostlyComponent } from '../src/commits.ts';
import type { InputRecord } from '../src/hook.ts';
import { attachLaterRender, blamedCommit, buildReport, isLaterRender, refreshReport, renderedVerb, sealReport, type LabelSource } from '../src/join.ts';
import type { PageNavigation } from '../src/navigation.ts';
import type { CommitSummary, FrameSummary, InteractionReport, ScriptSummary } from '../src/types.ts';

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
    startedAt: null,
    effectsStartedAt: null,
    effectsEndedAt: null,
    walkMs: 0,
    priority: 1,
    didError: false,
    ...opts,
  };
}

function input(ts: number, type: string, extra: Partial<InputRecord> = {}): InputRecord {
  return { ts, type, gestureTs: ts, press: undefined, target: null, owners: [], handler: null, dehydrated: null, work: { endedAt: ts, unjoined: [] }, ...extra };
}

/** An input whose own dispatch rendered, ending at `until`: what the hook sets `ownEndedAt` to. */
const worked = (until: number): Partial<InputRecord> => ({ work: { endedAt: until, ownEndedAt: until, unjoined: [] } });

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

test('the label is the one read at dispatch, before a handler changed the text, and read now when the ring has another node', () => {
  // A counter's click renders "Count is 1" before the entry arrives; the ring labelled it "Count is 0".
  const button = element('button', [text('Count is 1')]);
  const ring = [input(0, 'click', { target: button as unknown as Node, label: 'button "Count is 0"' })];
  const r = report([entry('click', 0, 120, 3, 100, { target: button })], [], [], ring, 'text');
  assert.equal(r.target?.label, 'button "Count is 0"');
  assert.equal(r.verdict.startsWith('120 ms click on button "Count is 0"'), true);
  // Not the entry's node: the ring's label is some other element's.
  const other = [input(0, 'click', { target: element('div', []) as unknown as Node, label: 'div "Elsewhere"' })];
  assert.equal(report([entry('click', 0, 120, 3, 100, { target: button })], [], [], other, 'text').target?.label, 'button "Count is 1"');
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

test("a Radix Slot is passed over for the component that rendered it, since it renders nothing of its own", () => {
  // The chain under a Radix DropdownMenu item, as a production build with the shadcn wrappers around it
  // reads it. Each `X.Slot` is the Slot that X rendered to merge its props into its child, and the collection
  // item slot before it renders only that Slot; the roving focus item is the first component that does more.
  const item = ['Primitive.div', 'Primitive.span.Slot', 'Primitive.span', 'RovingFocusGroupCollectionItemSlot.Slot', 'RovingFocusGroupCollectionItemSlot', 'RovingFocusGroupItem'];
  assert.equal(clickedInside(item).component, 'RovingFocusGroupItem');
  assert.equal(clickedInside(['MenuCollectionItemSlot.Slot', 'MenuCollectionItemSlot', 'MenuItemImpl', 'MenuItem']).component, 'MenuItemImpl');
  assert.equal(clickedInside(['RovingFocusGroupCollectionSlot.SlotClone', 'RovingFocusGroupCollectionSlot', 'RovingFocusGroup']).component, 'RovingFocusGroup');
  // shadcn's Button renders a plain Slot for `asChild`, and older Radix a SlotClone under every Slot.
  assert.equal(clickedInside(['Slot', 'Button', 'Toolbar']).component, 'Button');
  assert.equal(clickedInside(['Primitive.button.SlotClone', 'Primitive.button', 'Slot.SlotClone', 'Button']).component, 'Button');
  // Passed over, never dropped: with nothing better above it, the Slot is named as it is.
  assert.equal(clickedInside(['Menu.Slot', 'x']).component, 'Menu.Slot');
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

test("the browser's forced layout is said as styles and layout, since its one figure holds both", () => {
  const data = buildReport([entry('click', 0, 120, 3, 100)], [commit(50, 0)], []);
  const later = sealReport(attachLaterRender(data, commit(400, 0, { total: 40 }), [frame(350, 60, [script('#root.onclick', 355, 45, 12)])])!);
  assert.match(later.verdict, /A second React render landed 280 ms after the screen updated: 40 ms re-rendering 30 components inside List, mostly Row \(30 of them, 20 ms\), and it made the browser recalculate styles and layout for 12 ms on the way\. /);
  // The blame keeps its kind.
  const thrash = report([entry('click', 0, 128, 2, 118)], [], [frame(0, 128, [script('DIV#root.onmousedown', 2, 116, 108)])]).explanation;
  assert.equal(thrash.blame.kind, 'layout');
  assert.match(thrash.cause, /^The browser spent 108 ms of the 116 ms spent handling the click recalculating styles and layout, leaving 8 ms for React's render and commit/);
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

test("a keyup whose frame waited on the next key press does not take that key's render, even under a millisecond from it", () => {
  // Typing at full speed: the next key goes down 0.6 ms after the last one came up, before the frame
  // that keyup paints in, so the keyup's entry runs to the paint after the next key's render. That
  // render is stamped with the next keydown, and matched by time alone it was the keyup's too.
  for (const next of [1100.6, 1101]) {
    const a = [entry('keydown', 1000, 16, 1001, 1003), entry('keypress', 1000, 16, 1003, 1005), entry('keyup', 1100, 104, 1101, 1103)];
    const b = [entry('keydown', next, 104, 1103.5, 1190, { interactionId: 8 }), entry('keypress', next, 104, 1104, 1190, { interactionId: 8 })];
    // The next key's render ends inside its own dispatch at 1190, before the keyup's paint at 1204.
    const ring = [input(1000, 'keydown'), input(1100, 'keyup', { gestureTs: 1000 }), input(next, 'keydown', worked(1190)), input(1260, 'keyup', { gestureTs: next })];
    const render = commit(1185, next, { inputType: 'keydown', rendered: 1000, total: 70 });
    // Its keyup's render lands after the paint, stamped with the next key's press.
    const release = commit(1300, 1260, { inputType: 'keyup', gestureTs: next, total: 20 });

    const keyup = report(a, [render, release], [], ring);
    assert.deepEqual(keyup.commits, [], `next key at ${next}`);
    assert.deepEqual(keyup.followUps, [], `next key at ${next}`);
    assert.equal(isLaterRender(keyup, release, ring), false);
    assert.deepEqual(keyup.nextInput, { type: 'keydown', pointerType: null, start: next, endedAt: 1190 });
    assert.deepEqual(keyup.explanation.blame, { kind: 'painting', name: null, detail: null, ms: 101, confidence: 'measured' });
    // The render's end says when the next key's work finished, not when it began, so on it alone the clause is hedged.
    assert.match(keyup.verdict, /^104 ms key press\. After the key press was handled, /);
    assert.equal(keyup.explanation.cause, 'After the key press was handled, the screen took another 101 ms to update: the frame most likely waited on the next key press, which the page handled first.');
    // A script the browser recorded from the next key on times that work, and the clause is not hedged. It is
    // the longest script in that time, and names the blame as it does any painting blame.
    const oninput = [frame(1100, 104, [script('DIV#root.oninput', 1104, 80)])];
    const framed = report(a, [render, release], oninput, ring);
    assert.equal(framed.explanation.blame.name, 'DIV#root.oninput');
    assert.equal(
      framed.explanation.cause,
      'After the key press was handled, the screen took another 101 ms to update: the frame waited on the next key press, which the page handled first. The longest script the browser recorded in that time was DIV#root.oninput (app.js), 80 ms.',
    );
    // The script alone is enough where React rendered nothing in that key's dispatch.
    const unrendered = report(a, [render, release], oninput, [ring[0]!, ring[1]!, input(next, 'keydown'), ring[3]!]);
    assert.equal(unrendered.nextInput?.endedAt, null);
    assert.match(unrendered.explanation.cause, /: the frame waited on the next key press, which the page handled first\. /);

    const key = report(b, [render, release], [], ring);
    assert.deepEqual(key.commits, [joinedAs(render, 'exact')], `next key at ${next}`);
    assert.equal(key.nextInput, null);
    assert.equal(key.explanation.blame.kind, 'render');
  }
});

test('a keyup is said to have waited on the next key press only where the page worked on that press for half its screen update before the paint', () => {
  // The keyup above: handled by 1103 and painted at 1204, 101 ms of screen update, with the next key down at 1100.6.
  const a = [entry('keydown', 1000, 16, 1001, 1003), entry('keypress', 1000, 16, 1003, 1005), entry('keyup', 1100, 104, 1101, 1103)];
  const cause = (next: Partial<InputRecord>, frames: FrameSummary[] = [], at = 1100.6) =>
    report(a, [], frames, [input(1000, 'keydown'), input(1100, 'keyup', { gestureTs: 1000 }), input(at, 'keydown', next)]).explanation.cause;
  const plain = 'After the key press was handled, the screen took another 101 ms to update.';
  const waited = /: the frame most likely waited on the next key press, which the page handled first\.$/;
  // Pressed before the paint, with nothing to show the page did anything for it.
  assert.equal(cause({}), plain);
  // React's render in its dispatch ended 37 ms after the keyup's handlers, short of half the 101 ms; at 51 ms it is half.
  assert.equal(cause(worked(1140)), plain);
  assert.match(cause(worked(1154)), waited);
  // A render that ended past the paint, beyond the 8 ms the paint time is rounded to, ran after the frame.
  assert.equal(cause(worked(1260)), plain);
  assert.match(cause(worked(1210)), waited);
  // And it counts up to the paint only: a key down at 1160 whose render ended at 1211 had 44 ms of it before 1204.
  assert.equal(cause(worked(1211), [], 1160), plain);
  // A script counts from the press on. One that began before it is something else the frame waited for.
  const before = cause({}, [frame(1090, 120, [script('TimerHandler:setTimeout', 1095, 100)])]);
  assert.match(before, /^After the key press was handled, the screen took another 101 ms to update, mostly because /);
  assert.doesNotMatch(before, /waited on/);
  // One from the press on has to cover half the screen update too.
  assert.doesNotMatch(cause({}, [frame(1100, 104, [script('DIV#root.oninput', 1104, 40)])]), /waited on/);
  assert.match(cause({}, [frame(1100, 104, [script('DIV#root.oninput', 1104, 60)])]), /: the frame waited on the next key press, which the page handled first\. /);
});

test('the frame is said to wait on the next key press only where the screen update is the larger part of the interaction, under a long task as well', () => {
  const ring = (at: number, until: number) => [input(1000, 'keydown'), input(1100, 'keyup', { gestureTs: 1000 }), input(at, 'keydown', worked(until))];
  // 60 ms of handlers and 43 ms of screen update, which the next key's render filled from the end of the handlers.
  const handled = report([entry('keyup', 1100, 104, 1101, 1161)], [], [], ring(1150, 1200));
  assert.equal(handled.nextInput?.start, 1150);
  assert.equal(handled.explanation.blame.kind, 'none');
  assert.doesNotMatch(handled.explanation.cause, /waited on/);
  // A 45 ms wait before the handlers and 38 ms of screen update.
  const waitedLonger = report([entry('keyup', 1100, 88, 1145, 1150)], [], [], ring(1150.5, 1185));
  assert.equal(waitedLonger.explanation.blame.kind, 'none');
  assert.doesNotMatch(waitedLonger.explanation.cause, /waited on/);
  // 2 ms of handlers and 37 ms of screen update: under a long task, and still the answer.
  const short = report([entry('keyup', 1100, 40, 1101, 1103)], [], [], ring(1101, 1135));
  assert.deepEqual(short.explanation.blame, { kind: 'painting', name: null, detail: null, ms: 37, confidence: 'measured' });
  assert.equal(short.explanation.cause, 'After the key press was handled, the screen took another 37 ms to update: the frame most likely waited on the next key press, which the page handled first.');
});

test("a click is not said to have waited on the second click of a double click that did nothing before the paint", () => {
  const entries = [entry('pointerup', 1000, 150, 1001, 1008), entry('click', 1000, 150, 1008, 1010)];
  const mouse = { pointerType: 'mouse', press: 1 };
  const ring = [input(930, 'pointerdown', mouse), input(1000, 'pointerup', { ...mouse, gestureTs: 930 }), input(1000.3, 'click', { ...mouse, gestureTs: 930 })];
  const c = commit(1009, 1000.3, { gestureTs: 930, rendered: 400, total: 6 });
  const r = report(entries, [c], [], [...ring, input(1080, 'pointerdown', mouse)]);
  // The click 0.3 ms after the pointerup is this interaction's own, not the next.
  assert.deepEqual(r.nextInput, { type: 'pointerdown', pointerType: 'mouse', start: 1080, endedAt: null });
  assert.equal(r.explanation.cause, 'After the click was handled, the screen took another 140 ms to update.');
  // Where the second press rendered before the paint for half the 140 ms, the frame most likely waited on it.
  const rendered = report(entries, [c], [], [...ring, input(1080, 'pointerdown', { ...mouse, ...worked(1150) })]);
  assert.match(rendered.explanation.cause, /: the frame most likely waited on the next click, which the page handled first\.$/);
});

test('a release is never the next press: a modifier let go, or a keystroke\'s own keyup under an input method, before the paint', () => {
  // Cmd+K opening a palette: K handled in 10 ms, the palette's styles and layout hold the frame to 1136, and Meta comes up at 1070.
  const cmdK = report(
    [entry('keydown', 1000, 136, 1002, 1012), entry('keypress', 1000, 136, 1012, 1012)],
    [commit(1010, 1000, { inputType: 'keydown', rendered: 12, total: 4 })],
    [],
    [input(900, 'keydown', { press: 'MetaLeft' }), input(1000, 'keydown', { press: 'KeyK' }), input(1060, 'keyup', { press: 'KeyK', gestureTs: 1000 }), input(1070, 'keyup', { press: 'MetaLeft', gestureTs: 900 })],
  );
  assert.equal(cmdK.nextInput, null);
  assert.equal(cmdK.explanation.cause, 'After the key press was handled, the screen took another 124 ms to update.');
  // Shift+click selecting a range, with Shift let go at 1040.
  const mouse = { pointerType: 'mouse', press: 1 };
  const shiftClick = report(
    [entry('pointerdown', 990, 16, 991, 992), entry('pointerup', 1000, 120, 1001, 1010), entry('click', 1000, 120, 1010, 1015)],
    [commit(1014, 1000, { gestureTs: 990, rendered: 40, total: 3 })],
    [],
    [input(800, 'keydown', { press: 'ShiftLeft' }), input(990, 'pointerdown', mouse), input(1000, 'pointerup', { ...mouse, gestureTs: 990 }), input(1000, 'click', { ...mouse, gestureTs: 990 }), input(1040, 'keyup', { press: 'ShiftLeft', gestureTs: 800 })],
  );
  assert.equal(shiftClick.nextInput, null);
  assert.equal(shiftClick.explanation.cause, 'After the click was handled, the screen took another 105 ms to update.');
  // An input method composing: the `input` entry heads the interaction and owns nothing in the ring by type.
  const composed = report([entry('input', 1000, 120, 1001, 1030)], [], [], [input(995, 'keydown', { press: 'KeyA' }), input(1050, 'keyup', { press: 'KeyA', gestureTs: 995 })]);
  assert.equal(composed.nextInput, null);
  assert.equal(composed.explanation.cause, 'After the typing was handled, the screen took another 90 ms to update.');
});

test('a pointerup whose click was too quick for an entry still owns that click, and the render it set off after the paint', () => {
  const mouse = { pointerType: 'mouse', press: 1 };
  const ring = [input(930, 'pointerdown', mouse), input(1000, 'pointerup', { ...mouse, gestureTs: 930 }), input(1002, 'click', { ...mouse, gestureTs: 930 })];
  const later = commit(1200, 1002, { gestureTs: 930, rendered: 200, total: 40 });
  const r = report([entry('pointerup', 1000, 120, 1001, 1100)], [later], [], ring);
  assert.deepEqual(r.followUps, [joinedAs(later, 'exact')]);
  assert.equal(isLaterRender(r, later, ring), true);
  // The click 2 ms after the pointerup is this interaction's, not the next.
  assert.equal(r.nextInput, null);
});

test("a keypress entry stands for its keydown: the next key's report does not take the last key's keyup render 0.6 ms before it", () => {
  // The mirror of the keyup above. The last key comes up at 1000 and the next goes down at 1000.6, and the keyup's
  // handler renders at 1002, before the keydown's handlers run.
  const entries = [entry('keydown', 1000.6, 104, 1003.5, 1090), entry('keypress', 1000.6, 104, 1090, 1091)];
  const ring = [input(900, 'keydown'), input(1000, 'keyup', { gestureTs: 900 }), input(1000.6, 'keydown')];
  const keyupRender = commit(1002, 1000, { inputType: 'keyup', gestureTs: 900, total: 20 });
  const own = commit(1080, 1000.6, { inputType: 'keydown', total: 60 });
  assert.deepEqual(report(entries, [keyupRender, own], [], ring).commits, [joinedAs(own, 'exact')]);
});

test('a mousedown or mouseup entry stands for its pointer event, not for any input at its time', () => {
  const mouse = { pointerType: 'mouse', press: 1 };
  // A press held on a mousedown entry: a key released 0.5 ms before it renders just after.
  const down = [entry('mousedown', 1000, 104, 1003, 1010)];
  const keyupRender = commit(1001.5, 999.5, { inputType: 'keyup', gestureTs: 900, total: 20 });
  const pressRender = commit(1008, 1000, { inputType: 'pointerdown', total: 30 });
  const downRing = [input(900, 'keydown'), input(999.5, 'keyup', { gestureTs: 900 }), input(1000, 'pointerdown', mouse)];
  assert.deepEqual(report(down, [keyupRender, pressRender], [], downRing).commits, [joinedAs(pressRender, 'exact')]);
  // A release on a mouseup entry: a key pressed during the click and released 0.4 ms before it renders just after.
  const up = [entry('mouseup', 1080, 104, 1082, 1090)];
  const keyupRender2 = commit(1081, 1079.6, { inputType: 'keyup', gestureTs: 1050, total: 20 });
  const releaseRender = commit(1088, 1080, { inputType: 'pointerup', gestureTs: 1000, total: 30 });
  const upRing = [input(1000, 'pointerdown', mouse), input(1050, 'keydown'), input(1079.6, 'keyup', { gestureTs: 1050 }), input(1080, 'pointerup', { ...mouse, gestureTs: 1000 })];
  assert.deepEqual(report(up, [keyupRender2, releaseRender], [], upRing).commits, [joinedAs(releaseRender, 'exact')]);
});

test('a render stamped with a click the ring has let go is not claimed by a keydown within a millisecond of that click', () => {
  // The pointerup is the only entry, and by the time the report is built the ring holds none of the click's inputs,
  // only a key that went down 0.5 ms after the click. The render stamped with the click ran in its handlers, and joins
  // by overlap: the keydown is not the input its stamp names.
  const render = commit(1050, 1000.5, { gestureTs: 930, rendered: 200, total: 40 });
  const r = report([entry('pointerup', 1000, 120, 1001, 1100)], [render], [], [input(1001, 'keydown')]);
  assert.deepEqual(r.commits, [joinedAs(render, 'overlap')]);
});

test("the press a release carries matches only a press, where that press had no entry of its own", () => {
  // The key went down at 1000 too quickly for an entry, and its keyup heads the report. Another key came up 0.4 ms
  // after it went down, and a render stamped with that keyup lands at 1099.5, before this keyup's handlers ran.
  const ring = [input(950, 'keydown'), input(1000, 'keydown'), input(1000.4, 'keyup', { gestureTs: 950 }), input(1100, 'keyup', { gestureTs: 1000 })];
  const other = commit(1099.5, 1000.4, { inputType: 'keyup', gestureTs: 950, total: 20 });
  assert.deepEqual(report([entry('keyup', 1100, 104, 1101, 1103)], [other], [], ring).commits, []);
});

test('a render after an input or change a script dispatched past the paint is not a later render of the input before it', () => {
  // The same sort, then the page size picked with Playwright's selectOption: an `input` and a `change` from
  // script and no pointer or key going down, so the ring's newest input was still the sort click, and the
  // page-size render joined it as its later render.
  const sortClick = [entry('click', 0, 120, 3, 100)];
  const pageSizeRender = commit(1100, 0, { total: 400, rendered: 417 });
  const picked = [input(0, 'click', { work: { endedAt: 100, ownEndedAt: 100, unjoined: [], closers: [1000, 1000] } })];
  assert.deepEqual(buildReport(sortClick, [pageSizeRender], [], picked).followUps, []);
  assert.equal(isLaterRender(buildReport(sortClick, [], [], picked), pageSizeRender, picked), false);
  // A render before it is still the click's.
  const own = commit(900, 0, { total: 40 });
  assert.deepEqual(buildReport(sortClick, [own], [], picked).followUps, [joinedAs(own, 'exact')]);
  // One dispatched before the click painted closes nothing.
  const early = [input(0, 'click', { work: { endedAt: 100, ownEndedAt: 100, unjoined: [], closers: [110] } })];
  assert.deepEqual(buildReport(sortClick, [pageSizeRender], [], early).followUps, [joinedAs(pageSizeRender, 'exact')]);
});

test("the render a held press's release made inside its own entry is not said to be left out of INP", () => {
  // A 32 ms pointerdown on excalidraw's canvas painted, and the pointerup that ended the stroke rendered
  // in its own dispatch 38 ms later. INP timed that render: it is inside the pointerup's entry.
  const pressed = [entry('pointerdown', 0, 32, 2, 24), entry('pointerup', 60, 24, 61, 72)];
  const ring = [input(0, 'pointerdown'), input(60, 'pointerup', { gestureTs: 0, work: { endedAt: 72, ownEndedAt: 72, unjoined: [] } })];
  const release = commit(70, 60, { gestureTs: 0, inputType: 'pointerup', total: 12 });
  const note = (r: InteractionReport) => r.explanation.notes.find((n) => n.startsWith('A second React render')) ?? '';
  const observed = report(pressed, [release], [], ring);
  assert.deepEqual(observed.followUps.map((c) => c.at), [70]);
  assert.match(note(observed), /^A second React render landed 38 ms after the screen updated, on the release: 12 ms /);
  assert.doesNotMatch(note(observed), /INP/);
  // A pointerup under 16 ms has no entry, and then the hook says the render ran in its dispatch.
  const unobserved = report(pressed.slice(0, 1), [{ ...release, inDispatch: true }], [], ring);
  assert.deepEqual(unobserved.followUps.map((c) => c.at), [70]);
  assert.match(note(unobserved), /, on the release: /);
  assert.doesNotMatch(note(unobserved), /INP/);
  // A render after the release painted is one INP left out, and the note is about that one, however much
  // heavier the release's own was.
  const heavyRelease = commit(70, 60, { gestureTs: 0, inputType: 'pointerup', total: 60 });
  const effect = commit(400, 60, { gestureTs: 0, inputType: 'pointerup', total: 40 });
  assert.match(note(report(pressed, [heavyRelease, effect], [], ring)), /^A second React render landed 368 ms after the screen updated: 40 ms .* INP doesn't count it, but people still wait for it\.$/);
});

test("a render that began after the release came and committed before its handlers ran is inside the release's entry", () => {
  // The pointerup came at 40 and waited until 60 for its handlers, and React committed a render in that
  // wait, still stamped with the press since the pointerup had not been dispatched. INP counts the wait.
  const pressed = [entry('pointerdown', 0, 32, 2, 24), entry('pointerup', 40, 28, 60, 62)];
  const ring = [input(0, 'pointerdown'), input(40, 'pointerup', { gestureTs: 0, work: { endedAt: 62, ownEndedAt: 62, unjoined: [] } })];
  const note = (r: InteractionReport) => r.explanation.notes.find((n) => n.startsWith('A second React render')) ?? '';
  const inWait = note(report(pressed, [commit(58, 0, { inputType: 'pointerdown', startedAt: 45, total: 12 })], [], ring));
  assert.match(inWait, /^A second React render landed 26 ms after the screen updated, on the release: 12 ms /);
  assert.doesNotMatch(inWait, /INP/);
  // One that began before the pointerup came is not inside its entry.
  const before = note(report(pressed, [commit(58, 0, { inputType: 'pointerdown', startedAt: 20, total: 12 })], [], ring));
  assert.match(before, /^A second React render landed 26 ms after the screen updated: 12 ms .* INP doesn't count it/);
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

test("the follow-up window is the page's inputWindow, above 1.5 s as well as below it", () => {
  const clicked = [entry('click', 0, 120, 3, 100)];
  const ring = [input(0, 'click')];
  const r = buildReport(clicked, [], [], ring);
  // Data that came back 2 s after the paint: past the default window, inside one of 3 s. The hook walks
  // it under a 3 s window, and the report has to take it too, or the walk bought nothing.
  const late = commit(2120, 0, { total: 40 });
  assert.deepEqual(buildReport(clicked, [late], [], ring).followUps, []);
  assert.deepEqual(buildReport(clicked, [late], [], ring, 'attributes', [], 3000).followUps, [joinedAs(late, 'exact')]);
  assert.equal(isLaterRender(r, late, ring), false);
  assert.equal(isLaterRender(r, late, ring, 3000), true);
  // 600 ms after the paint: inside the default window, past one of 500 ms.
  const soon = commit(720, 0, { total: 40 });
  assert.deepEqual(buildReport(clicked, [soon], [], ring).followUps, [joinedAs(soon, 'exact')]);
  assert.deepEqual(buildReport(clicked, [soon], [], ring, 'attributes', [], 500).followUps, []);
  assert.equal(isLaterRender(r, soon, ring, 500), false);
});

test("a press held past the window keeps the render its release made, and a later render is measured from the end of the release's work", () => {
  // Only the pointerdown was slow enough to be observed. The pointer is held for 2 s and the click that
  // releases it renders inside its own dispatch, 1970 ms after the pointerdown painted. Measured from
  // that paint it was past the window and joined nothing, though the hook had walked it as the click's.
  const pressed = [entry('pointerdown', 0, 40, 2, 30)];
  const gesture = [input(0, 'pointerdown'), input(2000, 'pointerup', { gestureTs: 0 }), input(2001, 'click', { gestureTs: 0, work: { endedAt: 2012, unjoined: [] } })];
  const release = commit(2010, 2001, { gestureTs: 0, total: 40 });
  assert.deepEqual(buildReport(pressed, [release], [], gesture).followUps, [joinedAs(release, 'exact')]);
  // It is the release's own work, so a window shorter than the hold keeps it too.
  assert.deepEqual(buildReport(pressed, [release], [], gesture, 'attributes', [], 500).followUps, [joinedAs(release, 'exact')]);
  // The same when the release was observed too and the pointerdown is still the slowest entry.
  const observed = [...pressed, entry('pointerup', 2000, 16, 2001, 2002), entry('click', 2001, 16, 2002, 2012)];
  assert.deepEqual(buildReport(observed, [release], [], gesture).followUps, [joinedAs(release, 'exact')]);
  // A render 800 ms after the release is inside the default window and past one of 500 ms.
  const after = commit(2801, 2001, { gestureTs: 0, total: 40 });
  assert.deepEqual(buildReport(pressed, [after], [], gesture).followUps, [joinedAs(after, 'exact')]);
  assert.deepEqual(buildReport(pressed, [after], [], gesture, 'attributes', [], 500).followUps, []);
});

test("a later render of a click whose pointerdown painted first is measured from the end of the click's own work", () => {
  // The pointerdown was the slow part and painted at 152. The click after it renders inside its own
  // dispatch until 300, and an effect of it lands at 750. Under a 500 ms window the hook walked that
  // effect, 450 ms after the click's work, and a window run from the pointerdown's paint dropped it.
  const entries = [entry('pointerdown', 0, 152, 2, 148), entry('pointerup', 199, 16, 200, 201), entry('click', 200, 120, 201, 300)];
  const ring = [input(0, 'pointerdown'), input(199, 'pointerup', { gestureTs: 0 }), input(200, 'click', { gestureTs: 0, work: { endedAt: 300, unjoined: [] } })];
  const inDispatch = commit(290, 200, { gestureTs: 0, total: 40 });
  const effect = commit(750, 200, { gestureTs: 0, total: 40 });
  const report = (commits: CommitSummary[]) => buildReport(entries, commits, [], ring, 'attributes', [], 500).followUps.map((c) => c.at);
  assert.deepEqual(report([inDispatch, effect]), [290, 750]);
  // One the hook would have dropped too, 501 ms after the click's work, stays out.
  assert.deepEqual(report([inDispatch, commit(801, 200, { gestureTs: 0, total: 40 })]), [290]);
});

test('a click made from the keyboard is not a later render of the mouse click before it', () => {
  // A mouse click, then Enter on the button it left focused, 2.8 s after its paint, in a ring where the
  // click Enter made carries the mouse click's pointerdown as its press. The hook recorded it that way
  // until it tied a keyboard click to its key (install.test.ts has that), and a release whose press it
  // can only guess at still takes the newest one. The keydown between them says something else was
  // pressed, so the window still runs from the mouse click's paint and the render is past it.
  const mouse = [entry('pointerdown', 0, 24, 2, 4), entry('click', 81, 120, 83, 180)];
  const ring = [
    input(0, 'pointerdown', { press: 1 }),
    input(80, 'pointerup', { gestureTs: 0, press: 1 }),
    input(81, 'click', { gestureTs: 0, press: 1 }),
    input(3000, 'keydown', { press: 'Enter' }),
    input(3001, 'click', { gestureTs: 0, press: -1, work: { endedAt: 3012, unjoined: [] } }),
  ];
  const r = buildReport(mouse, [], [], ring);
  const enter = commit(3010, 3001, { gestureTs: 0, total: 40 });
  assert.equal(isLaterRender(r, enter, ring), false);
  assert.deepEqual(buildReport(mouse, [enter], [], ring).followUps, []);
  assert.deepEqual(buildReport(mouse, [enter], [], ring, 'attributes', [], 500).followUps, []);
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
  // only thing here a reader can open a file on, so it is what the blame carries. Radix's SlotClone at
  // the end of the hot path renders nothing of its own, so the subtree is named by the component before it.
  assert.deepEqual(r.explanation.blame, {
    kind: 'layout',
    name: 'Tabs',
    detail: '181 components',
    ms: 108,
    confidence: 'measured',
  });
  assert.equal(
    r.explanation.cause,
    'The browser spent 108 ms of the 116 ms spent handling the click recalculating styles and layout, leaving 8 ms for' +
      " React's render and commit, its layout effects and the click handler together." +
      // Where the layout happened and where React was working are two records, and only the first is
      // the browser's. The sentence carries both, so the subtree is never the only thing named.
      ' It was charged to DIV#root.onmousedown.' +
      ' React was re-rendering 181 components inside Tabs.' +
      " That happens when code reads an element's size right after changing styles, often in a layout effect.",
  );
  // The note would say the same thing a second time.
  assert.equal(r.explanation.notes.some((note) => note.includes('recalculating styles and layout')), false);

  // Half the working time is what makes it the answer rather than a note: under that the render keeps the blame.
  const little = report(tabs, [rerender], [frame(0, 128, [script('DIV#root.onmousedown', 2, 116, 40)])], [input(0, 'click')]);
  assert.equal(little.explanation.blame.kind, 'render');
  assert.ok(little.explanation.notes.some((note) => note.includes('recalculating styles and layout')));

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

  // Under 25 ms it did not make anything slow, whatever share of a short window it holds. Nor did 30 ms of
  // working time known by its count, and the script the frame lists ran as the handler, so it holds React's
  // render: it is not measured in the render's place, and nothing under the bar is blamed.
  const quick = report([entry('click', 0, 40, 2, 32)], [counted], [frame(0, 40, [script('#document.onclick', 2, 30, 24)])], [input(0, 'click')]);
  assert.equal(quick.explanation.blame.kind, 'none');
  assert.match(quick.explanation.cause, /^In 30 ms of working time, short of a long task, React was re-rendering 59 components inside DismissableLayer.*; the rest went to waiting and painting\.$/);

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
  assert.ok(under.explanation.notes.some((note) => note.includes('recalculating styles and layout')));

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
    rendered.explanation.notes.some((note) => note.includes('200 ms') && note.includes('inside List')),
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
  assert.equal(tight.explanation.blame.detail, '181 components');
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
  assert.deepEqual(measured.explanation.blame, { kind: 'render', name: 'List', detail: '300 components', ms: 90, confidence: 'measured' });

  // The same shape with long animation frames recorded, where the fall was further: past the screen
  // update to the script the render itself ran inside, which blames the handler for React's work.
  const observed = report(
    [entry('click', 0, 400, 5, 205)],
    [commit(60, 0, { total: 190, rendered: 300 })],
    [frame(0, 400, [script('DIV#root.onclick', 5, 199)])],
  );
  assert.deepEqual(observed.explanation.blame, { kind: 'render', name: 'List', detail: '300 components', ms: 190, confidence: 'measured' });

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

test('in a production build a render beside a handler is blamed only where its count explains the working time', () => {
  // Nothing times a render there, so the count is all that weighs it against the handler beside it. A click
  // whose handlers ran for `processing` ms from 3 ms, painted 5 ms after them, with one commit at their end.
  const blameOf = (processing: number, shape: Partial<CommitSummary>, handler = 'onClick') => {
    const r = report([entry('click', 0, processing + 8, 3, 3 + processing)], [commit(processing, 0, shape)], [], loginClick(handler));
    const { kind, name, confidence } = r.explanation.blame;
    return `${kind} ${name} ${confidence}`;
  };
  const counted = (rendered: number, [name, count]: [string, number], hotPath: string[]): Partial<CommitSummary> => ({
    hasDurations: false,
    total: 0,
    rendered,
    roots: [hotPath[0]!],
    hotPath,
    components: [{ name, count, self: null, total: null }],
  });
  // A Radix DropdownMenu item whose onSelect ran for 200 ms: closing the menu re-renders 85 different
  // components, four DropdownMenuItem among them, inside 209 ms of working time. Over 2 ms a component for
  // a tree leaves the time to the handler.
  const menu = counted(85, ['DropdownMenuItem', 4], ['ExportMenu', 'MenuPortalProvider']);
  assert.equal(blameOf(209, menu), 'handler onClick inferred');
  // 150 rows of a list in 160 ms is a millisecond each, which is what a row costs: the render's.
  assert.equal(blameOf(157, counted(152, ['SlowRow', 150], ['ListPanel', 'SlowList'])), 'render SlowList inferred');
  // A list is the render's however long it took: 250 sections rebuilt in 2.5 s.
  assert.equal(blameOf(2500, counted(251, ['Section', 250], ['SlowRender'])), 'render SlowRender inferred');
  // A tree of 90 different components in 120 ms is under 2 ms each, so the render is blamed; the same
  // tree in 300 ms is not.
  const page = counted(90, ['NavItem', 3], ['App', 'SettingsPage']);
  assert.equal(blameOf(120, page), 'render SettingsPage inferred');
  assert.equal(blameOf(300, page), 'handler onClick inferred');
  // Under 50 components the handler was the blame already, whatever the time.
  assert.equal(blameOf(209, counted(25, ['MenuItem', 2], ['ExportMenu', 'MenuPopup'])), 'handler onClick inferred');
  // Where React timed the render, the times decide, on a coarse clock too: 19 ms of render beside 190 of handler.
  const timed: Partial<CommitSummary> = { rendered: 85, total: 19, roots: ['ExportMenu'], hotPath: ['ExportMenu', 'MenuPortalProvider'], components: [{ name: 'DropdownMenuItem', count: 4, self: 4, total: 4 }] };
  assert.equal(blameOf(209, timed, 'handleExportCsv'), 'handler handleExportCsv measured');
  assert.equal(blameOf(209, { ...timed, coarseClock: true, components: [{ name: 'DropdownMenuItem', count: 4, self: null, total: null }] }, 'handleExportCsv'), 'handler handleExportCsv inferred');
});

test('a render blame always names something: the subtree, or the app where the commit named none', () => {
  // A commit that named no root and no hot path. 0.3.0 named such a render "the app"; the name went null
  // with the readable-name rule, and a reader written against 0.3.0 that dereferences it threw.
  const nameless = commit(50, 0, { hasDurations: false, total: 0, rendered: 40, roots: [], hotPath: [], components: [] });
  const r = report([entry('click', 0, 120, 3, 100)], [nameless], []);
  assert.equal(r.explanation.blame.kind, 'render');
  assert.equal(r.explanation.blame.name, 'the app');
});

test('where React is not being read, the verdict says the setup is the cause rather than guessing at the working time', () => {
  // Next.js's dev server loaded react-dom before install(): React rendered on the page and nothing it did
  // is in the report. A click whose handlers ran from 2 to 202 ms, with the browser's record of the listener.
  const click = [entry('click', 0, 208, 2, 202)];
  const listener = [frame(0, 208, [script('BUTTON.onclick', 2, 200)])];
  const ring = loginClick('handleSave');
  const late = report(click, [], listener, ring, 'attributes', [], undefined, 'installed-late');
  // The script holds the handler and whatever React rendered inside it, so neither is named as the blame.
  assert.deepEqual(late.explanation.blame, { kind: 'none', name: null, detail: null, ms: null, confidence: 'inferred' });
  assert.match(late.explanation.cause, /What React did is unknown/);
  assert.doesNotMatch(late.explanation.cause, /most likely/);
  // The same click with no long task on record read as waiting and painting; it is the setup here too.
  const quiet = report(click, [], [], ring, 'attributes', [], undefined, 'installed-late');
  assert.deepEqual(quiet.explanation.blame, { kind: 'none', name: null, detail: null, ms: null, confidence: 'inferred' });
  assert.match(quiet.explanation.cause, /What React did is unknown/);
  // A page whose react-dom cannot be read is as blind.
  assert.equal(report(click, [], listener, ring, 'attributes', [], undefined, 'unreadable').explanation.blame.kind, 'none');
  // What the browser measured on its own still stands: a wait behind another task, or the screen update.
  const waited = report([entry('click', 1000, 400, 1380, 1385)], [], [frame(900, 490, [script('TimerHandler:setTimeout', 905, 470)])], loginClick('handleSave', 1000), 'attributes', [], undefined, 'installed-late');
  assert.equal(waited.explanation.blame.kind, 'waiting');
  assert.equal(report([entry('click', 0, 400, 3, 10)], [], [], ring, 'attributes', [], undefined, 'installed-late').explanation.blame.kind, 'painting');
  // With React read, the same click and record is the handler's script, as before.
  assert.deepEqual(report(click, [], listener, ring).explanation.blame, { kind: 'script', name: 'handleSave', detail: 'SignInPage', ms: 200, confidence: 'measured' });
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
    ['render from its effects, counted', report(slow, [commit(50, 0, { hasDurations: false, total: 0, rendered: 2, effectsStartedAt: 51, effectsEndedAt: 95 })], [], ring)],
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
  const cart: PageNavigation = { url: 'https://shop.example/cart', type: 'soft-navigation', start: 1004, router: { type: 'push', input: { inputTs: 1000, inputType: 'click', gestureTs: 990 } } };
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
  // The blame is named after the boundary, which holds every component hydrated, so its detail is the whole
  // count even where the walk's path went below the boundary: "120 of 300" beside "the Suspense boundary in
  // ProductPage" would read as 180 of the boundary's components not having hydrated.
  const deep = commit(50, 0, { ...hydration, rendered: 300, hotPath: ['Reviews', 'ReviewList'], startRendered: 300, pathRendered: 120, components: [{ name: 'Review', count: 100, self: 30, total: 30 }] });
  assert.equal(report([entry('click', 0, 120, 3, 100)], [deep], []).explanation.blame.detail, '300 components');

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
  assert.match(r.explanation.cause, /first, 40 components:/);
  // A hydration the walk cut short says it counted at least that many, as its detail does.
  const cut = report([entry('click', 0, 120, 3, 100)], [{ ...hydration, rendered: 5000, truncated: true }], []);
  assert.match(cut.explanation.cause, /hydrated the page first, at least 5000 components:/);
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

test("committing is React's time, not the handler's, where the build keeps the render's start", () => {
  // Safari on a slow machine, the layout thrash scenario: onClick sets one state, React renders 401
  // components in 404 ms, then 400 layout effects each read geometry after a write, for 466 ms more.
  // No long animation frames, so the forced layout has no figure of its own. Counting only the render
  // as React's left the 466 ms to the handler, which ran for a millisecond.
  const thrash = commit(871, 0, {
    startedAt: 3,
    total: 404,
    rendered: 401,
    coarseClock: true,
    roots: ['LayoutThrash'],
    hotPath: ['LayoutThrash'],
    components: [
      { name: 'PriceTicker', count: 400, self: null, total: null },
      { name: 'LayoutThrash', count: 1, self: null, total: null },
    ],
  });
  const tap = [input(0, 'click', { owners: ['LayoutThrash'], handler: 'onClick' })];
  const r = report([entry('click', 0, 872, 2, 871)], [thrash], null, tap);
  assert.deepEqual(r.explanation.blame, { kind: 'render', name: 'LayoutThrash', detail: 'PriceTicker ×400', ms: 868, confidence: 'inferred' });
  assert.match(r.explanation.cause, /Committing it took about 464 ms more: the DOM changes, ref callbacks and layout effects\./);
  assert.doesNotMatch(r.explanation.cause, /onClick/);
  // A production build keeps no start, so the same commit reads as it did before: the time beyond the render is the handler's.
  const noStart = report([entry('click', 0, 872, 2, 871)], [{ ...thrash, startedAt: null }], null, tap);
  assert.equal(noStart.explanation.blame.kind, 'handler');
});

test('a render that waited or yielded across the handlers is not counted as React time', () => {
  // React does not yield inside one event's handlers, so a render that began before them, or committed
  // after them, stopped somewhere on the way, and whatever ran meanwhile was not React's. Clipped to the
  // handlers, a transition that began at 900 and committed at 1290 would have taken all 277 ms of them.
  const tap = [input(1000, 'click', { handler: 'onClick' })];
  const click = [entry('click', 1000, 300, 1003, 1280)];
  const after = report(click, [commit(1290, 1000, { startedAt: 900, total: 60 })], null, tap);
  assert.equal(after.explanation.blame.kind, 'handler');
  assert.equal(after.explanation.blame.ms, 217);
  assert.doesNotMatch(after.explanation.cause, /Committing/);
  const before = report(click, [commit(1100, 1000, { startedAt: 800, total: 20 })], null, tap);
  assert.equal(before.explanation.blame.kind, 'handler');
  assert.equal(before.explanation.blame.ms, 257);
});

test("two roots' React time is counted once where their spans overlap", () => {
  // A layout effect of one root flushes another with flushSync, so the second renders and commits inside
  // the first's commit, which ends at 1200. Added up the two would be 247 ms of the 277, leaving the
  // handler 30, under a quarter of the working time. Counted once they are 197, and the handler's 80
  // is still worth saying, beside React's time rather than instead of it.
  const outer = commit(1200, 1000, { startedAt: 1003, total: 20 });
  const inner = commit(1100, 1000, { startedAt: 1050, total: 10 });
  const r = report([entry('click', 1000, 300, 1003, 1280)], [outer, inner], null, [input(1000, 'click', { handler: 'onClick' })]);
  assert.equal(r.explanation.blame.kind, 'render');
  assert.match(r.explanation.cause, /On top of that, .* ran for about 80 ms./);
});

test('a small render with a heavy commit is still React, not nothing', () => {
  // A 3 ms render whose layout effects set up a chart for 272 ms. Taken off the handler, the time has to
  // land on React's render, or the report says React's render was small and nothing else is known.
  const chart = commit(1280, 1000, { startedAt: 1005, total: 3, rendered: 2, roots: ['Chart'], hotPath: ['Chart'], components: [{ name: 'Chart', count: 2, self: null, total: null }] });
  const r = report([entry('click', 1000, 300, 1003, 1280)], [chart], null, [input(1000, 'click', { owners: ['Chart'], handler: 'onClick' })]);
  assert.equal(r.explanation.blame.kind, 'render');
  // The render and its committing: what the commit accounts for, not the 3 ms render alone.
  assert.equal(r.explanation.blame.ms, 275);
  assert.match(r.explanation.cause, /Committing it took about 272 ms more/);
});

test('with long animation frames, React time and forced layout are not added together', () => {
  // onClick runs 150 ms of its own code, then React renders for 40 ms and commits, and the layout effects
  // force 150 ms of layout inside that commit. The forced layout is inside React's span, so adding the
  // two would leave the handler nothing; the larger of them is React's, and the handler keeps its 150.
  // React's 200 ms outrun it, so React has the blame and the handler's 150 are said beside it.
  const commitAfter = commit(1353, 1000, { startedAt: 1153, total: 40 });
  const frames = [frame(990, 380, [script('BUTTON.onclick', 1003, 350, 150)])];
  const r = report([entry('click', 1000, 380, 1003, 1353)], [commitAfter], frames, [input(1000, 'click', { handler: 'onClick' })]);
  assert.equal(r.explanation.blame.kind, 'render');
  assert.match(r.explanation.cause, /On top of that, .* ran for about 150 ms./);
});

test('a few milliseconds of committing do not make a small render outrank a wait', () => {
  // A click that waited 300 ms behind another task, then rendered for 2 ms and committed for 4. Every
  // development build commits for a few milliseconds; that is no reason to blame a 2 ms render.
  const small = commit(1306, 1000, { startedAt: 1300, total: 2, rendered: 2, roots: ['Badge'], hotPath: ['Badge'] });
  const r = report([entry('click', 1000, 330, 1300, 1308)], [small], null, [input(1000, 'click', { owners: ['Badge'], handler: 'onClick' })]);
  assert.equal(r.explanation.blame.kind, 'waiting');
});

test('the render blame names the commit whose committing took the time', () => {
  // List renders for 30 ms and commits in 2; a layout effect of it sets state, and Tooltip renders in
  // 1 ms and then runs 200 ms of layout effects. The 200 ms is Tooltip's, so the blame is too.
  const list = commit(1035, 1000, { startedAt: 1003, total: 30, rendered: 31, roots: ['List'], hotPath: ['List'] });
  const tooltip = commit(1237, 1000, { startedAt: 1036, total: 1, rendered: 1, roots: ['Tooltip'], hotPath: ['Tooltip'] });
  const r = report([entry('click', 1000, 300, 1003, 1240)], [list, tooltip], null, [input(1000, 'click', { handler: 'onClick' })]);
  assert.equal(r.explanation.blame.kind, 'render');
  assert.equal(r.explanation.blame.name, 'Tooltip');
  assert.equal(r.explanation.blame.ms, 201);
  assert.match(r.explanation.cause, /Committing it took about 200 ms more/);
});

test('a root flushed inside another in the same millisecond keeps its committing', () => {
  // On a 1 ms clock a wrapper whose layout effect mounts a widget root with flushSync can share both
  // edges with it. The widget committed first and its layout effects took the 300 ms; taking each span
  // as inside the other would leave both with nothing.
  const widget = commit(1304, 1000, { startedAt: 1004, total: 1, rendered: 1, roots: ['Widget'], hotPath: ['Widget'] });
  const wrapper = commit(1304, 1000, { startedAt: 1004, total: 2, rendered: 1, roots: ['Wrapper'], hotPath: ['Wrapper'] });
  const r = report([entry('click', 1000, 310, 1003, 1306)], [widget, wrapper], null, [input(1000, 'click', { handler: 'onClick' })]);
  assert.equal(r.explanation.blame.kind, 'render');
  assert.equal(r.explanation.blame.name, 'Widget');
  assert.match(r.explanation.cause, /Committing it took about 299 ms more/);
});

test("the note under a screen update gives the committing that made React's time worth a mention", () => {
  // 40 ms of working time, 1 ms of it rendering Badge and 35 committing it, then 207 ms of screen update.
  const badge = commit(1040, 1000, { startedAt: 1004, total: 1, rendered: 1, roots: ['Badge'], hotPath: ['Badge'] });
  const r = report([entry('click', 1000, 250, 1003, 1043)], [badge], null, [input(1000, 'click', { owners: ['Badge'], handler: 'onClick' })]);
  assert.equal(r.explanation.blame.kind, 'painting');
  assert.ok(r.explanation.notes.some((n) => /and 35 ms committing it in the 40 ms of working time before that\./.test(n)), r.explanation.notes.join(' | '));
});

/** A button labelled Draw, the target of the clicks below. */
const draw = (extra: Partial<InputRecord> = {}) => [input(1000, 'click', { target: element('button', [text('Draw')]) as unknown as Node, handler: 'onClick', ...extra })];

test("a click's useEffect callbacks are React's time, not the handler's, where React ran them in the same task", () => {
  // onClick sets one state, Chart renders in 5 ms, and its useEffect draws for 300 ms. React 18 and 19
  // run a click's passive effects right after its commit and then say so, so the 300 ms has a figure.
  const chart = commit(1010, 1000, { startedAt: 1004, total: 5, rendered: 1, roots: ['Chart'], hotPath: ['Chart'], components: [{ name: 'Chart', count: 1, self: 5, total: 5 }], effectsStartedAt: 1010, effectsEndedAt: 1310 });
  const tap = draw({ owners: ['Chart'] });
  const click = [entry('click', 1000, 330, 1003, 1320)];
  const r = report(click, [chart], null, tap);
  assert.equal(r.explanation.blame.kind, 'render');
  assert.equal(r.explanation.blame.name, 'Chart');
  // The commit's milliseconds are its render, committing and effects together.
  assert.equal(r.explanation.blame.ms, 306);
  assert.match(r.explanation.cause, /React spent 5 ms re-rendering Chart\. The commit's useEffect callbacks then ran for about 300 ms more, before the screen could update\./);
  assert.doesNotMatch(r.explanation.cause, /onClick|Committing/);
  // Without the effects' times, as on React 17, the 300 ms is the handler's, as it was before.
  const noEffects = report(click, [{ ...chart, effectsStartedAt: null, effectsEndedAt: null }], null, tap);
  assert.equal(noEffects.explanation.blame.kind, 'handler');
  assert.equal(noEffects.explanation.blame.ms, 311);
});

test('a production build times the effects too, so a heavy useEffect is not read as the handler there', () => {
  // The same click on a production React: no render durations and no render start, but React still says
  // when the effects ended, so the 300 ms is measured. Which component's effect it was is a reading.
  const chart = commit(1010, 1000, { hasDurations: false, total: 0, rendered: 1, roots: ['Chart'], hotPath: ['Chart'], components: [{ name: 'Chart', count: 1, self: null, total: null }], effectsStartedAt: 1010, effectsEndedAt: 1310 });
  const tap = draw({ owners: ['Chart'] });
  const click = [entry('click', 1000, 330, 1003, 1320)];
  const r = report(click, [chart], null, tap);
  assert.deepEqual(r.explanation.blame, { kind: 'render', name: 'Chart', detail: null, ms: null, confidence: 'inferred' });
  assert.equal(
    r.explanation.cause,
    'React was most likely re-rendering Chart, then ran useEffect callbacks for about 300 ms of the 317 ms of working time, before the screen could update. A profiling build of React would time the render too.',
  );
  // Before, the only reading was the handler's.
  assert.equal(report(click, [{ ...chart, effectsStartedAt: null, effectsEndedAt: null }], null, tap).explanation.blame.kind, 'handler');
});

test('effects React ran in a later task are not counted', () => {
  // A transition's effects run in a task of their own, after the handlers, so what lies between the
  // commit and their end is anyone's. The handler keeps the time it had.
  const chart = commit(1010, 1000, { startedAt: 1004, total: 5, effectsStartedAt: 1010, effectsEndedAt: 1400 });
  const r = report([entry('click', 1000, 330, 1003, 1320)], [chart], null, draw());
  assert.equal(r.explanation.blame.kind, 'handler');
  assert.equal(r.explanation.blame.ms, 311);
  assert.doesNotMatch(r.explanation.cause, /useEffect/);
});

test("the effects' time starts where the hook call returned, after this library's walk and React DevTools' reading", () => {
  const chart = commit(1010, 1000, { startedAt: 1004, total: 5, rendered: 1, roots: ['Chart'], hotPath: ['Chart'], walkMs: 2, effectsStartedAt: 1030, effectsEndedAt: 1310 });
  const r = report([entry('click', 1000, 330, 1003, 1320)], [chart], null, draw({ owners: ['Chart'] }));
  assert.equal(r.explanation.blame.kind, 'render');
  assert.match(r.explanation.cause, /The commit's useEffect callbacks then ran for about 280 ms more/);
});

test('light effects beside a heavy handler leave the handler its time', () => {
  const list = commit(1260, 1000, { startedAt: 1253, total: 5, effectsStartedAt: 1260, effectsEndedAt: 1275 });
  const r = report([entry('click', 1000, 300, 1003, 1280)], [list], null, draw());
  assert.equal(r.explanation.blame.kind, 'handler');
  assert.equal(r.explanation.blame.ms, 255);
  assert.doesNotMatch(r.explanation.cause, /useEffect/);
});

test('a handler has to outrun all of React to be the blame, effects included, and is said beside it when it does not', () => {
  // onClick runs for 100 ms, Chart renders in 5 and its useEffect runs for 200. The handler outruns the
  // render but not React, and the 200 ms were left unsaid when the handler took the blame.
  const chart = commit(1110, 1000, { startedAt: 1104, total: 5, rendered: 1, roots: ['Chart'], hotPath: ['Chart'], effectsStartedAt: 1110, effectsEndedAt: 1310 });
  const r = report([entry('click', 1000, 330, 1003, 1320)], [chart], null, draw({ owners: ['Chart'] }));
  assert.equal(r.explanation.blame.kind, 'render');
  assert.match(r.explanation.cause, /The commit's useEffect callbacks then ran for about 200 ms more, before the screen could update\. On top of that, the onClick handler ran for about 1\d\d ms\./);
});

test('a root an effect flushes with flushSync is its own time, not the effects of the commit that ran it', () => {
  // Chart's useEffect runs for 300 ms, then commits a Tooltip root with flushSync, which React renders
  // for 50 ms once the effects are done and before it says they ran.
  const chart = commit(1010, 1000, { startedAt: 1004, total: 5, rendered: 1, roots: ['Chart'], hotPath: ['Chart'], effectsStartedAt: 1010, effectsEndedAt: 1360 });
  const tooltip = commit(1360, 1000, { startedAt: 1310, total: 40, rendered: 1, roots: ['Tooltip'], hotPath: ['Tooltip'], walkMs: 1 });
  const r = report([entry('click', 1000, 380, 1003, 1370)], [chart, tooltip], null, draw());
  assert.equal(r.explanation.blame.kind, 'render');
  assert.equal(r.explanation.blame.name, 'Chart');
  assert.match(r.explanation.cause, /The commit's useEffect callbacks then ran for about 300 ms more, before the screen could update/);
});

test("in a production build, a render inside the effects' time is said to be in the figure", () => {
  // As above on a production React, which keeps no render start: Tooltip's render cannot be taken out
  // of the 350 ms, so the sentence says the figure holds it.
  const chart = commit(1010, 1000, { hasDurations: false, total: 0, rendered: 1, roots: ['Chart'], hotPath: ['Chart'], effectsStartedAt: 1010, effectsEndedAt: 1360 });
  const tooltip = commit(1359, 1000, { hasDurations: false, total: 0, rendered: 1, roots: ['Tooltip'], hotPath: ['Tooltip'], walkMs: 1 });
  const r = report([entry('click', 1000, 380, 1003, 1370)], [chart, tooltip], null, draw());
  assert.equal(r.explanation.blame.name, 'Chart');
  // The Tooltip's walk is this library's time, not the effects'.
  assert.match(r.explanation.cause, /then ran useEffect callbacks for about 349 ms of the \d+ ms of working time, one more render included, before the screen could update\./);
});

test('committing and effects too small to mention alone are both said where together they took the time', () => {
  // 40 ms of working time: a 1 ms render, 15 ms committing it and 15 ms of effects. Neither alone is
  // worth a handler blame; the two together are, and the sentence says both.
  const badge = commit(1020, 1000, { startedAt: 1004, total: 1, rendered: 1, roots: ['Badge'], hotPath: ['Badge'], effectsStartedAt: 1020, effectsEndedAt: 1035 });
  const r = report([entry('click', 1000, 60, 1003, 1043)], [badge], null, draw({ owners: ['Badge'] }));
  assert.equal(r.explanation.blame.kind, 'render');
  assert.match(r.explanation.cause, /Committing it took about 15 ms more: the DOM changes, ref callbacks and layout effects\. The commit's useEffect callbacks then ran for about 15 ms more/);
});

test("where only the effects of several commits together earned React the blame, the sentence gives the totals", () => {
  // Two commits, each with 15 ms of effects, in 40 ms of working time: neither alone is worth saying.
  const first = commit(1010, 1000, { startedAt: 1009, total: 1, rendered: 1, roots: ['Chart'], hotPath: ['Chart'], effectsStartedAt: 1010, effectsEndedAt: 1025 });
  const second = commit(1027, 1000, { startedAt: 1026, total: 1, rendered: 1, roots: ['Legend'], hotPath: ['Legend'], effectsStartedAt: 1027, effectsEndedAt: 1042 });
  const click = [entry('click', 1000, 60, 1003, 1043)];
  const dev = report(click, [first, second], null, draw());
  assert.equal(dev.explanation.blame.kind, 'render');
  assert.match(dev.explanation.cause, /React spent 1 ms re-rendering \w+\. React also spent 30 ms running useEffect callbacks across 2 commits\./);
  const strip = (x: CommitSummary): CommitSummary => ({ ...x, hasDurations: false, total: 0, startedAt: null, components: [] });
  const production = report(click, [strip(first), strip(second)], null, draw());
  assert.equal(production.explanation.blame.kind, 'render');
  assert.match(production.explanation.cause, /then ran useEffect callbacks for about 30 ms of the 40 ms of working time across 2 commits, before the screen could update\./);
});

test("the note under a screen update gives the effects that made React's time worth a mention", () => {
  // 40 ms of working time, 1 ms of it rendering Badge and 35 running its effects, then 207 ms of screen update.
  const tap = draw({ owners: ['Badge'] });
  const click = [entry('click', 1000, 250, 1003, 1043)];
  const badge = commit(1005, 1000, { startedAt: 1004, total: 1, rendered: 1, roots: ['Badge'], hotPath: ['Badge'], effectsStartedAt: 1005, effectsEndedAt: 1040 });
  const r = report(click, [badge], null, tap);
  assert.equal(r.explanation.blame.kind, 'painting');
  assert.ok(r.explanation.notes.some((n) => /React still spent 1 ms re-rendering Badge and 35 ms running its useEffect callbacks in the 40 ms of working time before that\./.test(n)), r.explanation.notes.join(' | '));
  const production = report(click, [{ ...badge, hasDurations: false, total: 0, startedAt: null }], null, tap);
  assert.ok(production.explanation.notes.some((n) => /React was most likely still re-rendering Badge, then spent 35 ms running useEffect callbacks in the 40 ms of working time before that\./.test(n)), production.explanation.notes.join(' | '));
});

test("the note under a screen update reads as a sentence for a production build's render", () => {
  // 60 ms of working time with a render of 400 rows in it, then 187 ms of screen update.
  const rows = commit(1030, 1000, { hasDurations: false, total: 0, rendered: 400, roots: ['Table'], hotPath: ['Table'], components: [{ name: 'Row', count: 400, self: null, total: null }] });
  const r = report([entry('click', 1000, 250, 1003, 1063)], [rows], null, draw({ owners: ['Table'] }));
  assert.equal(r.explanation.blame.kind, 'painting');
  assert.ok(r.explanation.notes.some((n) => /^React was most likely still re-rendering 400 components inside Table.* in the 60 ms of working time before that\./.test(n)), r.explanation.notes.join(' | '));
  // Under a long task of working time the count would not have named the render, so there is no rung for
  // the note to stand in for.
  const quick = report([entry('click', 1000, 250, 1003, 1043)], [rows], null, draw({ owners: ['Table'] }));
  assert.equal(quick.explanation.blame.kind, 'painting');
  assert.ok(!quick.explanation.notes.some((n) => n.includes('still re-rendering')), quick.explanation.notes.join(' | '));
});

test('in a production build, effects that are a minority of the working time leave the handler the blame and come off its time', () => {
  // onClick runs for 150 ms and Chart's useEffect for 60. A production build cannot split the 150 ms
  // between the handler and the render, so the 60 ms, though worth saying, do not outrank it.
  const chart = commit(1155, 1000, { hasDurations: false, total: 0, rendered: 1, roots: ['Chart'], hotPath: ['Chart'], components: [{ name: 'Chart', count: 1, self: null, total: null }], effectsStartedAt: 1155, effectsEndedAt: 1215 });
  const r = report([entry('click', 1000, 230, 1005, 1215)], [chart], null, draw({ owners: ['Chart'] }));
  assert.equal(r.explanation.blame.kind, 'handler');
  assert.equal(r.explanation.blame.ms, null);
  assert.match(r.explanation.cause, /^The onClick handler most likely took about 150 ms of the 210 ms: React re-rendered only 1 component and ran useEffect callbacks for 60 ms./);
  // Where the effects are most of it, they are React's, as above.
  const most = { ...chart, at: 1055, effectsStartedAt: 1055, effectsEndedAt: 1210 };
  assert.equal(report([entry('click', 1000, 230, 1005, 1215)], [most], null, draw({ owners: ['Chart'] })).explanation.blame.kind, 'render');
});

test("a handler that is the blame is said beside the effects React ran for it, where they would show", () => {
  // onClick runs for about 150 ms, Chart renders in 5 and its useEffect runs for 60.
  const chart = commit(1160, 1000, { startedAt: 1154, total: 5, rendered: 1, roots: ['Chart'], hotPath: ['Chart'], effectsStartedAt: 1160, effectsEndedAt: 1220 });
  const r = report([entry('click', 1000, 260, 1003, 1223)], [chart], null, draw({ owners: ['Chart'] }));
  assert.equal(r.explanation.blame.kind, 'handler');
  assert.match(r.explanation.cause, /^The onClick handler ran for about 154 ms; React spent 5 ms re-rendering Chart\. React also spent 60 ms running useEffect callbacks\.$/);
});

test("the handler's sentence gives React's committing and effects as totals, since the render it names need not have spent them", () => {
  // List renders for 30 ms; Tooltip renders for 1 ms and commits for 200; onClick runs for about 266.
  const list = commit(1035, 1000, { startedAt: 1005, total: 30, rendered: 31, roots: ['List'], hotPath: ['List'] });
  const tooltip = commit(1237, 1000, { startedAt: 1036, total: 1, rendered: 1, roots: ['Tooltip'], hotPath: ['Tooltip'] });
  const r = report([entry('click', 1000, 520, 1003, 1500)], [list, tooltip], null, draw());
  assert.equal(r.explanation.blame.kind, 'handler');
  assert.match(r.explanation.cause, /React spent 31 ms re-rendering 31 components inside List, .*\)\. React also spent 200 ms committing in another commit\.$/);
});

test('effects too small to mention do not choose the commit a render blame names', () => {
  // List renders for 30 ms; Chart renders for 1 ms and runs 30 ms of effects, under a quarter of the 121 ms.
  const list = commit(1035, 1000, { startedAt: 1005, total: 30, rendered: 31, roots: ['List'], hotPath: ['List'] });
  const chart = commit(1037, 1000, { startedAt: 1036, total: 1, rendered: 1, roots: ['Chart'], hotPath: ['Chart'], effectsStartedAt: 1037, effectsEndedAt: 1067 });
  const r = report([entry('click', 1000, 150, 1003, 1124)], [list, chart], null, draw());
  assert.equal(r.explanation.blame.kind, 'render');
  assert.equal(r.explanation.blame.name, 'List');
});

test("in a production build, effects that together are most of the working time are said together", () => {
  // Chart's effects run for 60 ms and Legend's for 45, in 200 ms of working time: neither is half alone.
  const chart = commit(1020, 1000, { hasDurations: false, total: 0, rendered: 1, roots: ['Chart'], hotPath: ['Chart'], effectsStartedAt: 1020, effectsEndedAt: 1080 });
  const legend = commit(1100, 1000, { hasDurations: false, total: 0, rendered: 1, roots: ['Legend'], hotPath: ['Legend'], effectsStartedAt: 1100, effectsEndedAt: 1145 });
  const r = report([entry('click', 1000, 230, 1003, 1203)], [chart, legend], null, draw());
  assert.equal(r.explanation.blame.kind, 'render');
  assert.equal(r.explanation.blame.name, 'Chart');
  assert.match(r.explanation.cause, /then ran useEffect callbacks for about 105 ms of the 200 ms of working time across 2 commits, before the screen could update\./);
});

test('in a production build with no handler to name, effects under half the working time are still React\'s', () => {
  const chart = commit(1050, 1000, { hasDurations: false, total: 0, rendered: 1, roots: ['Chart'], hotPath: ['Chart'], effectsStartedAt: 1050, effectsEndedAt: 1150 });
  const r = report([entry('click', 1000, 230, 1005, 1215)], [chart], null, draw({ handler: undefined, owners: ['Chart'] }));
  assert.equal(r.explanation.blame.kind, 'render');
  assert.match(r.explanation.cause, /then ran useEffect callbacks for about 100 ms of the 210 ms of working time, before the screen could update\./);
});

test('a handler worth blaming keeps the blame where React\'s time would not earn it, however close the two are', () => {
  // onClick runs for 28 ms; React renders for 4 and runs 24 ms of effects, neither worth a blame.
  const badge = commit(1035, 1000, { startedAt: 1031, total: 4, rendered: 1, roots: ['Badge'], hotPath: ['Badge'], effectsStartedAt: 1035, effectsEndedAt: 1059 });
  const r = report([entry('click', 1000, 80, 1003, 1059)], [badge], null, draw());
  assert.equal(r.explanation.blame.kind, 'handler');
  assert.equal(r.explanation.blame.ms, 28);
});

test("where the named commit's effects are said, another commit's committing worth saying is said beside them", () => {
  // Panel renders for 1 ms and commits for 100; Chart renders for 1 ms and runs 120 ms of effects.
  const panel = commit(1104, 1000, { startedAt: 1003, total: 1, rendered: 1, roots: ['Panel'], hotPath: ['Panel'] });
  const chart = commit(1106, 1000, { startedAt: 1105, total: 1, rendered: 1, roots: ['Chart'], hotPath: ['Chart'], effectsStartedAt: 1106, effectsEndedAt: 1226 });
  const r = report([entry('click', 1000, 280, 1003, 1250)], [panel, chart], null, draw());
  assert.equal(r.explanation.blame.name, 'Chart');
  assert.equal(r.explanation.blame.ms, 121);
  assert.match(r.explanation.cause, /The commit's useEffect callbacks then ran for about 120 ms more, before the screen could update\. React also spent 100 ms committing in another commit\./);
});

test('in a production build with no handler to name, a listener beside React that ran longer than the effects keeps the blame', () => {
  // React's listener runs Chart's 60 ms of effects; a listener on the document then runs for 143 ms.
  const chart = commit(1010, 1000, { hasDurations: false, total: 0, rendered: 1, roots: ['Chart'], hotPath: ['Chart'], effectsStartedAt: 1010, effectsEndedAt: 1070 });
  const click = [entry('click', 1000, 230, 1005, 1215)];
  const tap = draw({ handler: undefined, owners: ['Chart'] });
  const react = script('#root.onclick', 1005, 66);
  const r = report(click, [chart], [frame(1000, 230, [react, script('#document.onclick', 1072, 143)])], tap);
  assert.equal(r.explanation.blame.kind, 'script');
  assert.equal(r.explanation.blame.name, '#document.onclick');
  // With only React's own listener on record, the effects are React's as before.
  assert.equal(report(click, [chart], [frame(1000, 230, [{ ...react, duration: 210 }])], tap).explanation.blame.kind, 'render');
});

test('a sentence says across how many commits only where more than one holds the figure it gives', () => {
  // List renders for 10 ms and runs all 190 ms of the effects; Tip commits for 2 ms after it.
  const list = commit(1015, 1000, { startedAt: 1005, total: 10, rendered: 11, roots: ['List'], hotPath: ['List'], effectsStartedAt: 1015, effectsEndedAt: 1205 });
  const tip = commit(1209, 1000, { startedAt: 1206, total: 1, rendered: 1, roots: ['Tip'], hotPath: ['Tip'] });
  const r = report([entry('click', 1000, 450, 1003, 1420)], [list, tip], null, draw());
  assert.equal(r.explanation.blame.kind, 'handler');
  assert.match(r.explanation.cause, /React also spent 190 ms running useEffect callbacks\.$/);
});

test('a render is named after its deepest readable component, and what it was mostly made of after a readable one', () => {
  const ring = loginClick('onClick');
  const slow = [entry('click', 0, 120, 3, 100)];
  const blameOf = (opts: Partial<CommitSummary>) => report(slow, [commit(4, 0, { hasDurations: false, total: 0, rendered: 332, ...opts })], [], ring).explanation;

  // styled-components names every element it wraps `styled.<tag>` or `Styled(<Name>)`, and a minifier
  // leaves a dependency's components one or two letters: none of them is a name the app wrote. The
  // wrappers are not counted against DayCell either, so 90 of the 132 other components are most of them.
  const styled = blameOf({
    roots: ['Calendar'],
    hotPath: ['Calendar', 'MonthGrid', 'styled.tbody', '$'],
    components: [
      { name: 'Styled(td)', count: 200, self: null, total: null },
      { name: 'et', count: 113, self: null, total: null },
      { name: 'DayCell', count: 90, self: null, total: null },
    ],
  });
  assert.equal(styled.blame.kind, 'render');
  assert.equal(styled.blame.name, 'MonthGrid');
  assert.equal(styled.blame.detail, 'DayCell ×90');
  assert.ok(styled.cause.includes('inside MonthGrid, mostly DayCell (90 of them)'), styled.cause);

  // Another root is not: the hot path starts at the heaviest root, so any other one is a subtree beside the
  // work, such as a one-line status bar that re-rendered with a grid of 300 cells.
  assert.equal(blameOf({ roots: ['$', 'Calendar'], hotPath: ['$', '_'], components: [] }).blame.name, '_');

  // "Mostly" is a readable component only while it carries a real share of the render: 2 Panels beside 120
  // components a minifier named is not what the render was made of.
  const scattered = blameOf({ rendered: 122, roots: ['Xe'], hotPath: ['Xe'], components: [{ name: 'Nu', count: 120, self: null, total: null }, { name: 'Panel', count: 2, self: null, total: null }] });
  assert.equal(scattered.blame.detail, 'Nu ×120');
  // Where React measured, the share is the time.
  const timed = blameOf({ hasDurations: true, total: 60, roots: ['Xe'], hotPath: ['Xe'], components: [{ name: 'Nu', count: 5, self: 40, total: 40 }, { name: 'Panel', count: 50, self: 12, total: 12 }] });
  assert.equal(timed.blame.detail, 'Nu ×5');

  // A profiling build that measured every component at 0 ms still has the counts to go by.
  const quick = commit(4, 0, { total: 0, rendered: 122, roots: ['Xe'], hotPath: ['Xe'], components: [{ name: 'Nu', count: 120, self: 0, total: 0 }, { name: 'Panel', count: 2, self: 0, total: 0 }] });
  assert.equal(mostlyComponent(quick)?.name, 'Nu');

  // Vite's development server and Rolldown add a `$1` to a name that clashes with another, which leaves a
  // minifier's `Dt` looking like a word.
  const deduped = blameOf({ roots: ['PeoplePicker'], hotPath: ['PeoplePicker', 'Dt$1'], components: [{ name: 'Dt$1', count: 30, self: null, total: null }] });
  assert.equal(deduped.blame.name, 'PeoplePicker');
  assert.equal(blameOf({ roots: ['App'], hotPath: ['App', 'Button$1'], components: [] }).blame.name, 'Button$1');

  // With nothing readable anywhere the names are kept as they stand, rather than one being invented.
  const minified = blameOf({ rendered: 120, roots: ['Xe'], hotPath: ['Xe', '$'], components: [{ name: 'et', count: 113, self: null, total: null }] });
  assert.equal(minified.blame.name, '$');
  assert.equal(minified.blame.detail, 'et ×113');
});

test('a render is said to be mostly one component only where that component is half of it, by count or by the time React timed', () => {
  const click = [entry('click', 0, 120, 3, 100)];
  const counted = (rendered: number, hotPath: string[], components: [string, number][]) =>
    report(click, [commit(50, 0, { hasDurations: false, total: 0, rendered, roots: [hotPath[0]!], hotPath, components: components.map(([name, count]) => ({ name, count, self: null, total: null })) })], []).explanation;

  // Shaped like reports 0.12.0 gave on the shadcn/ui docs and on Twenty, where the most-rendered component
  // was a small part of the render.
  const dialog = counted(59, ['DismissableLayer'], [['Label', 4], ['Button', 3], ['DialogTitle', 1]]);
  assert.match(dialog.cause, /^React was most likely re-rendering 59 components inside DismissableLayer, in the 97 ms of working time\. /);
  assert.equal(dialog.blame.detail, '59 components');
  const panel = counted(1298, ['SidePanelSubPageRouter'], [['(anonymous)', 124], ['MenuItem', 40]]);
  assert.match(panel.cause, /^React was most likely re-rendering 1298 components inside SidePanelSubPageRouter, in the 97 ms of working time\. /);
  assert.equal(panel.blame.detail, '1298 components');
  // Where the render is named after that component, the count after it goes too.
  const presence = counted(56, ['Popover', 'Presence'], [['Presence', 4], ['Label', 2]]);
  assert.match(presence.cause, /^React was most likely re-rendering 56 components inside Presence, in the 97 ms of working time\. /);

  // Half of the components is enough, and so is half of the render's time.
  assert.match(counted(460, ['CommandList'], [['(anonymous)', 422], ['CommandItem', 20]]).cause, /re-rendering 460 components inside CommandList, mostly \(anonymous\) \(422 of them\), in the 97 ms of working time\. /);
  const typed = report(click, [commit(50, 0, { hasDurations: false, total: 0, rendered: 4, roots: ['CommandInput'], hotPath: ['CommandInput'], components: [{ name: '(anonymous)', count: 2, self: null, total: null }, { name: 'Primitive.input', count: 1, self: null, total: null }] })], []).explanation;
  assert.match(typed.cause, /re-rendering 4 components inside CommandInput, mostly \(anonymous\) \(2 of them\)\)/);
  const rows = report(
    [entry('click', 0, 48, 3, 30)],
    [
      commit(28, 0, {
        total: 24,
        rendered: 721,
        roots: ['App'],
        hotPath: ['App', 'TableBody'],
        components: [
          { name: 'TableBodyRow', count: 36, self: 13, total: 0.6 },
          { name: 'cell', count: 612, self: 6, total: 0.1 },
          { name: 'TableBody', count: 1, self: 3, total: 23 },
        ],
      }),
    ],
    [],
  ).explanation;
  assert.equal(rows.cause, 'React spent 24 ms re-rendering 721 components inside TableBody, mostly TableBodyRow (36 of them, 13 ms).');
  assert.equal(rows.blame.detail, 'TableBodyRow ×36');

  // Which blame a render gets is decided as before: 60 of one component beside a named handler is a list,
  // and a list explains the working time, though it is not most of these 200 components.
  const list = report(click, [commit(50, 0, { hasDurations: false, total: 0, rendered: 200, roots: ['Feed'], hotPath: ['Feed'], components: [{ name: 'Post', count: 60, self: null, total: null }] })], [], loginClick('onClick')).explanation;
  assert.equal(list.blame.kind, 'render');
  assert.equal(list.blame.detail, '200 components');
  assert.doesNotMatch(list.cause, /mostly/);
});

/**
 * TanStack Table's virtualized rows example with 200,000 rows, sorted by a click on "Last Name", as a profiling
 * build reported it: TableBody sorts the rows inside `table.getRowModel()`, which it calls while it renders, so
 * 257 of the 277 ms are its own and the components under it took about 17.
 */
const tableSort = (opts: Partial<CommitSummary> = {}, at = 290) =>
  commit(at, 0, {
    rendered: 637,
    total: 277,
    roots: ['App'],
    hotPath: ['App', 'TableBody'],
    components: [
      { name: 'TableBody', count: 1, self: 257.4, total: 274.7 },
      { name: 'TableBodyRow', count: 31, self: 8.4, total: 0.6 },
      { name: 're', count: 288, self: 4.9, total: 0.1 },
      { name: 'cell', count: 279, self: 1, total: 0.1 },
      { name: 'App', count: 1, self: 0.9, total: 277 },
    ],
    ...opts,
  });

test("a render that was mostly one component's own render says so, rather than sending the reader to the components under it", () => {
  const r = report([entry('click', 0, 304, 2, 296)], [tableSort()], []).explanation;
  assert.equal(r.cause, "React spent 277 ms re-rendering 637 components inside TableBody (257 ms of it in TableBody's own render).");
  assert.deepEqual(r.blame, { kind: 'render', name: 'TableBody', detail: "TableBody's own render", ms: 277, confidence: 'measured' });
  assert.deepEqual(r.notes, [
    "Time in TableBody's own render is usually work it does as it renders, like a sort or a filter, which memoising the components under it does not speed up.",
  ]);

  // Where that component is not the one the render is named after, it is still the one named.
  const beside = report([entry('click', 0, 304, 2, 296)], [tableSort({ hotPath: ['App', 'Table'] })], []).explanation;
  assert.match(beside.cause, /inside Table \(257 ms of it in TableBody's own render\)\.$/);
  assert.equal(beside.blame.detail, "TableBody's own render");

  // A production build has no time for any one component, so there is nothing to say about one.
  const production = report([entry('click', 0, 304, 2, 296)], [tableSort({ hasDurations: false, total: 0, components: tableSort().components.map((x) => ({ ...x, self: null, total: null })) })], []).explanation;
  assert.equal(production.blame.detail, '637 components');
  assert.match(production.cause, /^React was most likely re-rendering 637 components inside TableBody, in the 294 ms of working time\. /);
  assert.doesNotMatch(production.cause, /own render/);
  assert.ok(!production.notes.some((n) => n.includes('own render')), production.notes.join(' | '));

  // Under a screen update that outran the working time, the note that stands in for the render says it
  // too, with the committing figure after it.
  const screen = report([entry('click', 0, 425, 0, 210)], [tableSort({ startedAt: 10, total: 120, components: [{ name: 'TableBody', count: 1, self: 100, total: 118 }, ...tableSort().components.slice(1)] }, 200)], []).explanation;
  assert.equal(screen.blame.kind, 'painting');
  assert.ok(
    screen.notes.includes("React still spent 120 ms re-rendering 637 components inside TableBody (100 ms of it in TableBody's own render) and 70 ms committing it in the 210 ms of working time before that."),
    screen.notes.join(' | '),
  );

  // And with the effects as well, both figures after it.
  const both = report(
    [entry('click', 0, 600, 0, 240)],
    [tableSort({ startedAt: 10, total: 80, effectsStartedAt: 170, effectsEndedAt: 240, components: [{ name: 'TableBody', count: 1, self: 60, total: 78 }, ...tableSort().components.slice(1)] }, 170)],
    [],
  ).explanation;
  assert.equal(both.blame.kind, 'painting');
  assert.ok(
    both.notes.includes(
      "React still spent 80 ms re-rendering 637 components inside TableBody (60 ms of it in TableBody's own render), 80 ms committing it and 70 ms running its useEffect callbacks in the 240 ms of working time before that.",
    ),
    both.notes.join(' | '),
  );
});

test("one component's own render is named from 25 ms and half of the render, and only where React timed it in a walk it finished", () => {
  /** TableBody's own render at `self` ms of a `total` ms render, in a click whose working time is little more than that render. */
  const sorted = (self: number, total: number, opts: Partial<CommitSummary> = {}) =>
    report([entry('click', 0, total + 24, 2, total + 8)], [tableSort({ total, components: [{ name: 'TableBody', count: 1, self, total: total - 2 }, ...tableSort().components.slice(1)], ...opts }, total + 6)], []).explanation;
  const named = (x: ReturnType<typeof sorted>) => x.blame.detail === "TableBody's own render" && /own render/.test(x.cause) && x.notes.some((n) => n.includes('own render'));
  const unnamed = (x: ReturnType<typeof sorted>) => x.blame.detail !== "TableBody's own render" && !/own render/.test(x.cause) && !x.notes.some((n) => n.includes('own render'));

  // 25 ms is enough, and just under it is not, with the share well over half.
  const at25 = sorted(25, 40);
  assert.equal(at25.cause, "React spent 40 ms re-rendering 637 components inside TableBody (25 ms of it in TableBody's own render).");
  assert.ok(named(at25), at25.cause);
  const under25 = sorted(24.9, 40);
  assert.equal(under25.cause, 'React spent 40 ms re-rendering 637 components inside TableBody.');
  assert.equal(under25.blame.detail, '637 components');
  assert.ok(unnamed(under25), under25.cause);

  // Half of the render is enough, and just under half is not, with the time well over 25 ms.
  assert.ok(named(sorted(30, 60)));
  assert.ok(unnamed(sorted(29.9, 60)));

  // One component rendered is a render of that component, and the sentence already names it.
  const alone = sorted(100, 120, { rendered: 1, components: [{ name: 'TableBody', count: 1, self: 100, total: 118 }] });
  assert.equal(alone.cause, 'React spent 120 ms re-rendering TableBody.');
  assert.equal(alone.blame.detail, null);
  assert.ok(unnamed(alone), alone.cause);

  // A walk cut short has counted only the part it reached, so no one component's share of it is known.
  const cut = sorted(100, 120, { truncated: true });
  assert.equal(cut.blame.detail, 'at least 637 components');
  assert.ok(unnamed(cut), cut.cause);

  // Without durations there is no time of a component's own to go by.
  const production = sorted(100, 120, { hasDurations: false, total: 0, components: tableSort().components.map((x) => ({ ...x, self: null, total: null })) });
  assert.equal(production.blame.detail, '637 components');
  assert.ok(unnamed(production), production.cause);

  // A root outside ProfileMode with a <Profiler> under it can leave the commit's total below the
  // component's own time, and "100 ms of it" in a 60 ms render would be more than the whole.
  const profiler = sorted(100, 60);
  assert.equal(profiler.blame.detail, '637 components');
  assert.ok(unnamed(profiler), profiler.cause);
});

test("a render whose time is in the components under it, or is small, puts none of it on one component's own render", () => {
  const click = [entry('click', 0, 200, 3, 190)];
  // The demo's context storm: OrderSummary renders once and cheaply, and the time is in its 800 line items.
  const storm = commit(180, 0, {
    rendered: 801,
    total: 170,
    roots: ['ContextStorm'],
    hotPath: ['ContextStorm', 'OrderSummary'],
    components: [
      { name: 'LineItem', count: 800, self: 161, total: 0.4 },
      { name: 'OrderSummary', count: 1, self: 3, total: 170 },
    ],
  });
  const lineItems = report(click, [storm], []).explanation;
  assert.equal(lineItems.cause, 'React spent 170 ms re-rendering 801 components inside OrderSummary, mostly LineItem (800 of them, 161 ms).');
  assert.equal(lineItems.blame.detail, 'LineItem ×800');
  assert.deepEqual(lineItems.notes, []);

  // A dashboard of 60 different widgets, each rendered once: the one rendered first costs the most of any,
  // and still under half of the render.
  const widgets = Array.from({ length: 11 }, (_, i) => ({ name: `Widget${i}`, count: 1, self: 10, total: 10 }));
  const dashboard = commit(180, 0, { rendered: 60, total: 170, roots: ['Dashboard'], hotPath: ['Dashboard'], components: [{ name: 'Dashboard', count: 1, self: 40, total: 170 }, ...widgets] });
  const spread = report(click, [dashboard], []).explanation;
  assert.equal(spread.cause, 'React spent 170 ms re-rendering 60 components inside Dashboard.');
  assert.equal(spread.blame.detail, '60 components');
  assert.deepEqual(spread.notes, []);

  // Two thirds of a 30 ms render is 20 ms, too little in one component to be worth sending anyone to it.
  const small = commit(40, 0, { total: 30, components: [{ name: 'List', count: 1, self: 20, total: 30 }, { name: 'Row', count: 29, self: 10, total: 0.4 }] });
  const quick = report([entry('click', 0, 64, 3, 40)], [small], []).explanation;
  assert.equal(quick.cause, 'React spent 30 ms re-rendering 30 components inside List.');
  assert.equal(quick.blame.detail, '30 components');
  assert.deepEqual(quick.notes, []);
});

test("a click on an icon inside a button is named by the button's component, not the icon's", () => {
  // lucide-react builds every icon as a forwardRef with a displayName, so the icon is a component of its
  // own: `button > svg > path`, with Trash2 between the button and the svg.
  function removeRow() {}
  function DeleteButton() {}
  function Toolbar() {}
  const fiberOf = (tag: number, type: unknown, parent: Record<string, unknown> | null, props: Record<string, unknown> | null = null) =>
    ({ tag, flags: 1, mode: 0, elementType: type, type, memoizedProps: props, memoizedState: null, return: parent, child: null, sibling: null, alternate: null });
  const toolbar = fiberOf(0, Toolbar, null);
  const deleteButton = fiberOf(0, DeleteButton, toolbar);
  const buttonFiber = fiberOf(5, 'button', deleteButton, { onClick: removeRow, 'aria-label': 'Delete row' });
  const trash2 = fiberOf(11, { $$typeof: Symbol.for('react.forward_ref'), render: () => null, displayName: 'Trash2' }, buttonFiber);
  const svgFiber = fiberOf(5, 'svg', trash2, {});
  const pathFiber = fiberOf(5, 'path', svgFiber, {});
  const path = Object.assign(element('path', []), { __reactFiber$k1: pathFiber });
  const svg = Object.assign(element('svg', [path]), { __reactFiber$k1: svgFiber });
  const button = Object.assign(element('button', [svg], { 'aria-label': 'Delete row' }), { __reactFiber$k1: buttonFiber });
  children(toolbar, deleteButton);
  children(deleteButton, buttonFiber);
  children(buttonFiber, trash2);
  children(trash2, svgFiber);
  children(svgFiber, pathFiber);
  Object.assign(buttonFiber, { stateNode: button });

  const live = report([entry('click', 0, 120, 3, 100, { target: path })], [], []);
  assert.equal(live.target?.component, 'DeleteButton');
  assert.deepEqual(live.target?.owners, ['DeleteButton', 'Toolbar']);
  assert.equal(live.target?.label, 'button "Delete row"');
  assert.equal(live.target?.handler, 'removeRow');
  // The selector is still the element the browser reported.
  assert.equal(live.target?.selector, 'path');
  assert.ok(live.verdict.includes('click on button "Delete row" in DeleteButton'), live.verdict);

  // A click that swaps the icon detaches the path before its entry arrives: the control found at
  // dispatch labels it, where the path alone would read as `path`.
  const detached = element('path', []);
  const ring = [input(0, 'click', { target: detached as unknown as Node, control: button as unknown as Node, owners: ['DeleteButton', 'Toolbar'], handler: 'removeRow' })];
  const gone = report([entry('click', 0, 120, 3, 100)], [], [], ring);
  assert.equal(gone.target?.label, 'button "Delete row"');
  assert.equal(gone.target?.component, 'DeleteButton');
  assert.equal(gone.target?.selector, 'path');
});

/** Links a fiber to its children, as React does: the first as `child`, each to the next as `sibling`. */
function children(parent: Record<string, unknown>, ...kids: Record<string, unknown>[]): void {
  parent.child = kids[0] ?? null;
  kids.forEach((kid, i) => {
    kid.return = parent;
    kid.sibling = kids[i + 1] ?? null;
  });
}

test('what an icon belongs to is read from the fiber tree: a card\'s photo is the card, an option\'s icon the option, a button\'s the button', () => {
  const fiberOf = (tag: number, type: unknown, props: Record<string, unknown> | null = null) =>
    ({ tag, flags: 1, mode: 0, elementType: type, type, memoizedProps: props, memoizedState: null, return: null, child: null, sibling: null, alternate: null }) as Record<string, unknown>;
  const component = (name: string) => fiberOf(0, Object.defineProperty(function () {}, 'name', { value: name }));
  const icon = (name: string) => fiberOf(11, { $$typeof: Symbol.for('react.forward_ref'), render: () => null, displayName: name });
  /** A host fiber and its element, each pointing at the other. */
  const host = (tag: string, attributes: Record<string, string> = {}, kids: Record<string, unknown>[] = []) => {
    const el = element(tag, kids.map((k) => k.el as Record<string, unknown>), attributes);
    const fiber = fiberOf(5, tag, attributes);
    fiber.stateNode = el;
    el.__reactFiber$k1 = fiber;
    return { el, fiber };
  };
  const ownersFor = (target: Record<string, unknown>) => report([entry('click', 0, 120, 3, 100, { target })], [], []).target?.owners;

  // <a> in ProductList around ProductCard, which renders a photo, a title and Stars, three svg stars.
  const img = host('img');
  const title = host('span');
  const stars = [0, 1, 2].map(() => {
    const polygon = host('polygon');
    const star = host('svg', {}, [polygon]);
    children(star.fiber, polygon.fiber);
    return star;
  });
  const starsFiber = component('Stars');
  children(starsFiber, ...stars.map((star) => star.fiber));
  const card = host('div', {}, [img, title, ...stars]);
  children(card.fiber, img.fiber, title.fiber, starsFiber);
  const productCard = component('ProductCard');
  children(productCard, card.fiber);
  const link = host('a', { href: '/kettle', 'aria-label': 'Kettle' }, [card]);
  children(link.fiber, productCard);
  const list = component('ProductList');
  children(list, link.fiber);
  assert.deepEqual(ownersFor(img.el), ['ProductCard', 'ProductList']);
  assert.deepEqual(ownersFor(stars[1]!.el), ['Stars', 'ProductCard', 'ProductList']);
  assert.deepEqual(ownersFor(title.el), ['ProductCard', 'ProductList']);

  // <li role="option"> around PersonOption, which renders UserIcon beside the person's name.
  const person = host('svg');
  const userIcon = icon('UserIcon');
  children(userIcon, person.fiber);
  const name = host('span');
  const option = component('PersonOption');
  children(option, userIcon, name.fiber);
  const li = host('li', { role: 'option' }, [person, name]);
  children(li.fiber, option);
  const picker = component('PeoplePicker');
  children(picker, li.fiber);
  assert.deepEqual(ownersFor(person.el), ['PersonOption', 'PeoplePicker']);

  // A trash icon beside its label, and an avatar beside a name inside a link: the icon and the Avatar that
  // renders nothing but its picture are what the control holds, not what was clicked.
  const trash = host('svg');
  const trash2 = icon('Trash2');
  children(trash2, trash.fiber);
  const label = host('span');
  const button = host('button', {}, [trash, label]);
  children(button.fiber, trash2, label.fiber);
  const deleteButton = component('DeleteButton');
  children(deleteButton, button.fiber);
  assert.deepEqual(ownersFor(trash.el), ['DeleteButton']);
  const photo = host('img');
  const avatar = component('Avatar');
  children(avatar, photo.fiber);
  const userName = host('span');
  const userLink = host('a', { href: '/ada' }, [photo, userName]);
  children(userLink.fiber, avatar, userName.fiber);
  const userLinkComponent = component('UserLink');
  children(userLinkComponent, userLink.fiber);
  assert.deepEqual(ownersFor(photo.el), ['UserLink']);

  // An element that handles the click itself is what was clicked, icon or not: a thumbnail's `<img onClick>`
  // is named by the component that renders it, and so is a `<div onClick>` around an icon.
  const thumbnails = [0, 1, 2].map(() => {
    const img = host('img');
    (img.fiber.memoizedProps as Record<string, unknown>).onClick = () => {};
    const thumbnail = component('Thumbnail');
    children(thumbnail, img.fiber);
    return { img, thumbnail };
  });
  const gallery = host('div', {}, thumbnails.map((t) => t.img));
  children(gallery.fiber, ...thumbnails.map((t) => t.thumbnail));
  children(component('Gallery'), gallery.fiber);
  assert.deepEqual(ownersFor(thumbnails[1]!.img.el), ['Thumbnail', 'Gallery']);
  const pencil = host('svg');
  const pencilIcon = icon('Pencil');
  children(pencilIcon, pencil.fiber);
  const iconDiv = host('div', {}, [pencil]);
  (iconDiv.fiber.memoizedProps as Record<string, unknown>).onClick = () => {};
  children(iconDiv.fiber, pencilIcon);
  const editButton = component('EditButton');
  children(editButton, iconDiv.fiber);
  const toolbar = host('div', {}, [iconDiv, host('span')]);
  children(toolbar.fiber, editButton, host('span').fiber);
  children(component('Toolbar'), toolbar.fiber);
  assert.deepEqual(ownersFor(pencil.el), ['EditButton', 'Toolbar']);

  // A handler handed down to the icon, as lucide's Trash2 and Icon hand onClick to the svg, belongs to the
  // component that wrote `<Trash2 onClick>`, beside a label or alone.
  const trashWith = (parentProps: Record<string, unknown>) => {
    const remove = () => {};
    const svg = host('svg');
    (svg.fiber.memoizedProps as Record<string, unknown>).onClick = remove;
    const lucideIcon = icon('Icon');
    lucideIcon.memoizedProps = { onClick: remove };
    children(lucideIcon, svg.fiber);
    const trash = icon('Trash2');
    trash.memoizedProps = { onClick: remove };
    children(trash, lucideIcon);
    const writer = component('RemoveRow');
    writer.memoizedProps = parentProps;
    return { svg, trash, writer };
  };
  const inline = trashWith({});
  const text = host('span', {}, [inline.svg]);
  children(text.fiber, inline.trash, host('span').fiber);
  children(inline.writer, text.fiber);
  children(component('Rows'), inline.writer);
  assert.deepEqual(ownersFor(inline.svg.el), ['RemoveRow', 'Rows']);
  const alone = trashWith({});
  children(alone.writer, alone.trash);
  const row = host('div', {}, [alone.svg, host('span')]);
  children(row.fiber, alone.writer, host('span').fiber);
  children(component('Rows'), row.fiber);
  assert.deepEqual(ownersFor(alone.svg.el), ['RemoveRow', 'Rows']);
  // The same where the icon is a control of its own: `<Trash2 role="button" onClick>`.
  const asButton = trashWith({});
  asButton.svg.el.getAttribute = (name: string) => (name === 'role' ? 'button' : null);
  children(asButton.writer, asButton.trash);
  const buttonRow = host('div', {}, [asButton.svg, host('span')]);
  children(buttonRow.fiber, asButton.writer, host('span').fiber);
  children(component('Rows'), buttonRow.fiber);
  assert.deepEqual(ownersFor(asButton.svg.el), ['RemoveRow', 'Rows']);
});

test("Enter's work in the keypress entry is named by the form's onSubmit, from the key its keydown recorded", () => {
  // Enter in a field: the keydown's handlers take 2 ms and the keypress's 120, the time the form's submit
  // handler took. An Event Timing entry says no key; only the keydown's record does.
  function submitOrder() {}
  function OrderForm() {}
  const fiberOf = (tag: number, type: unknown, parent: Record<string, unknown> | null, props: Record<string, unknown> | null = null) =>
    ({ tag, flags: 1, mode: 0, elementType: type, type, memoizedProps: props, memoizedState: null, return: parent, child: null, sibling: null, alternate: null });
  const form = fiberOf(0, OrderForm, null);
  const formEl = fiberOf(5, 'form', form, { onSubmit: submitOrder });
  const field = fiberOf(5, 'input', formEl, { type: 'text', name: 'qty' });
  const target = Object.assign(element('input', [], { name: 'qty' }), { __reactFiber$k1: field });
  const press = [entry('keydown', 0, 140, 1, 3, { target }), entry('keypress', 0, 140, 3, 123, { target })];
  const ring = [input(0, 'keydown', { target: target as unknown as Node, press: 'Enter', owners: ['OrderForm'] })];
  assert.equal(report(press, [], [], ring).target?.handler, 'submitOrder');
  // Any other key submits nothing, so nothing is named for the keypress's work.
  const other = [input(0, 'keydown', { target: target as unknown as Node, press: 'KeyA', owners: ['OrderForm'] })];
  assert.equal(report(press, [], [], other).target?.handler, null);
});

test('the handler named is the one whose event did the work, with PREFERRED settling a tie', () => {
  // A row that selects itself on click, holding a menu button that opens on pointerdown, as Radix's
  // DropdownMenu does: the pointerdown's handlers ran for 90 ms, the pointerup's and the click's for none.
  function selectRow() {}
  function openMenu() {}
  function Row() {}
  const fiberOf = (tag: number, type: unknown, parent: Record<string, unknown> | null, props: Record<string, unknown> | null = null) =>
    ({ tag, flags: 1, mode: 0, elementType: type, type, memoizedProps: props, memoizedState: null, return: parent, child: null, sibling: null, alternate: null });
  const row = fiberOf(0, Row, null);
  const rowDiv = fiberOf(5, 'div', row, { onClick: selectRow });
  const buttonFiber = fiberOf(5, 'button', rowDiv, { onPointerDown: openMenu, 'aria-label': 'Row actions' });
  const button = Object.assign(element('button', [], { 'aria-label': 'Row actions' }), { __reactFiber$k1: buttonFiber });
  const press = (down: number, click: number) => [
    entry('pointerdown', 0, 120, 2, 2 + down, { target: button }),
    entry('pointerup', 100, 16, 101, 101.2, { target: button }),
    entry('click', 100, 16, 101.3, 101.3 + click, { target: button }),
  ];

  const opened = report(press(90, 0.1), [], []);
  assert.equal(opened.target?.handler, 'openMenu');
  // The report is still named by the click, the event people know.
  assert.equal(opened.type, 'click');

  // Handlers that did about the same work tie, and the click's is named as it always was.
  assert.equal(report(press(0.2, 0.1), [], []).target?.handler, 'selectRow');
  assert.equal(report(press(3, 0.1), [], []).target?.handler, 'selectRow');
  // A click whose own handler did the work is named by it, whatever else ran.
  assert.equal(report(press(20, 60), [], []).target?.handler, 'selectRow');
  // The tie is strictly under 4 ms.
  assert.equal(report(press(3.9, 0.1), [], []).target?.handler, 'selectRow');
  assert.equal(report(press(4.2, 0.1), [], []).target?.handler, 'openMenu');

  // Where the pointerdown's work was a listener of the page's own, no React handler did it: the onClick
  // that did nothing is not named for it.
  const plainButton = fiberOf(5, 'button', rowDiv, { 'aria-label': 'Row actions' });
  const plain = Object.assign(element('button', [], { 'aria-label': 'Row actions' }), { __reactFiber$k1: plainButton });
  const native = report([entry('pointerdown', 0, 120, 2, 92, { target: plain }), entry('pointerup', 100, 16, 101, 101.2, { target: plain }), entry('click', 100, 16, 101.3, 101.4, { target: plain })], [], []);
  assert.equal(native.target?.handler, null);

  // The same order where the node left the page and the ring's handlers stand in.
  const ring = [
    input(0, 'pointerdown', { target: element('button', []) as unknown as Node, owners: ['Row'], handler: 'openMenu' }),
    input(100, 'pointerup', { target: element('button', []) as unknown as Node, owners: ['Row'], handler: null }),
    input(100, 'click', { target: element('button', []) as unknown as Node, owners: ['Row'], handler: 'selectRow' }),
  ];
  const gone = [entry('pointerdown', 0, 120, 2, 92), entry('pointerup', 100, 16, 101, 101.2), entry('click', 100, 16, 101.3, 101.4)];
  assert.equal(report(gone, [], [], ring).target?.handler, 'openMenu');

  // A key press and its release keep the keydown's handler.
  function save() {}
  const input$ = fiberOf(5, 'div', row, { onKeyDown: save, onKeyUp: () => {} });
  const field = Object.assign(element('div', []), { __reactFiber$k1: input$ });
  const keys = report([entry('keydown', 0, 120, 2, 80, { target: field }), entry('keyup', 110, 8, 111, 111.1, { target: field })], [], []);
  assert.equal(keys.target?.handler, 'save');
});

test("a mouse's pointerdown alone reads as a click, a finger's as a tap", () => {
  const alone = [entry('pointerdown', 0, 120, 2, 92)];
  const mouse = report(alone, [], [], [input(0, 'pointerdown', { pointerType: 'mouse' })]);
  assert.equal(mouse.type, 'pointerdown');
  assert.equal(mouse.pointerType, 'mouse');
  assert.match(mouse.verdict, /^120 ms click\b/);
  const touch = report(alone, [], [], [input(0, 'pointerdown', { pointerType: 'touch' })]);
  assert.equal(touch.pointerType, 'touch');
  assert.match(touch.verdict, /^120 ms tap\b/);
  // Not seen at dispatch: as before.
  const unseen = report(alone, [], []);
  assert.equal(unseen.pointerType, null);
  assert.match(unseen.verdict, /^120 ms tap\b/);
  // A key's click carries no pointer.
  assert.equal(report([entry('click', 0, 120, 2, 92)], [], [], [input(0, 'click', { pointerType: '' })]).pointerType, null);
});

test('a click inside a link or an option is named by the component it landed in; only an icon gives way to its control', () => {
  function ProductCard() {}
  function ProductList() {}
  const fiberOf = (tag: number, type: unknown, parent: Record<string, unknown> | null, props: Record<string, unknown> | null = null) =>
    ({ tag, flags: 1, mode: 0, elementType: type, type, memoizedProps: props, memoizedState: null, return: parent, child: null, sibling: null, alternate: null });
  // <ProductList> renders <a href> around each <ProductCard>, which renders a div with the product's name.
  const list = fiberOf(0, ProductList, null);
  const linkFiber = fiberOf(5, 'a', list, { href: '/p/1' });
  const card = fiberOf(0, ProductCard, linkFiber);
  const nameFiber = fiberOf(5, 'span', card, {});
  const name = Object.assign(element('span', [text('Kettle')]), { __reactFiber$k1: nameFiber });
  Object.assign(element('a', [name], { href: '/p/1', 'aria-label': 'Kettle' }), { __reactFiber$k1: linkFiber });
  const r = report([entry('click', 0, 120, 3, 100, { target: name })], [], []);
  assert.equal(r.target?.component, 'ProductCard');
  assert.deepEqual(r.target?.owners, ['ProductCard', 'ProductList']);
  // The label is still the link's.
  assert.equal(r.target?.label, 'link "Kettle"');
});

test("a render a tap's pointerdown set off joins the tap when Chrome reported no pointerdown entry", () => {
  // A finger held on a card whose onPointerEnter opens it: React renders the card, stamped with the
  // pointerdown, after the finger lifts and before the click's handlers can run. The pointerdown's own
  // entry was under 16 ms, so only the pointerup and the click arrive.
  const ring = [
    input(0, 'pointerdown', { gestureTs: 0, pointerType: 'touch' }),
    input(150, 'pointerup', { gestureTs: 0, pointerType: 'touch' }),
    input(150, 'click', { gestureTs: 0, pointerType: 'touch' }),
  ];
  const card = commit(260, 0, { inputType: 'pointerdown', rendered: 403, roots: ['TapCard'], hotPath: ['TapCard', 'Cells'] });
  const button = commit(300, 150, { gestureTs: 0, rendered: 1, roots: ['TapButton'], hotPath: ['TapButton'] });
  const r = report([entry('pointerup', 150, 260, 280, 282), entry('click', 150, 280, 283, 298)], [card, button], [], ring);
  assert.deepEqual(r.commits.map((c) => [c.at, c.joinedBy]), [[260, 'exact'], [300, 'exact']]);
});

test('a render whose walk stopped at its budget says "at least", names no component it was "mostly" made of, and no root it reached first', () => {
  const ring = [input(0, 'click', { target: element('button', [text('Refresh')]) as unknown as Node, owners: ['Toolbar'], handler: 'onClick' })];
  const blameOf = (opts: Partial<CommitSummary>) =>
    report([entry('click', 0, 400, 3, 390)], [commit(200, 0, { hasDurations: false, total: 0, rendered: 5000, truncated: true, ...opts })], [], ring).explanation;
  const components = [
    { name: 'Order', count: 3000, self: null, total: null },
    { name: 'Metric', count: 1998, self: null, total: null },
  ];
  const one = blameOf({ roots: ['Dashboard'], hotPath: ['Dashboard'], components });
  assert.deepEqual(one.blame, { kind: 'render', name: 'Dashboard', detail: 'at least 5000 components', ms: one.blame.ms, confidence: 'inferred' });
  assert.ok(one.cause.includes('re-rendering at least 5000 components inside Dashboard, in the 387 ms of working time.'), one.cause);
  assert.doesNotMatch(one.cause, /mostly/);
  // Several roots under no shared component: not the first root the walk reached. The name falls back to
  // the app, as the sentence does, rather than to null, which a reader of a render blame does not expect.
  const several = blameOf({ roots: ['Orders', 'Metrics'], hotPath: [], components });
  assert.equal(several.blame.name, 'the app');
  assert.ok(several.cause.includes('inside the app'), several.cause);
  // Nor the one root it reached, when the walk says the work may be beside it (an empty hot path).
  assert.equal(blameOf({ roots: ['Orders'], hotPath: [], components }).blame.name, 'the app');
});

test('a render is counted inside the component it is named after, from the one it started at where that holds them all, and is a mount where most of it was one', () => {
  // Opening a Sheet on the shadcn/ui docs, production build, modelled on a reading of the app's source rather
  // than on a walk of it. Radix's Portal renders null and sets mounted in a layout effect, so the sheet's
  // overlay and its content each mount in a commit of their own from a Portal of their own, the two of them
  // in one commit: 59 components, 57 of them new, about 31 of them inside DismissableLayer, the overlay's
  // portal and the wrappers above it making up the rest. `roots` lists the two Portals once, so the count
  // under the one the path starts from is what says that they were two. 0.12.0 read "re-rendering 59
  // components inside DismissableLayer" beside the layout.
  const open = [entry('click', 0, 69, 2, 60)];
  const sheet = commit(30, 0, {
    hasDurations: false,
    total: 0,
    rendered: 59,
    mounted: 57,
    roots: ['Portal'],
    hotPath: ['Portal', 'Primitive.div', 'DialogContent', 'Presence', 'DialogContentModal', 'DialogContentImpl', 'FocusScope', 'Primitive.div', 'DismissableLayer'],
    startRendered: 42,
    pathRendered: 31,
    components: [{ name: 'Label', count: 4, self: null, total: null }],
  });
  const layout = report(open, [sheet], [frame(0, 69, [script('#document.onclick', 2, 58, 51)])], [input(0, 'click')]).explanation;
  assert.deepEqual(layout.blame, { kind: 'layout', name: 'DismissableLayer', detail: '31 of 59 components', ms: 51, confidence: 'measured' });
  assert.match(layout.cause, / React was (most likely )?mounting 59 components, 31 of them inside DismissableLayer\. /);
  const render = report(open, [sheet], [], [input(0, 'click')]).explanation;
  assert.deepEqual(render.blame, { kind: 'render', name: 'DismissableLayer', detail: '31 of 59 components', ms: null, confidence: 'inferred' });
  assert.match(render.cause, /^React was most likely mounting 59 components, 31 of them inside DismissableLayer, in the 58 ms of working time\. /);
  // Fewer than half mounted is a re-render, and a report an earlier release stored, which counted none of it, reads as it did.
  assert.match(report(open, [commit(30, 0, { ...sheet, mounted: 20 })], [], [input(0, 'click')]).explanation.cause, /^React was most likely re-rendering 59 components, 31 of them inside DismissableLayer/);
  const stored = { ...sheet } as { mounted?: number; startRendered?: number; pathRendered?: number };
  delete stored.mounted;
  delete stored.startRendered;
  delete stored.pathRendered;
  const old = report(open, [stored as CommitSummary], [], [input(0, 'click')]).explanation;
  assert.match(old.cause, /^React was most likely re-rendering 59 components inside DismissableLayer, in the 58 ms of working time\. /);
  assert.equal(old.blame.detail, '59 components');

  // Switching the install tabs on the same docs to npm, by the same reading: the page's two CodeBlockCommands
  // and the CommandMenu share the jotai atom that holds the choice, so each is a root of the one commit, 181
  // components in all, about 79 of them inside the RovingFocusGroup of the block whose tabs were clicked.
  // 0.12.0 spent its twelve steps on Radix's Provider and Slot layers, named the render after
  // RovingFocusGroupCollectionProviderProvider, and put all 181 inside it. The path starts at one block, which
  // does not hold the 181, so where the render started is not said.
  const tabs = commit(60, 0, {
    hasDurations: false,
    total: 0,
    rendered: 181,
    mounted: 0,
    roots: ['CodeBlockCommand', 'CommandMenu'],
    hotPath: ['CodeBlockCommand', 'Tabs', 'TabsProvider', 'Primitive.div', 'TabsList', 'RovingFocusGroup', 'RovingFocusGroupCollectionProvider', 'RovingFocusGroupCollectionProviderProvider', 'RovingFocusGroupCollectionSlot', 'RovingFocusGroupCollectionSlot.Slot', 'RovingFocusGroupCollectionSlot.SlotClone', 'Primitive.div'],
    startRendered: 88,
    pathRendered: 79,
    components: [{ name: 'TabsTrigger', count: 16, self: null, total: null }],
  });
  const switched = report([entry('click', 0, 128, 2, 118)], [tabs], [], [input(0, 'click')]).explanation;
  assert.deepEqual(switched.blame, { kind: 'render', name: 'RovingFocusGroup', detail: '79 of 181 components', ms: null, confidence: 'inferred' });
  assert.match(switched.cause, /^React was most likely re-rendering 181 components, 79 of them inside RovingFocusGroup, in the 116 ms of working time\. /);

  // Switching a cal.com event type to its advanced tab, development build, by the same reading: 1216
  // components from EventTypeWeb, the one root, where the form's state lives, about 800 of them inside the
  // tab's wrapper. 0.12.0 stopped at Form, twelve layers down, and put all 1216 inside it.
  const advanced = commit(200, 0, {
    rendered: 1216,
    mounted: 40,
    total: 180,
    roots: ['EventTypeWeb'],
    hotPath: ['EventTypeWeb', 'EventType', 'EventTypeSingleLayout', 'Shell', 'KBarWrapper', 'KBarRoot', 'KBarProvider', 'Layout', 'MainContainer', 'ErrorBoundary', 'ShellMain', 'Form', 'Ct', 'LoadableComponent', 'EventAdvancedWebWrapper'],
    startRendered: 1216,
    pathRendered: 812,
    components: [
      { name: 'Controller', count: 60, self: 30, total: 2 },
      { name: 'EventTypeWeb', count: 1, self: 12, total: 180 },
    ],
  });
  const tab = report([entry('click', 0, 220, 3, 210)], [advanced], []).explanation;
  assert.equal(tab.cause, 'React spent 180 ms re-rendering 1216 components from EventTypeWeb down, 812 of them inside EventAdvancedWebWrapper.');
  assert.deepEqual(tab.blame, { kind: 'render', name: 'EventAdvancedWebWrapper', detail: '812 of 1216 components', ms: tab.blame.ms, confidence: 'measured' });
  // A render that was mostly one component keeps its clause after the count, saying which count the
  // component's is of, since it was counted over the whole commit and not inside the one named.
  const mostly = report([entry('click', 0, 220, 3, 210)], [commit(200, 0, { ...advanced, components: [{ name: 'Controller', count: 700, self: 100, total: 2 }] })], []).explanation;
  assert.equal(mostly.cause, 'React spent 180 ms re-rendering 1216 components from EventTypeWeb down, 812 of them inside EventAdvancedWebWrapper, mostly Controller (700 of the 1216, 100 ms).');
  assert.equal(mostly.blame.detail, 'Controller ×700');
  // Where the component the render is named after is also most of what rendered, the whole count stays
  // inside it, as before: a count inside one TreeNode beside "700 of them" would be read as the count of them.
  const tree = report([entry('click', 0, 220, 3, 210)], [commit(200, 0, { ...advanced, hotPath: ['App', 'TreeNode'], pathRendered: 600, components: [{ name: 'TreeNode', count: 700, self: 100, total: 2 }] })], []).explanation;
  assert.equal(tree.cause, 'React spent 180 ms re-rendering 1216 components inside TreeNode (700 of them, 100 ms).');

  // A render named after the component it started at holds the whole count, and reads as it did.
  const whole = report([entry('click', 0, 220, 3, 210)], [commit(200, 0, { ...advanced, hotPath: ['EventTypeWeb'], pathRendered: 1216 })], []).explanation;
  assert.equal(whole.cause, 'React spent 180 ms re-rendering 1216 components inside EventTypeWeb.');
  assert.equal(whole.blame.detail, '1216 components');
  // Where the render started at a name nobody could search for, the count inside is still said, and the start is not.
  const minified = report([entry('click', 0, 220, 3, 210)], [commit(200, 0, { ...advanced, hotPath: ['hl', 'EventType', 'Layout'], pathRendered: 690 })], []).explanation;
  assert.equal(minified.cause, 'React spent 180 ms re-rendering 1216 components, 690 of them inside Layout.');
  // Nor where it started at one root among several, which does not hold the count: "from EventTypeWeb down"
  // would put the CommandMenu's components under it.
  const several = report([entry('click', 0, 220, 3, 210)], [commit(200, 0, { ...advanced, roots: ['EventTypeWeb', 'CommandMenu'], startRendered: 1000 })], []).explanation;
  assert.equal(several.cause, 'React spent 180 ms re-rendering 1216 components, 812 of them inside EventAdvancedWebWrapper.');

  // Selecting every row on Twenty, production build, the walk cut at its budget under several roots: the
  // component they share is named and holds every count, so none is said to be inside a part of it.
  const rows = commit(400, 0, {
    hasDurations: false,
    total: 0,
    rendered: 4632,
    mounted: 0,
    truncated: true,
    roots: ['RecordIndexFiltersToContextStoreEffect', 'RecordTableHeaderCheckboxColumn'],
    hotPath: ['RecordIndexContainer'],
    startRendered: 4632,
    pathRendered: 4632,
    components: [{ name: 'RecordTableCell', count: 2000, self: null, total: null }],
  });
  const all = report([entry('click', 0, 900, 3, 880)], [rows], [], [input(0, 'click')]).explanation;
  assert.match(all.cause, /^React was most likely re-rendering at least 4632 components inside RecordIndexContainer, in the 877 ms of working time\. /);
  assert.equal(all.blame.detail, 'at least 4632 components');
  // A walk cut short whose path went below where it started: every count is a lower bound, the one inside
  // too, and the sentence says so of both rather than putting the whole count inside the deeper component.
  const partial = report([entry('click', 0, 900, 3, 880)], [commit(400, 0, { ...rows, hotPath: ['RecordIndexContainer', 'RecordIndexTableContainer'], pathRendered: 3000 })], [], [input(0, 'click')]).explanation;
  assert.match(partial.cause, /^React was most likely re-rendering at least 4632 components from RecordIndexContainer down, at least 3000 of them inside RecordIndexTableContainer, in the 877 ms of working time\. /);
  assert.equal(partial.blame.detail, 'at least 3000 of at least 4632 components');
  // A development build follows React's durations past the cut, so the path can end in a subtree the walk
  // counted in full beside one it did not: 800 inside Heavy is exact, and still a lower bound of the 5000.
  const heavy = commit(200, 0, {
    rendered: 5000,
    mounted: 0,
    truncated: true,
    total: 180,
    roots: ['App'],
    hotPath: ['App', 'Heavy'],
    startRendered: 5000,
    pathRendered: 800,
    components: [
      { name: 'Cell', count: 4000, self: 8, total: 1 },
      { name: 'Heavy', count: 1, self: 80, total: 170 },
    ],
  });
  const cut = report([entry('click', 0, 220, 3, 210)], [heavy], []).explanation;
  assert.match(cut.cause, /re-rendering at least 5000 components from App down, at least 800 of them inside Heavy\./);
  assert.deepEqual([cut.blame.name, cut.blame.detail], ['Heavy', 'at least 800 of at least 5000 components']);
});

test('a render known only by its counts is not blamed under a long task of working time, and where no frame covered the click the styles and layout it forced are said to be unmeasured', () => {
  // Finishing a rectangle in excalidraw, production build: 2.6 ms of waiting, 2.8 of working time and 34.4
  // updating the screen. Releasing the pointer re-rendered the chrome, 149 components inside
  // FixedSideContainer, and no long animation frame covered the click. 0.12.0 read "re-rendering 149
  // components inside FixedSideContainer, mostly PanelComponent (22 of them)": the screen update is only
  // weighed from 50 ms, and beside the handler a count of 149 explained 2.8 ms many times over.
  const chrome = (rendered: number, panels: number) =>
    commit(4, 0, { hasDurations: false, total: 0, rendered, roots: ['InitializeApp'], hotPath: ['InitializeApp', 'LayerUI', 'FixedSideContainer'], components: [{ name: 'PanelComponent', count: panels, self: null, total: null }] });
  const release = (handler: string) => [input(0, 'click', { target: element('canvas', []) as unknown as Node, owners: ['InteractiveCanvas'], handler })];
  const rect = report([entry('click', 0, 40, 2.6, 5.4)], [chrome(149, 22)], [], release('onClick')).explanation;
  assert.deepEqual(rect.blame, { kind: 'none', name: null, detail: null, ms: null, confidence: 'measured' });
  assert.equal(
    rect.cause,
    'In 3 ms of working time, short of a long task, React was re-rendering 149 components inside FixedSideContainer; the rest went to waiting and painting. No long animation frame covered the click, so how much of the working time went to any styles and layout it forced is unmeasured.',
  );
  assert.ok(!rect.notes.some((n) => n.includes('still re-rendering')), rect.notes.join(' | '));
  // The same step at 4x CPU slowdown: 1.4 waiting, 16.2 working, 22.1 updating the screen. Still under.
  const slower = report([entry('click', 0, 40, 1.4, 17.6)], [chrome(149, 22)], [], release('onPointerUp')).explanation;
  assert.equal(slower.blame.kind, 'none');
  assert.match(slower.cause, /^In 16 ms of working time, short of a long task, React was re-rendering 149 components inside FixedSideContainer; /);

  // Closing a Sheet on the shadcn/ui docs, production build: 0.8 ms of waiting, 16.6 of working time and
  // 30.5 updating the screen, 56 components re-rendered, the hot path ending on the content's Presence, no
  // frame. A read of the source puts about two dozen of the 56 under that Presence; this fixture, like a
  // report 0.12.0 stored, carries no count inside it, so the sentence puts the whole 56 there. Most of the
  // working time is one style recalculation Radix's Presence forces on close; the same close at 4x CPU
  // slowdown, once a frame reported it, measured 66 of its 79 ms as forced layout. 0.12.0 blamed the render
  // here too.
  const presence = commit(10, 0, { hasDurations: false, total: 0, rendered: 56, roots: ['Portal'], hotPath: ['Portal', 'Presence'], components: [{ name: 'Presence', count: 4, self: null, total: null }] });
  const close = report([entry('click', 0, 48, 0.8, 17.4)], [presence], [], [input(0, 'click')]).explanation;
  assert.equal(close.blame.kind, 'none');
  assert.equal(
    close.cause,
    'In 17 ms of working time, short of a long task, React was re-rendering 56 components inside Presence; the rest went to waiting and painting. No long animation frame covered the click, so how much of the working time went to any styles and layout it forced is unmeasured.',
  );
  assert.doesNotMatch(close.cause, /most likely/);
  // The same Sheet on a phone, opening: 17.9 ms of waiting, 31.4 of working time and 6 updating the screen,
  // no frame, the sheet's 59 components mounted, 31 of them inside DismissableLayer. Four whole-document
  // style recalculations sit in the working time and nothing measured them.
  const sheet = commit(30, 0, {
    hasDurations: false,
    total: 0,
    rendered: 59,
    mounted: 57,
    roots: ['Portal'],
    hotPath: ['Portal', 'Primitive.div', 'DialogContent', 'Presence', 'DialogContentModal', 'DialogContentImpl', 'FocusScope', 'Primitive.div', 'DismissableLayer'],
    startRendered: 42,
    pathRendered: 31,
    components: [{ name: 'Label', count: 4, self: null, total: null }],
  });
  const phoneOpen = report([entry('click', 0, 56, 17.9, 49.3)], [sheet], [], [input(0, 'click')]).explanation;
  assert.equal(phoneOpen.blame.kind, 'none');
  // The time leads the sentence, so "31 of them inside DismissableLayer" is not read as what took the 31 ms.
  assert.equal(
    phoneOpen.cause,
    'In 31 ms of working time, short of a long task, React was mounting 59 components, 31 of them inside DismissableLayer; the rest went to waiting and painting. No long animation frame covered the click, so how much of the working time went to any styles and layout it forced is unmeasured.',
  );
  // And closing it on the phone: 17.3 waiting, 7.2 working, 15.4 on the screen; at 4x, 25.4, 37.1 and 16.1.
  assert.equal(report([entry('click', 0, 40, 17.3, 24.5)], [presence], [], [input(0, 'click')]).explanation.blame.kind, 'none');
  const phoneClose = report([entry('click', 0, 80, 25.4, 62.5)], [presence], [], [input(0, 'click')]).explanation;
  assert.equal(phoneClose.blame.kind, 'none');
  assert.match(phoneClose.cause, /^In 37 ms of working time, short of a long task, /);

  // A long task of working time is the bar, at the same 50 ms the handler is held to without durations, and
  // it is taken on the figure the sentence prints: 49.6 ms reads as 50 ms, and is over it.
  const at = (processingEnd: number, frames: FrameSummary[] | null = []) => report([entry('click', 0, 80, 3, processingEnd)], [presence], frames, [input(0, 'click')]).explanation;
  const over = at(53);
  assert.deepEqual(over.blame, { kind: 'render', name: 'Presence', detail: '56 components', ms: null, confidence: 'inferred' });
  assert.equal(
    over.cause,
    'React was most likely re-rendering 56 components inside Presence, in the 50 ms of working time. This React build records no render durations, so that is read from the component counts, not measured. A profiling build of React would give exact numbers.',
  );
  assert.equal(at(52.6).blame.kind, 'render');
  const under = at(52.4);
  assert.equal(under.blame.kind, 'none');
  assert.match(under.cause, /^In 49 ms of working time, short of a long task, React was re-rendering 56 components inside Presence; the rest went to waiting and painting\. No long animation frame covered the click, so how much/);
  // Under it, a browser without Long Animation Frames cannot say whether a frame covered the click, and a
  // frame that did cover it, with no script in it long enough to name, says the same of the working time
  // without the clause: a long frame was recorded, and nothing measured in it is the render's. Neither calls
  // a count the library's own bars call large small.
  assert.equal(at(52.4, null).cause, 'In 49 ms of working time, short of a long task, React was re-rendering 56 components inside Presence; this browser does not report long tasks, so what else ran is unknown.');
  const covered = at(52.4, [frame(0, 80, [script('#document.onclick', 3, 10, 0)])]);
  assert.equal(covered.blame.kind, 'none');
  assert.equal(covered.cause, 'In 49 ms of working time, short of a long task, React was re-rendering 56 components inside Presence; the rest went to waiting and painting.');
  // A script the frame lists after the handlers is still named: React's render did not run in it.
  const later = at(52.4, [frame(0, 80, [script('setTimeout', 58, 22, 0)])]);
  assert.deepEqual([later.blame.kind, later.blame.name, later.blame.detail, later.blame.confidence], ['script', 'setTimeout', null, 'measured']);
  assert.equal(later.cause, 'In 49 ms of working time, short of a long task, React was re-rendering 56 components inside Presence; a script (setTimeout, app.js) ran for 22 ms.');
  // A frame that covered the click and listed the handler's script: 300 components re-rendered inside List in
  // 45 ms of working time, with 45 ms charged to the root's click listener. That script holds React's render
  // as well as the handler, so it is not measured in the render's place; the report blames nothing, as it
  // does with no frame, rather than putting a measured 45 ms on onClick under the bar and an inferred
  // render on List over it.
  const list = commit(20, 0, { hasDurations: false, total: 0, rendered: 300, roots: ['List'], hotPath: ['List'], components: [{ name: 'Row', count: 100, self: null, total: null }] });
  const handled = report([entry('click', 0, 70, 2, 47)], [list], [frame(0, 70, [script('DIV#root.onclick', 2, 45, 0)])], [input(0, 'click', { handler: 'onClick' })]).explanation;
  assert.deepEqual(handled.blame, { kind: 'none', name: null, detail: null, ms: null, confidence: 'measured' });
  assert.equal(handled.cause, 'In 45 ms of working time, short of a long task, React was re-rendering 300 components inside List; the rest went to waiting and painting.');
  // The sentence is for a count that would have named the render but for the bar. A production commit under
  // the library's own count bars, or a build with durations whose render was under its time bar, reads as it did.
  const few = (rendered: number) => report([entry('click', 0, 48, 2, 7)], [commit(4, 0, { hasDurations: false, total: 0, rendered, roots: ['Badge'], hotPath: ['Badge'], components: [] })], [], [input(0, 'click')]).explanation;
  assert.equal(few(2).cause, "React's render was small (re-rendering 2 components inside Badge) and no long task was recorded, so the rest went to waiting and painting.");
  assert.equal(few(0).cause, "React's render was small (committing without rendering a component) and no long task was recorded, so the rest went to waiting and painting.");
  const timedSmall = report([entry('click', 0, 48, 0.8, 17.4)], [commit(10, 0, { total: 1, rendered: 56, roots: ['Portal'], hotPath: ['Portal', 'Presence'], components: [] })], [], [input(0, 'click')]).explanation;
  assert.equal(timedSmall.blame.kind, 'none');
  assert.equal(timedSmall.cause, "React's render was small (re-rendering 56 components inside Presence) and no long task was recorded, so the rest went to waiting and painting.");
  // A build with durations is not held to the bar: it timed the render, so 12 ms of it in 17 is known.
  const timed = commit(10, 0, { total: 12, rendered: 56, roots: ['Portal'], hotPath: ['Portal', 'Presence'], components: [{ name: 'Presence', count: 4, self: 6, total: 12 }] });
  const dev = report([entry('click', 0, 48, 0.8, 17.4)], [timed], [], [input(0, 'click')]).explanation;
  assert.equal(dev.blame.kind, 'render');
  assert.equal(dev.blame.confidence, 'measured');

  // Releasing Control after select-all in excalidraw, production build: 0.6 ms of waiting, 55.4 of working
  // time and 15.5 updating the screen, the whole chrome re-rendered (161 components inside FixedSideContainer,
  // 29 of them PanelComponent) and the browser charged the frame's 55 ms to the document's keyup listener.
  // Over a long task the count names the render as before, and the sentence gives the working time the
  // count is read against, since the same render took 7 ms on the key's press later in the session.
  const control = { ...chrome(161, 29), inputType: 'keyup' };
  const held = [input(0, 'keyup', { target: element('div', []) as unknown as Node, owners: ['InitializeApp'] })];
  const selectAll = report([entry('keyup', 0, 72, 0.6, 56)], [control], [frame(0, 72, [script('#document.onkeyup', 0.6, 55, 0)])], held).explanation;
  assert.deepEqual([selectAll.blame.kind, selectAll.blame.name, selectAll.blame.confidence], ['render', 'FixedSideContainer', 'inferred']);
  assert.match(selectAll.cause, /^React was most likely re-rendering 161 components inside FixedSideContainer, in the 55 ms of working time\. This React build records no render durations, so that is read from the component counts, not measured\./);
});

test("the panel's row takes its verb from the commit the blame names, which is not always the heaviest", () => {
  const click = [entry('click', 0, 120, 3, 100)];
  // A dialog opening: its content mounts in the heaviest commit, and a second commit's layout effects ran for
  // 60 ms, which names that one. The row says "re-rendered" of it, as the cause does, not "mounted" of the other.
  const mount = commit(25, 0, { total: 20, rendered: 59, mounted: 57, roots: ['Portal'], hotPath: ['Portal', 'DismissableLayer'], startRendered: 59, pathRendered: 31, components: [{ name: 'Label', count: 4, self: 2, total: 2 }] });
  const effects = commit(95, 0, { startedAt: 30, total: 5, rendered: 12, mounted: 0, roots: ['Panel'], hotPath: ['Panel'], startRendered: 12, pathRendered: 12, components: [{ name: 'Row', count: 5, self: 1, total: 1 }] });
  const r = report(click, [mount, effects], []);
  assert.deepEqual([r.explanation.blame.kind, r.explanation.blame.name], ['render', 'Panel']);
  assert.match(r.explanation.cause, /^React spent 5 ms re-rendering 12 components inside Panel\. Committing it took about 60 ms more/);
  assert.equal(heaviest(r.commits).at, mount.at);
  assert.equal(renderedVerb(mount), 'mounted');
  assert.equal(blamedCommit(r)?.at, effects.at);
  assert.equal(renderedVerb(blamedCommit(r)!), 're-rendered');
  // With one commit, or a blame the commits cannot be matched to, the heaviest stands for it.
  assert.equal(blamedCommit(report(click, [mount], []))?.at, mount.at);
  assert.equal(blamedCommit({ ...r, explanation: { ...r.explanation, blame: { ...r.explanation.blame, name: 'Elsewhere' } } })?.at, mount.at);
  assert.equal(blamedCommit(report(click, [], [])), null);
});

test('names that look minified get a note, and readable or styled names mixed with a few short ones do not', () => {
  const noteOf = (names: string[]) =>
    report([entry('click', 0, 120, 3, 100)], [commit(50, 0, { hasDurations: false, total: 0, rendered: 40, roots: [names[0]!], hotPath: [names[0]!], components: names.map((name) => ({ name, count: 8, self: null, total: null })) })], [], [])
      .explanation.notes.some((n) => n.startsWith('Most component names here are one or two characters'));
  assert.equal(noteOf(['e', 'Xe', 'Tt', 'nc', '$']), true);
  assert.equal(noteOf(['e', 'Xe', 'Tt', 'nc', 'OrderList']), true);
  assert.equal(noteOf(['OrderList', 'Row', 'Td', 'Li', 'Cell']), false);
  assert.equal(noteOf(['styled.div', 'Styled(li)', 'Row', 'List', 'Item']), false);
  // Too few names to say anything about the build.
  assert.equal(noteOf(['e', 'Xe', 'Tt']), false);
  assert.equal(noteOf(['e', 'Xe', 'Tt', 'nc']), false);
  assert.equal(noteOf(['e', 'Xe', 'Tt', 'nc', '(anonymous)']), false);
  // Four in five is the line, and three characters is not short.
  assert.equal(noteOf(['e', 'Xe', 'Tt', 'Abc', 'Row']), false);
  assert.equal(noteOf(['e', 'Xe', 'Tt', 'abc', 'def']), false);
  // A build that stamps the app's own names, where the render ran through a dependency the minifier renamed:
  // the app's Vendor is where it started, so the note, which prescribes what the build already has, is not said.
  const vendor = commit(50, 0, { hasDurations: false, total: 0, rendered: 40, roots: ['Vendor'], hotPath: ['Vendor'], components: ['le', 'ue', 'de', 'fe', 'ge', 'he', 'me', 'pe'].map((name) => ({ name, count: 4, self: null, total: null })) });
  assert.equal(report([entry('click', 0, 120, 3, 100)], [vendor], [], []).explanation.notes.some((n) => n.startsWith('Most component names')), false);
});

test("a minifier's name the report gives, in a build whose names are otherwise readable, gets a note of its own", () => {
  const oddNote = (name: string) =>
    `The name ${name} looks like one a minifier left, most likely on a dependency's component, which this library's build steps do not name. Selecting it in React DevTools shows its props and what rendered it, which usually says whose it is.`;
  const odd = (x: { notes: readonly string[] }) => x.notes.some((n) => n.startsWith('The name '));
  const named = (names: string[], count = 12) => names.map((name) => ({ name, count, self: null, total: null }));
  // The app's own components, stamped, beside two a dependency left short.
  const app = named(['Post', 'PostHeader', 'PostBody', 'Avatar', 'LikeButton', 'Wr', 'Qe']);
  const walk = (opts: Partial<CommitSummary>) => commit(50, 0, { hasDurations: false, total: 0, rendered: 60, roots: ['Feed'], hotPath: ['Feed'], components: app, ...opts });
  const click = [entry('click', 0, 120, 3, 100)];

  // Twenty, where React Router's RouterProvider is minified in a build that names the app's own components:
  // five readable names of the seven beside it.
  const records = named(['RecordTable', 'RecordTableRow', 'RecordTableCell', 'RecordTableCellDisplayMode', 'RecordShowPage', 'Wr', 'Qe', '(anonymous)']);
  const twenty = report(click, [walk({ rendered: 4917, truncated: true, roots: ['hl'], hotPath: ['hl'], components: records })], []).explanation;
  assert.match(twenty.cause, /^React was most likely re-rendering at least 4917 components inside hl, in the 97 ms of working time\. /);
  assert.equal(twenty.blame.name, 'hl');
  assert.ok(twenty.notes.includes(oddNote('hl')), twenty.notes.join('\n'));
  assert.ok(!twenty.notes.some((n) => n.startsWith('Most component names')));

  // Named after "inside" where the blame is the handler's, and with the `$1` a clash adds.
  const handler = report([entry('click', 0, 300, 3, 280)], [walk({ hotPath: ['Dt$1'] })], [], loginClick('onClick')).explanation;
  assert.equal(handler.blame.kind, 'handler');
  assert.ok(handler.cause.includes(' inside Dt$1, none of them'), handler.cause);
  assert.ok(handler.notes.includes(oddNote('Dt$1')), handler.notes.join('\n'));

  // And where only a note names it: a render after the paint.
  const data = buildReport(click, [walk({})], []);
  const later = sealReport(attachLaterRender(data, walk({ at: 400, sinceInput: 400, hasDurations: true, total: 40, hotPath: ['hl'] }), [])!).explanation;
  assert.ok(later.notes.some((n) => n.includes('re-rendering 60 components inside hl')), later.notes.join('\n'));
  assert.ok(later.notes.includes(oddNote('hl')), later.notes.join('\n'));

  // Not where the name the report gives is readable, whatever else in the walk is short.
  const readable = report(click, [walk({ rendered: 400, hotPath: ['Feed', 'Xe'], components: [...named(['Post'], 400), ...app] })], []).explanation;
  assert.ok(readable.cause.includes('inside Feed'), readable.cause);
  assert.ok(!odd(readable), readable.notes.join('\n'));

  // Nor where the short name is a commit's the report never names, and "inside Ta" is not "inside TableBody".
  const table = walk({ rendered: 400, roots: ['Table'], hotPath: ['Table', 'TableBody'], components: [...named(['TableBodyRow'], 400), ...app] });
  const beside = report(click, [table, walk({ at: 60, sinceInput: 60, rendered: 3, roots: ['Ta'], hotPath: ['Ta'], components: named(['Ta'], 3) })], []).explanation;
  assert.ok(beside.cause.includes('inside TableBody'), beside.cause);
  assert.ok(!odd(beside), beside.notes.join('\n'));

  // Nor where the rest are too few to say the build keeps names, or are not readable: an app that stamps
  // nothing would be told its own component is a dependency's.
  const unstamped = (roots: string[], names: string[]) => report(click, [walk({ rendered: 40, roots, hotPath: roots, components: named(names, 8) })], []).explanation;
  for (const few of [['e', 'Xe', 'Tt'], ['e', 'Xe', 'Tt', 'nc']]) {
    const r = unstamped([few[0]!], few);
    assert.match(r.cause, / inside e\b/);
    assert.ok(!odd(r) && !r.notes.some((n) => n.startsWith('Most component names')), r.notes.join('\n'));
  }
  for (const styled of [
    ['Xe', 'Nu', 'Tt', 'Styled(div)', 'Styled(button)'],
    ['Xe', 'Nu', 'Tt', 'Styled(div)', 'Styled(button)', 'Styled(span)', 'Styled(li)'],
  ]) {
    const r = unstamped(['Xe'], styled);
    assert.match(r.cause, / inside Xe\b/);
    assert.ok(!odd(r), r.notes.join('\n'));
  }

  // Nor where most names are a minifier's: the note for the whole build says it.
  const minified = unstamped(['e'], ['e', 'Xe', 'Tt', 'nc', '$']);
  assert.ok(minified.notes.some((n) => n.startsWith('Most component names')));
  assert.ok(!odd(minified), minified.notes.join('\n'));
});

test('a render that committed inside the script the screen update waited on is said to be what that script did', () => {
  // TanStack Table's virtualized rows at 4x: a checkbox click whose handlers rendered the rows, then a frame that
  // waited on react-virtual's scroll listener, which rendered them again through flushSync.
  const rows = { rendered: 721, hotPath: ['App', 'TableBody'], components: [{ name: 'TableBodyRow', count: 36, self: 60, total: 60 }] };
  const handled = commit(165, 0, { ...rows, total: 160 });
  const forced = commit(340, 0, { ...rows, total: 150 });
  const frames = [frame(0, 368, [script('INPUT.onclick', 2, 169), script('DIV.onscroll', 175, 174)])];
  const r = report([entry('click', 0, 368, 2, 171)], [handled, forced], frames, [input(0, 'click')]);
  assert.deepEqual(r.explanation.blame, { kind: 'painting', name: 'DIV.onscroll', detail: null, ms: 197, confidence: 'measured' });
  assert.equal(
    r.explanation.cause,
    'After the click was handled, the screen took another 197 ms to update, mostly because a script (DIV.onscroll, app.js) ran for 174 ms before the next frame, and React rendered inside it: 150 ms re-rendering 721 components inside TableBody.',
  );
  // The handlers' own render is still said, and the second render is not put down to an effect: the script set it off.
  assert.deepEqual(r.explanation.notes, ['React still spent 160 ms re-rendering 721 components inside TableBody in the 169 ms of working time before that.']);

  // Where the forced render is the heavier, the handlers' own is still the one said to be in the working time.
  const heavier = report([entry('click', 0, 368, 2, 171)], [handled, { ...forced, total: 170 }], frames, [input(0, 'click')]);
  assert.match(heavier.explanation.cause, /React rendered inside it: 170 ms /);
  assert.deepEqual(heavier.explanation.notes, ['React still spent 160 ms re-rendering 721 components inside TableBody in the 169 ms of working time before that.']);

  // A render that began before the script, or took longer than it ran, was not all inside it.
  for (const outside of [{ ...forced, startedAt: 120 }, { ...forced, total: 190 }]) {
    const x = report([entry('click', 0, 368, 2, 171)], [handled, outside], frames, [input(0, 'click')]);
    assert.match(x.explanation.cause, /before the next frame\.$/);
  }

  // React's own task, for an update an effect scheduled, is tied to the render it ran, and the render still counts
  // as a second one: that is what the effect note is for.
  const scheduled = report(
    [entry('click', 0, 368, 2, 171)],
    [handled, { ...forced, priority: 3 }],
    [frame(0, 368, [script('INPUT.onclick', 2, 169), script('MessagePort.onmessage', 175, 174)])],
    [input(0, 'click')],
  );
  assert.match(scheduled.explanation.cause, /MessagePort\.onmessage.*React rendered inside it: 150 ms /);
  assert.ok(scheduled.explanation.notes.some((n) => n.startsWith('React rendered 2 times')), scheduled.explanation.notes.join(' | '));

  // React 17 gives every commit priority 99, so there the task a render ran in is what says an effect set it off.
  const legacy = (invoker: string) =>
    report(
      [entry('click', 0, 368, 2, 171)],
      [{ ...handled, priority: 99 }, { ...forced, priority: 99 }],
      [frame(0, 368, [script('INPUT.onclick', 2, 169), script(invoker, 175, 174)])],
      [input(0, 'click')],
    ).explanation.notes;
  assert.ok(legacy('MessagePort.onmessage').some((n) => n.startsWith('React rendered 2 times')));
  assert.ok(!legacy('DIV.onscroll').some((n) => n.startsWith('React rendered')));

  // Two renders inside the script: the clause says how many, and neither is put down to an effect.
  const twice = report([entry('click', 0, 368, 2, 171)], [handled, forced, commit(345, 0, { rendered: 40, total: 20, hotPath: ['App'] })], frames, [
    input(0, 'click'),
  ]);
  assert.match(twice.explanation.cause, /React rendered inside it 2 times, the heaviest 150 ms re-rendering 721 components inside TableBody\.$/);
  assert.deepEqual(twice.explanation.notes, ['React still spent 160 ms re-rendering 721 components inside TableBody in the 169 ms of working time before that.']);

  // A hydration keeps its own sentence, and is not tied to the script.
  const hydrated = report(
    [entry('click', 0, 368, 2, 171)],
    [handled, { ...forced, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' } }],
    frames,
    [input(0, 'click')],
  );
  assert.doesNotMatch(hydrated.explanation.cause, /React rendered inside it/);

  // Where every render was the script's, the working time is still said to have been the handlers'.
  const onlyForced = report([entry('click', 0, 368, 2, 171)], [forced], frames, [input(0, 'click')]);
  assert.match(onlyForced.explanation.cause, /React rendered inside it: 150 ms /);
  assert.deepEqual(onlyForced.explanation.notes, ['Code outside React (the click handler or other scripts) still ran for about 169 ms of the 169 ms of working time before that.']);

  // A production build: no render times and no priority, and the script's render still left out of the count.
  const prod = (x: CommitSummary) => ({ ...x, hasDurations: false, total: 0, priority: undefined, components: [{ name: 'TableBodyRow', count: 36, self: 0, total: 0 }] });
  const production = report([entry('click', 0, 368, 2, 171)], [prod(handled), prod(forced)], frames, [input(0, 'click')]);
  assert.deepEqual(
    [production.explanation.cause, ...production.explanation.notes],
    [
      'After the click was handled, the screen took another 197 ms to update, mostly because a script (DIV.onscroll, app.js) ran for 174 ms before the next frame, and React rendered inside it: re-rendering 721 components inside TableBody.',
      'React was most likely still re-rendering 721 components inside TableBody, in the 169 ms of working time before that.',
    ],
  );

  // Where the handler outran React in the working time, that is still said beside the forced render.
  const handler = report([entry('click', 0, 368, 2, 171)], [{ ...handled, total: 10, rendered: 12 }, forced], frames, [input(0, 'click')]);
  assert.match(handler.explanation.cause, /React rendered inside it: 150 ms /);
  assert.deepEqual(handler.explanation.notes, ['Code outside React (the click handler or other scripts) still ran for about 159 ms of the 169 ms of working time before that.']);

  // A render that committed after the script ended is not tied to it, and a script with none inside keeps the clause as it was.
  const after = report([entry('click', 0, 368, 2, 171)], [handled, commit(360, 0, { ...rows, total: 5 })], frames, [input(0, 'click')]);
  assert.match(after.explanation.cause, /before the next frame\.$/);
});
