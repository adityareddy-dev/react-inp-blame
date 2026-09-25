import { iconAround, isControl } from './element.js';
import type { InputStamp } from './hook.js';
import type { CommitSummary, HydrationBoundary, RenderedComponent } from './types.js';

// React work tags, stable across 17, 18 and 19.
const FunctionComponent = 0;
const ClassComponent = 1;
const HostRoot = 3;
const HostComponent = 5;
const ForwardRef = 11;
const SuspenseComponent = 13;
const MemoComponent = 14;
const SimpleMemoComponent = 15;
// Fiber flag React sets on every component fiber that actually rendered in a commit.
const PerformedWork = 0b1;
// Far deeper than any real UI; a tree this deep is a runaway recursion in the app. The walk
// recurses once per level inside React's commit, so it stops descending here rather than risk
// the stack.
const MAX_DEPTH = 1000;
// The hot path follows a child carrying at least this share of its parent's work. Over half means
// no sibling carries as much; 60 rather than 50 keeps it from following a child that barely leads.
const HOT_PATH_SHARE = 0.6;
// The hot path names at most this many steps below the component it starts from: enough to reach the
// subtree to blame in a real tree, few enough to read in one line.
const HOT_PATH_STEPS = 12;
// A commit keeps its most-rendered components and its outermost ones up to these counts. A report
// names a culprit; it is not a profile.
const MAX_COMPONENTS = 12;
const MAX_ROOTS = 5;
// DOM nodes climbed to find a fiber, and fibers climbed to find a handler: more than any real nesting
// between an element and the component that handles it.
const MAX_HOPS = 64;
// A minifier leaves one- and two-letter function names, which say nothing about the handler.
const MINIFIED_NAME_LENGTH = 2;
// Longer names that say nothing about the handler either. React Compiler hoists an inline handler to a
// module-level `function _temp()` and compiles `const handleLogin = () => ...` to `t0 = () => ...`,
// whose function is named `t0` or `t12`; Radix's composeEventHandlers (@radix-ui/primitive) wraps
// every handler it composes in a function named `handleEvent`, and lodash's debounce and throttle in one
// named `debounced`.
const NAMELESS_HANDLER = /^(?:t\d+|_temp\d*|handleEvent|debounced)$/;
// A clock that steps in whole milliseconds (Firefox and Safari without cross-origin isolation) makes
// every component's time a whole number. With this many components timed and every time whole, that
// is the clock and not chance: Chromium steps in 0.1 ms, where eight whole values in a row are a
// one-in-10^8 event.
const COARSE_CLOCK_SAMPLES = 8;
// Each reading on such a clock is off by up to a millisecond: a quarter or more of a component that
// averaged under 4 ms, which is where per-component times stop saying anything.
const COARSE_CLOCK_MEAN_MS = 4;
const COMMENT_NODE = 8;
// The comment nodes React's server renderer puts around a boundary's HTML, and the ones that close
// them. React 19's getParentHydrationBoundary counts these exact five openers against these two
// closers: `$` complete, `$?` still streaming, `$!` errored on the server, `$~` queued, and `&` an
// Activity boundary. React 18 emits only the first three and `/$`, which are a subset of these.
const BOUNDARY_STARTS = ['$', '$?', '$!', '$~', '&'];
const BOUNDARY_ENDS = ['/$', '/&'];
// The two fibers React caches on an opening comment and keeps a dehydrated instance on. Activity is
// React 19 only; its state carries `dehydrated` the same way a Suspense boundary's does, which is what
// React's own getActivityInstanceFromFiber reads.
const ActivityComponent = 31;
// The tag of the DehydratedFragment fiber React deletes when it gives up on hydrating a boundary and
// renders it on the client instead. Same value on React 18 and 19.
const DehydratedFragment = 18;
// The fiber flag React sets on a root whose server HTML it threw away to render on the client, so that
// the commit is a client render rather than a hydration. 256 on React 18 and 19.
const ForceClientRender = 0b100000000;
// The fiber flag React sets on the child of a boundary it is hydrating, and clears when that work
// commits. 4096 on React 18 and 19: `var Hydrating = 4096` in react-dom 18.3.1, and in React 19.3 the
// same bit inside the combined literal 134221824 the compiled build writes. React sets it beside the
// hydrating child (`primaryChildFragment.flags |= Hydrating`) and clears it in
// `commitReconciliationEffects`, so it marks exactly the window between a boundary finishing its
// hydration render and that render reaching the screen. React reads it the same way, as
// `Placement | Hydrating` (4098) in `getNearestMountedFiber`, to tell committed from uncommitted.
const Hydrating = 0b1000000000000;

const wholeMs = (ms: number) => Math.abs(ms - Math.round(ms)) < 1e-6;

/**
 * A React fiber, reduced to the fields this library reads. They are React internals, the same
 * from 17 to 19; `rootShapeProblem` checks the root once before the first walk.
 */
export interface Fiber {
  tag: number;
  flags: number;
  /** Mode bits, inherited from the root. */
  mode: number;
  /** The component as written: a function, a class, or the memo or forwardRef object around one. */
  elementType: unknown;
  /** What React renders; differs from `elementType` for memo without a compare function. */
  type: unknown;
  memoizedProps: Record<string, unknown> | null;
  /** Read only to tell hydration: a HostRoot's `isDehydrated`, a Suspense boundary's `dehydrated`. */
  memoizedState: unknown;
  /** Read only on a HostRoot, where it is the FiberRoot, to reach the root's current fiber. */
  stateNode?: unknown;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  /** The same fiber in the other tree: current if this is work in progress, and the reverse. */
  alternate: Fiber | null;
  /** Children React deleted in this commit. Read only to tell a boundary React hydrated from one it gave up on. */
  deletions?: Fiber[] | null;
  /** ms React spent rendering this fiber's subtree in the commit; absent in production builds. */
  actualDuration?: number;
  /**
   * When React began this fiber's work in the render just committed, on performance.now()'s clock; -1
   * where it did not time the fiber (a tree outside ProfileMode), absent in production builds.
   */
  actualStartTime?: number;
  /** The flags of every fiber below this one in the commit, or'ed together. React 18 and 19; React 17 has none. */
  subtreeFlags?: number;
}

