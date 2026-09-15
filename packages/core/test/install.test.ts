import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { install, mountOverlay, onInteraction } from '../src/index.ts';
import { onRouterTransitionStart } from '../src/next-client.ts';
import type { InstallOptions, InteractionReport } from '../src/types.ts';

const HOOK = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

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
function inBrowser(body: (page: Page) => void, { entryTypes = ['event', 'first-input'], interactionId = true }: { entryTypes?: string[]; interactionId?: boolean } = {}): void {
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
    body({
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
    onCommitFiberRoot(id: number, _root?: unknown): void {
      calls.push(id);
    },
  };
}

const reactDom = (version: string, bundleType = 1) => ({ version, bundleType, rendererPackageName: 'react-dom' });

/** A committed root as React hands it to the hook: one component rendered, measured at `ms` when the build measures. */
function committedRoot(mode: number, ms: number | undefined) {
  function Counter() {}
  const counter = { tag: 0, flags: 1, mode, elementType: Counter, type: Counter, memoizedProps: {}, return: null, child: null, sibling: null, alternate: null, actualDuration: ms };
  return { current: { tag: 3, flags: 0, mode, elementType: null, type: null, memoizedProps: null, return: null, child: counter, sibling: null, alternate: null, actualDuration: ms } };
}

/** A committed root whose one component counts how often it is named, which a walk does once. */
function countingRoot() {
  const root = committedRoot(0b11, 4);
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
    inBrowser((page) => {
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

test("hook: 'auto' creates a hook when there is none, and it does not claim to be React DevTools", () => {
  inBrowser((page) => {
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

test("hook: 'auto' chains onto a hook that is already there", () => {
  inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install();
    assert.equal(api.stats().mode, 'chained');
    assert.equal(page.window[HOOK], existing);
    api.dispose();
  });
});

test("hook: 'chain' never creates the global hook", () => {
  inBrowser((page) => {
    const api = install({ hook: 'chain' });
    assert.equal(HOOK in page.window, false);
    assert.equal(api.stats().mode, 'none');
    api.dispose();
  });
});

test("hook: 'chain' reads commits through the existing hook, records them frozen, and puts the hook back on dispose", () => {
  inBrowser((page) => {
    const existing = existingHook();
    const { inject, onCommitFiberRoot } = existing;
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });

    const id = existing.inject(reactDom('19.3.0'));
    assert.deepEqual(api.debug.hook().renderers, [{ id, version: '19.3.0', bundleType: 1, rendererPackageName: 'react-dom' }]);
    page.duringClick(() => existing.onCommitFiberRoot(id, committedRoot(0b11, 4) as any, 1, false));
    assert.deepEqual(existing.calls, [id], 'the hook it wrapped no longer hears about commits');
    const [commit] = api.debug.commits();
    assert.equal(commit.rendered, 1);
    assert.equal(commit.priority, 1);
    assert.equal(commit.didError, false);
    assert.ok(Object.isFrozen(commit) && Object.isFrozen(commit.components), 'a recorded commit can be changed');

    api.dispose();
    assert.equal(existing.inject, inject);
    assert.equal(existing.onCommitFiberRoot, onCommitFiberRoot);
  });
});

test("hook: 'shim' over an existing hook chains instead of replacing it, and says so", (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  inBrowser((page) => {
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

test('durations come from the ProfileMode bit of the React version that registered', () => {
  // React 17 numbered its mode flags differently: ProfileMode is 8 there and 2 is BlockingMode.
  // A tree outside ProfileMode keeps actualDuration at 0 in development and has none in production.
  const cases: Array<[version: string, mode: number, ms: number | undefined, hasDurations: boolean]> = [
    ['17.0.2', 0b1000, 5, true],
    ['17.0.2', 0b0010, 0, false],
    ['18.3.1', 0b0011, 5, true],
    ['18.3.1', 0b0001, 0, false],
    ['19.3.0', 0b0011, 5, true],
    ['19.3.0', 0b0001, undefined, false],
  ];
  inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    for (const [version, mode, ms, hasDurations] of cases) {
      const id = existing.inject(reactDom(version));
      page.duringClick(() => existing.onCommitFiberRoot(id, committedRoot(mode, ms) as any));
      assert.equal(api.debug.commits().at(-1)!.hasDurations, hasDurations, `React ${version}, mode ${mode}`);
    }
    api.dispose();
  });
});

test('only react-dom from React 17 to 19 is walked; any other react-dom turns the walk off', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });

    const canvas = existing.inject({ version: '9.1.0', bundleType: 1, rendererPackageName: '@react-three/fiber' });
    page.duringClick(() => existing.onCommitFiberRoot(canvas, committedRoot(0b11, 4) as any));
    assert.equal(api.debug.commits().length, 0);
    assert.equal(api.stats().mode, 'chained');

    const old = existing.inject(reactDom('16.14.0'));
    assert.equal(api.stats().mode, 'unsupported');
    assert.equal(api.stats().unsupportedReason?.kind, 'react-version');
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /react-dom 16\.14\.0 is outside React 17 to 19/);
    page.duringClick(() => existing.onCommitFiberRoot(old, committedRoot(0b11, 4) as any));
    assert.equal(api.debug.commits().length, 0);
    api.dispose();
  });
});

