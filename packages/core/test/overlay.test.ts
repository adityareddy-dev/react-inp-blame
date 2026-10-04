import assert from 'node:assert/strict';
import { test } from 'node:test';
import { walkCommit } from '../src/fiber.ts';
import { buildReport, laterRenderOf, renderedVerb, sealReport } from '../src/join.ts';
import { blameLine, createOverlay, laterDetail, laterLead, laterWhen, titleFor } from '../src/overlay.ts';
import type { CommitSummary, InteractionReport } from '../src/types.ts';

// Only what a row's title reads: the report's type, its target's label and the names of its entries.
function report(type: string, label: string | null, entries: string[]): InteractionReport {
  const target = label === null ? null : { label, selector: 'x' };
  return { type, target, entries: entries.map((name) => ({ name })) } as unknown as InteractionReport;
}

// Entries as Chrome records them for each key (checked on a Next.js 15.5 page): a key that types a
// character, Enter in a text field among them, also fires a keypress; Escape and Tab fire only a
// keydown; Enter on a button ends in a click.
test('a panel row reads as typing only for a key that typed into a field, and any other key as a key press', () => {
  assert.equal(titleFor(report('keydown', 'button "Close"', ['keydown'])), 'Key press on "Close"');
  assert.equal(titleFor(report('keydown', 'input "Search"', ['keydown'])), 'Key press on "Search"');
  assert.equal(titleFor(report('keyup', 'input "Search"', ['keyup'])), 'Key press on "Search"');
  assert.equal(titleFor(report('keydown', 'button "Close"', ['keydown', 'keypress'])), 'Key press on "Close"');
  assert.equal(titleFor(report('keydown', 'link "Home"', ['keydown', 'keypress'])), 'Key press on "Home"');
  assert.equal(titleFor(report('keydown', null, ['keydown'])), 'Key press');

  assert.equal(titleFor(report('keydown', 'input "Search"', ['keydown', 'keypress'])), 'Typing in "Search"');
  assert.equal(titleFor(report('keydown', 'div "edit"', ['keydown', 'keypress'])), 'Typing in "edit"');
  assert.equal(titleFor(report('keydown', null, ['keydown', 'keypress'])), 'Typing');
  assert.equal(titleFor(report('input', 'textarea "Notes"', ['input'])), 'Typing in "Notes"');
  assert.equal(titleFor(report('change', 'select "Size"', ['change'])), 'Typing in "Size"');

  assert.equal(titleFor(report('click', 'button "Close"', ['keydown', 'keypress', 'click'])), 'Click on "Close"');
  assert.equal(titleFor({ ...report('pointerup', 'button "Close"', ['pointerdown', 'pointerup', 'click']), pointerType: 'mouse' }), 'Click on "Close"');
});

test("a panel row says tap for a finger's click and click for a mouse's", () => {
  const pressed = (type: string, pointerType: string | null) => ({ ...report(type, 'button "Save"', [type]), pointerType });
  assert.equal(titleFor(pressed('click', 'touch')), 'Tap on "Save"');
  assert.equal(titleFor(pressed('click', 'pen')), 'Tap on "Save"');
  assert.equal(titleFor(pressed('pointerdown', 'touch')), 'Tap on "Save"');
  assert.equal(titleFor(pressed('click', 'mouse')), 'Click on "Save"');
  assert.equal(titleFor(pressed('pointerup', 'mouse')), 'Click on "Save"');
  // A key's click carries no pointer, and stays a click, as does a press whose pointer the library did not see.
  assert.equal(titleFor(pressed('click', null)), 'Click on "Save"');
  assert.equal(titleFor(pressed('pointerdown', null)), 'Click on "Save"');
  assert.equal(titleFor(pressed('pointerup', null)), 'Click on "Save"');
  assert.equal(titleFor({ ...pressed('click', 'touch'), target: null }), 'Tap');
});

test("the panel's line for a later render says what the render was made of in the verdict's words", () => {
  const later = (rendered: number, components: [string, number, number?][], total = 0) =>
    ({ rendered, truncated: false, hasDurations: total > 0, total, components: components.map(([name, count, self]) => ({ name, count, self: self ?? null, total: self ?? null })) }) as unknown as CommitSummary;
  // Four Labels are not what a render of 59 components was made of.
  assert.equal(laterDetail(later(59, [['Label', 4], ['Button', 3]])), '59 components');
  assert.equal(laterDetail(later(801, [['LineItem', 800], ['OrderSummary', 1]])), 'LineItem ×800');
  assert.equal(laterDetail(later(637, [['TableBody', 1, 257], ['TableBodyRow', 36, 10]], 277)), "TableBody's own render");
  // Most of the time in one component, too little of it for its own render to be named, is not "Chart ×1".
  assert.equal(laterDetail(later(40, [['Chart', 1, 15], ['Bar', 10, 2]], 20)), '40 components');
  assert.equal(laterDetail(later(1, [['Toast', 1, 30]], 30)), '1 component');
  // The count inside the component the row names, where the walk counted fewer there than in the commit.
  assert.equal(laterDetail({ ...later(59, [['Label', 4]]), pathRendered: 31 }), '31 of 59 components');
  // A row's verb: a render that mounted most of what it rendered mounted, the way the verdict says.
  assert.equal(renderedVerb({ ...later(59, [['Label', 4]]), mounted: 57 }), 'mounted');
  assert.equal(renderedVerb({ ...later(59, [['Label', 4]]), mounted: 20 }), 're-rendered');
  assert.equal(renderedVerb(later(59, [['Label', 4]])), 're-rendered');
});

