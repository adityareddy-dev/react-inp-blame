import { dehydratedAround, fiberFromNode, handlerOf, hydratedSince, ownersOf, profileModeBit, rootShapeProblem, walkCommit, type FiberRoot } from './fiber.js';
import { shared } from './session.js';
import type { CommitSummary, HookInfo, HydrationBoundary, InputRecord, InstallOptions, RendererInfo, Stats, UnsupportedReason } from './types.js';
import { NEWEST_REACT_MAJOR, OLDEST_REACT_MAJOR, parseReactVersion } from './version.js';
import { warnOnce } from './warn.js';

const HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';
const MAX_COMMITS = 300;

/** Where React and every devtool look for the hook: `window`. */
interface HookHolder {
  [HOOK_KEY]?: unknown;
}

/** A `__REACT_DEVTOOLS_GLOBAL_HOOK__`, reduced to what this library reads, calls or wraps. */
interface DevtoolsHook {
  /** What each renderer handed `inject()`, by id. React DevTools' hook fills it; Fast Refresh's stub does not. */
  renderers?: Map<number, unknown>;
  /** React registers with no hook that sets it: how a page turns React's developer tools support off. */
  isDisabled?: boolean;
  /** React registers only with a hook that sets it. */
  supportsFiber?: boolean;
  inject(internals: unknown): number;
  onCommitFiberRoot(id: number, root: FiberRoot, priority?: number, didError?: boolean): void;
  /** React 18 and 19 call it once a commit's passive effects have run, when the hook has it. */
  onPostCommitFiberRoot?(id: number, root: FiberRoot): void;
  /** Marks the hook this library created. */
  reactInpBlame?: true;
}

/** Why a renderer's commits cannot be read: the kind `stats().unsupportedReason` reports, and the warning's sentence. */
interface Problem {
  kind: Extract<UnsupportedReason['kind'], 'react-version' | 'fiber-shape' | 'walk-threw'>;
  message: string;
}

interface Renderer {
  info: RendererInfo;
  /** Only react-dom commits are walked: other renderers have no DOM behind their fibers. */
  isReactDom: boolean;
  /** Its version is an experimental build's, read as the newest React (see `parseReactVersion`). */
  experimental: boolean;
  /** `profileModeBit` for its React major. */
  profileMode: number;
  /** Why its commits cannot be read (a React outside 17 to 19, a root of another shape, a walk that threw), or null. */
  problem: Problem | null;
  /** Its first commit has been checked. */
  checked: boolean;
}

/** The fields of a pointer or key event the ring reads. */
interface DispatchedInput {
  readonly isTrusted: boolean;
  readonly type: string;
  readonly timeStamp: number;
  readonly target: EventTarget | null;
  readonly pointerId?: number;
  readonly code?: string;
}

export interface HookOptions {
  hook: NonNullable<InstallOptions['hook']>;
  walkBudget: number;
  inputWindow: number;
  onSummary: (c: CommitSummary) => void;
}

/**
 * The React work the page's report listeners caused on one root. A listener that shows reports renders
 * when it hears one. That render has no input of its own, so it would be stamped with the report's
 * input, join the report as its later render, and reach the listener again as the report's next
 * revision: a loop on any page that renders its reports. React sets a lane (a bit) in
 * `root.pendingLanes` for each update and clears it when the update commits, so the lanes the listeners
 * leave pending name their work, and so do the lanes that work schedules in turn.
 */
interface ListenerWork {
  /** Pending lanes whose work the listeners caused. */
  lanes: number;
  /** `pendingLanes` when last looked at: a lane set since is new. */
  seen: number;
  /** The root's last commit was the listeners' work, and React has not yet said that its passive effects ran. */
  effectsPending: boolean;
}

