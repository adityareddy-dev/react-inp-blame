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
click is three entries: pointerdown, pointerup, click). The interaction window is the earliest
`startTime` to the latest `startTime + duration`, which is the next paint. Input delay,
processing and presentation delay fall out of the same numbers, the way web-vitals computes
them. The target element resolves to its component through the `__reactFiber$` expando, and
the React handler prop for the event type is looked up on the same chain, so "no React
render; 120ms in the click handler computeChecksum" is possible without a profile.

**Long Animation Frames.** Overlapping `long-animation-frame` entries supply the script
attribution and `forcedStyleAndLayoutDuration`. LoAF can only say "React's event dispatch ran
for 80ms"; the fiber walk is what turns that into a component. Together they separate "your
render was slow" from "your layout effect forced layout 400 times".

**Follow-ups.** Commits that land after the paint but within a second of the same input, with
no newer input in between. Effects, transitions and data-driven re-renders show up here.

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
paint is worth a sentence even though INP alone would never flag it.

**Late arrivals.** A profile that renders 500 ms after the click, once the server answers,
lands long after the report was first emitted. Such renders attach to the existing report
(same input, no newer input since, within 1.5 s), the explanation is rebuilt, and listeners
receive the same report again with a bumped `revision`. Long animation frames that arrive
for those later renders fold in the same way. Event Timing rounds durations to 8 ms, so the
window edge carries that much slack, or a render that ends at the paint gets misfiled.

**Output.** An `InteractionReport` object, a listener API, and User Timing measures carrying
the `devtools` detail that the Chrome Performance panel (128+) renders as custom tracks: a
"Inpector" group with an Interactions track and a React commits track. Older
Chrome shows the same measures in the Timings track. Not yet verified visually in a real
profile, only that the measures are emitted without throwing.

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
  `keepNames`. The demo ships a 20-line Vite plugin that appends
  `Foo.displayName = "Foo"` to every component; string literals survive any minifier and
  React DevTools honours the same property. The same transform as a Babel or SWC plugin is
  the Next.js answer. Handler names are a different problem: LoAF's `sourceFunctionName`
  plus `sourceURL` and character position can be resolved through source maps offline, which
  is a RUM-side feature, not a browser-side one.
- **Durations.** Only `react-dom/profiling` records them. Counts and the hot path are
  usually enough to name the culprit; durations tell you how bad.
- **Budget.** The walk is bounded (`walkBudget`, default 5000 fibers) and only runs when an
  input event landed within the last second. Reports carry `overheadMs` so the cost is
  visible in the data rather than assumed.

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
shim is needed. What Next still lacks is the displayName transform: its SWC minifier renames
components in production, so the verdict reads "602 components re-rendered under n" until the
transform exists as an SWC or Babel plugin. A `useReportWebVitals` adapter would attach the
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

- no npm publish, and the name `inpector` has not been checked against npm yet
- no issue, PR or RFC opened with Chrome DevTools, React, Next.js, Vercel, OpenTelemetry or any RUM vendor
- no human look at the Performance panel tracks yet (the trace file exists, the panel has not been opened on it)
- no run against a real application, only the synthetic demo
- no displayName transform for Next.js, so production names in Next are minified

## Next steps, in order

1. Open `apps/demo/traces/context-storm-dev.json` in the Performance panel and check the
   two tracks read well; adjust names, colours and tooltip text.
2. The displayName transform for Next (SWC plugin, or Babel as the fallback) and a `next`
   package that wires instrumentation-client for you.
3. The production-mode overhead measurement on a real tree of several thousand fibers.
4. Package split: `core`, `vite-plugin`, `next`, and an OpenTelemetry exporter.
5. Then, and only then, the first outside conversation: one issue on
   `open-telemetry/opentelemetry-js-contrib` proposing interaction-attribution attributes.
