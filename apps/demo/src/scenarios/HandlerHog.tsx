import { useState } from 'react';
import { burn } from '../burn';

/** Not React's fault: the click handler itself burns 120ms and never sets state. */
export function HandlerHog() {
  const [runs, setRuns] = useState(0);
  function computeChecksum() {
    burn(120);
  }
  return (
    <>
      <button className="primary" data-test="trigger" onClick={computeChecksum}>
        Compute checksum
      </button>{' '}
      <button className="ghost" onClick={() => setRuns((r) => r + 1)}>Cheap click ({runs})</button>
    </>
  );
}
