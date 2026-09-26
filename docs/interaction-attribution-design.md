# Interaction attribution for React: design notes

Status, 2026-09-22: 0.2.0 is the latest on npm, published on 2026-09-20 through trusted publishing,
and main has unreleased changes, listed under [Unreleased] in `CHANGELOG.md`.

Status at 0.1.0, 2026-09-17: published from the `v0.1.0` tag with provenance. On 7917366 the
Playwright suites were green against React 19.3 in development and production builds, 18.3.1 and
17.0.2 (legacy root), and Next.js 16.3.5 under `next dev` and its Turbopack and webpack production
builds. Since the prototype of 2026-09-12, the changes are these:

- 612601c: a commit joins an interaction on `Event.timeStamp` through a ring of
  the last 8 inputs, with wall-clock overlap kept only as a flagged fallback; the headline is the
  longest single Event Timing entry, with entries grouped by paint as web-vitals groups them and the
  span from press to release kept apart as `holdMs`; the page's INP is estimated in the library; and
  the unit tests begin. 6f0bb07 then observes the page's first input as a `first-input` entry, so a
  first click that paints in under 16 ms still gets its later render reported.
- b211fa9: the shim has no `checkDCE`; `install({ hook })` chooses between
  chaining onto a hook and creating one; `dispose()` puts a chained hook back; nothing installs
  without Event Timing's `interactionId`; a react-dom outside React 17 to 19, or a root of another
  shape, turns the walk off; only react-dom commits are walked; durations are read from
  `ProfileMode`; and `frames` is `null` without Long Animation Frames, checked in Firefox and WebKit.
- 81efbbb: only component fibers count against `walkBudget`, a depth guard stops
  runaway trees, the walk's time comes out of `processing` as `walkMs`, `sampleRate` exists, labels
  stop at 40 characters, the badge and panel are built after `install()` returns, and the Performance
  panel entries sit beside React's own: renamed, coloured like React's, drawn with `console.timeStamp`
  from Chrome 134, and taken back out of the User Timing buffer.
- 2d8110d: the INP estimate is checked against web-vitals 6.2.2 after every interaction of a session;
  `explanation.blame.confidence` says how sure the blame is; the whole-millisecond clocks of Firefox
  and WebKit are recognised; the report lifecycle moved into `lifecycle.ts`; a spec loads React
  DevTools' real hook and Fast Refresh before and after the library; the specs assert on data rather
  than sentences; and the demo's timings got margins.
- The package (4747918): `default` and `react-server` export conditions, reports frozen
  per revision with `schemaVersion: 1`, `api.debug`, `stats().unsupportedReason`, one installation per
  page, labels from attributes alone by default under a production React build, and `withInpBlame`
  adding nothing outside `next dev` unless its `enabled` option says so.
- 7917366: `withInpBlame` through
  `instrumentationClientInject`, the navigation on every report, `react-inp-blame/vite`, and the CI and
  publish workflows.
- The documents (2026-09-15): the README with its comparison, browser matrix and API
  reference, CONTRIBUTING.md and SECURITY.md, and "What it costs" below measured again on 7917366.
  0.1.0 was published on 2026-09-17.
- The fixes from the code review of 2026-09-15, by four readers of the repository (measurement, React
  internals, packaging, code quality): reports reach listeners in a task of their own and a render a
  listener causes while it runs is never read, so a page that shows its own reports no longer feeds
  itself; hydration joins an input only when React hydrated inside its dispatch; a memo wrapper and
  the component it renders count once; a clicked element React has already deleted is named from what the ring read at
  dispatch; a Long Animation Frames script counts for the part of it inside the interaction, and only a
  script that ran while the handlers did is named as the handler; a report keeps the frames it joined;
  INP is chosen again when the page is hidden; one react-dom that cannot be read no longer stops the
  others; and the rating is web-vitals' `needs-improvement`.

## The question

The browser can tell you an interaction was slow (Event Timing, which is what INP is built
on) and which scripts ran, with how much forced layout (Long Animation Frames). React can
tell you which components rendered and, in dev and profiling builds, how long each took.
Neither side knows about the other. Every React team that has chased an INP regression has
done the join by hand: record a profile, find the long task, squint at the flame chart for a
component name.

This library does the join and answers in plain words:

    408 ms click on button "Log in" in SignInPage. The click handler handleLogin ran for
    about 402 ms; React's own render took under 1 ms. A second React render landed 285 ms
    after the screen updated: 84 ms mounting 256 components from SignInDemo down, 241 of them
    inside ProfilePage, mostly PhotoTile (240 of the 256, 73 ms). INP doesn't count it, but
    people still wait for it.

## What is proven so far

`apps/demo/e2e/attribution.spec.ts` runs these headless in Chromium and asserts the component
names, the blame and the control row's 100 ms bound. The counts below are what a run produces:
the spec pins floors rather than exact tallies (`rendered >= 400`, `count >= 100`), and in a
production build it asserts that a handler name exists, not which prop it came from.

| Scenario (anti-pattern) | What the report names | Production build |
| --- | --- | --- |
| Context storm: unstable context value | render blame on the OrderSummary subtree, LineItem ×800 | the same names through displayName stamping, blame from render counts |
| Layout thrash: read after write in 400 layout effects | layout blame on the forced layout the long animation frame recorded, about 190 ms of a 250 ms working window, with LayoutThrash and PriceTicker ×400 named after it | same, and still `measured`: the browser times forced layout in every build |
| Handler hog: 120ms in the click handler, no state change | no React render before the paint; script blame on the click handler computeChecksum | the handler named by its prop, component names intact |
| Big list: 3000 unvirtualised rows filtered per keystroke | render blame on BigList, Row ×1440 | same |
| Lifted state: unrelated heavy sibling re-renders per keystroke | render blame on Sidebar, NavItem ×600 | same |
| Cascading effect: derived state set from useEffect | a cheap commit, then the heavy one rendering Detail ×400, joined by its exact input stamp | same |
| Slow render: 250 sections rebuilt during render | render blame on SlowRender, Section ×250, about 2.5 s of it, and the checkbox beside it named by the onChange React fires from its click | same names, blame from render counts |
| Control: memoised rows, stable callbacks | at most 3 components rendered, and under 100ms wherever it is reported at all | same |

What the library itself costs is under "What it costs" below.

One finding worth its own line: the render a click's `useEffect` sets off lands after the paint, on
17.0.2, 18.3.1 and 19.3.0 alike. React 18 and 19 run the effect itself before the paint, flushing a
discrete update's passive effects inside the click's own task, but a state update made in the effect
takes default priority and renders in a later task; React 17 has no such flush and defers the effect
as well. Event Timing closes the interaction at that paint (16 to 24ms), so INP never sees the 80ms
render that follows, but the user does. The report carries these as "follow-up commits" and the
verdict says so. react-scan comes closest:
it also groups Event Timing entries by `interactionId`, maps the target element to its fiber and
records the fibers that render during the interaction. But it keeps every render from the pointerup
or keydown as one set, until the interaction's entry arrives or a second after the frame that follows
the input, so a render after the paint is not told apart from one before it, and a render that lands
later is not joined at all (read in aidenybai/react-scan at 0fb3186,
`packages/scan/src/core/notifications/`, on 2026-09-15).

The same suite runs unchanged against React 18.3.1 and 17.0.2 (`scripts/react-matrix.mjs`
generates the pinned variants, and since 2026-09-22 also 19.2.8, 19.1.9 and 18.2.0: 19.2 alone is
about half of react-dom's downloads); fiber tags, the `PerformedWork` flag and `onCommitFiberRoot` are the
same across the three majors, and so are the verdicts. Two things are not: the `ProfileMode` bit moved
(8 on React 17, 2 on 18 and 19), and React 17 takes any hook for React DevTools where 18 and 19 look
for `checkDCE`.

Since 2026-09-14 `apps/demo/e2e/cross-browser.spec.ts` also runs in Firefox 148 and WebKit
26.4 (Playwright's builds, checked on Windows): reports appear and name the component, with
`frames: null`, and a page whose `PerformanceObserver.supportedEntryTypes` lacks `event` gets
nothing installed. Both time React's components with a clock too coarse for the demo's (see
"Coarse clocks" below), so their development reports carry counts and inferred blame.

Since 2026-09-23 `apps/demo/e2e/phone.spec.ts` taps the lab's scenarios on two emulated phones, each
with a touch screen and a phone's viewport: a Pixel 7 in Chromium with the CPU slowed 4x through the
DevTools protocol, and an iPhone 15 in WebKit 26.4 (Playwright's builds and device settings, checked on
Windows, not on a phone). A tap is one interaction, its pointerdown, pointerup and click under one id,
named after the click and labelled by the button tapped. Chromium's blames are the desktop click's;
WebKit names the same components and leaves out the forced layout and the handler's script, which it
has no Long Animation Frames to see. In Chromium a finger held 250 ms before it lifts goes into
`holdMs`, not the headline; WebKit gives Playwright no way to hold a touch. On WebKit a tap whose own
paint comes quickly, with the heavy render after it, can be reported as its pointerdown alone: the
page's first input is reported however quick it was, and the render joins it as a later render. The
tap's own commit may not. That report ends at the pointerdown's paint, rounded to 8 ms, and the
click's re-render of CascadingEffect lands within a millisecond of that end, before it in most runs and
after it in a few (2 of 30 on the dev server on 2026-09-23, with other runs loading the machine). After
it, one component is too small to be a later render, so it is left out and the report says "React
didn't render anything" about a tap that did.

**Smoke runs outside the demo.** On 2026-09-20 the packed tarball was installed into a production
build of a real Next.js App Router documentation site and driven through seven interactions. That run
is cited below wherever it changed something, and only ever for *what the library said*: three runs
of each build, unthrottled and at 4x CPU, on a machine somebody else was using, is not a measurement
of that app, of an interaction, or of this library's cost, and no number taken from it appears here
as one. Every verdict it produced came back identical across every run it recorded, which is what
makes the sentences worth arguing with. Excalidraw, two TanStack Table examples and Twenty (the
twentyhq/twenty CRM) have been run by hand as well, from the same date, and are cited on the same
terms; Next.js's own bench apps have not been run. Nothing outside the demo has been profiled,
reproduced on a second machine, or hand-checked against a flame chart, and the evidence corpus that
would do that is still not written.

## What it costs

Measured twice on 7917366 on 2026-09-15, since the report lifecycle had moved into `lifecycle.ts`
(2d8110d) and the demo's timings had changed after the last measurement. Windows PC, Chromium 147
headless under Playwright 1.59.1, with a harness that is a script outside the repo. It serves the demo
(the Vite dev server for the development build; for production, `vite build` into a folder outside the
repo and `vite preview`), loads each scenario 30 times after two warm-up loads, alternating the two,
each in a fresh page and browser context, and makes one interaction per load at `walkBudget: 100000`,
which the demo set at the time and no longer does: a click on "Add to cart" in the context storm, one
key in the big list's search box. It reads the numbers after 1.2 s and an idle callback, so late entries have joined the report and
its Performance panel entries are drawn. p50 / p95 in ms, nearest rank; `performance.now()` is coarsened
to 0.1 ms there. The two runs used the same harness and differ in what else the machine was doing: in
one-second samples taken before and after the runs, other processes held it at 15 to 49% CPU during the
first ("busy") and at 0 to 9% during the second ("idle").

- "install()" is `stats().installMs`: both calls the demo makes, the one `react-inp-blame/vite` puts
  ahead of the app and the `install()` in `SignInDemo.tsx`.
- "Walk" is the `walkMs` of the commits joined to the report.
- "Event Timing callback" is the wall time of the library's observer callback, timed from outside by
  wrapping `PerformanceObserver`, so it includes the page's own listeners.
- "Library, outside the walks" is `stats().reportTotalMs`.

The "81efbbb" columns are the measurement before, taken the same way on that commit with a harness that
was not kept; its "install()" was the `/auto` import and then `install({ overlay })`.

| Production build | Context storm, 81efbbb | 7917366, busy | 7917366, idle | Big list, 81efbbb | 7917366, busy | 7917366, idle |
| --- | --- | --- | --- | --- | --- | --- |
| install() | 0.5 / 0.8 | 0.6 / 1.1 | 0.5 / 0.6 | 0.6 / 0.8 | 0.6 / 1.0 | 0.5 / 0.7 |
| Walk (801 and 1441 components) | 1.2 / 1.6 | 1.3 / 1.8 | 0.8 / 0.9 | 1.6 / 2.3 | 1.6 / 2.1 | 1.2 / 1.4 |
| Event Timing callback | 1.1 / 1.6 | 1.2 / 1.7 | 1.0 / 1.2 | 1.0 / 1.4 | 1.2 / 1.6 | 1.0 / 1.2 |
| Library, outside the walks | 1.1 / 1.6 | 1.2 / 1.5 | 0.9 / 1.2 | 1.1 / 1.5 | 1.1 / 1.6 | 1.0 / 1.3 |
| `overheadMs` of the report | 2.3 / 3.0 | 1.8 / 2.3 | 1.3 / 1.5 | 2.7 / 3.3 | 2.1 / 2.8 | 1.7 / 1.9 |

| Development build | Context storm, 81efbbb | 7917366, busy | 7917366, idle | Big list, 81efbbb | 7917366, busy | 7917366, idle |
| --- | --- | --- | --- | --- | --- | --- |
| install() | 0.6 / 1.0 | 0.7 / 1.1 | 0.6 / 0.7 | 0.7 / 1.4 | 0.7 / 1.2 | 0.6 / 0.8 |
| Walk | 1.2 / 1.9 | 1.3 / 2.1 | 0.9 / 1.3 | 4.7 / 8.3 | 4.0 / 4.7 | 2.9 / 3.2 |
| Event Timing callback | 1.0 / 1.5 | 1.3 / 1.7 | 1.1 / 1.4 | 1.2 / 2.5 | 1.3 / 1.8 | 1.1 / 1.4 |
| Library, outside the walks | 0.9 / 1.5 | 1.1 / 1.4 | 0.8 / 1.1 | 1.1 / 1.8 | 1.1 / 1.4 | 0.9 / 1.2 |
| `overheadMs` of the report | not recorded | 1.8 / 2.9 | 1.5 / 1.9 | not recorded | 4.7 / 5.4 | 3.4 / 3.8 |

- **The machine moved these numbers more than the code did.** On the same commit the busy run read 1.1
  to 1.6 times the idle run's p50s, the walks most: 1.3 against 0.8 ms on the context storm in
  production, 4.0 against 2.9 ms on the big list in development. At p50 the busy run is within 0.2 ms of
  81efbbb on every production row but `overheadMs`, and the idle run is at or below 81efbbb on every
  production row. The load during the 81efbbb production runs was not recorded, so neither comparison
  says the code got faster or slower. The 81efbbb development runs were taken with another process
  holding the machine at about 40% CPU, and a repeat there with no code change moved the context-storm
  walk from 1.2 / 1.9 to 2.4 / 5.7.
- **`overheadMs`** no longer counts drawing. Reports are frozen since 0.1.0, and a report's Performance
  panel entries are drawn after it exists, so their time is only in `stats().reportTotalMs`. On 81efbbb
  `overheadMs` was the walks plus the library's time outside them (1.2 and 1.1 against 2.3 ms p50 on the
  context storm in production). On 7917366 it is 0.4 to 0.7 ms p50 below that sum in production, mostly
  the drawing, which on 81efbbb took about half a millisecond per report: there `devtoolsTrack: false`
  took the library's time outside the walks from 1.1 to 0.6 ms p50 on both scenarios in production,
  while the Event Timing callback stayed where it was, because the entries are drawn when the page is idle.
- **install()** is under 1 ms at p50 in both runs and both builds, and at p95 in the idle run. Before
  81efbbb, on b211fa9, it took 1.3 / 2.1 on the context storm in production. A CPU profile of the
  development demo then (V8 sampling at 50 µs over 20 loads) showed what came off: creating the badge
  and panel, now done after install() returns; reading the user agent to pick a way of drawing tracks, now
  done at the first draw; and starting the dynamic `import()`, now started after the current task. What is
  left is the first call itself: compiling the library's code on first use, and the browser calls that
  install the hook, seven capture listeners (one per input type, plus `pageshow` and
  `visibilitychange`) and two `PerformanceObserver`s.
- **The walk** counts only component fibers against `walkBudget`, and at the default budget of 5000 no
  commit of these scenarios is cut short: reinstalled with the default options, 10 loads of each in
  development walked all 801 and all 1441 components, in both runs. On b211fa9, when DOM and text fibers
  counted too, every commit stopped at 713 of 801 and 1027 of 1441. Development walks cost more than
  production ones on the same tree: 2.9 against 1.2 ms p50 for the big list in the idle run, 4.0 against
  1.6 in the busy one.
- **Inside the interaction**, the walk's time is taken out of `processing` (`walkMs` in production:
  0.8 / 0.9 on the context storm and 1.2 / 1.4 on the big list in the idle run, 1.3 / 1.8 and 1.6 / 2.1 in
  the busy one) and named in the explanation.