interface HookState {
  options: HookOptions | null;
  /** The hook commits are read from while installed. */
  attached: DevtoolsHook | null;
  /** Puts a chained hook back the way it was. */
  detach: (() => void) | null;
  /** The hook this library created. React keeps the hook it registered with for the page's life, so a second install reuses it. */
  shim: DevtoolsHook | null;
  devtoolsLockedOut: boolean;
  /** How the hook is in use: 'shim', 'chained' or 'none', or 'unsupported' when the page's hook is disabled. */
  mode: Stats['mode'];
  /** Why the page's hook cannot be used at all. A renderer's own problem is on the renderer. */
  unsupported: UnsupportedReason | null;
  /** Every commit walked so far, oldest first. */
  commits: CommitSummary[];
  walks: number;
  walkTotalMs: number;
  /** Renderers per hook object, by the id that hook's inject() returned. */
  registries: WeakMap<DevtoolsHook, Map<number, Renderer>>;
  /** The last 8 inputs seen, oldest first. */
  inputs: InputRecord[];
  /** Every root that committed while installed, held weakly so that an unmounted root is not kept alive by this list. */
  roots: WeakRef<FiberRoot>[];
  /** What the page's report listeners caused on each root in `roots`. */
  listenerWork: WeakMap<FiberRoot, ListenerWork>;
  /** The page's report listeners are running. */
  hearing: boolean;
}

/** One for the page, whichever copy of the library installed (see session.ts). */
const state = shared<HookState>('hook', () => ({
  options: null,
  attached: null,
  detach: null,
  shim: null,
  devtoolsLockedOut: false,
  mode: 'none',
  unsupported: null,
  commits: [],
  walks: 0,
  walkTotalMs: 0,
  registries: new WeakMap(),
  inputs: [],
  roots: [],
  listenerWork: new WeakMap(),
  hearing: false,
}));

// The events Event Timing gives an interactionId to, and so the only ones an interaction is ever
// named by. A derived event (`DERIVED_TYPES` below) is dispatched inside one of these, so a commit
// during one is stamped with the newest ring entry, which is the key or pointer that caused it.
export const INPUT_TYPES = ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup'];
const RING_SIZE = 8;
// Times of commits that could not be joined to one input, kept per input. A page that commits in a
// loop would otherwise grow this without end; the oldest are the least likely to be worth reporting.
const MAX_UNJOINED = 16;
// A press can be held this long and its release still counts as the same gesture.
const PRESS_WINDOW = 5000;

/** The last 8 inputs seen, oldest first. Live array, do not mutate. */
export function recentInputs(): InputRecord[] {
  return state.inputs;
}

/** Capture-phase listener for INPUT_TYPES: keeps the ring current. */
export function noteInput(e: Event): void {
  if (!e.isTrusted || INPUT_TYPES.indexOf(e.type) < 0) return;
  record(e);
}

function record(e: DispatchedInput): InputRecord {
  const isKey = e.type === 'keydown' || e.type === 'keyup';
  const target = e.target as Node | null;
  // Read now, before React's handlers run: once React commits the deletion of the element, React 18
  // and 19 clear its fiber's links and props, and the Event Timing entry arrives after that.
  const fiber = fiberFromNode(target);
  const rec: InputRecord = {
    ts: e.timeStamp,
    type: e.type,
    gestureTs: gestureOf(e, isKey),
    press: isKey ? e.code : e.pointerId,
    target,
    owners: Object.freeze(ownersOf(fiber)),
    handler: handlerOf(fiber, e.type, isKey ? e.code : null),
    work: { endedAt: e.timeStamp, unjoined: [] },
    // Asked of every input, not only of one with no fiber: a Suspense boundary can still be waiting
    // inside a page React has otherwise hydrated, and then the target's nearest fiber is the hydrated
    // ancestor above the boundary. React reads the same markers on every event it dispatches.
    dehydrated: frozen(dehydratedAround(target)),
  };
  state.inputs.push(rec);
  if (state.inputs.length > RING_SIZE) state.inputs.shift();
  return rec;
}

const frozen = <T>(x: T | null): T | null => (x === null ? null : Object.freeze(x));

/** Inputs whose wait for server-rendered HTML has already been credited to a commit, so it is credited once. */
const credited = new WeakSet<InputRecord>();

/**
 * The server-rendered HTML this input landed on, if this is the commit that hydrated it. Asked of
 * the DOM, which the commit has already updated, and answered at most once per input: a later commit
 * in the same window finds the page hydrated and is not a second hydration of it.
 */
function creditHydration(input: InputRecord): HydrationBoundary | null {
  if (input.dehydrated == null || credited.has(input)) return null;
  const done = hydratedSince(input.target, input.dehydrated);
  if (done) credited.add(input);
  return done;
}