test('the panel names the later render the note speaks of: one INP left out before a heavier one on the release', () => {
  // A 32 ms pointerdown held past its paint, the 60 ms render its pointerup made inside its own entry, and
  // a 40 ms one its effects made after the release painted. The row and "Rendered after the paint" read it.
  const entries = [
    { name: 'pointerdown', startTime: 0, duration: 32, processingStart: 2, processingEnd: 24 },
    { name: 'pointerup', startTime: 60, duration: 24, processingStart: 61, processingEnd: 72 },
  ];
  const render = (at: number, total: number, name: string) =>
    ({ at, inputTs: 60, gestureTs: 0, startedAt: null, hasDurations: true, total, rendered: 30, components: [{ name, count: 30, self: total, total }] }) as unknown as CommitSummary;
  const release = render(70, 60, 'Canvas');
  const effect = render(400, 40, 'Toolbar');
  const r = { entries, followUps: [release, effect] } as unknown as InteractionReport;
  assert.equal(laterRenderOf(r), effect);
  // Where INP timed every one, the heaviest of them.
  assert.equal(laterRenderOf({ ...r, followUps: [release] }), release);
  assert.equal(laterRenderOf({ ...r, followUps: [] }), null);
});

test('a row whose report the library could not explain says the library hit an error of its own, not that nothing stood out', (t) => {
  t.mock.method(console, 'warn', () => {});
  // A 40 ms click whose handlers ran from 5 to 10 ms: nothing in it stands out.
  const click = { name: 'click', interactionId: 7, startTime: 0, duration: 40, processingStart: 5, processingEnd: 10, target: null };
  const reading = (status: InteractionReport['reactStatus']) => sealReport(buildReport([click], [], [], [], 'attributes', [], undefined, status));
  assert.deepEqual(blameLine(reading('reading')), ['nothing stood out']);
  assert.deepEqual(blameLine(reading('unreadable')), ['nothing is blamed: React is not being read']);
  // The same click again, where the first number its explanation rounds throws, whatever is true of React.
  const round = t.mock.method(Math, 'round');
  for (const status of ['reading', 'waiting', 'unreadable'] as const) {
    const r = reading(status);
    round.mock.mockImplementationOnce(() => {
      throw new TypeError('rounding moved');
    });
    assert.deepEqual(blameLine(r), ['nothing is blamed: the library hit an error of its own'], status);
    assert.equal(r.explanation.blame.kind, 'none', status);
  }
});

/** Just enough of a document for the badge and panel to be built: elements that keep nothing and hear nothing. */
function standInDocument() {
  class Element {
    className = '';
    hidden = false;
    isConnected = false;
    textContent = '';
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    setAttribute() {}
    replaceChildren() {}
    append() {}
    prepend() {}
    addEventListener() {}
    attachShadow() {
      return new Element();
    }
    appendChild(child: Element) {
      child.isConnected = true;
    }
    remove() {
      this.isConnected = false;
    }
  }
  return { body: new Element(), createElement: () => new Element(), addEventListener() {}, removeEventListener() {} };
}

test('a badge and panel that cannot be drawn, for an error with no string form, say so once and never throw into the page', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: standInDocument(), configurable: true, writable: true });
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'document', saved);
    else delete (globalThis as any).document;
  });
  // Reports that throw an object with no prototype when the draw asks for them, which it does first.
  const source = {
    reports() {
      throw Object.create(null);
    },
    onInteraction: () => () => {},
  } as unknown as Parameters<typeof createOverlay>[0];
  let overlay: ReturnType<typeof createOverlay> | undefined;
  // Drawn as soon as it is made, and again on refresh(), as a timer or a click on the badge would.
  assert.doesNotThrow(() => {
    overlay = createOverlay(source);
  });
  assert.doesNotThrow(() => overlay?.refresh());
  assert.equal(warn.mock.callCount(), 1);
  assert.match(
    String(warn.mock.calls[0]?.arguments[0]),
    /^\[react-inp-blame\] the badge and panel could not be drawn \(a value that cannot be printed\)\. Reports still come through onInteraction\(\)\. See https:\/\/github\.com\/adityareddy-dev\/react-inp-blame#overlay-draw$/,
  );
  overlay?.dispose();
});

test("the panel's line for a press's render before a slower release says it came after the press painted", () => {
  // A keyup that painted at 320, slower than its keydown, which set off a render at 100 while the key was held.
  const r = { end: 320 } as unknown as InteractionReport;
  const at = (at: number) => ({ at }) as unknown as CommitSummary;
  assert.equal(laterWhen(r, at(100)), 'after the press painted');
  assert.equal(laterWhen(r, at(700)), 'after the paint');
  // The line opens "earlier," for it, where one after the paint opens "then".
  assert.equal(laterLead(r, at(100)), 'earlier, ');
  assert.equal(laterLead(r, at(700)), 'then ');
});

/** An element of the stand-in document, or the document itself. */
type Drawn = Record<string, any>;

/**
 * Gives the test a document to draw the panel in: elements that keep their class, their attributes,
 * their children and one listener of each type, and read out their text. `closest` takes the one class a
 * selector names, which is all the panel's click listener asks it. `restore` puts the global back.
 */
