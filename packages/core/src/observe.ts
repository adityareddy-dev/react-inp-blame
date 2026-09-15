import type { FrameSummary, ScriptSummary } from './types.ts';

/**
 * Hands over Event Timing entries grouped by interactionId, one call per id per observer
 * batch. Entries of one interaction arrive with the paint that presented them: a pointerdown
 * in one frame, the pointerup and click in a later one, a keydown before its keyup. Nothing
 * waits here; the caller merges a later batch into the report it already built.
 */
export function observeEventTiming(threshold: number, onGroup: (id: number, entries: any[]) => void): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {};
  const po = new PerformanceObserver((list) => {
    const byId = new Map<number, any[]>();
    for (const e of list.getEntries() as any[]) {
      const id = e.interactionId;
      if (!id) continue;
      let g = byId.get(id);
      if (!g) byId.set(id, (g = []));
      g.push(e);
    }
    for (const [id, entries] of byId) onGroup(id, entries);
  });
  try {
    po.observe({ type: 'event', buffered: true, durationThreshold: Math.max(16, threshold) } as any);
  } catch {
    return () => {};
  }
  return () => po.disconnect();
}

export function observeFrames(store: FrameSummary[], max = 60, onFrame?: (f: FrameSummary) => void): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {};
  const types = (PerformanceObserver as any).supportedEntryTypes as string[] | undefined;
  if (!types || !types.includes('long-animation-frame')) return () => {};
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
