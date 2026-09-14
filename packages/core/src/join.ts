import { handlerName, ownerChain } from './fiber';
import type { CommitSummary, Explanation, FrameSummary, InteractionReport, TargetInfo } from './types';

export const FOLLOW_UP_WINDOW = 1500;
// A later render has to be worth a sentence. Tiny ones (a status pill, a panel updating)
// are noise, and the page's own reporting UI would otherwise show up in every report.
// Event Timing rounds durations to 8 ms, so the paint can sit a few ms past `end`.
const PAINT_SLACK = 8;
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

export function buildReport(entries: any[], commits: CommitSummary[], frames: FrameSummary[]): InteractionReport {
  let start = Infinity;
  let end = -Infinity;
  let processingStart = Infinity;
  let processingEnd = -Infinity;
  let targetNode: any = null;
  for (const e of entries) {
    start = Math.min(start, e.startTime);
    end = Math.max(end, e.startTime + e.duration);
    processingStart = Math.min(processingStart, e.processingStart);
    processingEnd = Math.max(processingEnd, e.processingEnd);
    if (!targetNode && e.target) targetNode = e.target;
  }
  // A click arrives as pointerdown, pointerup and click entries sharing one interactionId.
  // Name the interaction by the most meaningful of them.
  const rank = (name: string) => {
    const i = PREFERRED.indexOf(name);
    return i < 0 ? PREFERRED.length : i;
  };
  const sorted = entries.slice().sort((a, b) => rank(a.name) - rank(b.name));
  const longest = sorted[0];
  let handler: string | null = null;
  for (const e of sorted) {
    if (e.target) handler = handlerName(e.target, e.name);
    if (handler) break;
  }
  const duration = end - start;
  const inputDelay = Math.max(0, processingStart - start);
  const processing = Math.max(0, processingEnd - processingStart);
  const presentation = Math.max(0, end - processingEnd);

  const inWindow = commits.filter((c) => c.at >= start - 1 && c.at <= end + PAINT_SLACK);
  // Same input (the commit's own input timestamp is within tolerance of this start), after the paint.
  const followUps = commits.filter(
    (c) => c.at > end + PAINT_SLACK && Math.abs(c.at - c.sinceInput - start) < 100 && c.at - start <= FOLLOW_UP_WINDOW && worthMentioning(c),
  );
  const overlapping = frames.filter((f) => f.start < end && f.start + f.duration > start);

  const report: InteractionReport = {
    interactionId: longest.interactionId,
    type: longest.name,
    start,
    end,
    duration,
    inputDelay,
    processing,
    presentation,
    target: targetNode ? describeTarget(targetNode, handler) : null,
    commits: inWindow,
    followUps,
    frames: overlapping,
    laterFrames: framesForLater(followUps, frames),
    revision: 0,
    explanation: null as any,
    verdict: '',
    overheadMs: inWindow.reduce((a, c) => a + c.walkMs, 0) + followUps.reduce((a, c) => a + c.walkMs, 0),
  };
  report.explanation = explain(report);
  report.verdict = toVerdict(report.explanation);
  return report;
}

function framesForLater(later: CommitSummary[], frames: FrameSummary[]): FrameSummary[] {
  return frames.filter((f) => later.some((c) => f.start <= c.at && f.start + f.duration >= c.at - Math.max(c.total, 16)));
}

/** Does this commit belong to the report's input, landing after its paint? */
export function isLaterRender(r: InteractionReport, c: CommitSummary): boolean {
  return c.at > r.end + PAINT_SLACK && c.at - r.start <= FOLLOW_UP_WINDOW && Math.abs(c.at - c.sinceInput - r.start) < 100 && worthMentioning(c);
}

/** Attach a later render to an already emitted report. Returns false if it was there already. */
export function attachLaterRender(r: InteractionReport, c: CommitSummary, frames: FrameSummary[]): boolean {
  if (r.followUps.includes(c)) return false;
  r.followUps.push(c);
  r.overheadMs += c.walkMs;
  r.laterFrames = framesForLater(r.followUps, frames);
  r.explanation = explain(r);
  r.verdict = toVerdict(r.explanation);
  r.revision++;
  return true;
}

/** A long animation frame arrived; if it overlaps this report's later renders, fold it in. */
export function refreshLaterFrames(r: InteractionReport, frames: FrameSummary[]): boolean {
  if (!r.followUps.length) return false;
  const next = framesForLater(r.followUps, frames);
  if (next.length === r.laterFrames.length) return false;
  r.laterFrames = next;
  r.explanation = explain(r);
  r.verdict = toVerdict(r.explanation);
  r.revision++;
  return true;
}

