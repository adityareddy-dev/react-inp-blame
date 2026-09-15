import { createTimeline } from './devtools.ts';
import { hookStats, INPUT_TYPES, installHook, knownRenderers, noteInput, recentInputs, recordedCommits, uninstallHook } from './hook.ts';
import type { InpEstimate } from './inp.ts';
import { FOLLOW_UP_WINDOW } from './join.ts';
import { createLifecycle } from './lifecycle.ts';
import { observeEventTiming, observeFrames, supportsInteractions, supportsLongAnimationFrames } from './observe.ts';
import type { OverlayHandle } from './overlay.ts';
import { overlayRequested } from './overlay-host.ts';
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
   * floor(count / 50) among the 10 longest. It agrees with web-vitals' `onINP` given
   * `durationThreshold: 16`, on the value and on the interaction; the design doc lists where the
   * two part (web-vitals' default 40 ms threshold, back/forward cache restores, `clear()`).
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
type Settings = Required<Pick<InstallOptions, 'threshold' | 'devtoolsTrack' | 'walkBudget' | 'inputWindow' | 'debugGlobal' | 'hook' | 'sampleRate'>>;

interface Installation {
  api: Api;
  /** Applies the options of a later install() call that can change while installed. */
  reapply(opts: InstallOptions): void;
}

/** `performance.interactionCount`, which TypeScript's DOM lib does not declare yet. */
interface InteractionCounting {
  readonly interactionCount: number;
}

const listeners = new Set<(r: InteractionReport) => void>();
let installed: Installation | null = null;
/** The API of a page that lost the `sampleRate` roll. Later calls get it back rather than rolling again, which would raise the share. */
let sampledOut: Api | null = null;
/** The badge and panel, from the moment they are asked for: their code arrives by dynamic import. */
let overlay: Promise<OverlayHandle | null> | null = null;
let installMs = 0;

/**
 * Must run before react-dom evaluates. The simplest way is
 * `import 'react-inp-blame/auto'` as the first import of your entry module. Calling it again
 * while installed applies `overlay` and `onReport` and returns the same API.
 */
export function install(opts: InstallOptions = {}): Api {
  // Timed because it runs before the app does: Next.js warns when instrumentation-client takes over 16 ms.
  const started = performance.now();
  try {
    return installNow(opts);
  } finally {
    installMs += performance.now() - started;
  }
}

function installNow(opts: InstallOptions): Api {
  if (typeof window === 'undefined') return noop('none');
  if (installed) {
    installed.reapply(opts);
    return installed.api;
  }
  if (sampledOut) return sampledOut;
  if (!supportsInteractions()) {
    warnOnce('unsupported-browser', 'this browser has no Event Timing interactionId (Chrome 96, Firefox 144, Safari 26.2), so nothing was installed.');
    // Exposed anyway, so stats() on the page says why nothing is reported.
    return expose(noop('unsupported'), opts.debugGlobal);
  }
  if (!(Math.random() < (opts.sampleRate ?? 1))) {
    const name = debugGlobalName(opts.debugGlobal);
    const api: Api = {
      ...noop('sampled-out'),
      dispose: () => {
        if (sampledOut !== api) return;
        sampledOut = null;
        if (name && (window as any)[name] === api) delete (window as any)[name];
        installMs = 0;
      },
    };
    sampledOut = api;
    return expose(api, opts.debugGlobal);
  }

  const settings: Settings = {
    threshold: opts.threshold ?? 40,
    devtoolsTrack: opts.devtoolsTrack ?? true,
    walkBudget: opts.walkBudget ?? 5000,
    inputWindow: opts.inputWindow ?? FOLLOW_UP_WINDOW,
    debugGlobal: opts.debugGlobal ?? false,
    hook: opts.hook ?? 'auto',
    sampleRate: opts.sampleRate ?? 1,
  };
  let onReport = opts.onReport;
  // Null where the browser has no Long Animation Frames: reports then say so rather than showing none.
  const frames: FrameSummary[] | null = supportsLongAnimationFrames() ? [] : null;

  // Performance panel entries are drawn once the page is idle: their tooltip is the verdict, and
  // building it does not belong in the callbacks that can delay the next input.
  const timeline = settings.devtoolsTrack ? createTimeline(knownRenderers) : null;
  const undrawn = new Set<InteractionReport>();
  let cancelDraw: (() => void) | null = null;
  let drawMs = 0;
  const drawWhenIdle = (r: InteractionReport) => {
    if (!timeline) return;
    undrawn.add(r);
    if (cancelDraw) return;
    cancelDraw = whenIdle(() => {
      cancelDraw = null;
      for (const pending of undrawn) {
        const started = performance.now();
        timeline.draw(pending);
        const spent = performance.now() - started;
        drawMs += spent;
        pending.overheadMs += spent;
      }
      undrawn.clear();
    });
  };

  const lifecycle = createLifecycle({
    threshold: settings.threshold,
    commits: recordedCommits,
    inputs: recentInputs,
    frames,
    interactionCount: 'interactionCount' in performance ? () => (performance as Performance & InteractionCounting).interactionCount : null,
    now: () => performance.now(),
    publish: (r) => {
      drawWhenIdle(r);
      for (const fn of listeners) {
        try {
          fn(r);
        } catch {
          // listener errors are theirs
        }
      }
      if (onReport) onReport(r);
    },
  });

  installHook({ hook: settings.hook, walkBudget: settings.walkBudget, inputWindow: settings.inputWindow, onSummary: lifecycle.onCommit });
  for (const t of INPUT_TYPES) window.addEventListener(t, noteInput, { capture: true, passive: true });
  const stopFrames = frames ? observeFrames(frames, 60, lifecycle.onFrame) : () => {};
  // Observe at the browser's floor (16 ms) so short interactions with a heavy later render
  // are not lost, and so the INP estimate sees every interaction it can; everything else
  // under the threshold stays quiet.
  const stopEvents = observeEventTiming(16, lifecycle.onEntries);

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
    reports: lifecycle.reports,
    last: lifecycle.last,
    inp: lifecycle.inp,
    clear: () => {
      lifecycle.clear();
      recordedCommits().length = 0;
    },
    onInteraction,
    stats: () => ({ ...hookStats(), reportTotalMs: lifecycle.spentMs() + drawMs, reports: lifecycle.reports().length, installMs }),
    allCommits: () => recordedCommits().slice(),
    dispose: () => {
      if (installed?.api !== api) return;
      clearTimeout(noRendererCheck);
      if (cancelDraw) cancelDraw();
      stopFrames();
      stopEvents();
      for (const t of INPUT_TYPES) window.removeEventListener(t, noteInput, { capture: true });
      uninstallHook();
      hideOverlay();
      listeners.clear();
      if (debugName && (window as any)[debugName] === api) delete (window as any)[debugName];
      installed = null;
      installMs = 0;
    },
  };

  const applyOverlay = (option: InstallOptions['overlay']) => {
    if (option === undefined) return;
    hideOverlay();
    const wanted = option === true || (option === 'query' && overlayRequested()) || (!!option && typeof option === 'object');
    if (wanted) showOverlay(api, typeof option === 'object' ? option : {});
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
  expose(api, settings.debugGlobal);
  applyOverlay(opts.overlay);
  return api;
}

/**
 * Show the badge and panel for an already installed library (for example after
 * `import 'react-inp-blame/auto'`). Installs with defaults if nothing has yet. Their code loads
 * on demand, so the handle arrives in a promise: null where nothing was installed.
 */
export function mountOverlay(opts: OverlayOptions = {}): Promise<OverlayHandle | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  const api = install();
  // Nothing was installed in a browser without Event Timing, or on a page the sample left out.
  if (!installed) return Promise.resolve(null);
  return overlay ?? showOverlay(api, opts);
}

