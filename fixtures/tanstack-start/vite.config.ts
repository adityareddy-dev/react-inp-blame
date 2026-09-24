// vite.config.ts
import { defineConfig } from 'vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import { inpBlame } from 'react-inp-blame/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    tanstackStart(),
    viteReact(),
    // Component names that survive the minifier. The install is src/inp-blame.ts, since TanStack Start
    // writes its own HTML and the plugin's script has no page to go in.
    inpBlame({ enabled: true, runtime: false }), // production builds too; the default is development only
  ],
})

export default config
