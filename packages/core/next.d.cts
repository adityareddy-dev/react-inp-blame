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
   * navigations to reports. The options reach the browser inlined through `env`, so they are data:
   * `onReport` is not one of them. false leaves the runtime out and keeps only the displayName loader,
   * for a project that installs from its own instrumentation-client. Default true.
   */
  runtime?: boolean | Omit<InstallOptions, 'onReport'>;
}

/**
 * Wraps a Next.js config: installs react-inp-blame before hydration, and keeps component names
 * through the production minifier under Turbopack and webpack.
 */
export function withInpBlame(nextConfig?: NextConfig, options?: WithInpBlameOptions): NextConfig;
