# react-inp-blame

When a click, tap or key press in your React app is slow, this names the component or the handler behind
it and says where the time went.

![The demo's sign-in page: a click on Log in, the badge showing the page's INP, the panel opening, and one row expanding into the explanation](docs/media/overlay.gif)

**[Try the demo](https://adityareddy-dev.github.io/react-inp-blame/)**. Every scenario there is slow on
purpose. Click something and read what the badge blames.

    npm install react-inp-blame

## Start with Next.js 14.2 or later

```ts
// next.config.ts
import type { NextConfig } from 'next';
import { withInpBlame } from 'react-inp-blame/next';

const nextConfig: NextConfig = {
  /* config options here */
};

// Your config first, this library's options second. They are not Next.js config keys.
export default withInpBlame(nextConfig, { runtime: { overlay: true } });
```

On Next.js 15.3 to 16.2, add one line to `instrumentation-client.ts` as well. `withInpBlame` prints it
until the file has it (14.2 to 15.2 need nothing more):

```ts
// instrumentation-client.ts
export { onRouterTransitionStart } from 'react-inp-blame/next-client';
```

Next.js 14.2 reads no `next.config.ts`, since that came in 15, so there the same setup goes in
`next.config.mjs`, as plain JavaScript:

```js
// next.config.mjs
import { withInpBlame } from 'react-inp-blame/next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
};

// Your config first, this library's options second. They are not Next.js config keys.
export default withInpBlame(nextConfig, { runtime: { overlay: true } });
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

**What you will see.** Reload the page. A small dark badge sits in the corner, bottom-right by default,
and reads `INP —` until you interact. Click something slow and it shows the page's INP so far in
milliseconds: green at 200 or under, amber up to 500, red above. Click the badge for a panel of the recent
slow interactions, newest first, and click a row for the whole explanation. A click, tap or key press of
40 ms or more gets a row (the `threshold` option), so a 150 ms click has one, though the badge stays green
and the panel says Good: INP counts anything up to 200 ms as good. The demo above sets
`position: 'bottom-left'`, which is why its badge sits on the left: its own explanation column has the
right-hand side. From the demo's sign-in page, in development, this is `report.verdict`, which the row
spreads over its header and body:

    408 ms click on button "Log in" in SignInPage. The click handler handleLogin ran for
    about 402 ms; React's own render took under 1 ms. A second React render landed 285 ms
    after the screen updated: 84 ms re-rendering 256 components inside ProfilePage, mostly
    PhotoTile (240 of them, 73 ms). INP doesn't count it, but people still wait for it.

`overlay` takes `true` (always shown), `'query'` (shown only when the URL has `?inp-blame` or
`#inp-blame`, or `localStorage` has `react-inp-blame` set to `overlay`, which is how to open it on a
production page) or `{ position, open, max }`. Both snippets above are development-only: `enabled`
defaults to `'development'`, so a production build carries nothing from either plugin until you say
`enabled: true` or `enabled: 'production'`. So `vite preview` and `next start`, which serve a production
build, show no badge by default, and the build prints a line saying it left the library out. The one
exception is the line on Next.js 15.3 to 16.2: its code is in every build, and in the ones `enabled` leaves
out it ships unused and installs nothing.

If you would rather read reports than look at a badge, drop `overlay` and subscribe:

```ts
// Next.js: instrumentation-client.ts or any client module. Vite: the entry module.
import { onInteraction } from 'react-inp-blame';

// A report can come again as a later revision when more data joins it: keep the latest per interactionId.
onInteraction((report) => console.log(report.verdict, report.explanation.blame));
```

To read the whole report of the last interaction in the console, add `debugGlobal: true` to `runtime` and
run `__REACT_INP_BLAME__.last()`.

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

