# Known limits

- **Frameworks that render their own HTML need a setup of their own**, and only the setups Install gives
  for [React Router](install.md#install-with-react-router), [Remix](install.md#install-with-remix),
  [TanStack Start](install.md#install-with-tanstack-start) and [Astro](install.md#install-with-astro) have
  been tried. The Vite plugin adds its install script only to the HTML pages Vite itself serves and builds,
  so without `entry` it installs nothing on another framework's pages. For those four, and for a build
  whose inputs are all scripts, the plugin warns when that happens and names the fix; any other framework
  gets no warning. On a Vite-based one, `entry` naming the first of the app's modules the browser runs may
  be enough. React Native is out of scope: only react-dom commits are walked.
- On Vite 6, a `buildApp`, your own or a framework's, that builds environments at the same time can leave a
  page with no install, since Vite 6 does not tell the plugin which environment a page is built in. Vite's own
  builder builds them one at a time.
- **React DevTools loaded after the library is locked out, and nothing can detect it**: it installs nothing
  over an existing hook. The extension loads first, so there the library chains; the lockout takes a page that
  installs React DevTools later, like react-devtools-inline's `initialize()`. `hook: 'chain'` never creates it.
- **An interaction after the page's first input that paints in under 16 ms gets no report**, however heavy the
  render after it: the browser sends no Event Timing entry for it. The first input still arrives as a
  `first-input` entry. See "Quiet interactions" in the [design notes](interaction-attribution-design.md).
- **A quick React Router link click whose new route renders in a later task gets no report**, however slow
  that render, where `announceNavigation` is called from a layout effect as
  [Install](install.md#install-with-react-router) shows: the announcement lets go of quiet interactions before
  React hands over the commit that holds the route. Keeping them past it would make the route Back or Forward
  goes back to a quiet click's later render.
- **Back or Forward within `inputWindow` of a reported click can add the route it opens to that click's
  report** (1.5 s from the paint unless you set it). The browser's own navigation is no input, so the route's
  commit is taken for the click's, and the report gains "A second React render landed 780 ms after the screen
  updated" while its `navigationURL` stays the page the person left.
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
  read against, or says the render ran after the handlers where it did. Under that the count is not a
  slow render, however large: the cause leads with the working time and says the count sat in it, or
  came after it, short of a long task, before what else the report knows. The exception is a commit held
  by the handler's own script where a long animation frame measured that script at 20 ms or more, not mostly
  forced layout: there the count names the render, and its sentence gives the script's measured time
  instead of the working time. A hydration the interaction waited for is still named by its count at any
  working time, as before.
  The exceptions are what the browser times itself and the build cannot change: waiting, the screen update,
  a Long Animation Frames script, and forced layout inside the handlers, which stay `'measured'` in a
  production build. So does a handler where React rendered nothing in the working time, on a page where it
  is read or no react-dom has loaded yet: the working time is then all outside React. The build is not the
  only thing that can lower a confidence, though: a script blame is `'inferred'` whenever a commit could
  not be tied to the interaction, since a script is what is left once React is ruled out and an unjoined
  commit is exactly what stops React from being ruled out.
  Where the count alone chose between the handler and the render beside it, the cause names both ("the
  onClick handler or React's render of StatsPanel") and says a profiling build can tell them apart, and
  the blame keeps the count's pick: in three production runs of apps written to test this, it picked wrong
  both ways. A list whose rows took 2 ms or less each decides it and names nothing else. Two ways to a
  profiling build: in Vite, a `resolve.alias` from `react-dom/client` to `react-dom/profiling`, and in
  Next.js, `next build --profile`. The Vite alias added 5.4 KB gzipped to one app. The runtime cost of
  either is not measured yet.
- **A commit past `walkBudget` (5000 components by default) is walked only in part**, and what took the time
  past the cut is not known. Its counts say "at least", and its blame's detail says the rest was not walked,
  unless the commit's useEffect callbacks lead it. Its sentence says so too in a production build and
  wherever the walk could not tell where the render started, and where a development build could tell, a note
  says only that the component count is partial. In a production build, which has only counts to go on, the
  blame names the component the render started at only where one rendered at the top and holds everything the
  walk reached, and that is where the render started, not what inside it took the time: a theme change over
  6,000 labels reads ThemeProvider, at least 1,999 components, where a walk of the whole tree finds NodeLabel
  ×6,000. Where the walk reached several such components, or one with work beside it that it never got to, it
  names the app and says it could not tell where the render started (`pathStart` is `'unknown-root'`). A
  development build has React's durations, which are totals for each subtree walked or not, so it still
  chooses among the subtrees the walk reached, but a subtree past the cut is in none of them, so it can name
  a component above the one past the cut that took the time. On a root React timed, React's total for the
  whole render is the render's time for any walk cut at the budget. Where it shows the part not reached took
  longer than the heaviest part reached, a development build names the app the same way. Where it does not,
  the time the sentence gives inside the component it names is still React's total for the whole render, so
  it can include a root beside it that the walk never reached. A root timed only under `<Profiler>` has no
  total of its own, and there the subtree the walk reached first can still be named. A larger budget walks
  further, inside the interaction it measures: a sort of 18,456 cells took 12.6 ms to walk in full, against
  1.7 ms capped. A branch more than 1,000 fibers deep is cut as well, and the walk sees nothing below it, so
  a component that rendered down there is missed, and `'only-root'` can be one start of two.
- **Forced layout is blamed only when a long animation frame measured it**, which is Chromium only. The
  browser counts style recalculation in the same figure, so a `'layout'` blame covers either. Its share of
  a script that ran on past the handlers is apportioned by time rather than measured, so such a blame is
  `'inferred'`. Where the browser reports no long animation frames the report says nothing about
  layout at all, rather than implying none happened. Where it does report them and none covered the
  interaction, the frame was under 50 ms, and a production build's report whose count would otherwise have
  named the render says how much of the working time went to any styles and layout the interaction forced
  is unmeasured, rather than blaming the render on its count: a style recalculation inside 17 ms of working
  time is invisible to the browser's own record. Nothing records *which* read forced the layout, so a
  `'layout'` blame's `name` and `detail` say where it happened instead: the subtree of the joined commit that
  ran in the script that forced it, and what it was mostly made of. Where several commits ran in the scripts
  that forced it, that is the one whose time could hold most of the layout: React's own time for it where the
  build times renders, else its effects and the time since the commit before it in the same script, which for
  the first commit there runs from the script's start and so holds the handler too. Where none could hold half
  of it, `name` and `detail` are `null` and the cause says so. A long effect that read no size can still take
  the name from the commit whose layout effect did. Where the render started from a component that holds the
  whole commit (the cause's "56 components from Dialog down"), that is the subtree named, since the
  component a render is named after holds only part of it and the read can be anywhere in what React
  rendered. Its `detail` is then what a render's would be, many of one
  component or one component's own render, and where it is a count, the whole commit's ("56 components"),
  not "15 of 56". That name is dropped for the browser's own invoker where no commit joined, or where the
  one that did only overlapped the interaction in time, was walked short of the end, or sat beside
  commits that could not be tied to the interaction. The invoker itself is named only while one script
  holds nine tenths of the layout, since `ms` is every script's total summed; where several scripts share
  it, `name` is `null` and the cause names the largest with the share it holds, unless that is React's own
  listener (its react-dom file or function, a root container the hook saw, or the document where a root is
  the document or the hook saw none it could name), which the cause does not name. So under the Next.js
  App Router, where the root is the document, a tag manager's or a heatmap's document listener reads the
  same as React's (`#document.onclick`), and a layout it forced is not named there either, though the
  frames in the report still hold it. The milliseconds are the browser's either way, so `confidence` is
  about them alone and is never lowered to cover a doubtful name.
- **A long animation frame that lists no scripts says nothing about what the time outside React went on.**
  Under `next dev --webpack` a modal whose layout effect forced layout came back as a 365 ms frame with no
  scripts in it, and the verdict read "On top of that, the onClick handler ran for about 151 ms" for a
  handler that is one setState. The same click under Turbopack measured the layout. Why webpack's dev frames
  list no scripts is not verified (its eval'd modules are the guess). Where every frame over the handlers lists
  none and one of them is 50 ms or longer, the time outside a render that has the verdict is said to be not
  accounted for. Where that time outruns React's render, the handler still has the verdict, measured, though
  it may have been a layout. A development build warns once, at the second such interaction whose handlers
  ran for 50 ms or more ([`frames-without-scripts`](troubleshooting.md#frames-without-scripts)).
- **A `painting` blame after a menu or a dialog closes cannot name a restyle of the whole page that a write
  to `body` or `html` set off.** Closing one often writes a style or a class there (a scroll lock, the
  `pointer-events` a modal put on the page, a theme class), and the browser can then recalculate styles for
  every element under it. That is a common cause of a slow screen update after a close, and the report cannot
  see it: it keeps no record of writes to `body` or `html`, and the restyle runs as the browser's own work,
  with no script for Long Animation Frames to list. So the cause puts that time on the browser "most likely
  recalculating styles and layout", `blame.name` stays null, and a note about a render in the handlers can
  sit beside it though that render may not be what made the frame slow.
- **The next press's work is told from the interaction's own by a listener of that press the browser
  recorded.** Typing or clicking fast, the frame an interaction paints in can hold the next press's handlers
  too, and Long Animation Frames lists only scripts over 5 ms, which in a React app often leaves out the next
  press's `onkeydown` or `onpointerdown`. Where none of its listeners was recorded, under a screen update of
  100 ms or less every script is ranked as the interaction's own, so the next press's handler can be named as
  its script, and over that, one of its own that started a millisecond or more after its handlers ended is
  taken for the next press's work. A next click whose button went down before the interaction, or whose
  pointerdown was not recorded, has no listener to go by, since nothing tells its `onclick` or `onpointerup`
  from the interaction's own, so it is weighed as in 0.18.0: every script from that click on is its work,
  except one that holds a render of the interaction's own.
  Rollover typing, where the next key goes down before this one comes up, can still put the next key's work on
  this one.
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
  name on it, so it reaches the component below those layers where there is one. A component that is all its
  parent rendered and hands the very children it was given to the one component it renders, as Radix's Dialog
  root does, is passed too where that one carries most of its work, and where nothing below it is named the
  render is named after the nearest component above it a reader could search for, through any layers between.
  That is read from props, the tree's shape and React's times, not from who wrote what. Where React timed the
  render, a component of that shape whose own render is the heavy part is named. A production build has only
  counts, and there it is still passed over for the one above it, a highlighter handing the code string it was
  given to one inner component as much as a dialog root. A wrapper that wraps its children in an element of its
  own before handing them on isn't caught and is named as 0.23.0 named it, and so is one where the path starts
  at a layer with nothing above it to name. Where such a wrapper (a Card, an AppLayout putting its children in
  `<main>`) sits between the component that owns the state and a dialog root, the dialog root is passed and the
  render is named after the Card or the layout, not the owner above it. Where React's times on the
  path show that name took under half of the render (every name above it holds it, so the smallest of their
  totals bounds it), the render is named after the component it started from where that holds the whole commit
  and has a name worth searching for (the cause's "from ... down"), and the cause still says the deeper one.
  Otherwise, and in a build with no durations, it takes the deepest name. A component the walk found no name
  for is never the name: a render or layout whose path ends there with nothing above it to take is named
  `'the app'`, and nothing is said to be mostly made of it. A name with the `$1` that Vite's development
  server and Rolldown add to one that clashes (`Dt$1`) is judged without it. The component emotion renders beside every element @emotion/styled or the
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
  input arrived is left out of the report, as is one stamped with a keyup or a pointerup where another press
  came between that release and its own press, or one after an `input`, `change` or `submit` a script
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
