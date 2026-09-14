import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { displayNames } from './vite-plugin-display-names.ts';

const core = (f: string) => fileURLToPath(new URL(`../../packages/core/src/${f}`, import.meta.url));

export default defineConfig({
  plugins: [displayNames()],
  resolve: {
    alias: [
      { find: 'inpector/auto', replacement: core('auto.ts') },
      { find: /^inpector$/, replacement: core('index.ts') },
      // React 17 has no react-dom/client. The matrix script sets this for the 17 variant.
      ...(process.env.INP_REACT_LEGACY ? [{ find: 'react-dom/client', replacement: fileURLToPath(new URL('./src/legacy-client.ts', import.meta.url)) }] : []),
    ],
  },
  // Vite 8 minifies with Oxc, which renames every function; keepNames-style flags do not
  // reach it. The displayNames plugin above is what keeps component names in production.
  build: { sourcemap: true },
});
