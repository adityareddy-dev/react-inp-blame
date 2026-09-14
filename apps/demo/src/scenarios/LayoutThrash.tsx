import { useLayoutEffect, useRef, useState } from 'react';

/** Anti-pattern: a layout effect that writes a style then reads geometry, in 400 rows. Forced layout x400. */
export function LayoutThrash() {
  const [tick, setTick] = useState(0);
  return (
    <>
      <button className="primary" data-test="trigger" onClick={() => setTick((t) => t + 1)}>
        Refresh prices ({tick})
      </button>
      <div className="grid">
        {Array.from({ length: 400 }, (_, i) => (
          <PriceTicker key={i} index={i} tick={tick} />
        ))}
      </div>
    </>
  );
}

function PriceTicker({ index, tick }: { index: number; tick: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.style.paddingLeft = `${(tick + index) % 7}px`; // write
    // read after write: forces layout of the whole grid, once per row
    el.dataset.h = String(el.parentElement!.getBoundingClientRect().height);
  }, [tick, index]);
  return (
    <div ref={ref}>
      <b>Ticker {index}</b> ${(100 + ((tick * 7 + index) % 50)).toFixed(2)} {'·'.repeat((index + tick) % 9)}
    </div>
  );
}
