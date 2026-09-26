# react-inp-blame

When a click, tap or key press in your React app is slow, this names the component or the handler behind
it and says where the time went.

![The demo's sign-in page: an email and a password typed in, a click on Log in, the badge showing the page's INP, the panel opening, and the login row expanding into the explanation](docs/media/overlay.gif)

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
never sees on its own, so each has a setup of its own: [React Router](docs/install.md#install-with-react-router),
[Remix](docs/install.md#install-with-remix), [TanStack Start](docs/install.md#install-with-tanstack-start), [Astro](docs/install.md#install-with-astro).

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
    after the screen updated: 84 ms mounting 256 components from SignInDemo down, 241 of them
    inside ProfilePage, mostly PhotoTile (240 of the 256, 73 ms). INP doesn't count it, but
    people still wait for it.

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

<a id="reporting-a-wrong-blame"></a>

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

These reports are how the blame gets better. If the console printed a warning instead, it ends with a link to
its entry under [Troubleshooting](#troubleshooting).

---

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
3. Its build step puts `data-sentry-component` on the outermost element each component returns. Since 11.0.0 the SDK names an INP span after the first of those on the target or its four nearest ancestors, or `Click` or `Key press` when there is none, and keeps the DOM path in `browser.web_vital.inp.target`.
4. Profiling builds list only components under a `<Profiler>`, or every component with the React Developer Tools extension enabled.
5. It keeps every fiber render from the pointerup or keydown as one set, until the interaction's Event Timing entry arrives or a second after the frame that follows the input.
6. `totalStyleAndLayoutDuration`, and `longestScript.entry`, which carries `forcedStyleAndLayoutDuration`.
7. It ships bundler plugins under `react-scan/react-component-name/*`; what they match was not checked.

Checked on 2026-09-26 against aidenybai/react-scan at 0fb3186 (0.5.7 on npm), getsentry/sentry-javascript at
bd3ce5f (11.0.0), reactjs/react.dev at 44b0b5f and web-vitals 6.2.2's types. In development, React's Components track is the
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

## Versions

| | CI runs | Outside that |
| --- | --- | --- |
| react-dom | 17.0.2, 18.2.0, 18.3.1, 19.0.0, 19.1.9, 19.2.8, 19.3.0, and the canary `next@canary` brings | Outside 17 to 19 that root is not read, and [one warning](docs/troubleshooting.md#react-version) says so |
| Next.js | 14.2.35, 15.3.9, 15.5.26, 16.2.12, 16.3.5 and canary | Below 14.2 the wrapper leaves the config as it was and [says why](docs/troubleshooting.md#next-too-old) |
| Vite | 6.4, 7.3 and 8.3; a build on Vite 5 | Not tried below 5 |
| React Router, Remix, TanStack Start | React Router 7.18 and 8.4, Remix 2.17 on Vite, TanStack Start 1.168 | Not tried |
| Astro | 7.3 | Not tried |
| webpack | 5.111 | Not tried |
| Node, for the build plugins | Installs and loads on 20.19, tests on 22 and 24 | `engines` asks for 20.19 |

The peer dependencies are all `*` and optional, on purpose. npm refuses to install beside a prerelease that a
range leaves out, even for an optional peer, and `next@canary` or a React canary is a prerelease of a version no
range written today can name. So a real range would stop those installs with an ERESOLVE error, where the library
itself says what is wrong: the Next.js wrapper checks the version at build time, and `install()` checks each
react-dom as it registers.

**What a release can change while on 0.x.** A minor release, 0.14.0 after 0.13.0, can break things: remove or
rename an export or an option, change what a report field holds, or raise an oldest version in the table. The
CHANGELOG says which under Changed or Removed, and `schemaVersion` on a report moves when a field is removed or
changes meaning. A patch release only fixes. From 1.0.0 on, those changes wait for 2.0.0.

Which component a report blames, and the sentence that explains it, can change in any release, a patch
included, as the verdict gets better. Don't key alerts or dashboards on the wording, or expect the same click to
be blamed on the same component after an upgrade. Fixes, security ones included, go into the latest release on
npm only ([SECURITY.md](SECURITY.md)).

## What it costs

On the demo's two heaviest scenarios the library's own time was 1.3 to 3.4 ms per interaction at the median and
3.8 ms at worst at p95, in production and development builds ([how that was
measured](docs/how-it-works.md#time-per-interaction)). With `enabled` at its default, neither plugin adds
anything to a production build (on Next.js 15.3 to 16.2 the line's module is the exception, shipped unused);
where it loads:

<!-- size:start -->
| Bundle (rolldown 1.2.8, minified ESM, gzip at zlib's default level) | Minified | Gzip |
| --- | --- | --- |
| `react-inp-blame/auto`: everything that loads with the page | 70.5 KB | 25.1 KB |
| The badge and panel, a chunk loaded by `import()` only when shown | 15.1 KB | 5.9 KB |
| Of `/auto`, what has to run before react-dom: the hook, the fiber reading, the observers | 25.2 KB | 9.5 KB |
| `react-inp-blame/web-vitals`, on top of `/auto` | 1.4 KB | 0.7 KB |
<!-- size:end -->

`node scripts/size.mjs` measures these from the build on every CI run, and CI fails when this table is out
of date or a size passes its budget in `scripts/size-budget.json`. The table before 0.8.0 said 39.0 and
14.4 KB for `/auto`, figures from 0.1.0 that had not been measured again as the entry grew.

On four open-source apps, built with and without it, 15 paired runs each unthrottled and at 4x CPU:
[docs/benchmarks](docs/benchmarks/README.md). INP did not move on any of them. On a Next.js site
with thousands of components, page load took about 75 ms longer unthrottled, most likely from the
name stamps. A second run on five apps with 0.12.0 from npm,
[docs/benchmarks/real-apps.md](docs/benchmarks/real-apps.md), found INP flat again. Page load on that
same site was about 209 ms longer unthrottled that time (the interval runs from 73 to 254), and on
twenty, where a commit is close to 5,000 components, reading them cost about 5 ms inside each
interaction, 10 at 4x.

## Labels and personal data

Reports are made to be forwarded to error trackers and analytics, so `target.label` never reads a form field's
value, and under a production build of React it uses only what your code wrote on the element (`aria-label`,
a form field's `placeholder`, `name` or `type`, `data-testid` or `data-test`). An element's text is opt-in there,
with `labels: 'text'`. URLs are kept whole, query string included. The details are under
[labels and personal data](docs/api.md#labels-and-personal-data) in the API page.

## Documentation

The [docs](docs/README.md) have the rest.

- **Install**, every setup in full: <a id="install-with-nextjs-142-or-later"></a>[Next.js](docs/install.md#install-with-nextjs-142-or-later),
  <a id="install-with-vite"></a>[Vite](docs/install.md#install-with-vite), <a id="install-with-react-router"></a>[React Router](docs/install.md#install-with-react-router),
  <a id="install-with-remix"></a>[Remix](docs/install.md#install-with-remix), <a id="install-with-tanstack-start"></a>[TanStack Start](docs/install.md#install-with-tanstack-start)
  and <a id="install-with-astro"></a>[Astro](docs/install.md#install-with-astro).
- <a id="with-web-vitals"></a>**[With web-vitals](docs/web-vitals.md)**: the React side added to web-vitals' INP attribution,
  <a id="sending-it-to-sentry"></a>[sent to Sentry](docs/web-vitals.md#sending-it-to-sentry) or <a id="sending-it-to-google-analytics-4"></a>[to GA4](docs/web-vitals.md#sending-it-to-google-analytics-4).
- <a id="api"></a>**[API](docs/api.md)**: `onInteraction`, <a id="installoptions"></a>[`install(options)`](docs/api.md#installoptions),
  <a id="interactionreport"></a>[every field of a report](docs/api.md#interactionreport) and <a id="the-badge-and-panel"></a>[the badge and panel](docs/api.md#the-badge-and-panel).
- <a id="reference"></a>**[How it works](docs/how-it-works.md)**: <a id="clicks-that-land-before-hydration"></a>[clicks before hydration](docs/how-it-works.md#clicks-that-land-before-hydration),
  <a id="the-inp-estimate"></a>[the INP estimate](docs/how-it-works.md#the-inp-estimate), <a id="what-it-reads-from-react"></a>[what it reads from React](docs/how-it-works.md#what-it-reads-from-react)
  and its own [time per interaction](docs/how-it-works.md#time-per-interaction).
- <a id="known-limits"></a>**[Known limits](docs/known-limits.md)**: what it can't see, and where it has to guess. Worth reading before
  you trust a verdict on a big app.
- [Benchmarks](docs/benchmarks/README.md) on real open-source apps, and the [design notes](docs/interaction-attribution-design.md).

## Troubleshooting

Each warning the library prints ends with a link to its line below, which opens the answer in
[docs/troubleshooting.md](docs/troubleshooting.md). To see whether the library installed at all, and why not,
add `debugGlobal: true` and read `__REACT_INP_BLAME__.stats()`. If your problem is not listed, open a
[setup problem](https://github.com/adityareddy-dev/react-inp-blame/issues/new?template=setup-problem.yml) issue
with the warning text.

<a id="in-the-browser"></a>In the browser:

- <a id="late-install"></a>[install() ran after a React root had already rendered](docs/troubleshooting.md#late-install)
- <a id="no-renderer"></a>[React has rendered, but no react-dom has registered](docs/troubleshooting.md#no-renderer)
- <a id="minified-names"></a>[Most component names are one or two characters](docs/troubleshooting.md#minified-names)
- <a id="another-copy"></a>[A copy from an incompatible version is already on this page](docs/troubleshooting.md#another-copy)
- <a id="unsupported-browser"></a>[This browser has no Event Timing interactionId](docs/troubleshooting.md#unsupported-browser)
- <a id="reinstall"></a>[install() had already run](docs/troubleshooting.md#reinstall)
- <a id="hook-disabled"></a>[The page's DevTools hook turns React's developer tools support off](docs/troubleshooting.md#hook-disabled)
- <a id="shim-over-hook"></a>[hook: 'shim' found a React DevTools hook already installed](docs/troubleshooting.md#shim-over-hook)
- <a id="locked-out"></a>[The DevTools hook was replaced after React registered](docs/troubleshooting.md#locked-out)
- <a id="react-version"></a>[react-dom is outside React 17 to 19](docs/troubleshooting.md#react-version)
- <a id="fiber-shape"></a>[The fiber tree is not the shape this library reads](docs/troubleshooting.md#fiber-shape)
- <a id="walk-threw"></a>[Reading a commit threw](docs/troubleshooting.md#walk-threw)
- <a id="overlay-failed"></a>[The badge and panel could not be shown](docs/troubleshooting.md#overlay-failed)
- <a id="overlay-draw"></a>[The badge and panel could not be drawn](docs/troubleshooting.md#overlay-draw)

<a id="at-build-time-any-setup"></a>At build time, any setup:

- <a id="left-out-of-a-production-build"></a>[Left out of this production build](docs/troubleshooting.md#left-out-of-a-production-build)

<a id="at-build-time-nextjs"></a>At build time, Next.js:

- <a id="next-too-old"></a>[Next.js is older than 14.2](docs/troubleshooting.md#next-too-old)
- <a id="next-turbopack"></a>[Next.js before 15.3 under Turbopack](docs/troubleshooting.md#next-turbopack)
- <a id="next-client-line"></a>[Add this line to instrumentation-client.ts](docs/troubleshooting.md#next-client-line)
- <a id="next-turbopack-rule"></a>[Your config already has a Turbopack rule for the same files](docs/troubleshooting.md#next-turbopack-rule)

<a id="at-build-time-vite"></a>At build time, Vite:

- <a id="vite-no-page"></a>[The install script never reaches a page](docs/troubleshooting.md#vite-no-page)
- <a id="vite-react-dom-first"></a>[The install chunk imports a chunk that runs react-dom](docs/troubleshooting.md#vite-react-dom-first)
- <a id="vite-manual-chunks"></a>[entry needs a manualChunks function](docs/troubleshooting.md#vite-manual-chunks)
- <a id="vite-module-info"></a>[The bundler gives manualChunks no getModuleInfo](docs/troubleshooting.md#vite-module-info)

---

[Docs](docs/README.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · MIT license
