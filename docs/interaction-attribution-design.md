# Interaction attribution for React: design notes

Status: prototype, 2026-09-12. Core library, demo app with six anti-patterns, Playwright
suite green against React 19.3 (dev and production builds), 18.3.1 and 17.0.2 (legacy root);
Next.js 16.3.5 load-order check green in dev and production. Nothing published, nothing
proposed to any outside project yet. See "What has not happened"
at the end.

## The question

The browser can tell you an interaction was slow (Event Timing, which is what INP is built
on) and which scripts ran, with how much forced layout (Long Animation Frames). React can
tell you which components rendered and, in dev and profiling builds, how long each took.
Neither side knows about the other. Every React team that has chased an INP regression has
done the join by hand: record a profile, find the long task, squint at the flame chart for a
component name.

This library does the join and answers in plain words:

    264 ms click on button "Log in" in SignInPage. The click handler handleLogin ran for
    about 261 ms; React's own render was only 0 ms. A second React render landed 547 ms
    after the screen updated: 92 ms re-rendering 256 components inside ProfilePage, mostly
    PhotoTile (240 of them, 72 ms). INP doesn't count it, but people still wait for it.

## What is proven so far

Every line below comes out of `apps/demo/e2e/attribution.spec.ts`, run headless in Chromium.

| Scenario (anti-pattern) | Dev build verdict | Production build |
| --- | --- | --- |
| Context storm: unstable context value | 163ms rendering the OrderSummary subtree, LineItem x800 | same names via displayName stamping, attribution by render counts |
| Layout thrash: read after write in 400 layout effects | 14ms render plus 63ms forced style/layout, PriceTicker x400 | same |
| Handler hog: 120ms in the click handler, no state change | no React render before the paint; 120ms in the click handler computeChecksum | handler name minified, component names intact |
| Big list: 3000 unvirtualised rows filtered per keystroke | 157ms rendering the BigList subtree, Row x1440 | same |
| Lifted state: unrelated heavy sibling re-renders per keystroke | 127ms rendering the Sidebar subtree, NavItem x600 | same |
| Cascading effect: derived state set from useEffect | 1ms before the paint, then a follow-up commit 87ms after it rendering Detail x400 | same |
| Control: memoised rows, stable callbacks | 1 component rendered, under 30ms | same |

Overhead inside the interaction window: 0.4 to 0.9ms per commit for the fiber walk in dev with
an unlimited budget on trees of 400 to 1500 components. Outside an interaction the per-commit
cost is one subtraction.

One finding worth its own line: React runs the `useEffect` from a click after the paint,
observed on 17.0.2, 18.3.1 and 19.3.0 alike. Event Timing closes the interaction at that
paint (16 to 24ms), so INP never sees the 80ms render that follows, but the user does. The
report carries these as "follow-up commits" and the verdict says so. No other tool draws that
distinction today.

The same suite runs unchanged against React 18.3.1 and 17.0.2 (`scripts/react-matrix.mjs`
generates the pinned variants); fiber tags, the `PerformedWork` flag and the hook protocol
are identical across the three majors, and so are the verdicts.

## How it works

Four sources, one join.

**React commits.** React calls `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot` after every
commit, in production builds too, provided the hook exists before `react-dom` evaluates. The
library either creates a minimal hook or chains onto the real React DevTools one. Because the
hook exists at root creation, dev and profiling builds also turn on `ProfileMode`, which is
what populates `actualDuration` on fibers. That is the same trick React DevTools relies on.

**The walk.** After a commit the current tree is walked once. A component fiber that rendered
carries the `PerformedWork` flag. A fiber whose alternate still points at the same child list
bailed out, so its whole subtree is stale and gets pruned; that prune is what keeps the walk
cheap on big trees. Ancestors that were only cloned on the way down (App, layouts, providers)
are named on the path but never counted as roots. The hot path follows the child carrying at
least 60% of the parent's work, so it stops at "the OrderSummary subtree" rather than
descending into 800 identical rows.

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
120ms in the click handler computeChecksum" is possible without a profile. When the entry's
target is null because the node left the DOM before the observer ran (a close button, a
deleted row), the input ring below still holds the node and the fiber it carried at
dispatch, which React deletes from the node on unmount.

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

