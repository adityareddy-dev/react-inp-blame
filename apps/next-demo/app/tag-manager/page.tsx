'use client';

import { useEffect, useState } from 'react';
import { burn } from '../burn';

/**
 * Not the button's fault: a tag manager's click listener on the document burns 150 ms on every click on "Add to
 * cart". The App Router hydrates the document itself, so React's own listener is on the document as well, and both
 * run as "#document.onclick". "Save" is slow in its own onClick, with no listener but React's taking any time.
 */
export default function TagManagerPage() {
  const [items, setItems] = useState(0);
  const [saved, setSaved] = useState(0);
  useEffect(() => {
    function trackClick(event: MouseEvent) {
      if (event.target instanceof Element && event.target.closest('[data-track]')) burn(150);
    }
    document.addEventListener('click', trackClick);
    return () => document.removeEventListener('click', trackClick);
  }, []);
  return (
    <main>
      <h1>Tag manager</h1>
      <button type="button" data-test="tracked" data-track onClick={() => setItems((n) => n + 1)}>
        Add to cart ({items})
      </button>
      <button
        type="button"
        data-test="slow"
        onClick={() => {
          burn(150);
          setSaved((n) => n + 1);
        }}
      >
        Save ({saved})
      </button>
    </main>
  );
}
