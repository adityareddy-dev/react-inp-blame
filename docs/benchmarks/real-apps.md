# react-inp-blame 0.12.0 on five open-source apps

Measured on 2026-09-25 with react-inp-blame 0.12.0 as published on npm (integrity
`sha512-QIX+NKEjdPClmiMn3XkPPykApAonlByoYVpGzpzHIr4eU3iANAv1g9si9oAGYl+Cq2joCXWwimJnm4S9lc6X0w==`), installed in
each app and checked file by file against the published tarball before the run. Two questions: what it costs
on apps nobody wrote for it, and whether what it blames is right.

**INP did not move on any of them, at either speed.** Every INP interval holds zero, the phone Sheet's at 4x
only just. The cost shows at page load on the shadcn site, as it did last time, and inside interactions only
where the library's own read of a commit gets big: about 5 ms an interaction on twenty unthrottled and 10 ms
at 4x, where a commit is close to 5,000 components.

**The blame was right in 11 of the 43 verdicts checked against the source, misleading in 18 and wrong in
13**, and one couldn't be settled. Most of the misses get the kind of work and its milliseconds right, then
name the wrong component or point you the wrong way. What was wrong, and the change that fixes each part, is
under "Where the blame was wrong".

## How

The harness is the one [the first benchmark](README.md) describes: production builds only, Playwright driving
headless Chromium through a scripted sequence of real interactions per app, every step asserting that the page
changed, a fresh browser context per run, one warm-up per app, 15 runs of each build interleaved A, B, A, B,
unthrottled and then at 4x CPU throttling through the DevTools protocol. The measuring is a separate observer
injected before any app script, the same bytes in both builds, and the deltas are paired by run index and
bootstrapped (10,000 resamples, 95% percentile interval).

Two builds of each app this time. C, the overlay, was measured last time and is left out.

| | |
| --- | --- |
| **A** | the library absent |
| **B** | the library's README setup with `enabled: true` and `runtime: { debugGlobal: true }`, so the harness can read `stats()` and `reports()` |

The apps:

| app | what | React | sequence |
| --- | --- | --- | --- |
| `tt-fuzzy` | TanStack Table `examples/react/filters-fuzzy`, 5,000 rows | 19.3.0, development build | type a name a key at a time, clear it, sort, page size to 50, scroll |
| `tt-virtual` | TanStack Table `examples/react/virtualized-rows`, 200,000 rows | 19.3.0, development build | sort up, sort down, scroll the list, tick a row |
| `excalidraw` | excalidraw at `97c68dd` | 19.0.0 | draw 60 rectangles, select all, drag them, undo |
| `shadcn-v4` | the shadcn/ui docs site, `apps/v4` at `a87a63b`, Next.js 16.3.3 App Router | 19.2.3 | sort a table, switch install tabs, search the command menu, follow a result, page a calendar, toggle the theme, open the mobile nav |
| `shadcn-sheet` | the same site's Radix Sheet page, 1350x940 | 19.2.3 | open the Sheet, close it |
| `shadcn-sheet-phone` | the same, at 390x844, DPR 3, touch | 19.2.3 | tap it open, tap it closed |
| `twenty` | twenty CRM, `packages/twenty-front` at `2feb94c3128e`, Vite, signed in to a seeded workspace | 19.2.7 | select every row and unselect them, open a record from its chip and close it, open the command menu, type in it and close it, drag a column and drag it back, then go to Companies, Opportunities and People |
| `cal-diy` | cal.diy `apps/web` at `54343aa`, Next.js 16.2.3, signed in with the seed's user | 19.3.0 canary, the one Next.js bundles for the App Router | hide and show an event type, search event types, open one, type in its title, the advanced tab, a switch on it, back |

twenty runs against its own server in Docker with Postgres and Redis beside it; cal.diy against Postgres. Both
have their service workers switched off, as Excalidraw does, so nothing installs inside a run. The patches
that do this, and the rest of the build plumbing, never reach the measured page.

The blame was checked against each app's source at the commits above, with the libraries read in each app's
`node_modules`: every verdict a one-run pass printed for an interaction of 100 ms or more, and the slowest of
each pass. Each finding then went to a second reader whose job was to knock it down. Six changed grade that
way, five of them for the worse. The 15-run pass printed the same blame for a step in nearly every run; where
it split, that's said below.

## What it costs

Medians and paired deltas, in ms, with the bootstrapped 95% interval. Bold where the interval leaves out zero.

#### Unthrottled

