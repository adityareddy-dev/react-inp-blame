import type { InteractionReport, Rating } from './types.js';

/** The INP of the navigation the page is on, so far, estimated the way web-vitals does it. */
export interface InpEstimate {
  /** Latency of the interaction INP points at: its longest single Event Timing entry, ms. */
  value: number;
  rating: Rating;
  /**
   * The `interactionId` of that interaction. Null for the 8 ms web-vitals reports after a soft navigation
   * or a restore from the back/forward cache when interactions were counted but every one painted too
   * quickly for an Event Timing entry.
   */
  interactionId: number | null;
  /** Interactions on the page so far, counted like web-vitals: `performance.interactionCount` when the browser has it, else estimated from interactionId spacing. */
  interactionCount: number;
  /** The report for that interaction, or null when it stayed under the reporting threshold and has since been dropped. */
  report: InteractionReport | null;
}

/** INP's thresholds, web-vitals' `INPThresholds`: good up to the first, needs improvement up to the second. */
const GOOD_INP_MS = 200;
const NEEDS_IMPROVEMENT_INP_MS = 500;

export function rateInp(ms: number): Rating {
  return ms <= GOOD_INP_MS ? 'good' : ms <= NEEDS_IMPROVEMENT_INP_MS ? 'needs-improvement' : 'poor';
}

/** An Event Timing entry, reduced to what the estimate reads. */
export interface TimedInteraction {
  entryType: string;
  interactionId: number;
  startTime: number;
  duration: number;
}

interface Candidate {
  id: number | null;
  latency: number;
}

// web-vitals keeps the 10 longest interactions and reports the one at index floor(count / 50), or the
// last it kept when fewer arrived: the worst until 50 interactions, then a rough 98th percentile.
const MAX_CANDIDATES = 10;
const INTERACTIONS_PER_CANDIDATE = 50;
// Chrome hands out interactionIds 7 apart, so the spacing between the smallest and largest id
// seen counts interactions the observer never saw (those under its duration threshold).
const ID_STEP = 7;
// What web-vitals reports after a soft navigation or a back/forward cache restore when interactions were
// counted but none was seen: each painted under the 16 ms floor, so it stands in half of that.
const UNSEEN_INTERACTION = { id: null, latency: 8 } as const;

const presented = (e: TimedInteraction) => e.startTime + e.duration;

/**
 * The estimate web-vitals' `onINP` makes, fed every batch of Event Timing entries the observer
 * hands over. It takes each batch in the order web-vitals does, sorted by the time its entries were
 * presented, so two interactions of equal latency rank the same in both and the one INP points at
 * is the same interaction, not only the same number. It chooses after each batch and again when the
 * page is hidden (`update()`), the two moments web-vitals chooses at. `apps/demo/e2e/inp.spec.ts` checks
 * it against web-vitals 6.2.2 run with `durationThreshold: 16` after every interaction of a session.
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
 *   an interaction this one can be ahead. When the page is hidden, web-vitals also takes the entries
 *   its observer has not delivered yet; this estimate takes them when they are delivered.
 * - Next.js 16.3's `useReportWebVitals` runs the web-vitals 4 it vendors, which after a back/forward
 *   cache restore keeps counting every interaction since the page loaded. Past 50 interactions before
 *   a restore, it and this estimate can point at different interactions.
 */
export function createInpTracker(nativeCount: (() => number) | null) {
  const list: Candidate[] = [];
  const byId = new Map<number, Candidate>();
  let minId = Infinity;
  let maxId = 0;
  let countAtReset = 0;
  // Set by a reset for a navigation, after which web-vitals stands in for interactions it counted but never saw.
  let afterNavigation = false;
  // Kept while the value stays the same: web-vitals moves its reported interaction only when INP
  // changes, so an interaction of equal latency taking the candidate's place does not move it.
  let current: { id: number | null; value: number; interactionCount: number } | null = null;

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
    if (!c && shortest && list.length >= MAX_CANDIDATES && entry.duration <= shortest.latency) return;
    if (c) {
      if (entry.duration > c.latency) c.latency = entry.duration;
    } else {
      c = { id, latency: entry.duration };
      byId.set(id, c);
      list.push(c);
    }
    // A stable sort: interactions of equal latency keep the order they were first seen in.
    list.sort((a, b) => b.latency - a.latency);
    for (const gone of list.splice(MAX_CANDIDATES)) if (gone.id !== null) byId.delete(gone.id);
  }

  function choose(): void {
    const n = totalCount() - countAtReset;
    const candidate = list[Math.min(list.length - 1, Math.floor(n / INTERACTIONS_PER_CANDIDATE))] ?? (afterNavigation && n > 0 ? UNSEEN_INTERACTION : null);
    if (!candidate) return;
    if (current && candidate.latency === current.value) current.interactionCount = n;
    else current = { id: candidate.id, value: candidate.latency, interactionCount: n };
  }

  return {
    /** One observer batch, in any order. */
    add(batch: readonly TimedInteraction[]): void {
      for (const entry of batch.slice().sort((a, b) => presented(a) - presented(b))) addEntry(entry);
      choose();
    },
    /** Chooses again at the interaction count by now, as web-vitals does when the page is hidden: interactions too quick to be observed still count. */
    update(): void {
      choose();
    },
    /** INP as last chosen, with the interaction count it was chosen at. */
    estimate(): { id: number | null; value: number; interactionCount: number } | null {
      return current && { ...current };
    },
    /** The interactionIds of the candidates, slowest first: those INP can move to as more interactions are counted. */
    candidates(): (number | null)[] {
      return list.map((c) => c.id);
    },
    /**
     * Forgets the candidates; the count keeps running from here. At a navigation, the way web-vitals
     * starts over after a back/forward cache restore or a soft navigation; at `clear()`, which web-vitals
     * has no match for.
     */
    reset(cause: 'navigation' | 'clear'): void {
      countAtReset = totalCount();
      list.length = 0;
      byId.clear();
      current = null;
      afterNavigation = cause === 'navigation';
    },
  };
}
