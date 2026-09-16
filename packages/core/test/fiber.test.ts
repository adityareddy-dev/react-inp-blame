import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handlerOf, ownersOf, rootShapeProblem, walkCommit } from '../src/fiber.ts';

// The HostRoot fiber React 17, 18 and 19 hand the hook as `root.current`, in a development build.
const hostRoot = (): Record<string, unknown> => ({ tag: 3, flags: 0, mode: 3, child: null, sibling: null, return: null, alternate: null, actualDuration: 1.5 });

/** What React hands the hook with a commit: the root, holding the tree it committed and the lanes still pending. */
const committed = (current: unknown) => ({ current, pendingLanes: 0 });

function without(key: string): Record<string, unknown> {
  const fiber = hostRoot();
  delete fiber[key];
  return fiber;
}

const click = { ts: 90, type: 'click', gestureTs: 90 };
const development = { profileMode: 0b10, priority: 1, didError: false };

/** A fiber of a freshly mounted tree, linked to its children. Tag 0 is a function component that rendered, 5 a DOM element, 6 a text node. */
function fiber(tag: number, type: unknown, children: Record<string, unknown>[] = [], flags = tag === 0 ? 1 : 0): Record<string, unknown> {
  const f: Record<string, unknown> = { tag, flags, mode: 0, elementType: type, type, memoizedProps: null, memoizedState: null, return: null, child: children[0] ?? null, sibling: null, alternate: null };
  children.forEach((child, i) => {
    child.return = f;
    child.sibling = children[i + 1] ?? null;
  });
  return f;
}
const root = (...children: Record<string, unknown>[]) => fiber(3, null, children);
const rendered = (component: () => void, ...children: Record<string, unknown>[]) => fiber(0, component, children);
const element = (tag: string, ...children: Record<string, unknown>[]) => fiber(5, tag, children);
const text = () => fiber(6, null);

test('the shape check accepts the root React hands the hook, with or without durations', () => {
  assert.equal(rootShapeProblem(committed(hostRoot())), null);
  // Production builds have no actualDuration field at all.
  assert.equal(rootShapeProblem(committed(without('actualDuration'))), null);
});

test('the shape check names the first field that is not what the walk reads', () => {
  const cases: Array<[string, unknown, string]> = [
    ['no root at all', undefined, 'the root is not an object'],
    ['pending work kept some other way', { current: hostRoot() }, 'root.pendingLanes is not a number'],
    ['no fiber at all', committed(undefined), 'root.current is not an object'],
    ['a component fiber instead of the root', committed({ ...hostRoot(), tag: 0 }), 'root.current.tag is 0, not 3 (HostRoot)'],
    ['React 16 called the flags effectTag', committed({ ...without('flags'), effectTag: 0 }), 'root.current.flags is not a number'],
    ['a tree link that went missing', committed(without('alternate')), 'root.current.alternate is neither a fiber nor null'],
    ['durations stored some other way', committed({ ...hostRoot(), actualDuration: '1.5' }), 'root.current.actualDuration is neither a number nor absent'],
  ];
  for (const [why, root, problem] of cases) assert.equal(rootShapeProblem(root), problem, why);
});

test('only component fibers count against the walk budget, not the DOM and text fibers under them', () => {
  function List() {}
  function Row() {}
  // One List and four Rows, each Row an <li> with its text: 5 components among 15 fibers.
  const list = () => root(rendered(List, element('ul', ...Array.from({ length: 4 }, () => rendered(Row, element('li', text()))))));

  const whole = walkCommit(list() as any, 5, 100, click, development);
  assert.equal(whole.truncated, false);
  assert.equal(whole.rendered, 5);

  const cut = walkCommit(list() as any, 4, 100, click, development);
  assert.equal(cut.truncated, true);
  assert.deepEqual(
    cut.components.map((c) => `${c.name} ×${c.count}`),
    ['Row ×3', 'List ×1'],
  );
});

