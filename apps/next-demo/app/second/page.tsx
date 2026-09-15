'use client';

import { burn } from '../burn';

/** Where the link on the first page goes: one slow button, for an interaction on a page reached by a soft navigation. */
export default function SecondPage() {
  return (
    <main>
      <h1 data-test="second">Second page</h1>
      <button type="button" data-test="slow" onClick={() => burn(60)}>
        Slow button
      </button>
    </main>
  );
}
