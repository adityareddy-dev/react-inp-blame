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
 * (styled-components and emotion). Radix's Slot is kept out by name: it renders nothing of its own, it
 * merges its props into the child it is given, and Radix names each one after the component that rendered
 * it (`RovingFocusGroupCollectionItemSlot.Slot`, `Primitive.button.SlotClone`), or `Slot` alone where the
 * app rendered one itself, as shadcn's Button does for `asChild`. So are the collection slots Radix's parts
 * register their items through (`MenuCollectionItemSlot`, `RovingFocusGroupCollectionSlot`), which render
 * only the Slot named after them. The component before is the one to name, where it is readable itself.
 */
const READABLE_NAME = /^[A-Z][A-Za-z0-9_$]{2,}$/;
const SLOT = /^Slot(Clone)?$|Collection(Item)?Slot$/;
// The suffix Vite's development server and Rolldown add to a name that clashes with another in the same
// scope: `Dt$1` is a minifier's `Dt`, and is judged as `Dt`.
const DEDUPE_SUFFIX = /\$\d+$/;
export const readableName = (name: string): boolean =>
  name.split('.').every((part) => {
    const plain = part.replace(DEDUPE_SUFFIX, '');
    return READABLE_NAME.test(plain) && !SLOT.test(plain);
  });

/**
 * A layer the hot path names but spends no step on, and a render is not named after, so that the steps go
 * on components a reader could search for and reach them where there are any: a name a reader could not
 * search for (`readableName`), and a Provider or a Context, which renders what it is given. On the
 * shadcn/ui docs Radix's layers alone (`Primitive.div`, `.Slot`, `.SlotClone`, `TabsProvider`,
 * `CollectionProvider`, `ProviderProvider`) spent the twelve steps between Tabs and the trigger that
 * rendered, and on cal.com a provider and a minified name spent the two that would have reached the tab
 * below the form. A library's readable parts (Radix's RovingFocusGroup, DismissableLayer) are not layers:
 * names alone cannot tell them from the app's.
 */
const PROVIDER = /Provider$|Context$/;
export const passedLayer = (name: string): boolean => !readableName(name) || PROVIDER.test(name);

/**
 * The component a commit is named after: the deepest name on its hot path that is not a layer
 * (`passedLayer`), else the end of its hot path, or its outermost root, as they stand, since the alternative
 * is inventing a name; null when it rendered none.
 */
export function leafName(c: CommitSummary): string | null {
  for (let i = c.hotPath.length - 1; i >= 0; i--) if (!passedLayer(c.hotPath[i]!)) return c.hotPath[i]!;
  // A walk cut short with no durations to go by leaves no hot path where the work could be in more than one
  // subtree and nothing holds them all, and its first root is only the one the walk reached first.
  if (c.truncated && !c.hasDurations) return c.hotPath[c.hotPath.length - 1] || null;
  // Not another root: the hot path starts at the heaviest, so any other root is a subtree beside the work.
  return c.hotPath[c.hotPath.length - 1] || c.roots[0] || null;
}

/**
 * The component a commit's render started from, for a sentence that says where it went: the top of its hot
 * path, where the path goes below it, the name is not a layer, and it holds the whole commit
 * (`startRendered`), since "from X down" claims the count under X, and the path starts at the heaviest of
 * the roots that rendered, not at all of them. It is often where the cause is: on cal.com the form's state
 * lives in EventTypeWeb, and the render was named after a component eleven layers down.
 */
export function startName(c: CommitSummary): string | null {
  const first = c.hotPath[0];
  return first && c.hotPath.length > 1 && first !== leafName(c) && !passedLayer(first) && c.startRendered === c.rendered ? first : null;
}

