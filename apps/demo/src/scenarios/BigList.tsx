import { useMemo, useState } from 'react';
import { burn } from '../burn';

/** Anti-pattern: filtering a 3000-row unvirtualised list on every keystroke. */
export function BigList() {
  const [q, setQ] = useState('');
  const rows = useMemo(() => Array.from({ length: 3000 }, (_, i) => `Row ${i} ${(i * 7919) % 1000}`), []);
  const shown = rows.filter((r) => r.includes(q));
  return (
    <>
      <input className="text" data-test="trigger" value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter rows" />
      <ul className="grid">
        {shown.map((r) => (
          <Row key={r} text={r} q={q} />
        ))}
      </ul>
    </>
  );
}

function Row({ text, q }: { text: string; q: string }) {
  burn(0.03);
  const i = q ? text.indexOf(q) : -1;
  return (
    <li>
      {i < 0 ? text : <>{text.slice(0, i)}<mark>{q}</mark>{text.slice(i + q.length)}</>}
    </li>
  );
}
