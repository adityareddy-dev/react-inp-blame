'use client';

import { useState, useTransition } from 'react';
import { burn } from '../burn';
import { save } from './actions';

/**
 * The slow click Next.js users meet most: a button that waits on the server, then renders what came back.
 * One calls a Server Action inside a transition, the other fetches a route handler, each with a wait inside
 * `inputWindow` (400 ms) and one past it (2 s). The click itself paints at once with its pending text, so INP
 * does not count the wait. What renders when the answer arrives is slow on purpose. Each button keeps its
 * own state, so a click re-renders nothing but its own.
 */
export default function ServerPage() {
  return (
    <main>
      <h1>Waiting on the server</h1>
      <ActionButton ms={400} test="action-short" />
      <ActionButton ms={2000} test="action-long" />
      <FetchButton ms={400} test="fetch-short" />
      <FetchButton ms={2000} test="fetch-long" />
    </main>
  );
}

function ActionButton({ ms, test }: { ms: number; test: string }) {
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<number | null>(null);
  const click = () =>
    startTransition(async () => {
      const saved = await save(ms);
      startTransition(() => setRows(saved.rows));
    });
  return (
    <section>
      <button type="button" data-test={test} onClick={click}>
        Save, {ms} ms on the server
      </button>
      <span> {pending ? 'Saving…' : rows === null ? 'Not saved' : 'Saved'}</span>
      {rows !== null && <Rows count={rows} test={`${test}-done`} />}
    </section>
  );
}

function FetchButton({ ms, test }: { ms: number; test: string }) {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<number | null>(null);
  const click = async () => {
    setLoading(true);
    const answer = (await (await fetch(`/api/slow?ms=${ms}`)).json()) as { rows: number };
    setRows(answer.rows);
    setLoading(false);
  };
  return (
    <section>
      <button type="button" data-test={test} onClick={click}>
        Load, {ms} ms on the server
      </button>
      <span> {loading ? 'Loading…' : rows === null ? 'Not loaded' : 'Loaded'}</span>
      {rows !== null && <Rows count={rows} test={`${test}-done`} />}
    </section>
  );
}

function Rows({ count, test }: { count: number; test: string }) {
  return (
    <ul data-test={test} style={{ columns: 6, fontSize: 12 }}>
      {Array.from({ length: count }, (_, i) => (
        <Row key={i} index={i} />
      ))}
    </ul>
  );
}

function Row({ index }: { index: number }) {
  burn(0.4);
  return <li>Row {index}</li>;
}