/** The pointerdown or keydown this event releases, by pointerId or key code; the newest press as a fallback. */
function gestureOf(e: DispatchedInput, isKey: boolean): number {
  if (e.type === 'pointerdown' || e.type === 'keydown') return e.timeStamp;
  const want = isKey ? 'keydown' : 'pointerdown';
  const press = isKey ? e.code : e.pointerId;
  let fallback = -1;
  for (let i = state.inputs.length - 1; i >= 0; i--) {
    const r = state.inputs[i];
    if (!r || r.type !== want || e.timeStamp - r.ts > PRESS_WINDOW) continue;
    if (press !== undefined && r.press === press) return r.ts;
    if (fallback < 0) fallback = r.ts;
  }
  return fallback < 0 ? e.timeStamp : fallback;
}

/**
 * The input being dispatched right now: `window.event`, when it is one of INPUT_TYPES, whose
 * `timeStamp` is exactly its Event Timing entry's `startTime`. Recorded in the ring if the capture
 * listener has not seen it yet. Null outside an input's dispatch.
 *
 * A derived event counts as its input's dispatch. Typing is the case that matters: React's onChange
 * for a text field runs during the native `input` event, not during the keydown, so `window.event`
 * there is an `input` and the keystroke's own render would otherwise look like an unrelated commit.
 * The browser dispatches each of these inside the input that caused it, so the newest ring entry is
 * that input; `isTrusted` keeps a `change` or `submit` fired by script out.
 */
const DERIVED_TYPES = ['input', 'beforeinput', 'change', 'submit', 'keypress'];

export function dispatchedInput(): InputRecord | null {
  const ev = typeof window !== 'undefined' ? (window.event as DispatchedInput | undefined) : undefined;
  if (!ev || !ev.isTrusted) return null;
  if (DERIVED_TYPES.indexOf(ev.type) >= 0) return newestInput();
  if (INPUT_TYPES.indexOf(ev.type) < 0) return null;
  const last = newestInput();
  return last && last.ts === ev.timeStamp ? last : record(ev);
}

/**
 * How long after an input's own work a commit can still join it, as this page configured it
 * (`inputWindow`), or null before install() has run. Reports quote it, so the number a note gives is
 * the number the hook actually used rather than the default.
 */
export function joinWindow(): number | null {
  return state.options?.inputWindow ?? null;
}

/** The newest input in the ring. */
function newestInput(): InputRecord | null {
  return state.inputs[state.inputs.length - 1] ?? null;
}

/** Every commit walked so far, oldest first. Live array. */
export function recordedCommits(): CommitSummary[] {
  return state.commits;
}

export function clearCommits(): void {
  state.commits.length = 0;
}

/** The hook's half of `stats()`. It only reads. */
export function hookStats(): Pick<Stats, 'mode' | 'unsupportedReason' | 'walks' | 'walkTotalMs'> {
  const unsupportedReason = state.unsupported ?? unreadableReactDom();
  return { mode: unsupportedReason ? 'unsupported' : state.mode, unsupportedReason, walks: state.walks, walkTotalMs: state.walkTotalMs };
}

/** `api.debug.hook()`. */
export function hookInfo(): HookInfo {
  return { owner: owner(), renderers: knownRenderers(), devtoolsLockedOut: state.devtoolsLockedOut };
}

/** What each renderer known to the hook in use handed `inject()`. */
export function knownRenderers(): RendererInfo[] {
  return state.attached ? [...registryOf(state.attached).values()].map((r) => r.info) : [];
}

/** Why no react-dom on the page can be read, when every one registered has a problem; null while one can be, or before any registers. */
function unreadableReactDom(): UnsupportedReason | null {
  if (!state.attached) return null;
  let first: Problem | null = null;
  for (const renderer of registryOf(state.attached).values()) {
    if (!renderer.isReactDom) continue;
    if (!renderer.problem) return null;
    first ??= renderer.problem;
  }
  return first && { kind: first.kind, message: first.message };
}

/**
 * Looks for a tool that replaced the shim by redefining or deleting the global, which its accessor
 * cannot see (an assignment it can). install() calls it at fixed points, so reading `stats()` or
 * `debug.hook()` never changes what they report.
 */
export function checkHookReplaced(): void {
  const { attached, shim } = state;
  if (!attached || attached !== shim) return;
  const current = (window as unknown as HookHolder)[HOOK_KEY];
  if (current !== shim) replaced(shim, current);
}