If the console printed a warning instead, it ends with a link to its entry under
[Troubleshooting](#troubleshooting).

---

# Reference

Terms this page uses: **INP** (Interaction to Next Paint) is the Core Web Vital for responsiveness: how
long a click, tap or key press took to reach the next frame drawn, at the page's slowest, with the worst
few left out once a page has had many. **Event
Timing** is the browser API INP is built on. **Long Animation Frames** is a second, Chromium-only API that
says which scripts ran in a slow frame and how much style and layout work they forced. React's **fiber tree** is the
internal tree React keeps of your rendered components; the library reads it through the hook React
exposes for developer tools. A **soft navigation** is a route change the framework makes in the page,
with no new document.

## Install with Next.js 14.2 or later

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
left as it is, with a warning, since 15.x takes one rule there.

**Next.js 14.2 to 15.2** have no `instrumentation-client`, so the wrapper puts the install first in webpack's
client entries (`main-app` for the App Router, `main` for the Pages Router), which webpack runs before the next
module in them loads react-dom, and adds the loader to webpack alone, writing no `turbopack` key, which 14.2
does not know. Under `next dev --turbo` no `webpack()` hook runs, so nothing installs: the wrapper says so. No
line is needed there, and soft navigations are not announced, so reports carry the page's URL but no
`startedNavigation`. Write the config as `next.config.mjs` on 14.2, which reads no `.ts`. Below 14.2 the wrapper
warns and hands your config back as it was. CI runs the Next.js suites on 16.3.5, 16.2.12, 15.5.26 and
15.3.9 (with the line below 16.3), under both bundlers, and an app on 14.2.35 (`fixtures/next-14`), dev and
production, each with an App Router page and a Pages Router page; 15.2.9 was checked by hand the same way.

**The Pages Router on `next dev` from 15.3.** Its dev entry, `next-dev.js` under webpack and
`next-dev-turbopack.js` under Turbopack, loads react-dom before `instrumentation-client` and before the
injected module, where its production entry loads them first. So on `next dev` the wrapper also puts the
install first in that entry: in webpack's `main`, and under Turbopack, which Next.js announces in the
`TURBOPACK` environment variable before it reads the config, through a rule that runs a small loader of this
package on `next-dev-turbopack.js` alone. Nothing in your setup changes, and a build gets neither.

**`enabled` defaults to `'development'`: a production build gets neither the runtime nor the component
names unless you pass `enabled: true` or `enabled: 'production'`.**

| `enabled` | `'development'` (default) | `'production'` | `true` | `false` |
| --- | --- | --- | --- | --- |
| Runs that get the runtime and the loader | `next dev` | `next build` and `next start` | both | none: the config comes back untouched |

`runtime` defaults to `true`, which is [`install()`](#installoptions) with its defaults. It also takes the
options for `install()`, inlined through `env` and so plain data, or `false` for the loader alone. On the
App Router, reports follow soft navigations in `navigationURL` and `navigationType`, name the one a click
started in `startedNavigation`, and the INP estimate starts over at each. The Pages Router gets attribution
without navigations: Next.js announces none there.

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
of `node_modules` to `vendor`. Vite 8's `build.rolldownOptions.output.codeSplitting.groups` (or the older
`advancedChunks.groups`) get the same: the plugin adds a group of its own ahead of yours, with a priority above
all of them, that takes the library, so a `{ name: 'vendor', test: /node_modules/ }` group keeps react-dom and
the rest. CI builds that on Vite 8.3 with React 18.3 and Radix's Portal, which imports react-dom, in the vendor
group; React 17 was checked by hand. A `manualChunks` object is left as it is, so there, keep
react-inp-blame out of the rule. With `@vitejs/plugin-legacy` the install stays in the page's own script, and
a vendor rule that takes react-dom, or a library that imports it, breaks it whatever it does with the
library, so keep react-dom out of that rule too (`!id.includes('/react-dom/')`, or on Vite 8 a group of its
own, `{ name: 'react-dom', test: /node_modules[\\/]react-dom[\\/]/, priority: 1 }`, ahead of the vendor
group, with the libraries that import it kept out of the vendor group as well, checked by hand on Vite 8.3
with plugin-legacy 8.2). The build warns, naming both
chunks and the module, when the install's chunk imports one that connects react-dom to React's DevTools hook as it
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
when its chunk loads: CI builds a webpack 5 app with react-dom and the library in one vendor chunk
(`fixtures/webpack`), in development and production; Rspack is not tried. `/auto` leaves the badge off: call
`mountOverlay()` from `react-inp-blame` after it to show it. For names, add this rule to `module.rules`:
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
      runtime: { overlay: true }, // the badge on every page of the dev server
      entry: "app/root.tsx",      // React Router writes its own HTML, so the install goes first in the root route
    }),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
