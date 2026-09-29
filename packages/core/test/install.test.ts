import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { announceNavigation, install, mountOverlay, onInteraction } from '../src/index.ts';
import { page as installState } from '../src/install-state.ts';
import { MAX_REPORTS } from '../src/lifecycle.ts';
import { routerNavigated } from '../src/navigation.ts';
import type { InstallOptions, InteractionReport } from '../src/types.ts';
import { attributeINP } from '../src/web-vitals.ts';

const HOOK = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

// The library warns once per page, and keeps what it warned about with the rest of the page's state
// (session.ts). To those warnings every test here is a page of its own.
const session = (globalThis as unknown as Record<symbol, { slots: { warnings?: Set<string> } } | undefined>)[Symbol.for('react-inp-blame')];
beforeEach(() => session?.slots.warnings?.clear());

// PerformanceObserver as install() sees it: the entry types the browser lists, and the observers
// currently connected, so a test can hand them entries.
class Observer {
  static supportedEntryTypes: string[] = [];
  static live = new Set<Observer>();
  callback: (list: { getEntries(): any[] }) => void;
  /** The entry types it observes. */
  types = new Set<string>();
  /** Entries the browser has queued for this observer and not delivered yet: its next callback gets them, unless takeRecords() took them first. */
  queued: any[] = [];
  constructor(callback: (list: { getEntries(): any[] }) => void) {
    this.callback = callback;
  }
  observe(options: { type: string }): void {
    this.types.add(options.type);
    Observer.live.add(this);
  }
  disconnect(): void {
    Observer.live.delete(this);
  }
  takeRecords(): any[] {
    return this.queued.splice(0);
  }
}

class EventTimingWithInteractionId {
  get interactionId(): number {
    return 0;
  }
}

/** The URL of the page the stand-in browser shows. */
const PAGE_URL = 'https://shop.example/products';

interface Page {
  window: Record<string, any>;
  /** The listener install() added on the window for each event type. */
  listening: ReadonlyMap<string, (event: unknown) => void>;
  /** Hands `event` to the window's listener for `type`. */
  fire(type: string, event: Record<string, unknown>): void;
  /** Hands a batch of Event Timing entries to every connected observer, after any it had queued. */
  paint(entries: any[]): void;
  /** Queues entries on each connected observer of their type without delivering them, as the browser does until it next runs the observers' callbacks. */
  queue(entries: any[]): void;
  /** Hides the page: `document.visibilityState` turns 'hidden' and the window's visibilitychange listener runs. */
  hide(): void;
  /** Runs `inside` in a click's dispatch, where React's sync commit and a router's navigation run: `window.event` is the click. Returns the click's timeStamp. */
  duringClick(inside: () => void): number;
}


/** The element a derived event (`input`, `change`, `submit`) is dispatched on: a node, unlike a media query's `change`. */
const FIELD = { nodeType: 1 };
/** Runs `body` against a stand-in browser: a window on PAGE_URL, Event Timing with interactionId unless told otherwise, no Long Animation Frames. */
async function inBrowser(body: (page: Page) => void | Promise<void>, { entryTypes = ['event', 'first-input'], interactionId = true }: { entryTypes?: string[]; interactionId?: boolean } = {}): Promise<void> {
  const names = ['window', 'document', 'location', 'PerformanceObserver', 'PerformanceEventTiming'];
  const saved = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const listening = new Map<string, (event: unknown) => void>();
  const win: Record<string, any> = {
    addEventListener: (type: string, listener: (event: unknown) => void) => listening.set(type, listener),
    removeEventListener: (type: string) => listening.delete(type),
  };
  Observer.supportedEntryTypes = entryTypes;
  Observer.live.clear();
  const values = [win, {}, { href: PAGE_URL }, Observer, interactionId ? EventTimingWithInteractionId : class {}];
  names.forEach((name, i) => Object.defineProperty(globalThis, name, { value: values[i], configurable: true, writable: true }));
  try {
    await body({
      window: win,
      listening,
      fire: (type, event) => listening.get(type)?.(event),
      paint: (entries) => {
        for (const o of [...Observer.live]) {
          const delivered = o.queued.splice(0).concat(entries);
          o.callback({ getEntries: () => delivered });
        }
      },
      queue: (entries) => {
        for (const o of Observer.live) o.queued.push(...entries.filter((e) => o.types.has(e.entryType)));
      },
      hide: () => {
        (globalThis as any).document.visibilityState = 'hidden';
        listening.get('visibilitychange')?.({ type: 'visibilitychange' });
      },
      duringClick: (inside) => {
        const timeStamp = performance.now();
        win.event = { isTrusted: true, type: 'click', timeStamp };
        try {
          inside();
        } finally {
          delete win.event;
        }
        return timeStamp;
      },
    });
  } finally {
    names.forEach((name, i) => {
      const descriptor = saved[i];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as any)[name];
    });
  }
}

/** Makes `performance.now()` read `clock.now`, so a test can place inputs, commits and entries in time. */
function useClock(t: TestContext): { now: number } {
  const clock = { now: 0 };
  t.mock.method(performance, 'now', () => clock.now);
  return clock;
}

/** Resolves after the task install() hands published reports to listeners in, which is queued before it. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A DevTools hook some other tool installed: React DevTools, or Fast Refresh's stub. */
function existingHook() {
  let nextId = 0;
  const calls: number[] = [];
  return {
    calls,
    renderers: new Map<number, unknown>(),
    supportsFiber: true,
    inject(_internals: unknown): number {
      return ++nextId;
    },
    onCommitFiberRoot(id: number, ..._rest: unknown[]): void {
      calls.push(id);
    },
  };
}

const reactDom = (version: string, bundleType = 1) => ({ version, bundleType, rendererPackageName: 'react-dom' });

/** A committed tree: a HostRoot over one component that rendered, measured at `ms` when the build measures. */
function renderedTree(mode: number, ms: number | undefined): Record<string, any> {
  function Counter() {}
  const counter = { tag: 0, flags: 1, mode, elementType: Counter, type: Counter, memoizedProps: {}, memoizedState: null, return: null, child: null, sibling: null, alternate: null, actualDuration: ms };
  return { tag: 3, flags: 0, mode, elementType: null, type: null, memoizedProps: null, memoizedState: null, return: null, child: counter, sibling: null, alternate: null, actualDuration: ms };
}

/** A root as React hands it to the hook at its first commit, the one that mounts it: no tree before it, no lanes left pending. */
function mountedRoot(mode: number, ms: number | undefined): { current: Record<string, any>; pendingLanes: number } {
  return { current: renderedTree(mode, ms), pendingLanes: 0 };
}

/** The root committing again: a new tree, whose alternate is the tree it replaces. A production build passes no `ms`. */
function commitAgain(root: { current: Record<string, any> }, ms: number | undefined): void {
  const next = renderedTree(root.current.mode, ms);
  next.alternate = root.current;
  root.current = next;
}

/** A mounted root whose one component counts how often it is named, which a walk does once. */
function countingRoot() {
  const root = mountedRoot(0b11, 4);
  const component = root.current.child;
  const type = component.elementType;
  let named = 0;
  Object.defineProperty(component, 'elementType', {
    get() {
      named++;
      return type;
    },
  });
  return { root, walks: () => named };
}

/** A click's Event Timing entry: its handlers start 2 ms after the input and end 8 ms before the paint. */
const click = (interactionId: number, startTime: number, duration: number) => ({ entryType: 'event', name: 'click', interactionId, startTime, duration, processingStart: startTime + 2, processingEnd: startTime + duration - 8, target: null });

const slowClick = (duration: number) => click(7, 1000, duration);

/** The press and release entries of the same gesture, which share the click's interactionId. */
const pointer = (name: string, interactionId: number, startTime: number, duration: number) => ({ ...click(interactionId, startTime, duration), name });

/** Where a report says its interaction happened, and the navigation it started. */
const placeOf = (r: InteractionReport | null) => r && { navigationURL: r.navigationURL, navigationType: r.navigationType, startedNavigation: r.startedNavigation };

/** A button that shows a person's name and carries a data-testid, as a detached DOM node. */
function saveButton() {
  const button: Record<string, unknown> = { nodeType: 1, tagName: 'BUTTON', id: '', classList: { length: 0 }, parentNode: null, parentElement: null, getAttribute: (name: string) => (name === 'data-testid' ? 'save' : null) };
  button.firstChild = { nodeType: 3, nodeValue: 'Save for Ada Lovelace', parentNode: button, nextSibling: null, firstChild: null };
  return button;
}

const librarySource = fileURLToPath(new URL('../src/', import.meta.url));

/** Another copy of the library, the way a duplicated package puts one on a page: the same source at another path, sharing no module with this one. */
async function copyOfLibrary(t: TestContext): Promise<typeof import('../src/index.ts')> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-inp-blame-copy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(librarySource, path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
  return import(pathToFileURL(path.join(dir, 'src', 'index.ts')).href);
}

test('a browser without Event Timing interactionId gets nothing installed, one warning, and the reason in stats()', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const overlays: Promise<unknown>[] = [];
  for (const browser of [{ entryTypes: ['first-input'] }, { interactionId: false }]) {
    await inBrowser((page) => {
      const api = install({ debugGlobal: true });
      assert.equal(api.stats().mode, 'unsupported');
      assert.equal(api.stats().unsupportedReason?.kind, 'browser');
      assert.equal(HOOK in page.window, false, 'the DevTools hook was created');
      assert.equal(page.listening.size, 0, 'input listeners were added');
      // Exposed anyway, so stats() on the page says why nothing is reported.
      assert.equal(page.window.__REACT_INP_BLAME__, api);
      overlays.push(mountOverlay());
    }, browser);
  }
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /no Event Timing interactionId/);
  assert.deepEqual(await Promise.all(overlays), [null, null]);
});

/** Runs `body` in a build whose bundler wrote `mode` in place of `process.env.NODE_ENV`, as every bundler that can bundle React does. */
async function inBuild(mode: string, body: () => void | Promise<void>): Promise<void> {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = mode;
  try {
    await body();
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

test('in a production build, a browser without interactionId is warned about only on a page the sample takes, and the roll is made once', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const roll = t.mock.method(Math, 'random', () => 0.5);
  await inBuild('production', async () => {
    await inBrowser(
      (page) => {
        const api = install({ sampleRate: 0.4, debugGlobal: true });
        // Nothing printed, and stats() on the page still says why nothing is reported.
        assert.equal(api.stats().mode, 'unsupported');
        assert.equal(api.stats().unsupportedReason?.kind, 'browser');
        assert.equal(page.window.__REACT_INP_BLAME__, api);
        // Rolling again on a later call, such as the one mountOverlay() makes, would raise the share of pages that print it.
        install({ sampleRate: 1 });
        install();
        assert.equal(warn.mock.callCount(), 0);
        assert.equal(roll.mock.callCount(), 1);
      },
      { interactionId: false },
    );

    // Another page, which the sample takes.
    session?.slots.warnings?.clear();
    await inBrowser(
      () => {
        install({ sampleRate: 0.6 });
        install({ sampleRate: 0.6 });
      },
      { interactionId: false },
    );
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /no Event Timing interactionId/);
  });
});

test('in a development build, a browser without interactionId is warned about whatever sampleRate says', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const roll = t.mock.method(Math, 'random', () => 0.99);
  // Anything but 'production' counts, the 'test' a test runner sets too. Each mode is a page of its own.
  for (const mode of ['development', 'test']) {
    session?.slots.warnings?.clear();
    await inBuild(mode, () =>
      inBrowser(() => assert.equal(install({ sampleRate: 0 }).stats().mode, 'unsupported'), { interactionId: false }),
    );
  }
  assert.equal(warn.mock.callCount(), 2);
  for (const call of warn.mock.calls) assert.match(call.arguments[0], /no Event Timing interactionId/);
  assert.equal(roll.mock.callCount(), 0);
});

/** Runs `body` with `standIn` as the page's `process`, or with no `process` at all where it is undefined. */
function withProcess(standIn: { env: Record<string, string> } | undefined, body: () => void): void {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'process')!;
  if (standIn) Object.defineProperty(globalThis, 'process', { value: standIn, configurable: true, writable: true });
  else delete (globalThis as { process?: unknown }).process;
  try {
    body();
  } finally {
    Object.defineProperty(globalThis, 'process', saved);
  }
}

test('a page loaded with no bundler, where process is not defined, counts as a production build', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.method(Math, 'random', () => 0.5);
  await inBrowser(
    () => withProcess(undefined, () => assert.equal(install({ sampleRate: 0.4 }).stats().unsupportedReason?.kind, 'browser')),
    { interactionId: false },
  );
  assert.equal(warn.mock.callCount(), 0);
});

test('a page whose process is a stand-in with no NODE_ENV in it counts as a development build', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const roll = t.mock.method(Math, 'random', () => 0.99);
  await inBrowser(() => withProcess({ env: {} }, () => install({ sampleRate: 0 })), { interactionId: false });
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /no Event Timing interactionId/);
  assert.equal(roll.mock.callCount(), 0);
});

/**
 * Gives the stand-in browser a document with what the badge and panel are drawn with: elements that keep
 * their children and their parent, and a body. `hosts()` counts the elements in the body that the badge
 * and panel live in, `panelHidden()` says whether the panel of the first of them is hidden, `badge()`
 * is its badge, and `press(button)` clicks the panel's button of that class.
 */
function badgeDocument() {
  const element = (tagName: string): Record<string, any> => {
    const el: Record<string, any> = {
      tagName,
      id: '',
      dataset: {},
      style: {},
      hidden: false,
      parentNode: null,
      childNodes: [],
      get isConnected() {
        return el.parentNode !== null;
      },
      listeners: {},
      setAttribute() {},
      addEventListener(type: string, listener: (event: unknown) => void) {
        el.listeners[type] = listener;
      },
      attachShadow: () => (el.shadowRoot = element('#shadow-root')),
      append: (...nodes: unknown[]) => el.childNodes.push(...nodes),
      prepend: (...nodes: unknown[]) => el.childNodes.unshift(...nodes),
      replaceChildren: (...nodes: unknown[]) => (el.childNodes = nodes),
      appendChild: (node: Record<string, any>) => {
        node.parentNode = el;
        el.childNodes.push(node);
      },
      remove: () => {
        el.parentNode?.childNodes.splice(el.parentNode.childNodes.indexOf(el), 1);
        el.parentNode = null;
      },
    };
    return el;
  };
  const body = element('BODY');
  const document = { body, createElement: element, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true });
  const hosts = () => body.childNodes.filter((node: { id: string }) => node.id === 'react-inp-blame');
  const wrap = () => hosts()[0].shadowRoot.childNodes.find((node: { className?: string }) => node.className?.startsWith('wrap'));
  const panel = () => wrap().childNodes.find((node: { className?: string }) => node.className === 'panel');
  return {
    hosts: () => hosts().length,
    panelHidden: (): boolean => panel().hidden,
    badge: () => wrap().childNodes.find((node: { tagName: string }) => node.tagName === 'button'),
    press: (button: string) => panel().listeners.click({ target: { closest: (selector: string) => (selector === `.${button}` ? {} : null) } }),
  };
}

test('mountOverlay() after its handle was disposed shows the badge and panel again, with a handle of its own', async () => {
  await inBrowser(async () => {
    const { hosts } = badgeDocument();
    const api = install();
    const first = await mountOverlay();
    assert.equal(hosts(), 1);
    first?.dispose();
    assert.equal(hosts(), 0, 'the badge stayed up after its only handle was disposed');
    const second = await mountOverlay();
    assert.notEqual(second, first, 'the disposed handle came back');
    assert.equal(hosts(), 1);
    api.dispose();
    await nextTask();
    assert.equal(hosts(), 0);
  });
});

test('a component that shows the badge from an effect keeps it under StrictMode, which mounts, cleans up and mounts again', async () => {
  await inBrowser(async () => {
    const { hosts } = badgeDocument();
    const api = install();
    const shown: Promise<unknown>[] = [];
    // useEffect(() => { const p = mountOverlay(); return () => { p.then((h) => h?.dispose()); }; }, [])
    const effect = () => {
      const p = mountOverlay();
      shown.push(p);
      return () => {
        p.then((handle) => handle?.dispose());
      };
    };
    effect()();
    effect();
    await Promise.all(shown);
    await nextTask();
    assert.equal(hosts(), 1, 'the cleanup hid the badge the second mount asked for');
    api.dispose();
  });
});

test('the badge and panel stay while any handle mountOverlay() gave is left, and go with the last one', async () => {
  await inBrowser(async () => {
    const { hosts, panelHidden, badge } = badgeDocument();
    const api = install();
    const [a, b] = await Promise.all([mountOverlay(), mountOverlay()]);
    assert.notEqual(a, b);
    a?.dispose();
    a?.dispose();
    await nextTask();
    assert.equal(hosts(), 1, 'disposing one handle twice let go of the other one');
    a?.open();
    assert.equal(panelHidden(), true, 'a disposed handle opened the panel another handle holds');
    a?.toggle();
    assert.equal(panelHidden(), true, 'a disposed handle toggled the panel another handle holds');
    b?.open();
    assert.equal(panelHidden(), false);
    a?.close();
    assert.equal(panelHidden(), false, 'a disposed handle closed the panel another handle holds');
    badge().dataset.status = 'stale';
    a?.refresh();
    assert.equal(badge().dataset.status, 'stale', 'a disposed handle redrew the badge another handle holds');
    b?.refresh();
    assert.notEqual(badge().dataset.status, 'stale');
    b?.dispose();
    assert.equal(hosts(), 0);
    api.dispose();
  });
});

test('a handle another copy of the library gave out keeps the badge and panel up too', async (t) => {
  const other = await copyOfLibrary(t);
  await inBrowser(async () => {
    const { hosts } = badgeDocument();
    const api = install();
    const a = await mountOverlay();
    const b = await other.mountOverlay();
    assert.equal(hosts(), 1);
    a?.dispose();
    await nextTask();
    assert.equal(hosts(), 1, "one copy's handle took the badge down while the other copy's was still held");
    b?.dispose();
    assert.equal(hosts(), 0);
    api.dispose();
  });
});

test("dispose() takes down the badge install({ overlay: true }) showed, and a handle from before it leaves the next one's alone", async () => {
  await inBrowser(async () => {
    const { hosts } = badgeDocument();
    const api = install({ overlay: true });
    const before = await mountOverlay();
    assert.equal(hosts(), 1);
    api.dispose();
    await nextTask();
    assert.equal(hosts(), 0);

    const again = install({ overlay: true });
    const after = await mountOverlay();
    before?.dispose();
    await nextTask();
    assert.equal(hosts(), 1, 'a handle from before dispose() hid the badge a new install() showed');
    again.dispose();
    await nextTask();
    assert.equal(hosts(), 0, 'dispose() left up the badge the second install() showed');
    after?.dispose();
  });
});

test('a badge that could not be shown is tried again at the next mountOverlay()', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser(async () => {
    // The stand-in document has no createElement.
    const api = install();
    assert.equal(await mountOverlay(), null);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /the badge and panel could not be shown/);
    const { hosts } = badgeDocument();
    assert.notEqual(await mountOverlay(), null);
    assert.equal(hosts(), 1);
    api.dispose();
  });
});

test("the badge shows only where overlay: 'query' and the URL or localStorage ask for it, never on a page that did not", async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete (globalThis as Record<string, unknown>).localStorage;
  });
  const cases: [overlay: InstallOptions['overlay'], url: string, stored: string | null, shown: boolean][] = [
    ['query', PAGE_URL, null, false],
    ['query', `${PAGE_URL}?inp-blame`, null, true],
    ['query', `${PAGE_URL}?sort=price&inp-blame=1`, null, true],
    ['query', `${PAGE_URL}#inp-blame`, null, true],
    ['query', `${PAGE_URL}?inp-blamed`, null, false],
    ['query', `${PAGE_URL}?ref=inp-blame`, null, false],
    ['query', PAGE_URL, 'overlay', true],
    ['query', PAGE_URL, 'panel', false],
    [undefined, `${PAGE_URL}?inp-blame`, 'overlay', false],
    [false, `${PAGE_URL}?inp-blame`, 'overlay', false],
  ];
  for (const [overlay, url, stored, shown] of cases) {
    await inBrowser(async () => {
      const { search, hash } = new URL(url);
      Object.defineProperty(globalThis, 'location', { value: { href: url, search, hash }, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (key: string) => (key === 'react-inp-blame' ? stored : null), setItem() {} }, configurable: true, writable: true });
      const { hosts } = badgeDocument();
      const api = install({ overlay });
      await installState.overlay;
      assert.equal(hosts(), shown ? 1 : 0, `overlay: ${overlay} on ${url}${stored ? ` with ${stored} in localStorage` : ''}`);
      api.dispose();
    });
  }
});

test("a stored 'hidden' keeps the badge off for that person whatever overlay says, until ?inp-blame clears it", async (t) => {
  t.mock.method(console, 'warn', () => {});
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete (globalThis as Record<string, unknown>).localStorage;
  });
  const THROWS = 'throws';
  const cases: [overlay: InstallOptions['overlay'], url: string, stored: string | null, shown: boolean, after: string | null][] = [
    [true, PAGE_URL, null, true, null],
    [true, PAGE_URL, 'overlay', true, 'overlay'],
    [true, PAGE_URL, 'hidden', false, 'hidden'],
    [true, `${PAGE_URL}?inp-blame`, 'hidden', true, null],
    [true, PAGE_URL, THROWS, true, THROWS],
    [{ position: 'top-left' }, PAGE_URL, 'hidden', false, 'hidden'],
    [{ position: 'top-left' }, `${PAGE_URL}#inp-blame`, 'hidden', true, null],
    ['query', PAGE_URL, null, false, null],
    ['query', PAGE_URL, 'overlay', true, 'overlay'],
    ['query', PAGE_URL, 'hidden', false, 'hidden'],
    ['query', `${PAGE_URL}?inp-blame`, 'hidden', true, null],
    ['query', PAGE_URL, THROWS, false, THROWS],
    [false, PAGE_URL, null, false, null],
    [false, PAGE_URL, 'overlay', false, 'overlay'],
    [false, `${PAGE_URL}?inp-blame`, 'hidden', false, 'hidden'],
    [false, PAGE_URL, THROWS, false, THROWS],
  ];
  for (const [overlay, url, stored, shown, after] of cases) {
    await inBrowser(async () => {
      const { search, hash } = new URL(url);
      Object.defineProperty(globalThis, 'location', { value: { href: url, search, hash }, configurable: true, writable: true });
      let value = stored;
      const fail = () => {
        throw new Error('SecurityError');
      };
      const storage =
        stored === THROWS
          ? { getItem: fail, setItem: fail, removeItem: fail }
          : {
              getItem: (key: string) => (key === 'react-inp-blame' ? value : null),
              setItem() {},
              removeItem: (key: string) => {
                if (key === 'react-inp-blame') value = null;
              },
            };
      Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
      const { hosts } = badgeDocument();
      const api = install({ overlay });
      await installState.overlay;
      const what = `overlay: ${JSON.stringify(overlay)} on ${url} with ${stored} in localStorage`;
      assert.equal(hosts(), shown ? 1 : 0, what);
      assert.equal(stored === THROWS ? THROWS : value, after, what);
      api.dispose();
    });
  }
});

test('after Hide for me, mountOverlay() still shows the badge, and the overlay option asked again does not', async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete (globalThis as Record<string, unknown>).localStorage;
  });
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  await inBrowser(async () => {
    const { search, hash } = new URL(PAGE_URL);
    Object.defineProperty(globalThis, 'location', { value: { href: PAGE_URL, search, hash }, configurable: true, writable: true });
    const { hosts, press } = badgeDocument();
    const api = install({ overlay: true });
    await installState.overlay;
    assert.equal(hosts(), 1);
    press('hide');
    assert.equal(hosts(), 0);
    assert.equal(stored.get('react-inp-blame'), 'hidden');
    // The badge the page's own code asks for is shown regardless, and not the one Hide for me took down.
    const shown = await mountOverlay();
    assert.equal(hosts(), 1, 'mountOverlay() handed back the badge Hide for me took down');
    shown?.dispose();
    await nextTask();
    assert.equal(hosts(), 0);
    // install() again with overlay: true asks the option again, and 'hidden' keeps it off.
    install({ overlay: true });
    await installState.overlay;
    assert.equal(hosts(), 0);
    api.dispose();
  });
});

test("a browser without Event Timing shows the badge that says so only where it was asked for, and install() or 'query' alone never loads it", async (t) => {
  t.mock.method(console, 'warn', () => {});
  const cases: [overlay: InstallOptions['overlay'], shown: boolean][] = [
    [undefined, false],
    ['query', false],
    [true, true],
  ];
  for (const [overlay, shown] of cases) {
    await inBrowser(
      async () => {
        const { hosts } = badgeDocument();
        const api = install({ overlay });
        await installState.overlay;
        assert.equal(hosts(), shown ? 1 : 0, `overlay: ${overlay}`);
        api.dispose();
        await nextTask();
        assert.equal(hosts(), 0);
      },
      { entryTypes: ['first-input'] },
    );
  }
});

/** A document whose elements, in document order, are `elements`, walked the way the renderer check walks it. */
function documentOf(elements: object[], own: object = {}) {
  return Object.assign(own, {
    documentElement: elements[0],
    createTreeWalker: () => {
      let at = 0;
      return { currentNode: elements[0], nextNode: () => elements[++at] ?? null };
    },
  });
}

test('React rendered with no react-dom registered is warned about after 3 s, and a page with no React on it yet is not', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pages = [
    // An Astro page whose only island hydrates once it scrolls into view, or whose islands are all Vue.
    documentOf([{}, {}, {}]),
    // react-dom rendered an element, and never told the hook.
    documentOf([{}, {}, { __reactFiber$x1y2: {} }]),
    // react-dom hydrated the whole document.
    documentOf([{}], { __reactContainer$x1y2: {} }),
  ];
  const warned = [];
  for (const page of pages) {
    await inBrowser(() => {
      Object.defineProperty(globalThis, 'document', { value: page, configurable: true, writable: true });
      const api = install();
      const before = warn.mock.callCount();
      t.mock.timers.tick(3000);
      warned.push(warn.mock.calls.slice(before).some((call) => /React has rendered on this page/.test(String(call.arguments[0]))));
      api.dispose();
    });
    session?.slots.warnings?.clear();
  }
  assert.deepEqual(warned, [false, true, true]);
});

test('a page with no React on it 3 s after install is looked at once more, at its first interaction', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const late = /React has rendered on this page/;
  await inBrowser((page) => {
    const widget: Record<string, unknown> = {};
    Object.defineProperty(globalThis, 'document', { value: documentOf([{}, widget]), configurable: true, writable: true });
    const api = install();
    t.mock.timers.tick(3000);
    if (warn.mock.calls.some((call) => late.test(String(call.arguments[0])))) api.dispose();
    assert.equal(warn.mock.calls.filter((call) => late.test(String(call.arguments[0]))).length, 0);
    // A react-dom that loaded before the install creates its root after the check, and the page is clicked.
    widget.__reactContainer$x1y2 = {};
    try {
      page.paint([click(7, 3100, 20)]);
      page.paint([click(8, 3200, 20)]);
      assert.equal(warn.mock.calls.filter((call) => late.test(String(call.arguments[0]))).length, 1);
    } finally {
      api.dispose();
    }
  });
});

test("hook: 'auto' creates a hook when there is none, and it does not claim to be React DevTools", async () => {
  await inBrowser((page) => {
    const api = install();
    const hook = page.window[HOOK];
    assert.equal(api.stats().mode, 'shim');
    assert.equal(api.debug.hook().owner, 'react-inp-blame');
    assert.equal(hook.reactInpBlame, true);
    // react-dom reads checkDCE as the real React DevTools being present.
    assert.equal('checkDCE' in hook, false);
    api.dispose();
  });
});

test("hook: 'auto' chains onto a hook that is already there", async () => {
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install();
    assert.equal(api.stats().mode, 'chained');
    assert.equal(page.window[HOOK], existing);
    api.dispose();
  });
});

test("hook: 'chain' never creates the global hook", async () => {
  await inBrowser((page) => {
    const api = install({ hook: 'chain' });
    assert.equal(HOOK in page.window, false);
    assert.equal(api.stats().mode, 'none');
    api.dispose();
  });
});