function owner(): string {
  const { attached } = state;
  if (!attached) return 'none';
  if (attached.reactInpBlame) return 'react-inp-blame';
  const keys = Object.keys(attached);
  return keys.length ? `existing hook (${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', ...' : ''})` : 'existing hook';
}

/**
 * React tells the DevTools hook about every commit, in production builds too, but only if the
 * hook exists before react-dom evaluates. So this chains onto the hook that is already there
 * (React DevTools, Fast Refresh) or, unless told to only chain, creates a minimal one.
 */
export function installHook(opts: HookOptions): void {
  state.options = opts;
  const holder = window as unknown as HookHolder;
  const existing = holder[HOOK_KEY] as DevtoolsHook | undefined;
  if (existing && existing === state.shim) {
    attach(existing, 'shim');
  } else if (existing && (existing.isDisabled || !existing.supportsFiber)) {
    // React checks both before registering, so it registers with no hook at all.
    const message =
      "the page's __REACT_DEVTOOLS_GLOBAL_HOOK__ turns React's developer tools support off (isDisabled, or no supportsFiber), so React registers with no hook and its commits cannot be read. Interactions are still reported, without components.";
    state.mode = 'unsupported';
    state.unsupported = { kind: 'hook-disabled', message };
    warnOnce('hook-disabled', message);
  } else if (existing) {
    if (opts.hook === 'shim') {
      warnOnce('shim-over-hook', "hook: 'shim' found a React DevTools hook already installed and chained onto it instead: replacing it would lock out whatever installed it.");
    }
    attach(existing, 'chained');
  } else if (opts.hook === 'chain') {
    state.mode = 'none';
  } else {
    const shim = (state.shim ??= createShim());
    defineGlobal(holder, shim);
    attach(shim, 'shim');
  }
}

/** Stops reading commits, forgets what was read, and puts a chained hook back the way it was. The shim stays: React still holds it. */
export function uninstallHook(): void {
  state.detach?.();
  state.detach = null;
  state.attached = null;
  state.options = null;
  state.mode = 'none';
  state.unsupported = null;
  state.commits = [];
  state.inputs = [];
  state.walks = 0;
  state.walkTotalMs = 0;
  state.roots = [];
  state.listenerWork = new WeakMap();
  state.hearing = false;
}

function attach(hook: DevtoolsHook, as: 'shim' | 'chained'): void {
  state.attached = hook;
  state.mode = as;
  state.unsupported = null;
  state.detach = as === 'chained' ? chain(hook) : null;
  for (const renderer of registryOf(hook).values()) admit(renderer);
}

function registryOf(hook: DevtoolsHook): Map<number, Renderer> {
  let registry = state.registries.get(hook);
  if (!registry) state.registries.set(hook, (registry = new Map()));
  return registry;
}

/** Records what a renderer handed `inject()` and whether its commits can be read. */
function register(hook: DevtoolsHook, id: number, internals: unknown): Renderer {
  const handed = (internals ?? {}) as { version?: unknown; bundleType?: unknown; rendererPackageName?: unknown };
  const info: RendererInfo = Object.freeze({
    id,
    version: typeof handed.version === 'string' ? handed.version : null,
    bundleType: typeof handed.bundleType === 'number' ? handed.bundleType : null,
    rendererPackageName: typeof handed.rendererPackageName === 'string' ? handed.rendererPackageName : null,
  });
  const version = parseReactVersion(info.version);
  const supported = version !== null && version.major >= OLDEST_REACT_MAJOR && version.major <= NEWEST_REACT_MAJOR;
  const renderer: Renderer = {
    info,
    isReactDom: info.rendererPackageName === 'react-dom',
    experimental: version?.experimental ?? false,
    profileMode: supported ? profileModeBit(version.major) : 0,
    problem: null,
    checked: false,
  };
  if (!supported) renderer.problem = problem('react-version', `react-dom ${info.version ?? 'without a version'} is outside React ${OLDEST_REACT_MAJOR} to ${NEWEST_REACT_MAJOR}`);
  registryOf(hook).set(id, renderer);
  return renderer;
}

function problem(kind: Problem['kind'], reason: string): Problem {
  return { kind, message: `${reason}, so the commits of that react-dom are not read. Interactions are still reported, without its components.` };
}