/** What React hands the DevTools hook with each commit: the root of the tree it committed. */
export interface FiberRoot {
  /** 0 for a root `ReactDOM.render` made (React 18's legacy mode, which React 19 removed), 1 for `createRoot` or `hydrateRoot`. */
  tag?: number;
  current: Fiber;
  /**
   * The lanes (bits) of updates React has not committed on this root: every update sets its lane, and a
   * commit clears the lanes it finished before React calls the hook. The same field in React 17 to 19.
   */
  pendingLanes: number;
  /** The node the root was created on: the element given to `createRoot`, or the document `hydrateRoot(document)` hydrates. */
  containerInfo?: unknown;
}

/**
 * Whether this root belongs to Next.js's dev tools rather than to the app. Under `next dev` the dev
 * overlay creates a root of its own on a `<nextjs-portal>` element, and from Next.js 15.4.11 and 15.5 it
 * renders there with a production react-dom that Next.js bundles into the overlay, so its commits carry
 * minified names and no durations, and some land inside the app's clicks. Nothing else in Next.js makes
 * that element, and an app has no reason to put a root on it. The renderer says nothing: an app can run
 * a production react-dom too, and under `next dev` the two report the same version.
 */
export function nextDevToolsRoot(root: FiberRoot): boolean {
  const container = root?.containerInfo as { localName?: unknown } | null | undefined;
  return container?.localName === 'nextjs-portal';
}

/**
 * The ProfileMode bit of `fiber.mode`, set on trees whose render durations React measures:
 * 8 on React 17, 2 on 18 and 19, which renumbered the mode flags.
 */
export function profileModeBit(reactMajor: number): number {
  return reactMajor === 17 ? 0b1000 : 0b10;
}

// The flags that make React run a commit's passive phase, and so call `onPostCommitFiberRoot` after
// it: effects to run (Passive), effects to clean up (ChildDeletion) and, from React 19, a hidden or
// revealed Activity or Suspense tree (Visibility). The same bits in React 18 and 19.
const PassiveFlags = 0b100000000000;
const ChildDeletion = 0b10000;
const Visibility = 0b10000000000000;
const LegacyRoot = 0;

/**
 * Whether React will say when this commit's passive effects have run: React 18 or 19, a root made
 * with `createRoot`, and a committed tree whose flags hold passive work. React makes no such call for a
 * commit without it, though it can still run the passive phase for one (every commit it timed, in a
 * React 19 development build). A legacy root runs a click's effects whenever React next renders, maybe
 * inside the same handler, so the time up to its call is not the effects' and it is left out.
 */
export function reportsPassiveEffects(root: FiberRoot, reactMajor: number): boolean {
  if (reactMajor < 18 || root.tag === LegacyRoot) return false;
  const fiber = root.current;
  const passive = PassiveFlags | ChildDeletion | (reactMajor >= 19 ? Visibility : 0);
  return ((fiber.flags | (fiber.subtreeFlags ?? 0)) & passive) !== 0;
}

/**
 * Why a committed root is not one this library can read, or null when it is: `pendingLanes` a number,
 * and `current` a HostRoot with numeric flags and mode, tree links that are fibers or null, and
 * `actualDuration` a number or absent. A React release that changes any of these fails here once,
 * instead of every walk.
 */
export function rootShapeProblem(root: unknown): string | null {
  if (!root || typeof root !== 'object') return 'the root is not an object';
  const { current, pendingLanes } = root as Record<string, unknown>;
  if (typeof pendingLanes !== 'number') return 'root.pendingLanes is not a number';
  if (!current || typeof current !== 'object') return 'root.current is not an object';
  const f = current as Record<string, unknown>;
  if (f.tag !== HostRoot) return `root.current.tag is ${String(f.tag)}, not ${HostRoot} (HostRoot)`;
  for (const key of ['flags', 'mode']) {
    if (typeof f[key] !== 'number') return `root.current.${key} is not a number`;
  }
  for (const key of ['child', 'sibling', 'return', 'alternate']) {
    if (f[key] !== null && typeof f[key] !== 'object') return `root.current.${key} is neither a fiber nor null`;
  }
  if (f.actualDuration !== undefined && typeof f.actualDuration !== 'number') return 'root.current.actualDuration is neither a number nor absent';
  if (f.actualStartTime !== undefined && typeof f.actualStartTime !== 'number') return 'root.current.actualStartTime is neither a number nor absent';
  return null;
}

/** The fiber React stored on this node itself, under the `__reactFiber$<key>` property it caches instances on. */
function fiberOn(node: Node): Fiber | null {
  return expando(node, '__reactFiber$');
}

/**
 * The HostRoot fiber React stored on this node itself. React writes it on the container element when
 * `createRoot` or `hydrateRoot` is called, before anything renders, so it is there on a page whose
 * HTML has not been hydrated yet.
 */
function containerFiberOn(node: Node): Fiber | null {
  return expando(node, '__reactContainer$');
}

/**
 * The last key found for each prefix. React appends one random string per copy of react-dom on the
 * page, so a remembered key is a first guess and not an answer: a node from a second copy misses it
 * and falls back to the scan, which is what the page did on every node before.
 */
const expandoKeys: Record<string, string | undefined> = {};

function expando(node: Node, prefix: string): Fiber | null {
  const o = node as unknown as Record<string, Fiber | undefined>;
  const known = expandoKeys[prefix];
  if (known !== undefined && known in o) return o[known] ?? null;
  for (const k of Object.keys(node)) {
    if (k.charCodeAt(0) === 95 && k.startsWith(prefix)) {
      expandoKeys[prefix] = k;
      return o[k] ?? null;
    }
  }
  return null;
}

/** The fiber React stored on a DOM node, climbing to the nearest ancestor that has one. */
export function fiberFromNode(node: Node | null): Fiber | null {
  let n = node;
  let hops = 0;
  while (n && hops++ < MAX_HOPS) {
    const fiber = fiberOn(n);
    if (fiber) return fiber;
    n = n.parentNode;
  }
  return null;
}

