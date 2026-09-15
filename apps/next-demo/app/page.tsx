'use client';

import { memo, useState } from 'react';

function burn(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}

/** The lifted-state anti-pattern: one keystroke re-renders an unrelated heavy sibling. */
export default function Page() {
  const [name, setName] = useState('');
  return (
    <main>
      <h1>Next.js load-order check</h1>
      <input data-test="trigger" value={name} onChange={(e) => setName(e.target.value)} placeholder="type here" />
      <p>Hello {name || 'stranger'}</p>
      <Sidebar />
      <Memoised />
    </main>
  );
}

function Sidebar() {
  return (
    <ul style={{ columns: 6, fontSize: 12 }}>
      {Array.from({ length: 600 }, (_, i) => (
        <NavItem key={i} index={i} />
      ))}
    </ul>
  );
}

function NavItem({ index }: { index: number }) {
  burn(0.12);
  return <li>Item {index}</li>;
}

// Exercises the `const X = memo(` case of the displayName loader. Not exported: a page file
// may only export what Next expects, and the webpack build's type check enforces that.
const Memoised = memo(function Memoised() {
  return null;
});
