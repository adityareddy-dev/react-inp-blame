import { useState } from 'react';
import { burn } from '../burn';

/** Anti-pattern: input state lives at the top, so an unrelated heavy sibling re-renders per keystroke. */
export function LiftedState() {
  const [name, setName] = useState('');
  return (
    <div className="two-col action">
      <section>
        <input className="text" data-test="trigger" value={name} onChange={(e) => setName(e.target.value)} placeholder="your name" />
        <p>Hello {name || 'stranger'}</p>
      </section>
      <Sidebar />
    </div>
  );
}

function Sidebar() {
  return (
    <nav className="grid">
      {Array.from({ length: 600 }, (_, i) => (
        <NavItem key={i} index={i} />
      ))}
    </nav>
  );
}

function NavItem({ index }: { index: number }) {
  burn(0.12);
  return <a href="#lifted-state">Item {index}</a>;
}
