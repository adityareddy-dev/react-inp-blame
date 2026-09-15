import type { Fiber } from './fiber.js';
import type { InpEstimate } from './inp.js';

// Reports are frozen when they are published, down to their commits, frames and explanation, and so
// is every commit the DevTools hook records. Their fields are readonly because the objects are.

export interface RenderedComponent {
  readonly name: string;
  /** How many fibers of this component rendered in the commit. */
  readonly count: number;
  /** Summed self time in ms; null when the React build records no durations, or its clock is too coarse to time single components (`CommitSummary.coarseClock`). */
  readonly self: number | null;
  /** Largest subtree time in ms; null like `self`. */
  readonly total: number | null;
}

/** An input stamped on a commit: the event being dispatched when it ran, else the newest one seen. */
export interface InputStamp {
  /** `Event.timeStamp`, the same clock as Event Timing's `startTime`. */
  readonly ts: number;
  readonly type: string;
  /** `timeStamp` of the pointerdown or keydown that began the press this input is part of; equals `ts` for those. */
  readonly gestureTs: number;
}

/** One input the library saw at dispatch. The last 8 are kept in a ring. */
export interface InputRecord extends InputStamp {
  /** `pointerId` for pointer events, `code` for key events: how a pointerup or keyup finds its press. */
  readonly press: string | number | undefined;
  readonly target: Node | null;
  /** The React fiber on the target at dispatch time. React drops it from the node on unmount, so a clicked row that was deleted still gets a component name. */
  readonly fiber: Fiber | null;
}

export interface CommitSummary {
  /** performance.now() at the end of the commit, when the walk started. */
  readonly at: number;
  /** ms from the stamped input to this commit. */
  readonly sinceInput: number;
  /** `Event.timeStamp` of the input being dispatched when this commit ran, else of the newest input seen. Matched to an entry's `startTime` within 1 ms. */
  readonly inputTs: number;
  /** `timeStamp` of the pointerdown or keydown that began that input's press. */
  readonly gestureTs: number;
  readonly inputType: string;
  /**
   * How the commit joined the report that holds it: exactly, by its input stamp, or by wall-clock
   * overlap when no stamp matched (the fallback). Absent on a commit no report holds, as in
   * `api.debug.commits()`.
   */
  readonly joinedBy?: 'exact' | 'overlap';
  /** Component fibers that performed work in this commit. */
  readonly rendered: number;
  /** The walk stopped early, at `walkBudget` component fibers or at a subtree deeper than it follows, so the counts are partial. */
  readonly truncated: boolean;
  /** Top-most components that rendered. */
  readonly roots: readonly string[];
  /** The chain that carries most of the work, outermost first. */
  readonly hotPath: readonly string[];
  /** Per-component aggregates, heaviest first. */
  readonly components: readonly RenderedComponent[];
  /** Whether React measured render durations for this tree: its root is in ProfileMode, or part of it was measured anyway (under a `<Profiler>`). Only development and profiling builds measure. */
  readonly hasDurations: boolean;
  /**
   * React timed this commit with a clock that steps in whole milliseconds (Firefox and Safari
   * without cross-origin isolation), and its components were too quick for that clock: each one read
   * 0 or 1 ms whatever it took, so `components` carry no times. `total` is a sum of many such readings,
   * close but not exact, and a blame built on it is `'inferred'`.
   */
  readonly coarseClock: boolean;
  /** Total render time of the commit in ms when durations exist, else 0. */
  readonly total: number;
  /**
   * How long this library took to walk the commit, ms. The walk runs inside React's commit, so
   * for a commit during an interaction's handlers it is part of the processing time the browser
   * measured; the report takes it back out (`InteractionReport.walkMs`).
   */
  readonly walkMs: number;
  /**
   * The Scheduler priority React passed with the commit: 1 (immediate) to 5 (idle) on React 18
   * and 19, React's own 99 to 95 on React 17. Production react-dom passes `undefined`, so
   * anything built on it works in development and profiling builds only.
   */
  readonly priority: number | undefined;
  /** Whether the root captured an error in this render, as React passed it. */
  readonly didError: boolean;
}

