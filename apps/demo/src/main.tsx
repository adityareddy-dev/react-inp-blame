// This import has to come first: React registers with the DevTools hook while
// react-dom evaluates, and the hook must already exist by then.
import 'react-inp-blame/auto';
import { mountOverlay } from 'react-inp-blame';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// The badge and panel every app gets. Bottom-left here, because the demo's own
// "What took time" column already sits on the right.
mountOverlay({ position: 'bottom-left' });
createRoot(document.getElementById('root')!).render(<App />);
