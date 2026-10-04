import type { InpEstimate } from './inp.js';

// Every type in this file is exported from the package (`export type *` in index.ts), so a type only
// the library itself uses belongs beside the code that uses it.
//
// Reports are frozen when they are published, down to their commits, frames and explanation, and so
// is every commit the DevTools hook records. Their fields are readonly because the objects are.

export interface RenderedComponent {
  readonly name: string;
  /** How many fibers of this component rendered in the commit. A memo wrapper and the component it renders are one, named after the wrapper. */
  readonly count: number;
  /** Summed self time in ms; null when the React build records no durations, or its clock is too coarse to time single components (`CommitSummary.coarseClock`). */
  readonly self: number | null;
  /** Largest subtree time in ms; null like `self`. */
  readonly total: number | null;
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
   * React made the commit while that input was being dispatched, in the input's own task, so its Event
   * Timing entry holds it: INP timed it, even as a later render (the release of a press held past its
   * paint). False outside the dispatch, and in a `change` from a later task. Absent on a report stored by
   * an earlier release.
   */
  readonly inDispatch?: boolean;
  /**
   * How the commit joined the report that holds it: exactly, by its input stamp, or by wall-clock
   * overlap when no stamp matched (the fallback). Absent on a commit no report holds, as in
   * `api.debug.commits()`.
   */
  readonly joinedBy?: 'exact' | 'overlap';
  /** Component fibers that performed work in this commit. */
  readonly rendered: number;
  /**
   * Of `rendered`, the components React rendered for the first time in this commit, mounting them, rather
   * than again: a fiber with no alternate. Radix mounts a dialog's content in a commit of its own, from its
   * Portal down, which mounts nearly every component in it. Absent on a report stored by an earlier release.
   */
  readonly mounted?: number;
  /**
   * Of `mounted`, the components with a useEffect to run after this commit, as a chart or a map that sets
   * itself up in one has (a `useSyncExternalStore` subscription is run the same way, and counts too). Always
   * 0 on React 17. Absent on a report stored by an earlier release.
   */
  readonly effectMounts?: number;
  /**
   * Of `rendered`, the components with a useEffect to run after this commit, mounted or rendered again. Always 0 on
   * React 17. Absent on a report stored by an earlier release.
   */
  readonly effectRuns?: number;
  /**
   * The name of the one component `effectMounts` counts, where it counts one and no other component that rendered
   * has a useEffect to run; null otherwise. Absent on a report stored by an earlier release.
   */
  readonly effectMountName?: string | null;
  /**
   * The commit hydrated server-rendered HTML, a root's or a Suspense boundary's. Hydrating is the page
   * starting up rather than an input's work, so such a commit is kept only when React ran it inside an
   * input's dispatch, hydrating so that it could handle that input.
   */
  readonly hydrated: boolean;
  /**
   * The server-rendered HTML this commit hydrated around the input's target: the innermost Suspense
   * boundary enclosing that element, or the root when no boundary does. Null when the commit hydrated
   * nothing the target was inside, which is what keeps a boundary hydrating elsewhere on the page off
   * the interaction's blame.
   */
  readonly hydratedTarget: HydrationBoundary | null;
  /** The walk stopped early, at `walkBudget` component fibers or at a subtree deeper than it follows, so the counts are partial. */
  readonly truncated: boolean;
  /** The outermost components that rendered, at most 5. */
  readonly roots: readonly string[];
  /**
   * The chain that carries most of the work, outermost first, every name on it as it stands. It spends at
   * most twelve steps below the component it starts from, on the components a reader could search for: a
   * library's layers between them (`Primitive.div`, a Slot, a Provider, a wrapper named after the component
   * it renders) are on the chain but spend no step. For a production walk cut at `walkBudget`, whose counts
   * cannot choose among subtrees it reached in part or not at all, it stops at its one subtree where
   * nothing it did not reach rendered beside it, and is otherwise the component its subtrees all sit
   * under, or empty where they sit under none. A timed walk cut there, which never reached the roots past
   * the cut, does the same where React's total for the render says those took longer than the heaviest
   * root it reached. `pathStart` says which.
   */
  readonly hotPath: readonly string[];
  /**
   * Where `hotPath` starts, as the walk found it. Every walk sets one of the four, and these four are all
   * there are in 1.x.
   *
   * 'only-root': the walk found one component where this render started, and the path starts at it.
   *
   * 'heaviest-root': the walk found several components where renders started, and the path starts at the
   * heaviest one it reached. `roots` has up to five of their names.
   *
   * 'unknown-root': the walk reached components that rendered but stopped before it could tell which one
   * held the render (in production at walkBudget, in a development or profiling build when React's own total
   * shows more of the render went unreached than the heaviest start it reached), so the path starts at the
   * nearest component they all sit under, or is empty when they share none.
   *
   * 'no-root': the walk reached no component that rendered, either because the commit rendered none or
   * because it stopped first (then `truncated` is true). hotPath is empty and `rendered` is 0.
   *
   * Absent: a report from before 0.21.0 (0.20.0 and 0.21.0 share schemaVersion 4).
   */
  readonly pathStart?: 'only-root' | 'heaviest-root' | 'unknown-root' | 'no-root';
  /**
   * Of `rendered`, those inside the component `hotPath` starts from, that component included. Equal to
   * `rendered` where that is the commit's one root or the component every root sits under, and below it
   * where other roots rendered beside the one the path starts from, since the path starts at the heaviest
   * of them: what a sentence can say rendered "from X down". Absent on a report stored by an earlier
   * release.
   */
  readonly startRendered?: number;
  /**
   * Of `rendered`, those inside the component the commit is named after, that component included: the
   * deepest on `hotPath` that is not a library's layer, else the one it ends on. What a sentence can say
   * rendered "inside" it, where `rendered` is the whole commit's. Equal to `startRendered` where the path
   * names nothing below the component it starts from, and partial like `rendered` where the walk was cut.
   * Absent on a report stored by an earlier release.
   */
  readonly pathRendered?: number;
  /**
   * Whether a component that rendered in this commit is under `<StrictMode>`, as the mode React gave its fiber
   * says. Only a development build renders such a component twice, which `InteractionReport.strictMode` is
   * for. Absent on a report stored by an earlier release.
   */
  readonly strictMode?: boolean;
  /** Per-component aggregates, heaviest first, at most 12. */
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
  /**
   * Total render time of the commit in ms when durations exist, else 0. A walk cut at `walkBudget` on a root
   * React timed takes the root's own figure, since the roots past the cut are in it and not in the walk.
   */
  readonly total: number;
  /**
   * performance.now() when React began the render this commit came from, read from the root fiber.
   * From here to `at` is React's own time for the commit, committing it included: the DOM changes,
   * ref callbacks and layout effects that `total` leaves out. Null in a production build, which keeps
   * no start, and where React did not time the tree.
   */
  readonly startedAt: number | null;
  /**
   * performance.now() when every tool on the DevTools hook had been handed this commit, React DevTools
   * included, after which React can run its passive effects, the `useEffect`s. Set together with
   * `effectsEndedAt`, and null where that is.
   */
  readonly effectsStartedAt: number | null;
  /**
   * performance.now() when React had run this commit's passive effects, as React 18 and 19 report it
   * to the DevTools hook, production builds included. React runs them in the same task right after a
   * click's or a key's commit, and later for most other updates, so the time from `effectsStartedAt`
   * to here is theirs only where no other task can have run in between. It also holds any render React
   * made once they were done and before it said so (an update from a layout effect or from `flushSync`
   * in an effect), which is that render's own time. Null until they have run, for a commit whose tree
   * has no passive effects, for a root made with `ReactDOM.render`, and on React 17.
   */
  readonly effectsEndedAt: number | null;
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
   * no React commits. 'unsupported': nothing was installed, or no react-dom on the page can be read,
   * for the reason in `unsupportedReason`. 'sampled-out': the page lost the `sampleRate` roll and
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
  /** Whether this library can see what React does on the page: see `ReactStatus`. */
  react: ReactStatus;
}

