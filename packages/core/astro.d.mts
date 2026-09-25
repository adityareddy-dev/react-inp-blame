import type { AstroIntegration } from 'astro';
import type { InstallOptions } from './dist/index.js';

/** The integration's own options. A key that is not one of these throws at config time. */
export interface InpBlameOptions {
  /**
   * Which runs of Astro get anything from this integration: 'development' (`astro dev`), 'production'
   * (`astro build`), true for both, false for neither. Default 'development', so a production build
   * carries nothing from it.
   */
  enabled?: 'development' | 'production' | boolean;
  /**
   * The runtime, in the runs `enabled` covers: install() with these options (true for the defaults),
   * in the script Astro imports before it hydrates any island, so it runs before an island's renderer
   * loads react-dom. The options are written into that script. false leaves the runtime out and keeps
   * only the displayName transform. Default true.
   */
  runtime?: boolean | InstallOptions;
}

/**
 * The Astro integration for react-inp-blame: the runtime installed before Astro hydrates any island, and
 * `displayName` stamped on components so their names survive the production minifier. List it after
 * `@astrojs/react`.
 */
export function inpBlame(options?: InpBlameOptions): AstroIntegration;
