import { fiberFromNode, handlerOf, ownersOf, type Fiber } from './fiber.ts';
import { rateInp } from './inp.ts';
import type { InteractionTiming } from './observe.ts';
import type { Blame, CommitSummary, EventEntrySummary, Explanation, FrameSummary, InputRecord, InteractionReport, ScriptSummary, TargetInfo } from './types.ts';

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
// A Long Animation Frames script is named from 20 ms: the API lists scripts from 5 ms, and one
// under 20 did not make its frame long by itself (a long frame is over 50 ms).
const SCRIPT_MIN_MS = 20;
// Waiting, the screen update, and working time without durations are blamed from 50 ms, the length
// of a long task: the least the browser itself calls long.
const LONG_TASK_MS = 50;
// A later render is worth a sentence from 10 ms or 25 components. The page's own reporting UI
// re-renders after every report (the demo's "What took time" panel: 6 to 14 components, under 2 ms)
// and would otherwise be in every report.
const LATER_MIN_MS = 10;
const LATER_MIN_COMPONENTS = 25;
// Forced layout is worth a sentence from 4 ms, a quarter of a frame.
const FORCED_LAYOUT_MIN_MS = 4;
// The screen update gets a note of its own from 100 ms, half of INP's 200 ms budget for "good".
const PRESENTATION_NOTE_MS = 100;
// A press held around the interaction is worth a note from 100 ms; an ordinary click is shorter.
const HOLD_NOTE_MS = 100;

// A label names the clicked element; it is not a copy of it. The element can be a list of 3000
// rows, and reading all of its text would cost more than the rest of the report, so only the
// aria-label, a form field's placeholder or the first run of text is read, up to 40 characters.
const LABEL_CHARS = 40;
// Nodes the search for that first run of text looks at: enough to get past an icon, not to crawl a table.
const LABEL_NODES = 32;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
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

/** A report's fields apart from the explanation and verdict, which are built on first read. */
type ReportData = Omit<InteractionReport, 'explanation' | 'verdict'>;

interface PaintGroup {
  renderTime: number;
  processingStart: number;
  processingEnd: number;
  entries: InteractionTiming[];
}

/** What a person would call the interaction: "click", "tap", "key press" or "typing", from the event type. */
export function kindOf(type: string): string {
  return FRIENDLY[type] || type;
}

/** A later render worth a sentence, rather than the page's own reporting UI updating. */
const worthMentioning = (c: CommitSummary) => (c.hasDurations ? c.total >= LATER_MIN_MS : c.rendered >= LATER_MIN_COMPONENTS);

/** A render with real work in it, the kind the blame and the "rendered N times" note count; a status pill updating is not one. */
export const carriesWork = (c: CommitSummary) => (c.hasDurations ? c.total >= RENDER_MIN_MS : c.rendered >= RENDER_MIN_COMPONENTS);

/** A commit whose numbers stand on their own: durations measured on a clock fine enough for them, joined by its exact input stamp, walked in full. */
const measuredCommit = (c: CommitSummary) => c.hasDurations && !c.coarseClock && c.joinedBy === 'exact' && !c.truncated;

