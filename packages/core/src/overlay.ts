import { dominantComponent, heaviest, leafName } from './commits.js';
import type { InpEstimate } from './inp.js';
import { unexplainedReports } from './install-state.js';
import { blamedCommit, carriesWork, isPointerEvent, isTypingEvent, kindOf, laterRenderOf, mostlyOf, renderedCount, renderedVerb } from './join.js';
import { OVERLAY_ID } from './overlay-host.js';
import type { Blame, CommitSummary, HookInfo, InteractionReport, OverlayOptions, Phase, Stats } from './types.js';
import { errorText, warnOnce } from './warn.js';

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
/** Where the panel's line under a development build sends the reader: how to check a number in production. */
const DEVELOPMENT_DOCS = 'https://github.com/adityareddy-dev/react-inp-blame/blob/main/docs/install.md#numbers-in-development';
/** A row with nothing to fix folds away under this, in ms: typing at the reporting threshold makes one per key. */
const QUICK_MS = 200;

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
.panel { position: absolute; width: min(372px, calc(100vw - 32px)); max-height: min(72vh, 660px); max-height: min(72dvh, 660px); overflow: auto; border-radius: 14px; background: #111318; border: 1px solid rgba(255,255,255,.12); box-shadow: 0 18px 50px rgba(0,0,0,.42); }
.br .panel, .bl .panel { bottom: 42px; } .tr .panel, .tl .panel { top: 42px; }
.br .panel, .tr .panel { right: 0; } .bl .panel, .tl .panel { left: 0; }
.head { position: sticky; top: 0; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px 12px; background: #111318; border-bottom: 1px solid rgba(255,255,255,.08); }
.big { font-size: 30px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; color: #fff; }
.big small { font-size: 12px; font-weight: 500; color: #9aa0ad; margin-left: 4px; }
.sub { color: #9aa0ad; margin-top: 7px; font-size: 11.5px; }
.tag { display: inline-block; background: var(--rating); font-size: 10.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; margin-left: 10px; vertical-align: 4px; color: #0b0d11; }
.x { flex: none; background: none; border: 0; color: #9aa0ad; font: inherit; font-size: 18px; line-height: 1; cursor: pointer; padding: 3px 7px; border-radius: 6px; }
.x:hover { color: #fff; background: rgba(255,255,255,.08); }
.row { padding: 11px 16px 12px; border-bottom: 1px solid rgba(255,255,255,.06); cursor: pointer; }
.row:hover { background: rgba(255,255,255,.035); }
@media (pointer: coarse), (max-width: 480px) { .x, .foot button { min-width: 44px; min-height: 44px; } .x { padding: 9px 12px; font-size: 20px; } .panel .foot { padding: 0 8px 0 16px; } .row { padding: 14px 16px; } }
.r1 { display: flex; align-items: center; gap: 8px; }
.r1 .dot { width: 8px; height: 8px; box-shadow: none; }
.r1 .t { flex: 1; font-weight: 600; font-size: 12.5px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.r1 .ms { font-weight: 700; font-size: 13px; color: var(--rating); }
.meta { color: #9aa0ad; margin: 3px 0 0 16px; font-size: 11px; }
.blame { color: #c3c7d1; margin: 4px 0 0 16px; font-size: 12px; overflow-wrap: anywhere; }
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
.empty { padding: 26px 16px; color: #9aa0ad; text-align: center; }
.status { padding: 10px 16px; font-size: 11.5px; border-bottom: 1px solid rgba(255,255,255,.08); color: #c3c7d1; }
.status.warn { background: rgba(251,191,36,.1); color: #fde68a; }
.mark { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; background: #fbbf24; color: #111318; font-size: 11px; font-weight: 800; margin-left: 2px; }
.dev { padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,.1); color: #c3c7d1; font-size: 10px; font-weight: 600; letter-spacing: .03em; }
.devnote a { color: #c3c7d1; }
.foot { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px 10px; color: #6f7582; font-size: 10.5px; }
.foot .btns { display: flex; gap: 14px; }
.foot button { background: none; border: 0; color: #9aa0ad; font: inherit; cursor: pointer; padding: 0; }
.foot button:hover { color: #fff; }
${RATING_CSS}
`;

export function createOverlay(source: Source, opts: OverlayOptions = {}, onHide?: () => void): OverlayHandle {
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
  let foldOpen = false;
  // With no position given, the corner is asked at mount and again at the first report, as widgets often load late.
  let asks = opts.position ? 0 : 2;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // Drawn from timers and event listeners, so a draw that throws is said once in the console rather than
  // left as an error on the page at every interaction.
  function render() {
    try {
      draw();
    } catch (error) {
      warnOnce('overlay-draw', `the badge and panel could not be drawn (${errorText(error)}). Reports still come through onInteraction().`);
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
    // React's development build is slower than production and renders twice under StrictMode, so its numbers
    // run high. The badge says which build it measured and keeps its colours: it never guesses production's.
    const development = source.debug.hook().renderers.some((r) => r.rendererPackageName === 'react-dom' && r.bundleType === 1);
    const dev = development && h('span', { class: 'dev', title: 'Development build: React runs slower here than in production.' }, 'dev');
    if (status?.key === 'unsupported-browser') {
      badge.dataset.rating = 'none';
      fill(badge, h('i', 'dot'), 'INP ', h('span', 'n', 'not measured'));
    } else if (!inp) {
      badge.dataset.rating = 'none';
      fill(badge, h('i', 'dot'), 'INP ', h('span', 'n', NONE), dev, mark);
    } else {
      badge.dataset.rating = inp.rating;
      fill(badge, h('i', 'dot'), 'INP ', h('span', 'ms', `${Math.round(inp.value)} ms`), dev, mark);
    }
    if (asks && (asks === 2 || all.length)) {
      asks--;
      if (panel.hidden) place();
    }
    if (panel.hidden) return;
    // The panel is rebuilt below, so the control that has the focus is given it back afterwards.
    const focused = focusedControl();
    const groups = groupRows(all).slice(-max).reverse();
    const cost = all.length ? all.reduce((a, r) => a + r.overheadMs, 0) / all.length : 0;
    const developmentLine =
      development &&
      h(
        'div',
        'sub devnote',
        'Development build. React runs slower here than in production, and StrictMode renders twice, so ',
        h('a', { href: DEVELOPMENT_DOCS, target: '_blank', rel: 'noopener' }, 'check anything amber or red in a production build'),
        '.',
      );
    const head = inp
      ? h(
          'div',
          '',
          h('div', 'big', String(Math.round(inp.value)), h('small', '', 'ms'), tag(inp.rating)),
          h('div', 'sub', `Page INP so far${inp.report ? `, from ${inSentence(titleFor(inp.report))}` : ''}${DOT}${inp.interactionCount} interaction${inp.interactionCount === 1 ? '' : 's'}`),
          developmentLine,
        )
      : h('div', '', h('div', 'big', NONE, h('small', '', 'ms')), h('div', 'sub', 'Interaction to Next Paint. Nothing slow yet.'), developmentLine);
    fill(
      panel,
      h('div', 'head', head, h('button', { class: 'x', type: 'button', 'aria-label': 'Close' }, '×')),
      status && h('div', { class: `status ${status.level}`, 'data-status': status.key }, status.text),
      ...(groups.length ? rows(groups) : [h('div', 'empty', 'Click or type. Anything slow shows up here, with the component to blame.')]),
      h(
        'div',
        'foot',
        h('span', '', `react-inp-blame${DOT}measuring cost ${costText(cost)} per interaction`),
        h(
          'span',
          'btns',
          onHide && h('button', { class: 'hide', type: 'button', title: 'Hides the badge in this browser. Open the page with ?inp-blame to bring it back.' }, 'Hide for me'),
          h('button', { class: 'clear', type: 'button' }, 'Clear'),
        ),
      ),
    );
    if (focused) panel.querySelector<HTMLElement>(focused)?.focus({ preventScroll: true });
  }

  /**
   * Moves the badge off a corner the page's own fixed or sticky element holds, a chat button say, to the first
   * free one of bottom right, bottom left, top right and top left, or leaves it bottom right where all four are
   * taken. Asked only while the panel is closed, which would move with it.
   */
  function place() {
    if (!('elementsFromPoint' in document)) return;
    const { width, height } = badge.getBoundingClientRect();
    const taken = (c: string) =>
      document
        .elementsFromPoint(c[1] === 'r' ? innerWidth - 16 - width / 2 : 16 + width / 2, c[0] === 'b' ? innerHeight - 16 - height / 2 : 16 + height / 2)
        .some((el) => el !== host && /^(fixed|sticky)$/.test(getComputedStyle(el).position));
    wrap.className = `wrap ${['br', 'bl', 'tr', 'tl'].find((c) => !taken(c)) ?? 'br'}`;
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
    if (el.closest('.fold')) return '.fold .toggle';
    if (el.closest('.x')) return '.x';
    if (el.closest('.clear')) return '.clear';
    if (el.closest('.hide')) return '.hide';
    return null;
  }

  /**
   * The rows, newest first, with the quick ones that have nothing to fix folded into one line where the newest
   * of them was, which opens on a click to show them under it. A row that blames nothing because the library
   * cannot tell stays a row.
   */
  function rows(groups: Group[]): HTMLElement[] {
    const quick = groups.filter((g) => nothingToFix(slowest(g.reports)));
    if (!quick.length) return groups.map(row);
    const n = quick.reduce((a, g) => a + g.reports.length, 0);
    const fold = h(
      'div',
      'row fold',
      h('div', { class: 'toggle', role: 'button', tabindex: '0', 'aria-expanded': String(foldOpen) }, h('div', 'meta', `${n} quick interaction${n === 1 ? '' : 's'}, nothing to fix`)),
    );
    const out: HTMLElement[] = [];
    for (const g of groups) {
      if (g === quick[0]) out.push(fold, ...(foldOpen ? quick.map(row) : []));
      else if (!quick.includes(g)) out.push(row(g));
    }
    return out;
  }

  function row(g: Group): HTMLElement {
    const r = slowest(g.reports);
    const total = Math.max(r.duration, 1);
    const later = laterRenderOf(r);
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
        later && h('div', 'blame later', laterLead(r, later), b(where(later)), ` ${renderedVerb(later)} ${laterWhen(r, later)}${DOT}${laterDetail(later)}${later.hasDurations ? `${DOT}${Math.round(later.total)} ms` : ''}`),
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
    const later = laterRenderOf(r);
    const legend = x.phases.flatMap((p, i) => [swatch(`p${i}`, p), ...(p.parts ?? []).map((part) => swatch('ph', part))]);
    return h(
      'div',
      'more',
      h('div', 'legend', ...legend),
      h('p', '', x.cause),
      ...x.notes.map((note) => h('p', 'note', note)),
      ...(before ? comps('Rendered before the paint', before) : []),
      ...(later ? comps(`Rendered ${laterWhen(r, later)}`, later) : []),
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
  function toggleFold() {
    foldOpen = !foldOpen;
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
    if (el.closest('.hide')) {
      try {
        localStorage.setItem('react-inp-blame', 'hidden');
      } catch {
        // ignore
      }
      handle.dispose();
      return onHide?.();
    }
    if (el.closest('.clear')) {
      source.clear();
      expanded.clear();
      return render();
    }
    if (el.closest('.more')) return;
    if (el.closest('.fold')) return toggleFold();
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
    if (e.repeat) return;
    if (r.closest('.fold')) toggleFold();
    else toggleRow(r);
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

  const handle: OverlayHandle = {
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
  return handle;
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
/** When a later render came, as the panel says it: after the paint, or after the press painted where it came before the release. */
export const laterWhen = (r: Pick<InteractionReport, 'end'>, c: CommitSummary): string => (c.at < r.end ? 'after the press painted' : 'after the paint');
/** How the panel's line for a later render opens: "earlier" for one before the release, "then" for one after the paint. */
export const laterLead = (r: Pick<InteractionReport, 'end'>, c: CommitSummary): string => (c.at < r.end ? 'earlier, ' : 'then ');

/** A quick row that blames nothing because nothing stood out, rather than because the library cannot tell. */
function nothingToFix(r: InteractionReport): boolean {
  return r.explanation.blame.kind === 'none' && r.duration < QUICK_MS && !cannotTell(r);
}

/** Why a report blames nothing where the library cannot tell what took the time, or null where it can. */
function cannotTell(r: InteractionReport): string | null {
  // A report the library could not explain blames nothing for an error of its own, not because nothing
  // stood out or React is not being read. Asked after the read of its blame, which is where that error is met.
  if (unexplainedReports.has(r)) return 'nothing is blamed: the library hit an error of its own';
  // Nothing is blamed where React is not being read; the cause line under the row says why.
  if (r.explanation.blame.kind === 'none' && (r.reactStatus === 'installed-late' || r.reactStatus === 'unreadable')) return 'nothing is blamed: React is not being read';
  return null;
}

/** The row's line under its title: what took the time, or why nothing is blamed. */
export function blameLine(r: InteractionReport): Child[] {
  const blame = r.explanation.blame;
  const unknown = cannotTell(r);
  if (unknown) return [unknown];
  // An inferred blame is the likeliest reading of component counts and phase times, not a measurement.
  // The row says so in two words; the cause sentence under it says what would make it exact.
  // "mounted" where the commit the blame names was mostly components rendering for the first time, as the
  // cause says of it: not always the heaviest commit, where one's committing and effects outweighed it.
  const named = blame.kind === 'render' ? blamedCommit(r) : null;
  const line = named && blame.name && !mayHaveRendered(named, blame.name) ? startedLine(blame, named) : blameText(blame, named ? renderedVerb(named) : 're-rendered');
  return blame.confidence === 'inferred' && blame.kind !== 'none' ? ['most likely ', ...line] : line;
}

/**
 * Whether `name` can have rendered in `c`: it is among the components the commit lists, or the list is not all
 * of them. The component a render is named after is where the render went, and can be one that bailed out
 * above the ones that rendered, as a context's consumers render under a list that does not.
 */
function mayHaveRendered(c: CommitSummary, name: string): boolean {
  return c.components.some((x) => x.name === name) || c.components.reduce((a, x) => a + x.count, 0) < c.rendered;
}

/**
 * The row's line for a render blame named after a component that did not render: where it started, when one
 * root did, and what rendered inside the named one, "PrefsProvider updated · ProductRow ×375 re-rendered inside
 * ProductList". What rendered is the commit's, never the blame's detail.
 */
function startedLine(blame: Blame, c: CommitSummary): Child[] {
  const top = dominantComponent(c);
  const what = top && top.count > 1 ? `${top.name} ×${top.count}` : renderedCount(c);
  const root = c.roots.length === 1 ? [b(c.roots[0]!), ` updated${DOT}`] : [];
  return [...root, `${what} ${renderedVerb(c)} inside `, b(blame.name!), blame.ms != null ? `${DOT}${Math.round(blame.ms)} ms` : ''];
}

/** The row's line for a blame: text with the name it turns on in bold. */
function blameText(blame: Blame, rendered: string): Child[] {
  const { name, detail } = blame;
  const ms = blame.ms != null ? `${DOT}${Math.round(blame.ms)} ms` : '';
  const named = name ? [DOT, b(name)] : [];
  switch (blame.kind) {
    case 'render':
      return [b(name ?? 'the tree'), ` ${rendered}${detail ? `${DOT}${detail}` : ''}${ms}`];
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
    // A wait between one event's handlers and the next's says where it came, in `detail`.
    case 'waiting':
      return detail ? [`main thread was busy${ms} ${detail}`, ...named] : [`main thread was busy${ms} before the handler could start`, ...named];
    case 'painting':
      return [`screen took${ms} to update`, ...named];
    case 'script':
      return [b(name ?? 'a script'), ` ran${ms}`];
    // The cause under the row says where the time went: waiting and painting, or working time short of a
    // long task whose styles and layout no frame measured.
    default:
      return ['nothing stood out'];
  }
}

/**
 * "Typing in Password" / "Key press on Close" / "Click on Log in", or "Tap on Log in" for a finger's,
 * from the report's target. A report with no target is just "Typing", "Key press", "Click" or "Tap".
 */
export function titleFor(r: InteractionReport): string {
  const t = r.target;
  const label = t?.label ? t.label.replace(/^\w+ /, '') : (t?.selector ?? '');
  if (isTyping(r)) return label ? `Typing in ${label}` : 'Typing';
  if (isTypingEvent(r.type)) return label ? `Key press on ${label}` : 'Key press';
  if (isPointerEvent(r.type)) {
    const kind = kindOf(r.type, r.pointerType) === 'tap' ? 'Tap' : 'Click';
    return label ? `${kind} on ${label}` : kind;
  }
  return `${kindOf(r.type)} ${label}`.trim();
}

/** A title inside a sentence: the kind it starts with lowercased, the label as the page wrote it. */
function inSentence(title: string): string {
  return title.charAt(0).toLowerCase() + title.slice(1);
}

function tag(rating: keyof typeof RATING): HTMLElement {
  return h('span', { class: 'tag', 'data-rating': rating }, RATING[rating].label);
}
