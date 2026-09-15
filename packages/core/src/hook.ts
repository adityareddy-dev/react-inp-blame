import { fiberFromNode, profileModeBit, rootShapeProblem, walkCommit, type Fiber } from './fiber.js';
import { shared } from './session.js';
import type { CommitSummary, HookInfo, InputRecord, InstallOptions, RendererInfo, Stats, UnsupportedReason } from './types.js';
import { warnOnce } from './warn.js';

const HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';
const MAX_COMMITS = 300;

/** Where React and every devtool look for the hook: `window`. */
interface HookHolder {
  [HOOK_KEY]?: unknown;
}

/** What React passes `onCommitFiberRoot`: the root of the tree it just committed. */
interface FiberRoot {
  current: Fiber;
}

/** A `__REACT_DEVTOOLS_GLOBAL_HOOK__`, reduced to what this library calls or wraps. */
interface DevtoolsHook {
  /** What each renderer handed `inject()`, by id. React DevTools' hook fills it; Fast Refresh's stub does not. */
  renderers?: Map<number, unknown>;
  inject(internals: unknown): number;
  onCommitFiberRoot(id: number, root: FiberRoot, priority?: number, didError?: boolean): void;
  /** Marks the hook this library created. */
  reactInpBlame?: true;
}

/** Why React's commits cannot be read: the kind `stats().unsupportedReason` reports, and the reason in words. */
interface Problem {
  kind: Extract<UnsupportedReason['kind'], 'react-version' | 'fiber-shape' | 'walk-threw'>;
  reason: string;
}

interface Renderer {
  info: RendererInfo;
  /** Only react-dom commits are walked: other renderers have no DOM behind their fibers. */
  isReactDom: boolean;
  /** `profileModeBit` for its React major. */
  profileMode: number;
  /** Why its commits cannot be read (a React outside 17 to 19, a root of another shape), or null. */
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

interface HookState {
  options: HookOptions | null;
  /** The hook commits are read from while installed. */
  attached: DevtoolsHook | null;
  /** Puts a chained hook back the way it was. */
  detach: (() => void) | null;
  /** The hook this library created. React keeps the hook it registered with for the page's life, so a second install reuses it. */
  shim: DevtoolsHook | null;
  devtoolsLockedOut: boolean;
  mode: Stats['mode'];
  /** Set with the first reason React's commits stopped being read. */
  unsupported: UnsupportedReason | null;
  /** Every commit walked so far, oldest first. */
  commits: CommitSummary[];
  walks: number;
  walkTotalMs: number;
  /** Renderers per hook object, by the id that hook's inject() returned. */
  registries: WeakMap<DevtoolsHook, Map<number, Renderer>>;
  /** The last 8 inputs seen, oldest first. */
  inputs: InputRecord[];
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
}));

// The events Event Timing gives an interactionId to. Derived events (input, change, keypress,
// submit) are dispatched inside one of these, so a commit during them is stamped with the
// newest ring entry, which is the key or pointer that caused them.
export const INPUT_TYPES = ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup'];
const RING_SIZE = 8;
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
  const rec: InputRecord = {
    ts: e.timeStamp,
    type: e.type,
    gestureTs: gestureOf(e, isKey),
    press: isKey ? e.code : e.pointerId,
    target,
    fiber: fiberFromNode(target),
  };
  state.inputs.push(rec);
  if (state.inputs.length > RING_SIZE) state.inputs.shift();
  return rec;
}

/** The pointerdown or keydown this event releases, by pointerId or key code; the newest press as a fallback. */
function gestureOf(e: DispatchedInput, isKey: boolean): number {
  if (e.type === 'pointerdown' || e.type === 'keydown') return e.timeStamp;
  const want = isKey ? 'keydown' : 'pointerdown';
  const press = isKey ? e.code : e.pointerId;
  const inputs = state.inputs;
  let fallback = -1;
  for (let i = inputs.length - 1; i >= 0; i--) {
    const r = inputs[i];
    if (r.type !== want || e.timeStamp - r.ts > PRESS_WINDOW) continue;
    if (press !== undefined && r.press === press) return r.ts;
    if (fallback < 0) fallback = r.ts;
  }
  return fallback < 0 ? e.timeStamp : fallback;
}

