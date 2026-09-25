import { heaviest, leafName } from './commits.js';
import type { InpEstimate } from './inp.js';
import { carriesWork, isPointerEvent, isTypingEvent, kindOf, mostlyOf, renderedCount } from './join.js';
import { OVERLAY_ID } from './overlay-host.js';
import type { Blame, CommitSummary, HookInfo, InteractionReport, OverlayOptions, Phase, Stats } from './types.js';
import { warnOnce } from './warn.js';

/**
 * The on-page badge and panel. Plain DOM inside a shadow root: no React, so it renders even
 * while React is busy, never causes a React commit, and takes no styles from the page.
 */

interface Source {
  reports(): InteractionReport[];
  inp(): InpEstimate | null;
  onInteraction(fn: (r: InteractionReport) => void): () => void;
  clear(): void;
  stats(): Stats;
  debug: { hook(): HookInfo };
}

/** Something that keeps the library from seeing part of what happens, with the one-line fix. */
interface Status {
  /** The badge's `data-status`. */
  key: 'unsupported-browser' | 'installed-late' | 'unreadable' | 'locked-out' | 'no-frames';
  /** 'warn' marks the badge; 'info' only says so in the panel. */
  level: 'warn' | 'info';
  text: string;
}

/** What the badge and panel say about how much the library can see, most serious first; null when all is well. */
function statusOf(source: Source): Status | null {
  const stats = source.stats();
  if (stats.mode === 'unsupported' && stats.unsupportedReason?.kind === 'browser') {
    return { key: 'unsupported-browser', level: 'warn', text: 'This browser does not report INP: it has no Event Timing interactionId. Chrome and Edge 96, Firefox 144 and Safari 26.2 or later do.' };
  }
  if (stats.react === 'installed-late') {
    return {
      key: 'installed-late',
      level: 'warn',
      text: "React is not being read: install() ran after react-dom loaded. Install ahead of the app with react-inp-blame/vite, /next or /astro, or import 'react-inp-blame/auto' first in the entry module.",
    };
  }
  if (stats.react === 'unreadable') {
    const why = stats.unsupportedReason?.message ?? 'no React DevTools hook is in use on this page';
    return { key: 'unreadable', level: 'warn', text: `React is not being read: ${why}.`.replace(/\.\.$/, '.') };
  }
  if (source.debug.hook().devtoolsLockedOut) {
    return { key: 'locked-out', level: 'warn', text: "The DevTools hook was replaced after React registered, so the tool that replaced it does not see this React. Load that tool before react-inp-blame, or install with hook: 'chain'." };
  }
  const types = typeof PerformanceObserver !== 'undefined' ? PerformanceObserver.supportedEntryTypes : undefined;
  if (types && !types.includes('long-animation-frame')) {
    return { key: 'no-frames', level: 'info', text: 'This browser does not report long animation frames, so scripts outside React, and the style and layout work they force, are not named.' };
  }
  return null;
}

export interface OverlayHandle {
  open(): void;
  close(): void;
  toggle(): void;
  refresh(): void;
  dispose(): void;
}

const RATING = {
  good: { label: 'Good', color: '#22c55e' },
  'needs-improvement': { label: 'Needs improvement', color: '#f59e0b' },
  poor: { label: 'Poor', color: '#ef4444' },
} as const;
const IDLE = '#6b7280';
// Each rating's colour, as a custom property the dot, the time and the tag read. Set by class rather than
// by a style attribute, which a Content Security Policy without 'unsafe-inline' in style-src blocks.
const RATING_CSS = Object.entries(RATING)
  .map(([key, R]) => `[data-rating="${key}"] { --rating: ${R.color}; }`)
  .join('\n');
const CORNER = { 'bottom-right': 'br', 'bottom-left': 'bl', 'top-right': 'tr', 'top-left': 'tl' } as const;
const STORE = 'react-inp-blame:overlay';
/** The dash the badge and the panel's head show before the page has an interaction. */
const NONE = '\u2014';
const DOT = ' · ';