| app | metric, ms | A median | B − A |
| --- | --- | ---: | --- |
| tt-fuzzy | INP | 32 | 0.0 [0.0, 0.0] |
| tt-fuzzy | Interaction time, all steps | 128 | 0.0 [0.0, 0.0] |
| tt-fuzzy | Long frame blocking | 0 | 0.0 [0.0, 0.0] |
| tt-fuzzy | Load to ready | 444 | -4.0 [-8.0, 9.0] |
| tt-virtual | INP | 272 | +8.0 [0.0, 8.0] |
| tt-virtual | Interaction time, all steps | 568 | +8.0 [0.0, 16.0] |
| tt-virtual | Long frame blocking | 1,035 | **+10.0 [2.0, 18.6]** |
| tt-virtual | Load to ready | 1,223 | +7.0 [-3.0, 12.0] |
| excalidraw | INP | 24 | 0.0 [0.0, 0.0] |
| excalidraw | Interaction time, all steps | 2,440 | 0.0 [-24.0, 16.0] |
| excalidraw | Long frame blocking | 23 | +0.4 [-3.8, 1.2] |
| excalidraw | Load to ready | 754 | +16.0 [-24.0, 92.0] |
| shadcn-v4 | INP | 168 | 0.0 [0.0, 8.0] |
| shadcn-v4 | Interaction time, all steps | 1,160 | +16.0 [-8.0, 48.0] |
| shadcn-v4 | Long frame blocking | 1,344 | **+98.9 [19.3, 136.6]** |
| shadcn-v4 | Load to ready | 2,889 | **+209.0 [73.0, 254.0]** |
| shadcn-sheet | INP | 96 | 0.0 [-8.0, 8.0] |
| shadcn-sheet | Interaction time, all steps | 152 | 0.0 [-8.0, 16.0] |
| shadcn-sheet | Long frame blocking | 60 | +7.8 [-2.5, 17.3] |
| shadcn-sheet | Load to ready | 1,132 | +12.0 [-23.0, 25.0] |
| shadcn-sheet-phone | INP | 56 | 0.0 [0.0, 8.0] |
| shadcn-sheet-phone | Interaction time, all steps | 96 | 0.0 [0.0, 8.0] |
| shadcn-sheet-phone | Long frame blocking | 0 | 0.0 [0.0, 18.8] |
| shadcn-sheet-phone | Load to ready | 1,067 | +13.0 [-5.0, 40.0] |
| twenty | INP | 376 | +8.0 [-16.0, 8.0] |
| twenty | Interaction time, all steps | 2,520 | +16.0 [-40.0, 112.0] |
| twenty | Long frame blocking | 7,172 | -14.0 [-114.7, 169.6] |
| twenty | Load to ready | 3,990 | -63.0 [-101.0, 10.0] |
| cal-diy | INP | 32 | 0.0 [0.0, 0.0] |
| cal-diy | Interaction time, all steps | 208 | 0.0 [-16.0, 0.0] |
| cal-diy | Long frame blocking | 33 | +2.6 [-0.3, 3.8] |
| cal-diy | Load to ready | 793 | +7.0 [-10.0, 18.0] |

#### 4x CPU throttling

