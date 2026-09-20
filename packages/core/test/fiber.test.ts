import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dehydratedAround, handlerOf, hydratedSince, ownersOf, rootShapeProblem, walkCommit } from '../src/fiber.ts';

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
const development = { profileMode: 0b10, priority: 1, didError: false, hydratedTarget: null };

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

/** A DOM node React has hydrated: it caches the fiber on the node under a key of its own making. */
const node = (fiber: unknown, parentNode: unknown = null) => ({ __reactFiber$k7: fiber, parentNode });
/** A boundary fiber whose server-rendered HTML React had not hydrated before this commit. */
const wasDehydrated = (f: Record<string, unknown>) => Object.assign(f, { alternate: { tag: f.tag, child: null, memoizedState: { dehydrated: {} } } });

test('a commit that hydrates a root or a boundary says so', () => {
  function Item() {}
  // React 18 and 19 mark a root's state isDehydrated until the commit that hydrates it.
  const hydratingRoot = root(rendered(Item));
  hydratingRoot.alternate = { tag: 3, child: null, memoizedState: { isDehydrated: true } };
  assert.equal(walkCommit(hydratingRoot as any, 5000, 100, click, development).hydrated, true);

  // A Suspense boundary (tag 13) keeps its server-rendered HTML as `dehydrated` until its code has run.
  const boundary = wasDehydrated(fiber(13, null, [rendered(Item)]));
  assert.equal(walkCommit(root(boundary) as any, 5000, 100, click, development).hydrated, true);
  // In any later commit its previous state was hydrated already.
  boundary.alternate = { tag: 13, child: null, memoizedState: null };
  assert.equal(walkCommit(root(boundary) as any, 5000, 100, click, development).hydrated, false);

  // An Activity boundary (tag 31, React 19) carries the same dehydrated state and is read the same way.
  const activity = wasDehydrated(fiber(31, null, [rendered(Item)]));
  assert.equal(walkCommit(root(activity) as any, 5000, 100, click, development).hydrated, true);
});

test('a boundary that hydrated long ago keeps a dehydrated alternate, and the walk never reaches it', () => {
  function App() {}
  function Section() {}
  function Panel() {}
  // What React leaves behind: the boundary's own fiber says hydrated, the alternate from the render
  // that hydrated it still says dehydrated, and it stays that way until a render passes through the
  // parent. On the fiber alone this is the same shape as a boundary hydrating right now.
  const stale = wasDehydrated(fiber(13, null, [rendered(Panel)]));
  const section = rendered(Section, stale);
  const app = rendered(App, section);
  const tree = root(app);

  // A commit that re-rendered App's subtree does reach it, and cannot tell the two apart. React only
  // ever asks this of a fiber it worked on in the commit, and so does the walk.
  assert.equal(walkCommit(tree as any, 5000, 100, click, development).hydrated, true);

  // A commit that rendered elsewhere bails out at Section, whose alternate still shares its child
  // list, and stops. The stale boundary below is never looked at.
  section.alternate = { tag: 0, child: section.child, memoizedState: null };
  assert.equal(walkCommit(tree as any, 5000, 100, click, development).hydrated, false);
});

test('a boundary React gave up on and rendered on the client is not called a hydration', () => {
  function Panel() {}
  // React deletes the boundary's DehydratedFragment child (tag 18) when it throws the server HTML
  // away, and ends the commit with the same memoizedState a real hydration ends with.
  const boundary = wasDehydrated(fiber(13, null, [rendered(Panel)]));
  boundary.deletions = [{ tag: 18 }];
  assert.equal(walkCommit(root(boundary) as any, 5000, 100, click, development).hydrated, false);

  // The same on a root, which React marks with ForceClientRender (256) instead.
  const clientRendered = root(rendered(Panel));
  clientRendered.flags = 0b100000000;
  clientRendered.alternate = { tag: 3, child: null, memoizedState: { isDehydrated: true } };
  assert.equal(walkCommit(clientRendered as any, 5000, 100, click, development).hydrated, false);
});

test('React 17 has no dehydrated state to read, so nothing on it is reported as a hydration', () => {
  function Item() {}
  // React 17 keeps a plain `hydrate` boolean on the FiberRoot, not on the fiber, and clears it in the
  // mutation phase before it calls the hook; its Suspense state never carries a dehydrated instance.
  const boundary = fiber(13, null, [rendered(Item)]);
  boundary.alternate = { tag: 13, child: null, memoizedState: { dehydrated: null, retryLane: 0 } };
  const tree = root(boundary);
  tree.alternate = { tag: 3, child: null, memoizedState: { element: null } };

  const c = walkCommit(tree as any, 5000, 100, click, { ...development, profileMode: 0b1000 });
  assert.equal(c.hydrated, false);
  assert.equal(c.hydratedTarget, null);
});

