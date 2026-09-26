# Known limits
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
  `first-input` entry. See "Quiet interactions" in the [design notes](interaction-attribution-design.md).
- React 18 and 19 development builds print "Download the React DevTools" on pages where the library created the
  hook: it has no `checkDCE`, which react-dom takes to mean React DevTools is there.
- **Hydration is joined to an input only when React hydrated inside that input's dispatch**, which is what
  React 18 and 19 do for a discrete event on a boundary that has not hydrated yet. A hydration that merely
  follows a keystroke is nobody's interaction and is left out. On React 17 nothing is: it has no dehydrated
  Suspense state, and it clears its one hydration flag before it calls the hook. See
  [Clicks that land before hydration](how-it-works.md#clicks-that-land-before-hydration).
- On React 17, which calls nothing after a commit's effects, a render set off by an effect of your report
  listener's own render can still join a report. On React 18 and 19 it cannot.
- **A render your report listener causes is recognised by the lane React put it on**, and React has one lane
  for each priority. An update of the app's own that lands on the same lane before React commits is rendered
  in that same commit and left out with it, which for an otherwise quiet interaction can mean no report.
  A commit inside an input's dispatch is kept even so. React 19 renders sync, continuous and default
  updates in one pass, so a key pressed before React's own task for your listener's update renders that
  update along with its own, and that commit is the key's. Its counts then take in your listener's
  components beside the key's, and where the key's own render is small, those components can be the render
  the blame names. The commit is not marked as your listener's either, so an update its components make in
  `useEffect` reads as the key's later render, on React 18 and 19 as well.
- Production React records no durations, so blame there rests on render counts and is `'inferred'`
  (`react-dom/profiling` gives durations), and minified handlers are named by their prop. An inferred blame
  says "most likely" in its sentence and in the overlay; take it as the likeliest reading, not a measurement.
  A count says nothing about time, so the render rung blames a render known by its count alone only from
  50 ms of working time, the length of a long task, and its sentence gives the working time the count is
  read against. Under that the count is not a slow render, however large: the cause leads with the working
  time and says the count sat in it, short of a long task, before what else the report knows. A hydration
  the interaction waited for is still named by its count at any working time, as before.
  The exceptions are what the browser times itself and the build cannot change: waiting, the screen update,
  a Long Animation Frames script, and forced layout inside the handlers, which stay `'measured'` in a
  production build. The build is not the only thing that can lower a confidence, though: a script blame is
  `'inferred'` whenever a commit could not be tied to the interaction, since a script is what is left once
  React is ruled out and an unjoined commit is exactly what stops React from being ruled out.
- **Forced layout is blamed only when a long animation frame measured it**, which is Chromium only. The
  browser counts style recalculation in the same figure, so a `'layout'` blame covers either. Its share of
  a script that ran on past the handlers is apportioned by time rather than measured, so such a blame is
  `'inferred'`. Where the browser reports no long animation frames the report says nothing about
  layout at all, rather than implying none happened. Where it does report them and none covered the
  interaction, the frame was under 50 ms, and a production build's report whose count would otherwise have
  named the render says how much of the working time went to any styles and layout the interaction forced
  is unmeasured, rather than blaming the render on its count: a style recalculation inside 17 ms of working
  time is invisible to the browser's own record. Nothing records *which* read forced the
  layout, so a `'layout'` blame's `name` and `detail` say where it happened instead: the joined commit's subtree and
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
  taken at face value either way. The names as they are stay on `target.owners` (the eight innermost), each
  commit's `components` and its `hotPath`; the path spends its twelve steps only on names a reader could
  search for, passing a library's layers between them (a Slot, `Primitive.div`, a Provider, a wrapper named
  after the component it renders) without spending one, and a render is named after the deepest searchable
  name on it, so it reaches the component below those layers where there is
  one. A name with the `$1` that Vite's development server and Rolldown add to one that clashes
  (`Dt$1`) is judged without it. The component emotion renders beside every element @emotion/styled or the
  `css` prop styles, to insert its styles, is not counted.
- **A styling library's wrapper is named the way the library names one it was given no label for**, whatever
  label it has: MUI's `MuiButtonBaseRoot` reads `Styled(button)`, a styled-components wrapper its Babel or SWC
  plugin named `Title` reads `styled.h1`, a Linaria one its plugin named `StyledContainer` reads `styled.div`,
  and the component @emotion/react's `css` prop wraps an element in reads `Styled(li)`. So none of them is
  taken for a component the app wrote, in development or production.
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
  input arrived is left out of the report, as is one after an `input`, `change` or `submit` a script
  dispatched once the interaction had painted (Playwright's `selectOption` changes a select that way), and
  one that lands past the window is dropped; a dropped commit
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
  follow-up lands after the window was resized loses it, the rule a newer input already follows. So does a
  click on a page whose own code dispatches `input`, `change` or `submit` after the paint, from a timer or
  from an effect React runs in a task of its own (React 17 runs every effect that way): what renders after
  that event is left out, its own handler's render included.
- **The window runs from the last commit inside the dispatch, not from the end of the dispatch**, which the
  library cannot see. A handler that works for two seconds and commits nothing leaves the window running from
  the input, so a transition it starts afterwards can fall outside it. That render is then dropped and counted
  rather than reported: the interaction says React rendered something it could not tie to it.
- **Waiting on the server is not a phase.** A click that calls a Server Action, a route handler or any `fetch`
  and shows a pending state paints at once, so INP and the report count the click, not the wait. The render
  showing the result joins as a later render within `inputWindow` of the paint (1.5 s unless you set it), and
  the sentence says how long after the paint it landed: "A second React render landed 567 ms after the screen
  updated". That gap is the server's time and whatever else ran meanwhile, which the report does not split.
  Past the window nothing holds that render, and no report says it was slow. CI runs both on the Next.js demo,
  a Server Action and a route handler at 400 ms and at 2 s, under `next dev` and both production bundlers.
