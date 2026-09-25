# react-inp-blame

When a click, tap or key press in your React app is slow, this names the component or the handler behind
it and says where the time went.

![The demo's sign-in page: a click on Log in, the badge showing the page's INP, the panel opening, and one row expanding into the explanation](docs/media/overlay.gif)

**[Try the demo](https://adityareddy-dev.github.io/react-inp-blame/)**. Every scenario there is slow on
purpose. Click something and read what the badge blames.

    npm install react-inp-blame

## Start with Next.js 15.3 or later

```ts
// next.config.ts
import { withInpBlame } from 'react-inp-blame/next';

// Your config first, this library's options second. They are not Next.js config keys.
export default withInpBlame({ /* your config */ }, { runtime: { overlay: true } });
```

On Next.js 15.3 to 16.2, add one line to `instrumentation-client.ts` as well. `withInpBlame` prints it
until the file has it:

```ts
// instrumentation-client.ts
export { onRouterTransitionStart } from 'react-inp-blame/next-client';
```

## Start with Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { inpBlame } from 'react-inp-blame/vite';

export default defineConfig({ plugins: [react(), inpBlame({ runtime: { overlay: true } })] });
```

React Router in framework mode, Remix, TanStack Start and Astro write their own HTML, which this plugin
never sees on its own, so each has a setup of its own: [React Router](#install-with-react-router),
[Remix](#install-with-remix), [TanStack Start](#install-with-tanstack-start), [Astro](#install-with-astro).

**What you will see.** Reload, then click something slow. A small dark badge appears in the corner,
bottom-right by default, with the page's INP so far in milliseconds: green at 200 or under, amber up to
500, red above. Click the badge for a panel of the recent slow interactions, newest first, and click a
row for the whole explanation. The demo above sets `position: 'bottom-left'`, which is why its badge
sits on the left: its own explanation column has the right-hand side. From the demo's sign-in page,
in development, this is `report.verdict`, which the row spreads over its header and body:

    408 ms click on button "Log in" in SignInPage. The click handler handleLogin ran for
    about 402 ms; React's own render took under 1 ms. A second React render landed 285 ms
    after the screen updated: 84 ms re-rendering 256 components inside ProfilePage, mostly
    PhotoTile (240 of them, 73 ms). INP doesn't count it, but people still wait for it.

`overlay` takes `true` (always shown), `'query'` (shown only when the URL has `?inp-blame` or
`#inp-blame`, or `localStorage` has `react-inp-blame` set to `overlay`, which is how to open it on a
production page) or `{ position, open, max }`. Both snippets above are development-only: `enabled`
defaults to `'development'`, so a production build carries nothing from either plugin until you say
`enabled: true` or `enabled: 'production'`. The one exception is the line on Next.js 15.3 to 16.2: its code
is in every build, and in the ones `enabled` leaves out it ships unused and installs nothing.

If you would rather read reports than look at a badge, drop `overlay` and subscribe:

```ts
// Next.js: instrumentation-client.ts or any client module. Vite: the entry module.
import { onInteraction } from 'react-inp-blame';

// A report can come again as a later revision when more data joins it: keep the latest per interactionId.
onInteraction((report) => console.log(report.verdict, report.explanation.blame));
```

## When the blame is wrong

