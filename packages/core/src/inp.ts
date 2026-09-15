import type { InteractionReport } from './types.ts';

/** The page's INP so far, estimated the way web-vitals does it. */
export interface InpEstimate {
  /** Latency of the interaction INP points at: its longest single Event Timing entry, ms. */
  value: number;
  rating: 'good' | 'needs-work' | 'poor';
  /** Interactions on the page so far, counted like web-vitals: `performance.interactionCount` when the browser has it, else estimated from interactionId spacing. */
  interactionCount: number;
  /** The report for that interaction, or null when it stayed under the reporting threshold and has since been dropped. */
  report: InteractionReport | null;
}

/** INP thresholds: good up to 200 ms, needs work up to 500 ms, poor beyond. */
export function rateInp(ms: number): InpEstimate['rating'] {
  return ms <= 200 ? 'good' : ms <= 500 ? 'needs-work' : 'poor';
}

interface Candidate {
  id: number;
  latency: number;
}

// web-vitals keeps the 10 longest interactions and reports the one at index floor(count / 50):
// the worst until 50 interactions, then a rough 98th percentile.
const MAX_CANDIDATES = 10;
// Chrome hands out interactionIds 7 apart, so the spacing between the smallest and largest id
// seen counts interactions the observer never saw (those under its duration threshold).
const ID_STEP = 7;

/**
 * The same estimate web-vitals computes for INP, fed every Event Timing entry the observer
 * sees. Exact when every interaction over the observer's 16 ms floor was seen.
 */
export function createInpTracker() {
  const list: Candidate[] = [];
  const byId = new Map<number, Candidate>();
  let minId = Infinity;
  let maxId = 0;
  let countAtReset = 0;

  function totalCount(): number {
    if (typeof performance !== 'undefined' && 'interactionCount' in performance) return (performance as any).interactionCount || 0;
    return maxId ? (maxId - minId) / ID_STEP + 1 : 0;
  }

  return {
    add(entry: { interactionId: number; duration: number }): void {
      const id = entry.interactionId;
      if (!id) return;
      minId = Math.min(minId, id);
      maxId = Math.max(maxId, id);
      let c = byId.get(id);
      const shortest = list[list.length - 1];
      if (!c && list.length >= MAX_CANDIDATES && entry.duration <= shortest.latency) return;
      if (c) {
        if (entry.duration > c.latency) c.latency = entry.duration;
      } else {
        c = { id, latency: entry.duration };
        byId.set(id, c);
        list.push(c);
      }
      list.sort((a, b) => b.latency - a.latency);
      for (const gone of list.splice(MAX_CANDIDATES)) byId.delete(gone.id);
    },
    /** Interactions since the last reset. */
    count(): number {
      return totalCount() - countAtReset;
    },
    estimate(): { id: number; value: number; interactionCount: number } | null {
      const n = totalCount() - countAtReset;
      const i = Math.min(list.length - 1, Math.floor(n / 50));
      if (i < 0) return null;
      return { id: list[i].id, value: list[i].latency, interactionCount: n };
    },
    /** Forget the candidates; the count keeps running from here, the way web-vitals resets on a soft navigation. */
    reset(): void {
      countAtReset = totalCount();
      list.length = 0;
      byId.clear();
    },
  };
}
