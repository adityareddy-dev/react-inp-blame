/**
 * The client half of `withInpBlame` (`react-inp-blame/next`), which adds this module to Next.js's
 * `instrumentationClientInject`. Next.js imports it before `instrumentation-client` and before
 * hydration, so install() runs ahead of react-dom, with the options the wrapper was given; and the
 * App Router calls its `onRouterTransitionStart` as each navigation starts.
 */
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

// Next.js replaces this expression with the JSON `withInpBlame` put in `env`, at build time. Declared
// here rather than taken from Node's types, because in the browser nothing else of `process` is read.
declare const process: { readonly env: { readonly REACT_INP_BLAME_NEXT?: string } };

const settings: WrapperSettings = { install: {}, basePath: '', ...JSON.parse(process.env.REACT_INP_BLAME_NEXT || '{}') };

install(settings.install);

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
  announceNavigation({
    // A push or replace announces the path it was given, without the basePath; a traverse, the full URL.
    url: new URL(url.startsWith('/') ? settings.basePath + url : url, location.href).href,
    type: navigationType,
    // Reports are on the performance.now() clock; the event's timestamp is on the Unix epoch.
    at: event ? event.timestamp - performance.timeOrigin : performance.now(),
  });
}
