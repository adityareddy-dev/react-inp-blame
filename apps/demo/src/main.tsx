// react-inp-blame is installed by a script the Vite plugin places ahead of this one (vite.config.ts),
// so React registers with its DevTools hook whatever this module imports first.
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './web-vitals-bridge';

createRoot(document.getElementById('root')!).render(<App />);