/**
 * Server-rendered HTML React has not hydrated that encloses `node`, or null when React has reached it.
 *
 * Every read here answers one question: what is on the screen now. An `alternate` on its own cannot
 * answer it, because it is the state before a commit only for the fibers React worked on in that
 * commit, and holds a hydration from months of clicks ago otherwise. Where the two trees disagree,
 * `boundaryIsDehydrated` below settles it the way React does, by the flag that says a hydration has
 * rendered but not yet committed.
 *
 * It follows React's `getClosestInstanceFromNode` to a fiber and then climbs. A node React has not
 * reached carries no fiber, and the fiber then comes from the comment opening the boundary around it
 * (`<!--$-->` complete, `<!--$?-->` still streaming, `<!--$!-->` errored, `<!--/$-->` closing), which
 * React caches it on. A fiber *on* the node is not the end of the question: React caches fibers on
 * the nodes of a boundary as it hydrates them, and that hydration can be interrupted and left
 * uncommitted, so the boundary above still has to be asked.
 *
 * Where nothing has a fiber at all, the container element is the only mark React has left: it carries
 * a HostRoot fiber from the moment `hydrateRoot` is called. Before that call there is nothing on the
 * page to read, and nothing is said.
 */
export function dehydratedAround(node: Node | null): HydrationBoundary | null {
  const fiber = closestFiber(node);
  return fiber ? dehydratedAbove(fiber) : containerRootDehydrated(node);
}

/** React's `getClosestInstanceFromNode`: the fiber on the node, or the one on the boundary enclosing it. */
function closestFiber(node: Node | null): Fiber | null {
  let n = node;
  let hops = 0;
  while (n && hops++ < MAX_HOPS) {
    const own = fiberOn(n);
    if (own) return own;
    const opening = openingComment(n);
    const onComment = opening && fiberOn(opening);
    if (onComment) return onComment;
    n = n.parentNode;
  }
  return null;
}

/**
 * The innermost boundary at or above this fiber that still holds server-rendered HTML, or the root
 * when it is the root that is still waiting. Null once React has reached everything above the fiber.
 */
function dehydratedAbove(fiber: Fiber): HydrationBoundary | null {
  let f: Fiber | null = fiber;
  for (let hops = 0; f && hops < MAX_DEPTH; f = f.return, hops++) {
    if (boundaryIsDehydrated(f)) return { scope: 'boundary', owner: ownersOf(f.return, 1)[0] ?? null };
    if (f.tag === HostRoot) return rootFiberIsDehydrated(f) ? { scope: 'root', owner: null } : null;
  }
  return null;
}

/** The root of the tree this node is in, when nothing in it has a fiber yet. */
function containerRootDehydrated(node: Node | null): HydrationBoundary | null {
  let n = node;
  let hops = 0;
  while (n && hops++ < MAX_HOPS) {
    const container = containerFiberOn(n);
    if (container) return rootFiberIsDehydrated(container) ? { scope: 'root', owner: null } : null;
    n = n.parentNode;
  }
  return null;
}

/**
 * Whether a root is still server-rendered HTML, asked of a HostRoot fiber.
 *
 * Read through `stateNode`, the FiberRoot, to the root's *current* fiber, because the fiber React
 * writes on a container is the one `createFiberRoot` made: it becomes the alternate on the first
 * commit and goes on saying `isDehydrated: true` for as long as it lives. React's own
 * `findInstanceBlockingTarget` reads exactly that on React 19, and `isRootDehydrated` on React 18.
 */
function rootFiberIsDehydrated(f: Fiber): boolean {
  const current = (f.stateNode as { current?: Fiber } | null | undefined)?.current ?? f;
  return (current.memoizedState as { isDehydrated?: unknown } | null | undefined)?.isDehydrated === true;
}

/** A Suspense or Activity state that still holds a server-rendered instance. */
const holdsServerHtml = (state: unknown) => (state as { dehydrated?: unknown } | null | undefined)?.dehydrated != null;

/**
 * Whether the boundary a fiber stands for still holds server-rendered HTML.
 *
 * The two trees can disagree, and which of them is on the screen is the whole question. React nulls a
 * boundary's state in `completeDehydratedSuspenseBoundary` ("This boundary did not suspend so it's now
 * hydrated and unsuspended"), which runs at the end of the *render*. A time-sliced pass can finish one
 * boundary and still be rendering the next, so for that window one tree says hydrated and the other
 * says server HTML, and the page is still showing the server's. The same split is left behind for good
 * once a boundary has committed, because the old fiber keeps its dehydrated state for as long as it
 * lives, and a subtree React bails out of never gets a fresh one.
 *
 * The flag React itself uses tells the two apart. `Hydrating` sits on the hydrating side's child from
 * the render until `commitReconciliationEffects` clears it in the commit, so it is set exactly while
 * that work has not reached the screen. React's `getNearestMountedFiber` asks the same question the
 * same way. Where both trees agree, or there is only one, there is nothing to tell apart.
 */
function boundaryIsDehydrated(f: Fiber): boolean {
  if (f.tag !== SuspenseComponent && f.tag !== ActivityComponent) return false;
  const own = holdsServerHtml(f.memoizedState);
  if (f.alternate === null) return own;
  const other = holdsServerHtml(f.alternate.memoizedState);
  if (own === other) return own;
  const hydratedSide = own ? f.alternate : f;
  return ((hydratedSide.child?.flags ?? 0) & Hydrating) !== 0;
}

/**
 * The comment node opening the boundary `node` sits directly inside, found by walking back over its
 * siblings and counting the boundaries that close and open on the way. React's own
 * `getParentHydrationBoundary` does exactly this, over the same markers.
 */
function openingComment(node: Node): Node | null {
  let depth = 0;
  for (let n = node.previousSibling; n; n = n.previousSibling) {
    if (n.nodeType !== COMMENT_NODE) continue;
    const data = (n as Comment).data;
    if (BOUNDARY_ENDS.indexOf(data) >= 0) depth++;
    else if (BOUNDARY_STARTS.indexOf(data) >= 0) {
      if (depth === 0) return n;
      depth--;
    }
  }
  return null;
}

/**
 * The server-rendered HTML an input landed on, once React has hydrated it, or null while it is still
 * waiting. `waited` is what `dehydratedAround` said about the target when the input was recorded, and
 * the answer is that same boundary or nothing: this only decides *when* the wait ended.
 *
 * It is the same question `dehydratedAround` answered when the input was recorded, asked again now
 * that the commit has landed. Asking the page again is the point: a verdict read from the fiber tree
 * alone would call every later click on that part of the page a hydration, because a boundary that
 * hydrated long ago keeps a dehydrated alternate until a render passes through its parent.
 */