If a report names the wrong component or handler, or a slow interaction gets no report at all, please open
an issue with the [wrong or missing blame form](https://github.com/adityareddy-dev/react-inp-blame/issues/new?template=wrong-or-missing-blame.yml).
The report itself is what makes it diagnosable. Add `debugGlobal: true` to `runtime` (or to `install()`) and
run `JSON.stringify(__REACT_INP_BLAME__.last(), null, 2)` in the console right after the slow interaction, or
print `JSON.stringify(report)` from `onInteraction`; with no report, paste `stats()` instead. What the badge
shows is a good start, but the JSON has everything its sentence was built from.

The form also asks for the versions of react-inp-blame, react and react-dom, and Next.js or Vite, the bundler,
whether it was a development or a production build, and the browser. Each changes what a report can say: a
production build of React records no render times, and only Chromium has Long Animation Frames. A report
carries the page's URL and the label of the element you clicked, so read it through before you paste it.

---

# Reference

Terms this page uses: **INP** (Interaction to Next Paint) is the Core Web Vital for responsiveness: how
long a click, tap or key press took to reach the next frame drawn, at the page's slowest, with the worst
few left out once a page has had many. **Event
Timing** is the browser API INP is built on. **Long Animation Frames** is a second, Chromium-only API that
says which scripts ran in a slow frame and how much layout they forced. React's **fiber tree** is the
internal tree React keeps of your rendered components; the library reads it through the hook React
exposes for developer tools. A **soft navigation** is a route change the framework makes in the page,
with no new document.

## Install with Next.js 15.3 or later

`withInpBlame(nextConfig, options)`: your Next.js config first, this library's options second. Passing the
options as the first argument throws, because Next.js has no `enabled` or `runtime` config key and would
silently drop them.

```ts
// next.config.ts
import { withInpBlame } from 'react-inp-blame/next';
export default withInpBlame({ /* your config */ }, {
  enabled: true,                 // production builds too; the default is development only
  runtime: { overlay: 'query' }, // the badge only on request, such as ?inp-blame in the URL
});
```

`withInpBlame` appends `react-inp-blame/next-client` to `instrumentationClientInject`, which Next.js imports
before `instrumentation-client` and before hydration, and adds a loader, under Turbopack and webpack, that
stamps `displayName` on the components in your `.tsx` and `.jsx` files so their names survive minification.

Next.js added `instrumentationClientInject` in 16.3. From 15.3 to 16.2 the wrapper adds the loader and your
options, and the install is one line in your own `instrumentation-client.ts`, beside `next.config` or in
`src/`: `export { onRouterTransitionStart } from 'react-inp-blame/next-client';`. Next.js imports that file
before hydration, which is early enough, and the wrapper prints the line in the runs `enabled` covers
(`next dev` by default) until the file has it. The module the line loads installs with the options given to
the wrapper, and installs nothing in a build `enabled` leaves out or with `runtime: false`, though its code
still ships there. After an upgrade to 16.3, delete the line: kept, it goes on doing the install and the wrapper
injects no second copy, but production builds keep carrying its code. If the file already exports an
`onRouterTransitionStart`, as Sentry's setup has it do, call this library's from yours instead:

```ts
// instrumentation-client.ts
import { onRouterTransitionStart as inpBlame } from 'react-inp-blame/next-client';

export const onRouterTransitionStart: typeof inpBlame = (url, navigationType, event) => {
  inpBlame(url, navigationType, event);
  Sentry.captureRouterTransitionStart(url, navigationType);
};
```

TypeScript finds the types of `react-inp-blame/next` and `react-inp-blame/next-client` under
`moduleResolution` `bundler` (the one `create-next-app` sets), `node16` and `nodenext`, which read the
package's `exports`, and under `node` (`node10`), which ignores `exports` and reads its `typesVersions`
instead. Whether they then pass depends on `module`. `module` `node16` and `node18`, and `nodenext` before
TypeScript 5.8, stand for a Node that cannot `require()` an ES module, so in an app whose `package.json` has
no `"type": "module"` the `next-client` import gives TS1479. `nodenext` from 5.8 and `node20` from 5.9 pass.
The same settings, in any app, find an error inside the `/next` types, which take `InstallOptions` from the
package's ES-module types, so there `/next` also needs `skipLibCheck: true`, as `create-next-app` sets it.
Before 16.0 a Turbopack rule takes no `condition`, so
on 15.x the loader's rule keeps to the browser build and out of `node_modules` through builtin conditions
instead, `experimental.turbo` rules and loaders carry over, and a rule of your own on `*.{tsx,jsx}` is
left as it is, with a warning, since 15.x takes one rule there. Below 15.3 there is no `instrumentation-client`
and nothing can load the library ahead of React: the wrapper warns and hands your config back as it was. CI runs
the Next.js suites on 16.2.12, 15.5.26 and 15.3.9 with the line, under both bundlers.

**`enabled` defaults to `'development'`: a production build gets neither the runtime nor the component
names unless you pass `enabled: true` or `enabled: 'production'`.**

| `enabled` | `'development'` (default) | `'production'` | `true` | `false` |
| --- | --- | --- | --- | --- |
| Runs that get the runtime and the loader | `next dev` | `next build` and `next start` | both | none: the config comes back untouched |

`runtime` defaults to `true`, which is [`install()`](#installoptions) with its defaults. It also takes the
options for `install()`, inlined through `env` and so plain data, or `false` for the loader alone. On the
App Router, reports follow soft navigations in `navigationURL` and `navigationType`, name the one a click
started in `startedNavigation`, and the INP estimate starts over at each. The Pages Router loads the injected
module too (read in Next.js 16.3.5's source, not tested), so it gets attribution without navigations.

## Install with Vite

```ts
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
});
```

`inpBlame()` takes one argument, its own options, and returns an array of plugins, which goes in `plugins` as
it is. It holds the install, a module script at the top of each HTML page that calls `install()`, so React
registers with the library's hook whatever your entry imports first (in a build the call usually gets a chunk
and a script tag of its own), and the `displayName` transform, which is all that `runtime: false` leaves. Add
it beside your React plugin, not instead of it.
`enabled` defaults to `'development'` here too (the dev server; `'production'` is `vite build`, `true` both,
`false` adds no plugins), `runtime` is as for Next.js, and `pages(path)` picks the pages that get the script.
`entry`, a module's path from the project root, is for a framework that writes its own HTML: that module gets
the install as its first import instead, as the React Router, Remix and TanStack Start setups below show.

**A vendor chunk rule.** A `manualChunks` rule sending all of `node_modules` to one vendor chunk used to put
this library in that chunk with react-dom, so the install script's import of the chunk ran react-dom before
`install()` (seen on Vite 5.4.21, 6.4.3 and 7.3.6 with React 17, and on 7.3.6 with React 18). When
`manualChunks` is a function the plugin now takes the library out of it into a chunk of its own, and your
function keeps deciding every other module. CI builds that on Vite 7.3 with React 18.3 and a rule sending all
of `node_modules` to `vendor`. A `manualChunks` object and a Vite 8 `codeSplitting` group are left as they
are, so there, keep react-inp-blame out of the rule. With `@vitejs/plugin-legacy` the install stays in the
page's own script, and a vendor rule that takes react-dom breaks it whatever it does with the library, so
keep react-dom out of that rule too (`!id.includes('/react-dom/')`). The build warns, naming both chunks and
the module, when the install's chunk imports one that connects react-dom to React's DevTools hook as it
loads: one that imports `react-dom/client`, or with React 17 or 18 `react-dom` itself, such as a component
library's portal in the same vendor chunk, or on Vite 5, whose bundler leaves react-dom's body where it is,
the chunk that holds react-dom. On Vite 6 and later a chunk that only holds react-dom is fine, since
react-dom runs where it is first imported.

**No HTML page in the build** (Laravel, Rails, Django, or any backend that writes the page from
`manifest.json`). The plugin has no page to put its script in, so it installs nothing, on the dev server or
in a build; when every input the build lists is a script, it warns that it will not. `entry`, naming the
script every page loads first, puts the install first in it as it does for the frameworks below (not tried on
a real backend yet). Or keep the plugin for names with `inpBlame({ runtime: false })`, and give the
install an entry of its own that each page loads first: a file such as `inp-blame.ts` holding
`import 'react-inp-blame/auto'` or your own `install()` call. List it first in the build's inputs
(`build.rollupOptions.input`, or your backend plugin's, such as `laravel({ input: [...] })`) and first in the
page, as `@vite(['resources/js/inp-blame.ts', 'resources/js/app.tsx'])` does. Module scripts run in document
order, which is what the plugin's own script relies on. `enabled` then decides only where names are stamped:
that entry installs in every run that loads it. A first import inside the app's own entry is not enough once
a second entry shares react-dom with it. Keep react-inp-blame out of a `node_modules` vendor rule there too,
because that entry imports the vendor chunk as the plugin's script would. None of this has been tried on a
real backend yet.

**webpack or Rspack.** Make `import 'react-inp-blame/auto'` the first import of your entry module. That holds
even with a `splitChunks` vendor chunk, because these bundlers run a module when it is first required, not
when its chunk loads (not tried with either). For names, add this rule to `module.rules`:
`{ test: /\.[jt]sx$/, exclude: /node_modules/, enforce: 'pre', use: ['react-inp-blame/display-names-loader'] }`.
`enforce: 'pre'` is what matters, as it is in the Next.js wrapper. The loader reads your source as text, so
after babel-loader or ts-loader it drops their source map, and where they compile down to ES5 (Babel 7's
preset-env with no targets, for one) it finds `var Foo = function…` where you wrote `const Foo = () =>` and
names none of those components.

With another bundler, make that import the first import of your entry module; for names, the loader's
`stamp(code)` export does the same work. A first import is not a guarantee there in a production build,
though: a bundler may put react-dom in a chunk that evaluates before your entry's body does, and React looks
for the hook only while it evaluates. Two builds where that happens are a second HTML page sharing a chunk
with the first, and a `manualChunks` rule sending `node_modules` to a vendor chunk. On Vite and Next.js use
the plugin and the wrapper, which put the install in a file the page loads before its own. That settles the
shared chunk, though not the vendor rule, as above. Anywhere else, check `stats().mode` and
`debug.hook().renderers` in a built page once.

## Install with React Router

In framework mode React Router writes the page itself, so the Vite plugin has no HTML page to put its script
in. Give it `entry` instead: the module that gets the install as its first import. `app/root.tsx` is the one
to name, because React Router loads the root route before any other route and before its client entry.

```ts
// vite.config.ts
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { inpBlame } from "react-inp-blame/vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    reactRouter(),
    inpBlame({
      enabled: true,                 // production builds too; the default is development only
      runtime: { overlay: "query" }, // the badge only on request, such as ?inp-blame in the URL
      entry: "app/root.tsx",         // React Router writes its own HTML, so the install goes first in the root route
    }),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
```

That is the whole setup: the plugin adds the import to the browser's copy of the module (never the server's),
and nothing in your own files changes. Leave `entry` out and the plugin warns, when the dev server starts and
when the app builds, that nothing will install and what to add; name a file that does not exist and both stop
with an error naming the path. An import you write yourself first in the root route, or in the client
entry, is not the same thing. On React 18, `react-dom` connects to React's DevTools hook as it loads, and a
route, or a library a route uses, can load it before the client entry does. In a production build, a chunk a
module imports is evaluated before the module's own body, so an install written in the root route runs after
the shared chunk that holds react-dom whenever the root route imports anything that reaches react-dom. And an
app whose `package.json` says `"sideEffects": false`, as Remix's template does, loses an import with no names
from the build altogether. With `entry` the install is a chunk of its own, marked as having side effects, and
the import is added after the JSX is compiled, so that in the module it comes before the one the compiler adds
for `react/jsx-runtime`. Rollup, which builds for Vite 7 and before, evaluates a module's chunk
imports in the order the module has them, so there the install runs before react-dom in all three cases.
Rolldown, which builds for Vite 8, orders a chunk's imports itself. The apps CI builds on Vite 8 come out right,
React Router 7 on React 18 among them, but that is Rolldown's doing rather than a promise, so check
`stats().mode` and `debug.hook().renderers` in a built page once. On React 19 it matters less: only
`react-dom/client` connects to the hook, and only the client entry imports it. A server build gets neither
the import nor the chunk. An output that cannot be split into chunks (one that inlines its dynamic imports,
keeps every module as its own file, or is an `iife` or `umd` script) keeps the import but gets no chunk of its
own, so there the install runs wherever the bundler puts it. A build in which no module has that path fails,
rather than shipping without the install. The chunk comes from `manualChunks`: the install and everything it
imports always go in it, so a rule of your own that sends `node_modules` to a vendor chunk cannot put the
library beside react-dom, and your `manualChunks` function keeps deciding every other module. Under Rollup
that keeps the install first; under Rolldown the module can still import the vendor chunk before it. A
`manualChunks` object, or Rolldown's own chunk groups, cannot be added to, so the plugin warns and leaves them
be, and the install may then run late in a build. `entry` needs the runtime, so it cannot go with
`runtime: false`.

CI builds this from `npx create-react-router@8.4.0` (React Router 8.4, Vite 8.3, React 19.3), and from
`npx create-react-router@7.18.4` moved to React 18.3 with a route that calls `flushSync` from react-dom, and
checks that a click is blamed on the component that rendered slowly, under `react-router dev` and on a
production build served by `react-router-serve`. React Router 8 needs React 19.2.7 or later. In
`vite.config.ts` only the `inpBlame` lines are the library's; `resolve.tsconfigPaths` is the template's, and
needs Vite 8.

## Install with Remix

Remix 2 writes its own HTML too, and takes the same `entry`. On the React 18 its template brings, the root
route is where it has to go: `@remix-run/react` imports `react-router-dom`, which imports `react-dom`.

```ts
// vite.config.ts
import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { inpBlame } from "react-inp-blame/vite";

declare module "@remix-run/node" {
  interface Future {
    v3_singleFetch: true;
  }
}

export default defineConfig({
  plugins: [
    remix({
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_singleFetch: true,
        v3_lazyRouteDiscovery: true,
      },
    }),
    tsconfigPaths(),
    inpBlame({
      enabled: true,                 // production builds too; the default is development only
      runtime: { overlay: "query" }, // the badge only on request, such as ?inp-blame in the URL
      entry: "app/root.tsx",         // Remix writes its own HTML, so the install goes first in the root route
    }),
  ],
});
```

Without `entry`, both ways of writing the install yourself fail in Remix's template: in the client entry it is
too late for the root route's react-dom, and first in `app/root.tsx` it works on the dev server but is dropped
from a production build, where `"sideEffects": false` shakes it out, and where the root route's chunk would
run react-dom first anyway. Remix 2 builds with Vite 5 or 6, so with `entry` the order holds there. CI builds
this from `npx create-remix@2.17.5` (Remix 2.17, Vite 6.4, React 18.3), with a route that imports a `Link` from
`@remix-run/react`, which puts react and react-dom in one shared chunk, and checks the same click under
`remix vite:dev` and on a production build served by `remix-serve`.

## Install with TanStack Start

TanStack Start writes its own HTML too. Its `entry` is the client entry, `src/client.tsx`, which you create
if the app has none yet: TanStack Start's own default is the code below. That entry imports `react-dom/client`
before it imports the router, so it, not a route, is where the install goes first.

```tsx
// src/client.tsx, TanStack Start's default client entry
import { StrictMode, startTransition } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { StartClient } from '@tanstack/react-start/client'

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  )
})
```

```ts
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
```

CI builds this from `npx @tanstack/cli@0.71.0 create --framework React --blank` (TanStack Start 1.168, Vite
8.3, React 19.3) and checks the same click under `vite dev` and on `vite preview` of the production build.

## Install with Astro

Astro writes its own pages too, and has a place for code that has to run before React does: a script
every island imports, and waits for, before it loads its component and its renderer. The integration puts
`install()` there, so it runs before `@astrojs/react` loads react-dom, and adds the `displayName` transform.

```js
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
```

`inpBlame()` from `react-inp-blame/astro` takes `enabled` and `runtime` as the Vite plugin does, with
`'development'` meaning `astro dev` and `'production'` meaning `astro build`. It has no `pages`: every page's
islands go through the same script. List it after `react()`, as above, which is the order CI runs: on the dev
server `react()` puts its Fast Refresh preamble in the same script, and the library then chains onto the hook
the preamble makes. The install runs as soon as the page's first island has been parsed, whatever its
`client:` directive, so it is in place before any island hydrates, and a page with no island loads neither
React nor the library. React itself may load much later, when a `client:visible` island scrolls into view, or
never, on a page whose islands are all another framework's; the library warns that it was installed too late
only where React has rendered without registering with it. The order holds for islands: a `<script>` of your
own in an `.astro` file that imports react-dom is outside it. CI builds this from Astro's minimal template
(`npm create astro@5.2.4 -- --template minimal`, then `npx astro add react`: Astro 7.3, Vite 8.3, React 19.3)
with a page of two islands, one `client:load` and one `client:idle`, and a page whose one island is
`client:visible` below the fold. It checks that a click is blamed on the component that rendered slowly, and
that the second page gets no warning before or after its island hydrates, under `astro dev` and on
`astro preview` of the build.

## With web-vitals

`react-inp-blame/web-vitals` gives the [web-vitals](https://github.com/GoogleChrome/web-vitals) package
React component names, in one option. It imports nothing from web-vitals, and `generateTarget` works with
no `install()` at all: it only reads the fiber React leaves on the node. `generateTarget` needs
web-vitals 5.1 or later: 5.0 types the option as always returning a string, and puts an `undefined` in
`interactionTarget` rather than falling back to its own selector.

```ts
import { onINP } from 'web-vitals/attribution';
import { generateTarget } from 'react-inp-blame/web-vitals';

onINP(send, { generateTarget });
// attribution.interactionTarget: 'ProfilePage > PhotoTile (button.tile)'
```

```tsx
'use client'; // Next.js: useReportWebVitals reports the build without attribution, so add the React side
import { useReportWebVitals } from 'next/web-vitals';
import { attributeINP } from 'react-inp-blame/web-vitals';

export function WebVitals() {
  useReportWebVitals((metric) => {
    send(metric.name === 'INP' ? { ...metric, attribution: attributeINP(metric) } : metric);
  });
  return null;
}
```

The component path goes into `attribution.interactionTarget`, where web-vitals otherwise puts a CSS
selector, so it shows up wherever that field is already collected and charted, with nothing to change
downstream. A path names at most four components, the four nearest the element whose names a reader could
search their code for (a minifier's `Xe` or a styling library's `styled.div` gives way to the next one out,
unless the chain has nothing better), starting for a clicked icon from what the icon belongs to, as reports do. So in a
deep tree it starts below the page and the layout rather than ending short of the component that renders
what was clicked. `generateTarget` returns `undefined` when the node has no React fiber or no named component
above it, which is web-vitals' signal to fall back to its own selector, and it never throws.

`attributeINP(metric)` returns the metric's attribution (`{}` where there is none, as under
`useReportWebVitals`) with a `react` field added: `{ schemaVersion, interactionId, blame, handler,
hotPath, components, commits, followUps }`, frozen, from this library's own report for that interaction.
It is `null` when nothing is installed on the page, and when there is no report for the interaction:
one that stayed under `threshold` and set off no later render, or one already pushed out of the 50
reports a page keeps. It never guesses, and like `generateTarget` it never throws: a metric it cannot
read gives `react: null` rather than an exception inside your analytics callback. web-vitals keeps
everything else it owns: which interaction is
the page's INP, at what percentile, over the back/forward cache and soft navigations.

Component names in production need the `displayName` transform (the Next.js wrapper, the Vite plugin or
the loader, all above). Without it the minifier has renamed them and the path reads `a > b (button.tile)`.

### Sending it to Sentry

Sentry records INP on its own, as a span, but that span carries no interaction id, so nothing ties this
library's report to it. A metric does the job instead, from web-vitals, with the blame in attributes Sentry
can search on. web-vitals reports INP the first time the page is hidden, and again, higher, each later time
it is hidden after a slower interaction. A distribution can't take a value back, so the recipe sends the
first report for each `metric.id`: one per page view, with a restore from the back/forward cache counting as
a new one, and a slower interaction after the user comes back to the tab left out. Metrics need Sentry 10.25
or later, where they are on by default, and `@sentry/react` and `@sentry/nextjs` export the same `metrics`.

```ts
import * as Sentry from '@sentry/browser'; // or @sentry/react, @sentry/nextjs
import { onINP } from 'web-vitals/attribution';
import { attributeINP, generateTarget } from 'react-inp-blame/web-vitals';

const sent = new Set<string>();
onINP((metric) => {
  if (sent.has(metric.id)) return; // the same page view, reported again as it was hidden again
  sent.add(metric.id);
  const { interactionTarget, react } = attributeINP(metric);
  Sentry.metrics.distribution('inp', metric.value, {
    unit: 'millisecond',
    attributes: {
      rating: metric.rating,
      target: interactionTarget,                    // 'ProfilePage > PhotoTile (button.tile)'
      'blame.kind': react?.blame.kind,              // 'render', 'handler', 'layout', 'waiting', ...
      'blame.name': react?.blame.name ?? undefined, // Sentry sends a null as the string "null"
      'blame.confidence': react?.blame.confidence,  // 'measured' or 'inferred'
    },
  });
}, { generateTarget });
```

### Sending it to Google Analytics 4

This is web-vitals' own [example for Google Analytics](https://github.com/GoogleChrome/web-vitals#send-attribution-data),
`debug_target` and all, with the blame in two more parameters. `navigationURL` came in web-vitals 6, so on
5.x leave out `page_location`:

```ts
import { onINP } from 'web-vitals/attribution';
import { attributeINP, generateTarget } from 'react-inp-blame/web-vitals';

onINP((metric) => {
  const { interactionTarget, react } = attributeINP(metric);
  // gtag() is the global the Google tag defines, typed by @types/gtag.js
  gtag('event', metric.name, {
    value: metric.delta, // delta, so the values can be summed
    metric_id: metric.id,
    metric_value: metric.value,
    metric_delta: metric.delta,
    page_location: metric.navigationURL,
    debug_target: interactionTarget, // 'ProfilePage > PhotoTile (button.tile)'
    debug_blame_kind: react?.blame.kind,
    debug_blame_name: react?.blame.name ?? undefined,
  });
}, { generateTarget });
```

GA4 reports show a parameter only once it is registered as an event-scoped custom dimension, and GA4 takes at
most 100 characters of a parameter's value, where `generateTarget` allows 120, so a long path can lose its end.

On Next.js, the body of either `onINP` callback goes in the `useReportWebVitals` one above, for
`metric.name === 'INP'`, with the Sentry one's `sent` at the top of that module. That metric comes from the
build without attribution, so `interactionTarget` is undefined there, and so is `navigationURL`.

Neither recipe sends a label or a sentence. `attributeINP` holds component, handler and script names, and
`generateTarget` an element's tag, id and test id or classes, but a report's `target.label`, `verdict` and
other sentences can hold text the page shows: under `labels: 'text'`, and by default in a development build
(see [Labels and personal data](#labels-and-personal-data)). If you forward those as well, install with
`labels: 'attributes'`, so a label comes only from what your code wrote on the element. `navigationURL`,
sent above as `page_location`, keeps its query string. So can `blame.name`: when a script takes the blame it
can be the script's URL, or the page's for an inline script, as the browser reports it.

## The badge and panel

`overlay: true`, in `runtime` or `install()`, shows a corner badge with the page's INP so far, green, amber or
red. Click it for the recent slow interactions, newest first, each with what to blame and a bar split into
waiting, working and updating the screen; a row opens into the full explanation and the components that
rendered before and after the paint. `overlay: 'query'` shows it only when the URL has `?inp-blame` or
`#inp-blame`, or `localStorage` has `react-inp-blame` set to `overlay`: that is how to open it on a production
page. `{ position, open, max }` sets the corner, whether the panel starts open and how many rows it keeps
(20). It is plain DOM in a shadow root, so it never causes a React render, and its code is a chunk loaded
after `install()` returns, only when shown. `mountOverlay(options)` shows it after an `/auto` import. The shadow
root is an open one on `#react-inp-blame`, but a test that wants the reports should read them through
[`debugGlobal`](#installoptions) rather than from the panel's DOM, which may change between versions.

**Content Security Policy.** The badge and panel need `'unsafe-inline'` in `style-src`, with no nonce or
hash beside it: a browser ignores `'unsafe-inline'` in a directive that also lists a nonce or a hash. They
style their shadow root with a `<style>` element that carries no nonce, and set `style` attributes (dot
colours, bar widths) through `innerHTML` with values that change with every report, so a `style-src` of
nonces and hashes blocks them: the badge is then an unstyled button at the foot of the page, and the
console reports the violation. The runtime still installs and measures, so on such a page read reports with
`onInteraction` or the Performance panel track. On Vite, `html.cspNonce` puts the nonce on the plugin's
script in development and in a build, and the badge's chunk loads through that script's import, so a
nonce-based `script-src` needs nothing more.

## API

```ts
import { onInteraction } from 'react-inp-blame';
// explanation.blame and explanation.rating are data; verdict is display text.
const stop = onInteraction((report) => console.log(report.explanation.blame, report.verdict));
```

`onInteraction(fn)` is the one way to hear reports: `fn` gets each report, and every later revision of it,
in a task after the one that published it, and the call returns the unsubscribe. A panel that renders what
it hears is safe, because the update a listener makes while it runs is never read as part of an
interaction. An update it schedules for later, with setTimeout or an await, is an ordinary render. The
package's types document every field.

### install(options)

It has to run before react-dom loads, which the plugins and `/auto` see to, and it installs once per page. A
later call, from any copy of the package, returns the same API and applies `overlay`; other options keep
their first value, with a warning, until `dispose()`.

| Option | Default | |
| --- | --- | --- |
| `overlay` | `false` | `true`, `'query'` or `{ position, open, max }` |
| `threshold` | `40` | Report interactions from this many ms; shorter ones only when a heavy later render joins them |
| `labels` | `'auto'` | Where `target.label` comes from: see [Labels and personal data](#labels-and-personal-data) |
| `hook` | `'auto'` | `'chain'` wraps an existing `__REACT_DEVTOOLS_GLOBAL_HOOK__` and never creates one; `'shim'` creates one unless one exists; `'auto'` chains or creates |
| `sampleRate` | `1` | Share of page loads that install anything |
| `walkBudget` | `5000` | Component fibers visited per commit. A commit past it is reported as partial: its counts say "at least", and in a production build, which has only counts to go on, the blame names the component the cut-short subtree sits in rather than the subtree the walk reached first |
| `inputWindow` | `1500` | A commit outside any input's dispatch is walked only within this many ms of the end of the last commit inside the newest input's dispatch, or of the input where there was none; commits inside an input's own dispatch are always walked. It also bounds `followUps`, whose window runs from the paint as a rule |
| `devtoolsTrack` | `true` | Draw each report in Chrome's Performance panel, in an "Interaction blame" track |
| `debugGlobal` | `false` | `true` puts the API on `window.__REACT_INP_BLAME__`; a string names the property |

The API has `reports()` (the last 50 published, oldest first, at their latest revision), `last()`, `inp()`
(`{ value, rating, interactionId, interactionCount, report }` for this navigation, or null), `onInteraction(fn)`,
`clear()` (drops reports and commits, and starts the INP estimate over), `dispose()` and `stats()`: `mode`
(`'shim'`, `'chained'`, `'none'`, `'unsupported'` or `'sampled-out'`), `unsupportedReason`, `walks`, and the
library's own time in `walkTotalMs`, `reportTotalMs` and `installMs`. `debug.commits()` and `debug.hook()` are
for debugging and may change in any version. Also exported: [`mountOverlay`](#the-badge-and-panel). Under
the `react-server` condition every export does nothing, here and on
[`react-inp-blame/web-vitals`](#with-web-vitals): `generateTarget` returns `undefined` and
`attributeINP` returns `{ react: null }`.

### InteractionReport

```ts
interface InteractionReport {
  schemaVersion: 2; interactionId: number; revision: number; type: string; // 'click', 'keydown', ...
  pointerType: string | null;                            // 'mouse', 'pen' or 'touch' for a pointer's event
  start: number; end: number; duration: number; holdMs: number;             // ms, performance.now() clock
  inputDelay: number; processing: number; walkMs: number; presentation: number; // add up to duration
  target: TargetInfo | null; entries: EventEntrySummary[]; // target: selector, label, component, owners, handler
  hydration: { kind: 'waited' | 'not-hydrated'; scope: 'root' | 'boundary';   // server-rendered HTML the click
               owner: string | null; ms: number | null } | null;            // landed on before React hydrated it
  navigationURL: string; navigationType: NavigationType; // web-vitals' names and values
  startedNavigation: { url: string; type: 'push' | 'replace' | 'traverse' } | null;
  commits: CommitSummary[]; followUps: CommitSummary[];   // before the paint; after it, within inputWindow
  unjoinedCommits: number;                               // commits in its handlers that could not be tied to it
  frames: FrameSummary[] | null; laterFrames: FrameSummary[] | null; // null without Long Animation Frames
  overheadMs: number;                                    // this library's own time on the interaction
  explanation: {
    blame: { kind: 'render' | 'handler' | 'hydration' | 'layout' | 'waiting' | 'painting' | 'script' | 'none';
             name: string | null; detail: string | null; ms: number | null;
             confidence: 'measured' | 'inferred' };
    rating: 'good' | 'needs-improvement' | 'poor';
    phases: { label: string; ms: number; hint: string; parts?: Phase[] }[]; // parts: named pieces of a phase
    headline: string; where: string | null; cause: string; notes: string[];
  };
  verdict: string;
}
```

`target.handler` is the name of the function on the element's event prop, or the prop's own name when that
function has no name worth printing. An inline `onClick={() => ...}` therefore reads as `onClick`, and so
does a handler the minifier renamed: name the function if you want the report to name it. Under React
Compiler, a handler declared as `const handleLogin = () => ...` becomes an alias of a temporary named `t0`
and is named by its prop, while a `function handleLogin()` keeps its name; a handler Radix composed is named
by its prop too, since every one it wraps is called `handleEvent`. When a click's events ran handlers of
their own, the handler named is the one whose event took longest, so a menu that opens on pointerdown is
put on its `onPointerDown`, not on an `onClick` that did nothing.

`target.component` is the nearest component enclosing the element whose name a reader could search their own
code for: one React would accept as a component name (capitalised), that a minifier has not cut down to a
letter or two, and whose every dotted part is the same, so a design system's `Primitive.button` gives way to
the `TabsTrigger` above it. When the click landed on an icon, an `<svg>` or something in one, an `<img>` or a
`<picture>`, the chain starts from what the icon belongs to in the tree React rendered: above every component
that renders nothing but the icon (an icon library's `Trash2` and the `Icon` under it), at the control around
it, at an element with a click handler of its own (a thumbnail's `<img onClick>`), or at the first element or
component that renders something beside it. A handler the icon was handed by the components that render
nothing but it is their caller's: `<Trash2 onClick>` names the component that wrote it. So a click on an
icon library's
`<svg>` inside a button names the component that renders the button, not the icon, an icon beside a name in
an option names the option's component, and a card's photo inside a link names the card. Anywhere else the
chain starts from the element itself. `target.owners` keeps the whole chain, innermost
first, whatever the names are, and where nothing in it passes, `component` is the innermost owner as it
always was.

`duration` is the longest single Event Timing entry, as web-vitals measures it; `holdMs` is how much longer
the span from press to release ran. Reports are frozen: a late entry, frame or render that joins one reaches
listeners as a new object with `revision` one higher, and `schemaVersion` changes when a field is removed or
changes meaning. **`verdict`, `cause`, `notes`, `headline`, `where` and the phases' `label` and `hint` are
display text that may change between versions**; the blame, the rating, the phases' `ms` and the report's
numbers are the data. `confidence` is `'measured'` when the blame follows from this interaction's own timings,
and `'inferred'` when it rests on render counts, a clock too coarse to time one component, a commit that only
overlapped, a walk cut short, or no Long Animation Frames to rule other scripts out.

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

## The INP estimate

`inp()` and the badge estimate INP the way web-vitals' `onINP` does, without depending on web-vitals: each
interaction's latency is its longest Event Timing entry, and INP is the one at index
`min(floor(count / 50), n - 1)` among the `n` longest it kept, `n` at most 10, chosen as entries arrive
and again when the page is hidden, the two moments web-vitals chooses at. It starts over at each soft
navigation and back/forward cache restore, and after one of those, interactions the browser counted but no
entry was sent for read as the same 8 ms web-vitals reports for them. `apps/demo/e2e/inp.spec.ts` runs
web-vitals 6.2.2's `onINP` in the same page (`reportAllChanges`, `durationThreshold: 16`) through more
than 50 interactions and asserts after
each that both name the same value and the same interaction. That is one session, not a promise: this is the
same algorithm written again from the same entries, and it is not web-vitals. The two part at the default 40 ms
threshold, which `useReportWebVitals` keeps, when INP is under 40 ms or too few interactions reach it; at a
soft navigation; after `clear()`; for a moment after each interaction, while web-vitals waits for an idle
page; and against the older web-vitals that Next.js 16.3 vendors, which keeps counting every interaction
since the page loaded after a back/forward cache restore.

## Compared with other tools

| | react-inp-blame | Sentry `reactComponentAnnotation` | react-scan | web-vitals attribution | React 19.2 Performance tracks |
| --- | --- | --- | --- | --- | --- |
| Production-safe | yes¹ | yes | no² | yes | no: development and profiling builds |
| Names the rendered subtree, not just the target's owner | yes | no³ | yes | no: a CSS selector | yes, in development⁴ |
| Follow-up renders after the paint | yes | no | not told apart⁵ | no | drawn, not joined to the interaction |
| Forced-layout split | yes, from Long Animation Frames, and it can be the verdict rather than a footnote | no | no: reads no Long Animation Frames | partly⁶ | no |
| Plain-language verdict | yes | no | no | no | no |
| Zero dependencies | yes | no | no (11 in 0.5.7) | yes | part of React |
| Needs a build step for names | in production builds: the plugins add it | yes | not in development⁷ | no names | not in development |

1. It fails closed on a browser or React it does not know, and `sampleRate` limits the page loads it runs on. The plugins leave it out of production builds unless `enabled` says otherwise.
2. It does not start when every React renderer on the page is a production build, unless `dangerouslyForceRunInProduction` is set, which its README calls "not recommended".
3. Its build step puts `data-sentry-component` on the outermost element each component returns, and the SDK names an INP span from the target and at most four of its ancestors, using those names where it finds them.
4. Profiling builds list only components under a `<Profiler>`, or every component with the React Developer Tools extension enabled.
5. It keeps every fiber render from the pointerup or keydown as one set, until the interaction's Event Timing entry arrives or a second after the frame that follows the input.
6. `totalStyleAndLayoutDuration`, and `longestScript.entry`, which carries `forcedStyleAndLayoutDuration`.
7. It ships bundler plugins under `react-scan/react-component-name/*`; what they match was not checked.

Checked on 2026-09-15 against aidenybai/react-scan at 0fb3186, getsentry/sentry-javascript at 7267c25,
reactjs/react.dev at f7f4524 and web-vitals 6.2.2's types. In development, React's Components track is the
better source of per-component durations; what this library adds there is the join and the sentence.

## Browser support

| | Chromium | Firefox | Safari |
| --- | --- | --- | --- |
| Event Timing `interactionId` (required) | 96 | 144 | 26.2 |
| Long Animation Frames: scripts and forced layout | 123 | no | no |
| Performance panel tracks | 128 | no | no |

Without `interactionId` nothing installs, one warning says why, and `stats().mode` is `'unsupported'`. Without
Long Animation Frames, `frames` and `laterFrames` are `null` and the explanation leaves out the forced-layout and
script sentences. On a page without cross-origin isolation, Playwright's Firefox 148 and WebKit 26.4 step
`performance.now()` in whole milliseconds, too coarse to time a quick component: when eight or more of a
commit's components are timed, every one reads a whole millisecond and they average under 4 ms, the report
leaves their times out and blame built on render times is `'inferred'`.

## What it costs

Measured 2026-09-15 on 7917366 in the demo's context storm (a click re-rendering 801 components) and big list
(a keystroke re-rendering 1441), in Chromium 147 headless on an otherwise idle Windows PC: 30 fresh page loads
per scenario, one interaction each, `walkBudget: 100000`, taken
[as the design notes describe](docs/interaction-attribution-design.md#what-it-costs). p50 / p95 in ms:

| | Context storm, production | Big list, production | Context storm, development | Big list, development |
| --- | --- | --- | --- | --- |
| `install()`, both calls the demo makes | 0.5 / 0.6 | 0.5 / 0.7 | 0.6 / 0.7 | 0.6 / 0.8 |
| Walk of the commits joined to the report | 0.8 / 0.9 | 1.2 / 1.4 | 0.9 / 1.3 | 2.9 / 3.2 |
| Event Timing callback, the page's listeners included | 1.0 / 1.2 | 1.0 / 1.2 | 1.1 / 1.4 | 1.1 / 1.4 |
| Library time outside the walks (`stats().reportTotalMs`) | 0.9 / 1.2 | 1.0 / 1.3 | 0.8 / 1.1 | 0.9 / 1.2 |
| `overheadMs` of the report | 1.3 / 1.5 | 1.7 / 1.9 | 1.5 / 1.9 | 3.4 / 3.8 |

On the same machine with other processes at 15 to 49% CPU, the same commit read 1.1 to 1.6 times these p50s.
The walk runs inside React's commit and its time is taken back out of `processing`; outside an interaction a
commit costs a renderer lookup and one subtraction, and at the default `walkBudget` of 5000 neither scenario is
cut short. With `enabled` at its default, neither plugin adds anything to a production build (on Next.js 15.3 to
16.2 the line's module is the exception, shipped unused); where it loads:

| Bundle (rolldown 1.2.8, minified ESM) | Minified | Gzip |
| --- | --- | --- |
| `react-inp-blame/auto`: everything that loads with the page | 39.0 KB | 14.4 KB |
| The badge and panel, a chunk loaded only when shown | 11.2 KB | 4.2 KB |
| Of that, the part that has to run before react-dom, not a separate entry yet: the hook, the fiber reading, the observers | 14.5 KB | 5.8 KB |
| `react-inp-blame/web-vitals` on its own, measured 2026-09-19 by a different script that read `/auto` at 38.2 / 14.1 | 2.7 KB | 1.3 KB |

On four open-source apps, built with and without it, 15 paired runs each unthrottled and at 4x CPU:
[docs/benchmarks](docs/benchmarks/README.md). INP did not move on any of them. On a Next.js site
with thousands of components, page load took about 75 ms longer unthrottled, most likely from the
name stamps.

## What it reads from React

These are React internals with no promise of stability, so the library checks them and fails closed: a
react-dom outside 17 to 19, a first `root.current` of another shape, or a walk that throws stops that
react-dom being read, for good, with one warning and `stats().unsupportedReason`. The page is only
`stats().mode === 'unsupported'` when no react-dom on it can be read, so an embedded widget that brought
its own React does not switch off the app's own. Reports carry on without components.

- `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`: created with `inject`, `onCommitFiberRoot`,
  `onPostCommitFiberRoot`, `renderers`, `supportsFiber` and a `reactInpBlame` marker, or, when one exists,
  those three methods wrapped and its `renderers`, `isDisabled` and `supportsFiber` read.
- What react-dom hands `inject()`: `version`, `bundleType`, `rendererPackageName`. What React passes
  `onCommitFiberRoot`: the renderer id, the root, the priority and `didError`.
- On the root: `current`, and `pendingLanes`, the bits of the updates React has not committed yet. They say
  which commits the page's own report listeners caused while they ran, so a panel that shows reports is not
  read as part of one. An update a listener defers to a later task is an ordinary render and is read like
  any other. Also `containerInfo`, the node the root was created on, for its `localName`: a root on a
  `<nextjs-portal>` element is Next.js's dev overlay under `next dev`, and its commits are not read.
- On fibers: `tag` (components are 0, 1, 11, 14 and 15; the root is 3, a Suspense boundary 13, an Activity
  boundary 31 on React 19, and 18 is the DehydratedFragment React deletes when it gives up hydrating a boundary),
  `flags` (the `PerformedWork` bit, 1; on the root `ForceClientRender`, 256, which says React threw its server
  HTML away; and `Hydrating`, 4096, on the child of a boundary whose hydration has rendered but not
  committed), `mode` (the `ProfileMode` bit: 8 on React 17, 2 on 18 and 19), `child`, `sibling`, `return`,
  `alternate` (the same `child` there means the fiber bailed out), `deletions` (only on a Suspense or Activity
  boundary, to tell one React hydrated from one it rendered on the client), `actualDuration`, `elementType`
  and `type` (for names: `displayName` or `name`, through `render` for forwardRef and `type` for memo; on a
  DOM element's fiber, its tag name), `memoizedProps` (the event's handler prop, such as `onClick`, and a
  form control's `type`), `memoizedState` (whether a root or a boundary was still server-rendered HTML:
  `isDehydrated` and `dehydrated`), and the root fiber's `stateNode`, the FiberRoot, to reach its `current`.
- On DOM nodes: React's `__reactFiber$` key, and `__reactContainer$` on the element `createRoot` or
  `hydrateRoot` was given. In server-rendered HTML: the comments React puts around a boundary, `$`, `$?`,
  `$!`, `$~` and `&` opening it and `/$` and `/&` closing it.

Supported: react-dom 17, 18 and 19; only react-dom commits are walked. CI runs the demo's suites on React 19.3
in development and production builds, its attribution and input-delay specs on React 19.2.8, 19.1.9, 18.3.1,
18.2.0 and 17.0.2 (legacy root), and the Next.js check on 16.3.5 under `next dev` and both production bundlers,
on 16.2.12, 15.5.26 and 15.3.9 through the `instrumentation-client` line, and on `next@canary`, whose App Router
brings a React canary, on every push and once a day, in a job allowed to fail. It also installs the package as
packed for npm into apps with no peers, with Next.js 15, with Next.js 16.3.5 and with Vite 5, on Node 20.19, the
oldest its `engines` allows, and imports and requires every subpath there; the canary job installs it beside
`next@canary` as well. No job runs `react@canary` alone. One more
job puts the packed package into an app made the way `npm create vite` makes one, on Vite 8.3 with
@vitejs/plugin-react 6.1 and the Vite setup above, and checks that a click there is blamed on the component
that rendered slowly, on the dev server with a Fast Refresh edit included and in a production build. Three
more check the same click, with no Fast Refresh edit, in the apps `npx create-react-router`, TanStack
Start's CLI and `npm create astro` make, each with its setup above, and a fifth in React Router 7's app
moved to React 18.

## Known limits

- **Frameworks that render their own HTML need a setup of their own**, and only React Router's, Remix's,
  TanStack Start's and Astro's above have been tried. The Vite plugin adds its install script only to the
  HTML pages Vite itself serves and builds, so without `entry` it installs nothing on another framework's
  pages. For those four, and for a build whose inputs are all scripts, the plugin warns when that happens and
  names the fix; any other framework gets no warning. On a Vite-based one, `entry` naming the first of the
  app's modules the browser runs may be enough. React Native is out of scope: only react-dom commits are walked.
- **React DevTools loaded after the library is locked out, and nothing can detect it**: it installs nothing
  over an existing hook. The extension loads first, so there the library chains; the lockout takes a page that
  installs React DevTools later, like react-devtools-inline's `initialize()`. `hook: 'chain'` never creates it.
- **An interaction after the page's first input that paints in under 16 ms gets no report**, however heavy the
  render after it: the browser sends no Event Timing entry for it. The first input still arrives as a
  `first-input` entry. See "Quiet interactions" in the [design notes](docs/interaction-attribution-design.md).
- React 18 and 19 development builds print "Download the React DevTools" on pages where the library created the
  hook: it has no `checkDCE`, which react-dom takes to mean React DevTools is there.
- **Hydration is joined to an input only when React hydrated inside that input's dispatch**, which is what
  React 18 and 19 do for a discrete event on a boundary that has not hydrated yet. A hydration that merely
  follows a keystroke is nobody's interaction and is left out. On React 17 nothing is: it has no dehydrated
  Suspense state, and it clears its one hydration flag before it calls the hook. See
  [Clicks that land before hydration](#clicks-that-land-before-hydration).
- On React 17, which calls nothing after a commit's effects, a render set off by an effect of your report
  listener's own render can still join a report. On React 18 and 19 it cannot.
- **A render your report listener causes is recognised by the lane React put it on**, and React has one lane
  for each priority. An update of the app's own that lands on the same lane before React commits is rendered
  in that same commit and left out with it, which for an otherwise quiet interaction can mean no report.
- Production React records no durations, so blame there rests on render counts and is `'inferred'`
  (`react-dom/profiling` gives durations), and minified handlers are named by their prop. An inferred blame
  says "most likely" in its sentence and in the overlay; take it as the likeliest reading, not a measurement.
  The exceptions are what the browser times itself and the build cannot change: waiting, the screen update,
  a Long Animation Frames script, and forced layout inside the handlers, which stay `'measured'` in a
  production build. The build is not the only thing that can lower a confidence, though: a script blame is
  `'inferred'` whenever a commit could not be tied to the interaction, since a script is what is left once
  React is ruled out and an unjoined commit is exactly what stops React from being ruled out.
- **Forced layout is blamed only when a long animation frame measured it**, which is Chromium only, and its
  share of a script that ran on past the handlers is apportioned by time rather than measured, so such a
  blame is `'inferred'`. Where the browser reports no long animation frames the report says nothing about
  layout at all, rather than implying none happened. Nothing records *which* read forced the layout, so a
  `'layout'` blame's `name` and `detail` say where it happened instead: the joined commit's subtree and
  what it was mostly made of. That name is dropped for the browser's own invoker where no commit joined,
  or where the one that did only overlapped the interaction in time, was walked short of the end, or sat
  beside commits that could not be tied to the interaction. The invoker itself is named only while one script
  holds nine tenths of the layout, since `ms` is every script's total summed; where several scripts share
  it, `name` is `null` and the cause names the largest with the share it holds. The milliseconds are the
  browser's either way, so `confidence` is about them alone and is never lowered to cover a doubtful name.
- **Reports name the nearest component with a readable name, not always the innermost one.** A component
  whose real name is one or two characters (`Td`, `Li`), or lowercase in any part of it (`header`,
  `motion.div`, `UI.list`), or that a styling library named after what it wraps (`styled.li`, `Styled(span)`),
  is passed over for the next one out, but only if there is one, so a chain holding nothing better prints the
  name as it stands. That goes for `where`, for the component a render blame names and what it was "mostly"
  made of, and for `generateTarget`. A short capitalised name cannot be told from minifier output, so `Abc` is
  taken at face value either way. The full chains are on `target.owners` and each commit's `hotPath` and
  `components`. A name with the `$1` that Vite's development server and Rolldown add to one that clashes
  (`Dt$1`) is judged without it. The component emotion renders beside every element @emotion/styled or the
  `css` prop styles, to insert its styles, is not counted.
- **A styling library's wrapper is named the way the library names one it was given no label for**, whatever
  label it has: MUI's `MuiButtonBaseRoot` reads `Styled(button)`, a styled-components wrapper its Babel or SWC
  plugin named `Title` reads `styled.h1`, and the component @emotion/react's `css` prop wraps an element in
  reads `Styled(li)`. So none of them is taken for a component the app wrote, in development or production.
  A click on a MUI button is then named by the nearest readable component above the wrapper, which can be
  MUI's own `ButtonBase` rather than the app's component around it: names alone cannot tell a library's
  component from the app's.
- The names loader stamps any capitalised top-level binding whose value is a function, written at the start of
  a line: `function Foo`, `const Foo = (props) => …`, `const Foo: React.FC = …`, `memo`, `forwardRef` and
  their generic forms, exported or not. Still minified: classes, anything indented inside another block,
  `export default () => …` with no name to stamp, a called function expression such as
  `const Foo = function () {…}()`, everything in a `"use server"` module, and a component built by a wrapper
  the loader does not know (`styled.div`, `observer(Row)`, an app's own `createIcon`). A name the module
  writes to again, declares twice, imports or already gives a `displayName` is left alone, and so is one
  declared inside braces, however far left it is written. A `displayName` your code sets is never replaced,
  including one a naming HOC sets on the component itself; an HOC that names a component some other way can
  still be overwritten.
- **A stamped module keeps the components nobody imported, in esbuild, terser and SWC.** The stamp checks the
  value before it writes to it, because a store that fails would throw at load in a strict module and take
  the page with it, and a bundler that cannot prove a property store is side-effect free has to keep the
  component it names. Measured on a module of seven exports with two imported: Rollup drops the unused ones
  and their stamps (Vite's production build is Rollup), esbuild keeps them all, and terser and SWC keep the
  ones the bundler handed them. `/*#__PURE__*/ Object.defineProperty` shakes everywhere and is worse, since
  every stamp is then dropped and no name survives at all. The transform only runs where you add the plugin
  or the loader, and only on your own files, so an app that minds can turn it off for the build and keep it
  for development.
- Two shapes the loader handles but nobody has put through a production bundler: a file that starts with a
  hashbang, and a file whose last line is a `sourceMappingURL` comment, which the stamp then follows.
- **A commit outside any dispatch joins the newest input when it lands within 1.5 s (`inputWindow`) of the end
  of the last commit inside that input's dispatch**, or of the input itself where there was none. An unrelated
  update landing in that window is read as the interaction's follow-up render. One that lands after a newer
  input arrived is left out of the report, and one that lands past the window is dropped; a dropped commit
  that ran while the interaction's own handlers were still running is counted as `unjoinedCommits`, which
  makes everything the report says about React's work `'inferred'`. A commit outside those handlers, a clock
  ticking elsewhere on the page, is not counted against the interaction at all. Some commits are plainly
  something else's and are left out the same way: one React makes while a resize, a scroll, a wheel, a hover
  or a media query's `change` is being dispatched (a `useMediaQuery` hook, and under React 17 any handler of
  those events), one after the window changed width since the input (a resize hook that waits for a timer;
  a change of height alone, a phone's keyboard opening, does not count), and, under React 19 in development
  and profiling builds, one React commits with the priority it gives a hover's or a scroll's update. Under
  React 18, and React 19 in production, a hover or a scroll renders in a task of its own with nothing to say
  whose it is, so within the window it still reads as a follow-up render of whatever interaction came last,
  as does an update with no user input behind it at all, a timer or a message arriving. A click whose own
  follow-up lands after the window was resized loses it, the rule a newer input already follows.
- **The window runs from the last commit inside the dispatch, not from the end of the dispatch**, which the
  library cannot see. A handler that works for two seconds and commits nothing leaves the window running from
  the input, so a transition it starts afterwards can fall outside it. That render is then dropped and counted
  rather than reported: the interaction says React rendered something it could not tie to it.
- Waiting on the server is not a phase: the render showing the result joins as a later render within
  `inputWindow` of the paint (1.5 s unless you set it), or not at all.

## Labels and personal data

`target.label` names the element by its tag and a name of at most 40 characters, and never reads a form
field's value or an element's whole text. A click that lands inside a control is labelled by that control,
tag and name included: the first of the element and its five nearest ancestors that is a `button`, a link,
`summary`, `label`, `input`, `select` or `textarea`, or has the ARIA role `button`, `link`, `menuitem`,
`menuitemcheckbox`, `menuitemradio`, `tab`, `option`, `checkbox`, `radio` or `switch`. A click on the `path`
of an icon button reads `button "Close"`, not `path`, and `target.selector` stays the element the browser
reported. Under a production build of React the label uses only what your code wrote on the element:
`aria-label`, a form field's `placeholder`, `name` or `type`, or `data-testid` or `data-test`. An element's
text can be a person's name or email, and reports are made to be forwarded to error trackers and analytics, so
text is opt-in there: with `install({ labels: 'text' })` an element with no `aria-label` that is not a form
field is named by its first run of text. Development builds use text by default. Whatever `labels` says,
`target.selector` has the tag, the `id` if there is one, and `data-test` or `data-testid` or else two classes,
and `navigationURL` and `startedNavigation.url` are full URLs, query string included. So is a script the
browser names by its URL, or by the page's for an inline script, in a blame's `name` and the sentences.

[Design notes](docs/interaction-attribution-design.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · MIT license
