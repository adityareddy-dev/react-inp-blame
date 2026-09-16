import { useEffect, useState } from 'react';
import { burn } from '../burn';

/**
 * Anti-pattern: derived state set from an effect. One click, two commits, the second one heavy.
 * React 18 and 19 run the effect inside the click's own task, but the state it sets there takes
 * default priority and renders in a later one, after the paint; React 17 defers the effect itself.
 * Either way INP sees only the cheap first commit and the user still waits for the second. The
 * report calls it a follow-up commit.
 */
export function CascadingEffect() {
  const [selected, setSelected] = useState<number | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  useEffect(() => {
    if (selected != null) setDetails(Array.from({ length: 400 }, (_, i) => `detail ${selected}-${i}`));
  }, [selected]);
  return (
    <>
      <button className="primary" data-test="trigger" onClick={() => setSelected((s) => (s ?? 0) + 1)}>
        Select next {selected ?? ''}
      </button>
      <ul className="grid">
        {details.map((d) => (
          <Detail key={d} text={d} />
        ))}
      </ul>
    </>
  );
}

function Detail({ text }: { text: string }) {
  burn(0.15);
  return <li>{text}</li>;
}
