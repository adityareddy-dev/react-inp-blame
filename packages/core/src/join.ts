import { fiberFromNode, handlerOf, ownersOf } from './fiber.js';
import { rateInp } from './inp.js';
import type { PageNavigation } from './navigation.js';
import type { InteractionTiming } from './observe.js';
import type { Blame, CommitSummary, EventEntrySummary, Explanation, FrameSummary, InputRecord, InteractionReport, Phase, ScriptSummary, StartedNavigation, TargetInfo } from './types.js';

export const FOLLOW_UP_WINDOW = 1500;
// A commit's input stamp and an entry's startTime are the same clock (Event.timeStamp), so
// they agree to the timer's resolution; 1 ms covers the coarsening.
const STAMP_TOLERANCE = 1;
// Entries presented in the same frame share a render time to within 8 ms, the rounding
// Event Timing applies to durations. Same rule as web-vitals' groupEntriesByRenderTime.
const RENDER_GROUP_MS = 8;

// What the explanation blames and says is decided by the thresholds below. Each is a judgement of
// what is worth naming; the reasons were checked against the demo's scenarios on React 17, 18 and
// 19, development and production builds, with this library's own walk left out of `processing`.

// Working time outside React's render names the handler from 25 ms: shorter, it does not make an
// interaction slow on its own (it is under two frames at 60 Hz).
const HANDLER_MIN_MS = 25;
// It also has to be a quarter of the working time: committing a large render (DOM writes, effects)
// is outside React's render durations too, and took a fifth of it on the demo's 1441-row list.
const HANDLER_MIN_SHARE = 0.25;
// A render with durations earns the blame from 5 ms, a third of a frame; less made nothing slow.
const RENDER_MIN_MS = 5;
// A render known only by its counts earns it from 10 components; fewer is a small update, a counter or a status line.
const RENDER_MIN_COMPONENTS = 10;
// From 50 when a handler is named, since counts cannot weigh a render against a slow handler: the
// demo's password field re-renders 2 components beside a handler that runs for 110 ms.
const RENDER_MIN_COMPONENTS_BESIDE_HANDLER = 50;
// A Long Animation Frames script is named from 20 ms of it inside the interaction: the API lists
// scripts from 5 ms, and one under 20 did not make its frame long by itself (a long frame is over 50 ms).
const SCRIPT_MIN_MS = 20;
// Waiting, the screen update, and working time without durations are blamed from 50 ms, the length
// of a long task: the least the browser itself calls long.
const LONG_TASK_MS = 50;
// A later render is worth a sentence from 10 ms or 25 components. Less is the page settling after the
// paint, a spinner going away or a status line changing, which is not what anyone was waiting for.
const LATER_MIN_MS = 10;
const LATER_MIN_COMPONENTS = 25;
// Forced layout is worth a sentence from 4 ms, a quarter of a frame.
const FORCED_LAYOUT_MIN_MS = 4;
// The screen update gets a note of its own from 100 ms, half of INP's 200 ms budget for "good".
const PRESENTATION_NOTE_MS = 100;
// A press held around the interaction is worth a note from 100 ms; an ordinary click is shorter.
const HOLD_NOTE_MS = 100;
// A later render without durations is given a frame's length, to find the long animation frames it ran in.
const FRAME_MS = 16;

// A label names the clicked element; it is not a copy of it. The element can be a list of 3000
// rows, and reading all of its text would cost more than the rest of the report, so at most its
// first run of text is read, and at most 40 characters of any label are kept.
const LABEL_CHARS = 40;
// Nodes the search for that first run of text looks at: enough to get past an icon, not to crawl a table.
const LABEL_NODES = 32;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
// The attributes tests select elements by. A selector names the one an element has.
const TEST_ATTRIBUTES = ['data-test', 'data-testid'];
const PREFERRED = ['click', 'keydown', 'input', 'keypress', 'keyup', 'pointerup', 'mouseup', 'pointerdown', 'mousedown'];
const FRIENDLY: Record<string, string> = {
  click: 'click',
  mousedown: 'click',
  mouseup: 'click',
  pointerdown: 'tap',
  pointerup: 'tap',
  keydown: 'key press',
  keyup: 'key press',
  keypress: 'key press',
  input: 'typing',
  change: 'typing',
};
const TYPING_EVENTS = ['keydown', 'keyup', 'keypress', 'input', 'change'];
const POINTER_EVENTS = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'];

/** Where a target's label may come from, once `InstallOptions.labels` is settled for the page's React build. */
export type LabelSource = 'text' | 'attributes';

/**
 * A report's fields apart from the explanation and verdict. The functions below take and return
 * these and never change one; the lifecycle seals each revision into the report it publishes.
 */
export type ReportData = Omit<InteractionReport, 'explanation' | 'verdict'>;

