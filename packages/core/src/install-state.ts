import type { OverlayHandle } from './overlay.js';
import { shared } from './session.js';
import type { Api, InstallOptions, InteractionReport } from './types.js';

/**
 * The one installation a page has, in its own module so that an entry which only reads reports
 * (`react-inp-blame/web-vitals`) can find it without pulling in the hook, the observers, the report
 * lifecycle or the overlay. `session.ts` says why it lives on `globalThis` rather than in a module
 * variable: whichever copy of the library installs, every copy finds the same one.
 */

export type Listener = (report: InteractionReport) => void;

export interface Installation {
  api: Api;
  /** Applies what a later install() call can still change while installed: `overlay`. */
  reapply(opts: InstallOptions): void;
}

export interface InstallState {
  installed: Installation | null;
  /** The API of a page that lost the `sampleRate` roll. Later calls get it back rather than rolling again, which would raise the share. */
  sampledOut: Api | null;
  /** Everyone hearing reports. */
  listeners: Set<Listener>;
  /** The badge and panel, from the moment they are asked for: their code arrives by dynamic import. */
  overlay: Promise<OverlayHandle | null> | null;
  installMs: number;
}

export const page = shared<InstallState>('install', () => ({ installed: null, sampledOut: null, listeners: new Set(), overlay: null, installMs: 0 }));
