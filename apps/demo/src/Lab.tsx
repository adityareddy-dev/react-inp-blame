import { useEffect, useState, type ReactElement } from 'react';
import type { InteractionReport } from 'react-inp-blame';
import { onInteraction } from 'react-inp-blame';
import { Entry, titleFor } from './ReportCard';
import { BigList } from './scenarios/BigList';
import { CascadingEffect } from './scenarios/CascadingEffect';
import { ContextStorm } from './scenarios/ContextStorm';
import { Fine } from './scenarios/Fine';
import { HandlerHog } from './scenarios/HandlerHog';
import { LayoutThrash } from './scenarios/LayoutThrash';
import { LiftedState } from './scenarios/LiftedState';

interface Scenario {
  title: string;
  short: string;
  what: string;
  problem: string;
  fix: string;
  el: () => ReactElement;
}

export const labScenarios: Record<string, Scenario> = {
  'context-storm': {
    title: 'Context storm',
    short: 'Unstable context value',
    what: 'Click "Add to cart". One state change re-renders all 800 line items.',
    problem: 'The provider builds a new value object on every render, so every consumer re-renders, memo or not.',
    fix: 'useMemo the value, or split it into a state context and a stable actions context.',
    el: ContextStorm,
  },
  'layout-thrash': {
    title: 'Layout thrash',
    short: 'Read after write in effects',
    what: 'Click "Refresh prices". 400 rows each change a style, then read a size.',
    problem: 'A layout effect writes a style and immediately reads geometry, so the browser recalculates layout 400 times in one commit.',
    fix: 'Batch the reads before the writes, use CSS for the style change, or drop the measurement.',
    el: LayoutThrash,
  },
  'handler-hog': {
    title: 'Handler hog',
    short: 'Slow handler, no render',
    what: 'Click "Compute checksum". The handler itself burns 120 ms; React never renders.',
    problem: 'Heavy synchronous work inside the click handler blocks the next frame even though nothing re-renders.',
    fix: 'Move the work to a worker, chunk it with scheduler.yield, or defer it until after the paint.',
    el: HandlerHog,
  },
  'big-list': {
    title: 'Big list',
    short: '3000 rows per keystroke',
    what: 'Type in the search box. Every keystroke re-renders 3000 rows.',
    problem: 'The whole list re-renders on each character and nothing is virtualised or deferred.',
    fix: 'Virtualise the list, or wrap the filter in useDeferredValue so typing stays responsive.',
    el: BigList,
  },
  'lifted-state': {
    title: 'Lifted state',
    short: 'Input state too high',
    what: 'Type your name. An unrelated 600-item sidebar re-renders on every keystroke.',
    problem: 'The input state lives in a parent it shares with a heavy sibling that has no memo boundary.',
    fix: 'Move the state down next to the input, or memoise the sibling.',
    el: LiftedState,
  },
  'cascading-effect': {
    title: 'Cascading effect',
    short: 'Derived state from useEffect',
    what: 'Click "Select next". The click commits, then an effect sets more state and React renders again.',
    problem: 'State that could be derived during render is set from an effect, so every selection costs two renders, the second one after the paint.',
    fix: 'Derive the details during render (useMemo), or set both pieces of state in the handler.',
    el: CascadingEffect,
  },
  fine: {
    title: 'Done right',
    short: 'Same shapes, memoised',
    what: 'Click "Add". Rows are memoised and callbacks are stable, so one component renders.',
    problem: 'Nothing. This is the control.',
    fix: 'Keep it this way.',
    el: Fine,
  },
};

export function Lab({ scenario }: { scenario: string }) {
  const s = labScenarios[scenario] ?? labScenarios['context-storm'];
  const Scenario = s.el;
  return (
    <>
      <div className="topbar">
        <span>
          <b>Anti-pattern lab</b> · six slow interactions, each a named React mistake
        </span>
        <a href="#">← Sign-in demo</a>
      </div>
      <div className="shell">
        <div className="stage">
          <div className="labwrap">
            <nav className="labnav">
              {Object.entries(labScenarios).map(([k, v]) => (
                <a key={k} href={`#lab/${k}`} className={k === scenario ? 'active' : ''}>
                  {v.title}
                  <small>{v.short}</small>
                </a>
              ))}
            </nav>
            <section className="card">
              <h2>{s.title}</h2>
              <p className="what">{s.what}</p>
              <div className="pf">
                <div>
                  <b>What's wrong</b>
                  {s.problem}
                </div>
                <div>
                  <b>The fix</b>
                  {s.fix}
                </div>
              </div>
              <Scenario key={scenario} />
            </section>
          </div>
        </div>
        <LabReport />
      </div>
    </>
  );
}

function LabReport() {
  const [report, setReport] = useState<InteractionReport | null>(null);
  // Each revision arrives as a new frozen report, so there is nothing to copy.
  useEffect(() => onInteraction((r) => setReport(r)), []);
  return (
    <aside className="journey">
      <h3>What took time</h3>
      <p className="muted">The last interaction, explained. INP, Interaction to Next Paint, is how long the screen takes to respond after a click, tap or key press.</p>
      {report ? <Entry report={report} {...titleFor(report)} /> : <div className="empty">Trigger the scenario. The report appears here and in the console.</div>}
    </aside>
  );
}
