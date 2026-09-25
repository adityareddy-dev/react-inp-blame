import type { CommitSummary } from './types.js';

/** Choosing among the React commits a report holds, for everything that names one of them. */

/** The commit that carries most of the rendering: the slowest where React measured, else the one that rendered most. */
export function heaviest(list: readonly CommitSummary[]): CommitSummary {
  return list.reduce((a, b) => (score(b) > score(a) ? b : a));
}

function score(c: CommitSummary): number {
  return c.hasDurations ? c.total : c.rendered;
}

/**
 * A component name a reader could search their own code for. React treats only a capitalised name as
 * a component, so `header`, the name a column definition's `header: ({ table }) => …` lends its
 * render function, is a property name that reads as an HTML tag rather than a component anybody
 * wrote. One and two character names are what a minifier leaves on a dependency that ships no
 * `displayName`. A dotted name counts only when every part of it does, which is what keeps
 * `Primitive.button` out: it names the element that was clicked, and "button in Primitive.button"
 * tells a reader nothing they did not write themselves. The same test keeps out the names styling
 * libraries give every element they wrap, `styled.div` (styled-components) and `Styled(Button)`
 * (styled-components and emotion).
 */
const READABLE_NAME = /^[A-Z][A-Za-z0-9_$]{2,}$/;
export const readableName = (name: string): boolean => name.split('.').every((part) => READABLE_NAME.test(part));

/**
 * The component a commit is named after: the deepest readable name on its hot path, else its first
 * readable root, else the end of its hot path or its outermost root as they stand, since the alternative
 * is inventing a name; null when it rendered none.
 */
export function leafName(c: CommitSummary): string | null {
  for (let i = c.hotPath.length - 1; i >= 0; i--) if (readableName(c.hotPath[i]!)) return c.hotPath[i]!;
  return c.roots.find(readableName) ?? (c.hotPath[c.hotPath.length - 1] || c.roots[0] || null);
}

/** What a commit was mostly made of: its most-rendered readable component, else its most-rendered one. */
export function mostlyComponent(c: CommitSummary): CommitSummary['components'][number] | undefined {
  return c.components.find((component) => readableName(component.name)) ?? c.components[0];
}
