import { useEffect } from 'react';

// The only island on /below-the-fold, hydrated once it scrolls into view: until then the page has no React
// on it, although the install before hydration has run.
export function VisibleNote() {
  useEffect(() => {
    document.body.dataset.visibleNote = '';
  }, []);
  return <p className="visible-note">Hydrated when it scrolled into view.</p>;
}