interface PaintGroup {
  renderTime: number;
  processingStart: number;
  processingEnd: number;
  entries: InteractionTiming[];
}

/** What a person would call the interaction: "click", "tap", "key press" or "typing", from the event type. Display text. */
export function kindOf(type: string): string {
  return FRIENDLY[type] || type;
}

/** A key press or typing, decided on the event type, not on the words `kindOf` picks. */
export const isTypingEvent = (type: string): boolean => TYPING_EVENTS.includes(type);

/** A click or a tap, decided on the event type. */
export const isPointerEvent = (type: string): boolean => POINTER_EVENTS.includes(type);

/** A later render worth a sentence, rather than the page settling after the paint. */
const worthMentioning = (c: CommitSummary) => (c.hasDurations ? c.total >= LATER_MIN_MS : c.rendered >= LATER_MIN_COMPONENTS);

/** A render with real work in it, the kind the blame and the "rendered N times" note count; a status pill updating is not one. */
export const carriesWork = (c: CommitSummary) => (c.hasDurations ? c.total >= RENDER_MIN_MS : c.rendered >= RENDER_MIN_COMPONENTS);

/** A commit whose numbers stand on their own: durations measured on a clock fine enough for them, joined by its exact input stamp, walked in full. */
const measuredCommit = (c: CommitSummary) => c.hasDurations && !c.coarseClock && c.joinedBy === 'exact' && !c.truncated;

/** Entries whose paint landed within 8 ms of each other were presented by one frame. */
function groupByRenderTime(entries: readonly InteractionTiming[]): PaintGroup[] {
  const groups: PaintGroup[] = [];
  for (const e of entries) {
    const renderTime = e.startTime + e.duration;
    let group: PaintGroup | undefined;
    for (let i = groups.length - 1; i >= 0 && !group; i--) {
      const g = groups[i];
      if (g && Math.abs(renderTime - g.renderTime) <= RENDER_GROUP_MS) group = g;
    }
    if (group) {
      group.processingStart = Math.min(group.processingStart, e.processingStart);
      group.processingEnd = Math.max(group.processingEnd, e.processingEnd);
      group.entries.push(e);
    } else {
      groups.push({ renderTime, processingStart: e.processingStart, processingEnd: e.processingEnd, entries: [e] });
    }
  }
  return groups;
}

/** The paint group `entry` falls in. */
function paintGroupOf(entries: readonly InteractionTiming[], entry: InteractionTiming): PaintGroup {
  for (const group of groupByRenderTime(entries)) if (group.entries.includes(entry)) return group;
  return { renderTime: entry.startTime + entry.duration, processingStart: entry.processingStart, processingEnd: entry.processingEnd, entries: [entry] };
}

const near = (a: number, b: number) => Math.abs(a - b) <= STAMP_TOLERANCE;

/** Does this input stamp, a commit's or a navigation's (or the press that input released), match one of these entry start times? */
function stampMatches(c: Pick<CommitSummary, 'inputTs' | 'gestureTs'>, stamps: number[]): boolean {
  for (const s of stamps) if (near(s, c.inputTs) || near(s, c.gestureTs)) return true;
  return false;
}

const rank = (name: string) => {
  const i = PREFERRED.indexOf(name);
  return i < 0 ? PREFERRED.length : i;
};

const summarize = (e: InteractionTiming): EventEntrySummary =>
  Object.freeze({
    name: e.name,
    startTime: e.startTime,
    duration: e.duration,
    processingStart: e.processingStart,
    processingEnd: e.processingEnd,
  });

const walked = (commits: readonly CommitSummary[]): number => commits.reduce((a, c) => a + c.walkMs, 0);

/** Each commit's copy per way of joining, so every report and revision holding a commit holds the same frozen object. */
const joinedCopies = new WeakMap<CommitSummary, { exact?: CommitSummary; overlap?: CommitSummary }>();

/** The commit as a report holds it: stamped with how it joined that report. */
function joined(c: CommitSummary, by: 'exact' | 'overlap'): CommitSummary {
  let copies = joinedCopies.get(c);
  if (!copies) joinedCopies.set(c, (copies = {}));
  return (copies[by] ??= Object.freeze({ ...c, joinedBy: by }));
}

/** The first entry target still in the DOM. Event Timing reports null for a node that has left it. */
function entryTarget(entries: readonly InteractionTiming[]): Node | null {
  for (const e of entries) if (e.target) return e.target;
  return null;
}

/** The input in the ring that one of these entries is, by its timestamp. */
function ringInput(inputs: readonly InputRecord[], stamps: number[]): InputRecord | null {
  return inputs.find((i) => stamps.some((s) => near(s, i.ts))) ?? null;
}

