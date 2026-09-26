# Changelog

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions are
[semantic](https://semver.org/spec/v2.0.0.html). `schemaVersion` on a report is versioned separately:
it changes when a field is removed or changes meaning, which a minor release may do while it is 0.x.

## [Unreleased]

### Added

- **A screen update no script held is put on the browser.** Where the screen took longer to update than the
  handlers took and no script ran for most of it, the sentence stopped at the figure. Now, where long
  animation frames saw at least half of it, it goes on to say what took it: the frame's own style and layout
  and paint where the frame timed them (its `styleAndLayoutStart`, now on `FrameSummary`), else "No script ran for
  long in that time: 212 ms of it was the browser's own work on the main thread, most likely recalculating
  styles and layout for what changed." The Vite demo has an eighth slow scenario for it, the restyle storm: one class
  on 30,000 cells.

### Fixed

- **Time between an interaction's events is said to be that, not handler time.** Enter on the restyle storm
  ran the keydown's and the click's handlers in 1 ms, then 157 ms went by, the browser restyling the page,
  before the keyup's handler ran. That time sits inside the working time, which runs from the first handler to
  the last as web-vitals counts it, and the verdict read "The onClick handler ran for about 158 ms". It now
  reads "The handlers took 1 ms in all, but 157 ms went by between the click's handlers and the keyup's", with
  what filled it, and the blame is a `waiting` whose `detail` says where: "between click and keyup". Where the
  wait before the handlers or the screen update is larger, that time is a note instead. A handler is never
  said to have run through it. A script that ran in it is part of that wait, named the way a script the input
  waited behind is, and never as the handler. A report built before its long animation frame arrives gives the
  wait too, and says no frame that says what else ran has been recorded yet.
- **A render a script forced after the handlers is said to be what that script did.** On TanStack Table's
  virtualized rows at 4x, a checkbox's screen update waited 174 ms on react-virtual's scroll listener, which
  re-rendered the rows through `flushSync`. The sentence named the listener and not the render, and counted
  that render in the working time before it. It now reads "... ran for 174 ms before the next frame, and React
  rendered inside it: 150 ms re-rendering 721 components inside TableBody", the handlers' own render or code
  is still said beside it, and the render no longer counts toward "React rendered N times", which points at an
  effect. A render in React's own scheduler task, where an effect's update runs, still counts. It is only tied
  to the script where it committed inside it, and began inside it where the build says when a render began.

## [0.14.0] - 2026-09-26

### Added

- **The Next.js demo waits on the server.** A Server Action and a route handler, each at 400 ms and at 2 s, then
  300 slow rows. CI checks that the 400 ms clicks carry the rows as a later render named after their own
  components, and that past `inputWindow` no report holds them, as the README's Known limits say.

### Fixed

- **Under `next dev`, the render a Server Action's result sets off is named after the app's components.** It
  renders from the App Router's `Router` down, through a dozen of Next.js's own components for every layout and
  page segment (`OuterLayoutRouter`, `ErrorBoundary`, `LoadingBoundary`, the redirect and not-found boundaries,
  `InnerLayoutRouter`, `ClientPageRoot` and more). They are readable in development, so the hot path spent its
  twelve steps on them two segments above the page, and on the Next.js demo the later render read "304 ms
  mounting 315 components from Router down, 302 of them inside ErrorBoundary". Where the library is installed
  through `react-inp-blame/next`, those names are now passed like a library's layers, as the minified ones of a
  production build already were, and the same render reads "301 of them inside Rows". A component of the app's
  own with one of those names is still named on the path, but spends no step and is not what a render is named
  after. Vite and other setups are unchanged.
- **Under `next dev`, a click on a link is said to be in the component that wrote `<Link>`.** It was said to
  be in `LinkComponent`, next/link's own component that renders the `<a>`: on the Next.js demo, "click on link
  "Second page" in LinkComponent", now "in Page". Through `react-inp-blame/next` that name gives way to the
  component above it where that is not one of Next.js's own. A link a server component wrote directly, not
  inside a client component, has only those above it and is still said to be in `LinkComponent`.
  `target.owners` still has it.

## [0.13.0] - 2026-09-26

### Added

- **A minifier's name in a build that keeps readable names gets a note.** On Twenty the verdict read "React
  was most likely re-rendering at least 4917 components inside hl.", where `hl` is React Router's
  `RouterProvider`: a dependency's component with no `displayName`, which the Vite plugin, the Next.js wrapper
  and the loader never stamp. Where a component the report names, as the blame or as the one React rendered
  inside, in the cause or in a note, is one or two characters, and the report holds at least five other names
  and most of them are readable, a note now says it looks like a name a minifier left, most likely on a
  dependency's component, and that selecting it in React DevTools shows its props and what rendered it, which
  usually says whose it is. With fewer names, or mostly unreadable ones, there is no note, since there the
  short name could be the app's own. The name is left as it stands. The blame is unchanged.
- **A commit counts what it mounted, and what sits under the two components a render sentence names.**
  `CommitSummary.mounted` counts the components React rendered for the first time in the commit, told by a
  fiber with no alternate. `CommitSummary.startRendered` counts those under the first name on `hotPath`: the
  commit's count where one root rendered or where several share that component, less where other roots
  rendered beside it. `CommitSummary.pathRendered` counts those inside the deepest name on `hotPath` that is
  not a library's layer, that component included, else the one the path ends on. The sentences under Changed
  below are built on them. All three are additive, so `schemaVersion` stays at 3; a report stored by an
  earlier release has none of them and reads as it did.
- **A commit says whether its input's Event Timing entry holds it.** `CommitSummary.inDispatch` is true
  where React made the commit while the input it is stamped with was being dispatched, in that input's own
  task, and false outside any dispatch and in an `input` or `change` from a later task. Whether a quick
  interaction is published, and what the note on a later render says, read it (under Changed). It is
  additive, so `schemaVersion` stays at 3.
- **A report says which press came before its paint.** `InteractionReport.nextInput` is the first press of
  another interaction, a keydown, pointerdown or click and never a release, that came after this one's input
  and before its paint, as `{ type, pointerType, start, endedAt }`, from the ring of recent inputs. `endedAt`
  is when React finished what it rendered in that press's own dispatch, null where it rendered nothing
  there. A press in that time does not by itself mean the frame waited on it; typing fast, the next key's
  keydown and its render do come before the frame the last keyup paints in, and then that wait is in
  `presentation`. Null when no press came in that time, or the ring has let it go. The explanation reads it
  (under Changed). It is additive, so `schemaVersion` stays at 3.

### Changed

- **A render known only by its counts is not blamed under a long task of working time, and where no long
  animation frame covered the interaction the report says how much of that time went to styles and layout
  is unmeasured.** A production build records no render durations, so a render there was blamed on its
  count alone, whatever working time it sat in. Finishing a rectangle in excalidraw re-rendered 149
  components inside FixedSideContainer in 2.8 ms of working time, with 34 of the click's 40 ms on the screen
  update, and read "React was most likely re-rendering 149 components inside FixedSideContainer": the screen
  update is only weighed from 50 ms, so nothing outranked the count. Closing a shadcn/ui Sheet re-rendered
  56 components in 17 ms of a 48 ms click and read the same way, when most of those 17 ms is one style
  recalculation Radix's Presence forces, which no frame under 50 ms reports. A render known by its count is
  now held to the 50 ms of working time the handler is held to without durations, the bar the `LONG_TASK_MS`
  comment describes, taken on the figure the sentence prints. From it the verdict reads as it did. Under it
  the count is not a slow render, however large, and the cause leads with the working time and says the
  count sat in it, short of a long task, rather than calling the render small. Opening the same Sheet on a
  phone now reads "In 31 ms of working time, short of a long task, React was mounting 59 components, 31 of
  them inside DismissableLayer; the rest went to waiting and painting. No long animation frame covered the
  click, so how much of the working time went to any styles and layout it forced is unmeasured." (the 59 was
  measured; the 31 and the name come from a read of Radix's source, as the entry below says). The last
  sentence is there where the browser supports Long Animation Frames and none covered the interaction: its
  frame was under 50 ms, and what the browser spent in it recalculating styles and layout, if anything, was
  never measured. Where a frame covered the interaction the cause opens the same way, naming a script the
  frame listed outside the handlers where one ran for 20 ms or more, and where the browser reports no frames
  it ends by saying so. Where the count still names
  the render, its sentence gives the working time the count is read against, after a comma so a count's own
  clause ("31 of them inside DismissableLayer") does not read as what took it: releasing Control after
  select-all in excalidraw now ends ", in the 55 ms of working time.", and 55 ms hung on the chrome's 161
  components is a claim a reader can weigh, since the same render took 7 ms on another key press in the same
  session. The note a screen update leaves about the render it outran follows the same bar, so 40 ms of
  working time before a 200 ms screen update no longer says React was "still re-rendering" in it. The
  panel's line for a report that blames nothing is "nothing stood out"; the cause under it says where the
  time went. `blame.kind` changes only for a production build's render under 50 ms of working time whose
  effects did not earn React the blame. Where the wait before the handler was over 50 ms it is `'waiting'`.
  Otherwise it is `'script'` where a frame over the interaction recorded a script of 20 ms or more that ran
  outside the handlers, named by the browser's invoker with `detail` null, and `'none'` with `name` and
  `detail` null everywhere else: where the frame's script ran as the handler, since that script holds React's
  render as well and is not measured in its place, where no script was that long, where no frame covered the
  interaction, and where the browser reports no frames. A screen update over 50 ms after under 50 ms of
  working time was `'painting'` before and stays so; only its note changes. Builds with durations are
  unchanged. The report's `schemaVersion` stays 3.
- **The count a render is said to be "inside" a component is that component's own, and the render is named
  from where it started where that holds them all.** On cal.com, switching an event type to its advanced tab
  read "React spent 180 ms re-rendering 1216 components inside Form", where 1216 was the whole commit's
  count, about a third of it above Form and beside it, and nothing named EventTypeWeb, the root the render
  started from and the component that holds the form's state. Where the walk counted fewer components inside
  the component a render is named after than in the commit, the sentence now gives both, with the component
  the render started from where it holds every one counted and a reader could search for it: "re-rendering
  1216 components from EventTypeWeb down, 812 of them inside EventAdvancedWebWrapper" (the 1216 was measured;
  the 812 and the name come from a read of cal.com's source, and a run may move them). Where other roots
  rendered beside the one the path starts from, as the two code blocks of the shadcn/ui install tabs do, no
  start is said: "re-rendering 181 components, 79 of them inside RovingFocusGroup". A render named after
  the component it started from holds the whole count and reads as it did. So does one named after the
  component it was mostly made of, whose count is in that clause already, and a hydration blame, named after
  the boundary or the page that holds every component hydrated. A walk cut short says both counts as lower
  bounds: "at least 5000 components from App down, at least 800 of them inside Heavy". The clause for what
  a render was mostly made of says which count it is of once two have been said, "mostly Controller (700 of
  the 1216, 100 ms)", and the one for a component's own render follows the count as before. The wording is
  the same wherever the render is said: in the cause of a render blame and of a handler blame, in the React
  clause of a layout blame, in the note on a later render and in the panel's rows. `blame.detail` is "812 of
  1216 components" on such a render, where it was "1216 components", "at least 800 of at least 5000
  components" on a walk cut short, and a layout blame named after its commit carries the same value; a
  hydration blame keeps the whole count. `blame.kind` does not change, and `blame.detail` keeps its meaning,
  so `schemaVersion` stays at 3.
