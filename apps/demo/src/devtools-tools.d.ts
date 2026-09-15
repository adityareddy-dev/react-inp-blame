// The parts of the two development tools that devtools-hook.tsx loads; neither package ships types.

declare module 'react-devtools-inline/backend' {
  /** Installs React DevTools' global hook on `target`, unless `target` already has one. */
  export function initialize(target: Window): void;
}

declare module 'react-refresh/runtime' {
  /** Wraps the global hook, creating a stub when there is none, so Fast Refresh sees every renderer and root. */
  export function injectIntoGlobalHook(target: Window): void;
  /** How many mounted roots Fast Refresh has seen commit. */
  export function _getMountedRootCount(): number;
}

interface Window {
  /** The Fast Refresh runtime the devtools-hook page injected, for the spec to ask what it saw. */
  __refreshRuntime?: typeof import('react-refresh/runtime');
  /** Unmounts the devtools-hook page's React root. */
  __unmountApp?: () => void;
}