/** The element an interaction landed on: an entry's target, or the node the ring kept when the entries' target has left the DOM. */
export function interactionTarget(entries: readonly InteractionTiming[], inputs: readonly InputRecord[]): Node | null {
  return entryTarget(entries) ?? ringInput(inputs, entries.map((e) => e.startTime))?.target ?? null;
}

/**
 * One report's data from every Event Timing entry seen for an interactionId. The headline is the
 * longest single entry, which is the number web-vitals reports as INP for the interaction;
 * `inputs` is the ring of recent inputs, used to tell whose commit is whose and to recover
 * the target when the entry's is gone; `navigations` are the page's, oldest first, to say which
 * one the interaction happened in and which one it started.
 */
export function buildReport(
  entries: readonly InteractionTiming[],
  commits: readonly CommitSummary[],
  frames: readonly FrameSummary[] | null,
  inputs: readonly InputRecord[] = [],
  labels: LabelSource = 'attributes',
  navigations: readonly PageNavigation[] = [],
): ReportData {
  const longest = entries.reduce((a, e) => (e.duration > a.duration ? e : a));
  const group = paintGroupOf(entries, longest);
  // The same clamps web-vitals applies: processing cannot start before this entry's input,
  // and cannot run past the paint that closed it (a sync modal can make it look that way).
  const start = longest.startTime;
  const processingStart = Math.max(group.processingStart, start);
  const end = Math.max(start + longest.duration, processingStart);
  const processingEnd = Math.min(group.processingEnd, end);
  const duration = longest.duration;
  let first = Infinity;
  let lastPaint = -Infinity;
  for (const e of entries) {
    first = Math.min(first, e.startTime);
    lastPaint = Math.max(lastPaint, e.startTime + e.duration);
  }
  const holdMs = Math.max(0, lastPaint - first - duration);

  // A click arrives as pointerdown, pointerup and click entries sharing one interactionId.
  // Name the interaction by the most meaningful entry painted with the headline.
  const sorted = group.entries.slice().sort((a, b) => rank(a.name) - rank(b.name));
  const stamps = entries.map((e) => e.startTime);
  const ring = ringInput(inputs, stamps);
  // The entry's target is null when the node left the DOM before the observer ran (a close button, a
  // deleted row). The ring kept the node, and what React said about it at dispatch: by the time the
  // entry arrives, React 18 and 19 have cleared the links and props of a deleted fiber.
  const live = entryTarget(entries);
  const targetNode = live ?? ring?.target ?? null;
  const fiber = live && fiberFromNode(live);
  let owners: readonly string[] = [];
  let handler: string | null = null;
  if (fiber) {
    owners = ownersOf(fiber);
    for (const e of sorted) {
      handler = handlerOf(fiber, e.name);
      if (handler) break;
    }
  } else if (ring) {
    owners = ring.owners;
    for (const e of sorted) {
      handler = inputs.find((i) => i.type === e.name && near(i.ts, e.startTime))?.handler ?? null;
      if (handler) break;
    }
  }

  // Durations are rounded to 8 ms but processingEnd is exact, so a commit inside the
  // handlers is before the paint even when the rounded paint time says otherwise.
  const paintBound = Math.max(end, group.processingEnd);
  const inWindow: CommitSummary[] = [];
  const followUps: CommitSummary[] = [];
  for (const c of commits) {
    if (stampMatches(c, stamps)) {
      // Work before the headline entry's own input (a press held before a click) is not
      // part of what INP measured for it; `holdMs` covers that time.
      if (c.at < start - STAMP_TOLERANCE) continue;
      if (c.at <= paintBound) inWindow.push(joined(c, 'exact'));
      else if (c.at - start <= FOLLOW_UP_WINDOW && worthMentioning(c)) followUps.push(joined(c, 'exact'));
    } else if (c.at >= processingStart - STAMP_TOLERANCE && c.at <= paintBound && !claimedElsewhere(c, inputs, stamps)) {
      // No stamp matched, but it ran between this interaction's handlers and its paint.
      inWindow.push(joined(c, 'overlap'));
    }
  }
  // The walk runs inside React's commit, so the walk of a commit during the handlers sits inside
  // the processing time the browser measured. That time is this library's, not the page's.
  let walkMs = 0;
  for (const c of inWindow) walkMs += Math.max(0, Math.min(c.at + c.walkMs, processingEnd) - Math.max(c.at, processingStart));
  // Placed by its first input: a click that starts a navigation happened on the page it left.
  const navigation = navigationAt(navigations, first);

  return {
    schemaVersion: 1,
    interactionId: longest.interactionId,
    type: (sorted[0] ?? longest).name,
    start,
    end,
    duration,
    holdMs,
    entries: Object.freeze(entries.map(summarize)),
    inputDelay: processingStart - start,
    processing: processingEnd - processingStart - walkMs,
    walkMs,
    presentation: end - processingEnd,
    target: targetNode ? describeTarget(targetNode, owners, handler, labels) : null,
    navigationURL: navigation?.url ?? '',
    navigationType: navigation?.type ?? 'navigate',
    startedNavigation: navigationStartedBy(navigations, stamps),
    commits: Object.freeze(inWindow),
    followUps: Object.freeze(followUps),
    frames: frames && Object.freeze(frames.filter((f) => f.start < end && f.start + f.duration > start)),
    laterFrames: frames && framesForLater(followUps, frames),
    revision: 0,
    overheadMs: walked(inWindow) + walked(followUps),
  };
}

