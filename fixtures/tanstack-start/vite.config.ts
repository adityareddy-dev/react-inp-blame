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
    inpBlame({
      enabled: true,                 // production builds too; the default is development only
      runtime: { overlay: 'query' }, // the badge only on request, such as ?inp-blame in the URL
      entry: 'src/client.tsx',       // TanStack Start writes its own HTML, so the install goes first in the client entry
    }),
  ],
})

export default config