| app | metric, ms | A median | B − A |
| --- | --- | ---: | --- |
| tt-fuzzy | INP | 128 | 0.0 [0.0, 0.0] |
| tt-fuzzy | Interaction time, all steps | 192 | +8.0 [-8.0, 24.0] |
| tt-fuzzy | Long frame blocking | 411 | +8.6 [-12.1, 27.6] |
| tt-fuzzy | Load to ready | 934 | -154.0 [-244.0, 32.0] |
| tt-virtual | INP | 1,352 | -24.0 [-32.4, 24.0] |
| tt-virtual | Interaction time, all steps | 2,848 | -48.0 [-72.0, 80.0] |
| tt-virtual | Long frame blocking | 6,537 | +34.8 [-57.9, 103.5] |
| tt-virtual | Load to ready | 3,722 | +19.0 [-89.0, 89.0] |
| excalidraw | INP | 56 | 0.0 [-0.2, 8.0] |
| excalidraw | Interaction time, all steps | 3,224 | +8.0 [-32.0, 48.0] |
| excalidraw | Long frame blocking | 477 | +11.8 [-5.6, 60.8] |
| excalidraw | Load to ready | 1,288 | +38.0 [-12.0, 204.0] |
| shadcn-v4 | INP | 928 | +40.0 [-96.0, 80.0] |
| shadcn-v4 | Interaction time, all steps | 6,352 | +96.0 [-416.0, 656.0] |
| shadcn-v4 | Long frame blocking | 19,684 | +463.5 [-300.4, 2433.9] |
| shadcn-v4 | Load to ready | 15,201 | +860.0 [-66.0, 1907.0] |
| shadcn-sheet | INP | 472 | +56.0 [-8.0, 72.0] |
| shadcn-sheet | Interaction time, all steps | 608 | +40.0 [-16.0, 80.0] |
| shadcn-sheet | Long frame blocking | 2,468 | **+135.6 [22.9, 365.2]** |
| shadcn-sheet | Load to ready | 4,993 | +87.0 [-22.0, 220.0] |
| shadcn-sheet-phone | INP | 232 | +16.0 [0.0, 32.0] |
| shadcn-sheet-phone | Interaction time, all steps | 312 | **+16.0 [8.0, 32.0]** |
| shadcn-sheet-phone | Long frame blocking | 577 | -11.3 [-96.6, 30.9] |
| shadcn-sheet-phone | Load to ready | 3,157 | -99.0 [-186.0, 49.0] |
| twenty | INP | 1,784 | +32.0 [-16.0, 64.0] |
| twenty | Interaction time, all steps | 11,520 | -72.0 [-392.0, 656.0] |
| twenty | Long frame blocking | 43,034 | -183.8 [-577.1, 680.1] |
| twenty | Load to ready | 14,030 | -45.0 [-256.0, 91.8] |
| cal-diy | INP | 72 | 0.0 [0.0, 8.0] |
| cal-diy | Interaction time, all steps | 448 | +8.0 [-16.0, 16.0] |
| cal-diy | Long frame blocking | 998 | +34.0 [-2.0, 94.1] |
| cal-diy | Load to ready | 2,190 | -25.0 [-72.0, 176.0] |

What shows:

- **Load to ready and long frame blocking on the shadcn site**, unthrottled: +209 ms on 2,889 to ready, +99
  ms of blocking on 1,344. At 4x both intervals are too wide to call. The first benchmark measured B at +140
  and C at +75 on the same site, and took C's figure cause B looked like one odd build. This B is a fresh
  build of the npm release and lands higher again, so the larger figure is more likely the real one. The
  likeliest cause is still the one that page found, the Next plugin stamping a `displayName` on every
  component in a site this heavy in them (under Bundle size).
- **Long frame blocking on the Sheet page at 4x**, +136 ms on 2,468, and +10 ms on 1,035 on the virtualized
  table unthrottled. Both cover the whole run from page load on.
- **The phone Sheet at 4x**, +16 ms [8, 32] of interaction time over its two taps. The library's own count
  of what it spent inside those two interactions is 13 ms, so that is its read of the commits, paid inside
  the tap. INP there is +16 [0, 32], one rounding step either side.

Everything else holds zero. The largest point estimates that do are the Sheet's INP at 4x, +56 [-8, 72],
and the shadcn site's load at 4x, +860 [-66, 1,907].

### What the library says it spent

Its own accounting from `stats()`, median over the 15 runs of B. "Inside interactions" is the sum of each
report's `overheadMs`, the part of the walk that ran inside an interaction the page was waiting on.

| app | pass | commits walked | `walkTotalMs` | per commit | inside interactions | `installMs` |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| tt-fuzzy | unthrottled | 15 | 0.8 | 0.05 | 0.4 | 0.6 |
| tt-fuzzy | 4x | 15 | 4.3 | 0.29 | 3.7 | 3.3 |
| tt-virtual | unthrottled | 5 | 2.0 | 0.40 | 3.3 | 0.7 |
| tt-virtual | 4x | 5 | 10.4 | 2.08 | 15.8 | 3.2 |
| excalidraw | unthrottled | 510 | 15.5 | 0.03 | 13.1 | 4.7 |
| excalidraw | 4x | 546 | 68.4 | 0.13 | 62.3 | 19.2 |
| shadcn-v4 | unthrottled | 55 | 5.5 | 0.10 | 9.2 | 0.5 |
| shadcn-v4 | 4x | 54 | 33.1 | 0.61 | 49.9 | 2.7 |
| shadcn-sheet | unthrottled | 17 | 1.6 | 0.09 | 2.5 | 0.6 |
| shadcn-sheet | 4x | 17 | 7.5 | 0.44 | 12.2 | 3.0 |
| shadcn-sheet-phone | unthrottled | 17 | 1.2 | 0.07 | 2.5 | 2.2 |
| shadcn-sheet-phone | 4x | 17 | 6.2 | 0.36 | 13.1 | 2.7 |
| twenty | unthrottled | 199 | 66.7 | 0.34 | 69.2 | 3.7 |
| twenty | 4x | 84 | 137.8 | 1.64 | 152.5 | 2.8 |
| cal-diy | unthrottled | 61 | 10.2 | 0.17 | 10.1 | 0.5 |
| cal-diy | 4x | 59 | 50.7 | 0.86 | 60.5 | 2.6 |

