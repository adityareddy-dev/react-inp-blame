import type { Fiber } from './fiber.ts';

export interface RenderedComponent {
  name: string;
  /** How many fibers of this component rendered in the commit. */
  count: number;
  /** Summed self time in ms, or null when the React build does not record durations. */
  self: number | null;
  /** Largest subtree time in ms, or null without durations. */
  total: number | null;
}

/** An input stamped on a commit: the event being dispatched when it ran, else the newest one seen. */
export interface InputStamp {
  /** `Event.timeStamp`, the same clock as Event Timing's `startTime`. */
  ts: number;
  type: string;
  /** `timeStamp` of the pointerdown or keydown that began the press this input is part of; equals `ts` for those. */
  gestureTs: number;
}

/** One input the library saw at dispatch. The last 8 are kept in a ring. */
export interface InputRecord extends InputStamp {
  /** `pointerId` for pointer events, `code` for key events: how a pointerup or keyup finds its press. */
  press: string | number | undefined;
  target: any;
  /** The React fiber on the target at dispatch time. React drops it from the node on unmount, so a clicked row that was deleted still gets a component name. */
  fiber: Fiber | null;
}

export interface CommitSummary {
  /** performance.now() at the end of the commit, when the walk started. */
  at: number;
  /** ms from the stamped input to this commit. */
  sinceInput: number;
  /** `Event.timeStamp` of the input being dispatched when this commit ran, else of the newest input seen. Matched to an entry's `startTime` within 1 ms. */
  inputTs: number;
  /** `timeStamp` of the pointerdown or keydown that began that input's press. */
  gestureTs: number;
  inputType: string;
  /**
   * How the commit was joined to a report: exactly, by its input stamp, or by wall-clock overlap
   * when no stamp matched (the fallback). Set when it is first joined; a commit in more than
   * one report carries the last join's value.
   */
  joinedBy?: 'exact' | 'overlap';
  /** Component fibers that performed work in this commit. */
  rendered: number;
  /** The walk stopped early, at `walkBudget` component fibers or at a subtree deeper than it follows, so the counts are partial. */
  truncated: boolean;
  /** Top-most components that rendered. */
  roots: string[];
  /** The chain that carries most of the work, outermost first. */
  hotPath: string[];
  /** Per-component aggregates, heaviest first. */
  components: RenderedComponent[];
  /** Whether React measured render durations for this tree: its root is in ProfileMode, or part of it was measured anyway (under a `<Profiler>`). Only development and profiling builds measure. */
  hasDurations: boolean;
  /** Total render time of the commit in ms when durations exist, else 0. */
  total: number;
  /**
   * How long this library took to walk the commit, ms. The walk runs inside React's commit, so
   * for a commit during an interaction's handlers it is part of the processing time the browser
   * measured; the report takes it back out (`InteractionReport.walkMs`).
   */
  walkMs: number;
  /**
   * The Scheduler priority React passed with the commit: 1 (immediate) to 5 (idle) on React 18
   * and 19, React's own 99 to 95 on React 17. Production react-dom passes `undefined`, so
   * anything built on it works in development and profiling builds only.
   */
  priority: number | undefined;
  /** Whether the root captured an error in this render, as React passed it. */
  didError: boolean;
}

/** What a React renderer handed the DevTools hook's `inject()` when it loaded. */
export interface RendererInfo {
  /** The id `inject()` returned; React passes it back with every commit. */
  id: number;
  /** e.g. '19.3.0'; null when the renderer did not say. */
  version: string | null;
  /** 1 for a development build, 0 for production and profiling builds; null when the renderer did not say. */
  bundleType: number | null;
  /** 'react-dom', or another renderer such as '@react-three/fiber'. Only react-dom commits are walked. */
  rendererPackageName: string | null;
}

export interface Stats {
  /**
   * 'shim': this library created the DevTools hook. 'chained': it wraps a hook that was already
   * there. 'none': no hook in use (on the server, or `hook: 'chain'` found none), so reports
   * carry no React commits. 'unsupported': the browser has no Event Timing `interactionId` and
   * nothing was installed, or react-dom is outside React 17 to 19 or its fiber tree is not the
   * expected shape, and reports carry no React commits. 'sampled-out': the page lost the
   * `sampleRate` roll and nothing was installed.
   */
  mode: 'shim' | 'chained' | 'none' | 'unsupported' | 'sampled-out';
  /** Who owns the hook: this library, or the keys of the hook it chained onto. */
  owner: string;
  /** Every renderer known to have registered with the hook: the ones seen registering, plus earlier ones React DevTools' hook kept. */
  renderers: RendererInfo[];
  /**
   * True when something replaced `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` after React had
   * registered with this library's shim: that React keeps reporting to the shim, and whatever
   * replaced it (React DevTools, typically) never hears from it.
   */
  devtoolsLockedOut: boolean;
  walks: number;
  /** Time spent walking React's commits, ms, inside those commits. */
  walkTotalMs: number;
  /**
   * The rest of this library's own time, ms: building and updating reports (in the Event Timing
   * and Long Animation Frames callbacks, and inside React's commit when a later render attaches)
   * and drawing Performance panel entries when the page is idle.
   */
  reportTotalMs: number;
  reports: number;
  commitsRecorded: number;
  /** Time spent inside install() calls since the page loaded or dispose() ran, ms. The badge and panel load afterwards and are not part of it. */
  installMs: number;
}

