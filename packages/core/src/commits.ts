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
 * The component a commit is named after: the deepest readable name on its hot path, else the end of its
 * hot path, or its outermost root, as they stand, since the alternative is inventing a name; null when it
 * rendered none.
 */
export function leafName(c: CommitSummary): string | null {
  for (let i = c.hotPath.length - 1; i >= 0; i--) if (readableName(c.hotPath[i]!)) return c.hotPath[i]!;
  // Not another root: the hot path starts at the heaviest, so any other root is a subtree beside the work.
  return c.hotPath[c.hotPath.length - 1] || c.roots[0] || null;
}

/** The names styling libraries give every element they wrap: `styled.div`, `Styled(Button)`. */
const STYLING_WRAPPER = /^styled\.|^Styled\(/;

/**
 * What a commit was mostly made of: of the components a styling library did not make, the one that
 * rendered most (took longest, where React measured), or a readable one that carries at least half as much,
 * since a name the app wrote says more than a minifier's; the most-rendered of all when every one is a
 * styling library's.
 */
export function mostlyComponent(c: CommitSummary): CommitSummary['components'][number] | undefined {
  const own = c.components.filter((component) => !STYLING_WRAPPER.test(component.name));
  const first = own[0];
  if (!first) return c.components[0];
  const readable = own.find((component) => readableName(component.name));
  if (!readable || readable === first) return first;
  const weight = (component: CommitSummary['components'][number]) => component.self ?? component.count;
  return weight(readable) >= weight(first) / 2 ? readable : first;
}
