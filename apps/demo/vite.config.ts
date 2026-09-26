import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { inpBlame } from 'react-inp-blame/vite';

const core = (f: string) => fileURLToPath(new URL(`../../packages/core/src/${f}`, import.meta.url));
const page = (f: string) => fileURLToPath(new URL(`./${f}`, import.meta.url));

// Only the build that goes to GitHub Pages, which .github/workflows/pages.yml sets this for. A stranger
// arriving there has no README beside the page, so the header says what the library does, where it lives
// and how to install it, that the delays are put there on purpose, and that nothing typed into the page
// leaves it. Off everywhere else, so the specs and the dev server see the demo unchanged.
const hostedHeader = {
  name: 'react-inp-blame-demo:hosted-header',
  apply: 'build' as const,
  // The demo builds two pages, and devtools-hook.html has a `<div id="root">` of its own. Only the
  // page a visitor lands on gets the header.
  transformIndexHtml: (html: string, ctx: { path: string }) =>
    process.env.INP_DEMO_HOSTED !== '1' || ctx.path !== '/index.html'
      ? html
      : html.replace(
          '<div id="root"></div>',
          `<header class="hosted-header">
      <p><b>react-inp-blame</b> names the React component or handler behind a slow click, tap or key press.
        <span><a href="https://github.com/adityareddy-dev/react-inp-blame">GitHub</a> <code>npm i react-inp-blame</code></span></p>
      <p>Everything here is slow on purpose, so click something and read what the badge in the corner blames.
        Nothing you type on this page leaves it: the sign-in is simulated and sends no request.</p>
    </header>
    <div id="root"></div>`,
        ),
};

export default defineConfig({
  plugins: [
    inpBlame({
      // The specs check attribution and component names in production builds too; by default only the dev server gets either.
      enabled: true,
      // The badge sits bottom-left, because the demo's own "What took time" column is on the right.
      // Everything else is left at its default, so the specs check what a user gets.
      runtime: { overlay: { position: 'bottom-left' }, debugGlobal: true },
      // devtools-hook.html loads the library itself, before or after React DevTools and Fast Refresh.
      pages: (path) => path !== '/devtools-hook.html',
    }),
    hostedHeader,
  ],
  resolve: {
    alias: [
      // The app imports the library from source, so a change needs no build; the plugins above come from the package.
      { find: /^react-inp-blame$/, replacement: core('index.ts') },
      { find: /^react-inp-blame\/web-vitals$/, replacement: core('web-vitals.ts') },
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