test("hook: 'chain' reads commits through the existing hook, records them frozen, and puts the hook back on dispose", async () => {
  await inBrowser((page) => {
    const existing = existingHook();
    const { inject, onCommitFiberRoot } = existing;
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });

    const id = existing.inject(reactDom('19.3.0'));
    assert.deepEqual(api.debug.hook().renderers, [{ id, version: '19.3.0', bundleType: 1, rendererPackageName: 'react-dom' }]);
    page.duringClick(() => existing.onCommitFiberRoot(id, mountedRoot(0b11, 4), 1, false));
    assert.deepEqual(existing.calls, [id], 'the hook it wrapped no longer hears about commits');
    const [commit] = api.debug.commits();
    assert.equal(commit?.rendered, 1);
    assert.equal(commit?.priority, 1);
    assert.equal(commit?.didError, false);
    assert.ok(Object.isFrozen(commit) && Object.isFrozen(commit.components), 'a recorded commit can be changed');

    api.dispose();
    assert.equal(existing.inject, inject);
    assert.equal(existing.onCommitFiberRoot, onCommitFiberRoot);
    assert.equal('onPostCommitFiberRoot' in existing, false, 'the post-commit call it added stayed');
  });
});

test("hook: 'shim' over an existing hook chains instead of replacing it, and says so", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'shim' });
    assert.equal(page.window[HOOK], existing);
    assert.equal(api.stats().mode, 'chained');
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /chained onto it instead/);
    api.dispose();
  });
});

test('durations come from the ProfileMode bit of the React version that registered, and an experimental build reads as React 19', async () => {
  // React 17 numbered its mode flags differently: ProfileMode is 8 there and 2 is BlockingMode.
  // A tree outside ProfileMode keeps actualDuration at 0 in development and has none in production.
  const cases: Array<[version: string, mode: number, ms: number | undefined, hasDurations: boolean]> = [
    ['17.0.2', 0b1000, 5, true],
    ['17.0.2', 0b0010, 0, false],
    ['18.3.1', 0b0011, 5, true],
    ['18.3.1', 0b0001, 0, false],
    ['19.3.0', 0b0011, 5, true],
    ['19.3.0', 0b0001, undefined, false],
    // react@experimental on npm carries no version of its own.
    ['0.0.0-experimental-ff8f88fc-20260915', 0b0011, 5, true],
  ];
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    for (const [version, mode, ms, hasDurations] of cases) {
      const id = existing.inject(reactDom(version));
      const walked = api.debug.commits().length;
      page.duringClick(() => existing.onCommitFiberRoot(id, mountedRoot(mode, ms)));
      const commits = api.debug.commits();
      assert.equal(commits.length, walked + 1, `React ${version} was not walked`);
      assert.equal(commits[commits.length - 1]?.hasDurations, hasDurations, `React ${version}, mode ${mode}`);
    }
    api.dispose();
  });
});

test('a report says which build of react-dom measured it, and under a development build whether StrictMode rendered it', async (t) => {
  // A production and a profiling build both say bundleType 0, and only a profiling build puts its roots in
  // ProfileMode. StrictMode's bit is 8 on React 18 and 19, and 1 on React 17, where ProfileMode is 8.
  const cases: Array<[version: string, bundleType: number, mode: number, reactBuild: InteractionReport['reactBuild'], strictMode: boolean | null]> = [
    ['19.3.0', 1, 0b1011, 'development', true],
    ['19.3.0', 1, 0b0011, 'development', false],
    ['18.3.1', 1, 0b1011, 'development', true],
    ['18.3.1', 1, 0b0011, 'development', false],
    ['17.0.2', 1, 0b1001, 'development', true],
    ['17.0.2', 1, 0b1000, 'development', false],
    ['19.3.0', 0, 0b0011, 'profiling', null],
    ['19.3.0', 0, 0b1001, 'production', null],
  ];
  const clock = useClock(t);
  for (const [version, bundleType, mode, reactBuild, strictMode] of cases) {
    await inBrowser((page) => {
      const existing = existingHook();
      page.window[HOOK] = existing;
      const api = install({ hook: 'chain', devtoolsTrack: false });
      const id = existing.inject(reactDom(version, bundleType));
      clock.now = 500;
      const root = mountedRoot(mode, 4);
      existing.onCommitFiberRoot(id, root);
      clock.now = 1000;
      commitAgain(root, 4);
      page.duringClick(() => existing.onCommitFiberRoot(id, root));
      page.paint([slowClick(120)]);
      const r = api.last();
      assert.deepEqual({ commits: r?.commits.length, reactBuild: r?.reactBuild, strictMode: r?.strictMode }, { commits: 1, reactBuild, strictMode }, `React ${version}, bundleType ${bundleType}, mode ${mode}`);
      api.dispose();
    });
  }
});

test("a report's build is the page's even where it joined no commit, and null until react-dom has said which it is", async (t) => {
  const clock = useClock(t);
  // The build a slow click with no render of its own reads, after a mount in `mode` where one is given.
  const buildOf = async (renderer: Record<string, unknown> | null, mode: number | null) => {
    let seen: Pick<InteractionReport, 'reactBuild' | 'strictMode'> | undefined;
    await inBrowser((page) => {
      const existing = existingHook();
      page.window[HOOK] = existing;
      const api = install({ hook: 'chain', devtoolsTrack: false });
      const id = renderer && existing.inject(renderer);
      clock.now = 500;
      if (id !== null && mode !== null) existing.onCommitFiberRoot(id, mountedRoot(mode, 4));
      clock.now = 1000;
      page.paint([slowClick(120)]);
      const r = api.last();
      assert.equal(r?.commits.length, 0);
      seen = r && { reactBuild: r.reactBuild, strictMode: r.strictMode };
      api.dispose();
    });
    return seen;
  };
  assert.deepEqual(await buildOf(reactDom('19.3.0', 1), null), { reactBuild: 'development', strictMode: null });
  assert.deepEqual(await buildOf(reactDom('19.3.0', 0), 0b0011), { reactBuild: 'profiling', strictMode: null });
  assert.deepEqual(await buildOf(reactDom('19.3.0', 0), 0b0001), { reactBuild: 'production', strictMode: null });
  // Before the page's first commit a production build and a profiling one look the same.
  assert.deepEqual(await buildOf(reactDom('19.3.0', 0), null), { reactBuild: null, strictMode: null });
  assert.deepEqual(await buildOf({ version: '19.3.0', rendererPackageName: 'react-dom' }, 0b0011), { reactBuild: null, strictMode: null });
  assert.deepEqual(await buildOf(null, null), { reactBuild: null, strictMode: null });
});

test("a development react-dom beside a production one is the page's build whichever registered first, as the badge says", async (t) => {
  const clock = useClock(t);
  for (const widgetFirst of [true, false]) {
    await inBrowser((page) => {
      const existing = existingHook();
      page.window[HOOK] = existing;
      const api = install({ hook: 'chain', devtoolsTrack: false });
      // A production widget's react-dom, and the app's development one under <StrictMode>.
      const widget = widgetFirst ? existing.inject(reactDom('19.3.0', 0)) : 0;
      const app = existing.inject(reactDom('19.3.0', 1));
      const other = widgetFirst ? widget : existing.inject(reactDom('19.3.0', 0));
      clock.now = 400;
      existing.onCommitFiberRoot(other, mountedRoot(0b0001, undefined));
      clock.now = 500;
      const root = mountedRoot(0b1011, 4);
      existing.onCommitFiberRoot(app, root);
      clock.now = 1000;
      commitAgain(root, 4);
      page.duringClick(() => existing.onCommitFiberRoot(app, root));
      page.paint([slowClick(120)]);
      const r = api.last();
      assert.deepEqual({ commits: r?.commits.length, reactBuild: r?.reactBuild, strictMode: r?.strictMode }, { commits: 1, reactBuild: 'development', strictMode: true }, `widget first: ${widgetFirst}`);
      api.dispose();
    });
  }
  // A production root created with unstable_strictMode carries the bit too, but renders once.
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const widget = existing.inject(reactDom('19.3.0', 0));
    existing.inject(reactDom('19.3.0', 1));
    clock.now = 500;
    const root = mountedRoot(0b1001, undefined);
    existing.onCommitFiberRoot(widget, root);
    clock.now = 1000;
    commitAgain(root, undefined);
    page.duringClick(() => existing.onCommitFiberRoot(widget, root));
    page.paint([slowClick(120)]);
    const r = api.last();
    assert.deepEqual({ commits: r?.commits.length, reactBuild: r?.reactBuild, strictMode: r?.strictMode }, { commits: 1, reactBuild: 'development', strictMode: false });
    api.dispose();
  });
  // A react-dom this library cannot read did not measure anything, whatever build it is.
  t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    existing.inject(reactDom('16.14.0', 1));
    const id = existing.inject(reactDom('19.3.0', 0));
    clock.now = 500;
    existing.onCommitFiberRoot(id, mountedRoot(0b0001, undefined));
    clock.now = 1000;
    page.paint([slowClick(120)]);
    assert.equal(api.last()?.reactBuild, 'production');
    api.dispose();
  });
});

test('a react-dom outside React 17 to 19 is not walked, and the page is unsupported only while no other react-dom can be read', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });

    const canvas = existing.inject({ version: '9.1.0', bundleType: 1, rendererPackageName: '@react-three/fiber' });
    page.duringClick(() => existing.onCommitFiberRoot(canvas, mountedRoot(0b11, 4)));
    assert.equal(api.debug.commits().length, 0);
    assert.equal(api.stats().mode, 'chained');

    const widget = existing.inject(reactDom('16.14.0'));
    assert.equal(api.stats().mode, 'unsupported');
    assert.equal(api.stats().unsupportedReason?.kind, 'react-version');
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /react-dom 16\.14\.0 is outside React 17 to 19/);
    page.duringClick(() => existing.onCommitFiberRoot(widget, mountedRoot(0b11, 4)));
    assert.equal(api.debug.commits().length, 0);

    // The page's own React, beside an embedded widget that brought React 16.
    const app = existing.inject(reactDom('19.3.0'));
    assert.deepEqual({ mode: api.stats().mode, reason: api.stats().unsupportedReason }, { mode: 'chained', reason: null });
    page.duringClick(() => existing.onCommitFiberRoot(app, mountedRoot(0b11, 4)));
    page.duringClick(() => existing.onCommitFiberRoot(widget, mountedRoot(0b11, 4)));
    assert.equal(api.debug.commits().length, 1);
    assert.equal(warn.mock.callCount(), 1);
    api.dispose();
  });
});

test('a root of an unexpected shape turns the walk off for good at the first commit', async (t) => {
  t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    const id = existing.inject(reactDom('19.3.0'));
    const changed = mountedRoot(0b11, 4);
    delete changed.current.flags;
    page.duringClick(() => existing.onCommitFiberRoot(id, changed));
    assert.equal(api.stats().mode, 'unsupported');
    assert.equal(api.stats().unsupportedReason?.kind, 'fiber-shape');
    page.duringClick(() => existing.onCommitFiberRoot(id, mountedRoot(0b11, 4)));
    assert.equal(api.debug.commits().length, 0);
    api.dispose();
  });
});

test('a walk that throws turns the walk off for good, and stats() carries what it threw', async (t) => {
  t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    Object.defineProperty(root.current.child, 'flags', {
      get() {
        throw new Error('flags moved');
      },
    });
    page.duringClick(() => existing.onCommitFiberRoot(id, root));
    assert.equal(api.stats().mode, 'unsupported');
    assert.equal(api.stats().unsupportedReason?.kind, 'walk-threw');
    assert.match(api.stats().unsupportedReason?.message ?? '', /reading a commit of react-dom 19\.3\.0 threw \(Error: flags moved\)/);
    api.dispose();
  });
});

test('a walk that throws a value with no string form still turns the walk off, and the hook it chains onto still hears the commit', async (t) => {
  t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    try {
      const id = existing.inject(reactDom('19.3.0'));
      const root = mountedRoot(0b11, 4);
      existing.onCommitFiberRoot(id, root);
      // A component whose type throws an object with no prototype when it is read, which has no string form.
      commitAgain(root, 4);
      Object.defineProperty(root.current.child, 'elementType', {
        get() {
          throw Object.create(null);
        },
      });
      assert.doesNotThrow(() => page.duringClick(() => existing.onCommitFiberRoot(id, root)));
      assert.deepEqual(existing.calls, [id, id]);
      assert.equal(api.stats().unsupportedReason?.kind, 'walk-threw');
      assert.match(api.stats().unsupportedReason?.message ?? '', /reading a commit of react-dom 19\.3\.0 threw \(a value that cannot be printed\)/);
    } finally {
      api.dispose();
    }
  });
});

test("a page whose DevTools hook turns React's support off still gets reports, without components, and stats() says why", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const disabled = { ...existingHook(), isDisabled: true };
    const { inject, onCommitFiberRoot } = disabled;
    page.window[HOOK] = disabled;
    const api = install({ devtoolsTrack: false });
    assert.deepEqual({ mode: api.stats().mode, kind: api.stats().unsupportedReason?.kind }, { mode: 'unsupported', kind: 'hook-disabled' });
    assert.equal(disabled.inject, inject, 'the disabled hook was wrapped');
    assert.equal(disabled.onCommitFiberRoot, onCommitFiberRoot, 'the disabled hook was wrapped');
    page.paint([slowClick(120)]);
    assert.equal(api.last()?.duration, 120);
    assert.equal(warn.mock.callCount(), 1);
    api.dispose();
  });
  // A global that holds no object has neither field, and React registers with nothing there too.
  for (const value of [true, 1, 'disabled']) {
    session?.slots.warnings?.clear();
    warn.mock.resetCalls();
    await inBrowser((page) => {
      page.window[HOOK] = value;
      const api = install({ devtoolsTrack: false });
      assert.deepEqual({ mode: api.stats().mode, kind: api.stats().unsupportedReason?.kind }, { mode: 'unsupported', kind: 'hook-disabled' });
      page.paint([slowClick(120)]);
      assert.equal(api.last()?.duration, 120);
      assert.equal(warn.mock.callCount(), 1);
      assert.match(warn.mock.calls[0].arguments[0], /turns React's developer tools support off/);
      api.dispose();
    });
  }
});

/**
 * Installs over a hook the page locked to keep developer tools out, which `lock` does to it and returns.
 * The install must not throw into the page's entry module, and must leave the hook the way the page made it.
 */
async function overLockedHook(t: TestContext, lock: (hook: ReturnType<typeof existingHook>) => object): Promise<void> {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const locked = existingHook();
    const { inject, onCommitFiberRoot } = locked;
    page.window[HOOK] = lock(locked);
    const api = install({ devtoolsTrack: false });
    assert.deepEqual({ mode: api.stats().mode, kind: api.stats().unsupportedReason?.kind }, { mode: 'unsupported', kind: 'hook-disabled' });
    assert.equal(locked.inject, inject, 'the locked hook was left wrapped');
    assert.equal(locked.onCommitFiberRoot, onCommitFiberRoot, 'the locked hook was left wrapped');
    assert.equal('onPostCommitFiberRoot' in locked, false, 'the locked hook was left wrapped');
    page.paint([slowClick(120)]);
    assert.equal(api.last()?.duration, 120);
    // The report says why nothing React did is in it, in words that fit a hook the page locked.
    assert.match(api.last()?.explanation.notes.join('\n') ?? '', /the page turns its DevTools hook off or locks it/);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /cannot be wrapped/);
    api.dispose();

    page.window[HOOK] = existingHook();
    const again = install({ devtoolsTrack: false });
    assert.deepEqual({ mode: again.stats().mode, reason: again.stats().unsupportedReason }, { mode: 'chained', reason: null });
    again.dispose();
  });
}

test('a page whose DevTools hook is frozen still gets reports, without components, and install() does not throw', async (t) => {
  await overLockedHook(t, (hook) => Object.freeze(hook));
});

test('a page whose DevTools hook has a getter for onCommitFiberRoot still gets reports, and its inject is put back', async (t) => {
  // inject is wrapped first, so the throw comes after the hook was already half wrapped.
  await overLockedHook(t, (hook) => {
    const { onCommitFiberRoot } = hook;
    return Object.defineProperty(hook, 'onCommitFiberRoot', { get: () => onCommitFiberRoot, enumerable: true, configurable: true });
  });
});

test("a page whose DevTools hook drops what is assigned to onCommitFiberRoot is unsupported, not read as React rendering nothing", async (t) => {
  // Nothing throws, so only reading the methods back shows that React's commits would never come here.
  await overLockedHook(t, (hook) => {
    const { onCommitFiberRoot } = hook;
    return Object.defineProperty(hook, 'onCommitFiberRoot', { get: () => onCommitFiberRoot, set: () => {}, enumerable: true, configurable: true });
  });
});

test('a page whose DevTools hook drops what is assigned to inject is unsupported, not read as React rendering nothing', async (t) => {
  // No react-dom would ever register with the library, so none of its commits could be read.
  await overLockedHook(t, (hook) => {
    const { inject } = hook;
    return Object.defineProperty(hook, 'inject', { get: () => inject, set: () => {}, enumerable: true, configurable: true });
  });
});

test('a page whose DevTools hook drops what is assigned to onPostCommitFiberRoot is unsupported, and the two methods wrapped are put back', async (t) => {
  await overLockedHook(t, (hook) => new Proxy(hook, { set: (target, key, value) => (key !== 'onPostCommitFiberRoot' && ((target as any)[key] = value), true) }));
});

/** Gives `hook` an onCommitFiberRoot whose setter keeps a function of its own that calls the one it is given, and returns each one it was given. */
function wrapsWhatItIsGiven(hook: ReturnType<typeof existingHook>): unknown[] {
  const given: unknown[] = [];
  let stored = hook.onCommitFiberRoot;
  Object.defineProperty(hook, 'onCommitFiberRoot', {
    get: () => stored,
    set: (fn: typeof stored) => {
      given.push(fn);
      stored = function (this: unknown, ...args: Parameters<typeof fn>) {
        return fn.apply(this, args);
      };
    },
    enumerable: true,
    configurable: true,
  });
  return given;
}

test('a page whose DevTools hook wraps what is assigned to onCommitFiberRoot is still chained, and its commits are read', async (t) => {
  // What is assigned never reads back, and React's commits reach it all the same.
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const existing = existingHook();
    wrapsWhatItIsGiven(existing);
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    assert.equal(api.stats().mode, 'chained');
    const id = existing.inject(reactDom('19.3.0'));
    page.duringClick(() => existing.onCommitFiberRoot(id, mountedRoot(0b11, 4), 1, false));
    assert.equal(api.debug.commits().length, 1);
    assert.deepEqual(existing.calls, [id], 'the hook it wrapped no longer hears about commits');
    assert.equal(warn.mock.callCount(), 0);
    api.dispose();
  });
});

test('a page whose DevTools hook is sealed without onPostCommitFiberRoot still gets reports, and the two methods wrapped are put back', async (t) => {
  await overLockedHook(t, (hook) => Object.seal(hook));
});

test('a hook that wraps what is assigned to onCommitFiberRoot and is sealed without onPostCommitFiberRoot is given its own back', async (t) => {
  t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const existing = existingHook();
    const { onCommitFiberRoot } = existing;
    const given = wrapsWhatItIsGiven(existing);
    page.window[HOOK] = Object.seal(existing);
    const api = install({ hook: 'chain', devtoolsTrack: false });
    assert.equal(api.stats().mode, 'unsupported');
    // Ours does not read back from a setter like that, so it goes back because it is no longer the page's own.
    assert.equal(given.length, 2);
    assert.equal(given[1], onCommitFiberRoot, 'the hook was left calling the library');
    api.dispose();
  });
});

test('a page that freezes its DevTools hook after install() can still dispose(), and what stays wrapped only passes calls on', async (t) => {
  // The library is the first import, so a script in the app that locks the hook runs after it has wrapped it.
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    Object.freeze(existing);
    api.dispose();

    const again = install({ hook: 'chain', devtoolsTrack: false });
    assert.notEqual(again, api, 'install() after dispose() returned the API it disposed');
    assert.equal(again.stats().mode, 'unsupported');
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /cannot be wrapped/);
    page.duringClick(() => existing.onCommitFiberRoot(id, mountedRoot(0b11, 4), 1, false));
    assert.deepEqual(existing.calls, [id], "the page's own hook stopped hearing about commits");
    assert.equal(again.debug.commits().length, 0);
    again.dispose();
  });
});

test('a page that freezes its DevTools hook after install() and before React registers can dispose() it, and again, and the next install() is a new one', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    assert.equal(api.stats().mode, 'chained');
    Object.freeze(existing);
    assert.doesNotThrow(() => api.dispose());
    assert.equal(installState.installed, null, 'dispose() stopped before the install was let go');
    assert.doesNotThrow(() => api.dispose());

    const again = install({ hook: 'chain', devtoolsTrack: false });
    assert.notEqual(again, api, 'install() after dispose() returned the API it disposed');
    assert.equal(again.stats().mode, 'unsupported');
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /cannot be wrapped/);
    again.dispose();
  });
});

test('a page that seals its DevTools hook after install() gets its methods back on dispose(), and the next install() wraps it again', async () => {
  await inBrowser((page) => {
    const existing = existingHook();
    const { inject, onCommitFiberRoot } = existing;
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    Object.seal(existing);
    api.dispose();
    assert.equal(existing.inject, inject);
    assert.equal(existing.onCommitFiberRoot, onCommitFiberRoot);
    // A sealed hook keeps the property the library added, but React calls it only when it is a function.
    assert.equal((existing as { onPostCommitFiberRoot?: unknown }).onPostCommitFiberRoot, undefined);

    const again = install({ hook: 'chain', devtoolsTrack: false });
    assert.equal(again.stats().mode, 'chained');
    page.duringClick(() => existing.onCommitFiberRoot(id, mountedRoot(0b11, 4), 1, false));
    assert.equal(again.debug.commits().length, 1);
    again.dispose();
  });
});

test('a hook that inherits onPostCommitFiberRoot and is sealed after install() still hears about post-commits after dispose()', async () => {
  // A hook made from a class has its methods on the prototype, where a sealed hook's own property would hide them.
  await inBrowser((page) => {
    const posts: number[] = [];
    class Hook {
      renderers = new Map<number, unknown>();
      supportsFiber = true;
      inject(_internals: unknown): number {
        return 1;
      }
      onCommitFiberRoot(): void {}
      onPostCommitFiberRoot(id: number): void {
        posts.push(id);
      }
    }
    const existing = new Hook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    Object.seal(existing);
    api.dispose();
    // React calls it only when it is a function.
    if (typeof existing.onPostCommitFiberRoot === 'function') existing.onPostCommitFiberRoot(1);
    assert.deepEqual(posts, [1], "the hook's own onPostCommitFiberRoot was hidden");
  });
});

test('a page that declares the global with var gets the shim as its value, and a hook assigned over it is noticed at the next Event Timing batch', async (t) => {
  // `var __REACT_DEVTOOLS_GLOBAL_HOOK__;` in a classic script leaves the global empty and writable, but it cannot
  // be redefined as the accessor that sees an assignment as it happens.
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    Object.defineProperty(page.window, HOOK, { value: undefined, writable: true, enumerable: true });
    const api = install({ devtoolsTrack: false });
    assert.equal(api.stats().mode, 'shim');
    assert.equal(page.window[HOOK]?.reactInpBlame, true, 'React would find no hook');
    assert.equal(warn.mock.callCount(), 0);
    page.window[HOOK] = existingHook();
    assert.equal(api.stats().mode, 'shim');
    page.paint([slowClick(120)]);
    assert.equal(api.stats().mode, 'chained');
    api.dispose();
  });
});

test('a page that holds the global empty and read-only still gets reports, without components, and install() does not throw', async (t) => {
  // A property defined with nothing in it and no way to assign it, which React reads as no hook. It can neither
  // become the library's accessor nor hold the shim.
  const warn = t.mock.method(console, 'warn', () => {});
  for (const empty of [{ value: undefined }, { get: () => undefined }]) {
    session?.slots.warnings?.clear();
    warn.mock.resetCalls();
    await inBrowser((page) => {
      Object.defineProperty(page.window, HOOK, empty);
      const api = install({ devtoolsTrack: false });
      assert.deepEqual({ mode: api.stats().mode, kind: api.stats().unsupportedReason?.kind }, { mode: 'unsupported', kind: 'hook-disabled' });
      assert.equal(page.window[HOOK], undefined);
      page.paint([slowClick(120)]);
      assert.equal(api.last()?.duration, 120);
      assert.equal(warn.mock.callCount(), 1);
      assert.match(warn.mock.calls[0].arguments[0], /empty and read-only/);
      api.dispose();
    });
  }
});

test('a frozen hook that replaces the shim before React registers is not followed, and the assignment does not throw', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    page.window[HOOK] = Object.freeze(existingHook());
    assert.deepEqual({ mode: api.stats().mode, kind: api.stats().unsupportedReason?.kind }, { mode: 'unsupported', kind: 'hook-disabled' });
    assert.equal(warn.mock.callCount(), 1);
    api.dispose();
  });
});

test("a hook that turns React's support off and replaces the shim before React registers is not followed, and stats() says why", async (t) => {
  // The plugin's shim goes in ahead of the app, so an app whose first import keeps developer tools out assigns its hook over it.
  const warn = t.mock.method(console, 'warn', () => {});
  for (const off of [{ isDisabled: true }, { ...existingHook(), isDisabled: true }, { ...existingHook(), supportsFiber: false }]) {
    session?.slots.warnings?.clear();
    warn.mock.resetCalls();
    await inBrowser((page) => {
      const api = install({ devtoolsTrack: false });
      const { inject } = off as { inject?: unknown };
      page.window[HOOK] = off;
      assert.deepEqual({ mode: api.stats().mode, kind: api.stats().unsupportedReason?.kind }, { mode: 'unsupported', kind: 'hook-disabled' });
      assert.equal((off as { inject?: unknown }).inject, inject, 'the hook was wrapped');
      page.paint([slowClick(120)]);
      assert.equal(api.last()?.duration, 120);
      assert.match(api.last()?.explanation.notes.join('\n') ?? '', /the page turns its DevTools hook off or locks it/);
      assert.equal(warn.mock.callCount(), 1);
      assert.match(warn.mock.calls[0].arguments[0], /turns React's developer tools support off/);
      api.dispose();
    });
  }
});

/**
 * Gives the test a shim of its own, as each page has one, and puts the shared one back after it. The react-doms
 * other tests registered with the shared shim would be read, and those this test registers would be read in theirs.
 */
function ownShim(t: TestContext): void {
  const hookState = (session?.slots as Record<string, { shim: unknown }>).hook!;
  const shared = hookState.shim;
  hookState.shim = null;
  t.after(() => {
    hookState.shim = shared;
  });
}

/** What the common scripts that keep React DevTools out of production do to the hook they find, where it is: each method a no-op and every other field null. */
function turnOff(hook: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(hook)) hook[key] = typeof value === 'function' ? () => {} : null;
}

