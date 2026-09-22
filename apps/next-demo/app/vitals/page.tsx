'use client';

import { useState } from 'react';
import { burn } from '../burn';
import { WebVitals } from './web-vitals';

/**
 * INP as Next.js's `useReportWebVitals` reports it, which is once the page is hidden. A slow click
 * re-renders a heavy list; a quicker key press afterwards is reported too, so the page's INP is not
 * its last report.
 */
export default function VitalsPage() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <WebVitals />
      <h1>useReportWebVitals</h1>
      <button type="button" data-test="slow" onClick={() => setCount((c) => c + 1)}>
        Clicked {count} times
      </button>
      <Quick />
      <Rows count={count} />
    </main>
  );
}

/** Its own state, so a key press renders one input and not the list. */
function Quick() {
  const [text, setText] = useState('');
  return (
    <input
      data-test="quick"
      value={text}
      onChange={(e) => {
        burn(50);
        setText(e.target.value);
      }}
      placeholder="type here"
    />
  );
}

function Rows({ count }: { count: number }) {
  return (
    <ul style={{ columns: 6, fontSize: 12 }}>
      {Array.from({ length: 400 }, (_, i) => (
        <Row key={i} index={i} count={count} />
      ))}
    </ul>
  );
}

function Row({ index, count }: { index: number; count: number }) {
  burn(0.4);
  return (
    <li>
      Row {index}, {count}
    </li>
  );
}