export function hydratedSince(target: Node | null, waited: HydrationBoundary | null): HydrationBoundary | null {
  if (waited === null || target === null) return null;
  // React threw the server HTML away and rendered the boundary on the client instead: it removed the
  // nodes it had rendered from, the target among them. Nothing was hydrated, so nothing is said.
  if (target.isConnected === false) return null;
  // Still waiting: this commit is not the one that ended it.
  if (dehydratedAround(target) !== null) return null;
  // React caches a fiber on every node it hydrates, so a target it reached has one at or above it.
  if (fiberFromNode(target) === null) return null;
  return waited;
}

function isComponent(f: Fiber): boolean {
  const t = f.tag;
  return t === FunctionComponent || t === ClassComponent || t === ForwardRef || t === MemoComponent || t === SimpleMemoComponent;
}

function componentName(f: Fiber): string | null {
  // memo(fn) without a compare function is a SimpleMemoComponent: fiber.type is the inner
  // function (anonymous once minified) while the memo object, which carries displayName,
  // sits on elementType. Prefer elementType, fall back to type.
  return typeName(f.elementType) || typeName(f.type);
}

function typeName(t: unknown): string | null {
  if (typeof t === 'function') return (t as { displayName?: string }).displayName || t.name || null;
  if (t && typeof t === 'object') {
    const o = t as { displayName?: unknown; render?: unknown; type?: unknown };
    if (typeof o.displayName === 'string') return o.displayName;
    if (o.render) return typeName(o.render); // forwardRef
    if (o.type) return typeName(o.type); // memo
  }
  return null;
}

/**
 * A component fiber's name. memo(fn, compare), memo(forwardRef(...)) and memo(Class) are two fibers: a
 * MemoComponent, and below it the component it renders, both flagged as having rendered. They are one
 * component, named after the wrapper, which is where displayName is stamped and what the minifier
 * cannot rename.
 */
function nameOf(f: Fiber): string | null {
  // Read once: every fiber the walk names comes through here.
  const type = f.elementType;
  const wrapper = f.return !== null && f.return.tag === MemoComponent ? componentName(f.return) : null;
  return stylingName(f, type) || wrapper || typeName(type) || typeName(f.type);
}

// The prop @emotion/react's jsx gives the component it renders for an element with a `css` prop, holding
// the element's own type. A string key, so a minifier leaves it as it is.
const EMOTION_CSS_PROP_TYPE = '__EMOTION_TYPE_PLEASE_DO_NOT_USE__';

/**
 * The name a styling library's wrapper goes by, whatever label it was given: `Styled(button)` for one that
 * @emotion/styled or @emotion/react's `css` prop made, `styled.li` or `Styled(Card)` for styled-components,
 * as each names its own when it has no label. MUI labels every root it styles (`MuiButtonBaseRoot`) in
 * development, which would otherwise read as a component the app wrote. Told by the fiber rather than the
 * name, a wrapper reads the same in development and production. Null for any other fiber.
 */
function stylingName(f: Fiber, elementType: unknown): string | null {
  const t = elementType as { __emotion_base?: unknown; styledComponentId?: unknown; target?: unknown } | null;
  if (t !== null && typeof t === 'object') {
    if ('__emotion_base' in t) return `Styled(${baseName(t.__emotion_base)})`;
    if (typeof t.styledComponentId === 'string') return typeof t.target === 'string' ? `styled.${t.target}` : `Styled(${baseName(t.target)})`;
  }
  const cssProp = isComponent(f) ? f.memoizedProps?.[EMOTION_CSS_PROP_TYPE] : undefined;
  return cssProp === undefined ? null : `Styled(${baseName(cssProp)})`;
}

/** The tag or component a styling wrapper wraps, by name. */
function baseName(base: unknown): string {
  return typeof base === 'string' ? base : (typeName(base) ?? 'Component');
}

/**
 * emotion's `Insertion`: the component @emotion/styled and @emotion/react's `css` prop render first, beside
 * the element they style, to insert the styles. It is the library's, and a minifier renames it, so it is
 * told by its place, not its name.
 */
function emotionInsertion(f: Fiber): boolean {
  const styled = f.return;
  if (styled === null || f.sibling === null || (styled.child !== f && styled.child !== f.alternate)) return false;
  return isEmotionStyled(styled.elementType) || (isComponent(styled) && styled.memoizedProps?.[EMOTION_CSS_PROP_TYPE] !== undefined);
}

/** A component @emotion/styled made: it carries the tag or component it wraps as `__emotion_base`. */
function isEmotionStyled(t: unknown): boolean {
  return t !== null && typeof t === 'object' && '__emotion_base' in (t as object);
}

/**
 * A MemoComponent is counted as the component it renders, never as a component of its own, and emotion's
 * `Insertion` not at all, since it is not a component the app wrote.
 */
const countsAsComponent = (f: Fiber) => f.tag !== MemoComponent && isComponent(f) && !emotionInsertion(f);

// How many fibers above an icon are climbed looking for what it belongs to.
const ICON_CLIMB = 16;
// The props that make an element what a click lands on, whatever its tag: a thumbnail `<img onClick>`, a
// `<div onClick>` around an icon.
const INPUT_HANDLERS = ['onClick', 'onDoubleClick', 'onPointerDown', 'onPointerUp', 'onMouseDown', 'onMouseUp', 'onTouchStart', 'onTouchEnd', 'onKeyDown', 'onKeyUp'];

/**
 * The fiber a report reads the components that name an interaction from. For a click on an icon, the icon
 * library's components are not what anyone clicked: from the icon's own fiber this climbs through every
 * fiber that renders nothing but it (lucide's `Icon`, then `Trash2`, then a `<span>` around them), and stops
 * at a control (the `<button>` they are in), at an element with a handler of its own (a thumbnail's
 * `<img onClick>`, which names the component that renders it), or at the first fiber that renders
 * something beside them. A handler the icon got from the components that render nothing but it is the one
 * that wrote it's: `<Trash2 onClick>` passes onClick through Trash2 and Icon to the `<svg>`, and names the
 * component that wrote `<Trash2 onClick>`. A
 * `DeleteButton`'s trash icon is then named by `DeleteButton`, an option's person icon by the option's
 * component, and a card's photo or its row of stars by the card or the stars, as the fiber tree has them.
 * Anything that is not an icon is named from its own fiber.
 */
