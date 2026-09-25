import { useEffect, useState } from 'react';
import { SlowList } from './SlowList';

export function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    // For the specs: from here on the counter's clicks reach React, rather than being queued for hydration.
    document.body.dataset.hydrated = '';
  }, []);
  return (
    <main>
      <button type="button" className="counter" onClick={() => setCount((count) => count + 1)}>
        Count is {count}
      </button>
      <SlowList count={count} />
    </main>
  );
}