/** The names styling libraries give every element they wrap: `styled.div`, `Styled(Button)`. */
const STYLING_WRAPPER = /^styled\.|^Styled\(/;

/**
 * What a commit was mostly made of: of the components a styling library did not make, the one that
 * rendered most (took longest, where React measured), or a readable one that carries at least half as much,
 * since a name the app wrote says more than a minifier's; the most-rendered of all when every one is a
 * styling library's. Not said of a walk cut short, whose counts are of the part it reached first.
 */
export function mostlyComponent(c: CommitSummary): CommitSummary['components'][number] | undefined {
  if (c.truncated) return undefined;
  const own = c.components.filter((component) => !STYLING_WRAPPER.test(component.name));
  const first = own[0];
  if (!first) return c.components[0];
  const readable = own.find((component) => readableName(component.name));
  if (!readable || readable === first) return first;
  // By time where React measured it, unless it measured none on the most-rendered (a render quicker than its
  // clock), where every weight is 0 and the counts still say something.
  const bySelf = first.self != null && readable.self != null && first.self > 0;
  const weight = (component: CommitSummary['components'][number]) => (bySelf ? component.self! : component.count);
  return weight(readable) >= weight(first) / 2 ? readable : first;
}

// A sentence says a commit was "mostly" one component from half of it. On the shadcn/ui docs a render of 59
// components read "mostly Label (4 of them)", which sends a reader to the wrong file.
const MOSTLY_MIN_SHARE = 0.5;

/**
 * `mostlyComponent` where it is most of the commit, for the words that say "mostly": half of the components
 * rendered or more, not counting the wrappers a styling library puts around each element, or half of the
 * render time where React timed it. Which blame a render gets still goes by `mostlyComponent`.
 */
export function dominantComponent(c: CommitSummary): CommitSummary['components'][number] | undefined {
  const top = mostlyComponent(c);
  const wrappers = c.components.reduce((n, x) => n + (STYLING_WRAPPER.test(x.name) ? x.count : 0), 0);
  return top && (top.count >= MOSTLY_MIN_SHARE * (c.rendered - wrappers) || (top.self != null && c.total > 0 && top.self <= c.total && top.self >= MOSTLY_MIN_SHARE * c.total)) ? top : undefined;
}

// What a minifier leaves on a function that carries no `displayName`: one or two characters.
const MINIFIED_NAME = /^[A-Za-z_$][A-Za-z0-9_$]?$/;
// Fewer names than this say nothing about the build: a page of three components can be called A, B and Nav.
const MINIFIED_NAMES_MIN = 5;

/**
 * Whether the component names in these commits look minified: at least five different names, and four in
 * five of them one or two characters long. That is a production build with nothing stamping `displayName`
 * (no Vite plugin, Next.js wrapper or loader), where blames read "inside e, mostly Xe". A styling library's
 * `styled.div` is not short, so an app styled that way does not look minified.
 */
export function namesLookMinified(commits: readonly CommitSummary[]): boolean {
  // A readable name where the render started or led is the app's own, stamped: the short ones around it are
  // a dependency's, which nothing in the app's build can name, and the setups the note gives would change
  // nothing.
  if (commits.some((c) => c.roots.some(readableName) || c.hotPath.some(readableName))) return false;
  const names = namesIn(commits);
  if (names.size < MINIFIED_NAMES_MIN) return false;
  let short = 0;
  for (const n of names) if (MINIFIED_NAME.test(n)) short++;
  return short >= 0.8 * names.size;
}

/**
 * Whether `name` is a minifier's in a build that keeps names: past it, `$1` or not, at least five different
 * names in these commits and most of them readable. There one short name is most likely a dependency's,
 * where in a build that stamps nothing, or one with too few names to tell, it could be the app's own.
 */
export function minifiedAmongReadable(commits: readonly CommitSummary[], name: string): boolean {
  const bare = name.replace(DEDUPE_SUFFIX, '');
  if (!MINIFIED_NAME.test(bare)) return false;
  const others = [...namesIn(commits)].filter((n) => n.replace(DEDUPE_SUFFIX, '') !== bare);
  return others.length >= MINIFIED_NAMES_MIN && others.filter(readableName).length > others.length / 2;
}

/** Every root, hot path and component name in these commits but `(anonymous)`. */
function namesIn(commits: readonly CommitSummary[]): Set<string> {
  const names = new Set<string>();
  for (const c of commits) for (const n of [...c.roots, ...c.hotPath, ...c.components.map((x) => x.name)]) names.add(n);
  names.delete('(anonymous)');
  return names;
}

const MINIFIED_NAMES_WHY =
  "are one or two characters, which is what a minifier leaves on a component without a displayName. The app's own components keep their names under react-inp-blame/vite, withInpBlame for Next.js or react-inp-blame/display-names-loader for webpack; a dependency's keep theirs only where it sets displayName itself.";
/** What a report says when `namesLookMinified`. */
export const MINIFIED_NAMES_NOTE = `Most component names here ${MINIFIED_NAMES_WHY}`;
/** What the console says, once, when a report's names look minified. */
export const MINIFIED_NAMES_CONSOLE = `Most component names in this page's reports ${MINIFIED_NAMES_WHY}`;