test('a page that turns the DevTools hook off where it is after install() is unsupported, not read as React rendering nothing', async (t) => {
  // The library is the first import, so such a script in the app runs once react-dom has registered, on the hook
  // react-dom registered with: the shim, or the hook the library chained onto.
  const warn = t.mock.method(console, 'warn', () => {});
  const clock = useClock(t);
  ownShim(t);
  for (const existing of [null, existingHook()]) {
    session?.slots.warnings?.clear();
    warn.mock.resetCalls();
    await inBrowser(async (page) => {
      if (existing) page.window[HOOK] = existing;
      const api = install({ threshold: 40, devtoolsTrack: false });
      const hook = page.window[HOOK];
      const id = hook.inject(reactDom('19.3.0'));
      const root = mountedRoot(0b11, 4);
      hook.onCommitFiberRoot(id, root);
      turnOff(hook);
      clock.now = 500;
      page.fire('click', { isTrusted: true, type: 'click', timeStamp: 500, target: null });
      page.duringClick(() => {
        clock.now = 650;
        commitAgain(root, 150);
        hook.onCommitFiberRoot(id, root, 1, false);
      });
      page.paint([click(3, 500, 200)]);
      await nextTask();
      const stats = api.stats();
      assert.deepEqual({ mode: stats.mode, kind: stats.unsupportedReason?.kind, react: stats.react }, { mode: 'unsupported', kind: 'hook-disabled', react: 'unreadable' });
      // debug.hook() still describes the hook the page turned off, and the react-dom that registered with it.
      const info = api.debug.hook();
      assert.match(info.owner, existing ? /^existing hook \(/ : /^react-inp-blame$/);
      assert.deepEqual(info.renderers.map((renderer) => renderer.version), ['19.3.0']);
      const r = api.last();
      assert.ok(r);
      assert.doesNotMatch(r.explanation.cause, /didn't render anything/);
      assert.match(r.explanation.notes.join('\n'), /the page turns its DevTools hook off or locks it/);
      assert.equal(warn.mock.callCount(), 1);
      assert.match(warn.mock.calls[0].arguments[0], /off after install\(\)/);
      api.dispose();
      // Installed again over it, the page is unsupported from the start rather than from the next batch, and React,
      // which registered with the hook, is not said to have registered with none.
      const again = install({ threshold: 40, devtoolsTrack: false });
      assert.equal(again.stats().mode, 'unsupported');
      assert.match(again.stats().unsupportedReason?.message ?? '', /off after react-dom registered with it/);
      // That install() never took the hook up, so debug.hook() describes none, as for any hook install() finds off.
      assert.equal(again.debug.hook().owner, 'none');
      again.dispose();
    });
  }
});

test('a click whose commit was read before React stopped being read keeps it, and its report says so rather than that none is in it', async (t) => {
  // The page turns the hook off, or a later commit's walk throws, after the click's commit was read and before its
  // entry arrives, so the report is built once the library has stopped reading.
  t.mock.method(console, 'warn', () => {});
  const clock = useClock(t);
  ownShim(t);
  for (const stop of ['turned off', 'walk threw']) {
    await inBrowser(async (page) => {
      if (stop === 'walk threw') page.window[HOOK] = existingHook();
      const api = install({ threshold: 40, devtoolsTrack: false });
      const hook = page.window[HOOK];
      const id = hook.inject(reactDom('19.3.0'));
      const root = mountedRoot(0b11, 4);
      hook.onCommitFiberRoot(id, root);
      clock.now = 1000;
      page.fire('click', { isTrusted: true, type: 'click', timeStamp: 1000, target: null });
      page.duringClick(() => {
        clock.now = 1150;
        commitAgain(root, 150);
        hook.onCommitFiberRoot(id, root, 1, false);
        if (stop === 'walk threw') {
          clock.now = 1160;
          commitAgain(root, 5);
          Object.defineProperty(root.current.child, 'elementType', {
            get() {
              throw new Error('elementType moved');
            },
          });
          hook.onCommitFiberRoot(id, root, 1, false);
        }
      });
      if (stop === 'turned off') turnOff(hook);
      page.paint([click(1000, 1000, 200)]);
      await nextTask();
      const r = api.last();
      assert.ok(r);
      assert.deepEqual({ mode: api.stats().mode, reactStatus: r.reactStatus, commits: r.commits.length }, { mode: 'unsupported', reactStatus: 'unreadable', commits: 1 });
      assert.match(r.explanation.cause, /150 ms .*Counter/);
      const notes = r.explanation.notes.join('\n');
      assert.doesNotMatch(notes, /nothing React did is in this report/);
      assert.match(notes, /React stopped being read partway through this click, so only what it did before that is in this report/);
      api.dispose();
    });
  }
});

test('a chained hook whose supportsFiber the page clears after install() gets its own methods back', async (t) => {
  t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const existing = existingHook();
    const { inject, onCommitFiberRoot } = existing;
    page.window[HOOK] = existing;
    const api = install({ devtoolsTrack: false });
    existing.supportsFiber = false;
    page.paint([slowClick(120)]);
    assert.equal(api.stats().mode, 'unsupported');
    assert.equal(existing.inject, inject, 'the hook was left wrapped');
    assert.equal(existing.onCommitFiberRoot, onCommitFiberRoot, 'the hook was left wrapped');
    assert.equal('onPostCommitFiberRoot' in existing, false, 'the hook was left wrapped');
    api.dispose();
  });
});

test('a page that turns the shim off where it is before react-dom loads is unsupported, not told install() ran late', async (t) => {
  // React finds support off and registers with no hook, and renders all the same.
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  ownShim(t);
  await inBrowser((page) => {
    const app: Record<string, unknown> = {};
    Object.defineProperty(globalThis, 'document', { value: documentOf([{}, app]), configurable: true, writable: true });
    const api = install({ threshold: 40, devtoolsTrack: false });
    turnOff(page.window[HOOK]);
    app.__reactContainer$x1y2 = {};
    t.mock.timers.tick(3000);
    const stats = api.stats();
    assert.deepEqual({ mode: stats.mode, kind: stats.unsupportedReason?.kind, react: stats.react }, { mode: 'unsupported', kind: 'hook-disabled', react: 'unreadable' });
    page.paint([slowClick(120)]);
    assert.equal(api.last()?.reactStatus, 'unreadable');
    assert.doesNotMatch(api.last()?.explanation.notes.join('\n') ?? '', /install\(\) ran after react-dom loaded/);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /off after install\(\)/);
    api.dispose();
  });
});

test('a page that empties the global over the shim before react-dom loads is unsupported, not told install() ran late', async (t) => {
  // React finds no hook there, or one it cannot register with, and renders all the same.
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  ownShim(t);
  for (const empty of ['undefined', 'false', 'delete']) {
    session?.slots.warnings?.clear();
    warn.mock.resetCalls();
    await inBrowser((page) => {
      const app: Record<string, unknown> = {};
      Object.defineProperty(globalThis, 'document', { value: documentOf([{}, app]), configurable: true, writable: true });
      const api = install({ threshold: 40, devtoolsTrack: false });
      if (empty === 'delete') delete page.window[HOOK];
      else page.window[HOOK] = empty === 'false' ? false : undefined;
      app.__reactContainer$x1y2 = {};
      t.mock.timers.tick(3000);
      const stats = api.stats();
      assert.deepEqual({ mode: stats.mode, kind: stats.unsupportedReason?.kind, react: stats.react }, { mode: 'unsupported', kind: 'hook-disabled', react: 'unreadable' });
      page.paint([slowClick(120)]);
      assert.equal(api.last()?.reactStatus, 'unreadable');
      assert.doesNotMatch(api.last()?.explanation.notes.join('\n') ?? '', /install\(\) ran after react-dom loaded/);
      assert.equal(warn.mock.callCount(), 1);
      assert.match(warn.mock.calls[0].arguments[0], /emptied its __REACT_DEVTOOLS_GLOBAL_HOOK__ after install\(\)/);
      api.dispose();
    });
  }
  // A tool that deletes the global and then defines a hook of its own is still followed.
  await inBrowser((page) => {
    const api = install({ threshold: 40, devtoolsTrack: false });
    delete page.window[HOOK];
    page.window[HOOK] = existingHook();
    page.paint([slowClick(120)]);
    assert.equal(api.stats().mode, 'chained');
    api.dispose();
  });
  // Once react-dom has registered with the shim, React goes on calling it whatever the global holds. That counts as
  // a tool locked out, which lasts the page's life, so the tests after this one start without it.
  const hookState = (session?.slots as Record<string, { devtoolsLockedOut: boolean }>).hook!;
  t.after(() => {
    hookState.devtoolsLockedOut = false;
  });
  await inBrowser((page) => {
    const api = install({ threshold: 40, devtoolsTrack: false });
    page.window[HOOK].inject(reactDom('19.3.0'));
    delete page.window[HOOK];
    page.paint([slowClick(120)]);
    assert.deepEqual({ mode: api.stats().mode, react: api.stats().react }, { mode: 'shim', react: 'reading' });
    api.dispose();
  });
});

test("a tool that wraps the shim's methods after install() leaves it the hook in use, and its commits are read", async (t) => {
  // Fast Refresh's runtime does this when it loads after the library, so a method that is no longer the shim's
  // own does not mean the page turned it off.
  const warn = t.mock.method(console, 'warn', () => {});
  ownShim(t);
  await inBrowser((page) => {
    const api = install({ threshold: 40, devtoolsTrack: false });
    const hook = page.window[HOOK];
    for (const method of ['inject', 'onCommitFiberRoot']) {
      const own = hook[method];
      hook[method] = function (this: unknown, ...args: unknown[]) {
        return own.apply(this, args);
      };
    }
    const id = hook.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    hook.onCommitFiberRoot(id, root);
    page.duringClick(() => {
      commitAgain(root, 150);
      hook.onCommitFiberRoot(id, root, 1, false);
    });
    page.paint([slowClick(200)]);
    assert.deepEqual({ mode: api.stats().mode, react: api.stats().react }, { mode: 'shim', react: 'reading' });
    assert.equal(api.debug.commits().length, 1);
    assert.equal(warn.mock.callCount(), 0);
    api.dispose();
  });
});

test('a page that only sets isDisabled on the hook once react-dom has registered is still read, since React goes on calling it', async (t) => {
  // React reads isDisabled and supportsFiber only as a react-dom registers. A page that sets the first in its entry
  // module, after its imports, sets it after react-dom registered, and React's commits still come to the hook.
  const warn = t.mock.method(console, 'warn', () => {});
  const clock = useClock(t);
  ownShim(t);
  for (const existing of [null, existingHook()]) {
    session?.slots.warnings?.clear();
    warn.mock.resetCalls();
    await inBrowser(async (page) => {
      if (existing) page.window[HOOK] = existing;
      let api = install({ threshold: 40, devtoolsTrack: false });
      const hook = page.window[HOOK];
      const id = hook.inject(reactDom('19.3.0'));
      const root = mountedRoot(0b11, 4);
      hook.onCommitFiberRoot(id, root);
      hook.isDisabled = true;
      for (const at of [1000, 2000, 3000]) {
        // The last click comes after dispose() and another install(), which finds the same hook.
        if (at === 3000) {
          api.dispose();
          api = install({ threshold: 40, devtoolsTrack: false });
        }
        clock.now = at;
        page.fire('click', { isTrusted: true, type: 'click', timeStamp: at, target: null });
        page.duringClick(() => {
          clock.now = at + 150;
          commitAgain(root, 150);
          hook.onCommitFiberRoot(id, root, 1, false);
        });
        page.paint([click(at, at, 200)]);
        await nextTask();
        const stats = api.stats();
        assert.deepEqual({ mode: stats.mode, react: stats.react }, { mode: existing ? 'chained' : 'shim', react: 'reading' });
        assert.match(api.last()?.explanation.cause ?? '', /150 ms .*Counter/);
      }
      assert.equal(warn.mock.callCount(), 0);
      api.dispose();
    });
  }
});

test('a page that only sets isDisabled once react-dom has registered is still read where a tool wrapped some of the methods the library left', async (t) => {
  // Fast Refresh wraps inject and onCommitFiberRoot when it loads after the library, the usual order in development,
  // and passes React's calls on. The scripts that keep developer tools out make every method a no-op.
  const warn = t.mock.method(console, 'warn', () => {});
  const clock = useClock(t);
  ownShim(t);
  for (const wrapped of [['inject', 'onCommitFiberRoot'], ['onPostCommitFiberRoot']]) {
    // The chained hook is the one React DevTools installs, which has an onPostCommitFiberRoot of its own, or Fast
    // Refresh's stub, which has none, so dispose() takes the library's away.
    for (const existing of [null, { ...existingHook(), onPostCommitFiberRoot() {} }, existingHook()]) {
      session?.slots.warnings?.clear();
      warn.mock.resetCalls();
      await inBrowser(async (page) => {
        if (existing) page.window[HOOK] = existing;
        let api = install({ threshold: 40, devtoolsTrack: false });
        const hook = page.window[HOOK];
        for (const method of wrapped) {
          const own = hook[method];
          hook[method] = function (this: unknown, ...args: unknown[]) {
            return own.apply(this, args);
          };
        }
        const id = hook.inject(reactDom('19.3.0'));
        const root = mountedRoot(0b11, 4);
        hook.onCommitFiberRoot(id, root);
        hook.isDisabled = true;
        for (const at of [1000, 2000, 3000]) {
          // The last click comes after dispose() and another install(), which finds the same hook.
          if (at === 3000) {
            api.dispose();
            api = install({ threshold: 40, devtoolsTrack: false });
          }
          clock.now = at;
          page.fire('click', { isTrusted: true, type: 'click', timeStamp: at, target: null });
          page.duringClick(() => {
            clock.now = at + 150;
            commitAgain(root, 150);
            hook.onCommitFiberRoot(id, root, 1, false);
          });
          page.paint([click(at, at, 200)]);
          await nextTask();
          const stats = api.stats();
          assert.deepEqual({ mode: stats.mode, react: stats.react }, { mode: existing ? 'chained' : 'shim', react: 'reading' });
          assert.match(api.last()?.explanation.cause ?? '', /^React spent 150 ms .*Counter/);
        }
        assert.equal(warn.mock.callCount(), 0);
        api.dispose();
      });
    }
  }
});

test('a chained hook the page turns off between dispose() and another install() is unsupported from the start', async (t) => {
  // dispose() takes away the onPostCommitFiberRoot the library added to a hook that had none, so only the page's own
  // onCommitFiberRoot is left to tell a no-op in its place from the method React still calls.
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    existing.onCommitFiberRoot(id, mountedRoot(0b11, 4));
    api.dispose();
    turnOff(existing);
    const again = install({ devtoolsTrack: false });
    assert.deepEqual({ mode: again.stats().mode, kind: again.stats().unsupportedReason?.kind }, { mode: 'unsupported', kind: 'hook-disabled' });
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /off after react-dom registered with it/);
    again.dispose();
  });
});

test('a hook the page turns off right before dispose(), with no interaction between, is unsupported from the start of the next install()', async (t) => {
  // dispose() records what React calls on the hook from then on, but not the no-ops on a hook turned off since the
  // last look, or the next install() would read them as React rendering nothing.
  const warn = t.mock.method(console, 'warn', () => {});
  ownShim(t);
  for (const existing of [null, existingHook()]) {
    session?.slots.warnings?.clear();
    warn.mock.resetCalls();
    await inBrowser((page) => {
      if (existing) page.window[HOOK] = existing;
      const api = install({ devtoolsTrack: false });
      const hook = page.window[HOOK];
      const id = hook.inject(reactDom('19.3.0'));
      hook.onCommitFiberRoot(id, mountedRoot(0b11, 4));
      turnOff(hook);
      api.dispose();
      const again = install({ devtoolsTrack: false });
      assert.deepEqual({ mode: again.stats().mode, kind: again.stats().unsupportedReason?.kind }, { mode: 'unsupported', kind: 'hook-disabled' });
      assert.equal(warn.mock.callCount(), 1);
      assert.match(warn.mock.calls[0].arguments[0], /off after react-dom registered with it/);
      again.dispose();
    });
  }
});

test("hook: 'shim' over a frozen hook says only that it cannot be wrapped, not that it chained onto it", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    page.window[HOOK] = Object.freeze(existingHook());
    const api = install({ hook: 'shim', devtoolsTrack: false });
    assert.equal(api.stats().mode, 'unsupported');
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /cannot be wrapped/);
    api.dispose();
  });
});

test('stats() and debug.hook() only read: a tool that redefines the global over the shim is noticed at the next Event Timing batch', async () => {
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    // Redefined rather than assigned, which the shim's accessor cannot see.
    Object.defineProperty(page.window, HOOK, { value: existingHook(), configurable: true, writable: true });
    assert.equal(api.stats().mode, 'shim');
    assert.equal(api.debug.hook().owner, 'react-inp-blame');
    page.paint([slowClick(120)]);
    assert.equal(api.stats().mode, 'chained');
    api.dispose();
  });
});

test('a label names an element by its attributes under a production React, and by its text under a development React or when asked', async () => {
  const labelUnder = async (bundleType: number, labels?: InstallOptions['labels']) => {
    let label: string | null | undefined;
    await inBrowser((page) => {
      const existing = existingHook();
      page.window[HOOK] = existing;
      const api = install({ hook: 'chain', devtoolsTrack: false, labels });
      existing.inject(reactDom('19.3.0', bundleType));
      page.paint([{ ...slowClick(120), target: saveButton() }]);
      label = api.last()?.target?.label;
      api.dispose();
    });
    return label;
  };
  assert.equal(await labelUnder(0), 'button "save"');
  assert.equal(await labelUnder(1), 'button "Save for Ada Lovelace"');
  assert.equal(await labelUnder(0, 'text'), 'button "Save for Ada Lovelace"');
  assert.equal(await labelUnder(1, 'attributes'), 'button "save"');
});

test('the Performance panel entries are drawn under a development React, and under a production one only when asked, since every PerformanceObserver on the page reads them', async (t) => {
  const groups: unknown[] = [];
  t.mock.method(performance, 'measure', (_name: string, opts?: { detail?: { devtools?: { trackGroup?: string } } }) => {
    groups.push(opts?.detail?.devtools?.trackGroup);
  });
  // How many entries of the library's a slow click drew, with react-dom of `bundleType` registered after install(), or none.
  const drawnUnder = async (bundleType: number | null, devtoolsTrack?: InstallOptions['devtoolsTrack']) => {
    groups.length = 0;
    await inBrowser(async (page) => {
      const existing = existingHook();
      page.window[HOOK] = existing;
      const api = install({ hook: 'chain', devtoolsTrack });
      if (bundleType !== null) existing.inject(reactDom('19.3.0', bundleType));
      page.paint([slowClick(120)]);
      // Entries are drawn once the page is idle, which without requestIdleCallback is a task later.
      await nextTask();
      await nextTask();
      api.dispose();
    });
    return groups.filter((group) => group === 'react-inp-blame').length;
  };
  assert.equal(await drawnUnder(0), 0, 'a production react-dom drew entries by default');
  assert.equal(await drawnUnder(0, 'auto'), 0, "a production react-dom drew entries under 'auto'");
  assert.ok((await drawnUnder(1)) >= 1, 'a development react-dom drew nothing by default');
  assert.ok((await drawnUnder(0, true)) >= 1, 'a production react-dom drew nothing when asked to');
  assert.equal(await drawnUnder(1, false), 0, 'a development react-dom drew entries when told not to');
  assert.equal(await drawnUnder(null), 0, 'a page no react-dom registered on drew entries by default');
});

test('a key press in an editor inside a label is labelled at dispatch as the report would label it, like a form field', async () => {
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false, labels: 'text' });
    // <label>Comment <div contenteditable>...</div></label>: the key press lands on the editor, and the label is the control around it.
    const label: Record<string, unknown> = { nodeType: 1, tagName: 'LABEL', id: '', classList: { length: 0 }, parentNode: null, parentElement: null, getAttribute: () => null };
    const editor: Record<string, unknown> = {
      nodeType: 1, tagName: 'DIV', id: '', classList: { length: 0 }, parentNode: label, parentElement: label, nextSibling: null, isContentEditable: true,
      getAttribute: (name: string) => (name === 'contenteditable' ? 'true' : null),
    };
    editor.firstChild = { nodeType: 3, nodeValue: 'Hi Ada, the password is hunter2', parentNode: editor, nextSibling: null, firstChild: null };
    label.firstChild = { nodeType: 3, nodeValue: 'Comment ', parentNode: label, nextSibling: editor, firstChild: null };
    page.fire('keydown', { isTrusted: true, type: 'keydown', timeStamp: 1000, target: editor, code: 'KeyA' });
    page.paint([{ ...pointer('keydown', 7, 1000, 120), target: editor }]);
    assert.equal(api.last()?.target?.label, 'label');
    api.dispose();
  });
});

test('dispose() drops every listener, and the next install() takes its own options', async () => {
  await inBrowser(async (page) => {
    const heard: string[] = [];
    const first = install({ threshold: 40, devtoolsTrack: false });
    onInteraction(() => heard.push('a listener added before dispose'));
    first.dispose();
    assert.equal(page.listening.size, 0);

    const second = install({ threshold: 100, devtoolsTrack: false });
    onInteraction((r) => heard.push(`a listener added after it, ${r.duration} ms`));
    page.paint([slowClick(64)]);
    page.paint([{ ...slowClick(120), interactionId: 14 }]);
    await nextTask();
    assert.deepEqual(heard, ['a listener added after it, 120 ms'], "a 64 ms click was reported under the first install's 40 ms threshold");
    second.dispose();
  });
});

test('install() while installed returns the same API, and warns once about the options only the first call sets', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser(() => {
    const api = install({ devtoolsTrack: false });
    assert.equal(install({ devtoolsTrack: false }), api, 'the same value again is not a change');
    assert.equal(warn.mock.callCount(), 0);
    install({ threshold: 16, walkBudget: 10 });
    install({ threshold: 16 });
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /threshold, walkBudget kept the first call's value/);
    api.dispose();
  });
});

test("install({ devtoolsTrack: 'auto' }) after an install() that left it out asks for what is already set, so nothing is warned about", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser(() => {
    const api = install();
    install({ devtoolsTrack: 'auto' });
    assert.equal(warn.mock.callCount(), 0);
    api.dispose();
  });
});

test('sampleRate rolls once per page, and a page that loses gets nothing installed until dispose()', async (t) => {
  const roll = t.mock.method(Math, 'random', () => 0.5);
  await inBrowser((page) => {
    const out = install({ sampleRate: 0.4, debugGlobal: true });
    assert.equal(out.stats().mode, 'sampled-out');
    assert.equal(HOOK in page.window, false, 'the DevTools hook was created');
    assert.equal(page.listening.size, 0, 'input listeners were added');
    assert.equal(page.window.__REACT_INP_BLAME__, out);
    // Rolling again on a later call would raise the share of pages that install.
    assert.equal(install({ sampleRate: 1 }), out);
    assert.equal(roll.mock.callCount(), 1);

    out.dispose();
    assert.equal('__REACT_INP_BLAME__' in page.window, false);
    const won = install({ sampleRate: 0.6 });
    assert.equal(won.stats().mode, 'shim');
    won.dispose();
  });
});

/** REACT_INP_BLAME_NEXT as the tests found it, which each test that sets it puts back as it ends. */
const outsideNextClient = process.env.REACT_INP_BLAME_NEXT;

/**
 * next-client as Next.js bundles it: `process.env.REACT_INP_BLAME_NEXT` holds what withInpBlame put in
 * `env`, '' in a build the wrapper left out, or nothing where no wrapper set it. Each tag imports a copy
 * of its own. The value stays until the test ends, as in a bundle, where it never changes after import:
 * each gate in the module reads it again, onRouterTransitionStart's when it is called.
 */
async function nextClient(t: TestContext, tag: string, settings?: object | ''): Promise<typeof import('../src/next-client.ts')> {
  t.after(() => {
    if (outsideNextClient === undefined) delete process.env.REACT_INP_BLAME_NEXT;
    else process.env.REACT_INP_BLAME_NEXT = outsideNextClient;
  });
  if (settings === undefined) delete process.env.REACT_INP_BLAME_NEXT;
  else process.env.REACT_INP_BLAME_NEXT = settings === '' ? '' : JSON.stringify(settings);
  return await import(`../src/next-client.ts?${tag}`);
}

test('a click that starts an App Router navigation is named with it, and the reports after it carry the new URL', async (t) => {
  // Imported outside the stand-in browser, so its own install() finds no window and does nothing.
  const { onRouterTransitionStart } = await nextClient(t, 'wrapped', { install: {}, basePath: '' });
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    // Next.js calls the injected module's hook from inside the click handler that starts the navigation.
    const clickedAt = page.duringClick(() => onRouterTransitionStart('/cart', 'push', null));
    page.paint([click(7, clickedAt, 64)]);
    assert.deepEqual(placeOf(api.last()), { navigationURL: PAGE_URL, navigationType: 'navigate', startedNavigation: { url: 'https://shop.example/cart', type: 'push' } });

    // Back to the products page, announced with the event Next.js passes under its experimental flag,
    // whose timestamp is on the Unix epoch. A click that began before it still happened on the cart.
    const back = clickedAt + 2000;
    onRouterTransitionStart(PAGE_URL, 'traverse', { timestamp: performance.timeOrigin + back });
    page.paint([click(14, back - 100, 64)]);
    assert.equal(api.last()?.navigationURL, 'https://shop.example/cart');
    page.paint([click(21, back + 100, 64)]);
    assert.deepEqual(placeOf(api.last()), { navigationURL: PAGE_URL, navigationType: 'soft-navigation', startedNavigation: null });
    api.dispose();
  });
});

test('next-client installs nothing and names no navigation where no withInpBlame set its value, as an older one did in a build it left out', async (t) => {
  await inBrowser(async (page) => {
    const { onRouterTransitionStart } = await nextClient(t, 'unset');
    assert.equal(Observer.live.size, 0);
    // The same module in a build the wrapper covers installs as it is imported. Its value, set from here
    // on, does not wake the copy imported without one.
    await nextClient(t, 'covered', { install: { devtoolsTrack: false }, basePath: '' });
    assert.ok(Observer.live.size > 0);
    const api = install({ devtoolsTrack: false });
    const clickedAt = page.duringClick(() => onRouterTransitionStart('/cart', 'push', null));
    page.paint([click(7, clickedAt, 64)]);
    assert.deepEqual(placeOf(api.last()), { navigationURL: PAGE_URL, navigationType: 'navigate', startedNavigation: null });
    api.dispose();
  });
});

test("next-client installs nothing and names no navigation in a build withInpBlame left out, whose value is '', where the line in instrumentation-client still brings it", async (t) => {
  await inBrowser(async (page) => {
    const { onRouterTransitionStart } = await nextClient(t, 'left-out', '');
    assert.equal(Observer.live.size, 0);
    const api = install({ devtoolsTrack: false });
    const clickedAt = page.duringClick(() => onRouterTransitionStart('/cart', 'push', null));
    page.paint([click(7, clickedAt, 64)]);
    assert.deepEqual(placeOf(api.last()), { navigationURL: PAGE_URL, navigationType: 'navigate', startedNavigation: null });
    api.dispose();
  });
});

test('announceNavigation inside a click names it on that click, starts INP over, and places the reports after it at the new URL', async (t) => {
  const clock = useClock(t);
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    clock.now = 1000;
    page.paint([slowClick(120)]);
    assert.equal(api.inp()?.interactionId, 7);

    // A router that pushes from inside the click handler, as TanStack Router does for a Link click.
    clock.now = 2000;
    const clickedAt = page.duringClick(() => {
      clock.now = 2004;
      announceNavigation('/cart');
    });
    assert.equal(api.inp(), null);
    page.paint([click(14, clickedAt, 64)]);
    assert.deepEqual(placeOf(api.last()), { navigationURL: PAGE_URL, navigationType: 'navigate', startedNavigation: { url: 'https://shop.example/cart', type: 'push' } });

    clock.now = 3000;
    page.paint([click(21, 3000, 64)]);
    assert.deepEqual(placeOf(api.last()), { navigationURL: 'https://shop.example/cart', navigationType: 'soft-navigation', startedNavigation: null });
    assert.equal(api.inp()?.interactionId, 21);
    api.dispose();
  });
});

test('announceNavigation from an effect, with no input being dispatched, names no click and places the reports after it at the new URL', async (t) => {
  const clock = useClock(t);
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    // React Router renders the new route in a transition, so the call comes after the click that started it.
    clock.now = 1500;
    announceNavigation('https://shop.example/cart');
    page.paint([click(7, 1000, 64)]);
    assert.deepEqual(placeOf(api.last()), { navigationURL: PAGE_URL, navigationType: 'navigate', startedNavigation: null });
    clock.now = 2000;
    page.paint([click(14, 2000, 64)]);
    assert.deepEqual(placeOf(api.last()), { navigationURL: 'https://shop.example/cart', navigationType: 'soft-navigation', startedNavigation: null });
    api.dispose();
  });
});

test('announceNavigation resolves a relative URL against the page, takes a URL object, and records a push', async (t) => {
  const clock = useClock(t);
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    clock.now = 1000;
    announceNavigation('?page=2');
    clock.now = 2000;
    page.paint([click(7, 2000, 64)]);
    assert.equal(api.last()?.navigationURL, 'https://shop.example/products?page=2');

    clock.now = 3000;
    const clickedAt = page.duringClick(() => announceNavigation(new URL('https://shop.example/cart')));
    page.paint([click(14, clickedAt, 64)]);
    assert.deepEqual(api.last()?.startedNavigation, { url: 'https://shop.example/cart', type: 'push' });
    api.dispose();
  });
});

test('announceNavigation does nothing and does not throw before install(), after dispose(), or for a URL that does not parse', async () => {
  await inBrowser((page) => {
    assert.doesNotThrow(() => announceNavigation('/cart'));
    const api = install({ devtoolsTrack: false });
    assert.doesNotThrow(() => announceNavigation('http://['));
    page.paint([click(7, performance.now() + 10, 64)]);
    assert.deepEqual(placeOf(api.last()), { navigationURL: PAGE_URL, navigationType: 'navigate', startedNavigation: null });
    api.dispose();
    assert.doesNotThrow(() => announceNavigation('/cart'));
  });
});