/** A comment node React's server renderer left around a boundary. */
const comment = (data: string) => ({ nodeType: 8, data, previousSibling: null as unknown, parentNode: null as unknown });
/** Lays out siblings in document order and puts them inside `parent`. */
const inside = (parent: Record<string, unknown>, ...siblings: Record<string, unknown>[]) => {
  siblings.forEach((s, i) => Object.assign(s, { previousSibling: siblings[i - 1] ?? null, parentNode: parent }));
  return parent;
};
/**
 * A container element as React marks it: the fiber `createFiberRoot` made, which is the alternate
 * after the first commit and says `isDehydrated: true` for as long as it lives, and the FiberRoot
 * on its `stateNode`, whose `current` fiber is the one that answers the question.
 */
const container = (isDehydrated: boolean) => ({
  nodeType: 1,
  parentNode: null,
  __reactContainer$k7: { tag: 3, memoizedState: { element: null, isDehydrated: true }, stateNode: { current: { tag: 3, memoizedState: { element: null, isDehydrated } } } },
});

test('server-rendered HTML waiting to hydrate is found from the element an input landed on', () => {
  function ProductPage() {}
  // A boundary React has not hydrated: its fiber is cached on the opening comment, and the HTML
  // between the comments carries no fiber at all.
  const page = rendered(ProductPage);
  const boundaryFiber = Object.assign(fiber(13, null), { memoizedState: { dehydrated: {} }, return: page });
  const open = Object.assign(comment('$'), { __reactFiber$k7: boundaryFiber });
  const button = { nodeType: 1, previousSibling: null as unknown, parentNode: null as unknown };
  const waiting = inside({ nodeType: 1, parentNode: null }, open as any, button as any, comment('/$') as any);

  assert.deepEqual(dehydratedAround(button as any), { scope: 'boundary', owner: 'ProductPage' });
  // Once React has hydrated it, the element carries a fiber and nothing is waiting.
  assert.equal(dehydratedAround(node(page, waiting) as any), null);

  // An Activity boundary uses `&` and `/&`, which the sibling walk has to count too: without them the
  // depth is wrong and the boundary above is handed back for a node that is not inside it.
  const activityFiber = Object.assign(fiber(31, null), { memoizedState: { dehydrated: {} }, return: page });
  const outside = { nodeType: 1, previousSibling: null as unknown, parentNode: null as unknown };
  inside({ nodeType: 1, parentNode: null }, comment('&') as any, Object.assign(comment('/&'), { __reactFiber$k7: activityFiber }) as any, outside as any);
  assert.equal(dehydratedAround(outside as any), null);

  // A whole root still waiting: React writes a HostRoot fiber on the container when hydrateRoot is
  // called, long before anything under it has a fiber.
  const untouched = (parentNode: unknown) => ({ nodeType: 1, previousSibling: null, parentNode });
  assert.deepEqual(dehydratedAround(untouched(container(true)) as any), { scope: 'root', owner: null });
  assert.equal(dehydratedAround(untouched(container(false)) as any), null);
  // React 17's root state is just the element: nothing there says anything about hydration.
  assert.equal(dehydratedAround(untouched({ __reactContainer$k7: { tag: 3, memoizedState: { element: null } }, parentNode: null }) as any), null);
});

test('a fiber on the element does not mean React has finished with it: the boundary above still decides', () => {
  function PanelSection() {}
  // React caches a fiber on each node of a boundary as it hydrates it, during the render and before
  // the commit, and that render can be interrupted. React 19 hydrates a boundary the server revealed
  // late on a low-priority render, which is exactly the one that gets interrupted, so the button
  // inside it carries a fiber while the boundary still holds the server's HTML.
  const section = rendered(PanelSection);
  const boundary = Object.assign(fiber(13, null), { memoizedState: { dehydrated: {} }, alternate: { tag: 13, child: null, memoizedState: { dehydrated: {} } }, return: section });
  const button = fiber(5, 'button');
  button.return = boundary;
  assert.deepEqual(dehydratedAround(node(button) as any), { scope: 'boundary', owner: 'PanelSection' });

  // Once the boundary has hydrated, the same element says nothing.
  boundary.memoizedState = null;
  assert.equal(dehydratedAround(node(button) as any), null);
});