/** The report a revision is published as: frozen, with its explanation and verdict built on first read. */
export function sealReport(data: ReportData): InteractionReport {
  return Object.freeze(Object.defineProperties({ ...data }, EXPLAINED_ON_READ)) as InteractionReport;
}

/** Explanations built so far, by report. Reports are frozen, so each is explained at most once. */
const explanations = new WeakMap<InteractionReport, { explanation: Explanation; verdict: string }>();

function explained(r: InteractionReport): { explanation: Explanation; verdict: string } {
  let built = explanations.get(r);
  if (!built) {
    const explanation = explain(r);
    built = { explanation, verdict: toVerdict(explanation) };
    explanations.set(r, built);
  }
  return built;
}

/**
 * Reports are built in the Event Timing callback, where every millisecond can delay the next
 * input, and many are never read, so the explanation and verdict are built on first read. They
 * are own enumerable getters: JSON, spreads and structured copies of a report still carry them.
 */
const EXPLAINED_ON_READ: PropertyDescriptorMap = {
  explanation: {
    enumerable: true,
    get(this: InteractionReport) {
      return explained(this).explanation;
    },
  },
  verdict: {
    enumerable: true,
    get(this: InteractionReport) {
      return explained(this).verdict;
    },
  },
};

/** The commit's stamp names another input the ring knows, one that is not part of this interaction. */
function claimedElsewhere(c: CommitSummary, inputs: readonly InputRecord[], stamps: number[]): boolean {
  return inputs.some((i) => near(i.ts, c.inputTs) && !stamps.some((s) => near(s, i.ts)));
}

/** The navigation an interaction that began at `time` happened in: the newest one that had begun by then. Null only for a report built without the page's navigations, as unit tests build them. */
function navigationAt(navigations: readonly PageNavigation[], time: number): PageNavigation | null {
  let found = navigations[0] ?? null;
  for (const n of navigations) if (n.start <= time) found = n;
  return found;
}

/** The soft navigation an interaction started: the last one a router announced while one of its inputs was being dispatched. */
function navigationStartedBy(navigations: readonly PageNavigation[], stamps: number[]): StartedNavigation | null {
  let started: StartedNavigation | null = null;
  for (const { url, router } of navigations) if (router?.input && stampMatches(router.input, stamps)) started = { url, type: router.type };
  return started && Object.freeze(started);
}

/**
 * The next revision of a report more entries arrived for (the click after a held pointerdown, the
 * keyup after a keydown): rebuilt from every entry so far.
 */
export function refreshReport(
  r: ReportData,
  entries: readonly InteractionTiming[],
  commits: readonly CommitSummary[],
  frames: readonly FrameSummary[] | null,
  inputs: readonly InputRecord[] = [],
  labels: LabelSource = 'attributes',
  navigations: readonly PageNavigation[] = [],
): ReportData {
  // Time already spent building the report stays counted; the walks are recounted for the commits it now holds.
  const building = r.overheadMs - walked(r.commits) - walked(r.followUps);
  const fresh = buildReport(entries, commits, frames, inputs, labels, navigations);
  return { ...fresh, revision: r.revision + 1, overheadMs: fresh.overheadMs + building };
}

function framesForLater(later: readonly CommitSummary[], frames: readonly FrameSummary[]): readonly FrameSummary[] {
  return Object.freeze(frames.filter((f) => later.some((c) => f.start <= c.at && f.start + f.duration >= c.at - Math.max(c.total, FRAME_MS))));
}

function framesInWindow(r: ReportData, frames: readonly FrameSummary[]): readonly FrameSummary[] {
  return frames.filter((f) => f.start < r.end && f.start + f.duration > r.start);
}

/** `held` and the frames of `found` it does not hold yet, in time order; null when it holds every one. */
function withNewFrames(held: readonly FrameSummary[] | null, found: readonly FrameSummary[]): readonly FrameSummary[] | null {
  const added = found.filter((f) => !held?.includes(f));
  return added.length ? Object.freeze([...(held ?? []), ...added].sort((a, b) => a.start - b.start)) : null;
}

