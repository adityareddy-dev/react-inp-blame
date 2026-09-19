import { heaviest } from './commits.js';
import { selector } from './element.js';
import { fiberFromNode, ownersOf } from './fiber.js';
import { page } from './install-state.js';
import type { Blame, CommitSummary, InteractionReport, RenderedComponent } from './types.js';

/**
 * `react-inp-blame/web-vitals`: React component names for the [web-vitals] package, which stays in
 * charge of everything it is good at. It picks which interaction is the page's INP, at what
 * percentile, across the back/forward cache and soft navigations; this entry only says which React
 * components were behind the interaction it picked.
 *
 * Nothing here imports or depends on web-vitals. The two types it needs are declared structurally
 * below, so the entry costs an app that does not use web-vitals nothing, and works with any version
 * that has the fields.
 *
 * [web-vitals]: https://github.com/GoogleChrome/web-vitals
 */

/** The version of the `react` object `attributeINP` adds. It changes when a field is removed or changes meaning; a field added beside the others leaves it as it is. */
const SCHEMA_VERSION = 1;
/**
 * Components named in an owner path: the four **nearest** the element, so a deep tree loses the page
 * and the layout rather than the component that actually renders what was clicked.
 */
const MAX_OWNERS = 4;
/** Components named in a `ReactAttribution`. A report names a culprit; the full list stays on the report. */
const MAX_COMPONENTS = 5;
/** Longest target string. web-vitals caps its own selectors at 100 characters, and these go to the same analytics fields. */
const MAX_TARGET_CHARS = 120;
/** Longest element description inside one, so a long id cannot crowd out the component path. */
const MAX_SELECTOR_CHARS = 60;
/** The ` (` and `)` an element description is wrapped in, counted against the cap so it is never cut open. */
const WRAPPER_CHARS = 3;
const SEPARATOR = ' > ';

/**
 * A web-vitals INP metric, in the fields this entry reads. `INPMetric` and
 * `INPMetricWithAttribution` both satisfy it, and so does the metric Next.js's `useReportWebVitals`
 * hands over, which comes from the build without attribution.
 */
export interface InpMetric<Attribution extends object = Record<string, never>> {
  readonly entries: readonly InpMetricEntry[];
  /** What web-vitals' attribution build adds; absent everywhere else. */
  readonly attribution?: Attribution;
}

/** One Event Timing entry of the metric: `PerformanceEventTiming` satisfies it. */
export interface InpMetricEntry {
  /** Optional only because TypeScript's DOM library does not declare it yet; web-vitals keeps no entry without one. */
  readonly interactionId?: number;
}

/** What React did across a set of commits. */
export interface ReactRenderSummary {
  /** How many commits. */
  readonly count: number;
  /** Component fibers that rendered in them. */
  readonly rendered: number;
  /** What React spent rendering them, ms; null unless it measured every one (development and profiling builds). */
  readonly ms: number | null;
}

/**
 * What this library knows about the interaction web-vitals reported as INP. Deliberately small: the
 * cause, who to look at, and how much React did. The whole report, with the phases, the entries, the
 * long animation frames and the sentences, stays on `reports()`.
 */
export interface ReactAttribution {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  /** Event Timing's id for the interaction, which is what the metric and the report were joined on. */
  readonly interactionId: number;
  /** Where the time mostly went, with the `confidence` that says how much the reading rests on. */
  readonly blame: Blame;
  /** The React handler prop that ran, or the function behind it when its name survived minification. */
  readonly handler: string | null;
  /** The chain carrying most of the rendering, outermost first. */
  readonly hotPath: readonly string[];
  /** The heaviest commit's components, at most 5. */
  readonly components: readonly RenderedComponent[];
  /** React's commits between the input and the paint INP measured. */
  readonly commits: ReactRenderSummary;
  /** Commits that landed after that paint but still belong to the interaction. INP does not count them; people still wait for them. */
  readonly followUps: ReactRenderSummary;
}

export type { Blame, RenderedComponent } from './types.js';

/**
 * web-vitals' `generateTarget` option, which it calls with the element an interaction landed on and
 * writes to `attribution.interactionTarget`. Gives the components enclosing that element, outermost
 * first, and the element itself: `"ProfilePage > PhotoTile (button.tile)"`. A tree deeper than four
 * components keeps the four nearest the element, so the path can begin below the page component.
 *
 *     import { onINP } from 'web-vitals/attribution';
 *     import { generateTarget } from 'react-inp-blame/web-vitals';
 *     onINP(send, { generateTarget });
 *
 * It reads the fiber React stored on the node, so it needs neither `install()` nor any React
 * internals beyond that one property, and never throws: a detached node, a text node, a node from
 * another document and a page with no React all return undefined, which is web-vitals' signal to
 * fall back to its own CSS selector. So does an element whose enclosing components have no names
 * worth printing.
 *
 * Under a production build without the `displayName` transform (`react-inp-blame/next`,
 * `react-inp-blame/vite` or `react-inp-blame/display-names-loader`) the minifier has renamed the
 * components, so the path reads `"a > b (button.tile)"`.
 */