function panelDocument(): { body: Drawn; restore(): void } {
  const element = (tagName: string): Drawn => {
    const adopt = (nodes: unknown[]) => {
      for (const node of nodes) if (typeof node !== 'string') (node as Drawn).parentNode = el;
      return nodes;
    };
    const el: Drawn = {
      tagName,
      className: '',
      dataset: {},
      attributes: {},
      style: {},
      hidden: false,
      parentNode: null,
      childNodes: [],
      listeners: {},
      get isConnected() {
        return el.parentNode !== null;
      },
      get textContent(): string {
        return el.childNodes.map((node: string | Drawn) => (typeof node === 'string' ? node : node.textContent)).join('');
      },
      set textContent(value: string) {
        el.childNodes = [value];
      },
      setAttribute(name: string, value: string) {
        if (name === 'class') el.className = value;
        else if (name.startsWith('data-')) el.dataset[name.slice(5)] = value;
        else el.attributes[name] = value;
      },
      addEventListener(type: string, listener: (e: unknown) => void) {
        el.listeners[type] = listener;
      },
      removeEventListener() {},
      getBoundingClientRect: () => ({ width: 100, height: 32 }),
      attachShadow: () => (el.shadowRoot = element('#shadow-root')),
      append: (...nodes: unknown[]) => el.childNodes.push(...adopt(nodes)),
      prepend: (...nodes: unknown[]) => el.childNodes.unshift(...adopt(nodes)),
      replaceChildren: (...nodes: unknown[]) => (el.childNodes = adopt(nodes)),
      appendChild: (node: Drawn) => el.append(node),
      remove: () => {
        el.parentNode?.childNodes.splice(el.parentNode.childNodes.indexOf(el), 1);
        el.parentNode = null;
      },
      closest: (selector: string): Drawn | null => {
        for (let x: Drawn | null = el; x; x = x.parentNode) if (x.className?.split(' ').includes(selector.slice(1))) return x;
        return null;
      },
    };
    return el;
  };
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const body = element('BODY');
  const document = { body, createElement: element, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true });
  return {
    body,
    restore: () => {
      if (saved) Object.defineProperty(globalThis, 'document', saved);
      else delete (globalThis as Record<string, unknown>).document;
    },
  };
}

/** The first element inside `el` with this class, depth first. */
function byClass(el: Drawn, name: string): Drawn | null {
  for (const node of el.childNodes) {
    if (typeof node === 'string') continue;
    if (node.className?.split(' ').includes(name)) return node;
    const inside = byClass(node, name);
    if (inside) return inside;
  }
  return null;
}

/** The panel, open, as it draws this one report, with the report's row opened by a click. */
function panelFor(r: InteractionReport): Drawn {
  const { body, restore } = panelDocument();
  try {
    const source = {
      reports: () => [r],
      inp: () => null,
      onInteraction: () => () => {},
      clear() {},
      stats: () => ({ mode: 'shim', unsupportedReason: null, react: 'reading' }),
      debug: { hook: () => ({ devtoolsLockedOut: false, renderers: [] }) },
    };
    const overlay = createOverlay(source as unknown as Parameters<typeof createOverlay>[0], { open: true });
    const panel = byClass(body.childNodes[0].shadowRoot, 'panel')!;
    panel.listeners.click({ target: byClass(panel, 'row') });
    overlay.dispose();
    return panel;
  } finally {
    restore();
  }
}

test("a row says a component re-rendered only where it did, and otherwise leads with where the render started", () => {
  // A checkbox flipped a context every row reads: PrefsProvider and 375 ProductRows rendered, and ProductList,
  // the component the hot path went through, bailed out. The row read "ProductList re-rendered".
  const components = [
    { name: 'ProductRow', count: 375, self: 140, total: 140 },
    { name: 'LinkComponent', count: 4, self: 2, total: 2 },
    { name: 'Nav', count: 1, self: 1, total: 1 },
    { name: 'PrefsProvider', count: 1, self: 1, total: 151 },
  ];
  const c = { at: 50, rendered: 381, hasDurations: true, total: 151, truncated: false, hydrated: false, roots: ['PrefsProvider'], hotPath: ['PrefsProvider', 'Shop', 'ProductList'], components } as unknown as CommitSummary;
  const blame = { kind: 'render', name: 'ProductList', detail: 'ProductRow ×375', ms: 151, confidence: 'measured' };
  const { restore } = panelDocument();
  try {
    const line = (commit: CommitSummary) => blameLine({ explanation: { blame }, commits: [commit], reactStatus: 'reading' } as unknown as InteractionReport).map((x) => (typeof x === 'string' ? x : x ? (x as unknown as Drawn).textContent : '')).join('');
    assert.equal(line(c), 'PrefsProvider updated · ProductRow ×375 re-rendered inside ProductList · 151 ms');
    // With no one root, what rendered and where.
    assert.equal(line({ ...c, roots: ['PrefsProvider', 'Toaster'] }), 'ProductRow ×375 re-rendered inside ProductList · 151 ms');
    // Consumers spread across the tree, no one of them most of it: the count is the ones inside, as the cause has it.
    // The row said "351 components re-rendered inside ProductList" where 120 of them were.
    const spread = [
      { name: 'ProductRow', count: 120, self: 60, total: 60 },
      { name: 'LinkComponent', count: 120, self: 40, total: 40 },
      { name: 'Nav', count: 110, self: 40, total: 40 },
      { name: 'PrefsProvider', count: 1, self: 1, total: 151 },
    ];
    assert.equal(line({ ...c, rendered: 351, pathRendered: 120, components: spread }), 'PrefsProvider updated · 120 of 351 components re-rendered inside ProductList · 151 ms');
    // One component most of the commit, and more of it than rendered inside: it cannot all have been inside.
    // The row said "NavItem ×500 re-rendered inside ProductList" where 298 components were.
    const outside = [{ name: 'NavItem', count: 500, self: 50, total: 50 }, { ...components[0]!, count: 298 }, components[2]!, components[3]!];
    assert.equal(line({ ...c, rendered: 800, pathRendered: 298, components: outside }), 'PrefsProvider updated · 298 of 800 components re-rendered inside ProductList · 151 ms');
    // No more of it than rendered inside, it is said as before.
    assert.equal(line({ ...c, pathRendered: 375 }), 'PrefsProvider updated · ProductRow ×375 re-rendered inside ProductList · 151 ms');
    // Each row updated from its own store, so the rows are the roots, and the row is not said to have started it.
    const store = { ...c, rendered: 375, roots: ['ProductRow'], hotPath: ['Shop', 'ProductList'], components: [components[0]!] };
    assert.equal(line(store), 'ProductRow ×375 re-rendered inside ProductList · 151 ms');
    // Where it did render, as before.
    const rendered = [...components, { name: 'ProductList', count: 1, self: 1, total: 141 }];
    assert.equal(line({ ...c, rendered: 382, components: rendered }), 'ProductList re-rendered · ProductRow ×375 · 151 ms');
    // Where the list holds only the heaviest and some that rendered are not in it, it may have, and is said as before.
    assert.equal(line({ ...c, rendered: 900 }), 'ProductList re-rendered · ProductRow ×375 · 151 ms');
  } finally {
    restore();
  }
});