- **The hot path spends its steps on names a reader could search for and passes a library's layers.** The
  path spends at most twelve steps below the component it starts from, and until now every name on it spent
  one. On the shadcn/ui docs, switching the install tabs to npm was named after
  RovingFocusGroupCollectionProviderProvider, since Radix's layers between one part and the next
  (`TabsProvider`, `Primitive.div`, `CollectionProvider`, `ProviderProvider`, `CollectionSlot`, `.Slot`,
  `.SlotClone`) and shadcn's parts named like the Radix parts they render (`Tabs` over `Tabs`, `TabsList` over
  `TabsList`) spent all twelve; on cal.com a provider and a minified name spent the two that would have
  reached the tab below the form. A name a reader could not search for (a Slot, `Primitive.div`, a styling
  wrapper, a minifier's) or a Provider or a Context now spends no step, and neither does a wrapper named after
  the component it renders, so the path runs deeper and the render is named after the deepest name on it that
  is none of those: RovingFocusGroup on those tabs, Radix's own but a name to search for, and
  EventAdvancedWebWrapper on cal.com. `hotPath` holds every name on the chain as it did, the layers included,
  so it gets longer where they used to spend the steps, and so do the "Heaviest path" on the Performance
  panel's track and `react.hotPath` from `attributeINP`. A chain of nothing but a minifier's names is still
  named after its end. `blame.name` changes on such a render, to a component further in. A walk cut short
  under several roots names the component they share the same way, passing a styling wrapper or a provider
  for the component above it. `hotPath` keeps its meaning, so `schemaVersion` stays at 3.
- **A render that mounted most of what it rendered reads as "mounting".** Radix's Portal renders null and
  sets mounted in a layout effect, so a dialog's content mounts in a commit of its own, under a Portal for
  each of the dialog's children, and opening a Sheet on the shadcn/ui docs read "React was re-rendering 59
  components inside DismissableLayer" of a commit that rendered about 57 of the 59 for the first time. Where
  more than half of a commit's components rendered for the first time, the sentence now reads "mounting 59
  components, 31 of them inside DismissableLayer" (the 59 was measured, the 31 and the 57 are from a read of
  Radix's source; with the overlay under a Portal of its own the path's Portal does not hold the 59, so no
  start is said), a handler blame's clause says React mounted them, and the panel's rows say "mounted". A
  hydration reads as hydrating, as before. Which blame the interaction gets does not change, so
  `schemaVersion` stays at 3.
