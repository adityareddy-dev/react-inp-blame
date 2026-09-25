'use client';
import { useState } from 'react';
function Row({ i, n }: { i: number; n: number }) {
  const end = performance.now() + 0.3;
  while (performance.now() < end) {}
  return <li>row {i} · {n}</li>;
}
export function SlowList() {
  const [n, setN] = useState(0);
  return (<div><button data-test="trigger" onClick={() => setN(n + 1)}>Count {n}</button><ul>{Array.from({ length: 400 }, (_, i) => <Row key={i} i={i} n={n} />)}</ul></div>);
}
