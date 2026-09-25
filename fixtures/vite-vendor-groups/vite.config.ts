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
    rolldownOptions: {
      output: {
        // Every dependency in one vendor chunk, react-dom, Radix's Portal and react-inp-blame included unless
        // the plugin keeps the library out of it. The Portal imports react-dom, so the vendor chunk runs
        // react-dom as it loads, which on React 18 used to be before the install.
        codeSplitting: { groups: [{ name: 'vendor', test: /node_modules/ }] },
      },
    },
  },
});
