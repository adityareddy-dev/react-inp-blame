// astro.config.mjs
// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import { inpBlame } from 'react-inp-blame/astro';

// https://astro.build/config
export default defineConfig({
  integrations: [
    react(),
    inpBlame({
      enabled: true,                 // production builds too; the default is development only
      runtime: { overlay: 'query' }, // the badge only on request, such as ?inp-blame in the URL
    }),
  ],
});
