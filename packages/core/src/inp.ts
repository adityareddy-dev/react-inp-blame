import type { InteractionReport } from './types.js';

/** The INP of the navigation the page is on, so far, estimated the way web-vitals does it. */
export interface InpEstimate {
  /** Latency of the interaction INP points at: its longest single Event Timing entry, ms. */
  value: number;
  rating: 'good' | 'needs-work' | 'poor';
  /** The `interactionId` of that interaction. */
  interactionId: number;
  /** Interactions on the page so far, counted like web-vitals: `performance.interactionCount` when the browser has it, else estimated from interactionId spacing. */
  interactionCount: number;
  /** The report for that interaction, or null when it stayed under the reporting threshold and has since been dropped. */
  report: InteractionReport | null;
}

/** INP thresholds: good up to 200 ms, needs work up to 500 ms, poor beyond. */
export function rateInp(ms: number): InpEstimate['rating'] {
  return ms <= 200 ? 'good' : ms <= 500 ? 'needs-work' : 'poor';
}

/** An Event Timing entry, reduced to what the estimate reads. */
export interface TimedInteraction {
  entryType: string;
  interactionId: number;
  startTime: number;
  duration: number;
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

const presented = (e: TimedInteraction) => e.startTime + e.duration;

/**
 * The estimate web-vitals' `onINP` makes, fed every batch of Event Timing entries the observer
 * hands over. It takes each batch in the order web-vitals does, sorted by the time its entries were
 * presented, so two interactions of equal latency rank the same in both and the one INP points at
 * is the same interaction, not only the same number. `apps/demo/e2e/inp.spec.ts` checks it against
 * web-vitals 6.2.2 run with `durationThreshold: 16` after every interaction of a session.
 *
 * `nativeCount` reads `performance.interactionCount` on browsers that have it, as web-vitals does;
 * without it the count comes from the spacing of `event` entry ids, the way web-vitals' polyfill
 * counts (a `first-input` entry does not widen the spacing there, so it does not here).
 *
 * Where the two can still differ on one page:
 * - web-vitals observes at 40 ms unless given `durationThreshold: 16`. At 40, interactions of 16 to
 *   40 ms are not its candidates, so the numbers part when INP is under 40 ms or fewer than
 *   floor(count / 50) + 1 interactions reach 40 ms.
 * - web-vitals starts over after a back/forward cache restore, and at each soft navigation when
 *   asked to report them. The library calls `reset()` at both, and on `clear()`, which web-vitals has
 *   no match for; at a soft navigation web-vitals is not asked to report, only this estimate starts over.
 * - web-vitals updates once the page is idle, this estimate as entries arrive, so for a moment after
 *   an interaction this one can be ahead.
 */
export function createInpTracker(nativeCount: (() => number) | null) {
  const list: Candidate[] = [];
  const byId = new Map<number, Candidate>();
  let minId = Infinity;
  let maxId = 0;
  let countAtReset = 0;
  // Chosen after each batch, as web-vitals chooses after each batch it processes, and kept while the
  // value stays the same: web-vitals moves its reported interaction only when INP changes, so an
  // interaction of equal latency taking the candidate's place does not move it.
  let current: { id: number; value: number; interactionCount: number } | null = null;

  function totalCount(): number {
    if (nativeCount) return nativeCount();
    return maxId ? (maxId - minId) / ID_STEP + 1 : 0;
  }

  function addEntry(entry: TimedInteraction): void {
    const id = entry.interactionId;
    if (!id) return;
    if (entry.entryType === 'event') {
      minId = Math.min(minId, id);
      maxId = Math.max(maxId, id);
    }
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
    // A stable sort: interactions of equal latency keep the order they were first seen in.
    list.sort((a, b) => b.latency - a.latency);
    for (const gone of list.splice(MAX_CANDIDATES)) byId.delete(gone.id);
  }

  function choose(): void {
    const n = totalCount() - countAtReset;
    const i = Math.min(list.length - 1, Math.floor(n / 50));
    if (i < 0) return;
    const candidate = list[i];
    if (current && candidate.latency === current.value) current.interactionCount = n;
    else current = { id: candidate.id, value: candidate.latency, interactionCount: n };
  }

  return {
    /** One observer batch, in any order. */
    add(batch: readonly TimedInteraction[]): void {
      for (const entry of batch.slice().sort((a, b) => presented(a) - presented(b))) addEntry(entry);
      choose();
    },
    /** Interactions since the last reset. */
    count(): number {
      return totalCount() - countAtReset;
    },
    /** INP as of the last batch, with the interaction count it was chosen at. */
    estimate(): { id: number; value: number; interactionCount: number } | null {
      return current && { ...current };
    },
    /** Forget the candidates; the count keeps running from here, the way web-vitals starts over after a back/forward cache restore. */
    reset(): void {
      countAtReset = totalCount();
      list.length = 0;
      byId.clear();
      current = null;
    },
  };
}