test('announceNavigation from another copy of the module reaches the installation', async (t) => {
  const clock = useClock(t);
  const tag = 'copy';
  const copy: typeof import('../src/navigation.ts') = await import(`../src/navigation.ts?${tag}`);
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    clock.now = 1000;
    copy.announceNavigation('/cart');
    clock.now = 2000;
    page.paint([click(7, 2000, 64)]);
    assert.deepEqual(placeOf(api.last()), { navigationURL: 'https://shop.example/cart', navigationType: 'soft-navigation', startedNavigation: null });
    api.dispose();
  });
});

test('a page restored from the back/forward cache starts its INP over, and its reports say how it came back', async () => {
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    page.paint([slowClick(120)]);
    assert.equal(api.inp()?.interactionId, 7);

    page.fire('pageshow', { persisted: true, timeStamp: 5000 });
    assert.equal(api.inp(), null);
    page.paint([click(14, 6000, 64)]);
    assert.deepEqual(placeOf(api.last()), { navigationURL: PAGE_URL, navigationType: 'back-forward-cache', startedNavigation: null });
    assert.equal(api.inp()?.interactionId, 14);

    // The pageshow of an ordinary load restores nothing.
    page.fire('pageshow', { persisted: false, timeStamp: 7000 });
    assert.equal(api.inp()?.interactionId, 14);
    api.dispose();
  });
});

test('a slow click whose entry is still queued when the page is hidden has its report by the time web-vitals reports INP', async () => {
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    // Hidden before the browser ran the observers' callbacks: web-vitals takes its own observer's entries
    // in its hide handler, which runs after this one, and reports the click as INP.
    page.queue([click(7, 1000, 300)]);
    page.hide();
    assert.deepEqual(
      api.reports().map((r) => r.interactionId),
      [7],
    );
    assert.equal(api.inp()?.interactionId, 7);
    assert.equal(attributeINP({ entries: [{ interactionId: 7 }] }).react?.interactionId, 7);

    // The taken entry is never delivered again, and the same entry delivered again adds nothing.
    page.paint([click(7, 1000, 300)]);
    assert.equal(api.reports().length, 1);
    assert.equal(api.last()?.revision, 0);
    api.dispose();
  });
});

test('a long animation frame still queued when the page is hidden is taken before the entries, so the report built then already holds it', async () => {
  await inBrowser(
    (page) => {
      const api = install({ devtoolsTrack: false });
      const frame = { entryType: 'long-animation-frame', startTime: 1010, duration: 280, blockingDuration: 230, styleAndLayoutStart: 1270, scripts: [] };
      page.queue([click(7, 1000, 300), frame]);
      page.hide();
      const r = api.last();
      assert.equal(r?.interactionId, 7);
      assert.deepEqual(
        r?.frames?.map((f) => f.start),
        [1010],
      );
      assert.equal(r?.revision, 0, 'the report was built without its frame and revised at once');
      api.dispose();
    },
    { entryTypes: ['event', 'first-input', 'long-animation-frame'] },
  );
});

test("the blame attributeINP hands to analytics names a script by its URL without the query, so a reset link's token never goes with it", async () => {
  await inBrowser(
    (page) => {
      const api = install({ devtoolsTrack: false });
      // A click that waited 300 ms behind the reset page's inline script, which the browser names by the page's URL.
      const url = 'https://shop.example/reset-password?token=s3cr3t-reset-token&email=ada%40example.com';
      const inline = { invoker: url, sourceFunctionName: '', sourceURL: url, startTime: 1000, duration: 300, forcedStyleAndLayoutDuration: 0 };
      const frame = { entryType: 'long-animation-frame', startTime: 1000, duration: 352, blockingDuration: 302, styleAndLayoutStart: 1350, scripts: [inline] };
      page.queue([{ ...click(7, 1000, 352), processingStart: 1300, processingEnd: 1350 }, frame]);
      page.hide();
      const { react } = attributeINP({ entries: [{ interactionId: 7 }] });
      assert.deepEqual(react?.blame, { kind: 'waiting', name: 'https://shop.example/reset-password', detail: null, ms: 300, confidence: 'measured' });
      assert.equal(JSON.stringify(react).includes('s3cr3t'), false);
      assert.equal(JSON.stringify(api.reports()).includes('s3cr3t'), false);
      api.dispose();
    },
    { entryTypes: ['event', 'first-input', 'long-animation-frame'] },
  );
});

/** A long animation frame of 280 ms from `startTime`, holding `scripts`. */
function longFrame(startTime: number, scripts: unknown[]) {
  return { entryType: 'long-animation-frame', startTime, duration: 280, blockingDuration: 230, styleAndLayoutStart: startTime + 260, scripts };
}

/** The warnings that say the library caught an error of its own. */
function caught(warn: { mock: { calls: { arguments: unknown[] }[] } }): unknown[] {
  return warn.mock.calls.map((call) => call.arguments[0]).filter((message) => /#library-error$/.test(String(message)));
}

test('a long animation frame the library cannot read never reaches the page, and the frames delivered with it and after it still join their reports', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser(
    (page) => {
      const api = install({ devtoolsTrack: false });
      try {
        page.queue([click(7, 1000, 300)]);
        page.paint([]);
        // One whose list of scripts holds a null, handed over in one list with a frame that can be read.
        page.queue([longFrame(1010, [null]), longFrame(1010, [])]);
        assert.doesNotThrow(() => page.paint([]));
        page.queue([longFrame(1100, [])]);
        page.paint([]);
        assert.deepEqual(
          api.last()?.frames?.map((f) => f.start),
          [1010, 1100],
        );
        assert.equal(caught(warn).length, 1);
      } finally {
        api.dispose();
      }
    },
    { entryTypes: ['event', 'first-input', 'long-animation-frame'] },
  );
});

test('a frame the library cannot read, still queued when the page is hidden, keeps neither the frame and the click queued with it from their report nor the reports waiting from being heard', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser(
    (page) => {
      const api = install({ devtoolsTrack: false });
      try {
        const heard: number[] = [];
        onInteraction((r) => heard.push(r.interactionId));
        page.queue([click(7, 1000, 300)]);
        page.paint([]);
        page.queue([longFrame(2010, [null]), longFrame(2010, []), click(14, 2000, 300)]);
        assert.doesNotThrow(() => page.hide());
        assert.deepEqual(
          api.reports().map((r) => ({ id: r.interactionId, frames: r.frames?.map((f) => f.start) })),
          [
            { id: 7, frames: [] },
            { id: 14, frames: [2010] },
          ],
        );
        assert.deepEqual(heard, [7, 14]);
        assert.equal(caught(warn).length, 1);
      } finally {
        api.dispose();
      }
    },
    { entryTypes: ['event', 'first-input', 'long-animation-frame'] },
  );
});

test("an error of the library's own at the hide never keeps the reports waiting from being heard, since a closing tab runs no later task", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    try {
      const heard: number[] = [];
      onInteraction((r) => heard.push(r.interactionId));
      page.paint([click(7, 1000, 300)]);
      // The clock throws the first time the hide reads it, before the INP estimate is chosen again.
      t.mock.method(performance, 'now').mock.mockImplementationOnce(() => {
        throw new TypeError('clock moved');
      });
      assert.doesNotThrow(() => page.hide());
      assert.deepEqual(heard, [7]);
      assert.equal(caught(warn).length, 1);
    } finally {
      api.dispose();
    }
  });
});

test('listeners hear a report in a task after the one that published it, never inside the React commit that revised it', async (t) => {
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    clock.now = 1000;
    page.duringClick(() => existing.onCommitFiberRoot(id, root));
    const heard: number[] = [];
    onInteraction((r) => heard.push(r.revision));

    page.paint([click(7, 1000, 120)]);
    assert.deepEqual(heard, [], 'the listener heard the report inside the Event Timing callback');
    await nextTask();
    assert.deepEqual(heard, [0]);

    // Data arrives after the paint and React renders it: a later render, which revises the report inside React's commit.
    clock.now = 1300;
    commitAgain(root, 40);
    existing.onCommitFiberRoot(id, root);
    assert.equal(api.last()?.revision, 1);
    assert.deepEqual(heard, [0], "the listener heard the revision inside React's commit");
    await nextTask();
    assert.deepEqual(heard, [0, 1]);
    api.dispose();
  });
});

test('reports waiting to be heard when the page is hidden are heard before its visibilitychange handler returns, since a closing tab runs no later task', async () => {
  await inBrowser(async (page) => {
    const api = install({ devtoolsTrack: false });
    const heard: number[] = [];
    onInteraction((r) => heard.push(r.interactionId));
    // One published before the hide in the same task, and one from an entry the hide takes.
    page.paint([click(7, 1000, 300)]);
    page.queue([click(14, 2000, 200)]);
    page.hide();
    assert.deepEqual(heard, [7, 14]);
    await nextTask();
    await nextTask();
    assert.deepEqual(heard, [7, 14], 'a report was heard twice');
    api.dispose();
  });
});

/**
 * A pointerdown at 1000 that paints after 32 ms, quiet at a threshold of 40, then its pointerup at 1060,
 * whose render commits at 1080 in a task of its own, and the page hidden with `queued` still waiting for
 * the observers. Returns what was published at the hide, what a listener had heard when the hide's handler
 * returned, and what it had heard two tasks later.
 */
async function heldPressThenHide(t: TestContext, queued: any[]) {
  const clock = useClock(t);
  let result = { published: [] as number[], heardAtHide: [] as number[], heardLater: [] as number[] };
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500, threshold: 40, devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    const heard: number[] = [];
    onInteraction((r) => heard.push(r.interactionId));
    clock.now = 1000;
    page.fire('pointerdown', { isTrusted: true, type: 'pointerdown', timeStamp: 1000, target: null, pointerId: 1 });
    page.paint([pointer('pointerdown', 7, 1000, 32)]);
    await nextTask();
    clock.now = 1060;
    page.fire('pointerup', { isTrusted: true, type: 'pointerup', timeStamp: 1060, target: null, pointerId: 1 });
    await nextTask();
    clock.now = 1080;
    commitAgain(root, 20);
    existing.onCommitFiberRoot(id, root, 3, false);
    assert.deepEqual(
      api.debug.commits().map((c) => [c.inputType, c.inDispatch]),
      [['pointerup', false]],
    );
    page.queue(queued);
    page.hide();
    const published = api.reports().map((r) => r.interactionId);
    const heardAtHide = [...heard];
    await nextTask();
    await nextTask();
    result = { published, heardAtHide, heardLater: [...heard] };
    api.dispose();
  });
  return result;
}

test("a quiet held press stays quiet at hide when its release's entries, still queued then, hold the release's render", async (t) => {
  // The hide takes the release's entries before it settles the press, so they time the render at 1080 and
  // it is not read as a later render INP left out.
  assert.deepEqual(await heldPressThenHide(t, [pointer('pointerup', 7, 1060, 24), pointer('click', 7, 1060, 24)]), { published: [], heardAtHide: [], heardLater: [] });
});

test('a quiet report the hide itself publishes is heard before its visibilitychange handler returns, and only once', async (t) => {
  // The release painted under 16 ms and sent no entry, so the hide publishes the press with the render it waited on.
  assert.deepEqual(await heldPressThenHide(t, []), { published: [7], heardAtHide: [7], heardLater: [7] });
});

test("a listener that throws does not stop the others hearing the report, and its error reaches the page's error handlers", async (t) => {
  const reported: unknown[] = [];
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'reportError');
  Object.defineProperty(globalThis, 'reportError', { value: (error: unknown) => reported.push(error), configurable: true, writable: true });
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'reportError', saved);
    else delete (globalThis as any).reportError;
  });
  const warned = t.mock.method(console, 'warn', () => {});
  const logged = t.mock.method(console, 'error', () => {});
  await inBrowser(async (page) => {
    const api = install({ devtoolsTrack: false });
    // An analytics forwarder that reads a field of a target the report does not have.
    const thrown: unknown[] = [];
    onInteraction(() => {
      const error = new TypeError("Cannot read properties of null (reading 'label')");
      thrown.push(error);
      throw error;
    });
    const heard: number[] = [];
    onInteraction((r) => heard.push(r.interactionId));

    page.paint([click(7, 1000, 120)]);
    await nextTask();
    page.paint([click(14, 2000, 200)]);
    await nextTask();
    assert.deepEqual(heard, [7, 14]);
    assert.equal(reported.length, 2);
    assert.ok(reported.every((error, i) => error === thrown[i]), 'reportError was not handed what the listener threw');
    assert.equal(warned.mock.callCount(), 0);
    assert.equal(logged.mock.callCount(), 0);
    api.dispose();
  });
});

test('where there is no reportError, the error a listener throws is thrown again from a task of its own', async (t) => {
  assert.equal(typeof (globalThis as any).reportError, 'undefined');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    const error = new TypeError("Cannot read properties of null (reading 'label')");
    const heard: number[] = [];
    onInteraction(() => {
      throw error;
    });
    onInteraction((r) => heard.push(r.interactionId));
    page.paint([click(7, 1000, 120)]);
    assert.throws(() => t.mock.timers.runAll(), (thrown) => thrown === error);
    assert.deepEqual(heard, [7]);
    api.dispose();
  });
});

/**
 * A form with a field named `tagName`. A form's fields shadow its own properties, so its `tagName` is that
 * field, and reading the form as an element throws inside the library.
 */
function formWithFieldNamedTagName() {
  const form: Record<string, unknown> = { nodeType: 1, id: '', classList: { length: 0 }, parentNode: null, parentElement: null, firstChild: null, getAttribute: () => null };
  form.tagName = { nodeType: 1, tagName: 'INPUT', name: 'tagName', form };
  return form;
}

test("an error while a report is built never reaches the page's error handlers: that report is dropped, the console says so once, and the others still come", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    try {
      const onForm = (interactionId: number, startTime: number) => ({ ...click(interactionId, startTime, 120), target: formWithFieldNamedTagName() });
      // A click on the form's padding, and a key pressed in the same frame, handed over in one batch.
      assert.doesNotThrow(() => page.paint([onForm(7, 1000), pointer('keydown', 14, 1010, 110)]));
      page.paint([click(21, 2000, 200)]);
      assert.doesNotThrow(() => page.paint([onForm(28, 3000)]));
      assert.deepEqual(
        api.reports().map((r) => r.interactionId),
        [14, 21],
      );
      assert.equal(warn.mock.callCount(), 1);
      const [message, error] = warn.mock.calls[0]?.arguments ?? [];
      assert.match(
        String(message),
        /^\[react-inp-blame\] an error inside the library \(TypeError: .+\) was kept from the page\. Only the step it threw in was skipped, so a report may be missing or blame nothing, and later interactions are reported as usual\. Please open an issue with this message and the error logged with it\. See https:\/\/github\.com\/adityareddy-dev\/react-inp-blame#library-error$/,
      );
      // The error itself is logged with it, so the console shows where it was thrown.
      assert.ok(error instanceof TypeError);
      assert.ok(String(message).includes(`(${String(error)})`));
    } finally {
      api.dispose();
    }
  });
});

test('an error with no string form, such as a bare object, is still kept from the page, and the warning says it cannot be printed', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    try {
      // An input whose every property throws an object with no prototype, which has no string form.
      const input = new Proxy(
        {},
        {
          get() {
            throw Object.create(null);
          },
        },
      );
      assert.doesNotThrow(() => page.fire('pointerdown', input));
      assert.match(String(caught(warn)[0]), /an error inside the library \(a value that cannot be printed\) was kept from the page/);
      page.paint([click(7, 2000, 120)]);
      assert.equal(api.last()?.interactionId, 7);
    } finally {
      api.dispose();
    }
  });
});

test("an interaction whose report was dropped after an error of the library's own still counts toward INP, and the INP estimate and attributeINP point at it with no report", async (t) => {
  t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    try {
      page.paint([{ ...click(7, 1000, 300), target: formWithFieldNamedTagName() }]);
      assert.deepEqual(api.reports(), []);
      assert.deepEqual({ id: api.inp()?.interactionId, report: api.inp()?.report }, { id: 7, report: null });
      assert.deepEqual(attributeINP({ entries: [{ interactionId: 7 }] }), { react: null });
    } finally {
      api.dispose();
    }
  });
});

test("an error while a report's explanation is built, on its first read, never reaches the page's error handlers: the report blames nothing and says why, the console says so once, and the next report is explained", async (t) => {
  const reported: unknown[] = [];
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'reportError');
  Object.defineProperty(globalThis, 'reportError', { value: (error: unknown) => reported.push(error), configurable: true, writable: true });
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'reportError', saved);
    else delete (globalThis as any).reportError;
  });
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    try {
      // An analytics forwarder, which reads every field of a report, the explanation and the verdict with them.
      const sent: InteractionReport[] = [];
      onInteraction((r) => sent.push(JSON.parse(JSON.stringify(r))));
      page.paint([{ ...click(7, 1000, 120), target: saveButton() }]);
      // The report is built, and its explanation is not until it is read. There the first number it rounds throws.
      t.mock.method(Math, 'round').mock.mockImplementationOnce(() => {
        throw new TypeError('rounding moved');
      });
      assert.doesNotThrow(() => t.mock.timers.tick(0));
      assert.deepEqual(reported, []);
      assert.equal(caught(warn).length, 1);
      const cause = 'Where the time went is unknown: this library hit an error of its own while it worked that out for this click, so nothing is blamed. See the library-error warning in the console.';
      // Where it happened is still said, so the issue the warning asks for can name the control.
      assert.deepEqual(
        sent.map((r) => ({ id: r.interactionId, blame: r.explanation.blame, where: r.explanation.where, cause: r.explanation.cause, phases: r.explanation.phases.map((p) => p.ms), verdict: r.verdict })),
        [{ id: 7, blame: { kind: 'none', name: null, detail: null, ms: null, confidence: 'inferred' }, where: 'button "save"', cause, phases: [2, 110, 8], verdict: `120 ms click on button "save". ${cause}` }],
      );
      // Read again, it is the same, and the console is not told twice.
      assert.equal(api.last()?.verdict, `120 ms click on button "save". ${cause}`);
      // Its 'none' is the library's error, not a finding, so analytics are not handed it as one.
      assert.deepEqual(attributeINP({ entries: [{ interactionId: 7 }] }), { react: null });
      page.paint([click(14, 2000, 150)]);
      t.mock.timers.tick(0);
      assert.equal(sent.length, 2);
      assert.notEqual(sent[1]?.explanation.cause, cause);
      assert.match(String(sent[1]?.verdict), /^150 ms click\. /);
      assert.equal(attributeINP({ entries: [{ interactionId: 14 }] }).react?.interactionId, 14);
      assert.deepEqual(reported, []);
      assert.equal(caught(warn).length, 1);
    } finally {
      api.dispose();
    }
  });
});

test('attributeINP gives react null for a report whose explanation throws when attributeINP is the first to read it', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    try {
      page.paint([click(7, 1000, 300)]);
      t.mock.method(Math, 'round').mock.mockImplementationOnce(() => {
        throw new TypeError('rounding moved');
      });
      assert.deepEqual(attributeINP({ entries: [{ interactionId: 7 }] }), { react: null });
      assert.equal(caught(warn).length, 1);
      assert.equal(api.last()?.explanation.blame.kind, 'none');
    } finally {
      api.dispose();
    }
  });
});

test('an input the library cannot read the target of is still recorded, so a render in its handler is read as its own and the reports after it keep their components', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    try {
      const id = existing.inject(reactDom('19.3.0'));
      const root = mountedRoot(0b11, 4);
      existing.onCommitFiberRoot(id, root);
      // A key typed in one of the form's fields, then a click on its submit button whose handler renders. Looking
      // up from either for an icon they are part of reads the form's `tagName`.
      const form = formWithFieldNamedTagName();
      const field = { nodeType: 1, tagName: 'INPUT', id: '', classList: { length: 0 }, parentNode: form, parentElement: form, firstChild: null, getAttribute: () => null };
      clock.now = 1000;
      assert.doesNotThrow(() => page.fire('keydown', { isTrusted: true, type: 'keydown', timeStamp: 1000, target: field, code: 'KeyA' }));
      await nextTask();
      const submit = { ...saveButton(), parentNode: form, parentElement: form };
      for (const [interactionId, at, target] of [
        [14, 2000, submit],
        [21, 3000, saveButton()],
      ] as const) {
        clock.now = at;
        page.window.event = { isTrusted: true, type: 'click', timeStamp: at, target };
        commitAgain(root, 4);
        assert.doesNotThrow(() => existing.onCommitFiberRoot(id, root));
        delete page.window.event;
        page.paint([{ ...click(interactionId, at, 120), target }]);
        await nextTask();
      }
      assert.equal(api.stats().mode, 'chained');
      assert.deepEqual(
        api.reports().map((r) => ({ id: r.interactionId, commits: r.commits.length })),
        [
          { id: 14, commits: 1 },
          { id: 21, commits: 1 },
        ],
      );
      assert.equal(warn.mock.callCount(), 1);
      assert.equal(caught(warn).length, 1);
    } finally {
      delete page.window.event;
      api.dispose();
    }
  });
});

test("an error while a later render revises a report inside React's commit is not the walk's, so that react-dom's commits after it are still read", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    try {
      const id = existing.inject(reactDom('19.3.0'));
      const root = mountedRoot(0b11, 4);
      const heard: string[] = [];
      onInteraction((r) => heard.push(`${r.interactionId}.${r.revision}`));
      clock.now = 1000;
      page.duringClick(() => existing.onCommitFiberRoot(id, root));
      page.paint([click(7, 1000, 120)]);
      await nextTask();
      // Data arrives after the paint and React renders it: a later render, which revises the report inside
      // React's commit. Queueing the revision for its listeners throws there, where the timer is refused.
      clock.now = 1300;
      commitAgain(root, 40);
      const refused = t.mock.method(globalThis, 'setTimeout', () => {
        throw new TypeError('timer refused');
      });
      try {
        assert.doesNotThrow(() => existing.onCommitFiberRoot(id, root));
      } finally {
        refused.mock.restore();
      }
      assert.equal(api.stats().mode, 'chained');
      assert.equal(caught(warn).length, 1);
      assert.equal(warn.mock.callCount(), 1);
      await nextTask();
      assert.deepEqual(heard, ['7.0']);
      // The next click's handler renders, and its report has that commit. The revision was kept, and is
      // heard with it.
      clock.now = 2000;
      commitAgain(root, 4);
      page.duringClick(() => existing.onCommitFiberRoot(id, root));
      page.paint([click(14, 2000, 120)]);
      assert.deepEqual({ id: api.last()?.interactionId, commits: api.last()?.commits.length, react: api.last()?.reactStatus }, { id: 14, commits: 1, react: 'reading' });
      await nextTask();
      assert.deepEqual(heard, ['7.0', '7.1', '14.0']);
    } finally {
      api.dispose();
    }
  });
});

test("a DevTools hook the library cannot chain onto, such as a frozen one, leaves the page 'unsupported' with the reason, whether install() finds it, it is assigned over the shim, or the check 3 s after install, an Event Timing batch or the hide finds it", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const finds of ['install', 'assignment', 'check', 'batch', 'hide']) {
    await inBrowser((page) => {
      // React has rendered, which the check 3 s after install would take for install() running late.
      Object.defineProperty(globalThis, 'document', { value: documentOf([{}, { __reactFiber$x1y2: {} }]), configurable: true, writable: true });
      // A script that locks the page down puts a frozen hook there before React loads: before install(), or
      // after it, assigned, which the shim's accessor hears at once, or redefined, which it cannot see.
      const frozen = Object.freeze(existingHook());
      if (finds === 'install') page.window[HOOK] = frozen;
      const api = install({ devtoolsTrack: false });
      try {
        const heard: number[] = [];
        onInteraction((r) => heard.push(r.interactionId));
        page.paint([click(7, 1000, 120)]);
        if (finds === 'assignment') {
          assert.doesNotThrow(() => {
            page.window[HOOK] = frozen;
          });
        } else if (finds !== 'install') {
          Object.defineProperty(page.window, HOOK, { value: frozen, configurable: true, writable: true });
        }
        if (finds === 'check') t.mock.timers.tick(3000);
        if (finds === 'batch') page.paint([click(14, 2000, 200)]);
        if (finds === 'hide') {
          page.queue([click(14, 2000, 200)]);
          page.hide();
          assert.deepEqual(heard, [7, 14], 'the report waiting was not heard at the hide');
        }
        // React registers with the frozen hook, and reports to it alone.
        frozen.inject(reactDom('19.3.0'));
        t.mock.timers.tick(3000);
        assert.deepEqual({ mode: api.stats().mode, kind: api.stats().unsupportedReason?.kind }, { mode: 'unsupported', kind: 'hook-disabled' }, finds);
        assert.equal(warn.mock.callCount(), 1, finds);
        assert.match(
          String(warn.mock.calls[0]?.arguments[0]),
          /^\[react-inp-blame\] the page's __REACT_DEVTOOLS_GLOBAL_HOOK__ is frozen, or has a method that cannot be assigned or added, so it cannot be wrapped and React's commits cannot be read\. Interactions are still reported, without components\. See https:\/\/github\.com\/adityareddy-dev\/react-inp-blame#hook-locked$/,
          finds,
        );
        // The library uses no hook then, not the shim the frozen one replaced.
        assert.equal(api.debug.hook().owner, 'none', finds);
        page.paint([click(21, 3000, 200)]);
        assert.deepEqual({ id: api.last()?.interactionId, react: api.last()?.reactStatus }, { id: 21, react: 'unreadable' }, finds);
      } finally {
        api.dispose();
      }
    });
    session?.slots.warnings?.clear();
    warn.mock.resetCalls();
  }
});

test('a sealed DevTools hook without a post-commit call, which the library cannot add one to, is left as it was', async (t) => {
  t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    // Its methods can be replaced, but nothing can be added to it.
    const sealed = Object.seal(existingHook());
    const { inject, onCommitFiberRoot } = sealed;
    page.window[HOOK] = sealed;
    const api = install({ devtoolsTrack: false });
    try {
      assert.equal(api.stats().unsupportedReason?.kind, 'hook-disabled');
      assert.equal(sealed.inject, inject);
      assert.equal(sealed.onCommitFiberRoot, onCommitFiberRoot);
    } finally {
      api.dispose();
    }
  });
});

test('a DevTools hook whose inject cannot be replaced, though its other calls can, is left as it was rather than partly wrapped', async (t) => {
  t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const hook = existingHook();
    Object.defineProperty(hook, 'inject', { value: hook.inject, writable: false });
    const { onCommitFiberRoot } = hook;
    page.window[HOOK] = hook;
    const api = install({ devtoolsTrack: false });
    try {
      assert.equal(api.stats().unsupportedReason?.kind, 'hook-disabled');
      assert.equal(hook.onCommitFiberRoot, onCommitFiberRoot);
      assert.equal('onPostCommitFiberRoot' in hook, false);
    } finally {
      api.dispose();
    }
  });
});

test('a DevTools hook whose renderers cannot be read once its calls are wrapped is put back as it was, as its warning says', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const hook = existingHook();
    Object.defineProperty(hook, 'renderers', {
      get() {
        throw new TypeError('renderers moved');
      },
    });
    const { inject, onCommitFiberRoot } = hook;
    page.window[HOOK] = hook;
    const api = install({ devtoolsTrack: false });
    try {
      assert.deepEqual({ mode: api.stats().mode, kind: api.stats().unsupportedReason?.kind }, { mode: 'unsupported', kind: 'hook-disabled' });
      assert.match(String(warn.mock.calls[0]?.arguments[0]), /__REACT_DEVTOOLS_GLOBAL_HOOK__ is frozen, or has a method that cannot be assigned or added, so it cannot be wrapped/);
      assert.equal(hook.inject, inject);
      assert.equal(hook.onCommitFiberRoot, onCommitFiberRoot);
      assert.equal('onPostCommitFiberRoot' in hook, false);
    } finally {
      api.dispose();
    }
  });
});

