'use client';

import Link from 'next/link';
import { useState } from 'react';
import { burn } from './burn';

/** The lifted-state anti-pattern: one keystroke re-renders an unrelated heavy sibling. */
export default function Page() {
  const [name, setName] = useState('');
  return (
    <main>
      <h1>Next.js load-order check</h1>
      <input data-test="trigger" value={name} onChange={(e) => setName(e.target.value)} placeholder="type here" />
      <p>Hello {name || 'stranger'}</p>
      {/* A click slow enough to be reported, which starts a soft navigation. */}
      <Link href="/second" data-test="navigate" onClick={() => burn(60)}>
        Second page
      </Link>
      <Sidebar />
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
