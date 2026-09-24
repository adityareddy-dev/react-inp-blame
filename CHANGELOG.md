# Changelog

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions are
[semantic](https://semver.org/spec/v2.0.0.html). `schemaVersion` on a report is versioned separately:
it changes when a field is removed or changes meaning, which a minor release may do while it is 0.x.

## [Unreleased]

## [0.3.0] - 2026-09-24

### Added

- **The READMEs show how to send the blame to Sentry and to Google Analytics 4.** Both start from
  web-vitals' `onINP` and `attributeINP`: Sentry gets one metric per page view with the blame in its
  attributes, since its own INP span carries no interaction id to join on, and GA4 gets web-vitals' own
  `debug_target` example with two more parameters. Neither sends a label or a sentence. The READMEs also ask
  for wrong or missing blames through the issue form and say what to include, and the form's versions field
  now asks for Next.js or Vite as well.
- `CommitSummary.startedAt`: when React began the render a commit came from, on `performance.now()`'s
  clock, read from the root fiber. From there to `at` is React's own time for the commit, committing
  it included. `null` in a production build, which keeps no start, and where React did not time the
  tree. A commit object your own code builds, in a test fixture or a fake, needs the field.
- `CommitSummary.effectsStartedAt` and `effectsEndedAt`: when every tool on the DevTools hook had been
  handed the commit, and when React had run its passive effects, the `useEffect`s, as React 18 and 19
  report it to the hook, production builds included. Both `null` until the effects have run, for a
  commit whose tree has none, for a root made with `ReactDOM.render`, and on React 17, which does not
  report them. A commit object your own code builds needs these fields too.

### Changed

- **`schemaVersion` is 2, on the report and on the `react` field `attributeINP` adds.** Three fields
  keep their names and change what they hold, below: `blame.name` can be a script's invoker where it
  used to be `null`, `target.label` names the control around where the click landed rather than the
  element itself, and a render blame's `ms` includes committing and effects. Code that reads any of
  them should check the version; code that only passes the report along needs no change.

- **A render blame's `ms` is the commit's time in all, not its render alone.** It is the render,
  committing it and its `useEffect` callbacks together, which is what the type has always said it is:
  how much of the interaction the blame accounts for. A 3 ms render whose layout effects ran for 272 ms
  was `ms: 3`, and the overlay showed 3 ms beside it; it is now 275. A production build's render blame
  stays `null`.

- **`withInpBlame` works on Next.js 15.3 to 16.2 instead of throwing.** Those versions have no
  `instrumentationClientInject`, so the wrapper adds the loader and the options and prints one line for
  the app's own `instrumentation-client.ts`, `export { onRouterTransitionStart } from
  'react-inp-blame/next-client';`, until the file has it. Next.js imports that file before hydration,
  which is early enough: the load-order, hydration and `useReportWebVitals` suites pass on 16.2.12,
  15.5.26 and 15.3.9 with it, under both bundlers, and CI runs them. That line is in every build, so
  `react-inp-blame/next-client` now installs nothing in a build the wrapper's `enabled` leaves out,
  though its code still ships there. Before
  16.0 the Turbopack rule keeps to the browser and out of `node_modules` through builtin conditions, the
  form those versions take, and `experimental.turbo` rules and loaders carry over. On 16.3 and later a
  kept line does the install and nothing is injected a second time, but it is better deleted, so builds
  `enabled` leaves out stop carrying the code. Below 15.3 the wrapper warns and returns the config as it
  was.

- **A wait names what the input waited behind.** A `waiting` verdict used to end "the main thread was
  busy with something else", even where the long animation frame that was open when the input came
  listed the script that kept it. The sentence now names that script, says whether it was already
  running or ran first, and how much of the wait it held. `explanation.blame.name` carries the script's
  invoker (`"TimerHandler:setTimeout"`) when it filled at least half of the wait, and is `null` as
  before otherwise; the overlay row shows it. Found on TanStack Table's fuzzy filter example at a
  million rows, where a key press waited 843 ms behind a debounced filter. With no script on record
  the old sentence stands.
- **A slow listener React did not attach gets a name.** A shortcut bound on the document has no React
  handler, so a `handler` verdict could only say "code outside React". The sentence now adds the
  longest script the browser recorded in the working time, with its file ("#document.onkeydown
  (excalidraw/reactUtils.ts), 115 ms"), and `blame.name` carries that invoker when it covers at least
  half of the time blamed; `blame.detail` is then `null`, since a document listener lives in no
  component. A handler React does name is unchanged. Found on Excalidraw's undo at 1,536 shapes.
- **A click on an icon is labelled by its button.** A click on an icon button lands on the svg's
  `line` or `path`, and the report said "click on line". `target.label` now comes from the control
  within five ancestors of where the click landed (a button, link, summary, label, form field, or an
  element with a control's ARIA role), so it reads `button "main-menu-trigger"`. `target.selector` is
  still the element the browser reported.
- **Forced layout takes the blame from 25 ms where no render was timed.** That is a production
  build, or an interaction no commit joined. The floor was 50 ms everywhere, which left a band where
  a measured layout lost to a render known only by its component count: opening a Sheet on the shadcn docs spent 44 to 49 ms of
  55 ms of working time on layout and was reported as a render, and the Dialog beside it changed
  verdict between runs at 49 and 50 ms. It still has to be half the window it was counted across. A
  commit with render durations keeps the 50 ms floor. In every build a layout no longer takes the
  blame from a longer wait before the handlers: that is a `waiting` verdict, as it is for a handler.
- **Text nobody can see is not a label.** With `labels: 'text'` a key press with nothing focused lands
  on the body, and the body's first text in a Vite page is its `noscript` line, so the report read
  `key press on body "You need to enable JavaScript to run thi"`. The first run of text now skips
  `noscript`, `script`, `style` and `template`. Found on Twenty's record table (the twentyhq/twenty CRM).
- **The overlay's rows open from the keyboard.** A row was a clickable `div` that could not take the
  focus, so from the keyboard alone there was no way to open one into its explanation. Its header is
  now a button in the Tab order (`role="button"`, with `aria-expanded`), and Enter or Space opens and
  closes the row without losing the focus. Held down, the key toggles it once rather than on every
  repeat. The close button, or Escape pressed inside the panel, closes it and moves the focus to the
  badge, where before the focus was lost with the panel. Escape anywhere else on the page still just
  closes it. Enter held on the badge, or on the close button, opens or closes the panel once, where
  the badge used to flip it on every repeat. The panel is drawn again whenever a report arrives or
  changes, and whichever of a row header, the close button or Clear had the focus has it again
  afterwards, so the next Tab stays in the overlay. Clear keeps it after emptying the list.

### Fixed

- **A heavy `useEffect` is React's time, not the handler's.** React 18 and 19 run a click's or a key's
  passive effects in the same task as its commit, before the paint, and the working time they took went
  to the handler: a click whose `useEffect` drew a chart for 300 ms came back as its `onClick` running
  for 311 ms, beside a 5 ms render. React tells the DevTools hook when a commit's passive effects have
  run, so the time from the end of the hook call to there is now React's, and the sentence says how
  long the `useEffect` callbacks ran. It counts only where both ends fall inside the interaction's
  handlers, so effects React ran in a later task, as it does for most other updates, are judged as
  before. A render React makes once the effects are done and before it says so, from `flushSync` in an
  effect or a `setState` in a layout effect, keeps its own time, and a production build, which cannot
  take such a render out, says the figure holds it. A production build keeps no render start, but its
  effects are timed all the same: there the render is named as a reading and the effects are measured.
  React 17 does not say when effects ran, and React 18 runs a `ReactDOM.render` root's effects whenever
  it next renders, so on those a heavy `useEffect` still reads as the handler. The handler is also now
  the blame only where it outran all of React's time, committing and effects included, rather than its
  render durations alone: a 100 ms handler beside a 5 ms render and 200 ms of effects is React's, with
  the handler's 100 ms said after it. Where the handler does outrun React, the sentence says the
  committing and effects that would show beside it. A production build cannot split the rest of the
  working time between the handler and the render, so there the effects take the blame only where they
  are at least half of it, or where no handler has a name: a 150 ms handler beside 60 ms of effects
  stays the handler's, and its figure comes out as about 150 of the 210 ms, with the 60 ms said.

- **Layout effects are React's time, not the handler's, where no Long Animation Frames say otherwise.**
  In Safari and Firefox the working time outside React's render durations went to the handler, and a
  render duration stops where committing starts. So in a development build a click whose 400 layout
  effects each read a size came back as its `onClick` running for 465 ms, beside a 404 ms render.
  A development or profiling build keeps when React began each render, so React's time now runs from
  there to the end of the commit, and the handler is blamed only from working time outside that. Only
  a render that began and committed inside the handlers counts that way: one that waited or yielded
  across them is judged by its render duration, as before. Where committing took 25 ms and a quarter of
  the working time, what a handler needs to be blamed, the render keeps the blame however small the
  render itself was, names the commit React spent longest on, and says how long committing took. A
  production build keeps no start and is judged as before. Found by the iPhone tap test in CI, on Linux
  WebKit.

- **Next.js's dev overlay stays out of the reports.** Under `next dev` from Next.js 15.4.11 and 15.5 the
  overlay renders with a production React of its own, and its commits joined the click they landed in.
  The report then named the overlay's minified components (`lk > P > eW` on 16.3.5), and as React never
  timed those commits, `commits.ms` in the web-vitals attribution was `null` and the explanation asked
  for a profiling build. The root the overlay creates on its `<nextjs-portal>` element is now left out,
  whatever React it runs, and the app's own roots are read as before, a production react-dom's too.
  Found by the web-vitals test on 15.5 under `next dev --turbopack`, where the overlay committed inside
  every click. On 16.3.5 it took opening the dev tools menu first.

- **An `inputWindow` over 1500 ms reaches the report.** The option set how long after an input's own
  work the hook walked a commit, but a report took later renders only within a fixed 1.5 s of its
  paint, so a page that set it to 3000 paid to walk a render 2 s after the paint and never saw it in
  `followUps`. A report now takes later renders within `inputWindow` of its paint, or of the end of a
  later input's own work in the same interaction where that came after the paint, which is where the
  hook measured from. The default length is unchanged, and a shorter window drops nothing the hook
  walked for the interaction. What changes at any length is where the window starts for a later input:
  where the pointerdown was the slowest part of a click, a render of the click counted from the
  pointerdown's paint, so a pointer held down past the window lost the render its release made, even
  one inside the click's own dispatch. A `change`, `input` or `submit` counts as part of the input
  before it only when the browser fires it in that input's task or within `inputWindow` of the work
  that task did, so a file chosen in the system dialog 20 s after its click is not a later render of
  it, and text that arrives with no key pressed, from dictation or an input method, stops joining the
  click rather than joining it for as long as it runs. Found reading the code, where a comment in the
  hook said changing one length did not change the other.

- **A click made from the keyboard belongs to its key, not to the mouse click before it.** A pointerup
  or a click is tied to the press it releases by its `pointerId`, and the click that Enter or Space makes
  has none to go by: its `pointerId` is -1. It took the newest pointerdown of the last 5 s instead. So
  after a mouse click on a button, Enter on the same button within `inputWindow` of that click's paint
  had its render joined to the mouse click's report as a later render, whenever the report held the
  mouse click's pointerdown entry, which it does once that entry reaches 16 ms, or at any length when
  that click was the page's first input. The click is now part of
  the key whose task made it, Enter's keydown or a Space's keyup, and a click with neither a key nor a
  pointer behind it, the kind a screen reader sends, is a gesture of its own. Found reading the code.

- **The subpaths have types under `moduleResolution: "node"`.** That setting, `node10` since
  TypeScript 5.0 and still what older setups have, ignores `exports`, so every import but the package
  root failed the type check with "Cannot find module 'react-inp-blame/next' or its corresponding type
  declarations", and the READMEs said to switch to `bundler`. A `typesVersions` map now points each
  subpath at the declarations its `exports` entry names. `bundler`, `node16` and `nodenext` read
  `exports` and ignore the map: with it pointed at a file that does not exist they still pass. Checked
  on TypeScript 4.7.4, 5.0.4, 5.8.3 and 5.9.3; 6.0 wants `ignoreDeprecations: "6.0"` for `node10`, and
  7.0 no longer has it. What still fails depends on `module`, not the resolution. In an app with no
  `"type": "module"`, `module` `node16` or `node18`, or `nodenext` before TypeScript 5.8, stands for a
  Node that cannot `require()` an ES module, so an import that takes a name from any subpath but `/next`
  and `/display-names-loader` gives TS1479, or TS1541 for an `import type` from 5.7; `nodenext` from 5.8
  and `node20` from 5.9 pass. Under those same settings the `/next` types have always needed
  `skipLibCheck`, in any app, since they take `InstallOptions` from the ES-module types, and the READMEs
  now say so. The packed-tarball check now type-checks every subpath under `node10`, `node16`,
  `nodenext` and `bundler`, so a subpath added without an entry in the map fails it.

- **A copy of this version keeps to itself beside an older one on the same page.** Every copy of the
  library on a page keeps its state under one global key, so that two copies install once between
  them, and a copy only uses what it finds there when the layout number beside it matches its own.
  That number stayed at 1 from 0.1.0 through 0.2.0 though what is kept there changed, and it changes
  again here: a renderer records whether it only draws Next.js's dev overlay, and an input where the
  work of its own task ended. It is 2 from this release, so where an older copy got to the page first,
  this one installs nothing and says so in the console, and `npm ls react-inp-blame` lists the two
  versions. Found reading the code.

### Removed

- **`fiberFromNode`, `ownerChain` and `handlerName` are no longer exported, nor is the `Fiber` type.**
  The READMEs listed them without saying what they take or return, and `fiberFromNode` handed out
  React's own fiber, typed as whichever fields this library happened to read, so a change to what it
  reads would have changed a public type. `fiberFromNode` and `Fiber` have no stand-in: the library no
  longer hands out React's fiber. For the element an interaction landed on, the report already carries
  the other two: `target.owners` is what `ownerChain` returned, nearest first, and `target.handler`
  is what `handlerName` returned. Both are read when the report is built, or at dispatch where the
  element had left the page by then. For any other element `handlerName` has no stand-in.
  `generateTarget(node)` from `react-inp-blame/web-vitals` names the components around it with no
  `install()` needed, but as one string, the way web-vitals prints a target: outermost first, the
  four nearest at most, then the element in brackets (`"ProfilePage > PhotoTile (button.tile)"`), or
  `undefined`. `ownerChain` gave an array of up to eight, nearest first, so code that took
  `ownerChain(el)[0]` wants the last name before the brackets. The no-op stand-ins for all three
  under the `react-server` condition went too.
- **The types `InputStamp`, `InputRecord` and `InputWork` are no longer exported.** They describe the
  ring of recent inputs the library keeps for itself, and no report, option or function names them. A
  commit carries the input it was stamped with as `inputTs`, `gestureTs` and `inputType`.
- **`react-inp-blame/display-names-loader` exports the loader and `stamp(code)`, and nothing else.**
  `componentNames(code)` was in its type declarations but in no README, and `componentEntries(code)`
  was in neither. The names the loader gives a file are the ones `stamp` assigns in what it appends
  after it, each `Foo.displayName = "Foo"` inside a guard, so
  `stamp(code).slice(code.length).matchAll(/\.displayName = ("[^"]*")/g)` reads them back.

## [0.2.0] - 2026-09-20

### Added

- **A hydration verdict.** A click that lands on server-rendered HTML React has not hydrated yet is
  named as that instead of going unexplained: `report.hydration` says whether React hydrated it inside
  the click (`kind: 'waited'`, with the boundary and the time) or it was still waiting and no React
  handler ran (`kind: 'not-hydrated'`). `explanation.blame.kind` gains `'hydration'`, a `Phase` may
  carry `parts` so the hydrating time shows inside the working time without becoming a fourth phase,
  and a commit carries `hydratedTarget`, the boundary it hydrated around the input's target. Reports
  stay at `schemaVersion: 1`: the fields are new, and the phases add up as they did. React 18 and 19
  only, and `apps/next-demo` has a streamed Suspense boundary that proves it under `next dev`, Turbopack
  and webpack.

  Two things to check when you take this. A `switch` over `explanation.blame.kind` that TypeScript
  checks for exhaustiveness now has a case missing, `'hydration'`. And a report object your own code
  builds, in a test fixture or a fake, needs the three new fields: `hydration` on the report,
  `hydratedTarget` on a commit and `dehydrated` on an input record. A report stored before this release
  and read back has them `undefined`; the library treats that as `null` throughout.
- `react-inp-blame/web-vitals`: `generateTarget` puts a React component path where web-vitals writes a
  CSS selector, and `attributeINP(metric)` adds this library's report for the interaction to an INP
  metric as `attribution.react`. It imports nothing from web-vitals, `generateTarget` needs no
  `install()`, and neither throws on a metric it cannot read.
- A hosted demo, built from `apps/demo` and deployed to GitHub Pages by `.github/workflows/pages.yml`.
- Issue forms for a wrong or missing blame and for a setup problem, and this changelog.

### Fixed

- **A Vite production build could install the library after react-dom had already evaluated**, and
  then nothing was attributed at all: React looks for the DevTools hook once, while it evaluates, so a
  hook created after that is never registered with. `vite build` folds every module script of a page
  into one entry module, and a module's imports are evaluated before its body, so the `install()` call
  the plugin added ran after any chunk that evaluated react-dom on the way in. Which chunk that is, if
  any, is the bundler's decision, so the same app could be right or wrong depending on how it split:
  it was seen failing in this repo's React 17 demo built with Vite 8, and in a two-page build where
  the modulepreload polyfill and react-dom share a chunk the entry imports first. The plugin now gives
  the install call a chunk of its own and the page a `<script type="module">` of its own ahead of its
  entry script, which is an order no bundler rearranges. Builds that can have no second script, a
  single-file output format, `build.lib`, and the `nomodule` bundle `@vitejs/plugin-legacy` adds, keep
  the inline import they had. The dev server is unchanged. Checked by loading built pages in Chromium
  on Vite 5.4, 6.4, 7.3 and 8.3; see the Vite section of `docs/interaction-attribution-design.md` for
  the results and for the one configuration this cannot fix. Both React matrix variants now run in CI
  as production builds too.

- `withInpBlame` threw nothing when the options were passed as its first argument, where the Next.js
  config goes. Next.js dropped them with "Unrecognized key(s) in object", nothing installed, and the
  library looked broken. It now refuses that call and quotes the two-argument form with the caller's
  own values.
- `withInpBlame` and `inpBlame` ignored an option they do not have, so `{ overlay: true }` written a
  level too high showed nothing and said nothing. Both now refuse an unknown key, list the ones they
  take, and, when the key is an `install()` option, say it belongs under `runtime`.
- A commit that rendered no component at all, which is what React's retry of a boundary it still cannot
  hydrate leaves behind, was described as "re-rendering 0 components inside the app". It now says React
  committed without rendering a component.
- A label read from an element's text stopped at the first `<!-- -->` React's server renderer leaves
  between two adjacent text children, so a hydrated `Slow click ({count})` was labelled
  `Slow click (`. Those comments are separators inside one run of text and are now skipped, up to a
  fixed number of siblings.
- **An interaction slower than the join window was reported as one React never rendered for.** A commit
  was joined to an input only when it landed within 1.5 s of that input, measured from the input itself,
  so a click that spent 2.5 s inside React had its commit dropped and the report read "React didn't
  render anything", with confidence `measured`. A commit React makes inside an input's dispatch is now
  that input's however long the dispatch has run, and a commit outside any dispatch is measured from the
  end of the last commit inside that input's dispatch rather than from the input. That is not the end of
  the dispatch, which the library cannot see: a handler that works for two seconds and commits nothing
  leaves the window running from the input, and a transition it starts afterwards is still dropped.
  A dropped commit that ran while the interaction's own handlers were running is counted on the report as
  `unjoinedCommits`: the report then says React rendered during the interaction and that those commits
  could not be tied to it, and nothing it says about React's work is `measured`. A commit outside those
  handlers, a clock ticking elsewhere on the page, is not counted against the interaction.
  `InteractionReport` carries a new required field, `unjoinedCommits`, so a report object built by hand
  rather than by `buildReport` has to set it; `InputRecord` carries a new `work` field; reports stay at
  `schemaVersion: 1`.
- **Arrow-function components lost their names in production.** The `displayName` loader matched only
  `function Foo(` and `const Foo = memo(...)`, so `const Foo = (props) => …`, the form most components
  are written in, reached the minifier unnamed and the blame named `t` or `Wr`. It now stamps any
  top-level capitalised binding whose value is a function, including the `React.memo`, `forwardRef` and
  generic forms, reading the source with strings, templates, comments, regular expressions and JSX
  masked out. Across Excalidraw and two TanStack Table examples (301 files) that took the components it
  names from 57 to 256, and every component the corpus can identify in those files, 316 of 316, now has
  a name, counting the 60 the apps already name themselves with a `displayName` of their own. It also
  reads the top level as brace depth rather than as indentation and skips a name the module imports.
  Two passes that were quadratic are linear: a 1 MB run of word characters used not to finish, and
  10,000 components in one file took 8 seconds. Both are now under 100 ms.
- **A stamp could throw at load and take the page down.** The stamp was a bare
  `Foo.displayName = "Foo"`, which fails on a frozen component, on a read-only `displayName`, on
  anything that is not an object, and on a name the loader read wrong; a module is strict, so that is
  a page that does not load rather than a name that does not appear. Evaluating 76 stamped modules
  under Node, in both the order Next.js transforms in and the order Vite does, 22 of them threw. The
  stamp now checks the value first, with `typeof Foo === "function" && Object.isExtensible(Foo) && …`
  for a function and a `try` for a `memo` or `forwardRef` object, and it never replaces a `displayName`
  your own code has set, including one from a naming HOC. All 76 load. The loader also stops naming a
  called function expression (`const Foo = function () {…}()`, `.call`, `.bind`), skips a module whose
  first statement is `"use server"`, and reads three shapes correctly that it used to misread: a
  pattern after `if (…)`, a backtick in JSX text, and a named function expression written at column 0
  inside `memo(` or an array. What the guard costs is tree shaking under terser and SWC, which could
  drop an unused component under the bare assignment; Rollup still drops it, esbuild still keeps it,
  and the 301-file corpus gives exactly the same names as before. See Known limits in the README.
- **A click on a checkbox, a radio or a select reported `handler: null`.** The event-to-prop table had
  one entry per native event and did not know that React fires `onChange` from the *click* on a checkbox
  or a radio, from `change` on a select or a file input, and from `input` on a text field. It now
  follows react-dom's own ChangeEventPlugin per control, forwards a click on a label's own text to the
  control the label wraps, and falls back from a pointer prop to the mouse prop of the same name.
  A click that lands on something interactive inside a label, an anchor, a button or a second control,
  is that element's: the browser forwards nothing there, and the label's own `onClick` wins over the
  control it wraps. `onSubmit` is reached from a key press only on Enter in a field or on a button,
  which is what implicit submission is, so `handlerOf` and `handlerName` take the key as a third
  argument; without it a key press reaches no `onSubmit`. Every one of these would rather return null
  than name a handler that did not run.
- **A render could be credited to an interaction two steps back.** A commit made outside any dispatch
  is stamped with whatever input the ring last held, so sorting a table and then changing its page size
  told the sort click it had re-rendered 417 components a second after it had painted. A follow-up now
  attaches only when no newer input arrived before that commit, and the follow-up window runs from the
  paint rather than from the input, so a slow interaction keeps the render that followed it. What is
  fixed is the case with a real user input behind the second render: the input ring is the whole of the
  evidence, so a page-size change made by script, which fires no trusted input of its own, still leaves
  its render attached to the click before it.
- **An inferred blame read like a measured one.** Every sentence the explanation can produce is now
  paired with its confidence: an inferred blame says "most likely" in the headline sentence and in the
  overlay's short line, and names a profiling build of React as what would make it exact, but only where
  a build with no render durations is what made it a reading. A blame that names nothing has nothing to
  hedge and does not.
- **Forced layout could never be blamed on a production build, however large.** The one branch that
  weighed anything against a render needed React's render durations to subtract them, and a production
  build records none, so a layout the browser had measured came out as a footnote under a render nobody
  had timed: 108 ms of layout inside 116 ms of working time was reported as a re-render of 181 components
  with `ms: null`. `explanation.blame.kind` gains `'layout'`, taken from 50 ms when the layout is half the
  window it was measured across, larger than React's render, larger than the time outside it, and not
  outweighed by the screen update that followed; the sentence says what is left over ("leaving 8 ms for
  React's render and commit, its layout effects and the click handler together"), which is what makes the
  demotion of the render a measurement. Its `name` and `detail` are where the layout happened, not what
  forced it, which nothing records: the joined commit's subtree and what it was mostly made of, dropped
  for the invoker the browser charged the script to where that commit only overlapped the interaction in
  time, was walked short of the end, or sat beside commits that could not be tied to the interaction at
  all — the milliseconds are the browser's and stay `'measured'`, so the name is dropped rather than the
  confidence lowered to cover it. The invoker stands for the whole layout only while one script holds
  nine tenths of it, since `ms` is every script's total summed and a name beside it claims all of it;
  below that `name` is `null`. The sentence names the largest script either way, with how much of the
  total it holds. It is the only blame **about React's work** that keeps
  `'measured'` in a production build — `'waiting'` and `'painting'` are the browser's own phases and never
  depended on the build, and `'script'` does not either, though it is `'inferred'` whenever a commit could
  not be tied to the interaction — and it is `'inferred'` only where a script ran past the window
  and its forced layout had to be apportioned by time. A `switch` over `explanation.blame.kind` that
  TypeScript checks for exhaustiveness now has a case missing.
- **Two interactions of the same shape could get opposite verdicts.** The render was tested before the
  screen update, so a component count decided which: paging a calendar forward one month (5 ms of working
  time, 82 of the screen updating) read `render` and `'inferred'`, while toggling a theme (2 ms and 85)
  read `painting` and `'measured'`. A render, a handler and a forced layout are all bounded by the working
  time they ran in, so the screen update is now weighed against that window once, and every branch inside
  it steps aside where the screen update is longer. Hydration is the exception and sits above the
  comparison: an input that landed on un-hydrated HTML is worth saying whatever else took longer. Because
  the comparison is the same one the painting branch asks, a branch it closes is a branch painting opens,
  so a verdict is never refused for the screen update and then dropped below it to `'script'` or `'none'`.
  A branch closed that way leaves a note naming what it would have blamed, so a 200 ms render inside a
  425 ms interaction is still reported when the 215 ms of screen update after it takes the verdict.
- **`where` named the innermost owner, which on a design-system app is never the app's own component.**
  Across seven interactions on one real App Router site it printed `in header`, `in Primitive.button`
  twice, `in Primitive.input`, `in Primitive.div` and `in _`, with the component the reader would
  recognise sitting further up the same chain every time. `target.component` is now the nearest owner
  whose name a reader could search their own code for: capitalised, as React requires of a component
  name, so a column definition's `header: ({ table }) => …` no longer reads as an HTML tag; at least three
  characters, since a minified dependency that ships no `displayName` leaves one and two character names;
  and every part of a dotted name the same, so `Primitive.button`, which names the element that was
  clicked, gives way to the component above it. `target.owners` still carries the whole chain, and where
  nothing in it passes, the innermost owner is named as before. A name is never invented.

## [0.1.1] - 2026-09-19

### Fixed

- A report with no target read "Typing in" with nothing after it. It now reads "Typing" or "Click".

## [0.1.0] - 2026-09-17

First release.

### Added

- `install()` joins the browser's Event Timing entries and Long Animation Frames to React's fiber
  tree, through the hook React keeps for developer tools, and publishes a frozen `InteractionReport`
  for each slow interaction: the blame with its confidence, the phases, the components that rendered
  before and after the paint, and a plain-language verdict. `onInteraction(fn)` hears them.
- An INP estimate for the navigation the page is on, `inp()`, written from the same entries web-vitals
  reads and checked against web-vitals 6.2.2 over more than 50 interactions in a browser.
- An on-page badge and panel, `overlay`, drawn as plain DOM in a shadow root and loaded only when
  shown, and in Chrome's Performance panel an "Interaction blame" track with an entry per interaction,
  beside a "React renders" track where React draws no render track of its own.
- `withInpBlame` for Next.js 16.3 and later: the runtime on `instrumentationClientInject`, so it
  installs before hydration, and a `displayName` loader under Turbopack and webpack. `inpBlame` for
  Vite does the same two things, and `react-inp-blame/auto` covers any other bundler.
- React 17, 18 and 19, and a fail-closed check on every React internal the library reads.

[Unreleased]: https://github.com/adityareddy-dev/react-inp-blame/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/adityareddy-dev/react-inp-blame/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/adityareddy-dev/react-inp-blame/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/adityareddy-dev/react-inp-blame/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/adityareddy-dev/react-inp-blame/releases/tag/v0.1.0
