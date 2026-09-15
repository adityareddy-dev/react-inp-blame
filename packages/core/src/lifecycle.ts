import { createInpTracker, rateInp, type InpEstimate } from './inp.ts';
import { attachLaterRender, buildReport, isLaterRender, refreshFrames, refreshReport } from './join.ts';
import type { InteractionTiming } from './observe.ts';
import { OVERLAY_ID } from './overlay-host.ts';
import type { CommitSummary, FrameSummary, InputRecord, InteractionReport } from './types.ts';

/**
 * What happens to reports between the first Event Timing entry of an interaction and the last
 * render that joins it: built, held back while quiet, published, rebuilt when late entries or
 * frames arrive, extended by later renders, and dropped past the limits below. It reads no browser
 * globals: install() feeds it from the observers and the DevTools hook, and hands it a clock.
 */

/** Published reports kept; the oldest goes first. */
export const MAX_REPORTS = 50;
/** Interactions under the threshold kept in case a later render makes them worth publishing. */
export const MAX_QUIET = 20;
/** Interactions whose raw entries are kept, so a late entry can rebuild the report it belongs to. */
export const MAX_ENTRY_SETS = 100;

export interface LifecycleOptions {
  /** Interactions at or above this duration (ms) are published at once; shorter ones when a later render joins them. */
  threshold: number;
  /** React commits walked so far, oldest first. */
  commits(): CommitSummary[];
  /** The ring of recent inputs, oldest first. */
  inputs(): InputRecord[];
  /** Long animation frames seen so far, kept current by the caller; null where the browser has none. */
  frames: FrameSummary[] | null;
  /** Reads `performance.interactionCount`, on browsers that have it. */
  interactionCount: (() => number) | null;
  /** The clock Event Timing and the commits use: `performance.now()`. */
  now(): number;
  /** Called when a report is published, and again every time a published report changes. */
  publish(r: InteractionReport): void;
}

export interface Lifecycle {
  /** One observer batch of Event Timing entries. */
  onEntries(batch: readonly InteractionTiming[]): void;
  /** A commit the DevTools hook walked. */
  onCommit(c: CommitSummary): void;
  /** A long animation frame arrived; `frames` already holds it. */
  onFrame(): void;
  /** Published reports, oldest first. */
  reports(): InteractionReport[];
  last(): InteractionReport | null;
  inp(): InpEstimate | null;
  /** Drops every report and entry, and starts the INP estimate over. */
  clear(): void;
  /** Time spent building and updating reports since creation, ms. Listeners' time is theirs and not in it. */
  spentMs(): number;
}

export function createLifecycle(options: LifecycleOptions): Lifecycle {
  const { threshold, frames, now, publish } = options;
  const published: InteractionReport[] = [];
  // Interactions under the threshold, kept only in case a later render attaches to them.
  const quiet: InteractionReport[] = [];
  // Raw Event Timing entries per interactionId, so a late entry (the click after a held
  // pointerdown, a keyup) can rebuild the report it belongs to.
  const entriesById = new Map<number, InteractionTiming[]>();
  const inp = createInpTracker(options.interactionCount);
  let spent = 0;

  /** Adds the time since `started` to the total, and to the report it was spent on. */
  const charge = (r: InteractionReport | null, started: number) => {
    const ms = now() - started;
    spent += ms;
    if (r) r.overheadMs += ms;
  };
  const worthPublishing = (r: InteractionReport) => r.duration >= threshold || r.followUps.length > 0;
  const keep = (r: InteractionReport) => {
    published.push(r);
    if (published.length > MAX_REPORTS) published.shift();
  };
  const holdBack = (r: InteractionReport) => {
    quiet.push(r);
    if (quiet.length > MAX_QUIET) quiet.shift();
  };
  const find = (id: number): InteractionReport | null => {
    for (let i = published.length - 1; i >= 0; i--) if (published[i].interactionId === id) return published[i];
    for (let i = quiet.length - 1; i >= 0; i--) if (quiet[i].interactionId === id) return quiet[i];
    return null;
  };

  function onInteraction(id: number, batch: InteractionTiming[]): void {
    const started = now();
    const seen = entriesById.get(id);
    const entries = seen ? seen.concat(batch) : batch;
    // Re-inserted, so the limit drops the interaction heard from longest ago.
    entriesById.delete(id);
    entriesById.set(id, entries);
    if (entriesById.size > MAX_ENTRY_SETS) entriesById.delete(entriesById.keys().next().value as number);

    const existing = seen ? find(id) : null;
    if (existing) {
      // A late entry of the same interaction: the click after a held pointerdown, the keyup.
      const wasQuiet = quiet.includes(existing);
      refreshReport(existing, entries, options.commits(), frames, options.inputs());
      charge(existing, started);
      if (wasQuiet) {
        if (!worthPublishing(existing)) return;
        quiet.splice(quiet.indexOf(existing), 1);
        keep(existing);
      }
      publish(existing);
      return;
    }
    const r = buildReport(entries, options.commits(), frames, options.inputs());
    charge(r, started);
    // Clicks on the badge and panel are not the app's interactions.
    if (r.target?.selector?.includes('#' + OVERLAY_ID)) return;
    if (!worthPublishing(r)) return holdBack(r);
    keep(r);
    publish(r);
  }

  return {
    onEntries(batch) {
      const started = now();
      inp.add(batch);
      charge(null, started);
      const byId = new Map<number, InteractionTiming[]>();
      for (const e of batch) {
        const group = byId.get(e.interactionId);
        if (group) group.push(e);
        else byId.set(e.interactionId, [e]);
      }
      for (const [id, group] of byId) onInteraction(id, group);
    },

    onCommit(c) {
      const started = now();
      // A render that lands after the report was published (data arrived, an effect fired) still
      // belongs to that input if nothing newer happened. Attach it and publish the report again.
      const last = published[published.length - 1];
      if (last && isLaterRender(last, c)) {
        const attached = attachLaterRender(last, c, frames);
        charge(last, started);
        if (attached) publish(last);
        return;
      }
      // A short interaction (a 24 ms click) followed by a heavy render after the paint is worth
      // reporting even though INP alone would not flag it.
      for (let i = quiet.length - 1; i >= 0; i--) {
        const q = quiet[i];
        if (!isLaterRender(q, c)) continue;
        const attached = attachLaterRender(q, c, frames);
        if (attached) {
          quiet.splice(i, 1);
          keep(q);
        }
        charge(q, started);
        if (attached) publish(q);
        return;
      }
      charge(null, started);
    },

    onFrame() {
      // A long animation frame can land after the report was built; fold it into the last report's
      // window or its later renders and publish the corrected numbers.
      const r = published[published.length - 1];
      if (!r || !frames) return;
      const started = now();
      const changed = refreshFrames(r, frames);
      charge(r, started);
      if (changed) publish(r);
    },

    reports: () => published.slice(),
    last: () => published[published.length - 1] ?? null,
    inp() {
      const e = inp.estimate();
      if (!e) return null;
      return { value: e.value, rating: rateInp(e.value), interactionId: e.id, interactionCount: Math.round(e.interactionCount), report: find(e.id) };
    },
    clear() {
      published.length = 0;
      quiet.length = 0;
      entriesById.clear();
      inp.reset();
    },
    spentMs: () => spent,
  };
}