/**
 * A long animation frame can arrive after the report was built (there is no settle timer), so its
 * forced layout and scripts were missing from the explanation. The next revision adds any that overlap
 * the interaction's window or its later renders. The frames a report holds stay in it after the page's
 * store of recent frames lets them go; null when there is nothing new to add.
 */
export function refreshFrames(r: ReportData, frames: readonly FrameSummary[]): ReportData | null {
  const inWindow = withNewFrames(r.frames, framesInWindow(r, frames));
  const later = withNewFrames(r.laterFrames, framesForLater(r.followUps, frames));
  if (!inWindow && !later) return null;
  return { ...r, frames: inWindow ?? r.frames, laterFrames: later ?? r.laterFrames, revision: r.revision + 1 };
}

/** Does this commit belong to the report's input, landing after its paint? */
export function isLaterRender(r: ReportData, c: CommitSummary): boolean {
  return c.at > r.end && c.at - r.start <= FOLLOW_UP_WINDOW && stampMatches(c, r.entries.map((e) => e.startTime)) && worthMentioning(c);
}

/** The next revision of a report, with a later render attached; null when it holds that render already. */
export function attachLaterRender(r: ReportData, c: CommitSummary, frames: readonly FrameSummary[] | null): ReportData | null {
  const commit = joined(c, 'exact');
  if (r.followUps.includes(commit)) return null;
  const followUps = Object.freeze([...r.followUps, commit]);
  const laterFrames = frames && (withNewFrames(r.laterFrames, framesForLater(followUps, frames)) ?? r.laterFrames);
  return { ...r, followUps, laterFrames, overheadMs: r.overheadMs + c.walkMs, revision: r.revision + 1 };
}

function describeTarget(node: Node, owners: readonly string[], handler: string | null, labels: LabelSource): TargetInfo {
  return Object.freeze({
    selector: selector(node),
    label: labelOf(node, labels),
    component: owners[0] ?? null,
    owners: Object.isFrozen(owners) ? owners : Object.freeze(owners.slice()),
    handler,
  });
}

function elementOf(node: Node): Element | null {
  return node.nodeType === ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** 'button#save[data-test="save"]': the tag, the id, then the test attribute the element has, or else two of its classes. */
function selector(node: Node): string | null {
  const el = elementOf(node);
  if (!el) return null;
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  for (const name of TEST_ATTRIBUTES) {
    const value = el.getAttribute(name);
    // Quoted, so that a value with spaces or brackets is still one selector.
    if (value) return `${s}[${name}="${value.replace(/["\\]/g, '\\$&')}"]`;
  }
  if (el.classList && el.classList.length) s += '.' + Array.from(el.classList).slice(0, 2).join('.');
  return s;
}

/**
 * 'button "Add to cart"': the element's kind and what names it. The name comes from what the page's
 * code wrote on the element: its aria-label, a form field's placeholder, name or type, or its
 * data-testid or data-test. Where `labels` is 'text', an element with no aria-label that is not a
 * form field is named by its first run of text before those data attributes are tried.
 */
function labelOf(node: Node, labels: LabelSource): string | null {
  const el = elementOf(node);
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const word = tag === 'a' ? 'link' : tag;
  const field = tag === 'input' || tag === 'textarea' || tag === 'select';
  const written = (name: string) => el.getAttribute(name);
  const name =
    written('aria-label') ||
    (field ? written('placeholder') || written('name') || written('type') : labels === 'text' ? firstText(el) : null) ||
    written('data-testid') ||
    written('data-test');
  const label = name ? clip(name) : '';
  return label ? `${word} "${label}"` : word;
}

/** Whitespace collapsed, cut at 40 characters. */
function clip(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, LABEL_CHARS).trimEnd();
}

/**
 * The first run of text inside `el`: its first text node with more than whitespace, joined to
 * the text nodes right after it (React renders `Add to cart ({n})` as three), stopping once 40
 * characters are in hand.
 */
function firstText(el: Element): string {
  let node: Node | null = el.firstChild;
  for (let looked = 0; node && looked < LABEL_NODES; looked++) {
    if (node.nodeType === TEXT_NODE && /\S/.test(node.nodeValue ?? '')) {
      let text = node.nodeValue ?? '';
      for (let next = node.nextSibling; next && next.nodeType === TEXT_NODE && text.length < LABEL_CHARS; next = next.nextSibling) text += next.nodeValue ?? '';
      return text;
    }
    node = nextNode(node, el);
  }
  return '';
}

/** The node after `node` in document order, without leaving `root`. */
function nextNode(node: Node, root: Node): Node | null {
  if (node.firstChild) return node.firstChild;
  for (let n: Node | null = node; n && n !== root; n = n.parentNode) if (n.nextSibling) return n.nextSibling;
  return null;
}

