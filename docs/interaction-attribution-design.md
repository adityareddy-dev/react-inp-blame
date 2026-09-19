# Interaction attribution for React: design notes

Status, 2026-09-17: 0.1.0 is on npm, published from the `v0.1.0` tag with provenance. On
7917366 the Playwright suites were green against React 19.3 in development and production builds,
18.3.1 and 17.0.2 (legacy root), and Next.js 16.3.5 under `next dev` and its Turbopack and webpack
production builds. Since the prototype of 2026-09-12, the changes are these:

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
    after the screen updated: 84 ms re-rendering 256 components inside ProfilePage, mostly
    PhotoTile (240 of them, 73 ms). INP doesn't count it, but people still wait for it.

## What is proven so far

`apps/demo/e2e/attribution.spec.ts` runs these headless in Chromium and asserts the component
names, the blame and the control row's 100 ms bound. The counts below are what a run produces:
the spec pins floors rather than exact tallies (`rendered >= 400`, `count >= 100`), and in a
production build it asserts that a handler name exists, not which prop it came from.

| Scenario (anti-pattern) | What the report names | Production build |
| --- | --- | --- |
| Context storm: unstable context value | render blame on the OrderSummary subtree, LineItem ×800 | the same names through displayName stamping, blame from render counts |
| Layout thrash: read after write in 400 layout effects | render blame on LayoutThrash, PriceTicker ×400, with the forced layout the long animation frame recorded | same |
| Handler hog: 120ms in the click handler, no state change | no React render before the paint; script blame on the click handler computeChecksum | the handler named by its prop, component names intact |
| Big list: 3000 unvirtualised rows filtered per keystroke | render blame on BigList, Row ×1440 | same |
| Lifted state: unrelated heavy sibling re-renders per keystroke | render blame on Sidebar, NavItem ×600 | same |
| Cascading effect: derived state set from useEffect | a cheap commit, then the heavy one rendering Detail ×400, joined by its exact input stamp | same |
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
generates the pinned variants); fiber tags, the `PerformedWork` flag and `onCommitFiberRoot` are the
same across the three majors, and so are the verdicts. Two things are not: the `ProfileMode` bit moved
(8 on React 17, 2 on 18 and 19), and React 17 takes any hook for React DevTools where 18 and 19 look
for `checkDCE`.

