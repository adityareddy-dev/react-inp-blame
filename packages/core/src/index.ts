import { emitRender, emitTrack } from './devtools.ts';
import { hookOwner, hookState, INPUT_TYPES, installHook, noteInput, recentInputs } from './hook.ts';
import { createInpTracker, rateInp, type InpEstimate } from './inp.ts';
import { attachLaterRender, buildReport, isLaterRender, refreshFrames, refreshReport } from './join.ts';
import { observeEventTiming, observeFrames } from './observe.ts';
import { createOverlay, overlayRequested, OVERLAY_ID, type OverlayHandle } from './overlay.ts';
import type { CommitSummary, FrameSummary, InstallOptions, InteractionReport, OverlayOptions } from './types.ts';

export type * from './types.ts';
export type { InpEstimate } from './inp.ts';
export { fiberFromNode, ownerChain, handlerName } from './fiber.ts';
export type { OverlayHandle } from './overlay.ts';

export interface Api {
  reports(): InteractionReport[];
  last(): InteractionReport | null;
  /**
   * The page's INP so far, the estimate web-vitals makes: the interaction at index
   * floor(count / 50) among the 10 longest. Exact when every interaction over 16 ms was seen.
   */
  inp(): InpEstimate | null;
  clear(): void;
  onInteraction(fn: (r: InteractionReport) => void): () => void;
  stats(): { mode: string; owner: string; renderers: number; walks: number; walkTotalMs: number; reports: number; commitsRecorded: number };
  /** Every commit walked so far, in or out of an interaction window. Debugging aid. */
  allCommits(): CommitSummary[];
  dispose(): void;
}

const reports: InteractionReport[] = [];
// Interactions under the threshold, kept only in case a later render attaches to them.
const quiet: InteractionReport[] = [];
// Raw Event Timing entries per interactionId, so a late entry (the click after a held
// pointerdown, a keyup) can rebuild the report it belongs to.
const entriesById = new Map<number, any[]>();
const MAX_ENTRY_SETS = 100;
const listeners = new Set<(r: InteractionReport) => void>();
let installed: Api | null = null;
let overlay: OverlayHandle | null = null;
const FOLLOW_UP_WINDOW_MS = 1500;

/**
 * Must run before react-dom evaluates. The simplest way is
 * `import 'react-inp-blame/auto'` as the first import of your entry module.
 */