test('a boundary that hydrated long ago is not reported as waiting, however stale the fiber on its comment', () => {
  function ProductPage() {}
  // The fiber cached on the opening comment can be either tree's, and the one from the render that
  // hydrated the boundary keeps its dehydrated state. One tree calling it hydrated settles it.
  const page = rendered(ProductPage);
  const hydrated = Object.assign(fiber(13, null), { memoizedState: null, alternate: { tag: 13, child: null, memoizedState: { dehydrated: {} } }, return: page });
  const open = Object.assign(comment('$'), { __reactFiber$k7: hydrated });
  // A node the app added inside the boundary, which React never rendered and so never gave a fiber.
  const stray = { nodeType: 1, previousSibling: null as unknown, parentNode: null as unknown };
  inside({ nodeType: 1, parentNode: null }, open as any, stray as any, comment('/$') as any);
  assert.equal(dehydratedAround(stray as any), null);

  // The same the other way round: the comment holds the dehydrated tree's fiber, whose alternate is
  // the hydrated one.
  const other = Object.assign(fiber(13, null), { memoizedState: { dehydrated: {} }, alternate: { tag: 13, child: null, memoizedState: null }, return: page });
  Object.assign(open, { __reactFiber$k7: other });
  assert.equal(dehydratedAround(stray as any), null);
});

test('a boundary that has finished hydrating but not committed is still server-rendered HTML', () => {
  function SectionA() {}
  // Two boundaries hydrating in one time-sliced pass: this one finished, so React nulled its state in
  // completeWork, while the other is still rendering and nothing has committed. The page is still
  // showing the server's HTML. React marks the difference with `Hydrating` on the hydrating side's
  // child, 4096, and clears it in commitReconciliationEffects.
  const page = rendered(SectionA);
  const uncommitted = Object.assign(fiber(13, null), {
    memoizedState: null,
    child: fiber(22, null, [], 0b1000000000000),
    alternate: { tag: 13, child: null, memoizedState: { dehydrated: {} } },
    return: page,
  });
  const open = Object.assign(comment('$'), { __reactFiber$k7: uncommitted });
  const button = { nodeType: 1, previousSibling: null as unknown, parentNode: null as unknown };
  inside({ nodeType: 1, parentNode: null }, open as any, button as any, comment('/$') as any);
  assert.deepEqual(dehydratedAround(button as any), { scope: 'boundary', owner: 'SectionA' });

  // Asked the other way round, of the fiber that still holds the server HTML, the answer is the same.
  const dehydratedSide = Object.assign(fiber(13, null), { memoizedState: { dehydrated: {} }, alternate: uncommitted, return: page });
  Object.assign(open, { __reactFiber$k7: dehydratedSide });
  assert.deepEqual(dehydratedAround(button as any), { scope: 'boundary', owner: 'SectionA' });

  // The commit clears the flag, and the same pair of fibers now says the page has been hydrated.
  (uncommitted.child as Record<string, unknown>).flags = 0;
  assert.equal(dehydratedAround(button as any), null);
  Object.assign(open, { __reactFiber$k7: uncommitted });
  assert.equal(dehydratedAround(button as any), null);
});

test('the commit that ended an input\'s wait is the one the DOM says ended it, not the one a fiber says', () => {
  function ProductPage() {}
  const page = rendered(ProductPage);
  const waited = { scope: 'boundary', owner: 'ProductPage' } as const;

  // Still waiting: the target is inside a boundary whose comment still holds a dehydrated fiber.
  const open = Object.assign(comment('$'), { __reactFiber$k7: Object.assign(fiber(13, null), { memoizedState: { dehydrated: {} }, return: page }) });
  const button = { nodeType: 1, previousSibling: null as unknown, parentNode: null as unknown };
  inside({ nodeType: 1, parentNode: null }, open as any, button as any, comment('/$') as any);
  assert.equal(hydratedSince(button as any, waited), null);

  // React reached it: the boundary's comment says hydrated and the element carries a fiber of its own.
  Object.assign(open, { __reactFiber$k7: Object.assign(fiber(13, null), { memoizedState: null, return: page }) });
  Object.assign(button, { __reactFiber$k7: page });
  assert.deepEqual(hydratedSince(button as any, waited), waited);

  // An input that landed on HTML React had already reached has no wait to end.
  assert.equal(hydratedSince(button as any, null), null);

  // React threw the server HTML away and rendered the boundary on the client: it took the target out
  // of the document on the way, so nothing was hydrated and nothing is said.
  assert.equal(hydratedSince({ ...button, isConnected: false } as any, waited), null);

  // The markers are gone but React never reached the element either: no fiber at or above it.
  const orphan = { nodeType: 1, previousSibling: null, parentNode: null };
  assert.equal(hydratedSince(orphan as any, waited), null);
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
  const c = walkCommit(root, 5000, 100, click, { ...development, priority: 1 });
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
  const c = walkCommit(root, 5000, 100, click, { ...development, priority: undefined });
  assert.equal(c.hasDurations, true);
  assert.equal(c.total, 12);
  assert.deepEqual(c.components, [{ name: 'Chart', count: 1, self: 12, total: 12 }]);
});
