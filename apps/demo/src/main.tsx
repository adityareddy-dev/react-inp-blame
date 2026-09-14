// This import has to come first: React registers with the DevTools hook while
// react-dom evaluates, and the hook must already exist by then.
import 'inpector/auto';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
