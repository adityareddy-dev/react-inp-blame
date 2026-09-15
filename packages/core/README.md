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

The design notes, the demos and the browser matrix are in the
[repository](https://github.com/adityareddy-dev/react-inp-blame#readme).

## Next.js

    // next.config.ts
    import { withInpBlame } from 'react-inp-blame/next';
    export default withInpBlame({ /* your config */ }, { enabled: true });

    // instrumentation-client.ts
    import 'react-inp-blame/auto';

`instrumentation-client.ts` runs before react-dom loads, which the library needs. `withInpBlame`
adds a loader, under Turbopack and webpack, that stamps `displayName` on components so their
names survive the production minifier. `enabled` decides which runs get it: `'development'`
(`next dev`, the default), `'production'` (`next build`), `true` for both, `false` for neither.
The import in `instrumentation-client.ts` is still yours, in every build that has it.

## Vite

    // src/main.tsx, as the first import: it has to run before react-dom
    import 'react-inp-blame/auto';

Component names in a production build need the same loader, as a plugin:

    // vite.config.ts
    import { defineConfig } from 'vite';
    import { stamp } from 'react-inp-blame/display-names-loader';

    export default defineConfig({
      plugins: [
        {
          name: 'display-names',
          enforce: 'post',
          transform(code, id) {
            const file = id.split('?')[0];
            if (/\.[jt]sx$/.test(file) && !file.includes('node_modules')) return { code: stamp(code), map: null };
          },
        },
      ],
    });

## API

    import { onInteraction } from 'react-inp-blame';

    onInteraction((report) => {
      const { blame, rating } = report.explanation; // data: kind, name, ms, confidence
      console.log(report.verdict);                  // display text, reworded in any version
    });

- `install(options?)` installs once per page and returns the API; every later call, from any copy
  of the package on the page, returns the same one. `react-inp-blame/auto` calls it on import.
  Options: `overlay`, `threshold` (40 ms), `labels` (`'auto'`), `hook` (`'auto'`), `sampleRate`
  (1), `walkBudget` (5000), `inputWindow` (1500 ms), `devtoolsTrack` (true), `debugGlobal`
  (`true` puts the API on `window.__REACT_INP_BLAME__`).
- `onInteraction(fn)` hears each report when it is published and each later revision of it, and
  returns the unsubscribe. It is the one way to hear reports; `install({ onReport })` is deprecated.
- The API: `reports()`, `last()`, `inp()` (the page's INP, estimated the way web-vitals does),
  `clear()`, `stats()` (the mode, why a page is unsupported, what the library has cost),
  `dispose()`, and `debug.commits()` and `debug.hook()`, which are for debugging and may change in
  any version.
- `mountOverlay(options?)` shows the on-page badge and panel; their code loads when shown.
- `fiberFromNode`, `ownerChain` and `handlerName` are the lookups reports are built from.

Reports are frozen and carry `schemaVersion: 1`. When a late Event Timing entry, a long animation
frame or a later render joins one, the next revision arrives as a new object with `revision`
bumped. `explanation.blame`, `rating`, the phases' milliseconds and the report's own numbers are
data; `verdict` and the other sentences are display text.

A report's `target.label` names the clicked element in at most 40 characters. Under a production
build of React it comes only from what the page's code wrote on the element: its aria-label, a
form field's placeholder, name or type, or its data-testid or data-test. The text an element
shows can be someone's name or email, and reports are made to be forwarded, so reading it is
opt-in there: `install({ labels: 'text' })`. Development builds read it by default.

## Size

Measured 2026-09-15 on 0.1.0 with rolldown 1.2.8, minified ESM, gzip at its default level:

| What | Minified | Gzip |
| --- | --- | --- |
| `react-inp-blame/auto`: everything that loads with the page | 31.8 KB | 12.0 KB |
| The badge and panel, a chunk loaded only when shown | 11.1 KB | 4.1 KB |
| What has to run before react-dom: the hook, the fiber reading, the observers | 9.3 KB | 4.0 KB |

Under the `react-server` condition, `react-inp-blame` and `react-inp-blame/auto` resolve to a
module whose exports do nothing, so a Server Component that imports them adds no browser code to
the server bundle.

MIT