test('a DevTools hook that refuses a call by throwing a value with no string form is still reported as one that cannot be chained onto, and install() does not throw', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const hook = existingHook();
    // Its post-commit call is guarded by a setter that throws an object with no prototype.
    Object.defineProperty(hook, 'onPostCommitFiberRoot', {
      get: () => undefined,
      set() {
        throw Object.create(null);
      },
    });
    const { inject, onCommitFiberRoot } = hook;
    page.window[HOOK] = hook;
    const api = install({ devtoolsTrack: false });
    try {
      assert.deepEqual({ mode: api.stats().mode, kind: api.stats().unsupportedReason?.kind }, { mode: 'unsupported', kind: 'hook-disabled' });
      assert.match(String(warn.mock.calls[0]?.arguments[0]), /__REACT_DEVTOOLS_GLOBAL_HOOK__ is frozen, or has a method that cannot be assigned or added, so it cannot be wrapped/);
      assert.equal(hook.inject, inject);
      assert.equal(hook.onCommitFiberRoot, onCommitFiberRoot);
    } finally {
      api.dispose();
    }
  });
});

test("a DevTools hook global the library cannot read, or a hook on it it cannot read, never reaches the page's error handlers, whether install(), the check 3 s after install, an Event Timing batch or the hide reads it", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const locked = {
    configurable: true,
    get() {
      throw new Error('hook locked');
    },
  };
  // There before install(), which reads it first: no hook can be reached through it, so the page is
  // 'unsupported' and says why, rather than install() throwing out of the app's entry module. So too for a
  // global that can be read holding a hook that cannot, and for a getter that throws a value with no string form.
  const unreadable: [string, PropertyDescriptor, string][] = [
    ['the global', locked, 'Error: hook locked'],
    [
      'the hook on it',
      {
        configurable: true,
        writable: true,
        value: new Proxy(
          {},
          {
            get() {
              throw new Error('hook locked');
            },
          },
        ),
      },
      'Error: hook locked',
    ],
    [
      'no string form',
      {
        configurable: true,
        get() {
          throw Object.create(null);
        },
      },
      'a value that cannot be printed',
    ],
  ];
  for (const [name, descriptor, quoted] of unreadable) {
    await inBrowser((page) => {
      Object.defineProperty(page.window, HOOK, descriptor);
      const api = install({ devtoolsTrack: false });
      try {
        assert.deepEqual({ mode: api.stats().mode, kind: api.stats().unsupportedReason?.kind }, { mode: 'unsupported', kind: 'hook-disabled' }, name);
        assert.equal(warn.mock.callCount(), 1, name);
        assert.equal(
          String(warn.mock.calls[0]?.arguments[0]),
          `[react-inp-blame] the page's __REACT_DEVTOOLS_GLOBAL_HOOK__ cannot be read or replaced (${quoted}), so React's commits cannot be read. Interactions are still reported, without components. See https://github.com/adityareddy-dev/react-inp-blame#hook-disabled`,
          name,
        );
        page.paint([click(7, 1000, 120)]);
        t.mock.timers.tick(3000);
        page.queue([click(14, 2000, 200)]);
        page.hide();
        assert.deepEqual(
          api.reports().map((r) => ({ id: r.interactionId, react: r.reactStatus })),
          [
            { id: 7, react: 'unreadable' },
            { id: 14, react: 'unreadable' },
          ],
          name,
        );
        assert.equal(warn.mock.callCount(), 1, name);
      } finally {
        api.dispose();
      }
    });
    session?.slots.warnings?.clear();
    warn.mock.resetCalls();
  }
  for (const reads of ['check', 'batch', 'hide']) {
    await inBrowser((page) => {
      const api = install({ devtoolsTrack: false });
      try {
        const heard: number[] = [];
        onInteraction((r) => heard.push(r.interactionId));
        page.paint([click(7, 1000, 120)]);
        // Redefined with a getter that throws, which the shim's accessor cannot see. That is the page's doing,
        // not an error of the library's: no React has registered with the shim, and none can reach it through
        // the global now, so the page is 'unsupported' and the console is told as it would be at install().
        const shim = page.window[HOOK];
        Object.defineProperty(page.window, HOOK, locked);
        if (reads === 'check') assert.doesNotThrow(() => t.mock.timers.tick(3000));
        if (reads === 'batch') assert.doesNotThrow(() => page.paint([click(14, 2000, 200)]));
        if (reads === 'hide') {
          page.queue([click(14, 2000, 200)]);
          assert.doesNotThrow(() => page.hide());
          assert.deepEqual(heard, [7, 14], 'the reports waiting were not heard at the hide');
        }
        assert.deepEqual({ mode: api.stats().mode, kind: api.stats().unsupportedReason?.kind }, { mode: 'unsupported', kind: 'hook-disabled' }, reads);
        // While the global goes on throwing, and once it can be read again, every interaction is reported and
        // counted toward INP, and the console is told once.
        page.paint([click(21, 3000, 300)]);
        Object.defineProperty(page.window, HOOK, { value: shim, configurable: true, writable: true });
        page.paint([click(28, 4000, 400)]);
        assert.deepEqual(
          api.reports().map((r) => r.interactionId),
          reads === 'check' ? [7, 21, 28] : [7, 14, 21, 28],
          reads,
        );
        assert.equal(api.inp()?.interactionId, 28, reads);
        assert.deepEqual(
          warn.mock.calls.map((call) => String(call.arguments[0])),
          [
            "[react-inp-blame] the page's __REACT_DEVTOOLS_GLOBAL_HOOK__ cannot be read or replaced (Error: hook locked), so React's commits cannot be read. Interactions are still reported, without components. See https://github.com/adityareddy-dev/react-inp-blame#hook-disabled",
          ],
          reads,
        );
      } finally {
        api.dispose();
      }
    });
    session?.slots.warnings?.clear();
    warn.mock.resetCalls();
  }
});

test("an error while the library checks for react-dom, 3 s after install or at the batch after that, never reaches the page's error handlers, and the batch still has its reports", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = t.mock.method(performance, 'now');
  const throwOnce = () =>
    now.mock.mockImplementationOnce(() => {
      throw new TypeError('clock moved');
    });
  for (const checks of ['timer', 'batch']) {
    await inBrowser((page) => {
      const api = install({ devtoolsTrack: false });
      try {
        // No react-dom registers and none has rendered, so the check looks for React on the page, and where
        // it found none 3 s after install, once more at the next batch. There the first clock read throws.
        if (checks === 'timer') throwOnce();
        assert.doesNotThrow(() => t.mock.timers.tick(3000), checks);
        if (checks === 'batch') throwOnce();
        assert.doesNotThrow(() => page.paint([click(7, 1000, 120)]), checks);
        page.paint([click(14, 2000, 200)]);
        assert.deepEqual(api.reports().map((r) => r.interactionId), [7, 14], checks);
        assert.equal(api.inp()?.interactionId, 14, checks);
        assert.equal(caught(warn).length, 1, checks);
        assert.match(String(caught(warn)[0]), /an error inside the library \(TypeError: clock moved\) was kept from the page/, checks);
      } finally {
        api.dispose();
      }
    });
    session?.slots.warnings?.clear();
    warn.mock.resetCalls();
  }
});

test("a DevTools hook global a classic script declared with var holds the shim as a plain value, and one locked as null or behind a setter that drops the write leaves the page 'unsupported', rather than install() throwing", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  // Declared, the global cannot be redefined as the shim's accessor, but it can still be written.
  await inBrowser((page) => {
    Object.defineProperty(page.window, HOOK, { value: undefined, writable: true, enumerable: true, configurable: false });
    const api = install({ devtoolsTrack: false });
    try {
      assert.deepEqual({ mode: api.stats().mode, shim: page.window[HOOK]?.reactInpBlame }, { mode: 'shim', shim: true });
      assert.equal(warn.mock.callCount(), 0);
      // With no accessor to hear it, a tool that assigns its own hook before React registers is noticed at the
      // next batch, and followed.
      page.window[HOOK] = existingHook();
      page.paint([click(7, 1000, 120)]);
      assert.deepEqual({ mode: api.stats().mode, id: api.last()?.interactionId }, { mode: 'chained', id: 7 });
      assert.equal(warn.mock.callCount(), 0);
    } finally {
      api.dispose();
    }
  });
  // Locked as null, or behind a setter that drops what it is handed, it can be neither redefined nor written.
  const locked = {
    'as null': { value: null, writable: false, configurable: false },
    'behind a setter': { get: () => undefined, set() {}, configurable: false },
  };
  for (const [name, descriptor] of Object.entries(locked)) {
    await inBrowser((page) => {
      Object.defineProperty(page.window, HOOK, descriptor);
      const api = install({ devtoolsTrack: false });
      try {
        assert.deepEqual({ mode: api.stats().mode, kind: api.stats().unsupportedReason?.kind }, { mode: 'unsupported', kind: 'hook-disabled' }, name);
        assert.equal(warn.mock.callCount(), 1, name);
        assert.match(String(warn.mock.calls[0]?.arguments[0]), /__REACT_DEVTOOLS_GLOBAL_HOOK__ is empty and read-only, so React registers with no hook and its commits cannot be read\./, name);
        page.paint([click(7, 1000, 120)]);
        assert.deepEqual({ id: api.last()?.interactionId, react: api.last()?.reactStatus }, { id: 7, react: 'unreadable' }, name);
      } finally {
        api.dispose();
      }
    });
    session?.slots.warnings?.clear();
    warn.mock.resetCalls();
  }
});

test("an Event Timing entry the library cannot read never reaches the page's error handlers, whether the observer is handed it or the hide takes it", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  // An entry whose interactionId throws when it is read, which the observer reads before anything else.
  const unreadable = () =>
    Object.defineProperty(click(14, 2000, 200), 'interactionId', {
      get() {
        throw new TypeError('interactionId moved');
      },
    });
  for (const takes of ['callback', 'hide']) {
    await inBrowser((page) => {
      const api = install({ devtoolsTrack: false });
      try {
        const heard: number[] = [];
        onInteraction((r) => heard.push(r.interactionId));
        page.paint([click(7, 1000, 120)]);
        if (takes === 'callback') assert.doesNotThrow(() => page.paint([unreadable()]));
        if (takes === 'hide') {
          page.queue([unreadable()]);
          assert.doesNotThrow(() => page.hide());
          assert.deepEqual(heard, [7], 'the report waiting was not heard at the hide');
        }
        assert.equal(caught(warn).length, 1, takes);
        page.paint([click(21, 3000, 200)]);
        assert.equal(api.last()?.interactionId, 21, takes);
      } finally {
        api.dispose();
      }
    });
    session?.slots.warnings?.clear();
    warn.mock.resetCalls();
  }
});

test("an error while reports are handed to listeners never reaches the page's error handlers, and the reports after it are still heard", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    try {
      const id = existing.inject(reactDom('19.3.0'));
      // A root whose lanes cannot be read for a while, which the delivery reads to tell the listeners' renders apart.
      const root = mountedRoot(0b11, 4);
      let unreadable = false;
      Object.defineProperty(root, 'pendingLanes', {
        get() {
          if (unreadable) throw new Error('lanes moved');
          return 0;
        },
      });
      page.duringClick(() => existing.onCommitFiberRoot(id, root));
      const heard: number[] = [];
      onInteraction((r) => heard.push(r.interactionId));
      page.paint([click(7, 1000, 120)]);
      unreadable = true;
      assert.doesNotThrow(() => t.mock.timers.tick(0));
      unreadable = false;
      assert.deepEqual(heard, []);
      assert.equal(caught(warn).length, 1);
      page.paint([click(14, 2000, 120)]);
      t.mock.timers.tick(0);
      assert.deepEqual(heard, [14]);
    } finally {
      api.dispose();
    }
  });
});

test("an error while reports are drawn on the Performance panel never reaches the page's error handlers, and they are drawn at the next chance", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // A measure that cannot be looked up for a while, which the drawing does before anything else.
  const drawn: string[] = [];
  let unreadable = true;
  Object.defineProperty(performance, 'measure', {
    configurable: true,
    get() {
      if (unreadable) throw new TypeError('measure moved');
      return (name: string) => drawn.push(name);
    },
  });
  t.after(() => delete (performance as any).measure);
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: true });
    try {
      page.paint([click(7, 1000, 120)]);
      assert.doesNotThrow(() => t.mock.timers.tick(0));
      assert.equal(caught(warn).length, 1);
      unreadable = false;
      page.paint([click(14, 2000, 150)]);
      t.mock.timers.tick(0);
      assert.deepEqual(drawn, ['120 ms click', '150 ms click']);
    } finally {
      api.dispose();
    }
  });
});

test("drawing on the Performance panel that goes on throwing holds only the reports the lifecycle can still revise, the page's INP among them however old, and draws no more than those once it stops", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // A measure that cannot be looked up until the last click, which the drawing does before anything else.
  // Each entry is known by where it starts.
  const drawn: number[] = [];
  let unreadable = true;
  Object.defineProperty(performance, 'measure', {
    configurable: true,
    get() {
      if (unreadable) throw new TypeError('measure moved');
      return (_name: string, opts: { start: number }) => drawn.push(opts.start);
    },
  });
  t.after(() => delete (performance as any).measure);
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: true });
    try {
      // The page's INP first, then quicker clicks enough to push it out were the oldest let go first.
      page.paint([click(1, 1000, 900)]);
      t.mock.timers.tick(0);
      for (let i = 2; i <= 300; i++) {
        page.paint([click(i, i * 1000, 120)]);
        t.mock.timers.tick(0);
      }
      assert.equal(caught(warn).length, 1);
      unreadable = false;
      page.paint([click(301, 301_000, 150)]);
      t.mock.timers.tick(0);
      // Each report the lifecycle still holds, the INP one and the one after the drawing stopped throwing
      // among them, and none it has let go.
      assert.equal(api.inp()?.interactionId, 1);
      assert.equal(drawn.length, MAX_REPORTS);
      assert.deepEqual(drawn.slice().sort((a, b) => a - b), api.reports().map((r) => r.start).sort((a, b) => a - b));
      assert.ok(drawn.includes(1000));
      assert.equal(drawn.at(-1), 301_000);
      assert.equal(caught(warn).length, 1);
    } finally {
      api.dispose();
    }
  });
});

test('a page that refuses the idle callback the Performance panel is drawn in keeps no report from its listeners, before the hide or at it, and holds none back to draw once it stops refusing', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Asked for as each report is published, and refused every time until the page stops refusing.
  let refused = true;
  const idle: (() => void)[] = [];
  Object.defineProperty(globalThis, 'requestIdleCallback', {
    configurable: true,
    value: (task: () => void) => {
      if (refused) throw new TypeError('idle callback refused');
      return idle.push(task);
    },
  });
  Object.defineProperty(globalThis, 'cancelIdleCallback', { configurable: true, value: () => {} });
  const drawn: string[] = [];
  Object.defineProperty(performance, 'measure', { configurable: true, value: (name: string) => drawn.push(name) });
  t.after(() => {
    delete (globalThis as any).requestIdleCallback;
    delete (globalThis as any).cancelIdleCallback;
    delete (performance as any).measure;
  });
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: true });
    try {
      const heard: number[] = [];
      onInteraction((r) => heard.push(r.interactionId));
      assert.doesNotThrow(() => page.paint([click(7, 1000, 300)]));
      page.paint([click(14, 2000, 300)]);
      t.mock.timers.tick(0);
      assert.deepEqual(heard, [7, 14]);
      page.queue([click(21, 3000, 300)]);
      page.hide();
      assert.deepEqual(
        api.reports().map((r) => r.interactionId),
        [7, 14, 21],
      );
      assert.deepEqual(heard, [7, 14, 21]);
      assert.equal(caught(warn).length, 1);
      // The page takes idle callbacks again. The reports from the refusal were let go, so the one
      // idle callback draws the next report alone.
      refused = false;
      page.paint([click(28, 4000, 150)]);
      assert.equal(idle.length, 1);
      idle[0]!();
      assert.deepEqual(drawn, ['150 ms click']);
      assert.equal(warn.mock.callCount(), 1);
    } finally {
      api.dispose();
    }
  });
});

test('a badge and panel that fail to show by throwing a value with no string form are said to have failed, and leave no rejected promise', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser(async () => {
    // The page will not make the badge's first element, and throws an object with no prototype.
    (globalThis as any).document.createElement = () => {
      throw Object.create(null);
    };
    const api = install({ devtoolsTrack: false });
    try {
      assert.equal(await mountOverlay(), null);
      assert.match(
        String(warn.mock.calls.at(-1)?.arguments[0]),
        /^\[react-inp-blame\] the badge and panel could not be shown \(a value that cannot be printed\)\. See https:\/\/github\.com\/adityareddy-dev\/react-inp-blame#overlay-failed$/,
      );
    } finally {
      api.dispose();
    }
  });
});

/** An event the library cannot read: every property asked of it throws. */
const unreadableEvent = () =>
  new Proxy(
    {},
    {
      get() {
        throw new TypeError('unreadable event');
      },
    },
  );

test("an error in a window listener of the library's, or in what it does when a router announces a navigation, never reaches the page's error handlers, and the next interaction is still reported", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const cases: Record<string, (page: Page) => void | Promise<void>> = {
    input: (page) => page.fire('pointerdown', unreadableEvent()),
    closer: async (page) => {
      // Looked at only after an input, and outside its task.
      page.fire('pointerdown', { isTrusted: true, type: 'pointerdown', timeStamp: 1000, target: FIELD, pointerId: 1 });
      await nextTask();
      page.fire('input', unreadableEvent());
    },
    keypress: (page) => page.fire('keypress', unreadableEvent()),
    resize: (page) => page.fire('resize', unreadableEvent()),
    pageshow: (page) => page.fire('pageshow', unreadableEvent()),
    visibilitychange: (page) => {
      Object.defineProperty((globalThis as any).document, 'visibilityState', {
        configurable: true,
        get() {
          throw new TypeError('unreadable document');
        },
      });
      page.fire('visibilitychange', { type: 'visibilitychange' });
    },
    router: (page) => {
      page.window.event = unreadableEvent();
      try {
        routerNavigated({ url: 'https://shop.example/cart', type: 'push', at: 1000 });
      } finally {
        delete page.window.event;
      }
    },
  };
  for (const [listener, fire] of Object.entries(cases)) {
    await inBrowser(async (page) => {
      const api = install({ devtoolsTrack: false });
      try {
        await assert.doesNotReject(async () => fire(page), listener);
        assert.equal(caught(warn).length, 1, listener);
        page.paint([click(7, 2000, 120)]);
        assert.equal(api.last()?.interactionId, 7, listener);
      } finally {
        api.dispose();
      }
    });
    session?.slots.warnings?.clear();
    warn.mock.resetCalls();
  }
});

test('a render that a report listener causes is never read, so a panel showing reports never joins the report it shows', async (t) => {
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    clock.now = 1000;
    page.duringClick(() => existing.onCommitFiberRoot(id, root));

    // A panel that shows the last report. Setting its state leaves the update's lane pending on the root,
    // and React renders it in a task of its own, clearing the lane before it calls the hook.
    const PANEL_LANE = 0b100000;
    onInteraction(() => {
      root.pendingLanes |= PANEL_LANE;
    });
    const panelRenders = () => {
      commitAgain(root, 40);
      root.pendingLanes &= ~PANEL_LANE;
      existing.onCommitFiberRoot(id, root);
    };

    page.paint([click(7, 1000, 120)]);
    await nextTask();
    clock.now = 1200;
    panelRenders();
    await nextTask();
    assert.equal(api.debug.commits().length, 1, 'the panel render was walked');
    assert.equal(api.last()?.revision, 0);

    // Data arriving is no listener's work: its render joins the report, the panel shows the new revision,
    // and that render joins nothing.
    clock.now = 1300;
    commitAgain(root, 40);
    existing.onCommitFiberRoot(id, root);
    await nextTask();
    clock.now = 1400;
    panelRenders();
    await nextTask();
    assert.deepEqual(
      api.reports().map((r) => ({ revision: r.revision, laterRenders: r.followUps.map((c) => c.at) })),
      [{ revision: 1, laterRenders: [1300] }],
    );
    api.dispose();
  });
});

test("a key pressed before a report listener's update renders it along with its own, and the commit is still the key's", async (t) => {
  // Typing at full speed, the next key press comes before React's own task for what the panel set on
  // hearing the last report. React 19.3 renders that update with the key's, inside the key's dispatch, so
  // the key's commit finishes the panel's lane. Read as the panel's render it was dropped, and the
  // keystroke's report said React rendered nothing.
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    clock.now = 1000;
    page.duringClick(() => existing.onCommitFiberRoot(id, root));
    const PANEL_LANE = 0b100000;
    onInteraction(() => {
      root.pendingLanes |= PANEL_LANE;
    });
    page.paint([click(7, 1000, 120)]);
    await nextTask();

    // React commits from the field's onChange, in the `input` event of the key's task, and clears the panel's lane with it.
    clock.now = 1200;
    page.fire('keydown', { isTrusted: true, type: 'keydown', timeStamp: 1200, target: null, code: 'KeyA' });
    page.window.event = { isTrusted: true, type: 'input', timeStamp: 1201, target: FIELD };
    clock.now = 1290;
    commitAgain(root, 80);
    root.pendingLanes &= ~PANEL_LANE;
    existing.onCommitFiberRoot(id, root);
    delete page.window.event;
    assert.deepEqual(
      api.debug.commits().map((c) => ({ inputType: c.inputType, inputTs: c.inputTs })),
      [
        { inputType: 'click', inputTs: 1000 },
        { inputType: 'keydown', inputTs: 1200 },
      ],
    );
    page.paint([pointer('keydown', 8, 1200, 104)]);
    await nextTask();
    assert.equal(api.last()?.interactionId, 8);
    assert.deepEqual(
      api.last()?.commits.map((c) => ({ inputTs: c.inputTs, joinedBy: c.joinedBy })),
      [{ inputTs: 1200, joinedBy: 'exact' }],
    );

    // The panel showing the key's report renders in a task of its own, and that render is still not read.
    clock.now = 1400;
    commitAgain(root, 40);
    root.pendingLanes &= ~PANEL_LANE;
    existing.onCommitFiberRoot(id, root);
    await nextTask();
    assert.equal(api.debug.commits().length, 2);
    assert.equal(api.last()?.revision, 0);
    api.dispose();
  });
});

test("the renders a listener's render sets off, from its layout effects or its passive effects, are not read either", async (t) => {
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    clock.now = 1000;
    page.duringClick(() => existing.onCommitFiberRoot(id, root));
    const [LAYOUT_EFFECT_LANE, PANEL_LANE, PASSIVE_EFFECT_LANE] = [0b10, 0b100000, 0b1000000];
    onInteraction(() => {
      root.pendingLanes |= PANEL_LANE;
    });
    page.paint([click(7, 1000, 120)]);
    await nextTask();

    // The panel renders, and its layout effect sets state before React calls the hook.
    clock.now = 1200;
    commitAgain(root, 40);
    root.pendingLanes = LAYOUT_EFFECT_LANE;
    existing.onCommitFiberRoot(id, root);
    // React renders that update at once. Then a passive effect sets state, and React says the passive effects ran.
    commitAgain(root, 40);
    root.pendingLanes = 0;
    existing.onCommitFiberRoot(id, root);
    root.pendingLanes = PASSIVE_EFFECT_LANE;
    page.window[HOOK].onPostCommitFiberRoot(id, root);
    clock.now = 1250;
    commitAgain(root, 40);
    root.pendingLanes = 0;
    existing.onCommitFiberRoot(id, root);

    assert.equal(api.debug.commits().length, 1);
    assert.equal(api.last()?.revision, 0);
    api.dispose();
  });
});

/** The roots the hook looks for the report listeners' work on (`listenerWorkOf`). */
const heldRoots = () => (session?.slots as Record<string, { roots: { deref(): unknown }[] }>).hook!.roots;

test('a page that keeps creating React roots and dropping them holds on to the dropped ones only for a while, report listener or not', async (t) => {
  // A root per toast, popup or map marker. The roots the listeners' work is looked for on are held
  // weakly, so a dropped one leaves an empty WeakRef behind. This one lets the test drop a root at once.
  const dropped = new WeakSet<object>();
  class DroppableRef<T extends object> {
    target: T;
    constructor(target: T) {
      this.target = target;
    }
    deref(): T | undefined {
      return dropped.has(this.target) ? undefined : this.target;
    }
  }
  const { WeakRef } = globalThis;
  globalThis.WeakRef = DroppableRef as unknown as WeakRefConstructor;
  t.after(() => {
    globalThis.WeakRef = WeakRef;
  });
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const app = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, app);
    const toasts = () => {
      for (let i = 0; i < 2000; i++) {
        const root = mountedRoot(0b11, 4);
        existing.onCommitFiberRoot(id, root);
        dropped.add(root);
      }
    };

    toasts();
    assert.ok(heldRoots().length <= 128, `${heldRoots().length} roots held with no report listener`);
    // A listener that no report has reached yet, so nothing has looked at the roots for it.
    onInteraction(() => {});
    toasts();
    assert.ok(heldRoots().length <= 128, `${heldRoots().length} roots held with a report listener`);
    assert.ok(heldRoots().some((ref) => ref.deref() === app), 'the root still mounted was let go');
    api.dispose();
  });
});

test('a page that keeps many React roots mounted looks at each only a few times as it records new ones, and starts over after dispose()', async (t) => {
  // A root per map marker, all of them kept. Looking through every root each time a new one commits would
  // take time that grows with the square of the roots, inside React's commit; looking again only once the
  // list has doubled keeps it to a few looks for each root.
  let looks = 0;
  const dropped = new WeakSet<object>();
  class CountedRef<T extends object> {
    target: T;
    constructor(target: T) {
      this.target = target;
    }
    deref(): T | undefined {
      looks++;
      return dropped.has(this.target) ? undefined : this.target;
    }
  }
  const { WeakRef } = globalThis;
  globalThis.WeakRef = CountedRef as unknown as WeakRefConstructor;
  t.after(() => {
    globalThis.WeakRef = WeakRef;
  });
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const markers = 3000;
    for (let i = 0; i < markers; i++) existing.onCommitFiberRoot(id, mountedRoot(0b11, 4));
    assert.equal(heldRoots().length, markers);
    assert.ok(looks <= 4 * markers, `${looks} looks at ${markers} roots`);
    api.dispose();

    // The markers put off the next look to twice their number. An install after dispose() looks from the
    // fewest roots again, so the ones it drops are let go of as soon as on a page that never had many.
    const again = install({ hook: 'chain', devtoolsTrack: false });
    for (let i = 0; i < 2000; i++) {
      const root = mountedRoot(0b11, 4);
      existing.onCommitFiberRoot(id, root);
      dropped.add(root);
    }
    assert.ok(heldRoots().length <= 128, `${heldRoots().length} roots held after dispose() and another install`);
    again.dispose();
  });
});

test("a root's first commit is an input's only when React ran it inside that input's dispatch", async (t) => {
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    // A click on server-rendered HTML before the app's code has run: the library hears it, React does not.
    clock.now = 1000;
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 1000, target: null });
    // The root hydrates 200 ms later. React 18 and 19 mark the state it leaves behind isDehydrated.
    clock.now = 1200;
    const hydrated = mountedRoot(0b11, 40);
    hydrated.current.alternate = { tag: 3, child: null, memoizedState: { isDehydrated: true } };
    existing.onCommitFiberRoot(id, hydrated);
    assert.deepEqual(api.debug.commits(), [], 'the hydration was stamped with the click before it');
    // A click whose handler opens a dialog in a root of its own: React mounts it inside the click's dispatch.
    page.duringClick(() => existing.onCommitFiberRoot(id, mountedRoot(0b11, 40)));
    assert.deepEqual(
      api.debug.commits().map((c) => ({ inputType: c.inputType, hydrated: c.hydrated })),
      [{ inputType: 'click', hydrated: false }],
    );
    api.dispose();
  });
});

test("a Suspense boundary hydrating is an input's only when React hydrated it inside that input's dispatch, and the commit says it hydrated", async (t) => {
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    clock.now = 1000;
    page.duringClick(() => existing.onCommitFiberRoot(id, root));
    // The boundary's server-rendered HTML hydrates once its code arrives: dehydrated before the commit, not after.
    const hydrateBoundary = () => {
      commitAgain(root, 30);
      const content = root.current.child;
      const boundary = { tag: 13, flags: 0, mode: 0b11, elementType: null, type: null, memoizedProps: {}, memoizedState: null, return: root.current, child: content, sibling: null, actualDuration: 30, alternate: { tag: 13, child: null, memoizedState: { dehydrated: {} } } };
      content.return = boundary;
      root.current.child = boundary;
      existing.onCommitFiberRoot(id, root);
    };
    clock.now = 1300;
    hydrateBoundary();
    assert.equal(api.debug.commits().length, 1, 'the hydration was stamped with the click before it');
    // A click on the boundary before it hydrated: React hydrates it at once, inside the click's dispatch.
    page.duringClick(hydrateBoundary);
    assert.deepEqual(
      api.debug.commits().map((c) => c.hydrated),
      [false, true],
    );
    api.dispose();
  });
});

