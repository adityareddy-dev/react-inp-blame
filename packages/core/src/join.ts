import { heaviest, leafName, MINIFIED_NAMES_NOTE, mostlyComponent, namesLookMinified, readableName } from './commits.js';
import { controlAround, elementOf, selector } from './element.js';
import { fiberFromNode, handlerOf, namingFiber, ownersOf } from './fiber.js';
import { DEFAULT_INPUT_WINDOW, joinWindow, type InputRecord } from './hook.js';
import { rateInp } from './inp.js';
import type { PageNavigation } from './navigation.js';
import type { InteractionTiming } from './observe.js';
import type { Blame, CommitSummary, EventEntrySummary, Explanation, FrameSummary, Hydration, InteractionReport, Phase, ScriptSummary, StartedNavigation, TargetInfo } from './types.js';

// A commit's input stamp and an entry's startTime are the same clock (Event.timeStamp), so
// they agree to the timer's resolution; 1 ms covers the coarsening.
const STAMP_TOLERANCE = 1;
// Handlers whose processing differs by less than this did about the same work, and the handler named
// for them is the best-known event's (see byWork). Chromium gives processing times to 0.1 ms, and a
// handler that does nothing takes under 2 ms.
const HANDLER_TIE_MS = 4;
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
// A script the input waited behind gives a waiting blame its name from half of the wait. Under that
// the wait was mostly something the browser did not list (another frame's work, rendering, garbage
// collection), and the name would send the reader after the smaller part of it. The same half holds
// for the listener that names a handler blame React had no name for.
const WAITED_BEHIND_MIN_SHARE = 0.5;
// A later render is worth a sentence from 10 ms or 25 components. Less is the page settling after the
// paint, a spinner going away or a status line changing, which is not what anyone was waiting for.
const LATER_MIN_MS = 10;
const LATER_MIN_COMPONENTS = 25;
// Forced layout is worth a sentence from 4 ms, a quarter of a frame.
const FORCED_LAYOUT_MIN_MS = 4;
// It takes the blame instead from half of the window it was counted across, on top of the long task
// above. Several things share that window (the handler, React's render, the commit, this library's own
// read), so half of it is what makes the layout the answer rather than one line of it; it is weighed
// against React's render, and a production build measures no render at all, which is exactly where
// this has to hold.
const FORCED_LAYOUT_MIN_SHARE = 0.5;
// Where no render was timed (a production build, or no commit joined at all), the long task is too
// high a bar: on the shadcn docs a sheet opened with 44 to 49 ms of layout in 55 ms of working time,
// and the blame went to a render known only by its counts, then back to the layout on the run where
// it reached 50. There the layout is the only measured duration in the window, so it is held to what
// the handler is: under 25 ms it did not make the interaction slow on its own.
const FORCED_LAYOUT_MIN_MS_NO_DURATIONS = HANDLER_MIN_MS;
// The browser charges forced layout per script, so a window holding several of them holds several
// totals. One script has to account for nine tenths of the layout before its name is used as where
// the layout happened: below that the name would be a claim about a cost the other scripts share, and
// a reader following it optimises whichever one the library happened to sort first. The sentence
// still names the largest and says how much of the total it holds, because that much is a fact.
const FORCED_LAYOUT_ONE_SCRIPT_SHARE = 0.9;
// The screen update gets a note of its own from 100 ms, half of INP's 200 ms budget for "good".
const PRESENTATION_NOTE_MS = 100;
// A press held around the interaction is worth a note from 100 ms; an ordinary click is shorter.
const HOLD_NOTE_MS = 100;
// A later render without durations is given a frame's length, to find the long animation frames it ran in.
const FRAME_MS = 16;

// A label names the clicked element; it is not a copy of it. The element can be a list of 3000
// rows, and reading all of its text would cost more than the rest of the report, so at most its
// first run of text is read, and at most 40 characters of the name inside a label are kept.
const LABEL_CHARS = 40;
// Elements whose text is never on the screen, so it cannot be what a reader knows the target by.
const UNSEEN_TEXT_TAGS = ['noscript', 'script', 'style', 'template'];
// Nodes the search for that first run of text looks at: enough to get past an icon, not to crawl a table.
const LABEL_NODES = 32;
// Siblings joined into that run once it starts, the separators between them counted: an interpolated
// string is a handful of nodes, so a long row of them is a list, not a label.
const RUN_NODES = 16;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
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

/**
 * What a person would call the interaction: "click", "tap", "key press" or "typing", from the event type
 * and, for a pointer event, the pointer it came from (a mouse's pointerdown is a click). Display text.
 */