Since 2026-09-14 `apps/demo/e2e/cross-browser.spec.ts` also runs in Firefox 148 and WebKit
26.4 (Playwright's builds, checked on Windows): reports appear and name the component, with
`frames: null`, and a page whose `PerformanceObserver.supportedEntryTypes` lacks `event` gets
nothing installed. Both time React's components with a clock too coarse for the demo's (see
"Coarse clocks" below), so their development reports carry counts and inferred blame.

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

**Size.** Measured 2026-09-15 with the rolldown 1.2.8 in the repo's `node_modules`
(`platform: 'browser'`, minified ESM, every export of `hook`, `fiber` and `observe` kept for the
last row, gzip at zlib's default level), by a script that is not in the repo, first on 0.1.0 and on
7917366 with the same figures, then again after the review fixes:

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
library, which installed nothing and never hears from React.

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
so there an effect of a listener's own render can still join a report. An update a listener defers
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
descending into 800 identical rows. A memo wrapper is a fiber of its own above the component it
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
120ms in the click handler computeChecksum" is possible without a profile. The element's label
names it by its tag and a name of at most 40 characters, and its whole `textContent` is never read,
because a click can land on a list of 3000 rows. It comes from what the page's code wrote on the element (its aria-label, a
form field's placeholder, name or type, or its data-testid or data-test), and, where text is
allowed, from the first run of text of an element with no aria-label that is not a form field. A run
is the adjacent text nodes React renders an interpolated string as, `Add to cart ({n})` as three, and
it takes in the `<!-- -->` the server renderer puts between them to keep hydration straight: without
that, the same button would be labelled `Add to cart (` after hydration and `Add to cart (3)` after a
client-only render. A run stops after a fixed number of siblings, so skipping those separators is
never a way to walk a whole element.
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

**The join.** A capture-phase listener keeps a ring of the last 8 inputs (pointerdown,
pointerup, click, keydown, keyup) with their `Event.timeStamp`, target and fiber. Every
commit is stamped with the input being dispatched when it ran: `window.event`, which is
still set for the sync commit of a discrete event, including the microtask React 18 and 19
flush it in. A commit with no event on the stack (a transition, an effect, data arriving)
is stamped with the newest input seen. A release also carries the timestamp of the press it
belongs to (pointerup and click by `pointerId`, keyup by key code), so a render after a cheap
click still finds the pointerdown that was slow enough to be observed. A commit belongs to
an interaction when one of those stamps matches an entry's `startTime` within 1 ms: the
Event Timing spec says `startTime` is the event's `timeStamp`, the same clock React's own
Blocking track keys on. That is why 150 ms of input delay changes nothing and two
overlapping interactions cannot both claim one commit at full cost. A commit no stamp
explains, landing between an interaction's handlers and its paint, is still taken and
flagged `joinedBy: 'overlap'`; one that ran during the input delay is what delayed the
interaction, not part of it. Before or after the paint is decided against the paint that
closed the headline entry, with the exact `processingEnd` as the other bound: durations are
rounded to 8 ms, `processingEnd` is not, so a commit inside the handlers is never misfiled as
a follow-up.

A root's first commit, which mounts it or hydrates its server-rendered HTML, and any commit that
hydrates a Suspense boundary, are the page starting up rather than an input's work. They join an
interaction only when React ran them inside that input's dispatch, which is what React does for a
discrete event on a boundary that has not hydrated yet, and such a commit says it hydrated rather than
re-rendered. Until 2026-09-15 they were stamped with the newest input like any other commit, so on
React 17, 18 and 19 alike a click on server-rendered HTML collected the whole hydration commit as its
"second React render", and a quiet first tap was published on the strength of it. README.md carried that
as a known limit. This is the first half of a hydration verdict: it reads a root's `isDehydrated` state
and a boundary's `dehydrated` one. What is still unbuilt is the rest of it, reporting the wait as a phase
of its own and naming the Suspense boundary people waited for.

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

**Follow-ups.** Commits that land after the paint but within 1.5 s, stamped with the same
input, with no newer input in between. Effects, transitions and data-driven re-renders show
up here.

**Saying it in plain words.** Every report carries an `explanation`: a headline ("264 ms
click"), a rating on the INP thresholds in web-vitals' words (good to 200 ms, needs improvement to
500 ms, poor beyond),
where it happened (the element's own label and the component that owns it), one sentence for
the cause, extra sentences only when they earn their place, and the time split into three
phases a person can picture: waiting before the handler, working, updating the screen. The
cause separates React's render time from the rest of the working time (the handler and other
scripts) after subtracting forced layout, so a slow handler is named as such rather than
blamed on a two-component render. Later renders only get a sentence when they carry real
work (10 ms or 25 components), otherwise the page's own status pill or reporting panel would
show up in every report. The `verdict` string is the explanation joined into one line. Both
are built the first time something reads them, and again after the report changes, not in the
Event Timing callback, where the time would come out of the next interaction.

**How sure the blame is.** The cause is chosen by named thresholds, each with its reason beside
it in `join.ts`: the handler is blamed from 25 ms of working time outside React's render, and only
when that is a quarter of the working time (committing the demo's 1441-row list takes a fifth of
it outside React's durations); a render from 5 ms with durations, or from 10 components by counts
and 50 beside a named handler; a Long Animation Frames script from 20 ms; waiting, painting and
working time known only by counts from 50 ms, the length of a long task. The hot path follows a
child carrying 60% of its parent's work (`fiber.ts`). `explanation.blame.confidence` says what the
call rests on. It is `'measured'` when the blame follows from timings of the interaction itself:
React's durations for commits joined by their exact input stamp and walked in full, the browser's
own phases, a script's Long Animation Frames entry. It is `'inferred'` when the blame is the
likeliest reading of weaker evidence: render counts (production builds, coarse clocks), a commit
that only overlapped the interaction, a walk cut short, or no Long Animation Frames to rule other
scripts out. `verdict`, `cause`, `notes`, `headline` and `where` are display text that may be
reworded in any version; `blame`, `rating`, the phases' milliseconds and the report's own fields
are the data, and the demo's specs assert on those.

The working time leaves out this library's own walk. A commit during the handlers is walked
inside that commit, so the browser counts the walk as processing; the report takes it back out
as `walkMs` (`inputDelay + processing + walkMs + presentation` is the duration), and the
explanation says how much once it rounds to 1 ms or more. The headline stays the browser's
number, so it still equals what web-vitals reports for the interaction.

**Quiet interactions.** The observer runs at the browser's 16 ms floor; interactions under
the reporting threshold (40 ms by default) are held back, not dropped, and surface only if a
heavy later render attaches to them. A 24 ms click that triggers an 85 ms render after the
paint is worth a sentence even though INP alone would never flag it. Under the floor there is
nothing to hold back: the browser sends no `event` entry for an interaction that paints in
less than 16 ms, so a render its effect sets off after the paint has no report to attach to,
however heavy. The page's first input is the exception. The browser also reports it as a
`first-input` entry at any duration, carrying its interactionId, so the observer takes that
entry too, as web-vitals' onINP does, and drops it when the `event` entry exists as well. For
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
(same input stamp, no newer input since, within 1.5 s), and listeners receive the next
revision: a new frozen report with `revision` bumped and its own explanation, the earlier one
left as it was (before 0.1.0 the same object was changed and handed over again). Long animation
frames that
arrive for those later renders fold in the same way, and a report keeps the frames it has joined even
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
modules too (read in Next.js 16.3.5's source, not run), which gives it attribution but no navigation
join. `apps/next-demo/e2e/load-order.spec.ts` clicks a Link whose handler takes 60 ms and checks the
click's report, the reset and a report on the page it opened, under `next dev` and both production
builds.

All of this, from quiet interactions and publishing to late entries, late frames, later renders
and the limits (50 published reports, 20 quiet ones, the entries of the 100 interactions heard
from most recently), lives in `lifecycle.ts`. It reads no browser globals and its transitions are
unit-tested one by one; `install()` only wires it to the observers, the DevTools hook and the page.

**Output.** An `InteractionReport` object, a listener API, and entries the Chrome Performance
panel (128+) draws as custom tracks, in a "react-inp-blame" group beside React's own
"Scheduler ⚛" and "Components ⚛".

- The report is a contract from 0.1.0. It carries `schemaVersion: 1`, which changes when a field
  is removed or changes meaning, and it is frozen down to its commits, frames and explanation.
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
sync render run inside the same script entry. A minified handler keeps only the name of the prop
it was found on, so production sentences say "the onClick handler".

## The demo

Two demos in one Vite app. The default page is a sign-in flow, an Instagram-style layout
under its own name (Framely), with four mistakes real apps make: the email field's state
sits in the page, so each keystroke re-renders a phone preview of 1000 tiles; the password
field scores strength synchronously in its change handler; the login click hashes the
password on the main thread before the request; and the profile grid's tiles each measure
the grid in a layout effect. A "What took time" panel lists every step in the order it
happened, key presses grouped per field, the server wait shown between the click and the
profile render, and the page's INP so far at the bottom. `#lab/...` keeps the six isolated
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
- the target component and its owner chain
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
  production, 2026-09-14. Cost is about 30 bytes per component; the alternatives are worse:
  `next build --no-mangling` keeps every name (+9.6% gzip on react-dom alone), and an SWC
  plugin has to be rebuilt against each Next release's swc_core. The regex handles
  top-level `function Foo(`, `export default function Foo(` and `const Foo = memo(` or
  `forwardRef(`; anything else needs a real parser. Handler names are a different problem:
  LoAF's `sourceFunctionName`
  plus `sourceURL` and character position can be resolved through source maps offline, which
  is a RUM-side feature, not a browser-side one.
- **Durations.** Only `react-dom/profiling` records them. Counts and the hot path are
  usually enough to name the culprit; durations tell you how bad.
- **Budget.** The walk is bounded (`walkBudget`, default 5000 component fibers) and only runs
  when an input event landed within the last 1.5 s (`inputWindow`). `sampleRate` (0 to 1) rolls
  once per page load, and a page that loses installs nothing at all. Reports carry
  `overheadMs`, and `stats()` carries `walkTotalMs`, `reportTotalMs` and `installMs`, so the
  cost is visible in the data rather than assumed.

The production mode is the one that has to reproduce a hand-made INP win on a large app; that
test has not been run yet against anything but the demo.

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
  interaction web-vitals picked: one that stayed under `threshold` and set off no later render, or one
  already pushed out of the 50 reports a page keeps (`MAX_REPORTS`). It is never a guess.
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

## Distribution: where this can live

Written with the prototype on 2026-09-12 and cut back since to what ships. Three ideas that stood here
are gone: a React DevTools Profiler "Interactions" view, a framework hook on Chrome's Interactions
track, and `react.*` OpenTelemetry attributes.

**Chrome DevTools.** The Performance panel extensibility API is the zero-install path: any
page that includes the library gets a React attribution track next to Chrome's own Interactions
track, with no extension to install.

**Next.js.** Tested on Next 16.3.5 (`apps/next-demo`). Setup is one line: `withInpBlame()` around
the config in `next.config.ts` (`react-inp-blame/next`). It appends `react-inp-blame/next-client` to
`instrumentationClientInject`, the list of client modules Next.js 16.3 imports before
`instrumentation-client` and before hydration, which Next.js documents for config wrappers of this
kind. That module installs the library with the wrapper's `runtime` options, which reach it through
`env` because Next.js inlines those at build time. The wrapper also adds the displayName loader as a
Turbopack rule and as a webpack `enforce: 'pre'` rule, merging with whatever rules the app already
has. Both are added only under `next dev` unless `enabled` is `'production'` or `true`, which
`apps/next-demo` sets because its test checks names in production builds; `runtime: false` keeps the
loader alone. That is the shape Sentry uses (`withSentryConfig`), so it is what Next users expect.
In a production build the injected module runs before `react-dom` evaluates: the library's own hook
is the one React registers with, and the first keystroke is attributed. In dev, React Fast Refresh's
runtime has already installed a hook stub by then, so the library chains onto it, and attribution
works there too, with durations. No beforeInteractive shim is needed. Until 2026-09-15 the runtime
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
script is served in development and bundled in production like the page's own, and module scripts
run in document order. The demo and its React 17 and 18 variants install with it.

## What is not done

- **Nobody has looked at the Performance panel tracks by eye.** `apps/demo/e2e/devtools-track.spec.ts`
  records a trace of a slow click and reads its JSON, checking the track group, the track names, the
  colours, the tooltip and that the measures are cleared again, in development and production builds
  and behind a Chrome 133 user agent. Opening `apps/demo/traces/context-storm-dev.json` in the panel
  beside React's own tracks is still to do.
- **Nothing has run against a real application**, only the synthetic demo, and nothing on Next.js's own
  bench apps.

## Next steps

What is left is the list above: look at the Performance panel tracks by eye, and run
the library against a real application and against Next.js's own bench apps. The
`react-inp-blame/web-vitals` entry landed on 2026-09-19 and has its own section; what it still wants is
a run under Next.js's `useReportWebVitals`, which reports INP only when the page is hidden and so needs
a test that can hide it. After those, the rest of the hydration verdict.