export function onInteraction(fn: (r: InteractionReport) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The badge and panel are loaded with a dynamic import that starts after the current task, so a
 * page that never shows them never downloads that code, and install() returns before any of it
 * is requested, evaluated or mounted.
 */
function showOverlay(api: Api, opts: OverlayOptions): Promise<OverlayHandle | null> {
  const shown: Promise<OverlayHandle | null> = new Promise<void>((resolve) => setTimeout(resolve, 0))
    .then(() => (overlay === shown ? import('./overlay.ts') : null))
    // Asked again on arrival: hidden or replaced while the code was on its way.
    .then((code) => (code && overlay === shown ? code.createOverlay(api, opts) : null))
    .catch((error: unknown) => {
      warnOnce('overlay-failed', `the badge and panel could not be shown (${String(error)}).`);
      return null;
    });
  overlay = shown;
  return shown;
}

function hideOverlay(): void {
  const shown = overlay;
  overlay = null;
  if (shown) shown.then((handle) => handle?.dispose());
}

/** Runs `task` once the main thread is idle, and within a second; where requestIdleCallback is missing, right after the current task. Returns the cancel. */
function whenIdle(task: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(task, { timeout: 1000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(task, 0);
  return () => clearTimeout(id);
}

function debugGlobalName(option: InstallOptions['debugGlobal']): string | null {
  if (!option) return null;
  return typeof option === 'string' ? option : '__REACT_INP__';
}

/** Puts the API on window under the name `debugGlobal` asks for, if any. */
function expose(api: Api, option: InstallOptions['debugGlobal']): Api {
  const name = debugGlobalName(option);
  if (name) (window as any)[name] = api;
  return api;
}

function noop(mode: 'none' | 'unsupported' | 'sampled-out'): Api {
  return {
    reports: () => [],
    last: () => null,
    inp: () => null,
    clear: () => {},
    onInteraction: () => () => {},
    stats: () => ({ mode, owner: 'none', renderers: [], devtoolsLockedOut: false, walks: 0, walkTotalMs: 0, reportTotalMs: 0, reports: 0, commitsRecorded: 0, installMs }),
    allCommits: () => [],
    dispose: () => {},
  };
}
