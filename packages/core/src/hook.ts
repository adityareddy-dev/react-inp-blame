import { walkCommit } from './fiber';
import type { CommitSummary } from './types';

export interface HookState {
  mode: 'none' | 'shim' | 'chained';
  commits: CommitSummary[];
  renderers: number;
  walkTotalMs: number;
  walks: number;
}

const state: HookState = { mode: 'none', commits: [], renderers: 0, walkTotalMs: 0, walks: 0 };
let hookRef: any = null;
let lastInputAt = -1e9;
const MAX_COMMITS = 300;

export function noteInput(): void {
  lastInputAt = performance.now();
}

export function hookState(): HookState {
  // React injects into whichever hook object exists; read the live count off it.
  if (hookRef && hookRef.renderers && typeof hookRef.renderers.size === 'number') state.renderers = hookRef.renderers.size;
  return state;
}

/** Whether the hook was created here ('shim') or found already installed ('chained'), plus who else owns it. */
export function hookOwner(): string {
  if (!hookRef) return 'none';
  if (hookRef.reactInpAttribution) return 'inpector';
  const keys = Object.keys(hookRef);
  return keys.length ? `existing hook (${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', ...' : ''})` : 'existing hook';
}

/**
 * React tells the DevTools hook about every commit, in production builds too, but only
 * if the hook exists before react-dom evaluates. So this either creates a minimal hook or
 * chains onto the real React DevTools one.
 */
export function installHook(budget: number, windowMs: number, onSummary?: (c: CommitSummary) => void): void {
  if (state.mode !== 'none') return;
  const w = window as any;

  const onCommit = (id: number, root: any): void => {
    const now = performance.now();
    const sinceInput = now - lastInputAt;
    // Outside an interaction window this is the whole cost: one subtraction.
    if (sinceInput > windowMs) return;
    const t0 = performance.now();
    const summary = walkCommit(root.current, budget, now, sinceInput);
    summary.walkMs = performance.now() - t0;
    state.walkTotalMs += summary.walkMs;
    state.walks++;
    if (state.commits.length >= MAX_COMMITS) state.commits.shift();
    state.commits.push(summary);
    if (onSummary) onSummary(summary);
  };

  const existing = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (existing) {
    const prev = existing.onCommitFiberRoot;
    existing.onCommitFiberRoot = function (this: any, id: number, root: any, ...rest: any[]) {
      try {
        onCommit(id, root);
      } catch {
        // never let attribution break React
      }
      return typeof prev === 'function' ? prev.call(this, id, root, ...rest) : undefined;
    };
    hookRef = existing;
    state.mode = 'chained';
    return;
  }

  const renderers = new Map<number, any>();
  let nextId = 0;
  const hook = {
    renderers,
    supportsFiber: true,
    inject(renderer: any) {
      const id = ++nextId;
      renderers.set(id, renderer);
      state.renderers = renderers.size;
      return id;
    },
    checkDCE() {},
    onCommitFiberRoot(id: number, root: any) {
      try {
        onCommit(id, root);
      } catch {
        // never let attribution break React
      }
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    setStrictMode() {},
    on() {},
    off() {},
    emit() {},
    sub() {
      return () => {};
    },
    reactInpAttribution: true,
  };
  Object.defineProperty(w, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
    value: hook,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  hookRef = hook;
  state.mode = 'shim';
}
