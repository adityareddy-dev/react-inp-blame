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
 * Only component, handler and script names and numbers: never the element's label, text or selector,
 * a sentence or a URL. A script's name is the browser's for its listener, element id included
 * (`DIV#root.onclick`), as the report gives it. It never throws.
 *
 * Experimental: the names can change in any minor release, 1.x included, until OpenTelemetry names
 * these fields.
 */
export function inpBlameAttributes(source: InpMetricLike | InpLogRecordLike | number | null | undefined): InpBlameAttributes {
  let inp = false;
  try {
    inp = isInp(source);
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
    const out: Record<string, string | number> = {};
    // A null is left out rather than sent, since some backends store it as the text "null".
    const put = (name: string, value: string | number | null | undefined) => {
      if (value !== null && value !== undefined && value !== '') out[PREFIX + name] = value;
    };
    put('status', 'matched');
    put('blame.kind', react.blame.kind);
    put('blame.name', react.blame.name);
    put('blame.detail', react.blame.detail);
    put('blame.ms', react.blame.ms);
    put('blame.confidence', react.blame.confidence);
    put('handler', react.handler);
    put('target.components', capped(componentPath(report.target?.owners ?? [])));
    put('hot_path', capped([...react.hotPath]));
    put('react_status', report.reactStatus);
    put('react_build', react.reactBuild);
    put('commits.count', react.commits.count);
    put('commits.rendered', react.commits.rendered);
    put('commits.ms', react.commits.ms);
    put('follow_ups.count', react.followUps.count);
    put('follow_ups.ms', react.followUps.ms);
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
 *     new LoggerProvider({ processors: [new InpBlameLogRecordProcessor(), new BatchLogRecordProcessor(exporter)] });
 *
 * Put it first in `processors`: a processor that exports as the record is emitted, like
 * `SimpleLogRecordProcessor`, has sent it by the time a later one runs. It never throws, since a throw
 * would keep the record from every processor after it, the exporter included.
 *
 * Experimental: the names can change in any minor release, 1.x included, until OpenTelemetry names
 * these fields.
 */
export class InpBlameLogRecordProcessor {
  onEmit(record: InpLogRecordLike): void {
    try {
      const attributes = inpBlameAttributes(record);
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

/** A metric named anything but INP, a record for another web vital, and anything neither an object nor a number, are not INP. */
function isInp(source: unknown): boolean {
  if (typeof source === 'number') return true;
  if (!source || typeof source !== 'object') return false;
  const { entries, name } = source as InpMetricLike;
  if (Array.isArray(entries)) return typeof name !== 'string' || name === 'INP';
  const vital = (source as InpLogRecordLike).attributes?.['browser.web_vital.name'];
  return typeof vital === 'string' && vital.toLowerCase() === 'inp';
}

/** Newest first, as react-inp-blame/web-vitals matches: an id comes back only after a reload. */
function byId(reports: readonly InteractionReport[], entries: readonly object[]): InteractionReport | null {
  const ids = new Set<number>();
  for (const e of entries) {
    const id = (e as { interactionId?: unknown } | null)?.interactionId;
    if (typeof id === 'number' && id > 0) ids.add(id);
  }
  for (let i = reports.length - 1; i >= 0; i--) {
    const r = reports[i];
    if (r && ids.has(r.interactionId)) return r;
  }
  return null;
}

/**
 * Matched on what both sides read from the same Event Timing entry: the record's time is the entry's
 * start, and its value the entry's duration. The report's headline entry first, then any of its
 * entries, for two entries of one interaction that paint in one frame at the same duration.
 */
function byTime(reports: readonly InteractionReport[], source: InpLogRecordLike | number): InteractionReport | null {
  const time = typeof source === 'number' ? relative(source) : timeOf(source);
  if (time === null) return null;
  const value = typeof source === 'number' ? undefined : source.attributes?.['browser.web_vital.value'];
  const fits = (start: number, duration: number) => Math.abs(start - time) < MATCH_MS && (typeof value !== 'number' || Math.abs(duration - value) < MATCH_MS);
  for (let i = reports.length - 1; i >= 0; i--) {
    const r = reports[i];
    if (r && fits(r.start, r.duration)) return r;
  }
  for (let i = reports.length - 1; i >= 0; i--) {
    const r = reports[i];
    if (r && r.entries.some((e) => fits(e.startTime, e.duration))) return r;
  }
  return null;
}

/** A record's time on the `performance.now()` clock, from the shape it came in; null for none. */
function timeOf(record: InpLogRecordLike): number | null {
  const { hrTime, timestamp } = record;
  const hr = Array.isArray(hrTime) ? hrTime : Array.isArray(timestamp) ? (timestamp as readonly unknown[]) : null;
  if (hr) return typeof hr[0] === 'number' && typeof hr[1] === 'number' ? hr[0] * 1e3 + hr[1] / 1e6 - performance.timeOrigin : null;
  if (typeof timestamp === 'number') return relative(timestamp);
  if (timestamp instanceof Date) return timestamp.getTime() - performance.timeOrigin;
  return null;
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