test('a row whose useEffect detail names the component it blames does not also say that component re-rendered', () => {
  // 20 SalesCharts rendered, one of them mounting with a 176 ms useEffect. The row read "SalesChart re-rendered ·
  // useEffect callbacks after mounting SalesChart".
  const chart: CommitSummary = {
    at: 129.5,
    sinceInput: 129.5,
    inputTs: 0,
    gestureTs: 0,
    inputType: 'click',
    rendered: 20,
    mounted: 1,
    effectMounts: 1,
    effectMountName: 'SalesChart',
    hydrated: false,
    truncated: false,
    roots: ['ReportView'],
    hotPath: ['Dashboard', 'SalesChart'],
    components: [{ name: 'SalesChart', count: 20, self: 75.6, total: 126 }],
    hasDurations: true,
    coarseClock: false,
    total: 126,
    startedAt: 3.5,
    effectsStartedAt: 129.8,
    effectsEndedAt: 306.2,
    walkMs: 0,
    priority: 1,
    didError: false,
  };
  const click = { name: 'click', interactionId: 1, startTime: 0, duration: 463, processingStart: 3, processingEnd: 423, target: null };
  const { restore } = panelDocument();
  try {
    const line = (c: CommitSummary) => {
      const r = sealReport(buildReport([click], [c], [], []));
      return blameLine(r).map((x) => (typeof x === 'string' ? x : x ? (x as unknown as Drawn).textContent : '')).join('');
    };
    assert.equal(line(chart), 'SalesChart · useEffect callbacks after mounting SalesChart · 302 ms');
    // Another component's mount keeps the verb.
    assert.equal(line({ ...chart, effectMountName: 'Legend' }), 'SalesChart re-rendered · useEffect callbacks after mounting Legend · 302 ms');
  } finally {
    restore();
  }
});

test('quick rows with nothing to fix fold into one line that opens on a click, and the rows worth reading stay rows', (t) => {
  t.mock.method(console, 'warn', () => {});
  // Ten 45 ms clicks whose handlers ran 5 ms, then a 300 ms one whose handler ran nearly all of it.
  const click = (id: number, duration: number, processingEnd: number) =>
    sealReport(buildReport([{ name: 'click', interactionId: id, startTime: id * 1000, duration, processingStart: id * 1000 + 5, processingEnd: id * 1000 + processingEnd, target: null }], [], [], []));
  const quiet = Array.from({ length: 10 }, (_, i) => click(i + 1, 45, 10));
  const slow = click(11, 300, 290);
  assert.equal(quiet[0]!.explanation.blame.kind, 'none');
  assert.notEqual(slow.explanation.blame.kind, 'none');
  // A quiet row where React is not read is "can't tell", not "nothing to fix", and stays a row.
  const unread = sealReport(buildReport([{ name: 'click', interactionId: 12, startTime: 12000, duration: 45, processingStart: 12005, processingEnd: 12010, target: null }], [], [], [], 'attributes', [], undefined, 'unreadable'));
  const { body, restore } = panelDocument();
  try {
    const source = {
      reports: () => [...quiet, slow, unread],
      inp: () => null,
      onInteraction: () => () => {},
      clear() {},
      stats: () => ({ mode: 'shim', unsupportedReason: null, react: 'reading' }),
      debug: { hook: () => ({ devtoolsLockedOut: false, renderers: [] }) },
    };
    const overlay = createOverlay(source as unknown as Parameters<typeof createOverlay>[0], { open: true });
    const panel = byClass(body.childNodes[0].shadowRoot, 'panel')!;
    const rows = () => panel.childNodes.filter((node: Drawn) => typeof node !== 'string' && node.className.split(' ').includes('row'));
    const fold = () => byClass(panel, 'fold');
    // The unread click, the slow one, and the fold, which the header's count and the badge still count in.
    assert.equal(rows().length, 3);
    assert.equal(fold()?.textContent, '10 quick interactions, nothing to fix');
    assert.deepEqual(rows().map((row: Drawn) => row.dataset.id ?? 'fold'), ['12', '11', 'fold']);
    panel.listeners.click({ target: byClass(fold()!, 'toggle') });
    assert.equal(rows().length, 13);
    assert.deepEqual(rows().slice(3).map((row: Drawn) => row.dataset.id), ['10', '9', '8', '7', '6', '5', '4', '3', '2', '1']);
    panel.listeners.click({ target: byClass(fold()!, 'toggle') });
    assert.equal(rows().length, 3);
    overlay.dispose();
  } finally {
    restore();
  }
});