/** What a React renderer handed the DevTools hook's `inject()` when it loaded. */
export interface RendererInfo {
  /** The id `inject()` returned; React passes it back with every commit. */
  readonly id: number;
  /** e.g. '19.3.0'; null when the renderer did not say. */
  readonly version: string | null;
  /** 1 for a development build, 0 for production and profiling builds; null when the renderer did not say. */
  readonly bundleType: number | null;
  /** 'react-dom', or another renderer such as '@react-three/fiber'. Only react-dom commits are walked. */
  readonly rendererPackageName: string | null;
}

/** Whether the library is installed on this page, why not, and what it has cost so far. A new object at every call. */
export interface Stats {
  /**
   * 'shim': this library created the DevTools hook. 'chained': it wraps a hook that was already
   * there. 'none': no hook in use (on the server, or `hook: 'chain'` found none), so reports carry
   * no React commits. 'unsupported': nothing was installed, or React's commits are not read, for
   * the reason in `unsupportedReason`. 'sampled-out': the page lost the `sampleRate` roll and
   * nothing was installed.
   */
  mode: 'shim' | 'chained' | 'none' | 'unsupported' | 'sampled-out';
  /** Why `mode` is 'unsupported'; null in every other mode. */
  unsupportedReason: UnsupportedReason | null;
  /** Commits walked. */
  walks: number;
  /** Time spent walking React's commits, ms, inside those commits. */
  walkTotalMs: number;
  /**
   * The rest of this library's own time, ms: building and revising reports (in the Event Timing
   * and Long Animation Frames callbacks, and inside React's commit when a later render attaches)
   * and drawing Performance panel entries when the page is idle.
   */
  reportTotalMs: number;
  /** Time spent inside install() calls since the page loaded or dispose() ran, ms. The badge and panel load afterwards and are not part of it. */
  installMs: number;
}

/** What made a page 'unsupported': the kind, as data, and the sentence the console warning gave. */
export interface UnsupportedReason {
  /**
   * 'browser': no Event Timing `interactionId` (Chrome 96, Firefox 144, Safari 26.2), so nothing was
   * installed. 'another-copy': a copy of this library from an incompatible version is already on the
   * page, so this one installed nothing. The other three stop only the reading of React's commits,
   * and reports carry on without components: 'react-version', a react-dom outside React 17 to 19;
   * 'fiber-shape', a first commit whose root is not the shape this library reads; 'walk-threw',
   * reading a commit threw.
   */
  kind: 'browser' | 'another-copy' | 'react-version' | 'fiber-shape' | 'walk-threw';
  /** The warning's sentence. Display text. */
  message: string;
}

/** The DevTools hook as this library found and uses it. */
export interface HookInfo {
  /** Who owns the hook: this library, or the keys of the hook it chained onto. */
  owner: string;
  /** Every renderer known to have registered with the hook: the ones seen registering, plus earlier ones React DevTools' hook kept. */
  renderers: RendererInfo[];
  /**
   * True when a tool assigned its own `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` over this library's
   * shim after React had registered with the shim: that React keeps reporting to the shim, and the
   * tool never hears from it.
   *
   * It cannot see React DevTools being locked out. React DevTools (the extension, the standalone
   * app and `react-devtools-inline`) never replaces a hook: when the global already exists it
   * installs nothing and says nothing, so a shim that loaded first leaves it without React while
   * this flag stays false. Load React DevTools before this library, or install with `hook: 'chain'`.
   */
  devtoolsLockedOut: boolean;
}