test('a tree deeper than the walk follows is cut off there, without overflowing the stack', () => {
  function Runaway() {}
  function Footer() {}
  // 20,000 nested <div>s with a component at the bottom, and a component beside the outermost one.
  let nested = element('div', rendered(Runaway));
  for (let i = 0; i < 20_000; i++) nested = element('div', nested);

  const c = walkCommit(root(nested, rendered(Footer)) as any, 5000, 100, click, development);
  assert.equal(c.truncated, true);
  // Only the branch that went too deep is cut: the component beside it is still counted.
  assert.deepEqual(
    c.components.map((x) => x.name),
    ['Footer'],
  );
});

test('a memo wrapper and the component it renders count once, named after the wrapper', () => {
  // memo(fn, compare), memo(forwardRef(...)) and memo(Class) leave a MemoComponent fiber (tag 14) above the
  // component it renders (0, 11 or 1), and React flags both as rendered. displayName is stamped on the
  // wrapper; the minifier has renamed the function inside it.
  function List() {}
  const minifiedFunction = () => Object.defineProperty(function () {}, 'name', { value: 'l' });
  const shapes: Array<[name: string, innerTag: number, inner: unknown]> = [
    ['CmpRow', 0, minifiedFunction()],
    ['FwdRow', 11, { render: minifiedFunction() }],
    ['ClassRow', 1, minifiedFunction()],
  ];
  const rows = shapes.flatMap(([name, innerTag, inner]) => {
    const wrapper = { type: inner, displayName: name };
    return [1, 2].map(() => fiber(14, wrapper, [fiber(innerTag, inner, [element('li', text())], 1)], 1));
  });
  const c = walkCommit(root(rendered(List, element('ul', ...rows))) as any, 5000, 100, click, development);
  assert.equal(c.rendered, 7);
  assert.deepEqual(c.components.map((x) => `${x.name} ×${x.count}`).sort(), ['ClassRow ×2', 'CmpRow ×2', 'FwdRow ×2', 'List ×1']);

  // From inside a row outwards, the row is named once.
  const li = (rows[0]?.child as Record<string, unknown>).child;
  assert.deepEqual(ownersOf(li as any), ['CmpRow', 'List']);
});

test('a commit that hydrates a root or a Suspense boundary says so', () => {
  function Item() {}
  // React 18 and 19 mark a root's state isDehydrated until the commit that hydrates it.
  const hydratingRoot = root(rendered(Item));
  hydratingRoot.alternate = { tag: 3, child: null, memoizedState: { isDehydrated: true } };
  assert.equal(walkCommit(hydratingRoot as any, 5000, 100, click, development).hydrated, true);

  // A Suspense boundary (tag 13) keeps its server-rendered HTML as `dehydrated` until its code has run.
  const boundary = fiber(13, null, [rendered(Item)]);
  boundary.alternate = { tag: 13, child: null, memoizedState: { dehydrated: {} } };
  assert.equal(walkCommit(root(boundary) as any, 5000, 100, click, development).hydrated, true);
  // In any later commit its previous state was hydrated already.
  boundary.alternate = { tag: 13, child: null, memoizedState: null };
  assert.equal(walkCommit(root(boundary) as any, 5000, 100, click, development).hydrated, false);
});

test('a handler is named by its function, or by its prop when the minifier left the function one or two letters', () => {
  function handleSave() {}
  const minified = Object.defineProperty(() => {}, 'name', { value: 'l' });
  const button = (onClick: unknown) => ({ ...fiber(5, 'button'), memoizedProps: { onClick } });
  assert.equal(handlerOf(button(handleSave) as any, 'click'), 'handleSave');
  assert.equal(handlerOf(button(minified) as any, 'click'), 'onClick');
});

