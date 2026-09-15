import type { CommitSummary, InputStamp, RenderedComponent } from './types.js';

// React work tags, stable across 17, 18 and 19.
const FunctionComponent = 0;
const ClassComponent = 1;
const HostRoot = 3;
const ForwardRef = 11;
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
// A clock that steps in whole milliseconds (Firefox and Safari without cross-origin isolation) makes
// every component's time a whole number. With this many components timed and every time whole, that
// is the clock and not chance: Chromium steps in 0.1 ms, where eight whole values in a row are a
// one-in-10^8 event.
const COARSE_CLOCK_SAMPLES = 8;
// Each reading on such a clock is off by up to a millisecond: a quarter or more of a component that
// averaged under 4 ms, which is where per-component times stop saying anything.
const COARSE_CLOCK_MEAN_MS = 4;

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
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  /** The same fiber in the other tree: current if this is work in progress, and the reverse. */
  alternate: Fiber | null;
  /** ms React spent rendering this fiber's subtree in the commit; absent in production builds. */
  actualDuration?: number;
}

/**
 * The ProfileMode bit of `fiber.mode`, set on trees whose render durations React measures:
 * 8 on React 17, 2 on 18 and 19, which renumbered the mode flags.
 */
export function profileModeBit(reactMajor: number): number {
  return reactMajor === 17 ? 0b1000 : 0b10;
}

/**
 * Why `root.current` is not a fiber this library can walk, or null when it is: a HostRoot with
 * numeric flags and mode, tree links that are fibers or null, and `actualDuration` a number or
 * absent. A React release that changes any of these fails here once, instead of every walk.
 */
export function rootShapeProblem(current: unknown): string | null {
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
  return null;
}

/** The fiber React stored on a DOM node, climbing to the nearest ancestor that has one. */
export function fiberFromNode(node: Node | null): Fiber | null {
  let n = node;
  let hops = 0;
  while (n && hops++ < 64) {
    const keys = Object.keys(n);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.charCodeAt(0) === 95 && k.startsWith('__reactFiber$')) return (n as unknown as Record<string, Fiber>)[k];
    }
    n = n.parentNode;
  }
  return null;
}

export function isComponent(f: Fiber): boolean {
  const t = f.tag;
  return t === FunctionComponent || t === ClassComponent || t === ForwardRef || t === MemoComponent || t === SimpleMemoComponent;
}

export function componentName(f: Fiber): string | null {
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

/** Component names from the node outwards, nearest first. */
export function ownerChain(node: Node | null, limit = 8): string[] {
  return ownersOf(fiberFromNode(node), limit);
}

/** Component names from a fiber outwards, nearest first. */
export function ownersOf(fiber: Fiber | null, limit = 8): string[] {
  const out: string[] = [];
  let f = fiber;
  while (f && out.length < limit) {
    if (isComponent(f)) {
      const n = componentName(f);
      if (n) out.push(n);
    }
    f = f.return;
  }
  return out;
}

const handlerProp: Record<string, string[]> = {
  click: ['onClick', 'onSubmit'],
  pointerdown: ['onPointerDown', 'onMouseDown'],
  pointerup: ['onPointerUp', 'onMouseUp'],
  mousedown: ['onMouseDown'],
  mouseup: ['onMouseUp'],
  keydown: ['onKeyDown', 'onChange', 'onInput'],
  keyup: ['onKeyUp', 'onChange', 'onInput'],
  keypress: ['onKeyPress', 'onChange', 'onInput'],
  input: ['onChange', 'onInput'],
  change: ['onChange'],
};

/** Name of the first React handler prop for this event type on the target chain. */
export function handlerName(node: Node | null, eventType: string): string | null {
  return handlerOf(fiberFromNode(node), eventType);
}

/** Same, starting from a fiber. */
export function handlerOf(fiber: Fiber | null, eventType: string): string | null {
  const props = handlerProp[eventType];
  if (!props) return null;
  let f = fiber;
  let hops = 0;
  while (f && hops++ < 64) {
    const p = f.memoizedProps;
    if (p) {
      for (const key of props) {
        const fn = p[key];
        if (typeof fn === 'function') {
          const name = (fn as { displayName?: string }).displayName || fn.name || '';
          // A minified name ("l") says nothing; the prop name at least says which handler.
          return name.length > 2 ? name : key;
        }
      }
    }
    f = f.return;
  }
  return null;
}

/** What React passed with a commit besides the root, and how its build marks measured trees. */
export interface CommitContext {
  /** `profileModeBit` for the renderer's React major. */
  profileMode: number;
  priority: number | undefined;
  didError: boolean;
}

interface Agg {
  name: string;
  performed: boolean;
  rendered: number;
  total: number;
  kids: Agg[];
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

  function visit(f: Fiber, depth: number): Agg[] {
    const comp = isComponent(f);
    // Host and text fibers are most of any tree, and counting them cut every root-level update
    // short on a page of 5000 DOM nodes. They cost the walk no more than they cost React: a
    // subtree React did not re-render is pruned below, so the walk only follows React's own work.
    if (comp && ++componentsVisited > budget) {
      outOfBudget = true;
      truncated = true;
      return [];
    }
    const bailedOut = f.alternate !== null && f.alternate.child === f.child;
    const performed = comp && (f.flags & PerformedWork) !== 0;
    let kids: Agg[] = [];
    if (!bailedOut && f.child !== null) {
      if (depth >= MAX_DEPTH) {
        truncated = true;
      } else {
        for (let c: Fiber | null = f.child; c !== null && !outOfBudget; c = c.sibling) {
          const r = visit(c, depth + 1);
          if (r.length) kids = kids.length ? kids.concat(r) : r;
        }
      }
    }
    if (!performed) {
      // A component that did not render itself but carries rendered descendants stays on the
      // path by name, so the hot path can say "the OrderSummary subtree".
      if (comp && kids.length) {
        const name = componentName(f) || '(anonymous)';
        return [{ name, performed: false, rendered: kids.reduce((a, k) => a + k.rendered, 0), total: f.actualDuration || 0, kids }];
      }
      return kids;
    }
    rendered++;
    const name = componentName(f) || '(anonymous)';
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
    return [{ name, performed: true, rendered: 1 + kids.reduce((a, k) => a + k.rendered, 0), total, kids }];
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
  const hotPath: string[] = [];
  if (performedRoots.length) {
    let cur = performedRoots.reduce((a, b) => (metric(b) > metric(a) ? b : a));
    hotPath.push(cur.name);
    let depth = 0;
    while (cur.kids.length && depth++ < 12) {
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
    .slice(0, 12)
    .map((c): RenderedComponent => Object.freeze({ name: c.name, count: c.count, self: perComponentTimes ? c.self : null, total: perComponentTimes ? c.total : null }));

  return {
    at,
    sinceInput: at - input.ts,
    inputTs: input.ts,
    gestureTs: input.gestureTs,
    inputType: input.type,
    rendered,
    truncated,
    roots: Object.freeze(dedupe(performedRoots.map((a) => a.name)).slice(0, 5)),
    hotPath: Object.freeze(hotPath),
    components: Object.freeze(components),
    hasDurations,
    coarseClock,
    total: hasDurations ? renderTime : 0,
    priority: context.priority,
    didError: context.didError,
  };
}

function dedupe(xs: string[]): string[] {
  return xs.filter((x, i) => xs.indexOf(x) === i);
}
