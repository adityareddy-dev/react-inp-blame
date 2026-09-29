// react-inp-blame is installed by a script the Vite plugin places ahead of this one (vite.config.ts),
// so React registers with its DevTools hook whatever this module imports first.
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './web-vitals-bridge';

// e2e/otel.spec.ts's page, and only that one: a chunk of its own, so every other page loads as it did.
if (new URLSearchParams(location.search).has('otel')) void import('./otel-bridge');

createRoot(document.getElementById('root')!).render(<App />);