/**
 * The input being dispatched right now: `window.event`, when it is one of INPUT_TYPES, whose
 * `timeStamp` is exactly its Event Timing entry's `startTime`. Recorded in the ring if the capture
 * listener has not seen it yet. Null outside an input's dispatch.
 */
export function dispatchedInput(): InputRecord | null {
  const ev = typeof window !== 'undefined' ? (window.event as DispatchedInput | undefined) : undefined;
  if (!ev || !ev.isTrusted || INPUT_TYPES.indexOf(ev.type) < 0) return null;
  const inputs = state.inputs;
  const last = inputs.length ? inputs[inputs.length - 1] : null;
  return last && last.ts === ev.timeStamp ? last : record(ev);
}

/**
 * The input a commit belongs to. A sync commit runs inside the event's dispatch, so it is the input
 * being dispatched. Anything else (a transition, an effect, data arriving) is stamped with the
 * newest input seen.
 */
function currentInput(): InputRecord | null {
  const inputs = state.inputs;
  return dispatchedInput() ?? (inputs.length ? inputs[inputs.length - 1] : null);
}

/** Every commit walked so far, oldest first. Live array. */
export function recordedCommits(): CommitSummary[] {
  return state.commits;
}

export function clearCommits(): void {
  state.commits.length = 0;
}

/** The hook's half of `stats()`. */
export function hookStats(): Pick<Stats, 'mode' | 'unsupportedReason' | 'walks' | 'walkTotalMs'> {
  noticeReplacement();
  return { mode: state.mode, unsupportedReason: state.unsupported, walks: state.walks, walkTotalMs: state.walkTotalMs };
}

/** `api.debug.hook()`. */
export function hookInfo(): HookInfo {
  noticeReplacement();
  return { owner: owner(), renderers: knownRenderers(), devtoolsLockedOut: state.devtoolsLockedOut };
}

/** What each renderer known to the hook in use handed `inject()`. */
export function knownRenderers(): RendererInfo[] {
  return state.attached ? [...registryOf(state.attached).values()].map((r) => r.info) : [];
}

