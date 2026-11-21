import { readableName } from './commits.js';
import { page } from './install-state.js';
import type { InteractionReport } from './types.js';
import { attributeINP } from './web-vitals.js';

/**
 * `react-inp-blame/otel`, experimental: the blame for the interaction behind an INP event, as flat
 * `react_inp_blame.*` attributes on the event an OpenTelemetry setup already sends. The web vitals
 * instrumentation's log record gets them through `InpBlameLogRecordProcessor`, and a hook that is
 * handed the metric, the record or the interaction's time gets them from `inpBlameAttributes`.
 *
 * Experimental: the export names and the attribute names can change in any minor release, 1.x
 * included, until OpenTelemetry names fields for an interaction's target or a component. Nothing here
 * imports OpenTelemetry, Honeycomb, Faro or web-vitals. Every input type is structural, as in
 * `react-inp-blame/web-vitals`, so the entry works with any version that has the fields.
 */

/** The attributes for one INP event, every name under `react_inp_blame.`, strings and numbers only. Frozen. */
export type InpBlameAttributes = Readonly<Record<`react_inp_blame.${string}`, string | number>>;

/** A web-vitals metric, in the fields read here. web-vitals' `Metric` and `INPMetric`, with attribution or without, all fit. */
export interface InpMetricLike {
  readonly name?: string;
  readonly entries: readonly object[];
}

/**
 * A `browser.web_vital` log record, in the fields read here: the SDK's record a processor gets, or the
 * plain record an instrumentation's `applyCustomLogRecordData` hook gets.
 */
export interface InpLogRecordLike {
  readonly attributes?: { readonly [key: string]: unknown };
  /** The SDK's own copy of `timestamp`, as seconds and nanoseconds since the epoch. */
  readonly hrTime?: readonly [number, number];
  /** When the interaction began, as the instrumentation stamped it: ms, an HrTime or a Date. */
  readonly timestamp?: unknown;
  setAttributes?(attributes: InpBlameAttributes): unknown;
}

/**
 * What `inpBlameAttributes` and `InpBlameLogRecordProcessor` send beyond timings, counts and fixed
 * categories. Without it no name the app wrote goes out.
 */
export interface InpBlameOptions {
  /**
   * The names the app approves for export, in `blame.name`, `blame.detail`, `handler`,
   * `target.components` and `hot_path`: a list of the names themselves, or a function handed each name
   * and the attribute it would go in, which approves it by returning `true`. In a path each component is
   * approved on its own, and the ones left out are skipped. A name not approved stays on the page, and so
   * does every name where the function throws. `() => true` sends every name, as 1.0 did.
   */
  readonly labels?: readonly string[] | ((label: string, attribute: `react_inp_blame.${string}`) => boolean);
}

const PREFIX = 'react_inp_blame.';
const EMPTY: InpBlameAttributes = Object.freeze({});
/**
 * How far apart a record's time and value can be from a report's start and duration and still be the
 * same interaction: the library's own window for matching an input's time. The trip through an SDK's
 * HrTime and back costs about 0.0001 ms.
 */
const MATCH_MS = 1;
/** Components in `target.components`: the four nearest the element, as `generateTarget` names them. */
const MAX_OWNERS = 4;
/** Longest `target.components` or `hot_path`, as `generateTarget` caps its own. */
const MAX_CHARS = 120;
const SEPARATOR = ' > ';

/**
 * The attributes for the interaction an INP event is about, from this library's report on it:
 *
 *     new WebVitalsInstrumentation({
 *       applyCustomLogRecordData: (record) => {
 *         record.attributes = { ...record.attributes, ...inpBlameAttributes(record) };
 *       },
 *     });
 *
 * A web-vitals metric (Honeycomb's `applyCustomAttributes` hands one over) is matched on its entries'
 * `interactionId`. A log record, or a number, is matched on time: the record's timestamp, which the
 * instrumentation takes from web-vitals' `attribution.interactionTime`, or that time itself, as Faro
 * sends it in `interaction_time`. A report matches where it started less than 1 ms from that time and,
 * where the record carries `browser.web_vital.value`, lasted within 1 ms of that value. Never
 * the nearest report: no report fits, no blame.
 *
 * `{}` for anything that is not INP. Otherwise `react_inp_blame.status` is always there: `matched`,
 * `not-installed` where the library installed nothing on the page, `sampled-out` where the page lost
 * the `sampleRate` roll, `no-report` where no report fits, or `library-error` where the library could
 * not explain the report or could not read the source. Nothing else is added unless it matched.
 *
 * By default only timings, counts and fixed categories: the blame's kind, confidence and ms, the React
 * status and build, and the commits' and follow-ups' counts and ms. Component, handler and script names
 * go out only where `options.labels` approves them. Never the element's label, text or selector, a
 * sentence, or a URL's query. A script's name is the browser's for its listener, element id included
 * (`DIV#root.onclick`) or, with no id, its `src` (`IMG[src="/avatars/jane.png"].onload`), or a
 * script's URL. A URL loses its password, query and fragment, as the report gives it, but keeps its
 * path, so an id or a path built from user data goes out as the page wrote it once approved. It never
 * throws.
 *
 * Experimental: the names can change in any minor release, 1.x included, until OpenTelemetry names
 * these fields.
 */
