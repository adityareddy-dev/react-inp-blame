import type { InteractionReport } from 'react-inp-blame';

/** Everything that took time on this page, in order: interactions from the library, waits from the app. */
export type Step =
  | { id: string; kind: 'interaction'; at: number; report: InteractionReport }
  | { id: string; kind: 'wait'; at: number; label: string; ms: number };

type Listener = (steps: Step[]) => void;
const steps: Step[] = [];
const listeners = new Set<Listener>();
const emit = () => {
  const snapshot = steps.slice().sort((a, b) => a.at - b.at);
  for (const fn of listeners) fn(snapshot);
};

export const journey = {
  steps: (): Step[] => steps.slice().sort((a, b) => a.at - b.at),
  /** Reports arrive once, then again each time a later render attaches to them. */
  upsertReport(r: InteractionReport): void {
    const i = steps.findIndex((s) => s.kind === 'interaction' && s.report.interactionId === r.interactionId);
    const step: Step = { id: `i${r.interactionId}`, kind: 'interaction', at: r.start, report: r };
    if (i >= 0) steps[i] = step;
    else steps.push(step);
    emit();
  },
  wait(label: string, ms: number, at: number): void {
    steps.push({ id: `w${Math.round(at)}`, kind: 'wait', at, label, ms });
    emit();
  },
  reset(): void {
    steps.length = 0;
    emit();
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