test('a clicked element that React deleted before its entry arrived is named by what the library read at dispatch', async () => {
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    function Page() {}
    function Row() {}
    function removeRow() {}
    const pageFiber = { tag: 0, elementType: Page, type: Page, memoizedProps: {}, return: null };
    const rowFiber = { tag: 0, elementType: Row, type: Row, memoizedProps: {}, return: pageFiber };
    const buttonFiber: Record<string, unknown> = { tag: 5, elementType: 'button', type: 'button', memoizedProps: { onClick: removeRow }, return: rowFiber };
    const button: Record<string, unknown> = { nodeType: 1, tagName: 'BUTTON', id: '', classList: { length: 0 }, parentNode: null, parentElement: null, firstChild: null, getAttribute: () => null, __reactFiber$demo: buttonFiber };
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 1000, target: button });
    // Committing the deletion of the row, React 18 and 19 detach the button's fiber: no parent, no props, no key on the node.
    buttonFiber.return = null;
    buttonFiber.memoizedProps = null;
    delete button.__reactFiber$demo;
    // The entry's target is null: the button has left the DOM.
    page.paint([click(7, 1000, 120)]);
    const target = api.last()?.target;
    assert.deepEqual(target && { component: target.component, owners: target.owners, handler: target.handler }, { component: 'Row', owners: ['Row', 'Page'], handler: 'removeRow' });
    api.dispose();
  });
});

test("a click on an icon that the click swapped out is named by the button it was in, read at dispatch", async () => {
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    function Toolbar() {}
    function DeleteButton() {}
    function removeRow() {}
    const node = (tag: string, fiber: Record<string, unknown>, parent: Record<string, unknown> | null, attributes: Record<string, string> = {}) => ({
      nodeType: 1, tagName: tag.toUpperCase(), id: '', classList: { length: 0 }, parentNode: parent, parentElement: parent, firstChild: null,
      getAttribute: (name: string) => attributes[name] ?? null, __reactFiber$demo: fiber,
    });
    const toolbarFiber = { tag: 0, elementType: Toolbar, type: Toolbar, memoizedProps: {}, return: null };
    const deleteFiber = { tag: 0, elementType: DeleteButton, type: DeleteButton, memoizedProps: {}, return: toolbarFiber };
    const buttonFiber = { tag: 5, elementType: 'button', type: 'button', memoizedProps: { onClick: removeRow }, return: deleteFiber };
    const iconType = { $$typeof: Symbol.for('react.forward_ref'), render: () => null, displayName: 'Trash2' };
    const iconFiber = { tag: 11, elementType: iconType, type: iconType, memoizedProps: {}, return: buttonFiber };
    const svgFiber: Record<string, unknown> = { tag: 5, elementType: 'svg', type: 'svg', memoizedProps: {}, return: iconFiber };
    const button = node('button', buttonFiber, null, { 'aria-label': 'Delete row' });
    const svg: Record<string, unknown> = node('svg', svgFiber, button);
    // Linked down as well as up, as React links them: the names are read from above the icon's own components.
    Object.assign(toolbarFiber, { child: deleteFiber, sibling: null });
    Object.assign(deleteFiber, { child: buttonFiber, sibling: null });
    Object.assign(buttonFiber, { child: iconFiber, sibling: null, stateNode: button });
    Object.assign(iconFiber, { child: svgFiber, sibling: null });
    Object.assign(svgFiber, { child: null, sibling: null, stateNode: svg });
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 1000, target: svg });
    // The click swaps the icon: the svg leaves the page and React clears its fiber.
    svg.parentNode = null;
    svg.parentElement = null;
    svgFiber.return = null;
    delete svg.__reactFiber$demo;
    page.paint([click(7, 1000, 120)]);
    const target = api.last()?.target;
    assert.deepEqual(target && { component: target.component, owners: target.owners, handler: target.handler, label: target.label, selector: target.selector }, {
      component: 'DeleteButton', owners: ['DeleteButton', 'Toolbar'], handler: 'removeRow', label: 'button "Delete row"', selector: 'svg',
    });
    api.dispose();
  });
});

test("Enter in a form's field is named by the onSubmit its keypress reached, read as the keypress was dispatched", async () => {
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ devtoolsTrack: false, hook: 'chain' });
    function Wizard() {}
    function goNext() {}
    function finish() {}
    function saveDraft() {}
    function setEmail() {}
    const node = (tag: string, fiber: Record<string, unknown>, parent: Record<string, unknown> | null) => ({
      nodeType: 1, tagName: tag.toUpperCase(), id: '', classList: { length: 0 }, parentNode: parent, parentElement: parent, firstChild: null,
      getAttribute: () => null, __reactFiber$demo: fiber,
    });
    const rootFiber = { tag: 3, elementType: null, type: null, memoizedProps: null, memoizedState: { isDehydrated: false }, return: null };
    const wizardFiber = { tag: 0, elementType: Wizard, type: Wizard, memoizedProps: {}, return: rootFiber };
    const formFiber: Record<string, unknown> = { tag: 5, elementType: 'form', type: 'form', memoizedProps: { onSubmit: goNext }, return: wizardFiber };
    // The field is controlled, as most are. Enter changes no value, so its onChange is not what the keypress reached.
    const fieldProps = { type: 'email', value: 'a@b.c', onChange: setEmail };
    const fieldFiber: Record<string, unknown> = { tag: 5, elementType: 'input', type: 'input', memoizedProps: fieldProps, return: formFiber };
    const container = { ...node('div', rootFiber, null), __reactContainer$demo: rootFiber };
    delete (container as Record<string, unknown>).__reactFiber$demo;
    const form: Record<string, unknown> = { ...node('form', formFiber, container), __reactProps$demo: { onSubmit: goNext } };
    formFiber.stateNode = form;
    const field: Record<string, unknown> = { ...node('input', fieldFiber, form), __reactProps$demo: fieldProps };
    fieldFiber.stateNode = field;
    const enter = (id: number, ts: number, render: () => void, beforeKeypress = () => {}, submitWork = 120) => {
      page.fire('keydown', { isTrusted: true, type: 'keydown', timeStamp: ts, target: field, code: 'Enter' });
      beforeKeypress();
      page.fire('keypress', { isTrusted: true, type: 'keypress', timeStamp: ts, target: field, code: 'Enter' });
      render();
      const keydown = { ...pointer('keydown', id, ts, 140), processingEnd: ts + 3, target: field };
      page.paint([keydown, { ...keydown, name: 'keypress', processingStart: ts + 3, processingEnd: ts + 3 + submitWork }]);
      return api.last()?.target?.handler;
    };
    // The first step's submit renders the second, whose onSubmit is finish, before the entries come.
    assert.equal(
      enter(7, 1000, () => (form.__reactProps$demo = { onSubmit: finish })),
      'goNext',
    );
    // Only the browser's own keypress for the keydown's key is read onto its record. One a script dispatched, here
    // while the form had another onSubmit, is not, and nor is one for another key.
    form.__reactProps$demo = { onSubmit: goNext };
    const strays = () => {
      form.__reactProps$demo = { onSubmit: saveDraft };
      page.fire('keypress', { isTrusted: false, type: 'keypress', timeStamp: 2000, target: field, code: 'Enter' });
      form.__reactProps$demo = { onSubmit: goNext };
      page.fire('keypress', { isTrusted: true, type: 'keypress', timeStamp: 2000, target: field, code: 'KeyA' });
    };
    assert.equal(enter(8, 2000, () => (form.__reactProps$demo = { onSubmit: finish }), strays), 'goNext');
    // An async onSubmit does little in the keypress, so its entry ties with the keydown's, which comes first. The
    // keydown reaches the same onSubmit and no onChange either: React runs none for Enter in a field.
    form.__reactProps$demo = { onSubmit: goNext };
    assert.equal(enter(9, 3000, () => (form.__reactProps$demo = { onSubmit: finish }), undefined, 2), 'goNext');
    // The Enter that commits an input method's text submits nothing and fires no keypress: the field's onChange runs,
    // from the input event that ends the composition. The keydown's keyCode is 229, whatever the key.
    form.__reactProps$demo = { onSubmit: goNext };
    page.fire('keydown', { isTrusted: true, type: 'keydown', timeStamp: 3500, target: field, code: 'Enter', keyCode: 229 });
    page.paint([{ ...pointer('keydown', 10, 3500, 140), target: field }]);
    assert.equal(api.last()?.target?.handler, 'setEmail');
    // Chromium submits the form from Enter in its field by clicking the submit button, inside the keypress, and times
    // that click in an entry of its own with the keypress's work. The button's onClick runs first and did none of it.
    function trackClick() {}
    const buttonProps = { type: 'submit', onClick: trackClick };
    const buttonFiber: Record<string, unknown> = { tag: 5, elementType: 'button', type: 'button', memoizedProps: buttonProps, return: formFiber };
    const button = { ...node('button', buttonFiber, form), __reactProps$demo: buttonProps };
    buttonFiber.stateNode = button;
    page.fire('keydown', { isTrusted: true, type: 'keydown', timeStamp: 3700, target: field, code: 'Enter' });
    page.fire('keypress', { isTrusted: true, type: 'keypress', timeStamp: 3700, target: field, code: 'Enter' });
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 3700, target: button, pointerId: -1, pointerType: '' });
    form.__reactProps$demo = { onSubmit: finish };
    const submitted = { ...pointer('keydown', 15, 3700, 140), processingEnd: 3703, target: field };
    const submitWork = { processingStart: 3703, processingEnd: 3823 };
    page.paint([submitted, { ...submitted, name: 'keypress', ...submitWork }, { ...submitted, name: 'click', ...submitWork, target: button }]);
    assert.equal(api.last()?.target?.handler, 'goNext');
    // Server HTML React had not hydrated by the keypress has no handler to read yet: the form is read when the
    // entries come, once React hydrated it to run the submit.
    const dehydrate = () => {
      rootFiber.memoizedState = { isDehydrated: true };
      delete form.__reactFiber$demo;
      delete form.__reactProps$demo;
      delete field.__reactFiber$demo;
      delete field.__reactProps$demo;
    };
    // React hydrates an element with the same props on it and on the fiber it caches there.
    const hydrate = (onSubmit = finish, props: Record<string, unknown> = fieldProps) => {
      rootFiber.memoizedState = { isDehydrated: false };
      formFiber.memoizedProps = { onSubmit };
      fieldFiber.memoizedProps = props;
      Object.assign(form, { __reactFiber$demo: formFiber, __reactProps$demo: formFiber.memoizedProps });
      Object.assign(field, { __reactFiber$demo: fieldFiber, __reactProps$demo: props });
    };
    dehydrate();
    assert.equal(enter(11, 4000, hydrate), 'finish');
    // An input method's Enter there is read then too, for the key its keydown was read for, which is not Enter.
    dehydrate();
    page.fire('keydown', { isTrusted: true, type: 'keydown', timeStamp: 5000, target: field, code: 'Enter', keyCode: 229 });
    hydrate();
    page.paint([{ ...pointer('keydown', 12, 5000, 140), target: field }]);
    assert.equal(api.last()?.target?.handler, 'setEmail');
    // React hydrates the HTML a key lands on inside the keydown, to run it, and commits that before any handler runs.
    // Then the keydown's entry carries the hydration and outweighs the keypress's. Its element is read again at that
    // commit: hydrated by then, and not yet rendered by the key or the submit.
    const renderer = existing.inject(reactDom('19.3.0'));
    const hydratedInKeydown = (id: number, ts: number, props: Record<string, unknown>, keypressOn = field, keydownRender = () => {}) => {
      dehydrate();
      const pressed = { isTrusted: true, type: 'keydown', timeStamp: ts, target: field, code: 'Enter' };
      page.fire('keydown', pressed);
      page.window.event = pressed;
      hydrate(goNext, props);
      existing.onCommitFiberRoot(renderer, mountedRoot(0b11, 4));
      delete page.window.event;
      keydownRender();
      page.fire('keypress', { isTrusted: true, type: 'keypress', timeStamp: ts, target: keypressOn, code: 'Enter' });
      form.__reactProps$demo = { onSubmit: finish };
      const keydown = { ...pointer('keydown', id, ts, 400), processingEnd: ts + 361, target: field };
      page.paint([keydown, { ...keydown, name: 'keypress', processingStart: ts + 361, processingEnd: ts + 393, target: keypressOn }]);
      return api.last()?.target?.handler;
    };
    assert.equal(hydratedInKeydown(13, 6000, fieldProps), 'goNext');
    // A field with its own onKeyDown ran it in the keydown, and that is what the keydown is named by.
    function checkShortcut() {}
    assert.equal(hydratedInKeydown(14, 7000, { ...fieldProps, onKeyDown: checkShortcut }), 'checkShortcut');
    // One the key's own render swaps, with a render after it, from an effect, that leaves the fiber cached on the
    // field current again with the swapped props. The keydown ran checkShortcut, and was read as React hydrated it.
    function closeShortcut() {}
    const swapped = () => {
      fieldFiber.memoizedProps = { ...fieldProps, onKeyDown: closeShortcut };
      field.__reactProps$demo = fieldFiber.memoizedProps;
    };
    assert.equal(hydratedInKeydown(17, 7500, { ...fieldProps, onKeyDown: checkShortcut }, field, swapped), 'checkShortcut');
    // One that moves focus sends the keypress to the element it focused, whose own onKeyDown never ran for the key.
    // The keydown is read from its own element.
    function focusResults() {}
    function moveThroughResults() {}
    const resultsProps = { tabIndex: -1, onKeyDown: moveThroughResults };
    const resultsFiber: Record<string, unknown> = { tag: 5, elementType: 'ul', type: 'ul', memoizedProps: resultsProps, return: wizardFiber };
    const results = { ...node('ul', resultsFiber, container), __reactProps$demo: resultsProps };
    resultsFiber.stateNode = results;
    assert.equal(hydratedInKeydown(16, 8000, { ...fieldProps, onKeyDown: focusResults }, results), 'focusResults');
    api.dispose();
  });
});

test("a key on server HTML is named by the handler React hydrated the element with to run it, not the one the key's own render gave it", async () => {
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ devtoolsTrack: false, hook: 'chain' });
    const renderer = existing.inject(reactDom('19.3.0'));
    function Toolbar() {}
    function openMenu() {}
    function closeMenu() {}
    const rootFiber = { tag: 3, elementType: null, type: null, memoizedProps: null, memoizedState: { isDehydrated: true }, return: null };
    const toolbarFiber = { tag: 0, elementType: Toolbar, type: Toolbar, memoizedProps: {}, return: rootFiber };
    const container = { nodeType: 1, tagName: 'DIV', id: '', classList: { length: 0 }, parentNode: null, parentElement: null, firstChild: null, getAttribute: () => null, __reactContainer$demo: rootFiber };
    // `onKeyDown={open ? closeMenu : openMenu}` on server HTML React has not hydrated: nothing on the button to read yet.
    const button: Record<string, unknown> = { nodeType: 1, tagName: 'BUTTON', id: '', classList: { length: 0 }, parentNode: container, parentElement: container, firstChild: null, getAttribute: () => null };
    const pressed = { isTrusted: true, type: 'keydown', timeStamp: 1000, target: button, code: 'ArrowDown' };
    page.fire('keydown', pressed);
    // React hydrates it inside the keydown, to run it, and commits that before any handler runs.
    page.window.event = pressed;
    const buttonFiber: Record<string, unknown> = { tag: 5, elementType: 'button', type: 'button', memoizedProps: { onKeyDown: openMenu }, return: toolbarFiber, stateNode: button };
    rootFiber.memoizedState = { isDehydrated: false };
    Object.assign(button, { __reactFiber$demo: buttonFiber, __reactProps$demo: buttonFiber.memoizedProps });
    existing.onCommitFiberRoot(renderer, mountedRoot(0b11, 4));
    delete page.window.event;
    // openMenu ran, and its render put closeMenu on the button. A layout effect that measured the open menu rendered
    // it again, which left the fiber cached on the button current, with closeMenu too.
    button.__reactProps$demo = buttonFiber.memoizedProps = { onKeyDown: closeMenu };
    page.paint([{ ...pointer('keydown', 3, 1000, 140), processingEnd: 1126, target: button }]);
    assert.equal(api.last()?.target?.handler, 'openMenu');
    // Hydrated by the next key, which is read at dispatch. A commit inside its dispatch is one its handler made, with
    // flushSync, after it ran, and the render put openMenu back: that commit hydrated nothing and is not read.
    const again = { ...pressed, timeStamp: 2000 };
    page.fire('keydown', again);
    page.window.event = again;
    button.__reactProps$demo = buttonFiber.memoizedProps = { onKeyDown: openMenu };
    existing.onCommitFiberRoot(renderer, mountedRoot(0b11, 4));
    delete page.window.event;
    page.paint([{ ...pointer('keydown', 4, 2000, 140), processingEnd: 2126, target: button }]);
    assert.equal(api.last()?.target?.handler, 'closeMenu');
    api.dispose();
  });
});

test("Enter in a form's field is named in each browser's entries by what did the submit's work, with or without the field's onKeyPress, the form's onSubmit and the button's onClick", async () => {
  await inBrowser((page) => {
    const api = install({ devtoolsTrack: false });
    function Checkout() {}
    function onlyDigits() {}
    function placeOrder() {}
    function trackClick() {}
    function saveOrder() {}
    const node = (tag: string, fiber: Record<string, unknown>, parent: Record<string, unknown> | null, props: Record<string, unknown>) => {
      const el: Record<string, unknown> = {
        nodeType: 1, tagName: tag.toUpperCase(), id: '', classList: { length: 0 }, parentNode: parent, parentElement: parent, firstChild: null,
        getAttribute: () => null, __reactFiber$demo: fiber, __reactProps$demo: props,
      };
      fiber.stateNode = el;
      return el;
    };
    const rootFiber = { tag: 3, elementType: null, type: null, memoizedProps: null, memoizedState: { isDehydrated: false }, return: null };
    const container = { nodeType: 1, tagName: 'DIV', id: '', classList: { length: 0 }, parentNode: null, parentElement: null, firstChild: null, getAttribute: () => null, __reactContainer$demo: rootFiber };
    const checkoutFiber = { tag: 0, elementType: Checkout, type: Checkout, memoizedProps: {}, return: rootFiber };
    let id = 20;
    // Every browser fires the keydown and the keypress on the field, and the click Enter makes on the submit button inside
    // the keypress, with the submit after it. Chromium times all three, the keypress and the click with the submit's work.
    // Firefox times the keypress alone, and the click too where the button's own onClick did the work. WebKit times the
    // keydown alone, whose handlers end before the submit begins.
    const enter = (keypress: boolean, submit: boolean, click: boolean, browser: 'chromium' | 'firefox' | 'firefox-click' | 'webkit') => {
      const formProps = submit ? { onSubmit: placeOrder } : {};
      const formFiber: Record<string, unknown> = { tag: 5, elementType: 'form', type: 'form', memoizedProps: formProps, return: checkoutFiber };
      const form = node('form', formFiber, container, formProps);
      const fieldProps = { type: 'text', name: 'qty', ...(keypress ? { onKeyPress: onlyDigits } : {}) };
      const field = node('input', { tag: 5, elementType: 'input', type: 'input', memoizedProps: fieldProps, return: formFiber }, form, fieldProps);
      const buttonProps = { type: 'submit', ...(click ? { onClick: submit ? trackClick : saveOrder } : {}) };
      const button = node('button', { tag: 5, elementType: 'button', type: 'button', memoizedProps: buttonProps, return: formFiber }, form, buttonProps);
      const ts = 1000 * ++id;
      page.fire('keydown', { isTrusted: true, type: 'keydown', timeStamp: ts, target: field, code: 'Enter' });
      page.fire('keypress', { isTrusted: true, type: 'keypress', timeStamp: ts, target: field, code: 'Enter' });
      page.fire('click', { isTrusted: true, type: 'click', timeStamp: ts, target: button, pointerId: -1, pointerType: '' });
      const keydownEntry = { ...pointer('keydown', id, ts, 96), processingEnd: ts + 3, target: field };
      const keypressEntry = { ...keydownEntry, name: 'keypress', processingStart: ts + 3, processingEnd: ts + 83 };
      const clickEntry = { ...keypressEntry, name: 'click', target: button };
      const entries = { chromium: [keydownEntry, keypressEntry, clickEntry], firefox: [keypressEntry], 'firefox-click': [keypressEntry, clickEntry], webkit: [keydownEntry] };
      page.paint(entries[browser]);
      return api.last()?.target?.handler;
    };
    const browsers = ['chromium', 'firefox', 'webkit'] as const;
    // The field's onKeyPress, the form's onSubmit and the button's onClick, and what Chromium, Firefox and WebKit name.
    // Firefox's keypress entry begins with the field's onKeyPress, and nothing in it tells that one's work from the
    // submit's, so the keypress's own reading names it. With no onSubmit and no onClick nothing of React's did the work,
    // and a keypress's own reading is all there is. WebKit's keydown reaches the onSubmit and never the button's onClick.
    const shapes: [boolean, boolean, boolean, (string | null)[]][] = [
      [true, true, true, ['placeOrder', 'onlyDigits', 'placeOrder']],
      [true, true, false, ['placeOrder', 'onlyDigits', 'placeOrder']],
      [true, false, true, ['saveOrder', 'onlyDigits', null]],
      [true, false, false, ['onlyDigits', 'onlyDigits', null]],
      [false, true, true, ['placeOrder', 'placeOrder', 'placeOrder']],
      [false, true, false, ['placeOrder', 'placeOrder', 'placeOrder']],
      [false, false, true, ['saveOrder', null, null]],
      [false, false, false, [null, null, null]],
    ];
    const named = shapes.map(([keypress, submit, click]) => [keypress, submit, click, browsers.map((b) => enter(keypress, submit, click, b))]);
    assert.deepEqual(named, shapes);
    // Where Firefox times the click too, the button's onClick did the work, and names it whether the field has an
    // onKeyPress or not.
    assert.deepEqual([enter(true, false, true, 'firefox-click'), enter(false, false, true, 'firefox-click')], ['saveOrder', 'saveOrder']);
    api.dispose();
  });
});

test('two copies of the library on one page share one installation: one hook wrapper, one walk per commit, one set of listeners', async (t) => {
  const [a, b] = await Promise.all([copyOfLibrary(t), copyOfLibrary(t)]);
  assert.notEqual(a.install, b.install, 'the copies share their modules');
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const first = a.install({ hook: 'chain', devtoolsTrack: false });
    const wrapper = existing.onCommitFiberRoot;
    const second = b.install({ hook: 'chain', devtoolsTrack: false });
    assert.equal(second, first);
    assert.equal(existing.onCommitFiberRoot, wrapper, 'the second copy wrapped the hook again');
    assert.equal(Observer.live.size, 1, 'each copy observes Event Timing');

    const { root, walks } = countingRoot();
    const id = existing.inject(reactDom('19.3.0'));
    page.duringClick(() => existing.onCommitFiberRoot(id, root));
    assert.equal(walks(), 1);

    const heard: string[] = [];
    a.onInteraction(() => heard.push('first copy'));
    b.onInteraction(() => heard.push('second copy'));
    page.paint([slowClick(120)]);
    await nextTask();
    assert.deepEqual(heard, ['first copy', 'second copy']);

    // Disposing through either copy ends the one installation for both.
    second.dispose();
    assert.equal(page.listening.size, 0);
    assert.equal(Observer.live.size, 0);
  });
  // The shim one copy made is the other copy's own hook, not someone else's to chain onto.
  await inBrowser(() => {
    a.install({ devtoolsTrack: false }).dispose();
    const api = b.install({ devtoolsTrack: false });
    assert.equal(api.stats().mode, 'shim');
    api.dispose();
  });
});

test('a copy of an incompatible version installs nothing beside the one already on the page, and says why', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const key = Symbol.for('react-inp-blame');
  const holder = globalThis as Record<symbol, unknown>;
  const current = holder[key];
  // What 0.1 and 0.2 left there.
  holder[key] = { layout: 1, slots: {} };
  let other: Awaited<ReturnType<typeof copyOfLibrary>>;
  try {
    other = await copyOfLibrary(t);
  } finally {
    holder[key] = current;
  }
  await inBrowser((page) => {
    const api = other.install({ debugGlobal: true });
    assert.equal(api.stats().mode, 'unsupported');
    assert.equal(api.stats().unsupportedReason?.kind, 'another-copy');
    assert.equal(HOOK in page.window, false, 'the DevTools hook was created');
    assert.equal(page.listening.size, 0, 'input listeners were added');
    assert.equal('__REACT_INP_BLAME__' in page.window, false, 'it took the debug global');
  });
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /incompatible version is already on this page/);
});

// Last: the shim this library creates outlives dispose(), the way React holds on to it.
test('the shim follows a hook that replaces it before React registers, and reports lockout after', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const api = install();
    const replacement = existingHook();
    page.window[HOOK] = replacement;
    assert.equal(api.stats().mode, 'chained');
    assert.equal(api.debug.hook().devtoolsLockedOut, false);
    api.dispose();
  });
  await inBrowser((page) => {
    const api = install();
    page.window[HOOK].inject(reactDom('19.3.0'));
    page.window[HOOK] = existingHook();
    // React keeps reporting to the shim it registered with; the replacement never hears from it.
    assert.equal(api.stats().mode, 'shim');
    assert.equal(api.debug.hook().devtoolsLockedOut, true);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /will not see this React/);
    api.dispose();
  });
});

test("a DevTools hook global the page makes throw when read, after React registered with the shim, is the page's doing: React goes on reporting to the shim, and the console is not told of an error of the library's", async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const reads of ['check', 'batch', 'hide']) {
    await inBrowser((page) => {
      const api = install({ devtoolsTrack: false });
      try {
        const heard: number[] = [];
        onInteraction((r) => heard.push(r.interactionId));
        const shim = page.window[HOOK];
        shim.inject(reactDom('19.3.0'));
        page.paint([click(7, 1000, 120)]);
        // The only order in which such a lock leaves React itself working: React holds the shim already.
        Object.defineProperty(page.window, HOOK, {
          configurable: true,
          get() {
            throw new Error('React DevTools is disabled on this site');
          },
        });
        if (reads === 'check') assert.doesNotThrow(() => t.mock.timers.tick(3000));
        if (reads === 'batch') assert.doesNotThrow(() => page.paint([click(14, 2000, 200)]));
        if (reads === 'hide') {
          page.queue([click(14, 2000, 200)]);
          assert.doesNotThrow(() => page.hide());
          assert.deepEqual(heard, [7, 14], 'the reports waiting were not heard at the hide');
        }
        page.paint([click(21, 3000, 300)]);
        assert.deepEqual(
          api.reports().map((r) => ({ id: r.interactionId, react: r.reactStatus })),
          (reads === 'check' ? [7, 21] : [7, 14, 21]).map((id) => ({ id, react: 'reading' })),
          reads,
        );
        assert.deepEqual({ mode: api.stats().mode, reason: api.stats().unsupportedReason }, { mode: 'shim', reason: null }, reads);
        assert.equal(warn.mock.callCount(), 0, reads);
      } finally {
        api.dispose();
      }
    });
    session?.slots.warnings?.clear();
  }
});

test('React registers with the shim a DevTools hook global declared with var holds as a plain value, and its commits are read', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    Object.defineProperty(page.window, HOOK, { value: undefined, writable: true, enumerable: true, configurable: false });
    const api = install({ devtoolsTrack: false });
    try {
      // What react-dom does as it loads: it reads the global and registers with the hook there.
      const hook = page.window[HOOK];
      const id = hook.inject(reactDom('19.3.0'));
      const root = mountedRoot(0b11, 4);
      hook.onCommitFiberRoot(id, root);
      page.duringClick(() => {
        commitAgain(root, 5);
        hook.onCommitFiberRoot(id, root, 1, false);
      });
      assert.deepEqual({ mode: api.stats().mode, react: api.stats().react, commits: api.debug.commits().length }, { mode: 'shim', react: 'reading', commits: 1 });
      assert.equal(warn.mock.callCount(), 0);
    } finally {
      api.dispose();
    }
  });
});

