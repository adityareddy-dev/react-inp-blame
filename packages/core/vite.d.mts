import type { Plugin } from 'vite';
import type { InstallOptions } from './dist/index.js';

export interface InpBlameOptions {
  /**
   * Which runs of Vite get anything from these plugins: 'development' (the dev server), 'production'
   * (`vite build`), true for both, false for neither. Default 'development', so a production build
   * carries nothing from them.
   */
  enabled?: 'development' | 'production' | boolean;
  /**
   * The runtime, in the runs `enabled` covers: a module script ahead of the page's own that calls
   * install() with these options (true for the defaults), so the order of imports in the entry module
   * stops mattering. The options are written into that script. false leaves the runtime out and keeps
   * only the displayName transform. Default true.
   */
  runtime?: boolean | InstallOptions;
  /** Which HTML pages get the runtime's script, by their path from the root, such as '/index.html'. Default every page. */
  pages?: (path: string) => boolean;
}

/**
 * The Vite plugins for react-inp-blame: the runtime installed ahead of the app, and `displayName`
 * stamped on components so their names survive the production minifier.
 */
export function inpBlame(options?: InpBlameOptions): Plugin[];