export function namingFiber(node: Node | null): Fiber | null {
  const icon = node && iconAround(node);
  const start = icon && fiberFromNode(icon);
  if (!start) return fiberFromNode(node);
  let f = start;
  const handled = handlesInput(start);
  // An icon with a handler is climbed through the components that handed it down even where it is a control
  // itself: `<Trash2 role="button" onClick>` is the writer's too.
  for (let i = 0; i < ICON_CLIMB && (handled || (!isControlHost(f) && !handlesInput(f))); i++) {
    const parent = f.return;
    const only = parent && onlyChild(parent);
    if (!only || (only !== f && only !== f.alternate)) break;
    // With a handler on the icon, only the components that handed it down are climbed.
    if (handled && !(isComponent(parent) && handsDown(parent, start))) break;
    f = parent;
  }
  // A component at the top of the climb renders nothing but the icon, so it is the icon's own: the one it
  // sits in names the click.
  return isComponent(f) ? (f.return ?? f) : f;
}

/** A parent's one child, emotion's `Insertion` beside it aside; null when it has none or several. */
function onlyChild(parent: Fiber): Fiber | null {
  let child = parent.child;
  if (child && emotionInsertion(child)) child = child.sibling;
  return child && child.sibling === null ? child : null;
}

function isControlHost(f: Fiber): boolean {
  const el = f.stateNode as Element | null | undefined;
  return f.tag === HostComponent && !!el && typeof el.getAttribute === 'function' && isControl(el);
}

function handlesInput(f: Fiber): boolean {
  const props = f.tag === HostComponent ? f.memoizedProps : null;
  return !!props && INPUT_HANDLERS.some((name) => typeof props[name] === 'function');
}

/** Whether a component was given the handler an element below it has, under the same prop. */
function handsDown(component: Fiber, element: Fiber): boolean {
  const own = element.memoizedProps;
  const given = component.memoizedProps;
  return !!own && !!given && INPUT_HANDLERS.some((name) => typeof own[name] === 'function' && given[name] === own[name]);
}

/**
 * The components enclosing a fiber, nearest first. They follow the tree React rendered the fiber in,
 * which is not React's owner chain: a button that Page passes into Card as children is in Card.
 */
export function ownersOf(fiber: Fiber | null, limit = 8): string[] {
  const out: string[] = [];
  for (let f = fiber; f && out.length < limit; f = f.return) {
    if (!countsAsComponent(f)) continue;
    const name = nameOf(f);
    if (name) out.push(name);
  }
  return out;
}

/**
 * The React props a native event can reach, in the order React would run them, nearest prop on the
 * chain first. React's own plugins decide this: SimpleEventPlugin maps a native event to the prop of
 * the same name (`click` to `onClick`, `submit` to `onSubmit`), and ChangeEventPlugin adds `onChange`
 * on top for form controls, from a different native event per control (see `firesChange`).
 *
 * Only the event's own prop is unconditional. Everything else React dispatches from this event rather
 * than for it is added by `propsFor`, and only where React really would: `onChange` on a form control,
 * `onSubmit` on Enter. The rule for the whole table is that a fallback which is sometimes right is
 * worse than nothing, because a named handler reads as a fact.
 *
 * `mousedown` and `mouseup` are not here. The ring records pointer events (`INPUT_TYPES` in hook.ts)
 * and Event Timing names the pointer ones, so a mouse event never reaches this table; an app that
 * wrote `onMouseDown` is still named, from the `pointerdown` row's fallback.
 */
const handlerProp: Record<string, readonly string[]> = {
  click: ['onClick', 'onSubmit'],
  pointerdown: ['onPointerDown', 'onMouseDown'],
  pointerup: ['onPointerUp', 'onMouseUp'],
  keydown: ['onKeyDown'],
  keyup: ['onKeyUp'],
  keypress: ['onKeyPress'],
  input: ['onChange', 'onInput'],
  change: ['onChange'],
  submit: ['onSubmit'],
};

// What a key event can reach besides its own prop, and the click on a toggle that React turns into an
// onChange. Both are added by `propsFor` only where React would fire them.
const TYPING = ['onChange', 'onInput'];
const CLICK_ON_TOGGLE = ['onClick', 'onChange', 'onSubmit'];
// `KeyboardEvent.code` for the two Enter keys, and `key` for both, since the ring stores the code and
// a caller with the event in hand may pass either.
const ENTER_KEYS = ['Enter', 'NumpadEnter'];

// The `type` values React treats as a text field, so that typing in one fires onChange: react-dom's
// `supportedInputTypes`, which `isTextInputElement` reads.
const TEXT_INPUT_TYPES = ['color', 'date', 'datetime-local', 'email', 'month', 'number', 'password', 'range', 'search', 'tel', 'text', 'time', 'url', 'week'];
const TOGGLE_INPUT_TYPES = ['checkbox', 'radio'];

/**
 * Whether React's ChangeEventPlugin turns this native event on this element into an `onChange`.
 * Taken from its `extractEvents` in react-dom 19.3.0 (`cjs/react-dom-client.development.js`, the
 * branch around `getTargetInstForClickEvent`), which picks the native event per control:
 *
 * - `select`, and `input type="file"`: `change`.
 * - a text field (`textarea`, or an `input` whose type is in `supportedInputTypes`): `input`, and
 *   `change` where the browser has no input event.
 * - `input type="checkbox"` and `type="radio"`: **`click`**, which is why a ticked checkbox used to
 *   report no handler at all. React reads the checked state after the click and fires onChange if it
 *   moved, so the click is the event and `onChange` is the prop.
 *
 * A click on a label's own text is forwarded by the browser to the control the label wraps, and React
 * fires onChange from that forwarded click, so `handlerOf` finishes the walk at that control.
 */