test('quick rows in the fold never push a row worth reading out of the panel', (t) => {
  t.mock.method(console, 'warn', () => {});
  // A 300 ms click, then as many quiet ones as the panel keeps. It showed the fold alone, and the slow row was gone.
  const click = (id: number, duration: number, processingEnd: number) =>
    sealReport(buildReport([{ name: 'click', interactionId: id, startTime: id * 1000, duration, processingStart: id * 1000 + 5, processingEnd: id * 1000 + processingEnd, target: null }], [], [], []));
  const slow = click(1, 300, 290);
  const quiet = Array.from({ length: 25 }, (_, i) => click(i + 2, 45, 10));
  const { body, restore } = panelDocument();
  try {
    const source = {
      reports: () => [slow, ...quiet],
      inp: () => null,
      onInteraction: () => () => {},
      clear() {},
      stats: () => ({ mode: 'shim', unsupportedReason: null, react: 'reading' }),
      debug: { hook: () => ({ devtoolsLockedOut: false, renderers: [] }) },
    };
    const overlay = createOverlay(source as unknown as Parameters<typeof createOverlay>[0], { open: true });
    const panel = byClass(body.childNodes[0].shadowRoot, 'panel')!;
    const rows = () => panel.childNodes.filter((node: Drawn) => typeof node !== 'string' && node.className.split(' ').includes('row'));
    assert.deepEqual(rows().map((row: Drawn) => row.dataset.id ?? 'fold'), ['fold', '1']);
    // The fold keeps as many as the panel does, the newest.
    assert.equal(byClass(panel, 'fold')?.textContent, '20 quick interactions, nothing to fix');
    panel.listeners.click({ target: byClass(byClass(panel, 'fold')!, 'toggle') });
    assert.equal(rows().length, 22);
    assert.equal(rows()[1].dataset.id, '26');
    overlay.dispose();
    // `max` still keeps the rows worth reading to the newest that many.
    const slower = [slow, click(30, 300, 290), click(31, 300, 290), ...quiet.slice(0, 3)];
    const few = createOverlay({ ...source, reports: () => slower } as unknown as Parameters<typeof createOverlay>[0], { open: true, max: 2 });
    const fewPanel = byClass(body.childNodes[0].shadowRoot, 'panel')!;
    const fewRows = fewPanel.childNodes.filter((node: Drawn) => typeof node !== 'string' && node.className.split(' ').includes('row'));
    assert.deepEqual(fewRows.map((row: Drawn) => row.dataset.id ?? 'fold'), ['fold', '31', '30']);
    assert.equal(byClass(fewPanel, 'fold')?.textContent, '2 quick interactions, nothing to fix');
    few.dispose();
  } finally {
    restore();
  }
});

test("with no position the badge leaves a corner the page's own fixed or sticky element holds, at mount and at the first report, and stays put when told a corner or with the panel open", (t) => {
  t.mock.method(console, 'warn', () => {});
  const saved = ['innerWidth', 'innerHeight', 'getComputedStyle'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  t.after(() => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  });
  Object.assign(globalThis, { innerWidth: 1000, innerHeight: 800, getComputedStyle: (el: Drawn) => ({ position: el.position ?? 'static' }) });
  const page = { tagName: 'HTML', position: 'static' };
  const corner = (x: number, y: number) => `${y > 400 ? 'b' : 't'}${x > 500 ? 'r' : 'l'}`;
  const widgetAt = (position: string) => (position === 'shadow' ? { position: 'absolute', shadowRoot: { elementsFromPoint: () => [{ position: 'fixed' }, page] } } : { position });
  const run = (opts: Parameters<typeof createOverlay>[1], held: Record<string, string>, later: Record<string, string> = held) => {
    const { body, restore } = panelDocument();
    try {
      let now = held;
      let listener: () => void = () => {};
      let reports: InteractionReport[] = [];
      Object.assign(globalThis.document, {
        // The host is on top at its own corner, fixed like the page's widget, and never counts as one.
        // 'shadow' is a host that is not fixed itself, with its widget fixed inside its shadow root, as Next.js draws its dev indicator.
        elementsFromPoint: (x: number, y: number) => [body.childNodes[0], ...(now[corner(x, y)] ? [widgetAt(now[corner(x, y)]!)] : []), page],
      });
      const source = {
        reports: () => reports,
        inp: () => null,
        onInteraction: (fn: () => void) => ((listener = fn), () => {}),
        clear() {},
        stats: () => ({ mode: 'shim', unsupportedReason: null, react: 'reading' }),
        debug: { hook: () => ({ devtoolsLockedOut: false, renderers: [] }) },
      };
      body.childNodes[0]?.remove();
      const overlay = createOverlay(source as unknown as Parameters<typeof createOverlay>[0], opts);
      body.childNodes[0].position = 'fixed';
      const wrap = byClass(body.childNodes[0].shadowRoot, 'wrap')!;
      const atMount = wrap.className.split(' ')[1];
      // A widget that loads late is there by the first report.
      now = later;
      reports = [{ explanation: { blame: { kind: 'none' } }, duration: 300, reports: [] } as unknown as InteractionReport];
      listener();
      overlay.refresh();
      const atReport = wrap.className.split(' ')[1];
      overlay.dispose();
      return [atMount, atReport];
    } finally {
      restore();
    }
  };
  const chat = { br: 'fixed' };
  assert.deepEqual(run({}, {}), ['br', 'br']);
  assert.deepEqual(run({}, chat), ['bl', 'bl']);
  assert.deepEqual(run({}, { br: 'fixed', bl: 'sticky' }), ['tr', 'tr']);
  const backdrop = { br: 'fixed', bl: 'fixed', tr: 'fixed', tl: 'fixed' };
  assert.deepEqual(run({}, backdrop), ['br', 'br']);
  // A dialog's backdrop over every corner at the first report leaves the badge off the chat button it moved from.
  // It went back on top of it.
  assert.deepEqual(run({}, chat, backdrop), ['bl', 'bl']);
  // An element of the page's own flow in the corner is not a widget on top of it.
  assert.deepEqual(run({}, { br: 'relative' }), ['br', 'br']);
  assert.deepEqual(run({}, {}, chat), ['br', 'bl']);
  // A widget inside a shadow root whose host is not fixed holds its corner. The badge sat on it.
  assert.deepEqual(run({}, { br: 'fixed', bl: 'shadow' }), ['tr', 'tr']);
  // A corner that was asked for is used as given.
  assert.deepEqual(run({ position: 'bottom-right' }, chat), ['br', 'br']);
  assert.deepEqual(run({ position: 'top-left' }, {}), ['tl', 'tl']);
  // Never moved with the panel open, where it would take the panel with it.
  assert.deepEqual(run({ open: true }, {}, chat), ['br', 'br']);
});