const ms = (n: number): string => `${Math.round(n)} ms`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A URL the way a link on `page` shows it: its path, query and fragment when it stays on that page's origin. */
function linkText(url: string, page: string): string {
  try {
    const to = new URL(url);
    return to.origin === new URL(page).origin ? to.pathname + to.search + to.hash : url;
  } catch {
    return url;
  }
}

/** "the click handler handleLogin"; "the onClick handler" when the name is a prop's, which is all a minified build leaves. */
function handlerPhrase(name: string, kind: string): string {
  return /^on[A-Z]/.test(name) ? `the ${name} handler` : `the ${kind} handler ${name}`;
}

export function heaviest(list: readonly CommitSummary[]): CommitSummary {
  return list.reduce((a, b) => (score(b) > score(a) ? b : a));
}

function score(c: CommitSummary): number {
  return c.hasDurations ? c.total : c.rendered;
}

function leafOf(c: CommitSummary): string {
  return c.hotPath[c.hotPath.length - 1] || c.roots[0] || 'the app';
}

/** "LineItem ×800", or the component count when no single component dominates. */
function mostlyOf(c: CommitSummary): string | null {
  if (c.rendered === 1) return null;
  const top = c.components[0];
  if (top && top.count > 1) return `${top.name} ×${top.count}`;
  return plural(c.rendered, 'component');
}

/** "re-rendering 801 components inside OrderSummary, mostly LineItem (800 of them, 161 ms)"; "hydrating" for a hydration. */
function renderPhrase(c: CommitSummary): string {
  const verb = c.hydrated ? 'hydrating' : 're-rendering';
  const leaf = leafOf(c);
  const top = c.components[0];
  if (c.rendered === 1) return `${verb} ${leaf}`;
  let mostly = '';
  if (top && top.count > 1) {
    const time = top.self != null ? `, ${ms(top.self)}` : '';
    mostly = top.name === leaf ? ` (${top.count} of them${time})` : `, mostly ${top.name} (${top.count} of them${time})`;
  }
  return `${verb} ${plural(c.rendered, 'component')} inside ${leaf}${mostly}`;
}

/** A Long Animation Frames script as one window of the interaction sees it. */
interface ScriptPart {
  readonly script: ScriptSummary;
  /** How much of the script is counted for this window, ms: the part of it lying between the window's two edges. */
  readonly ms: number;
  /**
   * Its forced layout, in proportion to that part. The API gives a script's forced layout as one total,
   * not when in the script it happened, so the share is an estimate: the one web-vitals makes.
   */
  readonly forcedLayout: number;
}

/**
 * The part of each script of `frames` that falls inside the window, clipped at both edges, with that
 * part's share of the script's forced layout, because the API gives a script's forced layout as one
 * total and never says when in the script it happened.
 *
 * web-vitals takes the same intersection for `totalScriptDuration` and `longestScript` (its
 * `attribution/onINP.ts`, "intersectingScriptDuration") but clips the left edge only, so a script
 * that starts inside an interaction and runs on past the paint counts against it whole. Here it
 * counts only up to the paint: the rest ran after the screen had updated, and nobody waited for it.
 */
function scriptParts(frames: readonly FrameSummary[], from: number, to: number): ScriptPart[] {
  const parts: ScriptPart[] = [];
  for (const f of frames) {
    for (const script of f.scripts) {
      // A script that had finished before the window, or had not started by the end of it, is not part of it.
      if (script.start + script.duration < from || script.start > to) continue;
      const ms = Math.min(script.start + script.duration, to) - Math.max(from, script.start);
      parts.push({ script, ms, forcedLayout: script.duration > 0 ? (ms / script.duration) * script.forcedLayout : 0 });
    }
  }
  return parts;
}

const forcedLayoutOf = (parts: readonly ScriptPart[]): number => parts.reduce((a, p) => a + p.forcedLayout, 0);

/** The longest part, if it is long enough to matter. */
function longestPart(parts: readonly ScriptPart[]): ScriptPart | null {
  let best: ScriptPart | null = null;
  for (const p of parts) if (!best || p.ms > best.ms) best = p;
  return best && best.ms >= SCRIPT_MIN_MS ? best : null;
}