function firesChange(fiber: Fiber | null, eventType: string): boolean {
  const host = nearestHost(fiber);
  if (!host) return false;
  const tag = typeof host.type === 'string' ? host.type : '';
  const props = host.memoizedProps;
  const type = typeof props?.type === 'string' ? props.type.toLowerCase() : 'text';
  if (tag === 'select' || (tag === 'input' && type === 'file')) return eventType === 'change';
  if (tag === 'textarea' || (tag === 'input' && TEXT_INPUT_TYPES.includes(type))) return eventType === 'input' || eventType === 'change';
  if (tag === 'input' && TOGGLE_INPUT_TYPES.includes(type)) return eventType === 'click';
  return false;
}

/** The DOM element the event landed on, as a fiber: a host fiber has its tag name as `type`. */
function nearestHost(fiber: Fiber | null): Fiber | null {
  let f = fiber;
  let hops = 0;
  while (f && hops++ < MAX_HOPS) {
    if (typeof f.type === 'string') return f;
    f = f.return;
  }
  return null;
}

/** Whether React turns any native event on this element into an `onChange`: it is a form control. */
function isFormControl(fiber: Fiber | null): boolean {
  return firesChange(fiber, 'input') || firesChange(fiber, 'change') || firesChange(fiber, 'click');
}

/**
 * Whether this key press submits the form it is in, so that `onSubmit` is a handler it really reaches.
 * That is implicit submission: Enter in a field or on a button. In a textarea Enter is a newline, and
 * on anything that is not a control it is nothing at all, so a keystroke there reaches no onSubmit.
 * An unknown key is treated as not Enter: most keys are not, and a wrong name is worse than no name.
 */
function submitsOnEnter(fiber: Fiber | null, key: string | null | undefined): boolean {
  if (!key || !ENTER_KEYS.includes(key)) return false;
  const host = nearestHost(fiber);
  const tag = typeof host?.type === 'string' ? host.type : '';
  if (tag !== 'input' && tag !== 'button') return false;
  const type = typeof host?.memoizedProps?.type === 'string' ? host.memoizedProps.type.toLowerCase() : '';
  return type !== 'button' && type !== 'reset';
}

/**
 * The props this event can reach on `fiber`'s chain: its own prop always, plus the ones React
 * dispatches from it on this particular element. `key` is the `code` or `key` of a key event, and
 * decides whether `onSubmit` is among them.
 */
function propsFor(fiber: Fiber | null, eventType: string, key: string | null | undefined): readonly string[] | undefined {
  const base = handlerProp[eventType];
  if (!base) return undefined;
  if (eventType === 'keydown' || eventType === 'keyup' || eventType === 'keypress') {
    const props = base.slice();
    // A keystroke fires onChange only in something React watches for changes; on a div it fires none.
    if (isFormControl(fiber)) props.push(...TYPING);
    if (eventType !== 'keyup' && submitsOnEnter(fiber, key)) props.push('onSubmit');
    return props;
  }
  if (base.includes('onChange') || !firesChange(fiber, eventType)) return base;
  // Only `click` gets here, from a checkbox or a radio. onChange goes after the click's own prop and
  // ahead of the form fallback, so a control with an onClick is still named by it.
  return CLICK_ON_TOGGLE;
}

// Fibers looked at inside a label to find the control its click is forwarded to. A label holds a
// control and a few words; anything larger is not what this is for.
const MAX_LABEL_FIBERS = 64;
// The elements a browser never forwards a label's click past: a click that lands on one of these, or
// inside one, activates it and nothing else. `label` is in the list so that the inner label of two
// nested ones wins, which is also what the browser does.
const INTERACTIVE = ['input', 'select', 'textarea', 'button', 'a', 'label'];

/**
 * The label whose click is forwarded to a control, starting from where the click landed, or null.
 *
 * A click on a label's own text is forwarded by the browser to the control the label labels, and every
 * handler React fires is then that control's. A click on interactive content inside the label is not
 * forwarded at all: an anchor, a button or a second control keeps the click, which is why the walk
 * stops at the first of those. A label with no control in it, or one whose control is elsewhere on the
 * page through `htmlFor`, has nothing to forward to and the ordinary walk up is the whole answer.
 */
function forwardingLabel(fiber: Fiber | null, eventType: string): Fiber | null {
  if (eventType !== 'click') return null;
  let f = fiber;
  let hops = 0;
  while (f && hops++ < MAX_HOPS) {
    if (typeof f.type === 'string' && INTERACTIVE.includes(f.type)) return f.type === 'label' ? f : null;
    f = f.return;
  }
  return null;
}

/** The control a label's click is forwarded to: the first form control in its subtree, or null. */
function labelledControl(label: Fiber): Fiber | null {
  const stack: Fiber[] = label.child ? [label.child] : [];
  let seen = 0;
  while (stack.length && seen++ < MAX_LABEL_FIBERS) {
    const node = stack.pop() as Fiber;
    if (node.type === 'input' || node.type === 'select' || node.type === 'textarea') return node;
    if (node.sibling) stack.push(node.sibling);
    if (node.child) stack.push(node.child);
  }
  return null;
}

/**
 * What a handler is called in a report: its own name, less the `bound ` a bound function carries, or the
 * prop it was passed as when its name says nothing (see MINIFIED_NAME_LENGTH and NAMELESS_HANDLER).
 */
function handlerName(fn: Function, key: string): string {
  const name = ((fn as { displayName?: string }).displayName || fn.name || '').replace(/^(?:bound )+/, '');
  return name.length > MINIFIED_NAME_LENGTH && !NAMELESS_HANDLER.test(name) ? name : key;
}

/** The first of `props` set on `fiber` or an ancestor, as a name. `stop` is the last fiber looked at. */
function firstHandler(fiber: Fiber | null, props: readonly string[], stop: Fiber | null): string | null {
  let f = fiber;
  let hops = 0;
  while (f && hops++ < MAX_HOPS) {
    const p = f.memoizedProps;
    if (p) {
      for (const key of props) {
        const fn = p[key];
        if (typeof fn === 'function') return handlerName(fn, key);
      }
    }
    if (f === stop) return null;
    f = f.return;
  }
  return null;
}

/**
 * Name of the first React handler prop for this event type on the chain from a fiber up. `key` is the
 * `code` or `key` of a key event where the caller has it; without it a key press reaches no onSubmit,
 * since there is no way to tell Enter from any other key.
 */
