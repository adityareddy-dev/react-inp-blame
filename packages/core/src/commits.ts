import type { CommitSummary } from './types.js';

/** Choosing among the React commits a report holds, for everything that names one of them. */

/** The commit that carries most of the rendering: the slowest where React measured, else the one that rendered most. */
export function heaviest(list: readonly CommitSummary[]): CommitSummary {
  return list.reduce((a, b) => (score(b) > score(a) ? b : a));
}

function score(c: CommitSummary): number {
  return c.hasDurations ? c.total : c.rendered;
}

/** The component a commit is named after: the end of its hot path, else its outermost root; null when it rendered none. */
export function leafName(c: CommitSummary): string | null {
  return c.hotPath[c.hotPath.length - 1] || c.roots[0] || null;
}
