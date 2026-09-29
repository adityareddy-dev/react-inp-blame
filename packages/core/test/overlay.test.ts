import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  // A key's click carries no pointer, and stays a click.
  assert.equal(titleFor(pressed('click', null)), 'Click on "Save"');
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
    // Where it did render, as before.
    const rendered = [...components, { name: 'ProductList', count: 1, self: 1, total: 141 }];
    assert.equal(line({ ...c, rendered: 382, components: rendered }), 'ProductList re-rendered · ProductRow ×375 · 151 ms');
    // Where the list holds only the heaviest and some that rendered are not in it, it may have, and is said as before.
    assert.equal(line({ ...c, rendered: 900 }), 'ProductList re-rendered · ProductRow ×375 · 151 ms');
  } finally {
    restore();
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
