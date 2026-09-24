import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { install, mountOverlay, onInteraction } from '../src/index.ts';
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
  constructor(callback: (list: { getEntries(): any[] }) => void) {
    this.callback = callback;
  }
  observe(): void {
    Observer.live.add(this);
  }
  disconnect(): void {
    Observer.live.delete(this);
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
  /** Hands a batch of Event Timing entries to every connected observer. */
  paint(entries: any[]): void;
  /** Runs `inside` in a click's dispatch, where React's sync commit and a router's navigation run: `window.event` is the click. Returns the click's timeStamp. */
  duringClick(inside: () => void): number;
}

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
        for (const o of [...Observer.live]) o.callback({ getEntries: () => entries });
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

/**
 * next-client as Next.js bundles it: `process.env.REACT_INP_BLAME_NEXT` holds what withInpBlame put in
 * `env`, or nothing in a build the wrapper left out. Each tag imports a copy of its own.
 */
async function nextClient(tag: string, settings?: object): Promise<typeof import('../src/next-client.ts')> {
  const saved = process.env.REACT_INP_BLAME_NEXT;
  if (settings) process.env.REACT_INP_BLAME_NEXT = JSON.stringify(settings);
  else delete process.env.REACT_INP_BLAME_NEXT;
  try {
    return await import(`../src/next-client.ts?${tag}`);
  } finally {
    if (saved === undefined) delete process.env.REACT_INP_BLAME_NEXT;
    else process.env.REACT_INP_BLAME_NEXT = saved;
  }
}

test('a click that starts an App Router navigation is named with it, and the reports after it carry the new URL', async () => {
  // Imported outside the stand-in browser, so its own install() finds no window and does nothing.
  const { onRouterTransitionStart } = await nextClient('wrapped', { install: {}, basePath: '' });
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

test('next-client installs nothing and names no navigation in a build withInpBlame left out, where the line in instrumentation-client still brings it', async () => {
  await inBrowser(async (page) => {
    const { onRouterTransitionStart } = await nextClient('left-out');
    assert.equal(Observer.live.size, 0);
    // The same module in a build the wrapper covers installs as it is imported.
    await nextClient('covered', { install: { devtoolsTrack: false }, basePath: '' });
    assert.ok(Observer.live.size > 0);
    const api = install({ devtoolsTrack: false });
    const clickedAt = page.duringClick(() => onRouterTransitionStart('/cart', 'push', null));
    page.paint([click(7, clickedAt, 64)]);
    assert.deepEqual(placeOf(api.last()), { navigationURL: PAGE_URL, navigationType: 'navigate', startedNavigation: null });
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
    assert.deepEqual(
      api.debug.commits().map((c) => ({ input: c.inputTs, gesture: c.gestureTs })),
      [
        { input: 1062, gesture: 1000 },
        { input: 2001, gesture: 2000 },
        { input: 3083, gesture: 3000 },
        { input: 4501, gesture: 4500 },
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
    page.window.event = { isTrusted: true, type: 'input', timeStamp: 1002, target: null };
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
    page.window.event = { isTrusted: true, type: 'change', timeStamp: 21000, target: null };
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
    page.window.event = { isTrusted: true, type: 'change', timeStamp: 21000, target: null };
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
    page.window.event = { isTrusted: true, type: 'change', timeStamp: 2000, target: null };
    clock.now = 2600;
    commitAgain(root, 600);
    existing.onCommitFiberRoot(id, root, 1, false);
    delete page.window.event;
    assert.equal(api.last()?.revision, 1);
    assert.deepEqual(api.last()?.followUps.map((c) => c.at), [2600]);
    api.dispose();
  });
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
      page.window.event = { isTrusted: true, type: 'input', timeStamp: at, target: null };
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
    page.window.event = { isTrusted: true, type: 'submit', timeStamp: 3000, target: null };
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