- **The Event Timing callback** includes the demo's own listeners, and the lab page copies each report
  with a spread, which runs the explanation's getters inside it. The getters are not what costs:
  defining them takes under 1 µs per report once warm (Node 24, 200,000 reports), about 30 µs on first
  use. A page whose listeners do not read the explanation straight away does not pay for building it
  there.

Outside an interaction the per-commit cost is a renderer lookup, the check that the page's own report
listeners did not cause the commit (a map lookup and two bit tests), and one subtraction.

These figures were taken on 7917366, before the review fixes. What changed since costs a commit the
listener check above and the walk a `tag` comparison per fiber; neither has been measured again, and the
sizes below have.

**Size.** Since 0.8.0 `scripts/size.mjs` measures the bundles on every CI run, with the same settings as
below, and keeps the READMEs' tables current: on 3bc78de, where the script came in, `/auto` was 59.0 KB
minified and 21.2 KB gzipped, the badge and panel 12.8 / 4.8 and the part before react-dom 22.2 / 8.4, so
the figures below, which the README carried until then, understated the entry by about a third. They were measured 2026-09-15 with the
rolldown 1.2.8 in the repo's `node_modules` (`platform: 'browser'`, minified ESM, every export of `hook`,
`fiber` and `observe` kept for the last row, gzip at zlib's default level), by a script that was not in the
repo, first on 0.1.0 and on 7917366 with the same figures, then again after the review fixes:

| Bundle | Minified | Gzip | On 7917366 |
| --- | --- | --- | --- |
| `react-inp-blame/auto`: everything that loads with the page | 39.0 KB | 14.4 KB | 34.3 / 12.9 |
| The badge and panel, a chunk loaded by dynamic `import()` only when shown | 11.2 KB | 4.2 KB | 11.3 / 4.2 |
| Before hydration: `hook`, `fiber`, `observe`, `session`, `version` and `warn` alone | 14.5 KB | 5.8 KB | 11.5 / 4.8 |

The review fixes cost the entry 4.7 KB minified and 1.5 KB gzipped, and the part before hydration 3.0
and 1.0 of that: telling the page's own report renders from its work needs the lane bookkeeping and the
post-commit wrapper in `hook.ts`, the ring now reads the enclosing components and the handler at
dispatch, the walk carries the hydration checks, and the version parsing moved into `version.ts`. The
same script gives 32.6 KB / 12.3 KB, 11.3 KB / 4.2 KB and 11.3 KB / 4.7 KB for commit 4747918, before
reports carried navigations. An earlier script measured that commit at 31.8 / 12.0, 11.1 / 4.1 and
9.3 / 4.0 KB; its settings were not kept, so those figures do not compare with these line for line.

The badge and panel were already behind the dynamic import and stay there. The explanation prose
(`join.ts`), the report lifecycle, the INP estimate and the Performance panel drawing still load
with the entry, which is why it is about two and a half times the part that has to run before hydration.
An earlier measurement (29 KB minified and 10.6 KB gzipped for `/auto`, badge and panel included)
predates the changes that added the lifecycle, the INP estimate and the version
gates, so the two sets do not compare line for line. `withInpBlame` adds its client module and its
loader to `next dev` only unless `enabled` says otherwise, and `react-inp-blame/vite` adds its
plugins to the dev server only, so a production build with the default carries nothing from the
library unless the app imports it itself.

## How it works

Four sources, one join.

**React commits.** React calls `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot` after every
commit, in production builds too, provided the hook exists before `react-dom` evaluates.
`install({ hook })` decides where commits come from. `'chain'` wraps a hook that is already
there (React DevTools, or Fast Refresh's stub in dev) and never creates one, so a production
page without either gets Event Timing and LoAF only. `'shim'` creates a minimal hook, and
`'auto'`, the default, chains when a hook exists and shims otherwise. The shim holds what React
needs: `supportsFiber`, `inject`, `onCommitFiberRoot`, `onPostCommitFiberRoot` and the `renderers`
map, plus a `reactInpBlame` marker; React checks for every other method before calling it. It has no
`checkDCE`: react-dom reads that as the real React DevTools being present, and in development builds it
silenced React's "Download the React DevTools" message. `dispose()` puts a chained hook's `inject`,
`onCommitFiberRoot` and `onPostCommitFiberRoot` back, removing the last of those when the hook had none.
A hook the page has switched off (`isDisabled`, or no `supportsFiber`) is not chained onto at all,
because React registers with nothing there: `stats().mode` is `'unsupported'` with
`kind: 'hook-disabled'`, and Event Timing reports carry on without components.

React DevTools never installs over an existing hook: its `installHook` returns as soon as
`window` has the property, reading and writing nothing. So a shim that loads before it locks
React DevTools out without a trace, and `api.debug.hook().devtoolsLockedOut` cannot see that happen. The
flag catches only a tool that assigns its own hook later, which the shim notices because it is an
accessor on `window`: before React has registered, the library follows the new hook; after, React
keeps reporting to the shim, the flag turns true and one warning says so. The browser extension
installs its hook at document start, before any page script, so beside it the library chains; the
lockout needs the page itself to install React DevTools after the library, as a call to
react-devtools-inline's `initialize()` after the library's import does.
`apps/demo/e2e/devtools-hook.spec.ts` loads React DevTools' real hook (react-devtools-inline
8.0.0) and the Fast Refresh runtime (react-refresh 0.19.0) before and after the library, in
development and production builds (Fast Refresh in development only, its runtime throws in a
production bundle): React's commits reach the library in every order, `stats().mode` is
`'chained'` when the tool came first and `'shim'` when it came after, and each tool's own record
of mounted roots follows the app as it mounts and unmounts, except React DevTools loaded after the
library, which installed nothing and never hears from React. On @vitejs/plugin-react's dev server the Fast
Refresh preamble runs first. Vite 8.3 puts each tag at the top of `head` as it adds it, so the page runs
them in the reverse of that order, and plugin-react adds its tag from a normal-order hook, after the
library's `order: 'pre'` one. The refresh stub is the hook there and the library chains onto it.
`fixtures/vite-react-ts` checks that path, and the production build's, from the packed package.

**One installation per page.** A page can load the library twice: a package duplicated in
`node_modules`, or the same module in two chunks. While its state lived in module variables, the
second copy found the first copy's hook and chained onto it, so every commit was walked twice and
listeners were split between two installations. Since 0.1.0 the state lives on `globalThis` under
`Symbol.for('react-inp-blame')`, so the page has one installation whichever copy installs, and a
call from the other copy returns the same API. A copy whose version lays that state out
differently installs nothing, warns, and says so in `stats().unsupportedReason` (`kind:
'another-copy'`) rather than read state it would misunderstand. `packages/core/test/install.test.ts`
loads two copies of the source from separate directories and checks for one hook wrapper, one
walk per commit and one set of listeners. In `apps/next-demo` a client component subscribes with
`onInteraction` from its own import and writes each report's `interactionId` to `document.body`;
the spec checks it hears the same reports as the debug global under `next dev` and both production
builds, so the module Next.js injects and the application share one installation there too.

**Reports reach listeners in a task of their own, and what a listener renders while it runs is not an
interaction's work.** A later render joins a report inside React's commit, so publishing that revision from there
called the page's listeners inside the commit: a listener that sets state rendered inside the commit it
was hearing about, which React 18 and 19 count as a nested update and stop at 50 with "Maximum update
depth exceeded", while React 17 counts before the hook and so never stops. The render a listener causes
also lands after the interaction's paint with no input of its own, so it was stamped with that
interaction's input, joined the report as its later render, and published a revision the listener heard
again: any page that shows its own reports fed itself. Since 2026-09-15 install() queues each published
revision and hands it over in a later task, and the hook keeps the listeners' work apart from the
page's. React sets a lane in `root.pendingLanes` for every update and clears it when that update
commits, so a commit during the delivery, a commit that finishes a lane the delivery left pending, and
whatever that commit's own render and layout effects schedule are not read at all; for its passive
effects React 18 and 19 call `onPostCommitFiberRoot` when they have run, and React 17 has no such call,
so there an effect of a listener's own render can still join a report. The one commit that finishes such
a lane and is read anyway is one inside an input's dispatch. React 19.3 renders sync, continuous and
default updates in one pass, so a key pressed before React's own task for the listener's update renders
that update with its own. Typing at full speed in the demo, 9 of 23 keystrokes lost their commit that way
until 2026-09-25, and their reports put the render's time on the handler's script. Kept, the commit
counts the listener's components beside the key's, which is the smaller error. An update a listener defers
instead, with `setTimeout`, `requestAnimationFrame` or an `await`, is scheduled after the lanes have been
taken, so its commit is read like any other render. That is the library working as intended: a genuine
later render is the thing it exists to report. Measured against a 37-component
panel fed by `onInteraction`, driven from source with react-dom 17.0.2, 18.3.1 and 19.3.0 in Node: one
click gave 54 listener calls and 53 wrong "second React render" notes blaming the panel on React 18 and
19 (111 on React 17 in development, 22,045 in a production build, with the main thread held for 1.4 s);
after the fix, one call and no follow-ups on all three, in both builds.

Durations come from `ProfileMode` on the root, which is what makes React fill `actualDuration`:
bit 8 on React 17, bit 2 on 18 and 19, chosen by the version react-dom hands `inject()`. React
17 and 18 development builds, and 19 profiling builds, set it when a hook existed as react-dom
evaluated; React 19.3 development builds set it on every root; production builds have no
`actualDuration` at all. Measured time under a root outside ProfileMode, as under a
`<Profiler>`, counts too.