**Long Animation Frames.** Overlapping `long-animation-frame` entries supply the script
attribution and `forcedStyleAndLayoutDuration`. LoAF can only say "React's event dispatch ran
for 80ms"; the fiber walk is what turns that into a component. Together they separate "your
render was slow" from "your layout effect forced layout 400 times".

**Follow-ups.** Commits that land after the paint but within 1.5 s, stamped with the same
input, with no newer input in between. Effects, transitions and data-driven re-renders show
up here.

**Saying it in plain words.** Every report carries an `explanation`: a headline ("264 ms
click"), a rating on the INP thresholds (good to 200 ms, needs work to 500 ms, poor beyond),
where it happened (the element's own label and the component that owns it), one sentence for
the cause, extra sentences only when they earn their place, and the time split into three
phases a person can picture: waiting before the handler, working, updating the screen. The
cause separates React's render time from the rest of the working time (the handler and other
scripts) after subtracting forced layout, so a slow handler is named as such rather than
blamed on a two-component render. Later renders only get a sentence when they carry real
work (10 ms or 25 components), otherwise the page's own status pill or reporting panel would
show up in every report. The `verdict` string is the explanation joined into one line.

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
(same input stamp, no newer input since, within 1.5 s), the explanation is rebuilt, and
listeners receive the same report again with a bumped `revision`. Long animation frames that
arrive for those later renders fold in the same way. So do late Event Timing entries: an
interaction's entries arrive with the paint that presented them, the pointerdown in one
frame and the pointerup and click in a later one when the pointer was held, a keydown before
its keyup. There is no settle timer any more (a 150 ms one used to split a long press into
two reports): the report is built from the first batch, rebuilt in place when the rest
arrive with the revision bumped, and a quiet 30 ms tap that turns out to be a 100 ms click
is published at that point. Waiting for an interaction to be "complete" was never possible
anyway, because entries under the observer's 16 ms floor never arrive at all.

**Output.** An `InteractionReport` object, a listener API, and User Timing measures carrying
the `devtools` detail that the Chrome Performance panel (128+) renders as custom tracks: a
"react-inp-blame" group with an Interactions track and a React commits track. Older
Chrome shows the same measures in the Timings track. Not yet verified visually in a real
profile, only that the measures are emitted without throwing.

**The badge and panel** (`overlay: true`, or `'query'` for production pages, 2026-09-14).
A corner badge with the page's INP so far, coloured by the INP thresholds, and a panel that
lists interactions newest first: title ("Click on Log in"), duration, one blame line, and the
waiting / working / updating bar. Consecutive key presses in one field collapse into a row
that shows the slowest and the typical. A row opens into the cause sentence, the notes, and
the components that rendered before and after the paint. It is plain DOM in a shadow root
(no React, so it renders while React is busy and never adds a commit), about 3 ms of work per
report, and the page's own clicks on it are dropped before they become reports. The blame
line comes from `explanation.blame`, a data twin of the cause sentence decided in the same
branch, so the short and the long form never disagree. Page INP, on the badge, in the panel
head and from `api.inp()`, is the web-vitals estimate computed in-library, with no web-vitals
dependency: the interaction count is `performance.interactionCount` where the browser has
it, else estimated from interactionId spacing (Chrome steps ids by 7); the 10 longest
interactions are kept by their longest single entry; INP is the one at index
`min(floor(count / 50), 9)`, longest first. It counts every interaction the observer sees at
its 16 ms floor, plus the page's first input at any duration, so it is only exact when all
interactions over 16 ms were observed. The demo's own "Page INP so far" line reads the same
call, so the page never shows two INPs that disagree.

**Production builds and small renders.** Without durations, a 10-component render can win
the blame over a 260 ms handler. Since 2026-09-14 a render only earns it in production when it
is large (50 components when a handler is named, 10 otherwise), and a named handler with a
small render is blamed as "most likely", with the note that a profiling build would give exact
numbers. LoAF cannot separate the two: the handler and React's sync render run inside the
same script entry.

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
  where a `webpack()` hook never runs) and under webpack (`module.rules`). The Vite plugin
  in the demo is a thin wrapper around the same function. Proven on Next 16.3.5 in
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
- **Budget.** The walk is bounded (`walkBudget`, default 5000 fibers) and only runs when an
  input event landed within the last 1.5 s (`inputWindow`). Reports carry `overheadMs` so
  the cost is visible in the data rather than assumed.

