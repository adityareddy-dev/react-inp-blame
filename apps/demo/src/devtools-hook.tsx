// The page behind e2e/devtools-hook.spec.ts: React DevTools' own global hook and the Fast Refresh
// runtime (and react-dom itself, as `react`), each loaded before or after react-inp-blame in the order `?order=` lists, then React
// rendering the cascading-effect scenario. The imports are dynamic so that order holds and react-dom
// evaluates last, the way it does behind the browser extension or a dev server's refresh preamble.
import './styles.css';

const order = (new URLSearchParams(location.search).get('order') ?? 'library').split(',');
// `?widget` puts an app's own chat button in the bottom right corner, fixed, where the badge starts.
if (new URLSearchParams(location.search).has('widget')) {
  const chat = document.createElement('button');
  chat.dataset.test = 'chat';
  chat.textContent = 'Chat';
  chat.style.cssText = 'position: fixed; right: 16px; bottom: 16px; width: 56px; height: 56px; border-radius: 50%';
  chat.addEventListener('click', () => (chat.dataset.clicks = String(Number(chat.dataset.clicks ?? 0) + 1)));
  document.body.append(chat);
}
for (const step of order) {
  if (step === 'devtools') {
    // What the React DevTools extension runs at document start: the same installHook.
    const { initialize } = await import('react-devtools-inline/backend');
    initialize(window);
  } else if (step === 'refresh') {
    const refresh = await import('react-refresh/runtime');
    refresh.injectIntoGlobalHook(window);
    window.__refreshRuntime = refresh;
  } else if (step === 'library') {
    const { install } = await import('react-inp-blame');
    // `?badge` shows the badge and panel, for what they say when React cannot be read.
    install({ debugGlobal: true, devtoolsTrack: false, overlay: new URLSearchParams(location.search).has('badge') });
  } else if (step === 'react') {
    // react-dom loaded before the library, as when install() is not the first thing an app loads: it
    // looks for the hook once, as it loads, and finds none.
    await import('react-dom/client');
  }
}

// `?renderAfter=` holds React's first render back that many ms, so the badge is drawn before React is on the page.
const renderAfter = Number(new URLSearchParams(location.search).get('renderAfter') ?? 0);
if (renderAfter > 0) await new Promise((resolve) => setTimeout(resolve, renderAfter));
const [{ createRoot }, { CascadingEffect }] = await Promise.all([import('react-dom/client'), import('./scenarios/CascadingEffect')]);
if (new URLSearchParams(location.search).has('inp66')) {
  await runUnmountProbe(createRoot);
} else {
  const root = createRoot(document.getElementById('root')!);
  root.render(<CascadingEffect />);
  // Unmounting is one more commit, and each tool's record of mounted roots shows whether it heard it.
  window.__unmountApp = () => root.unmount();
}

