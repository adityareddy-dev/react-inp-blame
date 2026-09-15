import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReport } from '../src/join.ts';
import { observeEventTiming } from '../src/observe.ts';
import type { CommitSummary } from '../src/types.ts';

// The browser's PerformanceObserver, reduced to the two delivery rules these tests are about:
// an `event` entry reaches an observer only at or above its durationThreshold (never under
// 16 ms), and a `first-input` entry only when that type is observed, whatever its duration.
class BrowserObserver {
  static supportedEntryTypes = ['event', 'first-input', 'long-animation-frame'];
  static live: BrowserObserver[] = [];
  callback: (list: { getEntries(): any[] }) => void;
  options = new Map<string, any>();
  constructor(callback: (list: { getEntries(): any[] }) => void) {
    this.callback = callback;
    BrowserObserver.live.push(this);
  }
  observe(o: any): void {
    this.options.set(o.type, o);
  }
  disconnect(): void {
    this.options.clear();
  }
  deliver(entries: any[]): void {
    const kept = entries.filter((e) => {
      const o = this.options.get(e.entryType);
      return !!o && (e.entryType !== 'event' || e.duration >= Math.max(16, o.durationThreshold ?? 104));
    });
    if (kept.length) this.callback({ getEntries: () => kept });
  }
}

/** Runs `body` with the stand-in installed; `paint` hands one batch of entries to every observer. */
function inBrowser(body: (paint: (entries: any[]) => void) => void): void {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'PerformanceObserver');
  Object.defineProperty(globalThis, 'PerformanceObserver', { value: BrowserObserver, configurable: true, writable: true });
  BrowserObserver.live.length = 0;
  try {
    body((entries) => {
      for (const o of BrowserObserver.live) o.deliver(entries);
    });
  } finally {
    if (saved) Object.defineProperty(globalThis, 'PerformanceObserver', saved);
    else delete (globalThis as any).PerformanceObserver;
  }
}

function timing(entryType: 'event' | 'first-input', name: string, duration: number, processingStart: number, processingEnd: number) {
  return { entryType, name, interactionId: 7, startTime: 1000, duration, processingStart, processingEnd, target: null };
}

// One click as Chromium reports it: pointerdown, pointerup and click share a timeStamp, and the
// page's first input comes again as a first-input copy of the pointerdown.
const click = (duration: number) => [
  timing('event', 'pointerdown', duration, 1001.3, 1001.6),
  timing('event', 'pointerup', duration, 1002.3, 1002.3),
  timing('event', 'click', duration, 1002.4, 1003.9),
  timing('first-input', 'pointerdown', duration, 1001.3, 1001.6),
];

function commit(at: number, rendered: number, total: number, components: CommitSummary['components']): CommitSummary {
  return { at, sinceInput: at - 1000, inputTs: 1000, gestureTs: 1000, inputType: 'click', rendered, truncated: false, roots: ['CascadingEffect'], hotPath: ['CascadingEffect'], components, hasDurations: true, total, walkMs: 0.3, priority: 1, didError: false };
}

test('a first click that paints under the 16 ms floor still gets its later render reported', () => {
  const handed: Array<[number, any[]]> = [];
  inBrowser((paint) => {
    observeEventTiming(16, (id, entries) => handed.push([id, entries]));
    // Painted 8 ms after the press: no event entry reaches the observer, only the first-input one.
    paint(click(8));
  });
  assert.equal(handed.length, 1, 'nothing was handed over for the click');
  const [id, entries] = handed[0];
  assert.equal(id, 7);
  // The click's own commit, then the render its effect set off 100 ms later, both stamped with the click.
  const own = commit(1003, 1, 0.5, [{ name: 'CascadingEffect', count: 1, self: 0.5, total: 0.5 }]);
  const later = commit(1100, 401, 82, [{ name: 'Detail', count: 400, self: 81, total: 0.3 }]);
  const r = buildReport(entries, [own, later], []);
  assert.deepEqual(r.commits, [own]);
  assert.deepEqual(r.followUps, [later]);
  assert.match(r.verdict, /A second React render landed 92 ms after the screen updated: 82 ms re-rendering 401 components inside CascadingEffect, mostly Detail/);
});

test('a first click that also cleared the 16 ms floor is handed over once, not twice', () => {
  const handed: Array<[number, any[]]> = [];
  inBrowser((paint) => {
    observeEventTiming(16, (id, entries) => handed.push([id, entries]));
    const [down, up, clicked, copy] = click(16);
    paint([down, up, clicked]);
    // The copy on its own must not reach the caller: it would rebuild the report for nothing.
    paint([copy]);
  });
  assert.equal(handed.length, 1);
  assert.deepEqual(
    handed[0][1].map((e) => `${e.entryType} ${e.name}`),
    ['event pointerdown', 'event pointerup', 'event click'],
  );
});
