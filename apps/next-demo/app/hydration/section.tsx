'use client';

import { Suspense, useState, useSyncExternalStore, type ReactNode } from 'react';
import { burn } from '../burn';
import { badgeCount, badgeOnServer, subscribeBadge } from './badge-store';

/** Slow enough that a click React handles is reported at the library's default 40 ms threshold. */
const HANDLER_MS = 60;

/**
 * Holds the Suspense boundary the streamed panel arrives in. A boundary has no name of its own, so
 * a report names it after the nearest component that holds it: this one. Written as a client
 * component for that reason, since a Server Component leaves no fiber to be named after.
 */
export function PanelSection({ children }: { children: ReactNode }) {
  return (
    <section>
      <h2>Panel</h2>
      <Badge />
      <Outside />
      <Suspense fallback={<p data-test="panel-waiting">Loading the panel…</p>}>{children}</Suspense>
    </section>
  );
}

/**
 * Hydrated with the page, beside the boundary rather than inside it. A click here while the panel is
 * still server-rendered HTML has nothing to do with that boundary, and the report must not say it did.
 */
function Outside() {
  const [clicks, setClicks] = useState(0);
  return (
    <button
      type="button"
      data-test="outside-button"
      onClick={() => {
        burn(HANDLER_MS);
        setClicks((n) => n + 1);
      }}
    >
      Outside the boundary ({clicks})
    </button>
  );
}

/** Outside the boundary, and updated from inside it. See badge-store.ts for why that matters. */
function Badge() {
  const count = useSyncExternalStore(subscribeBadge, badgeCount, badgeOnServer);
  return <p data-test="badge">{count}</p>;
}
