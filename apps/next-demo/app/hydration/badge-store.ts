/**
 * A counter held outside the streamed Suspense boundary and bumped from inside it, the way a cart
 * badge in a header is bumped by an "add to cart" button in a streamed section.
 *
 * It exists for one job in e2e/hydration.spec.ts: a click whose render lands entirely outside the
 * boundary. React then re-renders nothing under the boundary's parent, which leaves the boundary's
 * alternate fiber saying what it said when it hydrated, however long ago that was. A hydration verdict
 * read from that fiber calls every such click a hydration; this library reads the DOM beside the input
 * instead, and the spec holds it to that.
 */
let count = 0;
const listeners = new Set<() => void>();

export function bumpBadge(): void {
  count += 1;
  for (const listen of listeners) listen();
}

export function subscribeBadge(listen: () => void): () => void {
  listeners.add(listen);
  return () => {
    listeners.delete(listen);
  };
}

export const badgeCount = (): number => count;
/** The server renders the badge at zero, which is where every client starts too. */
export const badgeOnServer = (): number => 0;
