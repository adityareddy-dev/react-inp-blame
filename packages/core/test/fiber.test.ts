import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rootShapeProblem, walkCommit } from '../src/fiber.ts';

// The HostRoot fiber React 17, 18 and 19 hand the hook as `root.current`, in a development build.
const hostRoot = (): Record<string, unknown> => ({ tag: 3, flags: 0, mode: 3, child: null, sibling: null, return: null, alternate: null, actualDuration: 1.5 });

function without(key: string): Record<string, unknown> {
  const fiber = hostRoot();
  delete fiber[key];
  return fiber;
}

const click = { ts: 90, type: 'click', gestureTs: 90 };
const development = { profileMode: 0b10, priority: 1, didError: false };

/** A fiber of a freshly mounted tree, linked to its children. Tag 0 is a function component that rendered, 5 a DOM element, 6 a text node. */
function fiber(tag: number, type: unknown, children: Record<string, unknown>[] = []): Record<string, unknown> {
  const f: Record<string, unknown> = { tag, flags: tag === 0 ? 1 : 0, mode: 0, elementType: type, type, memoizedProps: null, return: null, child: children[0] ?? null, sibling: null, alternate: null };
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
  assert.equal(rootShapeProblem(hostRoot()), null);
  // Production builds have no actualDuration field at all.
  assert.equal(rootShapeProblem(without('actualDuration')), null);
});

test('the shape check names the first field that is not what the walk reads', () => {
  const cases: Array<[string, unknown, string]> = [
    ['no fiber at all', undefined, 'root.current is not an object'],
    ['a component fiber instead of the root', { ...hostRoot(), tag: 0 }, 'root.current.tag is 0, not 3 (HostRoot)'],
    ['React 16 called the flags effectTag', { ...without('flags'), effectTag: 0 }, 'root.current.flags is not a number'],
    ['a tree link that went missing', without('alternate'), 'root.current.alternate is neither a fiber nor null'],
    ['durations stored some other way', { ...hostRoot(), actualDuration: '1.5' }, 'root.current.actualDuration is neither a number nor absent'],
  ];
  for (const [why, current, problem] of cases) assert.equal(rootShapeProblem(current), problem, why);
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

test('outside ProfileMode a development tree reports render counts, not a 0 ms render', () => {
  // Development builds give every fiber actualDuration = 0 and only measure trees in ProfileMode.
  function Row() {}
  const row = { tag: 0, flags: 1, mode: 1, elementType: Row, type: Row, memoizedProps: null, return: null, child: null, sibling: null, alternate: null, actualDuration: 0 };
  const root = { tag: 3, flags: 0, mode: 1, elementType: null, type: null, memoizedProps: null, return: null, child: row, sibling: null, alternate: null, actualDuration: 0 };
  const c = walkCommit(root, 5000, 100, click, { profileMode: 0b10, priority: 1, didError: false });
  assert.equal(c.hasDurations, false);
  assert.equal(c.total, 0);
  assert.deepEqual(c.components, [{ name: 'Row', count: 1, self: null, total: null }]);
});

test('time React measured under a root outside ProfileMode still counts, as under <Profiler>', () => {
  // <Profiler> puts its own subtree in ProfileMode whatever the root's mode.
  function Chart() {}
  const chart = { tag: 0, flags: 1, mode: 0b10, elementType: Chart, type: Chart, memoizedProps: null, return: null, child: null, sibling: null, alternate: null, actualDuration: 12 };
  const profiler = { tag: 12, flags: 0, mode: 0b10, elementType: null, type: null, memoizedProps: null, return: null, child: chart, sibling: null, alternate: null, actualDuration: 12 };
  const root = { tag: 3, flags: 0, mode: 0, elementType: null, type: null, memoizedProps: null, return: null, child: profiler, sibling: null, alternate: null, actualDuration: 0 };
  const c = walkCommit(root, 5000, 100, click, { profileMode: 0b10, priority: undefined, didError: false });
  assert.equal(c.hasDurations, true);
  assert.equal(c.total, 12);
  assert.deepEqual(c.components, [{ name: 'Chart', count: 1, self: 12, total: 12 }]);
});
