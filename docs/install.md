# Install

The [README](../README.md) has the short version for Next.js and Vite. This page has every setup in full: what each option does, the frameworks that write their own HTML, and what to check when a build leaves the library out.

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

`runtime` defaults to `true`, which is [`install()`](api.md#installoptions) with its defaults. It also takes the
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
