import { dehydratedAround, fiberFromNode, handlerOf, hydratedSince, namingFiber, nextDevToolsRoot, ownersOf, profileModeBit, reportsPassiveEffects, rootShapeProblem, walkCommit, type FiberRoot } from './fiber.js';
import { controlOf } from './element.js';
import { shared } from './session.js';
import type { CommitSummary, HookInfo, HydrationBoundary, InstallOptions, RendererInfo, Stats, UnsupportedReason } from './types.js';
import { NEWEST_REACT_MAJOR, OLDEST_REACT_MAJOR, parseReactVersion } from './version.js';
import { warnOnce } from './warn.js';

const HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';
const MAX_COMMITS = 300;
/**
 * `inputWindow` by default, ms. The hook measures it from the end of the input's own work; a report
 * takes later renders within the same length of its paint, or of that end where it came after the
 * paint (`followUpFrom` in join.ts).
 */
export const DEFAULT_INPUT_WINDOW = 1500;

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
  /** Its React major, 0 outside the versions read. */
  major: number;
  /**
   * React passes the Scheduler priority of the lanes a commit rendered, which tells continuous-event work
   * apart: React 19.1 and later. 19.0 and 18 pass the priority of the moment the commit is made.
   */
  lanePriority: boolean;
  /** `profileModeBit` for its React major. */
  profileMode: number;
  /** Why its commits cannot be read (a React outside 17 to 19, a root of another shape, a walk that threw), or null. */
  problem: Problem | null;
  /** Its first commit has been checked. */
  checked: boolean;
  /** Every root it has committed so far is Next.js's dev overlay's, and those are never read (see `nextDevToolsRoot`). */
  devToolsOnly: boolean;
}

/** The fields of a pointer or key event the ring reads. */
interface DispatchedInput {
  readonly isTrusted: boolean;
  readonly type: string;
  readonly timeStamp: number;
  readonly target: EventTarget | null;
  readonly pointerId?: number;
  readonly pointerType?: string;
  readonly code?: string;
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
  /** 'mouse', 'pen' or 'touch' for a pointer event; empty or absent for a key, and for a click a key made. */
  readonly pointerType?: string;
  readonly target: Node | null;
  /**
   * The control the target is inside (the button around a clicked icon), found at dispatch while both
   * are still in the page; the target itself when there is none. Absent on records made elsewhere.
   */
  readonly control?: Node | null;
  /**
   * The report's label for the control, read at dispatch: a click on "Count is 0" that renders "Count
   * is 1" is labelled by what was clicked. Absent on records made elsewhere and before install().
   */
  readonly label?: string | null;
  /**
   * The components enclosing the target at dispatch (the control, for a click on an icon inside one), nearest first. Read before React's handlers run:
   * once React commits the deletion of an element, React 18 and 19 clear its fiber's links and props, so
   * a clicked row that deleted itself is still named after what it was.
   */
  readonly owners: readonly string[];
  /** The React handler prop for this input's type on the target chain at dispatch, read then for the same reason. */
  readonly handler: string | null;
  /**
   * Server-rendered HTML enclosing the target that React had not hydrated when the input was
   * dispatched; null when React had hydrated it, and on a page with no React root above the target.
   */
  readonly dehydrated: HydrationBoundary | null;
  /** What React did about this input. The hook keeps it current as commits arrive; the record itself does not change. */
  readonly work: InputWork;
}