The production mode is the one that has to reproduce a hand-made INP win on a large app; that
test has not been run yet against anything but the demo.

## Distribution: where this can live

**Chrome DevTools.** The Performance panel extensibility API is the zero-install path: any
page that includes the library gets a React attribution track next to the Interactions track
without an extension. A DevTools extension panel listing reports is the second step. The
long-term ask to the Chrome DevTools team would be a hook for framework attribution on the
Interactions track itself, which needs a working library and users first.

**React DevTools.** The Profiler dropped interaction tracing when React 18 removed the
`unstable_trace` API, and nothing replaced it. This library chains onto the DevTools hook
today (mode `chained`), so an "Interactions" view in the Profiler that joins Event Timing to
commits is a feature request with a working reference implementation behind it. React 19.2's
own Performance tracks (Scheduler and Components) are complementary: they show React's work,
this labels the interaction.

**Next.js.** Tested on Next 16.3.5 (`apps/next-demo`). In a production build,
`instrumentation-client.ts` runs before `react-dom` evaluates: the library's own hook is the
one React registers with, and the first keystroke is attributed. In dev, React Fast Refresh's
runtime has already installed a hook stub by the time instrumentation-client runs, so the
library chains onto it, and attribution works there too, with durations. No beforeInteractive
shim is needed. Setup is two lines: `withInpBlame()` around the config in `next.config.ts`
(`react-inp-blame/next`, adds the displayName loader as a Turbopack rule and as a webpack
`enforce: 'pre'` rule, merging with whatever rules the app already has) and
`import 'react-inp-blame/auto'` in `instrumentation-client.ts`. That is the shape Sentry uses
(`withSentryConfig` + `Sentry.init` in the same file), so it is what Next users expect. Proven
2026-09-14 in dev, Turbopack production and `next build --webpack` production; before the
loader the verdict read "602 components re-rendered under n". One lesson from the webpack
run: its type check rejects a page file that exports anything Next does not expect, which
Turbopack's does not, so the demo's `memo()` component is no longer exported. A
`useReportWebVitals` adapter would attach the
report to web-vitals' INP attribution object so Vercel Speed Insights, or anything else
consuming it, gets component names for free. The aim is inclusion in Next.js itself rather
than a plugin people have to find; those three pieces are what make that a reasonable ask.

**Vite.** The displayName plugin plus an auto-import of the `auto` entry.

**RUM vendors and OpenTelemetry.** The report maps cleanly onto span attributes:
`interaction.id`, `interaction.type`, `react.component`, `react.hot_path`,
`react.rendered_count`, `react.commit_count`, `react.follow_up_count`, `dom.forced_layout_ms`.
A semantic-convention proposal turns the library into one implementation of a standard rather
than a dependency people have to pick.

## What has not happened

None of the following has been done, and nothing here should be described as if it had:

- no npm publish, and the name `react-inp-blame` has not been checked against npm yet
- no issue, PR or RFC opened with Chrome DevTools, React, Next.js, Vercel, OpenTelemetry or any RUM vendor
- no human look at the Performance panel tracks yet (the trace file exists, the panel has not been opened on it)
- no run against a real application, only the synthetic demo

## Next steps, in order

1. An on-page overlay: a corner badge with the page's INP, and a panel that lists each slow
   interaction, the component to blame and a waiting / working / painting bar. Same look in
   the Vite demo and in Next.
2. The production-mode overhead measurement on a real tree of several thousand fibers.
3. Open `apps/demo/traces/context-storm-dev.json` in the Performance panel and check the
   two tracks read well; adjust names, colours and tooltip text.
4. Package split: `core`, `vite-plugin`, `next`, and an OpenTelemetry exporter.
5. Then, and only then, the first outside conversation: one issue on
   `open-telemetry/opentelemetry-js-contrib` proposing interaction-attribution attributes.