// The phone sizes come after the rules they override, which have the same specificity.
const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap { position: fixed; z-index: 2147483000; font: 12px/1.45 -apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #e7e9ee; -webkit-font-smoothing: antialiased; }
.wrap.br { right: 16px; bottom: 16px; } .wrap.bl { left: 16px; bottom: 16px; }
.wrap.tr { right: 16px; top: 16px; } .wrap.tl { left: 16px; top: 16px; }
.badge { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px 0 10px; border-radius: 999px; background: rgba(17,19,24,.94); color: #fff; border: 1px solid rgba(255,255,255,.12); box-shadow: 0 8px 24px rgba(0,0,0,.28); cursor: pointer; font: inherit; font-weight: 600; letter-spacing: .01em; user-select: none; }
.badge:hover { background: rgba(28,31,38,.97); }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--rating, ${IDLE}); box-shadow: 0 0 0 3px rgba(255,255,255,.07); flex: none; }
.ms { font-variant-numeric: tabular-nums; }
.badge .n { color: #9aa0ad; font-weight: 500; }
.panel { position: absolute; width: min(372px, calc(100vw - 32px)); max-height: min(72vh, 660px); max-height: min(72dvh, 660px); overflow: auto; border-radius: 14px; background: rgba(17,19,24,.97); border: 1px solid rgba(255,255,255,.12); box-shadow: 0 18px 50px rgba(0,0,0,.42); backdrop-filter: blur(14px); }
.br .panel, .bl .panel { bottom: 42px; } .tr .panel, .tl .panel { top: 42px; }
.br .panel, .tr .panel { right: 0; } .bl .panel, .tl .panel { left: 0; }
.head { position: sticky; top: 0; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px 12px; background: rgba(17,19,24,.98); border-bottom: 1px solid rgba(255,255,255,.08); }
.big { font-size: 30px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; color: #fff; }
.big small { font-size: 12px; font-weight: 500; color: #9aa0ad; margin-left: 4px; }
.sub { color: #9aa0ad; margin-top: 7px; font-size: 11.5px; }
.tag { display: inline-block; background: var(--rating); font-size: 10.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; margin-left: 10px; vertical-align: 4px; color: #0b0d11; }
.x { flex: none; background: none; border: 0; color: #9aa0ad; font: inherit; font-size: 18px; line-height: 1; cursor: pointer; padding: 3px 7px; border-radius: 6px; }
.x:hover { color: #fff; background: rgba(255,255,255,.08); }
.row { padding: 11px 16px 12px; border-bottom: 1px solid rgba(255,255,255,.06); cursor: pointer; }
.row:hover { background: rgba(255,255,255,.035); }
@media (pointer: coarse), (max-width: 480px) { .x { min-width: 40px; min-height: 40px; padding: 9px 12px; font-size: 20px; } .row { padding: 14px 16px; } }
.r1 { display: flex; align-items: center; gap: 8px; }
.r1 .dot { width: 8px; height: 8px; box-shadow: none; }
.r1 .t { flex: 1; font-weight: 600; font-size: 12.5px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.r1 .ms { font-weight: 700; font-size: 13px; color: var(--rating); }
.meta { color: #9aa0ad; margin: 3px 0 0 16px; font-size: 11px; }
.blame { color: #c3c7d1; margin: 4px 0 0 16px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.blame b { color: #fff; font-weight: 600; }
.blame.later { color: #9aa0ad; }
.bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: rgba(255,255,255,.08); margin: 9px 0 0 16px; }
.bar i { display: block; height: 100%; }
.p0 { background: #6b7280; } .p1 { background: #818cf8; } .p2 { background: #2dd4bf; }
.ph { background: #c084fc; }
.more { margin: 10px 0 0 16px; padding-top: 10px; border-top: 1px dashed rgba(255,255,255,.1); font-size: 12px; color: #c3c7d1; cursor: default; }
.more p { margin: 0 0 7px; }
.more .note { color: #9aa0ad; padding-left: 9px; border-left: 2px solid rgba(255,255,255,.14); }
.legend { display: flex; flex-wrap: wrap; gap: 6px 12px; color: #9aa0ad; font-size: 11px; margin: 0 0 9px; }
.legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
.h { color: #9aa0ad; font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; margin: 10px 0 4px; }
.comp { display: grid; grid-template-columns: 1fr auto; gap: 1px 8px; font-size: 11.5px; color: #9aa0ad; padding: 3px 0; }
.comp b { color: #e7e9ee; font-weight: 500; }
.comp .tr { grid-column: 1 / -1; height: 3px; background: rgba(255,255,255,.08); border-radius: 2px; }
.comp .fl { height: 100%; background: #818cf8; border-radius: 2px; }
.cost { color: #6f7582; font-size: 11px; margin-top: 8px; }
.empty { padding: 26px 16px; color: #9aa0ad; text-align: center; }
.status { padding: 10px 16px; font-size: 11.5px; border-bottom: 1px solid rgba(255,255,255,.08); color: #c3c7d1; }
.status.warn { background: rgba(251,191,36,.1); color: #fde68a; }
.mark { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; background: #fbbf24; color: #111318; font-size: 11px; font-weight: 800; margin-left: 2px; }
.foot { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px 10px; color: #6f7582; font-size: 10.5px; }
.foot button { background: none; border: 0; color: #9aa0ad; font: inherit; cursor: pointer; padding: 0; }
.foot button:hover { color: #fff; }
${RATING_CSS}
`;

export function createOverlay(source: Source, opts: OverlayOptions = {}): OverlayHandle {
  const max = opts.max ?? 20;
  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  const root = host.attachShadow({ mode: 'open' });
  const wrap = h('div', `wrap ${CORNER[opts.position ?? 'bottom-right']}`);
  const badge = h('button', { class: 'badge', type: 'button', title: 'Interaction to Next Paint. Click for what took the time.' });
  const panel = h('div', 'panel');
  panel.hidden = true;
  wrap.append(panel, badge);
  root.append(wrap);
  adoptStyles(root);

  const expanded = new Set<number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // Drawn from timers and event listeners, so a draw that throws is said once in the console rather than
  // left as an error on the page at every interaction.
  function render() {
    try {
      draw();
    } catch (error) {
      warnOnce('overlay-draw', `the badge and panel could not be drawn (${String(error)}). Reports still come through onInteraction().`);
    }
  }

  function draw() {
    timer = null;
    if (disposed) return;
    const all = source.reports();
    // The page's INP the way web-vitals estimates it, from every interaction seen, not just
    // the reported ones.
    const inp = source.inp();
    const status = statusOf(source);
    badge.dataset.status = status?.key ?? 'ok';
    const mark = status?.level === 'warn' ? h('span', { class: 'mark', title: status.text }, '!') : null;
    if (status?.key === 'unsupported-browser') {
      badge.dataset.rating = 'none';
      fill(badge, h('i', 'dot'), 'INP ', h('span', 'n', 'not measured'));
    } else if (!inp) {
      badge.dataset.rating = 'none';
      fill(badge, h('i', 'dot'), 'INP ', h('span', 'n', NONE), mark);
    } else {
      badge.dataset.rating = inp.rating;
      fill(badge, h('i', 'dot'), 'INP ', h('span', 'ms', `${Math.round(inp.value)} ms`), mark);
    }
    if (panel.hidden) return;
    // The panel is rebuilt below, so the control that has the focus is given it back afterwards.
    const focused = focusedControl();
    const groups = groupRows(all).slice(-max).reverse();
    const cost = all.length ? all.reduce((a, r) => a + r.overheadMs, 0) / all.length : 0;
    const head = inp
      ? h(
          'div',
          '',
          h('div', 'big', String(Math.round(inp.value)), h('small', '', 'ms'), tag(inp.rating)),
          h('div', 'sub', `Page INP so far${inp.report ? `, from ${inSentence(titleFor(inp.report))}` : ''}${DOT}${inp.interactionCount} interaction${inp.interactionCount === 1 ? '' : 's'}`),
        )
      : h('div', '', h('div', 'big', NONE, h('small', '', 'ms')), h('div', 'sub', 'Interaction to Next Paint. Nothing slow yet.'));
    fill(
      panel,
      h('div', 'head', head, h('button', { class: 'x', type: 'button', 'aria-label': 'Close' }, '×')),
      status && h('div', { class: `status ${status.level}`, 'data-status': status.key }, status.text),
      ...(groups.length ? groups.map(row) : [h('div', 'empty', 'Click or type. Anything slow shows up here, with the component to blame.')]),
      h('div', 'foot', h('span', '', `react-inp-blame${DOT}measuring cost ${costText(cost)} per interaction`), h('button', { class: 'clear', type: 'button' }, 'Clear')),
    );
    if (focused) panel.querySelector<HTMLElement>(focused)?.focus({ preventScroll: true });
  }

  /**
   * A selector for the control in the panel that has the focus: a row header, found by its row's id
   * since new rows go on top, or the close button or Clear, of which there is one each. Clear is
   * still there once it has emptied the list, so it keeps the focus it was pressed with.
   */
  function focusedControl(): string | null {
    const el = root.activeElement;
    if (!el || !panel.contains(el)) return null;
    const id = el.closest<HTMLElement>('.row')?.dataset.id;
    if (id) return `.row[data-id="${id}"] .toggle`;
    if (el.closest('.x')) return '.x';
    if (el.closest('.clear')) return '.clear';
    return null;
  }

  function row(g: Group): HTMLElement {
    const r = slowest(g.reports);
    const total = Math.max(r.duration, 1);
    const later = laterRender(r);
    const n = g.reports.length;
    const isExpanded = expanded.has(r.interactionId);
    return h(
      'div',
      { class: 'row', 'data-id': String(r.interactionId) },
      h(
        'div',
        { class: 'toggle', role: 'button', tabindex: '0', 'aria-expanded': String(isExpanded) },
        h('div', { class: 'r1', 'data-rating': r.explanation.rating }, h('i', 'dot'), h('span', 't', titleFor(r)), h('span', 'ms', `${Math.round(r.duration)} ms`)),
        n > 1 && h('div', 'meta', `${n} key presses${DOT}slowest ${Math.round(r.duration)} ms${DOT}typical ${Math.round(median(g.reports.map((x) => x.duration)))} ms`),
        h('div', 'blame', ...blameLine(r)),
        later && h('div', 'blame later', 'then ', b(where(later)), ` re-rendered after the paint${DOT}${laterDetail(later)}${later.hasDurations ? `${DOT}${Math.round(later.total)} ms` : ''}`),
        h('div', 'bar', ...phaseBar(r.explanation.phases, total)),
      ),
      isExpanded && more(r),
    );
  }

  function more(r: InteractionReport): HTMLElement {
    const x = r.explanation;
    // Only a render with real work gets a component list; a status pill updating does not.
    const main = r.commits.length ? heaviest(r.commits) : null;
    const before = main && carriesWork(main) ? main : null;
    const later = laterRender(r);
    const legend = x.phases.flatMap((p, i) => [swatch(`p${i}`, p), ...(p.parts ?? []).map((part) => swatch('ph', part))]);
    return h(
      'div',
      'more',
      h('div', 'legend', ...legend),
      h('p', '', x.cause),
      ...x.notes.map((note) => h('p', 'note', note)),
      ...(before ? comps('Rendered before the paint', before) : []),
      ...(later ? comps('Rendered after the paint', later) : []),
      h('p', 'cost', `Measuring this cost ${costText(r.overheadMs)}.`),
    );
  }

  function comps(label: string, c: CommitSummary): HTMLElement[] {
    const rows = c.components.slice(0, 5);
    if (!rows.length) return [];
    const maxV = Math.max(...rows.map((x) => x.self ?? x.count), 1);
    return [
      h('div', 'h', `${label}${DOT}${c.rendered} components`),
      ...rows.map((x) =>
        h(
          'div',
          'comp',
          b(x.name),
          h('span', '', `${x.count} rendered${x.self != null ? `${DOT}${x.self.toFixed(1)} ms` : ''}`),
          h('div', 'tr', sized(h('div', 'fl'), ((x.self ?? x.count) / maxV) * 100)),
        ),
      ),
    ];
  }

  function toggleRow(r: HTMLElement) {
    const id = Number(r.dataset.id);
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    render();
  }
  function schedule() {
    if (timer == null) timer = setTimeout(render, 0);
  }
  function setOpen(v: boolean) {
    panel.hidden = !v;
    try {
      localStorage.setItem(STORE, v ? 'open' : 'closed');
    } catch {
      // storage may be unavailable; the state is then per page load
    }
    render();
  }
  // Hiding the panel takes the focus from whatever inside it had it, so closing it from in there, with
  // Escape or the close button, moves the focus to the badge, the button that opens the panel again.
  function hide() {
    const inside = panel.contains(root.activeElement);
    setOpen(false);
    if (inside) badge.focus();
  }

  badge.addEventListener('click', () => setOpen(panel.hidden));
  // A button clicks on every keydown of a held Enter, so the badge drops the repeats and opens or closes
  // the panel once per press. They reach it after the close button too, which hands it the focus on the
  // first keydown. Space clicks on keyup, once however long it is held.
  badge.addEventListener('keydown', (e) => {
    if (e.repeat && e.key === 'Enter') e.preventDefault();
  });
  panel.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (el.closest('.x')) return hide();
    if (el.closest('.clear')) {
      source.clear();
      expanded.clear();
      return render();
    }
    if (el.closest('.more')) return;
    const r = el.closest<HTMLElement>('.row');
    if (r) toggleRow(r);
  });
  // A row header opens and closes its row from the keyboard the way a button does.
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const r = (e.target as HTMLElement).closest('.toggle')?.closest<HTMLElement>('.row');
    if (!r) return;
    // Space would also scroll the panel, on a repeat as much as on the first press.
    e.preventDefault();
    // A held key repeats, and the row opens or closes once per press rather than once per repeat.
    if (!e.repeat) toggleRow(r);
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || panel.hidden) return;
    hide();
  };
  document.addEventListener('keydown', onKey);
  const off = source.onInteraction(schedule);

  let open = !!opts.open;
  try {
    const saved = localStorage.getItem(STORE);
    if (saved === 'open') open = true;
    if (saved === 'closed' && !opts.open) open = false;
  } catch {
    // ignore
  }
  panel.hidden = !open;
  const attach = () => {
    if (!disposed && !host.isConnected) document.body.appendChild(host);
    render();
  };
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(panel.hidden),
    refresh: render,
    dispose: () => {
      disposed = true;
      off();
      document.removeEventListener('keydown', onKey);
      host.remove();
    },
  };
}

interface Group {
  reports: InteractionReport[];
}

/** Consecutive key presses in the same field collapse into one row, the way a person sees them. */
function groupRows(reports: InteractionReport[]): Group[] {
  const out: Group[] = [];
  for (const r of reports) {
    const last = out[out.length - 1];
    const started = last?.reports[0];
    if (last && started && isTyping(r) && isTyping(started) && sameTarget(r, started)) last.reports.push(r);
    else out.push({ reports: [r] });
  }
  return out;
}

/**
 * Whether a report is typing: an input or a change, or a key that typed a character into something
 * that is not a button or a link. The browser fires a keypress only for a key that makes a character,
 * so Escape, Tab and the arrow keys are key presses. A report does not keep which key it was, and
 * Enter in a text field fires a keypress too, so that one still reads as typing.
 */
function isTyping(r: InteractionReport): boolean {
  if (r.type === 'input' || r.type === 'change') return true;
  if (!isTypingEvent(r.type)) return false;
  const kind = r.target?.label?.match(/^\w+/)?.[0];
  return kind !== 'button' && kind !== 'link' && r.entries.some((e) => e.name === 'keypress');
}

function sameTarget(a: InteractionReport, b: InteractionReport): boolean {
  return a.target?.selector === b.target?.selector && a.target?.label === b.target?.label;
}

function slowest(reports: InteractionReport[]): InteractionReport {
  return reports.reduce((a, b) => (b.duration > a.duration ? b : a));
}

/** The middle value, or 0 for no values; every caller has at least one. */
function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/** The heaviest later render. A report only takes later renders with real work in them, so any one is worth a line. */
function laterRender(r: InteractionReport): CommitSummary | null {
  return r.followUps.length ? heaviest(r.followUps) : null;
}

/** "1.2 ms", and "under 0.1 ms" rather than a 0.0 that reads as free. */
function costText(ms: number): string {
  return ms < 0.05 ? 'under 0.1 ms' : `${ms.toFixed(1)} ms`;
}

/**
 * Styles the shadow root with a constructed stylesheet, which a Content Security Policy's style-src does not
 * govern, so the badge and panel are styled under a policy of nonces and hashes. A browser without
 * constructed stylesheets in shadow roots (Safari before 16.4) gets a `<style>` element, as before.
 */
function adoptStyles(root: ShadowRoot): void {
  try {
    if (typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype && 'adoptedStyleSheets' in root) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
      return;
    }
  } catch {
    // A browser that has the names but refuses the sheet gets the element below.
  }
  const style = document.createElement('style');
  style.textContent = CSS;
  root.prepend(style);
}

/** What goes inside an element: a node, text, or nothing for a part that is left out. */
type Child = Node | string | null | undefined | false;

/**
 * An element with `attrs` (a string is its class) and `children` inside it, a string child as a text node.
 * The badge and panel are built from elements and text rather than markup, so nothing a report carries is
 * ever parsed as HTML and no Trusted Types policy is needed: the page's `trusted-types` directive, however
 * strict, leaves them drawn. Bar widths are set through the style object (`sized`) rather than a style
 * attribute, which a style-src without 'unsafe-inline' blocks.
 */
function h(tag: string, attrs: string | Record<string, string>, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (typeof attrs === 'string') {
    if (attrs) el.className = attrs;
  } else {
    for (const name in attrs) el.setAttribute(name, attrs[name] as string);
  }
  fill(el, ...children);
  return el;
}

/** Puts `children` in `el` in place of what it held, leaving out the parts that are nothing. */
function fill(el: HTMLElement, ...children: Child[]): void {
  el.replaceChildren(...children.filter((child): child is Node | string => !!child));
}

function b(text: string): HTMLElement {
  return h('b', '', text);
}

/** `el` at `percent` of its parent's width. */
function sized(el: HTMLElement, percent: number): HTMLElement {
  el.style.width = `${percent.toFixed(1)}%`;
  return el;
}

/**
 * The phase bar. A phase with named parts draws them first, then what is left of it, so the
 * hydration inside the working time is a band of its own without the bar adding up to any more
 * than the interaction.
 */
function phaseBar(phases: readonly Phase[], total: number): HTMLElement[] {
  return phases.flatMap((p, i) => {
    const parts = p.parts ?? [];
    const rest = Math.max(0, p.ms - parts.reduce((a, x) => a + x.ms, 0));
    return [...parts.map((part) => band('ph', part.label, part.ms, total)), band(`p${i}`, p.label, rest, total)];
  });
}

function band(cls: string, label: string, ms: number, total: number): HTMLElement {
  return sized(h('i', { class: cls, title: `${label}: ${Math.round(ms)} ms` }), (ms / total) * 100);
}

function swatch(cls: string, p: Phase): HTMLElement {
  return h('span', { title: p.hint }, h('i', cls), `${p.label} ${Math.round(p.ms)} ms`);
}

function where(c: CommitSummary): string {
  return leafName(c) ?? 'the tree';
}
/** What a later render was made of, in the words its blame's `detail` would use, and the count for one component. */
export const laterDetail = (c: CommitSummary): string => mostlyOf(c) ?? renderedCount(c);

function blameLine(r: InteractionReport): Child[] {
  const blame = r.explanation.blame;
  // Nothing is blamed where React is not being read; the cause line under this says why.
  if (blame.kind === 'none' && (r.reactStatus === 'installed-late' || r.reactStatus === 'unreadable')) return ['nothing is blamed: React is not being read'];
  // An inferred blame is the likeliest reading of component counts and phase times, not a measurement.
  // The row says so in two words; the cause sentence under it says what would make it exact.
  const line = blameText(blame);
  return blame.confidence === 'inferred' && blame.kind !== 'none' ? ['most likely ', ...line] : line;
}

/** The row's line for a blame: text with the name it turns on in bold. */
function blameText(blame: Blame): Child[] {
  const { name, detail } = blame;
  const ms = blame.ms != null ? `${DOT}${Math.round(blame.ms)} ms` : '';
  const named = name ? [DOT, b(name)] : [];
  switch (blame.kind) {
    case 'render':
      return [b(name ?? 'the tree'), ` re-rendered${detail ? `${DOT}${detail}` : ''}${ms}`];
    case 'handler': {
      const where = detail ? ` in ${detail}` : '';
      // A production build of React records no render times, so there is no figure to put beside the
      // name: "the onClick handler in Layout".
      return blame.ms == null ? ['the ', name && b(name), name && ' ', `handler${where}`] : [b(name ?? 'the handler'), `${where}${ms} in the handler`];
    }
    // Only a hydration React finished inside the interaction takes the blame. HTML that was still
    // waiting is a sentence in front of whatever did take the time, which the cause line carries.
    case 'hydration':
      return ['waited for React to hydrate ', b(name ?? 'the page'), `${ms}${detail ? `${DOT}${detail}` : ''}`];
    // Nothing names the read that forced the layout: the browser gives a total per script and never
    // says which line caused it. The name is where it happened, the subtree or the script, and it is
    // null where several scripts shared the total; the row then says only what was measured.
    case 'layout':
      return [`browser recalculated styles and layout${ms}`, name && ' in ', name && b(name), detail && `${DOT}${detail}`];
    case 'waiting':
      return [`main thread was busy${ms} before the handler could start`, ...named];
    case 'painting':
      return [`screen took${ms} to update`, ...named];
    case 'script':
      return [b(name ?? 'a script'), ` ran${ms}`];
    default:
      return ['nothing stood out; the time went to waiting and painting'];
  }
}

/**
 * "Typing in Password" / "Key press on Close" / "Click on Log in", from the report's target. A report
 * with no target is just "Typing", "Key press" or "Click".
 */
export function titleFor(r: InteractionReport): string {
  const t = r.target;
  const label = t?.label ? t.label.replace(/^\w+ /, '') : (t?.selector ?? '');
  if (isTyping(r)) return label ? `Typing in ${label}` : 'Typing';
  if (isTypingEvent(r.type)) return label ? `Key press on ${label}` : 'Key press';
  if (isPointerEvent(r.type)) return label ? `Click on ${label}` : 'Click';
  return `${kindOf(r.type)} ${label}`.trim();
}

/** A title inside a sentence: the kind it starts with lowercased, the label as the page wrote it. */
function inSentence(title: string): string {
  return title.charAt(0).toLowerCase() + title.slice(1);
}

function tag(rating: keyof typeof RATING): HTMLElement {
  return h('span', { class: 'tag', 'data-rating': rating }, RATING[rating].label);
}