/** Day-one feasibility fixture. Ground-truth markers are not available to the generic hook observer. */
async function runUnmountProbe(createRoot: typeof import('react-dom/client').createRoot): Promise<void> {
  const React = await import('react');
  const kind = new URLSearchParams(location.search).get('cleanup') ?? 'layout';
  if (!['layout', 'passive', 'control', 'survivor', 'passive-first', 'passive-second'].includes(kind)) throw new Error('Unknown cleanup probe');
  type Event = { sequence: number; kind: string; at: number; [key: string]: unknown };
  type Fiber = {
    type?: string | { name?: string; displayName?: string };
    return?: Fiber | null; child?: Fiber | null; sibling?: Fiber | null; deletions?: Fiber[] | null;
    actualDuration?: number; effectDuration?: number; passiveEffectDuration?: number; _debugOwner?: Fiber | null;
  };
  const events: Event[] = [];
  let overflow = false;
  const record = (eventKind: string, data: Record<string, unknown> = {}) => {
    if (events.length >= 2_000) { overflow = true; return; }
    events.push({ sequence: events.length + 1, kind: eventKind, at: performance.now(), ...data });
  };
  const name = (fiber?: Fiber | null): string | null =>
    typeof fiber?.type === 'string' ? fiber.type : fiber?.type?.displayName ?? fiber?.type?.name ?? null;
  const describe = (fiber: Fiber) => {
    const owners: string[] = [];
    for (let owner = fiber.return, depth = 0; owner && depth < 12; owner = owner.return, depth++) {
      const label = name(owner);
      if (label) owners.push(label);
    }
    return { name: name(fiber), owners, debugOwner: name(fiber._debugOwner), renderDuration: fiber.actualDuration ?? null, effectDuration: fiber.effectDuration ?? null, passiveEffectDuration: fiber.passiveEffectDuration ?? null };
  };
  const deletionEvidence = (current: Fiber) => {
    const pending: Fiber[] = [current];
    const deleted: ReturnType<typeof describe>[] = [];
    let visited = 0;
    while (pending.length && visited++ < 512) {
      const fiber = pending.pop()!;
      for (const deletion of fiber.deletions ?? []) deleted.push(describe(deletion));
      if (fiber.child) pending.push(fiber.child);
      if (fiber.sibling) pending.push(fiber.sibling);
    }
    return { deleted, traversalTruncated: pending.length > 0 };
  };
  const hook = (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: Record<string, any> }).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const previousUnmount = hook.onCommitFiberUnmount;
  hook.onCommitFiberUnmount = function (rendererId: number, fiber: Fiber): unknown {
    record('unmount_hook', { rendererId, ...describe(fiber) });
    const started = performance.now();
    const result = previousUnmount?.call(this, rendererId, fiber);
    record('unmount_hook_return', { name: name(fiber), delegateDuration: performance.now() - started });
    return result;
  };
  const previousCommit = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function (rendererId: number, root: { current: Fiber; effectDuration?: number; passiveEffectDuration?: number }, ...args: unknown[]): unknown {
    record('commit_hook', { rendererId, ...deletionEvidence(root.current), effectDuration: root.effectDuration ?? null, passiveEffectDuration: root.passiveEffectDuration ?? null });
    const result = previousCommit?.call(this, rendererId, root, ...args);
    record('commit_hook_return');
    return result;
  };
  const previousPostCommit = hook.onPostCommitFiberRoot;
  hook.onPostCommitFiberRoot = function (rendererId: number, root: { effectDuration?: number; passiveEffectDuration?: number }): unknown {
    record('post_commit_hook', { rendererId, effectDuration: root.effectDuration ?? null, passiveEffectDuration: root.passiveEffectDuration ?? null });
    return previousPostCommit?.call(this, rendererId, root);
  };
  const burn = (ms: number) => {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) { /* Controlled synchronous fixture work. */ }
  };
  const cleanup = (phase: 'layout' | 'passive', component = 'NamedCleanup') => {
    const costly = component === 'SecondCleanup'
      ? phase === 'passive' && kind === 'passive-second'
      : kind === phase || (phase === 'passive' && kind === 'passive-first');
    record('fixture_cleanup_start', { phase, component, requestedMs: costly ? 40 : 0 });
    burn(costly ? 40 : 0);
    record('fixture_cleanup_end', { phase, component });
  };
  const CheapLeaf = Object.assign(function CheapLeaf() { return <span>cheap</span>; }, { displayName: 'CheapLeaf' });
  const NamedCleanup = Object.assign(function NamedCleanup() {
    React.useLayoutEffect(() => () => cleanup('layout'), []);
    React.useEffect(() => () => cleanup('passive'), []);
    return <section>{Array.from({ length: 24 }, (_, index) => <CheapLeaf key={index} />)}</section>;
  }, { displayName: 'NamedCleanup' });
  const SecondCleanup = Object.assign(function SecondCleanup() {
    React.useEffect(() => () => cleanup('passive', 'SecondCleanup'), []);
    return <span>second cleanup</span>;
  }, { displayName: 'SecondCleanup' });
  const DeletedSubtree = Object.assign(function DeletedSubtree() { return <><NamedCleanup /><SecondCleanup /></>; }, { displayName: 'DeletedSubtree' });
  const SurvivingSibling = Object.assign(function SurvivingSibling({ tick }: { tick: number }) {
    record('fixture_render_start', { component: 'SurvivingSibling', requestedMs: tick && kind === 'survivor' ? 40 : 0 });
    burn(tick && kind === 'survivor' ? 40 : 0);
    record('fixture_render_end', { component: 'SurvivingSibling' });
    return <p data-test="surviving-sibling">{tick}</p>;
  }, { displayName: 'SurvivingSibling' });
  const DeletionOwner = Object.assign(function DeletionOwner() {
    const [visible, setVisible] = React.useState(true);
    return <main>
      <button data-test="probe-delete" disabled={!visible} onClick={() => { record('fixture_action'); setVisible(false); }}>Delete named subtree</button>
      {visible && <DeletedSubtree />}
      <SurvivingSibling tick={visible ? 0 : 1} />
    </main>;
  }, { displayName: 'DeletionOwner' });
  (window as unknown as { __inp66Probe: unknown }).__inp66Probe = {
    schema: 'inp66-hook-probe/v1', reactVersion: React.version, kind, events,
    snapshot: () => ({ schema: 'inp66-hook-probe/v1', reactVersion: React.version, kind, overflow, events: [...events],
      hookOnly: events.filter((event) => event.kind.includes('hook')),
      groundTruth: events.filter((event) => event.kind.startsWith('fixture_')) }),
  };
  createRoot(document.getElementById('root')!).render(<DeletionOwner />);
}
