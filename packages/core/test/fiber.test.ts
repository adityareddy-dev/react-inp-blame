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
