import { memo, useState } from 'react';

const CELLS = 30000;

/** Not React's fault: one class on the grid restyles 30,000 cells, and the browser's style and layout is the slow part. */
export function RestyleStorm() {
  const [dense, setDense] = useState(false);
  return (
    <>
      <button className="primary" data-test="trigger" onClick={() => setDense((d) => !d)}>
        Switch density
      </button>
      <div className={dense ? 'restyle dense' : 'restyle'}>
        <Cells />
      </div>
    </>
  );
}

// Memoised, so the click renders RestyleStorm alone and what is left is the browser's.
const Cells = memo(function Cells() {
  const cells = [];
  for (let i = 0; i < CELLS; i++) cells.push(<span key={i}>{i}</span>);
  return <>{cells}</>;
});
