// Side-effect entry: installs with the default options on import, so the hook exists before react-dom
// evaluates when this is the first import of the entry module. For options, call install() instead, or
// let react-inp-blame/vite or react-inp-blame/next install ahead of the app.
import { install } from './index.js';

install();