test('outside ProfileMode a development tree reports render counts, not a 0 ms render', () => {
  // Development builds give every fiber actualDuration = 0 and only measure trees in ProfileMode.
  function Row() {}
  const row = { tag: 0, flags: 1, mode: 1, elementType: Row, type: Row, memoizedProps: null, memoizedState: null, return: null, child: null, sibling: null, alternate: null, actualDuration: 0 };
  const root = { tag: 3, flags: 0, mode: 1, elementType: null, type: null, memoizedProps: null, memoizedState: null, return: null, child: row, sibling: null, alternate: null, actualDuration: 0 };
  const c = walkCommit(root, 5000, 100, click, { profileMode: 0b10, priority: 1, didError: false });
  assert.equal(c.hasDurations, false);
  assert.equal(c.total, 0);
  assert.deepEqual(c.components, [{ name: 'Row', count: 1, self: null, total: null }]);
});

/** A rendered component React timed at `ms` for itself, in ProfileMode as on React 18 and 19. */
function timed(component: () => void, ms: number, ...children: Record<string, unknown>[]): Record<string, unknown> {
  const f = rendered(component, ...children);
  f.mode = 0b10;
  f.actualDuration = children.reduce((a, child) => a + (child.actualDuration as number), ms);
  return f;
}
const profiledRoot = (child: Record<string, unknown>) => Object.assign(root(child), { mode: 0b10, actualDuration: child.actualDuration });

test('a clock in whole milliseconds that timed quick components keeps the commit total and drops the per-component times', () => {
  // Firefox and Safari step performance.now() by 1 ms without cross-origin isolation: a component that
  // works for a fraction of a millisecond reads 0 or 1 ms there, so no single time says anything,
  // while a sum over many of them still comes out close.
  function OrderSummary() {}
  function LineItem() {}
  const tree = profiledRoot(timed(OrderSummary, 1, ...Array.from({ length: 12 }, () => timed(LineItem, 1))));
  const c = walkCommit(tree as any, 5000, 100, click, development);
  assert.equal(c.coarseClock, true);
  assert.equal(c.hasDurations, true);
  assert.equal(c.total, 13);
  assert.deepEqual(c.components, [
    { name: 'LineItem', count: 12, self: null, total: null },
    { name: 'OrderSummary', count: 1, self: null, total: null },
  ]);
});

test('whole milliseconds long enough to mean something keep their per-component times, and so does a clock in tenths', () => {
  function Chart() {}
  function Series() {}
  const slow = walkCommit(profiledRoot(timed(Chart, 20, ...Array.from({ length: 12 }, () => timed(Series, 20)))) as any, 5000, 100, click, development);
  assert.equal(slow.coarseClock, false);
  assert.equal(slow.total, 260);
  assert.deepEqual(slow.components[0], { name: 'Series', count: 12, self: 240, total: 20 });
  // Chromium's clock steps in 0.1 ms.
  const quick = walkCommit(profiledRoot(timed(Chart, 0.1, ...Array.from({ length: 12 }, () => timed(Series, 0.1)))) as any, 5000, 100, click, development);
  assert.equal(quick.coarseClock, false);
  assert.equal(quick.components[0]?.name, 'Series');
  assert.notEqual(quick.components[0]?.self, null);
});

test('time React measured under a root outside ProfileMode still counts, as under <Profiler>', () => {
  // <Profiler> puts its own subtree in ProfileMode whatever the root's mode.
  function Chart() {}
  const chart = { tag: 0, flags: 1, mode: 0b10, elementType: Chart, type: Chart, memoizedProps: null, memoizedState: null, return: null, child: null, sibling: null, alternate: null, actualDuration: 12 };
  const profiler = { tag: 12, flags: 0, mode: 0b10, elementType: null, type: null, memoizedProps: null, memoizedState: null, return: null, child: chart, sibling: null, alternate: null, actualDuration: 12 };
  const root = { tag: 3, flags: 0, mode: 0, elementType: null, type: null, memoizedProps: null, memoizedState: null, return: null, child: profiler, sibling: null, alternate: null, actualDuration: 0 };
  const c = walkCommit(root, 5000, 100, click, { profileMode: 0b10, priority: undefined, didError: false });
  assert.equal(c.hasDurations, true);
  assert.equal(c.total, 12);
  assert.deepEqual(c.components, [{ name: 'Chart', count: 1, self: 12, total: 12 }]);
});
