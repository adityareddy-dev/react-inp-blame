import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { inpBlame } from 'react-inp-blame/vite';

const core = (f: string) => fileURLToPath(new URL(`../../packages/core/src/${f}`, import.meta.url));
const page = (f: string) => fileURLToPath(new URL(`./${f}`, import.meta.url));

export default defineConfig({
  plugins: [
    inpBlame({
      // The specs check attribution and component names in production builds too; by default only the dev server gets either.
      enabled: true,
      // The badge sits bottom-left, because the demo's own "What took time" column is on the right.
      runtime: { overlay: { position: 'bottom-left' }, walkBudget: 100000, debugGlobal: true },
      // devtools-hook.html loads the library itself, before or after React DevTools and Fast Refresh.
      pages: (path) => path !== '/devtools-hook.html',
    }),
  ],
  resolve: {
    alias: [
      // The app imports the library from source, so a change needs no build; the plugins above come from the package.
      { find: /^react-inp-blame$/, replacement: core('index.ts') },
      // React 17 has no react-dom/client. The matrix script sets this for the 17 variant.
      ...(process.env.INP_REACT_LEGACY ? [{ find: 'react-dom/client', replacement: page('src/legacy-client.ts') }] : []),
    ],
  },
  // The devtools-hook page imports these only after the first request, which in development would
  // otherwise make Vite optimize them then and reload the page under the test.
  optimizeDeps: { include: ['react-devtools-inline/backend', 'react-refresh/runtime'] },
  // Vite 8 minifies with Oxc, which renames every function; keepNames-style flags do not
  // reach it. The displayName transform in inpBlame is what keeps component names in production.
  build: {
    sourcemap: true,
    rolldownOptions: { input: { main: page('index.html'), 'devtools-hook': page('devtools-hook.html') } },
  },
});