test('Hide for me in the footer stores hidden, takes the badge off the page and tells the host, and a badge the page mounted itself has no such button', (t) => {
  t.mock.method(console, 'warn', () => {});
  const stored = new Map<string, string>();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) }, configurable: true, writable: true });
  const { body, restore } = panelDocument();
  try {
    const source = {
      reports: () => [],
      inp: () => null,
      onInteraction: () => () => {},
      clear() {},
      stats: () => ({ mode: 'shim', unsupportedReason: null, react: 'reading' }),
      debug: { hook: () => ({ devtoolsLockedOut: false, renderers: [] }) },
    };
    let hidden = 0;
    const overlay = createOverlay(source as unknown as Parameters<typeof createOverlay>[0], { open: true }, () => hidden++);
    const panel = byClass(body.childNodes[0].shadowRoot, 'panel')!;
    const button = byClass(panel, 'hide')!;
    assert.equal(button.textContent, 'Hide for me');
    panel.listeners.click({ target: button });
    assert.equal(stored.get('react-inp-blame'), 'hidden');
    assert.equal(body.childNodes.length, 0);
    assert.equal(hidden, 1);
    overlay.dispose();
    const mounted = createOverlay(source as unknown as Parameters<typeof createOverlay>[0], { open: true });
    assert.equal(byClass(byClass(body.childNodes[0].shadowRoot, 'panel')!, 'hide'), null);
    mounted.dispose();
  } finally {
    restore();
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete (globalThis as Record<string, unknown>).localStorage;
  }
});

test("the panel's row and its open section say a key press's render before the slower keyup came after the press painted", () => {
  // The keydown painted at 24 and set off a render of 400 components at 150, before the key came up at 300.
  // The keyup's entry was the slower one and painted at 348.
  const entry = (name: string, startTime: number, duration: number, processingStart: number, processingEnd: number) => ({ name, interactionId: 7, startTime, duration, processingStart, processingEnd, target: null });
  const key = (ts: number, type: string) => ({ ts, type, gestureTs: 0, press: 'KeyA', target: null, owners: [], handler: null, dehydrated: null, work: { endedAt: ts, unjoined: [] } });
  const render = (at: number): CommitSummary => ({
    at,
    sinceInput: at,
    inputTs: 0,
    gestureTs: 0,
    inputType: 'keydown',
    rendered: 400,
    hydrated: false,
    hydratedTarget: null,
    truncated: false,
    roots: ['List'],
    hotPath: ['List'],
    components: [{ name: 'Row', count: 400, self: 50, total: 50 }],
    hasDurations: true,
    coarseClock: false,
    total: 60,
    startedAt: null,
    effectsStartedAt: null,
    effectsEndedAt: null,
    walkMs: 0,
    priority: 1,
    didError: false,
  });
  const keys = [entry('keydown', 0, 24, 1, 10), entry('keyup', 300, 48, 301, 340)];
  const drawn = (at: number) => {
    const r = sealReport(buildReport(keys, [render(at)], [], [key(0, 'keydown'), key(300, 'keyup')]));
    assert.deepEqual(r.followUps.map((c) => c.at), [at]);
    const panel = panelFor(r);
    const more = byClass(panel, 'more');
    return { line: byClass(panel, 'later')?.textContent, heading: more && byClass(more, 'h')?.textContent, cost: more && byClass(more, 'cost') };
  };
  const earlier = drawn(150);
  assert.equal(earlier.line, 'earlier, List re-rendered after the press painted · Row ×400 · 60 ms');
  // The library's own cost is the footer's, once for the page, not a line in every open row.
  assert.equal(earlier.cost, null);
  assert.equal(earlier.heading, 'Rendered after the press painted · 400 components');
  // One after the keyup painted is said as before.
  const after = drawn(600);
  assert.equal(after.line, 'then List re-rendered after the paint · Row ×400 · 60 ms');
  assert.equal(after.heading, 'Rendered after the paint · 400 components');
});

