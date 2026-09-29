import { useEffect, useState } from 'react';
import { burn } from '../burn';

/** Not the button's fault: a tag manager's click listener on the document burns 150 ms on every click. */
export function TagManager() {
  const [items, setItems] = useState(0);
  useEffect(() => {
    function trackClick() {
      burn(150);
    }
    document.addEventListener('click', trackClick);
    return () => document.removeEventListener('click', trackClick);
  }, []);
  return (
    <button className="primary" data-test="trigger" onClick={() => setItems((n) => n + 1)}>
      Add to cart ({items})
    </button>
  );
}
