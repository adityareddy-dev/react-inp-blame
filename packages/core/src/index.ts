import { emitRender, emitTrack } from './devtools';
import { hookOwner, hookState, installHook, noteInput } from './hook';
import { attachLaterRender, buildReport, isLaterRender, refreshLaterFrames } from './join';
import { observeEventTiming, observeFrames } from './observe';
import { createOverlay, overlayRequested, OVERLAY_ID, type OverlayHandle } from './overlay';
import type { CommitSummary, FrameSummary, InstallOptions, InteractionReport, OverlayOptions } from './types';

export type * from './types';
export { fiberFromNode, ownerChain, handlerName } from './fiber';
export type { OverlayHandle } from './overlay';

export interface Api {
  reports(): InteractionReport[];
  last(): InteractionReport | null;
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
const listeners = new Set<(r: InteractionReport) => void>();
let installed: Api | null = null;
let overlay: OverlayHandle | null = null;
const INPUT_TYPES = ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup', 'input'];
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
    const r = reports[reports.length - 1];
    if (r && refreshLaterFrames(r, frames)) notify(r);
  });
  const publish = (r: InteractionReport) => {
    reports.push(r);
    if (reports.length > 50) reports.shift();
    if (devtoolsTrack) emitTrack(r);
    notify(r);
  };
  // Observe at the browser's floor (16 ms) so short interactions with a heavy later render
  // are not lost; everything else under the threshold stays quiet.
  const stopEvents = observeEventTiming(16, (entries) => {
    const r = buildReport(entries, hookState().commits, frames);
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
    clear: () => {
      reports.length = 0;
      quiet.length = 0;
      hookState().commits.length = 0;
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
    clear: () => {},
    onInteraction: () => () => {},
    stats: () => ({ mode: 'none', owner: 'none', renderers: 0, walks: 0, walkTotalMs: 0, reports: 0, commitsRecorded: 0 }),
    allCommits: () => [],
    dispose: () => {},
  };
}
