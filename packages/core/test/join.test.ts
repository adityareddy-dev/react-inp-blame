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
  return { ts, type, gestureTs: ts, press: undefined, target: null, owners: [], handler: null, key: null, dehydrated: null, work: { endedAt: ts, unjoined: [] }, ...extra };
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
    matches: (selector: string) => matches(el, selector),
    closest: (selector: string) => {
      for (let at: Record<string, unknown> | null = el; at; at = at.parentElement as Record<string, unknown> | null) if (matches(at, selector)) return at;
      return null;
    },
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

/**
 * `Element.matches` for the attribute selectors a label asks about: `[name]`, `[name="value"]`, the same with the
 * `i` flag that compares the value in any case, `:not()` of those, and a list of them.
 */
function matches(el: Record<string, unknown>, selector: string): boolean {
  if (selector.includes(',')) return selector.split(',').some((one) => matches(el, one.trim()));
  const not = /^(.+):not\((.+)\)$/.exec(selector);
  if (not) return matches(el, not[1]!) && !matches(el, not[2]!);
  const attribute = /^\[([\w-]+)(?:="([^"]*)"( i)?)?\]$/.exec(selector);
  if (!attribute) throw new Error(`the stand-in DOM cannot match ${selector}`);
  const value = (el.getAttribute as (name: string) => string | null)(attribute[1]!);
  if (attribute[2] === undefined) return value !== null;
  return attribute[3] ? value?.toLowerCase() === attribute[2].toLowerCase() : value === attribute[2];
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
const frame = (start: number, duration: number, scripts: ScriptSummary[], styleAndLayoutStart: number | null = null): FrameSummary => ({
  start,
  duration,
  blocking: Math.max(0, duration - 50),
  forcedLayout: scripts.reduce((a, s) => a + s.forcedLayout, 0),
  scripts,
  styleAndLayoutStart,
});

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
  // A deleted row, with an older click still in the ring: the handler is the one read for the click at the entry's time.
  const menu = input(0, 'click', { target: element('button', [text('Menu')]) as unknown as Node, owners: ['MenuButton'], handler: 'openMenu' });
  const row = element('button', [text('Delete')]);
  const both = [menu, input(5000, 'click', { target: row as unknown as Node, owners: ['DeleteButton', 'Row'], handler: 'deleteRow' })];
  const deleted = report([entry('click', 5000, 120, 5003, 5100)], [], [], both, 'text');
  assert.deepEqual(deleted.target, { selector: 'button', label: 'button "Delete"', component: 'DeleteButton', owners: ['DeleteButton', 'Row'], handler: 'deleteRow' });
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

test("the handler is the one the ring read at dispatch, where the click's own render gave the element another before the entry came", () => {
  // `onClick={editing ? save : startEdit}`: the click on Save ran save, and its render put startEdit on the
  // button before the entry arrived. Read then, the button named the handler of the next click.
  function startEdit() {}
  function addToCart() {}
  const button = (onClick: () => void) => {
    const fiber: Record<string, unknown> = { tag: 5, flags: 0, mode: 0, elementType: 'button', type: 'button', memoizedProps: { onClick }, memoizedState: null, return: null, child: null, sibling: null, alternate: null };
    fiber.stateNode = Object.assign(element('button', []), { __reactFiber$k1: fiber, __reactProps$k1: { onClick } });
    return fiber.stateNode as Node;
  };
  const clickOn = (target: Node, extra: Partial<InputRecord>) => report([entry('click', 0, 120, 3, 100, { target })], [], [], [input(0, 'click', { target, ...extra })]).target?.handler;
  const edited = button(startEdit);
  assert.equal(clickOn(edited, { handler: 'save' }), 'save');
  // Where React had no handler on it at dispatch, as before a page's hydrateRoot, none ran, whatever it has now.
  assert.equal(clickOn(edited, { handler: null }), null);
  // Server HTML at dispatch had nothing to read yet. React hydrated it inside the click's dispatch, to run it, and the
  // record was read again then; one React did not hydrate there is read now.
  const dehydrated = { scope: 'boundary', owner: 'ProductPage' } as const;
  assert.equal(clickOn(edited, { handler: 'save', dehydrated, hydratedRead: true }), 'save');
  assert.equal(clickOn(button(addToCart), { handler: null, dehydrated }), 'addToCart');
  // So is an event the ring has no record of.
  assert.equal(report([entry('click', 0, 120, 3, 100, { target: edited })], [], []).target?.handler, 'startEdit');
  // Two fingers on two buttons in one frame: each report takes the record of its own button, not the first at its time.
  const other = button(addToCart);
  const both = [input(0, 'click', { target: edited, handler: 'save' }), input(0.5, 'click', { target: other, handler: 'addToCart' })];
  const named = (target: Node) => report([entry('click', 0, 120, 3, 100, { target })], [], [], both).target?.handler;
  assert.deepEqual([named(edited), named(other)], ['save', 'addToCart']);
  // With only the other button's record, the element is read now.
  assert.equal(report([entry('click', 0, 120, 3, 100, { target: edited })], [], [], both.slice(1)).target?.handler, 'startEdit');
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

test('an editor is named like a form field whatever labels allows, never by the text a person typed into it', () => {
  for (const labels of ['text', 'attributes'] as const) {
    const label = (target: Record<string, unknown>) => labelOf(target, labels);
    // Rich-text editors are elements the page made editable, and a key press lands on the one holding the caret.
    const editable = (tag: string, children: Record<string, unknown>[], attributes: Record<string, string> = {}) => Object.assign(element(tag, children, attributes), { isContentEditable: true });
    assert.equal(label(editable('div', [text('Hi Ada, the password is hunter2')], { contenteditable: 'true' })), 'div', labels);
    const paragraph = editable('p', [text('My SSN is 078-05-1120, card 4111 1111')]);
    editable('div', [paragraph], { contenteditable: 'true', role: 'textbox' });
    assert.equal(label(paragraph), 'p', labels);
    // Where isContentEditable is not there to ask, the attribute on an element above says the same.
    const plain = element('p', [text('Dear Dr. Smith, my diagnosis is')]);
    element('div', [element('div', [plain])], { contenteditable: '' });
    assert.equal(label(plain), 'p', labels);
    // A document in designMode is editable throughout, with no attribute anywhere to say so.
    assert.equal(label(editable('p', [text('Notes on Ada Lovelace')])), 'p', labels);
    // A mention chip is marked not editable inside the editor, and its text is still what was typed.
    const chip = element('span', [text('@Ada Lovelace')], { contenteditable: 'false' });
    editable('div', [text('Thanks '), chip], { contenteditable: 'true' });
    assert.equal(label(chip), 'span', labels);
    // A button an editor draws beside what was typed, a code block's Copy, is named by what the page's code wrote
    // on it, and its type names nothing.
    const copy = element('button', [text('Copy')], { type: 'button' });
    editable('div', [element('pre', [text('const token = "s3cr3t"')]), element('div', [copy], { contenteditable: 'false' })], { contenteditable: 'true' });
    assert.equal(label(copy), 'button', labels);
    // An editor built on an EditContext has nothing in its markup to say so: the page's code attaches one to the
    // element that takes the key presses, and it draws what was typed inside that element, a word in a line.
    assert.equal(label(Object.assign(element('div', [text('Dear Dr. Smith, my diagnosis is')], { tabindex: '0' }), { editContext: {} })), 'div', labels);
    const word = element('span', [text('typed via EditContext')]);
    Object.assign(element('div', [element('div', [word])]), { editContext: {} });
    assert.equal(label(word), 'span', labels);
    // As far down as the fifth element below it.
    const deep = element('span', [text('my diagnosis is')]);
    Object.assign(element('div', [element('div', [element('div', [element('div', [element('p', [deep])])])])]), { editContext: {} });
    assert.equal(label(deep), 'span', labels);
    // An element with a text field's role is a field, named by what the page's code wrote on it.
    assert.equal(label(element('div', [text('typed search query')], { role: 'textbox' })), 'div', labels);
    assert.equal(label(element('div', [text('typed search query')], { role: 'searchbox', 'data-testid': 'search' })), 'div "search"', labels);
    assert.equal(label(element('div', [text('Nice work, Ada')], { role: 'textbox', 'aria-placeholder': 'Write a comment' })), 'div "Write a comment"', labels);
    assert.equal(label(element('span', [text('1987')], { role: 'spinbutton' })), 'span', labels);
    // So is anything inside one: the span holding the words typed into a textbox, or the value an ARIA 1.1 combobox shows.
    const typed = element('span', [text('typed secret words')]);
    element('div', [typed], { role: 'textbox', tabindex: '0' });
    assert.equal(label(typed), 'span', labels);
    const picked = element('span', [text('Ada Lovelace')]);
    element('div', [picked], { role: 'combobox' });
    assert.equal(label(picked), 'span', labels);
    // A select trigger that shows its value is named the way a <select> is. Radix's is a button of type button.
    assert.equal(label(element('button', [text('ada@example.com')], { type: 'button', role: 'combobox' })), 'button', labels);
    // A textarea is named by its placeholder as ever, never by the text React keeps the same as its value.
    assert.equal(label(element('textarea', [text('Hi Ada, the password is hunter2')], { placeholder: 'Message' })), 'textarea "Message"', labels);
  }
  // A click beside an editor or a textarea reads no text inside them: React keeps a textarea's text the same as its value.
  const composer = element('div', [element('div', [text('Hi Ada, the password is hunter2')], { contenteditable: 'true' }), element('button', [text('Send')])]);
  assert.equal(labelOf(composer, 'text'), 'div "Send"');
  assert.equal(labelOf(element('div', [element('textarea', [text('Hi Ada, the password is hunter2')])]), 'text'), 'div');
  assert.equal(labelOf(element('div', [element('div', [text('typed search query')], { role: 'searchbox' })]), 'text'), 'div');
  const drawn = Object.assign(element('div', [text('Hi Ada, the password is hunter2')]), { editContext: {} });
  assert.equal(labelOf(element('div', [drawn, element('button', [text('Send')])]), 'text'), 'div "Send"');
  // The text a page shows beside an editor still names what was clicked.
  const toolbar = element('div', [element('span', [text('Bold')]), element('div', [text('Hi Ada')], { contenteditable: 'true' })]);
  assert.equal(labelOf(toolbar, 'text'), 'div "Bold"');
  // And so does the text of an element marked not editable outside any editor.
  assert.equal(labelOf(element('div', [text('Plain text')], { contenteditable: 'false' }), 'text'), 'div "Plain text"');
  assert.equal(labelOf(element('div', [element('div', [text('Plain text')], { contenteditable: 'false' })]), 'text'), 'div "Plain text"');
  // Written in any case: the browser reads "FALSE" as "false".
  assert.equal(labelOf(element('div', [text('Plain text')], { contenteditable: 'FALSE' }), 'text'), 'div "Plain text"');
  assert.equal(labelOf(element('div', [element('div', [text('Plain text')], { contenteditable: 'False' })]), 'text'), 'div "Plain text"');
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

test('a selector escapes an id or a class the way CSS.escape does, so it still parses as one', () => {
  const selectorOf = (target: Record<string, unknown>) => buildReport([entry('click', 0, 120, 3, 100, { target })], [], []).target?.selector;
  const named = (tag: string, id: string, classes: string[] = [], attributes: Record<string, string> = {}) => Object.assign(element(tag, [], { ...attributes, id }), { id, classList: classes });
  // React 18's useId, which Radix, Headless UI and React Aria put on their triggers, and Tailwind's variants and fractions.
  assert.equal(selectorOf(named('input', ':r1:')), 'input#\\:r1\\:');
  assert.equal(selectorOf(named('button', 'radix-:r1:')), 'button#radix-\\:r1\\:');
  assert.equal(selectorOf(named('div', '', ['md:flex', 'w-1/2', 'p-4'])), 'div.md\\:flex.w-1\\/2');
  assert.equal(selectorOf(named('div', '', ['hover:bg-red-500', 'w-[200px]'])), 'div.hover\\:bg-red-500.w-\\[200px\\]');
  assert.equal(selectorOf(named('button', 'radix-:r1:', [], { 'data-test': 'menu' })), 'button#radix-\\:r1\\:[data-test="menu"]');
  // A digit that starts the name, or follows a hyphen that does, is written as its code point, and a lone hyphen is escaped.
  assert.equal(selectorOf(named('tr', '1st')), 'tr#\\31 st');
  assert.equal(selectorOf(named('div', '-2', ['-'])), 'div#-\\32 .\\-');
  // A control character is written as its code point too, and NUL as the replacement character.
  assert.equal(selectorOf(named('div', 'a\tb\x7f\0')), 'div#a\\9 b\\7f \ufffd');
  // Past ASCII a name needs nothing, so React 19.1's useId reads as it is.
  assert.equal(selectorOf(named('div', '«r1»', ['café'])), 'div#«r1».café');
  // And an id or a class that needed nothing comes out as it was.
  assert.equal(selectorOf(named('button', 'save', ['btn', 'primary_2', 'x'])), 'button#save.btn.primary_2');
});

test("a form's selector has the id it was given, though a field named id takes the form's id property", () => {
  const selectorOf = (target: Record<string, unknown>) => buildReport([entry('click', 0, 120, 3, 100, { target })], [], []).target?.selector;
  // A hidden <input name="id">, which CRUD forms and Remix or React Router forms carry, is what the
  // form's `id` property returns: that element, or a RadioNodeList when there are several.
  const field = element('input', [], { name: 'id', type: 'hidden' });
  const form = (attributes: Record<string, string>) => Object.assign(element('form', [], attributes), { id: field });
  assert.equal(selectorOf(form({ id: 'checkout' })), 'form#checkout');
  assert.equal(selectorOf(form({})), 'form');
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

test('where the frame most likely waited on the next key press, the script after the handlers names the painting blame only where it ran for half of the screen update', () => {
  // A keyup handled by 1004 and painted at 1304, 300 ms of screen update, with the next key down at 1006.
  // Only the end of that key's render shows the frame waited on it, so the clause is hedged.
  const entries = [entry('keydown', 900, 16, 901, 903), entry('keyup', 1000, 304, 1001, 1004)];
  const typed = [input(900, 'keydown'), input(1000, 'keyup', { gestureTs: 900 })];
  const keyup = (until: number, frames: FrameSummary[], rendered = 12, total = 8, ring = [...typed, input(1006, 'keydown', worked(until))]) =>
    report(entries, [commit(until, 1006, { inputType: 'keydown', rendered, total })], frames, ring).explanation;
  const painting = (name: string | null) => ({ kind: 'painting', name, detail: null, ms: 300, confidence: 'measured' });
  const hedged = 'After the key press was handled, the screen took another 300 ms to update: the frame most likely waited on the next key press, which the page handled first.';

  // A 20 ms timer in the frame the next key's handler ran in is in the sentence, with its own figure, and is not the blame.
  const small = keyup(1163, [frame(995, 155, [], 1010), frame(1150, 60, [script('DIV#root.onkeydown', 1150, 15), script('TimerHandler:setTimeout', 1166, 20)], 1195)]);
  assert.deepEqual(small.blame, painting(null));
  assert.equal(small.cause, `${hedged} The longest script the browser recorded in that time was TimerHandler:setTimeout (app.js), 20 ms.`);
  // Nor is a 101 ms timer the next key waited behind, a third of it, in one fully recorded frame.
  const timerFirst = (timer: number, key: number) => [frame(1000, 304, [script('TimerHandler:setTimeout', 1004, timer), script('DIV#root.onkeydown', 1004 + timer, key)], 1004 + timer + key)];
  const behind = keyup(1160, timerFirst(101, 60), 40, 40);
  assert.deepEqual(behind.blame, painting(null));
  assert.equal(behind.cause, `${hedged} The longest script the browser recorded in that time was TimerHandler:setTimeout (app.js), 101 ms.`);
  // As with no next key at all.
  assert.equal(keyup(1160, timerFirst(101, 60), 40, 40, typed).blame.name, null);
  // At half of the screen update it names the blame, and just under half it does not.
  assert.deepEqual(keyup(1232, timerFirst(201, 30), 12, 20).blame, painting('TimerHandler:setTimeout'));
  assert.equal(keyup(1170, timerFirst(150, 20)).blame.name, 'TimerHandler:setTimeout');
  const under = keyup(1170, timerFirst(149, 20));
  assert.deepEqual(under.blame, painting(null));
  assert.equal(under.cause, `${hedged} The longest script the browser recorded in that time was TimerHandler:setTimeout (app.js), 149 ms.`);
  // The next key's own handler under half is that key's work, not this keyup's name.
  const handler = keyup(1160, [frame(1000, 304, [script('DIV#root.onkeydown', 1080, 80)], 1165)], 40, 40);
  assert.deepEqual(handler.blame, painting(null));
  assert.equal(handler.cause, `${hedged} The longest script the browser recorded in that time was DIV#root.onkeydown (app.js), 80 ms.`);
  // Where that handler ran for half of the screen update, it is on record from the press and the clause is not hedged.
  const held = keyup(1245, [frame(1000, 304, [script('DIV#root.onkeydown', 1006, 244)], 1250)], 900, 230);
  assert.deepEqual(held.blame, painting('DIV#root.onkeydown'));
  assert.equal(
    held.cause,
    'After the key press was handled, the screen took another 300 ms to update: the frame waited on the next key press, which the page handled first. The longest script the browser recorded in that time was DIV#root.onkeydown (app.js), 244 ms.',
  );
});

test('the frame is said to wait on the next key press only where the screen update is the larger part of the interaction, under a long task as well', () => {
  const ring = (at: number, until: number) => [input(1000, 'keydown'), input(1100, 'keyup', { gestureTs: 1000 }), input(at, 'keydown', worked(until))];
  // 60 ms of handlers and 43 ms of screen update, which the next key's render filled from the end of the handlers.
  // React rendered nothing for the keyup, so the 60 ms are the handlers'.
  const handled = report([entry('keyup', 1100, 104, 1101, 1161)], [], [], ring(1150, 1200));
  assert.equal(handled.nextInput?.start, 1150);
  assert.deepEqual(handled.explanation.blame, { kind: 'handler', name: null, detail: null, ms: 60, confidence: 'measured' });
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

test("where the working time was longer, the screen update's note says the frame waited on the next key press, and does not put it on that key's handler", () => {
  // Typing fast: a keydown rendered for 170 ms, then the next key went down at 1100 and its handler ran from
  // 1185 to 1290, before this key's paint at 1304. 181 ms of working time, then 122 ms of the screen updating.
  const typed = (frames: FrameSummary[], ring: InputRecord[], entries = [entry('keydown', 1000, 304, 1001, 1180), entry('keyup', 1060, 244, 1181, 1182)]) =>
    report(entries, [commit(1175, 1000, { inputType: 'keydown', total: 170, startedAt: 1005, rendered: 900, roots: ['Editor'], hotPath: ['Editor'] })], frames, ring).explanation;
  const ring = [input(1000, 'keydown'), input(1060, 'keyup', { gestureTs: 1000 }), input(1100, 'keydown', worked(1290))];
  const next = script('DIV#root.onkeydown', 1185, 105);
  const fast = typed([frame(1000, 304, [script('DIV#root.onkeydown', 1001, 179), next], 1292)], ring);
  assert.equal(fast.blame.kind, 'render');
  assert.deepEqual(fast.notes, [
    'After the handler finished, the screen took another 122 ms to update: the frame waited on the next key press, which the page handled first. The longest script the browser recorded in that time was DIV#root.onkeydown (app.js), 105 ms.',
  ]);
  // A render no stamp explains, inside the next key's handler, is not taken out as that script's and then
  // left unsaid: it stays this report's, as it does under the verdict.
  const overlapped = report(
    [entry('keydown', 1000, 304, 1001, 1180), entry('keyup', 1060, 244, 1181, 1182)],
    [
      commit(1175, 1000, { inputType: 'keydown', total: 170, startedAt: 1005, rendered: 900, roots: ['Editor'], hotPath: ['Editor'] }),
      commit(1250, 950, { inputType: 'keydown', total: 40, startedAt: 1200, rendered: 12, roots: ['Caret'], hotPath: ['Caret'] }),
    ],
    [frame(1000, 304, [script('DIV#root.onkeydown', 1001, 179), next], 1292)],
    ring,
  ).explanation;
  assert.deepEqual(overlapped.notes, [
    'React rendered 2 times before the screen updated, which usually means a state update inside an effect or a chain of updates.',
    fast.notes[0],
  ]);
  // With only the next key's render to show it, most likely, as the verdict says it.
  assert.deepEqual(typed([frame(1000, 304, [script('DIV#root.onkeydown', 1001, 179)], 1292)], ring).notes, [
    'After the handler finished, the screen took another 122 ms to update: the frame most likely waited on the next key press, which the page handled first.',
  ]);
  // And where a longer wait before the handlers took the verdict instead.
  const waited = typed(
    [frame(1000, 304, [script('TimerHandler:setTimeout', 990, 140), script('DIV#root.onkeydown', 1131, 51), next], 1292)],
    [input(1000, 'keydown'), input(1100, 'keydown', worked(1290))],
    [entry('keydown', 1000, 304, 1130, 1182)],
  );
  assert.equal(waited.blame.kind, 'waiting');
  assert.equal(
    waited.notes.find((n) => n.startsWith('After the handler finished')),
    'After the handler finished, the screen took another 122 ms to update: the frame waited on the next key press, which the page handled first. The longest script the browser recorded in that time was DIV#root.onkeydown (app.js), 105 ms.',
  );
  // With the working time split into short handlers and a small render, the next key's handler is not the
  // verdict's either, at 70 ms over half of the 122 ms or at 50 ms under it: the note says whose it is.
  const keys = Array.from({ length: 9 }, (_, i) => script('DIV#root.onkeydown', 1001 + i * 20, 19));
  const three = commit(1175, 1000, { inputType: 'keydown', hasDurations: false, total: 0, rendered: 3, roots: ['Editor'], hotPath: ['Editor'], components: [{ name: 'Row', count: 3, self: null, total: null }] });
  const shortKeys = (ms: number) =>
    report([entry('keydown', 1000, 304, 1001, 1180), entry('keyup', 1060, 244, 1181, 1182)], [three], [frame(1000, 304, [...keys, script('DIV#root.onkeydown', 1200, ms)], 1292)], ring).explanation;
  const held = shortKeys(70);
  assert.deepEqual(held.blame, { kind: 'none', name: null, detail: null, ms: null, confidence: 'measured' });
  assert.equal(held.cause, "React's render was small (re-rendering 3 components inside Editor, mostly Row (3 of them)) and no long task was recorded in the working time, so the rest went to waiting and painting.");
  assert.deepEqual(held.notes, [
    'After the handler finished, the screen took another 122 ms to update: the frame waited on the next key press, which the page handled first. The longest script the browser recorded in that time was DIV#root.onkeydown (app.js), 70 ms.',
  ]);
  const under = shortKeys(50);
  assert.deepEqual([under.blame, under.cause], [held.blame, held.cause]);
  assert.match(under.notes[0], /: the frame most likely waited on the next key press, which the page handled first\. The longest script the browser recorded in that time was DIV#root\.onkeydown \(app\.js\), 50 ms\.$/);
  // Nor where the screen update is 100 ms or under, which gets no note of its own: the next key's handler read as this
  // key's script, "after the handler finished", and nothing said the frame waited on it.
  const quickKeys = (ms: number, next = input(1100, 'keydown', worked(1265)), at = 1200, late: CommitSummary[] = []) =>
    report(
      [entry('keydown', 1000, 272, 1001, 1180), entry('keyup', 1060, 212, 1181, 1182)],
      [three, ...late],
      [frame(1000, 272, [...keys, script('DIV#root.onkeydown', at, ms)], 1262)],
      [...ring.slice(0, 2), next],
    ).explanation;
  const quick = quickKeys(70);
  assert.deepEqual([quick.blame, quick.cause], [held.blame, held.cause]);
  assert.deepEqual(quick.notes, [
    'After the handler finished, the screen took another 90 ms to update: the frame waited on the next key press, which the page handled first. The longest script the browser recorded in that time was DIV#root.onkeydown (app.js), 70 ms.',
  ]);
  const quickUnder = quickKeys(40);
  assert.deepEqual([quickUnder.blame, quickUnder.cause], [held.blame, held.cause]);
  assert.match(quickUnder.notes[0], /^After the handler finished, the screen took another 90 ms to update: the frame most likely waited on the next key press, which the page handled first\. The longest script the browser recorded in that time was DIV#root\.onkeydown \(app\.js\), 40 ms\.$/);
  // Nor where nothing shows the frame waited on it: the next key's 44 ms handler, under half of the 90 ms, with that
  // key's render not on record or ending after the paint, read as this key's script too. It is the next key's work
  // all the same, and the working time had no long task in it. The screen update's note names it, though, or it is
  // said nowhere. So it is on the tick after this key's handlers, where the next key's dispatch, queued behind them,
  // most likely ran: there it was this key's script again. A render no stamp explains, joined by overlap alone, says
  // too little to keep it as this key's either.
  const stray = commit(1230, 950, { inputType: 'keydown', hasDurations: false, total: 0, rendered: 2, roots: ['Editor'], hotPath: ['Editor'], components: [{ name: 'Row', count: 2, self: null, total: null }] });
  for (const next of [input(1100, 'keydown'), input(1100, 'keydown', worked(1400))]) {
    for (const [at, late] of [[1200, []], [1182, []], [1182.5, []], [1183, []], [1200, [stray]]] as const) {
      const unheld = quickKeys(44, next, at, [...late]);
      assert.deepEqual([unheld.blame, unheld.cause], [held.blame, held.cause], `at ${at}`);
      assert.deepEqual(unheld.notes, [
        "After the handler finished, the screen took another 90 ms to update: 46 ms of it was the browser's own work on the main thread, most likely recalculating styles and layout for what changed. The longest script the browser recorded in that time was DIV#root.onkeydown (app.js), 44 ms.",
      ], `at ${at}`);
    }
  }
  // Nor does a render of this key's, stamped a moment before that handler began, hold it: the next key's capture
  // listener puts that key in the ring before its handler runs, so a render stamped with this key came before the
  // handler. Held by a stamp 0.3 ms ahead of it, from the keydown or the keyup, the next key's 44 or 60 ms handler was
  // this key's script.
  const two = { inputType: 'keydown', hasDurations: false, total: 0, rendered: 2, roots: ['Editor'], hotPath: ['Editor'], components: [{ name: 'Row', count: 2, self: null, total: null }] };
  for (const [ms, said] of [
    [44, "46 ms of it was the browser's own work on the main thread, most likely recalculating styles and layout for what changed."],
    [60, 'the frame waited on the next key press, which the page handled first.'],
  ] as const) {
    for (const [at, stamp] of [[1186.2, commit(1185.9, 1000, two)], [1182.3, commit(1181.9, 1060, { ...two, inputType: 'keyup' })]] as const) {
      const early = quickKeys(ms, input(1100, 'keydown'), at, [stamp]);
      assert.deepEqual([early.blame, early.cause], [held.blame, held.cause], `${ms} ms at ${at}`);
      assert.deepEqual(early.notes, [
        `After the handler finished, the screen took another 90 ms to update: ${said} The longest script the browser recorded in that time was DIV#root.onkeydown (app.js), ${ms} ms.`,
      ], `${ms} ms at ${at}`);
    }
  }
  // React's task behind that handler, holding this key's render, is this key's, though: in its place the next key's
  // 30 ms handler was named.
  const eight = (at = 1215) =>
    commit(at, 1000, { inputType: 'keydown', hasDurations: false, total: 0, rendered: 8, roots: ['Editor'], hotPath: ['Editor'], components: [{ name: 'Row', count: 8, self: null, total: null }] });
  const behind = report(
    [entry('keydown', 1000, 272, 1001, 1180), entry('keyup', 1060, 212, 1181, 1182)],
    [three, eight(1240)],
    [frame(1000, 272, [...keys, script('DIV#root.onkeydown', 1182.3, 30), script('MessagePort.onmessage', 1214, 30)], 1262)],
    [...ring.slice(0, 2), input(1100, 'keydown')],
  ).explanation;
  assert.deepEqual(behind.blame, { kind: 'script', name: 'MessagePort.onmessage', detail: null, ms: 30, confidence: 'measured' });
  assert.deepEqual(behind.notes, []);
  // Where this key's own 25 ms script takes the verdict instead, the note names the next key's longer one as the
  // longest script before the paint, as it does over 100 ms, and does not leave it said nowhere.
  const ownFirst = report(
    [entry('keydown', 1000, 272, 1001, 1180), entry('keyup', 1060, 212, 1181, 1182)],
    [three],
    [frame(1000, 272, [script('DIV#root.onkeydown', 1001, 25), ...keys.slice(2), script('DIV#root.onkeydown', 1190, 44)], 1262)],
    [...ring.slice(0, 2), input(1100, 'keydown')],
  ).explanation;
  assert.deepEqual(ownFirst.blame, { kind: 'script', name: 'DIV#root.onkeydown', detail: null, ms: 25, confidence: 'measured' });
  assert.match(ownFirst.notes[0]!, /^After the handler finished, the screen took another 90 ms to update: .* The longest script the browser recorded in that time was DIV#root\.onkeydown \(app\.js\), 44 ms\.$/);
  // A script after the handlers that the next key cannot have run is this key's, though the next key came during
  // them: React's own task that held this key's render, with the render's stamp up to a millisecond past either end of
  // it, and a timer ahead of the next key's own listener, on the tick the handlers ended or two milliseconds after it.
  // Left out as that key's, either went to waiting and painting, with no note, where without the next key it was the
  // verdict, and from half of the screen update the note said the frame waited on the next key, which had no script
  // or render on record before the paint.
  const lateOwn = (late: ScriptSummary, commits: CommitSummary[], next: InputRecord[]) =>
    report(
      [entry('keydown', 1000, 272, 1001, 1180), entry('keyup', 1060, 212, 1181, 1182)],
      [three, ...commits],
      [frame(1000, 272, [...keys, late, script('DIV#root.onkeydown', 1245, 8)], 1262)],
      [...ring.slice(0, 2), ...next],
    ).explanation;
  for (const next of [[input(1100, 'keydown')], []]) {
    const said = next.length ? 'with the next key' : 'without it';
    for (const [ms, at] of [[35, 1215], [35, 1184], [35, 1219.5], [35, 1220], [46, 1225], [60, 1241]]) {
      const task = lateOwn(script('MessagePort.onmessage', 1184, ms), [eight(at)], next);
      assert.deepEqual(task.blame, { kind: 'script', name: 'MessagePort.onmessage', detail: null, ms, confidence: 'measured' }, `${said}, ${ms} ms, ${at}`);
      assert.equal(task.cause, `React's render was small (re-rendering 8 components inside Editor, mostly Row (8 of them)); a script (MessagePort.onmessage, app.js) ran for ${ms} ms after the handler finished.`, said);
      assert.deepEqual(task.notes, [], `${said}, ${ms} ms, ${at}`);
    }
    for (const [ms, at] of [[40, 1183], [46, 1183], [60, 1183], [40, 1184]]) {
      const timer = lateOwn(script('TimerHandler:setTimeout', at, ms), [], next);
      assert.deepEqual(timer.blame, { kind: 'script', name: 'TimerHandler:setTimeout', detail: null, ms, confidence: 'measured' }, `${said}, ${ms} ms at ${at}`);
      assert.equal(timer.cause, `React's render was small (re-rendering 3 components inside Editor, mostly Row (3 of them)); a script (TimerHandler:setTimeout, app.js) ran for ${ms} ms after the handler finished.`, said);
      assert.deepEqual(timer.notes, [], `${said}, ${ms} ms at ${at}`);
    }
  }
  // So under a 75 ms screen update, at 38, 40 and 50 ms of it: with the next key's listener after them, or on the
  // tick after this key's handlers, where the next key's dispatch, queued behind them, most likely ran, React's task
  // and the timer are the verdict with the next key as they are without it, and as 0.16.0 had them, React's task with
  // this key's render stamped inside it or half a millisecond past its end. A timer after that listener can be the
  // next key's, though, and is left to the note with it. With no listener of that key's on record, as for one under
  // 5 ms, nothing shows where its work began: the timer is the verdict as without it, and the note says the frame most
  // likely waited on that key only where that key's render, ending by the paint, shows it did. Counted from the tick
  // after this key's handlers, the note said the frame waited on that key, naming the timer the verdict named.
  const quicker = (scripts: ScriptSummary[], commits: CommitSummary[], next: InputRecord[]) =>
    report(
      [entry('keydown', 1000, 257, 1001, 1180), entry('keyup', 1060, 197, 1181, 1182)],
      [three, ...commits],
      [frame(1000, 257, [...keys, ...scripts], 1247)],
      [...ring.slice(0, 2), ...next],
    ).explanation;
  const listener = (at: number) => script('DIV#root.onkeydown', at, 8);
  for (const ms of [38, 40, 50]) {
    const task = script('MessagePort.onmessage', 1184, ms);
    for (const [scripts, commits, name, rendered] of [
      [[task, listener(1236)], [eight()], 'MessagePort.onmessage', 8],
      [[script('TimerHandler:setTimeout', 1183, ms), listener(1236)], [], 'TimerHandler:setTimeout', 3],
      [[listener(1182.5), { ...task, start: 1191 }], [eight()], 'MessagePort.onmessage', 8],
      [[listener(1182.5), { ...task, start: 1191 }], [eight(1191 + ms + 0.5)], 'MessagePort.onmessage', 8],
      [[script('TimerHandler:setTimeout', 1183, ms)], [], 'TimerHandler:setTimeout', 3],
    ] as const) {
      const alone = quicker([...scripts], [...commits], []);
      assert.deepEqual(alone.blame, { kind: 'script', name, detail: null, ms, confidence: 'measured' });
      assert.equal(alone.cause, `React's render was small (re-rendering ${rendered} components inside Editor, mostly Row (${rendered} of them)); a script (${name}, app.js) ran for ${ms} ms after the handler finished.`);
      assert.deepEqual(alone.notes, []);
      assert.deepEqual(quicker([...scripts], [...commits], [input(1100, 'keydown')]), alone, `${name}, ${ms} ms`);
    }
    const timerAfter = [listener(1182.5), script('TimerHandler:setTimeout', 1191, ms)];
    assert.deepEqual(quicker(timerAfter, [], []).blame, { kind: 'script', name: 'TimerHandler:setTimeout', detail: null, ms, confidence: 'measured' });
    const nextKeys = quicker(timerAfter, [], [input(1100, 'keydown')]);
    assert.deepEqual([nextKeys.blame, nextKeys.cause], [held.blame, held.cause]);
    assert.deepEqual(nextKeys.notes, [
      `After the handler finished, the screen took another 75 ms to update: the frame waited on the next key press, which the page handled first. The longest script the browser recorded in that time was TimerHandler:setTimeout (app.js), ${ms} ms.`,
    ]);
    for (const start of [1184, 1191]) {
      const timer = [script('TimerHandler:setTimeout', start, ms)];
      const alone = quicker(timer, [], []);
      assert.deepEqual(alone.blame, { kind: 'script', name: 'TimerHandler:setTimeout', detail: null, ms, confidence: 'measured' }, `at ${start}`);
      assert.deepEqual(alone.notes, [], `at ${start}`);
      for (const next of [input(1100, 'keydown'), input(1100, 'keydown', worked(1190))]) assert.deepEqual(quicker(timer, [], [next]), alone, `at ${start}`);
      const rendered = quicker(timer, [], [input(1100, 'keydown', worked(1247))]);
      assert.deepEqual([rendered.blame, rendered.cause], [alone.blame, alone.cause], `at ${start}`);
      assert.deepEqual(rendered.notes, [
        `After the handler finished, the screen took another 75 ms to update: the frame most likely waited on the next key press, which the page handled first. The longest script the browser recorded in that time was TimerHandler:setTimeout (app.js), ${ms} ms.`,
      ], `at ${start}`);
    }
  }
  // So where the screen update outranks the working time and is the blame: 31 ms of a keydown's handlers, then its own
  // timer 2 ms or more after them, in a 70, 90 or 100 ms screen update. Counted from the tick after the handlers, the
  // blame said the frame waited on the next key, which had no listener or render on record before the paint, where
  // without it the timer was the blame's script. It is what it is without that key, and says the frame most likely
  // waited on it only where its render, ending by the paint, shows it did.
  const painted = (paint: number, at: number, ms: number, next: InputRecord[]) =>
    report(
      [entry('keydown', 1000, 32 + paint, 1001, 1030), entry('keyup', 1010, 22 + paint, 1031, 1032)],
      [{ ...three, at: 1025, sinceInput: 25 }],
      [frame(1000, 32 + paint, [script('DIV#root.onkeydown', 1001.5, 28), script('TimerHandler:setTimeout', at, ms)], 1020 + paint)],
      [input(1000, 'keydown'), input(1010, 'keyup', { gestureTs: 1000 }), ...next],
    ).explanation;
  for (const paint of [70, 90, 100]) {
    for (const [at, ms] of [[1034, 50], [1034, 40], [1040, 45]]) {
      const alone = painted(paint, at, ms, []);
      for (const next of [input(1020, 'keydown'), input(1020, 'keydown', worked(1040))]) assert.deepEqual(painted(paint, at, ms, [next]), alone, `${paint} ms, ${ms} ms at ${at}`);
    }
  }
  const paintedAlone = painted(90, 1034, 50, []);
  assert.deepEqual(paintedAlone.blame, { kind: 'painting', name: 'TimerHandler:setTimeout', detail: null, ms: 90, confidence: 'measured' });
  assert.equal(paintedAlone.cause, 'After the key press was handled, the screen took another 90 ms to update, mostly because a script (TimerHandler:setTimeout, app.js) ran for 50 ms before the next frame.');
  const paintedRendered = painted(90, 1034, 50, [input(1020, 'keydown', worked(1080))]);
  assert.deepEqual(paintedRendered.blame, paintedAlone.blame);
  assert.equal(
    paintedRendered.cause,
    'After the key press was handled, the screen took another 90 ms to update: the frame most likely waited on the next key press, which the page handled first. The longest script the browser recorded in that time was TimerHandler:setTimeout (app.js), 50 ms.',
  );
  // So where React rendered nothing and the handlers are weighed first: a keydown's nine short handlers, or ones led by
  // a 25 ms script, then its own 50 ms timer after them. Counted from the tick after the handlers as the next key's,
  // the timer lost the verdict to the handlers' 181 ms, or to the 25 ms script, and the handlers' was said nowhere.
  // A click's short handlers and timer, with the next click's, the same way.
  const idleKey = (handlers: ScriptSummary[], next: InputRecord[]) =>
    report(
      [entry('keydown', 1000, 272, 1001, 1180), entry('keyup', 1060, 212, 1181, 1182)],
      [],
      [frame(1000, 272, [...handlers, script('TimerHandler:setTimeout', 1184, 50)], 1262)],
      [...ring.slice(0, 2), ...next],
    ).explanation;
  for (const handlers of [keys, [script('DIV#root.onkeydown', 1001, 25), ...keys.slice(2)]]) {
    const alone = idleKey(handlers, []);
    assert.deepEqual(alone.blame, { kind: 'script', name: 'TimerHandler:setTimeout', detail: null, ms: 50, confidence: 'measured' });
    assert.equal(alone.cause, "React didn't render anything; a script (TimerHandler:setTimeout, app.js) ran for 50 ms after the handler finished.");
    assert.deepEqual(alone.notes, []);
    assert.deepEqual(idleKey(handlers, [input(1100, 'keydown')]), alone, `${handlers[0]!.duration} ms first`);
    const rendered = idleKey(handlers, [input(1100, 'keydown', worked(1260))]);
    assert.deepEqual([rendered.blame, rendered.cause], [alone.blame, alone.cause], `${handlers[0]!.duration} ms first`);
    assert.deepEqual(rendered.notes, [
      'After the handler finished, the screen took another 90 ms to update: the frame most likely waited on the next key press, which the page handled first. The longest script the browser recorded in that time was TimerHandler:setTimeout (app.js), 50 ms.',
    ]);
  }
  const tapped = { pointerType: 'mouse' };
  const idleClick = (next: InputRecord[]) =>
    report(
      [entry('pointerdown', 990, 24, 991, 992), entry('pointerup', 1000, 272, 1000.5, 1001), entry('click', 1000, 272, 1001, 1182)],
      [],
      [frame(1000, 272, [...keys.map((s) => ({ ...s, invoker: 'DIV#root.onclick' })), script('TimerHandler:setTimeout', 1184, 50)], 1262)],
      [input(990, 'pointerdown', tapped), input(1000, 'pointerup', { ...tapped, gestureTs: 990 }), input(1000, 'click', { ...tapped, gestureTs: 990 }), ...next],
    ).explanation;
  assert.deepEqual(idleClick([]).blame, { kind: 'script', name: 'TimerHandler:setTimeout', detail: null, ms: 50, confidence: 'measured' });
  assert.deepEqual(idleClick([input(1100, 'pointerdown', tapped)]), idleClick([]));
  // And where the frame did wait on it, a 30 ms timer that ran after this key's handlers, before the next key came, is
  // the verdict under a 90 ms screen update, as the longest script of this key's own, and not under a 104 ms one,
  // where a script after the handlers takes it only from half of the screen update, with the next key or without.
  // Held to that under 90 as well where the frame waited on the next key, a script of this key's own under half, a
  // timer on the tick its handlers ended too, went to waiting and painting where 0.16.0 named it.
  const timerFirst = (paint: number) =>
    report(
      [entry('keydown', 1000, 182 + paint, 1001, 1180), entry('keyup', 1060, 122 + paint, 1181, 1182)],
      [three],
      [frame(1000, 182 + paint, [...keys, script('TimerHandler:setTimeout', 1183, 30), script('DIV#root.onkeydown', 1216, 55)])],
      [...ring.slice(0, 2), input(1215, 'keydown')],
    ).explanation;
  const first = timerFirst(90);
  assert.deepEqual(first.blame, { kind: 'script', name: 'TimerHandler:setTimeout', detail: null, ms: 30, confidence: 'measured' });
  const over = timerFirst(104);
  assert.deepEqual([over.blame, over.cause], [held.blame, held.cause]);
  for (const waitedOn of [first, over]) {
    assert.match(waitedOn.notes[0]!, /: the frame waited on the next key press, which the page handled first\. The longest script the browser recorded in that time was DIV#root\.onkeydown \(app\.js\), 55 ms\.$/);
  }
  // A timer from half of the screen update that started before the next key came is this key's own, though, and
  // keeps the verdict where the frame most likely waited on that key too: dropped with the next key's handler, its
  // 50 ms went to waiting and painting in the cause, and was said only in the note, as the longest script.
  const timerLeads = (paint: number) =>
    report(
      [entry('keydown', 1000, 182 + paint, 1001, 1180), entry('keyup', 1060, 122 + paint, 1181, 1182)],
      [three],
      [frame(1000, 182 + paint, [...keys, script('TimerHandler:setTimeout', 1183, 50), script('DIV#root.onkeydown', 1234, paint - 53)])],
      [...ring.slice(0, 2), input(1185, 'keydown', worked(1181 + paint))],
    ).explanation;
  for (const paint of [90, 100]) {
    const own = timerLeads(paint);
    assert.deepEqual(own.blame, { kind: 'script', name: 'TimerHandler:setTimeout', detail: null, ms: 50, confidence: 'measured' }, `${paint} ms`);
    assert.equal(own.cause, "React's render was small (re-rendering 3 components inside Editor, mostly Row (3 of them)); a script (TimerHandler:setTimeout, app.js) ran for 50 ms after the handler finished.");
    assert.deepEqual(own.notes, [
      `After the handler finished, the screen took another ${paint} ms to update: the frame most likely waited on the next key press, which the page handled first. The longest script the browser recorded in that time was TimerHandler:setTimeout (app.js), 50 ms.`,
    ]);
  }
  // So is one on the tick the handlers ended on, where the next key came during them, ahead of that key's listener:
  // the verdict from half of a screen update over 100 ms, as without the next key. Left out as coming after that key
  // came, it went to waiting and painting.
  const tickTimer = (paint: number, ms: number, next: InputRecord[], at = 1183, heard = true) =>
    report(
      [entry('keydown', 1000, 182 + paint, 1001, 1180), entry('keyup', 1060, 122 + paint, 1181, 1182)],
      [three],
      [frame(1000, 182 + paint, [...keys, script('TimerHandler:setTimeout', at, ms), ...(heard ? [script('DIV#root.onkeydown', 1184 + ms, paint - ms - 6)] : [])], 1172 + paint)],
      [...ring.slice(0, 2), ...next],
    ).explanation;
  for (const [paint, ms] of [[104, 54], [110, 57]]) {
    const own = tickTimer(paint, ms, [input(1100, 'keydown', worked(1181 + paint))]);
    const alone = tickTimer(paint, ms, []);
    assert.deepEqual(alone.blame, { kind: 'script', name: 'TimerHandler:setTimeout', detail: null, ms, confidence: 'measured' });
    assert.deepEqual([own.blame, own.cause], [alone.blame, alone.cause], `${paint} ms`);
    assert.deepEqual(own.notes, [
      `After the handler finished, the screen took another ${paint} ms to update: the frame most likely waited on the next key press, which the page handled first. The longest script the browser recorded in that time was TimerHandler:setTimeout (app.js), ${ms} ms.`,
    ]);
    // With no listener of that key's on record, as for one under 5 ms, only the tick shows the timer was this key's:
    // on it, the timer is the verdict as without the next key, and from a millisecond past it, that key's work, as in
    // 0.16.0, where the note says the frame waited on that key.
    assert.deepEqual(tickTimer(paint, ms, [input(1100, 'keydown')], 1183, false), tickTimer(paint, ms, [], 1183, false), `${paint} ms`);
    const past = tickTimer(paint, ms, [input(1100, 'keydown')], 1184, false);
    assert.deepEqual([past.blame, past.cause], [held.blame, held.cause], `${paint} ms`);
    assert.deepEqual(past.notes, [
      `After the handler finished, the screen took another ${paint} ms to update: the frame waited on the next key press, which the page handled first. The longest script the browser recorded in that time was TimerHandler:setTimeout (app.js), ${ms} ms.`,
    ], `${paint} ms`);
  }
  // Nor is a script that holds this key's render the next key's, though it started after that key came: React's task
  // at 83 held the 150-row render of this key's handlers, and with the next key down at 30 the note said the frame
  // waited on that key, naming the task as the longest script. With the next key at 30 or at 90, the verdict and the
  // notes are what they are without it.
  const counted = (n: number): Partial<CommitSummary> => ({ inputType: 'keydown', hasDurations: false, total: 0, rendered: n, components: [{ name: 'Row', count: n, self: null, total: null }] });
  const renderedFirst = (nexts: InputRecord[]) =>
    report(
      [entry('keydown', 0, 152, 1, 81)],
      [commit(75, 0, counted(3)), commit(128, 0, counted(150)), ...nexts.map((n) => commit(144, n.ts, counted(3)))],
      [frame(0, 160, [script('DIV#root.onkeydown', 1.2, 79.6), script('MessagePort.onmessage', 83, 47), script('DIV#root.onkeydown', 132, 13)], 146)],
      [input(0, 'keydown'), ...nexts],
    ).explanation;
  const renderedAlone = renderedFirst([]);
  assert.equal(renderedAlone.blame.kind, 'render');
  assert.equal(
    renderedAlone.cause,
    'React was most likely re-rendering 150 components inside List, mostly Row (150 of them), after the handlers, before the next frame. This React build records no render durations, so that is read from the component counts, not measured. A profiling build of React would give exact numbers.',
  );
  assert.deepEqual(renderedAlone.notes, []);
  for (const at of [30, 90]) assert.deepEqual(renderedFirst([input(at, 'keydown')]), renderedAlone, `next key at ${at}`);
  // A key with no keyup in the report runs its own input events in the task its handlers ran in, right after them:
  // React's onChange on `input`. That listener is this key's, though the next key came during the handlers, and is the
  // verdict with the next key as without it, as in 0.16.0. Only after a released key is one the next key's.
  const pressOnly = (ms: number, paint: number, nexts: InputRecord[]) =>
    report(
      [entry('keydown', 1000, 180 + paint, 1001, 1180)],
      [three],
      [frame(1000, 180 + paint, [...keys, script('DIV#root.oninput', 1180.1, ms)], 1170 + paint)],
      [...ring.slice(0, 1), ...nexts],
    ).explanation;
  for (const [ms, paint] of [[30, 75], [44, 90], [60, 90]]) {
    const own = pressOnly(ms, paint, []);
    assert.deepEqual(own.blame, { kind: 'script', name: 'DIV#root.oninput', detail: null, ms, confidence: 'measured' }, `${ms} ms`);
    assert.deepEqual(pressOnly(ms, paint, [input(1100, 'keydown')]), own, `${ms} ms`);
  }
  // So is one whose keyup the report has but the browser handled in a later frame: the release that counts is the
  // last event this frame handled. Taken for the next key's, the keydown's own `oninput` went to waiting and painting,
  // with a note that the frame waited on that key.
  const keyupLater = (ms: number, nexts: InputRecord[]) =>
    report(
      [entry('keydown', 1000, 270, 1001, 1180), entry('keyup', 1300, 16, 1301, 1302)],
      [three],
      [frame(1000, 270, [...keys, script('DIV#root.oninput', 1180.1, ms)], 1260)],
      [input(1000, 'keydown'), input(1300, 'keyup', { gestureTs: 1000 }), ...nexts],
    ).explanation;
  for (const ms of [30, 44, 60]) {
    const own = keyupLater(ms, []);
    assert.deepEqual(own.blame, { kind: 'script', name: 'DIV#root.oninput', detail: null, ms, confidence: 'measured' }, `${ms} ms`);
    assert.deepEqual(own.notes, [], `${ms} ms`);
    assert.deepEqual(keyupLater(ms, [input(1100, 'keydown')]), own, `${ms} ms`);
  }
  // And a listener of what a key dispatches after its handlers is only ever a key's, and a pointer's a pointer's: a
  // checkbox's click runs its own `oninput` in its task, right after its handlers, a pointer runs no `onbeforeinput`,
  // and a key no `onmousedown`. Taken for the next press's, each went to waiting and painting in the same way.
  const clicks = Array.from({ length: 6 }, (_, i) => script('DIV#root.onclick', 13 + i * 15, 15));
  const checkbox = (ms: number, nexts: InputRecord[], invoker = 'INPUT#agree.oninput', at = 104.5) =>
    report(
      [entry('pointerdown', 0, 24, 1, 2), entry('pointerup', 10, 184, 11, 12), entry('click', 10, 184, 12, 104)],
      [commit(102, 10, { ...counted(3), inputType: 'click', roots: ['List'], hotPath: ['List'] })],
      [frame(0, 194, [...clicks, script(invoker, at, ms)], 184)],
      [input(0, 'pointerdown', { pointerType: 'mouse' }), input(10, 'pointerup', { gestureTs: 0, pointerType: 'mouse' }), input(10, 'click', { gestureTs: 0, pointerType: 'mouse' }), ...nexts],
    ).explanation;
  for (const ms of [44, 60]) {
    const own = checkbox(ms, []);
    assert.deepEqual(own.blame, { kind: 'script', name: 'INPUT#agree.oninput', detail: null, ms, confidence: 'measured' }, `${ms} ms`);
    for (const next of [input(60, 'pointerdown', { pointerType: 'mouse' }), input(60, 'keydown')]) assert.deepEqual(checkbox(ms, [next]), own, `${ms} ms, ${next.type}`);
  }
  const dispatched = (invoker: string, nexts: InputRecord[], ms = 56) =>
    report(
      [entry('keydown', 1000, 272, 1001, 1180), entry('keyup', 1060, 212, 1181, 1182)],
      [three],
      [frame(1000, 272, [...keys, script(invoker, 1183, ms)], 1262)],
      [...ring.slice(0, 2), ...nexts],
    ).explanation;
  const mouse = input(1121, 'pointerdown', { pointerType: 'mouse' });
  for (const [invoker, other, own] of [
    ['DIV#root.onbeforeinput', mouse, input(1121, 'keydown')],
    ['DIV#root.onmousedown', input(1121, 'keydown'), mouse],
  ] as const) {
    const unpressed = dispatched(invoker, []);
    assert.deepEqual(unpressed.blame, { kind: 'script', name: invoker, detail: null, ms: 56, confidence: 'measured' });
    assert.deepEqual(dispatched(invoker, [other]), unpressed, invoker);
    // After a released key, the next press of its own kind it is.
    const next = dispatched(invoker, [own]);
    assert.deepEqual([next.blame, next.cause], [held.blame, held.cause], invoker);
    assert.deepEqual(next.notes, [
      `After the handler finished, the screen took another 90 ms to update: the frame waited on the next ${own.type === 'keydown' ? 'key press' : 'click'}, which the page handled first. The longest script the browser recorded in that time was ${invoker} (app.js), 56 ms.`,
    ], invoker);
  }
  // A key dispatches no `mousedown` or `touchstart` whether or not this frame handled its keyup, though: with no keyup,
  // or one handled in a later frame, the next click's 56 ms listener was ranked with this key's scripts and named as
  // having run after its handler. Only a pointer press whose release this frame did not handle can still dispatch its
  // own, and keeps it as its verdict with the next click as without it.
  const unreleased = (invoker: string, entries: ReturnType<typeof entry>[], handlers: ScriptSummary[], commits: CommitSummary[], pressed: InputRecord[]) =>
    report(entries, commits, [frame(1000, 272, [...handlers, script(invoker, 1183, 56)], 1262)], pressed).explanation;
  const pointers = keys.map((s) => ({ ...s, invoker: 'DIV#root.onpointerdown' }));
  for (const invoker of ['DIV#root.onmousedown', 'DIV#root.ontouchstart']) {
    for (const [entries, pressed] of [
      [[entry('keydown', 1000, 272, 1001, 1180)], [ring[0]!]],
      [[entry('keydown', 1000, 272, 1001, 1180), entry('keyup', 1300, 16, 1301, 1302)], [ring[0]!, input(1300, 'keyup', { gestureTs: 1000 })]],
    ]) {
      const key = unreleased(invoker, entries, keys, [three], [...pressed, mouse]);
      assert.deepEqual([key.blame, key.cause], [held.blame, held.cause], `${invoker}, ${entries.length} entries`);
      assert.deepEqual(key.notes, [
        `After the handler finished, the screen took another 92 ms to update: the frame waited on the next click, which the page handled first. The longest script the browser recorded in that time was ${invoker} (app.js), 56 ms.`,
      ], `${invoker}, ${entries.length} entries`);
    }
    const pointer = (nexts: InputRecord[]) =>
      unreleased(invoker, [entry('pointerdown', 1000, 272, 1001, 1180)], pointers, [{ ...three, inputType: 'pointerdown' }], [input(1000, 'pointerdown', { pointerType: 'mouse' }), ...nexts]);
    const own = pointer([]);
    assert.deepEqual(own.blame, { kind: 'script', name: invoker, detail: null, ms: 56, confidence: 'measured' }, invoker);
    assert.deepEqual(pointer([mouse]), own, invoker);
  }
  // A pointer's `pointerup`, `mouseup` and `click` listeners are the next click's only where this interaction has none
  // of its own still to come, after a key's handlers or a click's. In a React app the next click's listeners on its
  // press are usually under 5 ms and not recorded, and its `onclick` was ranked with a key's scripts: under half of a
  // 90 ms screen update, a 44 ms one was named as the key's script after its handler, and so was a 56 ms one, with no
  // note that the frame waited on that click.
  for (const invoker of ['DIV#root.onclick', 'DIV#root.onpointerup', 'DIV#root.onmouseup']) {
    const unpressed = dispatched(invoker, []);
    assert.deepEqual(unpressed.blame, { kind: 'script', name: invoker, detail: null, ms: 56, confidence: 'measured' });
    assert.deepEqual(dispatched(invoker, [input(1121, 'keydown')]), unpressed, invoker);
    const next = dispatched(invoker, [mouse]);
    assert.deepEqual([next.blame, next.cause], [held.blame, held.cause], invoker);
    assert.deepEqual(next.notes, [
      `After the handler finished, the screen took another 90 ms to update: the frame waited on the next click, which the page handled first. The longest script the browser recorded in that time was ${invoker} (app.js), 56 ms.`,
    ], invoker);
    const under = dispatched(invoker, [mouse], 44);
    assert.deepEqual([under.blame, under.cause], [held.blame, held.cause], invoker);
    assert.deepEqual(under.notes, [
      `After the handler finished, the screen took another 90 ms to update: 46 ms of it was the browser's own work on the main thread, most likely recalculating styles and layout for what changed. The longest script the browser recorded in that time was ${invoker} (app.js), 44 ms.`,
    ], invoker);
    const clicked = checkbox(56, [], invoker, 106);
    assert.deepEqual(clicked.blame, { kind: 'script', name: invoker, detail: null, ms: 56, confidence: 'measured' }, invoker);
    assert.deepEqual(checkbox(56, [input(60, 'keydown')], invoker, 106), clicked, invoker);
    assert.match(checkbox(56, [input(60, 'pointerdown', { pointerType: 'mouse' })], invoker, 106).notes[0]!, /: the frame waited on the next click, which the page handled first\./, invoker);
    // A pointerdown's own are still to come, and so are a pointerup's whose click was too quick for an entry.
    for (const [entries, pressed] of [
      [[entry('pointerdown', 1000, 272, 1001, 1180)], [input(1000, 'pointerdown', { pointerType: 'mouse' })]],
      [
        [entry('pointerdown', 1000, 24, 1001, 1002), entry('pointerup', 1010, 262, 1011, 1180)],
        [input(1000, 'pointerdown', { pointerType: 'mouse' }), input(1010, 'pointerup', { gestureTs: 1000, pointerType: 'mouse' })],
      ],
    ]) {
      const own = unreleased(invoker, entries, pointers, [{ ...three, inputType: 'pointerdown' }], pressed);
      assert.deepEqual(own.blame, { kind: 'script', name: invoker, detail: null, ms: 56, confidence: 'measured' }, `${invoker}, ${entries.length} entries`);
      assert.deepEqual(unreleased(invoker, entries, pointers, [{ ...three, inputType: 'pointerdown' }], [...pressed, mouse]), own, `${invoker}, ${entries.length} entries`);
    }
  }
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

test("a render a key press set off after it painted is still a later render once the slower keyup heads the report", () => {
  // The keydown painted at 24 and the render it set off landed at 150, before the key came up at 300. The
  // keyup's entry was the longer one and headed the next revision, which threw the render away as work
  // before its input and said React didn't render anything.
  const keydown = entry('keydown', 0, 24, 1, 10);
  const ring = [input(0, 'keydown', { press: 'KeyA' }), input(300, 'keyup', { press: 'KeyA', gestureTs: 0 })];
  const render = commit(150, 0, { inputType: 'keydown', rendered: 400, total: 60 });
  const note = (r: InteractionReport) => r.explanation.notes.find((n) => /^A (second )?React render/.test(n)) ?? '';
  const first = buildReport([keydown], [render], [], ring);
  assert.deepEqual(first.followUps.map((c) => c.at), [150]);
  const next = sealReport(refreshReport(first, [keydown, entry('keyup', 300, 48, 301, 340)], [render], [], ring));
  assert.equal(next.duration, 48);
  assert.deepEqual(next.commits, []);
  assert.deepEqual(next.followUps.map((c) => c.at), [150]);
  // Measured from the keydown's paint, the one it came after, and said as the press's: it is not a second
  // render after the screen the report is about updated.
  assert.match(note(next), /^A React render landed 126 ms after the press updated the screen, before the release: 60 ms .* INP doesn't count it, but people still wait for it\.$/);
  // The keyup's working time is what the cause is about, and the render was not in it. Said bare, the cause
  // told the reader React didn't render anything and the next sentence that it did.
  assert.match(next.explanation.cause, /; React didn't render anything in the working time\.$/);
  // Only while it lands inside the window from that paint, though: Shift held for 2 s, which macOS does not repeat, and
  // a render stamped with its keydown 1576 ms after the keydown painted, past the 1500 ms window. Measured from the
  // keyup instead, it would be kept.
  const shift = [input(0, 'keydown', { press: 'ShiftLeft' }), input(2000, 'keyup', { press: 'ShiftLeft', gestureTs: 0 })];
  const heldLong = [keydown, entry('keyup', 2000, 48, 2001, 2040)];
  assert.deepEqual(buildReport(heldLong, [{ ...render, at: 1600, sinceInput: 1600 }], [], shift).followUps, []);
  assert.deepEqual(buildReport(heldLong, [render], [], shift).followUps.map((c) => c.at), [150]);
});

test("a verdict that names no render says so of the working time where a press rendered before the release, whichever rung says it", () => {
  // The keyup's handlers ran for 2 ms, too short to be the verdict, and the press's render landed at 150.
  const ring = [input(0, 'keydown', { press: 'KeyA' }), input(300, 'keyup', { press: 'KeyA', gestureTs: 0 })];
  const keys = [entry('keydown', 0, 24, 1, 10), entry('keyup', 300, 48, 301, 303)];
  const render = commit(150, 0, { inputType: 'keydown', rendered: 400, total: 60 });
  const cause = (commits: CommitSummary[], frames: FrameSummary[] | null) => report(keys, commits, frames, ring).explanation.cause;
  assert.equal(cause([render], []), "React didn't render anything in the working time and no long task was recorded, so the time went to waiting and painting.");
  assert.equal(cause([], []), "React didn't render anything and no long task was recorded, so the time went to waiting and painting.");
  // Without Long Animation Frames.
  assert.equal(cause([render], null), "React didn't render anything in the working time; this browser does not report long tasks, so what ran instead is unknown.");
  assert.equal(cause([], null), "React didn't render anything; this browser does not report long tasks, so what ran instead is unknown.");
  // Where a listener after the handlers is what ran.
  const listener = [entry('keydown', 0, 24, 1, 10), entry('keyup', 300, 72, 303, 323)];
  const frames = [frame(290, 90, [script('BUTTON.onkeyup', 303, 15), script('DIV.onscroll', 325, 20)], 350)];
  assert.match(report(listener, [render], frames, ring).explanation.cause, /^React didn't render anything in the working time; a script \(DIV\.onscroll, app\.js\) ran for 20 ms after the handler finished\.$/);
  // Where the keyup's handler forced layout, the sentence that puts it outside React says so of the working time
  // too, in the layout verdict and in the note a script verdict leaves for a smaller one.
  const forcing = [entry('keydown', 0, 24, 1, 10), entry('keyup', 300, 80, 301, 360)];
  const forced = (layout: number) => [frame(290, 100, [script('BUTTON.onkeyup', 301, 58, layout)], 362)];
  const outside = / React did not render in the working time, so it was code outside React, such as the key press handler or a library's listener\.$/;
  const bare = / React did not render, so it was code outside React, such as the key press handler or a library's listener\.$/;
  const layoutNote = (r: InteractionReport) => r.explanation.notes.find((n) => n.startsWith('The browser also spent')) ?? '';
  const layout = report(forcing, [render], forced(40), ring);
  assert.equal(layout.explanation.blame.kind, 'layout');
  assert.match(layout.explanation.cause, outside);
  assert.match(report(forcing, [], forced(40), ring).explanation.cause, bare);
  const scripted = report(forcing, [render], forced(8), ring);
  assert.equal(scripted.explanation.blame.kind, 'script');
  assert.match(layoutNote(scripted), outside);
  assert.match(layoutNote(report(forcing, [], forced(8), ring)), bare);
  // A render after the paint the report is about leaves the cause as it was: its note puts it after that paint.
  const late = commit(600, 0, { inputType: 'keydown', rendered: 400, total: 60 });
  assert.deepEqual(report(keys, [late], [], ring).followUps.map((c) => c.at), [600]);
  assert.equal(cause([late], []), "React didn't render anything and no long task was recorded, so the time went to waiting and painting.");
  assert.match(report(forcing, [late], forced(40), ring).explanation.cause, bare);
  // Where the working time did render, a little, the long task clause keeps its own "in the working time":
  // "in it" follows only the clause that says React didn't render anything there. A Space held from -300 and
  // let go at 0, where the click it made took 360 ms.
  const space = [input(-300, 'keydown', { press: 'Space' }), input(0, 'keyup', { press: 'Space', gestureTs: -300 }), input(0, 'click', { gestureTs: -300 })];
  const listed = (x: CommitSummary) => ({ ...x, gestureTs: -300, rendered: 721, roots: ['TableBody'], hotPath: ['TableBody'], hasDurations: false, total: 0 });
  const three = commit(195, 0, { gestureTs: -300, hasDurations: false, total: 0, rendered: 3, components: [{ name: 'Row', count: 3, self: null, total: null }] });
  const held = commit(-150, -300, { inputType: 'keydown', rendered: 400, total: 60 });
  const tenClicks = Array.from({ length: 10 }, (_, i) => script('BUTTON.onclick', 3 + i * 20, 15));
  const small = report([entry('keydown', -300, 24, -299, -290), entry('click', 0, 360, 3, 203)], [held, three, listed(commit(270, 0))], [frame(0, 360, [...tenClicks, script('DIV.onscroll', 205, 70)], 280)], space);
  assert.deepEqual(small.followUps.map((c) => c.at), [-150]);
  assert.match(small.explanation.cause, /^React's render was small \(.*\) and no long task was recorded in the working time, so the rest went to waiting and painting\.$/);
  // Where it rendered nothing and the screen update's note names a script after the handlers, the long task
  // clause says "in it", not "in the working time" twice over. The click Space made came 100 ms after its
  // keyup, in the same frame, with the thread idle in between, and a 40 ms listener ran after its handlers.
  const spaced = [input(0, 'keydown', { press: 'Space' }), input(300, 'keyup', { press: 'Space', gestureTs: 0 }), input(400, 'click', { gestureTs: 0 })];
  const idle = [entry('keydown', 0, 24, 1, 10), entry('keyup', 300, 240, 301, 305), entry('click', 400, 136, 401, 421)];
  const after = [frame(420, 120, [script('DIV.onscroll', 430, 40)])];
  assert.equal(report(idle, [render], after, spaced).explanation.cause, "React didn't render anything in the working time and no long task was recorded in it, so the time went to waiting and painting.");
  assert.equal(report(idle, [], after, spaced).explanation.cause, "React didn't render anything and no long task was recorded in the working time, so the time went to waiting and painting.");
});

test("a press's render before a slower release is looked at from the press's paint for anything that came between", () => {
  // A script dispatched a change at 100, after the keydown painted at 24 and before the render at 150. Judged
  // against the keydown's report the render was left out for it, and the keyup's put it back: the check ran
  // after the interaction's last input, the keyup at 300, which came after the render.
  const keydown = entry('keydown', 0, 24, 1, 10);
  const pressed = input(0, 'keydown', { press: 'KeyA', work: { endedAt: 0, unjoined: [], closers: [100] } });
  const render = commit(150, 0, { inputType: 'keydown', rendered: 400, total: 60 });
  assert.equal(isLaterRender(buildReport([keydown], [], [], [pressed]), render, [pressed]), false);
  const both = [keydown, entry('keyup', 300, 48, 301, 340)];
  const released = input(300, 'keyup', { press: 'KeyA', gestureTs: 0 });
  assert.deepEqual(buildReport(both, [render], [], [pressed, released]).followUps, []);
  // So is another key that went down in between.
  const rolled = [input(0, 'keydown', { press: 'KeyA' }), input(100, 'keydown', { press: 'KeyB' }), released];
  assert.deepEqual(buildReport(both, [render], [], rolled).followUps, []);
});

test("a render a press too quick for an entry set off before the release is left out of the report, as a drag's moves are", () => {
  // A pointerdown under 16 ms sends no entry, and that is the usual press, so only the click's arrived. Nothing
  // of the interaction had painted before the render the press set off at 100, while the pointer was held. A
  // drag's moves are such renders, stamped by the hook with its pointerdown, and taking the press to have
  // painted inside the 16 ms made them later renders of the drop, which published a quiet one.
  const note = (r: InteractionReport) => r.explanation.notes.find((n) => /^A (second )?React render/.test(n)) ?? '';
  const ring = [input(0, 'pointerdown'), input(200, 'pointerup', { gestureTs: 0 }), input(200.5, 'click', { gestureTs: 0 })];
  const click = [entry('click', 200, 120, 201, 300)];
  const held = report(click, [commit(100, 0, { inputType: 'pointerdown', rendered: 400, total: 60 })], [], ring);
  assert.deepEqual(held.commits, []);
  assert.deepEqual(held.followUps, []);
  assert.equal(note(held), '');
  // `holdMs` starts at the interaction's first entry, the click's, so it does not reach the press either.
  assert.equal(held.holdMs, 0);
  assert.match(held.explanation.cause, /; React didn't render anything\.$/);
  assert.ok(!held.verdict.includes('Infinity'), held.verdict);
  // A quick keydown's, before its slower keyup, the same way. Taken to have painted 16 ms after it went down, one
  // at 16.3 was said to have "landed 0 ms after the press updated the screen", a bound stated as a measurement.
  const keys = [input(0, 'keydown', { press: 'KeyA' }), input(300, 'keyup', { press: 'KeyA', gestureTs: 0 })];
  const typed = report([entry('keyup', 300, 48, 301, 340)], [16.3, 150].map((at) => commit(at, 0, { inputType: 'keydown', rendered: 400, total: 60 })), [], keys);
  assert.deepEqual(typed.followUps, []);
  assert.equal(note(typed), '');
  // A key press with an entry is measured from that entry's paint, however short: the page's first input comes at any duration.
  const first = report([entry('keydown', 0, 8, 1, 4, { entryType: 'first-input' }), entry('keyup', 300, 48, 301, 340)], [commit(150, 0, { inputType: 'keydown', rendered: 400, total: 60 })], [], keys);
  assert.deepEqual(first.followUps.map((c) => c.at), [150]);
  assert.match(note(first), /^A React render landed 142 ms after the press updated the screen/);
});

test("a render a key's press set off after it painted is a later render of the release that heads the report, and one in another entry's handlers is not", () => {
  // Space held down from 0 and let go at 200, where the click it made took 120 ms.
  const note = (r: InteractionReport) => r.explanation.notes.find((n) => /^A (second )?React render/.test(n)) ?? '';
  const ring = [input(0, 'keydown', { press: 'Space' }), input(200, 'keyup', { press: 'Space', gestureTs: 0 }), input(200.5, 'click', { gestureTs: 0 })];
  const held = commit(100, 0, { inputType: 'keydown', rendered: 400, total: 60 });
  // One the keydown's handlers made is inside its entry, before any paint.
  const handlers = commit(5, 0, { inputType: 'keydown', total: 40 });
  const clicked = report([entry('keydown', 0, 24, 1, 10), entry('click', 200, 120, 201, 300)], [handlers, held], [], ring);
  assert.deepEqual(clicked.commits, []);
  assert.deepEqual(clicked.followUps.map((c) => c.at), [100]);
  assert.match(note(clicked), /^A React render landed 76 ms after the press updated the screen, before the release: 60 ms .* INP doesn't count it/);
  // Where the click rendered too, the press's render still reads as the one before it, not a second after it.
  const own = commit(290, 200.5, { gestureTs: 0, rendered: 900, total: 80 });
  const both = report([entry('keydown', 0, 24, 1, 10), entry('click', 200, 120, 201, 300)], [held, own], [], ring);
  assert.deepEqual(both.commits.map((c) => c.at), [290]);
  assert.match(note(both), /^A React render landed 76 ms after the press updated the screen, before the release: 60 ms /);
  // Past the keydown's paint as its duration rounds it, but still in its handlers, which ended at 26.
  const rounded = commit(25.5, 0, { inputType: 'keydown', total: 40 });
  assert.deepEqual(buildReport([entry('keydown', 0, 24, 1, 26), entry('click', 200, 120, 201, 300)], [rounded], [], ring).followUps, []);
  // Within a millisecond of that paint INP timed it as the keydown's, so it is not a later render INP left
  // out: kept, its note dropped "INP doesn't count it", as though it had.
  const atPaint = commit(24.5, 0, { inputType: 'keydown', rendered: 400, total: 60 });
  assert.deepEqual(buildReport([entry('keydown', 0, 24, 1, 10), entry('click', 200, 120, 201, 300)], [atPaint], [], ring).followUps, []);
  // The keyup's handlers made one after the keydown painted, and it is inside the keyup's entry: it is left
  // out of the report, as the keydown's own is.
  const slowUp = [input(0, 'keydown', { press: 'Space' }), input(200, 'keyup', { press: 'Space', gestureTs: 0 }), input(230, 'click', { gestureTs: 0 })];
  const released = commit(210, 200, { inputType: 'keyup', gestureTs: 0, total: 40 });
  const entries = [entry('keydown', 0, 24, 1, 10), entry('keyup', 200, 40, 201, 230), entry('click', 230, 120, 231, 330)];
  assert.deepEqual(buildReport(entries, [released], [], slowUp).followUps, []);
  // The click Enter made comes in its keydown's task, and a render stamped with it is the key's as well.
  const enter = [input(0, 'keydown', { press: 'Enter' }), input(1, 'click', { gestureTs: 0 }), input(300, 'keyup', { press: 'Enter', gestureTs: 0 })];
  const keyed = [entry('keydown', 0, 24, 1, 10), entry('keyup', 300, 48, 301, 340)];
  const fromClick = commit(150, 1, { gestureTs: 0, rendered: 400, total: 60 });
  assert.deepEqual(buildReport(keyed, [fromClick], [], enter).followUps.map((c) => c.at), [150]);
  // The ring holds the last eight inputs. Where the keydown has left it, a render stamped with the keydown is
  // still a key's.
  const gone = [input(300, 'keyup', { press: 'KeyA', gestureTs: 0 })];
  assert.deepEqual(buildReport(keyed, [commit(150, 0, { inputType: 'keydown', rendered: 400, total: 60 })], [], gone).followUps.map((c) => c.at), [150]);
});

test("a render a held pointer's press set off before the click is left out of the report, whether the press sent an entry or not", () => {
  // A sortable list dragged from 0 and dropped at 800. The hook stamps each move's render with the pointerdown
  // wherever it cannot tell a move from its press (React 18 and 19.0, a production build, touch), and nothing
  // tells those renders from one the press set off. Kept as later renders once the pointerdown's entry had
  // painted, they read "A React render landed 84 ms after the press updated the screen, before the release"
  // and published a quiet drop. They are left out, as 0.16.0 had them, with the press's entry or without.
  const note = (r: InteractionReport) => r.explanation.notes.find((n) => /^A (second )?React render/.test(n)) ?? '';
  const mouse = { pointerType: 'mouse', press: 1 };
  const ring = [input(0, 'pointerdown', mouse), input(800, 'pointerup', { ...mouse, gestureTs: 0 }), input(800.3, 'click', { ...mouse, gestureTs: 0 })];
  const moved = { inputType: 'pointerdown', inDispatch: false, hasDurations: false, total: 0, rendered: 60, roots: ['SortableList'], hotPath: ['SortableList'] };
  const moves = [100, 300, 500, 700].map((at) => commit(at, 0, { ...moved, components: [{ name: 'SortableItem', count: 60, self: null, total: null }] }));
  const drop = entry('click', 800.3, 32, 801, 810);
  for (const pressed of [[], [entry('pointerdown', 0, 16, 1, 4)], [entry('pointerdown', 0, 24, 1, 10)]]) {
    const r = report([...pressed, drop], moves, [], ring);
    assert.equal(r.type, 'click');
    assert.deepEqual(r.commits, []);
    assert.deepEqual(r.followUps, []);
    assert.equal(note(r), '');
  }
  // A render the press did set off while the pointer was held goes with them, and the click's own render is
  // the report's.
  const held = [input(0, 'pointerdown', mouse), input(200, 'pointerup', { ...mouse, gestureTs: 0 }), input(200.5, 'click', { ...mouse, gestureTs: 0 })];
  const pressed = commit(100, 0, { inputType: 'pointerdown', rendered: 400, total: 60 });
  const own = commit(290, 200.5, { gestureTs: 0, rendered: 900, total: 80 });
  const slow = report([entry('pointerdown', 0, 24, 1, 10), entry('click', 200, 120, 201, 300)], [pressed, own], [], held);
  assert.deepEqual(slow.commits.map((c) => c.at), [290]);
  assert.deepEqual(slow.followUps, []);
  assert.equal(note(slow), '');
  const alone = report([entry('pointerdown', 0, 24, 1, 10), entry('click', 200, 120, 201, 300)], [pressed], [], held);
  assert.deepEqual(alone.followUps, []);
  assert.match(alone.explanation.cause, /; React didn't render anything\.$/);
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

test('a render stamped with a release is attached to nothing when another press came between that release and its own press', () => {
  // Keys rolled over: B went down at 50, before A came up at 80. The results list rendered outside any
  // dispatch, stamped with the newest input, A's keyup, and joined A's report as its later render, while B,
  // whose keystroke it showed, held nothing. No input came after all of A's own, so nothing closed it.
  const keyA = [entry('keydown', 0, 40, 1, 20)];
  const rollover = [input(0, 'keydown', { press: 'KeyA' }), input(50, 'keydown', { press: 'KeyB' }), input(80, 'keyup', { press: 'KeyA', gestureTs: 0 })];
  const results = commit(110, 80, { inputType: 'keyup', gestureTs: 0, inDispatch: false, rendered: 400, total: 60 });
  assert.equal(isLaterRender(buildReport(keyA, [], [], rollover), results, rollover), false);
  assert.deepEqual(buildReport(keyA, [results], [], rollover).followUps, []);
  // Shift+click with Shift let go after the click: the click's data render was stamped with Shift's keyup.
  const mouse = { pointerType: 'mouse', press: 1 };
  const shiftClick = [
    input(0, 'keydown', { press: 'ShiftLeft' }),
    input(500, 'pointerdown', mouse),
    input(510, 'pointerup', { ...mouse, gestureTs: 500 }),
    input(510.5, 'click', { ...mouse, gestureTs: 500 }),
    input(600, 'keyup', { press: 'ShiftLeft', gestureTs: 0 }),
  ];
  const shift = [entry('keydown', 0, 48, 1, 30)];
  const data = commit(800, 600, { inputType: 'keyup', gestureTs: 0, inDispatch: false, rendered: 400, total: 60 });
  assert.equal(isLaterRender(buildReport(shift, [], [], shiftClick), data, shiftClick), false);
  assert.deepEqual(buildReport(shift, [data], [], shiftClick).followUps, []);
  // A click is a press in between as well: the mouse went down before the key and was let go before it came up.
  const clickBetween = [
    input(-10, 'pointerdown', mouse),
    input(0, 'keydown', { press: 'KeyA' }),
    input(40, 'pointerup', { ...mouse, gestureTs: -10 }),
    input(40.5, 'click', { ...mouse, gestureTs: -10 }),
    input(80, 'keyup', { press: 'KeyA', gestureTs: 0 }),
  ];
  assert.equal(isLaterRender(buildReport(keyA, [], [], clickBetween), results, clickBetween), false);
  // A pointer let go the same way, with a key gone down while it was held.
  const alt = [input(0, 'pointerdown', mouse), input(100, 'keydown', { press: 'AltLeft' }), input(600, 'pointerup', { ...mouse, gestureTs: 0 })];
  const released = commit(900, 600, { inputType: 'pointerup', gestureTs: 0, inDispatch: false, rendered: 400, total: 60 });
  assert.equal(isLaterRender(buildReport([entry('pointerdown', 0, 24, 1, 10)], [], [], alt), released, alt), false);
  // With nothing else pressed in between, the keyup's render is still the key's, and so is one React made
  // inside the keyup's own dispatch, whoever went down before it.
  const alone = [input(0, 'keydown', { press: 'KeyA' }), input(80, 'keyup', { press: 'KeyA', gestureTs: 0 })];
  assert.deepEqual(buildReport(keyA, [results], [], alone).followUps.map((c) => c.at), [110]);
  assert.deepEqual(buildReport(keyA, [{ ...results, inDispatch: true }], [], rollover).followUps.map((c) => c.at), [110]);
  // The click Enter makes comes between its keydown and its keyup, and it is the key's own.
  const enter = [input(0, 'keydown', { press: 'Enter' }), input(0.5, 'click', { gestureTs: 0, press: -1 }), input(80, 'keyup', { press: 'Enter', gestureTs: 0 })];
  assert.deepEqual(buildReport(keyA, [results], [], enter).followUps.map((c) => c.at), [110]);
  // A click's render after a pointer held down through a key press keeps its report as well.
  const through = [
    input(0, 'pointerdown', mouse),
    input(100, 'keydown', { press: 'KeyA' }),
    input(150, 'keyup', { press: 'KeyA', gestureTs: 100 }),
    input(600, 'pointerup', { ...mouse, gestureTs: 0 }),
    input(600, 'click', { ...mouse, gestureTs: 0 }),
  ];
  const held = [entry('pointerdown', 0, 24, 1, 10)];
  assert.equal(isLaterRender(buildReport(held, [], [], through), commit(900, 600, { gestureTs: 0, total: 40 }), through), true);
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
  // React's own durations, for a commit joined by the click's stamp and walked in full. It committed at 95, since a
  // 90 ms render ends no sooner than 90 ms after the handlers began.
  assert.equal(blame([commit(95, 0, { total: 90 })]), 'render measured');
  assert.equal(blame([commit(50, 0, { total: 2 })]), 'handler measured');
  // The same render judged by counts, by overlapping the handlers, or from a walk cut short.
  assert.equal(blame([commit(50, 0, { hasDurations: false, total: 0, rendered: 800 })]), 'render inferred');
  assert.equal(blame([commit(95, 999, { total: 90 })]), 'render inferred');
  assert.equal(blame([commit(95, 0, { total: 90, truncated: true })]), 'render inferred');
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
  const timed = report(tabs, [commit(115, 0, { total: 110, rendered: 181 })], thrash, [input(0, 'click')]);
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
  const rendered = report([entry('click', 0, 425, 0, 210)], [commit(205, 0, { total: 200, rendered: 300 })], []);
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
  const heavy = commit(205, 0, { total: 200, rendered: 300 });
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
    [commit(250, 0, { total: 200, rendered: 300, hydrated: true, hydratedTarget: 'Shell' })],
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
  // The rung it replaces blames one commit. The note sets that commit's render against the working time and gives
  // the render of every commit as their total after it. Summing every commit into the note put 200 ms beside a
  // phrase describing the 80 ms one.
  const r = report(
    [entry('click', 0, 425, 0, 210)],
    [commit(60, 0, { total: 60, rendered: 20 }), commit(125, 0, { total: 60, rendered: 20 }), commit(205, 0, { total: 80, rendered: 300 })],
    [],
  );
  assert.equal(r.explanation.blame.kind, 'painting');
  const note = r.explanation.notes.find((n) => n.startsWith('React still')) ?? '';
  assert.equal(note, 'React still spent 80 ms re-rendering 300 components inside List in the 210 ms of working time before that, and 200 ms of rendering in all across 3 commits.');
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
  const measured = report([entry('click', 0, 200, 5, 105)], [commit(100, 0, { total: 90, rendered: 300 })], []);
  assert.deepEqual(measured.explanation.blame, { kind: 'render', name: 'List', detail: '300 components', ms: 90, confidence: 'measured' });

  // The same shape with long animation frames recorded, where the fall was further: past the screen
  // update to the script the render itself ran inside, which blames the handler for React's work.
  const observed = report(
    [entry('click', 0, 400, 5, 205)],
    [commit(200, 0, { total: 190, rendered: 300 })],
    [frame(0, 400, [script('DIV#root.onclick', 5, 199)])],
  );
  assert.deepEqual(observed.explanation.blame, { kind: 'render', name: 'List', detail: '300 components', ms: 190, confidence: 'measured' });

  // And the screen update still wins where it is longer than everything the working time holds.
  const painted = report([entry('click', 0, 200, 5, 45)], [commit(20, 0, { total: 30, rendered: 300 })], []);
  assert.equal(painted.explanation.blame.kind, 'painting');
  assert.equal(painted.explanation.blame.ms, 155);
});

test('the forced layout sentence says a layout effect only where a commit ran in the script and could have held it', () => {
  const click = [entry('click', 0, 128, 2, 118)];
  const explain = (c: CommitSummary[], scripts: ScriptSummary[], ring = [input(0, 'click')]) => report(click, c, [frame(0, 128, scripts)], ring).explanation;
  const said = (c: CommitSummary[], scripts: ScriptSummary[]) => explain(c, scripts).cause.replace(/^.*\. (That happens)/, '$1');
  const reads = "That happens when code reads an element's size right after changing styles";
  const outsideReact = "code outside React, such as the click handler or a library's listener.";
  const named = { target: element('button', []) as unknown as Node, handler: 'measureThing' };

  // 100 ms of forced layout in React's click listener, where the commit ran too. A development build times
  // the commit and the render: 5 ms each, so at most 10 ms of the layout was React's and the rest was not,
  // and the blame is the script, not the subtree React rendered.
  const root = [script('DIV#root.onclick', 2, 116, 100)];
  const timed = explain([commit(110, 0, { total: 5, startedAt: 100 })], root);
  assert.ok(timed.cause.endsWith(`${reads}. React's commit and render took 10 ms in all, so at most that much of the layout was in React, and the rest in ${outsideReact}`), timed.cause);
  assert.deepEqual([timed.blame.name, timed.blame.detail], ['DIV#root.onclick', null]);
  // So with a 2 ms render and a 2 ms commit.
  assert.deepEqual(explain([commit(110, 0, { total: 2, startedAt: 106 })], root).blame.name, 'DIV#root.onclick');
  // A render too short to say leaves the commit alone in the sentence, and the blame goes to the script by its
  // handler's name where it ran as the handler.
  const bare = explain([commit(110, 0, { total: 0.4, startedAt: 104.6 })], root, [input(0, 'click', named)]);
  assert.ok(
    bare.cause.endsWith(
      `${reads}. React's commit took 5 ms in all, so at most that much of the layout was in a layout effect or a ref callback, and the rest in code outside React, such as the click handler measureThing or a library's listener.`,
    ),
    bare.cause,
  );
  assert.match(bare.cause, /React spent under 1 ms re-rendering/);
  assert.deepEqual([bare.blame.name, bare.blame.detail], ['measureThing', null]);
  // With the commit's useEffect timed, the effects are counted too; two commits are said as two.
  assert.match(
    said([commit(110, 0, { total: 5, startedAt: 100, effectsStartedAt: 108, effectsEndedAt: 110 })], root),
    /React's commit, effects and render took 12 ms in all, so at most that much of the layout was in React, and the rest in code outside React/,
  );
  assert.match(said([commit(60, 0, { total: 1, startedAt: 58 }), commit(110, 0, { total: 1, startedAt: 108 })], root), /React's commits and renders took 4 ms in all/);
  assert.match(said([commit(110, 0, { total: 0.2, startedAt: 109.4 })], root), /React's commit took under 1 ms in all, so at most that much of the layout was in a layout effect/);
  // A render that could have held most of the rest stays in it, and so does its subtree in the blame.
  const long = explain([commit(110, 0, { total: 45, startedAt: 50 })], root);
  assert.ok(long.cause.endsWith(`${reads}. React's commit took 15 ms in all, so at most that much of the layout was in a layout effect or a ref callback, and the rest in React's render or code outside React.`), long.cause);
  assert.deepEqual([long.blame.name, long.blame.detail], ['List', 'Row ×30']);
  // A commit long enough to have held it, or one a production build does not time, leaves the usual line.
  assert.equal(said([commit(110, 0, { total: 5, startedAt: 40 })], root), `${reads}, often in a layout effect.`);
  assert.equal(said([commit(110, 0, { total: 0, hasDurations: false, rendered: 3 })], root), `${reads}, often in a layout effect.`);
  // So does a commit stamped at the very end of React's listener, and one on its first tick whose effects, run
  // straight after it, ended inside it (as measured in Chromium, where a trivial click update and a useEffect
  // reading the layout commit on the listener's first tick 7 times in 150).
  assert.equal(said([commit(118, 0, { total: 0, hasDurations: false, rendered: 3 })], root), `${reads}, often in a layout effect.`);
  assert.equal(
    report([entry('click', 0, 70, 2.1, 64.4)], [commit(64.4, 0, { total: 0, hasDurations: false, rendered: 3 })], [frame(0, 70, [script('DIV#root.onclick', 2.1, 62.3, 60)])], [
      input(0, 'click'),
    ]).explanation.cause.replace(/^.*\. (That happens)/, '$1'),
    `${reads}, often in a layout effect.`,
  );
  for (const effectsEndedAt of [2.1, 118]) {
    assert.equal(said([commit(2, 0, { total: 0, hasDurations: false, rendered: 3, effectsStartedAt: 2, effectsEndedAt })], root), `${reads}, often in a layout effect.`);
  }
  // Chromium rounds an entry's duration to 8 ms, so where the screen updated soon after the handlers, the start and
  // the duration can add up to less than their end (746.3 + 64 against 810.9, measured on Space). A development
  // build's commit stamped at the listener's end is timed all the same.
  const rounded = report(
    [entry('click', 746.3, 64, 747, 810.9)],
    [commit(810.9, 746.3, { total: 0.05, startedAt: 810.8, rendered: 3, components: [{ name: 'Row', count: 3, self: 0.05, total: 0.05 }] })],
    [frame(746.3, 66, [script('DIV#root.onclick', 747, 63.9, 62.8)])],
    [input(746.3, 'click', named)],
  ).explanation;
  assert.ok(
    rounded.cause.endsWith(
      `${reads}. React's commit took under 1 ms in all, so at most that much of the layout was in a layout effect or a ref callback, and the rest in code outside React, such as the click handler measureThing or a library's listener.`,
    ),
    rounded.cause,
  );
  assert.deepEqual([rounded.blame.name, rounded.blame.detail], ['measureThing', null]);
  // On the 0.1 ms clock a tiny commit can begin and end on the same step, and is timed all the same.
  const oneStep = report(
    [entry('click', 746.3, 72, 747, 810.9)],
    [commit(800, 746.3, { total: 0.05, startedAt: 800, rendered: 3, components: [{ name: 'Row', count: 3, self: 0.05, total: 0.05 }] })],
    [frame(746.3, 72, [script('DIV#root.onclick', 747, 63.9, 62.8)])],
    [input(746.3, 'click', named)],
  ).explanation;
  assert.match(oneStep.cause, /React's commit took under 1 ms in all/);
  assert.deepEqual([oneStep.blame.name, oneStep.blame.detail], ['measureThing', null]);

  // The layout charged to a listener no commit ran in, React's own script holding the commit and forcing
  // nothing: in no layout effect, in any build, however long React's commit took. The blame is the
  // listener, not the subtree the commit rendered, and not the handler, which ran in React's listener.
  const beside = [script('DIV#root.onclick', 2, 18), script('DOCUMENT.onclick', 20, 98, 90)];
  const measureThing = "code outside React, such as the click handler measureThing or a library's listener.";
  for (const c of [commit(18, 0, { total: 5, startedAt: 4 }), commit(18, 0, { total: 0, hasDurations: false, rendered: 30 })]) {
    for (const [ring, where] of [
      [[input(0, 'click')], outsideReact],
      [[input(0, 'click', named)], measureThing],
    ] as const) {
      const e = explain([c], beside, ring);
      assert.equal(e.blame.kind, 'layout');
      assert.match(e.cause, / It was charged to DOCUMENT\.onclick\./);
      assert.ok(e.cause.endsWith(`${reads}. No React commit ran in the script it was charged to, so it was not in a layout effect but in ${where}`), e.cause);
      assert.deepEqual([e.blame.name, e.blame.detail], ['DOCUMENT.onclick', null]);
    }
  }
  // React's commit stamped at the very end of its listener is that listener's, not the one that starts right after.
  const tail = explain([commit(17.5, 0, { total: 0, hasDurations: false, rendered: 30 })], [script('DIV#root.onclick', 2, 16), script('DOCUMENT.onclick', 18, 98, 90)]);
  assert.match(tail.cause, /No React commit ran in the script it was charged to/);
  assert.equal(tail.blame.name, 'DOCUMENT.onclick');
  // Long Animation Frames lists only scripts over 5 ms, so a short React listener can be missing. Its commit,
  // stamped just before the listener that forced the layout starts, or on the same tick, is in no script listed,
  // not in that one, and being in the click's handlers, it says React's listener may have run there, so the
  // script is named by what ran it, in any build.
  for (const [at, c] of [
    [4.8, { total: 1, startedAt: 3 }],
    [4.8, { total: 0, hasDurations: false, rendered: 3 }],
    [4, { total: 1, startedAt: 3 }],
    [5.2, { total: 0, hasDurations: false, rendered: 3 }],
    [5.2, { total: 0, hasDurations: false, rendered: 3, effectsStartedAt: 5.2, effectsEndedAt: 5.2 }],
    [5.2, { total: 0, hasDurations: false, rendered: 3, effectsStartedAt: 119, effectsEndedAt: 121 }],
  ] as const) {
    const e = explain([commit(at, 0, c)], [script('DOCUMENT.onclick', 5.2, 112.8, 90)], [input(0, 'click', named)]);
    assert.ok(e.cause.endsWith(`${reads}. No React commit ran in the script it was charged to, so it was not in a layout effect but in ${measureThing}`), e.cause);
    assert.deepEqual([e.blame.name, e.blame.detail], ['DOCUMENT.onclick', null]);
  }
  // Nor in the one that ended just before it. As timed in Chromium: a library's capture listener forced the layout,
  // and React's listener, too short to be listed, ran after it, its commit stamped 0.1 to 0.4 ms after the capture
  // listener ended, where its own microtask did.
  for (const c of [
    commit(57.3, 0, { total: 0, hasDurations: false, rendered: 3 }),
    commit(57.3, 0, { total: 0.1, startedAt: 57.1 }),
    commit(57, 0, { total: 0, hasDurations: false, rendered: 3, effectsStartedAt: 57, effectsEndedAt: 57 }),
  ]) {
    const e = report([entry('click', 0, 68, 2, 59.8)], [c], [frame(0, 68, [script('DOCUMENT.onclick', 2, 54.9, 54.7)])], [input(0, 'click', named)]).explanation;
    assert.ok(e.cause.endsWith(`${reads}. No React commit ran in the script it was charged to, so it was not in a layout effect but in ${measureThing}`), e.cause);
    assert.deepEqual([e.blame.name, e.blame.detail], ['DOCUMENT.onclick', null]);
  }
  // Nothing tells React's listener from a library's that set state: here React's own listener measured and set
  // nothing, and a click-outside listener too short to be listed closed a menu, as late as the click's last
  // handler. The sentence keeps the handler, and the blame names the script by what ran it.
  for (const at of [111.5, 118]) {
    const e = explain([commit(at, 0, { total: 0, hasDurations: false, rendered: 3 })], [script('DIV#root.onclick', 2, 108, 90)], [input(0, 'click', named)]);
    assert.ok(e.cause.endsWith(`${reads}. No React commit ran in the script it was charged to, so it was not in a layout effect but in ${measureThing}`), e.cause);
    assert.deepEqual([e.blame.name, e.blame.detail], ['DIV#root.onclick', null]);
  }
  // So where both committed: React's listener, and a library's on another root that forced the layout.
  const both = explain(
    [commit(9, 0, { total: 1, startedAt: 7 }), commit(117, 0, { total: 1, startedAt: 115 })],
    [script('DIV#root.onclick', 2, 8), script('DOCUMENT.onclick', 10.2, 107.8, 90)],
    [input(0, 'click', named)],
  );
  assert.match(both.cause, /and the rest in code outside React, such as the click handler measureThing or a library's listener\.$/);
  assert.deepEqual([both.blame.name, both.blame.detail], ['DOCUMENT.onclick', null]);
  // A commit in another event's handlers says nothing of where this one's ran: React's pointerup listener
  // committed, and its click listener read the layout and set no state.
  const pointerup = report(
    [entry('pointerup', 0, 128, 2, 10), entry('click', 0, 128, 10, 118)],
    [commit(9, 0, { startedAt: 7.5 })],
    [frame(0, 128, [script('DIV#root.onpointerup', 2, 8), script('DIV#root.onclick', 10, 108, 90)])],
    [input(0, 'pointerup'), input(0, 'click')],
  ).explanation;
  assert.ok(pointerup.cause.endsWith(`${reads}. No React commit ran in the script it was charged to, so it was not in a layout effect but in ${outsideReact}`), pointerup.cause);
  // And a commit in a later event's handlers says nothing of where an earlier one's listener ran.
  const later = report(
    [entry('pointerup', 0, 128, 2, 100), entry('click', 0, 128, 100, 118)],
    [commit(110, 0, { total: 0, hasDurations: false, rendered: 3 })],
    [frame(0, 128, [script('DIV#root.onpointerup', 2, 98, 90)])],
    [input(0, 'pointerup', named), input(0, 'click', named)],
  ).explanation;
  assert.deepEqual([later.blame.name, later.blame.detail], ['measureThing', null]);
  // Nor does one a script in the pointerup's handlers sat beside, where the click's listener held the layout: the
  // blame is the click's handler, whatever ran around the pointerup's commit. Entries in any order.
  const [up, clicked] = [entry('pointerup', 0, 128, 2, 20), entry('click', 0, 128, 20, 118)];
  for (const entries of [[up, clicked], [clicked, up]]) {
    for (const start of [20, 20.1]) {
      const e = report(
        entries,
        [commit(9, 0, { startedAt: 7.5 }), commit(20, 0, { total: 0.2, startedAt: 19.6 })],
        [frame(0, 128, [script('DOCUMENT.onpointerup', 10, 8, 5), script('DIV#root.onclick', start, 118 - start, 85)])],
        [input(0, 'pointerup', named), input(0, 'click', named)],
      ).explanation;
      assert.deepEqual([e.blame.name, e.blame.detail], ['measureThing', null]);
    }
  }
  // Enter, as Chromium times it: the click is dispatched inside the keypress's handlers, so its entry sits inside
  // the keypress's. React's keypress listener, too short to be listed, committed on the click's first tick, and the
  // click's listener held the layout: that listener is the handler's, whether the click committed too or not. A
  // script in the keypress's own handlers, before the click's, is not the click handler, where the click committed.
  const enter = (click: number, commits: CommitSummary[], scripts: ScriptSummary[], reversed = false) => {
    const entries = [entry('keydown', 0, 70, 2, 2), entry('keypress', 0, 70, 2, 65), entry('click', 0, 70, click, 65)];
    return report(
      reversed ? entries.reverse() : entries,
      commits,
      [frame(0, 70, scripts)],
      [input(0, 'keydown', named), input(0, 'keypress', named), input(0, 'click', named)],
    ).explanation;
  };
  // A development build, where a 0.1 ms render is too short to hold the layout.
  const onKeyPress = commit(2.2, 0, { total: 0.1, startedAt: 2.1 });
  const onClick = commit(65, 0, { total: 0.1, startedAt: 64.8 });
  const clickListener = script('DIV#root.onclick', 2.2, 62.8, 61.7);
  for (const reversed of [false, true]) assert.equal(enter(2.2, [onKeyPress, onClick], [clickListener], reversed).blame.name, 'measureThing');
  assert.equal(enter(2.2, [onKeyPress], [clickListener]).blame.name, 'measureThing');
  // The keydown's handlers end on the tick the keypress's begin, as Chromium times them: a script starting there is
  // the keypress's, whatever order the entries come in.
  for (const reversed of [false, true]) {
    assert.equal(enter(62, [onClick], [script('DIV#root.onkeypress', 2, 59.9, 58)], reversed).blame.name, 'DIV#root.onkeypress');
  }
  // With no keypress listener the click begins on the keypress's first tick. The click is the innermost of the two
  // until its handlers end, so a commit after that, in the keypress's, says nothing of where its listener ran.
  const keypress = [entry('keypress', 0, 70, 2, 65), entry('click', 0, 70, 2, 64)];
  for (const entries of [keypress, [...keypress].reverse()]) {
    const e = report(
      entries,
      [commit(64.5, 0, { total: 0.1, startedAt: 64.3 })],
      [frame(0, 70, [script('DIV#root.onclick', 2, 60, 58)])],
      [input(0, 'keypress', named), input(0, 'click', named)],
    ).explanation;
    assert.deepEqual([e.blame.name, e.blame.detail], ['measureThing', null]);
  }
  // Most of it, not all: the share outside is said as a figure, and no one script holds enough to be named.
  const most = explain([commit(55, 0, { total: 3, startedAt: 50 })], [script('DIV#root.onclick', 2, 58, 20), script('DOCUMENT.onclick', 60, 58, 50)]);
  assert.ok(most.cause.endsWith(`${reads}. 50 ms of it was charged to a script no React commit ran in, so that was not in a layout effect but in ${outsideReact}`), most.cause);
  assert.equal(most.blame.name, null);
  // Where the part React's script holds rounds away, the figure is not the whole total again.
  for (const [inside, outside] of [
    [0.4, 99.7],
    [0.6, 99.5],
  ]) {
    assert.match(
      explain([commit(18, 0, { total: 5, startedAt: 4 })], [script('DIV#root.onclick', 2, 18, inside), script('DOCUMENT.onclick', 20, 98, outside)]).cause,
      /\. All but under 1 ms of it was charged to a script no React commit ran in, so that was not in a layout effect/,
    );
  }
  // The subtree named is the one the commit in the forcing script rendered, not a heavier one elsewhere.
  const big = commit(35, 0, { total: 30, startedAt: 3, roots: ['Big'], hotPath: ['Big'], components: [{ name: 'BigRow', count: 10, self: 30, total: 30 }] });
  const small = commit(110, 0, { total: 25, startedAt: 80, roots: ['Small'], hotPath: ['Small'], components: [{ name: 'SmallRow', count: 4, self: 25, total: 25 }] });
  const two = explain([big, small], [script('DIV#root.onclick', 2, 38), script('DOCUMENT.onclick', 42, 74, 60)]);
  assert.match(two.cause, /React's commit took 5 ms in all/);
  assert.deepEqual([two.blame.name, two.blame.detail], ['Small', 'SmallRow ×4']);
  // React's scheduler task can hold a render with no commit, a transition's slice, so it is never outside React.
  assert.equal(said([commit(18, 0, { total: 5, startedAt: 4 })], [script('DIV#root.onclick', 2, 18), script('MessagePort.onmessage', 20, 98, 90)]), `${reads}, often in a layout effect.`);
  assert.equal(
    said([commit(17, 0, { total: 0.4, startedAt: 16 })], [script('DIV#root.onclick', 2, 16, 5), script('MessagePort.onmessage', 20, 98, 90)]),
    `${reads}, often in a layout effect.`,
  );
  // React not rendering at all rules it out in any build.
  assert.equal(said([], root), `${reads}. React did not render, so it was ${outsideReact}`);
});

test("the forced layout note puts the layout where the layout rung would, and keeps the usual line after the handlers", () => {
  // The click's handlers ran from 2 to 20; a transition committed at 110 inside React's scheduler task, which
  // forced 55 ms of layout. What its commit took is not counted, since it ran after the handlers.
  const e = report(
    [entry('click', 0, 120, 2, 20)],
    [commit(110, 0, { total: 10, startedAt: 30 })],
    [frame(0, 120, [script('DIV#root.onclick', 2, 18), script('MessagePort.onmessage', 30, 80, 55)])],
    [input(0, 'click')],
  ).explanation;
  const note = e.notes.find((n) => n.startsWith('The browser also spent'));
  assert.ok(note, JSON.stringify(e.notes));
  assert.match(note, /in scripts before the paint\. That happens when code reads an element's size right after changing styles, often in a layout effect\.$/);
  // Inside the handlers, charged to a listener no commit ran in, with a render taking the verdict: the note says so.
  const render = report(
    [entry('click', 0, 128, 2, 118)],
    [commit(78, 0, { total: 70, startedAt: 4 })],
    [frame(0, 128, [script('DIV#root.onclick', 2, 77), script('DOCUMENT.onclick', 80, 36, 20)])],
    [input(0, 'click')],
  ).explanation;
  assert.equal(render.blame.kind, 'render');
  assert.match(render.notes.find((n) => n.startsWith('The browser also spent')) ?? '', /No React commit ran in the script it was charged to, so it was not in a layout effect/);
  // Under half a millisecond after the handlers rounds away and leaves the sentence; more is said as the usual line.
  for (const [after, said] of [
    [0.4, /No React commit ran in the script it was charged to, so it was not in a layout effect/],
    [0.6, /, often in a layout effect\.$/],
  ] as const) {
    const e = report(
      [entry('click', 0, 128, 2, 118)],
      [commit(78, 0, { total: 70, startedAt: 4 })],
      [frame(0, 128, [script('DIV#root.onclick', 2, 77), script('DOCUMENT.onclick', 80, 36, 20), script('MessagePort.onmessage', 119, 6, after)])],
      [input(0, 'click')],
    ).explanation;
    assert.match(e.notes.find((n) => n.startsWith('The browser also spent')) ?? '', said);
  }
  // Split between a listener inside the handlers and React's scheduler task after them, where a transition
  // committed: a sentence about the part inside would be read as about all of it, so the note says the usual line.
  const split = report(
    [entry('click', 0, 128, 2, 90)],
    [commit(74, 0, { total: 70, startedAt: 3 }), commit(108, 0, { total: 5, startedAt: 96, roots: ['Panel'] })],
    [frame(0, 128, [script('DIV#root.onclick', 2, 73), script('DOCUMENT.onclick', 76, 14, 12), script('MessagePort.onmessage', 95, 15, 10)])],
    [input(0, 'click')],
  ).explanation;
  assert.equal(split.blame.kind, 'render');
  assert.match(split.notes.find((n) => n.startsWith('The browser also spent')) ?? '', /spent 22 ms recalculating .*, often in a layout effect\.$/);
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
  // Nor does the screen update's note name the next key's handler beside it, as it does beside a verdict that script
  // was kept from: the verdict is the setup's, and the notes are the same with the next key or without it.
  const keys = Array.from({ length: 9 }, (_, i) => script('DIV#root.onkeydown', 1001 + i * 20, 19));
  const typed = (status: 'installed-late' | 'unreadable', next: InputRecord[]) =>
    report(
      [entry('keydown', 1000, 272, 1001, 1180), entry('keyup', 1060, 212, 1181, 1182)],
      [],
      [frame(1000, 272, [...keys, script('DIV#root.onkeydown', 1200, 44)], 1262)],
      [input(1000, 'keydown'), input(1060, 'keyup', { gestureTs: 1000 }), ...next],
      'attributes',
      [],
      undefined,
      status,
    ).explanation;
  for (const status of ['installed-late', 'unreadable'] as const) {
    const alone = typed(status, []);
    assert.equal(alone.notes.length, 1, status);
    assert.deepEqual(typed(status, [input(1100, 'keydown')]), alone, status);
  }
});

test('where React stopped being read partway through an interaction, the note says only what came before is in the report', () => {
  // The page turned its DevTools hook off, or a walk threw, once the commits here were read and before the report
  // was built. The verdict names them, so the note cannot say that nothing React did is in it.
  const click = [entry('click', 0, 120, 3, 100)];
  const notesOf = (r: InteractionReport) => r.explanation.notes.join('\n');
  const stopped = /React stopped being read partway through this click, so only what it did before that is in this report/;
  const inside = report(click, [commit(50, 0)], [], [], 'attributes', [], undefined, 'unreadable');
  assert.match(notesOf(inside), stopped);
  assert.doesNotMatch(notesOf(inside), /nothing React did is in this report/);
  const after = attachLaterRender(buildReport(click, [], [], [], 'attributes', [], undefined, 'unreadable'), commit(400, 0, { total: 40 }), []);
  assert.ok(after);
  assert.match(notesOf(sealReport(after)), stopped);
  // Nor does the cause say that whatever React rendered was not seen, where it holds a render read before that: a
  // production build's 2 components, too few to be the verdict, in 190 ms of working time.
  const two = commit(10, 0, { hasDurations: false, total: 0, rendered: 2, components: [{ name: 'Row', count: 2, self: null, total: null }] });
  const partway = report([entry('click', 0, 200, 1, 191)], [two], [], [input(0, 'click')], 'attributes', [], undefined, 'unreadable').explanation;
  assert.deepEqual(partway.blame, { kind: 'none', name: null, detail: null, ms: null, confidence: 'inferred' });
  assert.equal(partway.cause, 'What React did after it stopped being read is unknown, and the 190 ms of working time cannot be put on the click handler or on a render.');
  assert.match(partway.notes[0]!, stopped);
  // A render that landed after the screen updated says nothing of what React did while the handlers ran, so the
  // verdict stays unknown: counted, the click went to code outside React, which "didn't render anything". Where
  // install() ran too late, nothing React did was read at all, whatever rendered later.
  const later = sealReport(after).explanation;
  assert.deepEqual(later.blame, partway.blame);
  assert.equal(later.cause, 'What React did after it stopped being read is unknown, and the 97 ms of working time cannot be put on the click handler or on a render.');
  const tooLate = sealReport(attachLaterRender(buildReport(click, [], [], [], 'attributes', [], undefined, 'installed-late'), commit(400, 0, { total: 40 }), [])!).explanation;
  assert.deepEqual(tooLate.blame, partway.blame);
  assert.equal(
    tooLate.cause,
    'What React did is unknown: install() ran after react-dom loaded, so whatever it rendered for this click was not seen, and the 97 ms of working time cannot be put on the click handler or on a render.',
  );
  // With nothing read, nothing React did is in it.
  assert.match(notesOf(report(click, [], [], [], 'attributes', [], undefined, 'unreadable')), /^No react-dom on this page is being read, so nothing React did is in this report/m);
});

test('where React stopped being read after the only render it read, in a listener after the handlers, it was read all through them and rendered nothing there', () => {
  // handleSave ran from 20 to 220 ms and set no state, a scroll listener rendered 3 components from 221 to 245 ms,
  // and the page turned its DevTools hook off before the report was built. That render was read once the handlers
  // had ended, so React was read all through them. Taken as unknown, the click was blamed on nothing, and the cause
  // said the render the note names was not seen.
  const click = [entry('click', 0, 280, 20, 220)];
  const save = loginClick('handleSave');
  const scrolled = [commit(245, 0, { total: 20, rendered: 3, startedAt: 221 })];
  const listener = script('DIV.onscroll', 221, 25);
  const stopped = (frames: FrameSummary[]) => report(click, scrolled, frames, save, 'attributes', [], undefined, 'unreadable').explanation;
  const handler = { kind: 'handler', name: 'handleSave', detail: 'SignInPage', ms: 200, confidence: 'inferred' };
  // The verdict is the one React read gives, hedged, since what React did after that is not in the report.
  const framed = stopped([frame(0, 280, [script('BUTTON.onclick', 20, 200), listener])]);
  assert.deepEqual(framed.blame, { ...handler, kind: 'script' });
  assert.equal(framed.cause, "React didn't render anything in the working time; most likely the click handler handleSave ran for 200 ms.");
  assert.match(framed.notes[0]!, /^React stopped being read partway through this click/);
  assert.match(framed.notes[1]!, /DIV\.onscroll \(app\.js\), 25 ms, and React rendered inside it: 20 ms re-rendering 3 components/);
  const read = report(click, scrolled, [frame(0, 280, [script('BUTTON.onclick', 20, 200), listener])], save).explanation.blame;
  assert.deepEqual(read, { ...handler, kind: 'script', confidence: 'measured' });
  // Where no frame recorded the listener handleSave ran in, the handler is named, as it is where React is read.
  const bare = stopped([frame(0, 280, [listener])]);
  assert.deepEqual(bare.blame, handler);
  assert.equal(bare.cause, "The click handler handleSave most likely took about 200 ms; React didn't render anything in the working time.");
  // A layout forced in handleSave is put in code outside React, as it is where React is read, not often in a layout effect.
  const forced = stopped([frame(0, 280, [script('BUTTON.onclick', 20, 200, 150), listener])]);
  assert.deepEqual(forced.blame, { kind: 'layout', name: 'handleSave', detail: null, ms: 150, confidence: 'measured' });
  assert.match(forced.cause, /No React commit ran in the script it was charged to, so it was not in a layout effect but in code outside React, such as the click handler handleSave/);
  // So was it where the render it read ran in React's own task after the handlers, which stays in the working time
  // where the screen update does not outrank it: 20 ms of handleSave read as unknown, and that render as not seen.
  const quick = [entry('click', 0, 72, 10, 30)];
  const scheduled = [commit(38, 0, { total: 3, rendered: 3, startedAt: 35, components: [{ name: 'Row', count: 3, self: 1, total: 1 }] })];
  const task = [frame(0, 72, [script('BUTTON.onclick', 10, 20), script('MessagePort.onmessage', 31, 8)])];
  const inTask = report(quick, scheduled, task, save, 'attributes', [], undefined, 'unreadable').explanation;
  assert.deepEqual(inTask.blame, { kind: 'script', name: 'handleSave', detail: 'SignInPage', ms: 20, confidence: 'inferred' });
  assert.equal(inTask.cause, "React's render was small (re-rendering 3 components inside List, mostly Row (3 of them, 1 ms)); most likely the click handler handleSave ran for 20 ms.");
  assert.deepEqual(report(quick, scheduled, task, save).explanation.blame, { ...inTask.blame, confidence: 'measured' });
  // With no render read, what React did is still unknown.
  const unread = report(click, [], [frame(0, 280, [script('BUTTON.onclick', 20, 200), listener])], save, 'attributes', [], undefined, 'unreadable').explanation;
  assert.deepEqual(unread.blame, { kind: 'none', name: null, detail: null, ms: null, confidence: 'inferred' });
  assert.match(unread.cause, /^What React did is unknown/);
});

test('where React is read and rendered nothing, all of the working time is outside it in any build, so a slow handler is named', () => {
  // A click whose handleSave ran from 2 to 302 ms and set no state. With a 1 ms commit it was the handler's,
  // measured; with none it read as unknown, or as time that went to waiting and painting.
  const click = [entry('click', 0, 320, 2, 302)];
  const save = loginClick('handleSave');
  const handler = { kind: 'handler', name: 'handleSave', detail: 'SignInPage', ms: 300, confidence: 'measured' };
  // A browser without Long Animation Frames, and one that has recorded no frame over the click yet.
  for (const frames of [null, []]) {
    const r = report(click, [], frames, save);
    assert.deepEqual(r.explanation.blame, handler);
    assert.equal(r.explanation.cause, "The click handler handleSave ran for about 300 ms; React didn't render anything.");
  }
  assert.equal(report(click, [], null, [input(0, 'click')]).explanation.cause, "Code outside React (the click handler or other scripts) ran for about 300 ms; React didn't render anything.");
  // So is a page where no react-dom has loaded yet, such as an Astro page before its islands hydrate: React ran nothing.
  assert.deepEqual(report(click, [], null, save, 'attributes', [], undefined, 'waiting').explanation.blame, handler);
  // Where the screen update outranks the working time, the handler is the note it leaves.
  const painted = report([entry('click', 0, 200, 2, 62)], [], null, save);
  assert.equal(painted.explanation.blame.kind, 'painting');
  assert.ok(painted.explanation.notes.includes('The click handler handleSave still ran for all 60 ms of working time before that.'));
  // Where a frame recorded the listener, the browser's own record of the script is named, as before.
  assert.deepEqual(report(click, [], [frame(0, 320, [script('BUTTON.onclick', 2, 300)])], save).explanation.blame, { ...handler, kind: 'script' });
  // A frame that ended as the handlers began records only what the click waited behind: a 30 ms timer, then a 45 ms
  // handleSave in a frame under 50 ms, which no entry reports. The handler is still named, as it is before that
  // frame arrives and beside a 1 ms render.
  const saved = [entry('click', 0, 78, 30, 75)];
  const timer = [frame(-60, 90, [script('TimerHandler:setTimeout', -58, 88)])];
  for (const frames of [timer, [], null]) assert.deepEqual(report(saved, [], frames, save).explanation.blame, { ...handler, ms: 45 });
  assert.equal(report(saved, [commit(74, 0, { total: 1, rendered: 1 })], timer, save).explanation.blame.kind, 'handler');
  // A frame over the handlers that lists no script of 20 ms or more says nothing of what ran in them, so the handler
  // is still named there rather than the time going to waiting and painting: three listeners of 15 ms each, and the
  // 300 ms handleSave in a frame that lists no script at all.
  const listeners = [frame(0, 60, [script('DOCUMENT.onclick', 2, 15), script('DOCUMENT.onclick', 17, 15), script('WINDOW.onclick', 32, 15)])];
  const heard = report([entry('click', 0, 64, 2, 47)], [], listeners, save);
  assert.deepEqual(heard.explanation.blame, { ...handler, ms: 45 });
  assert.equal(heard.explanation.cause, "The click handler handleSave ran for about 45 ms; React didn't render anything.");
  assert.deepEqual(report(click, [], [frame(0, 318, [])], save).explanation.blame, handler);
  // Where React is not read, or rendered in commits that could not be tied to the click, its time is unknown.
  assert.equal(report(click, [], null, save, 'attributes', [], undefined, 'installed-late').explanation.blame.kind, 'none');
  const unjoinable = [{ ...save[0]!, work: { endedAt: 0, unjoined: [50] } }];
  assert.deepEqual(report(click, [], null, unjoinable).explanation.blame, { kind: 'none', name: null, detail: null, ms: null, confidence: 'inferred' });
  // Nor is a click React never dispatched, on server-rendered HTML it had not hydrated yet: the handler named is a
  // hydrated component's above the boundary, which never ran, and the working time can be React's own attempt at
  // hydrating it.
  const undispatched = [input(0, 'click', { ...save[0]!, dehydrated: { scope: 'boundary', owner: 'ProductPage' } })];
  const blocked = report(click, [], null, undispatched);
  assert.deepEqual(blocked.explanation.blame, { kind: 'none', name: null, detail: null, ms: null, confidence: 'inferred' });
  assert.equal(
    blocked.explanation.cause,
    "This click landed on server-rendered HTML that React had not hydrated yet, so React did not dispatch it and no React handler ran for it. React didn't render anything; this browser does not report long tasks, so what ran instead is unknown.",
  );
  assert.doesNotMatch(report(click, [], [], undispatched).explanation.cause, /handleSave/);
  // And a handler short of the bar is still nobody's.
  assert.equal(report([entry('click', 0, 40, 5, 20)], [], [], save).explanation.blame.kind, 'none');
});

test('a click whose only render ran after the handlers is weighed as one React rendered nothing for, and a listener the note names after them leaves the handlers the verdict', () => {
  // handleSave ran from 2 to 62 ms and set no state, then React's own task rendered from 64 to 144 ms in a 138 ms
  // screen update. That render is the task's, said with it, so React rendered nothing in the working time.
  const click = [entry('click', 0, 200, 2, 62)];
  const save = loginClick('handleSave');
  const task = [frame(62, 138, [script('MessagePort.onmessage', 64, 80)], 150)];
  const handled = 'The click handler handleSave still ran for all 60 ms of working time before that.';
  // The handler is the note the screen update leaves, as it is with no render at all and in a development build.
  // A production build, which times no render, left it out.
  const rows = { hasDurations: false, total: 0, priority: 3, components: [{ name: 'Row', count: 30, self: null, total: null }] };
  const production = report(click, [commit(140, 0, rows)], task, save).explanation;
  assert.equal(production.blame.kind, 'painting');
  assert.match(production.cause, /MessagePort\.onmessage.*React rendered inside it: re-rendering 30 components/);
  assert.deepEqual(production.notes, [handled]);
  assert.deepEqual(report(click, [commit(140, 0, { total: 40, startedAt: 70, priority: 3 })], task, save).explanation.notes, [handled]);
  assert.deepEqual(report(click, [], task, save).explanation.notes, [handled]);

  // 200 ms of click handlers, none of which ran for 20 ms, then a 40 ms scroll listener in a 157 ms screen update
  // that went mostly on style and layout. The listener ran outside the working time and the note names it, so it
  // does not take the handlers' verdict, with a render inside it or none: that read as waiting and painting, where
  // a 1 ms render in the working time left the verdict to the handler.
  const tenClicks = Array.from({ length: 10 }, (_, i) => script('BUTTON.onclick', 3 + i * 20, 15));
  const listened = (commits: CommitSummary[], onscroll = 40, styleAndLayoutStart = 250) =>
    report([entry('click', 0, 360, 3, 203)], commits, [frame(0, 360, [...tenClicks, script('DIV.onscroll', 205, onscroll)], styleAndLayoutStart)], save)
      .explanation;
  const handler = { kind: 'handler', name: 'handleSave', detail: 'SignInPage', ms: 200, confidence: 'measured' };
  const table = { total: 25, rendered: 721, roots: ['TableBody'], hotPath: ['TableBody'], startedAt: 210 };
  const none = listened([]);
  assert.deepEqual(none.blame, handler);
  assert.equal(none.cause, "The click handler handleSave ran for about 200 ms; React didn't render anything.");
  for (const rendered of [table, { ...table, hasDurations: false, total: 0, startedAt: null }]) {
    const r = listened([commit(240, 0, rendered)]);
    assert.deepEqual(r.blame, handler);
    // React did render, inside the listener, which the note says.
    assert.equal(r.cause, "The click handler handleSave ran for about 200 ms; React didn't render anything in the working time.");
    assert.match(r.notes[0]!, /DIV\.onscroll \(app\.js\), 40 ms, and React rendered inside it: /);
  }
  assert.deepEqual(listened([commit(150, 0, { total: 1, rendered: 2 })]).blame, { ...handler, ms: 199 });
  // A listener that held half of the screen update is still the verdict's, with a render inside it in a development
  // build as with none.
  for (const commits of [[], [commit(270, 0, table)]]) {
    assert.deepEqual(listened(commits, 80, 290).blame, { kind: 'script', name: 'DIV.onscroll', detail: null, ms: 80, confidence: 'measured' });
  }
  // One under half of it leaves the handlers the verdict where the screen update is 100 ms or under too, which no
  // note names it in: 110 ms of short handlers before a 30 ms timer went to the timer under a 99 ms screen update,
  // and to handleSave under a 104 ms one, or beside a 1 ms render.
  const sevenClicks = Array.from({ length: 7 }, (_, i) => script('BUTTON.onclick', 3 + i * 15, 12));
  const timed = (paint: number, commits: CommitSummary[] = []) =>
    report([entry('click', 0, 112 + paint, 2, 112)], commits, [frame(0, 112 + paint, [...sevenClicks, script('TimerHandler:setTimeout', 115, 30)], 92 + paint)], save).explanation;
  const unnoted = timed(99);
  assert.deepEqual(unnoted.blame, { ...handler, ms: 110 });
  assert.equal(unnoted.cause, "The click handler handleSave ran for about 110 ms; React didn't render anything.");
  assert.deepEqual(unnoted.notes, []);
  assert.deepEqual(timed(104).blame, unnoted.blame);
  assert.deepEqual(timed(99, [commit(100, 0, { total: 1, rendered: 1 })]).blame, { ...handler, ms: 109 });
  // Where the frame names a 25 ms timer the click waited behind, which takes the verdict from the handlers, it is that
  // timer's under either screen update, and not the 30 ms one after them: under 99 ms the later one was named.
  const waitedTimed = (paint: number) =>
    report(
      [entry('click', 0, 140 + paint, 30, 140)],
      [],
      [frame(0, 140 + paint, [script('TimerHandler:setTimeout', 3, 25), ...sevenClicks.map((s) => ({ ...s, start: s.start + 28 })), script('TimerHandler:setTimeout', 143, 30)], 120 + paint)],
      save,
    ).explanation;
  const first = waitedTimed(99);
  assert.deepEqual(first.blame, { kind: 'script', name: 'TimerHandler:setTimeout', detail: null, ms: 25, confidence: 'measured' });
  assert.equal(first.cause, "React didn't render anything; a script (TimerHandler:setTimeout, app.js) ran for 25 ms before the handler started.");
  assert.deepEqual([waitedTimed(104).blame, waitedTimed(104).cause], [first.blame, first.cause]);
  // The 30 ms timer the verdict passed over is still said, in the screen update's note, under 99 ms as under 104.
  for (const paint of [99, 104]) {
    assert.match(waitedTimed(paint).notes[0]!, /^After the handler finished, the screen took another \d+ ms to update: .* The longest script the browser recorded in that time was TimerHandler:setTimeout \(app\.js\), 30 ms\.$/, `${paint} ms`);
  }
  // So is a 49 ms timer after an idle click's handlers, where their 22 ms script takes the verdict under a 100 ms
  // screen update: the timer was said nowhere.
  const saving = [script('BUTTON.onclick', 2, 22), ...Array.from({ length: 6 }, (_, i) => script('BUTTON.onclick', 26 + i * 13, 12)), script('TimerHandler:setTimeout', 104, 49)];
  const passedOver = report([entry('click', 0, 202, 2, 102)], [], [frame(0, 202, saving)], save).explanation;
  assert.deepEqual(passedOver.blame, { ...handler, kind: 'script', ms: 22 });
  assert.equal(passedOver.cause, "React didn't render anything; the click handler handleSave ran for 22 ms.");
  assert.deepEqual(passedOver.notes, [
    "After the handler finished, the screen took another 100 ms to update: 50 ms of it was the browser's own work on the main thread, most likely recalculating styles and layout for what changed. The longest script the browser recorded in that time was TimerHandler:setTimeout (app.js), 49 ms.",
  ]);
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
  const r = report([entry('click', 0, 120, 3, 100)], [commit(95, 0, { hydrated: true, total: 90 })], []);
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
  const hydration = commit(95, 0, { hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' }, rendered: 40, total: 90 });
  const r = report([entry('click', 0, 120, 3, 100)], [hydration], []);

  assert.deepEqual(r.hydration, { kind: 'waited', scope: 'boundary', owner: 'ProductPage', ms: 90 });
  assert.equal(r.explanation.cause, 'The click landed on server-rendered HTML that had not been hydrated yet, so React hydrated the Suspense boundary in ProductPage first: 90 ms of the 97 ms of working time.');
  assert.deepEqual(r.explanation.blame, { kind: 'hydration', name: 'the Suspense boundary in ProductPage', detail: 'Row ×30', ms: 90, confidence: 'measured' });
  // The blame is named after the boundary, which holds every component hydrated, so its detail is the whole
  // count even where the walk's path went below the boundary: "120 of 300" beside "the Suspense boundary in
  // ProductPage" would read as 180 of the boundary's components not having hydrated.
  const deep = commit(95, 0, { ...hydration, rendered: 300, hotPath: ['Reviews', 'ReviewList'], startRendered: 300, pathRendered: 120, components: [{ name: 'Review', count: 100, self: 30, total: 30 }] });
  assert.equal(report([entry('click', 0, 120, 3, 100)], [deep], []).explanation.blame.detail, '300 components');

  // The hydration is a named part of the working time, so the three phases still add up to the interaction.
  const phases = r.explanation.phases;
  assert.deepEqual(phases.map((p) => [p.label, p.ms]), [['Waiting', 3], ['Working', 97], ['Updating the screen', 20]]);
  assert.deepEqual(phases[1]?.parts, [{ label: 'Hydrating', ms: 90, hint: 'React hydrating server-rendered HTML the interaction landed on, before it could be handled.' }]);
});

test('a hydration longer than the working time is said and blamed as all of it, as the phases show it, with its whole figure beside', () => {
  // A 104 ms click whose handlers ran for 20 ms, at the end of which React finished hydrating a boundary it spent 90 ms
  // on in all. The sentence read "90 ms of the 20 ms of working time" beside a Hydrating part of 20, and the blame said 90.
  const hydration = commit(60, 0, { hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' }, total: 90 });
  const r = report([entry('click', 0, 104, 40, 60)], [hydration], [], [input(0, 'click')]);
  assert.equal(r.hydration?.ms, 90);
  const first = 'The click landed on server-rendered HTML that had not been hydrated yet, so React hydrated the Suspense boundary in ProductPage first';
  assert.equal(r.explanation.cause, `${first}: all 20 ms of working time, in a hydration that took 90 ms in all.`);
  assert.deepEqual(r.explanation.blame, { kind: 'hydration', name: 'the Suspense boundary in ProductPage', detail: 'Row ×30', ms: 20, confidence: 'measured' });
  assert.equal(r.explanation.phases[1]?.parts?.[0]?.ms, 20);
  const partial = report([entry('click', 0, 104, 40, 60)], [{ ...hydration, truncated: true }], [], [input(0, 'click')]).explanation;
  assert.equal(partial.cause, `${first}, most likely all 20 ms of working time, in a hydration that took 90 ms in all.`);
  assert.equal(partial.blame.ms, 20);
  // Weighed on the 3 ms of working time it held, it does not take the verdict from a 61 ms screen update, as it did on
  // its 90 ms in all.
  const brief = report([entry('click', 0, 104, 40, 43)], [commit(42, 0, { hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' }, total: 90 })], [], [input(0, 'click')]);
  assert.equal(brief.explanation.blame.kind, 'painting');
});

test('a hydration is weighed on the part of the working time it held, as a render is, and one after the handlers is a note', () => {
  // A 90 ms hydration that began at -35 and committed at 55, 15 ms into 20 ms of handlers. Said as a render it held 15
  // ms of them. Said as a hydration it read "all 20 ms of working time", with 20 blamed and a Hydrating part of 20.
  const click = [entry('click', 0, 104, 40, 60)];
  const begun = { startedAt: -35, total: 90 };
  const boundary = { hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' } } as const;
  const hydrated = report(click, [commit(55, 0, { ...begun, ...boundary })], [], [input(0, 'click')]);
  assert.equal(
    hydrated.explanation.cause,
    'The click landed on server-rendered HTML that had not been hydrated yet, so React hydrated the Suspense boundary in ProductPage first: 15 ms of the 20 ms of working time, in a hydration that took 90 ms in all.',
  );
  assert.equal(hydrated.explanation.blame.ms, 15);
  assert.equal(hydrated.explanation.phases[1]?.parts?.[0]?.ms, 15);
  const render = report(click, [commit(55, 0, begun)], [], [input(0, 'click')]).explanation;
  assert.equal(render.blame.ms, 15);
  assert.match(render.cause, /so at most 15 ms of it was in the 20 ms of working time\.$/);
  // One that began after 17 ms of handlers ended held none of them. It read "all 17 ms of working time".
  const after = report([entry('click', 0, 104, 3, 20)], [commit(95, 0, { startedAt: 22, total: 70, ...boundary })], null, [input(0, 'click')]);
  assert.equal(after.hydration?.ms, 70);
  assert.equal(after.explanation.blame.kind, 'painting');
  assert.equal(after.explanation.phases[1]?.parts, undefined);
  assert.deepEqual(after.explanation.notes, [
    'It landed on server-rendered HTML that had not been hydrated yet, and React hydrated the Suspense boundary in ProductPage during it. That was not what took the time here.',
    'React still spent 70 ms hydrating 30 components inside List, mostly Row (30 of them, 20 ms) after the handlers, before the next frame.',
  ]);
  for (const r of [hydrated, after]) saysWithinTheWorkingTime(r);
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
  const elsewhere = commit(95, 0, { hydrated: true, total: 90 });
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

test('a render blame on the commit that hydrated does not have the note say the hydration was not what took the time', () => {
  // 30 ms of hydrating against 35 ms of code outside React: the boundary alone does not outweigh the
  // rest, so it is not the hydration blame, but React's time as a whole does, and the render blame
  // names the same commit. The note still says the click landed on HTML that had not been hydrated,
  // which the cause does not, and stops there.
  const hydration = commit(40, 0, { hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' }, roots: ['ProductPage'], hotPath: ['ProductPage'] });
  const r = report([entry('click', 0, 96, 2, 77)], [hydration, commit(60, 0, { total: 10, rendered: 12, roots: ['Cart'], hotPath: ['Cart'] })], []);

  assert.deepEqual(r.hydration, { kind: 'waited', scope: 'boundary', owner: 'ProductPage', ms: 30 });
  assert.equal(r.explanation.blame.kind, 'render');
  assert.equal(r.explanation.blame.name, 'ProductPage');
  assert.match(r.explanation.cause, /^React spent 40 ms rendering across 2 commits, 30 ms of it hydrating /);
  assert.ok(r.explanation.notes.includes('It landed on server-rendered HTML that had not been hydrated yet, and React hydrated the Suspense boundary in ProductPage during it.'));
  assert.doesNotMatch(r.verdict, /not what took the time/);
  // The same hydration behind a handler that outlasts it keeps the whole note.
  const alone = report([entry('click', 0, 96, 2, 77)], [hydration], [], loginClick('handleLogin'));
  assert.equal(alone.explanation.blame.kind, 'handler');
  assert.ok(alone.explanation.notes.includes('It landed on server-rendered HTML that had not been hydrated yet, and React hydrated the Suspense boundary in ProductPage during it. That was not what took the time here.'));
});

test('a commit that rendered no component at all is not described as a re-render of none', () => {
  // React commits with nothing rendered: a retry that found the boundary still blocked, which is what
  // a click on HTML React cannot hydrate leaves behind.
  const empty = commit(95, 0, { rendered: 0, components: [], total: 90, roots: ['app'], hotPath: ['app'] });
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

test('a wait that is the verdict is not said again in a note, and one under another verdict still is', () => {
  // A click that waited 200 ms, rendered for 20 ms of its 30 ms of working time, and took 114 ms more to
  // paint. The screen update outranks the working time, so the render is closed off and the wait is the verdict.
  const waited = report([entry('click', 0, 344, 200, 230)], [commit(225, 0, { total: 20 })], []);
  assert.equal(waited.explanation.blame.kind, 'waiting');
  assert.equal(waited.verdict.match(/waited 200 ms/g)?.length, 1);
  assert.doesNotMatch(waited.verdict, /also waited/);
  // The working time is the smallest of the three phases there, so the render is not said after the wait either.
  assert.doesNotMatch(waited.verdict, /still spent/);
  // A render that is the verdict after a 150 ms wait still carries the wait as a note.
  const rendered = report([entry('click', 0, 400, 150, 380)], [commit(370, 0, { total: 200 })], []);
  assert.equal(rendered.explanation.blame.kind, 'render');
  assert.ok(rendered.explanation.notes.includes('It also waited 150 ms before the handler could start, because the main thread was busy.'));
  // So does the screen update, beside the render it outranked. The render comes first, so its "before that" is
  // read as before the screen update rather than before the wait, and the same with a 2 ms render beside the
  // code outside React it left.
  const painted = report([entry('click', 0, 400, 100, 130)], [commit(125, 0, { total: 20 })], []);
  assert.equal(painted.explanation.blame.kind, 'painting');
  assert.deepEqual(painted.explanation.notes, [
    'React still spent 20 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) in the 30 ms of working time before that.',
    'It also waited 100 ms before the handler could start, because the main thread was busy.',
  ]);
  assert.deepEqual(report([entry('click', 0, 400, 100, 130)], [commit(125, 0, { total: 2 })], []).explanation.notes, [
    'Code outside React (the click handler or other scripts) still ran for about 28 ms of the 30 ms of working time before that.',
    'It also waited 100 ms before the handler could start, because the main thread was busy.',
  ]);
  // So does a wait between the handlers, whose sentence is about that wait and not the 60 ms before them.
  const between = report(
    [entry('keydown', 0, 232, 60, 70), entry('click', 0, 232, 70, 70.7), entry('keyup', 1, 232, 220, 220.2)],
    [commit(69, 0, { total: 8, rendered: 5 })],
    [frame(0, 225, [], 220)],
    [input(0, 'keydown')],
  );
  assert.equal(between.explanation.blame.detail, 'between click and keyup');
  assert.ok(between.explanation.notes.includes('It also waited 60 ms before the handler could start, because the main thread was busy.'));
  // And a handler after a 70 ms wait, whatever React rendered: beside a 2 ms render, and none, as beside a 10 ms one.
  const save = loginClick('handleSave');
  for (const commits of [[commit(168, 0, { total: 2 })], [], [commit(168, 0, { total: 10 })]]) {
    for (const frames of [[], null]) {
      const handled = report([entry('click', 0, 176, 70, 170)], commits, frames, save);
      assert.equal(handled.explanation.blame.kind, 'handler');
      assert.ok(handled.explanation.notes.includes('It also waited 70 ms before the handler could start, because the main thread was busy.'));
    }
  }
});

test('a handler, a render or a forced layout shorter than a long wait before the handlers does not take the verdict from it', () => {
  // A 480 ms click that waited 400 ms, then ran handleSave for 58 ms and rendered for 2. Optimising
  // handleSave would barely move it.
  const click = [entry('click', 0, 480, 400, 460)];
  const save = loginClick('handleSave');
  const waited = { kind: 'waiting', name: null, detail: null, ms: 400, confidence: 'measured' };
  for (const frames of [[], null]) {
    const r = report(click, [commit(450, 0, { total: 2 })], frames, save);
    assert.deepEqual(r.explanation.blame, waited);
    assert.equal(r.explanation.cause, 'The click waited 400 ms before its handler could start: the main thread was busy with something else.');
    // What the handler took is still said, after the wait.
    assert.deepEqual(r.explanation.notes, ['The click handler handleSave still ran for about 58 ms of the 60 ms of working time after the wait.']);
  }
  // Where a long animation frame recorded the timer the click waited behind, the timer is named, not the handler after it.
  const behind = [frame(0, 470, [script('TimerHandler:setTimeout', 0, 398), script('BUTTON.onclick', 400, 58)])];
  assert.deepEqual(report(click, [commit(450, 0, { total: 2 })], behind, save).explanation.blame, { ...waited, name: 'TimerHandler:setTimeout' });
  // 50 ms of code outside React beside a 10 ms render, and a 40 ms render, are no more the answer.
  const outside = report(click, [commit(450, 0, { total: 10 })], [], [input(0, 'click')]);
  assert.deepEqual(outside.explanation.blame, waited);
  assert.doesNotMatch(outside.verdict, /also waited/);
  const rendered = report(click, [commit(450, 0, { total: 40 })], []);
  assert.deepEqual(rendered.explanation.blame, waited);
  assert.doesNotMatch(rendered.verdict, /also waited/);
  assert.deepEqual(rendered.explanation.notes, ['React still spent 40 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) in the 60 ms of working time after the wait.']);
  // Nor is a 380 ms render right after a 400 ms wait, though near a tie it is said as much as the wait is.
  const near = report([entry('click', 0, 816, 400, 790)], [commit(785, 0, { total: 380 })], [], save);
  assert.deepEqual(near.explanation.blame, waited);
  assert.deepEqual(near.explanation.notes, ['React still spent 380 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) in the 390 ms of working time after the wait.']);
  // A production build's handler, which it cannot time, steps aside on the same test, where the wait ties the
  // working time and where a keyup handled later in the frame puts time between the handlers, and is said after
  // the wait as a render is. Its sentence is for a count that does not explain the working time: 3 components
  // do not, and 60 of one component do, so there the render is said.
  const counted = (n: number) => ({ hasDurations: false, total: 0, rendered: n, components: [{ name: 'Row', count: n, self: null, total: null }] });
  const tied = (n: number) => report([entry('click', 0, 216, 100, 200)], [commit(190, 0, counted(n))], [], save);
  assert.deepEqual(tied(3).explanation.blame, { ...waited, ms: 100 });
  assert.deepEqual(tied(3).explanation.notes, ['The click handler handleSave most likely still took the 100 ms of working time after the wait.']);
  assert.deepEqual(tied(60).explanation.blame, { ...waited, ms: 100 });
  assert.deepEqual(tied(60).explanation.notes, ['React was most likely still re-rendering 60 components inside List, mostly Row (60 of them), in the 100 ms of working time after the wait.']);
  const keyed = (n: number) => report([entry('keydown', 0, 192, 90, 150), entry('keyup', 100, 92, 180, 181)], [commit(149, 0, counted(n))], [], [{ ...loginClick('handleKey')[0]!, type: 'keydown' }]);
  assert.deepEqual(keyed(3).explanation.blame, { ...waited, ms: 90 });
  assert.deepEqual(keyed(3).explanation.notes, ['The key press handler handleKey most likely still took about 61 ms of the 91 ms of working time after the wait.']);
  assert.deepEqual(keyed(60).explanation.blame, { ...waited, ms: 90 });
  assert.doesNotMatch(keyed(60).verdict, /handleKey/);
  // The 400 ms wait in a production build says the handler after it too, as the build that times it does.
  assert.deepEqual(report(click, [commit(450, 0, counted(3))], [], save).explanation.notes, ['The click handler handleSave most likely still took the 60 ms of working time after the wait.']);
  // A forced layout steps aside on the same test: 55 ms of it in the key press's first 60 ms of handlers, after an
  // 80 ms wait and before a keyup handled 40 ms later. It is still said, in the note on forced layout.
  const layout = report([entry('keydown', 0, 192, 80, 140), entry('keyup', 100, 92, 180, 181)], [], [frame(70, 125, [script('INPUT.onkeydown', 80, 60, 55)])], [input(0, 'keydown')]);
  assert.deepEqual(layout.explanation.blame, { ...waited, ms: 80 });
  assert.match(layout.verdict, /The browser also spent 55 ms recalculating styles and layout in scripts before the paint\./);
  // Where it closed the rung, a production build's handler is not said to have taken the time it did: 160 ms of
  // forced layout in 200 ms of working time after a 200 ms wait read as handleSave taking all 200 ms, then as the
  // browser spending 160 ms of them on styles and layout.
  const forced = report([entry('click', 0, 420, 200, 400)], [commit(395, 0, counted(3))], [frame(-10, 430, [script('BUTTON.onclick', 200, 200, 160)])], save).explanation;
  assert.deepEqual(forced.blame, { ...waited, ms: 200 });
  assert.deepEqual(forced.notes, ["The browser also spent 160 ms recalculating styles and layout in scripts before the paint. That happens when code reads an element's size right after changing styles, often in a layout effect."]);
  // Nor is a render it outran, in either build: 800 rows read as React "still re-rendering" in all 200 ms of the working
  // time, then 160 ms of it went on styles and layout. The rung the wait closed was the layout's, and so is the one a
  // screen update closes, where 15 ms of rendering was said beside 80 ms of layout in 100 ms of working time.
  for (const rendered of [counted(800), { total: 15, rendered: 800 }]) {
    const outrun = report([entry('click', 0, 420, 200, 400)], [commit(395, 0, rendered)], [frame(-10, 430, [script('BUTTON.onclick', 200, 200, 160)])], save).explanation;
    assert.deepEqual(outrun.blame, { ...waited, ms: 200 });
    assert.deepEqual(outrun.notes, forced.notes);
    const painted = report([entry('click', 0, 300, 1, 101)], [commit(99, 0, rendered)], [frame(0, 300, [script('BUTTON.onclick', 1, 100, 80)])], save).explanation;
    assert.equal(painted.blame.kind, 'painting');
    assert.deepEqual(painted.notes, ["The browser also spent 80 ms recalculating styles and layout in scripts before the paint. That happens when code reads an element's size right after changing styles, often in a layout effect."]);
  }
  // A wait shorter than the working time leaves the render its verdict, and one short of a long task
  // leaves the handler its own: a 38 ms handler after 45 ms is not nothing. A wait of 50 ms is not over
  // a long task either.
  assert.equal(report([entry('click', 0, 110, 30, 90)], [commit(80, 0, { total: 40 })], []).explanation.blame.kind, 'render');
  const brief = report([entry('click', 0, 96, 45, 85)], [commit(84, 0, { total: 2 })], [], save);
  assert.deepEqual(brief.explanation.blame, { kind: 'handler', name: 'handleSave', detail: 'SignInPage', ms: 38, confidence: 'measured' });
  assert.equal(report([entry('click', 0, 104, 50, 95)], [commit(94, 0, { total: 2 })], [], save).explanation.blame.kind, 'handler');
  // Nor does it close a forced layout: 40 ms of it in 45 ms of working time after a 48 ms wait is the layout's.
  const briefLayout = report([entry('click', 0, 104, 48, 93)], [], [frame(0, 104, [script('BUTTON.onclick', 48, 45, 40)])], [input(0, 'click')]);
  assert.deepEqual(briefLayout.explanation.blame, { kind: 'layout', name: 'BUTTON.onclick', detail: null, ms: 40, confidence: 'measured' });
});

test('a render a closed verdict does not take is said to have run after the handlers where it committed after them, and in the working time only where it ran there', () => {
  // The click waited 300 ms, ran handleSave for 15, and React rendered for 43 ms in the task after the handlers.
  // The render was said to be 43 ms in the 15 ms of working time, a part larger than the whole.
  const save = loginClick('handleSave');
  const late = report([entry('click', 0, 360, 300, 315)], [commit(358, 0, { total: 43 })], [], save);
  assert.deepEqual(late.explanation.blame, { kind: 'waiting', name: null, detail: null, ms: 300, confidence: 'measured' });
  assert.deepEqual(late.explanation.notes, ['React still spent 43 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) after the handlers, before the next frame.']);
  // The same under a screen update that closed the render's rung, and for a production build's render.
  const painted = report([entry('click', 0, 400, 100, 130)], [commit(200, 0, { total: 40 })], [], save);
  assert.equal(painted.explanation.blame.kind, 'painting');
  assert.equal(painted.explanation.notes[0], 'React still spent 40 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) after the handlers, before the next frame.');
  const counted = { hasDurations: false, total: 0, rendered: 60, components: [{ name: 'Row', count: 60, self: null, total: null }] };
  assert.deepEqual(report([entry('click', 0, 380, 300, 360)], [commit(375, 0, counted)], [], save).explanation.notes, [
    'React was most likely still re-rendering 60 components inside List, mostly Row (60 of them), after the handlers, before the next frame.',
  ]);
  // Nor is another commit's committing or effects, which ran inside the handlers, said before the render's place,
  // where "after the handlers" read as where they ran: 30 ms of them beside a 43 ms render in the task after the
  // handlers, and 35 ms beside a production render of 800 rows there. The render is said with its place alone.
  const effects = { effectsStartedAt: 120.5, effectsEndedAt: 150.5 };
  const beside = report([entry('click', 0, 400, 100, 160)], [commit(120, 0, { total: 2, rendered: 3, ...effects }), commit(250, 0, { total: 43 })], [], save);
  assert.equal(beside.explanation.blame.kind, 'painting');
  assert.equal(
    beside.explanation.notes[0],
    'React still spent 43 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) after the handlers, before the next frame, and 45 ms of rendering in all across 2 commits.',
  );
  // So where that render is only a reading, walked short of its end.
  const cut = report([entry('click', 0, 400, 100, 160)], [commit(120, 0, { total: 2, rendered: 3, ...effects }), commit(250, 0, { total: 43, truncated: true })], [], save);
  assert.equal(cut.explanation.notes[0], 'React most likely still spent about 43 ms re-rendering at least 30 components inside List after the handlers, before the next frame, and 45 ms of rendering in all across 2 commits.');
  const few = { hasDurations: false, total: 0, rendered: 5, components: [{ name: 'Row', count: 5, self: null, total: null }], effectsStartedAt: 330.2, effectsEndedAt: 365 };
  const rows = { ...counted, rendered: 800, components: [{ name: 'Row', count: 800, self: null, total: null }] };
  assert.deepEqual(report([entry('click', 0, 500, 300, 400)], [commit(330, 0, few), commit(450, 0, rows)], null, save).explanation.notes, [
    'React was most likely still re-rendering 800 components inside List, mostly Row (800 of them), after the handlers, before the next frame.',
  ]);
  // One committed inside the handlers is still in the working time.
  const inside = report([entry('click', 0, 360, 300, 350)], [commit(349, 0, { total: 43 })], [], save);
  assert.deepEqual(inside.explanation.notes, ['React still spent 43 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) in the 50 ms of working time after the wait.']);
  assert.deepEqual(report([entry('click', 0, 380, 300, 360)], [commit(359, 0, counted)], [], save).explanation.notes, [
    'React was most likely still re-rendering 60 components inside List, mostly Row (60 of them), in the 60 ms of working time after the wait.',
  ]);
  // One that began before the handlers, or ran longer than they did, was not all in the working time, and is weighed on
  // what the working time held of it. Joined by overlap, a 43 ms render in the task the click waited behind, committed
  // as the handlers began, was said as that wait and then as 43 ms in the 15 ms of working time after it. None of it
  // was in the working time, so no rung it closed names it.
  const behind = report(
    [entry('click', 0, 360, 300, 315)],
    [commit(299.5, -200, { total: 43, startedAt: 256 })],
    [frame(0, 360, [script('MessagePort.onmessage', 255, 44.8), script('BUTTON.onclick', 300, 15)])],
    save,
  ).explanation;
  assert.equal(behind.cause, 'The click waited 300 ms before its handler could start: a script (MessagePort.onmessage, app.js) ran first and held the main thread for 45 ms of that wait.');
  assert.deepEqual(behind.notes, []);
  const edge = report([entry('click', 0, 360, 300, 315)], [commit(315.8, 0, { total: 43 })], [], save);
  assert.deepEqual(edge.explanation.notes, [
    'React still spent 43 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms). The render was longer than the 15 ms of working time after the wait, so it began before the handlers.',
  ]);
  // A render that began 20 ms before handlers of 60 ms and committed 20 ms into them held at most 20 ms of them. It
  // took the note for its 40 ms, and the handler ran for the other 40.
  const begun = report([entry('click', 0, 400, 300, 360)], [commit(320, 0, { total: 40, startedAt: 280 })], [], save);
  assert.deepEqual(begun.explanation.notes, ['The click handler handleSave still ran for about 40 ms of the 60 ms of working time after the wait.']);
});

test("a render the verdict keeps from React's task after the handlers is said to have run after them, not in a working time shorter than it", () => {
  // handleSave ran from 5 to 20 ms, then React's task rendered for 43 ms, from 22 to 65. The screen update does not
  // outrank the working time, so the render stays the verdict, and it read "about 43 ms of the 15 ms of working time".
  const save = loginClick('handleSave');
  const click = [entry('click', 0, 70, 5, 20)];
  const frames = [frame(0, 70, [script('BUTTON.onclick', 5, 15), script('MessagePort.onmessage', 21, 45)])];
  const said = 'React most likely spent about 43 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) after the handlers, before the next frame.';
  const stopped = report(click, [commit(65, 0, { total: 43, startedAt: 22 })], frames, save, 'attributes', [], undefined, 'unreadable').explanation;
  assert.deepEqual(stopped.blame, { kind: 'render', name: 'List', detail: 'Row ×30', ms: 43, confidence: 'inferred' });
  assert.equal(stopped.cause, said);
  // The same where React is read and the render joined by overlap, and for a production build's count.
  assert.equal(report(click, [commit(65, -200, { total: 43, startedAt: 22 })], frames, save).explanation.cause, said);
  const rows = { hasDurations: false, total: 0, rendered: 800, components: [{ name: 'Row', count: 800, self: null, total: null }] };
  const task = [frame(0, 116, [script('BUTTON.onclick', 1, 60), script('MessagePort.onmessage', 62, 5.5)])];
  assert.match(
    report([entry('click', 0, 116, 1, 61)], [commit(67, 0, rows)], task, save).explanation.cause,
    /^React was most likely re-rendering 800 components inside List, mostly Row \(800 of them\), after the handlers, before the next frame\. This React build/,
  );
  // So with another commit's effects in the handlers, which the sentence led with, then placed after the render: the
  // 800 rows "then ran useEffect callbacks for about 35 ms of the 100 ms of working time in another commit".
  const few = { ...rows, rendered: 5, components: [{ name: 'Row', count: 5, self: null, total: null }], effectsStartedAt: 40.2, effectsEndedAt: 75 };
  const beside = report([entry('click', 0, 130, 5, 105)], [commit(40, 0, few), commit(115, 0, rows)], null, save).explanation;
  assert.deepEqual(beside.blame, { kind: 'render', name: 'List', detail: 'Row ×800', ms: null, confidence: 'inferred' });
  assert.equal(
    beside.cause,
    'React was most likely re-rendering 800 components inside List, mostly Row (800 of them), after the handlers, before the next frame. This React build records no render durations, so that is read from the component counts, not measured. A profiling build of React would give exact numbers.',
  );
  // Where the 800 rows committed in the handlers too, the effects still lead.
  assert.match(
    report([entry('click', 0, 130, 5, 105)], [commit(40, 0, few), commit(100, 0, rows)], null, save).explanation.cause,
    /, then ran useEffect callbacks for about 35 ms of the 100 ms of working time in another commit, before the screen could update\./,
  );
  // One that began before the handlers is given no place, and one that ran in them is still said against them.
  const early = report([entry('click', 0, 70, 20, 60)], [commit(55, 0, { total: 30, startedAt: 10 })], [], save, 'attributes', [], undefined, 'unreadable');
  assert.equal(early.explanation.cause, 'React most likely spent about 30 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms).');
  const handled = [frame(0, 70, [script('BUTTON.onclick', 5, 45)])];
  const inside = report([entry('click', 0, 70, 5, 50)], [commit(45, 0, { total: 30, startedAt: 12 })], handled, save, 'attributes', [], undefined, 'unreadable');
  assert.equal(inside.explanation.cause, 'React most likely spent about 30 ms of the 45 ms of working time re-rendering 30 components inside List, mostly Row (30 of them, 20 ms).');
  assert.match(report([entry('click', 0, 116, 1, 61)], [commit(60, 0, rows)], task, save).explanation.cause, /mostly Row \(800 of them\), in the 60 ms of working time\. This React build/);
});

/** A second render beside List's, of 500 components inside Sidebar. */
const sidebarRender: Partial<CommitSummary> = { rendered: 500, roots: ['Sidebar'], hotPath: ['Sidebar'], components: [{ name: 'Item', count: 500, self: 10, total: 10 }] };

/** A render inside ProductPage of `rendered` components, all of them `name`, which took `ms`. */
const productPage = (rendered: number, name: string, ms: number): Partial<CommitSummary> => ({ rendered, roots: ['ProductPage'], hotPath: ['ProductPage'], components: [{ name, count: rendered, self: ms, total: ms }] });

/** No sentence puts more of a render in the working time than there was, and no render is blamed for more than the interaction. */
function saysWithinTheWorkingTime(r: InteractionReport): void {
  for (const said of [r.explanation.cause, ...r.explanation.notes].flatMap((x) => x.split('. '))) {
    const within = /(\d+) ms .*?\b(?:of|in) the (\d+) ms of working time/.exec(said);
    assert.ok(!within || Number(within[1]) <= Number(within[2]), said);
  }
  assert.ok((r.explanation.blame.ms ?? 0) <= r.duration);
}

test('a render that began before the handlers is weighed and blamed on what the working time held of it, and said whole beside that', () => {
  // A 64 ms click whose handlers ran from 1003 to 1030, and a 120 ms render that began at 880 and committed at 1020,
  // in them. It was blamed for 120 ms of the 64 ms click. React does not yield inside the handlers, so at most the
  // 17 ms from their start to the commit was theirs.
  const click = [entry('click', 1000, 64, 1003, 1030)];
  const begun = commit(1020, 1000, { startedAt: 880, total: 120 });
  const measured = report(click, [begun], [], [input(1000, 'click')]);
  assert.deepEqual(measured.explanation.blame, { kind: 'render', name: 'List', detail: 'Row ×30', ms: 17, confidence: 'measured' });
  assert.equal(
    measured.explanation.cause,
    'React spent 120 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms). The render began before the handlers, so at most 17 ms of it was in the 27 ms of working time.',
  );
  const partial = report(click, [{ ...begun, truncated: true }], [], [input(1000, 'click')]);
  assert.deepEqual(partial.explanation.blame, { kind: 'render', name: 'List', detail: 'at least 30 components', ms: 17, confidence: 'inferred' });
  assert.equal(
    partial.explanation.cause,
    'React most likely spent about 120 ms re-rendering at least 30 components inside List. The render began before the handlers, so at most 17 ms of it was in the 27 ms of working time.',
  );
  // Where the build kept no start, a render longer than the time from their start to its commit began before them,
  // and that time is what it is weighed on. It was weighed on the whole 27 ms.
  const unstarted = report(click, [commit(1020, 1000, { total: 120 })], [], [input(1000, 'click')]);
  assert.deepEqual(unstarted.explanation.blame, { kind: 'render', name: 'List', detail: 'Row ×30', ms: 17, confidence: 'measured' });
  assert.equal(
    unstarted.explanation.cause,
    'React spent 120 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms). The render began before the handlers, so at most 17 ms of it was in the 27 ms of working time.',
  );
  // The note a screen update leaves for the rung it closed says it the same way. It read "about 120 ms ... in the 27 ms
  // of working time before that".
  const painted = report([entry('click', 1000, 160, 1003, 1030)], [{ ...begun, truncated: true }], [], [input(1000, 'click')]);
  assert.equal(painted.explanation.blame.kind, 'painting');
  assert.equal(
    painted.explanation.notes[0],
    'React most likely still spent about 120 ms re-rendering at least 30 components inside List. The render began before the handlers, so at most 17 ms of it was in the 27 ms of working time before that.',
  );
  // In Firefox and Safari, with no long animation frames, a transition started from the click renders in React's task
  // after the handlers, before the paint, and is said there whole, begun after the handlers or with no start kept.
  const transition = (x: CommitSummary, handled: number) => report([entry('click', 1000, 160, 1003, handled)], [x], null, [input(1000, 'click')]);
  const unkept = transition(commit(1140, 1000, { total: 120 }), 1008);
  assert.deepEqual(unkept.explanation.notes, ['React still spent 120 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) after the handlers, before the next frame.']);
  const kept = transition(commit(1140, 1000, { total: 90, startedAt: 1045 }), 1040);
  assert.deepEqual(kept.explanation.notes, ['React still spent 90 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) after the handlers, before the next frame.']);
  // One committed after the handlers, with no start kept, is the render they set off and is weighed whole.
  const longer = report([entry('click', 0, 120, 3, 100)], [commit(110, 0, { total: 150 })], null, [input(0, 'click')]);
  assert.deepEqual(longer.explanation.blame, { kind: 'render', name: 'List', detail: 'Row ×30', ms: 150, confidence: 'measured' });
  assert.equal(longer.explanation.cause, 'React spent 150 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms).');
  // With a second render beside it, the total follows the named render, and the part held is of the total.
  const beside = report(click, [{ ...begun, truncated: true }, commit(1026, 1000, { total: 6, ...sidebarRender })], [], [input(1000, 'click')]);
  assert.equal(
    beside.explanation.cause,
    'React most likely spent about 120 ms re-rendering at least 30 components inside List, and 126 ms of rendering in all across 2 commits. Some of that rendering began before the handlers, so at most 23 ms of it was in the 27 ms of working time.',
  );
  // Beside a render that ran all its 28 ms in the handlers, the one that began before them and held 7 ms of them is
  // not the one named. It was, for its 100 ms in all, and blamed for 7.
  const two = report(
    [entry('click', 1000, 64, 1003, 1043)],
    [commit(1010, 1000, { startedAt: 900, total: 100, ...sidebarRender }), commit(1040, 1000, { startedAt: 1011, total: 28 })],
    [],
    [input(1000, 'click')],
  );
  assert.deepEqual(two.explanation.blame, { kind: 'render', name: 'List', detail: 'Row ×30', ms: 29, confidence: 'measured' });
  assert.equal(
    two.explanation.cause,
    'React spent 128 ms rendering across 2 commits, 28 ms of it re-rendering 30 components inside List, mostly Row (30 of them, 20 ms). Some of that rendering began before the handlers, so at most 35 ms of it was in the 40 ms of working time.',
  );
  // The handler's sentence and the layout's say it the same way. The handler's read "ran for about 80 ms; React spent
  // 60 ms re-rendering" in 97 ms of working time.
  const handled = report([entry('click', 0, 120, 3, 100)], [commit(20, 0, { startedAt: -40, total: 60 })], [], [input(0, 'click')]);
  assert.equal(handled.explanation.blame.kind, 'handler');
  assert.equal(
    handled.explanation.cause,
    'Code outside React (the click handler or other scripts) ran for about 80 ms; React spent 60 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms). The render began before the handlers, so at most 17 ms of it was in the 97 ms of working time.',
  );
  const forced = [frame(0, 200, [script('BUTTON.onclick', 2, 178, 120)])];
  const layout = report([entry('click', 0, 200, 2, 180)], [commit(20, 0, { startedAt: -60, total: 90 })], forced, loginClick('handleSave'));
  assert.equal(layout.explanation.blame.kind, 'layout');
  assert.match(
    layout.explanation.cause,
    / React spent 90 ms re-rendering 30 components inside List, mostly Row \(30 of them, 20 ms\)\. The render began before the handlers, so at most 18 ms of it was in the 178 ms of working time\. /,
  );
  for (const r of [measured, partial, unstarted, painted, unkept, kept, beside, two, handled, layout]) saysWithinTheWorkingTime(r);
});

test('a note standing in for a closed render rung sets only the named render against the working time, and the total of several after it', () => {
  // A screen update closed the render rung of a click whose List rendered for 20 ms in 25 ms of handlers. In Firefox
  // and Safari, where no frame ties it to a script, a 15 ms Sidebar render after the handlers is among the working
  // time's commits too, weighed whole. Led with the total, the note put 35 ms of rendering in the 25 ms.
  const click = [input(1000, 'click')];
  const list = commit(1025, 1000, { total: 20 });
  const note = 'React still spent 20 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) in the 25 ms of working time before that, and 35 ms of rendering in all across 2 commits.';
  const unframed = report([entry('click', 1000, 160, 1003, 1028)], [list, commit(1060, 1000, { total: 15, ...sidebarRender })], null, click);
  assert.equal(unframed.explanation.blame.kind, 'painting');
  assert.equal(unframed.explanation.notes.at(-1), note);
  // The same in Chromium, where React's task after the handlers is not the longest script after them.
  const scripts = [script('BUTTON.onclick', 1003, 25), script('TimerHandler:setTimeout', 1030, 40), script('MessagePort.onmessage', 1075, 16)];
  const framed = report([entry('click', 1000, 160, 1003, 1028)], [list, commit(1090, 1000, { startedAt: 1075, total: 15, ...sidebarRender })], [frame(1000, 160, scripts)], click);
  assert.equal(framed.explanation.blame.kind, 'painting');
  assert.equal(framed.explanation.notes.at(-1), note);
  // And where one of them began before the handlers, the part held is said of the total after it.
  const early = report(
    [entry('click', 1000, 200, 1003, 1043)],
    [commit(1010, 1000, { startedAt: 900, total: 25, ...sidebarRender }), commit(1040, 1000, { startedAt: 1011, total: 28 })],
    null,
    click,
  );
  assert.equal(
    early.explanation.notes.at(-1),
    'React still spent 28 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) in the 40 ms of working time before that, and 53 ms of rendering in all across 2 commits. Some of that rendering began before the handlers, so at most 35 ms of it was in the 40 ms of working time before that.',
  );
  // A total that holds a render after the handlers, which is the render they set off and weighed whole, is not set
  // against the working time. With a 60 ms render after them in it, the total "was longer than the 27 ms of working
  // time", and some of it was said to have begun before them from that alone.
  const around = report(
    [entry('click', 1000, 160, 1003, 1030)],
    [commit(1020, 1000, { startedAt: 990, total: 40 }), commit(1100, 1000, { startedAt: 1031, total: 60, ...sidebarRender })],
    null,
    click,
  );
  assert.equal(
    around.explanation.notes.at(-1),
    'React still spent 60 ms re-rendering 500 components inside Sidebar, mostly Item (500 of them, 10 ms) after the handlers, before the next frame, and 100 ms of rendering in all across 2 commits.',
  );
  // The same beside two renders of 20 ms committed in those 27 ms, so that some of their 40 ms began before them.
  const filled = report(
    [entry('click', 1000, 160, 1003, 1030)],
    [commit(1015, 1000, { total: 20 }), commit(1025, 1000, { total: 20 }), commit(1100, 1000, { startedAt: 1031, total: 60, ...sidebarRender })],
    null,
    click,
  );
  assert.match(filled.explanation.notes.at(-1) ?? '', /, and 100 ms of rendering in all across 3 commits\.$/);
  // The total says what it totals, and comes after the committing too, or it read as further shares of it, or as
  // the sum of the render and the committing before it.
  const committed = (x: Partial<CommitSummary>) =>
    report([entry('click', 0, 400, 5, 105)], [commit(100, 0, { startedAt: 10, total: 30, ...x }), commit(104, 0, { startedAt: 101, total: 2, ...sidebarRender })], [], [input(0, 'click')]);
  const measured = committed({});
  assert.deepEqual(measured.explanation.notes, [
    'React still spent 30 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) and 60 ms committing it in the 100 ms of working time before that, and 32 ms of rendering in all across 2 commits.',
  ]);
  const partial = committed({ truncated: true });
  assert.equal(
    partial.explanation.notes[0],
    'React most likely still spent about 30 ms re-rendering at least 30 components inside List and 60 ms committing it in the 100 ms of working time before that, and 32 ms of rendering in all across 2 commits.',
  );
  for (const r of [unframed, framed, early, around, filled, measured, partial]) saysWithinTheWorkingTime(r);
});

test('a render in the task the click waited behind is in no total, and each sentence names the render the working time held most of', () => {
  // A 43 ms render that began at 996.5, in the task the click waited behind, and committed as the handlers began at
  // 1040. Joined by overlap, it is among the working time's commits, and the working time held none of it.
  const behind = commit(1039.5, 800, { startedAt: 996.5, total: 43 });
  const save = loginClick('handleSave', 1000);
  // Beside a handler that ran all 140 ms, it is said to have run before them. It read "React spent 43 ms
  // re-rendering 30 components inside List" beside 97 ms of handler.
  const alone = report([entry('click', 1000, 200, 1040, 1180)], [behind], [], save);
  assert.equal(alone.explanation.blame.kind, 'handler');
  assert.equal(alone.explanation.blame.ms, 140);
  assert.equal(
    alone.explanation.cause,
    'The click handler handleSave most likely took about 140 ms; React spent 43 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms). The render ran before the handlers, not in the 140 ms of working time.',
  );
  // Beside the 10 ms render the handlers made, that one is named, and the 43 ms is left out. The handler's sentence
  // read "React spent 53 ms re-rendering 30 components inside List" beside 87 ms of handler, and the layout's gave
  // the same 53 ms beside a clause on React's commit that took Sidebar's 10.
  const made = commit(1100, 1000, { startedAt: 1090, total: 10, ...sidebarRender });
  const sidebar = 'React spent 10 ms re-rendering 500 components inside Sidebar, mostly Item (500 of them, 10 ms).';
  const handled = report([entry('click', 1000, 200, 1040, 1180)], [behind, made], [], save);
  assert.equal(handled.explanation.blame.kind, 'handler');
  assert.equal(handled.explanation.cause, `The click handler handleSave most likely took about 130 ms; ${sidebar}`);
  const forced = [frame(1000, 200, [script('BUTTON.onclick', 1040, 138, 100)])];
  const layout = report([entry('click', 1000, 200, 1040, 1180)], [behind, made], forced, save);
  assert.equal(layout.explanation.blame.kind, 'layout');
  assert.ok(layout.explanation.cause.includes(` It was charged to BUTTON.onclick. ${sidebar} `), layout.explanation.cause);
  // The render verdict names the render after the handlers, which the working time held, where it named the other
  // for its length: "React most likely spent about 43 ms re-rendering 30 components inside List".
  const rendered = report([entry('click', 1000, 80, 1040, 1050)], [behind, commit(1078, 1000, { startedAt: 1052, total: 25, ...sidebarRender })], null, [input(1000, 'click')]);
  assert.deepEqual(rendered.explanation.blame, { kind: 'render', name: 'Sidebar', detail: 'Item ×500', ms: 25, confidence: 'measured' });
  assert.equal(rendered.explanation.cause, 'React spent 25 ms re-rendering 500 components inside Sidebar, mostly Item (500 of them, 10 ms).');
  // The note a screen update leaves for a render after the handlers leaves it out of the total too, or it went on
  // "and 143 ms of rendering in all across 2 commits", and took that for rendering in the 27 ms of working time.
  const painted = report(
    [entry('click', 1000, 160, 1003, 1030)],
    [commit(1002.5, 800, { startedAt: 959.5, total: 43 }), commit(1140, 1000, { startedAt: 1031, total: 100, ...sidebarRender })],
    null,
    [input(1000, 'click')],
  );
  assert.equal(painted.explanation.blame.kind, 'painting');
  assert.equal(
    painted.explanation.notes.at(-1),
    'React still spent 100 ms re-rendering 500 components inside Sidebar, mostly Item (500 of them, 10 ms) after the handlers, before the next frame.',
  );
  for (const r of [alone, handled, layout, rendered, painted]) saysWithinTheWorkingTime(r);
});

test('a render that began before the handlers and committed after them is the render they set off, and is weighed whole', () => {
  // A transition React picked up again after a 27 ms click handler: it began at 900 and committed at 1050, 20 ms after
  // the handlers. It ran in React's task after them, the render they set off, so it is weighed whole, as it was at
  // 0.16.0, and no part of it is set against the working time.
  const click = [entry('click', 1000, 64, 1003, 1030)];
  const picked = commit(1050, 800, { startedAt: 900, total: 120, priority: 32 });
  const said = 'React most likely spent about 120 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms).';
  const framed = report(click, [picked], [frame(1000, 64, [script('BUTTON.onclick', 1003, 27), script('MessagePort.onmessage', 1031, 20)])], [input(1000, 'click')]);
  assert.deepEqual(framed.explanation.blame, { kind: 'render', name: 'List', detail: 'Row ×30', ms: 120, confidence: 'inferred' });
  assert.equal(framed.explanation.cause, said);
  // The same beside a handler on record for all 80 ms of the working time.
  const saved = report(
    [entry('click', 1000, 160, 1003, 1083)],
    [commit(1100, 800, { startedAt: 900, total: 120, priority: 32 })],
    [frame(1000, 160, [script('BUTTON.onclick', 1003, 80), script('MessagePort.onmessage', 1084, 16)])],
    loginClick('handleSave', 1000),
  );
  assert.deepEqual(saved.explanation.blame, { kind: 'render', name: 'List', detail: 'Row ×30', ms: 120, confidence: 'inferred' });
  assert.equal(saved.explanation.cause, said);
  // And for a render that filled the 30 ms wait and ran on after 2 ms of handlers.
  const waited = report([entry('click', 0, 77, 30, 32)], [commit(55.5, 0, { startedAt: -50, total: 105.5, priority: 3, ...productPage(10, 'Row', 14) })], [], [input(0, 'click')]);
  assert.deepEqual(waited.explanation.blame, { kind: 'render', name: 'ProductPage', detail: 'Row ×10', ms: 105.5, confidence: 'measured' });
  assert.equal(waited.explanation.cause, 'React spent 106 ms re-rendering 10 components inside ProductPage, mostly Row (10 of them, 14 ms).');
  // Where one of several renders committed after them, the total is said with the named commit's share, and none of
  // it is set against the working time.
  const across = report(
    [entry('click', 0, 58, 1, 28)],
    [commit(1.8, 0, { startedAt: -41.2, total: 43, ...productPage(3, 'Row', 26) }), commit(52, 0, { startedAt: 5, total: 43, ...productPage(30, 'Item', 26) })],
    null,
    [input(0, 'click')],
  );
  assert.deepEqual(across.explanation.blame, { kind: 'render', name: 'ProductPage', detail: 'Item ×30', ms: 43, confidence: 'measured' });
  assert.equal(
    across.explanation.cause,
    'React spent 86 ms rendering across 2 commits, 43 ms of it re-rendering 30 components inside ProductPage, mostly Item (30 of them, 26 ms).',
  );
  // One that began inside 7 ms of handlers and committed 50 ms after them is said to have run after them, in the note
  // a screen update leaves for it.
  const painted = report([entry('click', 0, 200, 3, 10)], [commit(60, 0, { startedAt: 5, total: 57 })], null, [input(0, 'click')]);
  assert.equal(painted.explanation.blame.kind, 'painting');
  assert.equal(
    painted.explanation.notes.at(-1),
    'React still spent 57 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) after the handlers, before the next frame.',
  );
  for (const r of [saved, across, painted]) saysWithinTheWorkingTime(r);
});

test("a render committed at the end of the handlers, past the paint the duration's rounding gives, is weighed as theirs", () => {
  // Handlers from 1003 to 1066, and a paint Chromium's 8 ms rounding of the duration puts at 1064, so the working
  // time ends 2 ms before they did. A 40 ms render that began 23 ms into them committed at 1065.5, with them. Taken
  // from the rounded paint, it was weighed on the 1.5 ms after it and lost the verdict: "React's render began before
  // the handlers ended, with at most 2 ms of it after them".
  const click = [entry('click', 1000, 64, 1003, 1066)];
  const ended = commit(1065.5, 1000, { startedAt: 1025.5, total: 40 });
  const said = 'React spent 40 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms).';
  const framed = report(click, [ended], [], [input(1000, 'click')]);
  const unframed = report(click, [ended], null, [input(1000, 'click')]);
  // With no start kept, the verdict went to 60 ms of code outside React, and the render was said to have committed
  // after the handlers.
  const unstarted = report(click, [commit(1065.5, 1000, { total: 40 })], [], [input(1000, 'click')]);
  for (const r of [framed, unframed, unstarted]) {
    assert.deepEqual(r.explanation.blame, { kind: 'render', name: 'List', detail: 'Row ×30', ms: 40, confidence: 'measured' });
    assert.equal(r.explanation.cause, said);
  }
  // One that began before the handlers is said against the working time. It was said to have committed after them,
  // with at most 2 ms of it there.
  const begun = report(click, [commit(1065.5, 1000, { startedAt: 990, total: 75 })], [], [input(1000, 'click')]);
  assert.deepEqual(begun.explanation.blame, { kind: 'render', name: 'List', detail: 'Row ×30', ms: 61, confidence: 'measured' });
  assert.equal(
    begun.explanation.cause,
    'React spent 75 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms). The render was longer than the 61 ms of working time, so it began before the handlers.',
  );
  // And one too small for the verdict, in 4 ms of working time whose handlers ran 2 ms past it, is too.
  const small = report([entry('click', 0, 8, 4, 10)], [commit(9.5, 0, { startedAt: -100, total: 104 })], [], [input(0, 'click')]);
  assert.match(small.explanation.cause, /^At most 4 ms of the 4 ms of working time went to React's render, which began before the handlers \(104 ms /);
  // It is placed in the working time, where a hedged sentence or a production build's says where it ran. Both said
  // "after the handlers, before the next frame".
  const partial = report(click, [{ ...ended, truncated: true }], [], [input(1000, 'click')]);
  assert.equal(partial.explanation.cause, 'React most likely spent about 40 ms of the 61 ms of working time re-rendering at least 30 components inside List.');
  const production = report(click, [commit(1065.5, 1000, { hasDurations: false, total: 0, rendered: 300 })], [], [input(1000, 'click')]);
  assert.match(production.explanation.cause, /^React was most likely re-rendering 300 components inside List, in the 61 ms of working time\. /);
  // A hydration there held all of its time too. It read "39 ms of the 61 ms of working time, in a hydration that took
  // 40 ms in all".
  const hydrated = report(click, [{ ...ended, hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' } }], [], [input(1000, 'click')]);
  assert.equal(
    hydrated.explanation.cause,
    'The click landed on server-rendered HTML that had not been hydrated yet, so React hydrated the Suspense boundary in ProductPage first: 40 ms of the 61 ms of working time.',
  );
  assert.equal(hydrated.explanation.blame.ms, 40);
  assert.deepEqual(hydrated.explanation.phases[1]?.parts?.map((p) => p.ms), [40]);
  for (const r of [framed, unframed, unstarted, begun, small, partial, production, hydrated]) saysWithinTheWorkingTime(r);
});

test("a render with no start kept is weighed on the time from the handlers' start to its commit, and a bound that is all the working time is left out", () => {
  // A 90 ms render with no start kept, committed 0.2 ms into 64 ms of handlers. It was blamed for all 64 ms, and at
  // 0.16.0 for its 90 ms. It ran before them.
  const early = report([entry('click', 0, 95, 1, 65)], [commit(1.2, 0, { total: 90, ...productPage(400, 'Row', 54) })], null, [input(0, 'click')]);
  assert.deepEqual(early.explanation.blame, { kind: 'handler', name: null, detail: null, ms: 63.8, confidence: 'measured' });
  assert.equal(
    early.explanation.cause,
    'Code outside React (the click handler or other scripts) ran for about 64 ms; React spent 90 ms re-rendering 400 components inside ProductPage, mostly Row (400 of them, 54 ms). The render ran before the handlers, not in the 64 ms of working time.',
  );
  // Committed 19 ms into them, beside a 3 ms render after them, it held no more than those 19 ms. It was blamed for all
  // 64. The total holds the render after them, so no part of it is set against the working time either, where it read
  // "at most 64 ms of it was in the 64 ms of working time".
  const vacuous = report(
    [entry('click', 0, 134, 60, 124)],
    [commit(127, 0, { startedAt: 124, total: 3, ...productPage(3, 'Item', 2) }), commit(79.2, 0, { total: 90, ...productPage(3, 'Item', 54) })],
    null,
    [input(0, 'click')],
  );
  assert.deepEqual(vacuous.explanation.blame, { kind: 'handler', name: null, detail: null, ms: 41.8, confidence: 'measured' });
  assert.equal(
    vacuous.explanation.cause,
    'Code outside React (the click handler or other scripts) ran for about 42 ms; React spent 93 ms rendering across 2 commits, 90 ms of it re-rendering 3 components inside ProductPage, mostly Item (3 of them, 54 ms).',
  );
  for (const r of [early, vacuous]) saysWithinTheWorkingTime(r);
});

test('a render too small for the verdict is said as what the working time held of it, and where the rest ran', () => {
  // A 120 ms render, 72 ms of it in 3 Cards, that began before 5 ms of handlers and committed 3 ms into them. The
  // verdict holds, but the sentence called it small.
  const click = [entry('click', 0, 38, 3, 8)];
  const begun = commit(6, 0, { startedAt: -114, total: 120, ...productPage(3, 'Card', 72) });
  const whole = '120 ms re-rendering 3 components inside ProductPage, mostly Card (3 of them, 72 ms)';
  const unframed = report(click, [begun], null, [input(0, 'click')]);
  assert.equal(unframed.explanation.blame.kind, 'none');
  assert.equal(
    unframed.explanation.cause,
    `At most 3 ms of the 5 ms of working time went to React's render, which began before the handlers (${whole}); this browser does not report long tasks, so what else ran is unknown.`,
  );
  const framed = report(click, [begun], [], [input(0, 'click')]);
  assert.equal(framed.explanation.blame.kind, 'none');
  assert.equal(
    framed.explanation.cause,
    `At most 3 ms of the 5 ms of working time went to React's render, which began before the handlers (${whole}) and no long task was recorded, so the rest went to waiting and painting.`,
  );
  // A render the working time held all of is small as it was.
  const small = report(click, [commit(6, 0, { startedAt: 4, total: 2, ...productPage(3, 'Card', 1) })], [], [input(0, 'click')]);
  assert.match(small.explanation.cause, /^React's render was small \(re-rendering 3 components inside ProductPage/);
  // The script's rung says it the same way. It read "React's render was small (...)" beside the 42 ms timer.
  const timed = report(
    [entry('click', 0, 72, 45, 50)],
    [commit(48, 0, { startedAt: -72, total: 120 })],
    [frame(0, 72, [script('TimerHandler:setTimeout', 2, 42)])],
    [input(0, 'click')],
  );
  assert.equal(timed.explanation.blame.kind, 'script');
  assert.equal(
    timed.explanation.cause,
    "At most 3 ms of the 5 ms of working time went to React's render, which began before the handlers (120 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms)); a script (TimerHandler:setTimeout, app.js) ran for 42 ms before the handler started.",
  );
  // The render said is the one the working time held most of. Beside a 3 ms render the handlers made, a 103 ms one in
  // the task the click waited behind read "Under 1 ms of the 5 ms of working time went to React's render, which began
  // before the handlers (103 ms re-rendering 30 components inside List, ...)", where 3 of those 5 ms went to the other.
  const made = commit(7.5, 0, { startedAt: 4, total: 3, rendered: 5, roots: ['Sidebar'], hotPath: ['Sidebar'], components: [{ name: 'Item', count: 5, self: 2, total: 2 }] });
  const beside = (frames: FrameSummary[] | null) => report(click, [commit(3.3, 0, { startedAt: -100, total: 103, truncated: true }), made], frames, [input(0, 'click')]);
  const sidebarSmall = "React's render was small (re-rendering 5 components inside Sidebar, mostly Item (5 of them, 2 ms))";
  const none = beside([]);
  assert.equal(none.explanation.blame.kind, 'none');
  assert.equal(none.explanation.cause, `${sidebarSmall} and no long task was recorded, so the rest went to waiting and painting.`);
  const unknown = beside(null);
  assert.equal(unknown.explanation.cause, `${sidebarSmall}; this browser does not report long tasks, so what else ran is unknown.`);
  const scripted = beside([frame(0, 38, [script('TimerHandler:setTimeout', 10, 20)])]);
  assert.equal(scripted.explanation.cause, `${sidebarSmall}; a script (TimerHandler:setTimeout, app.js) ran for 20 ms after the handler finished.`);
  // The walk of the render not named was cut short, and the note that the count is partial is not about this one.
  for (const r of [none, unknown, scripted]) assert.equal(r.explanation.notes.some((n) => n.startsWith('The component count is partial')), false);
  for (const r of [unframed, framed, small, timed, none, unknown, scripted]) saysWithinTheWorkingTime(r);
});

test('the renders a cause counts across commits are the renders the note says React made', () => {
  // Renders of 30, 20 and 3 ms in 80 ms of handlers. The cause said "across 3 commits" and the note "React rendered 2
  // times": the note left out the 3 ms render.
  const click = [entry('click', 0, 103, 3, 83)];
  const three = [
    commit(40, 0, { startedAt: 10, total: 30, ...productPage(3, 'Card', 18) }),
    commit(60, 0, { startedAt: 45, total: 20, ...productPage(3, 'Card', 18) }),
    commit(70, 0, { startedAt: 67, total: 3, ...productPage(3, 'Card', 2) }),
  ];
  const r = report(click, three, null, [input(0, 'click')]);
  assert.match(r.explanation.cause, /^React spent 53 ms rendering across 3 commits, 30 ms of it re-rendering 3 components inside ProductPage/);
  assert.ok(r.explanation.notes.includes('React rendered 3 times before the screen updated, which usually means a state update inside an effect or a chain of updates.'));
  // A render in the task the click waited behind, which the working time held none of, is in neither count. The note
  // counted it: "React rendered 3 times" beside "across 2 commits".
  const behind = report(click, [commit(2.5, 0, { startedAt: -40.5, total: 43, ...sidebarRender }), ...three.slice(0, 2)], null, [input(0, 'click')]);
  assert.match(behind.explanation.cause, /^React spent 50 ms rendering across 2 commits, 30 ms of it /);
  assert.ok(behind.explanation.notes.includes('React rendered 2 times before the screen updated, which usually means a state update inside an effect or a chain of updates.'));
  // A hydration is no re-render, and the note counts one only where a sentence counted it among the commits, as here.
  const times = (n: number) => `React rendered ${n} times before the screen updated, which usually means a state update inside an effect or a chain of updates.`;
  const handled = report(
    [entry('click', 0, 216, 2, 200)],
    [
      commit(60, 0, { rendered: 300, hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' } }),
      commit(120, 0, { rendered: 300 }),
      commit(190, 0, { rendered: 500, roots: ['Sidebar'] }),
    ],
    [],
    loginClick('handleSave'),
  );
  assert.match(handled.explanation.cause, /; React spent 90 ms rendering across 3 commits, 30 ms of it hydrating /);
  // The render verdict's sentence counts it the same way, and so do a layout's and a closed render rung's note.
  const hydration = (total: number) =>
    commit(40, 0, { total, hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' }, roots: ['ProductPage'], hotPath: ['ProductPage'], components: [{ name: 'Row', count: 30, self: total / 2, total: total / 2 }] });
  const cart = commit(60, 0, { total: 15, rendered: 12, roots: ['Cart'], hotPath: ['Cart'], components: [{ name: 'CartLine', count: 12, self: 10, total: 10 }] });
  const rendered = report([entry('click', 0, 96, 2, 77)], [hydration(20), cart, commit(70, 0, { total: 15 })], []);
  assert.equal(rendered.explanation.blame.kind, 'render');
  assert.match(rendered.explanation.cause, /^React spent 50 ms rendering across 3 commits, 20 ms of it hydrating /);
  const painted = report([entry('click', 0, 300, 2, 77)], [hydration(20), cart, commit(70, 0, { total: 15 })], []);
  assert.equal(painted.explanation.blame.kind, 'painting');
  assert.match(painted.explanation.notes.at(-1) ?? '', /, and 50 ms of rendering in all across 3 commits\.$/);
  const forced = [frame(0, 200, [script('BUTTON.onclick', 2, 178, 120)])];
  const layout = report([entry('click', 0, 200, 2, 180)], [hydration(4), cart, commit(170, 0, { total: 15 })], forced, loginClick('handleSave'));
  assert.equal(layout.explanation.blame.kind, 'layout');
  assert.match(layout.explanation.cause, / React spent 34 ms rendering across 3 commits, 15 ms of it re-rendering 12 components inside Cart, /);
  for (const r of [handled, rendered, painted, layout]) assert.ok(r.explanation.notes.includes(times(3)), r.explanation.notes.join(' | '));
  // Under a hydration verdict, and in a production build, no sentence gives a count, and the note leaves the hydration
  // out. Counted there, a click that waited for a boundary to hydrate and then rendered twice read "React rendered 3
  // times", and went looking for an effect that updates state.
  const hydrated = report(
    [entry('click', 0, 216, 2, 200)],
    [
      commit(120, 0, { rendered: 300, total: 110, hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' } }),
      commit(150, 0, { rendered: 300, total: 20 }),
      commit(190, 0, { rendered: 500, roots: ['Sidebar'], total: 20 }),
    ],
    [],
    loginClick('handleSave'),
  );
  assert.equal(hydrated.explanation.blame.kind, 'hydration');
  const production = report(
    [entry('click', 0, 216, 2, 200)],
    [
      commit(60, 0, { hasDurations: false, total: 0, rendered: 300, hydrated: true, hydratedTarget: { scope: 'boundary', owner: 'ProductPage' } }),
      commit(120, 0, { hasDurations: false, total: 0, rendered: 300 }),
      commit(190, 0, { hasDurations: false, total: 0, rendered: 500, roots: ['Sidebar'] }),
    ],
    [],
    loginClick('handleSave'),
  );
  for (const r of [hydrated, production]) assert.ok(r.explanation.notes.includes(times(2)), r.explanation.notes.join(' | '));
});

test('the note that the component count is partial is about the commit the cause names', () => {
  // A 100 ms Sidebar render that began before 40 ms of handlers, walked short of the end, and a 28 ms List render in
  // them, walked in full. The cause names List, measured, and the note said the count was partial.
  const click = [entry('click', 1000, 64, 1003, 1043)];
  const sidebar = commit(1010, 1000, { startedAt: 900, total: 100, ...sidebarRender });
  const list = commit(1040, 1000, { startedAt: 1011, total: 28 });
  const partial = 'The component count is partial: the walk stopped at its budget or at its depth limit.';
  const cutSidebar = report(click, [{ ...sidebar, truncated: true }, list], [], [input(1000, 'click')]).explanation;
  assert.equal(cutSidebar.blame.name, 'List');
  assert.equal(cutSidebar.blame.confidence, 'measured');
  assert.equal(cutSidebar.notes.includes(partial), false);
  // The List walk cut short says "at least 30 components", and the note said nothing.
  const cutList = report(click, [sidebar, { ...list, truncated: true }], [], [input(1000, 'click')]).explanation;
  assert.match(cutList.cause, /re-rendering at least 30 components inside List/);
  assert.ok(cutList.notes.includes(partial));
  // The handler's sentence, the layout's and a closed render rung's note follow the commit they name the same way:
  // List, walked in full, and not the 110 ms Sidebar render that began before the handlers.
  const early = commit(10, 0, { startedAt: -100, total: 110, truncated: true, ...sidebarRender });
  const listed = commit(150, 0, { startedAt: 130, total: 20 });
  const handled = report([entry('click', 0, 216, 2, 200)], [early, listed], [], loginClick('handleSave')).explanation;
  assert.equal(handled.blame.kind, 'handler');
  assert.match(handled.cause, /; React spent 130 ms rendering across 2 commits, 20 ms of it re-rendering 30 components inside List, /);
  const forced = [frame(0, 200, [script('BUTTON.onclick', 2, 178, 120)])];
  const layout = report([entry('click', 0, 200, 2, 180)], [early, listed], forced, loginClick('handleSave')).explanation;
  assert.equal(layout.blame.kind, 'layout');
  assert.match(layout.cause, / React spent 130 ms rendering across 2 commits, 20 ms of it re-rendering 30 components inside List, /);
  const painted = report([entry('click', 1000, 160, 1003, 1043)], [{ ...sidebar, truncated: true }, list], null, [input(1000, 'click')]).explanation;
  assert.equal(painted.blame.kind, 'painting');
  assert.match(painted.notes.at(-1) ?? '', /^React still spent 28 ms re-rendering 30 components inside List, /);
  for (const said of [handled, layout, painted]) assert.equal(said.notes.includes(partial), false);
});

test("a render between one event's handlers and the next's is working time a long wait before them has to outlast", () => {
  // Typing fast: the key press waited 60 ms behind the last key's work, then React rendered for 85 ms before the
  // keyup was handled, all in one frame. The render is the verdict, as it is after a 45 ms wait, and the wait is
  // the note it always was, not a verdict followed by a note giving the 85 ms.
  const typed = (wait: number) => [entry('keydown', 0, wait + 110, wait + 0.2, wait + 1.2), entry('keyup', wait + 100, 10, wait + 100.1, wait + 100.3)];
  const list = { kind: 'render', name: 'List', detail: 'Row ×30', ms: 85, confidence: 'measured' };
  for (const wait of [60, 45]) {
    for (const frames of [[], null]) {
      const r = report(typed(wait), [commit(wait + 90, 0, { total: 85 })], frames, [input(0, 'keydown')]);
      assert.deepEqual(r.explanation.blame, list, `${wait} ms`);
      assert.doesNotMatch(r.verdict, /after the wait/);
    }
  }
  assert.equal(
    report(typed(60), [commit(150, 0, { total: 85 })], [], [input(0, 'keydown')]).verdict,
    '170 ms key press. React spent 85 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms). It also waited 60 ms before the handler could start, because the main thread was busy.',
  );
  // A 190 ms render after a 100 ms wait, the same.
  const longer = report([entry('keydown', 0, 332, 100, 110), entry('keyup', 305, 27, 310, 311)], [commit(300, 0, { total: 190 })], [], [input(0, 'keydown')]);
  assert.deepEqual(longer.explanation.blame, { ...list, ms: 190 });
  // A production build's render, time-sliced into 15 of React's scheduler tasks: long frames time it by those
  // tasks, and without the frames nothing times it, so the wait has to outlast all of the time between.
  const slices = Array.from({ length: 15 }, (_, i) => script('MessagePort.onmessage', 61.3 + i * 5.8, 5.5));
  const counted = (rendered: number, at: number) => [commit(at, 0, { total: 0, hasDurations: false, rendered })];
  for (const frames of [[frame(60.2, 105, slices, 165)], [], null]) {
    assert.equal(report(typed(60), counted(300, 147.5), frames, [input(0, 'keydown')]).explanation.blame.kind, 'render');
  }
  // Where React's part of that time is shorter than the wait, the wait is still the verdict: a frame that says
  // React's task took 10 ms, a render that kept its durations and took 20, and a render of 2 components, which
  // does not count as one. The key was down for the rest of it, with nothing running.
  const held = [entry('keydown', 0, 176, 60.2, 61.2), entry('keyup', 130, 46, 130.1, 130.3)];
  const waited = { kind: 'waiting', name: null, detail: null, ms: 60.2, confidence: 'measured' };
  const framed = report(held, counted(300, 72), [frame(60.2, 110, [script('MessagePort.onmessage', 62, 10.5)], 165)], [input(0, 'keydown')]).explanation;
  assert.deepEqual(framed.blame, waited);
  // Without the frame nothing says how long the render took, and it is the verdict again.
  assert.equal(report(held, counted(300, 72), null, [input(0, 'keydown')]).explanation.blame.kind, 'render');
  const timed = report(held, [commit(90, 0, { total: 20 })], null, [input(0, 'keydown')]).explanation;
  assert.deepEqual(timed.blame, waited);
  assert.deepEqual(timed.notes, ['React still spent 20 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) in the 70 ms of working time after the wait.']);
  for (const frames of [[], null]) {
    assert.deepEqual(report(held, counted(2, 90), frames, [input(0, 'keydown')]).explanation.blame, waited);
  }
  // A render too small to be the verdict is no working time the wait has to outlast, since it closes nothing: a 55 ms
  // wait before 52 ms of a keydown's handlers is still the verdict with a 4 ms render between them and the keyup's.
  for (const frames of [[], null]) {
    const small = report([entry('keydown', 0, 312, 55, 107), entry('keyup', 300, 12, 300.1, 300.3)], [commit(200, 0, { total: 4 })], frames, [input(0, 'keydown')]);
    assert.deepEqual(small.explanation.blame, { ...waited, ms: 55 });
  }
  // Nor is one beside a handler or a forced layout that outruns React's render, since that rung is asked first and
  // leaves the time between out of its figure: a 60 ms wait before a keydown's 38 ms handler, with a 30 ms render
  // before the keyup's, is still the verdict, and the handler is said after it.
  const keyed = [entry('keydown', 0, 144, 60, 100), entry('keyup', 120, 24, 140, 140.2)];
  const key = [{ ...loginClick('handleKey')[0]!, type: 'keydown' }];
  for (const frames of [[], null]) {
    const handled = report(keyed, [commit(98, 0, { total: 2 }), commit(135, 0, { total: 30 })], frames, key).explanation;
    assert.deepEqual(handled.blame, { ...waited, ms: 60 });
    assert.ok(handled.notes.includes('The key press handler handleKey still ran for about 38 ms of the 80 ms of working time after the wait.'));
  }
  // So is 52 ms of forced layout in a keydown's 55 ms of handlers, with an 8 ms render between them and the keyup's.
  const forced = report(
    [entry('keydown', 0, 144, 60, 115), entry('keyup', 120, 24, 140, 140.2)],
    [commit(110, 0, { total: 6 }), commit(135, 0, { total: 8 })],
    [frame(50, 94, [script('INPUT.onkeydown', 60, 55, 52)])],
    [input(0, 'keydown')],
  );
  assert.deepEqual(forced.explanation.blame, { ...waited, ms: 60 });
  assert.match(forced.verdict, /The browser also spent 52 ms recalculating styles and layout in scripts before the paint\./);
  // Nor is one under a screen update longer than the working time, which closes the render rung: a transition render
  // that began before the keydown and committed between its handlers and the keyup's, 170 ms of it in a 130 ms gap,
  // after a 150 ms wait and before a 145 ms screen update. The wait is the longest phase, and the verdict.
  for (const frames of [[], null]) {
    const transition = report([entry('keydown', 0, 436, 150, 160), entry('keyup', 280, 156, 290, 291)], [commit(285, 0, { total: 170 })], frames, [input(0, 'keydown')]);
    assert.deepEqual(transition.explanation.blame, { ...waited, ms: 150 });
  }
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

test("a transition's effects React held until the click rendered are not counted, though it committed just before the handlers", () => {
  // The press set off a transition, which committed 0.4 ms before the click's handlers began. React held its
  // effects until the next render, the click's, so they ended after onClick had run for 290 ms: the span from the
  // commit to their end is the handler's time, not theirs.
  const transition = commit(1002.6, 1000, { startedAt: 999.6, total: 3, effectsStartedAt: 1002.6, effectsEndedAt: 1297 });
  const own = commit(1305, 1000, { startedAt: 1300, total: 5, effectsStartedAt: 1305, effectsEndedAt: 1306 });
  const r = report([entry('click', 1000, 330, 1003, 1320)], [transition, own], null, draw());
  assert.equal(r.explanation.blame.kind, 'handler');
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
  assert.match(dev.explanation.cause, /React spent 2 ms rendering across 2 commits, 1 ms of it re-rendering \w+\. React also spent 30 ms running useEffect callbacks across 2 commits\./);
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
  assert.match(r.explanation.cause, /React spent 31 ms rendering across 2 commits, 30 ms of it re-rendering 31 components inside List, .*\)\. React also spent 200 ms committing in another commit\.$/);
});

test("React's render time across several commits is said as their total with the named commit's share, not as the one's", () => {
  // handleSave runs for about 143 ms, List renders 30 components for 30 ms and Sidebar 500 for 25. The sentence
  // read "React spent 55 ms re-rendering 30 components inside List", putting Sidebar's 25 ms and 500 components there.
  const list = commit(40, 0, { total: 30 });
  const sidebar = commit(60, 0, { total: 25, rendered: 500, roots: ['Sidebar'], hotPath: ['Sidebar'], components: [{ name: 'Item', count: 500, self: 20, total: 20 }] });
  const across = '55 ms rendering across 2 commits, 30 ms of it re-rendering 30 components inside List, mostly Row (30 of them, 20 ms)';
  const handled = report([entry('click', 0, 216, 2, 200)], [list, sidebar], [], loginClick('handleSave')).explanation;
  assert.equal(handled.blame.kind, 'handler');
  assert.equal(handled.cause, `The click handler handleSave ran for about 143 ms; React spent ${across}.`);
  // The same beside a forced layout, and where the render is the verdict, which named List's 30 ms and never Sidebar's 25.
  const forced = [frame(0, 200, [script('BUTTON.onclick', 2, 178, 120)])];
  const layout = report([entry('click', 0, 200, 2, 180)], [list, sidebar], forced, loginClick('handleSave')).explanation;
  assert.equal(layout.blame.kind, 'layout');
  assert.match(layout.cause, new RegExp(` React spent ${across.replace(/[()]/g, '\\$&')}\\. `));
  const rendered = report([entry('click', 0, 72, 2, 64)], [list, sidebar], [], [input(0, 'click')]).explanation;
  assert.deepEqual(rendered.blame, { kind: 'render', name: 'List', detail: 'Row ×30', ms: 30, confidence: 'measured' });
  assert.equal(rendered.cause, `React spent ${across}.`);
  // A hedged sentence gives the named render against the working time first, and the total after it.
  const partial = report([entry('click', 0, 72, 2, 64)], [{ ...list, truncated: true }, sidebar], [], [input(0, 'click')]).explanation;
  assert.equal(
    partial.cause,
    'React most likely spent about 30 ms of the 62 ms of working time re-rendering at least 30 components inside List, and 55 ms of rendering in all across 2 commits.',
  );
  // Three renders of 3 ms earned the blame together, over the 5 ms a render needs, and read as 3 ms.
  const small = { total: 3, components: [{ name: 'Row', count: 30, self: 2, total: 2 }] };
  const three = report([entry('click', 0, 72, 2, 30)], [commit(10, 0, small), commit(15, 0, small), commit(20, 0, small)], [], [input(0, 'click')]).explanation;
  assert.deepEqual(three.blame, { kind: 'render', name: 'List', detail: 'Row ×30', ms: 3, confidence: 'measured' });
  assert.equal(three.cause, 'React spent 9 ms rendering across 3 commits, 3 ms of it re-rendering 30 components inside List, mostly Row (30 of them, 2 ms).');
  // One render beside a commit whose render rounds to nothing is said as it was.
  const alone = report([entry('click', 0, 72, 2, 40)], [commit(20, 0, { total: 0.2, rendered: 1 }), list], [], [input(0, 'click')]).explanation;
  assert.equal(alone.blame.kind, 'render');
  assert.equal(alone.cause, 'React spent 30 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms).');
  // Six of them, under 1 ms each and 2 ms together, are counted too. They read as List's: "React spent 32 ms
  // re-rendering 30 components inside List".
  const tiny = [50, 60, 70, 80, 90, 100].map((at) => commit(at, 0, { total: 0.4, rendered: 1 }));
  const specks = report([entry('click', 0, 216, 2, 200)], [list, ...tiny], [], [input(0, 'click')]).explanation;
  assert.equal(specks.blame.kind, 'handler');
  assert.equal(
    specks.cause,
    'Code outside React (the click handler or other scripts) ran for about 166 ms; React spent 32 ms rendering across 7 commits, 30 ms of it re-rendering 30 components inside List, mostly Row (30 of them, 20 ms).',
  );
  // Where one of them began before the handlers, what the working time held is said of the total.
  const early = report([entry('click', 0, 72, 2, 40)], [commit(12, 0, { startedAt: -8, total: 20 }), { ...sidebar, at: 39, startedAt: 14 }], [], [input(0, 'click')]).explanation;
  assert.equal(
    early.cause,
    'React spent 45 ms rendering across 2 commits, 25 ms of it re-rendering 500 components inside Sidebar, mostly Item (500 of them, 20 ms). Some of that rendering began before the handlers, so at most 35 ms of it was in the 38 ms of working time.',
  );
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
  const timed = blameOf({ at: 95, hasDurations: true, total: 60, roots: ['Xe'], hotPath: ['Xe'], components: [{ name: 'Nu', count: 5, self: 40, total: 40 }, { name: 'Panel', count: 50, self: 12, total: 12 }] });
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
    const stroke = host('path');
    const svg = host('svg', {}, [stroke]);
    children(svg.fiber, stroke.fiber);
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
  // The same where a script drew the icon, with no fiber, in an element its component hands the role to along
  // with the onClick: react-svg's `<ReactSVG src={trash} role="button" tabIndex={0} onClick={remove} />` renders
  // an empty `<div>` with them and SVGInjector draws the svg into it. A role handed down is the writer's, as the
  // onClick is, so the click is RemoveRow's with the role or without. An empty element whose component gives it
  // the role itself is a control of its own, and so is a `<button>`, whatever role it was handed: each is named
  // by the component that renders it, as IconButton's button is. A `<span>` whose svg an app's Icon sets through
  // dangerouslySetInnerHTML is the icon itself, as Trash2's `<svg>` is, so the click is RemoveRow's whoever gave
  // the span its role.
  const drawnIn = (wrapper: Record<string, unknown>, tag: string, given: Record<string, unknown>, rendered: Record<string, unknown>) => {
    const remove = () => {};
    const stroke = element('path', []);
    const holder = host(tag, {}, [{ el: element('svg', [stroke]) }]);
    const props: Record<string, unknown> = { ...given, ...rendered, onClick: remove };
    holder.fiber.memoizedProps = props;
    holder.el.getAttribute = (name: string) => (name === 'role' ? (props.role ?? null) : null);
    wrapper.memoizedProps = { ...given, onClick: remove };
    children(wrapper, holder.fiber);
    const label = host('span');
    const drawnRow = host('div', {}, [holder, label]);
    children(drawnRow.fiber, wrapper, label.fiber);
    const writer = component('RemoveRow');
    children(writer, drawnRow.fiber);
    children(component('Rows'), writer);
    return stroke;
  };
  const reactSvg = () => fiberOf(1, class ReactSVG {});
  const empty = { children: [false, false] };
  assert.deepEqual(ownersFor(drawnIn(reactSvg(), 'div', {}, empty)), ['RemoveRow', 'Rows']);
  assert.deepEqual(ownersFor(drawnIn(reactSvg(), 'div', { role: 'button', tabIndex: 0 }, empty)), ['RemoveRow', 'Rows']);
  assert.deepEqual(ownersFor(drawnIn(component('IconButton'), 'div', {}, { role: 'button', 'aria-label': 'Delete' })), ['IconButton', 'RemoveRow', 'Rows']);
  assert.deepEqual(ownersFor(drawnIn(component('IconButton'), 'button', { role: 'menuitem' }, { 'aria-label': 'Close' })), ['IconButton', 'RemoveRow', 'Rows']);
  const markup = { dangerouslySetInnerHTML: { __html: '<svg></svg>' } };
  assert.deepEqual(ownersFor(drawnIn(component('Icon'), 'span', { role: 'button' }, markup)), ['RemoveRow', 'Rows']);
  assert.deepEqual(ownersFor(drawnIn(component('Icon'), 'span', {}, { ...markup, role: 'button' })), ['RemoveRow', 'Rows']);
});

test("an icon a script drew outside React is read from the element holding it, whose handler is its own in a control", () => {
  // feather.replace() and Font Awesome's autoReplaceSvg swap the `<i>` React rendered for an `<svg>` React
  // never saw, so the svg has no fiber and is read from the element around it. IconButton handed that element
  // its onClick, but the click is still on IconButton's button.
  const fiberOf = (tag: number, type: unknown, props: Record<string, unknown> | null = null) =>
    ({ tag, flags: 1, mode: 0, elementType: type, type, memoizedProps: props, memoizedState: null, return: null, child: null, sibling: null, alternate: null }) as Record<string, unknown>;
  const component = (name: string, props: Record<string, unknown> | null = null) => fiberOf(0, Object.defineProperty(function () {}, 'name', { value: name }), props);
  /**
   * A host fiber and the element it stands for, which holds `nodes` in the page whatever React rendered in it
   * and has the `role` its props give it.
   */
  const host = (tag: string, props: Record<string, unknown> = {}, nodes: Record<string, unknown>[] = []) => {
    const el = element(tag, nodes, typeof props.role === 'string' ? { role: props.role } : {});
    const fiber = fiberOf(5, tag, props);
    fiber.stateNode = el;
    el.__reactFiber$k1 = fiber;
    return { el, fiber };
  };
  const ownersFor = (target: Record<string, unknown>) => report([entry('click', 0, 120, 3, 100, { target })], [], []).target?.owners;
  /**
   * `<IconButton onClick={close} />` beside a title in Page, IconButton rendering `<tag onClick={onClick}>` around
   * `rendered`: a fiber, text React writes into the element itself with no fiber for it, or nothing. `props` are
   * the element's others. `layer` is a component IconButton renders the element through, given its props, and
   * `given` what IconButton was given beside the onClick and hands the element with it.
   */
  const inIconButton = (tag: string, drawn: Record<string, unknown>, rendered: Record<string, unknown> | string | number | bigint | null, props: Record<string, unknown> = {}, { layer, given = {} }: { layer?: Record<string, unknown>; given?: Record<string, unknown> } = {}) => {
    const close = () => {};
    const written = rendered !== null && typeof rendered !== 'object';
    const holder = host(tag, written ? { ...given, ...props, onClick: close, children: rendered } : { ...given, ...props, onClick: close }, written ? [drawn, text(String(rendered))] : [drawn]);
    if (rendered !== null && typeof rendered === 'object') children(holder.fiber, rendered);
    const iconButton = component('IconButton', { ...given, onClick: close });
    if (layer) children(Object.assign(layer, { memoizedProps: holder.fiber.memoizedProps }), holder.fiber);
    children(iconButton, layer ?? holder.fiber);
    const title = host('h1');
    const header = host('header', {}, [holder.el, title.el]);
    children(header.fiber, iconButton, title.fiber);
    children(component('Page'), header.fiber);
  };
  const drawnOver = () => fiberOf(5, 'i', { 'data-feather': 'x' });

  const stroke = element('path', []);
  inIconButton('button', element('svg', [stroke]), drawnOver());
  assert.deepEqual(ownersFor(stroke), ['IconButton', 'Page']);
  // Where IconButton's element is a `<div onClick>`, which is not a control, the handler is the icon's: the
  // onClick IconButton handed the div is its caller's, as the one Trash2 hands its svg is.
  const inDiv = element('svg', []);
  inIconButton('div', inDiv, drawnOver());
  assert.deepEqual(ownersFor(inDiv), ['Page']);
  // An svg React rendered in the same button was placed there already.
  const rendered = host('svg');
  inIconButton('button', rendered.el, rendered.fiber);
  assert.deepEqual(ownersFor(rendered.el), ['IconButton', 'Page']);
  // So is one where the button's only child is text, which React writes into it with no fiber: the `<svg>`
  // Font Awesome's searchPseudoElements draws for an icon a stylesheet puts before `Close`, or before a count
  // of likes, a number or in React 19 a bigint. The same in a `<div role="button" onClick>` that
  // `<IconButton role="button" onClick={close} />` hands its role with its onClick, and in an `<i>` handed it
  // that way, where only that text tells the element holds the icon. In a `<div onClick>` the handler is the
  // icon's, text or not.
  const holders: [string, Record<string, unknown>, string[]][] = [
    ['button', {}, ['IconButton', 'Page']],
    ['div', { role: 'button' }, ['IconButton', 'Page']],
    ['i', { role: 'button' }, ['IconButton', 'Page']],
    ['div', {}, ['Page']],
  ];
  for (const [tag, given, owners] of holders) {
    for (const written of ['Close', 12, 12n]) {
      const drawn = element('svg', []);
      inIconButton(tag, drawn, written, {}, { given });
      assert.deepEqual(ownersFor(drawn), owners);
    }
  }
  // And where React rendered nothing in the button: an svg imported as a string and set through
  // dangerouslySetInnerHTML, or the `<svg>` Font Awesome's searchPseudoElements draws in an empty
  // `<button aria-label="Close">`. A button holds what is drawn in it, so the handler is its own.
  for (const props of [{ dangerouslySetInnerHTML: { __html: '<svg></svg>' } }, { 'aria-label': 'Close' }]) {
    const drawn = element('svg', []);
    inIconButton('button', drawn, null, props);
    assert.deepEqual(ownersFor(drawn), ['IconButton', 'Page']);
  }
  // So does a `<div role="button">`, a control as well.
  const inRoleButton = element('svg', []);
  inIconButton('div', inRoleButton, null, { role: 'button', 'aria-label': 'Close' });
  assert.deepEqual(ownersFor(inRoleButton), ['IconButton', 'Page']);
  // So does one IconButton renders through a styling layer, `<Clickable role="button" aria-label="Close"
  // onClick={onClick} />` with `const Clickable = styled.div`: Clickable was handed the role, but IconButton
  // wrote it, so the div is a control of IconButton's all the same.
  const inStyled = element('svg', []);
  const clickable = fiberOf(11, { $$typeof: Symbol.for('react.forward_ref'), render: () => null, styledComponentId: 'sc-a1b2', target: 'div' });
  inIconButton('div', inStyled, null, { role: 'button', 'aria-label': 'Close' }, { layer: clickable });
  assert.deepEqual(ownersFor(inStyled), ['styled.div', 'IconButton', 'Page']);
  // A role a script set on the div, which React never saw, was not handed down either.
  const inScriptRole = element('svg', []);
  inIconButton('div', inScriptRole, null, { 'aria-label': 'Close' });
  (inScriptRole.parentNode as Record<string, unknown>).getAttribute = (name: string) => (name === 'role' ? 'button' : null);
  assert.deepEqual(ownersFor(inScriptRole), ['IconButton', 'Page']);
  // A count of likes that `{count > 0 && count}` leaves out at 0 is a `false` React writes nothing for, and
  // `{count > 0 ? count : null}` a `null`: the count is written there at any other count, so an icon drawn
  // before it is placed as it is beside the count.
  for (const [tag, given, owners] of holders) {
    for (const nothing of [false, null]) {
      const drawn = element('svg', []);
      inIconButton(tag, drawn, null, { children: nothing }, { given });
      assert.deepEqual(ownersFor(drawn), owners);
    }
  }
  // Only a lone one, though. Two, as `{count > 0 && count}{liked && ' (you)'}` leaves at 0, or the empty list a
  // `.map()` returns, are nothing: the fiber holds them as it holds the `[false, false]` in the empty div
  // ReactSVG draws in, and cannot tell them apart. An icon drawn in a div handed its role that holds them is
  // the writer's until React renders something there. A button holds what is drawn in it either way.
  for (const nothing of [[false, false], []]) {
    const drawnInButton = element('svg', []);
    inIconButton('button', drawnInButton, null, { children: nothing });
    assert.deepEqual(ownersFor(drawnInButton), ['IconButton', 'Page']);
    const drawnInDiv = element('svg', []);
    inIconButton('div', drawnInDiv, null, { children: nothing }, { given: { role: 'button' } });
    assert.deepEqual(ownersFor(drawnInDiv), ['Page']);
  }

  // Markup set through dangerouslySetInnerHTML is the element's own, as the svg an icon library renders is:
  // an onClick the app's Icon handed its `<span>` names the component that wrote `<Icon onClick>`. So is the
  // `<svg>` Font Awesome draws in an empty `<i onClick>` when it nests the svg and keeps the `<i>`, with the
  // `role="button"` an accessible one is given or without, and the one it swaps for the `<i>` in Bulma's
  // `<span className="icon" onClick={onClick}><i className="fas fa-trash" /></span>`, where React still holds
  // the `<i>` the page no longer does.
  const shapes: [string, Record<string, unknown>, Record<string, unknown> | null][] = [
    ['span', { dangerouslySetInnerHTML: { __html: '<svg></svg>' } }, null],
    ['i', { className: 'fa-solid fa-trash' }, null],
    ['i', { className: 'fa-solid fa-trash', role: 'button' }, null],
    ['span', { className: 'icon' }, fiberOf(5, 'i', { className: 'fas fa-trash' })],
  ];
  for (const [tag, props, replaced] of shapes) {
    const remove = () => {};
    const glyph = element('svg', []);
    const holder = host(tag, { ...props, onClick: remove }, [glyph]);
    if (replaced) children(holder.fiber, replaced);
    const icon = component('Icon', { name: 'trash', onClick: remove });
    children(icon, holder.fiber);
    const writer = component('RemoveRow');
    children(writer, icon);
    const label = host('span');
    const row = host('div', {}, [holder.el, label.el]);
    children(row.fiber, writer, label.fiber);
    children(component('Rows'), row.fiber);
    assert.deepEqual(ownersFor(glyph), ['RemoveRow', 'Rows']);
  }
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
  const ring = [input(0, 'keydown', { target: target as unknown as Node, press: 'Enter', key: 'Enter', owners: ['OrderForm'] })];
  assert.equal(report(press, [], [], ring).target?.handler, 'submitOrder');
  // Any other key submits nothing, so nothing is named for the keypress's work.
  const other = [input(0, 'keydown', { target: target as unknown as Node, press: 'KeyA', key: 'KeyA', owners: ['OrderForm'] })];
  assert.equal(report(press, [], [], other).target?.handler, null);
  // Nor where an Enter 5 s before is still in the ring: the key is the one pressed at the entry's time.
  const later = [entry('keydown', 5000, 140, 5001, 5003, { target }), entry('keypress', 5000, 140, 5003, 5123, { target })];
  const typed = [...ring, input(5000, 'keydown', { target: target as unknown as Node, press: 'KeyA', key: 'KeyA', owners: ['OrderForm'] })];
  assert.equal(report(later, [], [], typed).target?.handler, null);
});

test("Enter's submit is named by the onSubmit its keypress reached at dispatch, where the submit's own render gave the form another", () => {
  // `onSubmit={step < 2 ? goNext : finish}`: Enter on the first step ran goNext from the keypress, and the submit's
  // render put finish on the form before the entries came, and on the fiber cached on it, which typing in the field
  // had rendered once before. The keypress has no record of its own; what it reached was read onto its keydown's as
  // it was dispatched.
  function goNext() {}
  function finish() {}
  function Wizard() {}
  const fiberOf = (tag: number, type: unknown, parent: Record<string, unknown> | null, props: Record<string, unknown> | null = null) =>
    ({ tag, flags: 1, mode: 0, elementType: type, type, memoizedProps: props, memoizedState: null, return: parent, child: null, sibling: null, alternate: null }) as Record<string, unknown>;
  const form = fiberOf(5, 'form', fiberOf(0, Wizard, null), { onSubmit: finish });
  form.stateNode = Object.assign(element('form', []), { __reactFiber$k1: form, __reactProps$k1: form.memoizedProps });
  const field = fiberOf(5, 'input', form, { type: 'text', name: 'email' });
  const target = Object.assign(element('input', [], { name: 'email' }), { __reactFiber$k1: field }) as unknown as Node;
  const press = [entry('keydown', 0, 140, 1, 3, { target }), entry('keypress', 0, 140, 3, 123, { target })];
  const keydown = (extra: Partial<InputRecord>) => [input(0, 'keydown', { target, press: 'Enter', key: 'Enter', owners: ['Wizard'], ...extra })];
  assert.equal(report(press, [], [], keydown({ keypressHandler: 'goNext' })).target?.handler, 'goNext');
  // Where the keypress reached nothing at dispatch, nothing ran, whatever the form has now.
  assert.equal(report(press, [], [], keydown({ keypressHandler: null })).target?.handler, null);
  // With no reading, as for a keypress on server HTML React had not hydrated, the form is read now.
  assert.equal(report(press, [], [], keydown({})).target?.handler, 'finish');
  // A Shift pressed with the Enter in the same millisecond has a keydown and no keypress, so no reading: the
  // Enter's is the one taken.
  const shift = input(0, 'keydown', { target, press: 'ShiftLeft', key: 'ShiftLeft', owners: ['Wizard'] });
  assert.equal(report(press, [], [], [shift, ...keydown({ keypressHandler: 'goNext' })]).target?.handler, 'goNext');
  // A form the submit took off the page: the entries have no target, and the reading still names it.
  const gone = press.map((e) => ({ ...e, target: null }));
  assert.equal(report(gone, [], [], keydown({ keypressHandler: 'goNext' })).target?.handler, 'goNext');
  // A step the submit took off the page, with focus on the next step's field: the keydown and keypress have no
  // target, and they tie, so the keydown's is looked for first. The keyup's target is the field that has focus
  // now, in a form that would run finish. The keydown's own record is still the one read.
  const next = Object.assign(element('input', [], { name: 'name' }), { __reactFiber$k1: fiberOf(5, 'input', form, { type: 'text', name: 'name' }) }) as unknown as Node;
  const moved = [entry('keydown', 0, 140, 1, 3), entry('keypress', 0, 140, 3, 5), entry('keyup', 80, 16, 81, 81.5, { target: next })];
  const keyup = input(80, 'keyup', { target: next, press: 'Enter', key: 'Enter', gestureTs: 0, owners: ['Wizard'] });
  assert.equal(report(moved, [], [], [...keydown({ handler: 'goNext', keypressHandler: 'goNext' }), keyup]).target?.handler, 'goNext');
});

test("an input method's Enter read from the element when the entry comes is read with the key the ring kept, as any other key", () => {
  // The Enter that commits an input method's text submits nothing, and the field's onChange runs from the input
  // event that ends the composition. On server HTML React had not hydrated at dispatch the ring had no handler to
  // read, so the field is read when the entry comes, and it is read as the ring read the key.
  function setEmail() {}
  function goNext() {}
  const fiberOf = (tag: number, type: unknown, parent: Record<string, unknown> | null, props: Record<string, unknown> | null = null) =>
    ({ tag, flags: 1, mode: 0, elementType: type, type, memoizedProps: props, memoizedState: null, return: parent, child: null, sibling: null, alternate: null }) as Record<string, unknown>;
  const form = fiberOf(5, 'form', null, { onSubmit: goNext });
  const field = fiberOf(5, 'input', form, { type: 'email', onChange: setEmail });
  const target = Object.assign(element('input', []), { __reactFiber$k1: field, __reactProps$k1: { type: 'email', onChange: setEmail } }) as unknown as Node;
  const keydown = (key: string | null) => [input(0, 'keydown', { target, press: 'Enter', key, dehydrated: { scope: 'boundary', owner: 'SignUp' } })];
  const composed = [entry('keydown', 0, 140, 1, 60, { target })];
  assert.equal(report(composed, [], [], keydown(null)).target?.handler, 'setEmail');
  // An Enter the input method did not take submits the form.
  assert.equal(report(composed, [], [], keydown('Enter')).target?.handler, 'goNext');
});

test("Enter on server HTML React hydrated inside the keydown is named by the keydown's element as React hydrated it", () => {
  // React hydrates the boundary a key lands on inside the keydown, to run it, so the keydown's entry carries the
  // hydration and outweighs the keypress's. The field was read again at the commit that hydrated it, before the
  // submit's render put finish on the form and on the fiber cached on it. Read when the entries came, it named the
  // step after.
  function goNext() {}
  function finish() {}
  function Wizard() {}
  const fiberOf = (tag: number, type: unknown, parent: Record<string, unknown> | null, props: Record<string, unknown> | null = null) =>
    ({ tag, flags: 1, mode: 0, elementType: type, type, memoizedProps: props, memoizedState: null, return: parent, child: null, sibling: null, alternate: null }) as Record<string, unknown>;
  const form = fiberOf(5, 'form', fiberOf(0, Wizard, null), { onSubmit: finish });
  form.stateNode = Object.assign(element('form', []), { __reactFiber$k1: form, __reactProps$k1: form.memoizedProps });
  const field = fiberOf(5, 'input', form, { type: 'text', name: 'email' });
  const target = Object.assign(element('input', [], { name: 'email' }), { __reactFiber$k1: field }) as unknown as Node;
  const hydrating = [entry('keydown', 0, 400, 1, 361, { target }), entry('keypress', 0, 400, 361, 393, { target })];
  const keydown = (extra: Partial<InputRecord>) => [input(0, 'keydown', { target, press: 'Enter', key: 'Enter', owners: ['Wizard'], dehydrated: { scope: 'boundary', owner: 'Wizard' }, ...extra })];
  assert.equal(report(hydrating, [], [], keydown({ handler: 'goNext', hydratedRead: true, keypressHandler: 'goNext' })).target?.handler, 'goNext');
  // A field with its own onKeyDown ran it in the keydown, which is that entry's handler and not the onSubmit its
  // keypress reached.
  assert.equal(report(hydrating, [], [], keydown({ handler: 'checkShortcut', hydratedRead: true, keypressHandler: 'goNext' })).target?.handler, 'checkShortcut');
  // A keydown React did not hydrate inside its own dispatch was not read again, and the form is read now.
  assert.equal(report(hydrating, [], [], keydown({})).target?.handler, 'finish');
});

test("an element read when the entry comes is read from the fiber cached on it, not from the props the event's own render put there", () => {
  // `onKeyDown={open ? closeMenu : openMenu}` on server HTML: openMenu ran, and its render put closeMenu on the
  // button before the entry came. The fiber cached on the button is the one React hydrated it with, and it still
  // holds openMenu.
  function openMenu() {}
  function closeMenu() {}
  function Toolbar() {}
  const host = (tag: string, cached: Record<string, unknown>, now: Record<string, unknown>) => {
    const owner = { tag: 0, flags: 0, mode: 0, elementType: Toolbar, type: Toolbar, memoizedProps: {}, memoizedState: null, return: null, child: null, sibling: null, alternate: null };
    const fiber: Record<string, unknown> = { tag: 5, flags: 0, mode: 0, elementType: tag, type: tag, memoizedProps: cached, memoizedState: null, return: owner, child: null, sibling: null, alternate: null };
    fiber.stateNode = Object.assign(element(tag, []), { __reactFiber$k1: fiber, __reactProps$k1: now });
    return fiber.stateNode as Node;
  };
  const dehydrated = { scope: 'boundary', owner: 'Toolbar' } as const;
  const pressed = (target: Node, extra: Partial<InputRecord> = {}) =>
    report([entry('keydown', 0, 140, 1, 126, { target })], [], [], [input(0, 'keydown', { target, press: 'ArrowDown', key: 'ArrowDown', dehydrated, ...extra })]).target?.handler;
  // React did not hydrate it inside the key's dispatch, so the record was not read again.
  assert.equal(pressed(host('button', { onKeyDown: openMenu }, { onKeyDown: closeMenu })), 'openMenu');
  // Where it did, the reading from then is taken. Here a layout effect rendered the button again, and the fiber cached
  // on it is the current one, with closeMenu too.
  assert.equal(pressed(host('button', { onKeyDown: closeMenu }, { onKeyDown: closeMenu }), { handler: 'openMenu', hydratedRead: true }), 'openMenu');
  // The `input` an input method sends has no record, and its render gave the field another onChange.
  function startSearch() {}
  function updateSearch() {}
  const field = host('input', { type: 'search', onChange: startSearch }, { type: 'search', onChange: updateSearch });
  assert.equal(report([entry('input', 0, 120, 1, 100, { target: field })], [], []).target?.handler, 'startSearch');
});

test("Enter in a field that submits by clicking the form's submit button is named by the onSubmit its keypress reached", () => {
  // Chromium submits a form from Enter in its field by clicking the submit button, inside the keypress, and times that
  // click in an entry of its own with the keypress's work. The button's onClick runs before the onSubmit that does the
  // work, and one for analytics, or the one a library's button always has, took the onSubmit's name.
  function placeOrder() {}
  function trackClick() {}
  function Checkout() {}
  const fiberOf = (tag: number, type: unknown, parent: Record<string, unknown> | null, props: Record<string, unknown> | null = null) =>
    ({ tag, flags: 1, mode: 0, elementType: type, type, memoizedProps: props, memoizedState: null, return: parent, child: null, sibling: null, alternate: null }) as Record<string, unknown>;
  const form = fiberOf(5, 'form', fiberOf(0, Checkout, null), { onSubmit: placeOrder });
  const node = (tag: string, props: Record<string, unknown>) =>
    Object.assign(element(tag, []), { __reactFiber$k1: fiberOf(5, tag, form, props), __reactProps$k1: props }) as unknown as Node;
  const field = node('input', { type: 'text', name: 'qty' });
  const buy = node('button', { type: 'submit', onClick: trackClick });
  const pressed = (on: Node) => [entry('keydown', 0, 100, 1, 1.5, { target: on }), entry('keypress', 0, 100, 2, 82, { target: on }), entry('click', 0, 100, 2, 82, { target: buy })];
  // What the keypress reached, and the onSubmit apart from it, as the ring read them at its dispatch.
  const ring = (on: Node, keypressSubmit: string | null, clickHandler = 'trackClick', keypressHandler = keypressSubmit) => [
    input(0, 'keydown', { target: on, press: 'Enter', key: 'Enter', owners: ['Checkout'], keypressHandler, keypressSubmit }),
    input(0, 'click', { target: buy, press: -1, owners: ['Checkout'], handler: clickHandler }),
  ];
  assert.equal(report(pressed(field), [], [], ring(field, 'placeOrder')).target?.handler, 'placeOrder');
  // A form the submit took off the page: the entries have no target, and the keypress's reading still names it.
  const gone = pressed(field).map((e) => ({ ...e, target: null }));
  assert.equal(report(gone, [], [], ring(field, 'placeOrder')).target?.handler, 'placeOrder');
  // A form with no onSubmit: the keypress reached nothing, and the button's onClick that the click ran did the work.
  assert.equal(report(pressed(field), [], [], ring(field, null, 'saveOrder')).target?.handler, 'saveOrder');
  // Enter on the button itself clicks the element the key was on, which is named as a click on it is.
  assert.equal(report(pressed(buy), [], [], ring(buy, 'placeOrder')).target?.handler, 'trackClick');
  // A field that keeps to digits with its own onKeyPress: the keypress reached that first, and ran it before the click.
  // It did none of the click's work, which is the onSubmit's, and with no onSubmit the button's onClick's.
  assert.equal(report(pressed(field), [], [], ring(field, 'placeOrder', 'trackClick', 'onlyDigits')).target?.handler, 'placeOrder');
  assert.equal(report(gone, [], [], ring(field, 'placeOrder', 'trackClick', 'onlyDigits')).target?.handler, 'placeOrder');
  assert.equal(report(pressed(field), [], [], ring(field, null, 'saveOrder', 'onlyDigits')).target?.handler, 'saveOrder');
  // Firefox times the submit in the keypress entry alone, which the onKeyPress begins, and nothing there tells its
  // work from the onSubmit's: the keypress's own reading names it.
  const firefox = [entry('keypress', 0, 100, 2, 82, { target: field })];
  assert.equal(report(firefox, [], [], ring(field, 'placeOrder', 'trackClick', 'onlyDigits')).target?.handler, 'onlyDigits');
  // So does Chromium for a form with no submit button, which Enter in its one field submits with no click.
  const noButton = pressed(field).slice(0, 2);
  assert.equal(report(noButton, [], [], ring(field, 'placeOrder', 'trackClick', 'onlyDigits').slice(0, 1)).target?.handler, 'onlyDigits');
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
  // A script the frame lists after the handlers is still named: React's render did not run in it. It is said
  // to have run after the handler finished, or it reads as the handler's.
  const later = at(52.4, [frame(0, 80, [script('setTimeout', 58, 22, 0)])]);
  assert.deepEqual([later.blame.kind, later.blame.name, later.blame.detail, later.blame.confidence], ['script', 'setTimeout', null, 'measured']);
  assert.equal(
    later.cause,
    'In 49 ms of working time, short of a long task, React was re-rendering 56 components inside Presence; a script (setTimeout, app.js) ran for 22 ms after the handler finished.',
  );
  // A count that committed after the handlers did not sit in the working time, and is said to have come after it: 800
  // rows committed 25 ms after 30 ms of handlers read "In 30 ms of working time, short of a long task, React was
  // re-rendering 800 components", where the same rows after 55 ms of handlers ran "after the handlers".
  const rows = commit(60, 0, { hasDurations: false, total: 0, rendered: 800, components: [{ name: 'Row', count: 800, self: null, total: null }] });
  const afterShort = (frames: FrameSummary[] | null) => report([entry('click', 0, 72, 5, 35)], [rows], frames, [input(0, 'click')]).explanation;
  assert.equal(afterShort(null).blame.kind, 'none');
  assert.equal(
    afterShort(null).cause,
    'After the 30 ms of working time, short of a long task, React was re-rendering 800 components inside List, mostly Row (800 of them), before the next frame; this browser does not report long tasks, so what else ran is unknown.',
  );
  assert.match(afterShort([]).cause, /^After the 30 ms of working time, short of a long task, React was re-rendering 800 components inside List, mostly Row \(800 of them\), before the next frame; the rest went/);
  // Nor is the handler's script kept from the verdict there: the rows rendered after it, in React's own task, not in
  // it. Kept, a 28 ms handleSave in the 30 ms of working time was said nowhere, where beside no render it was named.
  const task = [frame(0, 72, [script('BUTTON.onclick', 6, 28), script('MessagePort.onmessage', 36, 24)])];
  const handledFirst = report([entry('click', 0, 72, 5, 35)], [rows], task, loginClick('handleSave')).explanation;
  assert.deepEqual(handledFirst.blame, { kind: 'script', name: 'handleSave', detail: 'SignInPage', ms: 28, confidence: 'measured' });
  assert.equal(
    handledFirst.cause,
    'After the 30 ms of working time, short of a long task, React was re-rendering 800 components inside List, mostly Row (800 of them), before the next frame; the click handler handleSave ran for 28 ms.',
  );
  assert.deepEqual(report([entry('click', 0, 72, 5, 35)], [], task, loginClick('handleSave')).explanation.blame, handledFirst.blame);
  // It is kept from the verdict where a count that sat in the working time would have named a render too, and a count
  // the handler's own script held sat there, whatever its stamp: beside 150 rows committed in the handler, the 800
  // after it made the 28 ms handleSave the verdict, and so did 800 rows committed at 43 ms in a handler that ran to
  // 43.5, past the paint the duration's rounding put at 40, which also read as "After the 35 ms of working time". The
  // sentence is about the count in the working time, too: the 150 rows, where it put the 800 after it and said the
  // 150 nowhere. The 800 are the second of the two renders the note counts.
  const counted = (at: number, rendered: number) => commit(at, 0, { hasDurations: false, total: 0, rendered, components: [{ name: 'Row', count: rendered, self: null, total: null }] });
  const alsoInside = (frames: FrameSummary[] | null) => report([entry('click', 0, 72, 5, 35)], [counted(20, 150), rows], frames, loginClick('handleSave')).explanation;
  assert.deepEqual(alsoInside(task).blame, afterShort([]).blame);
  assert.equal(alsoInside(task).cause, 'In 30 ms of working time, short of a long task, React was re-rendering 150 components inside List, mostly Row (150 of them); the rest went to waiting and painting.');
  assert.deepEqual(alsoInside(task).notes, ['React rendered 2 times before the screen updated, which usually means a state update inside an effect or a chain of updates.']);
  assert.equal(alsoInside(null).cause, 'In 30 ms of working time, short of a long task, React was re-rendering 150 components inside List, mostly Row (150 of them); this browser does not report long tasks, so what else ran is unknown.');
  // The click's own handler time holds the 800 rows committed at 43 ms, whether or not a frame recorded its script.
  const heldInside = (frames: FrameSummary[] | null) => report([entry('click', 0, 40, 5, 43.5)], [counted(43, 800)], frames, loginClick('handleSave')).explanation;
  const inHandler = heldInside([frame(0, 50, [script('BUTTON.onclick', 6, 37.5)])]);
  assert.equal(inHandler.blame.kind, 'none');
  assert.equal(inHandler.cause, 'In 35 ms of working time, short of a long task, React was re-rendering 800 components inside List, mostly Row (800 of them); the rest went to waiting and painting.');
  assert.equal(
    heldInside([]).cause,
    'In 35 ms of working time, short of a long task, React was re-rendering 800 components inside List, mostly Row (800 of them); the rest went to waiting and painting. No long animation frame covered the click, so how much of the working time went to any styles and layout it forced is unmeasured.',
  );
  assert.equal(heldInside(null).cause, 'In 35 ms of working time, short of a long task, React was re-rendering 800 components inside List, mostly Row (800 of them); this browser does not report long tasks, so what else ran is unknown.');
  // The render verdict places it the same way over a long task of working time, where it read "after the handlers".
  const heldLonger = (frames: FrameSummary[] | null) => report([entry('click', 0, 60, 5, 63.5)], [counted(63, 800)], frames, loginClick('handleSave')).explanation;
  for (const frames of [[frame(0, 70, [script('BUTTON.onclick', 6, 57.5)])], [], null]) {
    assert.match(heldLonger(frames).cause, /^React was most likely re-rendering 800 components inside List, mostly Row \(800 of them\), in the 55 ms of working time\. /);
  }
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
  assert.match(r.explanation.cause, /^React spent 25 ms rendering across 2 commits, 5 ms of it re-rendering 12 components inside Panel\. Committing it took about 60 ms more/);
  // Named for its committing, a commit whose render took no time the clock could measure is still one of the renders
  // counted, or the sentence read "React spent 0 ms re-rendering 12 components inside Panel".
  for (const total of [0.3, 0]) {
    const unmeasured = report(click, [mount, { ...effects, total, components: [{ name: 'Row', count: 5, self: 0, total: 0 }] }], []);
    assert.match(unmeasured.explanation.cause, /^React spent 20 ms rendering across 2 commits, under 1 ms of it re-rendering 12 components inside Panel\. Committing it took about 65 ms more/);
  }
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
  assert.deepEqual(scheduled.explanation.notes, [
    'React rendered 2 times before the screen updated, which usually means a state update inside an effect or a chain of updates.',
    'React still spent 160 ms re-rendering 721 components inside TableBody in the 169 ms of working time before that.',
  ]);
  // Where it is the heavier, it is still taken out of the working time, as the handlers' own render is said there.
  const scheduledHeavier = report(
    [entry('click', 0, 368, 2, 171)],
    [handled, { ...forced, total: 170, priority: 3 }],
    [frame(0, 368, [script('INPUT.onclick', 2, 169), script('MessagePort.onmessage', 175, 174)])],
    [input(0, 'click')],
  );
  assert.match(scheduledHeavier.explanation.cause, /React rendered inside it: 170 ms /);
  assert.deepEqual(scheduledHeavier.explanation.notes, scheduled.explanation.notes);

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
  assert.deepEqual(onlyForced.explanation.notes, ['Code outside React (the click handler or other scripts) still ran for all 169 ms of working time before that.']);

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

  // The script's render, begun and committed inside a later event's handlers, is not taken back out of the working
  // time's React time: it was never in it.
  const tap = report(
    [entry('pointerdown', 0, 200, 2, 62), entry('pointerup', 100, 120, 101, 140)],
    [
      commit(30, 0, { inputType: 'pointerdown', total: 5, startedAt: 25, effectsStartedAt: 30, effectsEndedAt: 58 }),
      commit(138, 100, { inputType: 'pointerup', total: 30, startedAt: 105 }),
    ],
    [frame(0, 200, [script('DIV.onpointerdown', 2, 60), script('DIV.onpointerup', 101, 39)])],
    [input(0, 'pointerdown'), input(100, 'pointerup')],
  );
  assert.match(tap.explanation.cause, /DIV\.onpointerup.*React rendered inside it: 30 ms /);
  assert.deepEqual(tap.explanation.notes, [
    'React still spent 5 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms) and 28 ms running its useEffect callbacks in the 60 ms of working time before that.',
  ]);
});

test('a screen update no script took is put on the browser recalculating styles and layout, timed where the frame timed it', () => {
  // A class changed on 40,000 elements, in Chromium. From Enter the frame times its own style and layout: 211 ms.
  const key = report([entry('keydown', 0, 240, 10, 12)], [], [frame(10, 222, [], 22)], [input(0, 'keydown')]);
  assert.equal(key.explanation.blame.kind, 'painting');
  assert.equal(
    key.explanation.cause,
    'After the key press was handled, the screen took another 228 ms to update, mostly the browser recalculating styles and layout and painting the frame: 210 ms.',
  );

  // From a click the same work comes before the frame renders, and is only frame time no script ran in.
  const click = report([entry('click', 0, 232, 1, 2)], [], [frame(0, 214, [], 214)], [input(0, 'click')]);
  assert.equal(
    click.explanation.cause,
    "After the click was handled, the screen took another 230 ms to update. No script ran for long in that time: 212 ms of it was the browser's own work on the main thread, most likely recalculating styles and layout for what changed.",
  );

  // Where the frames saw less than half of it, nothing is said of why, as before.
  const unseen = report([entry('click', 0, 232, 1, 2)], [], [frame(0, 90, [], 90)], [input(0, 'click')]);
  assert.equal(unseen.explanation.cause, 'After the click was handled, the screen took another 230 ms to update.');

  // A script that ran after the handlers still takes it, as it did.
  const scripted = report([entry('click', 0, 232, 1, 2)], [], [frame(0, 214, [script('FrameRequestCallback', 3, 150)], 153)], [input(0, 'click')]);
  assert.match(scripted.explanation.cause, /mostly because a script \(FrameRequestCallback, app\.js\) ran for 150 ms before the next frame\.$/);
});

test('a script after the handlers is what held the screen update only from half of it, and under that is said after the browser', () => {
  // A 400 ms click whose frame spent 250 ms on its own style, layout and paint, and 20 ms on a timer.
  const click = [entry('click', 0, 400, 2, 30)];
  const handled = commit(20, 0, { total: 3 });
  const timer = (duration: number, styleAndLayoutStart = 150) => [
    frame(0, 400, [script('BUTTON.onclick', 2, 28), script('TimerHandler:setTimeout', 100, duration)], styleAndLayoutStart),
  ];
  const small = report(click, [handled], timer(20), [input(0, 'click')]);
  assert.deepEqual(small.explanation.blame, { kind: 'painting', name: null, detail: null, ms: 370, confidence: 'measured' });
  assert.equal(
    small.explanation.cause,
    'After the click was handled, the screen took another 370 ms to update, mostly the browser recalculating styles and layout and painting the frame: 250 ms. The longest script the browser recorded in that time was TimerHandler:setTimeout (app.js), 20 ms.',
  );

  // A render inside that timer is still said with it, and is not put in the working time before it.
  const rendered = report(click, [handled, commit(110, 0, { total: 15, startedAt: 101 })], timer(20), [input(0, 'click')]);
  assert.match(rendered.explanation.cause, /, 20 ms, and React rendered inside it: 15 ms re-rendering 30 components inside List/);
  assert.ok(!rendered.explanation.notes.some((n) => n.includes('15 ms')), rendered.explanation.notes.join(' | '));
  // And where the browser gave the timer no name, the render is still said.
  const nameless = report(
    click,
    [handled, commit(110, 0, { total: 15, startedAt: 101 })],
    [frame(0, 400, [script('BUTTON.onclick', 2, 28), { invoker: '', name: '', source: 'app.js', start: 100, duration: 20, forcedLayout: 0 }], 150)],
    [input(0, 'click')],
  );
  assert.equal(
    nameless.explanation.cause,
    'After the click was handled, the screen took another 370 ms to update, mostly the browser recalculating styles and layout and painting the frame: 250 ms. The longest script the browser recorded in that time was one with no name (app.js), 20 ms, and React rendered inside it: 15 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms).',
  );
  assert.ok(!nameless.explanation.notes.some((n) => n.includes('15 ms')), nameless.explanation.notes.join(' | '));

  // Frame time no script ran in is not said to have had no script in it where one ran for 150 ms.
  const unscripted = report(click, [handled], timer(150, 330), [input(0, 'click')]);
  assert.equal(unscripted.explanation.blame.name, null);
  assert.equal(
    unscripted.explanation.cause,
    "After the click was handled, the screen took another 370 ms to update: 220 ms of it was the browser's own work on the main thread, most likely recalculating styles and layout for what changed. The longest script the browser recorded in that time was TimerHandler:setTimeout (app.js), 150 ms.",
  );
  // A script the browser gave no name is said all the same, with no render inside it.
  const unnamed = report(
    click,
    [handled],
    [frame(0, 400, [script('BUTTON.onclick', 2, 28), { invoker: '', name: '', source: 'app.js', start: 100, duration: 150, forcedLayout: 0 }], 330)],
    [input(0, 'click')],
  );
  assert.match(unnamed.explanation.cause, /\. The longest script the browser recorded in that time was one with no name \(app\.js\), 150 ms\.$/);
  // And from half of the screen update, in the same words.
  const nameless200 = report(
    click,
    [handled],
    [frame(0, 400, [script('BUTTON.onclick', 2, 28), { invoker: '', name: '', source: 'app.js', start: 100, duration: 200, forcedLayout: 0 }], 330)],
    [input(0, 'click')],
  );
  assert.match(nameless200.explanation.cause, /, mostly because a script with no name \(app\.js\) ran for 200 ms before the next frame\.$/);

  // From half of the 370 ms the timer is the reason, and the blame's name.
  const half = report(click, [handled], timer(185, 300), [input(0, 'click')]);
  assert.equal(half.explanation.blame.name, 'TimerHandler:setTimeout');
  assert.match(half.explanation.cause, /, mostly because a script \(TimerHandler:setTimeout, app\.js\) ran for 185 ms before the next frame\.$/);
  assert.equal(report(click, [handled], timer(184, 300), [input(0, 'click')]).explanation.blame.name, null);

  // Two scripts that held 270 of the 370 ms between them, neither of them half, are said together, as the
  // scripts between one event's handlers and the next are, and neither is the blame's name.
  const two = (commits: CommitSummary[]) =>
    report(
      click,
      [handled, ...commits],
      [frame(0, 400, [script('BUTTON.onclick', 2, 28), script('A.onscroll', 40, 150), script('B.onscroll', 195, 120)], 330)],
      [input(0, 'click')],
    ).explanation;
  assert.deepEqual(two([]).blame, { kind: 'painting', name: null, detail: null, ms: 370, confidence: 'measured' });
  assert.equal(
    two([]).cause,
    'After the click was handled, the screen took another 370 ms to update. Scripts ran for 270 ms of it, the longest a script (A.onscroll, app.js) for 150 ms.',
  );
  assert.equal(
    two([commit(180, 0, { total: 15, startedAt: 150 })]).cause,
    'After the click was handled, the screen took another 370 ms to update. Scripts ran for 270 ms of it, the longest a script (A.onscroll, app.js) for 150 ms, and React rendered inside that one: 15 ms re-rendering 30 components inside List, mostly Row (30 of them, 20 ms).',
  );
  // One the browser gave no name is a script with no name, and not "the longest one with no name", which reads
  // as the longest of the ones with none.
  const unnamedTwo = report(
    click,
    [handled],
    [frame(0, 400, [script('BUTTON.onclick', 2, 28), { invoker: '', name: '', source: 'app.js', start: 40, duration: 150, forcedLayout: 0 }, script('B.onscroll', 195, 120)], 330)],
    [input(0, 'click')],
  ).explanation;
  assert.equal(
    unnamedTwo.cause,
    'After the click was handled, the screen took another 370 ms to update. Scripts ran for 270 ms of it, the longest a script with no name (app.js) for 150 ms.',
  );
  // At 180 ms together, with the last 100 ms in no long frame and the browser's own work under half too, the
  // longest is said on its own.
  assert.equal(
    report(click, [handled], [frame(0, 300, [script('BUTTON.onclick', 2, 28), script('A.onscroll', 40, 150), script('B.onscroll', 195, 30)], 280)], [input(0, 'click')]).explanation
      .cause,
    'After the click was handled, the screen took another 370 ms to update. The longest script the browser recorded in that time was A.onscroll (app.js), 150 ms.',
  );
});

test('a screen update over 100 ms gets its note under another verdict where the working time was longer too', () => {
  // twenty's select-all in a production build: a 1712 ms click, 947 ms of it the handler rendering 4632 components,
  // then 762 ms of the screen updating, 712 of it the frame's own style, layout and paint.
  const rows = {
    rendered: 4632,
    roots: ['RecordIndexFiltersToContextStoreEffect', 'RecordTableHeaderCheckboxColumn'],
    hotPath: ['RecordTableHeaderCheckboxColumn'],
    components: [{ name: 'RecordTableCell', count: 4000, self: null, total: null }],
    hasDurations: false,
    total: 0,
  };
  const selectAll = report(
    [entry('click', 0, 1712, 3, 950)],
    [commit(940, 0, rows)],
    [frame(0, 952, [script('#document.onclick', 3, 947)]), frame(960, 752, [], 1000)],
    [input(0, 'click')],
  );
  assert.equal(selectAll.explanation.blame.kind, 'render');
  assert.deepEqual(selectAll.explanation.notes, [
    'After the handler finished, the screen took another 762 ms to update, mostly the browser recalculating styles and layout and painting the frame: 712 ms.',
  ]);

  // Over 100 ms, not at it or under it: 197 ms of working time, then 104, 100 and 96 ms of the screen updating.
  const rendered = (end: number) =>
    report([entry('click', 0, end, 3, 200)], [commit(190, 0, { total: 150 })], [frame(0, end, [script('#document.onclick', 3, 197)], 210)], [input(0, 'click')]).explanation;
  assert.equal(rendered(304).blame.kind, 'render');
  assert.deepEqual(rendered(304).notes, ['After the handler finished, the screen took another 104 ms to update, mostly the browser recalculating styles and layout and painting the frame: 94 ms.']);
  assert.deepEqual(rendered(300).notes, []);
  assert.deepEqual(rendered(296).notes, []);

  // TanStack Virtual's checkbox at 4x: the handler rendered the table for 129 ms, then the frame waited on the
  // scroll listener, which forced a second render of it. That render is the script's, said with it, and not an
  // effect's, even where the 143 ms of working time was longer than the 142 ms of the screen updating.
  const checkbox = (end: number) =>
    report(
      [entry('click', 0, end, 3, 146)],
      [
        commit(140, 0, { total: 129, rendered: 737, roots: ['TableBody'], hotPath: ['TableBody'], startedAt: 8 }),
        commit(260, 0, { total: 89, rendered: 721, roots: ['TableBody'], hotPath: ['TableBody'], startedAt: 150 }),
      ],
      [frame(0, end, [script('INPUT.onclick', 3, 143), script('DIV.onscroll', 148, 130)], 280)],
      [input(0, 'click')],
    ).explanation;
  const onscroll = checkbox(288);
  assert.equal(onscroll.cause, 'React spent 129 ms re-rendering 737 components inside TableBody.');
  assert.deepEqual(onscroll.notes, [
    'After the handler finished, the screen took another 142 ms to update, mostly because a script (DIV.onscroll, app.js) ran for 130 ms before the next frame, and React rendered inside it: 89 ms re-rendering 721 components inside TableBody.',
  ]);
  // The same click with the screen update the longer part says it in the same words, as the verdict.
  assert.equal(
    checkbox(296).cause,
    'After the click was handled, the screen took another 150 ms to update, mostly because a script (DIV.onscroll, app.js) ran for 130 ms before the next frame, and React rendered inside it: 89 ms re-rendering 721 components inside TableBody.',
  );
  // On a faster machine the screen update is under 100 ms, and the render the listener forced is still the
  // listener's: said with it in the note, and not counted as a second render, as though an effect made it.
  const faster = report(
    [entry('click', 0, 242, 3, 146)],
    [
      commit(140, 0, { total: 129, rendered: 737, roots: ['TableBody'], hotPath: ['TableBody'], startedAt: 8 }),
      commit(228, 0, { total: 70, rendered: 721, roots: ['TableBody'], hotPath: ['TableBody'], startedAt: 150 }),
    ],
    [frame(0, 242, [script('INPUT.onclick', 3, 143), script('DIV.onscroll', 148, 85)], 234)],
    [input(0, 'click')],
  ).explanation;
  assert.equal(faster.cause, onscroll.cause);
  assert.deepEqual(faster.notes, [
    'After the handler finished, the screen took another 96 ms to update, mostly because a script (DIV.onscroll, app.js) ran for 85 ms before the next frame, and React rendered inside it: 70 ms re-rendering 721 components inside TableBody.',
  ]);
  // Where the handler rendered nothing and the script's render was the only one, the verdict does not say
  // React rendered nothing at all.
  const scrolledBy = (ring: InputRecord[]) =>
    report(
      [entry('click', 0, 296, 3, 153)],
      [commit(270, 0, { total: 100, rendered: 721, roots: ['TableBody'], hotPath: ['TableBody'], startedAt: 160 })],
      [frame(0, 296, [script('INPUT.onclick', 3, 150), script('DIV.onscroll', 155, 130)], 290)],
      ring,
    ).explanation;
  const scrolled = scrolledBy([input(0, 'click')]);
  assert.equal(scrolled.cause, "React didn't render anything in the working time; a script (INPUT.onclick, app.js) ran for 150 ms.");
  assert.deepEqual(scrolled.notes, [
    'After the handler finished, the screen took another 143 ms to update, mostly because a script (DIV.onscroll, app.js) ran for 130 ms before the next frame, and React rendered inside it: 100 ms re-rendering 721 components inside TableBody.',
  ]);
  // Nor that it rendered nothing in the working time, where a commit in it could not be tied to the click.
  assert.equal(
    scrolledBy([input(0, 'click', { work: { endedAt: 0, unjoined: [100] } })]).cause,
    'React rendered during it, but 1 commit could not be tied to this click; most likely a script (INPUT.onclick, app.js) ran for 150 ms.',
  );

  // The handlers split across three listeners, each shorter than the scroll listener after them, which held
  // the screen update. The verdict names the longest script wherever it ran, and says it ran after the
  // handler finished, so it does not read as working time; the note says the render inside it.
  const splitUp = (handlers: ScriptSummary[]) =>
    report(
      [entry('click', 0, 360, 3, 203)],
      [commit(340, 0, { total: 100, rendered: 721, roots: ['TableBody'], hotPath: ['TableBody'], startedAt: 210 })],
      [frame(0, 360, [...handlers, script('DIV.onscroll', 205, 150)], 356)],
      [input(0, 'click')],
    ).explanation;
  const threeListeners = [script('BUTTON.onpointerdown', 3, 60), script('BUTTON.onpointerup', 65, 60), script('BUTTON.onclick', 130, 70)];
  const split = splitUp(threeListeners);
  assert.deepEqual(split.blame, { kind: 'script', name: 'DIV.onscroll', detail: null, ms: 150, confidence: 'measured' });
  assert.equal(split.cause, "React didn't render anything in the working time; a script (DIV.onscroll, app.js) ran for 150 ms after the handler finished.");
  assert.deepEqual(split.notes, [
    'After the handler finished, the screen took another 157 ms to update, mostly because a script (DIV.onscroll, app.js) ran for 150 ms before the next frame, and React rendered inside it: 100 ms re-rendering 721 components inside TableBody.',
  ]);
  // A task starts only once the one before it has finished, so a listener that starts on the very timestamp the
  // handlers ended on is not the handler, and is named by what ran it: a clamped clock puts a scroll task right
  // after the click's on the same value. Taken for the handler, it read as handleSave running after the handler
  // finished, and the blame had handleSave's name.
  const saveClick = [input(0, 'click', { target: element('button', [text('Save')]) as unknown as Node, owners: ['SaveButton'], handler: 'handleSave' })];
  const onTheEnd = report(
    [entry('click', 0, 360, 3, 203)],
    [commit(340, 0, { total: 100, rendered: 721, roots: ['TableBody'], hotPath: ['TableBody'], startedAt: 210 })],
    [frame(0, 360, [...threeListeners, script('DIV.onscroll', 203, 152)], 356)],
    saveClick,
  ).explanation;
  assert.deepEqual(onTheEnd.blame, { kind: 'script', name: 'DIV.onscroll', detail: null, ms: 152, confidence: 'measured' });
  assert.equal(onTheEnd.cause, "React didn't render anything in the working time; a script (DIV.onscroll, app.js) ran for 152 ms after the handler finished.");
  assert.deepEqual(onTheEnd.notes, [
    'After the handler finished, the screen took another 157 ms to update, mostly because a script (DIV.onscroll, app.js) ran for 152 ms before the next frame, and React rendered inside it: 100 ms re-rendering 721 components inside TableBody.',
  ]);
  // The same where the screen update outranked the working time and took the blame.
  const painted = report(
    [entry('click', 0, 460, 3, 203)],
    [],
    [frame(0, 460, [...threeListeners, script('DIV.onscroll', 203, 250)], 456)],
    saveClick,
  ).explanation;
  assert.deepEqual(painted.blame, { kind: 'painting', name: 'DIV.onscroll', detail: null, ms: 257, confidence: 'measured' });
  assert.equal(painted.cause, 'After the click was handled, the screen took another 257 ms to update, mostly because a script (DIV.onscroll, app.js) ran for 250 ms before the next frame.');
  // React's own task after the same handlers is React rendering what they scheduled, a transition started from
  // the click, and not a script that forced a render. With the working time the longer part, that render stays
  // in it, measured or read from the counts, and the note says it ran inside the task: named alone, the task
  // read as a script that held the screen update, with nothing to say it was the render the verdict names.
  const transition = (rows: Partial<CommitSummary>) =>
    report(
      [entry('click', 0, 360, 3, 203)],
      [commit(340, 0, { rendered: 721, roots: ['TableBody'], hotPath: ['TableBody'], priority: 3, ...rows })],
      [frame(0, 360, [...threeListeners, script('MessagePort.onmessage', 205, 150)], 356)],
      [input(0, 'click')],
    ).explanation;
  const measured = transition({ total: 100, startedAt: 210 });
  assert.deepEqual(measured.blame, { kind: 'render', name: 'TableBody', detail: '721 components', ms: 100, confidence: 'measured' });
  assert.deepEqual(measured.notes, [
    'After the handler finished, the screen took another 157 ms to update, mostly because a script (MessagePort.onmessage, app.js) ran for 150 ms before the next frame, and React rendered inside it: 100 ms re-rendering 721 components inside TableBody.',
  ]);
  const counted = transition({ total: 0, hasDurations: false, components: [{ name: 'Row', count: 700, self: null, total: null }] });
  assert.deepEqual(counted.blame, { kind: 'render', name: 'TableBody', detail: 'Row ×700', ms: null, confidence: 'inferred' });
  assert.deepEqual(counted.notes, [
    'After the handler finished, the screen took another 157 ms to update, mostly because a script (MessagePort.onmessage, app.js) ran for 150 ms before the next frame, and React rendered inside it: re-rendering 721 components inside TableBody, mostly Row (700 of them).',
  ]);
  // Ranked by where they ran, ten click handlers of 20 ms took the verdict from the 150 ms listener that ten of
  // 19 ms left it to. By length, neither does, and a handler longer than the listener takes it.
  const tenClicks = Array.from({ length: 10 }, (_, i) => script('BUTTON.onclick', 3 + i * 20, 15));
  for (const each of [15, 19, 20]) {
    const spread = splitUp(Array.from({ length: 10 }, (_, i) => script('BUTTON.onclick', 3 + i * 20, each)));
    assert.deepEqual(spread.blame, split.blame, `${each} ms handlers`);
    assert.equal(spread.cause, split.cause, `${each} ms handlers`);
  }
  const longer = splitUp([script('BUTTON.onclick', 3, 190)]);
  assert.deepEqual(longer.blame, { kind: 'script', name: 'BUTTON.onclick', detail: null, ms: 190, confidence: 'measured' });
  assert.equal(longer.cause, "React didn't render anything in the working time; a script (BUTTON.onclick, app.js) ran for 190 ms.");
  // The same where the handlers rendered too: 3 components in a production build do not put the listener in
  // the working time.
  const alongside = (handlers: ScriptSummary[]) =>
    report(
      [entry('click', 0, 360, 3, 203)],
      [
        commit(195, 0, { hasDurations: false, total: 0, rendered: 3, components: [{ name: 'Row', count: 3, self: null, total: null }] }),
        commit(340, 0, { hasDurations: false, total: 0, rendered: 721, roots: ['TableBody'], hotPath: ['TableBody'] }),
      ],
      [frame(0, 360, [...handlers, script('DIV.onscroll', 205, 150)], 356)],
      [input(0, 'click')],
    ).explanation;
  const small = alongside(threeListeners);
  assert.deepEqual(small.blame, split.blame);
  assert.equal(
    small.cause,
    "React's render was small (re-rendering 3 components inside List, mostly Row (3 of them)); a script (DIV.onscroll, app.js) ran for 150 ms after the handler finished.",
  );
  assert.equal(
    alongside([script('BUTTON.onclick', 3, 190)]).cause,
    "React's render was small (re-rendering 3 components inside List, mostly Row (3 of them)); a script (BUTTON.onclick, app.js) ran for 190 ms.",
  );
  // A 40 ms listener in a 157 ms screen update that went mostly on the frame's style and layout held neither
  // phase, so the verdict does not name it. It is the note's, with the render inside it, and the verdict is the
  // 200 ms of handlers React rendered nothing in.
  const minor = report(
    [entry('click', 0, 360, 3, 203)],
    [commit(240, 0, { total: 25, rendered: 721, roots: ['TableBody'], hotPath: ['TableBody'], startedAt: 210 })],
    [frame(0, 360, [...tenClicks, script('DIV.onscroll', 205, 40)], 250)],
    [input(0, 'click')],
  ).explanation;
  assert.deepEqual(minor.blame, { kind: 'handler', name: null, detail: null, ms: 200, confidence: 'measured' });
  assert.match(minor.cause, /; React didn't render anything in the working time\.$/);
  assert.deepEqual(minor.notes, [
    'After the handler finished, the screen took another 157 ms to update, mostly the browser recalculating styles and layout and painting the frame: 110 ms. The longest script the browser recorded in that time was DIV.onscroll (app.js), 40 ms, and React rendered inside it: 25 ms re-rendering 721 components inside TableBody, mostly Row (30 of them, 20 ms).',
  ]);
});

test("a screen update that took the blame for React's own task names the component React rendered inside it, not the task", () => {
  // A cascading effect tapped on a phone: the click re-renders one component, and the state its effect sets
  // renders 400 rows in React's next task, before the paint. The row read "screen took 132 ms to update ·
  // MessagePort.onmessage", React's scheduler, which the page never wrote.
  const cascade = (hasDurations: boolean, invoker = 'MessagePort.onmessage') =>
    report(
      [entry('pointerdown', 0, 16, 1, 2), entry('click', 20, 136, 21, 24)],
      [
        commit(23, 20, { rendered: 1, roots: ['CascadingEffect'], hotPath: ['CascadingEffect'], components: [{ name: 'CascadingEffect', count: 1, self: 0.3, total: 0.3 }], total: hasDurations ? 0.3 : 0, hasDurations }),
        commit(120, 20, {
          rendered: 401,
          roots: ['CascadingEffect'],
          hotPath: ['CascadingEffect'],
          components: [{ name: 'Detail', count: 400, self: hasDurations ? 80 : null, total: hasDurations ? 80 : null }],
          total: hasDurations ? 90 : 0,
          hasDurations,
          priority: 3,
          startedAt: hasDurations ? 27 : null,
        }),
      ],
      [frame(20, 136, [script('DIV#root.onclick', 21, 3), script(invoker, 26, 96)])],
      [input(0, 'pointerdown'), input(20, 'click')],
    ).explanation;
  for (const hasDurations of [true, false]) {
    const { blame, cause } = cascade(hasDurations);
    assert.deepEqual(blame, { kind: 'painting', name: 'CascadingEffect', detail: null, ms: 132, confidence: 'measured' }, `durations: ${hasDurations}`);
    // The sentence still says what ran, the task and the render inside it.
    assert.match(cause, /^After the click was handled, the screen took another 132 ms to update, mostly because a script \(MessagePort\.onmessage, app\.js\) ran for 96 ms before the next frame, and React rendered inside it: /);
  }
  // A script the page wrote keeps the blame's name, whatever React rendered inside it.
  assert.equal(cascade(true, 'DIV.onscroll').blame.name, 'DIV.onscroll');
});

test("a render stamped inside React's own task stays there, not in a longer script starting under a millisecond after it", () => {
  // handleSave ran from 1 to 61 ms, React's own task from 62 to 67.5 ms committed a production render of 800 rows at
  // 67 ms, and a timer ran from 68 to 90 ms. The stamp is a millisecond from the timer's start, and it was put in the
  // timer, so React rendered nothing in the working time and the render was said to be the timer's.
  const click = [entry('click', 0, 116, 1, 61)];
  const save = loginClick('handleSave');
  const rows = commit(67, 0, { hasDurations: false, total: 0, rendered: 800, components: [{ name: 'Row', count: 800, self: null, total: null }] });
  const handled = script('BUTTON.onclick', 1, 60);
  const run = (at: number, scripts: ScriptSummary[]) => report(click, [{ ...rows, at }], [frame(0, 116, [handled, ...scripts])], save);
  const counted = { kind: 'render', name: 'List', detail: 'Row ×800', ms: null, confidence: 'inferred' };
  const tie = run(67, [script('MessagePort.onmessage', 62, 5.5), script('TimerHandler:setTimeout', 68, 22)]);
  assert.deepEqual(tie.explanation.blame, counted);
  assert.doesNotMatch(tie.verdict, /React rendered inside/);
  // A stamp at the end of React's task is in it, though 62.3 + 4.6 adds up to a hair under 66.9.
  assert.deepEqual(run(66.9, [script('MessagePort.onmessage', 62.3, 4.6), script('TimerHandler:setTimeout', 67.5, 22)]).explanation.blame, counted);
  // And where the timer started on the tick React's task ended, which is the task's, not the timer's.
  const tick = run(67, [script('MessagePort.onmessage', 62, 5), script('TimerHandler:setTimeout', 67, 22)]);
  assert.deepEqual(tick.explanation.blame, counted);
  assert.doesNotMatch(tick.verdict, /React rendered inside/);
  // The same a millisecond past the end of a longer script before React's task.
  const past = run(84.8, [script('TimerHandler:setTimeout', 62, 22), script('MessagePort.onmessage', 84.5, 5.5)]);
  assert.deepEqual(past.explanation.blame, counted);
  assert.doesNotMatch(past.verdict, /React rendered inside/);
  // A stamp no script holds is still the timer's where it starts within a millisecond after it.
  const between = run(67, [script('MessagePort.onmessage', 62, 4.5), script('TimerHandler:setTimeout', 68, 22)]);
  assert.equal(between.explanation.blame.kind, 'script');
  assert.match(between.verdict, /TimerHandler:setTimeout \(app\.js\), 22 ms, and React rendered inside it: re-rendering 800 components/);
});

test("a verdict does not say no long task was recorded where the screen update's note names one, and names a script the click waited behind", () => {
  // Ten 15 ms click handlers, then a 70 ms scroll listener that forced a render of 721 rows: under half of the
  // 157 ms screen update, so the note says it after the browser's 80 ms. The verdict is on the working time.
  const tenClicks = Array.from({ length: 10 }, (_, i) => script('BUTTON.onclick', 3 + i * 20, 15));
  const table = { total: 25, rendered: 721, roots: ['TableBody'], hotPath: ['TableBody'], startedAt: 210 };
  const seventy = (commits: CommitSummary[], ring = [input(0, 'click')]) =>
    report([entry('click', 0, 360, 3, 203)], commits, [frame(0, 360, [...tenClicks, script('DIV.onscroll', 205, 70)], 280)], ring).explanation;
  // That is 200 ms of handlers React rendered nothing in, so the verdict is theirs, as it is beside a 1 ms render there.
  const listener = seventy([commit(270, 0, table)]);
  assert.deepEqual(listener.blame, { kind: 'handler', name: null, detail: null, ms: 200, confidence: 'measured' });
  assert.equal(listener.cause, "Code outside React (the click handler or other scripts) ran for about 200 ms; React didn't render anything in the working time.");
  assert.deepEqual(listener.notes, [
    'After the handler finished, the screen took another 157 ms to update, mostly the browser recalculating styles and layout and painting the frame: 80 ms. The longest script the browser recorded in that time was DIV.onscroll (app.js), 70 ms, and React rendered inside it: 25 ms re-rendering 721 components inside TableBody, mostly Row (30 of them, 20 ms).',
  ]);
  // Where the handlers were too short to be the verdict, it says no long task was recorded in the working time, and not
  // that React rendered nothing: 20 ms of handlers before a 20 ms listener that rendered.
  const short = report(
    [entry('click', 0, 72, 3, 23)],
    [commit(40, 0, { ...table, total: 10, startedAt: 28 })],
    [frame(0, 72, [script('BUTTON.onclick', 3, 15), script('DIV.onscroll', 25, 20)], 50)],
    [input(0, 'click')],
  ).explanation;
  assert.deepEqual(short.blame, { kind: 'none', name: null, detail: null, ms: null, confidence: 'measured' });
  assert.equal(short.cause, "React didn't render anything in the working time and no long task was recorded in it, so the time went to waiting and painting.");
  // The same where the handlers rendered 3 components of their own in a production build.
  const three = commit(195, 0, { hasDurations: false, total: 0, rendered: 3, components: [{ name: 'Row', count: 3, self: null, total: null }] });
  const small = seventy([three, commit(270, 0, { ...table, hasDurations: false, total: 0, startedAt: null })]);
  assert.equal(
    small.cause,
    "React's render was small (re-rendering 3 components inside List, mostly Row (3 of them)) and no long task was recorded in the working time, so the rest went to waiting and painting.",
  );
  // With no render in the listener the note names it all the same, over 100 ms, and the verdict is the same:
  // taken without the render, the listener was a `script` verdict, and with it `none`, for the same 70 ms.
  const bare = seventy([three]);
  assert.deepEqual([bare.blame, bare.cause], [small.blame, small.cause]);
  assert.deepEqual(bare.notes, [
    'After the handler finished, the screen took another 157 ms to update, mostly the browser recalculating styles and layout and painting the frame: 80 ms. The longest script the browser recorded in that time was DIV.onscroll (app.js), 70 ms.',
  ]);
  // From half of the screen update the listener is the verdict's, said as after the handler finished, and so is
  // one in a screen update of 100 ms or under, which has no note to name it.
  const listened = (end: number, duration: number, styleAndLayoutStart: number) =>
    report([entry('click', 0, end, 3, 203)], [three], [frame(0, end, [...tenClicks, script('DIV.onscroll', 205, duration)], styleAndLayoutStart)], [input(0, 'click')])
      .explanation;
  const half = listened(360, 80, 290);
  assert.deepEqual(half.blame, { kind: 'script', name: 'DIV.onscroll', detail: null, ms: 80, confidence: 'measured' });
  assert.equal(half.cause, "React's render was small (re-rendering 3 components inside List, mostly Row (3 of them)); a script (DIV.onscroll, app.js) ran for 80 ms after the handler finished.");
  const unnoted = listened(299, 70, 280);
  assert.deepEqual([unnoted.blame.kind, unnoted.blame.name, unnoted.notes], ['script', 'DIV.onscroll', []]);
  assert.equal(unnoted.cause, "React's render was small (re-rendering 3 components inside List, mostly Row (3 of them)); a script (DIV.onscroll, app.js) ran for 70 ms after the handler finished.");
  // At exactly 100 ms as well, for a 40 ms listener under half of it.
  const hundred = listened(303, 40, 280);
  assert.deepEqual([hundred.blame.kind, hundred.blame.name, hundred.notes], ['script', 'DIV.onscroll', []]);
  assert.match(hundred.cause, /; a script \(DIV\.onscroll, app\.js\) ran for 40 ms after the handler finished\.$/);
  // And where a commit could not be tied to the click, "it" would be the click, so the working time is said.
  assert.equal(
    seventy([commit(270, 0, table)], [input(0, 'click', { work: { endedAt: 0, unjoined: [100] } })]).cause,
    'React rendered during it, but 1 commit could not be tied to this click and no long task was recorded in the working time, so the time went to waiting and painting.',
  );

  // A 62 ms timer the click waited 63 ms behind, then the handlers and a 40 ms listener as above. The timer is
  // the longest script outside the one the note names, so the verdict names it, as before the handler started:
  // it did not run in the working time the sentence begins with.
  const shifted = Array.from({ length: 10 }, (_, i) => script('BUTTON.onclick', 63 + i * 20, 15));
  const behind = report(
    [entry('click', 0, 420, 63, 263)],
    [commit(300, 0, { ...table, startedAt: 270 })],
    [frame(0, 420, [script('TimerHandler:setTimeout', 0, 62), ...shifted, script('DIV.onscroll', 265, 40)], 310)],
    [input(0, 'click')],
  ).explanation;
  assert.deepEqual(behind.blame, { kind: 'script', name: 'TimerHandler:setTimeout', detail: null, ms: 62, confidence: 'measured' });
  assert.equal(behind.cause, "React didn't render anything in the working time; a script (TimerHandler:setTimeout, app.js) ran for 62 ms before the handler started.");
  // That is the 63 ms the click waited, so no note says the wait again.
  assert.deepEqual(behind.notes, [
    'After the handler finished, the screen took another 157 ms to update, mostly the browser recalculating styles and layout and painting the frame: 110 ms. The longest script the browser recorded in that time was DIV.onscroll (app.js), 40 ms, and React rendered inside it: 25 ms re-rendering 721 components inside TableBody, mostly Row (30 of them, 20 ms).',
  ]);
  // And with no render in the listener, which the note names all the same.
  const behindBare = report(
    [entry('click', 0, 420, 63, 263)],
    [],
    [frame(0, 420, [script('TimerHandler:setTimeout', 0, 62), ...shifted, script('DIV.onscroll', 265, 40)], 310)],
    [input(0, 'click')],
  ).explanation;
  assert.deepEqual(behindBare.blame, behind.blame);
  assert.equal(behindBare.cause, "React didn't render anything; a script (TimerHandler:setTimeout, app.js) ran for 62 ms before the handler started.");
  assert.deepEqual(behindBare.notes, [
    'After the handler finished, the screen took another 157 ms to update, mostly the browser recalculating styles and layout and painting the frame: 110 ms. The longest script the browser recorded in that time was DIV.onscroll (app.js), 40 ms.',
  ]);
  // A timer that held under half of the wait is said as before the handler started all the same, and the wait is
  // still said: a 30 ms timer in a 120 ms wait left the other 90 ms said nowhere. One that held 115 ms of it is the
  // wait, as the 62 ms timer is.
  const save = loginClick('handleSave');
  const tenLater = Array.from({ length: 10 }, (_, i) => script('BUTTON.onclick', 121 + i * 20, 15));
  const timerIn = (duration: number) =>
    report([entry('click', 0, 460, 120, 330)], [], [frame(0, 460, [script('TimerHandler:setTimeout', 120 - duration, duration), ...tenLater, script('DIV.onscroll', 335, 40)], 420)], save).explanation;
  const part = timerIn(30);
  assert.deepEqual(part.blame, { kind: 'script', name: 'TimerHandler:setTimeout', detail: null, ms: 30, confidence: 'measured' });
  assert.equal(part.cause, "React didn't render anything; a script (TimerHandler:setTimeout, app.js) ran for 30 ms before the handler started.");
  assert.deepEqual(part.notes, [
    'It also waited 120 ms before the handler could start, because the main thread was busy.',
    "After the handler finished, the screen took another 130 ms to update: 90 ms of it was the browser's own work on the main thread, most likely recalculating styles and layout for what changed. The longest script the browser recorded in that time was DIV.onscroll (app.js), 40 ms.",
  ]);
  const most = timerIn(115);
  assert.equal(most.cause, "React didn't render anything; a script (TimerHandler:setTimeout, app.js) ran for 115 ms before the handler started.");
  assert.deepEqual(most.notes, [part.notes[1]]);

  // A 120 ms timer the click waited 121 ms behind, a 25 ms pointerdown listener, then a 40 ms scroll listener
  // that held the 61 ms screen update and forced a render. The timer is the longest, and is not dropped for the
  // pointerdown because the render moved out of the working time.
  const sixClicks = Array.from({ length: 6 }, (_, i) => script('BUTTON.onclick', 150 + i * 17, 16));
  const timerFirst = (commits: CommitSummary[]) =>
    report(
      [entry('click', 0, 312, 121, 251)],
      commits,
      [frame(0, 312, [script('TimerHandler:setTimeout', 0, 120), script('BUTTON.onpointerdown', 121, 25), ...sixClicks, script('DIV.onscroll', 253, 40)], 300)],
      [input(0, 'click')],
    ).explanation;
  // With no note on the listener it is still said as before the handler started, and as the 121 ms wait.
  assert.equal(timerFirst([]).cause, "React didn't render anything; a script (TimerHandler:setTimeout, app.js) ran for 120 ms before the handler started.");
  assert.deepEqual(timerFirst([]).notes, []);
  const forced = timerFirst([commit(290, 0, { ...table, total: 30, rendered: 200, startedAt: 255 })]);
  assert.deepEqual(forced.blame, { kind: 'script', name: 'TimerHandler:setTimeout', detail: null, ms: 120, confidence: 'measured' });
  assert.equal(forced.cause, "React didn't render anything in the working time; a script (TimerHandler:setTimeout, app.js) ran for 120 ms before the handler started.");
  // So is a timer that began before the click, cut at its start: said bare, its 60 ms read as a cost of its own,
  // then "It also waited 60 ms" as another, though they were the same 60 ms.
  const sevenClicks = Array.from({ length: 7 }, (_, i) => script('DOCUMENT.onclick', 60 + i * 14.2, 13.7));
  const cut = report([entry('click', 0, 200, 60, 160)], [], [frame(-10, 210, [script('TimerHandler:setTimeout', -10, 70), ...sevenClicks])], save).explanation;
  assert.deepEqual(cut.blame, { kind: 'script', name: 'TimerHandler:setTimeout', detail: null, ms: 60, confidence: 'measured' });
  assert.equal(cut.cause, "React didn't render anything; a script (TimerHandler:setTimeout, app.js) ran for 60 ms of it before the handler started.");
  assert.deepEqual(cut.notes, []);
});

test("a wait between one event's handlers and the next is put on the wait, not on the handlers", () => {
  // Enter on a button whose click changed a class on 30,000 cells, in Chromium: the keydown and the click it
  // made took 1 ms, then 147 ms went by before the keyup's handler ran, the browser restyling the page.
  const enter = (frames: FrameSummary[] | null, handlerEnds = 10.4, inputs = [input(0, 'keydown')], commits = [commit(handlerEnds + 0.5, 0, { total: 0.3, rendered: 2 })]) =>
    report([entry('keydown', 0, 168, 10, handlerEnds), entry('click', 0, 168, handlerEnds, handlerEnds + 0.7), entry('keyup', 1, 168, 158, 158.2)], commits, frames, inputs);
  const quiet = enter([frame(10, 147, [], 157)]);
  assert.deepEqual(quiet.explanation.blame, { kind: 'waiting', name: null, detail: 'between click and keyup', ms: 146.9, confidence: 'measured' });
  assert.equal(
    quiet.explanation.cause,
    "The handlers took 1 ms in all, but 147 ms went by between the click's handlers and the keyup's. No script ran in that time, so it was most likely the browser recalculating styles and layout for what the handlers before it changed. That time counts as working time, which runs from the first handler to the last.",
  );

  // A script that ran for part of it is said, and the rest is still the wait.
  const timer = enter([frame(10, 147, [script('TimerHandler:setTimeout', 50, 30)], 157)]);
  assert.equal(timer.explanation.blame.kind, 'waiting');
  assert.match(timer.explanation.cause, / A script \(TimerHandler:setTimeout, app\.js\) ran for 30 ms of it, and the rest was most likely the browser recalculating styles and layout/);

  // A script that filled it is what the keyup waited behind, as a wait before the handlers would be, and it is
  // not the handler, which had finished before it started.
  const filled = enter([frame(10, 147, [script('TimerHandler:setTimeout', 20, 120)], 157)], 10.4, [input(0, 'keydown', { handler: 'onSwitch' })]);
  assert.deepEqual([filled.explanation.blame.kind, filled.explanation.blame.name], ['waiting', 'TimerHandler:setTimeout']);
  assert.match(filled.explanation.cause, /keyup's\. A script \(TimerHandler:setTimeout, app\.js\) ran for 120 ms of it\. That time counts/);
  // Beside a handler that did less, too: the handler's listener is never the script in the gap.
  const beside = report(
    [entry('keydown', 0, 176, 10, 70), entry('keyup', 1, 176, 170, 170.5)],
    [commit(69, 0, { total: 0.3, rendered: 2 })],
    [frame(10, 161, [script('DOCUMENT.onkeydown', 10, 60), script('TimerHandler:setTimeout', 72, 95)], 171)],
    [input(0, 'keydown')],
  );
  assert.deepEqual([beside.explanation.blame.kind, beside.explanation.blame.name, beside.explanation.blame.detail], ['waiting', 'TimerHandler:setTimeout', 'between keydown and keyup']);
  // A React render in it is weighed as a render, not as the wait.
  const renderedIn = enter([frame(10, 147, [script('MessagePort.onmessage', 20, 120)], 157)], 10.4, [input(0, 'keydown')], [commit(10.9, 0, { total: 0.3, rendered: 2 }), commit(139, 0, { total: 115, rendered: 300 })]);
  assert.equal(renderedIn.explanation.blame.kind, 'render');
  // Painted in one frame, the handlers had the main thread busy between them, so where no long frame covers the
  // gap the frame is not on record yet: the wait is still the verdict, and it says so rather than name what ran.
  const unframed = enter([]);
  assert.deepEqual([unframed.explanation.blame.kind, unframed.explanation.blame.detail], ['waiting', 'between click and keyup']);
  assert.match(unframed.explanation.cause, /keyup's\. React did not render in it, and no long animation frame that says what else ran has been recorded yet, so it was most likely /);

  // Without Long Animation Frames only React's part in it is known.
  assert.match(enter(null).explanation.cause, / React did not render in it, and this browser does not record what else ran, so it was most likely /);
  const smallRender = enter(null, 10.4, [input(0, 'keydown')], [commit(80, 0, { total: 0.2, rendered: 1 })]);
  assert.match(smallRender.explanation.cause, / React rendered for under 1 ms of it, and /);
  // A production build says React rendered, and nothing of how long.
  const unTimed = enter(null, 10.4, [input(0, 'keydown')], [commit(80, 0, { total: 0, hasDurations: false, rendered: 3, components: [{ name: 'Row', count: 3, self: null, total: null }] })]);
  assert.match(unTimed.explanation.cause, / React rendered in it, and this browser does not record what else ran/);
  // And where React is not read at all, not even that, so nothing is put on the wait.
  const late = report(
    [entry('keydown', 0, 168, 10, 10.4), entry('click', 0, 168, 10.4, 11.1), entry('keyup', 1, 168, 158, 158.2)],
    [],
    null,
    [input(0, 'keydown')],
    'attributes',
    [],
    undefined,
    'installed-late',
  );
  assert.equal(late.explanation.blame.kind, 'none');

  // The frames can reach a report after it is built, so they change what is said of the wait and never how long it
  // was: a 100 ms render in the keydown's handlers and a 147 ms wait after them is the wait's however much of it
  // the frames cover yet.
  const renderThenWait = (frames: FrameSummary[] | null) =>
    report(
      [entry('keydown', 0, 264, 10, 110), entry('click', 0, 264, 110, 110.7), entry('keyup', 1, 264, 258, 258.2)],
      [commit(109, 0, { total: 100, startedAt: 9, rendered: 40 })],
      frames,
      [input(0, 'keydown')],
    ).explanation;
  for (const covered of [0, 73, 74, 110, 147]) {
    const e = renderThenWait(covered ? [frame(10, 100.7 + covered, [], null)] : []);
    assert.deepEqual([covered, e.blame.kind, e.blame.detail], [covered, 'waiting', 'between click and keyup']);
  }
  assert.match(renderThenWait([frame(10, 247.7, [], null)]).cause, /keyup's\. No script ran in that time/);
  assert.match(renderThenWait([frame(10, 174.7, [], null)]).cause, /keyup's\. React did not render in it, and no long animation frame that says what else ran has been recorded yet/);
  // A frame on record with a script in it says the script, and that the rest is not on record yet.
  assert.match(
    enter([frame(10, 60, [script('TimerHandler:setTimeout', 12, 55)])]).explanation.cause,
    /keyup's\. A script \(TimerHandler:setTimeout, app\.js\) ran for 55 ms of it, and no long animation frame over the rest has been recorded yet, so the rest was most likely /,
  );
  // Before its frame arrives, a render in the gap is weighed as it is without Long Animation Frames.
  assert.match(
    enter([], 10.4, [input(0, 'keydown')], [commit(10.9, 0, { total: 0.3, rendered: 2 }), commit(80, 0, { total: 0.2, rendered: 1 })]).explanation.cause,
    / React rendered for under 1 ms of it, and no long animation frame that says what else ran has been recorded yet/,
  );
  assert.equal(enter([], 10.4, [input(0, 'keydown')], unTimed.commits.slice()).explanation.blame.kind, unTimed.explanation.blame.kind);
  // When the frame arrives, the report is revised and the verdict stays.
  const entries = [entry('keydown', 0, 168, 10, 10.4), entry('click', 0, 168, 10.4, 11.1), entry('keyup', 1, 168, 158, 158.2)];
  const commits = [commit(10.9, 0, { total: 0.3, rendered: 2 })];
  const before = buildReport(entries, commits, [], [input(0, 'keydown')]);
  const after = sealReport(refreshReport(before, entries, commits, [frame(10, 147, [], 157)], [input(0, 'keydown')]));
  assert.deepEqual([sealReport(before).explanation.blame.kind, after.explanation.blame.kind], ['waiting', 'waiting']);
  assert.match(after.explanation.cause, /keyup's\. No script ran in that time/);
  // What the keyup waited starts at its own input: a key held down for 100 ms, while a paint held up off the main
  // thread kept both events in one frame, is no wait at all.
  const held = report([entry('keydown', 0, 168, 0.2, 1.2), entry('keyup', 100, 64, 100.1, 100.3)], [], [], [input(0, 'keydown')]);
  assert.notEqual(held.explanation.blame.kind, 'waiting');
  // Held down while the thread was busy, the time before the release is the wait all the same: people hold a key
  // for 80 to 150 ms. A long frame over it says so. Without one nothing places what ran before the release, so
  // only the time after it counts: 90 ms from a release at 60, under 50 from one at 120 or 140.
  for (const up of [60, 120, 140]) {
    const keys = [entry('keydown', 0, 168, 2, 6), entry('keyup', up, 168 - up, 150, 150.2)];
    const timer = report(keys, [], [frame(2, 160, [script('TimerHandler:setTimeout', 6.5, 143)], 151)], [input(0, 'keydown')]).explanation;
    assert.deepEqual([up, timer.blame.kind, timer.blame.name, Math.round(timer.blame.ms!)], [up, 'waiting', 'TimerHandler:setTimeout', 144]);
    for (const frames of [[], null]) {
      const blind = report(keys, [], frames, [input(0, 'keydown')]).explanation;
      assert.deepEqual([up, blind.blame.kind === 'waiting', blind.blame.kind === 'waiting' && Math.round(blind.blame.ms!)], [up, up === 60, up === 60 && 90]);
      // Nothing is said to be idle where no frame could have said otherwise.
      if (up === 60) assert.match(blind.cause, /\. No long animation frame says what ran in 54 ms of it, before the keyup came, so the wait counted is the other 90 ms\./);
    }
  }
  // Nor is a short task at the release taken for the whole hold: the keyup's handlers starting 7 ms after it say
  // nothing of the 99 ms before. The render is the answer, with or without the frames.
  const shortTask = [entry('keydown', 0, 176, 0.2, 1.2), entry('keyup', 100, 76, 107, 168)];
  const keyupRender = [commit(167.5, 100, { total: 60, startedAt: 107.5, rendered: 300 })];
  for (const frames of [null, [], [frame(96, 76, [script('TimerHandler:setInterval', 96, 11), script('DIV#root.onkeyup', 107, 61)], 168)]]) {
    assert.equal(report(shortTask, keyupRender, frames, [input(0, 'keydown')]).explanation.blame.kind, 'render');
  }
  // A timer the keydown's handler left behind is not lost to a 48 ms handler, nor, on a mouse, to a 60 ms one.
  const behind = report(
    [entry('keydown', 0, 168, 2, 50), entry('keyup', 120, 48, 150, 150.2)],
    [commit(49, 0, { total: 0.5, rendered: 1 })],
    [frame(2, 160, [script('DIV#root.onkeydown', 2, 48), script('TimerHandler:setTimeout', 50.5, 99.5)], 151)],
    [input(0, 'keydown')],
  ).explanation;
  assert.deepEqual([behind.blame.kind, behind.blame.name], ['waiting', 'TimerHandler:setTimeout']);
  const pressed = report(
    [entry('pointerdown', 0, 216, 1, 2), entry('pointerup', 100, 116, 150, 150.2), entry('click', 100, 116, 150.2, 210)],
    [commit(209, 100, { total: 0.5, rendered: 1 })],
    [frame(1, 210, [script('TimerHandler:setTimeout', 2.5, 147.5), script('BUTTON.onclick', 150.2, 59.8)], 211)],
    [input(0, 'pointerdown'), input(100, 'click')],
  ).explanation;
  assert.deepEqual([pressed.blame.kind, pressed.blame.name, pressed.blame.detail], ['waiting', 'TimerHandler:setTimeout', 'between pointerdown and pointerup']);
  // A render before the release is part of the wait it kept the thread busy in, not taken off the wait after it.
  const renderFirst = (frames: FrameSummary[] | null) =>
    report([entry('keydown', 0, 168, 2, 6), entry('keyup', 70, 98, 150, 150.2)], [commit(66.5, 0, { total: 60, startedAt: 6.5, rendered: 300 })], frames, [input(0, 'keydown')]).explanation;
  const framed = renderFirst([frame(2, 160, [script('MessagePort.onmessage', 6.5, 60), script('TimerHandler:setTimeout', 70, 80)], 151)]);
  assert.deepEqual([framed.blame.kind, framed.blame.name], ['waiting', 'TimerHandler:setTimeout']);
  // A render that kept its durations places itself: without the frames it is still busy time before the release,
  // and the 80 ms after it is the wait.
  const renderedHold = renderFirst(null);
  assert.equal(renderedHold.blame.kind, 'waiting');
  assert.doesNotMatch(renderedHold.cause, /still down/);
  // A render with no durations places nothing, and the script it committed in, where a frame recorded one, is
  // that render, not a wait on React's scheduler task.
  const prodHold = (frames: FrameSummary[] | null) =>
    report([entry('keydown', 0, 176, 0.2, 1.2), entry('keyup', 100, 76, 100.1, 100.3)], [commit(90, 0, { total: 0, hasDurations: false, rendered: 300 })], frames, [
      input(0, 'keydown'),
    ]).explanation;
  for (const frames of [null, [], [{ ...frame(0.2, 170, [script('MessagePort.onmessage', 1.3, 88.7)], 165), blocking: 44 }]]) {
    assert.equal(prodHold(frames).blame.kind, 'render');
  }
  // So is one time-sliced into React's scheduler tasks, a transition's, committing in the last of them; and a
  // render committed in one task, beside a 58 ms timer the rest of the gap reaches 50 ms with.
  const slices = Array.from({ length: 15 }, (_, i) => script('MessagePort.onmessage', 1.3 + i * 5.8, 5.5));
  const sliced = report(
    [entry('keydown', 0, 176, 0.2, 1.2), entry('keyup', 100, 76, 100.1, 100.3)],
    [commit(87.5, 0, { total: 0, hasDurations: false, rendered: 300 })],
    [frame(0.2, 170, slices, 165)],
    [input(0, 'keydown')],
  ).explanation;
  assert.equal(sliced.blame.kind, 'render');
  const nextToTimer = (rendered: number) =>
    report(
      [entry('keydown', 0, 176, 0.2, 1.2), entry('keyup', 100, 76, 141, 141.2)],
      [commit(79, 0, { total: 0, hasDurations: false, rendered })],
      [frame(0.2, 170, [script('MessagePort.onmessage', 1.3, 80), script('TimerHandler:setTimeout', 82, 58.5)], 165)],
      [input(0, 'keydown')],
    ).explanation;
  assert.equal(nextToTimer(300).blame.kind, 'render');
  // Where the wait wins all the same, React's render is not the script it is named after.
  const outlasts = report(
    [entry('keydown', 0, 176, 0.2, 1.2), entry('keyup', 100, 76, 147, 147.2)],
    [commit(71, 0, { total: 0, hasDurations: false, rendered: 300 })],
    [frame(0.2, 170, [script('MessagePort.onmessage', 1.3, 70), script('TimerHandler:setTimeout', 72, 65)], 165)],
    [input(0, 'keydown')],
  ).explanation;
  assert.equal(outlasts.blame.kind, 'waiting');
  assert.match(outlasts.cause, /, the longest a script \(TimerHandler:setTimeout, app\.js\) for 65 ms\./);
  // React's first task after a commit, the effects it left, is no render of a commit a timer's store update made
  // later: that commit was rendered in the timer (React 17's legacy root, the keydown committed in its handler).
  const effectsThenTimer = report(
    [entry('keydown', 0, 176, 0.2, 1.2), entry('keyup', 100, 76, 100.1, 100.3)],
    [commit(1, 0, { total: 0, hasDurations: false, rendered: 30 }), commit(79.9, 0, { total: 0, hasDurations: false, rendered: 30 })],
    [frame(0.2, 175, [script('MessagePort.onmessage', 1.5, 70), script('TimerHandler:setTimeout', 72, 8)], 170)],
    [input(0, 'keydown')],
  ).explanation;
  assert.deepEqual([effectsThenTimer.blame.kind, effectsThenTimer.blame.name], ['waiting', 'MessagePort.onmessage']);
  // Each task is the first commit's after it: a 60 ms task that committed 2 components, then React's 38 ms render
  // of 300, leaves the first a wait. And a task with commits only in the handlers, none in the gap, is no render.
  const twoTasks = report(
    [entry('keydown', 0, 176, 0.2, 1.2), entry('keyup', 100, 76, 100.1, 100.3)],
    [commit(61, 0, { total: 0, hasDurations: false, rendered: 2 }), commit(99.8, 0, { total: 0, hasDurations: false, rendered: 300 })],
    [frame(0.2, 175, [script('MessagePort.onmessage', 1.3, 60), script('MessagePort.onmessage', 62, 38)], 170)],
    [input(0, 'keydown')],
  ).explanation;
  assert.deepEqual([twoTasks.blame.kind, twoTasks.blame.name], ['waiting', 'MessagePort.onmessage']);
  const inHandlers = report(
    [entry('keydown', 0, 176, 0.2, 1.2), entry('keyup', 100, 76, 100.1, 100.3)],
    [commit(1, 0, { total: 0, hasDurations: false, rendered: 300 }), commit(100.25, 0, { total: 0, hasDurations: false, rendered: 300 })],
    [frame(0.2, 175, [script('MessagePort.onmessage', 1.5, 80)], 170)],
    [input(0, 'keydown')],
  ).explanation;
  assert.deepEqual([inHandlers.blame.kind, inHandlers.blame.name], ['waiting', 'MessagePort.onmessage']);
  // A 2-component render does not count as one, so the task it committed in is weighed as a script.
  assert.deepEqual([nextToTimer(2).blame.kind, nextToTimer(2).blame.name], ['waiting', 'MessagePort.onmessage']);
  // A commit in any other script says nothing of how much of it was React's: a store update at the end of a timer
  // leaves the timer the wait, however much it rendered.
  for (const invoker of ['TimerHandler:setInterval', 'WebSocket.onmessage']) {
    for (const rendered of [2, 300]) {
      const store = report(
        [entry('keydown', 0, 176, 0.2, 1.2), entry('keyup', 100, 76, 100.1, 100.3)],
        [commit(89.5, 0, { total: 0, hasDurations: false, rendered })],
        [frame(0.2, 170, [script(invoker, 1.3, 88.7)], 165)],
        [input(0, 'keydown')],
      ).explanation;
      assert.deepEqual([rendered, store.blame.kind, store.blame.name], [rendered, 'waiting', invoker]);
    }
  }
  // Nor is a commit in a task that starts 0.5 ms after it: a timer's, or React's own next task, which ran the
  // effects that commit left, 78 ms of them.
  for (const invoker of ['TimerHandler:setTimeout', 'MessagePort.onmessage']) {
    const next = report(
      [entry('keydown', 0, 176, 0.2, 1.2), entry('keyup', 100, 76, 100.1, 100.3)],
      [commit(21, 0, { total: 0, hasDurations: false, rendered: 300 })],
      [frame(0.2, 170, [script('MessagePort.onmessage', 1.3, 20), script(invoker, 21.8, 78)], 165)],
      [input(0, 'keydown')],
    ).explanation;
    assert.deepEqual([next.blame.kind, next.blame.name], ['waiting', invoker]);
  }
  // A timed render is placed for its own length up to its commit, not from where it started: one suspended on
  // data, rendering 8 ms and committing 95 ms later, leaves the thread idle in between.
  for (const frames of [null, [frame(0.2, 170, [script('MessagePort.onmessage', 2, 8)], 165)]]) {
    const suspended = report([entry('keydown', 0, 176, 0.2, 1.2), entry('keyup', 100, 76, 100.1, 100.3)], [commit(95, 0, { total: 8, startedAt: 2 })], frames, [
      input(0, 'keydown'),
    ]).explanation;
    assert.notEqual(suspended.blame.kind, 'waiting', suspended.cause);
  }
  // A frame's own style and layout is busy time too: the keyup came up in the middle of it, and the 30 ms after
  // the release would not make a wait.
  const styled = report([entry('keydown', 0, 176, 0.2, 1.2), entry('keyup', 100, 76, 130, 130.2)], [], [frame(1.2, 128, [], 3)], [input(0, 'keydown')]).explanation;
  assert.equal(styled.blame.kind, 'waiting');
  assert.doesNotMatch(styled.cause, /still down/);
  // Idle while held and busy after the release: only the time after it is the wait, and the sentence says so.
  const idleThenBusy = report(
    [entry('keydown', 0, 176, 0.2, 1.2), entry('keyup', 100, 76, 170, 170.2)],
    [],
    [frame(100, 72, [script('TimerHandler:setTimeout', 100.1, 69.5)], 171)],
    [input(0, 'keydown')],
  ).explanation;
  assert.deepEqual([idleThenBusy.blame.kind, idleThenBusy.blame.name, Math.round(idleThenBusy.blame.ms!)], ['waiting', 'TimerHandler:setTimeout', 70]);
  assert.match(
    idleThenBusy.cause,
    /169 ms went by between the keydown's handlers and the keyup's\. The key was still down for 99 ms of it with nothing on record running, so the wait was the other 70 ms\. A script \(TimerHandler:setTimeout, app\.js\) ran for 70 ms of the wait\./,
  );
  // A long frame over the held time is no busy thread by itself, whatever its blocking time: that does not say
  // when in the frame the thread was blocked, and a paint held up off the thread keeps a frame open with the
  // thread idle, and so does a keydown handler's long task.
  const heldIdle = [
    report([entry('keydown', 0, 176, 0.2, 1.2), entry('keyup', 100, 76, 100.1, 100.3)], [], [{ ...frame(0.2, 170, [], 165), blocking: 0 }], [input(0, 'keydown')]),
    report([entry('keydown', 0, 176, 0.2, 1.2), entry('keyup', 100, 76, 100.1, 100.3)], [], [frame(0.2, 170, [], 165)], [input(0, 'keydown')]),
    report(
      [entry('keydown', 0, 176, 0.2, 58.2), entry('keyup', 150, 26, 150.1, 150.3)],
      [],
      [{ ...frame(0.2, 170, [script('DIV#root.onkeydown', 0.2, 58)], 165), blocking: 8 }],
      [input(0, 'keydown')],
    ),
  ];
  for (const held of heldIdle) assert.notEqual(held.explanation.blame.kind, 'waiting', held.explanation.cause);
  // The figures add up as printed, rounding and all, and a key or a pointer is said to be down only before its
  // release: 169 ms, 100 of them held and a 69 ms wait.
  const rounded = report(
    [entry('keydown', 0, 176, 0.2, 0.8), entry('keyup', 100, 76, 169.4, 169.6)],
    [],
    [frame(100, 72, [script('TimerHandler:setTimeout', 100.1, 69)], 171)],
    [input(0, 'keydown')],
  ).explanation;
  assert.match(rounded.cause, /169 ms went by .* The key was still down for 100 ms of it with nothing on record running, so the wait was the other 69 ms\./);
  const heldThen = (first: string, next: string) =>
    report([entry(first, 0, 176, 0.2, 1.2), entry(next, 100, 76, 170, 170.2)], [], [frame(100, 72, [script('TimerHandler:setTimeout', 100.1, 69.5)], 171)], [input(0, first)])
      .explanation.cause;
  for (const next of ['pointerup', 'mouseup', 'touchend', 'click', 'auxclick']) assert.match(heldThen('pointerdown', next), /\. The pointer was still down for 99 ms of it/);
  assert.match(heldThen('pointerdown', 'contextmenu'), /\. Nothing on record ran in 99 ms of it, before the contextmenu came, so the wait was the other 70 ms\./);
  for (const next of ['input', 'keypress', 'keydown']) {
    assert.match(heldThen('keydown', next), new RegExp(`\\. Nothing on record ran in 99 ms of it, before the ${next} came`));
  }
  // A render that committed just before the keyup's handlers began is in the time between, however close.
  const close = enter(null, 10.4, [input(0, 'keydown')], [commit(10.9, 0, { total: 0.3, rendered: 2 }), commit(157.4, 0, { total: 130, startedAt: 12, rendered: 300 })]);
  assert.equal(close.explanation.blame.kind, 'render');
  // A task React's scheduler posted for straight after the keydown's handlers is in the gap, not in them: its 36 ms
  // of layout is not added to the keyup's 30, which used to make "66 ms of the 49 ms spent handling" a layout verdict.
  const posted = report(
    [entry('keydown', 0, 96, 2, 6), entry('keyup', 1, 96, 45, 90)],
    [commit(88, 0, { total: 2, startedAt: 45 })],
    [frame(0, 96, [script('DIV#root.onkeydown', 2, 4), script('MessagePort.onmessage', 6.4, 37.6, 36), script('DIV#root.onkeyup', 45, 45, 30)])],
    [input(0, 'keydown')],
  );
  assert.notEqual(posted.explanation.blame.kind, 'layout', posted.explanation.cause);

  // Painted in the same frame, a keyup can start its handler past the end web-vitals gives the working time,
  // the paint as the 8 ms rounded durations put it (React 19.0 in Chromium, in CI): it still ends the wait.
  const pastTheEnd = report(
    [entry('keydown', 0, 168, 8.1, 9.6), entry('keypress', 0, 168, 9.6, 13), entry('click', 0, 168, 10.2, 13), entry('keyup', 14, 160, 170.4, 170.5)],
    [commit(12.5, 0, { total: 0.5, startedAt: 10.6, rendered: 1 })],
    [frame(8.1, 156.9, [], 13.1)],
    [input(0, 'keydown')],
  );
  assert.deepEqual(
    [pastTheEnd.explanation.blame.kind, pastTheEnd.explanation.blame.detail, Math.round(pastTheEnd.explanation.blame.ms)],
    ['waiting', 'between click and keyup', 155],
  );

  // A keyup released after the key press painted is in a frame of its own, and leaves no wait in this one.
  const typed = report(
    [entry('keydown', 0, 112, 0.1, 0.1), entry('keypress', 0, 112, 0.1, 111), entry('keyup', 173, 112, 173.2, 173.3)],
    [commit(110.6, 0, { total: 0.2, rendered: 1 })],
    [frame(0.1, 111, [script('DIV#root.oninput', 0.3, 110)], 111)],
    [input(0, 'keydown')],
  );
  assert.equal(typed.explanation.blame.kind, 'handler');
  assert.match(typed.explanation.cause, /ran for about 111 ms;/);

  // Handlers that did more than the wait still take the blame, for their own time only.
  const busy = enter([frame(10, 147, [script('DIV#root.onkeydown', 10, 100)], 157)], 110);
  assert.equal(busy.explanation.blame.kind, 'handler');
  assert.match(busy.explanation.cause, /ran for about 101 ms;/);
  // Less than the wait, and the wait is the answer.
  const lighter = enter([frame(10, 147, [script('DIV#root.onkeydown', 10, 70)], 157)], 80);
  assert.equal(lighter.explanation.blame.kind, 'waiting');
  assert.equal(Math.round(lighter.explanation.blame.ms!), 77);
  assert.match(lighter.explanation.cause, /^The handlers took 71 ms in all, but 77 ms went by/);

  // A render in the handlers comes off their time as well as the wait: 50 ms of React and 5 of handler code
  // beside a 52 ms wait.
  const rendered = report(
    [entry('keydown', 0, 128, 10, 10.5), entry('click', 0, 128, 10.5, 65.5), entry('keyup', 1, 128, 117.5, 118)],
    [commit(65, 0, { total: 50, rendered: 30 })],
    [frame(10, 108, [script('DIV#root.onclick', 10.5, 55)], 118)],
    [input(0, 'keydown')],
  );
  assert.deepEqual(rendered.explanation.blame, { kind: 'waiting', name: null, detail: 'between click and keyup', ms: 52, confidence: 'measured' });

  // A larger screen update or wait before the handlers keeps the verdict, and the time between is a note.
  const gapNote = (r: InteractionReport) => r.explanation.notes.find((n) => n.includes('of the working time also went by')) ?? '';
  const screen = report(
    [entry('keydown', 0, 376, 10, 11), entry('click', 0, 376, 11, 12), entry('keyup', 1, 376, 170, 170.5)],
    [commit(11.5, 0, { total: 0.3, rendered: 2 })],
    [frame(10, 160, [], 170)],
    [input(0, 'keydown')],
  );
  assert.equal(screen.explanation.blame.kind, 'painting');
  assert.equal(gapNote(screen), "158 ms of the working time also went by between the click's handlers and the keyup's, with no handler running.");
  const delayed = report(
    [entry('keydown', 0, 400, 200, 201), entry('click', 0, 400, 201, 202), entry('keyup', 1, 400, 290, 290.5)],
    [commit(201.5, 0, { total: 0.3, rendered: 2 })],
    [frame(0, 291, [], null)],
    [input(0, 'keydown')],
  );
  assert.deepEqual([delayed.explanation.blame.kind, delayed.explanation.blame.detail], ['waiting', null]);
  assert.match(gapNote(delayed), /^88 ms of the working time also went by between the click's handlers and the keyup's/);
  // A wait before the handlers longer than the handlers themselves is the verdict, whatever the working time
  // held between them other than a render that could be the verdict.
  const shortHandlers = report(
    [entry('keydown', 0, 128, 60, 65), entry('keyup', 1, 128, 120, 125)],
    [commit(64, 0, { total: 0.3, rendered: 2 })],
    [frame(0, 126, [], null)],
    [input(0, 'keydown')],
  );
  assert.deepEqual([shortHandlers.explanation.blame.kind, shortHandlers.explanation.blame.detail, shortHandlers.explanation.blame.ms], ['waiting', null, 60]);
  assert.match(gapNote(shortHandlers), /^55 ms of the working time also went by between the keydown's handlers and the keyup's/);
  // Where the wait is the verdict, it is not said twice.
  assert.equal(gapNote(quiet), '');
});