/**
 * Whether this library can see what React does on the page. 'reading': a react-dom registered with the hook
 * and its commits are read. 'waiting': no react-dom has registered and React has not rendered on the page,
 * as on an Astro page before its islands hydrate. 'installed-late': React has rendered on the page and no
 * react-dom registered, because install() ran after react-dom loaded, so nothing React does is seen.
 * 'unreadable': a hook is not in use, or no react-dom that registered can be read (`unsupportedReason`).
 */
export type ReactStatus = 'reading' | 'waiting' | 'installed-late' | 'unreadable';

/**
 * What made a page 'unsupported': the kind, as data, and the sentence of its console warning. For 'browser'
 * that warning is printed only in a development build or on a page `sampleRate` takes.
 */
export interface UnsupportedReason {
  /**
   * 'browser': no Event Timing `interactionId` (Chrome 96, Firefox 144, Safari 26.2), so nothing was
   * installed. 'another-copy': another copy or entry of this library already owns the page and this one
   * cannot share it, so this one installed nothing, as when a copy from an incompatible version got there
   * first. 'hook-disabled': the page's DevTools hook has `isDisabled` set
   * or no `supportsFiber`, or the global is empty and read-only, so React registers with no hook;
   * or the page turned the hook in use off that way after install(), before react-dom registered or with
   * its methods made no-ops, or emptied the global over the shim before react-dom registered, which the
   * next interaction notices;
   * or the hook is frozen, sealed without `onPostCommitFiberRoot`, or has a method that cannot be assigned,
   * so it cannot be wrapped and was left as it was;
   * or the global, or the hook on it, throws when read, on install() or before react-dom registered, so no
   * hook the library can reach hears React. The other three stop the reading of one react-dom's commits,
   * and the page is 'unsupported' when that leaves no react-dom it can read:
   * 'react-version', a react-dom outside React 17 to 19; 'fiber-shape', a first commit whose root is not
   * the shape this library reads; 'walk-threw', reading a commit threw. Reports carry on without components.
   */
  kind: 'browser' | 'another-copy' | 'hook-disabled' | 'react-version' | 'fiber-shape' | 'walk-threw';
  /** The warning's sentence. Display text. */
  message: string;
}

