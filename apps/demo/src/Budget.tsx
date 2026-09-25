import { useState } from 'react';
import { burn } from './burn';

// A page for e2e/budget.spec.ts, at #budget and not in the lab's list: one click re-renders 9,000 small
// components, 3,000 in the first subtree and 6,000 in the second, past the walk's budget of 5,000. A
// production build has no durations, so the walk goes by counts, and it reaches the first subtree first.
// Each row spends 10 µs, so the click is slow enough to be reported in a production build too.

function Order({ i, round }: { i: number; round: number }) {
  burn(0.01);
  return <li>{`order ${i} · ${round}`}</li>;
}

function Orders({ round }: { round: number }) {
  return (
    <ul hidden>
      {Array.from({ length: 3000 }, (_, i) => (
        <Order key={i} i={i} round={round} />
      ))}
    </ul>
  );
}

function Metric({ i, round }: { i: number; round: number }) {
  burn(0.01);
  return <li>{`metric ${i} · ${round}`}</li>;
}

function Metrics({ round }: { round: number }) {
  return (
    <ul hidden>
      {Array.from({ length: 6000 }, (_, i) => (
        <Metric key={i} i={i} round={round} />
      ))}
    </ul>
  );
}

export function Budget() {
  const [round, setRound] = useState(0);
  return (
    <main>
      <button className="primary" data-test="trigger" onClick={() => setRound((n) => n + 1)}>
        Refresh ({round})
      </button>
      <Orders round={round} />
      <Metrics round={round} />
    </main>
  );
}
