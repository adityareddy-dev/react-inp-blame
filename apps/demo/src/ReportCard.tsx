import { useState } from 'react';
import type { CommitSummary, InteractionReport } from 'inpector';

export const RATING_LABEL = { good: 'Good', 'needs-work': 'Needs work', poor: 'Poor' } as const;

export function Pill({ rating }: { rating: keyof typeof RATING_LABEL }) {
  return <span className={`pill ${rating}`}>{RATING_LABEL[rating]}</span>;
}

/** Waiting / working / updating the screen, as one bar plus a legend. */
export function PhaseBar({ report }: { report: InteractionReport }) {
  const total = Math.max(report.duration, 1);
  const phases = report.explanation.phases;
  return (
    <>
      <div className="bar">
        {phases.map((p, i) => (
          <div key={p.label} className={`seg-${i}`} style={{ width: `${(p.ms / total) * 100}%` }} title={`${p.label}: ${Math.round(p.ms)} ms. ${p.hint}`} />
        ))}
      </div>
      <div className="legend">
        {phases.map((p, i) => (
          <span key={p.label} title={p.hint}>
            <i className={`seg-${i}`} />
            {p.label} {Math.round(p.ms)} ms
          </span>
        ))}
      </div>
    </>
  );
}

/** The components that rendered, heaviest first. */
export function Components({ commit }: { commit: CommitSummary }) {
  const rows = commit.components.slice(0, 5);
  const max = Math.max(...rows.map((x) => x.self ?? x.count), 1);
  return (
    <div className="comps">
      {rows.map((x) => (
        <div className="comp" key={x.name}>
          <b>{x.name}</b>
          <span>
            {x.count} rendered{x.self != null ? ` · ${x.self.toFixed(1)} ms` : ''}
          </span>
          <div className="track">
            <div className="fill" style={{ width: `${((x.self ?? x.count) / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** "Typing in Password" / "Click on Log in", from the report's target. */
export function titleFor(report: InteractionReport): { title: string; subtitle?: string } {
  const t = report.target;
  const label = t?.label ? t.label.replace(/^\w+ /, '') : (t?.selector ?? '');
  const kind = report.explanation.headline.replace(/^\d+ ms /, '');
  const verb = kind === 'key press' || kind === 'typing' ? 'Typing in' : kind === 'click' || kind === 'tap' ? 'Click on' : kind;
  const subtitle = t?.component ? `in ${t.component}${t.handler ? ` · handler ${t.handler}` : ''}` : undefined;
  return { title: `${verb} ${label}`.trim(), subtitle };
}

function Raw({ report }: { report: InteractionReport }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Raw report</summary>
      {open && <pre>{JSON.stringify(report, null, 1)}</pre>}
    </details>
  );
}

export function Entry({ report, title, subtitle, compact }: { report: InteractionReport; title: string; subtitle?: string; compact?: boolean }) {
  const x = report.explanation;
  const main = report.commits[0] ?? report.followUps[0];
  return (
    <div className="entry">
      <div className="head">
        <div className="title">
          {title}
          {subtitle && <small>{subtitle}</small>}
        </div>
        <div className="big">
          {Math.round(report.duration)}
          <span>ms</span> <Pill rating={x.rating} />
        </div>
      </div>
      <PhaseBar report={report} />
      <p className="cause">{x.cause}</p>
      {x.notes.map((n, i) => (
        <p key={i} className="note">
          {n}
        </p>
      ))}
      {!compact && main && <Components commit={main} />}
      {!compact && <Raw report={report} />}
      <div className="foot">Measuring this cost {report.overheadMs.toFixed(1)} ms.</div>
    </div>
  );
}
