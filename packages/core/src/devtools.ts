import type { InteractionReport } from './types';

const ms = (n: number): string => `${Math.round(n)} ms`;

/**
 * User Timing measures with a `devtools` detail render as custom tracks in the Chrome
 * Performance panel (Chrome 128+). Older Chrome still shows them in the Timings track.
 */
export function emitTrack(r: InteractionReport): void {
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return;
  const x = r.explanation;
  const color = x.rating === 'poor' ? 'error' : x.rating === 'needs-work' ? 'tertiary' : 'primary';
  const main = r.commits.length ? r.commits[0] : null;
  const leaf = main ? main.hotPath[main.hotPath.length - 1] || main.roots[0] || '' : '';
  const properties: [string, string][] = [
    ['Total', ms(r.duration)],
    ['Waiting before the handler', ms(r.inputDelay)],
    ['Handlers and React rendering', ms(r.processing)],
    ['Updating the screen', ms(r.presentation)],
    ['Where', x.where || 'n/a'],
    ['Handler', r.target?.handler || 'n/a'],
    ['React renders before the paint', String(r.commits.length)],
    ['React renders after the paint', String(r.followUps.length)],
  ];
  if (main && main.hotPath.length) properties.push(['Heaviest path', main.hotPath.join(' > ')]);
  try {
    performance.measure(`${x.headline}${leaf ? ' · ' + leaf : ''}`, {
      start: r.start,
      end: Math.max(r.end, r.start + 0.1),
      detail: {
        devtools: {
          dataType: 'track-entry',
          track: 'Interactions',
          trackGroup: 'react-inp-blame',
          color,
          tooltipText: r.verdict,
          properties,
        },
      },
    } as any);
    for (const c of [...r.commits, ...r.followUps]) emitRender(r, c);
  } catch {
    // measures are best effort
  }
}

/** One measure for one React render, in the "React renders" track. */
export function emitRender(r: InteractionReport, c: InteractionReport['commits'][number]): void {
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return;
  try {
    {
      const later = c.at > r.end;
      const name = c.hotPath[c.hotPath.length - 1] || c.roots[0] || 'root';
      const startAt = Math.max(r.start, c.hasDurations ? c.at - c.total : c.at - 0.5);
      performance.measure(`${later ? 'Later render' : 'React render'} · ${name} (${c.rendered} components)`, {
        start: startAt,
        end: c.at,
        detail: {
          devtools: {
            dataType: 'track-entry',
            track: 'React renders',
            trackGroup: 'react-inp-blame',
            color: later ? 'tertiary' : 'secondary',
            tooltipText: `${c.rendered} components rendered${later ? ' after the screen updated' : ''}; heaviest path ${c.hotPath.join(' > ')}`,
            properties: c.components
              .slice(0, 6)
              .map((y) => [y.name, y.self != null ? `${y.count} rendered, ${ms(y.self)}` : `${y.count} rendered`]),
          },
        },
      } as any);
    }
  } catch {
    // measures are best effort
  }
}