export function kindOf(type: string, pointerType?: string | null): string {
  if (pointerType === 'mouse' && (type === 'pointerdown' || type === 'pointerup')) return 'click';
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

/**
 * A commit whose *names* stand on their own, which is a weaker thing to ask than `measuredCommit`:
 * that it is this interaction's work and not something that merely overlapped it, and that the walk
 * reached the end of the tree it is about to name. Render durations have nothing to do with it, so a
 * production build's subtree and component counts are as good here as a profiling build's.
 */
const namesThisInteraction = (c: CommitSummary) => c.joinedBy === 'exact' && !c.truncated;

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

/**
 * The entries whose handler is looked for, in PREFERRED order: those whose own processing ran within less
 * than HANDLER_TIE_MS of the longest. The event whose handlers did the work is the one to name, so a menu
 * that opens on pointerdown is put on its onPointerDown, not on an onClick beside it that only stops the
 * event, and where that work was a listener of the page's own rather than a React handler, no React
 * handler is named for it: the explanation then names the listener. Where no handler did any real work
 * every entry ties, and the order is PREFERRED's as it always was.
 */
function byWork(sorted: readonly InteractionTiming[]): InteractionTiming[] {
  const workOf = (e: InteractionTiming) => e.processingEnd - e.processingStart;
  let most = 0;
  for (const e of sorted) most = Math.max(most, workOf(e));
  return sorted.filter((e) => workOf(e) > most - HANDLER_TIE_MS);
}

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

/**
 * Is this input one of the interaction's own? Its own timestamp matching an entry is the plain case.
 * The press it released matching one is the other: a click is a pointerdown, a pointerup and a click,
 * and only the entries slow enough to be observed arrive, so a gesture whose pointerdown was the only
 * entry still owns the pointerup and the click that finished it.
 */
function ownInput(i: InputRecord, stamps: number[]): boolean {
  return stamps.some((s) => near(s, i.ts) || near(s, i.gestureTs));
}

/** Every input of this interaction the ring still holds, oldest first. A click is a pointerdown, a pointerup and a click. */
function ringInputs(inputs: readonly InputRecord[], stamps: number[]): InputRecord[] {
  return inputs.filter((i) => ownInput(i, stamps));
}

/**
 * The stamps a commit of this interaction can carry: its entries' start times, and the press each of its
 * inputs released. Event Timing leaves out an entry under 16 ms, so a tap's pointerdown can be missing from
 * the entries while a render it set off, stamped with it, lands inside the click: a finger held a moment on
 * a card whose onPointerEnter opens it.
 */
function commitStamps(inputs: readonly InputRecord[], stamps: number[]): number[] {
  const out = stamps.slice();
  for (const i of ringInputs(inputs, stamps)) if (!out.some((s) => near(s, i.gestureTs))) out.push(i.gestureTs);
  return out;
}

/**
 * Whether a newer interaction had already begun when this commit ran, so the commit is at best
 * ambiguous and must not be attached to this report as a later render.
 *
 * A commit is stamped with the newest input at the time, so one stamped with this interaction's input
 * normally is its work. Normally is not always: a commit made during an event Event Timing gives no
 * interactionId to, or outside any dispatch, is stamped with whatever the ring last held, and that can
 * be an interaction two steps back. Sorting a table and then changing its page size made exactly that
 * report, where the sort click was told it had re-rendered 417 components a second after its paint and
 * the page-size change was what had done it.
 *
 * The ring is the evidence: an input that is not one of this interaction's own, that arrived after all
 * of them and before the commit, means something newer was under way. With nothing newer in the ring
 * the commit belongs where its stamp says.
 */
function newerInputBefore(inputs: readonly InputRecord[], stamps: number[], at: number): boolean {
  const last = ringInputs(inputs, stamps).reduce((a, i) => Math.max(a, i.ts), Math.max(...stamps));
  return inputs.some((i) => !ownInput(i, stamps) && i.ts > last + STAMP_TOLERANCE && i.ts <= at);
}

/**
 * Commits the hook saw during this interaction and could not join to it, over the inputs the ring
 * still holds.
 *
 * The hook drops a commit that lands past the join window and keeps the time it ran at, because at
 * that point there is no Event Timing entry to judge it against. Here there is. A commit counts only
 * if it ran while one of the interaction's own entries was in its processing phase, which is where
 * this interaction's handlers were on the stack: React rendering then is something this interaction
 * caused, whatever this library failed to tie it to. A commit outside every such span is somebody
 * else's work, and a page with a clock ticking once a second is full of them. Counting those turned an
 * honest fast click into "3 commits could not be tied to this click" and cost it its `measured`.
 */
function unjoinedCommits(inputs: readonly InputRecord[], stamps: number[], entries: readonly InteractionTiming[]): number {
  const during = (at: number) => entries.some((e) => at >= e.processingStart - STAMP_TOLERANCE && at <= e.processingEnd + STAMP_TOLERANCE);
  return ringInputs(inputs, stamps).reduce((a, i) => a + i.work.unjoined.filter(during).length, 0);
}

/**
 * Server-rendered HTML the interaction landed on before React had hydrated it, or null.
 *
 * React hydrating it inside the interaction is the case with a time on it: one commit of the
 * interaction ended the wait its input started in, and `ms` is what that commit spent rendering.
 * Without such a commit, the case left is the one where nothing of React ran: every input of the
 * interaction that the ring still holds landed on HTML that was still waiting. Reading the newest of
 * them, rather than the first, is what keeps a pointerdown before hydration from speaking for a click
 * after it.
 */
function hydrationOf(commits: readonly CommitSummary[], inputs: readonly InputRecord[], stamps: number[]): Hydration | null {
  // At most one commit carries it: the boundary an input waited on is credited to the commit that
  // hydrated it and to no other, so there is nothing here to pick between or to add up.
  const hydrating = commits.find((c) => c.hydratedTarget != null) ?? null;
  if (hydrating?.hydratedTarget) return Object.freeze({ ...hydrating.hydratedTarget, kind: 'waited', ms: hydrating.hasDurations ? hydrating.total : null });
  const landed = ringInputs(inputs, stamps);
  const still = landed.length > 0 && landed.every((i) => i.dehydrated != null) ? landed[landed.length - 1]?.dehydrated : null;
  return still ? Object.freeze({ ...still, kind: 'not-hydrated', ms: null }) : null;
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
 * one the interaction happened in and which one it started; `inputWindow` is the page's
 * `InstallOptions.inputWindow`, which bounds its later renders (see `isFollowUp`).
 */
export function buildReport(
  entries: readonly InteractionTiming[],
  commits: readonly CommitSummary[],
  frames: readonly FrameSummary[] | null,
  inputs: readonly InputRecord[] = [],
  labels: LabelSource = 'attributes',
  navigations: readonly PageNavigation[] = [],
  inputWindow = DEFAULT_INPUT_WINDOW,
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
  const named = sorted[0] ?? longest;
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
    // Named from what a clicked icon belongs to, as at dispatch; the handler is still looked for from the
    // node itself, which is where a handler on the icon would be.
    owners = ownersOf(namingFiber(live));
    for (const e of byWork(sorted)) {
      // An Event Timing entry does not say which key was pressed; the ring entry for the same event
      // does, and which key it was decides whether the press could have submitted a form.
      // A keypress has no ring entry of its own and shares its keydown's key.
      const pressed = inputs.find((i) => (i.type === e.name || (e.name === 'keypress' && i.type === 'keydown')) && near(i.ts, e.startTime))?.press;
      handler = handlerOf(fiber, e.name, typeof pressed === 'string' ? pressed : null);
      if (handler) break;
    }
  } else if (ring) {
    owners = ring.owners;
    for (const e of byWork(sorted)) {
      handler = inputs.find((i) => i.type === e.name && near(i.ts, e.startTime))?.handler ?? null;
      if (handler) break;
    }
  }

  // Durations are rounded to 8 ms but processingEnd is exact, so a commit inside the
  // handlers is before the paint even when the rounded paint time says otherwise.
  const paintBound = Math.max(end, group.processingEnd);
  const inWindow: CommitSummary[] = [];
  const followUps: CommitSummary[] = [];
  const ownStamps = commitStamps(inputs, stamps);
  for (const c of commits) {
    if (stampMatches(c, ownStamps)) {
      // Work before the headline entry's own input (a press held before a click) is not
      // part of what INP measured for it; `holdMs` covers that time.
      if (c.at < start - STAMP_TOLERANCE) continue;
      if (c.at <= paintBound) inWindow.push(joined(c, 'exact'));
      else if (isFollowUp(c, end, inputs, stamps, inputWindow)) followUps.push(joined(c, 'exact'));
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
    schemaVersion: 2,
    interactionId: longest.interactionId,
    type: named.name,
    pointerType: inputs.find((i) => i.type === named.name && near(i.ts, named.startTime))?.pointerType || null,
    start,
    end,
    duration,
    holdMs,
    entries: Object.freeze(entries.map(summarize)),
    inputDelay: processingStart - start,
    processing: processingEnd - processingStart - walkMs,
    walkMs,
    presentation: end - processingEnd,
    // A node that left the page has no control above it any more; the one found at dispatch labels it.
    target: targetNode ? describeTarget(targetNode, owners, handler, labels, live ?? ring?.control ?? targetNode) : null,
    hydration: hydrationOf(inWindow, inputs, stamps),
    navigationURL: navigation?.url ?? '',
    navigationType: navigation?.type ?? 'navigate',
    startedNavigation: navigationStartedBy(navigations, stamps),
    commits: Object.freeze(inWindow),
    followUps: Object.freeze(followUps),
    unjoinedCommits: unjoinedCommits(inputs, stamps, entries),
    frames: frames && Object.freeze(framesInWindow(frames, start, end)),
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
  inputWindow = DEFAULT_INPUT_WINDOW,
): ReportData {
  // Time already spent building the report stays counted; the walks are recounted for the commits it now holds.
  const building = r.overheadMs - walked(r.commits) - walked(r.followUps);
  const fresh = buildReport(entries, commits, frames, inputs, labels, navigations, inputWindow);
  return { ...fresh, revision: r.revision + 1, overheadMs: fresh.overheadMs + building };
}

function framesForLater(later: readonly CommitSummary[], frames: readonly FrameSummary[]): readonly FrameSummary[] {
  return Object.freeze(frames.filter((f) => later.some((c) => f.start <= c.at && f.start + f.duration >= c.at - Math.max(c.total, FRAME_MS))));
}

function framesInWindow(frames: readonly FrameSummary[], start: number, end: number): readonly FrameSummary[] {
  return frames.filter((f) => f.start < end && f.start + f.duration > start);
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
  const inWindow = withNewFrames(r.frames, framesInWindow(frames, r.start, r.end));
  const later = withNewFrames(r.laterFrames, framesForLater(r.followUps, frames));
  if (!inWindow && !later) return null;
  return { ...r, frames: inWindow ?? r.frames, laterFrames: later ?? r.laterFrames, revision: r.revision + 1 };
}

/**
 * A commit that landed after the paint and is worth a sentence, close enough to be this interaction's
 * own doing, with no newer interaction under way to have caused it instead. Close enough is within
 * `inputWindow` of `followUpFrom`, the length the hook walks a commit by, so a page that sets it longer
 * gets the renders it pays to walk and one that sets it shorter keeps the ones it walked.
 */
function isFollowUp(c: CommitSummary, end: number, inputs: readonly InputRecord[], stamps: number[], inputWindow: number): boolean {
  return c.at - followUpFrom(c, end, inputs, stamps) <= inputWindow && worthMentioning(c) && !newerInputBefore(inputs, stamps, c.at);
}

/**
 * Where a later render's window runs from. The paint, as a rule, not the input: an interaction that took
 * three seconds still gets the render its effects schedule a moment after it. The hook measures from the
 * end of the work of the input the commit is stamped with (`work.endedAt`, which the ring keeps), and for
 * the input the paint closed that is before the paint. Another input of the same interaction can end its
 * work after it: the click that releases a pointer held down past the paint, or a click whose pointerdown
 * was the slow part and painted first. Then the window runs from the end of that input's work, as the
 * hook's did, and a render inside the click's own dispatch is the click's however long the press was held.
 *
 * Only while the ring shows nothing else pressed from the interaction's first input to that one. Where
 * something was, the release may not be this interaction's alone: a pointer held down through a key
 * press, or a release whose press the hook could only guess at and took the newest one for (`gestureOf`).
 * When the ring has let the input go, there is nothing to check it against, and the window runs from the
 * paint.
 */
function followUpFrom(c: CommitSummary, end: number, inputs: readonly InputRecord[], stamps: number[]): number {
  // By type as well: a pointerup and its click are often under a millisecond apart.
  const own = inputs.find((i) => i.type === c.inputType && near(i.ts, c.inputTs));
  if (!own || !ownInput(own, stamps)) return end;
  const first = Math.min(...stamps);
  // No tolerance on the bounds: the inputs at them are the interaction's own, and the keydown that
  // makes a click can be under a millisecond before it.
  const pressedBetween = inputs.some((i) => i.ts >= first && i.ts <= own.ts && !ownInput(i, stamps));
  return pressedBetween ? end : Math.max(end, own.work.endedAt);
}

/** Does this commit belong to the report's input, landing after its paint and inside its later-render window (`followUpFrom`)? */
export function isLaterRender(r: ReportData, c: CommitSummary, inputs: readonly InputRecord[] = [], inputWindow = DEFAULT_INPUT_WINDOW): boolean {
  const stamps = r.entries.map((e) => e.startTime);
  return c.at > r.end && stampMatches(c, commitStamps(inputs, stamps)) && isFollowUp(c, r.end, inputs, stamps, inputWindow);
}

/** The next revision of a report, with a later render attached; null when it holds that render already. */
export function attachLaterRender(r: ReportData, c: CommitSummary, frames: readonly FrameSummary[] | null): ReportData | null {
  const commit = joined(c, 'exact');
  if (r.followUps.includes(commit)) return null;
  const followUps = Object.freeze([...r.followUps, commit]);
  const laterFrames = frames && (withNewFrames(r.laterFrames, framesForLater(followUps, frames)) ?? r.laterFrames);
  return { ...r, followUps, laterFrames, overheadMs: r.overheadMs + c.walkMs, revision: r.revision + 1 };
}

// What counts as a readable name is `readableName`, in commits.ts, shared with everything that names a commit.

/**
 * The owner a report names the target by: the nearest readable one. Where the chain holds no
 * readable name the nearest owner is named anyway, because the alternative is inventing one, and
 * `owners` keeps the chain whole either way.
 */
function namedOwner(owners: readonly string[]): string | null {
  return owners.find(readableName) ?? owners[0] ?? null;
}

function describeTarget(node: Node, owners: readonly string[], handler: string | null, labels: LabelSource, labelled: Node = node): TargetInfo {
  return Object.freeze({
    selector: selector(node),
    label: labelOf(labelled, labels),
    component: namedOwner(owners),
    owners: Object.isFrozen(owners) ? owners : Object.freeze(owners.slice()),
    handler,
  });
}

/**
 * 'button "Add to cart"': the element's kind and what names it. The name comes from what the page's
 * code wrote on the element: its aria-label, a form field's placeholder, name or type, or its
 * data-testid or data-test. Where `labels` is 'text', an element with no aria-label that is not a
 * form field is named by its first run of text before those data attributes are tried.
 */
function labelOf(node: Node, labels: LabelSource): string | null {
  const landed = elementOf(node);
  if (!landed) return null;
  const el = controlAround(landed);
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
      let joined = 0;
      for (let next = node.nextSibling; next && joined < RUN_NODES && text.length < LABEL_CHARS; next = next.nextSibling, joined++) {
        // Server-rendered HTML separates two adjacent text children with `<!-- -->`, a comment
        // holding a single space, so that hydration can tell them apart, and it stays in the DOM.
        // It is a separator inside one run of text, not the end of it: skipping it is what makes
        // the label read the same under Next.js as under a client-only render.
        if (next.nodeType === COMMENT_NODE) continue;
        if (next.nodeType !== TEXT_NODE) break;
        text += next.nodeValue ?? '';
      }
      return text;
    }
    node = nextNode(node, el);
  }
  return '';
}

/** The node after `node` in document order, without leaving `root`. */
function nextNode(node: Node, root: Node): Node | null {
  // Text nobody can see names nothing: a key press with nothing focused lands on the body, and the
  // first text in a Vite or CRA page's body is its noscript line, "You need to enable JavaScript".
  if (node.firstChild && !UNSEEN_TEXT_TAGS.includes((node as Element).tagName?.toLowerCase() ?? '')) return node.firstChild;
  for (let n: Node | null = node; n && n !== root; n = n.parentNode) if (n.nextSibling) return n.nextSibling;
  return null;
}

export const ms = (n: number): string => `${Math.round(n)} ms`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

interface Interval {
  readonly from: number;
  readonly to: number;
}

/** `intervals` as sorted pieces that do not overlap, so that each moment counts once. */
function merged(intervals: readonly Interval[]): Interval[] {
  const out: { from: number; to: number }[] = [];
  for (const i of intervals.filter((x) => x.to > x.from).sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1];
    if (last && i.from <= last.to) last.to = Math.max(last.to, i.to);
    else out.push({ from: i.from, to: i.to });
  }
  return out;
}

