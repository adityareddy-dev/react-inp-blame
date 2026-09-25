// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { inpBlame } from 'react-inp-blame/vite';

export default defineConfig({
  plugins: [
    react(),
    inpBlame({
      enabled: true,                 // production builds too; the default is development only
      runtime: { overlay: 'query' }, // the badge only on request, such as ?inp-blame in the URL
    }),
  ],
  build: {
    rollupOptions: {
      // Every dependency in one vendor chunk, react-dom and react-inp-blame included unless the plugin
      // keeps the library out of it. On Rollup with React 18 that used to evaluate react-dom first.
      output: { manualChunks: (id) => (id.includes('node_modules') ? 'vendor' : undefined) },
    },
  },
});