/** What install() returns. A page has one: every call, from any copy of the library, returns the same. */
export interface Api {
  /** Published reports, oldest first, each at its latest revision. */
  reports(): InteractionReport[];
  /** The newest published report, at its latest revision. */
  last(): InteractionReport | null;
  /**
   * The INP of the navigation the page is on, so far: the estimate web-vitals makes, the interaction
   * at index floor(count / 50) among the 10 longest. It starts over at each soft navigation and each
   * restore from the back/forward cache, from the interactions that began after it. It agrees with
   * web-vitals' `onINP` given `durationThreshold: 16`, on the value and on the interaction; the design
   * doc lists where the two part (web-vitals' default 40 ms threshold, `clear()`, a soft navigation
   * web-vitals is not asked to report).
   */
  inp(): InpEstimate | null;
  /** Drops every report and recorded commit, and starts the INP estimate over. */
  clear(): void;
  /** The same as the `onInteraction` export. */
  onInteraction(fn: (report: InteractionReport) => void): () => void;
  stats(): Stats;
  /** For looking inside the library while debugging it. Not part of the report contract: what these return may change in any version. */
  readonly debug: DebugApi;
  /** Undoes install(): listeners, observers, the overlay, the debug global and any wrapping of a chained hook. A later install() starts fresh. */
  dispose(): void;
}

export interface DebugApi {
  /** The last 300 commits walked, in or out of an interaction window, oldest first. They carry no `joinedBy`. */
  commits(): CommitSummary[];
  /** Where React's commits come from. */
  hook(): HookInfo;
}

export interface ScriptSummary {
  readonly invoker: string;
  readonly name: string;
  readonly source: string;
  readonly start: number;
  readonly duration: number;
  readonly forcedLayout: number;
}

export interface FrameSummary {
  readonly start: number;
  readonly duration: number;
  readonly blocking: number;
  readonly forcedLayout: number;
  readonly scripts: readonly ScriptSummary[];
}

export interface TargetInfo {
  readonly selector: string | null;
  /** Human label for the element, at most 40 characters, from what `InstallOptions.labels` allows. e.g. 'button "Add to cart"' or 'input "filter rows"'. */
  readonly label: string | null;
  /** Nearest component owning the event target. */
  readonly component: string | null;
  /** Owner chain, nearest first. */
  readonly owners: readonly string[];
  /** Name of the React prop handler on the target chain for this event type, if it has one. */
  readonly handler: string | null;
}

export interface Phase {
  readonly label: string;
  readonly ms: number;
  readonly hint: string;
}

/** Who is to blame, as data: the same call the cause sentence makes, for UIs to render short. */
export interface Blame {
  /** Where the time mostly went. */
  readonly kind: 'render' | 'handler' | 'waiting' | 'painting' | 'script' | 'none';
  /** The subtree that re-rendered, the handler that ran, or the script; null when unknown. */
  readonly name: string | null;
  /** For a render, what it was mostly made of ("LineItem ×800"); for a handler, its component. */
  readonly detail: string | null;
  /** How much of the interaction it accounts for, in ms; null when the build records no durations. */
  readonly ms: number | null;
  /**
   * 'measured': the blame follows from timings of this interaction. A render or handler blame
   * rests on React's render durations for commits joined by their exact input stamp and walked in
   * full; waiting and painting on the browser's own phases; a script on its Long Animation Frames
   * entry; 'none' on Long Animation Frames showing no long script.
   *
   * 'inferred': it is the likeliest reading of weaker evidence. Render counts without durations
   * (production builds, or a clock too coarse to time components), a commit that only overlapped
   * the interaction in time, a walk cut short, or no Long Animation Frames to rule scripts out.
   */
  readonly confidence: 'measured' | 'inferred';
}

/**
 * The report in plain words, for people and for UIs. `blame`, `rating` and the phases' `ms` are
 * data. `headline`, `where`, `cause`, `notes` and the phases' `label` and `hint` are display text:
 * their wording may change in any version, so show them, never parse or compare them.
 */
