const ROWS = 400;

// Each row holds the main thread for 0.75 ms while it renders, so a click that re-renders the list
// is a slow interaction, and the time is spent in these components rather than in the handler.
function Row({ index, count }: { index: number; count: number }) {
  const end = performance.now() + 0.75;
  while (performance.now() < end) {}
  return (
    <li>
      Row {index}, count {count}
    </li>
  );
}

export function SlowList({ count }: { count: number }) {
  return (
    <section id="slow-list">
      <h2>Results</h2>
      <ul>
        {Array.from({ length: ROWS }, (_, i) => (
          <Row key={i} index={i} count={count} />
        ))}
      </ul>
    </section>
  );
}
