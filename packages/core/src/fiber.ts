import type { CommitSummary, InputStamp, RenderedComponent } from './types.ts';

// React work tags, stable across 17, 18 and 19.
const FunctionComponent = 0;
const ClassComponent = 1;
const HostRoot = 3;
const ForwardRef = 11;
const MemoComponent = 14;
const SimpleMemoComponent = 15;
// Fiber flag React sets on every component fiber that actually rendered in a commit.
const PerformedWork = 0b1;

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
export function fiberFromNode(node: any): Fiber | null {
  let n = node;
  let hops = 0;
  while (n && hops++ < 64) {
    const keys = Object.keys(n);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.charCodeAt(0) === 95 && k.startsWith('__reactFiber$')) return n[k];
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
export function ownerChain(node: any, limit = 8): string[] {
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
export function handlerName(node: any, eventType: string): string | null {
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

/**
 * Summarise one commit from the fiber tree after it became current.
 * A fiber whose alternate still points at the same child list bailed out, so nothing
 * under it rendered and its subtree is stale: that is the prune.
 */
export function walkCommit(rootFiber: Fiber, budget: number, at: number, input: InputStamp, context: CommitContext): CommitSummary {
  let visited = 0;
  let truncated = false;
  let measured = 0;
  const byName = new Map<string, RenderedComponent>();
  let rendered = 0;

  function visit(f: Fiber): Agg[] {
    if (++visited > budget) {
      truncated = true;
      return [];
    }
    const bailedOut = f.alternate !== null && f.alternate.child === f.child;
    const comp = isComponent(f);
    const performed = comp && (f.flags & PerformedWork) !== 0;
    let kids: Agg[] = [];
    if (!bailedOut) {
      let c = f.child;
      while (c !== null) {
        const r = visit(c);
        if (r.length) kids = kids.length ? kids.concat(r) : r;
        if (truncated) break;
        c = c.sibling;
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
      entry.self = (entry.self as number) + self;
      entry.total = Math.max(entry.total as number, total);
    } else {
      byName.set(name, { name, count: 1, self, total });
    }
    return [{ name, performed: true, rendered: 1 + kids.reduce((a, k) => a + k.rendered, 0), total, kids }];
  }

  const top = visit(rootFiber);
  // React measures the trees in ProfileMode. A subtree under <Profiler> is measured even when
  // its root is not, and shows up as nonzero time.
  const hasDurations = (rootFiber.mode & context.profileMode) !== 0 || measured > 0;
  const metric = (a: Agg) => (hasDurations ? a.total : a.rendered);

  // Ancestors that were only cloned on the way down (App, layouts, providers) are not
  // roots. The roots are the outermost components that performed work.
  const performedRoots: Agg[] = [];
  (function collect(list: Agg[]) {
    for (const a of list) {
      if (a.performed) performedRoots.push(a);
      else collect(a.kids);
    }
  })(top);

  // Hot path: from the heaviest root, keep descending while one child carries most of
  // the work. Pass-through components inside a rendered subtree are named on the way.
  const hotPath: string[] = [];
  if (performedRoots.length) {
    let cur = performedRoots.reduce((a, b) => (metric(b) > metric(a) ? b : a));
    hotPath.push(cur.name);
    let depth = 0;
    while (cur.kids.length && depth++ < 12) {
      const next = cur.kids.reduce((a, b) => (metric(b) > metric(a) ? b : a));
      if (metric(next) < 0.6 * metric(cur)) break;
      if (next.name !== cur.name) hotPath.push(next.name);
      cur = next;
    }
  }

  const components = [...byName.values()]
    .map((c) => (hasDurations ? c : { ...c, self: null, total: null }))
    .sort((a, b) => (hasDurations ? (b.self || 0) - (a.self || 0) : b.count - a.count));

  return {
    at,
    sinceInput: at - input.ts,
    inputTs: input.ts,
    gestureTs: input.gestureTs,
    inputType: input.type,
    rendered,
    truncated,
    roots: dedupe(performedRoots.map((a) => a.name)).slice(0, 5),
    hotPath,
    components: components.slice(0, 12),
    hasDurations,
    total: hasDurations ? performedRoots.reduce((a, t) => a + t.total, 0) : 0,
    walkMs: 0,
    priority: context.priority,
    didError: context.didError,
  };
}

function dedupe(xs: string[]): string[] {
  return xs.filter((x, i) => xs.indexOf(x) === i);
}
