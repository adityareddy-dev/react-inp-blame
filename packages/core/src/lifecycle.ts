import { createInpTracker, rateInp, type InpEstimate } from './inp.js';
import { attachLaterRender, buildReport, interactionTarget, isLaterRender, refreshFrames, refreshReport, sealReport, type LabelSource, type ReportData } from './join.js';
import type { PageNavigation } from './navigation.js';
import type { InteractionTiming } from './observe.js';
import { inOverlay } from './overlay-host.js';
import type { CommitSummary, FrameSummary, InputRecord, InteractionReport } from './types.js';

/**
 * What happens to reports between the first Event Timing entry of an interaction and the last
 * render that joins it: built, held back while quiet, published, revised when late entries,
 * frames or later renders arrive, and dropped past the limits below. Every revision is published
 * as a new frozen report. A navigation starts the INP estimate over and lets go of the quiet ones.
 * It reads no browser globals: install() feeds it from the observers, the DevTools hook and the
 * page's navigations, and hands it a clock.
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
  /** How long after the paint a render can still join an interaction as its later render, ms (`InstallOptions.inputWindow`). */
  inputWindow: number;
  /** React commits walked so far, oldest first. */
  commits(): readonly CommitSummary[];
  /** The ring of recent inputs, oldest first. */
  inputs(): readonly InputRecord[];
  /** The page's navigations, oldest first: each report is placed in the one it happened in. */
  navigations(): readonly PageNavigation[];
  /** Long animation frames seen so far, kept current by the caller; null where the browser has none. */
  frames: readonly FrameSummary[] | null;
  /** Reads `performance.interactionCount`, on browsers that have it. */
  interactionCount: (() => number) | null;
  /** Where the labels of the next report built may come from (`InstallOptions.labels`). */
  labels(): LabelSource;
  /** The clock Event Timing and the commits use: `performance.now()`. */
  now(): number;
  /** Called with each report when it is published, and with every later revision of it: a new frozen report each time. */
  publish(r: InteractionReport): void;
}

export interface Lifecycle {
  /** One observer batch of Event Timing entries. */
  onEntries(batch: readonly InteractionTiming[]): void;
  /** A commit the DevTools hook walked. */
  onCommit(c: CommitSummary): void;
  /** A long animation frame arrived; `frames` already holds it. */
  onFrame(): void;
  /** A navigation began at `start` (`performance.now()`); `navigations` already holds it. */
  onNavigation(start: number): void;
  /** The page was hidden: the INP estimate is chosen again at the interaction count by then, as web-vitals chooses when it reports on hide. */
  onHidden(): void;
  /** Published reports, oldest first, each at its latest revision. */
  reports(): InteractionReport[];
  last(): InteractionReport | null;
  inp(): InpEstimate | null;
  /** Drops every report and entry, and starts the INP estimate over. */
  clear(): void;
  /** Time spent building and revising reports since creation, ms. Listeners' time is theirs and not in it. */
  spentMs(): number;
}

/** An interaction the lifecycle holds: the data it revises, and the frozen report of its current revision. */
interface Held {
  data: ReportData;
  report: InteractionReport;
}

