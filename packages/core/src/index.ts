import { MINIFIED_NAMES_CONSOLE, namesLookMinified } from './commits.js';
import { createTimeline } from './devtools.js';
import { checkHookReplaced, clearCommits, CLOSER_TYPES, DEFAULT_INPUT_WINDOW, dispatchedInput, hearingReports, hookInfo, hookStats, INPUT_TYPES, installHook, knownRenderers, noteCloser, noteInput, noteResize, readingReactDom, recentInputs, recordedCommits, uninstallHook } from './hook.js';
import { inertApi } from './inert.js';
import { page, type Listener } from './install-state.js';
import { labelOf, type LabelSource } from './join.js';
import { createLifecycle } from './lifecycle.js';
import { documentNavigation, MAX_NAVIGATIONS, onRouterNavigation, type PageNavigation } from './navigation.js';
import { observeEventTiming, observeFrames, supportsInteractions, supportsLongAnimationFrames } from './observe.js';
import type { OverlayHandle } from './overlay.js';
import { overlayRequested } from './overlay-host.js';
import { incompatibleCopy } from './session.js';
import type { Api, FrameSummary, InstallOptions, InteractionReport, OverlayOptions, ReactStatus, RendererInfo } from './types.js';
import { warnOnce } from './warn.js';

export type * from './types.js';
export type { InpEstimate } from './inp.js';
export type { OverlayHandle } from './overlay.js';

/** Where `debugGlobal: true` puts the API on window. */
const DEBUG_GLOBAL = '__REACT_INP_BLAME__';
/** `threshold` by default: web-vitals' default `durationThreshold`, two and a half frames at 60 Hz. */
const DEFAULT_THRESHOLD = 40;
/** `walkBudget` by default: over three times the 1441 components of the demo's largest commit, and still a bound on a runaway tree inside React's commit. */
const DEFAULT_WALK_BUDGET = 5000;
/** How often the page is looked at for React's marks while no react-dom has registered, at most. */
const REACT_LOOK_MS = 1000;
/**
 * How many times reports and stats() may look at the page for React's marks, in all. Each look reads up to
 * RENDERED_SCAN_LIMIT elements, and a page whose islands are all another framework's would otherwise pay
 * for one at every interaction for as long as it is open. Once this many looks have found no React the page
 * is taken to have none, and the status stays 'waiting' until a react-dom registers. The check
 * RENDERER_CHECK_MS after install and the one at the first interaction after it look regardless.
 */
const REACT_LOOKS = 5;
/** How long react-dom has to register with the hook before the page is told install() ran too late. */
const RENDERER_CHECK_MS = 3000;
// How many elements a look reads at most. React marks every element it renders, so a page with React on it
// shows one early, and a page without pays for this many reads at most REACT_LOOKS times, plus the two checks.
const RENDERED_SCAN_LIMIT = 10000;
// NodeFilter.SHOW_ELEMENT, written out so the check needs no NodeFilter global.
const SHOW_ELEMENT = 1;

/**
 * Whether react-dom has rendered into this document: the key it puts on a root's container, the document
 * itself when it hydrates the whole page, or on each element it renders. Only read when no react-dom has
 * registered, so a page that installed in time never pays for it.
 */
