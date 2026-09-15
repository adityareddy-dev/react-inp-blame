import type { CommitSummary, RenderedComponent } from './types';

// React work tags, stable across 17, 18 and 19.
const FunctionComponent = 0;
const ClassComponent = 1;
const ForwardRef = 11;
const MemoComponent = 14;
const SimpleMemoComponent = 15;
// Fiber flag React sets on every component fiber that actually rendered in a commit.
const PerformedWork = 0b1;

export type Fiber = any;

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

function typeName(t: any): string | null {
  if (!t) return null;
  if (typeof t === 'function') return t.displayName || t.name || null;
  if (typeof t === 'object') {
    if (typeof t.displayName === 'string') return t.displayName;
    if (t.render) return typeName(t.render); // forwardRef
    if (t.type) return typeName(t.type); // memo
  }
  return null;
}

/** Component names from the node outwards, nearest first. */
export function ownerChain(node: any, limit = 8): string[] {
  const out: string[] = [];
  let f = fiberFromNode(node);
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
  const props = handlerProp[eventType];
  if (!props) return null;
  let f = fiberFromNode(node);
  let hops = 0;
  while (f && hops++ < 64) {
    const p = f.memoizedProps;
    if (p) {
      for (const key of props) {
        const fn = p[key];
        if (typeof fn === 'function') {
          const name = fn.displayName || fn.name || '';
          // A minified name ("l") says nothing; the prop name at least says which handler.
          return name.length > 2 ? name : key;
        }
      }
    }
    f = f.return;
  }
  return null;
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
export function walkCommit(rootFiber: Fiber, budget: number, at: number, sinceInput: number): CommitSummary {
  let visited = 0;
  let truncated = false;
  const hasDurations = typeof rootFiber.actualDuration === 'number';
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
        const total = hasDurations ? f.actualDuration || 0 : 0;
        return [{ name, performed: false, rendered: kids.reduce((a, k) => a + k.rendered, 0), total, kids }];
      }
      return kids;
    }
    rendered++;
    const name = componentName(f) || '(anonymous)';
    let total = 0;
    let self = 0;
    if (hasDurations) {
      total = f.actualDuration || 0;
      let childSum = 0;
      if (!bailedOut) {
        let c = f.child;
        while (c !== null) {
          childSum += c.actualDuration || 0;
          c = c.sibling;
        }
      }
      self = Math.max(0, total - childSum);
    }
    const entry = byName.get(name);
    if (entry) {
      entry.count++;
      if (hasDurations) {
        entry.self = (entry.self || 0) + self;
        entry.total = Math.max(entry.total || 0, total);
      }
    } else {
      byName.set(name, { name, count: 1, self: hasDurations ? self : null, total: hasDurations ? total : null });
    }
    return [{ name, performed: true, rendered: 1 + kids.reduce((a, k) => a + k.rendered, 0), total, kids }];
  }

  const top = visit(rootFiber);
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

  const components = [...byName.values()].sort((a, b) =>
    hasDurations ? (b.self || 0) - (a.self || 0) : b.count - a.count,
  );

  return {
    at,
    sinceInput,
    rendered,
    truncated,
    roots: dedupe(performedRoots.map((a) => a.name)).slice(0, 5),
    hotPath,
    components: components.slice(0, 12),
    hasDurations,
    total: hasDurations ? performedRoots.reduce((a, t) => a + t.total, 0) : 0,
    walkMs: 0,
  };
}

function dedupe(xs: string[]): string[] {
  return xs.filter((x, i) => xs.indexOf(x) === i);
}