/** Entries whose paint landed within 8 ms of each other were presented by one frame. */
function groupByRenderTime(entries: InteractionTiming[]): PaintGroup[] {
  const groups: PaintGroup[] = [];
  for (const e of entries) {
    const renderTime = e.startTime + e.duration;
    let group: PaintGroup | null = null;
    for (let i = groups.length - 1; i >= 0; i--) {
      if (Math.abs(renderTime - groups[i].renderTime) <= RENDER_GROUP_MS) {
        group = groups[i];
        break;
      }
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

const near = (a: number, b: number) => Math.abs(a - b) <= STAMP_TOLERANCE;

/** Does the commit's input stamp (or the press that input released) match one of these entry start times? */
function stampMatches(c: CommitSummary, stamps: number[]): boolean {
  for (const s of stamps) if (near(s, c.inputTs) || near(s, c.gestureTs)) return true;
  return false;
}

const rank = (name: string) => {
  const i = PREFERRED.indexOf(name);
  return i < 0 ? PREFERRED.length : i;
};

const summarize = (e: InteractionTiming): EventEntrySummary => ({
  name: e.name,
  startTime: e.startTime,
  duration: e.duration,
  processingStart: e.processingStart,
  processingEnd: e.processingEnd,
});

const walked = (commits: CommitSummary[]): number => commits.reduce((a, c) => a + c.walkMs, 0);

/**
 * One report from every Event Timing entry seen for an interactionId. The headline is the
 * longest single entry, which is the number web-vitals reports as INP for the interaction;
 * `inputs` is the ring of recent inputs, used to tell whose commit is whose and to recover
 * the target when the entry's is gone.
 */
export function buildReport(entries: InteractionTiming[], commits: CommitSummary[], frames: FrameSummary[] | null, inputs: InputRecord[] = []): InteractionReport {
  return Object.defineProperties(reportData(entries, commits, frames, inputs), EXPLAINED_ON_READ) as InteractionReport;
}

function reportData(entries: InteractionTiming[], commits: CommitSummary[], frames: FrameSummary[] | null, inputs: InputRecord[]): ReportData {
  let longest = entries[0];
  for (const e of entries) if (e.duration > longest.duration) longest = e;
  const group = groupByRenderTime(entries).find((g) => g.entries.includes(longest))!;
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
  const ring = inputs.find((i) => stamps.some((s) => near(s, i.ts))) || null;
  // The entry's target is null when the node left the DOM before the observer ran (a close
  // button, a deleted row); the ring kept the node, and the fiber React has since detached.
  let targetNode: Node | null = null;
  for (const e of entries) {
    if (e.target) {
      targetNode = e.target;
      break;
    }
  }
  if (!targetNode && ring) targetNode = ring.target;
  const fiber = (targetNode && fiberFromNode(targetNode)) || (ring && ring.fiber) || null;
  let handler: string | null = null;
  for (const e of sorted) {
    handler = handlerOf(fiber, e.name);
    if (handler) break;
  }

  // Durations are rounded to 8 ms but processingEnd is exact, so a commit inside the
  // handlers is before the paint even when the rounded paint time says otherwise.
  const paintBound = Math.max(end, group.processingEnd);
  const inWindow: CommitSummary[] = [];
  const followUps: CommitSummary[] = [];
  for (const c of commits) {
    if (stampMatches(c, stamps)) {
      c.joinedBy = 'exact';
      // Work before the headline entry's own input (a press held before a click) is not
      // part of what INP measured for it; `holdMs` covers that time.
      if (c.at < start - STAMP_TOLERANCE) continue;
      if (c.at <= paintBound) inWindow.push(c);
      else if (c.at - start <= FOLLOW_UP_WINDOW && worthMentioning(c)) followUps.push(c);
    } else if (c.at >= processingStart - STAMP_TOLERANCE && c.at <= paintBound && !claimedElsewhere(c, inputs, stamps)) {
      // No stamp matched, but it ran between this interaction's handlers and its paint.
      c.joinedBy = c.joinedBy || 'overlap';
      inWindow.push(c);
    }
  }
  // The walk runs inside React's commit, so the walk of a commit during the handlers sits inside
  // the processing time the browser measured. That time is this library's, not the page's.
  let walkMs = 0;
  for (const c of inWindow) walkMs += Math.max(0, Math.min(c.at + c.walkMs, processingEnd) - Math.max(c.at, processingStart));
  const overlapping = frames && frames.filter((f) => f.start < end && f.start + f.duration > start);

  return {
    interactionId: longest.interactionId,
    type: sorted[0].name,
    start,
    end,
    duration,
    holdMs,
    entries: entries.map(summarize),
    inputDelay: processingStart - start,
    processing: processingEnd - processingStart - walkMs,
    walkMs,
    presentation: end - processingEnd,
    target: targetNode ? describeTarget(targetNode, fiber, handler) : null,
    commits: inWindow,
    followUps,
    frames: overlapping,
    laterFrames: frames && framesForLater(followUps, frames),
    revision: 0,
    overheadMs: walked(inWindow) + walked(followUps),
  };
}

/** Explanations built so far, by report. A report that changes is dropped from here and explained again when next read. */
const explanations = new WeakMap<ReportData, { explanation: Explanation; verdict: string }>();

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
function claimedElsewhere(c: CommitSummary, inputs: InputRecord[], stamps: number[]): boolean {
  return inputs.some((i) => near(i.ts, c.inputTs) && !stamps.some((s) => near(s, i.ts)));
}

/**
 * More entries arrived for an interaction whose report already exists (the click after a
 * held pointerdown, the keyup after a keydown). Rebuild it in place so listeners keep the
 * same object, and bump the revision.
 */
export function refreshReport(r: InteractionReport, entries: InteractionTiming[], commits: CommitSummary[], frames: FrameSummary[] | null, inputs: InputRecord[] = []): void {
  // Time already spent building the report stays counted; the walks are recounted for the commits it now holds.
  const building = r.overheadMs - walked(r.commits) - walked(r.followUps);
  const fresh = reportData(entries, commits, frames, inputs);
  Object.assign(r, fresh, { revision: r.revision + 1, overheadMs: fresh.overheadMs + building });
  explanations.delete(r);
}

function framesForLater(later: CommitSummary[], frames: FrameSummary[]): FrameSummary[] {
  return frames.filter((f) => later.some((c) => f.start <= c.at && f.start + f.duration >= c.at - Math.max(c.total, 16)));
}

function framesInWindow(r: InteractionReport, frames: FrameSummary[]): FrameSummary[] {
  return frames.filter((f) => f.start < r.end && f.start + f.duration > r.start);
}

/**
 * A long animation frame can arrive after the report was built (there is no settle timer),
 * so its forced layout and scripts were missing from the first explanation. Fold in any that
 * overlap the interaction's window or its later renders, and re-explain if anything changed.
 */
export function refreshFrames(r: InteractionReport, frames: FrameSummary[]): boolean {
  const inWindow = framesInWindow(r, frames);
  const later = framesForLater(r.followUps, frames);
  if (inWindow.length === r.frames?.length && later.length === r.laterFrames?.length) return false;
  r.frames = inWindow;
  r.laterFrames = later;
  explanations.delete(r);
  r.revision++;
  return true;
}

/** Does this commit belong to the report's input, landing after its paint? */
export function isLaterRender(r: InteractionReport, c: CommitSummary): boolean {
  return c.at > r.end && c.at - r.start <= FOLLOW_UP_WINDOW && stampMatches(c, r.entries.map((e) => e.startTime)) && worthMentioning(c);
}

/** Attach a later render to an already emitted report. Returns false if it was there already. */
export function attachLaterRender(r: InteractionReport, c: CommitSummary, frames: FrameSummary[] | null): boolean {
  if (r.followUps.includes(c)) return false;
  c.joinedBy = 'exact';
  r.followUps.push(c);
  r.overheadMs += c.walkMs;
  r.laterFrames = frames && framesForLater(r.followUps, frames);
  explanations.delete(r);
  r.revision++;
  return true;
}

function describeTarget(node: Node, fiber: Fiber | null, handler: string | null): TargetInfo {
  const owners = ownersOf(fiber);
  return {
    selector: selector(node),
    label: labelOf(node),
    component: owners[0] || null,
    owners,
    handler,
  };
}

function elementOf(node: Node): Element | null {
  return node.nodeType === ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function selector(node: Node): string | null {
  const el = elementOf(node);
  if (!el) return null;
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  const test = el.getAttribute('data-test') || el.getAttribute('data-testid');
  if (test) s += `[data-test=${test}]`;
  else if (el.classList && el.classList.length) s += '.' + Array.from(el.classList).slice(0, 2).join('.');
  return s;
}

function labelOf(node: Node): string | null {
  const el = elementOf(node);
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const word = tag === 'a' ? 'link' : tag;
  const field = tag === 'input' || tag === 'textarea' || tag === 'select';
  const text = el.getAttribute('aria-label') || (field ? el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('type') : firstText(el));
  const label = text ? clip(text) : '';
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
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** "the click handler handleLogin"; "the onClick handler" when the name is a prop's, which is all a minified build leaves. */
function handlerPhrase(name: string, kind: string): string {
  return /^on[A-Z]/.test(name) ? `the ${name} handler` : `the ${kind} handler ${name}`;
}

export function heaviest(list: CommitSummary[]): CommitSummary {
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

/** "re-rendering 801 components inside OrderSummary, mostly LineItem (800 of them, 161 ms)" */
function renderPhrase(c: CommitSummary): string {
  const leaf = leafOf(c);
  const top = c.components[0];
  if (c.rendered === 1) return `re-rendering ${leaf}`;
  let mostly = '';
  if (top && top.count > 1) {
    const time = top.self != null ? `, ${ms(top.self)}` : '';
    mostly = top.name === leaf ? ` (${top.count} of them${time})` : `, mostly ${top.name} (${top.count} of them${time})`;
  }
  return `re-rendering ${plural(c.rendered, 'component')} inside ${leaf}${mostly}`;
}

/** Longest script in frames overlapping [from, to], if it is long enough to matter. */
function longestScript(frames: FrameSummary[], from: number, to: number): ScriptSummary | null {
  let best: ScriptSummary | null = null;
  for (const f of frames) {
    for (const s of f.scripts) {
      if (s.start > to || s.start + s.duration < from) continue;
      if (!best || s.duration > best.duration) best = s;
    }
  }
  return best && best.duration >= SCRIPT_MIN_MS ? best : null;
}

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
  const scriptName = (s: ScriptSummary) => handler || `a script (${s.invoker || s.name || 'unknown'}${s.source ? `, ${s.source}` : ''})`;

  const forced = r.frames ? r.frames.reduce((a, f) => a + f.forcedLayout, 0) : 0;
  const c = r.commits.length ? heaviest(r.commits) : null;
  const renderTotal = r.commits.reduce((a, x) => a + x.total, 0);
  const hasDurations = !!c && c.hasDurations;
  // Working time that was neither React's render phase nor forced layout: the handler itself,
  // React committing what it rendered, or other scripts in the same task.
  const outside = Math.max(0, r.processing - renderTotal - forced);
  const outsideMatters = hasDurations && outside >= HANDLER_MIN_MS && outside >= HANDLER_MIN_SHARE * r.processing;
  // Without durations (production builds) a render only earns the blame when it is big; a
  // click that re-rendered 10 components and took 260 ms was slow in its handler.
  const renderMatters = !!c && (hasDurations ? renderTotal >= RENDER_MIN_MS : c.rendered >= (handlerName ? RENDER_MIN_COMPONENTS_BESIDE_HANDLER : RENDER_MIN_COMPONENTS));
  const processingEnd = r.start + r.inputDelay + r.processing + r.walkMs;
  // A change handler runs on the input event, after the key event was processed, so its
  // cost shows up between the handlers and the paint. Look for it there.
  const lateScript = r.frames && longestScript(r.frames, processingEnd - 5, r.end);
  const anyScript = r.frames && longestScript(r.frames, r.start, r.end);

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
    cause = `After the ${kind} was handled, the screen took another ${ms(r.presentation)} to update` + (lateScript ? `, mostly because ${scriptName(lateScript)} ran for ${ms(lateScript.duration)} before the next frame.` : '.');
    blame = { kind: 'painting', name: lateScript ? handlerName || lateScript.invoker || lateScript.name || null : null, detail: null, ms: r.presentation, confidence: 'measured' };
  } else if (anyScript) {
    const small = c ? `React's render was small (${renderPhrase(c)})` : `React didn't render anything`;
    cause = `${small}; ${scriptName(anyScript)} ran for ${ms(anyScript.duration)}.`;
    blame = { kind: 'script', name: handlerName || anyScript.invoker || anyScript.name || null, detail: component, ms: anyScript.duration, confidence: 'measured' };
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

  if (c) {
    const real = r.commits.filter(carriesWork).length;
    if (real > 1) notes.push(`React rendered ${real} times before the screen updated, which usually means a state update inside an effect or a chain of updates.`);
    if (r.inputDelay > LONG_TASK_MS && renderMatters) notes.push(`It also waited ${ms(r.inputDelay)} before the handler could start, because the main thread was busy.`);
    if (c.truncated) notes.push('The component count is partial: the walk stopped at its budget or at its depth limit.');
  }
  if (forced >= FORCED_LAYOUT_MIN_MS) {
    notes.push(`The browser also spent ${ms(forced)} recalculating layout during the same script. That happens when code reads an element's size right after changing styles, often in a layout effect.`);
  }
  if (r.followUps.length) {
    const f = heaviest(r.followUps);
    const what = f.hasDurations ? `${ms(f.total)} ${renderPhrase(f)}` : renderPhrase(f);
    const laterForced = r.laterFrames ? r.laterFrames.reduce((a, x) => a + x.forcedLayout, 0) : 0;
    const layout = laterForced >= FORCED_LAYOUT_MIN_MS ? `, and it made the browser recalculate layout for ${ms(laterForced)} on the way` : '';
    notes.push(`A second React render landed ${ms(f.at - r.end)} after the screen updated: ${what}${layout}. INP doesn't count it, but people still wait for it.`);
  }
  if (r.presentation > PRESENTATION_NOTE_MS && r.presentation > r.processing && blame.kind !== 'painting') {
    notes.push(`After the handler finished, the screen took another ${ms(r.presentation)} to update` + (lateScript ? `, mostly because ${scriptName(lateScript)} ran for ${ms(lateScript.duration)} before the next frame.` : '.'));
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

  const phases = [
    { label: 'Waiting', ms: r.inputDelay, hint: 'Before the handler could start. The main thread was busy.' },
    { label: 'Working', ms: r.processing, hint: 'Event handlers and React rendering.' },
    { label: 'Updating the screen', ms: r.presentation, hint: 'From the end of the handlers to the next painted frame.' },
  ];
  return { headline, blame, rating, where, cause, notes, phases };
}

export function toVerdict(x: Explanation): string {
  return `${x.headline}${x.where ? ` on ${x.where}` : ''}. ${x.cause}${x.notes.length ? ' ' + x.notes.join(' ') : ''}`;
}