export interface Explanation {
  /** e.g. "216 ms click". Display text. */
  readonly headline: string;
  /** The cause as data, for a one-line UI. */
  readonly blame: Blame;
  /** INP thresholds: good up to 200 ms, needs work up to 500 ms, poor beyond. */
  readonly rating: 'good' | 'needs-work' | 'poor';
  /** e.g. 'button "Add to cart" in ContextStorm'. Display text. */
  readonly where: string | null;
  /** The one sentence that says where the time went. Display text. */
  readonly cause: string;
  /** Extra sentences worth knowing: a navigation it started, forced layout, a later render, waiting time, this library's own time. Display text. */
  readonly notes: readonly string[];
  /** Waiting, working, updating the screen. With the report's `walkMs` their `ms` add up to the interaction's duration. */
  readonly phases: readonly Phase[];
}

/**
 * How the page came to be at a URL: web-vitals' `Metric['navigationType']`, with the same values.
 * 'soft-navigation' is a client-side navigation a router announced (the Next.js App Router, through
 * `react-inp-blame/next`); 'back-forward-cache' is a page restored from the back/forward cache.
 */
export type NavigationType = 'navigate' | 'reload' | 'back-forward' | 'back-forward-cache' | 'prerender' | 'restore' | 'soft-navigation';

/** A soft navigation an interaction started, as the router announced it. */
export interface StartedNavigation {
  /** Where it went, as an absolute URL. */
  readonly url: string;
  /** The router's word for it: 'push' or 'replace' for a link or `router.push()` / `router.replace()`, 'traverse' for back and forward. */
  readonly type: 'push' | 'replace' | 'traverse';
}

/** One Event Timing entry of the interaction, the fields that matter. */
export interface EventEntrySummary {
  readonly name: string;
  readonly startTime: number;
  readonly duration: number;
  readonly processingStart: number;
  readonly processingEnd: number;
}

/**
 * One interaction, joined to the React commits and long animation frames behind it. Frozen: when
 * something joins it after it was published (a late Event Timing entry, a long animation frame, a
 * later render), the next revision is published as a new report, and the earlier one stays as it was.
 */
export interface InteractionReport {
  /** The version of this shape. It changes when a field is removed or changes meaning; a field added beside the others leaves it as it is. */
  readonly schemaVersion: 1;
  readonly interactionId: number;
  /** The event the headline is named after: the best-known one in the headline entry's paint group. */
  readonly type: string;
  /** `startTime` of the headline entry. */
  readonly start: number;
  /** The paint that ended the headline entry, `start + duration`. */
  readonly end: number;
  /** The longest single entry's duration: what web-vitals reports as this interaction's latency. */
  readonly duration: number;
  /** How much longer the whole interaction ran than the headline: first input to last paint over every entry with the id, minus `duration`. A finger held down on touch makes this large; a plain click leaves it near 0. */
  readonly holdMs: number;
  /** Every entry seen for the id so far, in arrival order. */
  readonly entries: readonly EventEntrySummary[];
  readonly inputDelay: number;
  /** Handlers and React rendering, clamped to the paint the way web-vitals clamps it, less `walkMs`. */
  readonly processing: number;
  /**
   * This library's walks of the commits that ran during the handlers, ms. The browser counts them
   * as processing; they are taken out of `processing`, so `inputDelay + processing + walkMs +
   * presentation` is `duration`, and the explanation says so when it rounds to 1 ms or more.
   */
  readonly walkMs: number;
  readonly presentation: number;
  readonly target: TargetInfo | null;
  /**
   * The URL of the page the interaction happened on: the document's, or that of the latest soft
   * navigation that had begun when the interaction did. web-vitals' `Metric.navigationURL`, so a
   * report lines up with the INP web-vitals reports for that URL.
   */
  readonly navigationURL: string;
  /** How the page came to be at `navigationURL`: web-vitals' `Metric.navigationType`. */
  readonly navigationType: NavigationType;
  /** The soft navigation the interaction started, when a router announced one while its input was being dispatched; null otherwise. */
  readonly startedNavigation: StartedNavigation | null;
  /** React commits between the input and the next paint: what INP measures. */
  readonly commits: readonly CommitSummary[];
  /** Commits that landed after that paint but still belong to this input (effects, transitions, cascades). INP does not count them; the user still waits for them. */
  readonly followUps: readonly CommitSummary[];
  /** Long animation frames overlapping the interaction. Null where the browser has no Long Animation Frames API (only Chromium has it), so forced layout and scripts are unknown, not absent. */
  readonly frames: readonly FrameSummary[] | null;
  /** Long animation frames overlapping the later renders; null like `frames`. */
  readonly laterFrames: readonly FrameSummary[] | null;
  /** 0 as first built, and one more for each revision after it: a later render, frame or Event Timing entry joined. */
  readonly revision: number;
  /** Built on first read, so a report nobody reads costs nothing to explain. */
  readonly explanation: Explanation;
  /** The explanation as one line of display text, built on first read like `explanation`. Its wording may change in any version. */
  readonly verdict: string;
  /**
   * What this library spent on this interaction, ms: walking the commits joined to it, and building
   * each revision of the report. Only `walkMs` of it ran inside the interaction itself. Performance
   * panel entries are drawn after a report is published, so their time is only in
   * `stats().reportTotalMs`.
   */
  readonly overheadMs: number;
}

