// The page behind e2e/devtools-hook.spec.ts: React DevTools' own global hook and the Fast Refresh
// runtime (and react-dom itself, as `react`), each loaded before or after react-inp-blame in the order `?order=` lists, then React
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
const root = createRoot(document.getElementById('root')!);
root.render(<CascadingEffect />);
// Unmounting is one more commit, and each tool's record of mounted roots shows whether it heard it.
window.__unmountApp = () => root.unmount();
