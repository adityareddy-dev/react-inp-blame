import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leafName } from '../src/commits.ts';
import { walkCommit } from '../src/fiber.ts';
import { buildReport, sealReport } from '../src/join.ts';
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

/** Imports the Next.js entry, as withInpBlame's build would. */
async function nextEntry(): Promise<void> {
  process.env.REACT_INP_BLAME_NEXT = JSON.stringify({ install: {}, basePath: '' });
  try {
    // Outside a browser its install() finds no window and does nothing; the names are added all the same.
    await import('../src/next-client.ts');
  } finally {
    delete process.env.REACT_INP_BLAME_NEXT;
  }
}

/** What a click on a link the ring saw inside `owners` reports as its component and its `where`. */
function clickedInside(owners: string[]): { component: string | null; owners: readonly string[]; where: string | null } {
  const a = { nodeType: 1, tagName: 'A', id: '', classList: { length: 0 }, parentNode: null, parentElement: null, nextSibling: null, firstChild: null, getAttribute: () => null };
  const ring = [{ ts: 0, type: 'click', gestureTs: 0, press: undefined, target: a as unknown as Node, owners, handler: null, dehydrated: null, work: { endedAt: 0, unjoined: [] } }];
  const entry = { name: 'click', interactionId: 7, startTime: 0, duration: 120, processingStart: 3, processingEnd: 100, target: null };
  const r = sealReport(buildReport([entry] as any, [], [], ring));
  return { component: r.target?.component ?? null, owners: r.target?.owners ?? [], where: r.explanation.where };
}

test("under the App Router a render from the Router down is named after the app's components, not Next.js's boundaries", async () => {
  // Without the Next.js entry the names are readable ones like any other, and the twelve steps ran out at the
  // root segment's ErrorBoundary, which the render was then named after.
  const before = rows();
  assert.deepEqual([before.hotPath.at(-1), leafName(before)], ['ErrorBoundary', 'ErrorBoundary']);

  await nextEntry();
  const after = rows();
  assert.deepEqual(after.hotPath.slice(-3), ['ServerPage', 'ActionButton', 'Rows']);
  assert.equal(leafName(after), 'Rows');
  // The count the sentence gives beside it is the rows' and their list's.
  assert.equal(after.pathRendered, 301);
});

test("under Next.js a click on a link is named after the component that wrote <Link>, not next/link's own", async () => {
  // A link a page wrote, as the Next.js demo's link to its second page is. Without the entry LinkComponent is a
  // readable name like any other, and under `next dev` the click was said to be in it.
  const link = ['LinkComponent', 'Page', 'ClientPageRoot', 'InnerLayoutRouter'];
  await nextEntry();
  assert.deepEqual(clickedInside(link), { component: 'Page', owners: link, where: 'link in Page' });
  // Passed over only for the app's component right above it. A link a server component wrote has only the App
  // Router's boundaries above it, as in a root layout's header on 15.3, where the eighth owner up is the dev
  // overlay: that name is readable and unlisted, and a link there is still said to be in LinkComponent.
  const rootLayout = ['RedirectErrorBoundary', 'RedirectBoundary', 'HTTPAccessFallbackErrorBoundary', 'HTTPAccessFallbackBoundary', 'DevRootHTTPAccessFallbackBoundary', 'AppDevOverlayErrorBoundary', 'AppDevOverlay'];
  assert.equal(clickedInside(['LinkComponent', ...rootLayout]).component, 'LinkComponent');
  assert.equal(clickedInside(['LinkComponent', 'x', 'ClientPageRoot']).component, 'LinkComponent');
  // Only the wrapper is passed over: a button in the same layout is named as it was, after the nearest boundary.
  assert.equal(clickedInside(rootLayout).component, 'RedirectErrorBoundary');
});
