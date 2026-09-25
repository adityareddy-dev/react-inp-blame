import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dehydratedAround, handlerOf, hydratedSince, nextDevToolsRoot, ownersOf, rootShapeProblem, walkCommit, type FiberRoot } from '../src/fiber.ts';

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
    ['a render start stored some other way', committed({ ...hostRoot(), actualStartTime: '40' }), 'root.current.actualStartTime is neither a number nor absent'],
  ];
  for (const [why, root, problem] of cases) assert.equal(rootShapeProblem(root), problem, why);
});

test("a root on Next.js's nextjs-portal element is its dev tools', and a root anywhere else is the app's", () => {
  const on = (containerInfo: unknown) => ({ ...committed(hostRoot()), containerInfo }) as unknown as FiberRoot;
  assert.equal(nextDevToolsRoot(on({ nodeType: 1, nodeName: 'NEXTJS-PORTAL', localName: 'nextjs-portal' })), true);
  // The App Router hydrates the document; an app's own createRoot is given an element of its own.
  assert.equal(nextDevToolsRoot(on({ nodeType: 9, nodeName: '#document' })), false);
  assert.equal(nextDevToolsRoot(on({ nodeType: 1, nodeName: 'DIV', localName: 'div' })), false);
  // A root with no container, or none at all, is left to the shape check rather than taken for the overlay.
  assert.equal(nextDevToolsRoot(on(null)), false);
  assert.equal(nextDevToolsRoot(committed(hostRoot()) as unknown as FiberRoot), false);
  assert.equal(nextDevToolsRoot(undefined as unknown as FiberRoot), false);
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

test('a production walk cut at its budget does not blame the subtree it happened to reach first', () => {
  function Dashboard() {}
  function Orders() {}
  function Order() {}
  function Metrics() {}
  function Metric() {}
  function App() {}
  const rows = (component: () => void, n: number) => Array.from({ length: n }, () => rendered(component, element('li', text())));
  // Orders renders 3,000 rows and comes first; Metrics renders 6,000 after it. With no durations the hot path
  // goes by counts, and a walk stopped at 5,000 has all of Orders and a third of Metrics.
  const dashboard = () => root(rendered(Dashboard, rendered(Orders, ...rows(Order, 3000)), rendered(Metrics, ...rows(Metric, 6000))));
  const whole = walkCommit(dashboard() as any, 10_000, 100, click, development);
  assert.deepEqual(whole.hotPath, ['Dashboard', 'Metrics']);
  const cut = walkCommit(dashboard() as any, 5000, 100, click, development);
  assert.equal(cut.truncated, true);
  assert.deepEqual(cut.hotPath, ['Dashboard']);

  // The same tree cut inside its first subtree still says nothing it cannot know about the second.
  assert.deepEqual(walkCommit(dashboard() as any, 1000, 100, click, development).hotPath, ['Dashboard']);

  // With React's durations, which are totals for each subtree walked or not, the path still chooses.
  const timed = dashboard();
  const time = (f: Record<string, any>, ms: number) => Object.assign(f, { actualDuration: ms, mode: 0b10 });
  time(timed, 90);
  time(timed.child, 90);
  time(timed.child.child, 30);
  time(timed.child.child.sibling, 60);
  assert.deepEqual(walkCommit(timed as any, 5000, 100, click, development).hotPath, ['Dashboard', 'Metrics']);

  // Several roots, the walk cut in the first: named by the component they all sit under, not by the first.
  const passedThrough = (component: () => void, ...children: Record<string, unknown>[]) => fiber(0, component, children, 0);
  const roots = () => root(passedThrough(App, rendered(Orders, ...rows(Order, 3000)), rendered(Metrics, ...rows(Metric, 6000))));
  const several = walkCommit(roots() as any, 5000, 100, click, development);
  assert.deepEqual(several.roots, ['Orders', 'Metrics']);
  assert.deepEqual(several.hotPath, ['App']);
  // And by nothing where they sit under no component.
  const bare = walkCommit(root(element('main', rendered(Orders, ...rows(Order, 3000)), rendered(Metrics, ...rows(Metric, 6000)))) as any, 5000, 100, click, development);
  assert.deepEqual(bare.hotPath, []);
});

test("@emotion/styled's Insertion is not counted as a component, whatever the minifier named it", () => {
  function Row() {}
  function Insertion() {}
  function OtherInsertion() {}
  function Button() {}
  // A styled component from @emotion/styled: a forwardRef that carries the tag it wraps as __emotion_base,
  // rendering its Insertion first and the element it styles beside it.
  const styled = (base: unknown, name: string) => ({ $$typeof: Symbol.for('react.forward_ref'), render: () => null, displayName: name, __emotion_base: base });
  const cell = () => fiber(11, styled('td', 'Styled(td)'), [rendered(Insertion), element('td', text())], 1);
  const table = root(rendered(Row, element('tr', cell(), cell(), cell())));
  const walked = walkCommit(table as any, 100, 100, click, development);
  assert.deepEqual(
    walked.components.map((c) => `${c.name} ×${c.count}`),
    ['Styled(td) ×3', 'Row ×1'],
  );
  assert.equal(walked.rendered, 4);
  // A production build renames Insertion; its place still tells it. A component emotion styles is the
  // app's and is counted.
  const minifiedInsertion = Object.defineProperty(function () {}, 'name', { value: 'q' });
  const styledButton = fiber(11, styled(Button, 'Styled(Button)'), [rendered(minifiedInsertion), rendered(Button, element('button', text()))], 1);
  assert.deepEqual(
    walkCommit(root(styledButton) as any, 100, 100, click, development).components.map((c) => c.name).sort(),
    ['Button', 'Styled(Button)'],
  );
  // An Insertion anywhere else is an ordinary component with that name.
  Object.defineProperty(OtherInsertion, 'name', { value: 'Insertion' });
  const plain = walkCommit(root(rendered(Row, rendered(OtherInsertion))) as any, 100, 100, click, development);
  assert.deepEqual(plain.components.map((c) => c.name).sort(), ['Insertion', 'Row']);
});

test("a styling library's wrapper is named the way the library names an unlabelled one, whatever label it was given", () => {
  function Row() {}
  function Insertion() {}
  function Card() {}
  const forwardRef = (extra: Record<string, unknown>) => ({ $$typeof: Symbol.for('react.forward_ref'), render: () => null, ...extra });
  const names = (tree: Record<string, unknown>) => walkCommit(root(tree) as any, 100, 100, click, development).components.map((c) => c.name).sort();
  // MUI labels each root it styles with @emotion/styled, so in development it reads as a component anybody wrote.
  const muiRoot = forwardRef({ displayName: 'MuiButtonBaseRoot', __emotion_base: 'button' });
  assert.deepEqual(names(rendered(Row, fiber(11, muiRoot, [rendered(Insertion), element('button', text())], 1))), ['Row', 'Styled(button)']);
  // styled-components' Babel and SWC plugins give each one the name of the variable it was assigned to.
  const priceRow = forwardRef({ displayName: 'PriceList__Item', styledComponentId: 'sc-a1', target: 'li' });
  const styledCard = forwardRef({ displayName: 'Tile', styledComponentId: 'sc-b2', target: Card });
  assert.deepEqual(names(rendered(Row, fiber(11, priceRow, [element('li', text())], 1), fiber(11, styledCard, [rendered(Card)], 1))), ['Card', 'Row', 'Styled(Card)', 'styled.li']);
  // @emotion/react's css prop renders a component of its own around the element, and its Insertion beside it.
  const cssProp = (type: unknown) => {
    const wrapper = fiber(11, forwardRef({ displayName: 'EmotionCssPropInternal' }), [rendered(Insertion), typeof type === 'string' ? element(type, text()) : rendered(type as () => void)], 1);
    wrapper.memoizedProps = { __EMOTION_TYPE_PLEASE_DO_NOT_USE__: type, css: {} };
    return wrapper;
  };
  assert.deepEqual(names(rendered(Row, cssProp('li'), cssProp('li'))), ['Row', 'Styled(li)']);
  assert.equal(walkCommit(root(rendered(Row, cssProp('li'), cssProp(Card))) as any, 100, 100, click, development).rendered, 4);
  // Named that way in the owners a target reads too.
  const inside = element('li', text());
  rendered(Row, fiber(11, priceRow, [inside], 1));
  assert.deepEqual(ownersOf(inside as any), ['styled.li', 'Row']);
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

test("a compiler temporary, Radix's wrapper and a bound function's prefix are not the handler's name", () => {
  const named = (name: string) => Object.defineProperty(() => {}, 'name', { value: name });
  const button = (onClick: unknown) => ({ ...fiber(5, 'button'), memoizedProps: { onClick } });
  const handlerNamed = (name: string) => handlerOf(button(named(name)) as any, 'click');
  // React Compiler: `const handleLogin = () => ...` compiles to `t0 = () => ...`, and an inline handler
  // is hoisted to `function _temp()`.
  assert.equal(handlerNamed('t1'), 'onClick');
  assert.equal(handlerNamed('t12'), 'onClick');
  assert.equal(handlerNamed('_temp'), 'onClick');
  assert.equal(handlerNamed('_temp2'), 'onClick');
  // @radix-ui/primitive's composeEventHandlers.
  assert.equal(handlerNamed('handleEvent'), 'onClick');
  // lodash's debounce and throttle.
  assert.equal(handlerNamed('debounced'), 'onClick');
  assert.equal(handlerNamed('handleLogin'), 'handleLogin');
  // Names that only start like one.
  assert.equal(handlerNamed('toggle'), 'toggle');
  assert.equal(handlerNamed('t1Row'), 't1Row');
  assert.equal(handlerNamed('handleEvents'), 'handleEvents');
  function handleSave() {}
  assert.equal(handlerOf(button(handleSave.bind(null)) as any, 'click'), 'handleSave');
  assert.equal(handlerOf(button(handleSave.bind(null).bind(null)) as any, 'click'), 'handleSave');
  // A bound temporary is still a temporary.
  assert.equal(handlerOf(button(named('_temp').bind(null)) as any, 'click'), 'onClick');
});

/** A host fiber for `<tag …props>`, with `parent` above it as React's `return` chain has it. */
const host = (tag: string, props: Record<string, unknown>, parent?: Record<string, unknown>) => ({ ...fiber(5, tag), memoizedProps: props, return: parent ?? null });
/** A handler the minifier stripped the name off, so the prop it sits on is what names it. */
const anon = () => Object.defineProperty(() => {}, 'name', { value: '' });

test('React fires onChange from the click on a checkbox or a radio, so that is the handler the click is given', () => {
  // react-dom's ChangeEventPlugin listens to `click` for these two and to nothing else; before this the
  // table had only onClick and onSubmit for a click, and every ticked checkbox reported no handler.
  for (const type of ['checkbox', 'radio']) {
    assert.equal(handlerOf(host('input', { type, onChange: anon() }) as any, 'click'), 'onChange');
  }
  // The element's own onClick still wins, and onSubmit stays the last resort behind onChange.
  const both = host('input', { type: 'checkbox', onClick: anon(), onChange: anon() });
  assert.equal(handlerOf(both as any, 'click'), 'onClick');
  const inForm = host('input', { type: 'checkbox', onChange: anon() }, host('form', { onSubmit: anon() }));
  assert.equal(handlerOf(inForm as any, 'click'), 'onChange');
});

test("a click on a label's text is the control the label wraps, which is where the handler is", () => {
  // The browser forwards the click, so the interaction the user had is the checkbox's, not the span's.
  const box: Record<string, unknown> = { ...fiber(5, 'input'), memoizedProps: { type: 'checkbox', onChange: anon() } };
  const text: Record<string, unknown> = { ...fiber(5, 'span'), memoizedProps: {} };
  fiber(5, 'label', [box, text]);
  assert.equal(handlerOf(text as any, 'click'), 'onChange');
  // A label with no control in it is left where it is, and the walk up still applies.
  const bare: Record<string, unknown> = { ...fiber(5, 'span'), memoizedProps: {} };
  fiber(5, 'label', [bare]).memoizedProps = { onClick: anon() };
  assert.equal(handlerOf(bare as any, 'click'), 'onClick');
});

test('a click on something interactive inside a label is that element\'s, because the browser forwards nothing', () => {
  // Four shapes a real form has, all of which naming the labelled control got wrong. A browser
  // forwards a label's click only when the click was the label's to give away: an anchor, a button or
  // a second control keeps it, and so does the label's own onClick.
  const named = (fn: () => void) => Object.defineProperty(fn, 'name', { value: fn.name });

  // "I accept the <a>terms</a>" beside a checkbox: the anchor opens the terms, the box is untouched.
  function openTerms() {}
  function tick() {}
  const accept: Record<string, unknown> = { ...fiber(5, 'input'), memoizedProps: { type: 'checkbox', onChange: named(tick) } };
  const terms: Record<string, unknown> = { ...fiber(5, 'a'), memoizedProps: { onClick: named(openTerms) } };
  fiber(5, 'label', [accept, terms]);
  assert.equal(handlerOf(terms as any, 'click'), 'openTerms');

  // A button inside a label that also holds a text field: the click is the button's, and a text field
  // has no click handler of React's at all, so naming it was naming a handler that never ran.
  function clearField() {}
  const field: Record<string, unknown> = { ...fiber(5, 'input'), memoizedProps: { type: 'text', onChange: anon() } };
  const clear: Record<string, unknown> = { ...fiber(5, 'button'), memoizedProps: { onClick: named(clearField) } };
  fiber(5, 'label', [field, clear]);
  assert.equal(handlerOf(clear as any, 'click'), 'clearField');

  // Two checkboxes in one label: the click on the second is the second one's.
  function toggleA() {}
  function toggleB() {}
  const first: Record<string, unknown> = { ...fiber(5, 'input'), memoizedProps: { type: 'checkbox', onChange: named(toggleA) } };
  const second: Record<string, unknown> = { ...fiber(5, 'input'), memoizedProps: { type: 'checkbox', onChange: named(toggleB) } };
  fiber(5, 'label', [first, second]);
  assert.equal(handlerOf(second as any, 'click'), 'toggleB');

  // A label with its own onClick: that handler runs, and it is not the checkbox's onChange.
  function expand() {}
  const inner: Record<string, unknown> = { ...fiber(5, 'input'), memoizedProps: { type: 'checkbox', onChange: anon() } };
  const caption: Record<string, unknown> = { ...fiber(5, 'span'), memoizedProps: {} };
  fiber(5, 'label', [inner, caption]).memoizedProps = { onClick: named(expand) };
  assert.equal(handlerOf(caption as any, 'click'), 'expand');
});

test('a click that is not on one of those controls does not reach an onChange up the tree', () => {
  // Every click inside a form with an onChange would otherwise be named after it.
  const button = host('button', {}, host('form', { onChange: anon() }));
  assert.equal(handlerOf(button as any, 'click'), null);
  // A text field is React's onChange from `input` and `change`, not from a click.
  const text = host('input', { type: 'text', onChange: anon() });
  assert.equal(handlerOf(text as any, 'click'), null);
  assert.equal(handlerOf(text as any, 'input'), 'onChange');
  assert.equal(handlerOf(text as any, 'change'), 'onChange');
});

test('a select, a file input and a textarea are named by the event React reads each of them from', () => {
  assert.equal(handlerOf(host('select', { onChange: anon() }) as any, 'change'), 'onChange');
  assert.equal(handlerOf(host('input', { type: 'file', onChange: anon() }) as any, 'change'), 'onChange');
  assert.equal(handlerOf(host('textarea', { onChange: anon() }) as any, 'input'), 'onChange');
  // A select has no input event in React's plugin, so a click on it is not an onChange either.
  assert.equal(handlerOf(host('select', { onChange: anon() }) as any, 'click'), null);
});

test('only Enter in a field reaches onSubmit: every other keystroke in a form never submitted it', () => {
  // A form's onSubmit used to be named for any key in any field, so a report for typing an address
  // blamed saveOrder, which had not run. Implicit submission is Enter in a field or on a button.
  const field = host('input', { type: 'text' }, host('form', { onSubmit: anon() }));
  assert.equal(handlerOf(field as any, 'keydown', 'Enter'), 'onSubmit');
  assert.equal(handlerOf(field as any, 'keydown', 'NumpadEnter'), 'onSubmit');
  assert.equal(handlerOf(field as any, 'keydown', 'KeyA'), null);
  // Without the key there is no way to tell, and a wrong name is worse than no name.
  assert.equal(handlerOf(field as any, 'keydown'), null);
  // Enter in a textarea is a newline, and on a div it is nothing at all.
  const area = host('textarea', {}, host('form', { onSubmit: anon() }));
  assert.equal(handlerOf(area as any, 'keydown', 'Enter'), null);
  const div = host('div', {}, host('form', { onSubmit: anon() }));
  assert.equal(handlerOf(div as any, 'keydown', 'Enter'), null);
  // The release is never the submission: the browser submits on the keydown.
  assert.equal(handlerOf(field as any, 'keyup', 'Enter'), null);
  // The field's own handlers come first, whatever the key.
  const typed = host('input', { type: 'text', onChange: anon() }, host('form', { onSubmit: anon() }));
  assert.equal(handlerOf(typed as any, 'keydown', 'Enter'), 'onChange');
  assert.equal(handlerOf(typed as any, 'keydown', 'KeyA'), 'onChange');
  assert.equal(handlerOf(host('input', { type: 'text', onKeyDown: anon() }) as any, 'keydown', 'KeyA'), 'onKeyDown');
  // A keystroke outside a control fires no onChange of React's, so an onChange up the tree is not it.
  assert.equal(handlerOf(host('div', {}, host('form', { onChange: anon() })) as any, 'keydown', 'KeyA'), null);
});

test('a pointer event falls back to the mouse prop, the way React dispatches both', () => {
  assert.equal(handlerOf(host('button', { onMouseDown: anon() }) as any, 'pointerdown'), 'onMouseDown');
  assert.equal(handlerOf(host('button', { onMouseUp: anon() }) as any, 'pointerup'), 'onMouseUp');
  // A mouse event never reaches here: the ring records pointer events and Event Timing names those.
  assert.equal(handlerOf(host('button', { onPointerDown: anon() }) as any, 'mousedown'), null);
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

test("a commit's render start is the root fiber's actualStartTime, and only when it can be one", () => {
  function Panel() {}
  const at = (start: unknown) => walkCommit(Object.assign(profiledRoot(timed(Panel, 3)), start === undefined ? {} : { actualStartTime: start }) as any, 5000, 100, click, development).startedAt;
  assert.equal(at(40), 40);
  // A production build has no such field, and a tree outside ProfileMode leaves it at -1.
  assert.equal(at(undefined), null);
  assert.equal(at(-1), null);
  // Later than the commit's end is not the start of the render that commit came from.
  assert.equal(at(100.5), null);
});

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