/** The React work one input caused, as the DevTools hook saw it. */
export interface InputWork {
  /**
   * Where the window for joining later commits is measured from: the input's `ts` until React commits
   * inside its dispatch, then the end of the last such commit. A commit that arrives after the dispatch
   * is joined to the input while it lands within `inputWindow` of this, so a slow interaction's
   * follow-up render is still its own rather than cut off a fixed time after the input.
   *
   * It is the end of the last commit inside the dispatch, not the end of the dispatch. A handler that
   * runs for two seconds and commits nothing leaves this on the input itself, and a render it starts
   * afterwards can fall outside the window and be dropped. Dropped is not lost: the time is kept in
   * `unjoined` and the report says React rendered something it could not tie to the interaction.
   */
  endedAt: number;
  /**
   * `endedAt` as the input's own task left it. A commit inside a derived event from a later task, a
   * `change` or an `input`, moves `endedAt` and not this, and such an event counts as the input's
   * dispatch only within `inputWindow` of this, so a stream of them (dictation, an input method,
   * autofill) cannot hold the window open by carrying it forward one event at a time.
   */
  ownEndedAt: number;
  /**
   * When commits React made while this was the newest input landed, for the ones not joined to it
   * because they came past that window, newest last and capped. A report counts only those that ran
   * inside one of its interaction's processing spans; on a page with a clock in it, most are the clock.
   * A report with any says so and is never `measured`: React did render, and this library cannot say
   * what the render belonged to.
   */
  unjoined: number[];
  /**
   * The times of the first few `input`, `change` and `submit` events a script dispatched while this was
   * the newest input, once its task had ended, and outside the task of a trusted one of those handed to
   * it. None of them is an interaction, but a render after one can be its work rather than this input's,
   * so a report takes no later render past one that came after its paint (`noteCloser`). Absent until one
   * arrives.
   */
  closers?: number[];
}

export interface HookOptions {
  hook: NonNullable<InstallOptions['hook']>;
  walkBudget: number;
  inputWindow: number;
  onSummary: (c: CommitSummary) => void;
  /** Names the control an input landed on, at dispatch (see `InputRecord.label`). */
  label?: (control: Node) => string | null;
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
  /** The newest input while the task that dispatched it is still running; null once a task queued behind it has run. */
  inTask: InputRecord | null;
  /**
   * The newest input while a later task runs a trusted `input`, `change` or `submit` that
   * `dispatchedInput` hands to it (`noteCloser`); null once a task queued behind that one has run.
   * Absent where a copy of an earlier version made the state.
   */
  derivedTask?: InputRecord | null;
  /**
   * `timeStamp` of the last `resize` that changed the page's width (`noteResize`), and that width. Absent
   * where a copy of an earlier version made the state; `noteResize` fills them in.
   */
  resizedAt?: number;
  width?: number;
  /** Every root that committed while installed, held weakly so that an unmounted root is not kept alive by this list. */
  roots: WeakRef<FiberRoot>[];
  /** What the page's report listeners caused on each root in `roots`. */
  listenerWork: WeakMap<FiberRoot, ListenerWork>;
  /** The page's report listeners are running. */
  hearing: boolean;
  /** Per root, the commits React has not yet said ran their passive effects, newest last (`onPostCommit`). */
  awaitingEffects: WeakMap<FiberRoot, AwaitingEffects[]>;
}

/** A commit's place until React says its passive effects ran. */
interface AwaitingEffects {
  /** The commit as walked, or null for one that was not. */
  summary: CommitSummary | null;
  /** Its tree holds passive work, so React will say when that ran (`reportsPassiveEffects`). */
  reported: boolean;
  /**
   * When the hook call for it returned, every tool chained on the hook included (React DevTools reads
   * each commit too). The effects start after that, so nothing before it is theirs.
   */
  returnedAt: number;
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
  inTask: null,
  roots: [],
  listenerWork: new WeakMap(),
  hearing: false,
  awaitingEffects: new WeakMap(),
}));

// The events Event Timing gives an interactionId to, and so the only ones an interaction is ever
// named by. A derived event (`DERIVED_TYPES` below) is dispatched inside one of these, so a commit
// during one is stamped with the newest ring entry, which is the key or pointer that caused it.
export const INPUT_TYPES = ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup'];
const DERIVED_TYPES = ['input', 'beforeinput', 'change', 'submit', 'keypress'];
// Events that are never an interaction's work: the page resized or scrolled, or the pointer moved over it.
// A commit React makes while one of them is being dispatched, outside any input's task, is that event's:
// a handler under React 17, which renders inside every event, or a flushSync in a scroll listener. React 18
// and 19 render what a `resize` or a hover sets in a task of their own, which `noteResize` and the priority
// below tell apart.
const AMBIENT_TYPES = [
  'resize',
  'scroll',
  'scrollend',
  'wheel',
  'visibilitychange',
  'pointermove',
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
  'mousemove',
  'mouseover',
  'mouseout',
  'mouseenter',
  'mouseleave',
  'touchmove',
];
// The Scheduler priority React 19.1 and later pass with a commit of continuous-event work: a hover, a
// scroll, a wheel or a drag, rendered in a task of its own after the event. They derive it from the lanes
// they rendered; React 18 and 19.0 pass the priority of the moment they commit, which in that task is normal.
const USER_BLOCKING_PRIORITY = 2;
const RING_SIZE = 8;
// Times of commits that could not be joined to one input, kept per input. A page that commits in a
// loop would otherwise grow this without end; the oldest are the least likely to be worth reporting.
const MAX_UNJOINED = 16;
/** Commits per root waiting for React to say their passive effects ran. Only one committed inside another's effects waits behind a newer one. */
const MAX_AWAITING_EFFECTS = 8;
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

