/**
 * What `react-inp-blame`, `react-inp-blame/auto` and `react-inp-blame/next-client` resolve to under
 * the `react-server` export condition, which bundlers set for the React Server Components graph. A
 * server component has no page to measure, so every export does nothing, and none of the browser code
 * reaches the server bundle. The types stay those of the browser entries.
 */
import { inertApi } from './inert.js';
import type { Api } from './types.js';

const api: Api = inertApi('none');

export function install(): Api {
  return api;
}

export function mountOverlay(): Promise<null> {
  return Promise.resolve(null);
}

export function onInteraction(): () => void {
  return () => {};
}

export function fiberFromNode(): null {
  return null;
}

export function ownerChain(): string[] {
  return [];
}

export function handlerName(): null {
  return null;
}

export function onRouterTransitionStart(): void {}
