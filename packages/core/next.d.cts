import type { NextConfig } from 'next';
import type { InstallOptions } from './dist/index.js';

/** The wrapper's own options, its second argument. A key that is not one of these throws at config time. */
export interface WithInpBlameOptions {
  /**
   * Which runs of Next get anything from this wrapper: 'development' (`next dev`), 'production'
   * (`next build` and `next start`), true for both, false for neither. Default 'development', so a
   * production build carries nothing from it, except on Next.js 15.3 to 16.2, where the line in
   * instrumentation-client brings the client module into every build, unused where it is left out. Next
   * sets NODE_ENV before it reads the config, which is how the two are told apart.
   * Left at the default, `next build` says in one line that it left the library out; write
   * 'development' yourself to keep it out without the line.
   */
  enabled?: 'development' | 'production' | boolean;
  /**
   * The runtime, in the runs `enabled` covers: `react-inp-blame/next-client`, added to
   * `instrumentationClientInject` so Next.js runs it before instrumentation-client and before
   * hydration. It calls install() with these options (true for the defaults) and joins App Router
   * navigations to reports. The options reach the browser inlined through `env`. On Next.js 15.3 to
   * 16.2, which have no `instrumentationClientInject`, the app's instrumentation-client re-exports
   * that module instead, and the wrapper prints the line until it does. false leaves the runtime out
   * and keeps only the displayName loader, for a project that calls install() itself in its
   * instrumentation-client, without the next-client line; the App Router navigation join goes with it,
   * since that is what the client module hears. Default true.
   */
  runtime?: boolean | InstallOptions;
}

/** The context Next.js passes a config written as a function of the phase. */
export interface NextConfigPhase {
  defaultConfig: NextConfig;
}

/** A config written as a function of the phase, the other form Next.js documents. */
export type NextConfigFunction = (phase: string, context: NextConfigPhase) => NextConfig | Promise<NextConfig>;

/**
 * Wraps a Next.js config: installs react-inp-blame before hydration, and keeps component names
 * through the production minifier under Turbopack and webpack. A config written as a function is
 * wrapped around what it returns, so it comes back as a function too.
 */
export function withInpBlame(nextConfig: NextConfigFunction, options?: WithInpBlameOptions): NextConfigFunction;
export function withInpBlame(nextConfig?: NextConfig, options?: WithInpBlameOptions): NextConfig;
