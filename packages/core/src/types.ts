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
   * under, or empty where they sit under none.
   */
  readonly hotPath: readonly string[];
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
  /** Total render time of the commit in ms when durations exist, else 0. */
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

/** What made a page 'unsupported': the kind, as data, and the sentence the console warning gave. */
export interface UnsupportedReason {
  /**
   * 'browser': no Event Timing `interactionId` (Chrome 96, Firefox 144, Safari 26.2), so nothing was
   * installed. 'another-copy': a copy of this library from an incompatible version is already on the
   * page, so this one installed nothing. 'hook-disabled': the page's DevTools hook has `isDisabled` set
   * or no `supportsFiber`, so React registers with no hook. The other three stop the reading of one
   * react-dom's commits, and the page is 'unsupported' when that leaves no react-dom it can read:
   * 'react-version', a react-dom outside React 17 to 19; 'fiber-shape', a first commit whose root is not
   * the shape this library reads; 'walk-threw', reading a commit threw. Reports carry on without components.
   */
  kind: 'browser' | 'another-copy' | 'hook-disabled' | 'react-version' | 'fiber-shape' | 'walk-threw';
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
  /**
   * Published reports, oldest first, each at its latest revision. At most 50: past that the oldest goes,
   * except the INP estimate's report and the ten slowest.
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
}

export interface TargetInfo {
  /** A CSS selector for the element: its tag, its id if it has one, then its `data-test` or `data-testid` attribute, or else up to two of its classes. */
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
   * Where the time mostly went. 'hydration' is React hydrating, inside the interaction, the
   * server-rendered HTML the input landed on: the report's `hydration` names the boundary. An input
   * that was never dispatched because its HTML was *still* waiting spent its time elsewhere, so it
   * keeps the blame that says where, and `hydration.kind` is `'not-hydrated'`. 'layout' is the
   * browser recalculating styles and layout inside the handlers, one figure in a Long Animation Frames
   * entry, which measures it in every build, React's durations or not.
   */
  readonly kind: 'render' | 'handler' | 'hydration' | 'layout' | 'waiting' | 'painting' | 'script' | 'none';
  /**
   * The subtree that re-rendered, the handler that ran, the script, or the boundary that was
   * hydrated; null when unknown. A 'render' always has one: the subtree, or 'the app' where the commit
   * named none. For a 'layout' it is where the layout was forced, never what forced
   * it, because no source says that. That is the subtree of a commit the interaction can claim: one
   * joined by its own input stamp, walked to the end, with no commit of the interaction left
   * unjoined. Failing that it is the invoker the browser charged the script to ("DIV#root.onclick"),
   * and only while one script holds nearly all of `ms`; where several scripts share the total, no
   * one of them is where the layout happened and this is null. The cause sentence names the largest
   * either way, with how much of the total it holds. For a 'waiting' it is the invoker of the script
   * the input waited behind ("TimerHandler:setTimeout"), when Long Animation Frames recorded one that
   * filled at least half of the wait; null otherwise. A 'handler' React has no name for (a listener
   * bound on the document, say) takes the invoker of the longest script in the working time on the
   * same terms: "#document.onkeydown".
   */
  readonly name: string | null;
  /**
   * For a render or a hydration, what it was mostly made of: many of one component ("LineItem ×800"), one
   * component's own render where React timed it at half the render or more ("TableBody's own render"), else
   * how many components rendered ("637 components"). For a render, of which how many inside the component
   * `name` gives, where that is fewer ("812 of 1216 components"); a hydration is named after a boundary or
   * the page, which holds them all, so it carries the whole count. Null where it rendered one. For a
   * handler, its component, or null where the name is a listener the browser recorded rather than a React
   * handler. For a 'layout', what that same commit was mostly made of, as a render's, wherever `name` came
   * from that commit, and null wherever `name` did not, since a script has no component counts.
   */
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
 * The report in plain words, for people and for UIs. `blame`, `rating` and the phases' `ms` are
 * data. `headline`, `where`, `cause`, `notes` and the phases' `label` and `hint` are display text:
 * their wording may change in any version, so show them, never parse or compare them.
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
  readonly schemaVersion: 3;
  readonly interactionId: number;
  /** The event the headline is named after: the best-known one in the headline entry's paint group. */
  readonly type: string;
  /**
   * Whether this library could see what React did when the report was built (`Stats.react`). Under
   * 'installed-late' and 'unreadable', `commits` is empty whatever React did, and the explanation says
   * React's work is unknown rather than that it rendered nothing.
   */
  readonly reactStatus: ReactStatus;
  /**
   * The pointer `type`'s event came from, 'mouse', 'pen' or 'touch', as the library saw it dispatched;
   * null for a key, for a click a key made, and when the library did not see the event.
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
  readonly target: TargetInfo | null;
  /**
   * Server-rendered HTML the interaction landed on before React had hydrated it; null when it landed
   * on HTML React had already hydrated, which is every interaction on a client-rendered page and
   * almost every one on a server-rendered page.
   */
  readonly hydration: Hydration | null;
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
  /**
   * Commits that landed after that paint but still belong to this input (effects, transitions, cascades), within
   * `inputWindow` of the paint, or of the end of a later input's own work in the same interaction, such as the
   * click that releases a press held past the paint. INP does not count them; the user still waits for them.
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
  /**
   * Maximum component fibers (function, class, memo and forwardRef components) visited per commit walk;
   * DOM and text fibers do not count, and a memo wrapper counts as one with the component it renders.
   * Default 5000.
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
   * field's value.
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