/** Says once that a react-dom's commits cannot be read. Other renderers are not walked anyway, and are not warned about. */
function admit(renderer: Renderer): void {
  if (renderer.isReactDom && renderer.problem) warnOnce(renderer.problem.message, renderer.problem.message);
}

/** A React this library does not know is not guessed at: that renderer's commits are not read from here on. */
function stopReading(renderer: Renderer, kind: Problem['kind'], reason: string): void {
  renderer.problem = problem(kind, reason);
  admit(renderer);
}

function onCommit(hook: DevtoolsHook, id: number, root: FiberRoot, priority: number | undefined, didError: boolean | undefined): void {
  const { options } = state;
  if (!options || hook !== state.attached) return;
  // A renderer that registered before install() is unknown here, and its commits are not read.
  const renderer = registryOf(hook).get(id);
  if (!renderer || !renderer.isReactDom || renderer.problem) return;
  if (!renderer.checked) checkFirstCommit(renderer, root);
  if (renderer.problem || causedByListeners(root)) return;
  const now = performance.now();
  const dispatched = dispatchedInput();
  // A root's first commit mounts it, or hydrates its server-rendered HTML: the page starting up, not an
  // input's work, unless React ran it inside that input's dispatch (a click that opens a dialog in a root
  // of its own, or React hydrating so that it can handle the click). A Suspense boundary hydrating is the
  // same, and only the walk can find one.
  const firstCommit = root.current.alternate === null || root.current.alternate.child === null;
  const input = dispatched ?? (firstCommit ? null : newestInput());
  // Outside an interaction window this is the whole cost: a few lookups and one subtraction.
  if (!input) return;
  // A commit React ran inside an input's own dispatch is that input's work however long it took to get
  // there: the handler is still on the stack and nothing else can have caused it. Sorting 200,000 rows
  // takes seconds on a throttled machine, and a window measured from the input dropped exactly those
  // commits, leaving the slowest interactions looking as though React had never rendered.
  //
  // A commit outside any dispatch could be anyone's: an effect of this input, or a poll that happened
  // to fire. It joins the newest input while it lands within `inputWindow` of `endedAt`, which is the
  // input itself until React commits inside its dispatch and the end of the last such commit after
  // that. Two failure modes, both of them the window's own:
  //
  // - An unrelated commit landing inside the window is read as the input's follow-up render. That one
  //   the window always had; it is now anchored to the end of the interaction rather than its start.
  // - `endedAt` is the end of the last commit inside the dispatch, not the end of the dispatch. A
  //   handler that runs for two seconds and commits nothing leaves it on the input, so a transition it
  //   starts can land outside the window and be dropped. Dropped is not silent: the time is kept and a
  //   report whose interaction was still being handled then says React rendered something it could not
  //   tie to the interaction. Moving `endedAt` to the end of the dispatch would need a second listener
  //   per event type on the window, in the bubble phase, which is a bigger change than the case is.
  if (!dispatched && now - input.work.endedAt > options.inputWindow) {
    // Kept as times, not as a count: a page with a clock in it commits all day, and only a commit that
    // landed while this interaction's own handlers were running says anything about this interaction.
    // `join.ts` does that filtering; here there is no Event Timing entry to filter against yet.
    const dropped = input.work.unjoined;
    dropped.push(now);
    if (dropped.length > MAX_UNJOINED) dropped.shift();
    return;
  }
  const t0 = performance.now();
  const walk = walkCommit(root.current, options.walkBudget, now, input, { profileMode: renderer.profileMode, priority, didError: didError === true, hydratedTarget: creditHydration(input) });
  const summary: CommitSummary = Object.freeze({ ...walk, walkMs: performance.now() - t0 });
  state.walkTotalMs += summary.walkMs;
  state.walks++;
  // Only the dispatch extends the window. Were a joined follow-up to extend it too, one commit every
  // second would keep an interaction's window open for as long as the page lived.
  if (dispatched) input.work.endedAt = performance.now();
  if (summary.hydrated && !dispatched) return;
  if (state.commits.length >= MAX_COMMITS) state.commits.shift();
  state.commits.push(summary);
  options.onSummary(summary);
}

