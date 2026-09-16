import type { NextConfig } from 'next';
import type { InstallOptions } from './dist/index.js';

export interface WithInpBlameOptions {
  /**
   * Which runs of Next get anything from this wrapper: 'development' (`next dev`), 'production'
   * (`next build` and `next start`), true for both, false for neither. Default 'development', so a
   * production build carries nothing from it. Next sets NODE_ENV before it reads the config, which is
   * how the two are told apart.
   */
  enabled?: 'development' | 'production' | boolean;
  /**
   * The runtime, in the runs `enabled` covers: `react-inp-blame/next-client`, added to
   * `instrumentationClientInject` so Next.js runs it before instrumentation-client and before
   * hydration. It calls install() with these options (true for the defaults) and joins App Router
   * navigations to reports. The options reach the browser inlined through `env`. false leaves the
   * runtime out and keeps only the displayName loader, for a project that installs from its own
   * instrumentation-client; the App Router navigation join goes with it, since that is what the
   * client module hears. Default true.
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
