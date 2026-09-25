import type { Plugin } from 'vite';
import type { InstallOptions } from './dist/index.js';

/** The plugins' own options. A key that is not one of these throws at config time. */
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
  /**
   * For a framework that writes its own HTML, where no page goes through Vite: the module of the app,
   * by its path from the project root, that gets the install as its first import, such as
   * 'app/root.tsx' under React Router and Remix, or 'src/client.tsx' under TanStack Start. In a build
   * the install gets a chunk of its own, holding everything it imports, and an app whose package.json
   * says `"sideEffects": false` keeps it. Rollup (Vite 7 and before) evaluates that chunk before the
   * others the module imports, react-dom's included; Rolldown (Vite 8) orders them itself. A server
   * build gets neither the import nor the chunk; an output that cannot be split keeps the import with
   * no chunk. A build in which no module has that path fails. Needs the runtime.
   */
  entry?: string;
}

/**
 * The Vite plugins for react-inp-blame: the runtime installed ahead of the app, and `displayName`
 * stamped on components so their names survive the production minifier.
 */
export function inpBlame(options?: InpBlameOptions): Plugin[];
