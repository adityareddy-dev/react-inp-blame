// The landing page: plain HTML, one stylesheet pair and one small script, served at the domain root.
// `npm run build:site` builds it to apps/site/dist. `npm run build:demo` then builds the interactive demo
// into apps/site/dist/demo, so the demo is served at /demo/.
export default {
  base: '/',
  publicDir: 'public',
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
};