```

This shows the badge under `react-router dev`. A production build leaves the library out, since `enabled` defaults to
`'development'`, and the build prints a line saying so. To keep it in production too, add `enabled: true` and
make the overlay `'query'`, so a visitor sees the badge only with `?inp-blame` in the URL. CI's copy of this
app does that.

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
library beside react-dom, and your `manualChunks` function keeps deciding every other module. Under Rolldown
with `codeSplitting` or `advancedChunks` groups, the chunk comes from a group the plugin puts ahead of yours
instead, with the same effect. Under Rollup that keeps the install first; under Rolldown the module can still
import the vendor chunk before it. A `manualChunks` object cannot be added to, so the plugin warns and leaves
it be, and the install may then run late in a build. `entry` needs the runtime, so it cannot go with
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
      runtime: { overlay: true }, // the badge on every page of the dev server
      entry: "app/root.tsx",      // Remix writes its own HTML, so the install goes first in the root route
    }),
  ],
});
```

This shows the badge under `remix vite:dev`. A production build leaves the library out, since `enabled` defaults to
`'development'`, and the build prints a line saying so. To keep it in production too, add `enabled: true` and
make the overlay `'query'`, so a visitor sees the badge only with `?inp-blame` in the URL. CI's copy of this
app does that.

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
      runtime: { overlay: true }, // the badge on every page of the dev server
      entry: 'src/client.tsx',    // TanStack Start writes its own HTML, so the install goes first in the client entry
    }),
  ],
})

export default config
```

This shows the badge under `vite dev`. A production build leaves the library out, since `enabled` defaults to
`'development'`, and the build prints a line saying so. To keep it in production too, add `enabled: true` and
make the overlay `'query'`, so a visitor sees the badge only with `?inp-blame` in the URL. CI's copy of this
app does that.

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
      runtime: { overlay: true }, // the badge on every page of the dev server
    }),
  ],
});
```

This shows the badge under `astro dev`. A production build leaves the library out, since `enabled` defaults to
`'development'`, and the build prints a line saying so. To keep it in production too, add `enabled: true` and
make the overlay `'query'`, so a visitor sees the badge only with `?inp-blame` in the URL. CI's copy of this
app does that.

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

**Content Security Policy.** The badge and panel need nothing in `style-src`: their stylesheet is a
constructed one adopted by the shadow root, which `style-src` does not govern, and their colours and bar
widths are set through classes and the style object rather than `style` attributes. Safari before 16.4 has
no constructed stylesheets and gets a `<style>` element instead, which needs `'unsafe-inline'` in
`style-src` there. They need nothing from Trusted Types either: they are built from elements and text nodes,
never from markup, so a page that enforces them (`require-trusted-types-for 'script'`) draws them under any
`trusted-types` directive, `'none'` included, and the library creates no policy. A page set up for 0.9.0 to
0.11.0 can drop `react-inp-blame` from its directive. On Vite, `html.cspNonce` puts the
nonce on the plugin's script in development and in a build, and the badge's chunk loads through that
script's import, so a nonce-based `script-src` needs nothing more.

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
| `walkBudget` | `5000` | Component fibers visited per commit. A commit past it is reported as partial: its counts say "at least", and in a production build, which has only counts to go on, the blame names the one subtree the walk was in where nothing it did not reach rendered beside it, and otherwise the component the subtrees all sit under, or the app where they sit under none, rather than the subtree the walk reached first |
| `inputWindow` | `1500` | A commit outside any input's dispatch is walked only within this many ms of the end of the last commit inside the newest input's dispatch, or of the input where there was none; commits inside an input's own dispatch are always walked. It also bounds `followUps`, whose window runs from the paint as a rule |
| `devtoolsTrack` | `true` | Draw each report in Chrome's Performance panel, in an "Interaction blame" track |
| `debugGlobal` | `false` | `true` puts the API on `window.__REACT_INP_BLAME__`; a string names the property |