test("a commit React makes inside an input's dispatch is that input's, however long the dispatch has been running", async (t) => {
  // Sorting 200,000 rows takes seconds on a throttled machine. The commit still runs inside the click's
  // own dispatch, so it is the click's work; a window measured from the input dropped exactly these.
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500 });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    const clicked = page.duringClick(() => {
      clock.now = 3800;
      commitAgain(root, 2700);
      existing.onCommitFiberRoot(id, root, 1, false);
    });
    const commits = api.debug.commits();
    assert.equal(commits.length, 1);
    assert.equal(commits[0]?.inputTs, clicked);
    assert.equal(commits[0]?.sinceInput, 2800);
    api.dispose();
  });
});

test('a commit outside any dispatch joins the newest input while it lands inside the window, measured from the end of that input\'s own work', async (t) => {
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500 });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    // The click, and the 2.7 s render inside its dispatch.
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 1000, target: null });
    page.duringClick(() => {
      clock.now = 3800;
      commitAgain(root, 2700);
      existing.onCommitFiberRoot(id, root, 1, false);
    });
    // An effect of that render commits 200 ms later: 2.9 s after the input, well inside the window that
    // now runs from the end of the click's own work.
    clock.now = 4000;
    commitAgain(root, 6);
    existing.onCommitFiberRoot(id, root, 1, false);
    assert.equal(api.debug.commits().length, 2);
    assert.equal(api.debug.commits()[1]?.at, 4000);
    // A commit 1.6 s after that is past the window, and is counted rather than joined.
    clock.now = 5700;
    commitAgain(root, 6);
    existing.onCommitFiberRoot(id, root, 1, false);
    assert.equal(api.debug.commits().length, 2);
    api.dispose();
  });
});

/** Marks the tree `root` just committed as holding `useEffect`s to run: React's Passive flag on the root's subtree. */
function withEffects(root: { current: Record<string, any> }): void {
  root.current.subtreeFlags = 0b100000000000;
}

test('a commit gets the time the hook call returned and the time React says its passive effects ended, and a call with no commit waiting changes nothing', async (t) => {
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    // React DevTools reads the commit after this library does, for 4 ms: not the effects' time.
    existing.onCommitFiberRoot = () => {
      clock.now += 4;
    };
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.duringClick(() => {
      clock.now = 1010;
      commitAgain(root, 5);
      withEffects(root);
      page.window[HOOK].onCommitFiberRoot(id, root, 1, false);
      assert.equal(api.debug.commits()[0]?.effectsEndedAt, null);
      // React runs a click's passive effects in the same task, then says so.
      clock.now = 1310;
      page.window[HOOK].onPostCommitFiberRoot(id, root);
    });
    const [commit] = api.debug.commits();
    assert.equal(commit?.at, 1010);
    assert.equal(commit?.effectsStartedAt, 1014);
    assert.equal(commit?.effectsEndedAt, 1310);
    assert.ok(Object.isFrozen(commit));
    // Nothing is waiting any more: the mount's tree had no effects, and its place is passed over.
    clock.now = 1400;
    page.window[HOOK].onPostCommitFiberRoot(id, root);
    page.window[HOOK].onPostCommitFiberRoot(id, root);
    assert.equal(api.debug.commits()[0]?.effectsEndedAt, 1310);
    api.dispose();
  });
});

test('a commit an effect flushes with flushSync gets its own post-commit, which React makes before the one of the commit that ran the effect', async (t) => {
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.duringClick(() => {
      clock.now = 1010;
      commitAgain(root, 5);
      withEffects(root);
      existing.onCommitFiberRoot(id, root, 1, false);
      // An effect calls flushSync. React commits that update once the effects are done, and runs its
      // effects, before it says the first commit's ran.
      clock.now = 1200;
      commitAgain(root, 40);
      withEffects(root);
      existing.onCommitFiberRoot(id, root, 1, false);
      clock.now = 1210;
      page.window[HOOK].onPostCommitFiberRoot(id, root);
      clock.now = 1215;
      page.window[HOOK].onPostCommitFiberRoot(id, root);
    });
    assert.deepEqual(api.debug.commits().map((c) => [c.at, c.effectsEndedAt]), [[1010, 1215], [1200, 1210]]);
    api.dispose();
  });
});

test("after dispose() and another install(), a commit and its post-commit are read once where another tool wrapped the library's methods", async (t) => {
  // Fast Refresh wraps onCommitFiberRoot when it runs after the library, and dispose() leaves a method wrapped
  // since where it is. The next install() wraps the hook again, so the old methods sit under the new ones.
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    const id = existing.inject(reactDom('19.3.0'));
    const hook = page.window[HOOK];
    const commit = hook.onCommitFiberRoot;
    hook.onCommitFiberRoot = (...args: unknown[]) => {
      commit(...args);
      // The tool's own work on the commit, which React's effects wait for as well.
      clock.now += 2;
    };
    const postCommit = hook.onPostCommitFiberRoot;
    hook.onPostCommitFiberRoot = (...args: unknown[]) => postCommit(...args);
    api.dispose();

    const again = install({ hook: 'chain' });
    const root = mountedRoot(0b11, 4);
    hook.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.duringClick(() => {
      clock.now = 1010;
      commitAgain(root, 5);
      withEffects(root);
      hook.onCommitFiberRoot(id, root, 1, false);
      // An effect calls flushSync, and that commit's post-commit comes first.
      clock.now = 1200;
      commitAgain(root, 40);
      withEffects(root);
      hook.onCommitFiberRoot(id, root, 1, false);
      clock.now = 1210;
      hook.onPostCommitFiberRoot(id, root);
      clock.now = 1215;
      hook.onPostCommitFiberRoot(id, root);
    });
    // Each commit once, its effects from when the tool's work on it ended, and each post-commit to its own commit.
    assert.deepEqual(again.debug.commits().map((c) => [c.at, c.effectsStartedAt, c.effectsEndedAt]), [[1010, 1012, 1215], [1200, 1202, 1210]]);
    assert.deepEqual(existing.calls, [id, id, id], 'the hook it wrapped no longer hears about commits');
    again.dispose();
  });
});

test("a layout effect's update without effects of its own never takes the call for the commit it was made in", async (t) => {
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    const id = existing.inject(reactDom('18.3.1'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.duringClick(() => {
      clock.now = 1010;
      commitAgain(root, 5);
      withEffects(root);
      existing.onCommitFiberRoot(id, root, 1, false);
      // A layout effect measured something and set state. React renders that once the passive effects
      // are done and before it says so, and the update has no effects, so React makes no call for it.
      clock.now = 1250;
      commitAgain(root, 3);
      existing.onCommitFiberRoot(id, root, 1, false);
      clock.now = 1260;
      page.window[HOOK].onPostCommitFiberRoot(id, root);
    });
    assert.deepEqual(api.debug.commits().map((c) => [c.at, c.effectsEndedAt]), [[1010, 1260], [1250, null]]);
    api.dispose();
  });
});

test('a call React makes for a commit without effects passes to the commit it was made in, whose effects had ended by then', async (t) => {
  // A React 19 development build runs the passive phase for every commit it timed, effects or not.
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.duringClick(() => {
      clock.now = 1010;
      commitAgain(root, 5);
      withEffects(root);
      existing.onCommitFiberRoot(id, root, 1, false);
      clock.now = 1250;
      commitAgain(root, 3);
      existing.onCommitFiberRoot(id, root, 1, false);
      clock.now = 1255;
      page.window[HOOK].onPostCommitFiberRoot(id, root);
      clock.now = 1260;
      page.window[HOOK].onPostCommitFiberRoot(id, root);
    });
    assert.deepEqual(api.debug.commits().map((c) => [c.at, c.effectsEndedAt]), [[1010, 1255], [1250, null]]);
    api.dispose();
  });
});

test("a commit that was not walked keeps its place, so React's word about its effects never lands on an older commit", async (t) => {
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    // The click's call is held back here, to show the pairing alone.
    page.duringClick(() => {
      clock.now = 1010;
      commitAgain(root, 5);
      withEffects(root);
      existing.onCommitFiberRoot(id, root, 1, false);
    });
    // A poll commits long after the window closed. It is not walked, and its effects are its own.
    clock.now = 9000;
    commitAgain(root, 3);
    withEffects(root);
    existing.onCommitFiberRoot(id, root, 1, false);
    clock.now = 9100;
    page.window[HOOK].onPostCommitFiberRoot(id, root);
    assert.equal(api.debug.commits().length, 1);
    assert.equal(api.debug.commits()[0]?.effectsEndedAt, null);
    api.dispose();
  });
});

test("a root made with ReactDOM.render gets no effects' time, since React runs them whenever it next renders", async (t) => {
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    const id = existing.inject(reactDom('18.3.1'));
    const root = { ...mountedRoot(0b11, 4), tag: 0 };
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.duringClick(() => {
      clock.now = 1010;
      commitAgain(root, 5);
      withEffects(root);
      existing.onCommitFiberRoot(id, root, 1, false);
      clock.now = 1300;
      page.window[HOOK].onPostCommitFiberRoot(id, root);
    });
    assert.equal(api.debug.commits()[0]?.effectsEndedAt, null);
    api.dispose();
  });
});

test('a call that finds no commit React reports for clears the ones waiting, so none of them takes a later call', async (t) => {
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.duringClick(() => {
      // A React 19 development build calls for a commit without effects too, and nothing below it waits.
      clock.now = 1010;
      commitAgain(root, 5);
      existing.onCommitFiberRoot(id, root, 1, false);
      clock.now = 1020;
      page.window[HOOK].onPostCommitFiberRoot(id, root);
      clock.now = 1030;
      commitAgain(root, 5);
      withEffects(root);
      existing.onCommitFiberRoot(id, root, 1, false);
      clock.now = 1100;
      page.window[HOOK].onPostCommitFiberRoot(id, root);
      clock.now = 1200;
      page.window[HOOK].onPostCommitFiberRoot(id, root);
    });
    assert.deepEqual(api.debug.commits().map((c) => [c.at, c.effectsEndedAt]), [[1010, null], [1030, 1100]]);
    api.dispose();
  });
});

test("under the shim, too, the effects' time starts once the hook call returned, after the walk", async (t) => {
  // Every reading moves the clock on a little, so the walk takes time and its end is not its start.
  let now = 0;
  t.mock.method(performance, 'now', () => (now += 0.25));
  await inBrowser((page) => {
    const api = install();
    const shim = page.window[HOOK];
    const id = shim.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    shim.onCommitFiberRoot(id, root);
    now = 1000;
    page.duringClick(() => {
      now = 1010;
      commitAgain(root, 5);
      withEffects(root);
      shim.onCommitFiberRoot(id, root, 1, false);
      now = 1300;
      shim.onPostCommitFiberRoot(id, root);
    });
    assert.equal(api.stats().mode, 'shim');
    const [commit] = api.debug.commits();
    assert.ok(commit && commit.walkMs > 0 && commit.effectsStartedAt !== null && commit.effectsEndedAt !== null);
    assert.ok(commit.effectsStartedAt >= commit.at + commit.walkMs, `${commit.effectsStartedAt} is before the walk ended`);
    assert.ok(commit.effectsEndedAt > 1300);
    api.dispose();
  });
});

test('an inputWindow over 1.5 s reaches the report: a render the hook walks under it joins as a later render', async (t) => {
  // The report used to take a later render only within a fixed 1.5 s of the paint, so a longer window
  // paid for the walk and the render still never reached the report.
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 3000, devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    clock.now = 1000;
    page.duringClick(() => existing.onCommitFiberRoot(id, root));
    page.paint([click(7, 1000, 120)]);
    assert.equal(api.last()?.revision, 0);
    // Data comes back and React renders it 2 s after the paint.
    clock.now = 3120;
    commitAgain(root, 40);
    existing.onCommitFiberRoot(id, root);
    assert.equal(api.debug.commits().length, 2);
    assert.equal(api.last()?.revision, 1);
    assert.deepEqual(api.last()?.followUps.map((c) => c.at), [3120]);
    api.dispose();
  });
});

/** A trusted input handed to the window's capture listener at `timeStamp`, and, given `render`, a commit inside its dispatch 9 ms later. */
function inputOn(page: Page, clock: { now: number }, commit: (ms: number) => void) {
  return (type: string, timeStamp: number, fields: Record<string, unknown>, render?: number) => {
    clock.now = timeStamp;
    const event = { isTrusted: true, type, timeStamp, target: null, ...fields };
    page.fire(type, event);
    if (render === undefined) return;
    page.window.event = event;
    clock.now = timeStamp + 9;
    commit(render);
    delete page.window.event;
  };
}

test('a key or a finger let go pairs with its own press, not the newest one, when keys roll over or two fingers are down', async (t) => {
  // A fast typist presses H before letting go of T. Paired with the newest press, T's keyup would take H's
  // keydown, and the render T's keyup made would carry H's stamp, as if H had made it. Two fingers on a touch
  // screen, the first lifted while the second is still down, are the same by pointerId.
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    const input = inputOn(page, clock, (ms) => {
      commitAgain(root, ms);
      existing.onCommitFiberRoot(id, root, 1, false);
    });

    input('keydown', 10000, { code: 'KeyT' });
    await nextTask();
    input('keydown', 10030, { code: 'KeyH' });
    await nextTask();
    input('keyup', 10060, { code: 'KeyT' }, 20);
    await nextTask();
    input('keyup', 10090, { code: 'KeyH' }, 20);
    await nextTask();
    input('pointerdown', 11000, { pointerId: 3, pointerType: 'touch' });
    await nextTask();
    input('pointerdown', 11020, { pointerId: 4, pointerType: 'touch' });
    await nextTask();
    input('pointerup', 11050, { pointerId: 3, pointerType: 'touch' }, 20);
    await nextTask();
    assert.deepEqual(
      api.debug.commits().map((c) => ({ input: c.inputTs, gesture: c.gestureTs })),
      [
        { input: 10060, gesture: 10000 },
        { input: 10090, gesture: 10030 },
        { input: 11050, gesture: 11000 },
      ],
    );
    api.dispose();
  });
});

test('a click made from the keyboard is part of its key press, so its render never joins the mouse click before it', async (t) => {
  // A mouse click on a button, then Enter on the button it left focused, 800 ms after the click's paint.
  // The click Enter makes has no pointerdown (its pointerId is -1). It used to take the newest pointerdown
  // within 5 s as its press, the mouse click's, so its render carried that stamp and joined the mouse
  // click's report as a later render, well inside the window from its paint.
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    const input = inputOn(page, clock, (ms) => {
      commitAgain(root, ms);
      existing.onCommitFiberRoot(id, root, 1, false);
    });

    input('pointerdown', 1000, { pointerId: 1 });
    input('pointerup', 1060, { pointerId: 1 });
    input('click', 1061, { pointerId: 1 }, 40);
    page.paint([pointer('pointerdown', 7, 1000, 24), click(7, 1061, 120)]);
    await nextTask();

    input('keydown', 2000, { code: 'Enter' });
    input('click', 2001, { pointerId: -1 }, 40);
    await nextTask();
    assert.deepEqual(
      api.reports().map((r) => ({ id: r.interactionId, revision: r.revision, laterRenders: r.followUps.map((c) => c.at) })),
      [{ id: 7, revision: 0, laterRenders: [] }],
    );
    assert.equal(api.debug.commits().at(-1)?.gestureTs, 2000, "the keyboard click's render is not stamped with the Enter that made it");

    page.paint([pointer('keydown', 8, 2000, 120), click(8, 2001, 119)]);
    assert.deepEqual(api.last()?.commits.map((c) => c.at), [2010]);
    api.dispose();
  });
});

test('Space makes its click on the key coming up, and a click with no key or pointer behind it is a gesture of its own', async (t) => {
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    const input = inputOn(page, clock, (ms) => {
      commitAgain(root, ms);
      existing.onCommitFiberRoot(id, root, 1, false);
    });

    input('pointerdown', 1000, { pointerId: 1 });
    input('pointerup', 1060, { pointerId: 1 });
    input('click', 1061, { pointerId: 1 }, 40);
    await nextTask();
    input('keydown', 1500, { code: 'Space' });
    await nextTask();
    input('keyup', 1580, { code: 'Space' });
    input('click', 1581, { pointerId: -1 }, 40);
    await nextTask();
    // A click with no key or pointer behind it.
    input('click', 1900, { pointerId: -1 }, 40);
    await nextTask();
    assert.deepEqual(
      api.debug.commits().map((c) => ({ input: c.inputTs, gesture: c.gestureTs })),
      [
        { input: 1061, gesture: 1000 },
        { input: 1581, gesture: 1500 },
        { input: 1900, gesture: 1900 },
      ],
    );
    api.dispose();
  });
});

test("a click takes the press of the input whose task made it, whatever its pointerId says, unless it is a tap's", async (t) => {
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    const input = inputOn(page, clock, (ms) => {
      commitAgain(root, ms);
      existing.onCommitFiberRoot(id, root, 1, false);
    });

    // A mouse click on a label, which forwards a click of its own to its checkbox in the same task. Where
    // the forwarded click has pointerId -1, it is still the mouse press.
    input('pointerdown', 1000, { pointerId: 1 });
    await nextTask();
    input('pointerup', 1060, { pointerId: 1 });
    input('click', 1061, { pointerId: 1 });
    input('click', 1062, { pointerId: -1 }, 40);
    await nextTask();
    // Enter's click carrying the mouse's pointerId, which pairing by pointerId would give to the mouse press.
    input('keydown', 2000, { code: 'Enter' });
    input('click', 2001, { pointerId: 1 }, 40);
    await nextTask();
    // A tap whose click comes in a task of its own after the touchend, with a key pressed in between whose
    // task marker has not been cleared yet. The click is still the tap's.
    input('pointerdown', 3000, { pointerId: 2, pointerType: 'touch' });
    await nextTask();
    input('pointerup', 3080, { pointerId: 2, pointerType: 'touch' });
    await nextTask();
    input('keydown', 3082, { code: 'ShiftLeft' });
    input('click', 3083, { pointerId: 2, pointerType: 'touch' }, 40);
    await nextTask();
    // A mouse press let go with no click, as a drag or a right click is, then Enter's click carrying the
    // mouse's pointerId. The mouse press is not waiting for a click, so the click is still Enter's.
    input('pointerdown', 4000, { pointerId: 1, pointerType: 'mouse' });
    await nextTask();
    input('pointerup', 4060, { pointerId: 1, pointerType: 'mouse' });
    await nextTask();
    input('keydown', 4500, { code: 'Enter' });
    input('click', 4501, { pointerId: 1, pointerType: 'mouse' }, 40);
    await nextTask();
    // Two fingers: one tapped and has had its click, and the other is still down. Enter's click carrying the
    // first finger's pointerId is still Enter's. The finger that tapped is not waiting for a click, and the one
    // that is has another pointerId.
    input('pointerdown', 6000, { pointerId: 6, pointerType: 'touch' });
    await nextTask();
    input('pointerup', 6050, { pointerId: 6, pointerType: 'touch' });
    await nextTask();
    input('click', 6052, { pointerId: 6, pointerType: 'touch' });
    await nextTask();
    input('pointerdown', 6100, { pointerId: 5, pointerType: 'touch' });
    await nextTask();
    input('keydown', 6200, { code: 'Enter' });
    input('click', 6201, { pointerId: 6, pointerType: 'touch' }, 40);
    await nextTask();
    assert.deepEqual(
      api.debug.commits().map((c) => ({ input: c.inputTs, gesture: c.gestureTs })),
      [
        { input: 1062, gesture: 1000 },
        { input: 2001, gesture: 2000 },
        { input: 3083, gesture: 3000 },
        { input: 4501, gesture: 4500 },
        { input: 6201, gesture: 6200 },
      ],
    );
    api.dispose();
  });
});

test('a report whose interaction had commits it could not be joined to says so, and no longer reads as measured', async (t) => {
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500, threshold: 40 });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 1000, target: null });
    // A commit long after the click's own work, with nothing tying it to the click.
    clock.now = 4000;
    commitAgain(root, 300);
    existing.onCommitFiberRoot(id, root, 1, false);
    assert.equal(api.debug.commits().length, 0);

    page.paint([click(7, 1000, 3200)]);
    const r = api.last();
    assert.ok(r);
    assert.equal(r.commits.length, 0);
    assert.equal(r.unjoinedCommits, 1);
    // Never "React didn't render anything", and never measured: React did render.
    assert.doesNotMatch(r.explanation.cause, /didn't render anything/);
    assert.match(r.explanation.cause, /could not be tied to this click/);
    assert.equal(r.explanation.blame.confidence, 'inferred');
    assert.ok(r.explanation.notes.some((note) => note.includes('could not be tied to it')));
    api.dispose();
  });
});

test("a commit inside a derived event's dispatch is the input that caused it, which is how typing gets its render", async (t) => {
  // React's onChange for a text field runs during the native `input` event, not during the keydown, so
  // `window.event` there is an `input`. Read as nothing, the keystroke's own render looked like an
  // unrelated commit and a 2.7 s render joined nothing at all.
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500 });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.fire('keydown', { isTrusted: true, type: 'keydown', timeStamp: 1000, target: null, code: 'KeyA' });
    // The browser dispatches `input` inside the keydown; React commits from its onChange.
    page.window.event = { isTrusted: true, type: 'input', timeStamp: 1002, target: FIELD };
    clock.now = 3800;
    commitAgain(root, 2700);
    existing.onCommitFiberRoot(id, root, 1, false);
    delete page.window.event;
    const commits = api.debug.commits();
    assert.equal(commits.length, 1);
    assert.equal(commits[0]?.inputTs, 1000);
    assert.equal(commits[0]?.inputType, 'keydown');
    // A `change` fired by script is not a user's input, and nothing of the sort joins the key press.
    page.window.event = { isTrusted: false, type: 'change', timeStamp: 4000, target: null };
    clock.now = 6000;
    commitAgain(root, 5);
    existing.onCommitFiberRoot(id, root, 1, false);
    delete page.window.event;
    assert.equal(api.debug.commits().length, 1);
    api.dispose();
  });
});

test('a change the browser fires long after its click, a file chosen in the system dialog, is not the click\'s work, so a quick click stays unreported', async (t) => {
  // The click opens the file dialog and paints in 24 ms. The browser fires a trusted `change` once a
  // file is chosen, 20 s later, and React renders the preview. Read as the click's own dispatch, that
  // render joined the click as a later render and published a report for a click nobody waited on.
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500, threshold: 40, devtoolsTrack: false });
    const heard: InteractionReport[] = [];
    const stop = onInteraction((r) => heard.push(r));
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 1000, target: null });
    page.duringClick(() => {
      clock.now = 1003;
      commitAgain(root, 1);
      existing.onCommitFiberRoot(id, root, 1, false);
    });
    page.paint([click(7, 1000, 24)]);
    await nextTask();
    clock.now = 21000;
    page.window.event = { isTrusted: true, type: 'change', timeStamp: 21000, target: FIELD };
    commitAgain(root, 60);
    existing.onCommitFiberRoot(id, root, 1, false);
    delete page.window.event;
    await nextTask();
    assert.deepEqual(api.reports(), []);
    assert.deepEqual(heard, []);
    assert.equal(api.debug.commits().length, 1);
    stop();
    api.dispose();
  });
});

test('a report keeps revision 0 when a change arrives long after its click, and the change does not reopen the window for what follows it', async (t) => {
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500, threshold: 40, devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 1000, target: null });
    page.duringClick(() => {
      clock.now = 1100;
      commitAgain(root, 90);
      existing.onCommitFiberRoot(id, root, 1, false);
    });
    page.paint([click(7, 1000, 120)]);
    assert.equal(api.last()?.revision, 0);
    await nextTask();
    // A choice from a native select's popup, 20 s on, then an effect of the render it made.
    clock.now = 21000;
    page.window.event = { isTrusted: true, type: 'change', timeStamp: 21000, target: FIELD };
    commitAgain(root, 30);
    existing.onCommitFiberRoot(id, root, 1, false);
    delete page.window.event;
    clock.now = 21200;
    commitAgain(root, 30);
    existing.onCommitFiberRoot(id, root, 1, false);
    assert.equal(api.debug.commits().length, 1);
    assert.equal(api.last()?.revision, 0);
    assert.deepEqual(api.last()?.followUps, []);
    api.dispose();
  });
});

test('a change 1 s after its click still joins it as a later render, measured from when the change was fired and not from when its render ended', async (t) => {
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500, threshold: 40, devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 1000, target: null });
    page.duringClick(() => {
      clock.now = 1003;
      commitAgain(root, 1);
      existing.onCommitFiberRoot(id, root, 1, false);
    });
    page.paint([click(7, 1000, 120)]);
    await nextTask();
    // An option picked from a native select a second after the click that opened it. Its render takes
    // 600 ms, so it ends 1.6 s after the click's own work, and the change itself came well inside the window.
    // The browser fired it, so the capture listener that hears it first takes it for no newer input.
    const change = { isTrusted: true, type: 'change', timeStamp: 2000, target: FIELD };
    page.fire('change', change);
    page.window.event = change;
    clock.now = 2600;
    commitAgain(root, 600);
    existing.onCommitFiberRoot(id, root, 1, false);
    delete page.window.event;
    assert.equal(api.last()?.revision, 1);
    assert.deepEqual(api.last()?.followUps.map((c) => c.at), [2600]);
    // The change came in a task of its own, so its render is outside the click's entry.
    assert.deepEqual(api.debug.commits().map((c) => c.inDispatch), [true, false]);
    api.dispose();
  });
});

test("an input a script fires from the change the browser handed to the click is part of that change, and one on its own is not", async (t) => {
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500, threshold: 40, devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 1000, target: null });
    page.duringClick(() => {
      clock.now = 1003;
      commitAgain(root, 1);
      existing.onCommitFiberRoot(id, root, 1, false);
    });
    page.paint([click(7, 1000, 120)]);
    await nextTask();
    // An option picked from the select the click opened, and the select's onChange firing `input` on
    // another field in the same task, the way a form library keeps a second control in step.
    const change = { isTrusted: true, type: 'change', timeStamp: 2000, target: FIELD };
    page.fire('change', change);
    page.window.event = change;
    page.fire('input', { isTrusted: false, type: 'input', timeStamp: 2000.5, target: FIELD });
    clock.now = 2600;
    commitAgain(root, 600);
    existing.onCommitFiberRoot(id, root, 1, false);
    delete page.window.event;
    assert.deepEqual(api.last()?.followUps.map((c) => c.at), [2600]);
    // Once that task is over, one a script fires with nothing trusted behind it is something new.
    await nextTask();
    page.fire('change', { isTrusted: false, type: 'change', timeStamp: 3000, target: FIELD });
    clock.now = 3100;
    commitAgain(root, 50);
    existing.onCommitFiberRoot(id, root, 3, false);
    assert.deepEqual(api.debug.commits().map((c) => c.at), [1003, 2600, 3100]);
    assert.deepEqual(api.last()?.followUps.map((c) => c.at), [2600]);
    api.dispose();
  });
});

/**
 * A pointerdown at 1000 that paints after `pressMs`, then its pointerup at 1060, which renders in its own
 * dispatch at 1070, and its effects rendering at 1400. `before` runs once the press has painted and
 * `inside` in the pointerup's task. Returns what was published and what the hook made of the two renders.
 */
async function heldRelease(t: TestContext, pressMs: number, before: (page: Page) => void, inside: (page: Page) => void) {
  const clock = useClock(t);
  let result = { published: [] as number[], followUps: [] as number[], inDispatch: [] as (boolean | undefined)[] };
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500, threshold: 40, devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.fire('pointerdown', { isTrusted: true, type: 'pointerdown', timeStamp: 1000, target: null, pointerId: 1 });
    page.paint([pointer('pointerdown', 7, 1000, pressMs)]);
    await nextTask();
    before(page);
    clock.now = 1060;
    const up = { isTrusted: true, type: 'pointerup', timeStamp: 1060, target: null, pointerId: 1 };
    page.fire('pointerup', up);
    inside(page);
    page.window.event = up;
    clock.now = 1070;
    commitAgain(root, 20);
    existing.onCommitFiberRoot(id, root, 1, false);
    delete page.window.event;
    await nextTask();
    clock.now = 1400;
    commitAgain(root, 60);
    existing.onCommitFiberRoot(id, root, 3, false);
    result = { published: api.reports().map((r) => r.interactionId), followUps: (api.last()?.followUps ?? []).map((c) => c.at), inDispatch: api.debug.commits().map((c) => c.inDispatch) };
    api.dispose();
  });
  return result;
}

