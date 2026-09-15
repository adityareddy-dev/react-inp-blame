import { fiberFromNode, handlerOf, ownersOf } from './fiber.ts';
import { rateInp } from './inp.ts';
import type { Blame, CommitSummary, EventEntrySummary, Explanation, FrameSummary, InputRecord, InteractionReport, TargetInfo } from './types.ts';

export const FOLLOW_UP_WINDOW = 1500;
// A commit's input stamp and an entry's startTime are the same clock (Event.timeStamp), so
// they agree to the timer's resolution; 1 ms covers the coarsening.
const STAMP_TOLERANCE = 1;
// Entries presented in the same frame share a render time to within 8 ms, the rounding
// Event Timing applies to durations. Same rule as web-vitals' groupEntriesByRenderTime.
const RENDER_GROUP_MS = 8;
// A later render has to be worth a sentence. Tiny ones (a status pill, a panel updating)
// are noise, and the page's own reporting UI would otherwise show up in every report.
const MIN_LATER_MS = 10;
const MIN_LATER_COUNT = 25;
const worthMentioning = (c: CommitSummary) => (c.hasDurations ? c.total >= MIN_LATER_MS : c.rendered >= MIN_LATER_COUNT);
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

interface PaintGroup {
  renderTime: number;
  processingStart: number;
  processingEnd: number;
  entries: any[];
}

/** Entries whose paint landed within 8 ms of each other were presented by one frame. */
function groupByRenderTime(entries: any[]): PaintGroup[] {
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

const summarize = (e: any): EventEntrySummary => ({
  name: e.name,
  startTime: e.startTime,
  duration: e.duration,
  processingStart: e.processingStart,
  processingEnd: e.processingEnd,
});

/**
 * One report from every Event Timing entry seen for an interactionId. The headline is the
 * longest single entry, which is the number web-vitals reports as INP for the interaction;
 * `inputs` is the ring of recent inputs, used to tell whose commit is whose and to recover
 * the target when the entry's is gone.
 */
export function buildReport(entries: any[], commits: CommitSummary[], frames: FrameSummary[] | null, inputs: InputRecord[] = []): InteractionReport {
  let longest = entries[0];
  for (const e of entries) if (e.duration > longest.duration) longest = e;
  const group = groupByRenderTime(entries).find((g) => g.entries.includes(longest))!;
  // The same clamps web-vitals applies: processing cannot start before this entry's input,
  // and cannot run past the paint that closed it (a sync modal can make it look that way).
  const start: number = longest.startTime;
  const processingStart = Math.max(group.processingStart, start);
  const end = Math.max(start + longest.duration, processingStart);
  const processingEnd = Math.min(group.processingEnd, end);
  const duration: number = longest.duration;
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
  const stamps: number[] = entries.map((e) => e.startTime);
  const ring = inputs.find((i) => stamps.some((s) => near(s, i.ts))) || null;
  // The entry's target is null when the node left the DOM before the observer ran (a close
  // button, a deleted row); the ring kept the node, and the fiber React has since detached.
  let targetNode: any = null;
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

  const inputDelay = processingStart - start;
  const processing = processingEnd - processingStart;
  const presentation = end - processingEnd;

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
  const overlapping = frames && frames.filter((f) => f.start < end && f.start + f.duration > start);

  const report: InteractionReport = {
    interactionId: longest.interactionId,
    type: sorted[0].name,
    start,
    end,
    duration,
    holdMs,
    entries: entries.map(summarize),
    inputDelay,
    processing,
    presentation,
    target: targetNode ? describeTarget(targetNode, fiber, handler) : null,
    commits: inWindow,
    followUps,
    frames: overlapping,
    laterFrames: frames && framesForLater(followUps, frames),
    revision: 0,
    explanation: null as any,
    verdict: '',
    overheadMs: inWindow.reduce((a, c) => a + c.walkMs, 0) + followUps.reduce((a, c) => a + c.walkMs, 0),
  };
  report.explanation = explain(report);
  report.verdict = toVerdict(report.explanation);
  return report;
}

/** The commit's stamp names another input the ring knows, one that is not part of this interaction. */
function claimedElsewhere(c: CommitSummary, inputs: InputRecord[], stamps: number[]): boolean {
  return inputs.some((i) => near(i.ts, c.inputTs) && !stamps.some((s) => near(s, i.ts)));
}

/**
 * More entries arrived for an interaction whose report already exists (the click after a
 * held pointerdown, the keyup after a keydown). Rebuild it in place so listeners keep the
 * same object, bump the revision, and say whether the headline moved.
 */
export function refreshReport(r: InteractionReport, entries: any[], commits: CommitSummary[], frames: FrameSummary[] | null, inputs: InputRecord[] = []): boolean {
  const fresh = buildReport(entries, commits, frames, inputs);
  const headlineChanged = fresh.duration !== r.duration || fresh.start !== r.start || fresh.type !== r.type;
  Object.assign(r, fresh, { revision: r.revision + 1 });
  return headlineChanged;
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
  r.explanation = explain(r);
  r.verdict = toVerdict(r.explanation);
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
  r.explanation = explain(r);
  r.verdict = toVerdict(r.explanation);
  r.revision++;
  return true;
}

function describeTarget(node: any, fiber: any, handler: string | null): TargetInfo {
  const owners = ownersOf(fiber);
  return {
    selector: selector(node),
    label: labelOf(node),
    component: owners[0] || null,
    owners,
    handler,
  };
}

function elementOf(node: any): any {
  return node.nodeType === 1 ? node : node.parentElement;
}

function selector(node: any): string | null {
  const el = elementOf(node);
  if (!el) return null;
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  const test = el.getAttribute && (el.getAttribute('data-test') || el.getAttribute('data-testid'));
  if (test) s += `[data-test=${test}]`;
  else if (el.classList && el.classList.length) s += '.' + Array.from(el.classList as string[]).slice(0, 2).join('.');
  return s;
}

function labelOf(node: any): string | null {
  const el = elementOf(node);
  if (!el || !el.getAttribute) return null;
  const tag = el.tagName.toLowerCase();
  const word = tag === 'a' ? 'link' : tag;
  const aria = el.getAttribute('aria-label');
  if (aria) return `${word} "${aria.trim().slice(0, 40)}"`;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const p = el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('type');
    return p ? `${word} "${p.slice(0, 40)}"` : word;
  }
  const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
  return text ? `${word} "${text.slice(0, 40)}"` : word;
}