export function install(opts: InstallOptions = {}): Api {
  if (installed) return installed;
  if (typeof window === 'undefined') return noop();
  const threshold = opts.threshold ?? 40;
  const devtoolsTrack = opts.devtoolsTrack ?? true;

  const frames: FrameSummary[] = [];
  const inp = createInpTracker();
  const notify = (r: InteractionReport) => {
    for (const fn of listeners) {
      try {
        fn(r);
      } catch {
        // listener errors are theirs
      }
    }
    if (opts.onReport) opts.onReport(r);
  };
  const findReport = (id: number): InteractionReport | null => {
    for (let i = reports.length - 1; i >= 0; i--) if (reports[i].interactionId === id) return reports[i];
    for (let i = quiet.length - 1; i >= 0; i--) if (quiet[i].interactionId === id) return quiet[i];
    return null;
  };

  // A render that lands after the report was emitted (data arrived, an effect fired) still
  // belongs to that input if nothing newer happened. Attach it and re-emit the same report.
  installHook(opts.walkBudget ?? 5000, opts.inputWindow ?? FOLLOW_UP_WINDOW_MS, (c) => {
    const r = reports[reports.length - 1];
    if (r && isLaterRender(r, c)) {
      if (attachLaterRender(r, c, frames)) {
        if (devtoolsTrack) emitRender(r, c);
        notify(r);
      }
      return;
    }
    // A short interaction (a 24 ms click) followed by a heavy render after the paint is worth
    // reporting even though INP alone would not flag it.
    for (let i = quiet.length - 1; i >= 0; i--) {
      const q = quiet[i];
      if (!isLaterRender(q, c)) continue;
      if (attachLaterRender(q, c, frames)) {
        quiet.splice(i, 1);
        publish(q);
      }
      return;
    }
  });
  for (const t of INPUT_TYPES) window.addEventListener(t, noteInput, { capture: true, passive: true });

  const stopFrames = observeFrames(frames, 60, () => {
    // A LoAF can land after the report was built (there is no settle timer); fold it into the
    // last report's window or its later renders and re-notify with the corrected numbers.
    const r = reports[reports.length - 1];
    if (r && refreshFrames(r, frames)) notify(r);
  });
  const publish = (r: InteractionReport) => {
    reports.push(r);
    if (reports.length > 50) reports.shift();
    if (devtoolsTrack) emitTrack(r);
    notify(r);
  };
  // Observe at the browser's floor (16 ms) so short interactions with a heavy later render
  // are not lost, and so the INP estimate sees every interaction it can; everything else
  // under the threshold stays quiet.
  const stopEvents = observeEventTiming(16, (id, batch) => {
    for (const e of batch) inp.add(e);
    const seen = entriesById.get(id);
    const entries = seen ? seen.concat(batch) : batch;
    entriesById.set(id, entries);
    if (entriesById.size > MAX_ENTRY_SETS) entriesById.delete(entriesById.keys().next().value as number);
    const commits = hookState().commits;
    const existing = seen ? findReport(id) : null;
    if (existing) {
      // A late entry of the same interaction: the click after a held pointerdown, the keyup.
      const had = new Set([...existing.commits, ...existing.followUps]);
      const wasQuiet = quiet.includes(existing);
      const headlineChanged = refreshReport(existing, entries, commits, frames, recentInputs());
      if (wasQuiet) {
        if (existing.duration < threshold && !existing.followUps.length) return;
        quiet.splice(quiet.indexOf(existing), 1);
        publish(existing);
        return;
      }
      if (devtoolsTrack) {
        const fresh = [...existing.commits, ...existing.followUps].filter((c) => !had.has(c));
        if (headlineChanged) emitTrack(existing, fresh);
        else for (const c of fresh) emitRender(existing, c);
      }
      notify(existing);
      return;
    }
    const r = buildReport(entries, commits, frames, recentInputs());
    // Clicks on our own badge and panel are not the app's interactions.
    if (r.target?.selector?.includes('#' + OVERLAY_ID)) return;
    if (r.duration < threshold && !r.followUps.length) {
      quiet.push(r);
      if (quiet.length > 20) quiet.shift();
      return;
    }
    publish(r);
  });

  const api: Api = {
    reports: () => reports.slice(),
    last: () => reports[reports.length - 1] || null,
    inp: () => {
      const e = inp.estimate();
      if (!e) return null;
      return { value: e.value, rating: rateInp(e.value), interactionCount: Math.round(e.interactionCount), report: findReport(e.id) };
    },
    clear: () => {
      reports.length = 0;
      quiet.length = 0;
      entriesById.clear();
      hookState().commits.length = 0;
      inp.reset();
    },
    onInteraction,
    stats: () => {
      const h = hookState();
      return {
        mode: h.mode,
        owner: hookOwner(),
        renderers: h.renderers,
        walks: h.walks,
        walkTotalMs: h.walkTotalMs,
        reports: reports.length,
        commitsRecorded: h.commits.length,
      };
    },
    allCommits: () => hookState().commits.slice(),
    dispose: () => {
      stopFrames();
      stopEvents();
      for (const t of INPUT_TYPES) window.removeEventListener(t, noteInput, { capture: true } as any);
      if (overlay) overlay.dispose();
      overlay = null;
      installed = null;
    },
  };

  if (opts.debugGlobal) {
    (window as any)[typeof opts.debugGlobal === 'string' ? opts.debugGlobal : '__REACT_INP__'] = api;
  }
  setTimeout(() => {
    const h = hookState();
    if (h.mode === 'shim' && h.renderers === 0) {
      console.warn(
        '[react-inp-blame] no React renderer registered within 3s. install() has to run before react-dom loads: ' +
          "make `import 'react-inp-blame/auto'` the first import of your entry module.",
      );
    }
  }, 3000);
  installed = api;
  const ov = opts.overlay;
  if (ov === true || (ov === 'query' && overlayRequested()) || (ov && typeof ov === 'object')) {
    overlay = createOverlay(api, typeof ov === 'object' ? ov : {});
  }
  return api;
}

/**
 * Show the badge and panel for an already installed library (for example after
 * `import 'react-inp-blame/auto'`). Installs with defaults if nothing has yet.
 */
export function mountOverlay(opts: OverlayOptions = {}): OverlayHandle | null {
  if (typeof window === 'undefined') return null;
  const api = installed ?? install();
  if (!overlay) overlay = createOverlay(api, opts);
  return overlay;
}

export function onInteraction(fn: (r: InteractionReport) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function noop(): Api {
  return {
    reports: () => [],
    last: () => null,
    inp: () => null,
    clear: () => {},
    onInteraction: () => () => {},
    stats: () => ({ mode: 'none', owner: 'none', renderers: 0, walks: 0, walkTotalMs: 0, reports: 0, commitsRecorded: 0 }),
    allCommits: () => [],
    dispose: () => {},
  };
}