/** The report in plain words. Frozen, like the report it explains. */
export function explain(r: InteractionReport): Explanation {
  const rating = rateInp(r.duration);
  const kind = kindOf(r.type);
  const headline = `${ms(r.duration)} ${kind}`;
  const where = r.target ? [r.target.label || r.target.selector, r.target.component ? `in ${r.target.component}` : ''].filter(Boolean).join(' ') || null : null;
  const notes: string[] = [];
  const handlerName = r.target?.handler ?? null;
  const component = r.target?.component ?? null;
  const handler = handlerName ? handlerPhrase(handlerName, kind) : null;
  const outsideName = handler || `code outside React (the ${kind} handler or other scripts)`;

  const processingStart = r.start + r.inputDelay;
  const processingEnd = processingStart + r.processing + r.walkMs;
  // A script is the handler only when it started while the input's handlers ran. One that was already
  // running when the input came (the task the input waited behind), or that ran after the handlers, is
  // named by what the browser says ran it.
  const ranAsHandler = (s: ScriptSummary) => s.start >= processingStart - STAMP_TOLERANCE && s.start <= processingEnd;
  const scriptPhrase = (s: ScriptSummary) => (handler && ranAsHandler(s) ? handler : `a script (${s.invoker || s.name || 'unknown'}${s.source ? `, ${s.source}` : ''})`);
  const scriptBlameName = (s: ScriptSummary) => (handlerName && ranAsHandler(s) ? handlerName : s.invoker || s.name || null);

  // A script counts for its part inside each window, and so does its forced layout.
  const frames = r.frames ?? [];
  const forcedWhileHandling = forcedLayoutOf(scriptParts(frames, processingStart, processingEnd));
  const forcedAfterInput = forcedLayoutOf(scriptParts(frames, processingStart, r.end));
  const lateScript = longestPart(scriptParts(frames, processingEnd, r.end));
  const anyScript = longestPart(scriptParts(frames, r.start, r.end));
  const lateScriptClause = lateScript ? `, mostly because ${scriptPhrase(lateScript.script)} ran for ${ms(lateScript.ms)} before the next frame.` : '.';

  const c = r.commits.length ? heaviest(r.commits) : null;
  const renderTotal = r.commits.reduce((a, x) => a + x.total, 0);
  const hasDurations = !!c && c.hasDurations;
  // Working time that was neither React's render phase nor forced layout: the handler itself,
  // React committing what it rendered, or other scripts in the same task.
  const outside = Math.max(0, r.processing - renderTotal - forcedWhileHandling);
  const outsideMatters = hasDurations && outside >= HANDLER_MIN_MS && outside >= HANDLER_MIN_SHARE * r.processing;
  // Without durations (production builds) a render only earns the blame when it is big; a
  // click that re-rendered 10 components and took 260 ms was slow in its handler.
  const renderMatters = !!c && (hasDurations ? renderTotal >= RENDER_MIN_MS : c.rendered >= (handlerName ? RENDER_MIN_COMPONENTS_BESIDE_HANDLER : RENDER_MIN_COMPONENTS));

  // The sentence and the data version of it are decided together, so a UI that shows the
  // short form never disagrees with the long one.
  let cause: string;
  let blame: Blame;
  if (c && outsideMatters && outside > renderTotal) {
    const rest = renderTotal >= RENDER_MIN_MS ? `React spent ${ms(renderTotal)} ${renderPhrase(c)}` : `React's own render took ${renderTotal < 0.5 ? 'under 1 ms' : `only ${ms(renderTotal)}`}`;
    cause = `${cap(outsideName)} ran for about ${ms(outside)}; ${rest}.`;
    blame = { kind: 'handler', name: handlerName, detail: component, ms: outside, confidence: r.commits.every(measuredCommit) ? 'measured' : 'inferred' };
  } else if (c && renderMatters) {
    cause = hasDurations ? `React spent ${ms(c.total)} ${renderPhrase(c)}.` : `React was ${renderPhrase(c)}.`;
    if (outsideMatters) cause += ` On top of that, ${outsideName} ran for about ${ms(outside)}.`;
    blame = { kind: 'render', name: leafOf(c), detail: mostlyOf(c), ms: hasDurations ? c.total : null, confidence: measuredCommit(c) ? 'measured' : 'inferred' };
  } else if (c && !hasDurations && handler && r.processing >= LONG_TASK_MS && r.processing >= r.inputDelay && r.processing >= r.presentation) {
    cause = `${cap(handler)} most likely took the ${ms(r.processing)}: React re-rendered only ${plural(c.rendered, 'component')}. A profiling build of React would give exact numbers.`;
    blame = { kind: 'handler', name: handlerName, detail: component, ms: null, confidence: 'inferred' };
  } else if (r.inputDelay > LONG_TASK_MS && r.inputDelay >= r.processing && r.inputDelay >= r.presentation) {
    cause = `The ${kind} waited ${ms(r.inputDelay)} before its handler could start: the main thread was busy with something else.`;
    blame = { kind: 'waiting', name: null, detail: null, ms: r.inputDelay, confidence: 'measured' };
  } else if (r.presentation > LONG_TASK_MS && r.presentation > r.processing) {
    cause = `After the ${kind} was handled, the screen took another ${ms(r.presentation)} to update${lateScriptClause}`;
    blame = { kind: 'painting', name: lateScript ? scriptBlameName(lateScript.script) : null, detail: null, ms: r.presentation, confidence: 'measured' };
  } else if (anyScript) {
    const small = c ? `React's render was small (${renderPhrase(c)})` : `React didn't render anything`;
    // A script cut by the interaction's edges ran for longer than the part counted here.
    const ofIt = Math.round(anyScript.ms) < Math.round(anyScript.script.duration) ? ' of it' : '';
    cause = `${small}; ${scriptPhrase(anyScript.script)} ran for ${ms(anyScript.ms)}${ofIt}.`;
    blame = { kind: 'script', name: scriptBlameName(anyScript.script), detail: ranAsHandler(anyScript.script) ? component : null, ms: anyScript.ms, confidence: 'measured' };
  } else if (r.frames) {
    cause = c
      ? `React's render was small (${renderPhrase(c)}) and no long task was recorded, so the rest went to waiting and painting.`
      : `React didn't render anything and no long task was recorded, so the time went to waiting and painting.`;
    blame = { kind: 'none', name: null, detail: null, ms: null, confidence: 'measured' };
  } else {
    // Without Long Animation Frames there is no record to say no long task ran.
    cause = c
      ? `React's render was small (${renderPhrase(c)}); this browser does not report long tasks, so what else ran is unknown.`
      : `React didn't render anything; this browser does not report long tasks, so what ran instead is unknown.`;
    blame = { kind: 'none', name: null, detail: null, ms: null, confidence: 'inferred' };
  }

  if (r.startedNavigation) notes.push(`It started a navigation to ${linkText(r.startedNavigation.url, r.navigationURL)}.`);
  if (c) {
    const real = r.commits.filter(carriesWork).length;
    if (real > 1) notes.push(`React rendered ${real} times before the screen updated, which usually means a state update inside an effect or a chain of updates.`);
    if (r.inputDelay > LONG_TASK_MS && renderMatters) notes.push(`It also waited ${ms(r.inputDelay)} before the handler could start, because the main thread was busy.`);
    if (c.truncated) notes.push('The component count is partial: the walk stopped at its budget or at its depth limit.');
  }
  if (forcedAfterInput >= FORCED_LAYOUT_MIN_MS) {
    notes.push(`The browser also spent ${ms(forcedAfterInput)} recalculating layout during the same script. That happens when code reads an element's size right after changing styles, often in a layout effect.`);
  }
  if (r.followUps.length) {
    const f = heaviest(r.followUps);
    const what = f.hasDurations ? `${ms(f.total)} ${renderPhrase(f)}` : renderPhrase(f);
    const laterForced = r.laterFrames ? r.laterFrames.reduce((a, x) => a + x.forcedLayout, 0) : 0;
    const layout = laterForced >= FORCED_LAYOUT_MIN_MS ? `, and it made the browser recalculate layout for ${ms(laterForced)} on the way` : '';
    notes.push(`A second React render landed ${ms(f.at - r.end)} after the screen updated: ${what}${layout}. INP doesn't count it, but people still wait for it.`);
  }
  if (r.presentation > PRESENTATION_NOTE_MS && r.presentation > r.processing && blame.kind !== 'painting') {
    notes.push(`After the handler finished, the screen took another ${ms(r.presentation)} to update${lateScriptClause}`);
  }
  if (r.holdMs >= HOLD_NOTE_MS) {
    notes.push(`The whole ${kind}, from press to release, spanned ${ms(r.duration + r.holdMs)}; INP counts only its slowest part, so the rest is left out of the headline.`);
  }
  if (r.commits.some((x) => x.coarseClock) || r.followUps.some((x) => x.coarseClock)) {
    notes.push("This browser's clock steps in whole milliseconds, too coarse to time each component, so no component's time is shown and React's total is a sum of whole-millisecond readings.");
  }
  // Rounded to whole milliseconds like every other number here, so anything under half of one is not worth the sentence.
  if (r.walkMs >= 0.5) {
    notes.push(`The ${ms(r.duration)} includes ${ms(r.walkMs)} that react-inp-blame itself spent reading what React rendered; it is not counted as working time.`);
  }

  const phases: Phase[] = [
    { label: 'Waiting', ms: r.inputDelay, hint: 'Before the handler could start. The main thread was busy.' },
    { label: 'Working', ms: r.processing, hint: 'Event handlers and React rendering.' },
    { label: 'Updating the screen', ms: r.presentation, hint: 'From the end of the handlers to the next painted frame.' },
  ];
  return Object.freeze({
    headline,
    blame: Object.freeze(blame),
    rating,
    where,
    cause,
    notes: Object.freeze(notes),
    phases: Object.freeze(phases.map((p) => Object.freeze(p))),
  });
}

export function toVerdict(x: Explanation): string {
  return `${x.headline}${x.where ? ` on ${x.where}` : ''}. ${x.cause}${x.notes.length ? ' ' + x.notes.join(' ') : ''}`;
}