/**
 * The DevTools hook as this library found and uses it. For debugging, like `Api.debug`: not part of the
 * report contract, and its shape may change in any version.
 */
export interface HookInfo {
  /**
   * Who owns the hook: this library, or the keys of the hook it chained onto. Where the page turned that hook off
   * after install(), it is still the one described here, with the renderers that registered with it.
   */
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
  /**
   * Published reports, oldest first, each at its latest revision. At most 50: past that the oldest goes,
   * except the ten slowest and those INP can still point at.
   */
  reports(): InteractionReport[];
  /** The newest published report, at its latest revision. */
  last(): InteractionReport | null;
  /**
   * The INP of the navigation the page is on, so far: the estimate web-vitals makes, the interaction
   * at index min(floor(count / 50), n - 1) among the n it kept, n at most 10, chosen as entries arrive
   * and again when the page is hidden. It starts over at each soft navigation and each restore from
   * the back/forward cache, from the interactions that began after it.
   *
   * It is not web-vitals, and it is not a drop-in for it: it is the same algorithm written again from
   * the same entries. Through the session `apps/demo/e2e/inp.spec.ts` drives, more than 50 interactions,
   * it names the same value and the same interaction as web-vitals 6.2.2's `onINP` at
   * `durationThreshold: 16` after every one of them. The design doc lists where the two part, which
   * includes web-vitals' own default of 40 ms, `clear()`, a soft navigation web-vitals is not asked to
   * report, and the older web-vitals that Next.js 16.3 vendors.
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

/**
 * What `Api.debug` holds. For debugging: not part of the report contract, and its shape may change in
 * any version.
 */
export interface DebugApi {
  /**
   * The last 300 commits walked, in or out of an interaction window, oldest first. They carry no
   * `joinedBy`. A render the page's report listeners caused is not walked, and a hydration is kept only
   * when React ran it inside an input's dispatch.
   */
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
  /**
   * When the frame's own style and layout began, after its scripts and animation frame callbacks. From
   * there to the frame's end the browser recalculated styles and layout and painted, less any
   * ResizeObserver callbacks `scripts` lists after it. `null` where the frame did not render.
   */
  readonly styleAndLayoutStart: number | null;
}

export interface TargetInfo {
  /** A CSS selector for the element: its tag, its id if it has one, then its `data-test` or `data-testid` attribute, or else up to two of its classes, the id and classes escaped as `CSS.escape` escapes them. */
  readonly selector: string | null;
  /**
   * Human label for the element: its tag and a name of at most 40 characters, from what `InstallOptions.labels` allows. e.g. 'button "Add to cart"' or 'input "filter rows"'.
   * A click that landed on something inside a control (the svg of an icon button) is labelled by the control; `selector` stays the element it landed on.
   */
  readonly label: string | null;
  /**
   * The nearest component enclosing the event target that a reader could go and look for: one React
   * would accept as a component name, that a minifier has not cut down to a letter or two, and whose
   * every dotted part is the same (`Primitive.button` names the element, not a component). The
   * nearest owner of all where the chain holds no such name, and null where there is no chain.
   * Enclosing follows the tree React rendered the element in, which is not React's owner chain: a
   * button that Page passes into Card as children is in Card. A click on an icon (an `<svg>` or something
   * in one, an `<img>`, a `<picture>`) inside a control is read from the control, as `label` is.
   */
  readonly component: string | null;
  /** The components enclosing the target (for a click on an icon, the control around it), nearest first, by the same tree: the eight innermost. */
  readonly owners: readonly string[];
  /**
   * Name of the React prop handler on the target chain for the event that did the work: of the entries
   * painted with the headline, the ones whose own handlers ran longest, the best-known of them first.
   */
  readonly handler: string | null;
}

export interface Phase {
  readonly label: string;
  readonly ms: number;
  readonly hint: string;
  /**
   * Named pieces of this phase, when part of it is worth showing on its own (React hydrating
   * inside the working time). Each is shorter than the phase that holds it, and together they
   * never exceed it; the phases themselves keep adding up to the interaction as they always did.
   */
  readonly parts?: readonly Phase[];
}

/**
 * Server-rendered HTML around the element an input landed on: the whole root, or the innermost
 * Suspense boundary enclosing it.
 */
export interface HydrationBoundary {
  /** 'root' when the HTML is a React root's own, 'boundary' when a Suspense boundary inside it holds it. */
  readonly scope: 'root' | 'boundary';
  /**
   * The nearest named component enclosing it, so it can be pointed at: a Suspense boundary has no
   * name of its own. Null when nothing above it is named, which a minified build without the
   * `displayName` transform leaves.
   */
  readonly owner: string | null;
}

/**
 * Server-rendered HTML the interaction landed on before React had hydrated it. Every App Router page
 * is server-rendered, so a click can arrive while the HTML under the pointer is still waiting for React.
 */
export interface Hydration extends HydrationBoundary {
  /**
   * 'waited': React hydrated the HTML the input landed on while the input was being dispatched, so
   * the input waited for that before it was handled. 'not-hydrated': at input time the target was
   * inside server-rendered HTML React had not hydrated, and no React handler ran for this interaction.
   */
  readonly kind: 'waited' | 'not-hydrated';
  /**
   * What React spent hydrating it inside the interaction, ms. Null when the React build records no
   * render durations (every production build), and for 'not-hydrated', where nothing was timed
   * because nothing ran.
   */
  readonly ms: number | null;
}

/** Who is to blame, as data: the same call the cause sentence makes, for UIs to render short. */
export interface Blame {
  /**
   * Where the time mostly went, one of eight kinds. 'render': React rendering and committing for this
   * input, charged to a subtree. 'handler': the input's own event handlers, named after the handler.
   * 'hydration': React hydrating the server-rendered HTML the input landed on. 'layout': style and layout
   * the browser recalculated inside the handlers. 'waiting': the input waiting for the main thread, before
   * its first handler or between handlers. 'painting': the screen update after the handlers. 'script': a
   * script Long Animation Frames recorded while the interaction ran, named after what ran it. 'none':
   * nothing stood out, or nothing could be seen. A slow event listener is both a handler and a script, and
   * which of the two a report says can change in a minor.
   *
   * 'hydration' is React hydrating, inside the interaction, the server-rendered HTML the input landed on: the
   * report's `hydration` names the boundary. An input that was never dispatched because its HTML was *still*
   * waiting spent its time elsewhere, so it keeps the blame that says where, and `hydration.kind` is
   * `'not-hydrated'`. 'layout' is the browser recalculating styles and layout inside the handlers, one figure
   * in a Long Animation Frames entry, which measures it in every build, React's durations or not. 'waiting'
   * is the input waiting for the main thread: before its first handler, or inside the working time, between
   * one of its events' handlers and the next's (Enter on a button whose click restyled 30,000 cells, where
   * the keyup waits for the browser to finish).
   */
  readonly kind: 'render' | 'handler' | 'hydration' | 'layout' | 'waiting' | 'painting' | 'script' | 'none';
  /**
   * What the time is charged to: a subtree that re-rendered, a handler that ran, what ran a script as the
   * browser names it, or the boundary that was hydrated, and null when unknown. Which of them a report names
   * can change in a minor as the reading gets better, and the rest of this says how each kind picks one
   * today. A 'render' always has one: the subtree, or 'the app', the fixed value (the same through 1.x) a
   * 'render' or a 'layout' takes where its commit's walk gave no component to name it after: where it could
   * not tell where the render started, which the commit's `pathStart` says, or where the component the render
   * is named after has no name it could read. For a 'layout' it is where the layout was forced, never what
   * forced it, because no source says that. That is the subtree of a commit the interaction can claim: one
   * joined by its own input stamp, walked to the end, with no commit of the interaction left unjoined. Of
   * several commits in the scripts that forced it, it is the one whose time could hold most of the layout,
   * and null where none could hold half. Failing that it is the invoker the browser charged the script to
   * ("DIV#root.onclick"), and only while one script holds nearly all of `ms`; where several scripts share the
   * total, no one of them is where the layout happened and this is null. The cause sentence names the largest
   * either way, with how much of the total it holds. For a 'waiting' it is the invoker of the script the
   * input waited behind ("TimerHandler:setTimeout"), when Long Animation Frames recorded one that filled at
   * least half of the wait, before the first handler or between them; null otherwise. A 'painting' takes the
   * invoker of the script after the handlers that ran for at least half of the screen update
   * ("DIV.onscroll"), or where that script is React's own task (`MessagePort.onmessage`) and React rendered
   * inside it, the component that render is named after; null otherwise. A 'handler' React has no name for (a
   * listener bound on the document, say) takes the invoker of the longest script in the working time on the
   * same terms as a 'waiting': "#document.onkeydown".
   */
  readonly name: string | null;
  /**
   * Display text. For a render or a hydration, what it was mostly made of: many of one component
   * ("LineItem ×800"), one component's own render where React timed it at half the render or more
   * ("TableBody's own render"), else how many components rendered ("637 components"). For a render, of which
   * how many inside the component `name` gives, where that is fewer ("812 of 1216 components"); a hydration
   * is named after a boundary or the page, which holds them all, so it carries the whole count. Null where it
   * rendered one. Where the walk was cut short it is always the count, and says so: "at least 1999 components,
   * the rest not walked". A render whose commit spent over half of `ms` in its useEffect callbacks has
   * "useEffect callbacks" instead, "useEffect callbacks after mounting RevenueChart" where one component
   * mounted in it with one (`effectMountName`), or "useEffect callbacks in 3 mounted components" where
   * several did and no component that rendered again had one to run (`effectRuns`), and on a walk cut short,
   * which counted only the mounts it reached, "useEffect callbacks in at least 2 mounted components". For a
   * handler, its component, or null where the name is a listener the browser recorded rather than a React
   * handler. For a 'layout', what that same commit was mostly made of, as a render's, where a count is the
   * whole commit's ("56 components", not "15 of 56") when `name` is the component the render started from and
   * that holds the whole commit, wherever `name` came from that commit, and null wherever `name` did not,
   * since a script has no component counts. For a 'waiting' inside the working time, where it came: "between
   * click and keyup", or "between handlers" where it was split across more than one; null for a wait before
   * the first handler.
   */
  readonly detail: string | null;
  /**
   * How much of the interaction it accounts for, in ms; null for 'none', and for a render, a hydration
   * or a handler where the build records no durations and React committed in the working time. For a
   * render it is the named commit's render, plus committing it, plus its useEffect callbacks in the same
   * task, and React's other commits in the interaction are not in it.
   */
  readonly ms: number | null;
  /**
   * 'measured': the blame follows from timings of this interaction. A render or handler blame rests
   * on React's render durations for commits joined by their exact input stamp and walked in full,
   * or a handler blame on React committing nothing in the working time where it is read or not yet
   * loaded, in any build; waiting and painting on the browser's own phases; a script on its Long
   * Animation Frames entry; 'none' on Long Animation Frames showing no long script. A painting
   * blame whose cause says the frame waited on the next press (`InteractionReport.nextInput`) is
   * still the screen update's own time. The clause about the press rests on that press's timings,
   * which are not this interaction's, so it says "most likely" unless a long animation frame over
   * this interaction recorded a script from the press on that shows the work, the way it records
   * the script a wait was behind. Where the screen update's note names a long script after the
   * handlers, a 'none' rests on there being no long script in the working time.
   *
   * 'inferred': it is the likeliest reading of weaker evidence. Render counts without durations
   * (production builds, or a clock too coarse to time components), a commit that only overlapped
   * the interaction in time, a walk cut short, or no Long Animation Frames to rule scripts out.
   *
   * A 'layout' is the one kind whose confidence is not about its `name` at all. The milliseconds
   * come from a Long Animation Frames entry and are 'measured' unless part of the total had to be
   * apportioned across the edge of the window, which no React build changes. Where the commit that
   * would have named it cannot be trusted to, the name is dropped for the browser's own invoker
   * rather than the confidence being lowered, so a 'measured' layout never carries a guessed name.
   */
  readonly confidence: 'measured' | 'inferred';
}

/** A rating on INP's thresholds, in web-vitals' words: good up to 200 ms, needs improvement up to 500 ms, poor beyond. */
export type Rating = 'good' | 'needs-improvement' | 'poor';

/**
 * The report in plain words, for people and for UIs. `blame.kind`, `blame.name`, `blame.ms`,
 * `blame.confidence`, `rating` and the phases' `ms` are data. `blame.detail`, `headline`, `where`,
 * `cause`, `notes` and the phases' `label` and `hint` are display text: their wording may change in
 * any version, so show them, never parse or compare them.
 */
export interface Explanation {
  /** e.g. "216 ms click". Display text. */
  readonly headline: string;
  /** The cause as data, for a one-line UI. */
  readonly blame: Blame;
  /** The interaction's duration on INP's thresholds. */
  readonly rating: Rating;
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
 * How the page came to be at a URL, with the values of web-vitals' `Metric['navigationType']`. The
 * document's own load takes it from the browser's navigation entry, or 'prerender' and 'restore' for a
 * page that was prerendered or discarded and loaded again. 'soft-navigation' is a client-side navigation
 * a router announced (the Next.js App Router through `react-inp-blame/next`, any other router through
 * `announceNavigation`), and 'back-forward-cache' is a page restored from the back/forward cache. The set
 * is this library's own and stays as it is through 1.x: a navigation type a browser adds later reads as
 * 'navigate' until 2.0.0.
 */
export type NavigationType = 'navigate' | 'reload' | 'back-forward' | 'back-forward-cache' | 'prerender' | 'restore' | 'soft-navigation';

/** A soft navigation an interaction started, as the router announced it. */
export interface StartedNavigation {
  /** Where it went: an absolute URL without its query, fragment or password. */
  readonly url: string;
  /**
   * The router's word for it: 'push' or 'replace' for a link or `router.push()` / `router.replace()`, 'traverse'
   * for back and forward. `announceNavigation` always records 'push', and so does a type Next.js passes that is
   * none of these three, so the set stays as it is through 1.x.
   */
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
  readonly schemaVersion: 4;
  readonly interactionId: number;
  /** The event the headline is named after: the best-known one in the headline entry's paint group. */
  readonly type: string;
  /**
   * Whether this library could see what React did when the report was built (`Stats.react`). Under
   * 'installed-late' and 'unreadable', `commits` is empty whatever React did, and the explanation says
   * React's work is unknown rather than that it rendered nothing. Where React stopped being read partway
   * through the interaction, the commits read before that stay, and a note says so.
   */
  readonly reactStatus: ReactStatus;
  /**
   * The build of react-dom the page renders with. A development build is slower than the others, and StrictMode
   * renders twice there, so its numbers run higher than production's: this is what to drop or label reports by
   * before they are forwarded. 'development' where any react-dom on the page says so to the DevTools hook, as
   * the badge's mark does, in whatever order they registered. A production and a profiling build say the same
   * there, and only a profiling build puts its roots in React's ProfileMode, so those two are told apart by the
   * page's first commit. Null where react-dom did not say, where no react-dom registered, and for a production
   * or profiling build before the page's first commit or that this library cannot read.
   */
  readonly reactBuild: 'development' | 'production' | 'profiling' | null;
  /**
   * Whether a component React rendered for this interaction was under `<StrictMode>`, which renders each
   * component twice in a development build, so its render times run higher than the same code's outside
   * StrictMode. Null unless `reactBuild` is 'development' and the report holds a commit, since no other
   * build renders twice.
   */
  readonly strictMode: boolean | null;
  /**
   * The pointer `type`'s event came from, as the browser named it on the event the library saw dispatched.
   * Browsers give 'mouse', 'pen' or 'touch', and any other value is passed on as it is, since this is the
   * browser's string rather than a set of the library's own. A click takes a finger's or a pen's from its
   * press's pointerdown, since WebKit gives a tap's click 'mouse'. Null for a key, for a click a key made,
   * when the library did not see the event, and where the browser gave an empty string.
   */
  readonly pointerType: string | null;
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
  /**
   * The first press of another interaction (a keydown, pointerdown or click) that came after this one's
   * input and before its paint: its event `type`, `pointerType` as for this report, `start`, its
   * `timeStamp`, and `endedAt`, when React finished what it rendered in that press's own dispatch, null
   * where it rendered nothing there. A press coming then does not by itself mean the frame waited on it.
   * Typing fast, the next key's keydown and its render come before the frame the last keyup paints in, and
   * that wait is in `presentation`; the explanation says the frame waited only where the page worked on
   * the press before the paint for half the screen update or more, going by that render or by a script
   * Long Animation Frames recorded from the press on. Null when no press came in that time, or when the
   * library no longer holds the one that did.
   */
  readonly nextInput: { readonly type: string; readonly pointerType: string | null; readonly start: number; readonly endedAt: number | null } | null;
  readonly target: TargetInfo | null;
  /**
   * Server-rendered HTML the interaction landed on before React had hydrated it; null when it landed
   * on HTML React had already hydrated, which is every interaction on a client-rendered page and
   * almost every one on a server-rendered page.
   */
  readonly hydration: Hydration | null;
  /**
   * The origin and path of the page the interaction happened on: the document's, or that of the latest
   * soft navigation that had begun when the interaction did. A query, a fragment and a password are left
   * out, since a report is made to be forwarded. web-vitals' `Metric.navigationURL` keeps them, so match
   * the two on the path.
   */
  readonly navigationURL: string;
  /** How the page came to be at `navigationURL`: web-vitals' `Metric.navigationType`. */
  readonly navigationType: NavigationType;
  /** The soft navigation the interaction started, when a router announced one while its input was being dispatched; null otherwise. */
  readonly startedNavigation: StartedNavigation | null;
  /** React commits between the input and the next paint: what INP measures. */
  readonly commits: readonly CommitSummary[];
  /**
   * Commits that landed after that paint but still belong to this input (effects, transitions, cascades), within
   * `inputWindow` of the paint, or of the end of a later input's own work in the same interaction, such as the
   * click that releases a press held past the paint, and before any newer input or any `input`, `change` or
   * `submit` a script dispatched after the paint. One made outside any dispatch and stamped with a keyup or a
   * pointerup is left out where another press came between that release and its own, as when keys roll over
   * while typing fast. One a key set off before the headline's input, after another of the interaction's entries
   * painted and inside none of them, is one too, from that paint: a keydown's render before its slower keyup. A
   * pointer's before its release is not, whether its press sent an entry or not: the hook stamps a drag's move
   * renders with its pointerdown.
   * INP does not count them, except one that ran inside another of the interaction's own entries
   * (`CommitSummary.inDispatch`), such as that release's render; the user still waits for them.
   */
  readonly followUps: readonly CommitSummary[];
  /**
   * React commits that ran while this interaction's own handlers were running and could not be tied to
   * it, and so were left out of `commits` and `followUps`. Above zero, the report knows React rendered
   * and not what it rendered: the explanation says so and its blame is never `measured`. A commit made
   * outside those handlers, by a timer or a clock elsewhere on the page, is not counted here.
   */
  readonly unjoinedCommits: number;
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
  /**
   * Which corner the badge sits in. Without it the badge starts bottom right and moves to the next free corner
   * when the page's own fixed or sticky element holds that one.
   */
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  /** Start with the panel open. Default false. */
  open?: boolean;
  /** How many interactions the panel keeps, newest first, and as many again in its fold of quick ones. Default 20. */
  max?: number;
}

export interface InstallOptions {
  /**
   * Show the on-page badge and panel. `true` or an options object shows them, unless someone pressed
   * Hide for me in this browser, which `?inp-blame` or `#inp-blame` in the URL clears. `'query'` shows
   * them only when the URL carries `?inp-blame` / `#inp-blame` or localStorage has
   * `react-inp-blame=overlay`, which is how you open it on a production page without shipping UI to
   * users. Their code is loaded with a dynamic import after install() returns. Default false.
   */
  overlay?: boolean | 'query' | OverlayOptions;
  /** Report interactions at or above this duration (ms), plus shorter ones that trigger a later render INP does not count. Default 40. */
  threshold?: number;
  /**
   * Draw each report in the Chrome Performance panel, in a "react-inp-blame" track group, once the
   * page is idle. The interaction's entry is a User Timing measure, which every `PerformanceObserver`
   * on the page receives, verdict and label included, so `'auto'` draws only under a development build
   * of react-dom and `true` under any build. Default 'auto'.
   */
  devtoolsTrack?: boolean | 'auto';
  /**
   * Maximum component fibers (function, class, memo and forwardRef components) React rendered or passed
   * through per commit walk; DOM and text fibers do not count, nor does a component React only cloned and
   * skipped, and a memo wrapper counts as one with the component it renders. Default 5000.
   */
  walkBudget?: number;
  /**
   * How long after an input's own work ends a commit can still be that input's, in ms. Default 1500.
   * A commit React makes inside the input's dispatch is always its own, however long the dispatch runs,
   * so this bounds only the commits that arrive after it: effects, transitions, data that came back, and
   * a `change` or `input` the browser fires from a later task, such as a file chosen in the system dialog.
   * A report takes the ones that land within this long of its paint as its `followUps`, or within this
   * long of the end of a later input's own work in the same interaction where that came after the paint.
   */
  inputWindow?: number;
  /** Expose the API on window (true = window.__REACT_INP_BLAME__, or give a name). */
  debugGlobal?: boolean | string;
  /**
   * Where a report's `target.label` may come from. Every label names the element by its tag and a
   * name of at most 40 characters, and none ever reads an element's whole `textContent` or a form
   * field's value. An element inside a `contenteditable` editor, or inside one with the role `textbox`,
   * `searchbox`, `combobox` or `spinbutton`, counts as a form field, since its text is what a person typed,
   * and so does an element an `EditContext` is attached to, or one up to five elements inside it.
   *
   * `'attributes'`: only what the page's code wrote on the element: its `aria-label`, a form field's
   * `placeholder`, `aria-placeholder` or `name`, an input's `type`, or its `data-testid` or `data-test`.
   * `'text'`: the same, except that a form field with no `aria-label` is named by its `<label>` first,
   * and any other element with no `aria-label` by its first run of text, the way a person would name
   * it. That text can be what the page shows about a person (a name in a table cell), and it travels
   * with every report you forward to an error tracker or analytics.
   * `'auto'`: text under a development build of React, attributes under any other.
   *
   * Default 'auto'.
   */
  labels?: 'auto' | 'text' | 'attributes';
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
   * no hook, no listeners, no observers. Later calls return that API until dispose(). In a browser
   * without Event Timing `interactionId`, where nothing installs, the same share, rolled once per page,
   * decides whether a production build prints the warning about it; a development build always does.
   * Default 1.
   */
  sampleRate?: number;
}
