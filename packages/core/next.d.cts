export interface WithInpBlameOptions {
  /**
   * Which runs of Next get the displayName loader: 'development' (`next dev`), 'production'
   * (`next build` and `next start`), true for both, false for neither. Default 'development', so
   * a production build carries nothing from this wrapper, and component names survive the
   * production minifier only when production is included. Next sets NODE_ENV before it reads the
   * config, which is how the two are told apart.
   */
  enabled?: 'development' | 'production' | boolean;
}

/**
 * Wraps a Next.js config so component names survive the production minifier, under Turbopack
 * and webpack. Pair it with `import 'react-inp-blame/auto'` in instrumentation-client.ts.
 */
export function withInpBlame<T extends Record<string, any>>(nextConfig?: T, options?: WithInpBlameOptions): T;