/** The shim's accessor sees an assignment; a tool that redefined or deleted the property is only found by looking. */
function noticeReplacement(): void {
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

/** Stops reading commits and puts a chained hook back the way it was. The shim stays: React still holds it. */
export function uninstallHook(): void {
  state.detach?.();
  state.detach = null;
  state.attached = null;
  state.options = null;
  state.mode = 'none';
  state.unsupported = null;
  state.commits = [];
  state.walks = 0;
  state.walkTotalMs = 0;
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
  const major = info.version ? parseInt(info.version, 10) : NaN;
  const supported = major >= 17 && major <= 19;
  const isReactDom = info.rendererPackageName === 'react-dom';
  const renderer: Renderer = {
    info,
    isReactDom,
    profileMode: supported ? profileModeBit(major) : 0,
    problem: isReactDom && !supported ? { kind: 'react-version', reason: `react-dom ${info.version ?? 'without a version'} is outside React 17 to 19` } : null,
    checked: false,
  };
  registryOf(hook).set(id, renderer);
  return renderer;
}

function admit(renderer: Renderer): void {
  if (renderer.isReactDom && renderer.problem) failClosed(renderer.problem);
}

/** A React this library does not know is not guessed at: stop reading commits and say why, once. */
function failClosed({ kind, reason }: Problem): void {
  const message = `${reason}, so React commits are not read. Interactions are still reported, without components.`;
  state.mode = 'unsupported';
  state.unsupported ??= { kind, message };
  warnOnce('unsupported-react', message);
}

function onCommit(hook: DevtoolsHook, id: number, root: FiberRoot, priority: number | undefined, didError: boolean | undefined): void {
  const { options } = state;
  if (!options || hook !== state.attached || state.mode === 'unsupported') return;
  // A renderer that registered before install() is unknown here, and its commits are not read.
  const renderer = registryOf(hook).get(id);
  if (!renderer || !renderer.isReactDom) return;
  if (!renderer.checked) checkFirstCommit(renderer, root);
  if (renderer.problem) return;
  const now = performance.now();
  const input = currentInput();
  // Outside an interaction window this is the whole cost: a lookup and one subtraction.
  if (!input || now - input.ts > options.inputWindow) return;
  const t0 = performance.now();
  const walk = walkCommit(root.current, options.walkBudget, now, input, { profileMode: renderer.profileMode, priority, didError: didError === true });
  const summary: CommitSummary = Object.freeze({ ...walk, walkMs: performance.now() - t0 });
  state.walkTotalMs += summary.walkMs;
  state.walks++;
  if (state.commits.length >= MAX_COMMITS) state.commits.shift();
  state.commits.push(summary);
  options.onSummary(summary);
}

function checkFirstCommit(renderer: Renderer, root: FiberRoot): void {
  renderer.checked = true;
  const shape = rootShapeProblem(root && root.current);
  if (shape) {
    renderer.problem = { kind: 'fiber-shape', reason: `the fiber tree of react-dom ${renderer.info.version} is not the shape this library reads (${shape})` };
    failClosed(renderer.problem);
    return;
  }
  // A root's first commit replaces the empty fiber createRoot made. A rendered tree behind the
  // first commit seen here means the root rendered before install(), and those commits were missed.
  if (root.current.alternate?.child) {
    warnOnce('late-install', "install() ran after a React root had already rendered, so its earlier commits were missed. Install ahead of the app with react-inp-blame/vite or react-inp-blame/next, or make `import 'react-inp-blame/auto'` the first import of your entry module.");
  }
}

/** React calls the hook inside its commit; nothing here may throw into it. */
function guarded(hook: DevtoolsHook, id: number, root: FiberRoot, priority?: number, didError?: boolean): void {
  try {
    onCommit(hook, id, root, priority, didError);
  } catch (error) {
    failClosed({ kind: 'walk-threw', reason: `reading a React commit threw (${String(error)})` });
  }
}

/** Wraps a hook someone else installed; returns the undo. */
function chain(hook: DevtoolsHook): () => void {
  const prevInject = hook.inject;
  const prevCommit = hook.onCommitFiberRoot;
  const inject = function (this: unknown, ...args: Parameters<DevtoolsHook['inject']>): number {
    const id = prevInject.apply(this, args);
    const renderer = register(hook, id, args[0]);
    if (hook === state.attached) admit(renderer);
    return id;
  };
  const onCommitFiberRoot = function (this: unknown, ...args: Parameters<DevtoolsHook['onCommitFiberRoot']>): void {
    guarded(hook, ...args);
    if (typeof prevCommit === 'function') prevCommit.apply(this, args);
  };
  if (typeof prevInject === 'function') hook.inject = inject;
  hook.onCommitFiberRoot = onCommitFiberRoot;
  // Renderers that registered before install(): React DevTools' hook kept what they handed it.
  if (hook.renderers instanceof Map) {
    const registry = registryOf(hook);
    for (const [id, internals] of hook.renderers) if (!registry.has(id)) register(hook, id, internals);
  }
  return () => {
    // Put the originals back unless another tool has wrapped ours since; then ours stay and pass through.
    if (hook.inject === inject) hook.inject = prevInject;
    if (hook.onCommitFiberRoot === onCommitFiberRoot) hook.onCommitFiberRoot = prevCommit;
  };
}

/**
 * The least React needs to register and report commits. React checks for every other hook
 * method before calling it (17.0.2, 18.3.1 and 19.3.0 alike), and there is deliberately no
 * `checkDCE`: react-dom reads that as React DevTools being present.
 */
function createShim(): DevtoolsHook {
  let nextId = 0;
  const renderers = new Map<number, unknown>();
  const hook: DevtoolsHook & { supportsFiber: true } = {
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
      guarded(hook, id, root, priority, didError);
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
