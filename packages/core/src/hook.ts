import { fiberFromNode, walkCommit } from './fiber.ts';
import type { CommitSummary, InputRecord } from './types.ts';

export interface HookState {
  mode: 'none' | 'shim' | 'chained';
  commits: CommitSummary[];
  renderers: number;
  walkTotalMs: number;
  walks: number;
}

const state: HookState = { mode: 'none', commits: [], renderers: 0, walkTotalMs: 0, walks: 0 };
let hookRef: any = null;
const MAX_COMMITS = 300;

// The events Event Timing gives an interactionId to. Derived events (input, change, keypress,
// submit) are dispatched inside one of these, so a commit during them is stamped with the
// newest ring entry, which is the key or pointer that caused them.
export const INPUT_TYPES = ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup'];
const RING_SIZE = 8;
const inputs: InputRecord[] = [];
// A press can be held this long and its release still counts as the same gesture.
const PRESS_WINDOW = 5000;

/** The last 8 inputs seen, oldest first. Live array, do not mutate. */
export function recentInputs(): InputRecord[] {
  return inputs;
}

/** Capture-phase listener for INPUT_TYPES: keeps the ring current. */
export function noteInput(e: Event): void {
  if (!e.isTrusted || INPUT_TYPES.indexOf(e.type) < 0) return;
  record(e);
}

function record(e: any): InputRecord {
  const isKey = e.type === 'keydown' || e.type === 'keyup';
  const rec: InputRecord = {
    ts: e.timeStamp,
    type: e.type,
    gestureTs: gestureOf(e, isKey),
    press: isKey ? e.code : e.pointerId,
    target: e.target,
    fiber: fiberFromNode(e.target),
  };
  inputs.push(rec);
  if (inputs.length > RING_SIZE) inputs.shift();
  return rec;
}

/** The pointerdown or keydown this event releases, by pointerId or key code; the newest press as a fallback. */
function gestureOf(e: any, isKey: boolean): number {
  if (e.type === 'pointerdown' || e.type === 'keydown') return e.timeStamp;
  const want = isKey ? 'keydown' : 'pointerdown';
  const press = isKey ? e.code : e.pointerId;
  let fallback = -1;
  for (let i = inputs.length - 1; i >= 0; i--) {
    const r = inputs[i];
    if (r.type !== want || e.timeStamp - r.ts > PRESS_WINDOW) continue;
    if (press !== undefined && r.press === press) return r.ts;
    if (fallback < 0) fallback = r.ts;
  }
  return fallback < 0 ? e.timeStamp : fallback;
}

/**
 * The input a commit belongs to. A sync commit runs inside the event's dispatch, so
 * `window.event` is that event and its `timeStamp` is exactly the Event Timing entry's
 * `startTime`. Anything else (a transition, an effect, data arriving) is stamped with the
 * newest input seen.
 */
function currentInput(): InputRecord | null {
  const ev: any = typeof window !== 'undefined' ? window.event : undefined;
  const last = inputs.length ? inputs[inputs.length - 1] : null;
  if (ev && ev.isTrusted && INPUT_TYPES.indexOf(ev.type) >= 0) return last && last.ts === ev.timeStamp ? last : record(ev);
  return last;
}

export function hookState(): HookState {
  // React injects into whichever hook object exists; read the live count off it.
  if (hookRef && hookRef.renderers && typeof hookRef.renderers.size === 'number') state.renderers = hookRef.renderers.size;
  return state;
}

/** Whether the hook was created here ('shim') or found already installed ('chained'), plus who else owns it. */
export function hookOwner(): string {
  if (!hookRef) return 'none';
  if (hookRef.reactInpAttribution) return 'react-inp-blame';
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
    const input = currentInput();
    // Outside an interaction window this is the whole cost: one subtraction.
    if (!input || now - input.ts > windowMs) return;
    const t0 = performance.now();
    const summary = walkCommit(root.current, budget, now, input);
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