/** The time `intervals` cover, each moment once, less what `less` covers of it. */
function coverage(intervals: readonly Interval[], less: readonly Interval[] = []): number {
  const taken = merged(less);
  let total = 0;
  for (const x of merged(intervals)) {
    total += x.to - x.from;
    for (const y of taken) total -= Math.max(0, Math.min(x.to, y.to) - Math.max(x.from, y.from));
  }
  return total;
}
/** What the browser says ran a script: its invoker, else its function's name; null when it gives neither. */
const scriptName = (s: ScriptSummary): string | null => s.invoker || s.name || null;
/** "a script (handleClick, app.js)": a script by what ran it and the file it came from. */
const aScript = (s: ScriptSummary): string => `a script (${scriptName(s) ?? 'unknown'}${s.source ? `, ${s.source}` : ''})`;
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

function leafOf(c: CommitSummary): string {
  return leafName(c) ?? 'the app';
}

/** "LineItem ×800", or the component count when no single component dominates. */
function mostlyOf(c: CommitSummary): string | null {
  if (c.rendered === 1) return null;
  const top = mostlyComponent(c);
  if (top && top.count > 1) return `${top.name} ×${top.count}`;
  return renderedCount(c);
}

/** "801 components"; "at least 5000 components" where the walk stopped before the end of the tree. */
function renderedCount(c: CommitSummary): string {
  return `${c.truncated ? 'at least ' : ''}${plural(c.rendered, 'component')}`;
}

/** "re-rendering 801 components inside OrderSummary, mostly LineItem (800 of them, 161 ms)"; "hydrating" for a hydration. */
function renderPhrase(c: CommitSummary): string {
  const verb = c.hydrated ? 'hydrating' : 're-rendering';
  const leaf = leafOf(c);
  const top = mostlyComponent(c);
  // React commits with nothing rendered: a retry that found the boundary still blocked, or an update
  // every component bailed out of. Calling that a re-render of no components reads as a bug in the
  // report rather than as what it is.
  if (c.rendered === 0) return 'committing without rendering a component';
  if (c.rendered === 1) return `${verb} ${leaf}`;
  let mostly = '';
  if (top && top.count > 1) {
    const time = top.self != null ? `, ${ms(top.self)}` : '';
    mostly = top.name === leaf ? ` (${top.count} of them${time})` : `, mostly ${top.name} (${top.count} of them${time})`;
  }
  return `${verb} ${renderedCount(c)} inside ${leaf}${mostly}`;
}

/**
 * "the Suspense boundary in ProductPage": a Suspense boundary has no name of its own, so it is named
 * by the nearest component that holds it. "the page" where a whole root was waiting, which has no
 * component above it to be named after.
 */
