# react-inp-blame

Click **Log in** in the demo. The report shows a 400 ms interaction, about 399 ms in the handler, and
a React render that landed after the screen updated. INP didn't count that later render. Without the
timeline, it is easy to investigate the render and miss the handler.

react-inp-blame joins browser interaction timing to the React tree and shows where the time went,
with a component or handler name when it has one. The name can be wrong, check it against the profiler.
1.0.0 makes the API and report shape stable, with [documented exceptions](#versions). It does not
make the attribution reliable: the latest [unseen-app accuracy check](#how-reliable-is-it) is below.

![The demo's sign-in page: an email and a password typed in, a click on Log in, the badge showing the page's INP, the panel opening, and the login row expanding into the explanation](docs/media/overlay.gif)

**[Try the demo](https://adityareddy-dev.github.io/react-inp-blame/)**. Every scenario there is slow on
purpose. Click something and read what the badge blames.

## 30-second quickstart

In an existing Next.js or Vite React app:

    npm install react-inp-blame

Use the setup below for your framework, restart its dev server, then click a slow control and open the
badge. Both setups are development-only by default. Production needs an
[explicit opt-in](docs/install.md#numbers-in-development).

[Next.js](#start-with-nextjs-142-or-later) · [Vite](#start-with-vite) ·
[API reference](docs/api.md) · [Browser support](#browser-support) ·
[React and framework versions](#versions) · [web-vitals and telemetry](#send-attribution-with-inp) ·
[Benchmarks and reproduction](#benchmarks-and-reproduction)

## Start with Next.js 14.2 or later

```ts
// next.config.ts
import type { NextConfig } from "next";
import { withInpBlame } from "react-inp-blame/next";

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
export { onRouterTransitionStart } from "react-inp-blame/next-client";
```

Next.js 14.2 reads no `next.config.ts`, since that came in 15, so there the same setup goes in
`next.config.mjs`, as plain JavaScript:

```js
// next.config.mjs
import { withInpBlame } from "react-inp-blame/next";

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
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { inpBlame } from "react-inp-blame/vite";

export default defineConfig({
  plugins: [react(), inpBlame({ runtime: { overlay: true } })],
});
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

    400 ms click on button "Log in" in SignInPage. The click handler handleLogin ran for
    about 399 ms; React's own render took under 1 ms. A second React render landed 295 ms
    after the screen updated: 81 ms rendering 260 components from SignInDemo down, 241 of them
    inside ProfilePage, mostly PhotoTile (240 of the 260, 72 ms). INP doesn't count it, and
    what started it can't be told.

`overlay` takes `true` (always shown), `'query'` (shown only when the URL has `?inp-blame` or
`#inp-blame`, or `localStorage` has `react-inp-blame` set to `overlay`, which is how to open it on a
production page) or `{ position, open, max }`. In a shared repo each developer can press Hide for me in
the panel, which keeps the badge off in that browser until the page is opened with `?inp-blame`, or the
repo can use `'query'` and each developer opts in with the `localStorage` line. Both snippets above are
development-only: `enabled` defaults to `'development'`, so a production build carries nothing from
either plugin until you say `enabled: true` or `enabled: 'production'`. So `vite preview` and
`next start`, which serve a production build, show no badge by default, and the build prints a line
saying it left the library out. The line on Next.js 15.3 to 16.2 stays in every build, but compiles to
nothing in the ones `enabled` leaves out.

**Numbers in development.** It is a development tool first, so most numbers you see come from React's
development build, which is slower than production, and under `<StrictMode>` React renders every component
twice there. The badge rates what it measured on the same scale, marks the build `dev`, and the panel says to
check anything amber or red in a production build: add `enabled: true` and `runtime: { overlay: 'query' }`,
run `next build` and `next start` or `vite build` and `vite preview`, and open the page with `?inp-blame`
([Numbers in development](docs/install.md#numbers-in-development)).

If you would rather read reports than look at a badge, drop `overlay` and subscribe:

```ts
// Next.js: instrumentation-client.ts or any client module. Vite: the entry module.
import { onInteraction } from "react-inp-blame";

// A report can come again as a later revision when more data joins it: keep the latest per interactionId.
onInteraction((report) =>
  console.log(report.verdict, report.explanation.blame),
);
```

To read the whole report of the last interaction in the console, add `debugGlobal: true` to `runtime` and
run `__REACT_INP_BLAME__.last()`.

## Send attribution with INP

The [web-vitals attribution build](https://github.com/GoogleChrome/web-vitals) owns the page's INP
measurement. This library adds React context to it. For component names on the interaction target,
`generateTarget` needs no runtime installation:

```ts
import { onINP } from "web-vitals/attribution";
import { generateTarget } from "react-inp-blame/web-vitals";

onINP((metric) => console.log(metric), { generateTarget });
```

Use web-vitals 5.1 or later. Production component names need the build plugin's display-name transform.
For the whole report, `attributeINP(metric)` reads the installed library's report for that interaction.
[The integration guide](docs/web-vitals.md) covers both paths and the cases where no report is available.

Event Timing supplies the interaction's duration and phases. Long Animation Frames adds script and
forced-layout evidence on Chromium 123 and later. It does not supply React component names, and
coinciding work alone does not prove what caused it. Without that API, reports leave those details out.

For an existing OpenTelemetry web-vitals pipeline, add the processor before the processor that exports:

```ts
import { InpBlameLogRecordProcessor } from "react-inp-blame/otel";

const loggerProvider = new LoggerProvider({
  processors: [
    new InpBlameLogRecordProcessor(),
    new BatchLogRecordProcessor({ exporter }),
  ],
});
```

Here `LoggerProvider`, `BatchLogRecordProcessor` and `exporter` come from your telemetry setup.
The [complete OTLP recipe](docs/opentelemetry.md#opentelemetrys-web-sdk) includes their imports,
the exporter and instrumentation registration. Enable the library in production and sample it first,
or the processor has no reports to attach. `/otel` is experimental through 1.x, its attributes are not
standard OpenTelemetry conventions, and a component name is attribution to investigate, not proof.

## Benchmarks and reproduction

The [live demo](https://adityareddy-dev.github.io/react-inp-blame/) has deliberately slow scenarios.
For a local copy, use Node 22.18 or later, run `npm ci`, `npm run build` and `npm run dev` from this
repository, then open the address Vite prints. `npm test` runs the demo checks after
`npx playwright install chromium firefox webkit` ([contributor setup](CONTRIBUTING.md#setup)).

The [benchmark harness](bench/README.md) now selects [five everyday apps](docs/benchmarks/real-apps.md).
Their build and interaction integrations are pending, and no accuracy or overhead results exist
for this cohort. The [measurement plan](docs/benchmarks/README.md) describes the protocol and
selection amendment. The [accuracy check](#how-reliable-is-it) remains a separate historical result.

## What 1.0 means

1.0.0 keeps 0.26.0's runtime and starts the API promise in [What 1.x promises](#versions).
The API and the meanings of its report fields are stable through 1.x, apart from the documented experimental and debugging exceptions.
A minor release can improve how blame is selected and how a report reads. It cannot change what an existing field means.

The blame can still be wrong, and the count below is why 1.0.0 is not a claim of accuracy.
Read the [known limits](docs/known-limits.md) before trusting a name.

## How reliable is it

On hyperdx and kaneo, 0.25.0 was right on 8 of 62 verdicts. Of the other 54, 35 were wrong and 19 misleading.
Every verdict stayed in the count. Each was read twice, with a third read where the two disagreed on a scored axis. The [accuracy page](docs/benchmarks/real-apps.md) gives the context for this check. The bar I set for 1.0 was at least 38 right and at most 6 wrong on those 62, and it isn't met. No later version has been graded on fresh apps.

These are separate checks of what each report says.

| Check                                   | Right | Wrong | Misleading | Cannot tell | Blank |
| --------------------------------------- | ----: | ----: | ---------: | ----------: | ----: |
| Whole verdict                           |     8 |    35 |         19 |           0 |     0 |
| Name and its explanation                |     9 |    32 |         19 |           2 |     0 |
| Kind of work                            |    49 |    13 |          0 |           0 |     0 |
| Milliseconds charged to the blamed work |    36 |     0 |          0 |           0 |    26 |

Kind asks whether the named work is the biggest part of the time in the trace. The milliseconds pass
if they are within the larger of 10 ms and 20% of the trace's figure for that work. Blank means the report
gave no blame figure, so there was nothing to check on that axis. The headline duration was not a separate axis.

The name check includes the explanation and notes. A wrong name grade can also mean the verdict states
something false. Misleading means its wording is true but sends you to the wrong place. Cannot tell means
the evidence could not settle it. A wrong kind makes the whole verdict wrong, even with a right or unresolved
name grade. A right name with wrong milliseconds, or a name that points at an ancestor after the component
walk stopped at its budget, cannot make the whole verdict right.

Here is the same count split by app and run settings.

Overall cells read right / wrong / misleading. Name cells add cannot tell as the last count. Kind cells read right / wrong / misleading. Milliseconds cells add blank as the last count. The kind and milliseconds axes do not permit misleading, their zeros reflect the rubric. Each row includes every verdict in that group. The marginal rows overlap, the eight app/build/throttle rows partition all 62. `dev` means development and `prod` means production. `1x` means no CPU throttling and `4x` means 4x CPU throttling.

| Group           | Verdicts | Overall     | Name            | Kind        | Milliseconds    |
| --------------- | -------: | ----------- | --------------- | ----------- | --------------- |
| All             |       62 | 8 / 35 / 19 | 9 / 32 / 19 / 2 | 49 / 13 / 0 | 36 / 0 / 0 / 26 |
| hyperdx         |       39 | 6 / 19 / 14 | 6 / 19 / 14 / 0 | 37 / 2 / 0  | 16 / 0 / 0 / 23 |
| kaneo           |       23 | 2 / 16 / 5  | 3 / 13 / 5 / 2  | 12 / 11 / 0 | 20 / 0 / 0 / 3  |
| dev             |       30 | 6 / 12 / 12 | 6 / 12 / 12 / 0 | 25 / 5 / 0  | 27 / 0 / 0 / 3  |
| prod            |       32 | 2 / 23 / 7  | 3 / 20 / 7 / 2  | 24 / 8 / 0  | 9 / 0 / 0 / 23  |
| 1x              |       28 | 7 / 13 / 8  | 8 / 12 / 8 / 0  | 22 / 6 / 0  | 13 / 0 / 0 / 15 |
| 4x              |       34 | 1 / 22 / 11 | 1 / 20 / 11 / 2 | 27 / 7 / 0  | 23 / 0 / 0 / 11 |
| hyperdx dev 1x  |       11 | 4 / 3 / 4   | 4 / 3 / 4 / 0   | 11 / 0 / 0  | 8 / 0 / 0 / 3   |
| hyperdx dev 4x  |        6 | 0 / 3 / 3   | 0 / 3 / 3 / 0   | 6 / 0 / 0   | 6 / 0 / 0 / 0   |
| hyperdx prod 1x |       10 | 1 / 6 / 3   | 1 / 6 / 3 / 0   | 8 / 2 / 0   | 0 / 0 / 0 / 10  |
| hyperdx prod 4x |       12 | 1 / 7 / 4   | 1 / 7 / 4 / 0   | 12 / 0 / 0  | 2 / 0 / 0 / 10  |
| kaneo dev 1x    |        5 | 2 / 2 / 1   | 2 / 2 / 1 / 0   | 3 / 2 / 0   | 5 / 0 / 0 / 0   |
| kaneo dev 4x    |        8 | 0 / 4 / 4   | 0 / 4 / 4 / 0   | 5 / 3 / 0   | 8 / 0 / 0 / 0   |
| kaneo prod 1x   |        2 | 0 / 2 / 0   | 1 / 1 / 0 / 0   | 0 / 2 / 0   | 0 / 0 / 0 / 2   |
| kaneo prod 4x   |        8 | 0 / 8 / 0   | 0 / 6 / 0 / 2   | 4 / 4 / 0   | 7 / 0 / 0 / 1   |

The kind of work was right more often than the name. Names were wrong on 32 verdicts and misleading on 19. Two were unresolved. All 36 supplied blame figures passed the timing tolerance, but 26 verdicts supplied
none. In production, 23 of 32 supplied none. Passing that timing check does not show that the named component
caused the time.

The graders also recorded their confidence and where evidence was missing. The grade files behind these tables are not in this repo.

Capped ancestor means a production verdict whose component walk stopped at its budget and named an ancestor of the work. It is a flag, not a correctness grade. Reader confidence belongs to the selected grade, not the report's measured/inferred confidence. An evidence gap is a recorded limitation, not an automatic failure. These fields have no right/wrong/misleading grades.

| Group           | Verdicts | Capped ancestor: yes / no | Reader confidence: high / medium / low | Evidence gap: recorded / none |
| --------------- | -------: | ------------------------- | -------------------------------------- | ----------------------------- |
| All             |       62 | 1 / 61                    | 25 / 36 / 1                            | 50 / 12                       |
| hyperdx         |       39 | 1 / 38                    | 17 / 21 / 1                            | 37 / 2                        |
| kaneo           |       23 | 0 / 23                    | 8 / 15 / 0                             | 13 / 10                       |
| dev             |       30 | 0 / 30                    | 12 / 18 / 0                            | 19 / 11                       |
| prod            |       32 | 1 / 31                    | 13 / 18 / 1                            | 31 / 1                        |
| 1x              |       28 | 1 / 27                    | 11 / 16 / 1                            | 25 / 3                        |
| 4x              |       34 | 0 / 34                    | 14 / 20 / 0                            | 25 / 9                        |
| hyperdx dev 1x  |       11 | 0 / 11                    | 6 / 5 / 0                              | 10 / 1                        |
| hyperdx dev 4x  |        6 | 0 / 6                     | 2 / 4 / 0                              | 5 / 1                         |
| hyperdx prod 1x |       10 | 1 / 9                     | 4 / 5 / 1                              | 10 / 0                        |
| hyperdx prod 4x |       12 | 0 / 12                    | 5 / 7 / 0                              | 12 / 0                        |
| kaneo dev 1x    |        5 | 0 / 5                     | 1 / 4 / 0                              | 3 / 2                         |
| kaneo dev 4x    |        8 | 0 / 8                     | 3 / 5 / 0                              | 1 / 7                         |
| kaneo prod 1x   |        2 | 0 / 2                     | 0 / 2 / 0                              | 2 / 0                         |
| kaneo prod 4x   |        8 | 0 / 8                     | 4 / 4 / 0                              | 7 / 1                         |

The reasons and trace measurements are supporting evidence, they have no separate accuracy grade. There
is no separate score for every component count or later-render note, those claims affect the name grade.

All eight right verdicts were clicks. Six were in development and two in production.
Seven were unthrottled.
Five named a render subtree. The two Denoise Results clicks named DBSqlRowTable, and the two workspace-menu
openings named MenuPositioner. One navigation expansion named AppNav. The grade reasons place the work inside those subtrees.
The other three correctly named no culprit for the interaction. They are not three slow components found.

Seven of the eight right verdicts still have a recorded evidence gap. Some exact component counts and the
precise hot function inside DBSqlRowTable remain unverified in the grade reasons.

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
carries the page's origin and path and the label of the element you clicked, so read it through before you
paste it.

These reports are how the blame gets better. If the console printed a warning instead, it ends with a link to
its entry under [Troubleshooting](#troubleshooting).

---

## Compared with other tools

|                                                         | react-inp-blame                                                                   | Sentry `reactComponentAnnotation` | react-scan                         | web-vitals attribution | React 19.2 Performance tracks        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------- | ---------------------- | ------------------------------------ |
| Runs in a production build                              | optional¹                                                                         | yes                               | not its main entry²                | yes                    | no: development and profiling builds |
| Names the rendered subtree, not just the target's owner | yes                                                                               | no³                               | yes                                | no: a CSS selector     | yes, in development⁴                 |
| Follow-up renders after the paint                       | yes                                                                               | no                                | not told apart⁵                    | no                     | drawn, not joined to the interaction |
| Forced-layout split                                     | yes, from Long Animation Frames, and it can be the verdict rather than a footnote | no                                | no: reads no Long Animation Frames | partly⁶                | no                                   |
| Plain-language verdict                                  | yes                                                                               | no                                | no                                 | no                     | no                                   |
| Zero dependencies                                       | yes                                                                               | no                                | no (11 in 0.5.7)                   | yes                    | part of React                        |
| Needs a build step for names                            | in production builds: the plugins add it                                          | yes                               | not in development⁷                | no names               | not in development                   |

1. Its main entry does not start when every React renderer on the page is a production build, unless `dangerouslyForceRunInProduction` is set, which its README calls "not recommended". Two other entries in 0.5.7 run there anyway: `react-scan/all-environments` skips that check, and `react-scan/lite`, a headless one, attaches to every renderer whatever its build.
2. Its build step puts `data-sentry-component` on the outermost element each component returns. Since 11.0.0 the SDK, with span streaming (its default), names an INP span after the first of those on the target or its four nearest ancestors, or `Click` or `Key press` when there is none, and keeps the DOM path in `browser.web_vital.inp.target`.
3. Profiling builds list only components under a `<Profiler>`, or every component with the React Developer Tools extension enabled.
4. It keeps every fiber render from the pointerup or keydown as one set, until the interaction's Event Timing entry arrives or a second after the frame that follows the input.
5. `totalStyleAndLayoutDuration`, and `longestScript.entry`, which carries `forcedStyleAndLayoutDuration`.
6. It ships bundler plugins under `react-scan/react-component-name/*`; what they match was not checked.

Checked on 2026-09-26 against aidenybai/react-scan at 0fb3186 (0.5.7 on npm), getsentry/sentry-javascript at
bd3ce5f (11.0.0), reactjs/react.dev at 44b0b5f and web-vitals 6.2.2's types. In development, React's Components track is the
better source of per-component durations, and react-scan's notifications already tie a slow interaction to the components
that rendered for it. Its `all-environments` entry starts the same tracking in a production build. What this library adds
is Long Animation Frames' forced layout inside that join, in either build, and the sentence.

## Browser support

|                                                  | Chromium | Firefox | Safari |
| ------------------------------------------------ | -------- | ------- | ------ |
| Event Timing `interactionId` (required)          | 96       | 144     | 26.2   |
| Long Animation Frames: scripts and forced layout | 123      | no      | no     |
| Performance panel tracks                         | 128      | no      | no     |

Without `interactionId` nothing installs and `stats().mode` is `'unsupported'`. One warning says why: always in
a development build, and in a production build on the pages `sampleRate` takes. A production page the sample
leaves out prints nothing, so a tool that forwards console warnings gets no event from it. Without Long
Animation Frames, `frames` and `laterFrames` are `null` and the explanation leaves out the forced-layout and
script sentences. On a page without cross-origin isolation, Playwright's Firefox 148 and WebKit 26.4 step
`performance.now()` in whole milliseconds, too coarse to time a quick component: when eight or more of a
commit's components are timed, every one reads a whole millisecond and they average under 4 ms, the report
leaves their times out and blame built on render times is `'inferred'`.

## Versions

|                                              | CI runs                                                                                     | Outside that                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| react-dom                                    | 17.0.2, 18.2.0, 18.3.1, 19.0.0, 19.1.9, 19.2.8, 19.3.0, and the canary `next@canary` brings | Outside 17 to 19 that root is not read, and [one warning](docs/troubleshooting.md#react-version) says so |
| Next.js                                      | 14.2.35, 15.3.9, 15.5.26, 16.2.12, 16.3.5 and canary                                        | Below 14.2 the wrapper leaves the config as it was and [says why](docs/troubleshooting.md#next-too-old)  |
| Vite                                         | 6.4, 7.3 and 8.3; a build on Vite 5                                                         | Not tried below 5                                                                                        |
| React Router, Remix, TanStack Start          | React Router 7.18 and 8.4, Remix 2.17 on Vite, TanStack Start 1.168                         | Not tried                                                                                                |
| Astro                                        | 7.3                                                                                         | Not tried                                                                                                |
| [webpack](docs/install.md#webpack-or-rspack) | 5.111                                                                                       | Not tried                                                                                                |
| Node, for the build plugins                  | Installs and loads on 20.19, tests on 22 and 24                                             | `engines` asks for 20.19                                                                                 |

The peer dependencies are all `*` and optional, on purpose. npm refuses to install beside a prerelease that a
range leaves out, even for an optional peer, and `next@canary` or a React canary is a prerelease of a version no
range written today can name. So a real range would stop those installs with an ERESOLVE error, where the library
itself says what is wrong: the Next.js wrapper checks the version at build time, and `install()` checks each
react-dom as it registers.

**Under Jest.** The package is ES modules only, and Jest's default runtime loads everything as CommonJS, so a
test that reaches it fails with "Cannot use import statement outside a module" (from Jest 30.5, "Must use import
to load ES Module") unless Jest compiles it first. With `next/jest`, add `transpilePackages: ['react-inp-blame']`
to your Next.js config. Anywhere else, install `@babel/preset-env@7`, since Jest is on Babel 7, and add these two
keys to the Jest config:

```js
transform: {
  '\\.[jt]sx?$': ['babel-jest', { presets: [['@babel/preset-env', { targets: { node: 'current' } }]] }],
},
transformIgnorePatterns: ['/node_modules/(?!(.pnpm/)?react-inp-blame[@/])'],
```

The pattern lets Jest hand the package to babel-jest in npm's `node_modules` and in pnpm's, and the presets have
babel-jest turn `import` and `export` into `require`, which it does not do on its own. `'\\.[jt]sx?$'` is the key
Jest gives babel-jest where a config sets no `transform`, so your own files still go to it. The presets go here
rather than in a Babel config file: Babel never reads a `.babelrc` or a `babel` key in `package.json` for a file
in `node_modules`, and Next.js builds the app with any Babel config file it finds, in place of its own compiler,
so one that holds only these presets breaks `next build`. Where the Jest config already has a
`transformIgnorePatterns`, put `react-inp-blame` inside its `(?!...)` rather than adding a second pattern, since
Jest leaves a file uncompiled when any one of them matches. Where the config or its preset already sets a
`transform`, give the presets to its babel-jest entry, or where no entry takes `.js` files, as under ts-jest, add
the one above with `'\\.jsx?$'` as its key: Jest runs a file through the first entry whose key matches, so one
for `.ts` files as well would take them from ts-jest. Jest 30.5's error also offers Node 24.9 or later, but there
Jest loads the package as it is only from Jest 30.4 and only when run with
`NODE_OPTIONS=--experimental-vm-modules`; on Node 20 and 22, or an older Jest, not even then. CI checks all of it
on Jest 30, ts-jest 29, the Next.js `apps/next-demo` pins and Node 20.19, except a pnpm install, the `babel` key
and the flag on Node 24.19 and on older Jest, which were checked by hand.

**What 1.x promises.** From 1.0.0 the package follows semantic versioning. That covers every export and the
options it takes, and the shape of a report. Only a major release removes or renames an export, an entry point,
an option or a report field, changes what a field holds or what an option does, changes a default, adds a value
to one of the [fixed sets of strings](docs/api.md#fixed-sets-of-strings), or drops a version the table above
lists, except a Node line past its end of life. `schemaVersion` stays where 1.0.0 has it for all of 1.x, on a
report and on the `react` object that `react-inp-blame/web-vitals`' `attributeINP` adds.

A minor release can add exports, options, report fields and entry points. It can also change how a report reads
an interaction: which kind, name and detail its blame gets, which components a report and `generateTarget` name,
and any display text. That is how the verdict gets better. Display text is `headline`, `where`, `cause`, `notes`,
the phases' `label` and `hint`, `verdict`, `blame.detail`, the words of `target.label`, console warnings, the
Performance panel's entries, and the badge and panel. Show it, never parse it. What each kind means stays the
same through 1.x ([Blame](docs/api.md#interactionreport)), and so does what each `labels` value may read. Each
release's notes list its blame changes under a heading of their own, so a dashboard that groups by kind or name
knows what moved.

A patch release fixes bugs and security problems. It changes a blame only to undo a regression from the release
before, and its notes list that too.

Minor releases come at most once every two weeks. Anything deprecated keeps working through at least one minor,
marked `@deprecated` and, where it runs, with a warning in development builds. Only a major removes it. From
1.0.0, security fixes go into the latest minor, and into the minor before it for 90 days after the latest came
out ([SECURITY.md](SECURITY.md#versions)). Once 2.0.0 is out, the last 1.x minor counts as the one before it.

`react-inp-blame/otel` is experimental. Its export names and the attribute names it sends can change in any minor,
1.x included, until OpenTelemetry names these fields, and the CHANGELOG says so when they do. `api.debug` can
change in any release. So can bundle size and the library's own time.

**Support window.** 1.x supports what the table above lists at 1.0.0. A new major of React, Next.js, Vite or Astro
comes in a minor, once CI runs it. The build plugins run on Node 20.19 and later at 1.0.0. A minor can drop a
Node line once it is past its end of life upstream, and the CHANGELOG says so under Changed. A patch never drops
one. Dropping anything else the table lists waits for 2.0.0. The canaries run in CI every day but are not
supported: a canary can break the library, and the fix comes in an ordinary release.

Load one copy of the library per page. Two copies from different releases may refuse to share it, and the second
says so in the console ([another-copy](#another-copy)).

CI keeps a copy of the type declarations each entry point publishes, `/otel`'s included, and fails when a build's
differ from it. No change to the surface goes out unseen, and the pull request that makes one says why.

## What it costs

It is a development tool first, and running it in production is optional: this is what it costs where it
runs. On two of the demo's scenarios, a click that re-renders 801 components and a keystroke that re-renders
1441, the library's own time was 1.3 to 3.4 ms per interaction at the median and 3.8 ms at worst at p95, in
production and development builds ([how that was measured](docs/how-it-works.md#time-per-interaction)). With
`enabled` at its default, neither plugin adds anything to a production build (on Next.js 15.3 to 16.2 the
line's module stays, as an empty function); where it loads:

<!-- size:start -->
| Bundle (rolldown 1.2.8, minified ESM, gzip at zlib's default level) | Minified | Gzip |
| --- | --- | --- |
| `react-inp-blame/auto`: everything that loads with the page | 101.3 KB | 35.8 KB |
| The badge and panel, a chunk loaded by `import()` only when shown | 18.1 KB | 7.1 KB |
| Of `/auto`, what has to run before react-dom: the hook, the fiber reading, the observers | 32.3 KB | 11.7 KB |
| `react-inp-blame/web-vitals`, on top of `/auto` | 1.6 KB | 0.9 KB |
| `react-inp-blame/otel`, on top of `/auto` | 3.5 KB | 1.6 KB |
<!-- size:end -->

`node scripts/size.mjs` measures these from the build on every CI run, and CI fails when this table is out
of date or a size passes its budget in `scripts/size-budget.json`. The table before 0.8.0 said 39.0 and
14.4 KB for `/auto`, figures from 0.1.0 that had not been measured again as the entry grew.

## Labels and personal data

Reports are made to be forwarded to error trackers and analytics, so `target.label` never reads a form field's
value, and under a production build of React it uses only what your code wrote on the element (`aria-label`, a
form field's `placeholder`, `aria-placeholder` or `name`, an input's `type`, `data-testid` or `data-test`). An
element's text is opt-in there, with `labels: 'text'`. What your code wrote goes out as written, though: an
`aria-label`, `data-testid` or `id` built from user data, such as ``aria-label={`Message ${user.name}`}``,
lands in `target.label` or `target.selector`, and the label in the verdict. A URL in a report keeps its origin
and path, never its query, fragment or password, and a script's URL in a blame loses the same. The details are
under [labels and personal data](docs/api.md#labels-and-personal-data) in the API page. Each report also goes out
as a User Timing measure, with its verdict and label in the entry's `detail`, under a development build of React
unless [`devtoolsTrack`](docs/api.md#installoptions) is `false`, and under any build where it is `true`. Any
`PerformanceObserver` on the page sees it, a monitoring script that collects measures included. Everything it
reads, changes and keeps on a page is in [SECURITY.md](SECURITY.md#what-it-touches).

## Documentation

The [docs](docs/README.md) have the rest.

- **Install**, every setup in full: <a id="install-with-nextjs-142-or-later"></a>[Next.js](docs/install.md#install-with-nextjs-142-or-later),
  <a id="install-with-vite"></a>[Vite](docs/install.md#install-with-vite), <a id="install-with-react-router"></a>[React Router](docs/install.md#install-with-react-router),
  <a id="install-with-remix"></a>[Remix](docs/install.md#install-with-remix), <a id="install-with-tanstack-start"></a>[TanStack Start](docs/install.md#install-with-tanstack-start),
  <a id="install-with-astro"></a>[Astro](docs/install.md#install-with-astro), [webpack or Rspack](docs/install.md#webpack-or-rspack),
  and a Vite build with [no HTML page](docs/install.md#no-html-page-in-the-build) (Laravel, Rails, Django).
- <a id="with-web-vitals"></a>**[With web-vitals](docs/web-vitals.md)**: the React side added to web-vitals' INP attribution,
  <a id="sending-it-to-sentry"></a>[sent to Sentry](docs/web-vitals.md#sending-it-to-sentry) or <a id="sending-it-to-google-analytics-4"></a>[to GA4](docs/web-vitals.md#sending-it-to-google-analytics-4).
- <a id="with-opentelemetry"></a>**[With OpenTelemetry](docs/opentelemetry.md)**, experimental: the blame added to the INP event OpenTelemetry,
  Honeycomb, Elastic, Embrace or Grafana Faro already sends.
- <a id="api"></a>**[API](docs/api.md)**: `onInteraction`, <a id="installoptions"></a>[`install(options)`](docs/api.md#installoptions),
  <a id="interactionreport"></a>[every field of a report](docs/api.md#interactionreport) and <a id="the-badge-and-panel"></a>[the badge and panel](docs/api.md#the-badge-and-panel).
- <a id="reference"></a>**[How it works](docs/how-it-works.md)**: <a id="clicks-that-land-before-hydration"></a>[clicks before hydration](docs/how-it-works.md#clicks-that-land-before-hydration),
  <a id="the-inp-estimate"></a>[the INP estimate](docs/how-it-works.md#the-inp-estimate), <a id="what-it-reads-from-react"></a>[what it reads from React](docs/how-it-works.md#what-it-reads-from-react)
  and its own [time per interaction](docs/how-it-works.md#time-per-interaction).
- <a id="known-limits"></a>**[Known limits](docs/known-limits.md)**: what it can't see, and where it has to guess. Worth reading before
  you trust a verdict on a big app.
- [Benchmarks](docs/benchmarks/README.md) on real open-source apps, and the [design notes](docs/interaction-attribution-design.md).

## Troubleshooting

Each warning the library prints ends with a link into this README. Most land on their line below, which
opens the answer in [docs/troubleshooting.md](docs/troubleshooting.md); the Vite plugin's setup advice lands
on its setup under [Documentation](#documentation). To see whether the library installed at all, and why not,
add `debugGlobal: true` and read `__REACT_INP_BLAME__.stats()`. If your problem is not listed, open a
[setup problem](https://github.com/adityareddy-dev/react-inp-blame/issues/new?template=setup-problem.yml) issue
with the warning text.

<a id="in-the-browser"></a>In the browser:

- <a id="late-install"></a>[install() ran after a React root had already rendered](docs/troubleshooting.md#late-install)
- <a id="no-renderer"></a>[React has rendered, but no react-dom has registered](docs/troubleshooting.md#no-renderer)
- <a id="minified-names"></a>[Most component names are one or two characters](docs/troubleshooting.md#minified-names)
- <a id="frames-without-scripts"></a>[Long Animation Frames on this page list no scripts](docs/troubleshooting.md#frames-without-scripts)
- <a id="another-copy"></a>[A copy from an incompatible version is already on this page](docs/troubleshooting.md#another-copy)
- <a id="unsupported-browser"></a>[This browser has no Event Timing interactionId](docs/troubleshooting.md#unsupported-browser)
- <a id="reinstall"></a>[install() had already run](docs/troubleshooting.md#reinstall)
- <a id="hook-disabled"></a><a id="hook-locked"></a>[The page's DevTools hook turns React's developer tools support off](docs/troubleshooting.md#hook-disabled)
- <a id="shim-over-hook"></a>[hook: 'shim' found a React DevTools hook already installed](docs/troubleshooting.md#shim-over-hook)
- <a id="locked-out"></a>[The DevTools hook was replaced after React registered](docs/troubleshooting.md#locked-out)
- <a id="react-version"></a>[react-dom is outside React 17 to 19](docs/troubleshooting.md#react-version)
- <a id="fiber-shape"></a>[The fiber tree is not the shape this library reads](docs/troubleshooting.md#fiber-shape)
- <a id="walk-threw"></a>[Reading a commit threw](docs/troubleshooting.md#walk-threw)
- <a id="library-error"></a>[An error inside the library was caught](docs/troubleshooting.md#library-error)
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
