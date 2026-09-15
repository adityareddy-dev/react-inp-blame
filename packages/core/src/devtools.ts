import type { CommitSummary, InteractionReport, RendererInfo } from './types.ts';

/**
 * Entries the Chrome Performance panel draws as custom tracks (Chrome 128+), in a group beside
 * React's own "Scheduler ⚛" and "Components ⚛" tracks.
 */

const TRACK_GROUP = 'react-inp-blame';
// Not "Interactions": that is the name of Chrome's own track.
const INTERACTION_TRACK = 'Interaction blame';
const RENDER_TRACK = 'React renders';

/** The track entry colours DevTools knows. Its documentation leaves out 'warning', which React's own event spans use. */
type Color = 'primary' | 'tertiary' | 'warning' | 'error';

/** `console.timeStamp` as Chrome 134 extended it; lib.dom still declares only the label. */
interface TrackConsole {
  timeStamp(label: string, start: number, end: number, track: string, trackGroup: string, color: Color): void;
}

// The Scheduler priorities React passes with the commit of a discrete or continuous input:
// immediate and user-blocking, 1 and 2 on React 18 and 19, 99 and 98 on React 17. Transitions,
// deferred values and updates from effects or timers all arrive at normal priority or lower.
const BLOCKING_PRIORITIES = [1, 2, 98, 99];

const ms = (n: number): string => `${Math.round(n)} ms`;

export interface Timeline {
  /** Draws what is new about a report: its interaction entry when first seen or when its headline moved, and every render not drawn yet. */
  draw(r: InteractionReport): void;
}

/** `renderers` is read at every draw, because react-dom registers with the hook after install(). */
export function createTimeline(renderers: () => RendererInfo[]): Timeline {
  // Found out at the first draw rather than here, because install() creates the timeline before the app has loaded.
  let timeStampTracks: boolean | null = null;
  const drawnHeadlines = new WeakMap<InteractionReport, string>();
  const drawnCommits = new WeakSet<CommitSummary>();
  return {
    draw(r) {
      if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return;
      if (timeStampTracks === null) timeStampTracks = drawsTimeStampTracks();
      const reactDrawsRenders = timeStampTracks && renderers().some(drawsComponentsTrack);
      try {
        const headline = `${r.start} ${r.end} ${r.type}`;
        if (drawnHeadlines.get(r) !== headline) {
          drawnHeadlines.set(r, headline);
          drawInteraction(r, reactDrawsRenders);
        }
        if (reactDrawsRenders) return;
        for (const c of [...r.commits, ...r.followUps]) {
          if (drawnCommits.has(c)) continue;
          drawnCommits.add(c);
          drawRender(r, c, timeStampTracks);
        }
      } catch {
        // entries are best effort
      }
    },
  };
}

/**
 * One entry from the input to the paint. It is the entry with a tooltip (the verdict) and
 * properties, which `console.timeStamp` cannot carry, so it is always a measure: the same choice
 * React makes for its own entries with details.
 */
function drawInteraction(r: InteractionReport, reactDrawsRenders: boolean): void {
  const x = r.explanation;
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
  if (r.walkMs > 0) properties.push(['react-inp-blame itself', ms(r.walkMs)]);
  measure(`${x.headline}${leaf ? ' · ' + leaf : ''}`, r.start, Math.max(r.end, r.start + 0.1), {
    track: INTERACTION_TRACK,
    color: 'warning',
    tooltipText: reactDrawsRenders ? `${r.verdict} Each component's render is in React's own Components ⚛ track.` : r.verdict,
    properties,
  });
}

/** One entry for one React commit joined to the report. */
function drawRender(r: InteractionReport, c: CommitSummary, timeStampTracks: boolean): void {
  const later = c.at > r.end;
  const name = c.hotPath[c.hotPath.length - 1] || c.roots[0] || 'root';
  const label = `${later ? 'Later render' : 'React render'} · ${name} (${c.rendered} components)`;
  const start = Math.max(r.start, c.hasDurations ? c.at - c.total : c.at - 0.5);
  const color = renderColor(c, later);
  if (timeStampTracks) {
    (console as unknown as TrackConsole).timeStamp(label, start, c.at, RENDER_TRACK, TRACK_GROUP, color);
    return;
  }
  measure(label, start, c.at, {
    track: RENDER_TRACK,
    color,
    tooltipText: `${c.rendered} components rendered${later ? ' after the screen updated' : ''}; heaviest path ${c.hotPath.join(' > ')}`,
    properties: c.components.slice(0, 6).map((y) => [y.name, y.self != null ? `${y.count} rendered, ${ms(y.self)}` : `${y.count} rendered`]),
  });
}

/**
 * React's colours: warning for the event, primary for a blocking render, tertiary for a deferred
 * one, error for a render that threw. Production builds pass no priority, so there the paint
 * decides: a commit before it was the input's own render.
 */
function renderColor(c: CommitSummary, later: boolean): Color {
  if (c.didError) return 'error';
  if (c.priority === undefined) return later ? 'tertiary' : 'primary';
  return BLOCKING_PRIORITIES.includes(c.priority) ? 'primary' : 'tertiary';
}

/** A User Timing measure with the detail DevTools reads, taken back out of the page's buffer once drawn. */
function measure(name: string, start: number, end: number, entry: { track: string; color: Color; tooltipText: string; properties: [string, string][] }): void {
  performance.measure(name, { start, end, detail: { devtools: { dataType: 'track-entry', trackGroup: TRACK_GROUP, ...entry } } });
  // A recording already holds the entry. Left in the buffer, every interaction would add one for the life of the page.
  performance.clearMeasures(name);
}

/**
 * Chrome 134 taught `console.timeStamp` to take a start, an end, a track, a group and a colour,
 * lighter than a measure because nothing enters the page's User Timing buffer. Every other
 * browser, and Chrome before 134, has the one-argument form and ignores the rest, so the method
 * being there proves nothing: the version is the only signal.
 */
function drawsTimeStampTracks(): boolean {
  if (typeof console === 'undefined' || typeof console.timeStamp !== 'function' || typeof navigator === 'undefined') return false;
  const chrome = /Chrome\/(\d+)/.exec(navigator.userAgent);
  return chrome !== null && Number(chrome[1]) >= 134;
}

/** React 19.2 added a Components track of its own, drawn in development builds with `console.timeStamp`. */
function drawsComponentsTrack(renderer: RendererInfo): boolean {
  if (renderer.rendererPackageName !== 'react-dom' || renderer.bundleType !== 1 || !renderer.version) return false;
  const [major, minor] = renderer.version.split('.').map((part) => parseInt(part, 10));
  return major > 19 || (major === 19 && minor >= 2);
}
