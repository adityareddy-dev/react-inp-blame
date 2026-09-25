// vite.config.ts, the README's with debugGlobal on, so the specs can read the reports.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { inpBlame } from 'react-inp-blame/vite';

export default defineConfig({
  plugins: [
    react(),
    inpBlame({
      enabled: true,
      runtime: { overlay: 'query', debugGlobal: true },
    }),
  ],
});