export function handlerOf(fiber: Fiber | null, eventType: string, key?: string | null): string | null {
  const props = propsFor(fiber, eventType, key);
  if (!props) return null;
  const label = forwardingLabel(fiber, eventType);
  if (label) {
    // Anything at or below the label handles the click itself; only when nothing there does is the
    // click the browser's to forward.
    const own = firstHandler(fiber, props, label);
    if (own) return own;
    const control = labelledControl(label);
    if (control) return firstHandler(control, propsFor(control, eventType, key) ?? props, null);
  }
  return firstHandler(fiber, props, null);
}

/** What the walk needs besides the fiber tree: what React passed with the commit, how its build marks measured trees, and where the input landed. */
export interface CommitContext {
  /** `profileModeBit` for the renderer's React major. */
  profileMode: number;
  priority: number | undefined;
  didError: boolean;
  /**
   * The server-rendered HTML the input landed on that this commit hydrated, from `hydratedSince`.
   * Decided from the DOM beside the input rather than from the tree, and passed in, so that a
   * boundary hydrating elsewhere on the page is never taken for the one the input waited on.
   */
  hydratedTarget: HydrationBoundary | null;
}

interface Agg {
  name: string;
  performed: boolean;
  rendered: number;
  total: number;
  kids: Agg[];
  /** The walk ran out of budget inside this subtree, so `rendered` and `kids` hold only what it reached first. */
  cut: boolean;
  /** The fiber it was read from. */
  fiber: Fiber;
}

/** A component's figures while the walk adds them up. */
interface Tally {
  name: string;
  count: number;
  self: number;
  total: number;
}

/** A commit as its walk reads it: everything but the time the walk took, which only the caller can measure. */
export type CommitWalk = Omit<CommitSummary, 'walkMs' | 'joinedBy'>;

/**
 * A HostRoot whose previous state was server-rendered HTML waiting to hydrate, which React 18 and 19
 * mark `isDehydrated` on the root's `memoizedState`. `ForceClientRender` says React threw that HTML
 * away and rendered the root on the client instead, which is not a hydration; React's own
 * `commitPassiveMountOnFiber` reads the same two.
 *
 * React 17 has neither: it keeps a plain `hydrate` boolean on the FiberRoot and clears it during the
 * mutation phase, before the hook is called, so there is nothing left to read. Hydration is therefore
 * never reported on React 17.
 */
function hydratesRoot(root: Fiber): boolean {
  const before = root.alternate?.memoizedState as { isDehydrated?: unknown } | null | undefined;
  return before?.isDehydrated === true && (root.flags & ForceClientRender) === 0;
}

/**
 * A Suspense or Activity boundary whose server-rendered content hydrated in this commit: dehydrated
 * before it, not after, which is React 19's own `isHydratingParent`. A boundary React gave up on
 * instead, rendering it on the client, ends the commit the same way, and is told apart by the
 * `DehydratedFragment` child it deleted on the way, the discriminator React 19 uses itself.
 *
 * `alternate` is only the state before the commit for a fiber React worked on in it, and the walk
 * asks this of no other: it stops descending at a fiber whose child list its alternate still shares,
 * so a fiber it reaches is one React either rendered or cloned, and either way gave a fresh alternate.
 */
function hydratesBoundary(f: Fiber): boolean {
  if ((f.tag !== SuspenseComponent && f.tag !== ActivityComponent) || f.alternate === null) return false;
  if (!holdsServerHtml(f.alternate.memoizedState) || holdsServerHtml(f.memoizedState)) return false;
  return f.deletions?.[0]?.tag !== DehydratedFragment;
}

/**
 * Summarise one commit from the fiber tree after it became current.
 * A fiber whose alternate still points at the same child list bailed out, so nothing
 * under it rendered and its subtree is stale: that is the prune.
 * `budget` caps the component fibers visited; DOM and text fibers do not count against it.
 * The lists in the summary are frozen, like the commit the caller makes of it.
 */