export function inpBlameAttributes(source: InpMetricLike | InpLogRecordLike | number | null | undefined, options?: InpBlameOptions): InpBlameAttributes {
  let inp = false;
  try {
    // A metric named INP is INP's before its entries are read, so one whose entries throw is the library's error.
    inp = (source as InpMetricLike | null)?.name === 'INP' || isInp(source);
    if (!inp) return EMPTY;
    const api = page.installed?.api;
    if (!api) return status(page.sampledOut ? 'sampled-out' : 'not-installed');
    const reports = api.reports();
    const entries = typeof source === 'object' ? (source as InpMetricLike).entries : undefined;
    const report = Array.isArray(entries) ? byId(reports, entries) : byTime(reports, source as InpLogRecordLike | number);
    if (!report) return status('no-report');
    // The same frozen summary react-inp-blame/web-vitals gives, found again by the id just matched.
    const react = attributeINP({ entries: [{ interactionId: report.interactionId }] }).react;
    if (!react) return status('library-error');
    const { blame, commits, followUps } = react;
    const approves = approval(options?.labels);
    const named = (name: string, label: string | null) => (label != null && approves(label, name) ? label : null);
    const each = (name: string, labels: readonly string[]) => labels.filter((label) => approves(label, name));
    const all: Record<string, string | number | null> = {
      status: 'matched',
      'blame.kind': blame.kind,
      'blame.name': named('blame.name', blame.name),
      'blame.detail': named('blame.detail', blame.detail),
      'blame.ms': blame.ms,
      'blame.confidence': blame.confidence,
      handler: named('handler', react.handler),
      'target.components': capped(componentPath(each('target.components', report.target?.owners ?? []))),
      hot_path: capped(each('hot_path', react.hotPath)),
      react_status: report.reactStatus,
      react_build: react.reactBuild,
      'commits.count': commits.count,
      'commits.rendered': commits.rendered,
      'commits.ms': commits.ms,
      'follow_ups.count': followUps.count,
      'follow_ups.ms': followUps.ms,
    };
    const out: Record<string, string | number> = {};
    // A null is left out rather than sent, since some backends store it as the text "null".
    for (const name in all) if (all[name] != null && all[name] !== '') out[PREFIX + name] = all[name]!;
    return Object.freeze(out);
  } catch {
    // A hook inside someone else's telemetry pipeline is never worth breaking it over.
    return inp ? status('library-error') : EMPTY;
  }
}

/**
 * A LogRecordProcessor for an OpenTelemetry LoggerProvider: adds `inpBlameAttributes` to each
 * `browser.web_vital` INP record and leaves every other record as it is.
 *
 *     new LoggerProvider({ processors: [new InpBlameLogRecordProcessor(), new BatchLogRecordProcessor({ exporter })] });
 *
 * Put it first in `processors`: a processor that exports as the record is emitted, like
 * `SimpleLogRecordProcessor`, has sent it by the time a later one runs. It never throws, since a throw
 * would keep the record from every processor after it, the exporter included.
 *
 * Names go out only where `options.labels` approves them, as for `inpBlameAttributes`.
 *
 * Experimental: the names can change in any minor release, 1.x included, until OpenTelemetry names
 * these fields.
 */
export class InpBlameLogRecordProcessor {
  private readonly options: InpBlameOptions | undefined;

  constructor(options?: InpBlameOptions) {
    this.options = options;
  }