export function createLifecycle(options: LifecycleOptions): Lifecycle {
  const { threshold, inputWindow, frames, now, publish } = options;
  const published: Held[] = [];
  // Interactions under the threshold, kept only in case a later render attaches to them.
  const quiet: Held[] = [];
  // Raw Event Timing entries per interactionId, so a late entry (the click after a held
  // pointerdown, a keyup) can rebuild the report it belongs to.
  const entriesById = new Map<number, InteractionTiming[]>();
  const inp = createInpTracker(options.interactionCount);
  // When the navigation the page is on began: interactions that began earlier are not part of its INP.
  let navigationStart = 0;
  let spent = 0;

  /** Adds the time since `started` to the total, and returns it. */
  const spend = (started: number): number => {
    const ms = now() - started;
    spent += ms;
    return ms;
  };
  /**
   * Makes `data` the interaction's current revision and seals it, charged with the time spent on it
   * since `started`. The report is frozen, so its cost is added before it exists.
   */
  const revise = (held: Held | null, data: ReportData, started: number): Held => {
    const charged = { ...data, overheadMs: data.overheadMs + spend(started) };
    const report = sealReport(charged);
    if (!held) return { data: charged, report };
    held.data = charged;
    held.report = report;
    return held;
  };
  const worthPublishing = (data: ReportData) => data.duration >= threshold || data.followUps.length > 0;
  const keep = (held: Held) => {
    published.push(held);
    if (published.length > MAX_REPORTS) published.shift();
  };
  const holdBack = (held: Held) => {
    quiet.push(held);
    if (quiet.length > MAX_QUIET) quiet.shift();
  };
  const find = (id: number): Held | null => {
    for (const list of [published, quiet]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const held = list[i];
        if (held && held.data.interactionId === id) return held;
      }
    }
    return null;
  };

  function onInteraction(id: number, batch: InteractionTiming[]): void {
    const started = now();
    const seen = entriesById.get(id);
    // The page's first input can arrive twice, as its `first-input` entry and later as its `event` entry.
    const fresh = seen ? batch.filter((e) => !seen.some((held) => held.name === e.name && held.startTime === e.startTime)) : batch;
    if (!fresh.length) {
      spend(started);
      return;
    }
    const entries = seen ? seen.concat(fresh) : fresh;
    // Re-inserted, so the limit drops the interaction heard from longest ago.
    entriesById.delete(id);
    entriesById.set(id, entries);
    if (entriesById.size > MAX_ENTRY_SETS) entriesById.delete(entriesById.keys().next().value as number);

    const existing = seen ? find(id) : null;
    if (existing) {
      // A late entry of the same interaction: the click after a held pointerdown, the keyup.
      const wasQuiet = quiet.includes(existing);
      revise(existing, refreshReport(existing.data, entries, options.commits(), frames, options.inputs(), options.labels(), options.navigations(), inputWindow), started);
      if (wasQuiet) {
        if (!worthPublishing(existing.data)) return;
        quiet.splice(quiet.indexOf(existing), 1);
        keep(existing);
      }
      publish(existing.report);
      return;
    }
    // Clicks on the badge and panel are not the app's interactions.
    if (inOverlay(interactionTarget(entries, options.inputs()))) {
      spend(started);
      return;
    }
    const held = revise(null, buildReport(entries, options.commits(), frames, options.inputs(), options.labels(), options.navigations(), inputWindow), started);
    if (!worthPublishing(held.data)) return holdBack(held);
    keep(held);
    publish(held.report);
  }

  return {
    onEntries(batch) {
      const started = now();
      inp.add(batch.filter((e) => e.startTime >= navigationStart));
      spend(started);
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
      // belongs to that input if nothing newer happened. Attach it and publish the next revision.
      const last = published[published.length - 1];
      const inputs = options.inputs();
      if (last && isLaterRender(last.data, c, inputs, inputWindow)) {
        const next = attachLaterRender(last.data, c, frames);
        if (next) publish(revise(last, next, started).report);
        else spend(started);
        return;
      }
      // A short interaction (a 24 ms click) followed by a heavy render after the paint is worth
      // reporting even though INP alone would not flag it.
      for (let i = quiet.length - 1; i >= 0; i--) {
        const held = quiet[i];
        if (!held || !isLaterRender(held.data, c, inputs, inputWindow)) continue;
        const next = attachLaterRender(held.data, c, frames);
        if (!next) break;
        quiet.splice(i, 1);
        keep(revise(held, next, started));
        publish(held.report);
        return;
      }
      spend(started);
    },

    onFrame() {
      // A long animation frame can land after the report was built; fold it into the last report's
      // window or its later renders and publish the corrected numbers.
      const last = published[published.length - 1];
      if (!last || !frames) return;
      const started = now();
      const next = refreshFrames(last.data, frames);
      if (next) publish(revise(last, next, started).report);
      else spend(started);
    },

    onNavigation(start) {
      navigationStart = start;
      inp.reset('navigation');
      // Renders of the page it moves to, stamped with an input from before it, would otherwise publish
      // quiet interactions from the page it left as if they had caused them.
      quiet.length = 0;
    },

    onHidden() {
      const started = now();
      inp.update();
      spend(started);
    },

    reports: () => published.map((held) => held.report),
    last: () => published[published.length - 1]?.report ?? null,
    inp() {
      const e = inp.estimate();
      if (!e) return null;
      const report = e.id === null ? null : (find(e.id)?.report ?? null);
      return { value: e.value, rating: rateInp(e.value), interactionId: e.id, interactionCount: Math.round(e.interactionCount), report };
    },
    clear() {
      published.length = 0;
      quiet.length = 0;
      entriesById.clear();
      inp.reset('clear');
    },
    spentMs: () => spent,
  };
}
