import type { FrameSummary, ScriptSummary } from './types.js';

/** The browser sends no `event` entry for an interaction under this many ms, whatever threshold an observer asks for. */
const EVENT_TIMING_FLOOR_MS = 16;
/** Long animation frames kept to join to reports. A report keeps the frames it joined for as long as it is kept itself. */
const MAX_FRAMES = 60;

/** An Event Timing entry with the `interactionId` that TypeScript's DOM lib does not declare yet. */
export interface InteractionTiming extends PerformanceEventTiming {
  readonly interactionId: number;
}

/** Observer options for `event` entries; TypeScript's DOM lib leaves out `durationThreshold`. */
interface EventTimingObserverInit extends PerformanceObserverInit {
  durationThreshold: number;
}

/** The spec's `PerformanceLongAnimationFrameTiming`, which TypeScript's DOM lib does not declare: the fields read here. */
interface PerformanceLongAnimationFrameTiming extends PerformanceEntry {
  readonly blockingDuration: number;
  /** 0 where the frame did not render. */
  readonly styleAndLayoutStart: number;
  readonly scripts: readonly PerformanceScriptTiming[];
}

/** The spec's `PerformanceScriptTiming`: one script that ran in a long animation frame. */
interface PerformanceScriptTiming extends PerformanceEntry {
  readonly invoker: string;
  readonly sourceFunctionName: string;
  readonly sourceURL: string;
  readonly forcedStyleAndLayoutDuration: number;
}

/** A connected observer: `flush` hands over at once what the browser has queued for it and not delivered yet. */
export interface Observing {
  stop(): void;
  flush(): void;
}

/** What an observer that could not connect hands back. */
export const NOT_OBSERVING: Observing = { stop() {}, flush() {} };

function supportedEntryTypes(): readonly string[] {
  return typeof PerformanceObserver !== 'undefined' ? PerformanceObserver.supportedEntryTypes || [] : [];
}

/** Event Timing with `interactionId`, which groups entries into interactions: Chrome 96, Firefox 144, Safari 26.2. */
export function supportsInteractions(): boolean {
  return supportedEntryTypes().includes('event') && typeof PerformanceEventTiming !== 'undefined' && 'interactionId' in PerformanceEventTiming.prototype;
}

/** Long Animation Frames, the source of script and forced-layout attribution: Chromium 123+ only. */
export function supportsLongAnimationFrames(): boolean {
  return supportedEntryTypes().includes('long-animation-frame');
}

/**
 * Hands over each observer batch of Event Timing entries that belong to an interaction, in the
 * order the browser delivered them. Entries of one interaction arrive with the paint that
 * presented them: a pointerdown in one frame, the pointerup and click in a later one, a keydown
 * before its keyup. Nothing waits here; the caller merges a later batch into the report it built.
 *
 * The browser sends no `event` entry under 16 ms, so an interaction that paints faster is
 * never seen, and a heavy render its effect sets off after the paint has no report to join.
 * The page's first input is the exception: it also comes as a `first-input` entry at any
 * duration, carrying its interactionId, so that type is observed too (web-vitals' onINP does
 * the same). When its `event` entry has been handed over, the copy adds nothing and is dropped.
 */
