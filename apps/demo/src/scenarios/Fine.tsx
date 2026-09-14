import { memo, useCallback, useState } from 'react';
import { burn } from '../burn';

/** Control: the same shapes done right. Memoised rows, stable callbacks, state kept low. */
export function Fine() {
  const [count, setCount] = useState(0);
  const add = useCallback(() => setCount((c) => c + 1), []);
  return (
    <>
      <button className="primary" data-test="trigger" onClick={add}>
        Add ({count})
      </button>
      <Rows />
    </>
  );
}

const Rows = memo(function Rows() {
  return (
    <ul className="grid">
      {Array.from({ length: 800 }, (_, i) => (
        <Row key={i} index={i} />
      ))}
    </ul>
  );
});

const Row = memo(function Row({ index }: { index: number }) {
  burn(0.05);
  return <li>row {index}</li>;
});
