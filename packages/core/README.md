# react-inp-blame

Names the React component behind a slow interaction. It joins the browser's Event Timing and Long
Animation Frames entries to React's fiber tree, and says where the time went:

    408 ms click on button "Log in" in SignInPage. The click handler handleLogin ran for
    about 402 ms; React's own render took under 1 ms. A second React render landed 285 ms
    after the screen updated: 84 ms re-rendering 256 components inside ProfilePage, mostly
    PhotoTile (240 of them, 73 ms). INP doesn't count it, but people still wait for it.

No dependencies. React 17 to 19 (react-dom). Browsers with Event Timing's `interactionId`
(Chrome 96, Firefox 144, Safari 26.2); only Chromium has Long Animation Frames. Anywhere else
`install()` installs nothing, and `stats()` says why.

    npm install react-inp-blame

The design notes, the demos and the browser matrix are in the
[repository](https://github.com/adityareddy-dev/react-inp-blame#readme).

## Next.js

    // next.config.ts
    import { withInpBlame } from 'react-inp-blame/next';
    export default withInpBlame({ /* your config */ });

That is the whole setup, on Next.js 16.3 or later. `withInpBlame` adds `react-inp-blame/next-client`
to `instrumentationClientInject`, so Next.js installs the library before hydration, which the
library needs, and a loader, under Turbopack and webpack, that stamps `displayName` on components
so their names survive the production minifier. `enabled` decides which runs get both:
`'development'` (`next dev`, the default), `'production'` (`next build`), `true` for both, `false`
for neither; a run it leaves out gets the config back untouched. `runtime` takes the options for
`install()`, such as `{ overlay: 'query' }`. They reach the browser inlined through `env`, so they
are plain data. `runtime: false` leaves the client module out, for an app that installs from its own
`instrumentation-client.ts`; the navigation join below goes with it, since the client module is what
hears navigations.

On the App Router the client module also hears each navigation: every report carries
`navigationURL` and `navigationType`, a click that started a navigation names it in
`startedNavigation`, and `inp()` starts over at each soft navigation. The Pages Router loads the injected
module too (read in Next.js 16.3.5's source, not tested), so it gets attribution without the navigation
join.

## Vite

    // vite.config.ts
    import { defineConfig } from 'vite';
    import { inpBlame } from 'react-inp-blame/vite';

    export default defineConfig({ plugins: [inpBlame()] });

`inpBlame` returns two plugins. One adds a module script ahead of the page's own that calls
`install()`, so React registers with the library's hook whatever the entry module imports first;
the other stamps `displayName` on the app's components. `enabled` and `runtime` work as they do for
Next.js, with `'development'` meaning the dev server and `'production'` meaning `vite build`, and
`pages` picks the HTML pages that get the script.

Anywhere else, make `import 'react-inp-blame/auto'` the first import of the entry module: it
installs with the default options before react-dom loads.

## API

    import { onInteraction } from 'react-inp-blame';

    onInteraction((report) => {
      const { blame, rating } = report.explanation;                // data: kind, name, ms, confidence
      console.log(blame.kind, blame.name, rating, report.verdict); // the verdict is display text, reworded in any version
    });

- `install(options?)` installs once per page and returns the API; every later call, from any copy
  of the package on the page, returns the same one. `react-inp-blame/auto` calls it on import, and
  the Vite plugins and the Next.js wrapper call it with their `runtime` options.
  Options: `overlay`, `threshold` (40 ms), `labels` (`'auto'`), `hook` (`'auto'`), `sampleRate`
  (1), `walkBudget` (5000), `inputWindow` (1500 ms), `devtoolsTrack` (true), `debugGlobal`
  (`true` puts the API on `window.__REACT_INP_BLAME__`).
- `onInteraction(fn)` hears each report, and each later revision of it, in a task after the one that
  published it, and returns the unsubscribe. It is the one way to hear reports. A panel that renders
  what it hears is safe: the update your listener makes while it runs is never read as part of an
  interaction. One it schedules for later, with setTimeout or an await, is an ordinary render.
- The API: `reports()`, `last()`, `inp()` (the INP of the navigation the page is on, estimated the
  way web-vitals does, chosen again when the page is hidden; it starts over at each soft navigation
  and each restore from the back/forward cache), `clear()`, `stats()` (the mode, why a page is
  unsupported, what the library has cost), `dispose()`, and `debug.commits()` and `debug.hook()`,
  which are for debugging and may change in any version.
- `mountOverlay(options?)` shows the on-page badge and panel; their code loads when shown.
- `fiberFromNode`, `ownerChain` and `handlerName` are the lookups reports are built from.

Reports are frozen and carry `schemaVersion: 1`. When a late Event Timing entry, a long animation
frame or a later render joins one, the next revision arrives as a new object with `revision`
bumped. `explanation.blame`, `rating`, the phases' milliseconds and the report's own numbers are
data; `verdict` and the other sentences are display text. `navigationURL` and `navigationType` say
which page the interaction happened on, with web-vitals' names and values, and `startedNavigation`
names the soft navigation it started, if it started one.

A report's `target.label` names the clicked element by its tag and a name of at most 40 characters. Under
a production build of React it comes only from what the page's code wrote on the element: its aria-label, a
form field's placeholder, name or type, or its data-testid or data-test. The text an element
shows can be someone's name or email, and reports are made to be forwarded, so reading it is
opt-in there: `install({ labels: 'text' })`. Development builds read it by default.

## Size

Measured 2026-09-15 with rolldown 1.2.8, minified ESM for the browser, gzip at its default level:

| What | Minified | Gzip |
| --- | --- | --- |
| `react-inp-blame/auto`: everything that loads with the page | 39.0 KB | 14.4 KB |
| The badge and panel, a chunk loaded only when shown | 11.2 KB | 4.2 KB |
| Of that, the part that has to run before react-dom, not a separate entry yet: the hook, the fiber reading, the observers | 14.5 KB | 5.8 KB |

Under the `react-server` condition, `react-inp-blame`, `react-inp-blame/auto` and
`react-inp-blame/next-client` resolve to a module whose exports do nothing, so a Server Component
that imports them adds no browser code to the server bundle.

MIT