export function observeEventTiming(onBatch: (entries: InteractionTiming[]) => void): Observing {
  if (typeof PerformanceObserver === 'undefined') return NOT_OBSERVING;
  const firstInput = supportedEntryTypes().includes('first-input');
  // The interactionIds of `event` entries handed over, kept until the page's first-input entry comes.
  // Deciding on the copy's duration is not enough: `buffered: true` replays `event` entries to a late
  // install() only from 104 ms, and `first-input` at any duration, so a 56 ms first input has no other entry.
  let handedOver: Set<number> | null = firstInput ? new Set() : null;
  // Delivered entries and flushed ones both come through here, so the first input is dropped the same way.
  const take = (entries: InteractionTiming[]) => {
    if (handedOver) for (const e of entries) if (e.entryType === 'event' && e.interactionId) handedOver.add(e.interactionId);
    const batch = entries.filter((e) => {
      if (!e.interactionId) return false;
      if (e.entryType !== 'first-input') return true;
      const copy = handedOver?.has(e.interactionId) ?? false;
      handedOver = null;
      return !copy;
    });
    if (batch.length) onBatch(batch);
  };
  const po = new PerformanceObserver((list) => take(list.getEntries() as InteractionTiming[]));
  const events: EventTimingObserverInit = { type: 'event', buffered: true, durationThreshold: EVENT_TIMING_FLOOR_MS };
  try {
    po.observe(events);
  } catch {
    return NOT_OBSERVING;
  }
  if (firstInput) po.observe({ type: 'first-input', buffered: true });
  return { stop: () => po.disconnect(), flush: () => take(po.takeRecords() as InteractionTiming[]) };
}

export function observeFrames(store: FrameSummary[], onFrame: (f: FrameSummary) => void): Observing {
  if (!supportsLongAnimationFrames()) return NOT_OBSERVING;
  const take = (entries: PerformanceLongAnimationFrameTiming[]) => {
    for (const e of entries) {
      const f = summarizeFrame(e);
      store.push(f);
      if (store.length > MAX_FRAMES) store.splice(0, store.length - MAX_FRAMES);
      onFrame(f);
    }
  };
  const po = new PerformanceObserver((list) => take(list.getEntries() as PerformanceLongAnimationFrameTiming[]));
  po.observe({ type: 'long-animation-frame', buffered: true });
  return { stop: () => po.disconnect(), flush: () => take(po.takeRecords() as PerformanceLongAnimationFrameTiming[]) };
}

/** A frame summary is frozen: reports hold the same object from the revision it joins onwards. */
function summarizeFrame(e: PerformanceLongAnimationFrameTiming): FrameSummary {
  const scripts = (e.scripts || []).map(
    (s): ScriptSummary =>
      Object.freeze({
        invoker: invokerOf(s.invoker || ''),
        name: s.sourceFunctionName || '',
        source: shortSource(s.sourceURL || ''),
        start: s.startTime,
        duration: s.duration,
        forcedLayout: s.forcedStyleAndLayoutDuration || 0,
      }),
  );
  return Object.freeze({
    start: e.startTime,
    duration: e.duration,
    blocking: e.blockingDuration || 0,
    forcedLayout: scripts.reduce((a, s) => a + s.forcedLayout, 0),
    scripts: Object.freeze(scripts),
    styleAndLayoutStart: e.styleAndLayoutStart > 0 ? e.styleAndLayoutStart : null,
  });
}

/**
 * What ran a script, as the browser names it, less any URL's query and fragment, which can carry a
 * signed parameter, a reset token or an email. The browser names a script by its URL, or by the page's
 * for an inline script, which in an Electron app is a file: URL or one of the app's own, such as app://,
 * that can carry a session in its query as well. A URL is told by the `//` after its scheme, since
 * `TimerHandler:setTimeout` reads as one too. An event listener on an element without an id is named by
 * the element's src, which Chromium quotes: `IMG[src="/avatar.png?sig=abc"].onload` is kept as
 * `IMG[src="/avatar.png"].onload`, its quotes still paired, and the same src unquoted loses its query
 * too, a bracket in its path or not. Any other name, `#document.onclick`, `TimerHandler:setTimeout` or a
 * blob: URL, is kept as it is.
 */
function invokerOf(invoker: string): string {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(invoker) ? invoker.replace(/[?#][^]*/, '') : invoker.replace(/(\[src=(")?[^?#"]*)[?#][^]*(\2\]\.on)/, '$1$3');
}

function shortSource(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.pathname.split('/').slice(-2).join('/') || u.host;
  } catch {
    return url;
  }
}