function reactRendered(): boolean {
  // A document this does not know how to walk is one it says nothing about, rather than an error from a timer.
  try {
    if (typeof document.createTreeWalker !== 'function') return false;
    const marked = (node: Node) => Object.keys(node).some((key) => key.startsWith('__reactContainer$') || key.startsWith('__reactFiber$'));
    if (marked(document)) return true;
    const walker = document.createTreeWalker(document.documentElement, SHOW_ELEMENT);
    for (let node: Node | null = walker.currentNode, read = 0; node && read < RENDERED_SCAN_LIMIT; node = walker.nextNode(), read++) {
      if (marked(node)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** The options only a first install() can set; a later call that changes one is warned about. */
type Settings = Required<Pick<InstallOptions, 'threshold' | 'devtoolsTrack' | 'walkBudget' | 'inputWindow' | 'debugGlobal' | 'hook' | 'sampleRate' | 'labels'>>;

/** `performance.interactionCount`, which TypeScript's DOM lib does not declare yet. */
interface InteractionCounting {
  readonly interactionCount: number;
}

/** The window as a bag of properties, for the debug global. */
const globals = () => window as unknown as Record<string, unknown>;
const installTime = () => page.installMs;

/**
 * Must run before react-dom evaluates. `react-inp-blame/vite` and `react-inp-blame/next` call it in
 * a module that runs ahead of the app; without either, make `import 'react-inp-blame/auto'` the
 * first import of your entry module. Calling it again while installed, from this or any other copy
 * of the library on the page, applies `overlay` and returns the same API.
 */
export function install(opts: InstallOptions = {}): Api {
  // Timed because it runs before the app does: Next.js warns when instrumentation-client takes over 16 ms.
  const started = performance.now();
  try {
    return installNow(opts);
  } finally {
    page.installMs += performance.now() - started;
  }
}

function installNow(opts: InstallOptions): Api {
  if (typeof window === 'undefined') return inertApi('none');
  if (incompatibleCopy) {
    const message = 'a copy of react-inp-blame from an incompatible version is already on this page, so this one installed nothing. Load a single version (`npm ls react-inp-blame` lists them).';
    warnOnce('another-copy', message);
    return inertApi('unsupported', { unsupportedReason: { kind: 'another-copy', message } });
  }
  if (page.installed) {
    page.installed.reapply(opts);
    return page.installed.api;
  }
  if (page.sampledOut) return page.sampledOut;
  if (!supportsInteractions()) {
    const message = 'this browser has no Event Timing interactionId (Chrome 96, Firefox 144, Safari 26.2), so nothing was installed.';
    warnOnce('unsupported-browser', message);
    // Exposed anyway, so stats() on the page says why nothing is reported. A badge that was asked for says
    // it too, rather than leaving someone looking for one that never comes.
    const api = inertApi('unsupported', { unsupportedReason: { kind: 'browser', message }, installMs: installTime, dispose: hideOverlay });
    if (overlayWanted(opts.overlay) && !page.overlay) showOverlay(api, typeof opts.overlay === 'object' ? opts.overlay : {});
    return expose(api, opts.debugGlobal);
  }
  if (!(Math.random() < (opts.sampleRate ?? 1))) {
    const name = debugGlobalName(opts.debugGlobal);
    const api = inertApi('sampled-out', {
      installMs: installTime,
      dispose: () => {
        if (page.sampledOut !== api) return;
        page.sampledOut = null;
        if (name && globals()[name] === api) delete globals()[name];
        page.installMs = 0;
      },
    });
    page.sampledOut = api;
    return expose(api, opts.debugGlobal);
  }

  const settings: Settings = {
    threshold: opts.threshold ?? DEFAULT_THRESHOLD,
    devtoolsTrack: opts.devtoolsTrack ?? true,
    walkBudget: opts.walkBudget ?? DEFAULT_WALK_BUDGET,
    inputWindow: opts.inputWindow ?? DEFAULT_INPUT_WINDOW,
    debugGlobal: opts.debugGlobal ?? false,
    hook: opts.hook ?? 'auto',
    sampleRate: opts.sampleRate ?? 1,
    labels: opts.labels ?? 'auto',
  };
  // Asked at each report, because react-dom registers with the hook after install() has run.
  const labels = (): LabelSource => (settings.labels === 'auto' ? (knownRenderers().some(isDevelopmentReactDom) ? 'text' : 'attributes') : settings.labels);
  // Null where the browser has no Long Animation Frames: reports then say so rather than showing none.
  const frames: FrameSummary[] | null = supportsLongAnimationFrames() ? [] : null;

  // Performance panel entries are drawn once the page is idle: their tooltip is the verdict, and
  // building it does not belong in the callbacks that can delay the next input.
  const timeline = settings.devtoolsTrack ? createTimeline(knownRenderers) : null;
  // The newest revision of each report not drawn yet.
  const undrawn = new Map<number, InteractionReport>();
  let cancelDraw: (() => void) | null = null;
  let drawMs = 0;
  const drawWhenIdle = (r: InteractionReport) => {
    if (!timeline) return;
    undrawn.set(r.interactionId, r);
    if (cancelDraw) return;
    cancelDraw = whenIdle(() => {
      cancelDraw = null;
      const started = performance.now();
      for (const pending of undrawn.values()) timeline.draw(pending);
      undrawn.clear();
      drawMs += performance.now() - started;
    });
  };

  // Reports reach listeners in a task of their own. A later render revises a report inside React's
  // commit, and a listener that set state there would render inside that commit. The renders the
  // listeners cause by hearing reports are kept out of every report (see hearingReports).
  const undelivered: InteractionReport[] = [];
  let delivery: ReturnType<typeof setTimeout> | null = null;
  const deliver = () => {
    delivery = null;
    const reports = undelivered.splice(0);
    if (!page.listeners.size) return;
    hearingReports(() => {
      for (const r of reports) {
        for (const fn of page.listeners) {
          try {
            fn(r);
          } catch {
            // A listener's error is its own; the others still hear the report.
          }
        }
      }
    });
  };

  // Where reports happened: the document's own navigation, then each soft navigation a router
  // announces and each restore from the back/forward cache, oldest first.
  const navigations: PageNavigation[] = [documentNavigation()];
  // Whether React has rendered on the page: sticky once seen, and looked for at most once a second and at
  // most REACT_LOOKS times while no react-dom has registered, since each look reads the page's elements.
  // Input the page has seen since the last look makes the next one due, so while looks remain a report never
  // goes by a look from before React rendered. The renderer check below looks whenever it runs.
  let sawReact = false;
  let lookedForReact = -Infinity;
  let reactLookDue = false;
  let looksLeft = REACT_LOOKS;
  const reactRenderedHere = (force = false): boolean => {
    const now = performance.now();
    if (!sawReact && (force || (looksLeft > 0 && (reactLookDue || now - lookedForReact >= REACT_LOOK_MS)))) {
      if (!force) looksLeft--;
      lookedForReact = now;
      reactLookDue = false;
      sawReact = reactRendered();
    }
    return sawReact;
  };
  const reactStatus = (): ReactStatus => {
    if (readingReactDom()) return 'reading';
    const { mode } = hookStats();
    if (mode !== 'shim' && mode !== 'chained') return 'unreadable';
    return reactRenderedHere() ? 'installed-late' : 'waiting';
  };

  const lifecycle = createLifecycle({
    threshold: settings.threshold,
    inputWindow: settings.inputWindow,
    commits: recordedCommits,
    inputs: recentInputs,
    navigations: () => navigations,
    frames,
    interactionCount: 'interactionCount' in performance ? () => (performance as Performance & InteractionCounting).interactionCount : null,
    labels,
    reactStatus,
    now: () => performance.now(),
    publish: (r) => {
      if (namesLookMinified([...r.commits, ...r.followUps])) warnOnce('minified-names', MINIFIED_NAMES_CONSOLE);
      drawWhenIdle(r);
      undelivered.push(r);
      delivery ??= setTimeout(deliver, 0);
    },
  });

  const navigated = (navigation: PageNavigation) => {
    navigations.push(navigation);
    if (navigations.length > MAX_NAVIGATIONS) navigations.shift();
    lifecycle.onNavigation(navigation.start);
    // The badge shows the INP of the navigation the page is on, which has just started over.
    page.overlay?.then((handle) => handle?.refresh());
  };
  const onPageShow = (e: PageTransitionEvent) => {
    const current = navigations[navigations.length - 1];
    if (e.persisted && current) navigated({ url: current.url, type: 'back-forward-cache', start: e.timeStamp, router: null });
  };
  // web-vitals chooses INP again when the page is hidden, at the interaction count by then.
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') lifecycle.onHidden();
  };
  // The App Router announces a navigation from inside the handler that starts it, so the input
  // being dispatched, if any, is the one that started it.
  const stopRouterNavigations = onRouterNavigation(({ url, type, at }) => {
    const input = dispatchedInput();
    navigated({ url, type: 'soft-navigation', start: at, router: { type, input: input && { inputTs: input.ts, inputType: input.type, gestureTs: input.gestureTs } } });
  });

  installHook({ hook: settings.hook, walkBudget: settings.walkBudget, inputWindow: settings.inputWindow, onSummary: lifecycle.onCommit, label: (control) => labelOf(control, labels()) });
  for (const t of INPUT_TYPES) window.addEventListener(t, noteInput, { capture: true, passive: true });
  for (const t of CLOSER_TYPES) window.addEventListener(t, noteCloser, { capture: true, passive: true });
  window.addEventListener('resize', noteResize, { capture: true, passive: true });
  window.addEventListener('pageshow', onPageShow, { capture: true });
  window.addEventListener('visibilitychange', onVisibilityChange, { capture: true });
  const stopFrames = frames ? observeFrames(frames, lifecycle.onFrame) : () => {};
  // Observe at the browser's floor so short interactions with a heavy later render are not lost, and
  // so the INP estimate sees every interaction it can; everything else under the threshold stays quiet.
  // React on the page with no react-dom registered means install() ran after react-dom loaded. Without
  // React on the page nothing is said: a host may load it later by design, as Astro does for an island
  // hydrated once it scrolls into view, or never, on a page whose islands are another framework's. So the
  // page is looked at RENDERER_CHECK_MS after install, and where it had no React on it then, once more at
  // the first interaction after that, for a root a late react-dom created later on.
  let rendererCheck: 'waiting' | 'again' | 'done' = 'waiting';
  const checkRenderer = () => {
    checkHookReplaced();
    const { mode } = hookStats();
    const unregistered = (mode === 'shim' || mode === 'chained') && !knownRenderers().some((r) => r.rendererPackageName === 'react-dom');
    // Looked at whenever the check runs, however recently a report looked.
    const rendered = unregistered && reactRenderedHere(true);
    rendererCheck = unregistered && !rendered && rendererCheck === 'waiting' ? 'again' : 'done';
    if (rendered) {
      warnOnce(
        'no-renderer',
        'React has rendered on this page, but no react-dom has registered with the DevTools hook, so install() ran after react-dom loaded. ' +
          "Install with the Vite, Next.js or Astro plugin, or make `import 'react-inp-blame/auto'` the first import of your entry module.",
      );
      // The badge says so too, now rather than at the next report.
      page.overlay?.then((handle) => handle?.refresh());
    }
  };
  const stopEvents = observeEventTiming((batch) => {
    checkHookReplaced();
    reactLookDue = true;
    if (rendererCheck === 'again') checkRenderer();
    lifecycle.onEntries(batch);
  });
  const rendererTimer = setTimeout(checkRenderer, RENDERER_CHECK_MS);
  const debugName = debugGlobalName(settings.debugGlobal);

  const api: Api = {
    reports: lifecycle.reports,
    last: lifecycle.last,
    inp: lifecycle.inp,
    clear: () => {
      lifecycle.clear();
      clearCommits();
    },
    onInteraction,
    stats: () => ({ ...hookStats(), reportTotalMs: lifecycle.spentMs() + drawMs, installMs: page.installMs, react: reactStatus() }),
    debug: {
      commits: () => recordedCommits().slice(),
      hook: hookInfo,
    },
    dispose: () => {
      if (page.installed?.api !== api) return;
      clearTimeout(rendererTimer);
      if (delivery !== null) clearTimeout(delivery);
      undelivered.length = 0;
      if (cancelDraw) cancelDraw();
      stopFrames();
      stopEvents();
      stopRouterNavigations();
      for (const t of INPUT_TYPES) window.removeEventListener(t, noteInput, { capture: true });
      for (const t of CLOSER_TYPES) window.removeEventListener(t, noteCloser, { capture: true });
      window.removeEventListener('resize', noteResize, { capture: true });
      window.removeEventListener('pageshow', onPageShow, { capture: true });
      window.removeEventListener('visibilitychange', onVisibilityChange, { capture: true });
      uninstallHook();
      hideOverlay();
      page.listeners.clear();
      if (debugName && globals()[debugName] === api) delete globals()[debugName];
      page.installed = null;
      page.installMs = 0;
    },
  };

  const applyOverlay = (option: InstallOptions['overlay']) => {
    if (option === undefined) return;
    hideOverlay();
    if (overlayWanted(option)) showOverlay(api, typeof option === 'object' ? option : {});
  };
  page.installed = {
    api,
    reapply: (next) => {
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
  // A browser without Event Timing gets the badge that says so; a page the sample left out gets none.
  if (!page.installed && api.stats().unsupportedReason?.kind !== 'browser') return Promise.resolve(null);
  return page.overlay ?? showOverlay(api, opts);
}

/**
 * Calls `fn` with each report once it is published, and again with every later revision of it, in a
 * task after the one that published it. An update `fn` makes while it runs is never read as part of an
 * interaction; one it schedules for later, with setTimeout or an await, is an ordinary render.
 * Returns the unsubscribe.
 */
export function onInteraction(fn: Listener): () => void {
  // A server renders no interactions, and a listener added during a render there would outlive the request.
  if (typeof window === 'undefined') return () => {};
  page.listeners.add(fn);
  return () => {
    page.listeners.delete(fn);
  };
}

/**
 * The badge and panel are loaded with a dynamic import that starts after the current task, so a
 * page that never shows them never downloads that code, and install() returns before any of it
 * is requested, evaluated or mounted.
 */
function showOverlay(api: Api, opts: OverlayOptions): Promise<OverlayHandle | null> {
  const shown: Promise<OverlayHandle | null> = new Promise<void>((resolve) => setTimeout(resolve, 0))
    .then(() => (page.overlay === shown ? import('./overlay.js') : null))
    // Asked again on arrival: hidden or replaced while the code was on its way.
    .then((code) => (code && page.overlay === shown ? code.createOverlay(api, opts) : null))
    .catch((error: unknown) => {
      warnOnce('overlay-failed', `the badge and panel could not be shown (${String(error)}).`);
      return null;
    });
  page.overlay = shown;
  return shown;
}

/** Whether the `overlay` option asks for the badge on this page. */
function overlayWanted(option: InstallOptions['overlay']): boolean {
  return option === true || (option === 'query' && overlayRequested()) || (!!option && typeof option === 'object');
}

function hideOverlay(): void {
  const shown = page.overlay;
  page.overlay = null;
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

/** A development build of react-dom, which says so with `bundleType` 1. */
function isDevelopmentReactDom(renderer: RendererInfo): boolean {
  return renderer.rendererPackageName === 'react-dom' && renderer.bundleType === 1;
}

function debugGlobalName(option: InstallOptions['debugGlobal']): string | null {
  if (!option) return null;
  return typeof option === 'string' ? option : DEBUG_GLOBAL;
}

/** Puts the API on window under the name `debugGlobal` asks for, if any. */
function expose(api: Api, option: InstallOptions['debugGlobal']): Api {
  const name = debugGlobalName(option);
  if (name) globals()[name] = api;
  return api;
}