**Coarse clocks.** React times each component with `performance.now()`, which Chromium steps in
0.1 ms and Firefox 148 and WebKit 26.4 step in whole milliseconds on a page without cross-origin
isolation (measured 2026-09-15 in Playwright's builds). After a context-storm click in a
development build, all 400 line items sampled read 1 or 2 ms in Firefox and 1 ms in WebKit,
against 0.2 to 1.4 ms in Chromium, which is how reports there came to say "800 of them, 800 ms".
That total was not inflated: the click itself took 832 to 840 ms there, because the demo's
busy-wait stops on the same clock and so stretches each line item's 0.12 ms to the next
millisecond. Work that does not wait on the clock reads 0 or 1 ms at random: no single
component's time means anything, while a sum over many of them comes out close. So a commit is marked `coarseClock` when eight or more of its
components carry a time, every one a whole millisecond, and they average under 4 ms. Its
per-component `self` and `total` are left out, the commit's own `total` stays, and a blame built on
its durations is `'inferred'`, with a note saying why. Components that average 4 ms or more keep
their times, since a millisecond of rounding moves them by a quarter at most.

**Failing closed.** `install()` checks the browser first. Without `event` in
`PerformanceObserver.supportedEntryTypes` and `interactionId` on `PerformanceEventTiming` (Chrome
96, Firefox 144, Safari 26.2) it installs nothing, returns an API whose `stats().mode` is
`'unsupported'`, and warns once. What each renderer hands `inject()` (version, bundleType,
rendererPackageName) is kept in `api.debug.hook().renderers`, and only `react-dom` commits are
walked, so a react-three-fiber canvas is never read as a DOM tree. A renderer that registered before
`install()` is not walked either when the hook kept nothing about it (Fast Refresh's stub keeps
nothing; React DevTools' hook keeps everything). A react-dom outside React 17 to 19, a root that fails
the shape check at its first commit (numeric `pendingLanes`, and a `current` with tag 3, numeric
`flags` and `mode`, `child`, `sibling`, `return` and `alternate` fibers or null, `actualDuration` a
number or absent), or a walk that throws stops that renderer's commits being read, for good, with one
warning. The page is `stats().mode === 'unsupported'` only when no react-dom on it can be read, so an
embedded widget that brought React 16 no longer switches off the app's own React. A version of
`0.0.0-experimental-<sha>`, which is what react@experimental carries, says nothing about the React it
is ahead of, so it is read as the newest major and left to the shape check. Event Timing reports carry
on without components. Since 0.1.0 `stats().unsupportedReason` says which of these it was, as data
(`kind` is `'browser'`, `'another-copy'`, `'hook-disabled'`, `'react-version'`, `'fiber-shape'` or
`'walk-threw'`) beside the warning's sentence; before, the reason was only in the console. A first
commit with a rendered tree already behind it means `install()` ran after that root rendered, and a
warning says so once.

**The walk.** After a commit the current tree is walked once. A component fiber that rendered
carries the `PerformedWork` flag. A fiber whose alternate still points at the same child list
bailed out, so its whole subtree is stale and gets pruned; that prune is what keeps the walk
cheap on big trees. Ancestors that were only cloned on the way down (App, layouts, providers)
are named on the path but never counted as roots. The hot path follows the child carrying at
least 60% of the parent's work, so it stops at "the OrderSummary subtree" rather than
descending into 800 identical rows, and spends at most twelve steps below the one it starts from,
on names a reader could search for. A library's layers between them are named on the path but
spend no step: a name a reader could not search for (Radix's `Primitive.div`, a Slot, a
minifier's) or a Provider or a Context, and the same for a wrapper named after the component it
renders (shadcn's `TabsList` over Radix's). Every name spent a step before this, so on the shadcn/ui
docs Radix's layers alone spent the twelve and a render of the install tabs was named after
RovingFocusGroupCollectionProviderProvider, and on cal.com a provider and a minified name spent the
two that would have reached the tab below the form. The walk also counts the components rendering
for the first time (`mounted`, a fiber with no alternate), and beside the commit's count keeps two
more: those under the component the path starts from (`startRendered`, the whole where one root
rendered or the roots share it, less where other roots rendered beside it) and those inside the
deepest searchable name on the path (`pathRendered`). So a sentence can say "1216 components from
EventTypeWeb down, 812 of them inside EventAdvancedWebWrapper" where 0.12.0 put the whole count
inside the last name it reached (the 812 and the name are a read of cal.com's source, not a run),
or "181 components, 79 of them inside RovingFocusGroup" where two code blocks rendered and neither
holds the rest. It can also say "mounting" of a Radix dialog's content, which its Portals mount in
a commit of their own. A memo wrapper is a fiber of its own above the component it
renders (`memo(fn, compare)`, `memo(forwardRef(...))` and `memo(Class)`, but not `memo(fn)`, which
React keeps as a single fiber), and React flags both as having rendered, so each such component was
counted twice until 2026-09-15: 504 rendered where 304 did, on 17, 18 and 19 alike. The wrapper now
counts as the component below it and lends it its name, which is where `displayName` is stamped and
what a minifier cannot rename.

Only component fibers count against `walkBudget` (default 5000). DOM and text fibers are most of
any tree, and until 2026-09-15 they counted too: at the default budget every context-storm click
in the demo was cut at 713 of its 801 components, and every big-list keystroke at 1027 of 1441.
They cost the walk no more than they cost React, because the prune keeps it to the subtrees React
re-rendered. The walk recurses inside React's commit, so past 1000 levels it stops descending
that branch, carries on with its siblings and marks the commit `truncated`.

**Event Timing.** A `PerformanceObserver` on `event` entries, grouped by `interactionId` (a
click is three entries: pointerdown, pointerup, click). The headline number is the longest
single entry's duration, which is what web-vitals reports as the interaction's latency, so a
pointer held down (normal on touch) does not inflate it. Entries whose paint landed within
8 ms of each other count as one frame (web-vitals' `groupEntriesByRenderTime`), processing
is clamped to that paint, and input delay, processing and presentation delay come out of the
same numbers. The span of every entry with the id, press to release, is kept as `holdMs`
and stays off the headline (since 2026-09-14; before that the headline was the whole span).
The target element resolves to its component through the `__reactFiber$` expando, and the
React handler prop for the event type is looked up on the same chain, so "no React render;
120ms in the click handler computeChecksum" is possible without a profile. Of a click's pointerdown,
pointerup and click, only the events whose own processing ran longest are asked, since their handlers did
the work; under 4 ms apart they tie and the click is asked first, and where none of them has a React
handler, none is named (since 0.6.0). The element's label
names it by its tag and a name of at most 40 characters, and its whole `textContent` is never read,
because a click can land on a list of 3000 rows. It comes from what the page's code wrote on the element (its aria-label, a
form field's placeholder, name or type, or its data-testid or data-test), and, where text is
allowed, from the first run of text of an element with no aria-label that is not a form field. A run
is the adjacent text nodes React renders an interpolated string as, `Add to cart ({n})` as three, and
it takes in the `<!-- -->` the server renderer puts between them to keep hydration straight: without
that, the same button would be labelled `Add to cart (` after hydration and `Add to cart (3)` after a
client-only render. A run stops after a fixed number of siblings, so skipping those separators is
never a way to walk a whole element. The label is read by the capture listener as the input is
dispatched, before React's handlers run, and kept with the input: read when the entry arrives, after the
paint, a counter's button clicked as `Count is 0` was labelled `Count is 1`. Where the entry's target is
not the node the listener saw, the label is read from the entry's target when the report is built.
Text is allowed under a development build of React and wherever `install({ labels: 'text' })`
asks for it, not by default under a production build: an element's text can be a person's name
or email (a clicked table cell), and production reports are the ones forwarded to Sentry, Faro
or an OpenTelemetry collector. Selectors still carry ids and classes, and name the test attribute they
were built from with its value quoted. When the entry's target is null because the node left the DOM
before the observer ran (a close button, a deleted row), the input ring below still holds the node,
and the enclosing components and the handler prop read from its fiber at dispatch. Keeping the fiber
itself was not enough: React 18 and 19 clear a deleted fiber's `return` and `memoizedProps` when the
deletion's effects run, which is before the entry arrives, and a click that deleted its own row was
reported with no component, no owners and no handler at all.

**Which prop a native event maps to.** The table is in `fiber.ts`, and it is read off React's own event
plugins in the installed react-dom 19.3.0 (`cjs/react-dom-client.development.js`): SimpleEventPlugin for
the events that map one to one, and ChangeEventPlugin's `extractEvents` for the controls whose `onChange`
comes from something other than a `change` event. The walk starts at the element the event landed on and
climbs the fiber chain, taking the first of these props it finds:

| native event | props looked for, in order |
| --- | --- |
| `click` | `onClick`, `onSubmit` |
| `click` on `input[type=checkbox]` or `[type=radio]` | `onClick`, `onChange`, `onSubmit` |
| `pointerdown` / `pointerup` | `onPointerDown`, `onMouseDown` / `onPointerUp`, `onMouseUp` |
| `keydown` | `onKeyDown` |
| `keydown` in a form control | `onKeyDown`, `onChange`, `onInput` |
| `keydown` of Enter in a field or on a button | the same, then `onSubmit` |
| `keyup`, `keypress` | `onKeyUp` / `onKeyPress`, and the same two additions |
| `input` | `onChange`, `onInput` |
| `change` | `onChange` |
| `submit` | `onSubmit` |

Only the event's own prop is unconditional. Everything else is a prop React dispatches *from* this event
rather than *for* it, and each is added only where React really would: `onChange` on a control React
watches for changes, `onSubmit` on the key that submits a form. A fallback that is sometimes right is
worse than none, because a named handler reads as a fact. There are no `mousedown` or `mouseup` rows:
the ring records pointer events and Event Timing names those, so a mouse event never reaches the table,
while an app that wrote `onMouseDown` is still named from the `pointerdown` row.

ChangeEventPlugin picks a different native event per control, which is the row that matters: `select` and
`input[type=file]` fire `onChange` from `change`; a text field (a `textarea`, or an input whose type is in
`supportedInputTypes`, which `isTextInputElement` reads) fires it from `input`, and from `change` where the
browser has no input event; and `input[type=checkbox]` and `[type=radio]` fire it from the **`click`**, in
`getTargetInstForClickEvent`, because React compares the checked state after the click rather than
listening for a change. Until 2026-09-19 the table had one row per event and no notion of the element, so
every ticked checkbox, chosen radio and changed select in a real app reported `handler: null` while its
onChange sat one fiber away. `onChange` is only ever reached for an event React would fire it from, which
is what keeps every click inside a form with an `onChange` from being named after it.

A click on a `<label>`'s own text is forwarded by the browser to the control the label labels, and every
handler React fires is then that control's, so the walk finishes at that control rather than at the text
that was clicked. A click on interactive content inside the label is not forwarded at all: an anchor, a
button or a second control keeps it, and so does the label's own `onClick`. The walk therefore stops at
the first `input`, `select`, `textarea`, `button`, `a` or nested `label` between the target and the
label, and forwards only when nothing at or below the label handled the click. Read the other way round,
as it was between 2026-09-19's first pass and this one, an "I accept the terms" label reported the
checkbox's `tick` for a click that opened the terms, a button inside a label reported nothing, the second
checkbox in a label reported the first one's handler, and a label with its own `onClick` reported the
checkbox's `onChange`. A label whose control is elsewhere on the page through `htmlFor` has nothing to
forward to and is left where it is.

**The join.** A capture-phase listener keeps a ring of the last 8 inputs (pointerdown,
pointerup, click, keydown, keyup) with their `Event.timeStamp`, target and fiber. Every
commit is stamped with the input being dispatched when it ran: `window.event`, which is
still set for the sync commit of a discrete event, including the microtask React 18 and 19
flush it in. A commit with no event on the stack (a transition, an effect, data arriving)
is stamped with the newest input seen. A release also carries the timestamp of the press it
belongs to (pointerup and click by `pointerId`, keyup by key code, and a click made from the
keyboard, whose `pointerId` is -1 in Chrome, by the key whose task it came in), so a render after a cheap
click still finds the pointerdown that was slow enough to be observed. A commit belongs to
an interaction when its input matches an entry of the same type whose `startTime` is within 1 ms
(a keypress stands for its keydown), or the press it carries matches a pointerdown or keydown entry: the
Event Timing spec says `startTime` is the event's `timeStamp`, the same clock React's own
Blocking track keys on. That is why 150 ms of input delay changes nothing and two
overlapping interactions cannot both claim one commit at full cost. The type matters when typing at full
speed: the next key goes down under a millisecond after the last one comes up, before the frame that
keyup paints in, and by time alone the next key's render was the keyup's as well. The keyup's report now
holds no render, and says its frame waited on the next key press, which the page handled first
(`nextInput`). A commit no stamp
explains, landing between an interaction's handlers and its paint, is still taken and
flagged `joinedBy: 'overlap'`; one that ran during the input delay is what delayed the
interaction, not part of it. Before or after the paint is decided against the paint that
closed the headline entry, with the exact `processingEnd` as the other bound: durations are
rounded to 8 ms, `processingEnd` is not, so a commit inside the handlers is never misfiled as
a follow-up.

**The window, and what it is measured from.** A commit React makes inside an input's dispatch is that
input's, however long the dispatch has been running. A `change`, `input` or `submit` the browser fires
from an input counts as its dispatch while it comes in the input's own task or within `inputWindow` of
the end of the input's work, by its own `timeStamp`: a file chosen in the system dialog 20 s after its
click is neither, and its render is held to the window like any other. A commit outside any dispatch
joins the newest input the ring holds while it lands within `inputWindow` (1.5 s by default) of the
input's own timestamp, until React commits inside its dispatch, and then of the end of the last such
commit. Until 2026-09-19 both were measured from the input's timestamp, so a click that
spent 2.5 s inside React had its one commit thrown out by the same check that throws out an unrelated
background update, and the report read "React didn't render anything" with confidence `measured`. That
was wrong, and stated as a fact.

The new rule has two failure modes, and the anchor is the name of both.

- The old one, in a smaller form: an unrelated commit landing inside the window is still read as this
  interaction's follow-up render, now anchored to the end of the interaction's work rather than to the
  input, which is a longer reach on a slow interaction. Only a dispatch moves the anchor, so a chain of
  follow-ups cannot hold the window open indefinitely, and the check below on newer inputs closes the
  common case.
- The anchor is the end of the **last commit inside the dispatch**, which is not the end of the
  dispatch. The hook is called after a commit and at no other time, so the end of the dispatch is not a
  moment it can see; a handler that runs for two seconds and commits nothing leaves the anchor on the
  input itself, and a transition that handler starts can land outside the window and be dropped. Moving
  the anchor properly would mean a second window listener per event type, in the bubble phase, to mark
  where each dispatch ended. That is a real change to what the library installs on the page, for a case
  the count below already reports honestly, so the wording is what changed here and not the rule.

A commit the gate drops is not silent. The input keeps the time it ran at, capped at 16, and a report
counts the ones that ran while one of its own Event Timing entries was in its processing phase, which
is where the interaction's handlers were on the stack. `unjoinedCommits` is that count, and while it is
above zero nothing the report says about React's work is `'measured'`: the sentence says React rendered
during the interaction and that those commits could not be tied to it. Counting every dropped commit
instead, which is what 2026-09-19 first did, made a page with a clock in it unreadable: holding a button
for four seconds while a 1 s clock ticked reported "3 commits could not be tied to this click" on an
honest, fast, fully measured click, and took its `measured` away. A page with a clock in it has to be
able to get a measured "React didn't render anything", and the processing spans are what make that
possible.

A root's first commit, which mounts it or hydrates its server-rendered HTML, and any commit that
hydrates a Suspense boundary, are the page starting up rather than an input's work. They join an
interaction only when React ran them inside that input's dispatch, which is what React does for a
discrete event on a boundary that has not hydrated yet, and such a commit says it hydrated rather than
re-rendered. Until 2026-09-15 they were stamped with the newest input like any other commit, so on
React 17, 18 and 19 alike a click on server-rendered HTML collected the whole hydration commit as its
"second React render", and a quiet first tap was published on the strength of it. README.md carried that
as a known limit. The rest of the verdict, reporting the wait as its own part of the working time and
naming the boundary people waited for, is the section below.

### Clicks that land before hydration

Every App Router page is server-rendered, so a click can land on HTML React has not reached. The element
has no fiber, so until 2026-09-19 the report had nothing to say about the commonest cause of a slow first
interaction in a Next.js app. Two cases are now told apart, and `report.hydration` carries them as data.

Both cases start from the same question, asked of the page beside the input: *what is the innermost
piece of server-rendered HTML enclosing this element that React has not reached yet?* It is asked once
when the input is recorded, and again on each commit until the answer changes. `dehydratedAround`
answers it by following React's own `getClosestInstanceFromNode` to a fiber, from the element or from
the comment opening the boundary around it, and then climbing to the innermost Suspense or Activity
boundary that still holds a dehydrated instance, or to the root.

*Every read asks what is on the screen now.* This is the whole of the correctness argument, and it was
got wrong twice in opposite directions.

The first attempt read `alternate`, which is the state before the commit **only for the fibers React
worked on in that commit**, which is why React itself only ever asks it of a `finishedWork` inside its
own commit traversal. A boundary that hydrated at page load keeps a dehydrated alternate until some
later render passes through its parent, and a verdict read from that alternate calls every click in that
part of the page a hydration, for as long as nothing re-renders there. A click that updates something
outside the boundary, a cart badge in a header, never re-renders there at all. There is a demo route and
an e2e test for exactly that click.

The correction went too far and refused to look at the alternate at all, which missed the case where the
two trees disagree **because a hydration has rendered and not yet committed**. React nulls a boundary's
state at the end of its render, in `completeDehydratedSuspenseBoundary`, not in the commit. A
time-sliced pass that hydrates two boundaries finishes the first while it is still rendering the second,
and for that window one tree says hydrated, the other says server HTML, and the page is showing the
server's. A click there is blocked by React and hydrated inside the event, which is exactly the case
this section exists to report, so reading the hydrated side and stopping would report nothing.

What settles it is the flag React uses for the same purpose. `Hydrating` (4096) sits on the hydrating
side's child from the render until `commitReconciliationEffects` clears it in the commit, so it marks
exactly the window in which that work has not reached the screen; `getNearestMountedFiber` asks the same
question the same way, as `Placement | Hydrating`. So: where the two trees agree, or there is only one,
that is the answer; where they disagree, the boundary is still server HTML if and only if the hydrated
side is still flagged. The three shapes are pinned by unit tests, and the uncommitted one by a unit test
alone, because driving it from a route means hitting a window a few milliseconds wide.

*A fiber on the element is not an answer either.* React caches a fiber on each node of a boundary as it
hydrates it, during the render and before the commit, and a boundary the server reveals late is hydrated
on an interruptible render on both 18 and 19, whatever marker it carries. So the button inside such a
boundary carries a fiber while the boundary still holds the server's HTML, and the boundary above it has
to be asked regardless.

*React hydrated it inside the click.* The input recorded a boundary, and a commit of the interaction is
the one after which the same question answers null. That commit is credited, once per input, and it is
the only commit that can be: after it the page is hydrated and there is no second hydration of it to
find. The boundary named is the one the input was inside, so a boundary streaming in elsewhere on the
page is never blamed, and where an outer boundary hydrates first the inner one around the target is
still the one named. The time is React's render duration for the credited commit, reported as a named
part of the working time rather than as a fourth phase: `Phase.parts` was added for it, and the three
phases add up to the interaction exactly as before, so reports stay at `schemaVersion: 1`. It takes the
blame only when it is what the working time went on, at least `RENDER_MIN_MS` and more than the time
outside React's render; a boundary that hydrated in 2 ms ahead of a 400 ms handler is a note beside the
ordinary verdict instead.

*It was still waiting.* Every input of the interaction the ring still holds landed on HTML that had not
been hydrated, and no commit hydrated it. React stops a discrete event at a boundary it has not reached,
so almost no working time goes by: the blame stays on whatever the time actually went to, the input
delay or the paint, and the hydration sentence goes in front of it. That sentence says only what was
seen, that React did not dispatch the event and no React handler ran for it. Reading the newest input of
the interaction rather than the first is what keeps a pointerdown before hydration from speaking for a
click after it.

A Suspense boundary has no name of its own, so it is named after the nearest component holding it, which
means a boundary written directly in a Server Component is named after whichever client component of the
router happens to enclose it. The demo puts its boundary inside a client component for that reason. A
root that has not hydrated has no component above it at all and reads as "the page".

**What React does, read from the react-dom in this repository.**

*React 19.3.0*, `node_modules/react-dom/cjs/react-dom-client.development.js`. A HostRoot's
`memoizedState` is `{element, isDehydrated, cache}`; `createFiberRoot` sets `isDehydrated` from the
hydrate flag and `updateHostRoot` swaps in a new object with it false. A dehydrated Suspense fiber
(tag 13) has `memoizedState.dehydrated` set to the boundary's opening comment node, and `completeWork`
clears the whole state to null when it hydrates. React's own `isHydratingParent` is the same predicate,
dehydrated on the alternate and not on the current fiber, and it is called from `commitLayoutEffectOnFiber`
and `commitMutationEffectsOnFiber` as `isHydratingParent(finishedWork.return.alternate, finishedWork.return)`:
only ever of a fiber React worked on in that commit, which is why this library reads the current state
first and consults the alternate only through the `Hydrating` flag described above. The walk's own
"this commit hydrated something" flag does use it, and
can, because the walk stops descending at a fiber whose alternate still shares its child list, so every
fiber it reaches was either rendered or cloned in the commit. A boundary React gave up on ends the commit
the same way a hydration does, and React tells the two apart by the `DehydratedFragment` child (tag 18)
in `deletions`, which is what `commitPassiveMountOnFiber` reads. The `Hydrating` flag is 4096 here too,
inside the combined literal `134221824` the compiled build writes at the two places it starts hydrating
a boundary; `commitReconciliationEffects` strips it in the mutation phase, before `onCommitFiberRoot` is
called, so a commit handed to the hook never carries it and it is only ever read live, off the page.
Markers on the DOM: `internalInstanceKey` is
`'__reactFiber$' + randomKey`, `internalContainerInstanceKey` is `'__reactContainer$' + randomKey`, and
`getClosestInstanceFromNode` finds a boundary for unhydrated HTML through `getParentHydrationBoundary`,
which walks back over the siblings counting five opening markers (`$`, `$?`, `$!`, `$~` and `&` for an
Activity boundary) against two closing ones (`/$` and `/&`), and reads the boundary's fiber off the
opening comment. This library counts the same seven, because counting fewer gets the depth wrong and
hands back a boundary the node is not inside. The container fiber is not the one to read for a root:
`findInstanceBlockingTarget` goes through it to `stateNode.current.memoizedState.isDehydrated`, because
the fiber React writes on a container is the one `createFiberRoot` made, which becomes the alternate on
the first commit and says `isDehydrated: true` for as long as it lives. Activity boundaries are tag 31,
handled beside tag 13 in `findInstanceBlockingTarget`, `dispatchEvent` and `isHydratingParent`, and
carry the same `memoizedState.dehydrated`; this library reads them the same way. For a discrete event, `dispatchEvent` attempts a
synchronous hydration on the capture phase (`IS_CAPTURE_PHASE`, bit 4) by scheduling the root or the
boundary at lane 2 and flushing sync work; if it is still blocked afterwards it calls
`nativeEvent.stopPropagation()` and returns without dispatching, so no React handler runs. It does not
call `preventDefault`, and there is no discrete replay queue. `queueIfContinuousEvent` queues five
events for replay instead, at `SelectiveHydrationLane`: `focusin`, `dragenter`, `mouseover`,
`pointerover` and `gotpointercapture`. React 18.3.1 queues the same five.

*React 18.3.1*, `apps/demo-react18/node_modules/react-dom/cjs/react-dom.development.js`. The same
shapes: `isDehydrated` on the root state from `createFiberRoot`, `memoizedState.dehydrated` on a tag 13
fiber from `tryHydrate`, cleared in `completeDehydratedSuspenseBoundary`.
`commitSuspenseHydrationCallbacks` compares the fiber's state with its alternate's exactly as this
library does. `var Hydrating = 4096` is written out in this build; it is set as
`primaryChildFragment.flags |= Hydrating` in `updateDehydratedSuspenseComponent` and cleared in
`commitReconciliationEffects`, before the hook. Discrete events take `attemptSynchronousHydration` on the capture phase, which does a real
`flushSync` at `SyncLane`; still blocked, the event gets `stopPropagation()` and is not dispatched. The
discrete replay queue exists in the file but has no push site, so it never fills.

*React 17.0.2*, `apps/demo-react17/node_modules/react-dom/cjs/react-dom.development.js`. There is no
dehydrated Suspense state at all: `enableSuspenseServerRenderer` and `enableSelectiveHydration` were
experimental in 17.0.2 stable, so the compiler stripped those branches and `tryHydrate` for a
SuspenseComponent returns false unconditionally. Hydration stops at each Suspense boundary and its
children are created on the client instead. The only hydration signal is a `hydrate` boolean on the
FiberRoot, and `commitWork` clears it during the mutation phase, before `onCommitRoot` runs, so by the
time the hook is called there is nothing left to read. React 17 therefore reports no hydration, which is
why the matrix variants' reports are unchanged.

**What cannot be known.** A click before `hydrateRoot` has run at all: nothing on the page carries a
mark of React yet, not even the container, so there is nothing to read and no verdict is given. Why a boundary was still waiting: the library sees a dehydrated boundary,
not whether React was blocked on code or on data. Whether the element had a handler for the event React
did not dispatch, which is why the sentence says no React handler ran rather than that one was lost.
Hydration that fell back to a client render, where React threw the server HTML away: the target goes out
of the document with it, and the library says nothing rather than calling the client render a hydration.
How long a hydration took in a production build, where React records no render durations, though which
boundary hydrated and how many components it took are still measured and `next build --profile` gives the
durations back. And a boundary written directly in a Server Component, which has no component of its own
to be named after.

**Two gaps that are reasoned about and not verified.** Both would leave a click reported as an ordinary
one when it was really waiting on a hydration, and neither has been reproduced. React throttles a
retry-lane commit for up to 300 ms after a fallback appeared, so one boundary on its own could sit
rendered-but-not-committed for that long, which is the same shape the `Hydrating` flag covers above but
through a different door; an attempt to drive it in a headless browser never caught the window. And a
click during a root hydration that Next has put inside `startTransition(hydrateRoot)` would be
time-sliced the same way: the verdict would name the innermost boundary around the target, and the time
would count that boundary's commit only, not the rest of the root's.

**Long Animation Frames.** Overlapping `long-animation-frame` entries supply the script
attribution and `forcedStyleAndLayoutDuration`. A script counts for the part of it inside the
interaction, with its forced layout apportioned to that part (the API gives forced layout as one
total per script, never saying when in the script it happened). web-vitals takes the same
intersection but clips the left edge only, so a script that starts inside an interaction and runs on
past the paint counts against it whole. Here it stops at the paint, since the rest ran after the
screen had updated and nobody waited for it. Only a script that started while the input's handlers ran is named as the handler: the task
an input waited behind is not its handler, and its forced layout is not the handler's to answer for.
Until 2026-09-15 a 96 ms click that waited behind a 300 ms timer was reported as "the click handler
handleSave ran for 300 ms", with confidence `measured`. LoAF can only say "React's event dispatch ran
for 80ms"; the fiber walk is what turns that into a component. Together they separate "your
render was slow" from "your layout effect forced layout 400 times". Only Chromium has LoAF. In
Firefox and Safari a report's `frames` and `laterFrames` are `null`, and the explanation leaves
out the forced-layout and script sentences rather than implying none happened.

Forced layout inside the handlers, which Long Animation Frames counts together with style recalculation
(a Chrome trace of a shadcn/ui Sheet opening had about 80 ms of style against 1 ms of layout, so the
sentences say styles and layout), can take the blame outright, as `blame.kind: 'layout'`, and until
2026-09-20 it could not: the one branch that weighed anything against a render needed React's render
durations to subtract them, and a production build has none, so however much layout the browser had
measured it came out as a footnote under a render nobody had timed. On the shadcn/ui documentation
site that happened on three of seven interactions, each one a Radix component reading geometry while
opening: 108 ms of layout inside 116 ms of working time was reported as a re-render of 181 components
with `ms: null`. The number it demoted was measured and the number it promoted did not exist. So a
layout takes the blame from 50 ms (from 25 ms where no render was timed, a production build or no
commit joined, where it is the only measured duration in the window and a 50 ms floor flipped a sheet opening on the shadcn docs between
render and layout at 49 and 50 ms), when it is half the window it was counted across — the working
time plus this library's own walk, since the scripts run to the end of that and `processing` has it
taken back out — and larger than both React's render and the working time left outside it, and the
sentence is printed against that same window, or it reads "110 ms of the 100 ms of working time".
So the sentence names that window rather than the working time — "the 116 ms spent handling the
click" — and its numbers add up to it. Where the walk is worth a whole millisecond the remainder
names it too, because the window it was taken from holds it. The sentence says what is left over —
"the browser spent 108 ms of the 116 ms spent handling the click recalculating styles and layout, leaving 8 ms
for React's render and commit, its layout effects and the click handler together" — which is what
makes the demotion of the
render a measurement rather than a preference. Where React's render is itself timed higher than that
remainder the two overlap, because geometry read inside a render body is charged to the render and to
the layout both, and the sentence says that instead of printing a remainder that bounds nothing. It
is the one blame *about React's work* that keeps `measured` under a production build — `waiting` and
`painting` are the browser's own phases and never depended on the build, and neither does `script`,
though that one turns `inferred` whenever a commit could not be tied to the interaction, since a
script is what is left once React is ruled out and an unjoined commit is what stops React from being
ruled out — and it is
`inferred` only where a script ran on past the window and its forced layout had to be apportioned.

Nothing names the read that forced the layout, so the blame's `name` says where it happened rather
than what did it: the subtree of the commit the interaction joined. That name is worth less than the
number beside it and the two are kept apart. The milliseconds are the browser's, so the confidence
is about them alone — whether any of the total had to be apportioned — and it is never lowered to
cover a doubtful name. The name is dropped instead, for the invoker the browser charged the script
to, whenever the commit only overlapped the interaction in time, was walked short of the end, or sat
beside commits that could not be tied to the interaction at all. Render durations play no part in
that: a production build times nothing and its subtree names are no worse for it.

The invoker is only a name for the whole layout while one script holds nine tenths of it. The
browser charges forced layout per script, so a window holding three of them holds three totals, and
`blame.ms` is their sum: printing one invoker beside that sum says that script cost the lot. Below
the nine tenths there is no name — `name` is null — and nothing is claimed that the evidence does
not carry.

The invoker goes in the sentence either way ("It was charged to `IntersectionObserver.callback`", or
"80 ms of it was charged to …" where it holds less), because a script that merely ran inside the
same window is charged separately and looks identical from the React side, so the subtree alone can
send a reader to a file with nothing to do with it.
**Decided not to change the name on that basis**: the only held signal is the invoker string, and
`ranAsHandler` is a time-window test an observer callback inside the window passes. The field that
would settle it, LoAF's `invokerType`, is not captured, and adding it changes a published type on a
guess about what Chromium reports for React's own dispatch. The sentence carries the doubt instead.

The demo's layout-thrash scenario is the case: 400 layout effects writing a style and reading a size,
about 190 ms of layout against a 48 ms render, named `LayoutThrash` with `PriceTicker ×400` beside
it, exactly as the render blame it replaced was.

Without Long Animation Frames that layout is not measured at all, and until 2026-09-23 it went to the
handler. A render duration stops where committing starts, so 400 layout effects reading geometry are
nowhere in it, and the working time outside the render was all the handler's: on Linux WebKit in CI
the same scenario came back as `onClick` running for 465 ms beside a 404 ms render. A development or
profiling build keeps when React began each render, as the root fiber's `actualStartTime`, on the same
clock as `performance.now()`, and the commit hook runs after the layout effects. So from that start
to the commit's end is React's own time, committing included (`CommitSummary.startedAt` to `at`).
A span only counts when it began and ended inside one event's handlers. React does not yield in
there, so a render that began before them or committed after them stopped on the way, and what ran
meanwhile, the handler most often, was not React's; that commit falls back to its render duration.
Where spans overlap (a layout effect flushing another root with `flushSync`) they count once. The
handler now takes what lies outside both React's time and the forced layout the browser measured.
The two are not added together: a layout effect's forced layout sits inside the commit, and counting
it twice would leave the handler less than it ran, so the larger one is taken. Neither is exact:
geometry read in a render body is in the render and the layout both, as the layout branch says, and
forced layout in the handler's own code, beside a commit busy with other work, stays in the handler's
figure rather than the layout's. The render keeps the blame, however small the render itself was,
once committing took as long as the handler would have needed to be blamed (25 ms and a quarter of
the working time), since the time taken off the handler has to land somewhere. The commit it names
is the one React spent longest on with committing counted, and its sentence says what that commit's
committing took. A production build keeps no start, so nothing changes there.

`useEffect`s were left with the handler until 2026-09-24. React 18 and 19 run a click's or a key's
passive effects in the same task, right after the commit hook, so a heavy one read as `onClick` in
every browser: a chart drawn for 300 ms in an effect came back as the handler running 311 ms beside a
5 ms render. React calls `onPostCommitFiberRoot` once a commit's passive effects have run, production
builds included, and the hook now stamps that on the commit (`CommitSummary.effectsEndedAt`), with
the moment the hook call for the commit returned (`effectsStartedAt`). The walk and React DevTools'
own reading of the commit run inside that call, and neither is the effects' time. From one to the
other is React's time as well, under the same rule as the render span: it counts only where both ends
fall inside one event's handlers, so the effects of a transition, which React runs in a later task,
count for nothing, since another task can have run in between. The effects add to the commit's
committing time for the 25 ms test, and the sentence says each of the two that would show alone, or
both where only their sum does, or the totals across the commits where only those earned the blame.
A production build has no render start, but the effects are measured all the same, so there the
render is named as a reading and the effects carry the figure. What is left of that build's working
time is the handler and the render together, unsplit, so the effects take the blame there only where
they are at least half of it, or where there is no handler's name to give the rest; below that the
handler keeps it, with the effects taken off its time and said. A development build's handler keeps
the blame, too, where React's time would not earn one: a 28 ms handler beside a 4 ms render and 24 ms
of effects. Committing and effects only choose the commit a render blame names where they are worth
a mention, and a sentence that names one commit gives what the others spent where that is worth
saying, so none of it goes unsaid under the wrong name. The handler, for its part, now has to outrun all of React's time to be the blame, committing and
effects included, not only the render durations it was held against before spans existed. A render
blame's milliseconds are the commit's in all, render, committing and effects, since that is what it
accounts for.

React commits some updates once a commit's effects are done and before it says they ran: one an
effect made with `flushSync`, and one a layout effect made, the measure-then-`setState` a tooltip
does (in 18.3.1 `flushSyncCallbacks` and in 19.3 `flushSyncWorkAcrossRoots` run just before the
call). Such a commit lands inside the effects' span. Where it has a span of its own it is taken out,
like its walk; in a production build it has none, and the sentence says the figure holds one more
render. In a React 19 development build the figure also holds the time React takes logging the
components it rendered to the Performance panel, which it does in the same phase.

React makes no post-commit call for a commit whose tree has no passive work, so the hook cannot
simply take the latest commit. It keeps a place for every commit of a root, walked or not, with
whether its fibers carry the flags that make React run the passive phase: Passive and ChildDeletion,
and from React 19 Visibility, the same bits in both. A call goes to the newest place with those flags,
and the places above it are dropped. That is right because React flushes a commit's pending effects
before it renders the next one, so only the updates above can come between a commit and its call,
and those came later: the ones with effects have had their own call first, and the ones without get
none. A React 19 development build also calls for every commit it timed, effects or not; that call
then goes to the commit the update was made in, whose effects had ended by then, so its end comes out
a little late, by a render that is taken out as its span. A root made with `ReactDOM.render` in React
18 runs a click's effects whenever React next renders, possibly later in the same handler, so its
commits get no effects' time. React 17 makes no call at all, so nothing changes there.

**Follow-ups.** Commits that land after the paint but within `inputWindow` (1.5 s by default) of it,
stamped with the same input, with no newer input in between and no `input`, `change` or `submit` a
script dispatched after the paint. Effects, transitions and data-driven
re-renders show up here. The window runs from the paint, not from the input, so an interaction that took
three seconds still gets the render its effects schedule a moment after it. Where the commit's own input
is a later one of the same interaction whose work ended after that paint, the click that releases a
pointer held down past it or a click whose pointerdown was the slow part and painted first, the window
runs from the end of that input's work (`work.endedAt` in the ring), which is where the hook measured
it from. So the hold is not counted against the render the release made, and a window set shorter than
1.5 s does not drop a render the hook walked for that input. It runs from there only while the ring
shows nothing else pressed between the interaction's first input and that one: a pointer held down
through a key press, say, or a release whose press the hook could only guess at and took the newest one
for. A click made from the keyboard is neither. It belongs to the key whose task made it, Enter's keydown
or a Space's keyup, and a click with `pointerId` -1 and no input's task behind it is a gesture of its
own. The hook paired a keyboard click with the newest pointerdown of the last 5 s until 2026-09-23, so
Enter on a button inside the window from an earlier mouse click's paint had its render joined to that
mouse click. A tap's click can land in a key's task too: Chromium can run it ahead of the timer a key
pressed just before it left to end that task, since input outranks timers. So a touch or pen click whose
pointer went down and has had no click since stays with that pointer. Until 2026-09-23 this window was a fixed
1.5 s whatever `inputWindow` said, and always ran from the paint. A page that set `inputWindow` to 3 s
paid for the walk of a render 2 s after the paint and never saw it in a report, and a press held for
2 s lost the render its own click made inside its dispatch.

"No newer input in between" is checked against the ring, not against the stamp alone: a commit made
outside any dispatch carries whatever input the ring last held, and that can be an interaction two
steps back. Sorting a table in the TanStack Table example and then changing its page size a second
later made exactly that report, where the sort click was told it had re-rendered 417 components a
second after its paint, when the page-size change had done it. So when an input that is not one of
this interaction's own arrived after all of them and before the commit, the commit is attached to
nothing: the library cannot tell whose it is, and a wrong attachment reads as a finding. The ring is
the whole of that evidence, which bounds the check: an update with no user input behind it at all, a
timer firing or a message from a socket, is invisible to it and is still read as this interaction's
follow-up render. So, until 2026-09-25, was a test script setting a select's value and dispatching
`change` itself. The harness's `page-size-50` step does that through Playwright's `selectOption`, and
the `tt-fuzzy` sort click collected the page-size render 1017 ms after its paint.

Since then a capture listener on the window hears `input`, `change` and `submit` too. One a script
dispatched outside any input's task is noted on the newest input (`InputWork.closers`, the first 16),
and a commit after one that came after the interaction's paint is attached to nothing, as after a
newer input. It is not an input: Event Timing has no entry for it and the ring never holds it, so it
never starts a report. One the browser fires is left alone. It comes in the task of the key or pointer
that caused it, or carries on what that input began (an option picked from the native select the click
opened, or text dictated into the field it focused), which `dispatchedInput` hands to that input
within `inputWindow`; and a person picking a page size presses something first, which the ring already
holds. One a script fires in the task of such a trusted event answers the same input and is left alone
too (`derivedTask`), as when a select's onChange fires `input` on a second field to keep it in step. A
script's `click()` does not count either, as no untrusted input does. The price is a page whose own
code dispatches one of those events after the paint, from a timer or from an effect React runs in a
task of its own (React 17 runs every effect that way): the interaction loses its later renders from
there, the one that event's own handler causes included.

A run on the shadcn/ui documentation site on 2026-09-20 produced a fourth: resizing the viewport. A
theme toggle was credited with a second render of 441 components inside `SidebarContent` 982 ms after
its paint, and the render was the site's `useIsMobile` media query firing when the harness narrowed
the window to 390 px for the step after it. The next click came 446 ms later still, so no newer input
had arrived and the check above never had anything to fire on. It is the same limit, not a new one:
the ring holds inputs, a resize is not one, and the commit's own stamp says the theme toggle because
the theme toggle is the last input the ring held. Nothing here can tell that apart from the render an
effect of the theme toggle might genuinely have scheduled a second later, and the default window is
1.5 s because the renders worth reporting land inside it. A longer `inputWindow` reads more of these.

Since 0.7.0 the hook tells some of them apart by what the page was doing as React committed, which
costs nothing until a commit is in the window. A MediaQueryList's `change` is dispatched like any other
event, React treats `change` as discrete and renders inside it, so `window.event` is that `change` while
React commits; a derived event now counts as part of an input only when its target is a node, and a
commit made while a resize, a scroll, a wheel, a hover or a media query's `change` is being dispatched,
outside any input's task, is nobody's and is not walked. That catches the shadcn/ui case and everything
React 17 renders, which it does inside the event. A resize hook that waits for a timer has no event to
read, so a capture listener notes when the window's width changes and a commit outside any dispatch after
that is the page's. React 18 and 19 render a hover's or a scroll's update in a task of their own, where
`window.event` is empty. React 19.1 and later pass the hook the priority of the lanes they committed
(user-blocking for that work) in development and profiling builds; React 18 and 19.0 pass the priority of
the moment of the commit, normal in that task, and production builds pass none, so there such a render still
joins. An input's own updates are immediate and what its effects and timers set off is normal or lower, but a
touch fires pointerover and pointerenter of its own, whose updates get user-blocking priority too: a finger
held on a card whose onPointerEnter opens it has the card rendered in React's own task, stamped with the
pointerdown. So behind a touch, and inside an input's own task, the priority is not read. Event Timing may
leave that pointerdown out, under 16 ms, so a commit joins by the press its interaction's inputs released as
well as by their own stamps. The demo's `#ambient` page and its spec check the breakpoint case on React 17 to
19.3, and the hover and scroll cases where the React version and build say whose they are; the phone spec
checks a finger's hover render stays the tap's.

**Saying it in plain words.** Every report carries an `explanation`: a headline ("264 ms
click"), a rating on the INP thresholds in web-vitals' words (good to 200 ms, needs improvement to
500 ms, poor beyond),
where it happened (the element's own label and the nearest component owning it that a reader could
go and look for), one sentence for
the cause, extra sentences only when they earn their place, and the time split into three
phases a person can picture: waiting before the handler, working, updating the screen. The
cause separates React's render time from the rest of the working time (the handler and other
scripts) after subtracting forced layout, so a slow handler is named as such rather than
blamed on a two-component render. Later renders only get a sentence when they carry real
work (10 ms or 25 components), otherwise the page's own status pill or reporting panel would
show up in every report. The `verdict` string is the explanation joined into one line. Both
are built the first time something reads them, and again after the report changes, not in the
Event Timing callback, where the time would come out of the next interaction.

**Nothing inside the working time is blamed for more than the working time.** A render, a handler and
a forced layout all happened inside that window, so none of them can account for an interaction whose
time went on the screen update instead. So the screen update is weighed against the working time
itself, once, rather than against each branch's own claim in turn: where it is longer than the
working time, and long enough to be blamed on its own, every branch inside that window steps aside.
It is the same test the painting branch asks, which is what makes it safe — a branch closed here is
a branch the painting branch opens, so a verdict can never be refused for the screen update and then
fall past it to a script or to nothing at all. Weighing it claim by claim did exactly that: a 90 ms
render inside 100 ms of working time, against a 95 ms screen update, lost the render branch to the
95 and the painting branch to the 100, and came back as `none`. Without
that rule the render was tested first and a component count decided the verdict: on the shadcn/ui
site, paging a calendar forward one month (5 ms of working time, 82 of the screen updating) came back
`render` and `inferred` because the commit touched 332 components, while toggling the theme (2 ms and
85) came back `painting` and `measured` because its commit touched two. Two interactions of the same
shape, one offered as a guess and the other as a measurement. They now read the same.

**How sure the blame is.** The cause is chosen by named thresholds, each with its reason beside
it in `join.ts`: the handler is blamed from 25 ms of working time outside React's own time (the
larger of two figures: each render's start to its commit's end, where the build keeps the start, and
the render durations plus the forced layout), and only when that is a quarter of the working time
(in a production build committing the demo's 1441-row list takes a fifth of it outside React's
durations); a render from 5 ms with durations, or from 10 components by counts
and 50 beside a named handler, and by counts never under 50 ms of working time; forced layout from 50 ms, or 25 ms without render durations, and half the
window it was counted across, and never over a longer wait before the handlers,
with one script having to hold nine tenths of a window's forced layout before its name is used for
all of it; a Long Animation
Frames script from 20 ms; waiting, painting and
working time known only by counts from 50 ms, the length of a long task. The hot path follows a
child carrying 60% of its parent's work (`fiber.ts`). Where React timed each component and one of them,
rendered once, spent 25 ms and half of the render or more in its own render, the sentence says so
rather than leaving the reader with the count: sorting TanStack Table's 200,000 rows reads "re-rendering
637 components inside TableBody (257 ms of it in TableBody's own render)", `blame.detail` is "TableBody's
own render", and a note says that time is usually work TableBody does as it renders, like a sort or a
filter, which memoising the rows does not speed up. A render is said to be "mostly" one component only
where that component is half of the components rendered or more, a styling library's wrappers not
counted, or half of the render's time: "mostly Label (4 of them)" in a render of 59 components on the
shadcn/ui docs sent the reader to the wrong file. The count said to be inside the component a render
is named after is that component's own where the walk counted fewer there than in the commit, with the
component the render started from named where it holds them all and a reader could search for it
("1216 components from EventTypeWeb down, 812 of them inside EventAdvancedWebWrapper", the 812 a read
of cal.com's source rather than a run). A walk cut short says both counts as lower bounds, and a render
is "mounting" where more than half of its components rendered for the first time. A hydration blame
keeps the whole count, since the boundary or page it is named after holds every component hydrated,
and so does a render named after the component it was mostly made of.
`explanation.blame.confidence` says what the
call rests on. It is `'measured'` when the blame follows from timings of the interaction itself:
React's durations for commits joined by their exact input stamp and walked in full, the browser's
own phases, a script's Long Animation Frames entry. It is `'inferred'` when the blame is the
likeliest reading of weaker evidence: render counts (production builds, coarse clocks), a commit
that only overlapped the interaction, a walk cut short, or no Long Animation Frames to rule other
scripts out. `verdict`, `cause`, `notes`, `headline` and `where` are display text that may be
reworded in any version; `blame`, `rating`, the phases' milliseconds and the report's own fields
are the data, and the demo's specs assert on those.

**Which end of the owner chain the sentence prints.** `where` named `target.owners[0]`, the innermost
component enclosing the element, until 2026-09-20. On a design-system app that is never the app's
own component: across seven interactions on the shadcn/ui documentation site it printed `in header`,
`in Primitive.button` twice, `in Primitive.input`, `in Primitive.div` and `in _`, with
`DataTableDemo`, `CalendarDemo` and `CommandMenuItem` sitting further up the same chain every time.
So the report names the nearest owner whose name a reader could search their own code for, and the
chain itself is untouched on `owners`. A name counts when React would accept it as a component name
and a minifier has not cut it down: capitalised, three characters or more, and every part of a dotted
name the same. That is three rules from three observations. `header` came from a column definition's
`header: ({ table }) => …`, which is a property name lent to a render function and reads as an HTML
tag; React's own rule is that a component name is capitalised, so a lowercase one is not a component
anybody wrote. `_`, `ee`, `V`, `$` and `et` are what a minifier leaves on react-day-picker, next-themes
and cmdk, none of which ship a `displayName`, and the display-names loader only stamps the app's own
files. `Primitive.button` names the element that was clicked, so "button in Primitive.button" tells
the reader nothing they did not write themselves. Where nothing in the chain passes, the innermost
owner is printed as before: a name is never invented, and `in $` at least matches what a profiler
would show.

The working time leaves out this library's own walk. A commit during the handlers is walked
inside that commit, so the browser counts the walk as processing; the report takes it back out
as `walkMs` (`inputDelay + processing + walkMs + presentation` is the duration), and the
explanation says how much once it rounds to 1 ms or more. The headline stays the browser's
number, so it still equals what web-vitals reports for the interaction.

**Quiet interactions.** The observer runs at the browser's 16 ms floor; interactions under
the reporting threshold (40 ms by default) are held back, not dropped, and surface only if a
heavy later render that INP leaves out attaches to them. A 24 ms click that triggers an 85 ms render
after the paint is worth a sentence even though INP alone would never flag it. A render inside
another of the interaction's own entries is not one of those. A pointerdown held past its paint is one
interaction with its release, and the render the pointerup makes in its own dispatch lands after the
press's paint but inside the pointerup's entry, which INP counts. Until 2026-09-25 that render
published a 32 ms pointerdown on excalidraw's canvas, with a note saying INP didn't count it; now it
keeps the press quiet. Where the report is published anyway, the note is about a render INP left out
if the report holds one, and otherwise says the render came on the release and says nothing about
INP. A render that began after the pointerup came and committed while it waited for its handlers is
inside the entry too, since INP counts that wait. The pointerup's entry can be under the 16 ms floor,
and a report is explained when it is read, by which time the ring may have let the input go, so the
hook marks a commit it made in the dispatch of the input it is stamped with
(`CommitSummary.inDispatch`). A render React made in a task of its own can still land before the
release paints, and the release's entry only comes after that paint. So a render stamped with a
release that came after every entry's paint, less than `threshold` after it, waits for that entry
before it can publish the press (`awaitsEntry`). A newer interaction's entry ends the wait, since it
never comes first, and so does the page being hidden: a release under the floor sends none. A render
`threshold` or more after the release does not wait, as an entry holding it would publish the press
on its own, and neither does one after a tap, whose click came before the pointerdown painted and was
presented with it. Under the floor there is nothing to hold back: the browser sends no `event` entry
for an interaction that paints in less than 16 ms, so a render its effect sets off after the paint has
no report to attach to, however heavy. The page's first input is the exception. The browser also
reports it as a `first-input` entry at any duration, carrying its interactionId, so the observer takes
that entry too, as web-vitals' onINP does, and drops it when the `event` entry exists as well. For
every later interaction under 16 ms the render stays unreported: its stamp still names the
input exactly, but with no entry there is no latency to headline and no paint to place the
render after, and making either up would be a guess. Found 2026-09-14 on the React 17 variant
on Windows, where the cascading-effect click painted about 12 ms after the press, the point at
which Event Timing's 8 ms rounding splits 8 from 16: from 1 in 20 to 3 in 10 runs emitted no
report at all. The parent of the `Event.timeStamp` join commit failed the same way (6 in 30),
so the join did not cause it. React 18 showed the same timing (the scheduler task rendering the
details started 14.0 ms after the press, median, against 13.8 on React 17) and simply did not
round down in 20 runs.

**Late arrivals.** A profile that renders 500 ms after the click, once the server answers,
lands long after the report was first emitted. Such renders attach to the existing report
(same input stamp, no newer input since and no scripted `input`, `change` or `submit` since the
paint, within `inputWindow`), and listeners receive the next
revision: a new frozen report with `revision` bumped and its own explanation, the earlier one
left as it was (before 0.1.0 the same object was changed and handed over again). Long animation
frames that
arrive for those later renders fold in the same way, into every published report whose window or later
renders they overlap. Until 2026-09-25 only the newest report took one, so on an undo in excalidraw,
Control pressed 8 ms before z, Control's report never got the frame z's handler ran in and said only
that its screen took 64 ms to update. A report keeps the frames it has joined even
once the page's store of the last 60 has let them go: until 2026-09-15 the newest report was rebuilt
from that store on every frame, so after a minute of scrolling it lost its own frames and its verdict
fell back to "no long task was recorded". So do late Event Timing entries: an
interaction's entries arrive with the paint that presented them, the pointerdown in one
frame and the pointerup and click in a later one when the pointer was held, a keydown before
its keyup. There is no settle timer any more (a 150 ms one used to split a long press into
two reports): the report is built from the first batch, rebuilt as its next revision when the
rest arrive, and a quiet 30 ms tap that turns out to be a 100 ms click
is published at that point. Waiting for an interaction to be "complete" was never possible
anyway, because entries under the observer's 16 ms floor never arrive at all.

**Navigations.** Every report carries `navigationURL` and `navigationType`, with web-vitals' names
and values, so it lines up with the INP web-vitals reports for the same navigation. The page's
navigations begin with the document's own, named from its navigation timing entry the way
web-vitals names it (`navigate`, `reload`, `back-forward`, `prerender`, `restore`). A `pageshow`
with `persisted` adds a `back-forward-cache` navigation, and `react-inp-blame/next` adds a
`soft-navigation` for each App Router navigation, through the `onRouterTransitionStart` hook Next.js
calls on the module it injects. A report is placed in the newest navigation that had begun when its
first input did, so a click that starts a navigation belongs to the page it left. Next.js 16.3.5
calls the hook synchronously inside the click's dispatch (a Link's click handler calls
`startTransition`, whose callback dispatches the navigation, which calls the hook), so
`window.event` is that click, and its `timeStamp` joins the navigation to the click's report with
the same exact match commits use; the report names it in `startedNavigation`. Under
`experimental.instrumentationClientRouterTransitionEvents` the hook also gets an event whose
`timestamp` is a Unix epoch time (Next.js computes it as `performance.timeOrigin +
performance.now()`); the library subtracts `timeOrigin` and takes it as the navigation's start, and
without the flag reads `performance.now()` itself. A navigation started with no input being
dispatched, a `router.push()` after an `await` or the browser's back button, is named on no report.
At each soft navigation and back/forward cache restore the INP estimate starts over from the
interactions that began after it, and quiet interactions held so far are let go, so renders of the
new page stamped with an input from before it cannot publish them. The App Router announces a push
or replace without `basePath`, so `withInpBlame` hands the module the app's `basePath` to put back.
Next.js calls the hook only for the App Router. The Pages Router's client entry imports the injected
modules too, which gives it attribution but no navigation join. Its production entry, `next.js`, imports
them before the module that loads react-dom, but its dev entries, `next-dev.js` and
`next-dev-turbopack.js`, import that module first and the injected ones later, through `page-bootstrap`
(read in 15.5.26 and 16.3.5). A Pages Router page on `next dev` from 15.3 therefore read nothing until the
wrapper also put the install first in that entry: in webpack's `main` entry, and under Turbopack through a
rule on `next-dev-turbopack.js` whose loader adds the require on the line of its `"use strict"`, so no
line moves. `apps/next-demo/pages/pages-router.tsx` is checked by `e2e/pages-router.spec.ts` in every
Next.js suite, and `fixtures/next-14` has a Pages Router page beside its App Router one. `apps/next-demo/e2e/load-order.spec.ts` clicks a Link whose handler takes 60 ms and checks the
click's report, the reset and a report on the page it opened, under `next dev` and both production
builds.

All of this, from quiet interactions and publishing to late entries, late frames, later renders
and the limits (50 published reports, 20 quiet ones, the entries of the 100 interactions heard
from most recently), lives in `lifecycle.ts`. It reads no browser globals and its transitions are
unit-tested one by one; `install()` only wires it to the observers, the DevTools hook and the page.
Past 50 the oldest report goes first, but never one of the ten slowest (`KEPT_SLOWEST`, as many as
web-vitals keeps candidates for INP) or one INP can still point at: the estimate's, and those of the
candidates it moves down to every 50 interactions. Until 2026-09-25 reports went first in, first out,
and drawing sixty rectangles in excalidraw pushed out the key press that was the page's INP, so
`inp().report` came back null, and so did the `react` field `attributeINP` adds. Keeping the estimate's
report alone was not enough either: after a navigation, ten slow clicks on the page before it filled the
ten slowest, and by the time the fiftieth interaction moved the estimate to the second slowest click
since, its report had gone. The ten slowest outlive a soft navigation, where the estimate starts over,
because web-vitals does not start over there unless asked to report soft navigations.

**Output.** An `InteractionReport` object, a listener API, and entries the Chrome Performance
panel (128+) draws as custom tracks, in a "react-inp-blame" group beside React's own
"Scheduler ⚛" and "Components ⚛".

- The report is a contract from 0.1.0. It carries `schemaVersion` (1 until 0.3.0, 2 until 0.11.0, 3 since), which
  changes when a field is removed or changes meaning, and it is frozen down to its commits, frames and
  explanation.
  Each commit a report holds is a frozen copy stamped with how it joined that report
  (`joinedBy`), so a commit in two reports no longer carries whichever join came last.
  `onInteraction` is the one way to hear reports, and each report reaches it in a task after the one
  that published it; the `onReport` option was deprecated at 0.1.0 and is now gone. What is there for debugging (every commit walked, the hook's owner, its
  renderers and the lockout flag) is under `api.debug`, outside the contract, while `stats()`
  keeps the mode, why a page is unsupported and the costs. `debugGlobal: true` puts the API on
  `window.__REACT_INP_BLAME__`.

- Each report is one entry in an "Interaction blame" track (not "Interactions", which is
  Chrome's own track), from the input to the paint, in `warning` like React's event spans, with
  the verdict as its tooltip and the phases as properties. It is a `performance.measure` with a
  `devtools` detail, because `console.timeStamp` carries no tooltip: a seventh argument reaches
  the trace as an empty field in Chromium 147.
- Each commit joined to the report gets an entry in a "React renders" track, but only where
  React draws none itself. Development builds of React 19.2 and later draw every component in
  Components ⚛, and there the interaction's tooltip points to it instead; production and
  profiling builds, and development builds of React 17 to 19.1, get the track. The colours
  follow React's: `primary` for a blocking commit (immediate or user-blocking priority),
  `tertiary` for a deferred one (normal priority or lower, which covers transitions, deferred
  values and updates from effects or timers alike, since the priority cannot tell them apart),
  `error` when React passed `didError`. Production builds pass no priority, so there a commit
  before the paint is `primary` and one after it `tertiary`.
- Chrome 134 and later take the renders through `console.timeStamp(label, start, end, track,
  group, color)`, as react-dom does. Earlier Chrome, and every other browser, has the
  one-argument `console.timeStamp` and silently drops the rest, which no feature test can see, so
  the choice is made on the `Chrome/NNN` version in the user agent; the fallback is a measure.
  Every measure is taken out of the User Timing buffer with `performance.clearMeasures` once
  drawn, so the buffer does not grow with each interaction.
- Entries are drawn when the page is idle (`requestIdleCallback`, within a second), so building
  the verdict for the tooltip stays out of the callbacks that can delay the next input.

`apps/demo/e2e/devtools-track.spec.ts` reads the trace JSON for all of this, in development and
production builds and with a Chrome 133 user agent. Older Chrome shows the measures in the
Timings track. Nobody has yet opened the trace in the Performance panel and looked.

**The badge and panel** (`overlay: true`, or `'query'` for production pages, 2026-09-14).
A corner badge with the page's INP so far, coloured by the INP thresholds, and a panel that
lists interactions newest first: title ("Click on Log in"), duration, one blame line, and the
waiting / working / updating bar. Consecutive key presses in one field collapse into a row
that shows the slowest and the typical. A row opens into the cause sentence, the notes, and
the components that rendered before and after the paint. It is plain DOM in a shadow root
(no React, so it renders while React is busy and never adds a commit), about 3 ms of work per
report, and the page's own clicks on it are dropped before they become reports. Its code
arrives by dynamic `import()` after `install()` has returned, so a page that never shows it
never downloads it, and `mountOverlay()` returns a promise of its handle. The blame
line comes from `explanation.blame`, a data twin of the cause sentence decided in the same
branch, so the short and the long form never disagree. Page INP, on the badge, in the panel
head and from `api.inp()`, is the web-vitals estimate computed in-library, with no web-vitals
dependency: the interaction count is `performance.interactionCount` where the browser has
it (Chromium 147, Firefox 148 and WebKit 26.4 all do), else the spacing of `event` entry ids
(Chrome steps ids by 7); the 10 longest interactions are kept by their longest single entry;
INP is the one at index `min(floor(count / 50), n - 1)` among the `n` kept, longest first, chosen as
entries arrive and again when the page is hidden, which are the two moments web-vitals chooses at. After
a soft navigation or a back/forward cache restore, interactions the browser counted but sent no entry
for read as the 8 ms
web-vitals stands in for them, with `interactionId: null`. It counts every interaction
the observer sees at its 16 ms floor, plus the page's first input at any duration. The demo's
own "Page INP so far" line reads the same call, so the page never shows two INPs that disagree.

Three details make it name the same interaction as web-vitals, not only the same number. Each
observer batch is taken sorted by the time its entries were presented, the order web-vitals
processes them in, so interactions of equal latency rank alike; the id spacing counts `event`
entries only, as web-vitals' polyfill does; and the interaction INP points at is chosen after each
batch and kept while the value stays the same, since web-vitals moves `metric.entries` only when
the value changes. `apps/demo/e2e/inp.spec.ts` runs web-vitals 6.2.2's `onINP` beside the library,
with `reportAllChanges` and `durationThreshold: 16`, through a session of a quiet first click,
typing, clicks and more than 50 interactions, and asserts after every interaction that both name
the same value and the same interaction. It runs in Chromium's own headless mode, where a click
that changes nothing paints within a frame: Playwright's default headless shell reports nearly
every click at 16 ms or more, so the first input would seldom be quiet there. Even in that mode the
first click waits for the page to settle. A few hundred ms after navigation the demo's start-up
work ends in a long animation frame of 56 to 89 ms with no script attributed to it, and a click
landing next to it waits for that frame: clicked as soon as the form appeared, 6 of 60 first clicks
on a freshly launched browser read 16 to 72 ms. Once the badge was up and the page had had an idle
period and painted two frames, all 120 read 0 or 8 ms. A slower machine can still miss the frame, and
a page has exactly one first input, so the spec makes that click on up to three freshly loaded pages
and keeps the first page whose click was quiet. If none of them is, it carries on with the last page
and annotates the run to say that path went unexercised there, rather than failing on the machine.

The two still part in four cases. web-vitals observes at 40 ms unless given `durationThreshold:
16`; at its default, interactions of 16 to 40 ms are not its candidates, so the numbers differ
when INP is under 40 ms or fewer than floor(count / 50) + 1 interactions reach 40 ms (Next.js's
`useReportWebVitals` passes no threshold). Both start over after a back/forward cache restore, but
web-vitals starts over at a soft navigation only when asked to report them, and learns of one from
the browser's soft navigation entries where the library learns of it from the router (see
Navigations above), so at a soft navigation the two can start over at different moments, or only
one of them at all. The library starts over on `clear()`, including the panel's Clear button;
web-vitals does not. web-vitals updates once the page is idle, so for a moment after an interaction the
library's number is ahead, and when the page is hidden it also takes the entries its observer has not
delivered yet, which this estimate sees only when they are delivered. And Next.js 16.3.5's
`useReportWebVitals` runs the web-vitals 4 it vendors, which after a back/forward cache restore keeps
counting every interaction since the page loaded (its base is only ever set to 0), so past 50
interactions before a restore that copy and this estimate can point at different interactions.

**Production builds and small renders.** Without durations, a 10-component render can win
the blame over a 260 ms handler. Since 2026-09-14 a render only earns it in production when it
is large (50 components when a handler is named, 10 otherwise), and a named handler with a
small render is blamed as "most likely", with the note that a profiling build would give exact
numbers; its `confidence` is `'inferred'`. LoAF cannot separate the two: the handler and React's
sync render run inside the same script entry. It can separate out the forced layout inside that
script, which is measured whatever the build records, so since 2026-09-20 a large forced layout
outranks a render the build never timed and stays `'measured'` there. It is the only blame about
React's own work that does; the phase blames (`waiting`, `painting`) and `script` come from the
browser and never depended on the build at all, though `script` turns `inferred` when a commit could
not be tied to the interaction, which has nothing to do with which build is running.
A minified handler keeps only the name of the prop
it was found on, so production sentences say "the onClick handler".

**Counts under a long task.** Since 2026-09-25 a count also needs 50 ms of working time, the bar the
handler rung already had and the `LONG_TASK_MS` comment describes, taken on the figure the sentence
prints: excalidraw re-rendered 149 components in 2.8 ms of a 40 ms click and read as the render,
since the 34 ms screen update is only weighed from 50 ms, and a shadcn/ui Sheet closing re-rendered
56 in 17 ms and read the same, when most of the 17 ms is a style recalculation Radix forces. Under
the bar nothing in the working time is blamed, the handler's script included where a frame lists
it, since that script holds React's render too. The cause leads with the working time and says the
count sat in it, short of a long task, rather than calling the render small; the sentence that does
name a render by its count gives the working time the count is read against. Where LoAF is
supported and no frame covered the interaction, the frame was under 50 ms and whatever style
recalculation and layout it forced went unmeasured (the Sheet opening on a phone forces four
whole-document recalculations inside 31 ms of working time), and the sentence says so. Hydration is
the exception: a boundary the interaction waited for is named by its count at any working time, as
it was.

## The demo

Two demos in one Vite app. The default page is a sign-in flow for a made-up photo app,
Framely, in a plain look of its own, with four mistakes real apps make: the email field's state
sits in the page, so each keystroke re-renders a phone preview of 1000 tiles; the password
field scores strength synchronously in its change handler; the login click hashes the
password on the main thread before the request; and the profile grid's tiles each measure
the grid in a layout effect. A "What took time" panel lists every step in the order it
happened, key presses grouped per field, the server wait shown between the click and the
profile render, and the page's INP so far at the bottom. `#lab/...` keeps the seven isolated
anti-patterns with a "what's wrong / the fix" note each. Both have Playwright coverage.

**Margins.** A demo test should pass because the library attributed the scenario, not because the
timing fell right. On 2026-09-15 every scenario and the sign-in flow ran 12 times on the Windows PC
in development and production builds, and the lab also on React 17 and 18, and each value a test
rests on was set against its threshold. Five were within a factor of two. Layout thrash's render
took 4.8 to 7.9 ms on React 17 and 18 against the 5 ms a render needs, and on React 17 some runs
blamed the click's script instead; its rows now spend 0.05 ms each formatting a price, and the
render takes 42 to 49 ms. The password field's handler worked 91 ms in production against the 50 ms
a "most likely" handler needs; it now scores the password for 110 ms, and works 111 ms. The login
click took 264 ms against the 200 ms that ends "good"; it now hashes for 400 ms (400 to 408 ms), and
the server answers in 200 ms rather than 450, so the profile renders 687 to 704 ms after the click
instead of 797 to 819 ms, inside the 1500 ms a later render may take by a factor of 2.1. The
input-delay test's later render landed 1374 to 1395 ms after its click; the test now holds the main
thread for 350 ms before a cascading-effect click, which waits 323 to 328 ms and whose later render
lands 410 to 431 ms after it. Two values cannot reach a factor of two and do not have to: the hot
path's share is 100% where one child carries all of its parent's work (60% is needed), and the
cascading-effect click paints in 16 ms, on the observer's floor, but it is the page's first input,
so it also arrives as a first-input entry at any duration.

## Production mode

What works with a plain production React build, no profiling build, no DevTools:

- which components rendered, how many, under which subtree (counts, not durations)
- the target component and its owner chain, minus the names the minifier took
- forced layout inside the handlers, measured, and blamed as such when it is the larger part of them
- the name of the handler prop that fired
- input delay, processing, presentation delay, forced layout, script attribution from LoAF
- follow-up commits after the paint

What needs help:

- **Names.** Minifiers rename functions. Vite 8 minifies with Oxc and ignores esbuild's
  `keepNames`. The fix is to append `Foo.displayName = "Foo"` to every component file:
  string literals survive any minifier and React DevTools honours the same property. It
  ships as `react-inp-blame/display-names-loader`, a webpack-style loader that only needs
  the source string, so it runs under Turbopack (`turbopack.rules`, the Next 16 default,
  where a `webpack()` hook never runs) and under webpack (`module.rules`), and
  `react-inp-blame/vite` runs the same function as a transform. Proven on Next 16.3.5 in
  production, 2026-09-14. Cost, for the guarded stamps written since 2026-09-19 (below), is
  about 120 bytes minified and 16 gzipped per function component and about 35 and 6 per `memo`
  or `forwardRef` one, against about 20 and 5 for a bare assignment (rolldown 1.2.8, twenty
  components with four-letter names). The alternatives are worse:
  `next build --no-mangling` keeps every name (+9.6% gzip on react-dom alone), and an SWC
  plugin has to be rebuilt against each Next release's swc_core.

  What it stamps, since 2026-09-19: any capitalised binding declared at the start of a line whose value
  is a function. `function Foo`, `export default function Foo`, `const Foo = (props) => …`, `const Foo =
  function () {}`, a typed `const Foo: React.FC<Props> = …`, a generic `const Foo = <T,>(props: T) => …`,
  and the `memo`, `React.memo`, `forwardRef`, `memo<Props>(…)` and `memo(forwardRef(…))` forms. Until
  then it matched `function Foo(` and `const Foo = memo(` or `forwardRef(` only, so the form most
  components are written in, an arrow function bound to a const, reached the minifier unnamed.
  A function expression that is **called** is not one of these shapes: `const Version = function () {
  return 5; }()`, and the `.call`, `.bind` and index forms, bind whatever that produced rather than the
  function that was written. Nor is anything in a module whose first statement is `"use server"`, where
  every export is an endpoint and the bundler rewrites the module into a table of them; `"use client"`
  modules are ordinary modules and are stamped as usual.

  It still reads the source as text, with no parser dependency: strings, templates, comments and regular
  expressions are masked to blanks that keep their offsets, so a declaration written inside one is not a
  declaration. JSX is what makes that hard, because `<br />`, `</div>` and `<Icon/>` each put a slash
  where an expression could begin, and reading one as a regular expression swallows the rest of the file.
  A slash opens a regular expression only after a short list of operators and keywords, and never before
  `>`. The list has `)` in it, but only for the bracket that closes an `if (…)`, a `while (…)` or a
  `for (…)`, where what follows is a statement: `if (s) /}/.test(s)` read as division leaves a brace
  that closes a block, and everything below it then looks like the top level. Backticks get the same
  treatment as slashes, because a backtick in JSX text, the kind that puts a keystroke in a code span,
  otherwise pairs with the next one in the file, which is usually a real template's opening one, and the
  template's contents, which are often a code sample, are then read as code. A backtick opens a template
  only where a value can begin, and a tagged template only where its tag can, so a `styled.div` or `css`
  template still masks its contents and a code span in prose does not open one. Anything unterminated degrades locally rather than
  blanking what follows it: a `d="M 145 75` attribute continued on the next line, and an apostrophe in
  JSX text, cost their own character and nothing more. A name the module writes to again, declares
  twice, or already gives a `displayName`, is left alone, and so is one the module imports. The top
  level is read as brace depth rather than as indentation, because a declaration inside a function, a
  class body or a namespace can be written at column 0 too, and the module's last line cannot reach it;
  where the file has both, the binding that line would reach is the imported one, which is another
  module's component. A `function Foo(…)` at column 0 also has to be where a statement can begin, since
  a named function expression inside `memo(` or an array literal can be written there and declares
  nothing at all.

  Two things in it were quadratic and are not any more. The scan used to read an identifier back from
  every character, so a 1 MB run of word characters never finished, and each name found cost its own
  regular expression pass over the file, so 10,000 components in one file took 8 seconds. The scan now
  carries the start of the identifier along and reads at most ten characters back, the name tests are
  three passes whatever the number of names, and an unclosed bracket is read for at most 4 KB rather
  than to the end of the file. Measured after: 1 MB of word characters 28 ms, 10,000 components 66 ms.

  **A stamp must never be able to throw; tree shaking comes second.** Those are in that order because a
  module is strict, so a property store that fails is not ignored, it throws at load and takes the page
  with it, and a transform that reads text rather than a syntax tree will name something that is not
  what it took it for. Evaluating 76 stamped modules under Node, in both build orders, a bare
  `Foo.displayName = "Foo"` threw in 22 of them: a called function expression that returned a number or
  null, a component frozen through a helper or a `forEach`, a `displayName` already defined as
  read-only, a user's own `memo` that returned nothing, and names the scan had read wrong. So the two
  forms since 2026-09-19 check the value before they write it, and neither replaces a name that is
  already there:

  ```js
  typeof Foo === "function" && Object.isExtensible(Foo) && !Object.getOwnPropertyDescriptor(Foo, "displayName") && (Foo.displayName = "Foo");
  try { if (Bar.displayName == null) Bar.displayName = "Bar"; } catch (e) {}
  ```

  The first is for a function, whose value `typeof` can prove, and `typeof` on a name that turns out not
  to exist is not an error either. The second is for a `memo` or `forwardRef` binding, whose value is an
  object that `typeof` proves nothing about. It reads `displayName` rather than asking for the property
  descriptor, because React defines `displayName` on a memo object in a development build as an accessor
  that starts out undefined: the descriptor is there from the start, so the descriptor test would mean
  never naming a memo component in development. Measured on the seven-export icons module with one
  function and one memo imported, and on the same module through each minifier:

  | form | Rollup | esbuild | terser | SWC | can throw on |
  | --- | --- | --- | --- | --- | --- |
  | `Foo.displayName = "Foo"`, until 2026-09-19 | drops unused | keeps | drops unused | drops unused | every value that is not an extensible object |
  | `typeof` guard, shipped for functions | drops unused | keeps | keeps | keeps | a Proxy whose set trap throws |
  | `try` wrapper, shipped for memo and forwardRef | keeps | keeps | keeps the arrow, drops the declaration | drops unused | nothing |

  The bundler columns are that seven-export module; the minifier columns are a three-component module
  the minifier sees whole, since terser and SWC only ever see what the bundler decided to keep. Rollup
  drops the whole guarded expression along with the component nobody imported, exactly as it dropped the
  bare assignment; esbuild keeps every stamp under every form, since it does not drop a property store on
  a module-level binding. What the guard costs is terser and SWC, which could drop an unused component
  under a bare assignment and cannot under this. The memo and forwardRef bindings are kept by every
  bundler under every form anyway, because the wrapper call is not something they can prove away, so the
  `try` there costs nothing that was not already lost. The `/*#__PURE__*/ Object.defineProperty` form shakes
  in both bundlers and is worse than any of these: both then drop every stamp whether the component is
  used or not, so no name survives minification and the transform does nothing at all. The remaining
  cost is stated in both READMEs, and it only applies where the plugin or the loader is turned on, which
  for `enabled: 'development'` is not the production build.

  Measured over the Excalidraw app and two TanStack Table examples, 301 files with JSX that a parser
  accepts: the names stamped went from 57 to 256, all 316 components the corpus can identify now carry
  one, counting the 60 those apps name themselves with a `displayName` of their own, and re-parsing
  every transformed file broke 0 of 301. The guards changed none of that: the same 301 files give the
  same names, none added and none dropped. What
  it still misses there is 6 capitalised classes, and capitalised bindings built by a call it does not
  know: 89 `createIcon(…)`, 14 `createToolButton(…)`, 10 `React.createContext(…)`, 7 `Object.assign(…)`,
  2 `dynamic(…)`, 2 `withInternalFallback(…)`, and one each of `clsx`, `createContext`, `defineTools`,
  `filter` and `join`. Most of those are not components, which is why that list is not a to-do: telling
  the ones that are from the ones that are not needs a scope analysis rather than a wider pattern.

  What is still open, and is stated in the root README's Known limits. A naming HOC that sets a
  `displayName` keeps it, since the stamp does not replace a name that is there, but one that names a
  component some other way, on a prototype or through a wrapper it returns, can still be overwritten. A
  file that begins with a hashbang, and a file whose last line is a `sourceMappingURL` comment rather
  than code, are stamped correctly by this transform but have not been put through webpack or Turbopack
  to see what those make of the result.

  Handler names are a different problem: LoAF's `sourceFunctionName`
  plus `sourceURL` and character position can be resolved through source maps offline, which
  is a RUM-side feature, not a browser-side one.
- **Durations.** Only `react-dom/profiling` records them. Counts and the hot path are
  usually enough to name the culprit; durations tell you how bad.
- **Budget.** The walk is bounded (`walkBudget`, default 5000 component fibers) and only runs for a
  commit an input can claim: one React made inside an input's dispatch, or one within `inputWindow`
  (1.5 s) of the end of the newest input's own work. `sampleRate` (0 to 1) rolls
  once per page load, and a page that loses installs nothing at all. Reports carry
  `overheadMs`, and `stats()` carries `walkTotalMs`, `reportTotalMs` and `installMs`, so the
  cost is visible in the data rather than assumed.

The production mode is the one that has to reproduce a hand-made INP win on a large app; that
test has not been run yet against anything but the demo, and the real applications run by hand were
smoke runs, not that test.

## The web-vitals entry

`react-inp-blame/web-vitals` (`packages/core/src/web-vitals.ts`), added 2026-09-19. It exists because
web-vitals is already in the page of anyone who measures INP, and its one sanctioned framework hook,
`generateTarget` on the attribution options, was reviewed and added for exactly this: a framework
naming the element in its own words. Two exports, no import of web-vitals at all: the two types it
needs are declared structurally in the file, so the entry works with any version that has the fields
and costs an app that does not use web-vitals nothing.

**What web-vitals keeps.** Which interaction is the page's INP and at what percentile, the interaction
count, reporting across the back/forward cache and soft navigations, and its own intersection with Long
Animation Frames. None of that is reimplemented here; `inp()` on the API is a second implementation of
the same algorithm for the badge, and this entry is the opposite bet: let web-vitals decide, and add
only the fiber side.

**What it adds.** `generateTarget(node)` gives the components enclosing the node, outermost first, and
the node itself: `"ProfilePage > PhotoTile (button.tile)"`, which web-vitals writes to
`attribution.interactionTarget` in place of its own CSS selector. It reads `fiberFromNode` and
`ownersOf`, the same two lookups every report is built from, so there is one walk in the codebase, not
two. `attributeINP(metric)` returns the metric's attribution with a frozen `react` field added: the
blame with its confidence, the handler, the hot path, the heaviest commit's components (at most 5), and
what React rendered before and after the paint. It carries its own `schemaVersion`, separate from the
report's, because it is a smaller and slower-moving shape than `InteractionReport`.

**The join.** `metric.entries[].interactionId` against the published reports, newest first. Both sides
read the same Event Timing entries and the same ids, so the match is exact and no tolerance is needed.
There is no second key: web-vitals drops every entry without an `interactionId` before a metric is
built (`lib/InteractionManager.js`), and this library's observer does the same, so an entry with no id
matches nothing rather than being matched on a start time.

**Limits.**

- `react` is `null` when nothing is installed on the page, and when the library has no report for the
  interaction web-vitals picked: one that stayed under `threshold` and set off no later render INP
  leaves out, or one already pushed out of the 50 reports a page keeps (`MAX_REPORTS`), which the ten
  slowest and those INP can still point at never are. It is never a guess.
- `generateTarget` needs no installation, only React's fiber expando, so it works in a page that never
  calls `install()`. `attributeINP` needs one, though not from the same copy of the library: the
  installation lives on `globalThis` (`session.ts`), so any copy of a compatible version sees it.
- Under a production build without the `displayName` transform the minifier has renamed the components
  and the path reads `"a > b (button.tile)"`. Nothing can tell that apart from a real one-letter name,
  so the entry prints it rather than hiding it.
- The element half of the target is built from attributes only, never from the element's text, the same
  rule reports follow (`element.ts`), and the whole string is capped at 120 characters. A path names at
  most four components and they are the four **nearest** the element, so a deep tree loses the page and
  the layout rather than the component that renders what was clicked; over the character cap the
  outermost go first for the same reason. What is left after the components is the element's budget,
  rather than the joined string being sliced, so a long id is shortened and never leaves a bracket open.
- Neither export throws. `generateTarget` returns `undefined` for a node it cannot read, which is
  web-vitals' own signal to fall back to its CSS selector, and `attributeINP` returns `react: null` for
  a metric it cannot read. Both run inside somebody else's analytics callback, which is no place to
  raise an exception over a node from another document.
- `attributeINP` reads `report.explanation`, which is built on first read, so the sentences are built
  in the web-vitals callback rather than in the Event Timing one. That callback already runs when the
  page is idle or hidden.

**Size.** 2.7 KB minified, 1.3 KB gzipped on its own, measured 2026-09-19 with the same rolldown
settings as the table above (the same script read `/auto` at 38.2 / 14.1 that day, against the 39.0 /
14.4 in the table, so the two scripts are close but not identical). It holds none of the hook, the
observers, the report lifecycle, the explanation prose or the overlay. Keeping it there needed three
small extractions: the CSS selector into `element.ts`, the page's installation into `install-state.ts`,
and the choice of the heaviest commit into `commits.ts`, which the overlay, the DevTools tracks and the
report's own verdict all make the same way. Reading reports no longer means importing the code that
produces them.

**Checked by** `packages/core/test/web-vitals.test.ts` and `apps/demo/e2e/web-vitals.spec.ts`, which
runs web-vitals 6.2.2's attribution build in the page beside the library, in development and production
builds, and holds `attributeINP(metric).react.blame` against the library's own report for the same
interaction.

Under Next.js's `useReportWebVitals`, which runs the web-vitals Next.js vendors (4.2.1 in 16.3) and reports
INP only once the page is hidden, `apps/next-demo/e2e/web-vitals.spec.ts` runs the README's snippet on
`app/vitals` under `next dev` and both production bundlers. A slow click is followed by a quicker key
press that is reported too, the spec hides the page, and the metric's `react` must be the click's: its
`interactionId`, its `blame`, and `VitalsPage > Rows` as the path, so the join is on the interaction
web-vitals chose and not on the latest report. It passed 5 of 5 in development and 3 of 3 under each
production bundler on 2026-09-22.

One thing it found belongs to web-vitals, not here. In every current web-vitals, 4.2.1 in Next.js 16.3,
6.2.1 on Next.js canary and 6.2.2, a page hidden while web-vitals still has an idle callback pending
reports no INP, or the smaller value from before. `onINP`'s own hide handler reports first, before that
callback has set the value, and the callback then reports without forcing it, which does nothing. It
happens every time with the stubbed hide web-vitals' own tests use; a real hide was not produced here.
Their tests always wait for idle before hiding, so they never reach it. The spec waits for an idle
callback before it hides the page, which runs after the one web-vitals posted. An earlier version of
this paragraph put a loss seen when hiding one frame after a click down to the same thing. That was a
different case: the entry arrived after the hide.

## Distribution: where this can live

Written with the prototype on 2026-09-12 and cut back since to what ships. Three ideas that stood here
are gone: a React DevTools Profiler "Interactions" view, a framework hook on Chrome's Interactions
track, and `react.*` OpenTelemetry attributes.

**Chrome DevTools.** The Performance panel extensibility API is the zero-install path: any
page that includes the library gets a React attribution track next to Chrome's own Interactions
track, with no extension to install.

**Next.js.** Tested on Next 16.3.5 (`apps/next-demo`). Setup is one line on 16.3 and two before it:
`withInpBlame()` around the config in `next.config.ts` (`react-inp-blame/next`). It appends
`react-inp-blame/next-client` to `instrumentationClientInject`, the list of client modules Next.js 16.3
imports before `instrumentation-client` and before hydration, which Next.js documents for config
wrappers of this kind. Next.js 15.3 to 16.2 have no such list, so there the app's own
`instrumentation-client.ts` re-exports that module, a line the wrapper prints until the file has it;
the load-order, hydration and web-vitals suites pass that way on 16.2.12, 15.5.26 and 15.3.9 under
both bundlers (2026-09-22), on 15.5 under Turbopack without the `commits.ms` check until the dev
overlay's commits were left out (2026-09-23, below). That module
installs the library with the wrapper's `runtime` options, which reach it through `env` because
Next.js inlines those at build time. Where the wrapper put nothing in `env`, a build `enabled` leaves
out, it installs nothing, though the line in instrumentation-client still brings its code into that
build. The wrapper
also adds the displayName loader as a Turbopack rule and as a webpack `enforce: 'pre'` rule, merging
with whatever rules the app already has (before 16.0 a glob takes one rule, so an app's own rule on
the same files is left alone, with a warning). Both are added only under `next dev` unless `enabled`
is `'production'` or `true`, which `apps/next-demo` sets because its test checks names in production
builds; `runtime: false` keeps the loader alone. That is the shape Sentry uses (`withSentryConfig`), so it is what Next users expect.
In a production build the injected module runs before `react-dom` evaluates: the library's own hook
is the one React registers with, and the first keystroke is attributed. In dev, React Fast Refresh's
runtime has already installed a hook stub by then, so the library chains onto it, and attribution
works there too, with durations. No beforeInteractive shim is needed. The dev overlay is not the app,
though it runs React on the same page: it creates a root of its own on a `<nextjs-portal>` element, and
from 15.4.11 and 15.5 renders it with a production react-dom bundled at
`next/dist/compiled/next-devtools`, the same version the app gets (checked on 15.5.26 and 16.3.5). Its
commits carry minified names and no durations, and on 15.5 under Turbopack one landed inside every
click, so the report named the overlay's components and `commits.ms` came out null. The hook now drops
any commit on a root whose container is that element (`nextDevToolsRoot`, 2026-09-23). The container
is the signal because nothing about the renderer is: an app can run a production react-dom of its own,
and several roots. Summing only the commits that have durations was the other option, and it would have
kept the overlay's components in the report. Dropping them keeps the overlay's react-dom away from the
shape check too, so while it has committed nothing but that root it does not count as a react-dom the
page can still be read through, and a React that moved a field still leaves the page `'unsupported'`
as it did before. Until 2026-09-15 the runtime
half was a hand-written `import 'react-inp-blame/auto'` in `instrumentation-client.ts`; the spec
now checks the injected module under `next dev`, Turbopack production and `next build --webpack`
production. The loader was proven 2026-09-14 in the same three runs; before it the verdict read
"602 components re-rendered under n". One lesson from the webpack run: its type check rejects a page
file that exports anything Next does not expect, which Turbopack's does not, so nothing beside the page
itself is exported there. The `memo()` component that stood in for the loader's `const X = memo(` case
rendered null and was never checked by a spec, so it is gone; `packages/core/test/display-names-loader.test.ts`
covers the patterns the loader matches, and the ones it does not, instead. `react-inp-blame/web-vitals`
now supplies web-vitals' `generateTarget`, which puts component paths into `interactionTarget`, the
field an analytics product reads without any work on the vendor's side (see "The web-vitals entry").
Enriching `metric.attribution` from Next.js itself would need `experimental.webVitalsAttribution`, which
16.3.5 does not wire up: `dist/client/web-vitals.js` calls `onINP` from `next/dist/compiled/web-vitals`,
the build without attribution, whatever the flag says, and the attribution build it also ships is never
imported there. So under `useReportWebVitals` the metric has no `attribution` and `attributeINP` adds
the React side to `{}`.

**Vite.** `react-inp-blame/vite`: a module script ahead of the page's own that installs the
library, so the order of imports in the entry module stops mattering, and the displayName transform.
Vite runs a `transformIndexHtml` hook ordered `pre` before it reads the page's scripts, so the added
script is served in development and bundled in production like the page's own. In development that
is the whole job, because nothing is bundled and module scripts run in document order.

A production build is different. Vite folds every module script of a page into one entry module, and
JavaScript evaluates a module's imports before its body, so an `install()` call in that body runs
after any chunk that evaluated react-dom on the way in. React looks for the hook once, while
react-dom evaluates, and never again, so a hook created afterwards is never registered with. Nothing
the plugin writes into the entry module can settle that, because the bundler decides what the entry
imports and in what order. Two pages sharing a chunk is enough to settle it the wrong way: the
modulepreload polyfill and react-dom end up in one shared chunk that the entry imports first.

So the install call is given a file of its own and the page loads it as a script of its own.
`buildStart` asks for the split with `this.emitFile({ type: 'chunk' })`, and a `transformIndexHtml`
hook ordered `post`, which runs once the bundle exists, finds that chunk in `ctx.bundle` by its
`facadeModuleId` and prepends `<script type="module" crossorigin src="…">` to the head. Document
order between two module scripts is the one thing a bundler cannot rearrange. A module script with no
`async` is deferred, and at "the end" of parsing the HTML Standard runs the deferred scripts in the
order their elements were reached, waiting for each one's whole module graph before it runs and
running it to completion before starting the next (HTML Standard, "The script element" §4.12.1 and
"The end" §13.2.7; the install graph uses no top-level await, which is the one thing that would end
that script before its work was done). Looking the chunk up by `facadeModuleId` rather than holding
the reference `emitFile` returns also keeps the plugin correct when Vite 6 and later build several
environments in parallel from one plugin instance.

The inline `import 'virtual:react-inp-blame/install'` the `pre` hook used to add in builds as well is
now the fallback for the outputs that can have no second script: `output.format: 'iife'` or `'umd'`,
which are one file by definition and fail the build outright if asked to split, `build.lib`, and the
SystemJS `nomodule` bundle `@vitejs/plugin-legacy` adds, where document order buys nothing and a
second entry would only separate the install from the code that has to run after it. For that last
one the plugin stands down entirely, on `config.plugins` containing a `vite:legacy` plugin. Keeping
the inline form costs the one benefit an external script would otherwise bring under a Content
Security Policy, so the README does not claim it. Where a page does get the script, `generateBundle`
checks that some page's HTML names the chunk and deletes it otherwise, so a build whose every page is
turned down by `pages` ships no stray file. `manifest: true` gains a row keyed
`../virtual:react-inp-blame/install` with `isEntry: true`; the page's own row does not list it, so a
framework that builds its HTML from `manifest.json` instead of from Vite's emitted page will not pick
the script up.

What went wrong here, and how far it reached. This repo's demo builds with Vite 8.3.0, whose bundler
is Rolldown. Its React 17 variant failed 11 of 14 production specs with `hook.renderers` empty and
`stats().mode` still reading `shim`, while the same specs passed in development and the React 18
variant passed in both. React 17 has no `react-dom/client`, so `apps/demo/src/legacy-client.ts` shims
`createRoot` over `ReactDOM.render` with a default import, and a default import of a CommonJS module
builds its namespace object while the importing chunk evaluates, rather than at first use. That is
what put react-dom ahead of `install()` there. It is not a rule about React versions or about default
imports: in the small fixtures below a single React 17 page, and two of them, come out in the right
order at HEAD on both Vite 5 and Vite 8, and React 18 through `react-dom/client` was never seen to
lose on either. Which chunk evaluates first is the bundler's decision, and the point of the fix is to
stop asking it the question.

Checked by building each of these and loading the built pages in Chromium, on Vite 5.4.21, 6.4.3,
7.3.6 and 8.3.0, with React 17.0.2 and a default import of `react-dom`. "Yes" means
`__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers` had the renderer in it after the page settled.

| Build | 5.4.21 | 6.4.3 | 7.3.6 | 8.3.0 |
| --- | --- | --- | --- | --- |
| One page | yes | yes | yes | yes |
| Two pages sharing a chunk | yes | yes | yes | yes |
| Two pages, both entries eager on react-dom | yes | yes | yes | yes |
| The same, `modulePreload.polyfill: false` | yes | yes | yes | yes |
| One page, `modulePreload: false` | yes | yes | yes | yes |
| Custom `entryFileNames` and `chunkFileNames`, with and without a hash | yes | yes | yes | yes |
| `base: '/sub/'`, page at the root and in a subdirectory | yes | yes | yes | yes |
| `base: './'` and `base: ''`, page at the root and in a subdirectory | yes | yes | yes | yes |
| `html.cspNonce` set | yes | yes | yes | yes |
| `output.inlineDynamicImports` | yes | yes | yes | yes |
| `output.format: 'iife'` | yes | yes | yes | yes |
| `@vitejs/plugin-legacy`, one page, module and `nomodule` paths | yes | yes | yes | yes |
| `@vitejs/plugin-legacy`, two eager pages, module and `nomodule` paths | yes | yes | yes | yes |
| `manualChunks` sending react and react-dom to `vendor` | yes | yes | yes | yes |
| `manualChunks` sending all of `node_modules` to `vendor` | no | no | no | yes |
| `build.lib`, default formats and `formats: ['es']` | builds, no stray file | same | same | same |
| `build.ssr`, and a `consumer: 'server'` environment | no tag, no chunk | same | same | same |
| A JavaScript entry with no HTML page | builds, no stray file | same | same | same |
| `pages` turning a page down, or every page down | no script there, no stray file | same | same | same |
| `createBuilder` with client, ssr and worker, in three orders | n/a | ok | ok | ok |
| `build.watch`, first build and a rebuild | yes | yes | yes | yes |

The one "no" is a limit, not a regression: it fails the same way at HEAD, and on Vite 8 it passes
both before and after. `manualChunks: (id) => id.includes('node_modules') ? 'vendor' : undefined` puts
react-dom and this library in the same chunk, and the install script's own import of that chunk
evaluates react-dom first. Nothing the plugin can reach decides that. Exclude the library from the
rule, or give it its own chunk, and the row passes, which is what the narrower `vendor` rule in the
row above it does. The dev server output is byte for byte what it was before this change on all four
versions, with no warnings.

Since 0.5.0 the plugin does that itself for a `manualChunks` function: the library gets a chunk of its
own and the function decides every other module, so the "no" row passes on Rollup too
(`fixtures/vite-vendor-chunk` builds it in CI). A `manualChunks` object is left as it is, and a build
where react-dom still connects before the install gets a warning naming the module that connects it.

Rolldown's chunk groups (`codeSplitting.groups`, or the older `advancedChunks.groups`) were a second
way to the same "no" on Vite 8, and a worse one: a vendor group took react-dom and this library
together, and when a library that imports react-dom (Radix's Portal, for one) was in the group too, its
module ran react-dom as the vendor chunk loaded, before the install script's own body. The plugin
now puts a group of its own ahead of the app's, with a priority above all of theirs and no
size limits, whose `test` takes the install's static graph, so the library leaves every group of the
app's and the vendor chunk is only what the app's groups keep. A group's `test` gets only the module
id, so the graph comes from the `getModuleInfo` of the build in progress, kept at `buildEnd`; a function
`name` would get the graph itself, but Rolldown then warns on every build unless the group has a
`debugName`, which older Rolldown refuses. With `entry` the group takes the install module too, as the
`manualChunks` function does, and it is added under any `codeSplitting` object, since Rolldown ignores
`manualChunks` beside one (`fixtures/vite-vendor-groups` builds the page case in CI).

The demo and its React variants install with the plugin, and every variant runs in CI as a production
build as well as on the dev server.

## What is not done

- **Nobody has looked at the Performance panel tracks by eye.** `apps/demo/e2e/devtools-track.spec.ts`
  records a trace of a slow click and reads its JSON, checking the track group, the track names, the
  colours, the tooltip and that the measures are cleared again, in development and production builds
  and behind a Chrome 133 user agent. Opening `apps/demo/traces/context-storm-dev.json` in the panel
  beside React's own tracks is still to do.
- **Real applications have been run by hand, not in CI**: Excalidraw, two TanStack Table examples, the
  shadcn/ui documentation site and Twenty, from 2026-09-20. What they turned up is in the sections
  above and in the changelog. Nothing has run on Next.js's own bench apps.
- **Frameworks that render their own HTML need a setup of their own**, and have one only under React
  Router, Remix, TanStack Start and Astro. The Vite plugin adds its install script only to the HTML pages
  Vite itself serves and builds, and theirs never go through it, so the library installs nothing there
  unless the plugin's `entry` names a module, and nothing says so. The READMEs' setup for a build with no
  HTML page has not been tried.
  React Router and TanStack Start got a setup on 2026-09-23: `install()` in a module of the app's own that
  the client entry imports first. That is early enough under React Router because its `<Scripts>` imports
  the route modules statically and then the client entry with `import()`, and the route modules reach only
  `react-router`, whose main entry imports no react-dom; `react-router/dom` does, and only the client entry
  imports it (read in react-router 8.4.0's `dist/production`, and the same holds for 7.18.4). A route can
  still import `react-dom` itself, as a portal does, and that is harmless on React 19: its `react-dom`
  calls nothing on the hook but `registerInternalModuleStart` and `registerInternalModuleStop`, and only
  `react-dom/client` connects. React Router 8 needs React 19.2.7 or later. A React Router 7 app on React 18
  loads a `react-dom` that connects as it evaluates, so a route that imports it beats an install in the
  entry. There the install goes first in `app/root.tsx`, since React Router imports the root route's module
  before any other and before the entry. CI runs that in React Router 7.18's app on React 18.3 with a route
  that calls `flushSync`; with the install in the entry instead, the same app blamed nothing on the dev
  server or the build (run 35953518744, 2026-09-23). Under
  TanStack Start the build's client input is `src/client.tsx` itself, the dev server imports it right after
  the Fast Refresh preamble, and `@tanstack/react-router` imports react-dom only for server rendering (read
  in @tanstack/start-plugin-core 1.171.47 and @tanstack/react-router 1.170.39). CI runs both in the job
  `framework-app`, on the dev server and a production build. Astro got an integration on 2026-09-24,
  `react-inp-blame/astro`, which hands `install()` to Astro's `injectScript('before-hydration', …)`. Each
  `<astro-island>` awaits `import()` of that script before it imports its component and its renderer, and
  `@astrojs/react`'s renderer is the only module that imports `react-dom/client` (read in astro 7.3.5's
  `runtime/server/astro-island.js` and @astrojs/react 7.0.0's `client.js`). The same job runs it in
  Astro's minimal template with two islands. The same day the Vite plugin got `entry`, after Remix 2 showed
  that a module of the app's own is not enough. Its root route imports `@remix-run/react`, which imports
  `react-router-dom` and so `react-dom`, which on React 18 connects to the hook as it loads. Written first
  in the client entry, the install came too late on the dev server and in a build. Written first in
  `app/root.tsx`, it held on the dev server, but a build left it out, since the template's
  `"sideEffects": false` lets Rollup drop an import with no names, and with that fixed the root route's
  chunk still imported the shared chunk holding react-dom before running its own body, the install inlined
  there included. `entry` prepends an import of the plugin's install module to the named module in the
  browser's build only, resolves that module with `moduleSideEffects: true`, and emits it as a chunk of its
  own, so the root's chunk imports it before the shared one (Remix 2.17.5, Vite 6.4.3). The import is
  added by a plugin of its own that runs after the JSX is compiled: added before, it sat under the
  compiler's `react/jsx-runtime` import, and with a route importing a `Link` from `@remix-run/react`,
  react and react-dom share one chunk and the build blamed nothing again. Rolldown (Vite 8) orders a
  chunk's imports by its own rule rather than the module's, so there the order is not guaranteed; the
  apps CI builds with it pass, React Router 7 on React 18 among them. React Router and
  TanStack Start moved to it too, and CI runs all four apps on it. The dev server's dependency scan reads
  the source before plugins transform it, so the plugin adds react-inp-blame to `optimizeDeps.include`;
  without that the first visit found it late and reloaded the page while it hydrated. React Native is out of scope: only react-dom commits are
  walked.

## Next steps

What is left is the list above: look at the Performance panel tracks by eye, and run the library
against Next.js's own bench apps. The frameworks that render their own HTML need a setup as well. The
`react-inp-blame/web-vitals` entry landed on 2026-09-19 and has its own section, which now includes a
run under Next.js's `useReportWebVitals`. The hydration verdict landed on 2026-09-19 and has its own
section above.
