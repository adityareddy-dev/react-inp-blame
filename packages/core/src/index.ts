import { emitRender, emitTrack } from './devtools.ts';
import { hookStats, INPUT_TYPES, installHook, noteInput, recentInputs, recordedCommits, uninstallHook } from './hook.ts';
import { createInpTracker, rateInp, type InpEstimate } from './inp.ts';
import { attachLaterRender, buildReport, isLaterRender, refreshFrames, refreshReport } from './join.ts';
import { observeEventTiming, observeFrames, supportsInteractions, supportsLongAnimationFrames } from './observe.ts';
import { createOverlay, overlayRequested, OVERLAY_ID, type OverlayHandle } from './overlay.ts';
import type { CommitSummary, FrameSummary, InstallOptions, InteractionReport, OverlayOptions, Stats } from './types.ts';
import { warnOnce } from './warn.ts';

export type * from './types.ts';
export type { InpEstimate } from './inp.ts';
export type { Fiber } from './fiber.ts';
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
  stats(): Stats;
  /** Every commit walked so far, in or out of an interaction window. Debugging aid. */
  allCommits(): CommitSummary[];
  /** Undoes install(): listeners, observers, the overlay, the debug global and any wrapping of a chained hook. A later install() starts fresh. */
  dispose(): void;
}

/** The options only a first install() can set; a later call that changes one is warned about. */
type Settings = Required<Pick<InstallOptions, 'threshold' | 'devtoolsTrack' | 'walkBudget' | 'inputWindow' | 'debugGlobal' | 'hook'>>;

interface Installation {
  api: Api;
  /** Applies the options of a later install() call that can change while installed. */
  reapply(opts: InstallOptions): void;
}

const listeners = new Set<(r: InteractionReport) => void>();
let installed: Installation | null = null;
let overlay: OverlayHandle | null = null;
const FOLLOW_UP_WINDOW_MS = 1500;
const MAX_ENTRY_SETS = 100;

/**
 * Must run before react-dom evaluates. The simplest way is
 * `import 'react-inp-blame/auto'` as the first import of your entry module. Calling it again
 * while installed applies `overlay` and `onReport` and returns the same API.
 */