twenty is the heavy one: 14 or 15 reports a run, so about 5 ms of the library inside each interaction
unthrottled and 10 ms at 4x, on interactions of 200 to 1,800 ms. The walk stops at 5,000 components, which
is why twenty's sentences say "at least". Excalidraw's `installMs` is higher than anywhere else and higher
than the first benchmark's 0.5 ms; nothing here says why.

`inp()` gave the same INP as the harness in every run on every app but two. On the shadcn site and cal.diy it
starts over at each soft navigation, as it's documented to, so it only counts what came after the last one.
On cal.diy nothing did.

### Bundle size

JavaScript on disk, A against B: +81 KB on each TanStack app, +114 KB on Excalidraw. Both up from the first
benchmark's +66 and +97, since 0.12.0 carries more than the 0.3.0 candidate did.

On the three big apps the figure is mostly the Next and Vite plugins stamping a `displayName` on each
component. twenty's client JavaScript grows by 474 KB and the word `displayName` goes from 534 appearances to
5,774. cal.diy's grows by 713 KB, from 1,542 to 13,991. The shadcn site's grows by 7.0 MB across every chunk
behind the pages Next generates, not what one page loads; the first benchmark worked out what its page loads.
`enabled` at its default, `'development'`, keeps the stamps out of production builds.

## What it blamed, and whether that was right

For each app, the slowest interaction, what 0.12.0 said about it, what the source says, and whether the fix
is obvious. The times are A's medians, the app on its own.

**TanStack Table, virtualized rows.** The slowest interaction is the sort, 272 ms unthrottled and 1,344 at
4x. The library says:

> React spent 277 ms re-rendering 637 components inside TableBody.

TableBody is right. The count sends you the wrong way. 257 of those 277 ms are TableBody's own render, cause
that is where `table.getRowModel()` runs, and that is where the 200,000 rows get sorted: the column has no sort
function, `'auto'` samples ten rows, finds strings with no digits and picks `text`, and every one of the roughly
3.3 million comparisons calls `getValue` four times through a wrapper and lowercases both strings. The 637
components under it cost about 20 ms. Memoising rows would do nothing. The fix is obvious once you know where
the time is: a plain comparator on the raw value, measured below under "One fix, before and after". The same
app's checkbox tick at 4x is blamed on the screen update after a scroll listener ran for 133 ms, in 12 of 15
runs. The listener is react-virtual's, and what it spent that time on was a React render it forced with
`flushSync`, which the library recorded but did not connect to the script.

**TanStack Table, fuzzy filters.** Nothing here reaches 100 ms unthrottled; at 4x the sort is the slowest, 128
ms, blamed on a render of 97 components in App. App is the whole page. It is also where
`table.getRowModel()` runs and the 5,000 rows get sorted, so again the time sits in one component's own render
rather than in the 97. Its report also carried a later render, "people still wait for it", that belonged to
the next step: the page size change, fired by script, so it never became an interaction of its own. That note
was wrong.

**Excalidraw.** Nothing in its sequence is slow; even at 4x the slowest is the undo, 72 ms. Two verdicts were
still wrong or beside the point. A rectangle's pointer release had 2.8 ms of working time in 40 and was blamed
on a render, cause the screen update only takes the blame from 50 ms. And the undo's 64 ms were put on the
screen update after the Control key, when that update was waiting on the z key's handler, the undo itself. At
4x the report shown for the rectangles' step was a shorter one than the slowest: the library keeps its last
50 reports, and a run with 60 rectangles in it pushes the slowest out.

