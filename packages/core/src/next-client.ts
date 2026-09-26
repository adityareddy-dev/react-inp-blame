/**
 * The client half of `withInpBlame` (`react-inp-blame/next`), which adds this module to Next.js's
 * `instrumentationClientInject`. Next.js imports it before `instrumentation-client` and before
 * hydration, so install() runs ahead of react-dom, with the options the wrapper was given; and the
 * App Router calls its `onRouterTransitionStart` as each navigation starts. Before Next.js 16.3 the
 * app's own instrumentation-client re-exports it, and Next.js imports that file just as early.
 */
import { frameworkLayers } from './commits.js';
import { install } from './index.js';
import { announceNavigation } from './navigation.js';
import type { InstallOptions, StartedNavigation } from './types.js';

/** What `withInpBlame` hands this module. */
interface WrapperSettings {
  /** The options of its `runtime`; empty for the defaults. */
  install: InstallOptions;
  /** `nextConfig.basePath`, which the App Router leaves out of the URLs it announces. */
  basePath: string;
}

/**
 * The components Next.js's App Router renders between the root and a page, from Next.js 14.2 to 16.3: the
 * boundaries every layout and page segment gets, the layout routers, the scroll handlers, the page's own root
 * and the development build's hot reloader and overlay boundary. Each renders what it is given. A production
 * build minifies them, and the hot path passes them already; in development they are readable, and a render
 * that starts at the Router, as a Server Action's result does, spent the path's twelve
 * steps on them two segments above the page, and was named after the page segment's ErrorBoundary.
 */
const APP_ROUTER_LAYERS: readonly string[] = [
  'Router', 'HotReload', 'ReactDevOverlay', 'AppDevOverlayErrorBoundary', 'ServerRoot', 'AppRouter',
  'DevRootHTTPAccessFallbackBoundary', 'DevRootNotFoundBoundary', 'HTTPAccessFallbackBoundary', 'HTTPAccessFallbackErrorBoundary',
  'NotFoundBoundary', 'NotFoundErrorBoundary', 'RedirectBoundary', 'RedirectErrorBoundary', 'ErrorBoundary', 'ErrorBoundaryHandler',
  'LoadingBoundary', 'OuterLayoutRouter', 'InnerLayoutRouter', 'SegmentViewNode', 'ScrollAndFocusHandler', 'ScrollAndMaybeFocusHandler',
  'InnerScrollAndFocusHandler', 'InnerScrollAndFocusHandlerOld', 'InnerScrollHandlerNew', 'ClientPageRoot', 'ClientSegmentRoot',
];

// Next.js replaces this expression with the JSON `withInpBlame` put in `env`, at build time. Declared
// here rather than taken from Node's types, because in the browser nothing else of `process` is read.
declare const process: { readonly env: { readonly REACT_INP_BLAME_NEXT?: string } };

// Undefined in a build the wrapper's `enabled` leaves out, or with `runtime: false`, and then this module
// does nothing. The injected copy is not in those builds at all, but the line in instrumentation-client
// is in every one, so this is what keeps it to the runs the wrapper covers.
const wrapper = process.env.REACT_INP_BLAME_NEXT;
const settings: WrapperSettings | null = wrapper ? { install: {}, basePath: '', ...JSON.parse(wrapper) } : null;

if (settings) {
  // Under the App Router these names are Next.js's own, so a render that starts at its Router is named after
  // the app's components below them.
  for (const name of APP_ROUTER_LAYERS) frameworkLayers.add(name);
  install(settings.install);
}

/** The third argument under `experimental.instrumentationClientRouterTransitionEvents`, reduced to what is read; Next.js passes null without the flag. */
interface RouterTransitionStartEvent {
  /** When the navigation began, as a Unix epoch time in ms. */
  readonly timestamp: number;
}

/**
 * Called by the App Router as each navigation starts. A navigation started while an input was being
 * dispatched (a Link click, `router.push()` in a click handler) is named on that input's report, and
 * every report after it carries its URL.
 */
export function onRouterTransitionStart(url: string, navigationType: StartedNavigation['type'], event?: RouterTransitionStartEvent | null): void {
  if (!settings) return;
  announceNavigation({
    // A push or replace announces the path it was given, without the basePath; a traverse, the full URL.
    url: new URL(url.startsWith('/') ? settings.basePath + url : url, location.href).href,
    type: navigationType,
    // Reports are on the performance.now() clock; the event's timestamp is on the Unix epoch.
    at: event ? event.timestamp - performance.timeOrigin : performance.now(),
  });
}