export function install(opts: InstallOptions = {}): Api {
  if (typeof window === 'undefined') return noop('none');
  if (installed) {
    installed.reapply(opts);
    return installed.api;
  }
  if (!supportsInteractions()) {
    warnOnce('unsupported-browser', 'this browser has no Event Timing interactionId (Chrome 96, Firefox 144, Safari 26.2), so nothing was installed.');
    const api = noop('unsupported');
    const name = debugGlobalName(opts.debugGlobal);
    if (name) (window as any)[name] = api;
    return api;
  }

  const settings: Settings = {
    threshold: opts.threshold ?? 40,
    devtoolsTrack: opts.devtoolsTrack ?? true,
    walkBudget: opts.walkBudget ?? 5000,
    inputWindow: opts.inputWindow ?? FOLLOW_UP_WINDOW_MS,
    debugGlobal: opts.debugGlobal ?? false,
    hook: opts.hook ?? 'auto',
  };
  const { threshold, devtoolsTrack } = settings;
  let onReport = opts.onReport;

  const reports: InteractionReport[] = [];
  // Interactions under the threshold, kept only in case a later render attaches to them.
  const quiet: InteractionReport[] = [];
  // Raw Event Timing entries per interactionId, so a late entry (the click after a held
  // pointerdown, a keyup) can rebuild the report it belongs to.
  const entriesById = new Map<number, any[]>();
  // Null where the browser has no Long Animation Frames: reports then say so rather than showing none.
  const frames: FrameSummary[] | null = supportsLongAnimationFrames() ? [] : null;
  const inp = createInpTracker();
  const notify = (r: InteractionReport) => {
    for (const fn of listeners) {
      try {
        fn(r);
      } catch {
        // listener errors are theirs
      }
    }
    if (onReport) onReport(r);
  };
  const findReport = (id: number): InteractionReport | null => {
    for (let i = reports.length - 1; i >= 0; i--) if (reports[i].interactionId === id) return reports[i];
    for (let i = quiet.length - 1; i >= 0; i--) if (quiet[i].interactionId === id) return quiet[i];
    return null;
  };

  // A render that lands after the report was emitted (data arrived, an effect fired) still
  // belongs to that input if nothing newer happened. Attach it and re-emit the same report.
  installHook({
    hook: settings.hook,
    walkBudget: settings.walkBudget,
    inputWindow: settings.inputWindow,
    onSummary: (c) => {
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
    },
  });
  for (const t of INPUT_TYPES) window.addEventListener(t, noteInput, { capture: true, passive: true });

  const stopFrames = frames
    ? observeFrames(frames, 60, () => {
        // A LoAF can land after the report was built (there is no settle timer); fold it into the
        // last report's window or its later renders and re-notify with the corrected numbers.
        const r = reports[reports.length - 1];
        if (r && refreshFrames(r, frames)) notify(r);
      })
    : () => {};
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
    const commits = recordedCommits();
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

  const noRendererCheck = setTimeout(() => {
    const h = hookStats();
    if ((h.mode === 'shim' || h.mode === 'chained') && !h.renderers.some((r) => r.rendererPackageName === 'react-dom')) {
      warnOnce(
        'no-renderer',
        'no react-dom registered with the DevTools hook within 3s. install() has to run before react-dom loads: ' +
          "make `import 'react-inp-blame/auto'` the first import of your entry module.",
      );
    }
  }, 3000);
  const debugName = debugGlobalName(settings.debugGlobal);

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
      recordedCommits().length = 0;
      inp.reset();
    },
    onInteraction,
    stats: () => ({ ...hookStats(), reports: reports.length }),
    allCommits: () => recordedCommits().slice(),
    dispose: () => {
      if (installed?.api !== api) return;
      clearTimeout(noRendererCheck);
      stopFrames();
      stopEvents();
      for (const t of INPUT_TYPES) window.removeEventListener(t, noteInput, { capture: true });
      uninstallHook();
      if (overlay) overlay.dispose();
      overlay = null;
      listeners.clear();
      if (debugName && (window as any)[debugName] === api) delete (window as any)[debugName];
      installed = null;
    },
  };

  const applyOverlay = (ov: InstallOptions['overlay']) => {
    if (ov === undefined) return;
    if (overlay) overlay.dispose();
    const wanted = ov === true || (ov === 'query' && overlayRequested()) || (!!ov && typeof ov === 'object');
    overlay = wanted ? createOverlay(api, typeof ov === 'object' ? ov : {}) : null;
  };
  installed = {
    api,
    reapply: (next) => {
      if (next.onReport !== undefined) onReport = next.onReport;
      applyOverlay(next.overlay);
      const kept = (Object.keys(settings) as (keyof Settings)[]).filter((k) => next[k] !== undefined && next[k] !== settings[k]);
      if (kept.length) {
        warnOnce('reinstall', `install() had already run, so ${kept.join(', ')} kept the first call's value. Call dispose() first to change it.`);
      }
    },
  };
  if (debugName) (window as any)[debugName] = api;
  applyOverlay(opts.overlay);
  return api;
}

/**
 * Show the badge and panel for an already installed library (for example after
 * `import 'react-inp-blame/auto'`). Installs with defaults if nothing has yet.
 */
export function mountOverlay(opts: OverlayOptions = {}): OverlayHandle | null {
  if (typeof window === 'undefined') return null;
  const api = install();
  // Nothing was installed in a browser without Event Timing, so there is nothing to show.
  if (!installed) return null;
  if (!overlay) overlay = createOverlay(api, opts);
  return overlay;
}

export function onInteraction(fn: (r: InteractionReport) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function debugGlobalName(option: InstallOptions['debugGlobal']): string | null {
  if (!option) return null;
  return typeof option === 'string' ? option : '__REACT_INP__';
}

function noop(mode: 'none' | 'unsupported'): Api {
  return {
    reports: () => [],
    last: () => null,
    inp: () => null,
    clear: () => {},
    onInteraction: () => () => {},
    stats: () => ({ mode, owner: 'none', renderers: [], devtoolsLockedOut: false, walks: 0, walkTotalMs: 0, reports: 0, commitsRecorded: 0 }),
    allCommits: () => [],
    dispose: () => {},
  };
}
