import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leafName } from '../src/commits.ts';
import { walkCommit } from '../src/fiber.ts';
import type { CommitSummary } from '../src/types.ts';

// A file of its own, because importing react-inp-blame/next-client adds the App Router's names to the layers
// for the rest of the process, as it does for the rest of the page.

const click = { ts: 90, type: 'click', gestureTs: 90 };
const development = { profileMode: 0b10, priority: 1, didError: false, hydratedTarget: null };

function fiber(tag: number, type: unknown, children: Record<string, unknown>[] = []): Record<string, unknown> {
  const f: Record<string, unknown> = { tag, flags: tag === 0 ? 1 : 0, mode: 0, elementType: type, type, memoizedProps: null, memoizedState: null, return: null, child: children[0] ?? null, sibling: null, alternate: null };
  children.forEach((child, i) => {
    child.return = f;
    child.sibling = children[i + 1] ?? null;
  });
  return f;
}
const named = (name: string) => Object.assign(() => {}, { displayName: name });
const chain = (names: string[], ...leaves: Record<string, unknown>[]) => names.reduceRight((kids, name) => [fiber(0, named(name), kids)], leaves)[0]!;
const walk = (tree: Record<string, unknown>) => walkCommit(fiber(3, null, [tree]) as any, 5000, 100, click, development) as CommitSummary;

// What a Server Action's result rendered on the Next.js demo under `next dev` on 16.3.5, from the Router down:
// the root segment's boundaries and layout router, the page segment's, then the page and the rows it rendered.
const SEGMENT = ['OuterLayoutRouter', 'SegmentStateProvider', 'RenderFromTemplateContext', 'ScrollAndMaybeFocusHandler', 'InnerScrollHandlerNew', 'ErrorBoundary', 'LoadingBoundary', 'HTTPAccessFallbackBoundary', 'HTTPAccessFallbackErrorBoundary', 'RedirectBoundary', 'RedirectErrorBoundary', 'InnerLayoutRouter'];
const ROUTER = ['Router', 'HotReload', 'AppDevOverlayErrorBoundary', 'DevRootHTTPAccessFallbackBoundary', 'HTTPAccessFallbackBoundary', 'HTTPAccessFallbackErrorBoundary', 'RedirectBoundary', 'RedirectErrorBoundary', '__next_root_layout_boundary__', 'SegmentViewNode', ...SEGMENT, ...SEGMENT, 'SegmentViewNode', 'ClientPageRoot', 'ServerPage', 'ActionButton', 'Rows'];
const rows = () => walk(chain(ROUTER, ...Array.from({ length: 300 }, () => fiber(0, named('Row'), [fiber(5, 'li')]))));

test("under the App Router a render from the Router down is named after the app's components, not Next.js's boundaries", async () => {
  // Without the Next.js entry the names are readable ones like any other, and the twelve steps ran out at the
  // root segment's ErrorBoundary, which the render was then named after.
  const before = rows();
  assert.deepEqual([before.hotPath.at(-1), leafName(before)], ['ErrorBoundary', 'ErrorBoundary']);

  process.env.REACT_INP_BLAME_NEXT = JSON.stringify({ install: {}, basePath: '' });
  try {
    // Outside a browser its install() finds no window and does nothing; the names are added all the same.
    await import('../src/next-client.ts');
  } finally {
    delete process.env.REACT_INP_BLAME_NEXT;
  }
  const after = rows();
  assert.deepEqual(after.hotPath.slice(-3), ['ServerPage', 'ActionButton', 'Rows']);
  assert.equal(leafName(after), 'Rows');
  // The count the sentence gives beside it is the rows' and their list's.
  assert.equal(after.pathRendered, 301);
});
