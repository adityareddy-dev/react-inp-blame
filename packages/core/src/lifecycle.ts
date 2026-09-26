import type { InputRecord } from './hook.js';
import { createInpTracker, rateInp, type InpEstimate } from './inp.js';
import { attachLaterRender, awaitsEntry, buildReport, interactionTarget, isLaterRender, refreshFrames, refreshReport, sealReport, timed, type LabelSource, type ReportData } from './join.js';
import type { PageNavigation } from './navigation.js';
import type { InteractionTiming } from './observe.js';
import { inOverlay } from './overlay-host.js';
import type { CommitSummary, FrameSummary, InteractionReport, ReactStatus } from './types.js';

/**
 * What happens to reports between the first Event Timing entry of an interaction and the last
 * render that joins it: built, held back while quiet, published, revised when late entries,
 * frames or later renders arrive, and dropped past the limits below. Every revision is published
 * as a new frozen report. A navigation starts the INP estimate over and lets go of the quiet ones.
 * It reads no browser globals: install() feeds it from the observers, the DevTools hook and the
 * page's navigations, and hands it a clock.
 */

/**
 * Published reports kept. Past it the oldest goes first, unless it is one of the `KEPT_SLOWEST` or INP can
 * still point at it: the estimate's report, and those of the candidates it moves down to as more
 * interactions are counted. The estimate's alone was not enough: 50 interactions after a navigation it
 * moved to a report already gone.
 */
export const MAX_REPORTS = 50;
/**
 * The slowest published reports, kept however old they are: as many as web-vitals keeps candidates for
 * INP. Kept first in, first out, the reports of sixty quick rectangles drawn in excalidraw pushed out the
 * key press that was the page's INP. They outlive a soft navigation too, where the estimate starts over
 * and web-vitals, unless asked to report soft navigations, does not.
 */
export const KEPT_SLOWEST = 10;
/** Interactions under the threshold kept in case a later render makes them worth publishing. */
export const MAX_QUIET = 20;
/** Interactions whose raw entries are kept, so a late entry can rebuild the report it belongs to. */
export const MAX_ENTRY_SETS = 100;

export interface LifecycleOptions {
  /** Interactions at or above this duration (ms) are published at once; shorter ones when a later render INP left out joins them. */
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
  /** Whether React can be seen as the next report is built (`Stats.react`); 'reading' where not given. */
  reactStatus?(): ReactStatus;
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
  /**
   * The page was hidden: the INP estimate is chosen again at the interaction count by then, as web-vitals
   * chooses when it reports on hide, and a later render stops waiting on an entry (`awaitsEntry`).
   */
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
  // Only a later render INP left out makes a quick interaction worth publishing. INP timed the one a
  // press's release made inside its own entry, and one stamped with a release whose entry has not come
  // may be inside it (`awaitsEntry`), so it waits for that entry unless `settle` says none will come. Not
  // one `threshold` or more after the release: an entry holding that would publish the interaction anyway.
  const worthPublishing = (data: ReportData) =>
    data.duration >= threshold || data.followUps.some((c) => !timed(c, data.entries) && (c.sinceInput >= threshold || !awaitsEntry(c, data.entries)));
  const keep = (held: Held) => {
    published.push(held);
    if (published.length <= MAX_REPORTS) return;
    const inpIds = [inp.estimate()?.id, ...inp.candidates()];
    // A stable sort, so of equal durations the older is kept.
    const slowest = published.slice().sort((a, b) => b.data.duration - a.data.duration).slice(0, KEPT_SLOWEST);
    published.splice(published.findIndex((h) => !inpIds.includes(h.data.interactionId) && !slowest.includes(h)), 1);
  };
  const holdBack = (held: Held) => {
    quiet.push(held);
    if (quiet.length > MAX_QUIET) quiet.shift();
  };
  /**
   * Publishes a quiet interaction whose render INP left out was waiting for a release's entry, once that
   * entry will not come. A newer interaction's entry never comes before it, so one in `batch` means the
   * release painted under the 16 ms floor and sent none, and once the page is hidden (`batch` null)
   * nothing waits. An interaction with entries in the batch is judged on those instead. The untimed
   * renders of a quiet interaction are all waiting ones: any other would have published it.
   */
  const settle = (batch: readonly InteractionTiming[] | null) => {
    for (const held of quiet.slice()) {
      const { interactionId, entries, followUps } = held.data;
      if (batch?.some((e) => e.interactionId === interactionId)) continue;
      if (!followUps.some((c) => !timed(c, entries) && (!batch || batch.some((e) => e.startTime > c.inputTs)))) continue;
      quiet.splice(quiet.indexOf(held), 1);
      keep(held);
      publish(held.report);
    }
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
      revise(existing, refreshReport(existing.data, entries, options.commits(), frames, options.inputs(), options.labels(), options.navigations(), inputWindow, options.reactStatus?.()), started);
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
    const held = revise(null, buildReport(entries, options.commits(), frames, options.inputs(), options.labels(), options.navigations(), inputWindow, options.reactStatus?.()), started);
    if (!worthPublishing(held.data)) return holdBack(held);
    keep(held);
    publish(held.report);
  }

  return {
    onEntries(batch) {
      const started = now();
      inp.add(batch.filter((e) => e.startTime >= navigationStart));
      spend(started);
      // Before the batch's own interactions, so the newest report is still the last published.
      settle(batch);
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
      // reporting even though INP alone would not flag it. The render a press's own release made is not:
      // it stays quiet with the render held, and a later one INP left out can still publish it.
      for (let i = quiet.length - 1; i >= 0; i--) {
        const held = quiet[i];
        if (!held || !isLaterRender(held.data, c, inputs, inputWindow)) continue;
        const next = attachLaterRender(held.data, c, frames);
        if (!next) break;
        revise(held, next, started);
        if (!worthPublishing(held.data)) return;
        quiet.splice(i, 1);
        keep(held);
        publish(held.report);
        return;
      }
      spend(started);
    },

    onFrame() {
      // A long animation frame can land after the report was built; fold it into the window or the later
      // renders of every report it overlaps and publish the corrected numbers. Not only the newest one:
      // Control and z pressed 8 ms apart share the frame the undo ran in, and Control's report is the older.
      if (!frames) return;
      for (const held of published) {
        const started = now();
        const next = refreshFrames(held.data, frames);
        if (next) publish(revise(held, next, started).report);
        else spend(started);
      }
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
      settle(null);
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