The API has `reports()` (the last 50 published, oldest first, at their latest revision), `last()`, `inp()`
(`{ value, rating, interactionId, interactionCount, report }` for this navigation, or null), `onInteraction(fn)`,
`clear()` (drops reports and commits, and starts the INP estimate over), `dispose()` and `stats()`: `mode`
(`'shim'`, `'chained'`, `'none'`, `'unsupported'` or `'sampled-out'`), `unsupportedReason`, `react` (`'reading'`,
`'waiting'` while React has not rendered on the page, `'installed-late'` when it has and no react-dom registered
because install() ran after react-dom loaded, or `'unreadable'`), `walks`, and the
library's own time in `walkTotalMs`, `reportTotalMs` and `installMs`. `debug.commits()` and `debug.hook()` are
for debugging and may change in any version. Also exported: [`mountOverlay`](#the-badge-and-panel). Under
the `react-server` condition every export does nothing, here and on
[`react-inp-blame/web-vitals`](#with-web-vitals): `generateTarget` returns `undefined` and
`attributeINP` returns `{ react: null }`.

### InteractionReport

```ts
interface InteractionReport {
  schemaVersion: 3; interactionId: number; revision: number; type: string; // 'click', 'keydown', ...
  pointerType: string | null;                            // 'mouse', 'pen' or 'touch' for a pointer's event
  reactStatus: 'reading' | 'waiting' | 'installed-late' | 'unreadable'; // stats().react as it was built
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
does a handler the minifier renamed. Naming the function helps on the dev server only: a production build's
minifier renames `handleLogin` like any other function, so there it reads as `onClick` whatever you called
it, unless the build keeps function names (terser's `keep_fnames`, esbuild's `keepNames`), which costs bundle
size. The names loader stamps components, not handlers. In production, `target.component` and the prop are
what say where to look. Under React
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
chain starts from the element itself. `target.owners` keeps the chain's eight innermost components, nearest
first, whatever the names are, and `component` is picked from those eight: where nothing in them passes, it is
the innermost owner as it always was.

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

<!-- size:start -->
| Bundle (rolldown 1.2.8, minified ESM, gzip at zlib's default level) | Minified | Gzip |
| --- | --- | --- |
| `react-inp-blame/auto`: everything that loads with the page | 64.0 KB | 22.8 KB |
| The badge and panel, a chunk loaded by `import()` only when shown | 15.2 KB | 5.9 KB |
| Of `/auto`, what has to run before react-dom: the hook, the fiber reading, the observers | 24.2 KB | 9.0 KB |
| `react-inp-blame/web-vitals`, on top of `/auto` | 1.4 KB | 0.7 KB |
<!-- size:end -->

`node scripts/size.mjs` measures these from the build on every CI run, and CI fails when this table is out
of date or a size passes its budget in `scripts/size-budget.json`. The table before 0.8.0 said 39.0 and
14.4 KB for `/auto`, figures from 0.1.0 that had not been measured again as the entry grew.

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
in development and production builds, its attribution, input-delay and ambient specs on React 19.2.8, 19.1.9,
19.0.0, 18.3.1, 18.2.0 and 17.0.2 (legacy root), and the Next.js check on 16.3.5 under `next dev` and both production bundlers,
on 16.2.12, 15.5.26 and 15.3.9 through the `instrumentation-client` line, and on `next@canary`, whose App Router
brings a React canary, on every push and once a day, in a job that fails the daily run when it breaks but
never a push or a pull request. It also installs the package as
packed for npm into apps with no peers, with Next.js 15, with Next.js 16.3.5 and with Vite 5, on Node 20.19, the
oldest its `engines` allows, and imports and requires every subpath there; the canary job installs it beside
`next@canary` as well. No job runs `react@canary` alone. One more
job puts the packed package into an app made the way `npm create vite` makes one, on Vite 8.3 with
@vitejs/plugin-react 6.1 and the Vite setup above, and checks that a click there is blamed on the component
that rendered slowly, on the dev server with a Fast Refresh edit included and in a production build. Three
more check the same click, with no Fast Refresh edit, in the apps `npx create-react-router`, TanStack
Start's CLI and `npm create astro` make, each with its setup above, and a fifth in React Router 7's app
moved to React 18. The create-vite app, and a Next.js 14.2 app with both routers, are installed with pnpm
as well, into the isolated `node_modules` pnpm makes by default, and checked the same way.

For component libraries, CI builds the Vite app with styled-components, @emotion/styled, lucide-react and
Radix's DropdownMenu, on the dev server and in production. That covers the Radix primitives shadcn/ui's Radix
styles wrap, used directly rather than through shadcn's generated files. shadcn/ui now starts a project on
Base UI, and no job builds Base UI or a shadcn project of either style.

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
- **Forced layout is blamed only when a long animation frame measured it**, which is Chromium only. The
  browser counts style recalculation in the same figure, so a `'layout'` blame covers either. Its share of
  a script that ran on past the handlers is apportioned by time rather than measured, so such a blame is
  `'inferred'`. Where the browser reports no long animation frames the report says nothing about
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
  taken at face value either way. The names as they are stay on `target.owners` (the eight innermost) and
  each commit's `hotPath` and `components`. A name with the `$1` that Vite's development server and Rolldown add to one that clashes
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
  their generic forms, exported or not. In a Vite build the plugin first turns `export default function Foo` into
  `function Foo` exported by name, so a framework that wraps a module's default export, as React Router does a
  route's component, still leaves a `Foo` to stamp. Still minified: classes, anything indented inside another block,
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
  a change of height alone, a phone's keyboard opening, does not count), and, under React 19.1 and later in
  development and profiling builds, one React commits with the priority it gives a hover's or a scroll's
  update. A touch's own pointerover and pointerenter get that priority too, so behind a touch it is not read:
  a card that opens when a finger enters it is the tap's work, and on a device with both a touch screen and a
  mouse, a mouse hover or a wheel soon after a tap still joins the tap. Under React 18 and 19.0, and React 19 in
  production, a hover or a scroll renders in a task of its own with nothing to say whose it is, so within
  the window it still reads as a follow-up render of whatever interaction came last,
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
field's value or an element's whole text. It is read as the input is dispatched, before your handlers run,
so a click on a button reading "Count is 0" is labelled that, not with the "Count is 1" it then shows. A click that lands inside a control is labelled by that control,
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

## Troubleshooting

Each warning the library prints ends with a link to its entry below. In the browser a warning starts with
`[react-inp-blame]` and prints once per page. At build time it starts with `withInpBlame:` or `inpBlame:`,
except the Vite plugin's setup advice, which starts with `[react-inp-blame]` and links its setup section, and
the line a production build prints when it leaves the library out, which starts with `[react-inp-blame]` too
under Vite and Astro.
To see whether the library installed at all, and why not, add `debugGlobal: true` and read
`__REACT_INP_BLAME__.stats()`. If your problem is not here, open a
[setup problem](https://github.com/adityareddy-dev/react-inp-blame/issues/new?template=setup-problem.yml) issue
with the warning text.

### In the browser

<a id="late-install"></a>
#### install() ran after a React root had already rendered

The library has to be on the page before react-dom loads, and here it came later. The commits React made
before that were missed. It reads React now only because another hook, usually the React DevTools
extension, was on the page first. Without that, nothing would be read. Install with the
[Vite plugin](#install-with-vite), the [Next.js wrapper](#install-with-nextjs-142-or-later) or the
[Astro integration](#install-with-astro). With another bundler, make `import 'react-inp-blame/auto'` the first
import of your entry module. Frameworks that write their own HTML need `entry`: see
[React Router](#install-with-react-router), [Remix](#install-with-remix) and
[TanStack Start](#install-with-tanstack-start).

<a id="no-renderer"></a>
#### React has rendered, but no react-dom has registered

The same problem as [the one above](#late-install), found another way: 3 seconds after install, React is on the
page but react-dom never talked to the library. Nothing React does on this page is read, so reports have no
components, and `stats().react` says `'installed-late'`.

If the library is not set up for your framework yet, the fix is the one above. If it is and this still shows,
something on the page loads react-dom before the install runs. The known cases:

- **Next.js 15.3 or later, Pages Router, `next dev`.** Next.js's dev entry for the Pages Router loads react-dom
  before `instrumentation-client`, so the line there comes too late. The wrapper now puts the install ahead of
  that entry under webpack and Turbopack; up to 0.11.0 it did not, so upgrade. With `runtime: false` and an
  `install()` of your own in `instrumentation-client.ts`, your call still comes too late on that page: drop
  `runtime: false` and pass your options as `runtime` instead. Production builds were never affected.
- **Next.js before 15.3 under Turbopack.** Nothing can install there, and the wrapper
  [says so](#next-turbopack) when `next dev` starts.
- **Vite with a chunk rule of your own**, which can put react-dom in a chunk the install then imports. The plugin
  [warns at build time](#vite-react-dom-first).
- **A script of your own that runs first**, such as another entry or a `<script>` ahead of the app's that
  imports react-dom. Make the install the first thing on the page, or put `import 'react-inp-blame/auto'` at
  the top of that script.

If none of these fits, open a
[setup problem](https://github.com/adityareddy-dev/react-inp-blame/issues/new?template=setup-problem.yml) issue
with the framework, its version and what `__REACT_INP_BLAME__.stats()` says.

<a id="minified-names"></a>
#### Most component names are one or two characters

The build minified your component names, so reports read like "inside e, mostly Xe". The blame itself is
fine. To keep your own components' names, use the [Vite plugin](#install-with-vite) or the
[Next.js wrapper](#install-with-nextjs-142-or-later). With webpack or Rspack, add
`react-inp-blame/display-names-loader` as the webpack part of [Install with Vite](#install-with-vite) shows. A dependency's
components keep their names only where the dependency sets `displayName`.

<a id="another-copy"></a>
#### A copy from an incompatible version is already on this page

Two versions of react-inp-blame were loaded, and the second one installed nothing. Run
`npm ls react-inp-blame` to find them, and dedupe to one version.

<a id="unsupported-browser"></a>
#### This browser has no Event Timing interactionId

The browser cannot say which events belong to one interaction, so nothing was installed. It needs Chrome 96,
Firefox 144 or Safari 26.2 or later. See [Browser support](#browser-support).

<a id="reinstall"></a>
#### install() had already run

`install()` was called a second time with different options. Only `overlay` changes on a later call. The
other options keep the first call's values. Call `dispose()` first if you mean to change them. This often
means the library is installed twice, for example by a plugin and by your own `install()` call.

<a id="hook-disabled"></a>
#### The page's DevTools hook turns React's developer tools support off

Something on the page set `__REACT_DEVTOOLS_GLOBAL_HOOK__` with `isDisabled`, or without `supportsFiber`,
before the library loaded. Packages that disable React DevTools in production do this. React then reports to
no hook, so reports come without components. Remove that script where you want blame.

<a id="shim-over-hook"></a>
#### hook: 'shim' found a React DevTools hook already installed

You asked for `hook: 'shim'`, but a hook was already there: the React DevTools extension, or in Vite development the React
Fast Refresh preamble. The
library chained onto it instead, which works. Nothing to fix. Drop `hook: 'shim'` to stop the warning.

<a id="locked-out"></a>
#### The DevTools hook was replaced after React registered

Another tool, often react-devtools-inline's `initialize()`, replaced `__REACT_DEVTOOLS_GLOBAL_HOOK__` after
React had registered with this library's hook. React keeps reporting to the old hook, so that tool will not
see React. Blame still works. Load that tool before react-inp-blame, or install with `hook: 'chain'`.

<a id="react-version"></a>
#### react-dom is outside React 17 to 19

That react-dom's commits are not read, so its interactions are reported without components. Upgrade to
React 17, 18 or 19. Other React roots on the page are still read.

<a id="fiber-shape"></a>
#### The fiber tree is not the shape this library reads

This react-dom build lays out its internals in a way the library does not know, for example a canary
or experimental React. Its commits are not read. Please open a
[wrong or missing blame](https://github.com/adityareddy-dev/react-inp-blame/issues/new?template=wrong-or-missing-blame.yml)
issue with the warning text and your react-dom version.

<a id="walk-threw"></a>
#### Reading a commit threw

The library hit an error while reading React's tree, and stopped reading that react-dom. This is a bug in
the library. Please open a
[wrong or missing blame](https://github.com/adityareddy-dev/react-inp-blame/issues/new?template=wrong-or-missing-blame.yml)
issue with the warning text, your versions and, if you can, the component that was rendering.

<a id="overlay-failed"></a>
#### The badge and panel could not be shown

The badge's code is a separate chunk loaded with `import()`, and that load failed. Check the network panel
for the chunk, and a `script-src` policy that blocks it. Reports still come through `onInteraction`.

<a id="overlay-draw"></a>
#### The badge and panel could not be drawn

Building the badge threw. It is made from elements and text, so no Content Security Policy or Trusted Types
directive should stop it: this is a bug in the library, or a page that replaced a DOM method. Please open a
[setup problem](https://github.com/adityareddy-dev/react-inp-blame/issues/new?template=setup-problem.yml)
issue with the warning text and your browser. Reports still come through `onInteraction`.

### At build time, any setup

<a id="left-out-of-a-production-build"></a>
#### Left out of this production build

`enabled` defaults to `'development'`, so a production build carries nothing from this library. The page it
serves (`vite preview`, `next start`, `astro preview` or your own server) shows no badge and makes no reports.
That is on purpose, so real visitors get none of it until you choose. To include it, pass `enabled: true` or
`enabled: 'production'`, and think about `runtime: { overlay: 'query' }`, which shows the badge only when the
URL has `?inp-blame`. To keep it out without the line, write `enabled: 'development'` yourself. The Vite plugin
and the Astro integration print the line once per build, and `withInpBlame` once per `next build`.

### At build time, Next.js

<a id="next-too-old"></a>
#### Next.js is older than 14.2

`withInpBlame` left your config as it was, so nothing installs. Upgrade Next.js to 14.2 or later.

<a id="next-turbopack"></a>
#### Next.js before 15.3 under Turbopack

Next.js 14.2 to 15.2 has no `instrumentation-client`, and under Turbopack it runs no `webpack()` hook, so
nothing installs the library. Run `next dev` without `--turbo`, or upgrade Next.js to 15.3 or later.

<a id="next-client-line"></a>
#### Add this line to instrumentation-client.ts

On Next.js 15.3 to 16.2 the wrapper cannot load the library before React by itself. Add the line it prints to
`instrumentation-client.ts`, next to `next.config` or in `src/`. The warning stops once the file has it. See
[Install with Next.js](#install-with-nextjs-142-or-later).

<a id="next-turbopack-rule"></a>
#### Your config already has a Turbopack rule for the same files

Before Next.js 16 a Turbopack glob holds one rule, and your config has one for `*.{tsx,jsx}`. So under
Turbopack the names loader is left out, and a production build has minified names. webpack builds still get
it. Upgrade to Next.js 16, or add `react-inp-blame/display-names-loader` to your own rule's `loaders`.

### At build time, Vite

<a id="vite-no-page"></a>
#### The install script never reaches a page

A framework that writes its own HTML, or a build with only scripts as inputs, never loads the plugin's
install script. The warning links the setup for your case: [React Router](#install-with-react-router),
[Remix](#install-with-remix), [TanStack Start](#install-with-tanstack-start), [Astro](#install-with-astro),
or [scripts only](#install-with-vite).

<a id="vite-react-dom-first"></a>
#### The install chunk imports a chunk that runs react-dom

A `manualChunks` or `codeSplitting` rule put react-dom where it loads before the install, so nothing is read in
that build. Keep `react-inp-blame` out of the rule, usually a `node_modules` vendor rule. With
@vitejs/plugin-legacy, keep react-dom and every library that imports it, such as Radix's Portal, out of the
vendor rule too: see [a vendor chunk](#install-with-vite) for a config that works.

<a id="vite-manual-chunks"></a>
#### entry needs a manualChunks function

With `entry`, the plugin gives the install its own chunk through a `manualChunks` function. Your build sorts
chunks with a `manualChunks` object, so it could not. Write your rule as a `manualChunks` function. Rolldown's
chunk groups (`codeSplitting` or `advancedChunks`, Vite 8) need nothing: the plugin adds a group of its own.

<a id="vite-module-info"></a>
#### The bundler gives manualChunks no getModuleInfo

Only the install call got its own chunk, and the rest of the library goes wherever your rules put it. Keep
`react-inp-blame` out of any vendor rule.

## Reporting a wrong blame

If a report blames the wrong component or handler, or a slow interaction gets no report, please open a
[wrong or missing blame](https://github.com/adityareddy-dev/react-inp-blame/issues/new?template=wrong-or-missing-blame.yml)
issue. Paste the report JSON from `__REACT_INP_BLAME__.last()`, as
[When the blame is wrong](#when-the-blame-is-wrong) says. These reports are how the blame gets better.

[Design notes](docs/interaction-attribution-design.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · MIT license