function boundaryPhrase(h: Hydration): string {
  if (h.scope === 'root') return 'the page';
  return h.owner ? `the Suspense boundary in ${h.owner}` : 'a Suspense boundary';
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
  /** Whether the whole script lay inside the window, so its forced layout is its own figure rather than a share of one. */
  readonly whole: boolean;
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
      const whole = script.start >= from - STAMP_TOLERANCE && script.start + script.duration <= to + STAMP_TOLERANCE;
      parts.push({ script, ms, forcedLayout: script.duration > 0 ? (ms / script.duration) * script.forcedLayout : 0, whole });
    }
  }
  return parts;
}

const forcedLayoutOf = (parts: readonly ScriptPart[]): number => parts.reduce((a, p) => a + p.forcedLayout, 0);

/** Whether every script that forced layout in this window ran inside it, so none of the total was shared out by time. */
const forcedLayoutMeasured = (parts: readonly ScriptPart[]): boolean => parts.every((p) => p.whole || p.forcedLayout === 0);

/** The script the browser charged the most forced layout to in this window; null when none forced any. */
function mostForcedLayout(parts: readonly ScriptPart[]): ScriptPart | null {
  let best: ScriptPart | null = null;
  for (const p of parts) if (p.forcedLayout > 0 && (!best || p.forcedLayout > best.forcedLayout)) best = p;
  return best;
}

/** The longest part, if it is long enough to matter. */
function longestPart(parts: readonly ScriptPart[]): ScriptPart | null {
  let best: ScriptPart | null = null;
  for (const p of parts) if (!best || p.ms > best.ms) best = p;
  return best && best.ms >= SCRIPT_MIN_MS ? best : null;
}

/**
 * The word that marks a sentence as a reading rather than a measurement. Every blame that names
 * something and carries `confidence: 'inferred'` uses it, so the sentence and the data never
 * disagree; a blame of kind 'none' names nothing and has nothing to hedge.
 */
const HEDGE = 'most likely';
/** What would turn a blame read off component counts into a measured one. */
const PROFILING_BUILD = 'A profiling build of React would give exact numbers.';

/** The measured sentence, or the hedged one when the blame is a reading. */
const say = (confidence: Blame['confidence'], measured: string, likely: string): string => (confidence === 'measured' ? measured : likely);

