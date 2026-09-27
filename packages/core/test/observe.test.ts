import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReport, sealReport } from '../src/join.ts';
import { observeEventTiming, observeFrames } from '../src/observe.ts';
import type { CommitSummary, FrameSummary } from '../src/types.ts';

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
  return { at, sinceInput: at - 1000, inputTs: 1000, gestureTs: 1000, inputType: 'click', rendered, hydrated: false, truncated: false, roots: ['CascadingEffect'], hotPath: ['CascadingEffect'], components, hasDurations: true, coarseClock: false, total, startedAt: null, effectsStartedAt: null, effectsEndedAt: null, walkMs: 0.3, priority: 1, didError: false };
}

test('a first click that paints under the 16 ms floor still gets its later render reported', () => {
  const handed: any[][] = [];
  inBrowser((paint) => {
    observeEventTiming((entries) => handed.push(entries));
    // Painted 8 ms after the press: no event entry reaches the observer, only the first-input one.
    paint(click(8));
  });
  assert.equal(handed.length, 1, 'nothing was handed over for the click');
  const [entries = []] = handed;
  assert.deepEqual(
    entries.map((e) => `${e.entryType} ${e.name} ${e.interactionId}`),
    ['first-input pointerdown 7'],
  );
  // The click's own commit, then the render its effect set off 100 ms later, both stamped with the click.
  const own = commit(1003, 1, 0.5, [{ name: 'CascadingEffect', count: 1, self: 0.5, total: 0.5 }]);
  const later = commit(1100, 401, 82, [{ name: 'Detail', count: 400, self: 81, total: 0.3 }]);
  const r = sealReport(buildReport(entries, [own, later], []));
  assert.deepEqual(r.commits, [{ ...own, joinedBy: 'exact' }]);
  assert.deepEqual(r.followUps, [{ ...later, joinedBy: 'exact' }]);
  assert.match(r.verdict, /A second React render landed 92 ms after the screen updated: 82 ms re-rendering 401 components inside CascadingEffect, mostly Detail/);
});

test('a first click that also cleared the 16 ms floor is handed over once, not twice', () => {
  const handed: any[][] = [];
  inBrowser((paint) => {
    observeEventTiming((entries) => handed.push(entries));
    const [down, up, clicked, copy] = click(16);
    paint([down, up, clicked]);
    // The copy on its own must not reach the caller: it would rebuild the report for nothing.
    paint([copy]);
  });
  assert.equal(handed.length, 1);
  assert.deepEqual(
    handed[0]?.map((e) => `${e.entryType} ${e.name}`),
    ['event pointerdown', 'event pointerup', 'event click'],
  );
});

test('a first input replayed to an install() that ran after it is handed over when its event entry never comes', () => {
  const handed: any[][] = [];
  inBrowser((paint) => {
    observeEventTiming((entries) => handed.push(entries));
    // `buffered: true` replays `event` entries only from 104 ms, and `first-input` at any duration, so a
    // 56 ms first click reaches a late observer as its first-input entry alone.
    paint([timing('first-input', 'pointerdown', 56, 1001, 1040)]);
  });
  assert.deepEqual(
    handed.map((batch) => batch.map((e) => `${e.entryType} ${e.name} ${e.duration}`)),
    [['first-input pointerdown 56']],
  );
});

/** A long-animation-frame entry as the browser gives it, holding scripts as `[invoker, startTime, duration]`, each from an inline script on `page`. */
function loaf(startTime: number, duration: number, scripts: [string, number, number][], page = 'https://shop.example/') {
  return {
    entryType: 'long-animation-frame',
    startTime,
    duration,
    blockingDuration: Math.max(0, duration - 50),
    styleAndLayoutStart: startTime + duration - 2,
    scripts: scripts.map(([invoker, start, length]) => ({ invoker, sourceFunctionName: '', sourceURL: page, startTime: start, duration: length, forcedStyleAndLayoutDuration: 0 })),
  };
}

test("a script the browser names by a URL is kept without the URL's query and fragment, and any other invoker as the browser gave it", () => {
  const frames: FrameSummary[] = [];
  const invokers = [
    'https://cdn.example/app.js?sig=abc#x',
    'https://shop.example/account#access_token=abc',
    // An event listener on an element with no id is named by its src, which Chromium quotes.
    'IMG[src="https://cdn.example/avatars/ada.png?X-Amz-Signature=abc"].onload',
    'SCRIPT[src="https://cdn.example/sdk.js?key=abc"].onload',
    'IFRAME[src="/frame.html?tok=abc#top"].onload',
    // A src can hold a bracket of its own, and one with no query keeps both its quotes.
    'IMG[src="/photos/[1].png?sig=abc"].onload',
    'IMG[src="/avatars/ada.png"].onload',
    // Unquoted, the same src loses its query too.
    'IMG[src=/avatars/ada.png?v=3].onerror',
    'IMG#avatar.onload',
    '#document.onclick',
    'DIV#root.onclick',
    'TimerHandler:setTimeout',
    'MessagePort.onmessage',
    'Response.json.then',
    'blob:https://shop.example/1234',
    '',
  ];
  inBrowser((paint) => {
    observeFrames(frames, () => {});
    paint([loaf(1000, invokers.length * 20, invokers.map((invoker, i) => [invoker, 1000 + i * 20, 20]))]);
  });
  assert.deepEqual(
    frames[0]?.scripts.map((s) => s.invoker),
    [
      'https://cdn.example/app.js',
      'https://shop.example/account',
      'IMG[src="https://cdn.example/avatars/ada.png"].onload',
      'SCRIPT[src="https://cdn.example/sdk.js"].onload',
      'IFRAME[src="/frame.html"].onload',
      'IMG[src="/photos/[1].png"].onload',
      'IMG[src="/avatars/ada.png"].onload',
      'IMG[src=/avatars/ada.png].onerror',
      'IMG#avatar.onload',
      '#document.onclick',
      'DIV#root.onclick',
      'TimerHandler:setTimeout',
      'MessagePort.onmessage',
      'Response.json.then',
      'blob:https://shop.example/1234',
      '',
    ],
  );
});

test('a click that waited behind an inline script on a reset link blames the page by its path, and the token in its query is nowhere in the report', () => {
  const frames: FrameSummary[] = [];
  const page = 'https://shop.example/reset-password?token=s3cr3t-reset-token&email=ada%40example.com';
  inBrowser((paint) => {
    observeFrames(frames, () => {});
    paint([loaf(1000, 352, [[page, 1000, 300]], page)]);
  });
  const r = sealReport(buildReport([timing('event', 'click', 352, 1300, 1350)], [], frames));
  assert.deepEqual(r.explanation.blame, { kind: 'waiting', name: 'https://shop.example/reset-password', detail: null, ms: 300, confidence: 'measured' });
  assert.equal(
    r.explanation.cause,
    'The click waited 300 ms before its handler could start: a script (https://shop.example/reset-password, /reset-password) ran first and held the main thread for all of that wait.',
  );
  const sent = JSON.stringify(r);
  assert.equal(sent.includes('s3cr3t'), false);
  assert.equal(sent.includes('ada%40example.com'), false);
});