export interface OverlayOptions {
  /** Which corner the badge sits in. Default 'bottom-right'. */
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  /** Start with the panel open. Default false. */
  open?: boolean;
  /** How many interactions the panel keeps, newest first. Default 20. */
  max?: number;
}

export interface InstallOptions {
  /**
   * Show the on-page badge and panel. `true` always; `'query'` only when the URL carries
   * `?inp-blame` / `#inp-blame` or localStorage has `react-inp-blame=overlay`, which is how you
   * open it on a production page without shipping UI to users. Their code is loaded with a
   * dynamic import after install() returns. Default false.
   */
  overlay?: boolean | 'query' | OverlayOptions;
  /** Report interactions at or above this duration (ms), plus shorter ones that trigger a later render. Default 40. */
  threshold?: number;
  /** Draw each report in the Chrome Performance panel, in a "react-inp-blame" track group, once the page is idle. Default true. */
  devtoolsTrack?: boolean;
  /** Maximum component fibers (function, class, memo and forwardRef components) visited per commit walk; DOM and text fibers do not count. Default 5000. */
  walkBudget?: number;
  /** Commits later than this many ms after the last input are not walked. Default 1500. */
  inputWindow?: number;
  /** Expose the API on window (true = window.__REACT_INP_BLAME__, or give a name). */
  debugGlobal?: boolean | string;
  /**
   * Where a report's `target.label` may come from. Every label is at most 40 characters, and none
   * ever reads an element's whole `textContent` or a form field's value.
   *
   * `'attributes'`: only what the page's code wrote on the element: its `aria-label`, a form
   * field's `placeholder`, `name` or `type`, or its `data-testid` or `data-test`.
   * `'text'`: the same, except that an element with no `aria-label` that is not a form field is
   * named by its first run of text, the way a person would name it. That text can be what the page
   * shows about a person (a name in a table cell), and it travels with every report you forward to
   * an error tracker or analytics.
   * `'auto'`: text under a development build of React, attributes under any other.
   *
   * Default 'auto'.
   */
  labels?: 'auto' | 'text' | 'attributes';
  /** @deprecated Use `onInteraction()`, the one way to hear reports; this option only adds a listener there. */
  onReport?: (report: InteractionReport) => void;
  /**
   * How to hear about React commits. `'chain'` wraps a `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`
   * that already exists (React DevTools, Fast Refresh in dev) and never creates one, so a
   * production page without either gets Event Timing and Long Animation Frames only. `'shim'`
   * creates a minimal hook, and React DevTools loading after it will not install over it; when a
   * hook is already there it chains instead and warns. `'auto'` chains when a hook exists and
   * shims otherwise. Default 'auto'.
   */
  hook?: 'auto' | 'chain' | 'shim';
  /**
   * Share of page loads that install anything, from 0 to 1. The first install() on a page rolls
   * once; a page that loses gets an API with nothing behind it (`stats().mode === 'sampled-out'`):
   * no hook, no listeners, no observers. Later calls return that API until dispose(). Default 1.
   */
  sampleRate?: number;
}
