export interface RenderedComponent {
  name: string;
  /** How many fibers of this component rendered in the commit. */
  count: number;
  /** Summed self time in ms, or null when the React build does not record durations. */
  self: number | null;
  /** Largest subtree time in ms, or null without durations. */
  total: number | null;
}

export interface CommitSummary {
  /** performance.now() at the end of the commit. */
  at: number;
  /** ms since the last input event before this commit. */
  sinceInput: number;
  /** Component fibers that performed work in this commit. */
  rendered: number;
  /** Fiber visits stopped at the walk budget; counts are partial. */
  truncated: boolean;
  /** Top-most components that rendered. */
  roots: string[];
  /** The chain that carries most of the work, outermost first. */
  hotPath: string[];
  /** Per-component aggregates, heaviest first. */
  components: RenderedComponent[];
  /** Whether the React build recorded per-fiber durations (dev or profiling builds). */
  hasDurations: boolean;
  /** Total render time of the commit in ms when durations exist, else 0. */
  total: number;
  /** Cost of the fiber walk itself, ms. */
  walkMs: number;
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
  /** Human label for the element, e.g. 'button "Add to cart"' or 'input "filter rows"'. */
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
  /** Extra sentences worth knowing: forced layout, a later render, waiting time. */
  notes: string[];
  /** Waiting, working, updating the screen. Sums to the interaction's duration. */
  phases: Phase[];
}

export interface InteractionReport {
  interactionId: number;
  type: string;
  start: number;
  end: number;
  duration: number;
  inputDelay: number;
  processing: number;
  presentation: number;
  target: TargetInfo | null;
  /** React commits between the input and the next paint: what INP measures. */
  commits: CommitSummary[];
  /** Commits that landed after that paint but still belong to this input (effects, transitions, cascades). INP does not count them; the user still waits for them. */
  followUps: CommitSummary[];
  frames: FrameSummary[];
  /** Long animation frames overlapping the later renders. */
  laterFrames: FrameSummary[];
  /** Bumped every time a later render or frame attaches to this report after it was first emitted. */
  revision: number;
  explanation: Explanation;
  /** The explanation as one line of text. */
  verdict: string;
  /** What this library itself cost inside the interaction window, ms. */
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
   * open it on a production page without shipping UI to users. Default false.
   */
  overlay?: boolean | 'query' | OverlayOptions;
  /** Report interactions at or above this duration (ms), plus shorter ones that trigger a later render. Default 40. */
  threshold?: number;
  /** Emit User Timing measures that the Chrome Performance panel renders as custom tracks. Default true. */
  devtoolsTrack?: boolean;
  /** Maximum fibers visited per commit walk. Default 5000. */
  walkBudget?: number;
  /** Commits later than this many ms after the last input are not walked. Default 1500. */
  inputWindow?: number;
  /** Expose the API on window (true = window.__REACT_INP__, or give a name). */
  debugGlobal?: boolean | string;
  onReport?: (report: InteractionReport) => void;
}