export function generateTarget(node: Node | null): string | undefined {
  if (!node) return undefined;
  try {
    const fiber = fiberFromNode(node);
    if (!fiber) return undefined;
    // Nearest first from the tree React rendered the node in, which is the order a path reads in reverse.
    const path = ownersOf(fiber, MAX_OWNERS).reverse();
    if (!path.length) return undefined;
    const element = selector(node);
    const described = element ? ` (${element.slice(0, MAX_SELECTOR_CHARS)})` : '';
    // Over the cap the outermost components go first: the nearest ones say the most about the element.
    while (path.length > 1 && path.join(SEPARATOR).length + described.length > MAX_TARGET_CHARS) path.shift();
    const components = path.join(SEPARATOR).slice(0, MAX_TARGET_CHARS);
    // What is left for the element, after the brackets it is wrapped in. Budgeted rather than sliced
    // off the end, so a long id is shortened and never leaves a bracket hanging open.
    const room = Math.min(MAX_TARGET_CHARS - components.length - WRAPPER_CHARS, MAX_SELECTOR_CHARS);
    if (!element || room < 1) return components;
    return `${components} (${element.slice(0, room)})`;
  } catch {
    // Reading a node this library was handed is never worth breaking the page's metric over.
    return undefined;
  }
}

/**
 * The metric's attribution with a `react` field added, for a web-vitals INP callback:
 *
 *     import { onINP } from 'web-vitals';
 *     import { attributeINP } from 'react-inp-blame/web-vitals';
 *     onINP((metric) => send({ ...metric, attribution: attributeINP(metric) }));
 *
 * `metric.attribution` is only there on web-vitals' attribution build; without it the result is
 * `{ react }` alone, which is the case under Next.js's `useReportWebVitals`.
 *
 * `react` is null when this library installed nothing on the page, and when it has no report for
 * that interaction: one under `install({ threshold })` that no later render made worth publishing,
 * or one the page has since pushed out of the 50 reports it keeps. It is never a guess.
 *
 * It never throws. A metric missing its entries, or one whose getters throw, gives `react: null`
 * rather than an exception inside the page's own analytics callback.
 */
export function attributeINP<Attribution extends object>(metric: InpMetric<Attribution>): Attribution & { readonly react: ReactAttribution | null } {
  // Copied inside the try, so a metric whose own getters throw still leaves a spreadable object here.
  let attribution = {} as Attribution;
  try {
    attribution = { ...(metric.attribution ?? ({} as Attribution)) };
    const report = Array.isArray(metric.entries) ? reportFor(metric.entries) : null;
    return { ...attribution, react: report && describe(report) };
  } catch {
    // Reading a metric this library was handed is never worth breaking the page's reporting over.
    return { ...attribution, react: null };
  }
}

/**
 * The library's report for the interaction the metric is about, matched on `interactionId`. Both
 * sides read the same Event Timing entries, so the numbers are identical rather than close. Newest
 * first, because an id is reused only after a reload.
 */
function reportFor(entries: readonly InpMetricEntry[]): InteractionReport | null {
  const api = page.installed?.api;
  if (!api) return null;
  const ids = new Set<number>();
  for (const e of entries) if (e?.interactionId) ids.add(e.interactionId);
  if (!ids.size) return null;
  const reports = api.reports();
  for (let i = reports.length - 1; i >= 0; i--) {
    const r = reports[i];
    if (r && ids.has(r.interactionId)) return r;
  }
  return null;
}

/** Frozen, like the report it reads: what a caller forwards to an analytics endpoint is not a thing to edit. */
function describe(r: InteractionReport): ReactAttribution {
  const main = r.commits.length ? heaviest(r.commits) : null;
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    interactionId: r.interactionId,
    // A report explains itself on first read, in this callback rather than in the one that built it.
    blame: r.explanation.blame,
    handler: r.target?.handler ?? null,
    hotPath: main?.hotPath ?? Object.freeze([]),
    components: Object.freeze(main ? main.components.slice(0, MAX_COMPONENTS) : []),
    commits: summarize(r.commits),
    followUps: summarize(r.followUps),
  });
}

function summarize(commits: readonly CommitSummary[]): ReactRenderSummary {
  let rendered = 0;
  let ms = 0;
  // A sum is only a duration when React measured every commit in it.
  let measured = commits.length > 0;
  for (const c of commits) {
    rendered += c.rendered;
    ms += c.total;
    measured &&= c.hasDurations;
  }
  return Object.freeze({ count: commits.length, rendered, ms: measured ? ms : null });
}
