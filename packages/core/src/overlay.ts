import { heaviest, leafName } from './commits.js';
import type { InpEstimate } from './inp.js';
import { carriesWork, isPointerEvent, isTypingEvent, kindOf } from './join.js';
import { OVERLAY_ID } from './overlay-host.js';
import type { Blame, CommitSummary, InteractionReport, OverlayOptions, Phase } from './types.js';

/**
 * The on-page badge and panel. Plain DOM inside a shadow root: no React, so it renders even
 * while React is busy, never causes a React commit, and takes no styles from the page.
 */

interface Source {
  reports(): InteractionReport[];
  inp(): InpEstimate | null;
  onInteraction(fn: (r: InteractionReport) => void): () => void;
  clear(): void;
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
const CORNER = { 'bottom-right': 'br', 'bottom-left': 'bl', 'top-right': 'tr', 'top-left': 'tl' } as const;
const STORE = 'react-inp-blame:overlay';

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap { position: fixed; z-index: 2147483000; font: 12px/1.45 -apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #e7e9ee; -webkit-font-smoothing: antialiased; }
.wrap.br { right: 16px; bottom: 16px; } .wrap.bl { left: 16px; bottom: 16px; }
.wrap.tr { right: 16px; top: 16px; } .wrap.tl { left: 16px; top: 16px; }
.badge { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px 0 10px; border-radius: 999px; background: rgba(17,19,24,.94); color: #fff; border: 1px solid rgba(255,255,255,.12); box-shadow: 0 8px 24px rgba(0,0,0,.28); cursor: pointer; font: inherit; font-weight: 600; letter-spacing: .01em; user-select: none; }
.badge:hover { background: rgba(28,31,38,.97); }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: ${IDLE}; box-shadow: 0 0 0 3px rgba(255,255,255,.07); flex: none; }
.ms { font-variant-numeric: tabular-nums; }
.badge .n { color: #9aa0ad; font-weight: 500; }
.panel { position: absolute; width: 372px; max-height: min(72vh, 660px); overflow: auto; border-radius: 14px; background: rgba(17,19,24,.97); border: 1px solid rgba(255,255,255,.12); box-shadow: 0 18px 50px rgba(0,0,0,.42); backdrop-filter: blur(14px); }
.br .panel, .bl .panel { bottom: 42px; } .tr .panel, .tl .panel { top: 42px; }
.br .panel, .tr .panel { right: 0; } .bl .panel, .tl .panel { left: 0; }
.head { position: sticky; top: 0; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px 12px; background: rgba(17,19,24,.98); border-bottom: 1px solid rgba(255,255,255,.08); }
.big { font-size: 30px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; color: #fff; }
.big small { font-size: 12px; font-weight: 500; color: #9aa0ad; margin-left: 4px; }
.sub { color: #9aa0ad; margin-top: 7px; font-size: 11.5px; }
.tag { display: inline-block; font-size: 10.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; margin-left: 10px; vertical-align: 4px; color: #0b0d11; }
.x { flex: none; background: none; border: 0; color: #9aa0ad; font: inherit; font-size: 18px; line-height: 1; cursor: pointer; padding: 3px 7px; border-radius: 6px; }
.x:hover { color: #fff; background: rgba(255,255,255,.08); }
.row { padding: 11px 16px 12px; border-bottom: 1px solid rgba(255,255,255,.06); cursor: pointer; }
.row:hover { background: rgba(255,255,255,.035); }
.r1 { display: flex; align-items: center; gap: 8px; }
.r1 .dot { width: 8px; height: 8px; box-shadow: none; }
.r1 .t { flex: 1; font-weight: 600; font-size: 12.5px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.r1 .ms { font-weight: 700; font-size: 13px; }
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
.foot { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px 10px; color: #6f7582; font-size: 10.5px; }
.foot button { background: none; border: 0; color: #9aa0ad; font: inherit; cursor: pointer; padding: 0; }
.foot button:hover { color: #fff; }
`;

export function createOverlay(source: Source, opts: OverlayOptions = {}): OverlayHandle {
  const max = opts.max ?? 20;
  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  const wrap = document.createElement('div');
  wrap.className = `wrap ${CORNER[opts.position ?? 'bottom-right']}`;
  const badge = document.createElement('button');
  badge.className = 'badge';
  badge.type = 'button';
  badge.title = 'Interaction to Next Paint. Click for what took the time.';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.hidden = true;
  wrap.append(panel, badge);
  root.append(style, wrap);

  const expanded = new Set<number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function render() {
    timer = null;
    if (disposed) return;
    const all = source.reports();
    // The page's INP the way web-vitals estimates it, from every interaction seen, not just
    // the reported ones.
    const inp = source.inp();
    if (!inp) {
      badge.dataset.rating = 'none';
      badge.innerHTML = `<i class="dot"></i>INP <span class="n">&mdash;</span>`;
    } else {
      const R = RATING[inp.rating];
      badge.dataset.rating = inp.rating;
      badge.innerHTML = `<i class="dot" style="background:${R.color}"></i>INP <span class="ms">${Math.round(inp.value)} ms</span>`;
    }
    if (panel.hidden) return;
    // The panel is rebuilt below, so the control that has the focus is given it back afterwards.
    const focused = focusedControl();
    const groups = groupRows(all).slice(-max).reverse();
    const cost = all.length ? all.reduce((a, r) => a + r.overheadMs, 0) / all.length : 0;
    const head = inp
      ? `<div><div class="big">${Math.round(inp.value)}<small>ms</small>${tag(inp.rating)}</div><div class="sub">Page INP so far${inp.report ? `, from ${esc(inSentence(titleFor(inp.report)))}` : ''} &middot; ${inp.interactionCount} interaction${inp.interactionCount === 1 ? '' : 's'}</div></div>`
      : `<div><div class="big">&mdash;<small>ms</small></div><div class="sub">Interaction to Next Paint. Nothing slow yet.</div></div>`;
    panel.innerHTML =
      `<div class="head">${head}<button class="x" type="button" aria-label="Close">&times;</button></div>` +
      (groups.length ? groups.map(row).join('') : `<div class="empty">Click or type. Anything slow shows up here, with the component to blame.</div>`) +
      `<div class="foot"><span>react-inp-blame &middot; measuring cost ${costText(cost)} per interaction</span><button class="clear" type="button">Clear</button></div>`;
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

  function row(g: Group): string {
    const r = slowest(g.reports);
    const R = RATING[r.explanation.rating];
    const title = titleFor(r);
    const total = Math.max(r.duration, 1);
    const bar = phaseBar(r.explanation.phases, total);
    const later = laterRender(r);
    const n = g.reports.length;
    const isExpanded = expanded.has(r.interactionId);
    const meta = n > 1 ? `<div class="meta">${n} key presses &middot; slowest ${Math.round(r.duration)} ms &middot; typical ${Math.round(median(g.reports.map((x) => x.duration)))} ms</div>` : '';
    return (
      `<div class="row" data-id="${r.interactionId}">` +
      `<div class="toggle" role="button" tabindex="0" aria-expanded="${isExpanded}">` +
      `<div class="r1"><i class="dot" style="background:${R.color}"></i><span class="t">${esc(title)}</span><span class="ms" style="color:${R.color}">${Math.round(r.duration)} ms</span></div>` +
      meta +
      `<div class="blame">${blameLine(r)}</div>` +
      (later ? `<div class="blame later">then <b>${esc(where(later))}</b> re-rendered after the paint &middot; ${esc(top(later))}${later.hasDurations ? ` &middot; ${Math.round(later.total)} ms` : ''}</div>` : '') +
      `<div class="bar">${bar}</div>` +
      `</div>` +
      (isExpanded ? more(r) : '') +
      `</div>`
    );
  }

  function more(r: InteractionReport): string {
    const x = r.explanation;
    // Only a render with real work gets a component list; a status pill updating does not.
    const main = r.commits.length ? heaviest(r.commits) : null;
    const before = main && carriesWork(main) ? main : null;
    const later = laterRender(r);
    const legend = x.phases.flatMap((p, i) => [swatch(`p${i}`, p), ...(p.parts ?? []).map((part) => swatch('ph', part))]).join('');
    return (
      `<div class="more">` +
      `<div class="legend">${legend}</div>` +
      `<p>${esc(x.cause)}</p>` +
      x.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('') +
      (before ? comps('Rendered before the paint', before) : '') +
      (later ? comps('Rendered after the paint', later) : '') +
      `<p class="cost">Measuring this cost ${costText(r.overheadMs)}.</p>` +
      `</div>`
    );
  }

  function comps(label: string, c: CommitSummary): string {
    const rows = c.components.slice(0, 5);
    if (!rows.length) return '';
    const maxV = Math.max(...rows.map((x) => x.self ?? x.count), 1);
    return (
      `<div class="h">${label} &middot; ${c.rendered} components</div>` +
      rows
        .map(
          (x) =>
            `<div class="comp"><b>${esc(x.name)}</b><span>${x.count} rendered${x.self != null ? ` &middot; ${x.self.toFixed(1)} ms` : ''}</span>` +
            `<div class="tr"><div class="fl" style="width:${(((x.self ?? x.count) / maxV) * 100).toFixed(1)}%"></div></div></div>`,
        )
        .join('')
    );
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

function isTyping(r: InteractionReport): boolean {
  return isTypingEvent(r.type);
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
 * The phase bar. A phase with named parts draws them first, then what is left of it, so the
 * hydration inside the working time is a band of its own without the bar adding up to any more
 * than the interaction.
 */
function phaseBar(phases: readonly Phase[], total: number): string {
  return phases
    .map((p, i) => {
      const parts = p.parts ?? [];
      const rest = Math.max(0, p.ms - parts.reduce((a, x) => a + x.ms, 0));
      return parts.map((part) => band('ph', part.label, part.ms, total)).join('') + band(`p${i}`, p.label, rest, total);
    })
    .join('');
}

function band(cls: string, label: string, ms: number, total: number): string {
  return `<i class="${cls}" style="width:${((ms / total) * 100).toFixed(1)}%" title="${esc(label)}: ${Math.round(ms)} ms"></i>`;
}

function swatch(cls: string, p: Phase): string {
  return `<span title="${esc(p.hint)}"><i class="${cls}"></i>${esc(p.label)} ${Math.round(p.ms)} ms</span>`;
}

function where(c: CommitSummary): string {
  return leafName(c) ?? 'the tree';
}
function top(c: CommitSummary): string {
  const t = c.components[0];
  return t ? `${t.name} ×${t.count}` : `${c.rendered} components`;
}

function blameLine(r: InteractionReport): string {
  const b = r.explanation.blame;
  // An inferred blame is the likeliest reading of component counts and phase times, not a measurement.
  // The row says so in two words; the cause sentence under it says what would make it exact.
  const line = blameText(b);
  return b.confidence === 'inferred' && b.kind !== 'none' ? `most likely ${line}` : line;
}

function blameText(b: Blame): string {
  const ms = b.ms != null ? ` &middot; ${Math.round(b.ms)} ms` : '';
  switch (b.kind) {
    case 'render':
      return `<b>${esc(b.name ?? 'the tree')}</b> re-rendered${b.detail ? ` &middot; ${esc(b.detail)}` : ''}${ms}`;
    case 'handler':
      return `<b>${esc(b.name ?? 'the handler')}</b>${b.detail ? ` in ${esc(b.detail)}` : ''}${ms} in the handler`;
    // Only a hydration React finished inside the interaction takes the blame. HTML that was still
    // waiting is a sentence in front of whatever did take the time, which the cause line carries.
    case 'hydration':
      return `waited for React to hydrate <b>${esc(b.name ?? 'the page')}</b>${ms}${b.detail ? ` &middot; ${esc(b.detail)}` : ''}`;
    // Nothing names the read that forced the layout: the browser gives a total per script and never
    // says which line caused it. The name is where it happened, the subtree or the script, and it is
    // null where several scripts shared the total; the row then says only what was measured.
    case 'layout':
      return `browser recalculated layout${ms}${b.name ? ` in <b>${esc(b.name)}</b>` : ''}${b.detail ? ` &middot; ${esc(b.detail)}` : ''}`;
    case 'waiting':
      return `main thread was busy${ms} before the handler could start${b.name ? ` &middot; <b>${esc(b.name)}</b>` : ''}`;
    case 'painting':
      return `screen took${ms} to update${b.name ? ` &middot; <b>${esc(b.name)}</b>` : ''}`;
    case 'script':
      return `<b>${esc(b.name ?? 'a script')}</b> ran${ms}`;
    default:
      return 'nothing stood out; the time went to waiting and painting';
  }
}

/** "Typing in Password" / "Click on Log in", from the report's target. A report with no target is just "Typing" or "Click". */
function titleFor(r: InteractionReport): string {
  const t = r.target;
  const label = t?.label ? t.label.replace(/^\w+ /, '') : (t?.selector ?? '');
  if (isTypingEvent(r.type)) return label ? `Typing in ${label}` : 'Typing';
  if (isPointerEvent(r.type)) return label ? `Click on ${label}` : 'Click';
  return `${kindOf(r.type)} ${label}`.trim();
}

/** A title inside a sentence: the kind it starts with lowercased, the label as the page wrote it. */
function inSentence(title: string): string {
  return title.charAt(0).toLowerCase() + title.slice(1);
}

function tag(rating: keyof typeof RATING): string {
  const R = RATING[rating];
  return `<span class="tag" style="background:${R.color}">${R.label}</span>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string);
}