  onEmit(record: InpLogRecordLike): void {
    try {
      const attributes = inpBlameAttributes(record, this.options);
      if (!Object.keys(attributes).length) return;
      if (typeof record.setAttributes === 'function') record.setAttributes(attributes);
      else Object.assign(record.attributes as object, attributes);
    } catch {
      // The record goes on without them.
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const status = (value: string): InpBlameAttributes => Object.freeze({ [`${PREFIX}status`]: value });

/**
 * Whether the app approves a name for the attribute it would go in. Only a list or a function the app
 * passed approves anything, and a function only by returning `true`: a throw approves nothing.
 */
function approval(labels: InpBlameOptions['labels']): (label: string, name: string) => boolean {
  if (typeof labels === 'function') {
    return (label, name) => {
      try {
        return labels(label, `${PREFIX}${name}`) === true;
      } catch {
        return false;
      }
    };
  }
  if (!Array.isArray(labels) || !labels.length) return () => false;
  const approved = new Set<unknown>(labels);
  return (label) => approved.has(label);
}

/** A metric named anything but INP, a record for another web vital, and anything neither an object nor a number, are not INP. */
function isInp(source: unknown): boolean {
  if (typeof source === 'number') return true;
  if (!source || typeof source !== 'object') return false;
  const { entries, name } = source as InpMetricLike;
  if (Array.isArray(entries)) return typeof name !== 'string' || name === 'INP';
  const vital = (source as InpLogRecordLike).attributes?.['browser.web_vital.name'];
  return typeof vital === 'string' && vital.toLowerCase() === 'inp';
}

/** The newest report that passes, as react-inp-blame/web-vitals matches: an id comes back only after a reload. */
const newest = (reports: readonly InteractionReport[], passes: (r: InteractionReport) => boolean): InteractionReport | undefined =>
  [...reports].reverse().find((r) => r && passes(r));

function byId(reports: readonly InteractionReport[], entries: readonly object[]): InteractionReport | undefined {
  const ids = new Set(entries.map((e) => (e as { interactionId?: unknown } | null)?.interactionId));
  return newest(reports, (r) => ids.has(r.interactionId));
}

/**
 * Matched on what both sides read from the same Event Timing entry: the record's time is the entry's
 * start, and its value the entry's duration. The report's headline entry first, then any of its
 * entries, for two entries of one interaction that paint in one frame at the same duration.
 */
function byTime(reports: readonly InteractionReport[], source: InpLogRecordLike | number): InteractionReport | undefined {
  const time = typeof source === 'number' ? relative(source) : timeOf(source);
  const value = typeof source === 'number' ? undefined : source.attributes?.['browser.web_vital.value'];
  const fits = (start: number, duration: number) => Math.abs(start - time) < MATCH_MS && (typeof value !== 'number' || Math.abs(duration - value) < MATCH_MS);
  return newest(reports, (r) => fits(r.start, r.duration)) ?? newest(reports, (r) => r.entries.some((e) => fits(e.startTime, e.duration)));
}

/** A record's time on the `performance.now()` clock, from the shape it came in, or NaN, which matches nothing. */
function timeOf({ hrTime, timestamp }: InpLogRecordLike): number {
  const hr = (Array.isArray(hrTime) ? hrTime : timestamp) as readonly number[];
  if (Array.isArray(hr)) return hr[0]! * 1e3 + hr[1]! / 1e6 - performance.timeOrigin;
  if (typeof timestamp === 'number') return relative(timestamp);
  return timestamp instanceof Date ? timestamp.getTime() - performance.timeOrigin : NaN;
}

/** Ms since the page's time origin, as a hook sees `interactionTime`, or epoch ms, which is far larger. */
const relative = (ms: number): number => (ms < performance.timeOrigin / 2 ? ms : ms - performance.timeOrigin);

/** The components around what was clicked, outermost first: the four nearest a reader could search for, without the element. */
function componentPath(owners: readonly string[]): string[] {
  const readable = owners.filter(readableName);
  return (readable.length ? readable : [...owners]).slice(0, MAX_OWNERS).reverse();
}

/** Joined, with the outermost names dropped first past the cap, since the nearest say the most. */
function capped(path: string[]): string {
  while (path.length > 1 && path.join(SEPARATOR).length > MAX_CHARS) path.shift();
  return path.join(SEPARATOR).slice(0, MAX_CHARS);
}
