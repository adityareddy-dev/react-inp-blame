import { heaviest, leafName } from './commits.js';
import { ms } from './join.js';
import { MAX_QUIET, MAX_REPORTS } from './lifecycle.js';
import type { CommitSummary, InteractionReport, RendererInfo } from './types.js';
import { parseReactVersion } from './version.js';

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

// The Scheduler priorities React 18 and 19 pass with the commit of a discrete or continuous input:
// immediate and user-blocking. Transitions, deferred values and updates from effects or timers all
// arrive at normal priority or lower. React 17 passes immediate priority with every commit of a legacy
// root, whatever caused it, so its priorities are not read.
const BLOCKING_PRIORITIES = [1, 2];

// Interactions whose drawn headline is remembered: every one the lifecycle can still revise, so a
// revision of a report is never drawn as if it were new.
const REMEMBERED_HEADLINES = MAX_REPORTS + MAX_QUIET;

export interface Timeline {
  /** Draws what is new about a report: its interaction entry when first seen or when its headline moved, and every render not drawn yet. */
  draw(r: InteractionReport): void;
}

/** `renderers` is read at every draw, because react-dom registers with the hook after install(). */
export function createTimeline(renderers: () => RendererInfo[]): Timeline {
  // Found out at the first draw rather than here, because install() creates the timeline before the app has loaded.
  let timeStampTracks: boolean | null = null;
  // By interactionId, because every revision of a report is a new object.
  const drawnHeadlines = new Map<number, string>();
  // A commit is the same object in every revision and report that holds it.
  const drawnCommits = new WeakSet<CommitSummary>();
  return {
    draw(r) {
      if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return;
      if (timeStampTracks === null) timeStampTracks = drawsTimeStampTracks();
      const known = renderers();
      // React draws its Components track only for the commits it measured.
      const measured = r.commits.some((c) => c.hasDurations) || r.followUps.some((c) => c.hasDurations);
      const reactDrawsRenders = timeStampTracks && measured && known.some(drawsComponentsTrack);
      const readPriorities = !known.some(isReact17Dom);
      try {
        const headline = `${r.start} ${r.end} ${r.type}`;
        if (drawnHeadlines.get(r.interactionId) !== headline) {
          // Re-inserted, so the limit forgets the interaction drawn longest ago.
          drawnHeadlines.delete(r.interactionId);
          drawnHeadlines.set(r.interactionId, headline);
          if (drawnHeadlines.size > REMEMBERED_HEADLINES) drawnHeadlines.delete(drawnHeadlines.keys().next().value as number);
          drawInteraction(r, reactDrawsRenders);
        }
        if (reactDrawsRenders) return;
        for (const c of [...r.commits, ...r.followUps]) {
          if (drawnCommits.has(c)) continue;
          drawnCommits.add(c);
          drawRender(r, c, timeStampTracks, readPriorities);
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
  // The commit the verdict's blame names, so the entry's name never contradicts its tooltip.
  const main = r.commits.length ? heaviest(r.commits) : null;
  const leaf = main ? (leafName(main) ?? '') : '';
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
function drawRender(r: InteractionReport, c: CommitSummary, timeStampTracks: boolean, readPriorities: boolean): void {
  const later = c.at > r.end;
  const name = leafName(c) ?? 'root';
  const label = `${later ? 'Later render' : c.hydrated ? 'Hydration' : 'React render'} · ${name} (${c.rendered} components)`;
  const start = Math.max(r.start, c.hasDurations ? c.at - c.total : c.at - 0.5);
  const color = renderColor(c, later, readPriorities);
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
 * one, error for a render that threw. Where the priority says nothing (production builds pass none,
 * and React 17 passes the same one with every commit), the paint decides: a commit before it was the
 * input's own render.
 */
function renderColor(c: CommitSummary, later: boolean, readPriorities: boolean): Color {
  if (c.didError) return 'error';
  if (!readPriorities || c.priority === undefined) return later ? 'tertiary' : 'primary';
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

/**
 * React 19.2 added a Components track of its own, drawn with `console.timeStamp` for each component it
 * measured: every one in a development build, the trees in ProfileMode in a profiling build. A production
 * build measures nothing and draws nothing. So beside react-dom 19.2 or later, the renders of a report
 * whose commits carry durations are drawn by React already.
 */
function drawsComponentsTrack(renderer: RendererInfo): boolean {
  if (renderer.rendererPackageName !== 'react-dom') return false;
  const version = parseReactVersion(renderer.version);
  return version !== null && (version.major > 19 || (version.major === 19 && version.minor >= 2));
}

/** React 17 passes the same priority with every commit of a legacy root, so there the priority says nothing about the commit. */
function isReact17Dom(renderer: RendererInfo): boolean {
  return renderer.rendererPackageName === 'react-dom' && parseReactVersion(renderer.version)?.major === 17;
}
