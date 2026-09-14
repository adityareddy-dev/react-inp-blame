// Side-effect entry: installs on import so the hook exists before react-dom evaluates.
// Options can be provided ahead of time on window.__REACT_INP_OPTIONS__.
import { install } from './index';

const w: any = typeof window !== 'undefined' ? window : undefined;
if (w) install(w.__REACT_INP_OPTIONS__ || {});
