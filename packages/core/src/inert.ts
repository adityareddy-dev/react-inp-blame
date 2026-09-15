import type { Api, Stats, UnsupportedReason } from './types.js';

export interface InertOptions {
  unsupportedReason?: UnsupportedReason;
  /** Time spent in install() so far, read at each `stats()` call. */
  installMs?: () => number;
  dispose?: () => void;
}

/**
 * An API with nothing behind it, for a page where nothing was installed: on the server, in a
 * browser without Event Timing, on a page the sample left out. `stats()` still says which.
 */
export function inertApi(mode: Exclude<Stats['mode'], 'shim' | 'chained'>, options: InertOptions = {}): Api {
  const { unsupportedReason = null, installMs = () => 0, dispose = () => {} } = options;
  return {
    reports: () => [],
    last: () => null,
    inp: () => null,
    clear: () => {},
    onInteraction: () => () => {},
    stats: () => ({ mode, unsupportedReason, walks: 0, walkTotalMs: 0, reportTotalMs: 0, installMs: installMs() }),
    debug: {
      commits: () => [],
      hook: () => ({ owner: 'none', renderers: [], devtoolsLockedOut: false }),
    },
    dispose,
  };
}
