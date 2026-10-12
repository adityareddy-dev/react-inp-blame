/**
 * The client half of `withInpBlame` (`react-inp-blame/next`), which adds this module to Next.js's
 * `instrumentationClientInject`. Next.js imports it before `instrumentation-client` and before
 * hydration, so install() runs ahead of react-dom, with the options the wrapper was given; and the
 * App Router calls its `onRouterTransitionStart` as each navigation starts. Before Next.js 16.3 the
 * app's own instrumentation-client re-exports it, and Next.js imports that file just as early.
 */
import { frameworkLayers, frameworkWrappers } from './commits.js';
import { install } from './index.js';
import { routerNavigated } from './navigation.js';
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

/**
 * next/link's component, named the same in both routers from Next.js 14.2 to 16.3. It renders the `<a>` around
 * what the app gives it, so in development a click on a link was named after it rather than after the
 * component that wrote `<Link>`. Not a layer: a render that stops at it is still named after it.
 */
const NEXT_WRAPPERS: readonly string[] = ['LinkComponent'];

// Next.js replaces this expression at build time with what `withInpBlame` put in `env`: the settings as
// JSON, or '' in a build its `enabled` leaves out and with `runtime: false`. Declared here rather than
// taken from Node's types, because in the browser nothing else of `process` is read.
declare const process: { readonly env: { readonly REACT_INP_BLAME_NEXT?: string } };

// The injected copy is not in a build the wrapper leaves out at all, but the line in instrumentation-client
// is in every one, so each gate below is what keeps this module to the runs the wrapper covers. Each names
// process.env.REACT_INP_BLAME_NEXT itself: webpack folds a test of the inlined '' but not a test of a const
// that holds it, and only the folded test lets it drop install() and everything it imports. Kept in a
// variable, it brought the unused library back into a left-out webpack build: 62 KB gzipped on
// apps/next-demo, where main-app and the Pages Router's main each hold a copy. Undefined, from an older
// wrapper or none, still installs nothing, but no bundler can drop the code. In a bundle the expression
// is a literal, so reading it at each gate changes nothing at runtime.
const settings: WrapperSettings | null = process.env.REACT_INP_BLAME_NEXT ? { install: {}, basePath: '', ...JSON.parse(process.env.REACT_INP_BLAME_NEXT) } : null;

if (process.env.REACT_INP_BLAME_NEXT && settings) {
  // Under Next.js these names are its own, so a render that starts at the App Router's Router, and a click on
  // a link, are named after the app's components.
  for (const name of APP_ROUTER_LAYERS) frameworkLayers.add(name);
  for (const name of NEXT_WRAPPERS) frameworkWrappers.add(name);
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
 * every report after it carries its URL's origin and path.
 */
export function onRouterTransitionStart(url: string, navigationType: StartedNavigation['type'], event?: RouterTransitionStartEvent | null): void {
  if (process.env.REACT_INP_BLAME_NEXT && settings) {
    routerNavigated({
      // A push or replace announces the path it was given, without the basePath; a traverse, the full URL.
      url: new URL(url.startsWith('/') ? settings.basePath + url : url, location.href).href,
      type: navigationType,
      // Reports are on the performance.now() clock; the event's timestamp is on the Unix epoch.
      at: event ? event.timestamp - performance.timeOrigin : performance.now(),
    });
  }
}