const ms = (n: number): string => `${Math.round(n)} ms`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function heaviest(list: CommitSummary[]): CommitSummary {
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
function longestScript(frames: FrameSummary[], from: number, to: number) {
  let best: FrameSummary['scripts'][number] | null = null;
  for (const f of frames) {
    for (const s of f.scripts) {
      if (s.start > to || s.start + s.duration < from) continue;
      if (!best || s.duration > best.duration) best = s;
    }
  }
  return best && best.duration >= 20 ? best : null;
}

export function explain(r: InteractionReport): Explanation {
  const rating = rateInp(r.duration);
  const kind = FRIENDLY[r.type] || r.type;
  const headline = `${ms(r.duration)} ${kind}`;
  const where = r.target ? [r.target.label || r.target.selector, r.target.component ? `in ${r.target.component}` : ''].filter(Boolean).join(' ') || null : null;
  const notes: string[] = [];
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  const handler = r.target?.handler ? `the ${kind} handler ${r.target.handler}` : null;
  const outsideName = handler || `code outside React (the ${kind} handler or other scripts)`;
  const scriptName = (s: FrameSummary['scripts'][number]) => handler || `a script (${s.invoker || s.name || 'unknown'}${s.source ? `, ${s.source}` : ''})`;

  const forced = r.frames ? r.frames.reduce((a, f) => a + f.forcedLayout, 0) : 0;
  const c = r.commits.length ? heaviest(r.commits) : null;
  const renderTotal = r.commits.reduce((a, x) => a + x.total, 0);
  const hasDurations = !!c && c.hasDurations;
  // Working time that was neither React's render phase nor forced layout: the handler
  // itself, or other scripts in the same task.
  const outside = Math.max(0, r.processing - renderTotal - forced);
  const outsideMatters = hasDurations && outside >= 25 && outside >= 0.25 * r.processing;
  // Without durations (production builds) a render only earns the blame when it is big; a
  // click that re-rendered 10 components and took 260 ms was slow in its handler.
  const renderMatters = !!c && (hasDurations ? renderTotal >= 5 : c.rendered >= (r.target?.handler ? 50 : 10));
  const processingEnd = r.start + r.inputDelay + r.processing;
  // A change handler runs on the input event, after the key event was processed, so its
  // cost shows up between the handlers and the paint. Look for it there.
  const lateScript = r.frames && longestScript(r.frames, processingEnd - 5, r.end);
  const anyScript = r.frames && longestScript(r.frames, r.start, r.end);

  // The sentence and the data version of it are decided together, so a UI that shows the
  // short form never disagrees with the long one.
  let cause: string;
  let blame: Blame;
  const handlerName = r.target?.handler ?? null;
  const component = r.target?.component ?? null;
  if (c && outsideMatters && outside > renderTotal) {
    const rest = renderTotal >= 10 ? `React spent ${ms(renderTotal)} ${renderPhrase(c)}` : `React's own render was only ${ms(renderTotal)}`;
    cause = `${cap(outsideName)} ran for about ${ms(outside)}; ${rest}.`;
    blame = { kind: 'handler', name: handlerName, detail: component, ms: outside };
  } else if (c && renderMatters) {
    cause = hasDurations ? `React spent ${ms(c.total)} ${renderPhrase(c)}.` : `React was ${renderPhrase(c)}.`;
    if (outsideMatters) cause += ` On top of that, ${outsideName} ran for about ${ms(outside)}.`;
    blame = { kind: 'render', name: leafOf(c), detail: mostlyOf(c), ms: hasDurations ? c.total : null };
  } else if (c && !hasDurations && handlerName && r.processing >= 50 && r.processing >= r.inputDelay && r.processing >= r.presentation) {
    cause = `The ${kind} handler ${handlerName} most likely took the ${ms(r.processing)}: React re-rendered only ${plural(c.rendered, 'component')}. A profiling build of React would give exact numbers.`;
    blame = { kind: 'handler', name: handlerName, detail: component, ms: null };
  } else if (r.inputDelay > 50 && r.inputDelay >= r.processing && r.inputDelay >= r.presentation) {
    cause = `The ${kind} waited ${ms(r.inputDelay)} before its handler could start: the main thread was busy with something else.`;
    blame = { kind: 'waiting', name: null, detail: null, ms: r.inputDelay };
  } else if (r.presentation > 50 && r.presentation > r.processing) {
    cause = `After the ${kind} was handled, the screen took another ${ms(r.presentation)} to update` + (lateScript ? `, mostly because ${scriptName(lateScript)} ran for ${ms(lateScript.duration)} before the next frame.` : '.');
    blame = { kind: 'painting', name: lateScript ? handlerName || lateScript.invoker || lateScript.name || null : null, detail: null, ms: r.presentation };
  } else if (anyScript) {
    const small = c ? `React's render was small (${renderPhrase(c)})` : `React didn't render anything`;
    cause = `${small}; ${scriptName(anyScript)} ran for ${ms(anyScript.duration)}.`;
    blame = { kind: 'script', name: handlerName || anyScript.invoker || anyScript.name || null, detail: component, ms: anyScript.duration };
  } else if (r.frames) {
    cause = c
      ? `React's render was small (${renderPhrase(c)}) and no long task was recorded, so the rest went to waiting and painting.`
      : `React didn't render anything and no long task was recorded, so the time went to waiting and painting.`;
    blame = { kind: 'none', name: null, detail: null, ms: null };
  } else {
    // Without Long Animation Frames there is no record to say no long task ran.
    cause = c
      ? `React's render was small (${renderPhrase(c)}); this browser does not report long tasks, so what else ran is unknown.`
      : `React didn't render anything; this browser does not report long tasks, so what ran instead is unknown.`;
    blame = { kind: 'none', name: null, detail: null, ms: null };
  }

  if (c) {
    // Only renders that carry real work count here; a status pill or a panel updating does not.
    const real = r.commits.filter((x) => (x.hasDurations ? x.total >= 5 : x.rendered >= 10)).length;
    if (real > 1) notes.push(`React rendered ${real} times before the screen updated, which usually means a state update inside an effect or a chain of updates.`);
    if (r.inputDelay > 50 && renderMatters) notes.push(`It also waited ${ms(r.inputDelay)} before the handler could start, because the main thread was busy.`);
    if (c.truncated) notes.push('The component count is partial: the walk hit its budget.');
  }
  if (forced >= 4) {
    notes.push(`The browser also spent ${ms(forced)} recalculating layout during the same script. That happens when code reads an element's size right after changing styles, often in a layout effect.`);
  }
  if (r.followUps.length) {
    const f = heaviest(r.followUps);
    const what = f.hasDurations ? `${ms(f.total)} ${renderPhrase(f)}` : renderPhrase(f);
    const laterForced = r.laterFrames ? r.laterFrames.reduce((a, x) => a + x.forcedLayout, 0) : 0;
    const layout = laterForced >= 4 ? `, and it made the browser recalculate layout for ${ms(laterForced)} on the way` : '';
    notes.push(`A second React render landed ${ms(f.at - r.end)} after the screen updated: ${what}${layout}. INP doesn't count it, but people still wait for it.`);
  }
  if (r.presentation > 100 && r.presentation > r.processing && !cause.startsWith('After the')) {
    notes.push(`After the handler finished, the screen took another ${ms(r.presentation)} to update` + (lateScript ? `, mostly because ${scriptName(lateScript)} ran for ${ms(lateScript.duration)} before the next frame.` : '.'));
  }
  if (r.holdMs >= 100) {
    notes.push(`The whole ${kind}, from press to release, spanned ${ms(r.duration + r.holdMs)}; INP counts only its slowest part, so the rest is left out of the headline.`);
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