/** The events that close the newest input's later renders when a script dispatches one (`noteCloser`). */
export const CLOSER_TYPES = ['input', 'change', 'submit'];

/**
 * Capture-phase listener for CLOSER_TYPES. One a script dispatched outside any input's task has no Event
 * Timing entry and no place in the ring, yet it is something new happening on the page, and a render
 * after it can be its work rather than the newest input's. Sorting a table by a click and then changing
 * its page size through Playwright's `selectOption`, which fires `input` and `change` from script, put
 * the page-size render on the sort as its later render. The time is kept on the newest input
 * (`InputWork.closers`), where `join.ts` reads it. One the browser fires is left alone: it comes in the
 * task of the key or click that caused it, or carries on what that input began (an option picked from
 * the select it opened, or text dictated into the field it focused), which `dispatchedInput` hands to
 * the input within `inputWindow`. So is one a script dispatches in the task of such a trusted event, as a
 * select's onChange firing `input` on another field does: it answers the same input (`derivedTask`).
 */
export function noteCloser(e: Event): void {
  const last = newestInput();
  if (state.inTask !== null || !last) return;
  if (e.isTrusted) {
    if (isNode(e.target) && e.timeStamp - last.work.ownEndedAt <= (state.options?.inputWindow ?? DEFAULT_INPUT_WINDOW)) {
      state.derivedTask = last;
      setTimeout(() => {
        if (state.derivedTask === last) state.derivedTask = null;
      }, 0);
    }
    return;
  }
  if (state.derivedTask === last) return;
  // The first few are enough: only the first after the report's paint closes anything, and at most a
  // handful come between the end of the input's task and its paint.
  const closers = (last.work.closers ??= []);
  if (closers.length < MAX_UNJOINED) closers.push(e.timeStamp);
}

