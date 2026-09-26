# Troubleshooting
Each warning the library prints ends with a link to its entry below. In the browser a warning starts with
`[react-inp-blame]` and prints once per page. At build time it starts with `withInpBlame:` or `inpBlame:`,
except the Vite plugin's setup advice, which starts with `[react-inp-blame]` and links its setup section, and
the line a production build prints when it leaves the library out, which starts with `[react-inp-blame]` too
under Vite and Astro.
To see whether the library installed at all, and why not, add `debugGlobal: true` and read
`__REACT_INP_BLAME__.stats()`. If your problem is not here, open a
[setup problem](https://github.com/adityareddy-dev/react-inp-blame/issues/new?template=setup-problem.yml) issue
with the warning text.

## In the browser

<a id="late-install"></a>
### install() ran after a React root had already rendered

The library has to be on the page before react-dom loads, and here it came later. The commits React made
before that were missed. It reads React now only because another hook, usually the React DevTools
extension, was on the page first. Without that, nothing would be read. Install with the
[Vite plugin](install.md#install-with-vite), the [Next.js wrapper](install.md#install-with-nextjs-142-or-later) or the
[Astro integration](install.md#install-with-astro). With another bundler, make `import 'react-inp-blame/auto'` the first
import of your entry module. Frameworks that write their own HTML need `entry`: see
[React Router](install.md#install-with-react-router), [Remix](install.md#install-with-remix) and
[TanStack Start](install.md#install-with-tanstack-start).

<a id="no-renderer"></a>
### React has rendered, but no react-dom has registered

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
### Most component names are one or two characters

The build minified your component names, so reports read like "inside e, mostly Xe". The blame itself is
fine. To keep your own components' names, use the [Vite plugin](install.md#install-with-vite) or the
[Next.js wrapper](install.md#install-with-nextjs-142-or-later). With webpack or Rspack, add
`react-inp-blame/display-names-loader` as the webpack part of [Install with Vite](install.md#install-with-vite) shows. A dependency's
components keep their names only where the dependency sets `displayName`. Where most of your names are readable
and only the component a report names is short, the note says that one is most likely a dependency's instead.
React DevTools shows the same short name, but selecting it there shows its props and what rendered it, which
usually says whose it is.

<a id="another-copy"></a>
### A copy from an incompatible version is already on this page

Two versions of react-inp-blame were loaded, and the second one installed nothing. Run
`npm ls react-inp-blame` to find them, and dedupe to one version.

<a id="unsupported-browser"></a>
### This browser has no Event Timing interactionId

The browser cannot say which events belong to one interaction, so nothing was installed. It needs Chrome 96,
Firefox 144 or Safari 26.2 or later. See [Browser support](../README.md#browser-support).

<a id="reinstall"></a>
### install() had already run

`install()` was called a second time with different options. Only `overlay` changes on a later call. The
other options keep the first call's values. Call `dispose()` first if you mean to change them. This often
means the library is installed twice, for example by a plugin and by your own `install()` call.

<a id="hook-disabled"></a>
### The page's DevTools hook turns React's developer tools support off

Something on the page set `__REACT_DEVTOOLS_GLOBAL_HOOK__` with `isDisabled`, or without `supportsFiber`,
before the library loaded. Packages that disable React DevTools in production do this. React then reports to
no hook, so reports come without components. Remove that script where you want blame.

<a id="shim-over-hook"></a>
### hook: 'shim' found a React DevTools hook already installed

You asked for `hook: 'shim'`, but a hook was already there: the React DevTools extension, or in Vite development the React
Fast Refresh preamble. The
library chained onto it instead, which works. Nothing to fix. Drop `hook: 'shim'` to stop the warning.

<a id="locked-out"></a>
### The DevTools hook was replaced after React registered

Another tool, often react-devtools-inline's `initialize()`, replaced `__REACT_DEVTOOLS_GLOBAL_HOOK__` after
React had registered with this library's hook. React keeps reporting to the old hook, so that tool will not
see React. Blame still works. Load that tool before react-inp-blame, or install with `hook: 'chain'`.

<a id="react-version"></a>
### react-dom is outside React 17 to 19

That react-dom's commits are not read, so its interactions are reported without components. Upgrade to
React 17, 18 or 19. Other React roots on the page are still read.

<a id="fiber-shape"></a>
### The fiber tree is not the shape this library reads

This react-dom build lays out its internals in a way the library does not know, for example a canary
or experimental React. Its commits are not read. Please open a
[wrong or missing blame](https://github.com/adityareddy-dev/react-inp-blame/issues/new?template=wrong-or-missing-blame.yml)
issue with the warning text and your react-dom version.

<a id="walk-threw"></a>
### Reading a commit threw

The library hit an error while reading React's tree, and stopped reading that react-dom. This is a bug in
the library. Please open a
[wrong or missing blame](https://github.com/adityareddy-dev/react-inp-blame/issues/new?template=wrong-or-missing-blame.yml)
issue with the warning text, your versions and, if you can, the component that was rendering.

<a id="overlay-failed"></a>
### The badge and panel could not be shown

The badge's code is a separate chunk loaded with `import()`, and that load failed. Check the network panel
for the chunk, and a `script-src` policy that blocks it. Reports still come through `onInteraction`.

<a id="overlay-draw"></a>
### The badge and panel could not be drawn

Building the badge threw. It is made from elements and text, so no Content Security Policy or Trusted Types
directive should stop it: this is a bug in the library, or a page that replaced a DOM method. Please open a
[setup problem](https://github.com/adityareddy-dev/react-inp-blame/issues/new?template=setup-problem.yml)
issue with the warning text and your browser. Reports still come through `onInteraction`.

## At build time, any setup

<a id="left-out-of-a-production-build"></a>
### Left out of this production build

`enabled` defaults to `'development'`, so a production build carries nothing from this library. The page it
serves (`vite preview`, `next start`, `astro preview` or your own server) shows no badge and makes no reports.
That is on purpose, so real visitors get none of it until you choose. To include it, pass `enabled: true` or
`enabled: 'production'`, and think about `runtime: { overlay: 'query' }`, which shows the badge only when the
URL has `?inp-blame`. To keep it out without the line, write `enabled: 'development'` yourself. The Vite plugin
and the Astro integration print the line once per build, and `withInpBlame` once per `next build`.

## At build time, Next.js

<a id="next-too-old"></a>
### Next.js is older than 14.2

`withInpBlame` left your config as it was, so nothing installs. Upgrade Next.js to 14.2 or later.

<a id="next-turbopack"></a>
### Next.js before 15.3 under Turbopack

Next.js 14.2 to 15.2 has no `instrumentation-client`, and under Turbopack it runs no `webpack()` hook, so
nothing installs the library. Run `next dev` without `--turbo`, or upgrade Next.js to 15.3 or later.

<a id="next-client-line"></a>
### Add this line to instrumentation-client.ts

On Next.js 15.3 to 16.2 the wrapper cannot load the library before React by itself. Add the line it prints to
`instrumentation-client.ts`, next to `next.config` or in `src/`. The warning stops once the file has it. See
[Install with Next.js](install.md#install-with-nextjs-142-or-later).

<a id="next-turbopack-rule"></a>
### Your config already has a Turbopack rule for the same files

Before Next.js 16 a Turbopack glob holds one rule, and your config has one for `*.{tsx,jsx}`. So under
Turbopack the names loader is left out, and a production build has minified names. webpack builds still get
it. Upgrade to Next.js 16, or add `react-inp-blame/display-names-loader` to your own rule's `loaders`.

## At build time, Vite

<a id="vite-no-page"></a>
### The install script never reaches a page

A framework that writes its own HTML, or a build with only scripts as inputs, never loads the plugin's
install script. The warning links the setup for your case: [React Router](install.md#install-with-react-router),
[Remix](install.md#install-with-remix), [TanStack Start](install.md#install-with-tanstack-start), [Astro](install.md#install-with-astro),
or [scripts only](install.md#install-with-vite).

<a id="vite-react-dom-first"></a>
### The install chunk imports a chunk that runs react-dom

A `manualChunks` or `codeSplitting` rule put react-dom where it loads before the install, so nothing is read in
that build. Keep `react-inp-blame` out of the rule, usually a `node_modules` vendor rule. With
@vitejs/plugin-legacy, keep react-dom and every library that imports it, such as Radix's Portal, out of the
vendor rule too: see [a vendor chunk](install.md#install-with-vite) for a config that works.

<a id="vite-manual-chunks"></a>
### entry needs a manualChunks function

With `entry`, the plugin gives the install its own chunk through a `manualChunks` function. Your build sorts
chunks with a `manualChunks` object, so it could not. Write your rule as a `manualChunks` function. Rolldown's
chunk groups (`codeSplitting` or `advancedChunks`, Vite 8) need nothing: the plugin adds a group of its own.

<a id="vite-module-info"></a>
### The bundler gives manualChunks no getModuleInfo

Only the install call got its own chunk, and the rest of the library goes wherever your rules put it. Keep
`react-inp-blame` out of any vendor rule.
