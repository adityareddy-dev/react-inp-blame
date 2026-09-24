/**
 * The state this library keeps for the life of a page, on `globalThis` under
 * `Symbol.for('react-inp-blame')`.
 *
 * A page can load the library twice: a package duplicated in node_modules, or the same module in
 * two chunks. With its state in module variables, the second copy would find the first copy's
 * DevTools hook and chain onto it, so every commit would be walked twice and listeners would be
 * split between two installations. Under one global key every copy finds the same state, so a page
 * has one installation, one hook and one set of listeners, whichever copy installs.
 */

const KEY = Symbol.for('react-inp-blame');

/**
 * How the state is laid out. It changes whenever a slot's contents do, so a copy of another version
 * never reads state it would misunderstand.
 */
const LAYOUT = 2;

interface Session {
  readonly layout: number;
  readonly slots: Record<string, object>;
}

type Holder = { [KEY]?: Session };

const found = (globalThis as Holder)[KEY];

/** A copy of this library from a version that lays its state out differently got to the page first. */
export const incompatibleCopy = found !== undefined && found.layout !== LAYOUT;

// That copy's state stays its own: this copy keeps a private session, and install() installs nothing.
const session: Session = found && !incompatibleCopy ? found : { layout: LAYOUT, slots: {} };
if (!found) (globalThis as Holder)[KEY] = session;

/** The page's state for `slot`, created by the first copy that asks. Each slot belongs to one module. */
export function shared<T extends object>(slot: string, create: () => T): T {
  return (session.slots[slot] ??= create()) as T;
}
