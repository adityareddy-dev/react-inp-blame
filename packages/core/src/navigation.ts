import { shared } from './session.js';
import type { CommitSummary, NavigationType, StartedNavigation } from './types.js';

/**
 * The navigations of a page, which reports are placed in: the document's own load, then each soft
 * navigation a router announces and each restore from the back/forward cache. Their names and values
 * are web-vitals' (`navigationURL`, `navigationType`), so a report lines up with the INP web-vitals
 * reports for the same navigation. A report's URL keeps only the origin and path, so match on those.
 */

/** One navigation of the page. */
export interface PageNavigation {
  /** Its URL, absolute, as `pageURL` leaves it. */
  readonly url: string;
  readonly type: NavigationType;
  /** `performance.now()` when it began: 0 for the document's own load. */
  readonly start: number;
  /** For a soft navigation: the router's word for it, and the input being dispatched when the router announced it, if one was. */
  readonly router: {
    readonly type: StartedNavigation['type'];
    readonly input: Pick<CommitSummary, 'inputTs' | 'inputType' | 'gestureTs'> | null;
  } | null;
}

/** Navigations a page keeps, oldest first. An interaction that began before the oldest of them is placed in that one. */
export const MAX_NAVIGATIONS = 20;

/** A soft navigation as a router announces it. */
export interface RouterNavigation {
  /** Where it goes, as an absolute URL. */
  readonly url: string;
  readonly type: StartedNavigation['type'];
  /** When it began, on the `performance.now()` clock. */
  readonly at: number;
}

/**
 * Where router announcements go: the installation's handler, while there is one. Shared like the rest
 * of the page's state, so a router integration from another copy of the library reaches it.
 */
const router = shared<{ listener: ((navigation: RouterNavigation) => void) | null }>('router', () => ({ listener: null }));

/**
 * A URL as a report keeps it: its origin and path, without a query, a fragment or a password, since a
 * report is made to be forwarded. One that does not parse is cut at its first `?` or `#`.
 */
export function pageURL(href: string): string {
  try {
    const url = new URL(href);
    url.username = url.password = url.search = url.hash = '';
    return url.href;
  } catch {
    return href.split(/[?#]/, 1)[0]!;
  }
}

/** Tells the installation that a router started a soft navigation. Does nothing while nothing is installed. */
export function routerNavigated(navigation: RouterNavigation): void {
  router.listener?.(navigation);
}

/**
 * Tells react-inp-blame that the app's router changed the route in the page, to `url`, resolved against
 * the page's URL, so include any base path. Reports of the interactions that begin after it carry the
 * URL, with `navigationType: 'soft-navigation'`, and the INP estimate starts over. Called while a click
 * or key press is being dispatched, that interaction's report names it in `startedNavigation`, as a
 * 'push'. Reports keep its origin and path only, so a call for a change of query or hash alone still
 * counts as a navigation: the INP estimate starts over, and `startedNavigation.url` is the same as the
 * report's own `navigationURL`. Does nothing before install(), on a page the sample left out and on
 * the server, and never throws. The Next.js App Router needs no call: `withInpBlame` announces its
 * navigations.
 */
export function announceNavigation(url: string | URL): void {
  if (typeof window === 'undefined' || !router.listener) return;
  let href: string;
  try {
    href = new URL(url, location.href).href;
  } catch {
    // A URL that does not parse names no navigation.
    return;
  }
  routerNavigated({ url: href, type: 'push', at: performance.now() });
}

/** Makes `fn` hear router announcements, until the returned undo is called. */
export function onRouterNavigation(fn: (navigation: RouterNavigation) => void): () => void {
  router.listener = fn;
  return () => {
    if (router.listener === fn) router.listener = null;
  };
}

/** A `PerformanceNavigationTiming`, reduced to what names the navigation; TypeScript's DOM lib leaves out `activationStart`. */
interface NavigationEntry extends PerformanceEntry {
  readonly type: 'navigate' | 'reload' | 'back_forward' | 'prerender';
  readonly activationStart?: number;
}

/** The document's own navigation, named the way web-vitals names it. */
export function documentNavigation(): PageNavigation {
  const [entry] = performance.getEntriesByType('navigation') as NavigationEntry[];
  const doc = document as Document & { readonly prerendering?: boolean; readonly wasDiscarded?: boolean };
  let type: NavigationType = 'navigate';
  if (entry) {
    if (doc.prerendering || (entry.activationStart ?? 0) > 0) type = 'prerender';
    else if (doc.wasDiscarded) type = 'restore';
    else type = entry.type.replace(/_/g, '-') as NavigationType;
  }
  return { url: entry?.name || location.href, type, start: 0, router: null };
}