test('a render whose walk could not tell where it started is the tree in the panel, never the component the roots sit under', () => {
  // A production build, the walk cut at its budget inside Orders with Metrics beside it, both under an App that
  // did not render.
  const entry = (name: string, startTime: number, duration: number, processingStart: number, processingEnd: number) => ({ name, interactionId: 7, startTime, duration, processingStart, processingEnd, target: null });
  const click = { ts: 0, type: 'click', gestureTs: 0, press: undefined, target: null, owners: [], handler: null, key: null, dehydrated: null, work: { endedAt: 0, unjoined: [] } };
  const cut = (at: number, opts: Partial<CommitSummary> = {}): CommitSummary => ({
    at,
    sinceInput: at,
    inputTs: 0,
    gestureTs: 0,
    inputType: 'click',
    rendered: 5000,
    hydrated: false,
    hydratedTarget: null,
    truncated: true,
    roots: ['Orders', 'Metrics'],
    hotPath: ['App'],
    pathStart: 'unknown-root',
    components: [
      { name: 'Row', count: 4998, self: null, total: null },
      { name: 'Orders', count: 1, self: null, total: null },
      { name: 'Metrics', count: 1, self: null, total: null },
    ],
    hasDurations: false,
    coarseClock: false,
    total: 0,
    startedAt: null,
    effectsStartedAt: null,
    effectsEndedAt: null,
    walkMs: 0,
    priority: undefined,
    didError: false,
    ...opts,
  });
  const lineOf = (r: InteractionReport) => {
    const { restore } = panelDocument();
    try {
      return blameLine(r).map((x) => (typeof x === 'string' ? x : x ? (x as unknown as Drawn).textContent : '')).join('');
    } finally {
      restore();
    }
  };
  // The second is App beside a Toaster the walk never reached: App is the one root it reached, and not said to
  // have updated, since the walk can't tell that is where the render started.
  for (const opts of [{}, { roots: ['App'], hotPath: [], components: [{ name: 'Row', count: 4999, self: null, total: null }, { name: 'App', count: 1, self: null, total: null }] }]) {
    // Rendered in the working time, it is the row's blame.
    const r = sealReport(buildReport([entry('click', 0, 400, 3, 390)], [cut(200, opts)], [], [click]));
    assert.equal(lineOf(r), 'most likely at least 5000 components re-rendered inside the app');
    // After the paint, it is the row's later render.
    const later = sealReport(buildReport([entry('click', 0, 48, 3, 40)], [cut(600, opts)], [], [click]));
    assert.deepEqual(later.followUps.map((c) => c.at), [600]);
    assert.equal(byClass(panelFor(later), 'later')?.textContent, 'then the tree re-rendered after the paint · at least 5000 components, the rest not walked');
  }

  // The same from walks of real trees.
  function fiber(tag: number, type: unknown, children: Record<string, unknown>[] = [], flags = tag === 0 ? 1 : 0): Record<string, unknown> {
    // Each one rendered before, so this is a re-render, not a mount.
    const f: Record<string, unknown> = { tag, flags, mode: 0, elementType: type, type, memoizedProps: null, memoizedState: null, return: null, child: children[0] ?? null, sibling: null, alternate: { tag, child: {} } };
    children.forEach((child, i) => Object.assign(child, { return: f, sibling: children[i + 1] ?? null }));
    return f;
  }
  const named = (name: string) => Object.assign(() => {}, { displayName: name });
  const rendered = (name: string, children: Record<string, unknown>[]) => fiber(0, named(name), children);
  const rows = (name: string, n: number) => Array.from({ length: n }, () => rendered(name, [fiber(5, 'li')]));
  const timed = (f: Record<string, unknown>, ms: number) => Object.assign(f, { actualDuration: ms, mode: 0b10 });
  const walked = (budget: number, tree: Record<string, unknown>) => {
    const w = walkCommit(tree as any, budget, 200, { ts: 0, type: 'click', gestureTs: 0 }, { profileMode: 0b10, strictMode: 0b1000, priority: undefined, didError: false, hydratedTarget: null });
    return sealReport(buildReport([entry('click', 0, 400, 3, 390)], [{ ...w, at: 200, sinceInput: 200, walkMs: 0, inDispatch: true }], [], [click]));
  };
  // Production: App beside a Toaster, the walk out of budget inside App.
  const beside = walked(5000, fiber(3, null, [rendered('App', rows('Row', 6000)), rendered('Toaster', [rendered('Toast', [])])]));
  assert.equal(beside.commits[0]?.pathStart, 'unknown-root');
  assert.equal(lineOf(beside), 'most likely at least 5000 components re-rendered inside the app');
  // Development: Left reached, cheap, and Right never reached, heavy, under an App that did not render. React's
  // total says the part past the cut took longer.
  const left = timed(rendered('Left', rows('Item', 3000)), 20);
  const right = timed(rendered('Right', rows('Heavy', 20)), 70);
  const dev = walked(1000, timed(fiber(3, null, [fiber(0, named('App'), [left, right], 0)]), 90));
  assert.equal(dev.commits[0]?.pathStart, 'unknown-root');
  assert.doesNotMatch(lineOf(dev), /Left|App/);
});

