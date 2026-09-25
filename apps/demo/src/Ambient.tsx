import { useEffect, useState } from 'react';
import { burn } from './burn';

// A page for e2e/ambient.spec.ts, at #ambient and not in the lab's list: renders that a resize, a media
// query, a hover or a scroll causes, each heavy, beside a quick button. None of them is the button's work.

const CELLS = 400;

function Cell({ label }: { label: string }) {
  burn(0.25);
  return <li>{label}</li>;
}

function Cells({ label, name }: { label: string; name: string }) {
  return (
    <ul className="grid" data-test={name} data-label={label}>
      {Array.from({ length: CELLS }, (_, i) => (
        <Cell key={i} label={`${label} ${i}`} />
      ))}
    </ul>
  );
}

/** Whether the media query matches, kept current by its `change` event, as useMediaQuery hooks do. React 17 has no useSyncExternalStore. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const on = () => setMatches(list.matches);
    list.addEventListener('change', on);
    return () => list.removeEventListener('change', on);
  }, [query]);
  return matches;
}

function BreakpointGrid() {
  const wide = useMediaQuery('(min-width: 600px)');
  return <Cells name="breakpoint" label={wide ? 'wide' : 'narrow'} />;
}

/** Whether the window is 600 px wide or more, kept current by `resize`, as useWindowSize hooks do. */
function WidthGrid() {
  const [wide, setWide] = useState(() => innerWidth >= 600);
  useEffect(() => {
    const on = () => setWide(innerWidth >= 600);
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  return <Cells name="width" label={wide ? 'wide' : 'narrow'} />;
}

function HoverCard() {
  const [open, setOpen] = useState(false);
  return (
    <div data-test="hover-card" onMouseEnter={() => setOpen(true)} style={{ padding: 8, border: '1px solid' }}>
      Hover me
      {open ? <Cells name="hover" label="open" /> : null}
    </div>
  );
}

function ScrollList() {
  const [scrolled, setScrolled] = useState(false);
  return (
    <div data-test="scroll-list" onScroll={() => setScrolled(true)} style={{ height: 120, overflow: 'auto', border: '1px solid' }}>
      <div style={{ height: 1200 }}>{scrolled ? <Cells name="scroll" label="scrolled" /> : 'Scroll me'}</div>
    </div>
  );
}

/** The quick click: its render is this button alone. */
function SaveButton() {
  const [saved, setSaved] = useState(0);
  return (
    <button className="primary" data-test="trigger" onClick={() => setSaved((n) => n + 1)}>
      Save ({saved})
    </button>
  );
}

export function Ambient() {
  return (
    <main>
      <SaveButton />
      <HoverCard />
      <ScrollList />
      <BreakpointGrid />
      <WidthGrid />
    </main>
  );
}