test('a root of an unexpected shape turns the walk off for good at the first commit', () => {
  inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    const id = existing.inject(reactDom('19.3.0'));
    const changed = committedRoot(0b11, 4);
    delete (changed.current as Record<string, unknown>).flags;
    page.duringClick(() => existing.onCommitFiberRoot(id, changed as any));
    assert.equal(api.stats().mode, 'unsupported');
    assert.equal(api.stats().unsupportedReason?.kind, 'fiber-shape');
    page.duringClick(() => existing.onCommitFiberRoot(id, committedRoot(0b11, 4) as any));
    assert.equal(api.debug.commits().length, 0);
    api.dispose();
  });
});

test('a walk that throws turns the walk off for good, and stats() carries what it threw', (t) => {
  t.mock.method(console, 'warn', () => {});
  inBrowser((page) => {
    const existing = existingHook();
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });
    const id = existing.inject(reactDom('19.3.0'));
    const root = committedRoot(0b11, 4);
    Object.defineProperty(root.current.child, 'flags', {
      get() {
        throw new Error('flags moved');
      },
    });
    page.duringClick(() => existing.onCommitFiberRoot(id, root as any));
    assert.equal(api.stats().mode, 'unsupported');
    assert.equal(api.stats().unsupportedReason?.kind, 'walk-threw');
    assert.match(api.stats().unsupportedReason!.message, /reading a React commit threw \(Error: flags moved\)/);
    api.dispose();
  });
});

test("a label names an element by its attributes under a production React, and by its text under a development React or when asked", () => {
  const labelUnder = (bundleType: number, labels?: InstallOptions['labels']) => {
    let label: string | null | undefined;
    inBrowser((page) => {
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
  assert.equal(labelUnder(0), 'button "save"');
  assert.equal(labelUnder(1), 'button "Save for Ada Lovelace"');
  assert.equal(labelUnder(0, 'text'), 'button "Save for Ada Lovelace"');
  assert.equal(labelUnder(1, 'attributes'), 'button "save"');
});

test('dispose() drops every listener, and the next install() takes its own options', () => {
  inBrowser((page) => {
    const heard: string[] = [];
    const first = install({ threshold: 40, devtoolsTrack: false, onReport: () => heard.push('first onReport') });
    onInteraction(() => heard.push('listener added before dispose'));
    first.dispose();
    assert.equal(page.listening.size, 0);

    const second = install({ threshold: 100, devtoolsTrack: false, onReport: (r: InteractionReport) => heard.push(`second onReport, ${r.duration} ms`) });
    page.paint([slowClick(64)]);
    assert.deepEqual(heard, [], "a 64 ms click was reported under the first install's 40 ms threshold");
    page.paint([{ ...slowClick(120), interactionId: 14 }]);
    assert.deepEqual(heard, ['second onReport, 120 ms']);
    second.dispose();
  });
});

test('install() while installed replaces onReport and warns once about options it cannot change', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  inBrowser((page) => {
    const heard: string[] = [];
    const api = install({ devtoolsTrack: false, onReport: () => heard.push('first') });
    assert.equal(install({ devtoolsTrack: false }), api, 'the same value again is not a change');
    assert.equal(warn.mock.callCount(), 0);
    install({ threshold: 16, walkBudget: 10, onReport: () => heard.push('second') });
    install({ threshold: 16 });
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /threshold, walkBudget kept the first call's value/);
    page.paint([slowClick(120)]);
    assert.deepEqual(heard, ['second']);
    api.dispose();
  });
});

test('sampleRate rolls once per page, and a page that loses gets nothing installed until dispose()', (t) => {
  const roll = t.mock.method(Math, 'random', () => 0.5);
  inBrowser((page) => {
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

test('a click that starts an App Router navigation is named with it, and the reports after it carry the new URL', () => {
  inBrowser((page) => {
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

test('a page restored from the back/forward cache starts its INP over, and its reports say how it came back', () => {
  inBrowser((page) => {
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

test('two copies of the library on one page share one installation: one hook wrapper, one walk per commit, one set of listeners', async (t) => {
  const [a, b] = await Promise.all([copyOfLibrary(t), copyOfLibrary(t)]);
  assert.notEqual(a.install, b.install, 'the copies share their modules');
  inBrowser((page) => {
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
    assert.deepEqual(heard, ['first copy', 'second copy']);

    // Disposing through either copy ends the one installation for both.
    second.dispose();
    assert.equal(page.listening.size, 0);
    assert.equal(Observer.live.size, 0);
  });
  // The shim one copy made is the other copy's own hook, not someone else's to chain onto.
  inBrowser(() => {
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
  const session = holder[key];
  holder[key] = { layout: 0, slots: {} };
  let other: Awaited<ReturnType<typeof copyOfLibrary>>;
  try {
    other = await copyOfLibrary(t);
  } finally {
    holder[key] = session;
  }
  inBrowser((page) => {
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
test('the shim follows a hook that replaces it before React registers, and reports lockout after', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  inBrowser((page) => {
    const api = install();
    const replacement = existingHook();
    page.window[HOOK] = replacement;
    assert.equal(api.stats().mode, 'chained');
    assert.equal(api.debug.hook().devtoolsLockedOut, false);
    api.dispose();
  });
  inBrowser((page) => {
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
