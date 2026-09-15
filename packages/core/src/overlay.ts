import type { Blame, CommitSummary, InteractionReport, OverlayOptions } from './types';

/**
 * The on-page badge and panel. Plain DOM inside a shadow root: no React, so it renders even
 * while React is busy, never causes a React commit, and takes no styles from the page.
 */

interface Source {
  reports(): InteractionReport[];
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

export const OVERLAY_ID = 'react-inp-blame';

const RATING = {
  good: { label: 'Good', color: '#22c55e' },
  'needs-work': { label: 'Needs work', color: '#f59e0b' },
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
    const inp = pageInp(all);
    if (!inp) {
      badge.dataset.rating = 'none';
      badge.innerHTML = `<i class="dot"></i>INP <span class="n">&mdash;</span>`;
    } else {
      const R = RATING[inp.explanation.rating];
      badge.dataset.rating = inp.explanation.rating;
      badge.innerHTML = `<i class="dot" style="background:${R.color}"></i>INP <span class="ms">${Math.round(inp.duration)} ms</span>`;
    }
    if (panel.hidden) return;
    const groups = groupRows(all).slice(-max).reverse();
    const cost = all.length ? all.reduce((a, r) => a + r.overheadMs, 0) / all.length : 0;
    const head = inp
      ? `<div><div class="big">${Math.round(inp.duration)}<small>ms</small>${tag(inp.explanation.rating)}</div><div class="sub">Page INP so far, from ${esc(titleFor(inp).title.toLowerCase())} &middot; ${all.length} interaction${all.length === 1 ? '' : 's'} measured</div></div>`
      : `<div><div class="big">&mdash;<small>ms</small></div><div class="sub">Interaction to Next Paint. Nothing slow yet.</div></div>`;
    panel.innerHTML =
      `<div class="head">${head}<button class="x" type="button" aria-label="Close">&times;</button></div>` +
      (groups.length ? groups.map(row).join('') : `<div class="empty">Click or type. Anything slow shows up here, with the component to blame.</div>`) +
      `<div class="foot"><span>react-inp-blame &middot; measuring cost ${cost.toFixed(1)} ms per interaction</span><button class="clear" type="button">Clear</button></div>`;
  }

  function row(g: Group): string {
    const r = slowest(g.reports);
    const R = RATING[r.explanation.rating];
    const { title } = titleFor(r);
    const total = Math.max(r.duration, 1);
    const bar = r.explanation.phases
      .map((p, i) => `<i class="p${i}" style="width:${((p.ms / total) * 100).toFixed(1)}%" title="${esc(p.label)}: ${Math.round(p.ms)} ms"></i>`)
      .join('');
    const later = laterRender(r);
    const n = g.reports.length;
    const meta = n > 1 ? `<div class="meta">${n} key presses &middot; slowest ${Math.round(r.duration)} ms &middot; typical ${Math.round(median(g.reports.map((x) => x.duration)))} ms</div>` : '';
    return (
      `<div class="row${expanded.has(r.interactionId) ? ' on' : ''}" data-id="${r.interactionId}">` +
      `<div class="r1"><i class="dot" style="background:${R.color}"></i><span class="t">${esc(title)}</span><span class="ms" style="color:${R.color}">${Math.round(r.duration)} ms</span></div>` +
      meta +
      `<div class="blame">${blameLine(r.explanation.blame)}</div>` +
      (later ? `<div class="blame later">then <b>${esc(where(later))}</b> re-rendered after the paint &middot; ${esc(top(later))}${later.hasDurations ? ` &middot; ${Math.round(later.total)} ms` : ''}</div>` : '') +
      `<div class="bar">${bar}</div>` +
      (expanded.has(r.interactionId) ? more(r) : '') +
      `</div>`
    );
  }

