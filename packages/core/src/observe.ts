import type { FrameSummary, ScriptSummary } from './types.ts';

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
 * Hands over Event Timing entries grouped by interactionId, one call per id per observer
 * batch. Entries of one interaction arrive with the paint that presented them: a pointerdown
 * in one frame, the pointerup and click in a later one, a keydown before its keyup. Nothing
 * waits here; the caller merges a later batch into the report it already built.
 *
 * The browser sends no `event` entry under 16 ms, so an interaction that paints faster is
 * never seen, and a heavy render its effect sets off after the paint has no report to join.
 * The page's first input is the exception: it also comes as a `first-input` entry at any
 * duration, carrying its interactionId, so that type is observed too (web-vitals' onINP does
 * the same). At or over the floor the `event` entry exists as well, and the copy is dropped.
 */
export function observeEventTiming(threshold: number, onGroup: (id: number, entries: any[]) => void): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {};
  const floor = Math.max(16, threshold);
  const po = new PerformanceObserver((list) => {
    const byId = new Map<number, any[]>();
    for (const e of list.getEntries() as any[]) {
      const id = e.interactionId;
      if (!id || (e.entryType === 'first-input' && e.duration >= floor)) continue;
      let g = byId.get(id);
      if (!g) byId.set(id, (g = []));
      g.push(e);
    }
    for (const [id, entries] of byId) onGroup(id, entries);
  });
  try {
    po.observe({ type: 'event', buffered: true, durationThreshold: floor } as any);
  } catch {
    return () => {};
  }
  if (supportedEntryTypes().includes('first-input')) po.observe({ type: 'first-input', buffered: true });
  return () => po.disconnect();
}

export function observeFrames(store: FrameSummary[], max = 60, onFrame?: (f: FrameSummary) => void): () => void {
  if (!supportsLongAnimationFrames()) return () => {};
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries() as any[]) {
      const f = summarizeFrame(e);
      store.push(f);
      if (store.length > max) store.splice(0, store.length - max);
      if (onFrame) onFrame(f);
    }
  });
  po.observe({ type: 'long-animation-frame', buffered: true });
  return () => po.disconnect();
}

function summarizeFrame(e: any): FrameSummary {
  const scripts: ScriptSummary[] = (e.scripts || []).map((s: any) => ({
    invoker: s.invoker || '',
    name: s.sourceFunctionName || '',
    source: shortSource(s.sourceURL || ''),
    start: s.startTime,
    duration: s.duration,
    forcedLayout: s.forcedStyleAndLayoutDuration || 0,
  }));
  return {
    start: e.startTime,
    duration: e.duration,
    blocking: e.blockingDuration || 0,
    forcedLayout: scripts.reduce((a, s) => a + s.forcedLayout, 0),
    scripts,
  };
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