**The shadcn/ui docs.** The slowest is opening the command menu, 168 ms and 928 at 4x. The kind and the size
are right: the browser recalculating styles, measured within a few milliseconds of what a Chrome trace shows.
The name is not. The sentence says 118 components inside DismissableLayer, mostly CommandItem, and
DismissableLayer is just where the library's 12-step walk down from the dialog's Portal ran out; the 118 is
the whole commit. What forces the three whole-document style recalculations, about 7,100 elements each against
a 600 KB stylesheet, is Radix's `Presence` reading `animationName`, cmdk's `scrollIntoView` and
`DismissableLayer` setting `pointer-events` on the body before `FocusScope` focuses. None of it is the app's
code, and there is no obvious fix in the app. The install tabs switch is worse: blamed on
`RovingFocusGroupCollectionProviderProvider`, a Radix internal, when what happened is that one shared atom
re-rendered both install blocks and each `TabsContent` forced a recalc.

**The Sheet.** The open is the slowest, 96 ms on the desktop and 472 at 4x, 232 ms on the phone at 4x. Style
recalculation is right again, and a Chrome trace of the same click agrees: four whole-document recalcs.
Everything that names code is off: "59 components inside DismissableLayer, mostly Label (4 of them)" counts the
whole commit, calls a mount a re-render, and points at the form's two labels, which cost nothing. The fix is
obvious though, and it isn't in the app's code: the Base UI Sheet the same site ships does one recalc and
opens in 40 to 48 ms against 120. On the phone unthrottled the tap's frame was under the 50 ms Long Animation
Frames reports, so no style work was measured and the verdict fell back to a render guessed from counts. The
close did the same on the phone at both speeds and on the desktop unthrottled.

**twenty.** The slowest is opening a record from its chip, 376 ms and 1,784 at 4x, blamed on "at least 4917
components inside hl". `hl` is React Router's `RouterProvider`, minified in a dependency. The sentence is true,
the whole people table re-rendered from the router down, and it gives you nothing to open: a URL parameter the
side panel writes changes the router's context, and with no memo boundary anywhere under the page every row
and cell follows. There is no one-line fix; it needs a memo boundary under the page or the parameter kept out
of router state. Selecting all rows is blamed on `StyledContainer`, one of about 270 in the codebase and not
the checkbox's. The command menu's verdicts say "mostly" of a component that is 6 to 10% of what rendered, and
at 4x its typing and closing are put down to the screen update with nothing named.

**cal.diy.** Nothing reaches 100 ms, even at 4x. The slowest is a switch on the advanced tab, 72 ms at 4x,
blamed on "1216 components inside Form, mostly (anonymous) (259 of them)". Form is where the 12-step walk ran
out, and the count is the whole commit's. The cause is higher up: `useEventTypeForm` calls `form.watch()` with
no argument on every render, so every field change re-renders the host, and with it the whole page. That fix
is obvious enough: watch with a callback in an effect, and read `isDirty` in a small child.

## Where the blame was wrong, and what changed

Most of the 31 misses come from a few defects, and one miss often has two of them.