test("an open row lists the components of the commit a layout blame names, not the heaviest one's", () => {
  // Opening a menu, production build: 44 ms of layout forced in one script across four commits. The menu's
  // commit could hold it; the sidebar's rendered the most.
  const press = { name: 'pointerdown', interactionId: 7, startTime: 0, duration: 72, processingStart: 1.1, processingEnd: 59.9, target: null };
  const at = (at: number, opts: Partial<CommitSummary>): CommitSummary => ({
    at,
    sinceInput: at,
    inputTs: 0,
    gestureTs: 0,
    inputType: 'pointerdown',
    rendered: 15,
    mounted: 0,
    hydrated: false,
    hydratedTarget: null,
    truncated: false,
    roots: ['Layer'],
    hotPath: ['Layer'],
    components: [],
    hasDurations: false,
    coarseClock: false,
    total: 0,
    startedAt: null,
    effectsStartedAt: null,
    effectsEndedAt: null,
    walkMs: 0,
    priority: undefined,
    didError: false,
    ...opts,
  });
  const one = (name: string, count: number) => [{ name, count, self: null, total: null }];
  const sidebar = at(3.8, { rendered: 295, roots: ['Sidebar'], hotPath: ['Sidebar'], startRendered: 295, pathRendered: 295, components: one('NavItem', 24), effectsStartedAt: 4.6, effectsEndedAt: 4.7 });
  const portal = at(9.3, { rendered: 96, mounted: 95, roots: ['Portal'], hotPath: ['Portal'], components: one('Slot', 9), effectsStartedAt: 9.4, effectsEndedAt: 11.4 });
  const menu = at(36.5, { rendered: 185, roots: ['Header'], hotPath: ['Header', 'Menu', 'MenuContent'], startRendered: 185, pathRendered: 80, components: one('MenuItem', 13), effectsStartedAt: 36.8, effectsEndedAt: 57.4 });
  const layer = at(57.9, { components: one('Slot', 3), effectsStartedAt: 57.9, effectsEndedAt: 58 });
  const forced = [{ start: 0, duration: 64, blocking: 14, forcedLayout: 44.4, scripts: [{ invoker: '#document.onpointerdown', name: '', source: 'app.js', start: 1.9, duration: 58, forcedLayout: 44.4 }], styleAndLayoutStart: null }];
  const ring = [{ ts: 0, type: 'pointerdown', gestureTs: 0, press: undefined, target: null, owners: [], handler: null, key: null, dehydrated: null, work: { endedAt: 0, unjoined: [] } }];
  const r = sealReport(buildReport([press], [sidebar, portal, menu, layer], forced, ring));
  assert.deepEqual([r.explanation.blame.kind, r.explanation.blame.name], ['layout', 'Header']);
  const more = byClass(panelFor(r), 'more')!;
  assert.equal(byClass(more, 'h')?.textContent, 'Rendered before the paint · 185 components');
  assert.equal(byClass(more, 'comp')?.childNodes[0].textContent, 'MenuItem');
});

test("an open row lists the components of the commit a render blame names, not the heaviest one's", () => {
  // Enter on a menu item, production build: the press rendered 300 components and painted on its own; the
  // release's 55 ms of working time rendered 60 of its own, which the blame names.
  const entry = (name: string, startTime: number, duration: number, processingStart: number, processingEnd: number) => ({ name, interactionId: 7, startTime, duration, processingStart, processingEnd, target: null });
  const key = (ts: number, type: string) => ({ ts, type, gestureTs: 0, press: 'Enter', target: null, owners: [], handler: null, key: null, dehydrated: null, work: { endedAt: ts, unjoined: [] } });
  const rendered = (at: number, inputTs: number, inputType: string, rendered: number, root: string, name: string, count: number): CommitSummary => ({
    at,
    sinceInput: at - inputTs,
    inputTs,
    gestureTs: 0,
    inputType,
    rendered,
    hydrated: false,
    hydratedTarget: null,
    truncated: false,
    roots: [root],
    hotPath: [root],
    components: [{ name, count, self: null, total: null }],
    hasDurations: false,
    coarseClock: false,
    total: 0,
    startedAt: null,
    effectsStartedAt: null,
    effectsEndedAt: null,
    walkMs: 0,
    priority: undefined,
    didError: false,
  });
  const commits = [rendered(4.2, 0, 'keydown', 300, 'Menu', 'Item', 200), rendered(58, 5, 'keyup', 60, 'List', 'Row', 55)];
  const r = sealReport(buildReport([entry('keydown', 0, 32, 0.1, 4.8), entry('keyup', 5, 64, 5.2, 60)], commits, [], [key(0, 'keydown'), key(5, 'keyup')]));
  assert.deepEqual([r.explanation.blame.kind, r.explanation.blame.name], ['render', 'List']);
  const more = byClass(panelFor(r), 'more')!;
  assert.equal(byClass(more, 'h')?.textContent, 'Rendered before the paint · 60 components');
  assert.equal(byClass(more, 'comp')?.childNodes[0].textContent, 'Row');
});

test('under a development build of react-dom the badge is marked dev, and the panel says why its colours can run high', () => {
  // A 608 ms INP: the badge and the panel's head, drawn with react-dom of `bundleType` registered.
  const drawnUnder = (bundleType: number) => {
    const { body, restore } = panelDocument();
    try {
      const source = {
        reports: () => [],
        inp: () => ({ value: 608, rating: 'poor', report: null, interactionCount: 1 }),
        onInteraction: () => () => {},
        clear() {},
        stats: () => ({ mode: 'shim', unsupportedReason: null, react: 'reading' }),
        debug: { hook: () => ({ devtoolsLockedOut: false, renderers: [{ id: 1, version: '19.3.0', bundleType, rendererPackageName: 'react-dom' }] }) },
      };
      const overlay = createOverlay(source as unknown as Parameters<typeof createOverlay>[0], { open: true });
      const shadow = body.childNodes[0].shadowRoot;
      const badge = byClass(shadow, 'badge')!;
      const note = byClass(shadow, 'devnote');
      const link = note?.childNodes.find((node: string | Drawn) => typeof node !== 'string' && node.tagName === 'a');
      overlay.dispose();
      return { badge: badge.textContent, rating: badge.dataset.rating, note: note?.textContent ?? null, href: link?.attributes.href ?? null };
    } finally {
      restore();
    }
  };
  assert.deepEqual(drawnUnder(1), {
    badge: 'INP 608 msdev',
    rating: 'poor',
    note: 'Development build. React runs slower here than in production, and StrictMode renders twice, so check anything amber or red in a production build.',
    href: 'https://github.com/adityareddy-dev/react-inp-blame/blob/main/docs/install.md#numbers-in-development',
  });
  // A production or profiling build gets neither, and the colour is the same either way.
  assert.deepEqual(drawnUnder(0), { badge: 'INP 608 ms', rating: 'poor', note: null, href: null });
});