function record(e: DispatchedInput): InputRecord {
  const isKey = e.type === 'keydown' || e.type === 'keyup';
  const target = e.target as Node | null;
  // Read now, before React's handlers run: once React commits the deletion of the element, React 18
  // and 19 clear its fiber's links and props, and the Event Timing entry arrives after that.
  const fiber = fiberFromNode(target);
  // The control labels the click, and for a click on an icon the components are read from what the icon
  // belongs to: an icon library's `Trash2` inside the button is not what anyone clicked. Both found now,
  // since a click that swaps the icon detaches it before the entry.
  const control = controlOf(target);
  const rec: InputRecord = {
    ts: e.timeStamp,
    type: e.type,
    gestureTs: gestureOf(e, isKey),
    press: isKey ? e.code : e.pointerId,
    pointerType: e.pointerType,
    target,
    control,
    label: control && state.options?.label?.(control),
    owners: Object.freeze(ownersOf(namingFiber(target))),
    handler: handlerOf(fiber, e.type, isKey ? e.code : null),
    work: { endedAt: e.timeStamp, ownEndedAt: e.timeStamp, unjoined: [] },
    // Asked of every input, not only of one with no fiber: a Suspense boundary can still be waiting
    // inside a page React has otherwise hydrated, and then the target's nearest fiber is the hydrated
    // ancestor above the boundary. React reads the same markers on every event it dispatches.
    dehydrated: frozen(dehydratedAround(target)),
  };
  state.inputs.push(rec);
  if (state.inputs.length > RING_SIZE) state.inputs.shift();
  // A task queued now runs only after the one dispatching this input has finished, with whatever
  // derived events the browser fires from it.
  state.inTask = rec;
  setTimeout(() => {
    if (state.inTask === rec) state.inTask = null;
  }, 0);
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

/**
 * The pointerdown or keydown this event releases, by pointerId or key code; the newest press as a fallback.
 *
 * A click made from the keyboard has no pointer to pair by, and Chrome gives it pointerId -1. It comes in
 * the task of the key that made it, Enter's keydown or a Space's keyup, and is part of that key's press
 * whatever its pointerId says. Paired by the fallback it took the newest pointerdown within PRESS_WINDOW,
 * an earlier mouse click's, and its render joined that click's report. The one click in a key's task that
 * is not the key's is a tap's (`tapInFlight`). Any other click with pointerId -1 takes the press of the
 * input whose task it came in, and with none behind it is a gesture of its own.
 */
function gestureOf(e: DispatchedInput, isKey: boolean): number {
  if (e.type === 'pointerdown' || e.type === 'keydown') return e.timeStamp;
  const task = state.inTask;
  const fromKey = task !== null && (task.type === 'keydown' || task.type === 'keyup');
  if (e.type === 'click' && (fromKey || e.pointerId === -1) && !tapInFlight(e)) return task ? task.gestureTs : e.timeStamp;
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
 * Whether this is a tap's click whose pointer went down and has had no click since. A tap's click comes in
 * a task of its own after the touchend, and a key pressed just before it can still be `state.inTask` then,
 * since Chromium runs input ahead of the timer the key's task left to clear it. That click is the tap's,
 * and pairs by its pointerId. Only touch and pen go that way: a mouse's click comes in its pointerup's
 * task, and a mouse press that never clicked (a right click, a drag) must not take a keyboard click that
 * carries its pointerId.
 */
function tapInFlight(e: DispatchedInput): boolean {
  if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return false;
  for (let i = state.inputs.length - 1; i >= 0; i--) {
    const r = state.inputs[i];
    if (!r || r.press !== e.pointerId || e.timeStamp - r.ts > PRESS_WINDOW) continue;
    if (r.type === 'click') return false;
    if (r.type === 'pointerdown') return true;
  }
  return false;
}

/**
 * The input being dispatched right now: `window.event`, when it is one of INPUT_TYPES, whose
 * `timeStamp` is exactly its Event Timing entry's `startTime`. Recorded in the ring if the capture
 * listener has not seen it yet. Null outside an input's dispatch.
 *
 * When `window.event` is one of DERIVED_TYPES, such as an `input` or a `change`, this returns the
 * newest input in the ring instead, because the browser fires a derived event as part of the input
 * that caused it. Typing is the case that matters: React's onChange for a text field runs during the
 * native `input` event, not during the keydown, and the keystroke's own render would otherwise look
 * like an unrelated commit. An event a script makes and sends with dispatchEvent() is not trusted,
 * so a `change` or `submit` dispatched that way gets null, the same as no event at all.
 *
 * Only while the derived event is part of that input: fired in the task that dispatched it, or within
 * `inputWindow` of the end of the work that task did (`ownEndedAt`). That is measured from the derived
 * event's own `timeStamp`, since a slow render inside an `input` event ends seconds after it. A
 * `change` the browser fires once a file is chosen in the system dialog, an option is picked from a
 * native select's popup or a password manager fills a field can come long after the click on it, and
 * gets null: its commit is then held to the window like any other, and cannot make a late render the
 * click's own. A derived event from a later task does not move `ownEndedAt`, so text that arrives
 * with no key pressed, from dictation or an input method, stops counting once it passes the window.
 */
export function dispatchedInput(): InputRecord | null {
  const ev = typeof window !== 'undefined' ? (window.event as DispatchedInput | undefined) : undefined;
  if (!ev || !ev.isTrusted) return null;
  if (DERIVED_TYPES.indexOf(ev.type) >= 0) {
    // A `change` from a MediaQueryList, the screen's orientation or the network connection is not part
    // of any input: only an element's (or the document's) derived event is.
    if (!isNode(ev.target)) return null;
    const last = newestInput();
    if (!last) return null;
    return last === state.inTask || ev.timeStamp - last.work.ownEndedAt <= (state.options?.inputWindow ?? DEFAULT_INPUT_WINDOW) ? last : null;
  }
  if (INPUT_TYPES.indexOf(ev.type) < 0) return null;
  const last = newestInput();
  return last && last.ts === ev.timeStamp ? last : record(ev);
}

/**
 * How long after an input's own work a commit can still join it, as this page configured it
 * (`inputWindow`), or null before install() has run. Reports quote it when their explanation is first
 * read, so while the hook is installed a note gives the number the hook actually used rather than the
 * default; a report first read after dispose() quotes the default.
 */
export function joinWindow(): number | null {
  return state.options?.inputWindow ?? null;
}

/** A DOM node, told by its `nodeType`, so that a node of another frame counts too. */
const isNode = (target: EventTarget | null): boolean => target !== null && typeof (target as { nodeType?: unknown }).nodeType === 'number';

/**
 * Whether `window.event` is a trusted event whose commits are its own and no input's: one of
 * AMBIENT_TYPES, a `change` from something that is not an element (a media query hook), or the window
 * itself gaining or losing focus. Asked only outside an input's task, where such an event cannot be
 * the input's own doing.
 */
function inAmbientEvent(): boolean {
  const ev = typeof window !== 'undefined' ? (window.event as DispatchedInput | undefined) : undefined;
  if (!ev || !ev.isTrusted) return false;
  if (AMBIENT_TYPES.indexOf(ev.type) >= 0) return true;
  if (ev.type === 'change') return !isNode(ev.target);
  return (ev.type === 'focus' || ev.type === 'blur') && ev.target === window;
}

/**
 * Capture-phase listener for `resize`: a render after the page changed width is the page's, a layout
 * hook's or a media query's, and not the last input's (`onCommit`). A resize that changes only the
 * height is a phone's keyboard or address bar coming and going, which a tap on a field causes, and the
 * render after it can still be the tap's.
 */
export function noteResize(e: Event): void {
  if (!e.isTrusted) return;
  const width = window.innerWidth;
  if (width === state.width) return;
  state.width = width;
  state.resizedAt = e.timeStamp;
}

/** Whether `window.event` is one of DERIVED_TYPES, which `dispatchedInput` hands to the newest input. */
function inDerivedEvent(): boolean {
  const ev = typeof window !== 'undefined' ? window.event : undefined;
  return ev !== undefined && DERIVED_TYPES.indexOf(ev.type) >= 0;
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

/** Whether a react-dom the page renders with has registered with the hook in use and can be read. */
export function readingReactDom(): boolean {
  if (!state.attached || (state.mode !== 'shim' && state.mode !== 'chained')) return false;
  for (const renderer of registryOf(state.attached).values()) {
    if (renderer.isReactDom && !renderer.devToolsOnly && !renderer.problem) return true;
  }
  return false;
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
    // The dev overlay's own react-dom is never read, so it is not one the page can still be read through.
    if (!renderer.isReactDom || renderer.devToolsOnly) continue;
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
  state.width = window.innerWidth;
  state.resizedAt = undefined;
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
  state.inTask = null;
  state.derivedTask = null;
  state.walks = 0;
  state.walkTotalMs = 0;
  state.roots = [];
  state.listenerWork = new WeakMap();
  state.hearing = false;
  state.awaitingEffects = new WeakMap();
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
    major: supported ? version.major : 0,
    lanePriority: supported && (version.major > 19 || (version.major === 19 && version.minor >= 1)),
    profileMode: supported ? profileModeBit(version.major) : 0,
    problem: null,
    checked: false,
    devToolsOnly: false,
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
  if (renderer.isReactDom && renderer.problem) warnOnce(renderer.problem.message, renderer.problem.message, renderer.problem.kind);
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
  // Next.js's dev overlay is not the app, so nothing it commits is walked or tied to an input (see `nextDevToolsRoot`).
  if (nextDevToolsRoot(root)) {
    if (!renderer.checked) renderer.devToolsOnly = true;
    return;
  }
  if (!renderer.checked) checkFirstCommit(renderer, root);
  if (renderer.problem) return;
  // Every commit holds a place until React says its passive effects ran, walked or not, so that the
  // report is matched to the commit it belongs to (`onPostCommit`).
  const place: AwaitingEffects = { summary: null, reported: reportsPassiveEffects(root, renderer.major), returnedAt: performance.now() };
  const awaiting = awaitingEffectsOf(root);
  awaiting.push(place);
  if (awaiting.length > MAX_AWAITING_EFFECTS) awaiting.shift();
  placed = place;
  const dispatched = dispatchedInput();
  if (causedByListeners(root, dispatched !== null)) return;
  const now = performance.now();
  // A root's first commit mounts it, or hydrates its server-rendered HTML: the page starting up, not an
  // input's work, unless React ran it inside that input's dispatch (a click that opens a dialog in a root
  // of its own, or React hydrating so that it can handle the click). A Suspense boundary hydrating is the
  // same, and only the walk can find one.
  const firstCommit = root.current.alternate === null || root.current.alternate.child === null;
  const input = dispatched ?? (firstCommit ? null : newestInput());
  // Outside an interaction window this is the whole cost: a few lookups and one subtraction.
  if (!input) return;
  // A commit outside the input's dispatch that something else plainly caused is not the input's, and not
  // a commit it could not account for either: it is left alone, like a commit before any input.
  if (!dispatched && notTheInputs(input, renderer, priority)) return;
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
  // In the input's own task the commit is inside that input's Event Timing entry, so INP timed it, even
  // after the paint of an earlier entry of the same interaction. A derived event from a later task is not.
  const inDispatch = dispatched !== null && (dispatched === state.inTask || !inDerivedEvent());
  const t0 = performance.now();
  const walk = walkCommit(root.current, options.walkBudget, now, input, { profileMode: renderer.profileMode, priority, didError: didError === true, hydratedTarget: creditHydration(input) });
  const summary: CommitSummary = Object.freeze({ ...walk, walkMs: performance.now() - t0, inDispatch });
  state.walkTotalMs += summary.walkMs;
  state.walks++;
  // Only the dispatch extends the window. Were a joined follow-up to extend it too, one commit every
  // second would keep an interaction's window open for as long as the page lived.
  if (dispatched) {
    input.work.endedAt = performance.now();
    // A derived event from a later task is held to the window from the input's own work, which it does
    // not move, or each one would open the window again for the next.
    if (inDispatch) input.work.ownEndedAt = input.work.endedAt;
  }
  if (summary.hydrated && !dispatched) return;
  if (state.commits.length >= MAX_COMMITS) state.commits.shift();
  state.commits.push(summary);
  place.summary = summary;
  options.onSummary(summary);
}

/**
 * Whether a commit outside any input's dispatch was caused by something other than `input`, the newest
 * input: a resize, scroll or hover being dispatched as React committed (`inAmbientEvent`), the page's
 * width changing since the input (`noteResize`), or, where React says so, continuous-event work. React 18
 * and 19 render a hover's, a scroll's or a wheel's update in a task of its own, where there is no event
 * to read, and React 19.1 and later commit it with user-blocking priority. An input's own updates are
 * immediate, and what its effects, timers and transitions set off is normal or lower, but a touch sets off
 * hover events of its own (pointerover and pointerenter, then the compatibility mouseover and mouseenter),
 * whose updates get that same priority. A finger hovers over nothing, so after a touch the priority says
 * nothing about whose the work is, and neither does it inside the input's own task. Production builds pass
 * no priority, React 18 and 19.0 pass the commit's moment's (normal, in that task) and React 17 its own
 * numbers, so there only the first two apply (README, Known limits).
 */
function notTheInputs(input: InputRecord, renderer: Renderer, priority: number | undefined): boolean {
  if (state.inTask === null && inAmbientEvent()) return true;
  if (state.resizedAt !== undefined && state.resizedAt > input.ts) return true;
  return priority === USER_BLOCKING_PRIORITY && renderer.lanePriority && state.inTask === null && input.pointerType !== 'touch';
}

function awaitingEffectsOf(root: FiberRoot): AwaitingEffects[] {
  let awaiting = state.awaitingEffects.get(root);
  if (!awaiting) state.awaitingEffects.set(root, (awaiting = []));
  return awaiting;
}

/**
 * Puts when `summary`'s passive effects ended on it. A report is built from `state.commits` once the
 * interaction's Event Timing entry arrives, after the paint, so a commit whose effects React ran in the
 * same task has the time by then. The summary already handed to `onSummary` is only read as a render
 * after the paint, whose effects never count.
 */
function effectsRan(summary: CommitSummary, startedAt: number, endedAt: number): void {
  const i = state.commits.lastIndexOf(summary);
  if (i >= 0) state.commits[i] = Object.freeze({ ...summary, effectsStartedAt: startedAt, effectsEndedAt: endedAt });
}

/**
 * The place the hook call now running pushed, until that call returns. Module state rather than page
 * state: the call that pushes it and the wrapper that returns are both this copy's.
 */
let placed: AwaitingEffects | null = null;

/** Every tool on the hook has had the commit; its effects can start from here. */
function hookReturned(): void {
  if (placed) placed.returnedAt = performance.now();
  placed = null;
}

function checkFirstCommit(renderer: Renderer, root: FiberRoot): void {
  renderer.checked = true;
  renderer.devToolsOnly = false;
  const shape = rootShapeProblem(root);
  if (shape) {
    const build = renderer.experimental ? ' (an experimental build, read as React 19)' : '';
    stopReading(renderer, 'fiber-shape', `the fiber tree of react-dom ${renderer.info.version}${build} is not the shape this library reads (${shape})`);
    return;
  }
  // A root's first commit replaces the empty fiber createRoot made. A rendered tree behind the
  // first commit seen here means the root rendered before install(), and those commits were missed.
  if (root.current.alternate?.child) {
    warnOnce('late-install', "install() ran after a React root had already rendered, so its earlier commits were missed. Install with the Vite, Next.js or Astro plugin, or make `import 'react-inp-blame/auto'` the first import of your entry module.");
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
 *
 * Not a commit inside an input's dispatch (`inInput`) that finished such a lane: that is the input's work
 * with theirs rendered along. React 19 renders sync, continuous and default updates in one pass, so a key
 * pressed before React's own task for a listener's update renders that update with the key's. Typing at
 * full speed in the demo, 9 of 23 keystrokes had their commit read as the panel's render and dropped, and
 * their reports said the handler's script took the time. Kept, the commit counts the listener's components
 * beside the input's, and where the input's own render is small they can be what the render blame names.
 * Nor is `effectsPending` set for it, so an update the listener's components make in useEffect reads as
 * the input's later render. Both are the lesser error.
 */
function causedByListeners(root: FiberRoot, inInput: boolean): boolean {
  const work = listenerWorkOf(root);
  const theirs = state.hearing || (!inInput && (work.lanes & ~root.pendingLanes) !== 0);
  // The lanes this commit finished are done with; the ones still pending stay theirs.
  work.lanes &= root.pendingLanes;
  if (theirs) takeNewLanes(root, work);
  else work.seen = root.pendingLanes;
  work.effectsPending = theirs;
  return theirs;
}

/**
 * React 18 and 19, once a commit's passive effects have run. React 17 has no such call, so there an
 * effect of the listeners' render is not recognised, and no commit gets `effectsEndedAt`.
 */
function onPostCommit(hook: DevtoolsHook, id: number, root: FiberRoot): void {
  if (hook !== state.attached) return;
  // The call is the newest waiting commit's that React reports for. React runs a commit's pending
  // effects before it renders again, so no commit can come between one and its call, except those
  // React commits inside that call's passive phase: an update an effect made with `flushSync`, or one
  // a layout effect made, which React renders once the effects are done and before it says so. Those
  // came later, so they sit above it, and their own calls come first. One with no passive work gets no
  // call and is passed over, and one React calls for anyway (a React 19 development build calls for
  // every commit it timed) passes its call down to the commit it was made inside: the effects of that
  // one had ended by then, and the commit's own time is its span, taken out in `join.ts`.
  const awaiting = state.awaitingEffects.get(root);
  if (awaiting && !registryOf(hook).get(id)?.problem) {
    const now = performance.now();
    for (let place = awaiting.pop(); place; place = awaiting.pop()) {
      if (!place.reported) continue;
      if (place.summary) effectsRan(place.summary, place.returnedAt, now);
      break;
    }
  }
  const work = state.listenerWork.get(root);
  if (!work?.effectsPending) return;
  work.effectsPending = false;
  takeNewLanes(root, work);
}

/** React calls the hook inside its commit; nothing here may throw into it. */
function guardedCommit(hook: DevtoolsHook, id: number, root: FiberRoot, priority?: number, didError?: boolean): void {
  placed = null;
  try {
    onCommit(hook, id, root, priority, didError);
  } catch (error) {
    threw(hook, id, error);
  }
}

function guardedPostCommit(hook: DevtoolsHook, id: number, root: FiberRoot): void {
  try {
    onPostCommit(hook, id, root);
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
    try {
      if (typeof prevCommit === 'function') prevCommit.apply(this, args);
    } finally {
      hookReturned();
    }
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
      hookReturned();
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