  function more(r: InteractionReport): string {
    const x = r.explanation;
    // Only a render with real work gets a component list; a status pill updating does not.
    const main = r.commits.length ? heaviest(r.commits) : null;
    const before = main && (main.hasDurations ? main.total >= 5 : main.rendered >= 10) ? main : null;
    const later = laterRender(r);
    const legend = x.phases.map((p, i) => `<span title="${esc(p.hint)}"><i class="p${i}"></i>${esc(p.label)} ${Math.round(p.ms)} ms</span>`).join('');
    return (
      `<div class="more">` +
      `<div class="legend">${legend}</div>` +
      `<p>${esc(x.cause)}</p>` +
      x.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('') +
      (before ? comps('Rendered before the paint', before) : '') +
      (later ? comps('Rendered after the paint', later) : '') +
      `<p class="cost">Measuring this cost ${r.overheadMs.toFixed(1)} ms.</p>` +
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

  badge.addEventListener('click', () => setOpen(panel.hidden));
  panel.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (el.closest('.x')) return setOpen(false);
    if (el.closest('.clear')) {
      source.clear();
      expanded.clear();
      return render();
    }
    if (el.closest('.more')) return;
    const r = el.closest<HTMLElement>('.row');
    if (!r) return;
    const id = Number(r.dataset.id);
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    render();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !panel.hidden) setOpen(false);
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

/** True when the URL or localStorage asks for the overlay; the `'query'` mode of the option. */
export function overlayRequested(): boolean {
  try {
    if (/[?&#]inp-blame(?:[=&#]|$)/.test(location.search + location.hash)) return true;
    return localStorage.getItem('react-inp-blame') === 'overlay';
  } catch {
    return false;
  }
}

interface Group {
  reports: InteractionReport[];
}

/** Consecutive key presses in the same field collapse into one row, the way a person sees them. */
function groupRows(reports: InteractionReport[]): Group[] {
  const out: Group[] = [];
  for (const r of reports) {
    const last = out[out.length - 1];
    if (last && isTyping(r) && isTyping(last.reports[0]) && sameTarget(r, last.reports[0])) last.reports.push(r);
    else out.push({ reports: [r] });
  }
  return out;
}

function isTyping(r: InteractionReport): boolean {
  const kind = r.explanation.headline.replace(/^\d+ ms /, '');
  return kind === 'key press' || kind === 'typing';
}

function sameTarget(a: InteractionReport, b: InteractionReport): boolean {
  return a.target?.selector === b.target?.selector && a.target?.label === b.target?.label;
}

function slowest(reports: InteractionReport[]): InteractionReport {
  return reports.reduce((a, b) => (b.duration > a.duration ? b : a));
}

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** The page's INP so far: the worst interaction, or the 98th percentile once there are 50 or more. */
function pageInp(reports: InteractionReport[]): InteractionReport | null {
  if (!reports.length) return null;
  const sorted = reports.slice().sort((a, b) => b.duration - a.duration);
  return sorted[Math.min(sorted.length - 1, Math.floor(reports.length / 50))];
}

function heaviest(commits: CommitSummary[]): CommitSummary {
  return commits.reduce((a, b) => ((b.hasDurations ? b.total : b.rendered) > (a.hasDurations ? a.total : a.rendered) ? b : a));
}

/** A later render worth a line: real work, not the page's own status pill updating. */
function laterRender(r: InteractionReport): CommitSummary | null {
  if (!r.followUps.length) return null;
  const c = heaviest(r.followUps);
  return (c.hasDurations ? c.total >= 10 : c.rendered >= 25) ? c : null;
}

function where(c: CommitSummary): string {
  return c.hotPath[c.hotPath.length - 1] ?? c.roots[0] ?? 'the tree';
}
function top(c: CommitSummary): string {
  const t = c.components[0];
  return t ? `${t.name} ×${t.count}` : `${c.rendered} components`;
}

function blameLine(b: Blame): string {
  const ms = b.ms != null ? ` &middot; ${Math.round(b.ms)} ms` : '';
  switch (b.kind) {
    case 'render':
      return `<b>${esc(b.name ?? 'the tree')}</b> re-rendered${b.detail ? ` &middot; ${esc(b.detail)}` : ''}${ms}`;
    case 'handler':
      return `<b>${esc(b.name ?? 'the handler')}</b>${b.detail ? ` in ${esc(b.detail)}` : ''}${ms} in the handler`;
    case 'waiting':
      return `main thread was busy${ms} before the handler could start`;
    case 'painting':
      return `screen took${ms} to update${b.name ? ` &middot; <b>${esc(b.name)}</b>` : ''}`;
    case 'script':
      return `<b>${esc(b.name ?? 'a script')}</b> ran${ms}`;
    default:
      return 'nothing stood out; the time went to waiting and painting';
  }
}

/** "Typing in Password" / "Click on Log in", from the report's target. */
function titleFor(r: InteractionReport): { title: string } {
  const t = r.target;
  const label = t?.label ? t.label.replace(/^\w+ /, '') : (t?.selector ?? '');
  const kind = r.explanation.headline.replace(/^\d+ ms /, '');
  const verb = kind === 'key press' || kind === 'typing' ? 'Typing in' : kind === 'click' || kind === 'tap' ? 'Click on' : kind;
  return { title: `${verb} ${label}`.trim() };
}

function tag(rating: keyof typeof RATING): string {
  const R = RATING[rating];
  return `<span class="tag" style="background:${R.color}">${R.label}</span>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string);
}
