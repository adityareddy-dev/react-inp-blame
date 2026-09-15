// The page behind e2e/devtools-hook.spec.ts: React DevTools' own global hook and the Fast Refresh
// runtime, each loaded before or after react-inp-blame in the order `?order=` lists, then React
// rendering the cascading-effect scenario. The imports are dynamic so that order holds and react-dom
// evaluates last, the way it does behind the browser extension or a dev server's refresh preamble.
import './styles.css';

const order = (new URLSearchParams(location.search).get('order') ?? 'library').split(',');
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
    install({ debugGlobal: true, devtoolsTrack: false });
  }
}

const [{ createRoot }, { CascadingEffect }] = await Promise.all([import('react-dom/client'), import('./scenarios/CascadingEffect')]);
const root = createRoot(document.getElementById('root')!);
root.render(<CascadingEffect />);
// Unmounting is one more commit, and each tool's record of mounted roots shows whether it heard it.
window.__unmountApp = () => root.unmount();