- **The component named is where the walk ran out, and the count is the whole commit's.** The walk takes 12
  steps down the heaviest path, and a library's layers (Provider, Slot, Primitive, Portal, a styled wrapper,
  a component wrapping one of the same name) used them up. That gave DismissableLayer, Portal,
  `RovingFocusGroupCollectionProviderProvider`, Form, Layout and `StyledContainer`, each with a count that
  was the whole commit's, not what sat inside it. It also never said where the render started, and it called
  a mount a re-render. About half the misses. Fixed in 0.13.0 ([#29](https://github.com/adityareddy-dev/react-inp-blame/pull/29)): the walk passes those
  layers without spending steps on them, the count is what sits inside the component named, the sentence says
  where the render started, and a mount is called a mount.
- **"Mostly" for a component that was a small share.** It said "mostly" for whichever component rendered
  most, however few: Label, 4 of 59; `(anonymous)`, 124 of 1,298. Fixed in 0.13.0 ([#28](https://github.com/adityareddy-dev/react-inp-blame/pull/28)): "mostly"
  only when that component is at least half of what rendered or half the timed render, and the count
  otherwise.
- **A component's own render reported as breadth.** TableBody and App above. Fixed in 0.13.0 ([#27](https://github.com/adityareddy-dev/react-inp-blame/pull/27)): when
  most of the time is the named component's own render, the sentence says so and says what that usually
  means.
- **A minified name with nothing to go on.** `hl` above. Fixed in 0.13.0 ([#28](https://github.com/adityareddy-dev/react-inp-blame/pull/28)): a name that looks
  minifier-made, among names that mostly aren't, gets a note saying so and how to find whose it is.
- **A render blamed on counts when the time wasn't there.** The rectangle release with 2.8 ms of work in 40,
  and every phone tap whose frame Long Animation Frames never reported. Fixed in 0.13.0 ([#30](https://github.com/adityareddy-dev/react-inp-blame/pull/30)): with
  no measured render time and little working time, the screen update keeps the blame.
- **A later render put in the wrong report, the slowest report evicted, a key chord split in two.** The fuzzy
  table's page size render, Excalidraw's 50-report limit and its Control+z. Fixed in 0.13.0 ([#31](https://github.com/adityareddy-dev/react-inp-blame/pull/31)).
- **A render a script forced, left out of the sentence about that script.** The virtualized table's checkbox:
  the screen update is blamed on react-virtual's scroll listener, and the render of the rows it forced with
  `flushSync` was in the report, not in the sentence. Fixed after 0.14.0 ([#41](https://github.com/adityareddy-dev/react-inp-blame/pull/41)): the sentence says React rendered
  inside that script and what, and that render is no longer counted in the working time before it.
- **A screen update with no script named said nothing about why.** twenty's command menu at 4x, a column
  drop. Fixed after 0.14.0 ([#42](https://github.com/adityareddy-dev/react-inp-blame/pull/42)): where long animation frames saw at least half of it, the
  sentence says it was the browser's own work, from the frame's style and layout where the frame timed them.

Left as they are, and known:

- twenty's route changes, through React Router's data router, weren't recognised as soft navigations, so
  every report there carries the URL the page loaded on.
- "Often in a layout effect" is a generic hint. On the Radix pieces above the reads are in layout effects, on
  cmdk and the tabs they are not.
- The same step can read as style work at 4x and screen update unthrottled when the two are close: the
  command menu's jump to Calendar did.

## One fix, before and after

The virtualized table's sort, with the plain comparator from above as the only change, the library in both
builds, 15 paired runs through the same harness:

```ts
sortFn: (rowA, rowB) => {
  const a = rowA.original.lastName
  const b = rowB.original.lastName
  return a < b ? -1 : a > b ? 1 : 0
},
```

| pass | step | before | after | after − before |
| --- | --- | ---: | ---: | --- |
| unthrottled | INP | 280 | 192 | **-88 [-96, -80]** |
| unthrottled | sort up | 280 | 192 | **-88 [-96, -80]** |
| unthrottled | sort down | 248 | 168 | **-80 [-88, -72]** |
| 4x | INP | 1,576 | 1,080 | **-504 [-552, -440]** |
| 4x | sort up | 1,560 | 1,080 | **-480 [-544, -448]** |
| 4x | sort down | 1,440 | 1,016 | **-432 [-560, -368]** |

The scroll and the checkbox didn't move. What 0.12.0 printed for the sort, in all 15 runs of each:

> Before: React spent 266 ms re-rendering 637 components inside TableBody.
>
> After: React spent 162 ms re-rendering 637 components inside TableBody.

It named the same component both times and the time fell by about a third, which is right as far as it goes.
It is also why the own-render fix above matters: nothing in either sentence says the time is the sort. The
comparator is case-sensitive, where TanStack's `text` sort isn't, which is fine for these names. There is more
to take: TanStack's row compare still reads each value twice per comparison unless the column sets
`sortUndefined: false`.

## Hold these against the numbers

- **One machine, one browser.** Windows 11, AMD Ryzen 9 7900X, 32 GB, Chromium 147.0.7727.15 headless through
  Playwright 1.59.1, Node 24.19.0. The run took 113 minutes. The machine sat at about 2% CPU before it
  started. During it, Docker ran twenty's server, Postgres and Redis, and an editor session in this
  repository ran unit tests and type checks now and then. The before-and-after ran straight after, for 12
  minutes, and its 4x medians sit about 200 ms above the same build's in the main run, so the machine was
  busier then. Pairing run by run is what the deltas rest on; the absolute medians are this machine's.
- **The TanStack examples ship React's development build.** Their Vite configs pin `NODE_ENV` to
  `development`. Everything else runs production React, where the library reads counts, not durations, and
  says "most likely".
- **twenty and cal.diy have backends.** Their times include waiting on their own servers on the same machine.
  A step that fetches is as fast as that server was.
- **One warm-up per app.** The first measured run of each build can still pay for a cold cache the others
  don't.
- **The blame check read source, not traces, except where a trace is named.** A second reader tried to refute
  every finding, and six grades moved. It is still a reading of the code, and one verdict stays unsettled.

The harness is not in this repository yet.
