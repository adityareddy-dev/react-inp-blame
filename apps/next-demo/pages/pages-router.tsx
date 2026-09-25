import { useState } from 'react';
import { burn } from '../app/burn';

/**
 * A Pages Router page beside the App Router ones. On `next dev` from Next.js 15.3 the Pages Router's entry
 * loads react-dom before instrumentation-client, so this is where an install that comes too late shows.
 */
export default function PagesRouterPage() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Pages Router</h1>
      <button type="button" data-test="trigger" onClick={() => setCount(count + 1)}>
        Count {count}
      </button>
      <SlowList count={count} />
    </main>
  );
}

function SlowList({ count }: { count: number }) {
  return (
    <ul style={{ columns: 6, fontSize: 12 }}>
      {Array.from({ length: 400 }, (_, i) => (
        <Row key={i} index={i} count={count} />
      ))}
    </ul>
  );
}

function Row({ index, count }: { index: number; count: number }) {
  burn(0.3);
  return (
    <li>
      Row {index} · {count}
    </li>
  );
}