function checkFirstCommit(renderer: Renderer, root: FiberRoot): void {
  renderer.checked = true;
  const shape = rootShapeProblem(root);
  if (shape) {
    const build = renderer.experimental ? ' (an experimental build, read as React 19)' : '';
    stopReading(renderer, 'fiber-shape', `the fiber tree of react-dom ${renderer.info.version}${build} is not the shape this library reads (${shape})`);
    return;
  }
  // A root's first commit replaces the empty fiber createRoot made. A rendered tree behind the
  // first commit seen here means the root rendered before install(), and those commits were missed.
  if (root.current.alternate?.child) {
    warnOnce('late-install', "install() ran after a React root had already rendered, so its earlier commits were missed. Install ahead of the app with react-inp-blame/vite or react-inp-blame/next, or make `import 'react-inp-blame/auto'` the first import of your entry module.");
  }
}

/**
 * Calls the page's report listeners through `hear`, and remembers the React work they cause: a commit
 * during the call, and each lane the call leaves pending on a root. Those commits are the page's own
 * reporting UI, so they are never read as an interaction's render (see `ListenerWork`).
 */
export function hearingReports(hear: () => void): void {
  const roots: [FiberRoot, ListenerWork][] = [];
  state.roots = state.roots.filter((ref) => {
    const root = ref.deref();
    if (root) roots.push([root, listenerWorkOf(root)]);
    return root !== undefined;
  });
  for (const [root, work] of roots) work.seen = root.pendingLanes;
  state.hearing = true;
  try {
    hear();
  } finally {
    state.hearing = false;
    for (const [root, work] of roots) takeNewLanes(root, work);
  }
}

function listenerWorkOf(root: FiberRoot): ListenerWork {
  let work = state.listenerWork.get(root);
  if (!work) {
    state.listenerWork.set(root, (work = { lanes: 0, seen: root.pendingLanes, effectsPending: false }));
    state.roots.push(new WeakRef(root));
  }
  return work;
}

/** Counts the lanes set on the root since it was last looked at as the listeners' work. */
function takeNewLanes(root: FiberRoot, work: ListenerWork): void {
  work.lanes |= root.pendingLanes & ~work.seen;
  work.seen = root.pendingLanes;
}

/**
 * Whether this commit is the listeners' work: it ran while they did, or it finished a lane they left
 * pending. What such a commit's render and layout effects schedule is set by the time React calls the
 * hook, so it is theirs too; what its passive effects schedule is taken when React says they ran.
 */
function causedByListeners(root: FiberRoot): boolean {
  const work = listenerWorkOf(root);
  const theirs = state.hearing || (work.lanes & ~root.pendingLanes) !== 0;
  // The lanes this commit finished are done with; the ones still pending stay theirs.
  work.lanes &= root.pendingLanes;
  if (theirs) takeNewLanes(root, work);
  else work.seen = root.pendingLanes;
  work.effectsPending = theirs;
  return theirs;
}

/** React 18 and 19, once a commit's passive effects have run. React 17 has no such call, so there an effect of the listeners' render is not recognised. */
function onPostCommit(hook: DevtoolsHook, root: FiberRoot): void {
  if (hook !== state.attached) return;
  const work = state.listenerWork.get(root);
  if (!work?.effectsPending) return;
  work.effectsPending = false;
  takeNewLanes(root, work);
}

/** React calls the hook inside its commit; nothing here may throw into it. */
function guardedCommit(hook: DevtoolsHook, id: number, root: FiberRoot, priority?: number, didError?: boolean): void {
  try {
    onCommit(hook, id, root, priority, didError);
  } catch (error) {
    threw(hook, id, error);
  }
}

function guardedPostCommit(hook: DevtoolsHook, id: number, root: FiberRoot): void {
  try {
    onPostCommit(hook, root);
  } catch (error) {
    threw(hook, id, error);
  }
}

function threw(hook: DevtoolsHook, id: number, error: unknown): void {
  const renderer = registryOf(hook).get(id);
  if (renderer) stopReading(renderer, 'walk-threw', `reading a commit of react-dom ${renderer.info.version ?? 'without a version'} threw (${String(error)})`);
}