export function walkCommit(rootFiber: Fiber, budget: number, at: number, input: InputStamp, context: CommitContext): CommitWalk {
  let componentsVisited = 0;
  let outOfBudget = false;
  let truncated = false;
  let measured = 0;
  const byName = new Map<string, Tally>();
  let rendered = 0;
  // Rendered components with a time, and whether any time had a fraction of a millisecond.
  let timed = 0;
  let fractional = false;
  // A root hydrating is known from the root; a Suspense boundary hydrating, only by finding it.
  let hydrated = hydratesRoot(rootFiber);
  const { hydratedTarget } = context;

  function visit(f: Fiber, depth: number): Agg[] {
    const comp = countsAsComponent(f);
    // Host and text fibers are most of any tree, and counting them cut every root-level update
    // short on a page of 5000 DOM nodes. They cost the walk no more than they cost React: a
    // subtree React did not re-render is pruned below, so the walk only follows React's own work.
    if (comp && ++componentsVisited > budget) {
      outOfBudget = true;
      truncated = true;
      return [];
    }
    hydrated ||= hydratesBoundary(f);
    const bailedOut = f.alternate !== null && f.alternate.child === f.child;
    const performed = comp && (f.flags & PerformedWork) !== 0;
    let kids: Agg[] = [];
    if (!bailedOut && f.child !== null) {
      if (depth >= MAX_DEPTH) {
        truncated = true;
      } else {
        for (let c: Fiber | null = f.child; c !== null && !outOfBudget; c = c.sibling) {
          const r = visit(c, depth + 1);
          if (!r.length) continue;
          // Appended in place: copying the list for every child would make a wide list quadratic,
          // inside React's commit. Nothing else holds an array a visit returns.
          if (kids.length) for (const a of r) kids.push(a);
          else kids = r;
        }
      }
    }
    if (!performed) {
      // A component that did not render itself but carries rendered descendants stays on the
      // path by name, so the hot path can say "the OrderSummary subtree".
      if (comp && kids.length) {
        const name = nameOf(f) || '(anonymous)';
        return [{ name, performed: false, rendered: kids.reduce((a, k) => a + k.rendered, 0), total: f.actualDuration || 0, kids, cut: outOfBudget, fiber: f }];
      }
      return kids;
    }
    rendered++;
    const name = nameOf(f) || '(anonymous)';
    const total = f.actualDuration || 0;
    if (total > 0) {
      timed++;
      fractional ||= !wholeMs(total);
    }
    let childSum = 0;
    if (!bailedOut) {
      let c = f.child;
      while (c !== null) {
        childSum += c.actualDuration || 0;
        c = c.sibling;
      }
    }
    const self = Math.max(0, total - childSum);
    measured += self;
    const entry = byName.get(name);
    if (entry) {
      entry.count++;
      entry.self += self;
      entry.total = Math.max(entry.total, total);
    } else {
      byName.set(name, { name, count: 1, self, total });
    }
    return [{ name, performed: true, rendered: 1 + kids.reduce((a, k) => a + k.rendered, 0), total, kids, cut: outOfBudget, fiber: f }];
  }

  const top = visit(rootFiber, 0);

  // Ancestors that were only cloned on the way down (App, layouts, providers) are not
  // roots. The roots are the outermost components that performed work.
  const performedRoots: Agg[] = [];
  (function collect(list: Agg[]) {
    for (const a of list) {
      if (a.performed) performedRoots.push(a);
      else collect(a.kids);
    }
  })(top);
  const renderTime = performedRoots.reduce((a, t) => a + t.total, 0);

  // React measures the trees in ProfileMode. A subtree under <Profiler> is measured even when
  // its root is not, and shows up as nonzero time.
  const hasDurations = (rootFiber.mode & context.profileMode) !== 0 || measured > 0;
  const coarseClock = hasDurations && timed >= COARSE_CLOCK_SAMPLES && !fractional && renderTime / rendered < COARSE_CLOCK_MEAN_MS;
  const metric = (a: Agg) => (hasDurations ? a.total : a.rendered);

  // Hot path: from the heaviest root, keep descending while one child carries most of
  // the work. Pass-through components inside a rendered subtree are named on the way.
  //
  // Without durations the path goes by how many components each subtree rendered, and a walk cut at its
  // budget has counted the subtrees it reached first in full and the rest in part or not at all. Choosing
  // among those would follow the walk's order, not the work, so the path stops at a subtree the cut was
  // in. Where it reached several roots, or one with rendered work beside it that the walk never reached,
  // the counts cannot choose a root: the one counted first can be the smaller. The path then names the
  // component they all sit under, or nothing. React's durations are totals for each subtree, walked or not,
  // so they still choose.
  const comparable = (a: Agg) => hasDurations || !a.cut;
  const hotPath: string[] = [];
  const onlyRoot = performedRoots.length === 1 ? performedRoots[0]! : null;
  if (!hasDurations && outOfBudget && !(onlyRoot && !unreachedBeside(onlyRoot.fiber, rootFiber))) {
    const shared = sharedAncestor(top);
    if (shared) hotPath.push(shared);
  } else if (performedRoots.length) {
    let cur = performedRoots.reduce((a, b) => (metric(b) > metric(a) ? b : a));
    hotPath.push(cur.name);
    for (let step = 0; cur.kids.length && comparable(cur) && step < HOT_PATH_STEPS; step++) {
      const next = cur.kids.reduce((a, b) => (metric(b) > metric(a) ? b : a));
      if (metric(next) < HOT_PATH_SHARE * metric(cur)) break;
      if (next.name !== cur.name) hotPath.push(next.name);
      cur = next;
    }
  }

  // Summed over a whole commit, readings of a coarse clock come out close; one component's do not.
  const perComponentTimes = hasDurations && !coarseClock;
  const components = [...byName.values()]
    .sort((a, b) => (perComponentTimes ? b.self - a.self : b.count - a.count))
    .slice(0, MAX_COMPONENTS)
    .map((c): RenderedComponent => Object.freeze({ name: c.name, count: c.count, self: perComponentTimes ? c.self : null, total: perComponentTimes ? c.total : null }));

  return {
    at,
    sinceInput: at - input.ts,
    inputTs: input.ts,
    gestureTs: input.gestureTs,
    inputType: input.type,
    rendered,
    hydrated: hydrated || hydratedTarget != null,
    hydratedTarget: hydratedTarget && Object.freeze(hydratedTarget),
    truncated,
    roots: Object.freeze(dedupe(performedRoots.map((a) => a.name)).slice(0, MAX_ROOTS)),
    hotPath: Object.freeze(hotPath),
    components: Object.freeze(components),
    hasDurations,
    coarseClock,
    total: hasDurations ? renderTime : 0,
    startedAt: renderStartOf(rootFiber, at),
    effectsStartedAt: null,
    effectsEndedAt: null,
    priority: context.priority,
    didError: context.didError,
  };
}

/**
 * The innermost component above every root of a walk, from the components the walk passed through without
 * their rendering (App, a layout, a provider): followed down while there is exactly one, and never into a
 * rendered one. Null when the roots share none.
 */
/**
 * Whether anything after `f` in the tree, beside it or beside any fiber above it up to the root, rendered in
 * this commit: the work a walk cut short inside `f` never reached. A fiber whose children are its previous
 * render's did not.
 */
function unreachedBeside(f: Fiber, root: Fiber): boolean {
  for (let at: Fiber | null = f; at && at !== root; at = at.return) {
    for (let s = at.sibling; s; s = s.sibling) if (!(s.alternate !== null && s.alternate.child === s.child)) return true;
  }
  return false;
}

function sharedAncestor(top: Agg[]): string | null {
  let name: string | null = null;
  let list = top;
  while (list.length === 1 && !list[0]!.performed) {
    name = list[0]!.name;
    list = list[0]!.kids;
  }
  return name;
}

/**
 * When React began the render this commit came from: the root fiber's `actualStartTime`, which React
 * sets from the same clock as performance.now() when it starts the root's work. Only a development or
 * profiling build keeps it, and only for a tree in ProfileMode. Anything that cannot be the start of
 * this commit's render, unset or later than the commit's end, is null rather than a guess.
 */
function renderStartOf(rootFiber: Fiber, at: number): number | null {
  const t = rootFiber.actualStartTime;
  return typeof t === 'number' && t >= 0 && t <= at ? t : null;
}

function dedupe(xs: string[]): string[] {
  return xs.filter((x, i) => xs.indexOf(x) === i);
}
