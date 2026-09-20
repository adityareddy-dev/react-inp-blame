'use client';

import { startTransition, useEffect, useState } from 'react';
import { burn } from '../burn';
import { bumpBadge } from './badge-store';

// Deliberately expensive to hydrate. Hydrating this boundary has to run every component inside it,
// and each row burns the main thread the way a real component with a heavy first render does, so the
// wait is long enough to measure and to see in the report. 24 rows of 7 ms is about 168 ms, which
// leaves the whole interaction far inside the library's 1500 ms input window even on a slow machine
// and with React's development double render.
const ROWS = 24;
const ROW_MS = 7;
/** Slow enough that a click React handles is reported at the library's default 40 ms threshold. */
const HANDLER_MS = 60;

/**
 * The client component inside the streamed Suspense boundary of app/hydration/page.tsx. Its buttons
 * are in the server-rendered HTML from the moment the boundary's content arrives, so a click can land
 * on one before React has hydrated the boundary, which is what e2e/hydration.spec.ts checks.
 */
export function Panel() {
  const [clicks, setClicks] = useState(0);
  const [deferred, setDeferred] = useState(0);
  // Says the boundary has hydrated, since this effect cannot run before its first commit. The spec
  // reads it to know a click it is about to send really is landing on HTML React has not reached.
  useEffect(() => {
    (window as Window & { __panelHydrated?: number }).__panelHydrated = performance.now();
  }, []);
  return (
    <section data-test="panel">
      <button
        type="button"
        data-test="panel-button"
        onClick={() => {
          burn(HANDLER_MS);
          setClicks((n) => n + 1);
        }}
      >
        Panel button
      </button>
      <p data-test="panel-clicks">{clicks}</p>
      <button
        type="button"
        data-test="badge-button"
        onClick={() => {
          // Every component this renders is outside the boundary, which is the case that used to be
          // mistaken for a hydration. See badge-store.ts.
          burn(HANDLER_MS);
          bumpBadge();
        }}
      >
        Bump the badge
      </button>
      <button
        type="button"
        data-test="transition-button"
        onClick={() => {
          burn(HANDLER_MS);
          // A transition renders after the dispatch has returned, so the hook sees the commit with no
          // input being dispatched. That is the path where a commit wrongly called a hydration is
          // thrown away as page startup rather than reported, which e2e/hydration.spec.ts checks.
          startTransition(() => setDeferred((n) => n + 1));
        }}
      >
        Transition inside the panel
      </button>
      <p data-test="panel-deferred">{deferred}</p>
      <ul style={{ columns: 4, fontSize: 12 }}>
        {Array.from({ length: ROWS }, (_, i) => (
          <PanelRow key={i} index={i} />
        ))}
      </ul>
    </section>
  );
}

function PanelRow({ index }: { index: number }) {
  burn(ROW_MS);
  return <li>Row {index}</li>;
}
