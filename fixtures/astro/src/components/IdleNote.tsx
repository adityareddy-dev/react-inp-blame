import { useEffect } from 'react';

// A second island, hydrated once the page is idle and as a root of its own, so the page has two: the install
// before hydration has to run once for both, and a click on the counter must not be blamed on this one.
export function IdleNote() {
  useEffect(() => {
    document.body.dataset.idleNote = '';
  }, []);
  return <p className="idle-note">Hydrated when the page went idle.</p>;
}
