# react-inp-blame

When a click, tap or key press in your React app is slow, this names the component or the handler
behind it and says where the time went.

![The demo's sign-in page: a click on Log in, the badge showing the page's INP, the panel opening, and one row expanding into the explanation](https://raw.githubusercontent.com/adityareddy-dev/react-inp-blame/main/docs/media/overlay.gif)

**[Try the demo](https://adityareddy-dev.github.io/react-inp-blame/)**. Every scenario there is slow
on purpose. Click something and read what the badge blames.

    npm install react-inp-blame

## Start with Next.js 16.3 or later

    // next.config.ts
    import { withInpBlame } from 'react-inp-blame/next';

    // Your config first, this library's options second. They are not Next.js config keys.
    export default withInpBlame({ /* your config */ }, { runtime: { overlay: true } });

## Start with Vite

    // vite.config.ts
    import { defineConfig } from 'vite';
    import react from '@vitejs/plugin-react';
    import { inpBlame } from 'react-inp-blame/vite';

    export default defineConfig({ plugins: [react(), inpBlame({ runtime: { overlay: true } })] });

**What you will see.** Reload, then click something slow. A small dark badge appears in the corner,
bottom-right by default, with the page's INP so far in milliseconds: green at 200 or under, amber up
to 500, red above. INP, Interaction to Next Paint, is the Core Web Vital for responsiveness: how long
a click, tap or key press took to reach the next frame drawn, at the page's slowest. Click the badge
for a panel of the recent slow interactions, newest first, and click a row for the whole explanation.
The demo above sets `position: 'bottom-left'`, which is why its badge sits on the left: its own
explanation column has the right-hand side. From the demo's sign-in page, in development:

    408 ms click on button "Log in" in SignInPage. The click handler handleLogin ran for
    about 402 ms; React's own render took under 1 ms. A second React render landed 285 ms
    after the screen updated: 84 ms re-rendering 256 components inside ProfilePage, mostly
    PhotoTile (240 of them, 73 ms). INP doesn't count it, but people still wait for it.

`overlay` takes `true` (always shown), `'query'` (shown only when the URL has `?inp-blame` or
`#inp-blame`, or `localStorage` has `react-inp-blame` set to `overlay`, which is how to open it on a
production page) or `{ position, open, max }`. Both snippets above are development-only: `enabled`
defaults to `'development'`, so a production build carries nothing from either plugin until you say
`enabled: true` or `enabled: 'production'`.

The design notes, the demos and the browser matrix are in the
[repository](https://github.com/adityareddy-dev/react-inp-blame#readme).

# Reference

No dependencies. React 17 to 19 (react-dom). Browsers with Event Timing's `interactionId`
(Chrome 96, Firefox 144, Safari 26.2); only Chromium has Long Animation Frames, the API that says
which scripts ran in a slow frame and how much layout they forced. Anywhere else `install()` installs
nothing, and `stats()` says why.

## Next.js

    // next.config.ts
    import { withInpBlame } from 'react-inp-blame/next';
    export default withInpBlame({ /* your config */ }, { enabled: true, runtime: { overlay: 'query' } });

That is the whole setup, on Next.js 16.3 or later. The Next.js config is the first argument and this
library's options are the second; passing the options first throws, because Next.js has no `enabled`
or `runtime` config key and would drop them without installing anything.
`withInpBlame` adds `react-inp-blame/next-client`
to `instrumentationClientInject`, so Next.js installs the library before hydration, which the
library needs, and a loader, under Turbopack and webpack, that stamps `displayName` on components
so their names survive the production minifier. The stamp is a guarded assignment after the module's
code, which costs a module its tree shaking in some bundlers: a component nobody imported is kept,
because the assignment names it and a bundler cannot always prove a property store is safe to drop.
Measured on seven exports with two imported, Rollup drops the unused ones and esbuild keeps them;
terser and SWC keep whatever the bundler handed them. Leave `enabled` at `'development'` to keep the names out of the production build entirely. `enabled` decides which runs get both:
`'development'` (`next dev`, the default), `'production'` (`next build`), `true` for both, `false`
for neither; a run it leaves out gets the config back untouched. `runtime` defaults to `true`, which
is `install()` with its default options; it also takes those options, such as `{ overlay: 'query' }`.
They reach the browser inlined through `env`, so they are plain data. `runtime: false` leaves the
client module out, for an app that installs from its own `instrumentation-client.ts`; the navigation
join below goes with it, since the client module is what hears navigations.

On the App Router the client module also hears each navigation, meaning each route change the
framework makes in the page with no new document: every report carries
`navigationURL` and `navigationType`, a click that started a navigation names it in
`startedNavigation`, and `inp()` starts over at each soft navigation. The Pages Router loads the injected
module too (read in Next.js 16.3.5's source, not tested), so it gets attribution without the navigation
join.

## Vite

    // vite.config.ts
    import { defineConfig } from 'vite';
    import react from '@vitejs/plugin-react';
    import { inpBlame } from 'react-inp-blame/vite';

    export default defineConfig({ plugins: [react(), inpBlame({ enabled: true, runtime: { overlay: 'query' } })] });

`inpBlame` takes one argument, its own options, and returns an array of plugins. Those for the runtime
add a module script ahead of the page's own that calls `install()`, so React registers with the
library's hook whatever the entry module imports first; in most builds the call gets a chunk of its
own, which a separate script tag loads. The last one stamps `displayName` on the app's components,
and is all that `runtime: false` leaves. They go beside the React plugin, not instead of it.
`enabled` and `runtime` work as they do for Next.js, with `'development'` meaning the dev server and
`'production'` meaning `vite build`, and `pages` picks the HTML pages that get the script.

The plugin cannot fix a `manualChunks` rule sending all of `node_modules` to one vendor chunk. The
rule puts this library in that chunk with react-dom, and the install script's import of the chunk
can then evaluate react-dom before `install()` runs; nothing the plugin can reach decides that
order. Keep react-inp-blame out of the rule, or give it a chunk of its own, whatever the Vite
version. A rule sending only react and react-dom to `vendor` is fine. Seen failing on Vite 5.4.21,
6.4.3 and 7.3.6, built with React 17 and a default import of react-dom. On 8.3.0 the same build
came out right, but that was the bundler's doing.

A build with no HTML page, as under Laravel, Rails, Django or any backend that writes the page from
`manifest.json`, gives the plugin nowhere to put its script, so it installs nothing, on the dev
server or in a build, and says nothing about it. Keep the plugin for names with
`inpBlame({ runtime: false })`, and give the install an entry of its own that each page loads first:
a file such as `inp-blame.ts` holding `import 'react-inp-blame/auto'` or the app's own `install()`
call. List it first in the build's inputs (`build.rollupOptions.input`, or the backend plugin's,
such as `laravel({ input: [...] })`) and first in the page, as
`@vite(['resources/js/inp-blame.ts', 'resources/js/app.tsx'])` does. Module scripts run in document
order, which is what the plugin's own script relies on. `enabled` then decides only where names are
stamped: that entry installs in every run that loads it. A first import inside the app's own entry is
not enough once a second entry shares react-dom with it. Keep react-inp-blame out of a `node_modules`
vendor rule there too, because that entry imports the vendor chunk as the plugin's script would.
None of this has been tried on a real backend yet. React Router 7 and Remix in framework mode,
TanStack Start and Astro render their own HTML too, and have no setup yet: the plugin most likely
installs nothing there either, and nothing says so. Not tried yet.

Without the Vite plugin or the Next.js wrapper, make `import 'react-inp-blame/auto'` the first
import of the entry module: it installs with the default options before react-dom loads. Under
webpack or Rspack that holds even with a `splitChunks` vendor chunk, because they run a module when
it is first required, not when its chunk loads (not tried with either). With another bundler it is
the right shape in a production build but not a guarantee, because a bundler may put react-dom in a
chunk that evaluates before the entry's body does, and React looks for the hook only while it
evaluates. Two builds where that happens are a second HTML page sharing a chunk with the first, and a
`manualChunks` rule sending `node_modules` to a vendor chunk. The Vite plugin and the Next.js wrapper
put the install in a file the page loads before its own. That settles the shared chunk, though not
the vendor rule, as above. With any other bundler, check `stats().mode` and `debug.hook().renderers`
in a built page once.

For component names in a production build, `react-inp-blame/display-names-loader` is a webpack-style
loader with a `stamp(code)` export. It is written for the source before Babel or TypeScript compiles
it, so under webpack or Rspack give it `enforce: 'pre'`, as `withInpBlame` does:

    // webpack.config.js or rspack.config.js, in module.rules
    { test: /\.[jt]sx$/, exclude: /node_modules/, enforce: 'pre', use: ['react-inp-blame/display-names-loader'] }

## With web-vitals

`react-inp-blame/web-vitals` gives the web-vitals package React component names, in one option. It
imports nothing from web-vitals, and `generateTarget` needs no `install()`: it only reads the fiber
React leaves on the node.

    import { onINP } from 'web-vitals/attribution';
    import { generateTarget } from 'react-inp-blame/web-vitals';

    onINP(send, { generateTarget });
    // attribution.interactionTarget: 'ProfilePage > PhotoTile (button.tile)'

Next.js reports the build without attribution, so there the React side is added to the metric:

    'use client';
    import { useReportWebVitals } from 'next/web-vitals';
    import { attributeINP } from 'react-inp-blame/web-vitals';

    export function WebVitals() {
      useReportWebVitals((metric) => {
        send(metric.name === 'INP' ? { ...metric, attribution: attributeINP(metric) } : metric);
      });
      return null;
    }

The component path goes into `attribution.interactionTarget`, where web-vitals otherwise puts a CSS
selector, so it shows up wherever that field is already collected. A path names at most four
components, and they are the four nearest the element, so a deep tree loses the page and the layout
rather than the component that renders what was clicked. `generateTarget` returns `undefined` when the
node has no React fiber or no named component above it, which is web-vitals' signal to fall back to
its own selector, and it never throws. `attributeINP(metric)` returns the
metric's attribution (`{}` where there is none) with a frozen `react` field added, from this
library's report for that interaction: the blame with its confidence, the handler, the hot path, the
heaviest commit's components, and what React rendered before and after the paint. It is `null` when
nothing is installed and when there is no report for that interaction, one that stayed under
`threshold` or one already pushed out of the 50 a page keeps; it never guesses, and a metric it cannot
read gives `react: null` rather than throwing in the callback. web-vitals keeps
which interaction is INP, the percentile, the back/forward cache and soft navigations.

In production the component names need the `displayName` transform above; without it the minifier
has renamed them and the path reads `a > b (button.tile)`.

## API

    // Any module the browser runs: instrumentation-client.ts on Next.js, the entry module on Vite
    import { onInteraction } from 'react-inp-blame';

    // Hears a report again, revision one higher, each time later data joins it: key on report.interactionId
    onInteraction((report) => {
      const { blame, rating } = report.explanation;                // data: kind, name, ms, confidence
      console.log(blame.kind, blame.name, rating, report.verdict); // the verdict is display text, reworded in any version
    });

- `install(options?)` installs once per page and returns the API; every later call, from any copy
  of the package on the page, returns the same one. `react-inp-blame/auto` calls it on import, and
  the Vite plugins and the Next.js wrapper call it with their `runtime` options.
  Options: `overlay` (false), `threshold` (40 ms), `labels` (`'auto'`), `hook` (`'auto'`),
  `sampleRate` (1), `walkBudget` (5000 component fibers per commit, so one huge render cannot cost
  more than that), `inputWindow` (1500 ms), `devtoolsTrack` (true), `debugGlobal` (false; set it to
  `true` to put the API on `window.__REACT_INP_BLAME__`, or to a string to name the property).
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
- `fiberFromNode`, `ownerChain` and `handlerName` are the lookups reports are built from. They read
  React's fiber tree, the internal tree React keeps of the rendered components, through the hook
  React exposes for developer tools.

`target.handler` is the name of the function on the element's event prop, or the prop's own name when
that function has no name worth printing. An inline `onClick={() => ...}` therefore reads as
`onClick`, and so does a handler the minifier renamed: name the function if you want the report to
name it.

Reports are frozen and carry `schemaVersion: 1`. When a late Event Timing entry, a long animation
frame or a later render joins one, the next revision arrives as a new object with `revision`
bumped. `explanation.blame`, `rating`, the phases' milliseconds and the report's own numbers are
data; `verdict` and the other sentences are display text. `navigationURL` and `navigationType` say
which page the interaction happened on, with web-vitals' names and values, and `startedNavigation`
names the soft navigation it started, if it started one.

A report's `target.label` names the clicked element, or the control it sits in, by its tag and a name of
at most 40 characters. A control is a button, link, summary, label or form field, or an element with a
control's ARIA role such as `button`, `link` or `tab`, within five ancestors of the click, so a click on
the `path` of an icon button is labelled by the button; `target.selector` stays the element the click
landed on. Under a production build of React the name comes only from what the page's code wrote on the
element it names: its aria-label, a form field's placeholder, name or type, or its data-testid or
data-test. The text an element shows can be someone's name or email, and reports are made to be
forwarded, so reading it is opt-in there: `install({ labels: 'text' })`. Development builds read it by
default.

## Clicks that land before hydration

Every App Router page is server-rendered, so a click can land on HTML React has not hydrated yet. The
browser reports a slow click, React DevTools shows nothing, and the element has no fiber to be named
after. When the library can see which piece of server-rendered HTML the click landed on,
`report.hydration` says so and which of the two things happened:

```ts
hydration: { kind: 'waited' | 'not-hydrated'; scope: 'root' | 'boundary';
             owner: string | null; ms: number | null } | null
```

**React hydrated it inside the click** (`kind: 'waited'`). On React 18 and 19 a discrete event that lands
on a boundary waiting to hydrate makes React hydrate that boundary synchronously, inside the event's own
dispatch, before the event reaches any handler. That wait is working time, and the report names it:

> 264 ms click on button "Add to cart". The click landed on server-rendered HTML that had not been
> hydrated yet, so React hydrated the Suspense boundary in ProductPage first: 208 ms of the 236 ms of
> working time.

`blame.kind` is then `'hydration'` and `blame.name` is the boundary. The hydrating time is a named part of
the `Working` phase (`phases[1].parts`), not a fourth phase beside it, so the three phases go on adding up
to the interaction. A hydration too small to be the story keeps `report.hydration` and its place in the
phase bar but leaves the blame where it belongs, with a note beside it: 8 ms of hydrating in front of a
400 ms handler is not why the click was slow. Under 5 ms, where React's own render is too small for this
library to call it the story at all, only `report.hydration` and the note say it happened.

**It was still waiting** (`kind: 'not-hydrated'`). React 18 and 19 stop the propagation of a discrete event
they could not unblock instead of dispatching it, so no React handler runs. Almost no working time goes by,
so the blame stays on where the time actually went, and the hydration leads the sentence:

> This click landed on server-rendered HTML that React had not hydrated yet, so React did not dispatch it
> and no React handler ran for it. The click waited 380 ms before its handler could start: the main thread
> was busy with something else.

A Suspense boundary has no name of its own, so `owner` is the nearest component holding it; write that
boundary inside a client component if you want a name you recognise. `scope: 'root'` is a whole root that
had not hydrated, which has no component above it and reads as "the page".

**What it does not say.** A click that lands before `hydrateRoot` has run at all: nothing on the page
carries a mark of React yet, so there is nothing to read and `report.hydration` is `null`. A boundary React gave up on and rendered on the client instead, where the
server HTML the click landed on was thrown away: that is not a hydration and is not reported as one.
Whether the element had a handler at all, which is why the sentence says no React handler ran rather than
that a click was lost.

In a production build React records no render durations, so `ms` is `null`: which boundary hydrated, and
how many components it took, are measured; how long it took is not. `next build --profile` gives the
durations back. React 17 is left out altogether: it has no dehydrated Suspense state, and the one hydration
flag it keeps is cleared before it calls the hook, so nothing there is ever reported as a hydration.

## Size

Measured 2026-09-15 with rolldown 1.2.8, minified ESM for the browser, gzip at its default level:

| What | Minified | Gzip |
| --- | --- | --- |
| `react-inp-blame/auto`: everything that loads with the page | 39.0 KB | 14.4 KB |
| The badge and panel, a chunk loaded only when shown | 11.2 KB | 4.2 KB |
| Of that, the part that has to run before react-dom, not a separate entry yet: the hook, the fiber reading, the observers | 14.5 KB | 5.8 KB |

`react-inp-blame/web-vitals` on its own is 2.7 KB minified, 1.3 KB gzipped, measured 2026-09-19 with
the same rolldown settings but by a different script, which read `/auto` at 38.2 / 14.1 that day
against the 39.0 / 14.4 above. It pulls in none of the hook, the observers or the badge: an app that
only wants component names in its web-vitals attribution pays for the fiber reading and nothing else.

Under the `react-server` condition, `react-inp-blame`, `react-inp-blame/auto`,
`react-inp-blame/next-client` and `react-inp-blame/web-vitals` resolve to a module whose exports do
nothing, so a Server Component that imports them adds no browser code to the server bundle.

MIT