/** A `change` a script dispatches at `timeStamp`, with no trusted event behind it. */
const scriptedChange = (timeStamp: number) => (page: Page) => page.fire('change', { isTrusted: false, type: 'change', timeStamp, target: FIELD });

test("a change a script fires in a held press's release task closes nothing the release renders", async (t) => {
  // A 32 ms press stays quiet through its release's own render, and the render after it publishes it.
  assert.deepEqual(await heldRelease(t, 32, () => {}, scriptedChange(1062)), { published: [7], followUps: [1070, 1400], inDispatch: [true, false] });
});

test('a change a script fires after a held press painted and before its release closes nothing the release renders', async (t) => {
  // A 48 ms press is published at its paint, 1048, and the change comes before the pointerup at 1060.
  assert.deepEqual(await heldRelease(t, 48, scriptedChange(1050), () => {}), { published: [7], followUps: [1070, 1400], inDispatch: [true, false] });
});

test('text that arrives with no key pressed, one input event a second after a click, stops joining the click once it passes the window', async (t) => {
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500, threshold: 40, devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 1000, target: null });
    page.duringClick(() => {
      clock.now = 1003;
      commitAgain(root, 1);
      existing.onCommitFiberRoot(id, root, 1, false);
    });
    page.paint([click(7, 1000, 120)]);
    await nextTask();
    // Dictation into the field the click focused: a trusted input event a second, each rendering, and no
    // keydown between them to start an interaction of their own. Were each to carry the window forward
    // from its own render, the stream would join the click for as long as it ran.
    for (const at of [2000, 3000, 4000, 5000]) {
      const typed = { isTrusted: true, type: 'input', timeStamp: at, target: FIELD };
      page.fire('input', typed);
      page.window.event = typed;
      clock.now = at + 10;
      commitAgain(root, 10);
      existing.onCommitFiberRoot(id, root, 1, false);
      delete page.window.event;
    }
    assert.deepEqual(api.last()?.followUps.map((c) => c.at), [2010, 3010]);
    assert.deepEqual(api.debug.commits().map((c) => c.at), [1003, 2010, 3010]);
    api.dispose();
  });
});

test("a click or a key a script dispatches is not taken for the user's input, so a render after it is still the click's before it", async (t) => {
  // A page that calls el.click() or dispatchEvent() from code: analytics, a focus trap, a test harness left in.
  // The event has no Event Timing entry. Taken for the newest input, it would stamp the renders after it with an
  // input no report has, and the click's report would lose them. It is the same for a render React makes
  // inside the script's dispatch: flushSync in a handler, el.click() on a controlled checkbox, a legacy root.
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    const commit = (at: number) => {
      clock.now = at;
      commitAgain(root, 40);
      existing.onCommitFiberRoot(id, root, 1, false);
    };
    clock.now = 1000;
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 1000, target: null });
    page.duringClick(() => commit(1010));
    await nextTask();
    const click = { isTrusted: false, type: 'click', timeStamp: 1100, target: null, pointerId: -1 };
    page.fire('click', click);
    page.window.event = click;
    commit(1110);
    delete page.window.event;
    commit(1120);
    await nextTask();
    const key = { isTrusted: false, type: 'keydown', timeStamp: 1200, target: null, code: 'KeyA' };
    page.fire('keydown', key);
    page.window.event = key;
    commit(1210);
    delete page.window.event;
    commit(1220);
    assert.deepEqual(api.debug.commits().map((c) => c.inputTs), [1000, 1000, 1000, 1000, 1000]);
    api.dispose();
  });
});

test('a render after an input or change a script dispatched does not join the click before it, as a page size Playwright picked did', async (t) => {
  // Sorting a table by a click, then picking a page size a second later with Playwright's selectOption,
  // which fires `input` and `change` from script. No pointer or key goes down, so the ring's newest input
  // stays the sort click, and the page-size render joined it as its later render.
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500, threshold: 40, devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    const commit = (at: number, priority: number) => {
      clock.now = at;
      commitAgain(root, 200);
      existing.onCommitFiberRoot(id, root, priority, false);
    };
    const scripted = (type: string, timeStamp: number) => ({ isTrusted: false, type, timeStamp, target: FIELD });
    clock.now = 1000;
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 1000, target: null });
    // One the click's own handler dispatches, in its task, is part of the click.
    page.fire('change', scripted('change', 1001));
    page.duringClick(() => commit(1100, 1));
    page.paint([click(7, 1000, 120)]);
    await nextTask();
    // An effect of the sort after its paint is its later render.
    commit(1420, 3);
    page.fire('input', scripted('input', 2000));
    page.fire('change', scripted('change', 2000));
    page.window.event = scripted('change', 2000);
    commit(2020, 1);
    delete page.window.event;
    await nextTask();
    assert.deepEqual(
      api.debug.commits().map((c) => [c.at, c.inDispatch]),
      [
        [1100, true],
        [1420, false],
        [2020, false],
      ],
    );
    assert.deepEqual(api.last()?.followUps.map((c) => c.at), [1420]);
    api.dispose();
  });
});

/**
 * A click at 1000 whose own render lands inside it, painted at 1120 and reported; then `after` runs a
 * second on, in a task of its own. Returns what the report and the hook made of it.
 */
async function clickThen(
  t: TestContext,
  after: (page: Page, commit: (at: number, priority?: number | null) => void) => void,
  version = '19.3.0',
): Promise<{ followUps: number[]; walked: number[]; unjoined: number }> {
  const clock = useClock(t);
  let result = { followUps: [] as number[], walked: [] as number[], unjoined: -1 };
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    page.window.innerWidth = 1280;
    const api = install({ hook: 'chain', inputWindow: 1500, threshold: 40, devtoolsTrack: false });
    const id = existing.inject(reactDom(version));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 1000, target: null });
    page.duringClick(() => {
      clock.now = 1003;
      commitAgain(root, 1);
      existing.onCommitFiberRoot(id, root, 1, false);
    });
    page.paint([click(7, 1000, 120)]);
    await nextTask();
    // A commit at normal priority unless the case says otherwise; null for a production build's none.
    after(page, (at, priority = 3) => {
      clock.now = at;
      commitAgain(root, 200);
      existing.onCommitFiberRoot(id, root, priority ?? undefined, false);
    });
    await nextTask();
    result = { followUps: (api.last()?.followUps ?? []).map((c) => c.at), walked: api.debug.commits().map((c) => c.at), unjoined: api.last()?.unjoinedCommits ?? -1 };
    api.dispose();
  });
  return result;
}

test("a render a media query hook makes when the window crosses a breakpoint is not the last click's", async (t) => {
  // useMediaQuery subscribes to a MediaQueryList, whose `change` React treats as discrete and renders
  // inside. Read as a derived event of the click, 400 components re-rendering at the breakpoint became
  // the click's second render.
  const mediaQuery = { matches: false, media: '(min-width: 600px)' };
  const r = await clickThen(t, (page, commit) => {
    page.window.event = { isTrusted: true, type: 'change', timeStamp: 1400, target: mediaQuery };
    commit(1600, 1);
    delete page.window.event;
  });
  assert.deepEqual(r, { followUps: [], walked: [1003], unjoined: 0 });
});

test('a render inside a resize, scroll or hover event is not the last click\'s, and neither is one a window focus causes', async (t) => {
  const ambient = ['scroll', 'scrollend', 'wheel', 'visibilitychange', 'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'touchmove'];
  for (const [type, target] of [['resize', null] as const, ...ambient.map((type) => [type, FIELD] as const)]) {
    const r = await clickThen(t, (page, commit) => {
      page.window.event = { isTrusted: true, type, timeStamp: 1400, target };
      commit(1450, 1);
      delete page.window.event;
    });
    assert.deepEqual(r, { followUps: [], walked: [1003], unjoined: 0 }, type);
  }
  for (const type of ['focus', 'blur']) {
    const focused = await clickThen(t, (page, commit) => {
      page.window.event = { isTrusted: true, type, timeStamp: 1400, target: page.window };
      commit(1450, 1);
      delete page.window.event;
    });
    assert.deepEqual(focused.followUps, [], type);
  }
  // An element taking focus is not the window, and its render still joins.
  const field = await clickThen(t, (page, commit) => {
    page.window.event = { isTrusted: true, type: 'focus', timeStamp: 1400, target: FIELD };
    commit(1450, 1);
    delete page.window.event;
  });
  assert.deepEqual(field.followUps, [1450]);
  // One made by a script is not the browser's, and joins as any commit outside an event does.
  const scripted = await clickThen(t, (page, commit) => {
    page.window.event = { isTrusted: false, type: 'resize', timeStamp: 1400, target: null };
    commit(1450, 3);
    delete page.window.event;
  });
  assert.deepEqual(scripted.followUps, [1450]);
});

test('a hover inside the input\'s own task is still the input\'s: a tap\'s mouse events come in the tap\'s task', async (t) => {
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500, threshold: 40, devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.fire('pointerup', { isTrusted: true, type: 'pointerup', timeStamp: 1000, target: null, pointerType: 'touch' });
    // The compatibility mouseover a touch sends, in the same task as the pointerup.
    page.window.event = { isTrusted: true, type: 'mouseover', timeStamp: 1001, target: FIELD };
    clock.now = 1040;
    commitAgain(root, 30);
    existing.onCommitFiberRoot(id, root, 1, false);
    delete page.window.event;
    assert.deepEqual(api.debug.commits().map((c) => c.inputType), ['pointerup']);
    api.dispose();
  });
});

test('a render after the window changed width is not the last click\'s, and one after only its height changed still is', async (t) => {
  // A resize hook that debounces renders in a timer of its own, where there is no event to read.
  const wider = await clickThen(t, (page, commit) => {
    page.window.innerWidth = 400;
    page.fire('resize', { isTrusted: true, type: 'resize', timeStamp: 1400, target: null });
    commit(1600);
  });
  assert.deepEqual(wider, { followUps: [], walked: [1003], unjoined: 0 });
  // A phone's keyboard opening after a tap on a field changes the height alone.
  const taller = await clickThen(t, (page, commit) => {
    page.fire('resize', { isTrusted: true, type: 'resize', timeStamp: 1400, target: null });
    commit(1600);
  });
  assert.deepEqual(taller.followUps, [1600]);
});

test("React 19's user-blocking priority marks a hover's or a scroll's render, outside any input's dispatch", async (t) => {
  // React 19 renders continuous-event work in a task of its own, where window.event is empty, and passes
  // the hook (development and profiling builds) the priority of the lanes it rendered.
  const hover = await clickThen(t, (_page, commit) => commit(1400, 2));
  assert.deepEqual(hover, { followUps: [], walked: [1003], unjoined: 0 });
  const effect = await clickThen(t, (_page, commit) => commit(1400, 3));
  assert.deepEqual(effect.followUps, [1400]);
  // Production builds pass no priority, and the render joins as before.
  const production = await clickThen(t, (_page, commit) => commit(1400, null));
  assert.deepEqual(production.followUps, [1400]);
  // React 18 and 19.0 pass the priority of the moment they commit, not of what they rendered, so they say
  // nothing here.
  for (const version of ['18.3.1', '19.0.0']) {
    const moment = await clickThen(t, (_page, commit) => commit(1400, 2), version);
    assert.deepEqual(moment.followUps, [1400], version);
  }
  assert.deepEqual((await clickThen(t, (_page, commit) => commit(1400, 2), '19.1.0')).followUps, []);
});

test("a tap's own hover render, committed at user-blocking priority, is the tap's", async (t) => {
  // A touch fires pointerover and pointerenter of its own, and React 19 renders their updates in a task of
  // its own at user-blocking priority, before or after the tap's task has ended.
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500, threshold: 40, devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.fire('pointerup', { isTrusted: true, type: 'pointerup', timeStamp: 1000, target: null, pointerType: 'touch' });
    clock.now = 1140;
    commitAgain(root, 30);
    existing.onCommitFiberRoot(id, root, 2, false);
    assert.deepEqual(api.debug.commits().map((c) => c.inputType), ['pointerup']);
    // Or after it: a finger hovers over nothing, so behind a touch the priority is the tap's hover events'.
    await nextTask();
    clock.now = 1300;
    commitAgain(root, 30);
    existing.onCommitFiberRoot(id, root, 2, false);
    assert.equal(api.debug.commits().length, 2);
    // Behind a mouse click, once its task is over, the same priority is a hover's of its own.
    clock.now = 2000;
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 2000, target: null, pointerType: 'mouse' });
    await nextTask();
    clock.now = 2400;
    commitAgain(root, 30);
    existing.onCommitFiberRoot(id, root, 2, false);
    assert.equal(api.debug.commits().length, 2);
    api.dispose();
  });
});

test('a submit fired in its click\'s own task is the click\'s work however long the click\'s handler ran first', async (t) => {
  // A submit button's click handler validates for 2 s and commits nothing, then the browser submits the
  // form in the same task and React renders from onSubmit. The submit comes past the window measured
  // from the click, but nothing else can have run in between.
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500 });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 1000, target: null });
    page.window.event = { isTrusted: true, type: 'submit', timeStamp: 3000, target: FIELD };
    clock.now = 3050;
    commitAgain(root, 50);
    existing.onCommitFiberRoot(id, root, 1, false);
    delete page.window.event;
    assert.equal(api.debug.commits().length, 1);
    assert.equal(api.debug.commits()[0]?.inputTs, 1000);
    assert.equal(api.debug.commits()[0]?.inputType, 'click');
    api.dispose();
  });
});

test('a commit from a clock elsewhere on the page is not counted against the interaction it happened to follow', async (t) => {
  // A page with a clock in it commits once a second, all day. Holding a button for four seconds used to
  // report "3 commits could not be tied to this click" on what was an honest, fast, fully measured
  // click. Only a commit that ran while the interaction's own handlers were running says anything
  // about it, and the Event Timing entries are what say when that was.
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500, threshold: 40 });
    const id = existing.inject(reactDom('19.3.0'));
    const root = mountedRoot(0b11, 4);
    existing.onCommitFiberRoot(id, root);
    clock.now = 1000;
    page.fire('pointerdown', { isTrusted: true, type: 'pointerdown', timeStamp: 1000, target: null });
    // Three ticks of the clock while the button is held, none of them inside a dispatch.
    for (const at of [2600, 3600, 4600]) {
      clock.now = at;
      commitAgain(root, 3);
      existing.onCommitFiberRoot(id, root, 1, false);
    }
    clock.now = 5000;
    page.fire('pointerup', { isTrusted: true, type: 'pointerup', timeStamp: 5000, target: null });
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 5001, target: null });
    page.paint([pointer('pointerdown', 7, 1000, 60), pointer('pointerup', 7, 5000, 90), click(7, 5001, 90)]);
    const r = api.last();
    assert.ok(r);
    assert.equal(r.unjoinedCommits, 0);
    assert.equal(r.explanation.blame.confidence, 'measured');
    assert.match(r.explanation.cause, /didn't render anything/);
    assert.equal(r.explanation.notes.some((note) => note.includes('could not be tied to it')), false);
    api.dispose();
  }, { entryTypes: ['event', 'first-input', 'long-animation-frame'] });
});

test("Next.js's dev overlay is left out of every report: a root on its nextjs-portal element, whatever React it runs", async (t) => {
  // Under `next dev` the overlay renders with a production react-dom that Next.js bundles into it, at the
  // same version as the app's. On 15.5 under Turbopack it committed inside every click, and the report
  // named its minified components and lost the render time: React never timed the overlay's commit.
  const clock = useClock(t);
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', inputWindow: 1500, threshold: 40 });
    const app = existing.inject(reactDom('19.3.0-canary-cbb046ab-20260731'));
    const devTools = existing.inject(reactDom('19.3.0-canary-cbb046ab-20260731', 0));
    const onDocument = { ...mountedRoot(0b11, 4), containerInfo: { nodeType: 9, nodeName: '#document' } };
    const onPortal = { ...mountedRoot(0b01, undefined), containerInfo: { nodeType: 1, nodeName: 'NEXTJS-PORTAL', localName: 'nextjs-portal' } };
    existing.onCommitFiberRoot(app, onDocument);
    existing.onCommitFiberRoot(devTools, onPortal);

    clock.now = 1000;
    const clicked = page.duringClick(() => {
      clock.now = 1005;
      commitAgain(onPortal, undefined);
      existing.onCommitFiberRoot(devTools, onPortal);
      clock.now = 1400;
      commitAgain(onDocument, 380);
      existing.onCommitFiberRoot(app, onDocument, 1, false);
    });
    // After the paint, a message from the dev server re-renders the overlay inside the click's window.
    clock.now = 1600;
    commitAgain(onPortal, undefined);
    existing.onCommitFiberRoot(devTools, onPortal);
    assert.equal(api.debug.commits().length, 1, "the overlay's commits were walked");

    page.paint([click(7, clicked, 420)]);
    const r = api.last();
    assert.ok(r);
    assert.deepEqual(r.commits.map((c) => [c.hasDurations, c.total]), [[true, 380]]);
    assert.equal(r.followUps.length, 0);
    assert.equal(r.unjoinedCommits, 0);
    assert.equal(r.explanation.blame.confidence, 'measured');
    assert.equal(attributeINP({ entries: [{ interactionId: 7 }] }).react?.commits.ms, 380);

    // A root of the app's own on a production react-dom is read as before, without durations.
    const widget = existing.inject(reactDom('19.3.0', 0));
    const island = { ...mountedRoot(0b01, undefined), containerInfo: { nodeType: 1, nodeName: 'DIV', localName: 'div' } };
    existing.onCommitFiberRoot(widget, island);
    clock.now = 3000;
    page.duringClick(() => {
      commitAgain(island, undefined);
      existing.onCommitFiberRoot(widget, island);
    });
    assert.deepEqual(api.debug.commits().map((c) => c.hasDurations), [true, false]);
    api.dispose();
  });
});

test("the dev overlay's own react-dom does not keep a page supported whose app React cannot be read", async (t) => {
  // The overlay's react-dom is never read, so it is not a react-dom the page could still be read through.
  // Its React is the app's version, so a React that moved a field fails the app's shape check alone.
  const warn = t.mock.method(console, 'warn', () => {});
  await inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    const app = existing.inject(reactDom('19.3.0'));
    const devTools = existing.inject(reactDom('19.3.0', 0));
    const onPortal = { ...mountedRoot(0b01, undefined), containerInfo: { nodeType: 1, nodeName: 'NEXTJS-PORTAL', localName: 'nextjs-portal' } };
    delete onPortal.current.flags;
    existing.onCommitFiberRoot(devTools, onPortal);
    assert.equal(api.stats().mode, 'chained', 'the app has not committed yet');

    const onDocument = { ...mountedRoot(0b11, 4), containerInfo: { nodeType: 9, nodeName: '#document' } };
    delete onDocument.current.flags;
    page.duringClick(() => existing.onCommitFiberRoot(app, onDocument));
    assert.deepEqual({ mode: api.stats().mode, kind: api.stats().unsupportedReason?.kind }, { mode: 'unsupported', kind: 'fiber-shape' });
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /react-dom 19\.3\.0 is not the shape/);

    // Were the overlay's react-dom to render a root of the app's, it would be read like any other.
    existing.onCommitFiberRoot(devTools, { ...mountedRoot(0b01, undefined), containerInfo: { nodeType: 1, nodeName: 'DIV', localName: 'div' } });
    assert.deepEqual({ mode: api.stats().mode, reason: api.stats().unsupportedReason }, { mode: 'chained', reason: null });
    api.dispose();
  });
});

test('a build whose component names look minified says so in the report and once in the console', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const clock = useClock(t);
  // A production build with nothing stamping displayName: every component is what the minifier left.
  const minified = () => {
    const names = ['e', 'Xe', 'Tt', 'nc', '$'];
    let child: Record<string, any> | null = null;
    for (const name of names.reverse()) {
      const type = Object.defineProperty(function () {}, 'name', { value: name });
      const fiber: Record<string, any> = { tag: 0, flags: 1, mode: 0, elementType: type, type, memoizedProps: {}, memoizedState: null, return: null, child, sibling: null, alternate: null };
      if (child) child.return = fiber;
      child = fiber;
    }
    return { tag: 3, flags: 0, mode: 0, elementType: null, type: null, memoizedProps: null, memoizedState: null, return: null, child, sibling: null, alternate: null };
  };
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', threshold: 40, devtoolsTrack: false });
    const id = existing.inject(reactDom('19.3.0'));
    const root = { current: minified(), pendingLanes: 0 };
    existing.onCommitFiberRoot(id, root);
    for (const at of [1000, 3000]) {
      clock.now = at;
      page.fire('click', { isTrusted: true, type: 'click', timeStamp: at, target: null });
      page.duringClick(() => {
        clock.now = at + 90;
        const next = minified();
        next.alternate = root.current;
        root.current = next;
        existing.onCommitFiberRoot(id, root);
      });
      page.paint([click(at, at, 120)]);
      await nextTask();
    }
    assert.equal(api.reports().length, 2);
    for (const r of api.reports()) assert.ok(r.explanation.notes.some((n) => n.startsWith('Most component names here are one or two characters')), r.explanation.notes.join('\n'));
    const said = warn.mock.calls.filter((c) => /Most component names in this page's reports/.test(String(c.arguments[0])));
    assert.equal(said.length, 1);
    assert.match(String(said[0]!.arguments[0]), / See https:\/\/github\.com\/adityareddy-dev\/react-inp-blame#minified-names$/);
    api.dispose();
  });
});

test('a development build is warned once, at the second interaction whose long frames listed no scripts', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const unlisted = () => warn.mock.calls.filter((c) => /#frames-without-scripts$/.test(String(c.arguments[0])));
  const script = { invoker: 'BUTTON.onclick', sourceFunctionName: 'save', sourceURL: 'https://shop.example/app.js', startTime: 1010, duration: 250, forcedStyleAndLayoutDuration: 0 };
  await inBuild('development', () =>
    inBrowser(
      (page) => {
        const api = install({ devtoolsTrack: false });
        try {
          // One frame that names its script, then the same click twice more with none named.
          page.queue([click(7, 1000, 300), longFrame(1010, [script])]);
          page.paint([]);
          page.queue([click(8, 2000, 300), longFrame(2010, [])]);
          page.paint([]);
          // The same interaction revised is still one.
          page.queue([longFrame(2100, [])]);
          page.paint([]);
          // Handlers of 3 ms in frames long for styles and layout list no script on any page, since the browser lists
          // none under 5 ms, so they say nothing about this one.
          page.queue([{ ...click(11, 2400, 256), processingEnd: 2405 }, longFrame(2400, [])]);
          page.paint([]);
          page.queue([{ ...click(12, 2700, 256), processingEnd: 2705 }, longFrame(2700, [])]);
          page.paint([]);
          assert.equal(unlisted().length, 0);
          page.queue([click(9, 3000, 300), longFrame(3010, [])]);
          page.paint([]);
          page.queue([click(10, 4000, 300), longFrame(4010, [])]);
          page.paint([]);
          assert.equal(unlisted().length, 1);
          assert.match(String(unlisted()[0]!.arguments[0]), /Long Animation Frames on this page list no scripts, so forced layout cannot be measured here/);
        } finally {
          api.dispose();
        }
      },
      { entryTypes: ['event', 'first-input', 'long-animation-frame'] },
    ),
  );
});

test('stats().react says whether React can be seen, and a report built while it cannot says React\'s work is unknown', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const clock = useClock(t);
  await inBrowser(async (page) => {
    // No React on the page yet, as on an Astro page before its islands hydrate.
    const app: Record<string, unknown> = {};
    Object.defineProperty(globalThis, 'document', { value: documentOf([{}, app]), configurable: true, writable: true });
    const api = install({ hook: 'chain', threshold: 40, devtoolsTrack: false });
    const existing = existingHook();
    // `hook: 'chain'` with no hook on the page reads nothing, and a report says why without pointing at a
    // reason stats() does not have.
    assert.equal(api.stats().react, 'unreadable');
    assert.equal(api.stats().unsupportedReason, null);
    clock.now = 500;
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 500, target: null });
    page.paint([click(3, 500, 200)]);
    await nextTask();
    const note = api.last()?.explanation.notes.find((n) => n.startsWith('No react-dom on this page is being read'));
    assert.ok(note?.includes("hook: 'chain' found none to wrap"), api.last()?.explanation.notes.join('\n'));
    api.dispose();

    page.window[HOOK] = existing;
    const chained = install({ hook: 'chain', threshold: 40, devtoolsTrack: false });
    assert.equal(chained.stats().react, 'waiting');
    // React renders into the page, but its react-dom loaded before install() and never registered.
    app.__reactContainer$late = {};
    clock.now = 5000;
    assert.equal(chained.stats().react, 'installed-late');
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 5000, target: null });
    page.paint([click(7, 5000, 200)]);
    await nextTask();
    const r = chained.last();
    assert.ok(r);
    assert.equal(r.reactStatus, 'installed-late');
    assert.doesNotMatch(r.explanation.cause, /didn't render anything/);
    assert.match(r.explanation.cause, /What React did is unknown/);
    assert.notEqual(r.explanation.blame.confidence, 'measured');
    assert.ok(r.explanation.notes.some((n) => n.includes('install() ran after react-dom loaded')), r.explanation.notes.join('\n'));
    // Once a react-dom registers, it is read.
    existing.inject(reactDom('19.3.0'));
    assert.equal(chained.stats().react, 'reading');
    chained.dispose();
  });
});

test('a report looks for React again when React rendered after the last look, however recent that look was', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const app: Record<string, unknown> = {};
    Object.defineProperty(globalThis, 'document', { value: documentOf([{}, app]), configurable: true, writable: true });
    page.window[HOOK] = existingHook();
    clock.now = 100;
    const api = install({ hook: 'chain', threshold: 40, devtoolsTrack: false });
    // Looked at before React rendered, as the badge does when it mounts.
    assert.equal(api.stats().react, 'waiting');
    app.__reactContainer$late = {};
    // Well inside the second a look is otherwise good for.
    clock.now = 300;
    page.fire('click', { isTrusted: true, type: 'click', timeStamp: 300, target: null });
    page.paint([click(7, 300, 200)]);
    await nextTask();
    assert.equal(api.last()?.reactStatus, 'installed-late');
    assert.equal(api.stats().react, 'installed-late');
    api.dispose();
  });
});

test('a page with no React on it is looked at a bounded number of times, however many interactions it gets', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = useClock(t);
  await inBrowser((page) => {
    // An Astro page whose islands are all another framework's: the integration installs, and no react-dom ever registers.
    let looks = 0;
    const doc = documentOf([{}, {}, {}]);
    const walk = doc.createTreeWalker;
    doc.createTreeWalker = () => {
      looks++;
      return walk();
    };
    Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
    page.window[HOOK] = existingHook();
    clock.now = 100;
    const api = install({ hook: 'chain', threshold: 40, devtoolsTrack: false });
    // The badge asks as it mounts.
    assert.equal(api.stats().react, 'waiting');
    // A click, its report, and the badge redrawing for it, each more than the second a look is otherwise good for after the last.
    const interact = (id: number) => {
      clock.now += 1500;
      page.fire('click', { isTrusted: true, type: 'click', timeStamp: clock.now, target: null });
      page.paint([click(id, clock.now, 200)]);
      api.stats();
    };
    let id = 1;
    for (; id <= 3; id++) interact(id);
    // The check 3 s after install, and the one at the first interaction after it.
    t.mock.timers.tick(3000);
    for (; id <= 20; id++) interact(id);
    const settled = looks;
    assert.ok(settled <= 8, `looked at the page ${settled} times over the first 20 interactions`);
    for (; id <= 220; id++) interact(id);
    assert.equal(looks, settled, `looked at the page ${looks - settled} more times over the next 200 interactions`);
    assert.equal(api.stats().react, 'waiting');
    api.dispose();
  });
});

test("the pointer an input came from is kept at dispatch, and a mouse's pointerdown alone reads as a click", async (t) => {
  const clock = useClock(t);
  await inBrowser(async (page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain', threshold: 40, devtoolsTrack: false });
    clock.now = 1000;
    page.fire('pointerdown', { isTrusted: true, type: 'pointerdown', timeStamp: 1000, target: null, pointerId: 1, pointerType: 'mouse' });
    page.paint([pointer('pointerdown', 7, 1000, 120)]);
    await nextTask();
    assert.equal(api.last()?.pointerType, 'mouse');
    assert.match(api.last()?.verdict ?? '', /^120 ms click\b/);
    api.dispose();
  });
});
