import assert from 'node:assert/strict';
import { test } from 'node:test';
import { install, mountOverlay, onInteraction } from '../src/index.ts';
import type { InteractionReport } from '../src/types.ts';

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

interface Page {
  window: Record<string, any>;
  /** Event types install() is listening to on the window. */
  listening: Set<string>;
  /** Hands a batch of Event Timing entries to every connected observer. */
  paint(entries: any[]): void;
  /** Runs `commit` inside a click's dispatch, where React's sync commit runs: `window.event` is the click. */
  duringClick(commit: () => void): void;
}

/** Runs `body` against a stand-in browser: a window, Event Timing with interactionId unless told otherwise, no Long Animation Frames. */
function inBrowser(body: (page: Page) => void, { entryTypes = ['event', 'first-input'], interactionId = true }: { entryTypes?: string[]; interactionId?: boolean } = {}): void {
  const names = ['window', 'PerformanceObserver', 'PerformanceEventTiming'];
  const saved = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const listening = new Set<string>();
  const win: Record<string, any> = {
    addEventListener: (type: string) => listening.add(type),
    removeEventListener: (type: string) => listening.delete(type),
  };
  Observer.supportedEntryTypes = entryTypes;
  Observer.live.clear();
  const values = [win, Observer, interactionId ? EventTimingWithInteractionId : class {}];
  names.forEach((name, i) => Object.defineProperty(globalThis, name, { value: values[i], configurable: true, writable: true }));
  try {
    body({
      window: win,
      listening,
      paint: (entries) => {
        for (const o of [...Observer.live]) o.callback({ getEntries: () => entries });
      },
      duringClick: (commit) => {
        win.event = { isTrusted: true, type: 'click', timeStamp: performance.now() };
        try {
          commit();
        } finally {
          delete win.event;
        }
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
    onCommitFiberRoot(id: number): void {
      calls.push(id);
    },
  };
}

const reactDom = (version: string) => ({ version, bundleType: 1, rendererPackageName: 'react-dom' });

/** A committed root as React hands it to the hook: one component rendered, measured at `ms` when the build measures. */
function committedRoot(mode: number, ms: number | undefined) {
  function Counter() {}
  const counter = { tag: 0, flags: 1, mode, elementType: Counter, type: Counter, memoizedProps: {}, return: null, child: null, sibling: null, alternate: null, actualDuration: ms };
  return { current: { tag: 3, flags: 0, mode, elementType: null, type: null, memoizedProps: null, return: null, child: counter, sibling: null, alternate: null, actualDuration: ms } };
}

const slowClick = (duration: number) => ({ entryType: 'event', name: 'click', interactionId: 7, startTime: 1000, duration, processingStart: 1002, processingEnd: 1000 + duration - 8, target: null });

test('a browser without Event Timing interactionId gets nothing installed and one warning', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const overlays: Promise<unknown>[] = [];
  for (const browser of [{ entryTypes: ['first-input'] }, { interactionId: false }]) {
    inBrowser((page) => {
      const api = install({ debugGlobal: true });
      assert.equal(api.stats().mode, 'unsupported');
      assert.equal(HOOK in page.window, false, 'the DevTools hook was created');
      assert.equal(page.listening.size, 0, 'input listeners were added');
      // Exposed anyway, so stats() on the page says why nothing is reported.
      assert.equal(page.window.__REACT_INP__, api);
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
    assert.equal(api.stats().owner, 'react-inp-blame');
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

test("hook: 'chain' reads commits through the existing hook and puts it back on dispose", () => {
  inBrowser((page) => {
    const existing = existingHook();
    const { inject, onCommitFiberRoot } = existing;
    page.window[HOOK] = existing;
    const api = install({ hook: 'chain' });

    const id = existing.inject(reactDom('19.3.0'));
    assert.deepEqual(api.stats().renderers, [{ id, version: '19.3.0', bundleType: 1, rendererPackageName: 'react-dom' }]);
    page.duringClick(() => existing.onCommitFiberRoot(id, committedRoot(0b11, 4) as any, 1, false));
    assert.deepEqual(existing.calls, [id], 'the hook it wrapped no longer hears about commits');
    const [commit] = api.allCommits();
    assert.equal(commit.rendered, 1);
    assert.equal(commit.priority, 1);
    assert.equal(commit.didError, false);

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
      assert.equal(api.allCommits().at(-1)!.hasDurations, hasDurations, `React ${version}, mode ${mode}`);
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
    assert.equal(api.allCommits().length, 0);
    assert.equal(api.stats().mode, 'chained');

    const old = existing.inject(reactDom('16.14.0'));
    assert.equal(api.stats().mode, 'unsupported');
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /react-dom 16\.14\.0 is outside React 17 to 19/);
    page.duringClick(() => existing.onCommitFiberRoot(old, committedRoot(0b11, 4) as any));
    assert.equal(api.allCommits().length, 0);
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
    page.duringClick(() => existing.onCommitFiberRoot(id, committedRoot(0b11, 4) as any));
    assert.equal(api.allCommits().length, 0);
    api.dispose();
  });
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

test('install() while installed applies onReport and warns once about options it cannot change', (t) => {
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
    assert.equal(page.window.__REACT_INP__, out);
    // Rolling again on a later call would raise the share of pages that install.
    assert.equal(install({ sampleRate: 1 }), out);
    assert.equal(roll.mock.callCount(), 1);

    out.dispose();
    assert.equal('__REACT_INP__' in page.window, false);
    const won = install({ sampleRate: 0.6 });
    assert.equal(won.stats().mode, 'shim');
    won.dispose();
  });
});

// Last: the shim this library creates outlives dispose(), the way React holds on to it.
test('the shim follows a hook that replaces it before React registers, and reports lockout after', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  inBrowser((page) => {
    const api = install();
    const replacement = existingHook();
    page.window[HOOK] = replacement;
    assert.equal(api.stats().mode, 'chained');
    assert.equal(api.stats().devtoolsLockedOut, false);
    api.dispose();
  });
  inBrowser((page) => {
    const api = install();
    page.window[HOOK].inject(reactDom('19.3.0'));
    page.window[HOOK] = existingHook();
    // React keeps reporting to the shim it registered with; the replacement never hears from it.
    assert.equal(api.stats().mode, 'shim');
    assert.equal(api.stats().devtoolsLockedOut, true);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /will not see this React/);
    api.dispose();
  });
});