function describeTarget(node: any, handler: string | null): TargetInfo {
  const owners = ownerChain(node);
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

/** "re-rendering 801 components inside OrderSummary, mostly LineItem (800 of them, 161 ms)" */
function renderPhrase(c: CommitSummary): string {
  const leaf = c.hotPath[c.hotPath.length - 1] || c.roots[0] || 'the app';
  const top = c.components[0];
  if (c.rendered === 1) return `re-rendering ${leaf}`;
  let mostly = '';
  if (top && top.count > 1) {
    const time = top.self != null ? `, ${ms(top.self)}` : '';
    mostly = top.name === leaf ? ` (${top.count} of them${time})` : `, mostly ${top.name} (${top.count} of them${time})`;
  }
  return `re-rendering ${plural(c.rendered, 'component')} inside ${leaf}${mostly}`;
}

function topScript(frames: FrameSummary[]) {
  let best: FrameSummary['scripts'][number] | null = null;
  for (const f of frames) for (const s of f.scripts) if (!best || s.duration > best.duration) best = s;
  return best;
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
  const rating = r.duration <= 200 ? 'good' : r.duration <= 500 ? 'needs-work' : 'poor';
  const kind = FRIENDLY[r.type] || r.type;
  const headline = `${ms(r.duration)} ${kind}`;
  const where = r.target ? [r.target.label || r.target.selector, r.target.component ? `in ${r.target.component}` : ''].filter(Boolean).join(' ') || null : null;
  const notes: string[] = [];
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  const handler = r.target?.handler ? `the ${kind} handler ${r.target.handler}` : null;
  const outsideName = handler || `code outside React (the ${kind} handler or other scripts)`;
  const scriptName = (s: FrameSummary['scripts'][number]) => handler || `a script (${s.invoker || s.name || 'unknown'}${s.source ? `, ${s.source}` : ''})`;

  const forced = r.frames.reduce((a, f) => a + f.forcedLayout, 0);
  const c = r.commits.length ? heaviest(r.commits) : null;
  const renderTotal = r.commits.reduce((a, x) => a + x.total, 0);
  const hasDurations = !!c && c.hasDurations;
  // Working time that was neither React's render phase nor forced layout: the handler
  // itself, or other scripts in the same task.
  const outside = Math.max(0, r.processing - renderTotal - forced);
  const outsideMatters = hasDurations && outside >= 25 && outside >= 0.25 * r.processing;
  const renderMatters = !!c && (hasDurations ? renderTotal >= 5 : c.rendered >= 10);
  const processingEnd = r.start + r.inputDelay + r.processing;
  // A change handler runs on the input event, after the key event was processed, so its
  // cost shows up between the handlers and the paint. Look for it there.
  const lateScript = longestScript(r.frames, processingEnd - 5, r.end);
  const anyScript = longestScript(r.frames, r.start, r.end);

  let cause: string;
  if (c && outsideMatters && outside > renderTotal) {
    const rest = renderTotal >= 10 ? `React spent ${ms(renderTotal)} ${renderPhrase(c)}` : `React's own render was only ${ms(renderTotal)}`;
    cause = `${cap(outsideName)} ran for about ${ms(outside)}; ${rest}.`;
  } else if (c && renderMatters) {
    cause = hasDurations ? `React spent ${ms(c.total)} ${renderPhrase(c)}.` : `React was ${renderPhrase(c)}.`;
    if (outsideMatters) cause += ` On top of that, ${outsideName} ran for about ${ms(outside)}.`;
  } else if (r.inputDelay > 50 && r.inputDelay >= r.processing && r.inputDelay >= r.presentation) {
    cause = `The ${kind} waited ${ms(r.inputDelay)} before its handler could start: the main thread was busy with something else.`;
  } else if (r.presentation > 50 && r.presentation > r.processing) {
    cause = `After the ${kind} was handled, the screen took another ${ms(r.presentation)} to update` + (lateScript ? `, mostly because ${scriptName(lateScript)} ran for ${ms(lateScript.duration)} before the next frame.` : '.');
  } else if (anyScript) {
    const small = c ? `React's render was small (${renderPhrase(c)})` : `React didn't render anything`;
    cause = `${small}; ${scriptName(anyScript)} ran for ${ms(anyScript.duration)}.`;
  } else {
    cause = c
      ? `React's render was small (${renderPhrase(c)}) and no long task was recorded, so the rest went to waiting and painting.`
      : `React didn't render anything and no long task was recorded, so the time went to waiting and painting.`;
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
    const laterForced = r.laterFrames.reduce((a, x) => a + x.forcedLayout, 0);
    const layout = laterForced >= 4 ? `, and it made the browser recalculate layout for ${ms(laterForced)} on the way` : '';
    notes.push(`A second React render landed ${ms(f.at - r.end)} after the screen updated: ${what}${layout}. INP doesn't count it, but people still wait for it.`);
  }
  if (r.presentation > 100 && r.presentation > r.processing && !cause.startsWith('After the')) {
    notes.push(`After the handler finished, the screen took another ${ms(r.presentation)} to update` + (lateScript ? `, mostly because ${scriptName(lateScript)} ran for ${ms(lateScript.duration)} before the next frame.` : '.'));
  }

  const phases = [
    { label: 'Waiting', ms: r.inputDelay, hint: 'Before the handler could start. The main thread was busy.' },
    { label: 'Working', ms: r.processing, hint: 'Event handlers and React rendering.' },
    { label: 'Updating the screen', ms: r.presentation, hint: 'From the end of the handlers to the next painted frame.' },
  ];
  return { headline, rating, where, cause, notes, phases };
}

export function toVerdict(x: Explanation): string {
  return `${x.headline}${x.where ? ` on ${x.where}` : ''}. ${x.cause}${x.notes.length ? ' ' + x.notes.join(' ') : ''}`;
}