/** The report in plain words. Frozen, like the report it explains. */
function explain(r: InteractionReport): Explanation {
  const rating = rateInp(r.duration);
  const kind = kindOf(r.type, r.pointerType);
  const headline = `${ms(r.duration)} ${kind}`;
  const where = r.target ? [r.target.label || r.target.selector, r.target.component ? `in ${r.target.component}` : ''].filter(Boolean).join(' ') || null : null;
  const notes: string[] = [];
  const handlerName = r.target?.handler ?? null;
  const component = r.target?.component ?? null;
  const handler = handlerName ? handlerPhrase(handlerName, kind) : null;
  const outsideName = handler || `code outside React (the ${kind} handler or other scripts)`;
  // React did render during the interaction and this library could not tell which interaction those
  // renders belonged to. Saying it rendered nothing would be false, and nothing said about what React
  // did here is a measurement.
  const unjoined = r.unjoinedCommits > 0;
  const renderedNothing = unjoined
    ? `React rendered during it, but ${plural(r.unjoinedCommits, 'commit')} could not be tied to this ${kind}`
    : `React didn't render anything`;
  /**
   * How sure a sentence about React's work can be. A commit that could not be tied to the interaction
   * is missing evidence, so nothing said about what React did here is a measurement, however good the
   * commits that did join are. The phases (waiting, painting) are the browser's numbers and keep
   * their own confidence.
   */
  const measuredFrom = (...cs: readonly CommitSummary[]): Blame['confidence'] => (!unjoined && cs.every(measuredCommit) ? 'measured' : 'inferred');
  // A build that records no render durations is the one reason for an inference with a remedy worth
  // naming in the sentence. The others (a clock too coarse to time single components, a walk cut at
  // its budget, a commit joined by its timing rather than its input) each already have a note below.
  const profiling = r.commits.some((x) => !x.hasDurations) ? ` ${PROFILING_BUILD}` : '';

  const processingStart = r.start + r.inputDelay;
  const processingEnd = processingStart + r.processing + r.walkMs;
  // A script is the handler only when it started while the input's handlers ran. One that was already
  // running when the input came (the task the input waited behind), or that ran after the handlers, is
  // named by what the browser says ran it.
  const ranAsHandler = (s: ScriptSummary) => s.start >= processingStart - STAMP_TOLERANCE && s.start <= processingEnd;
  const scriptPhrase = (s: ScriptSummary) => (handler && ranAsHandler(s) ? handler : aScript(s));
  const scriptBlameName = (s: ScriptSummary) => (handlerName && ranAsHandler(s) ? handlerName : scriptName(s));

  // A script counts for its part inside each window, and so does its forced layout.
  const frames = r.frames ?? [];
  const whileHandling = scriptParts(frames, processingStart, processingEnd);
  const forcedWhileHandling = forcedLayoutOf(whileHandling);
  const forcedAfterInput = forcedLayoutOf(scriptParts(frames, processingStart, r.end));
  const lateScript = longestPart(scriptParts(frames, processingEnd, r.end));
  const anyScript = longestPart(scriptParts(frames, r.start, r.end));
  const lateScriptClause = lateScript ? `, mostly because ${scriptPhrase(lateScript.script)} ran for ${ms(lateScript.ms)} before the next frame.` : '.';

  const c = r.commits.length ? heaviest(r.commits) : null;
  const renderTotal = r.commits.reduce((a, x) => a + x.total, 0);
  const hasDurations = !!c && c.hasDurations;
  /**
   * The window the scripts, and so the forced layout, were counted across. It runs to the end of the
   * library's own walk, because the walk happens inside the same script the handlers did, and
   * `processing` has that walk taken back out of it. Anything printed against the forced layout is
   * printed against this, or it reads as "110 ms of the 100 ms of working time".
   */
  const handledWindow = r.processing + r.walkMs;
  /**
   * React's own time while the input was handled, where the build keeps when each render began: from
   * that start to the end of its commit, so committing is in it, the DOM changes, ref callbacks and
   * layout effects that a render duration leaves out. Only a development or profiling build keeps the
   * start, so a production build has no such span. A span only counts when it began and ended inside
   * one event's handlers. React does not yield in there, so a render that began before them, or
   * committed after, waited or yielded on the way, and what ran meanwhile (the handler, most often) was
   * not React's. Its render duration stands for it, as in a production build. Spans that overlap
   * count once: a root flushed from inside another root's layout effect commits within that span.
   */
  const inOneHandler = (from: number, to: number) => r.entries.some((e) => from >= e.processingStart - STAMP_TOLERANCE && to <= e.processingEnd + STAMP_TOLERANCE);
  const spans = r.commits
    .flatMap((x, order) => {
      const began = x.startedAt;
      if (began === null || !inOneHandler(began, x.at)) return [];
      const from = Math.max(began, processingStart);
      const to = Math.min(x.at, processingEnd);
      return to > from ? [{ commit: x, order, from, to }] : [];
    })
    .sort((a, b) => a.from - b.from);
  /**
   * The passive effects', the `useEffect`s', in every build: React 18 and 19 say when a commit's have
   * run, and run a click's or a key press's right after its commit, in the same task. From the end of
   * the hook call for the commit (this library's walk and React DevTools' own reading are not theirs)
   * to then is theirs, under the same rule as a span: the commit and the end of its effects inside one
   * event's handlers. Effects React ran in a later task have no figure here, since whatever ran between
   * the two tasks was not theirs.
   */
  const effectSpans = r.commits.flatMap((x, order) => {
    const began = x.effectsStartedAt;
    const ended = x.effectsEndedAt;
    if (began === null || ended === null || !inOneHandler(x.at, ended)) return [];
    const from = Math.max(began, processingStart);
    const to = Math.min(ended, processingEnd);
    return to > from ? [{ commit: x, order, from, to }] : [];
  });
  // This library's walk of each commit, which `processing` already leaves out. One inside another
  // commit's span, a root committed inside it, is not React's time either.
  const walks = r.commits.map((x) => ({ from: x.at, to: x.at + x.walkMs }));
  const spanned = coverage([...spans, ...effectSpans], walks);
  const spannedRender = spans.reduce((a, x) => a + x.commit.total, 0);
  /**
   * What committing took beyond the render, for each commit with a span: the span less its own render,
   * and less the span of any root it flushed inside it, which is that root's time and counted there.
   */
  const committingOf = new Map<CommitSummary, number>();
  // On a 1 ms clock a root flushed inside another can share both its edges; it committed first, so the
  // earlier of two identical spans is the one inside.
  const within = (inner: (typeof spans)[number], outer: (typeof spans)[number]) =>
    inner !== outer && inner.from >= outer.from && inner.to <= outer.to && (inner.from > outer.from || inner.to < outer.to || inner.order < outer.order);
  for (const span of spans) {
    // The walks of the roots flushed inside it are in their gaps, after each one's own span, and are
    // this library's time.
    const flushed = spans.filter((o) => within(o, span));
    committingOf.set(span.commit, Math.max(0, coverage([span], [...flushed, ...walks]) - span.commit.total));
  }
  const committing = [...committingOf.values()].reduce((a, x) => a + x, 0);
  /**
   * What each commit's effects took: the span less the React time of anything committed inside it,
   * which is counted as that commit's, and less the walks. React commits an update an effect made with
   * `flushSync`, or one a layout effect made, once the effects are done and before it says so, so such
   * a commit lands inside. Where it has no span of its own (a production build keeps no render start),
   * its render cannot be taken out, and the figure says it holds one.
   */
  const effectsOf = new Map<CommitSummary, number>();
  const rendersInside = new Map<CommitSummary, number>();
  for (const span of effectSpans) {
    const within = (o: Interval) => o.from >= span.from && o.to <= span.to;
    const inside = [...spans, ...effectSpans].filter((o) => o.commit !== span.commit && within(o));
    effectsOf.set(span.commit, Math.max(0, coverage([span], [...inside, ...walks])));
    const unspanned = r.commits.filter((x) => x !== span.commit && x.at > span.from && x.at < span.to && !spans.some((o) => o.commit === x));
    if (unspanned.length) rendersInside.set(span.commit, unspanned.length);
  }
  const effects = [...effectsOf.values()].reduce((a, x) => a + x, 0);
  /** Where a commit's effects figure holds renders it could not take out: ", one more render included". */
  const includedN = (n: number) => (n === 0 ? '' : `, ${n === 1 ? 'one more render' : `${n} more renders`} included`);
  const included = (x: CommitSummary) => includedN(rendersInside.get(x) ?? 0);
  // Committing and effects that would have been enough to blame the handler, had they been the handler's.
  const committingShows = (t: number) => t >= HANDLER_MIN_MS && t >= HANDLER_MIN_SHARE * r.processing;
  const committingMatters = committingShows(committing + effects);
  // A production build has no render durations, so what is left of the working time once the effects
  // are out is the handler and the render together, unsplit. There the effects earn React the blame
  // only where they are at least that remainder: a 150 ms handler beside 60 ms of effects is still the
  // handler's, though the 60 ms are worth saying.
  // Without a handler's name there is no sentence to say them in, and the rest is no one's to take,
  // unless the browser names a script that ran beside React rather than around it (none of the
  // effects inside it), a listener on the document, and for longer.
  const besideReact = longestPart(whileHandling.filter((p) => !effectSpans.some((e) => p.script.start < e.to && p.script.start + p.script.duration > e.from)));
  const effectsEarn =
    committingMatters && (hasDurations || committing + effects >= r.processing / 2 || (!handler && !(besideReact && besideReact.ms > committing + effects)));
  // React's time in all: the spans, and the render durations of the commits that have none.
  const reactWhileHandling = spanned + renderTotal - spannedRender;
  // What the handler has to outrun to be the blame: all of React's time, committing and effects
  // included, not only its render durations, or a 100 ms handler beside a 5 ms render and 200 ms of
  // effects was blamed and the effects went unsaid.
  const reactTime = Math.max(renderTotal, reactWhileHandling);
  // Working time that was neither React's nor forced layout: the handler itself, or other scripts in
  // the same task. Subtracting React's render is what makes it the handler's, so a build that records
  // no durations has no such figure: there this would be the whole working time wearing the handler's
  // name. Subtracting React's commit too keeps a commit phase heavy with layout effects off the handler,
  // which is all that stood between the two in a browser that does not time forced layout. Where it
  // does, forced layout inside React's commit is in both figures, so the larger of the two is taken
  // rather than their sum. The walk is taken out too, by starting from `processing` rather than the
  // window above: it is this library's time, not the app's.
  const outside = Math.max(0, r.processing - Math.max(reactWhileHandling, renderTotal + forcedWhileHandling));
  const outsideMatters = hasDurations && outside >= HANDLER_MIN_MS && outside >= HANDLER_MIN_SHARE * r.processing;
  // Without durations (production builds) a render only earns the blame when it is big; a
  // click that re-rendered 10 components and took 260 ms was slow in its handler. With them, a commit
  // that took as long as a handler would need to be blamed earns it too: a 3 ms render whose layout
  // effects ran for 300 ms is React's work, and taking that time off the handler has to leave it
  // somewhere. A few milliseconds of committing, which any development build spends, earn nothing.
  // Effects are timed in every build, so a production build's render earns it by them too.
  const renderMatters = !!c && (effectsEarn || (hasDurations ? renderTotal >= RENDER_MIN_MS : c.rendered >= (handlerName ? RENDER_MIN_COMPONENTS_BESIDE_HANDLER : RENDER_MIN_COMPONENTS)));
  // The commit a render blame names is the one React spent longest on, committing and effects included,
  // so a 1 ms render whose layout effects ran for 200 ms is named over a 30 ms render beside it. Where
  // no commit has a span this is the heaviest render, as everywhere else. Committing and effects only
  // choose it where they are worth a mention at all, or a 1 ms render beside 30 ms of effects nobody
  // hears about is named over a 30 ms render. Without durations a commit is only named over the one
  // with the most components when its effects are what earned the blame.
  const own = (x: CommitSummary) => x.total + (committingOf.get(x) ?? 0) + (effectsOf.get(x) ?? 0);
  const rc = c && (hasDurations ? committingMatters : effectsEarn) ? r.commits.reduce((a, x) => (own(x) > own(a) ? x : a), c) : c;
  const rcCommitting = rc ? (committingOf.get(rc) ?? 0) : 0;
  const rcEffects = rc ? (effectsOf.get(rc) ?? 0) : 0;
  // Of a committing figure and an effects figure, which to say: each that would be worth saying alone,
  // or both where neither is and only the two together are.
  const worthSaying = (committed: number, ran: number): [boolean, boolean] => {
    const alone = [committingShows(committed), committingShows(ran)];
    const together = !alone[0] && !alone[1] && committingShows(committed + ran);
    return [alone[0] || (together && committed >= 1), alone[1] || (together && ran >= 1)];
  };
  // What committing that commit and running its effects took, where it is worth saying: a render
  // duration stops where committing starts, so layout effects that read geometry 400 times are nowhere in
  // it, and in a browser that does not time forced layout this is the only figure for them.
  const [sayCommitting, sayEffects] = worthSaying(rcCommitting, rcEffects);
  // The commits that hold the figures a sentence says, other than `except`, and where they were from
  // the point of view of the commit the sentence names.
  const holding = ([sayC, sayE]: [boolean, boolean], except: CommitSummary | null = null) =>
    r.commits.filter((x) => x !== except && ((sayC && (committingOf.get(x) ?? 0) >= 1) || (sayE && (effectsOf.get(x) ?? 0) >= 1)));
  const whereOf = (named: CommitSummary | null, said: [boolean, boolean]) => {
    const held = holding(said);
    return held.length > 1 ? ` across ${plural(held.length, 'commit')}` : held.length === 1 && held[0] !== named ? ' in another commit' : '';
  };
  const heldAll = includedN([...rendersInside.values()].reduce((a, x) => a + x, 0));
  const figures = (committed: number, ran: number, [sayC, sayE]: [boolean, boolean], its = '') =>
    [sayC ? `${ms(committed)} committing${its ? ' it' : ''}` : null, sayE ? `${ms(ran)} running ${its}useEffect callbacks` : null].filter((x): x is string => x !== null);
  // Committing and effects can earn the blame across several commits with no one commit's worth
  // saying. Then the totals are what earned it, and the sentence gives those.
  const sayTotals = committingMatters && !sayCommitting && !sayEffects;
  const totalsSaid = worthSaying(committing, effects);
  const totals = sayTotals ? figures(committing, effects, totalsSaid) : [];
  const acrossCommits = totals.length ? `${totals.join(' and ')}${whereOf(rc, totalsSaid)}` : null;
  // And where the named commit's are said, what the others spent beside them, where that is worth saying.
  const othersSaid = worthSaying(committing - rcCommitting, effects - rcEffects);
  const others = sayTotals || !rc ? [] : figures(committing - rcCommitting, effects - rcEffects, othersSaid);
  const othersBusy = holding(othersSaid, rc).length;
  const alsoOthers = others.length ? ` React also spent ${others.join(' and ')} in ${othersBusy === 1 ? 'another commit' : `${othersBusy} other commits`}.` : '';
  const extras = figures(rcCommitting, rcEffects, [sayCommitting, sayEffects], 'its ');
  if (sayEffects && rc) extras[extras.length - 1] += included(rc);
  // A figure that ends in the renders it holds takes a comma before the sentence goes on.
  const committedEnd = sayEffects && rc && included(rc) ? ',' : '';
  const committed = extras.length === 2 ? `, ${extras[0]} and ${extras[1]}` : extras.length === 1 ? ` and ${extras[0]}` : acrossCommits ? ` and ${acrossCommits}` : '';
  // In a production build the effects are the only figure, and the totals are said, since there is no
  // render figure to set one commit's beside.
  const effectsFigure = committingMatters ? effects : 0;
  const effectsWhere = `${whereOf(rc, [false, true])}${heldAll}`;
  const profilingRender = profiling ? ' A profiling build of React would time the render too.' : '';
  // The handler is the blame where it outruns all of React's time, or where React's time, whatever it
  // is, would not be the blame anyway: a 28 ms handler beside a 4 ms render and 24 ms of effects.
  const handlerWins = outsideMatters && (outside > reactTime || !renderMatters);
  /**
   * Does the screen update outrank everything the working time holds? Nothing that happened in
   * there can account for more of the interaction than the working time it ran in, so that is what
   * the screen update is measured against — one comparison for the whole ladder, not one per rung
   * against whatever that rung happened to claim. Two things follow. A render or a layout is no
   * longer unseated by a screen update that beats it but not the time it sat in; and because this
   * is the *same* test the screen update's own rung asks, a rung it closes is one the screen update
   * is open to take. A longer wait before the handler can still take the verdict first, since that
   * rung sits above the screen update's. What cannot happen is a verdict refused here landing below
   * the screen update, which is where it turns into `script` or into nothing at all.
   *
   * It is also what keeps two interactions of the same shape from getting opposite verdicts on the
   * strength of a component count: paging a calendar forward and toggling a theme were both 88 ms
   * with 5 ms of working time and 82 of the screen updating, and only one of them came back a
   * render. Under a long task the screen update is never blamed at all, so nothing gives way to it
   * there.
   */
  const screenOutranks = r.presentation > LONG_TASK_MS && r.presentation > r.processing;
  // Forced layout is the one cost outside React the browser measures in every build, so it is weighed
  // against React's render rather than left as a footnote under it: `renderTotal` is 0 in a production
  // build, where a render the library only counted used to outrank a layout it had timed.
  const layoutMatters =
    forcedWhileHandling >= (hasDurations ? LONG_TASK_MS : FORCED_LAYOUT_MIN_MS_NO_DURATIONS) &&
    forcedWhileHandling >= FORCED_LAYOUT_MIN_SHARE * handledWindow &&
    forcedWhileHandling > renderTotal &&
    forcedWhileHandling > outside &&
    // A longer wait before the handlers is the answer, as it is for the handler rung: 26 ms of layout
    // at the end of a 300 ms wait did not make the click slow.
    r.processing >= r.inputDelay &&
    !screenOutranks;

  /**
   * What the ladder would have named had the screen update not outrun the whole working time. The
   * screen update winning the verdict is a tie-break, not a finding that the rest was nothing: a
   * 200 ms render inside a 425 ms interaction is worth knowing about even when the 215 ms of screen
   * update after it is worth more. So the rung the comparison closed leaves a note behind, the way a
   * forced layout that lost to a bigger claim already does. It follows the ladder's own order below
   * the layout rung, which needs no entry here because the forced-layout note further down already
   * fires on every blame that is not a layout; so the note never names a rung the comparison did not
   * close.
   *
   * It is held to the standard of the rung it stands in for: the same commit, the same duration that
   * rung would have blamed, and the same hedge. A note is a claim like any other. It is only pushed
   * where the verdict really is the screen update, because its wording ("... before that") is about
   * the screen update. Hydration sits above the comparison and closes nothing, so repeating its
   * milliseconds as a leftover would say them twice. A `waiting` verdict can take the blame with a
   * rung closed, and there the note is dropped: known, and it wants its own phrasing, not this one.
   */
  const closedByTheScreen: string | null =
    !screenOutranks || !c || !rc
      ? null
      : handlerWins
        ? say(
            measuredFrom(...r.commits),
            `${cap(outsideName)} still ran for about ${ms(outside)} of the ${ms(r.processing)} of working time before that.`,
            `${cap(outsideName)} ${HEDGE} still ran for about ${ms(outside)} of the ${ms(r.processing)} of working time before that.`,
          )
        : renderMatters
          ? say(
              measuredFrom(rc),
              `React still spent ${ms(rc.total)} ${renderPhrase(rc)}${committed}${committedEnd} in the ${ms(r.processing)} of working time before that.`,
              hasDurations
                ? `React ${HEDGE} still spent about ${ms(rc.total)} ${renderPhrase(rc)}${committed}${committedEnd} in the ${ms(r.processing)} of working time before that.`
                : effectsFigure >= 1
                  ? `React was ${HEDGE} still ${renderPhrase(rc)}, then spent ${ms(effectsFigure)} running useEffect callbacks${effectsWhere}${heldAll ? ',' : ''} in the ${ms(r.processing)} of working time before that.`
                  : `React was ${HEDGE} still ${renderPhrase(rc)} in the ${ms(r.processing)} of working time before that.`,
            )
          : null;

  // A click can land on server-rendered HTML React has not reached yet, which is the commonest cause
  // of a slow first interaction in a server-rendered app. When React hydrated it inside the
  // interaction, that hydration is the story, ahead of what it rendered or what the handler did.
  const hydrating = r.commits.find((x) => x.hydratedTarget != null) ?? null;
  const waited = r.hydration?.kind === 'waited' && hydrating && carriesWork(hydrating) ? { boundary: r.hydration, commit: hydrating } : null;
  // It takes the blame only when it is what the working time went on. A boundary that hydrated in
  // 2 ms ahead of a 400 ms handler is worth the note below, not the verdict. Where the build records
  // no durations there is no figure to weigh, and the commit carrying real work is the whole test.
  const hydrationTook = waited && (waited.boundary.ms == null || (waited.boundary.ms >= RENDER_MIN_MS && waited.boundary.ms > outside)) ? waited : null;

  // The sentence and the data version of it are decided together, so a UI that shows the
  // short form never disagrees with the long one.
  let cause: string;
  let blame: Blame;
  if (hydrationTook) {
    const { boundary, commit } = hydrationTook;
    const confidence = measuredFrom(commit);
    const first = `The ${kind} landed on server-rendered HTML that had not been hydrated yet, so React hydrated ${boundaryPhrase(boundary)} first`;
    cause =
      boundary.ms == null
        ? `${first}, ${renderedCount(commit)}: ${HEDGE} what the ${ms(r.processing)} of working time went on. This React build records no render durations, so that is read from the component count.${profiling}`
        : say(confidence, `${first}: ${ms(boundary.ms)} of the ${ms(r.processing)} of working time.`, `${first}, ${HEDGE} ${ms(boundary.ms)} of the ${ms(r.processing)} of working time.${profiling}`);
    blame = { kind: 'hydration', name: boundaryPhrase(boundary), detail: mostlyOf(commit), ms: boundary.ms, confidence };
  } else if (layoutMatters) {
    // The number is the browser's and nothing React did changes it, so the confidence is about the
    // measurement alone: whether any of the total had to be apportioned across the edge of the window.
    const confidence = forcedLayoutMeasured(whileHandling) ? 'measured' : 'inferred';
    const charged = mostForcedLayout(whileHandling);
    const invoker = charged ? scriptName(charged.script) : null;
    // The name beside that number is not the browser's: it comes from a commit, and a commit that
    // only overlapped the interaction in time, or was walked short of the end, or sits beside commits
    // that could not be tied to this interaction at all, cannot say the layout happened in the
    // subtree it names. Then the name is dropped rather than the confidence, because everything left
    // — the milliseconds and the invoker — is still something the browser measured. Render durations
    // are not part of this test: a production build records none and its names are no worse for it.
    const named = c && !unjoined && namesThisInteraction(c) ? c : null;
    // One script holding nearly all of the total is where the layout happened; several scripts
    // sharing it means no one script is, and then nothing but the commit can name this.
    const holdsMostOfIt = !!charged && charged.forcedLayout >= FORCED_LAYOUT_ONE_SCRIPT_SHARE * forcedWhileHandling;
    /**
     * Everything in the window the sentence is about: the handlers, React's render and commit, and
     * this library's read of what React rendered. That is the window the browser counted the forced
     * layout across, so it is the only one the layout can be subtracted from and leave a true
     * remainder. It is deliberately not `processing`, which has the library's own read taken back
     * out of it and is what the Working phase and the walk note both report.
     */
    const window = `${ms(handledWindow)} spent handling the ${kind}`;
    // What is left of that window bounds everything else in it, React's render included, which is the
    // whole of why this outranks a render the build never timed. Unless React's render is itself
    // timed higher than that remainder: the browser charges forced layout to the script it happened
    // in, and that can be a render body reading geometry, so the two overlap and the remainder bounds
    // nothing. Claiming it did would contradict the sentence about the render next.
    const left = Math.max(0, handledWindow - forcedWhileHandling);
    // The remainder covers the walk because the window it came from does. Naming the walk only when
    // it is worth a whole millisecond keeps it out of the sentence for every ordinary interaction.
    const ourRead = r.walkMs >= 0.5 ? ", this library's read of what React rendered" : '';
    const overlapping = hasDurations && renderTotal > left;
    const rest = overlapping
      ? "which overlaps React's own render: geometry read inside a render body is charged to both"
      : `leaving ${ms(left)} for React's render and commit, its layout effects${ourRead} and the ${kind} handler together`;
    const spent = `${ms(forcedWhileHandling)} of the ${window} recalculating layout, ${rest}`;
    // Where the layout happened and where React was working are two different records, and the
    // browser's is the one that is never a reading. Naming the subtree without it would point a
    // reader at a file that need have nothing to do with the layout: an observer callback running
    // inside the same window is charged separately and looks identical from the React side. The
    // sentence says it whatever the blame is named after, because the cause is read on its own; and
    // it prints the script's own share whenever the script does not hold nearly all of the total,
    // since the total is several scripts' and the name beside it would claim all of it for one.
    const chargedTo = charged && invoker ? ` ${holdsMostOfIt ? 'It' : `${ms(charged.forcedLayout)} of it`} was charged to ${invoker}.` : '';
    // The clause about React is hedged on the same evidence the name is: a commit this interaction
    // cannot claim, and, where the clause prints a duration, a duration that is not a measurement.
    // A production build's component counts are measured by the walk, so they are not hedged here.
    const reactSure = !!named && (!hasDurations || measuredFrom(named) === 'measured');
    const maybe = reactSure ? '' : `${HEDGE} `;
    const rendered = c ? ` ${hasDurations ? `React ${maybe}spent ${ms(renderTotal)} ${renderPhrase(c)}` : `React was ${maybe}${renderPhrase(c)}`}.` : '';
    cause = `${say(confidence, `The browser spent ${spent}.`, `The browser ${HEDGE} spent ${spent}.`)}${chargedTo}${rendered} That happens when code reads an element's size right after changing styles, often in a layout effect.`;
    // Nothing names the read that forced the layout. What is held is where it happened: the subtree
    // of the commit this interaction joined, or, failing that, the script the browser charged it to
    // — and that only while one script holds nearly all of it, since `ms` is the whole total and a
    // name beside it is read as owning all of it.
    blame = {
      kind: 'layout',
      name: named ? leafOf(named) : holdsMostOfIt ? invoker : null,
      detail: named ? mostlyOf(named) : null,
      ms: forcedWhileHandling,
      confidence,
    };
  } else if (c && handlerWins && !screenOutranks) {
    const confidence = measuredFrom(...r.commits);
    const rest = renderTotal >= RENDER_MIN_MS ? `React spent ${ms(renderTotal)} ${renderPhrase(c)}` : `React's own render took ${renderTotal < 0.5 ? 'under 1 ms' : `only ${ms(renderTotal)}`}`;
    // Committing and effects React spent beside it, where they would be worth saying. They are the
    // totals, since the render named here need not be the commit that spent them.
    const spent = figures(committing, effects, totalsSaid);
    const also = spent.length ? ` React also spent ${spent.join(' and ')}${whereOf(c, totalsSaid)}.` : '';
    cause = say(confidence, `${cap(outsideName)} ran for about ${ms(outside)}; ${rest}.${also}`, `${cap(outsideName)} ${HEDGE} took about ${ms(outside)}; ${rest}.${also}${profiling}`);
    // A listener React did not attach (a shortcut bound on the document, a library's own listener) has
    // no React name, and "code outside React" sends nobody anywhere. The browser still says which
    // listener it ran and from which file, so the sentence passes that on as what the browser
    // recorded. It is not said to be the 190 ms: the script's time can hold React's render too.
    const listener = handlerName ? null : longestPart(whileHandling);
    const listenerName = listener ? scriptName(listener.script) : null;
    if (listener && listenerName) cause += ` The longest script the browser recorded in that time was ${listenerName}${listener.script.source ? ` (${listener.script.source})` : ''}, ${ms(listener.ms)}.`;
    // It names the blame only where it covers most of the time being blamed.
    const blamedListener = listener && listener.ms >= WAITED_BEHIND_MIN_SHARE * outside ? listenerName : null;
    // The component is the target's, which is where a React handler lives. A listener on the document
    // lives nowhere in the tree, so a name that came from the browser goes without one.
    blame = { kind: 'handler', name: handlerName ?? blamedListener, detail: blamedListener && !handlerName ? null : component, ms: outside, confidence };
  } else if (c && rc && renderMatters && !screenOutranks) {
    const confidence = measuredFrom(rc);
    // Without durations the blame rests on the component count alone, which is why it is a reading:
    // 600 cheap components can outrank the one expensive component that actually took the time.
    const likely = hasDurations
      ? // The measured render is the claim; the working time is context. Saying React spent all of it
        // rendering and then that other code ran for a third of it was two claims that cannot both hold.
        `React ${HEDGE} spent about ${ms(rc.total)} of the ${ms(r.processing)} of working time ${renderPhrase(rc)}.`
      : `React was ${HEDGE} ${renderPhrase(rc)}. This React build records no render durations, so that is read from the component counts, not measured.`;
    // A production build times the effects but not the render, so there the effects lead.
    cause =
      !hasDurations && effectsFigure >= 1
        ? `React was ${HEDGE} ${renderPhrase(rc)}, then ran useEffect callbacks for about ${ms(effectsFigure)} of the ${ms(r.processing)} of working time${effectsWhere}, before the screen could update.${profilingRender}`
        : say(confidence, `React spent ${ms(rc.total)} ${renderPhrase(rc)}.`, `${likely}${profiling}`);
    if (sayCommitting) cause += ` Committing it took about ${ms(rcCommitting)} more: the DOM changes, ref callbacks and layout effects.`;
    if (sayEffects && hasDurations) cause += ` The commit's useEffect callbacks then ran for about ${ms(rcEffects)} more${included(rc)}, before the screen could update.`;
    if (acrossCommits && hasDurations) cause += ` React also spent ${acrossCommits}.`;
    if (hasDurations) cause += alsoOthers;
    if (outsideMatters) cause += ` On top of that, ${outsideName} ran for about ${ms(outside)}.`;
    // The milliseconds are the commit's in all, its render, committing and effects, which is what it
    // accounts for; the render alone was 5 ms for a commit whose effects ran for 300.
    blame = { kind: 'render', name: leafName(rc), detail: mostlyOf(rc), ms: hasDurations ? own(rc) : null, confidence };
  } else if (c && !hasDurations && handler && r.processing >= LONG_TASK_MS && r.processing >= r.inputDelay && r.processing >= r.presentation) {
    const howLittle = c.rendered === 0 ? 'React rendered nothing' : `React re-rendered only ${plural(c.rendered, 'component')}`;
    // The effects are measured in every build, so they come off what the handler is said to have taken.
    const took = effects >= 1 ? `about ${ms(r.processing - effects)} of the ${ms(r.processing)}` : `the ${ms(r.processing)}`;
    const ranEffects = effects >= 1 ? ` and ran useEffect callbacks for ${ms(effects)}${heldAll}` : '';
    cause = `${cap(handler)} ${HEDGE} took ${took}: ${howLittle}${ranEffects}.${profiling}`;
    blame = { kind: 'handler', name: handlerName, detail: component, ms: null, confidence: 'inferred' };
  } else if (r.inputDelay > LONG_TASK_MS && r.inputDelay >= r.processing && r.inputDelay >= r.presentation) {
    // What the input waited behind is usually on record: the long animation frame that was open when
    // it came lists its scripts, and the one that filled the wait is the thing to go and look at. It is
    // counted for its part inside the wait only, since what it did before the input came delayed nobody.
    const behind = longestPart(scriptParts(frames, r.start, processingStart));
    if (behind) {
      const s = behind.script;
      const already = s.start < r.start - STAMP_TOLERANCE;
      const what = aScript(s);
      cause = `The ${kind} waited ${ms(r.inputDelay)} before its handler could start: ${what} ${already ? `was already running when the ${kind} came and` : 'ran first and'} held the main thread for ${Math.round(behind.ms) >= Math.round(r.inputDelay) ? 'all' : ms(behind.ms)} of that wait.`;
    } else {
      cause = `The ${kind} waited ${ms(r.inputDelay)} before its handler could start: the main thread was busy with something else.`;
    }
    // The milliseconds are the wait, so the script only gets its name on them when it filled most of
    // it. A 30 ms timer inside a 400 ms wait is in the sentence, with its own figure, and is not the blame.
    const named = behind && behind.ms >= WAITED_BEHIND_MIN_SHARE * r.inputDelay ? scriptName(behind.script) : null;
    blame = { kind: 'waiting', name: named, detail: null, ms: r.inputDelay, confidence: 'measured' };
  } else if (screenOutranks) {
    // The same test the rungs above were closed by, so one of the two always fires: a verdict cannot
    // be refused for the screen update and then fall past it.
    cause = `After the ${kind} was handled, the screen took another ${ms(r.presentation)} to update${lateScriptClause}`;
    blame = { kind: 'painting', name: lateScript ? scriptBlameName(lateScript.script) : null, detail: null, ms: r.presentation, confidence: 'measured' };
  } else if (anyScript) {
    // A script is what is left once React is ruled out, so a commit that could not be tied to the
    // interaction is exactly what stops this from being a finding.
    const confidence = unjoined ? 'inferred' : 'measured';
    const small = c ? `React's render was small (${renderPhrase(c)})` : renderedNothing;
    // A script cut by the interaction's edges ran for longer than the part counted here.
    const ofIt = Math.round(anyScript.ms) < Math.round(anyScript.script.duration) ? ' of it' : '';
    const ran = `${scriptPhrase(anyScript.script)} ran for ${ms(anyScript.ms)}${ofIt}`;
    cause = say(confidence, `${small}; ${ran}.`, `${small}; ${HEDGE} ${ran}.`);
    blame = { kind: 'script', name: scriptBlameName(anyScript.script), detail: ranAsHandler(anyScript.script) ? component : null, ms: anyScript.ms, confidence };
  } else if (r.frames) {
    cause = c
      ? `React's render was small (${renderPhrase(c)}) and no long task was recorded, so the rest went to waiting and painting.`
      : `${renderedNothing} and no long task was recorded, so the time went to waiting and painting.`;
    // Nothing is named, so there is nothing to hedge; the confidence says whether the absence of a
    // long task was itself observed or merely assumed.
    blame = { kind: 'none', name: null, detail: null, ms: null, confidence: unjoined ? 'inferred' : 'measured' };
  } else {
    // Without Long Animation Frames there is no record to say no long task ran.
    cause = c
      ? `React's render was small (${renderPhrase(c)}); this browser does not report long tasks, so what else ran is unknown.`
      : `${renderedNothing}; this browser does not report long tasks, so what ran instead is unknown.`;
    blame = { kind: 'none', name: null, detail: null, ms: null, confidence: 'inferred' };
  }

  // React stops an event at a boundary it has not hydrated: it never dispatches it, so hardly any
  // working time goes by and the slow part is the wait before it or the paint after. That verdict
  // still holds and stands above; this goes in front of it, because it is the thing worth knowing.
  if (r.hydration?.kind === 'not-hydrated') {
    cause = `This ${kind} landed on server-rendered HTML that React had not hydrated yet, so React did not dispatch it and no React handler ran for it. ${cause}`;
  }

  if (unjoined) {
    notes.push(
      `React committed ${plural(r.unjoinedCommits, 'time')} while this ${kind} was being handled that could not be tied to it, so what it rendered is left out of this report. That happens when the commit landed more than ${ms(joinWindow() ?? DEFAULT_INPUT_WINDOW)} after the last commit inside the ${kind}'s own dispatch, or after the ${kind} itself where React committed nothing inside it, with no way to tell it from an unrelated update.`,
    );
  }
  if (r.startedNavigation) notes.push(`It started a navigation to ${linkText(r.startedNavigation.url, r.navigationURL)}.`);
  if (r.hydration?.kind === 'waited' && blame.kind !== 'hydration') {
    // Saying it was not what took the time is a measurement. Where the build records no durations
    // nobody measured it, and the sentence would be a guess dressed as a finding.
    const notTheStory = r.hydration.ms == null ? '' : ' That was not what took the time here.';
    notes.push(`It landed on server-rendered HTML that had not been hydrated yet, and React hydrated ${boundaryPhrase(r.hydration)} during it.${notTheStory}`);
  }
  if (c) {
    // A hydration is not a re-render: it is the first render of that HTML on the client, and counting
    // it here would tell every click that waited for one to go looking for an effect that updates state.
    const real = r.commits.filter((x) => carriesWork(x) && x.hydratedTarget == null).length;
    if (real > 1) notes.push(`React rendered ${real} times before the screen updated, which usually means a state update inside an effect or a chain of updates.`);
    if (r.inputDelay > LONG_TASK_MS && renderMatters) notes.push(`It also waited ${ms(r.inputDelay)} before the handler could start, because the main thread was busy.`);
    if (c.truncated) notes.push('The component count is partial: the walk stopped at its budget or at its depth limit.');
  }
  if (namesLookMinified([...r.commits, ...r.followUps])) notes.push(MINIFIED_NAMES_NOTE);
  if (forcedAfterInput >= FORCED_LAYOUT_MIN_MS && blame.kind !== 'layout') {
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
  // The other half of that note: where the screen update did take the blame, the work it outranked
  // is what this report would otherwise never mention. Only where it took it, though — a rung above
  // the comparison that won anyway had nothing closed off, and its own time is already in the cause.
  if (closedByTheScreen && blame.kind === 'painting') notes.push(closedByTheScreen);
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

  // Hydrating runs inside the event's own dispatch, so it is part of the working time rather than a
  // fourth phase beside it: the three phases go on adding up to the interaction the way they always did.
  const hydrationMs = waited && waited.boundary.ms != null ? Math.min(waited.boundary.ms, r.processing) : 0;
  const working: Phase = { label: 'Working', ms: r.processing, hint: 'Event handlers and React rendering.' };
  const phases: Phase[] = [
    { label: 'Waiting', ms: r.inputDelay, hint: 'Before the handler could start. The main thread was busy.' },
    hydrationMs > 0 ? { ...working, parts: Object.freeze([Object.freeze({ label: 'Hydrating', ms: hydrationMs, hint: 'React hydrating server-rendered HTML the interaction landed on, before it could be handled.' })]) } : working,
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

function toVerdict(x: Explanation): string {
  return `${x.headline}${x.where ? ` on ${x.where}` : ''}. ${x.cause}${x.notes.length ? ' ' + x.notes.join(' ') : ''}`;
}