/** Wraps a hook someone else installed; returns the undo. */
function chain(hook: DevtoolsHook): () => void {
  const prevInject = hook.inject;
  const prevCommit = hook.onCommitFiberRoot;
  const hadPostCommit = Object.prototype.hasOwnProperty.call(hook, 'onPostCommitFiberRoot');
  const prevPostCommit = hook.onPostCommitFiberRoot;
  const inject = function (this: unknown, ...args: Parameters<DevtoolsHook['inject']>): number {
    const id = prevInject.apply(this, args);
    const renderer = register(hook, id, args[0]);
    if (hook === state.attached) admit(renderer);
    return id;
  };
  const onCommitFiberRoot = function (this: unknown, ...args: Parameters<DevtoolsHook['onCommitFiberRoot']>): void {
    guardedCommit(hook, ...args);
    if (typeof prevCommit === 'function') prevCommit.apply(this, args);
  };
  const onPostCommitFiberRoot = function (this: unknown, id: number, root: FiberRoot): void {
    guardedPostCommit(hook, id, root);
    if (typeof prevPostCommit === 'function') prevPostCommit.call(this, id, root);
  };
  if (typeof prevInject === 'function') hook.inject = inject;
  hook.onCommitFiberRoot = onCommitFiberRoot;
  hook.onPostCommitFiberRoot = onPostCommitFiberRoot;
  // Renderers that registered before install(): React DevTools' hook kept what they handed it.
  if (hook.renderers instanceof Map) {
    const registry = registryOf(hook);
    for (const [id, internals] of hook.renderers) if (!registry.has(id)) register(hook, id, internals);
  }
  return () => {
    // Put the originals back unless another tool has wrapped ours since; then ours stay and pass through.
    if (hook.inject === inject) hook.inject = prevInject;
    if (hook.onCommitFiberRoot === onCommitFiberRoot) hook.onCommitFiberRoot = prevCommit;
    if (hook.onPostCommitFiberRoot === onPostCommitFiberRoot) {
      if (hadPostCommit) hook.onPostCommitFiberRoot = prevPostCommit;
      else delete hook.onPostCommitFiberRoot;
    }
  };
}

/**
 * The least React needs to register and report commits, and the call after a commit's passive effects.
 * React checks for every other hook method before calling it (17.0.2, 18.3.1 and 19.3.0 alike), and
 * there is deliberately no `checkDCE`: react-dom reads that as React DevTools being present.
 */
function createShim(): DevtoolsHook {
  let nextId = 0;
  const renderers = new Map<number, unknown>();
  const hook: DevtoolsHook = {
    renderers,
    supportsFiber: true,
    inject(internals) {
      const id = ++nextId;
      // Kept the way React DevTools keeps them, for tools that chain on later (Fast Refresh reads them).
      renderers.set(id, internals);
      const renderer = register(hook, id, internals);
      if (hook === state.attached) admit(renderer);
      return id;
    },
    onCommitFiberRoot(id, root, priority, didError) {
      guardedCommit(hook, id, root, priority, didError);
    },
    onPostCommitFiberRoot(id, root) {
      guardedPostCommit(hook, id, root);
    },
    reactInpBlame: true,
  };
  return hook;
}

/**
 * Makes the shim the global through an accessor rather than a plain value, so that another tool
 * assigning its own hook later is noticed instead of silently winning or losing. React DevTools
 * never assigns: its installHook returns as soon as `window` has the property, without a read or a
 * write the accessor could see, so a shim that got there first locks it out unnoticed.
 */
function defineGlobal(holder: HookHolder, hook: DevtoolsHook): void {
  let current: unknown = hook;
  Object.defineProperty(holder, HOOK_KEY, {
    configurable: true,
    enumerable: false,
    get: () => current,
    set(next: unknown) {
      current = next;
      if (next !== hook) replaced(hook, next);
    },
  });
}

function replaced(hook: DevtoolsHook, next: unknown): void {
  if (hook !== state.attached) return;
  if (registryOf(hook).size) {
    // React holds on to the hook it registered with, so it keeps reporting to the shim.
    state.devtoolsLockedOut = true;
    warnOnce('locked-out', "__REACT_DEVTOOLS_GLOBAL_HOOK__ was replaced after React registered with react-inp-blame's hook, so the tool that replaced it will not see this React. Load that tool before react-inp-blame, or install with hook: 'chain'.");
  } else if (next && typeof next === 'object') {
    // Nothing has registered yet, so React will register with the replacement: follow it.
    attach(next as DevtoolsHook, 'chained');
  }
}
