import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { displayNames } from './vite-plugin-display-names.ts';

const core = (f: string) => fileURLToPath(new URL(`../../packages/core/src/${f}`, import.meta.url));
const page = (f: string) => fileURLToPath(new URL(`./${f}`, import.meta.url));

export default defineConfig({
  plugins: [displayNames()],
  resolve: {
    alias: [
      { find: 'react-inp-blame/auto', replacement: core('auto.ts') },
      { find: /^react-inp-blame$/, replacement: core('index.ts') },
      // React 17 has no react-dom/client. The matrix script sets this for the 17 variant.
      ...(process.env.INP_REACT_LEGACY ? [{ find: 'react-dom/client', replacement: page('src/legacy-client.ts') }] : []),
    ],
  },
  // The devtools-hook page imports these only after the first request, which in development would
  // otherwise make Vite optimize them then and reload the page under the test.
  optimizeDeps: { include: ['react-devtools-inline/backend', 'react-refresh/runtime'] },
  // Vite 8 minifies with Oxc, which renames every function; keepNames-style flags do not
  // reach it. The displayNames plugin above is what keeps component names in production.
  build: {
    sourcemap: true,
    rolldownOptions: { input: { main: page('index.html'), 'devtools-hook': page('devtools-hook.html') } },
  },
});