export interface ScriptSummary {
  invoker: string;
  name: string;
  source: string;
  start: number;
  duration: number;
  forcedLayout: number;
}

export interface FrameSummary {
  start: number;
  duration: number;
  blocking: number;
  forcedLayout: number;
  scripts: ScriptSummary[];
}

export interface TargetInfo {
  selector: string | null;
  /** Human label for the element: its aria-label, a form field's placeholder, or its first run of text, at most 40 characters. e.g. 'button "Add to cart"' or 'input "filter rows"'. */
  label: string | null;
  /** Nearest component owning the event target. */
  component: string | null;
  /** Owner chain, nearest first. */
  owners: string[];
  /** Name of the React prop handler on the target chain for this event type, if it has one. */
  handler: string | null;
}

export interface Phase {
  label: string;
  ms: number;
  hint: string;
}

/** Who is to blame, as data: the same call the cause sentence makes, for UIs to render short. */
export interface Blame {
  /** Where the time mostly went. */
  kind: 'render' | 'handler' | 'waiting' | 'painting' | 'script' | 'none';
  /** The subtree that re-rendered, the handler that ran, or the script; null when unknown. */
  name: string | null;
  /** For a render, what it was mostly made of ("LineItem ×800"); for a handler, its component. */
  detail: string | null;
  /** How much of the interaction it accounts for, in ms; null when the build records no durations. */
  ms: number | null;
}

/** The report in plain words, for people and for UIs. */
export interface Explanation {
  /** e.g. "216 ms click" */
  headline: string;
  /** The cause as data, for a one-line UI. */
  blame: Blame;
  /** INP thresholds: good up to 200 ms, needs work up to 500 ms, poor beyond. */
  rating: 'good' | 'needs-work' | 'poor';
  /** e.g. 'button "Add to cart" in ContextStorm' */
  where: string | null;
  /** The one sentence that says where the time went. */
  cause: string;
  /** Extra sentences worth knowing: forced layout, a later render, waiting time, this library's own time. */
  notes: string[];
  /** Waiting, working, updating the screen. With the report's `walkMs` they add up to the interaction's duration. */
  phases: Phase[];
}

/** One Event Timing entry of the interaction, the fields that matter. */
export interface EventEntrySummary {
  name: string;
  startTime: number;
  duration: number;
  processingStart: number;
  processingEnd: number;
}

export interface InteractionReport {
  interactionId: number;
  /** The event the headline is named after: the best-known one in the headline entry's paint group. */
  type: string;
  /** `startTime` of the headline entry. */
  start: number;
  /** The paint that ended the headline entry, `start + duration`. */
  end: number;
  /** The longest single entry's duration: what web-vitals reports as this interaction's latency. */
  duration: number;
  /** How much longer the whole interaction ran than the headline: first input to last paint over every entry with the id, minus `duration`. A finger held down on touch makes this large; a plain click leaves it near 0. */
  holdMs: number;
  /** Every entry seen for the id so far, in arrival order. */
  entries: EventEntrySummary[];
  inputDelay: number;
  /** Handlers and React rendering, clamped to the paint the way web-vitals clamps it, less `walkMs`. */
  processing: number;
  /**
   * This library's walks of the commits that ran during the handlers, ms. The browser counts them
   * as processing; they are taken out of `processing`, so `inputDelay + processing + walkMs +
   * presentation` is `duration`, and the explanation says so when it rounds to 1 ms or more.
   */
  walkMs: number;
  presentation: number;
  target: TargetInfo | null;
  /** React commits between the input and the next paint: what INP measures. */
  commits: CommitSummary[];
  /** Commits that landed after that paint but still belong to this input (effects, transitions, cascades). INP does not count them; the user still waits for them. */
  followUps: CommitSummary[];
  /** Long animation frames overlapping the interaction. Null where the browser has no Long Animation Frames API (only Chromium has it), so forced layout and scripts are unknown, not absent. */
  frames: FrameSummary[] | null;
  /** Long animation frames overlapping the later renders; null like `frames`. */
  laterFrames: FrameSummary[] | null;
  /** Bumped every time a later render, frame or Event Timing entry attaches to this report after it was first built. */
  revision: number;
  /** Built on first read, and again after the report changes, so a report nobody reads costs nothing to explain. */
  readonly explanation: Explanation;
  /** The explanation as one line of text, built on first read like `explanation`. */
  readonly verdict: string;
  /**
   * What this library spent on this interaction, ms: walking the commits joined to it, building
   * and updating the report, and drawing its Performance panel entries (which builds the
   * explanation for their tooltip). Only `walkMs` of it ran inside the interaction itself.
   */
  overheadMs: number;
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
  /** Expose the API on window (true = window.__REACT_INP__, or give a name). */
  debugGlobal?: boolean | string;
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