- **A component Linaria's `styled` made is named the way a styled-components one is.** Twenty styles with
  Linaria, whose Babel plugin names each styled element after its variable, and some 270 of them are
  `StyledContainer`: selecting every row read "at least 4632 components inside StyledContainer", the wrapper
  div in RecordIndexContainer, which sends a reader to any of 270 files. Told by the mark Linaria leaves on
  the component (`__wyw_meta`, `__linaria` on older releases) rather than by its name, it now reads
  `styled.div` or `Styled(Card)`, so it is passed for the component above it wherever a styled-components
  wrapper is, and that render is named after RecordIndexContainer. The name changes wherever the walk names
  the component, `target.owners` and `generateTarget`'s path included. `schemaVersion` stays at 3.
- **A render that was mostly one component's own render says so.** Sorting TanStack Table's virtualized rows
  example (200,000 rows) by a click on a header read "React spent 277 ms re-rendering 637 components inside
  TableBody", which sends a reader off to memoise the rows. 257 ms of it was TableBody's own render: the sort
  runs inside `table.getRowModel()`, which TableBody calls while it renders, and the components under it took
  about 17 ms. Where React timed each component, and one of them rendered once and spent 25 ms or more, and
  half of the commit's render time or more, in its own render, the sentence now reads "React spent 277 ms
  re-rendering 637 components inside TableBody (257 ms of it in TableBody's own render)", and `blame.detail`
  is "TableBody's own render" where it was "637 components". A hydration blame, and a layout blame named after
  its commit, take their `detail` from the same rule, so they can carry that value too. A render blame of that
  kind also gets a note: that time is usually work the component does as it renders, like a sort or a filter,
  which memoising the components under it does not speed up. A render whose time is spread over its
  components gets no own-render clause, and neither does a production build or a clock too coarse for single
  components, where no component has a time of its own. `blame.detail` changes value for those renders and
  keeps its meaning, so `schemaVersion` stays at 3.
- **A render is "mostly" one component only where that component is most of it.** 0.12.0 named the component
  that rendered most whenever it rendered more than once, however small its share, and on real apps that read
  "re-rendering 59 components inside DismissableLayer, mostly Label (4 of them)" (the shadcn/ui docs) and
  "1298 components inside SidePanelSubPageRouter, mostly (anonymous) (124 of them)" (Twenty). The clause is
  now said only where that component is half of the components rendered or more, not counting the wrappers a
  styling library puts around each element, or half of the render's time where React timed it. "460
  components inside CommandList, mostly (anonymous) (422 of them)" reads as before, and so does "721
  components inside TableBody, mostly TableBodyRow (36 of them, 13 ms)", 13 ms of a 24 ms render. Where it is
  not, the sentence stops at the component the render is named after, and `blame.detail` is the component count
  ("59 components") where it was "Label ×4", as its description always said. The panel's line for a later
  render follows the same rule. Which kind of blame an interaction gets does not change. `blame.detail` keeps
  its meaning, so `schemaVersion` stays at 3.
- **Forced layout reads as "recalculating styles and layout".** The figure is Long Animation Frames'
  `forcedStyleAndLayoutDuration`, which holds style recalculation and layout together, and a Chrome trace of a
  shadcn/ui Sheet opening had about 80 ms of style recalculation in it against 1 ms of layout. The cause of a
  layout blame, the note beside another blame, the note on a later render and the panel's row now say styles
  and layout. `blame.kind` is still `'layout'` and no field changes name, so `schemaVersion` stays at 3.
- **A render after an `input`, `change` or `submit` a script dispatched past the paint no longer joins the
  interaction before it.** Picking a page size with Playwright's `selectOption` after sorting a TanStack
  Table example by Full Name put the page-size render on the sort click, which read "A second React render
  landed 1017 ms after the screen updated: 91 ms re-rendering 417 components inside App. INP doesn't count
  it, but people still wait for it." `selectOption` fires `input` and `change` from script and presses
  nothing, so the ring had nothing newer than the click. A capture listener on the window now notes those
  events when a script dispatches one outside any input's task, and a render after one that came after an
  interaction's paint joins nothing, as after a newer input. Such an event is never an interaction of its
  own. One the browser fires still carries on the input before it, as an option picked from a native
  select or dictated text did, and so does one a script fires in that event's task, as a select's onChange
  firing `input` on another field does. The sort click now has no later render and no note. `followUps`
  loses the render and no blame changes, since a blame never rests on a later render. A page whose own code
  dispatches one of those events after the paint loses the renders after it too (README, Known limits).
- **Past 50 published reports, the ten slowest and every report INP can still point at are kept.**
  `reports()` let the oldest go first, whatever it was, and drawing sixty rectangles in excalidraw pushed
  out the 64 ms key press that was the page's INP: `inp().report` came back null, and `attributeINP` gave
  `react: null` for the one interaction INP named. The oldest still goes first unless it is one of the ten
  slowest, as many as web-vitals keeps candidates for INP, or one INP can still point at: the estimate's,
  and those of the candidates it moves down to every 50 interactions. `reports()` still returns 50 at
  most, oldest first, and no report changes.
- **A quick press is not published for the render its own release made, and the note on that render no
  longer says INP leaves it out.** A 32 ms pointerdown on excalidraw's canvas was published only because
  the pointerup that ended the stroke rendered in its own dispatch, 37 ms after the press painted, and the
  note read "A second React render landed 37 ms after the screen updated: ... INP doesn't count it, but
  people still wait for it." That render ran inside the pointerup's own Event Timing entry, part of the
  same interaction, so INP does count it: a slower release would have raised the interaction's latency. A
  render made in the dispatch of the input it is stamped with (`CommitSummary.inDispatch`, under Added),
  or landing inside one of the interaction's entries before its paint, no longer makes an interaction
  under `threshold` worth publishing. That takes in a render that began after the entry's input and
  committed before its handlers ran, in the wait INP counts. A later one outside them still does, and the
  report then holds both. A render stamped with a release whose entry has not come, less than `threshold`
  after it, waits for that entry before it publishes the press, since the entry may hold it. A newer
  interaction's entry ends the wait, and so does the page being hidden, as a release under 16 ms sends
  none. Where a report with such a render is published on its own duration, the note is about a render
  INP left out if it has one, and otherwise reads "A second React render landed 37 ms after the screen
  updated, on the release:" and what the render did, with nothing about INP. The panel's line for a later
  render and its "Rendered after the paint" list now name that same render, where they took the heaviest
  of all. `followUps` keeps the render and no blame changes.
- **A long animation frame is folded into every published report it overlaps, not only the newest.** On
  an undo in excalidraw, Control pressed 8 ms before z, z's handler ran for about 59 ms in the frame both
  key presses painted in, and only z's report, the newer one, took the frame when it arrived. Control's
  report read "After the key press was handled, the screen took another 64 ms to update." with
  `blame.name` null. Every report the frame overlaps, in its window or its later renders, now takes it as
  a new revision. A painting blame like Control's stays painting and gains ", mostly because a script
  (...) ran for N ms before the next frame." where a script ran 20 ms or more of the screen update, and
  `blame.name` becomes that script's name where it was null. Any other blame is worked out again with the
  frame, as the newest report's always was, so it can change kind: a 'none' becomes 'script' where a
  script ran 20 ms or more in the interaction's window, or 'layout' where the frame shows the handlers
  forcing enough styles and layout. A 'waiting' blame can gain the name of the script it waited behind,
  and a 'none' loses "No long animation frame covered the ..." once a frame does.
- **A key pressed before React has rendered what a report listener set keeps its own render.** Typing
  "ada@example.com" and "Hunter2!" into the demo as fast as Playwright can, 9 of the 23 keystrokes in a
  development build and 10 in a production build had no commit, and their reports put the time on the
  field's handler as a script, `onEmailChange` or `onChange`, where the email's render of 1000 tiles took
  it. The demo's panel sets state when it hears a report, and the next key often came before React's own
  task for that update. React 19 renders sync, continuous and default updates in one pass, so the key's
  render took the panel's update along and finished its lane, and the hook read the whole commit as the
  listener's work and dropped it. A commit inside an input's dispatch is now the input's even where it
  finishes a lane the listeners left pending; outside any dispatch such a commit is still theirs and not
  read. Every keystroke now has its commit and its report blames the render or the handler. The kept
  commit counts the listener's components beside the input's, and where the input's own render is small
  they can be the render the blame names. It is not marked as the listener's either, so an update the
  listener's components make in `useEffect` reads as the input's later render (README, Known limits).
- **A commit joins an entry of its own input's type, and a release's press is matched against presses only.**
  Typing at full speed, the next key can go down under a millisecond after the last one came up, before the
  frame that keyup paints in, so the keyup's entry runs to the paint after the next key's render. A commit's
  stamp matched any entry within 1 ms, and that render was exact in both reports. Now a commit matches where
  the input it is stamped with is an entry of the same type at its time, a keypress standing for its keydown
  and a mousedown or mouseup for its pointer event, or where the press it carries (`gestureTs`) is a
  pointerdown or keydown entry at its time. Either one is enough. An entry of a type the ring never records
  still matches by time alone. The same test decides which inputs in the ring are the interaction's own, and a
  click whose entry was too quick to arrive is still its pointerup's. The keyup's report no longer holds the
  render. Where its frame waited on the next press (`nextInput`, under Added) and nothing of its own explains
  the time, it reads "After the key press was handled, the screen took another 111 ms to update: the frame
  waited on the next key press, which the page handled first.", with the longest script the browser recorded
  in that time after it. That is said only where the page worked on the press before the paint for half the
  screen update or more: a script a long animation frame recorded from the press on, or React's render in the
  press's own dispatch ending by the paint, and on that render alone it says "the frame most likely waited". A
  press with no such work, like the second click of a double click, and a modifier let go before the paint
  leave the screen update's sentence as it was. The blame is 'painting' and `measured`, the screen update's
  own time, named by that script as a painting blame is, where it could be the next key's render or, with that
  render gone, a script or nothing. With the frame waiting on the next press it is blamed under 50 ms of
  screen update too, where the screen update is the larger part of the interaction.

## [0.12.0] - 2026-09-25

0.4.0 to 0.11.0 were version numbers on `main` that never went to npm. 0.12.0 is the first release after 0.3.0,
and has everything in their entries below as well as its own. Coming from 0.3.0, read the `schemaVersion` entry
under Changed first.

### Security

- **The badge and panel need no Trusted Types policy, and leave none for other scripts to use.** Since 0.9.0
  their markup went through a policy named `react-inp-blame` that passed strings on as they were, and the policy
  was kept in the library's page-wide state, where any script on the page could reach it
  (`globalThis[Symbol.for('react-inp-blame')]`). On a page that listed the name in its `trusted-types`
  directive, as the README said to, that gave every script a way to put any markup into any sink, which is what
  Trusted Types are there to stop. The badge and panel are now built from elements and text nodes, so they need
  no policy and create none, and draw under any `trusted-types` directive, `'none'` included. They look as they
  did. A page that listed `react-inp-blame` can drop it. The CSP spec now runs under `trusted-types 'none'` and
  checks that nothing reachable from the shared state is a policy.

### Changed

- **`schemaVersion` is 3, on the report and on the `react` field `attributeINP` adds.** Two fields kept their
  names and changed what they hold while the version stayed at 2, which the rule at the top of this file says
  it must not. Since 0.6.0, `target.component` and `target.owners` for a click on an icon inside a control name
  the control's component, as `target.label` has since 0.3.0, where they named the icon's own. Since 0.7.0,
  `hotPath` for a production walk cut at `walkBudget` is the chain into the one subtree the walk reached where
  nothing unreached rendered beside it, otherwise the one component all its subtrees sit under, whether or not
  it rendered itself, or empty where they sit under none; it used to be the chain into whichever subtree the
  walk reached first. `react.hotPath` follows it. Code that reads either field should take 3 to mean them this
  way, and know that reports from 0.6.0 to 0.11.0 carried the same meanings under 2. Three fields were added in
  that time, which leaves the version alone: `pointerType` (0.6.0) and `reactStatus` (0.8.0) on the report, and
  `react` on `stats()` (0.8.0). They are required in the types because the library always fills them; a report
  object your own code builds, in a test fixture or a fake, needs them. Code that only passes the report along
  needs no change.
- **A production build no longer blames a render for the slow handler beside it unless its count explains
  the time.** Without durations, a render of 50 components or more beside a named handler took the blame on
  its count alone, so a Radix menu item whose `onSelect` ran for 200 ms read as "re-rendering 85 components
  inside MenuPortalProvider": closing the menu re-renders its own tree of components once each, which is
  no 200 ms of work. Beside a handler, a render is now the blame only where the count is the kind that costs
  time: at least 50 of one component (a list, 150 `SlowRow` in 160 ms), or a working time of at most 2 ms
  for each component rendered (`RENDER_MAX_MS_PER_COMPONENT_BESIDE_HANDLER`). Past that the handler keeps
  the blame, as inferred, and the sentence says why the render was passed over. Builds with durations, and
  the coarse clock of Firefox and WebKit, went by time already and are unchanged. The component-libraries
  fixture clicks a menu item with a slow `onSelect` in both builds. What this gives up: a click whose handler
  only sets state, and whose render of many different components is slow (60 chart widgets at 5 ms each),
  now reads in a production build as the handler, most likely, where it read as the render. A development or
  profiling build, which has the durations, still names the render.
- **A Radix `Slot` is passed over for the component that rendered it.** Radix renders a slot inside most of
  its parts, named after the part (`RovingFocusGroupCollectionItemSlot.Slot`, `Primitive.button.SlotClone`),
  and it renders nothing of its own: it merges its props into the child it is given. A click on a
  `DropdownMenu.Item` was named "in RovingFocusGroupCollectionItemSlot.Slot", and a render or a layout inside
  one took the same name. Those names, the bare `Slot` or `SlotClone` of an `asChild` the app rendered
  itself, and the collection slots Radix's parts register their items through (`MenuCollectionItemSlot`),
  which render only such a Slot, are now skipped the way an icon or a styling wrapper is, and the component
  before them is named. The library part that composed a handler is still the one named where the app's own
  component sits further up than the owners a report keeps.
- **Where React is not being read, the verdict says so instead of guessing.** With `install()` run after
  react-dom loaded, or with no react-dom to read, a report has no commits, and the ladder read the working
  time as it would for an app that rendered nothing: a 200 ms click became its handler, or "waiting and
  painting", said with confidence, with the real cause left to a note. The blame is now `none` and
  `inferred`, and the cause says what React did was not seen and why, naming the script the browser
  recorded across the time where there is one. A wait, a paint or a forced layout the browser measured
  still outranks it, as before. The panel's blame line says nothing is blamed.

### Fixed

- **A page without React is no longer scanned at every interaction.** While no react-dom has registered with
  the hook, a report looks at the page for React's marks, up to 10,000 elements, to tell a late install from a
  page that has not loaded React yet, and since 0.8.0 every report after input looked again, for as long as the
  page was open. An Astro page whose islands are all Svelte or Vue, where the integration installs on every
  page, paid for that at every click. Reports and `stats()` now look at most five times in all, besides the
  check 3 s after install and the one at the first interaction after it; a page with no React by then is taken
  to have none, and `stats().react` stays `'waiting'` until a react-dom registers. A report still looks again
  after input while looks remain, so a look from just before React rendered does not leave it saying waiting.
- **A Pages Router page on `next dev` is read from Next.js 15.3 on.** Next.js's dev entry for the Pages Router,
  `next-dev.js` under webpack and `next-dev-turbopack.js` under Turbopack, loads react-dom before
  `instrumentation-client` and before the module `instrumentationClientInject` adds, so on 15.3 to 16.3 the
  install came too late even with the README's setup, every report said `installed-late` and none had a
  component. Production builds load them the other way round and were fine. On `next dev` the wrapper now also
  puts the install first in that entry: in webpack's `main`, as it already did below 15.3, and under Turbopack
  through a rule whose loader adds it at the top of `next-dev-turbopack.js`. `apps/next-demo` has a Pages Router
  page, checked in every Next.js suite CI runs, from 15.3.9 to 16.3.5 under both bundlers, and
  `fixtures/next-14` has one beside its App Router page. The Troubleshooting entry for this warning now lists the
  setups that still load react-dom first. The line added to `next-dev-turbopack.js` requires the install by its
  path from that file, not by the package name, which a strict `node_modules` (pnpm with hoisting off) would not
  let Next.js's own file resolve.
- **The README says `target.owners` holds the eight innermost components**, which it always has, and that
  `component` is picked from those eight. It said the whole chain.
- **The Next.js quick start has a `next.config.mjs` for 14.2**, which reads no `next.config.ts`. It told 14.2
  users to use that file and showed only the TypeScript one, which is a syntax error there.
- **Escape, Tab and the other keys that type nothing read as a key press in the panel.** A row for any key
  event was titled "Typing in", so Escape on a close button read `Typing in "Close"`. A key is now typing only
  when it typed a character, which the browser marks with a keypress, into something that is not a button or
  a link, and only those rows collapse into one per field. Any other key reads `Key press on "Close"`. Enter
  in a text field still reads as typing, since a report does not keep which key it was.
- **The README no longer says naming a handler gets it named in production.** A production build's minifier
  renames `handleLogin` like any other function, so there a handler reads as its prop unless the build keeps
  function names. The README says so, and that the names loader stamps components, not handlers.
- **The README says which component libraries CI builds**: styled-components, @emotion/styled, lucide-react
  and Radix's DropdownMenu used directly, the primitives shadcn/ui's Radix styles wrap. No job builds Base UI,
  which shadcn/ui now starts a project on, or a shadcn project of either style.
- **A component named like the import it renames is named.** shadcn writes every component this way,
  `import { Button as ButtonPrimitive } from '@base-ui/react/button'` and then `function Button`, and the
  displayName pass took both sides of the `as` for names the module imports, so it left `Button` unnamed and a
  production report put its clicks on the component above it. Only the local name, the one after `as`, now
  counts as imported. An import whose names are strings, `{ 'row-card' as Card }`, and one written with no
  spaces, `import{Card}from'./card'`, are read too.
- **A render blame always has a name again.** Since 0.7.0, `blame.name` was null for a render whose cut
  walk found no component holding all of its subtrees, and for a commit that rendered none, though the
  sentence said "the app" for both. It reads `the app` there again, as it did through 0.6.0, so a reader
  written against those versions that reads into a render's name does not throw.

## [0.11.0] - 2026-09-25

### Added

- **A production build says when it left the library out.** With `enabled` left at its default,
  `'development'`, `vite build`, `next build` and `astro build` printed nothing, and `vite preview`, `next start`
  and `astro preview` showed no badge, which looked like the library failing. Each now prints one line saying
  it left the library out and how to include it, with a link to a new Troubleshooting entry. It is said once
  per build, not for a server build, not on the dev server, and not when the app wrote `enabled` itself.

### Changed

- **The React Router, Remix, TanStack Start and Astro setups show the badge on the dev server.** Their
  snippets set `enabled: true` with `overlay: 'query'`, so the dev server showed nothing until the URL had
  `?inp-blame`, and the README did not say so. They now use `overlay: true` and the default `enabled`, as the
  Next.js and Vite ones do, and say how to keep the library in production with the badge on request.
- **The Next.js snippet has the shape `create-next-app` writes**: a typed `nextConfig`, passed to
  `withInpBlame`.
- **The README says what you see first.** The badge reads `INP —` from the start, a click of 40 ms or more gets
  a row, a 150 ms one still reads Good, `vite preview` and `next start` show no badge by default, and
  `__REACT_INP_BLAME__.last()` gives the whole report.

### Fixed

- **A label is what the element said when it was clicked.** It was read when the Event Timing entry arrived,
  after the paint, so a click on a button reading "Count is 0" was labelled "Count is 1". The capture listener
  now reads it as the input is dispatched. Where the entry's target is another node, it is read as before.
- **The panel's row reads naturally without a time.** Under a production build of React a handler's blame has no
  figure, and the row read "most likely onClick in Layout in the handler". It now reads "most likely the
  onClick handler in Layout".
- **A React Router route's component keeps its name in production.** React Router's Vite plugin rewrites
  `export default function Home()` in a route module to `export default withComponentProps(function Home()
  {…})`, so no `Home` binding was left for the displayName pass to name, and the minifier dropped the name of
  the function inside the wrapper. A click in the route's own markup was put down to the nearest named
  component above it, `Layout` in the template, and the component itself showed as `(anonymous)` among the
  renders. The Vite plugin now turns a component's `export default function Foo` into `function Foo` with
  `export default Foo;` after it, in builds and before any other plugin reads the module, so the wrapper takes
  the binding and the pass after the JSX compiler names it. Lines and the name's column stay where they were.
  `fixtures/react-router` and `fixtures/react-router-7` now have a slow click handler in the route component,
  and CI checks the verdict names `Home` in development and production.

## [0.10.0] - 2026-09-25

### Added

- **Every warning links to what to do about it.** Each warning the library prints in the browser, and each
  one `withInpBlame` and the Vite plugin print at build time, now ends with a link to its own entry in the
  README's new Troubleshooting section, which says what it means and how to fix it. A unit test reads the
  anchors out of the source and fails when one is missing from the README.
- **The issue forms ask for more.** The wrong or missing blame form asks what you clicked, what the report
  blamed and what you think is slow as three questions. The setup problem form asks for the framework and the
  full warning text, and links Troubleshooting first.
- `profiler` is among the package's npm keywords.

### Changed

- **The two "installed too late" warnings are shorter.** They name the Vite, Next.js and Astro setups and
  `/auto` in one line, and the README entry they link to has the rest.
- **The size check wants the README's table exactly as `--write` writes it.** It let a row a tenth of a
  kilobyte off pass, so a table could go stale by 0.1 KB at a time. The budget check is unchanged.

### Fixed

- **A Vite 8 vendor group no longer runs react-dom before the install.** With a
  `build.rolldownOptions.output.codeSplitting` group (or the older `advancedChunks` one) sending
  `node_modules` to one vendor chunk, the library went into that chunk beside react-dom, and the install
  script imported it. When a library that imports react-dom, such as Radix's Portal, was in the group too,
  its module ran react-dom as the vendor chunk loaded, so on React 17 and 18 react-dom connected to the hook
  before `install()` and nothing was blamed; the build only warned. The plugin now adds a group of its own
  ahead of the app's, with a priority above all of them and no minimum size, that takes the library into a
  chunk of its own, as it has done for a `manualChunks` function since 0.5.0. With `entry` the group takes the
  install module too, where the plugin used to warn and leave the groups alone. CI builds
  `fixtures/vite-vendor-groups`, Vite 8.3 and React 18.3 with such a group and Radix's Portal in the page,
  and checks the click is blamed on `SlowList` in development and production; React 17 was checked by hand.
- Under `@vitejs/plugin-legacy`, the warning that react-dom runs before the install names the modern bundle's
  files, such as `assets/index-a1b2.js`, rather than the legacy copy's, which the plugin writes first. It
  names the legacy files only when there is no modern bundle (`renderModernChunks: false`), and on Vite 8,
  which builds the two copies one after the other, it is said once rather than twice.

## [0.9.0] - 2026-09-25

### Added

- **Next.js 14.2 to 15.2.** They have no `instrumentation-client`, so `withInpBlame` used to warn and install
  nothing. It now puts the install first in webpack's client entries (`main-app`, `main`, and the `main.js`
  list a config such as Sentry's prepends to, which Next.js turns into `main`), which runs it before react-dom
  loads, adds the name loader to webpack alone, and writes no `turbopack` key. Under `next dev
  --turbo` nothing can install, and the wrapper says so; soft navigations are not announced there. CI runs a
  14.2.35 App Router app (`fixtures/next-14`) in dev and production; 15.2.9 was checked by hand.
- **The README's webpack setup is tested.** `fixtures/webpack` is a React 18.3 app built by webpack 5 and
  babel-loader with `import 'react-inp-blame/auto'` first in its entry, the names loader rule and a
  `splitChunks` rule that puts react-dom and the library in one vendor chunk; CI clicks it in development and
  production and checks the blame names `SlowList`, which in production only the loader's `displayName` can.

### Changed

- **The badge and panel work under a strict Content Security Policy.** They styled their shadow root with a
  `<style>` element and set colours and bar widths in `style` attributes, so a `style-src` of nonces or hashes
  left an unstyled button at the foot of the page, and under Trusted Types the overlay was not shown at all.
  The stylesheet is now a constructed one, which `style-src` does not govern, colours come from classes and
  widths are set through the style object; under Trusted Types the markup goes through a policy named
  `react-inp-blame`, which the page lists in `trusted-types`. Where it does not, the console says so once and
  the reports still come. Safari before 16.4 still gets a `<style>` element. CI runs the demo under such a
  policy in Chromium (`apps/demo/e2e/csp.spec.ts`).

## [0.8.0] - 2026-09-25

### Fixed

- **The panel fits a 360 px phone screen.** It was 372 px wide, 16 px from the corner, so it ran 28 px off a
  360 px Android screen and cut off the close button and each row's milliseconds; it is now at most the
  screen's width less 32 px, its height follows the screen as the browser's bars come and go (`dvh`), and
  on a touch screen or a screen under 480 px wide the close button and the rows are larger to tap. CI opens
  it on a 360 px phone (Playwright's Galaxy S8) as well as the Pixel 7 and the iPhone 15.
- **The README's bundle sizes are measured, and checked in CI.** The table said 39.0 KB minified and
  14.4 KB gzipped for `react-inp-blame/auto`, figures from 0.1.0, about a third under what the entry had grown
  to. The table, in the repository's README and in the package's own, now comes from `scripts/size.mjs`, which
  builds each bundle with the repo's rolldown, and CI's unit job fails when either is out of date or a gzipped
  size passes its budget in `scripts/size-budget.json`.
- An icon that is a control of its own and was handed its handler, `<Trash2 role="button" onClick>`, names the
  component that wrote the handler, as `<Trash2 onClick>` has since 0.6.0; it was named by lucide's `Trash`.

### Added

- **A report says when component names look minified.** Names come from `displayName` or the function's
  name, and only the Vite plugin, the Next.js wrapper and the loader stamp them, so under `react-inp-blame/auto`
  in a webpack, Rspack, Parcel or Rsbuild build a blame read "inside e, mostly Xe" with nothing to say why.
  Where a report's commits hold at least five different names and four in five of them are one or two
  characters long, and none of the names its renders started or led with is readable, it gets a note saying
  which setups keep an app's own names and that a dependency's are kept only where it sets `displayName`,
  and the console says so once, with a link. The blame is unchanged.
- **`stats().react`, the badge and the panel say when the library cannot see React.** When install() ran
  after react-dom loaded, the only sign was one console warning 3 s after load: reports then said "React
  didn't render anything", and a script blame could read as measured. `stats().react` is now `'reading'`,
  `'waiting'` (React has not rendered on the page yet, as before an Astro island hydrates), `'installed-late'`
  or `'unreadable'`, and each report carries it as `reactStatus`. While React cannot be seen, a report says
  what React did is unknown, never calls a blame measured, and carries a note with the fix. The badge gets a
  `data-status` and a warning mark, as soon as the check 3 s after load finds React, and the panel a line
  saying what is wrong and what to do: installed
  late, a disabled or replaced DevTools hook, a react-dom that cannot be read, or, as a note, a browser
  without Long Animation Frames. On a browser without Event Timing's `interactionId`, a badge that was asked
  for now shows "INP not measured" and a panel naming the browsers that report it, where it showed nothing.

## [0.7.0] - 2026-09-25

### Fixed

- **Renders that a resize, a scroll, a hover or a media query caused stop joining the last click.** A commit
  made while one of those events was being dispatched, outside any input's task, was read as the newest
  input's work, and a `change` from a `MediaQueryList` counted as part of the input the way a form field's
  does. Narrowing the window re-rendered 441 components behind a `useMediaQuery` hook, reported as the second
  render of a click a second earlier. Those commits are now left out, not walked and not counted as
  `unjoinedCommits`, and so is a commit after the window changed width since the input. Under React 19.1
  and later, in development and profiling builds, a hover's or a scroll's render, which comes in a task of
  its own, is told by the priority React commits it with, except behind a touch, whose own pointerover and
  pointerenter get that priority too: a card a finger opens by entering it stays the tap's work, and joins
  the tap even where Event Timing left out its pointerdown. React 18 and 19.0, and React 19 in production,
  say nothing that tells it apart, and there it still joins (README, Known limits). The demo's `ambient` spec
  checks the breakpoint case on React 17 to 19.3 and the hover and scroll cases where React says whose they
  are, in development and production, and its phone spec the finger's card.
- **A render past the walk budget is no longer blamed on the subtree the walk reached first.** The walk stops
  at `walkBudget` components (5,000), depth first, and a production build has no durations, so the blame
  went by counts: the first subtree, counted in full, beat a later one twice its size that the walk had
  only begun. A commit cut short is now named by its one subtree where nothing it did not reach rendered
  beside it (a single long list), and otherwise by the component its subtrees all sit under (a render of
  3,000 and then 6,000 rows is blamed on the component holding both, wherever the cut fell), and its sentence
  says "at least" that many components and names none it was "mostly" made of. `blame.name` and `blame.detail` change value for those
  commits; `blame.name` is null where nothing contains them all, and for a render blame on a commit that
  rendered no component (it read "the app"). The Performance panel's render entries say "at least" too.
  Development builds, whose durations cover every subtree, choose as before. The demo's `budget` spec checks
  it in both builds.

## [0.6.0] - 2026-09-25

### Added

- `pointerType` on a report: 'mouse', 'pen' or 'touch' for the event its `type` names, as the library saw it
  dispatched, and null for a key.

### Changed

- **Render and layout blames name a component of the app, not a styling library's wrapper or a minified
  name.** The readable-name rule `where` already followed now picks the component a render blame names
  (the deepest readable one on the hot path), what a commit was "mostly" made of (the most-rendered
  component a styling library did not make, or a readable one carrying at least half as much), and the
  owners in `generateTarget`'s string. A list styled with styled-components used to be blamed on
  `styled.ul`, "mostly styled.li ×400", and one styled with @emotion/styled on `Styled(ul)`; both are now
  blamed on the component that renders the list, mostly the row component. A wrapper is told by its fiber,
  not its name, and named the way its library names one without a label, so MUI's `MuiButtonBaseRoot` in
  development reads `Styled(button)`, and the component @emotion/react's `css` prop wraps an element in reads
  `Styled(li)`. emotion's `Insertion`, which @emotion/styled and the `css` prop render beside every element
  they style, is no longer counted as a component, so an emotion list of 400 rows no longer reads as 800
  components. A name with the `$1` Vite's development server adds to one that clashes (`Dt$1`) is judged
  without it. Where nothing readable is there, the names stand as before. `blame.name`, `blame.detail`, a
  commit's `components` and `rendered` under emotion, and `generateTarget`'s string change value for those
  cases and keep their meaning.
- **A click on an icon inside a button is put on the button's component.** Event Timing names the element
  the pointer landed on, often an icon library's `<svg>` or `<path>`, and `target.component` and `owners`
  were read from there: `Trash2` from lucide-react rather than the `DeleteButton` around it. For a click on
  an icon (an `<svg>` or something in one, an `<img>`, a `<picture>`) they are now read from what the icon
  belongs to in the fiber tree: above the components that render nothing but the icon, at the control
  around it, at an element with a click handler of its own, or at the first element or component that
  renders something beside it. So the trash icon is `DeleteButton`'s, an icon beside a name in an option is
  the option component's, a card's photo inside a link is still the card's, a thumbnail's `<img onClick>` is
  the thumbnail's, and `<Trash2 onClick>`, whose handler lucide hands down to its `<svg>`, is the component's
  that wrote it, as is a click on any component that only hands its onClick to its one image or icon
  (`<Avatar onClick>` is named by what renders it); `generateTarget`'s string follows. A click anywhere else is named as before.
  When the icon was swapped by the render (a minus for a check), the label and the names still come from
  the button. `target.selector` and `target.handler` still describe the element that was hit.
  CI runs these on real libraries (`fixtures/component-libraries`, styled-components 6, @emotion/styled and
  @emotion/react 11, lucide-react 1 and Radix's DropdownMenu 2), in development and production builds.
- **The handler named is the one whose event did the work.** A click is a pointerdown, a pointerup and a
  click, and the handler was looked for on the click first whatever each one's handlers cost, so a menu that
  opens on pointerdown (Radix's DropdownMenu) was put on an `onClick` beside it that did nothing. Only the
  events whose own handlers ran longest (within 4 ms of each other) are now asked, the click first among
  them; where their work was a listener of the page's own rather than a React handler, `target.handler` is
  null and the explanation names that listener. The report's `type` is unchanged.
- **Names that say nothing about a handler give way to its prop.** React Compiler's temporaries (`t0`,
  `t12`, `_temp`), the `handleEvent` Radix wraps every composed handler in, the `debounced` lodash's
  debounce and throttle wrap one in, and the `bound ` on a bound function no longer reach `target.handler`:
  the first four read as the prop, such as `onClick`, and a bound function by its own name.
- A report whose only event is a mouse's pointerdown or pointerup reads "click", not "tap".

## [0.5.0] - 2026-09-25

### Added

- **The Vite plugin says when nothing will install.** Its install script only reaches HTML pages Vite
  serves or builds, so in React Router, Remix, TanStack Start and Astro, and in a build whose inputs are all
  scripts (Laravel, Rails, Django), the plugin with the runtime on and no `entry` installed nothing and said
  nothing. It now warns once, when the dev server starts and, where the plugin is on for builds, when the
  app builds, naming the fix: the `entry` for that framework, the Astro integration, or `entry` for the
  first script. Not under Vitest or `vite preview`.
- A build where the chunk holding the install call imports a chunk that connects react-dom to React's
  DevTools hook as it loads gets a warning naming both: react-dom connects before `install()` there, and the
  build looks fine otherwise. That chunk is one that imports `react-dom/client`, or with React 17 or 18
  `react-dom` itself (a component library's portal in a vendor chunk is enough), or on Vite 5, whose bundler
  leaves react-dom's body in place, the chunk that holds react-dom. Seen on Vite 8 with a `codeSplitting`
  vendor group and React 18, on Vite 5.4 with a `manualChunks` object, and with `@vitejs/plugin-legacy` and a
  vendor rule, where the fix is to keep react-dom out of the rule, since the install stays in the page's own
  script there.

### Changed

- **`entry` naming a file that does not exist stops the dev server and the build at once**, with the path it
  looked for. The dev server used to run without the install and say nothing; a build failed only at the end.

### Fixed

- **A `manualChunks` vendor rule no longer runs react-dom before the install on an HTML page.** A function
  sending all of `node_modules` to one chunk put this library there with react-dom, and the page's install
  script imported that chunk, so on Rollup (Vite 7 and before) with React 17 or 18 nothing was blamed in a
  production build. When the app's `manualChunks` is a function, the library now gets a chunk of its own
  and the function decides every other module. CI builds the case on Vite 7.3 with React 18.3
  (`fixtures/vite-vendor-chunk`), which fails on 0.4.0.

## [0.4.0] - 2026-09-25

### Added

- **`react-inp-blame/astro`, an integration for Astro.** Astro writes its own pages, so the Vite plugin's
  script never ran there and the library never installed. The integration hands `install()` to the script
  Astro imports in every island before it loads the island's component and renderer, so it runs before
  `@astrojs/react` loads react-dom, and adds the `displayName` transform. It takes `enabled` and `runtime`
  as the Vite plugin does. CI runs it in Astro's minimal template (Astro 7.3, React 19.3), installed from
  the packed tarball, under `astro dev` and on `astro preview` of a production build: a page with two
  islands, and one whose only island hydrates when it scrolls into view.
- **`entry`, a Vite plugin option for frameworks that write their own HTML, and a setup for Remix.**
  `inpBlame({ entry: 'app/root.tsx' })` puts the install first in that module, in the browser's copy only
  and after the JSX is compiled, and in a build gives it a chunk of its own, marked as having side effects.
  Under Rollup (Vite 7 and before) that chunk is evaluated before the others the module imports; Rolldown
  (Vite 8) orders them itself, and the apps CI builds with it come out right.
  It is the whole setup for React Router, Remix and TanStack Start (`entry: 'src/client.tsx'`), and the
  READMEs now give it in place of a module of your own imported first, which still works where it did. It
  also covers what that could not: in Remix's template the root route's chunk loads react-dom before its
  own body, and `"sideEffects": false` drops an import with no names from the build, so on Remix 2 an
  install written in `app/root.tsx` worked on the dev server and never ran in a production build. A build
  in which no module has the path fails. A server build gets neither the import nor the chunk, and an output
  that cannot be split into chunks keeps the import with no chunk of its own. The chunk holds everything the
  install imports, so an app's vendor rule cannot put the library beside react-dom. On the dev server the
  plugin asks Vite to pre-bundle
  react-inp-blame, which it cannot find in the source by itself, so the first visit does not reload the
  page while it hydrates. CI runs Remix 2.17 from `npx create-remix@2.17.5`, on React 18.3, beside the
  React Router 8, React Router 7 on React 18 and TanStack Start apps, all on `entry` now.
- The READMEs' Vite quick start says that React Router, Remix, TanStack Start and Astro need their own
  setup, and links to it.
- **A setup for React Router in framework mode and for TanStack Start.** Both write their own HTML, so the
  Vite plugin's script never ran there and the library never installed. The README's new sections put
  `install()` in a module of the app's own that the client entry (`app/entry.client.tsx`, `src/client.tsx`)
  imports first, which runs before react-dom does, and keep the plugin for component names. CI runs each in
  an app from the framework's own template, `npx create-react-router@8.4.0` and TanStack Start's blank one,
  installed from the packed tarball, on the dev server and on a production build. On React 18 the import
  goes first in `app/root.tsx`: that `react-dom` connects to React's DevTools hook as it loads, and a route
  can import it before the entry does. CI runs that in React Router 7.18's app moved to React 18.3.

### Fixed

- **The warning that `install()` ran too late needs React on the page.** It came 3 s after install
  whenever no react-dom had registered with the hook, which is also a page that has not loaded React yet:
  under Astro, one whose only React island is `client:visible` below the fold, or whose islands are all
  another framework's. It now also needs an element react-dom has rendered, or a root container, which a
  react-dom that loaded before the install leaves behind. A page with neither at 3 s is looked at once
  more at its first interaction, for a root created later. The late-install warnings name
  `react-inp-blame/astro` and the Vite plugin's `entry` among the setups. Found by review.
- **A click made from the keyboard belongs to its key, not to the mouse click before it.** A pointerup
  or a click is tied to the press it releases by its `pointerId`, and the click that Enter or Space makes
  has none to go by: its `pointerId` is -1. It took the newest pointerdown of the last 5 s instead. So
  after a mouse click on a button, Enter on the same button within `inputWindow` of that click's paint
  had its render joined to the mouse click's report as a later render, whenever the report held the
  mouse click's pointerdown entry, which it does once that entry reaches 16 ms, or at any length when
  that click was the page's first input. The click is now part of
  the key whose task made it, Enter's keydown or a Space's keyup, unless it is a tap's click whose touch
  has not clicked yet, which happens when a key lands between the touchend and the click. A click with
  neither a key nor a pointer behind it is a gesture of its own. Found reading the code.

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

[Unreleased]: https://github.com/adityareddy-dev/react-inp-blame/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/adityareddy-dev/react-inp-blame/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/adityareddy-dev/react-inp-blame/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/adityareddy-dev/react-inp-blame/compare/v0.3.0...v0.12.0
[0.11.0]: https://github.com/adityareddy-dev/react-inp-blame/compare/215a9f2...0c8d148
[0.10.0]: https://github.com/adityareddy-dev/react-inp-blame/compare/ab94834...215a9f2
[0.9.0]: https://github.com/adityareddy-dev/react-inp-blame/compare/5c15a1d...ab94834
[0.8.0]: https://github.com/adityareddy-dev/react-inp-blame/compare/006cc27...5c15a1d
[0.7.0]: https://github.com/adityareddy-dev/react-inp-blame/compare/f39b212...006cc27
[0.6.0]: https://github.com/adityareddy-dev/react-inp-blame/compare/0f12c43...f39b212
[0.5.0]: https://github.com/adityareddy-dev/react-inp-blame/compare/97b2e4a...0f12c43
[0.4.0]: https://github.com/adityareddy-dev/react-inp-blame/compare/v0.3.0...97b2e4a
[0.3.0]: https://github.com/adityareddy-dev/react-inp-blame/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/adityareddy-dev/react-inp-blame/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/adityareddy-dev/react-inp-blame/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/adityareddy-dev/react-inp-blame/releases/tag/v0.1.0
