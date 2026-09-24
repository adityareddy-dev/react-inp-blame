# What react-inp-blame costs on real apps

Measured overnight on 2026-09-23 on the 0.3.0 candidate: PR #5 (`fixes-before-0.3.0`, `d780ca2`)
with #6 (`4fdebd8`), #7 (`f0505e3`) and #8 (`389d802`) on top, packed into one tarball, sha256
`d474cc3b10941cf7ece05e526c205831bbd4f3bd0e596f368d8529f1bec859ef`. Its `package.json` still says
0.2.0, since the version moves at the tag. Every app below had that tarball's files installed,
checked by hash after the run. PR #9 came later and is not in it; it adds a small record and up to
three clock reads to every commit.

## How

Three builds of each app, all production builds (`vite build` served as static files, or
`next build` served by `next start`, never a dev server):

| | |
| --- | --- |
| **A** | the library absent: the Vite config constructs no plugin, the Next config never calls the wrapper |
| **B** | `inpBlame({ enabled: true, runtime: { debugGlobal: true } })`, or `withInpBlame(config, { enabled: true, runtime: { debugGlobal: true } })` on Next |
| **C** | as B, with `overlay: true` in `runtime` |

`debugGlobal` is there so the harness can read `stats()` and `reports()` out of the page. It
assigns one global at install.

Playwright drives headless Chromium through a scripted sequence of real interactions per app, and
every step asserts the page changed, so a step that silently did nothing fails the run instead of
counting as a fast interaction. A fresh browser context per run, one warm-up per app, build and
pass thrown away, then 15 runs of each build, interleaved A, B, C, A, B, C so drift lands on all
three alike. Two passes: unthrottled, then 4x CPU throttling through the DevTools protocol.

The measuring is not the library's. A `PerformanceObserver` injected before any app script, the
same bytes in all three builds, collects Event Timing, Long Animation Frames and long tasks, and
INP is worked out from those the standard way. The deltas are paired by run index and bootstrapped:
10,000 resamples of the per-run difference, 95% percentile interval.

The apps:

| app | what | React | sequence |
| --- | --- | --- | --- |
| `tt-fuzzy` | TanStack Table `examples/react/filters-fuzzy`, 5,000 rows | 19.3.0, development build (the example pins `NODE_ENV`) | type a name a key at a time, clear it, sort, page size to 50, scroll |
| `tt-virtual` | TanStack Table `examples/react/virtualized-rows`, 200,000 rows | 19.3.0, development build | sort up, sort down, scroll the list, tick a row |
| `excalidraw` | excalidraw at `97c68dd` | 19.0.0 | draw 60 rectangles, select all, drag them, undo |
| `shadcn-v4` | the shadcn/ui docs site (`apps/v4` at `a87a63b`), Next.js 16.3.3 App Router | 19.2.3 | sort a table, switch tabs, search the command menu, follow a result (a soft navigation), page a calendar, toggle the theme, open the mobile nav at 390x844 |

The TanStack pair are seeded (`faker.seed`) so every load has the same rows, and their `react-scan`
script tag is removed. Excalidraw's service worker is off, so it cannot precache inside a run.
The rest is build plumbing that never reaches the page: Excalidraw's build skips its TypeScript
checker, and each shadcn build writes to its own output directory.

## What it costs

**INP did not move on any of the four apps, at either speed, with or without the overlay.** Every
INP delta's interval holds zero, and so does every delta in the run's total across its scripted
interactions. Event Timing rounds durations to 8 ms, so an interval of [0, 8] is one rounding step.

What does show:

- **Long animation frame blocking**, summed over a whole run from page load on, rises by about 5 to
  11 ms on the two TanStack apps in some cells (against 370 to 1,030 ms of blocking in the same run),
  and by about 210 ms on the shadcn site at 4x, against 16,700.
- **Load to ready on the shadcn site** rises by about 75 ms unthrottled, on 3,240. At 4x C reads
  +258 ms on 13,560 with an interval of [-18, 521], too wide to call. The likeliest reason is the
  size of what the Next plugin adds to that site's pages, below under Bundle size.
- **Excalidraw does better with the library than without it.** It blocks 18 to 19 ms less
  unthrottled and 34 to 41 ms less at 4x, in both B and C, and C's load to ready is 47 ms shorter
  unthrottled. Nothing here explains that; it is reported as measured.

On the shadcn site read C's column, not B's. B's larger figures there are that one build's, not the
library's: see the section after the tables.

Medians and paired deltas, in ms, with the bootstrapped 95% interval. Bold where the interval leaves
out zero.

### Unthrottled

| app | metric, ms | A median | B − A | C − A |
| --- | --- | ---: | --- | --- |
| tt-fuzzy | INP | 32 | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
| tt-fuzzy | Interaction time, all steps | 128 | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
| tt-fuzzy | Long frame blocking | 0 | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
| tt-fuzzy | Load to ready | 449 | -1.0 [-5.0, 1.0] | +2.0 [-8.0, 11.0] |
| tt-virtual | INP | 272 | 0.0 [0.0, 8.0] | 0.0 [0.0, 8.0] |
| tt-virtual | Interaction time, all steps | 568 | +8.0 [0.0, 8.0] | 0.0 [0.0, 16.0] |
| tt-virtual | Long frame blocking | 1031 | **+9.4 [0.5, 17.8]** | **+5.6 [3.0, 8.4]** |
| tt-virtual | Load to ready | 1226 | +5.0 [-6.0, 10.0] | +8.0 [-5.0, 11.0] |
| excalidraw | INP | 24 | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
| excalidraw | Interaction time, all steps | 2440 | -8.0 [-40.0, 16.0] | -8.0 [-48.0, 16.0] |
| excalidraw | Long frame blocking | 23 | **-19.0 [-20.7, -16.3]** | **-17.6 [-19.1, -15.0]** |
| excalidraw | Load to ready | 745 | -8.0 [-90.0, 75.0] | **-47.0 [-101.0, -13.0]** |
| shadcn-v4 | INP | 184 | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
| shadcn-v4 | Interaction time, all steps | 1256 | 0.0 [0.0, 8.0] | 0.0 [-8.0, 16.0] |
| shadcn-v4 | Long frame blocking | 1780 | +63.1 [-25.1, 105.9] | +6.6 [-29.4, 45.8] |
| shadcn-v4 | Load to ready | 3237 | **+140.0 [129.0, 209.0]** | **+75.0 [55.0, 84.0]** |

### 4x CPU throttling

| app | metric, ms | A median | B − A | C − A |
| --- | --- | ---: | --- | --- |
| tt-fuzzy | INP | 120 | +8.0 [0.0, 8.0] | 0.0 [0.0, 8.0] |
| tt-fuzzy | Interaction time, all steps | 200 | +8.0 [-16.0, 16.0] | -8.0 [-16.0, 8.0] |
| tt-fuzzy | Long frame blocking | 372 | **+10.7 [1.5, 22.4]** | **+9.5 [0.8, 19.7]** |
| tt-fuzzy | Load to ready | 873 | +46.0 [-42.0, 161.0] | +34.0 [-88.0, 131.0] |
| tt-virtual | INP | 1312 | 0.0 [-72.0, 32.0] | 0.0 [-32.0, 24.0] |
| tt-virtual | Interaction time, all steps | 2720 | +16.0 [-104.0, 80.0] | -8.0 [-96.0, 64.0] |
| tt-virtual | Long frame blocking | 6268 | +3.8 [-55.7, 88.5] | -4.1 [-51.5, 69.4] |
| tt-virtual | Load to ready | 3585 | +153.0 [-7.0, 362.0] | +102.0 [-13.0, 271.0] |
| excalidraw | INP | 56 | 0.0 [0.0, 0.0] | 0.0 [-8.0, 0.0] |
| excalidraw | Interaction time, all steps | 3160 | +16.0 [-8.0, 32.0] | +16.0 [-8.0, 32.0] |
| excalidraw | Long frame blocking | 445 | **-40.8 [-43.0, -39.9]** | **-33.6 [-49.6, -31.3]** |
| excalidraw | Load to ready | 1232 | +73.0 [-8.0, 118.0] | +67.0 [-13.0, 185.0] |
| shadcn-v4 | INP | 824 | 0.0 [-8.0, 8.0] | 0.0 [-8.0, 8.0] |
| shadcn-v4 | Interaction time, all steps | 5616 | +48.0 [-72.0, 96.0] | +40.0 [-80.0, 72.0] |
| shadcn-v4 | Long frame blocking | 16747 | **+730.3 [491.7, 966.9]** | **+208.0 [100.3, 404.4]** |
| shadcn-v4 | Load to ready | 13564 | **+637.0 [447.0, 949.0]** | +258.0 [-18.0, 521.0] |

### Why B and C differ on the shadcn site

C is B with the overlay on, so C should cost the same as B or more. On the shadcn site B came out
worse: 140 ms against 75 on load, 730 against 208 on blocking at 4x. The checks after the run, all
unthrottled:

- Run in the order A, C, B, B still loaded slower (+164 against +52). Not its slot in the rotation.
- With B's server given C's build, B and C matched: +75 [54, 87] and +73 [51, 87] on load, blocking
  +32 (inside the noise) and +16 [4, 50]. Not B's server or port.
- The two builds' page is the same 114 tags in the same order, and each server sends it and the 108
  scripts and stylesheets it references in the same time. Three scripts differ in their bytes: the
  library's, by the overlay flag; Turbopack's runtime, only by the library script's hashed name; and
  the site's biggest, by the random ids Next gives server actions. Only the library's differs in size.
- Loaded outside the harness, B's build reached ready about 110 ms after C's on every load. A trace
  puts the difference in React's hydration of the page, which ran 150 ms longer.
- With the overlay flag switched off in C's build, C stayed fast. Not the overlay.

So the extra time follows that one build's output, and the library code in it is the same as C's.
What in it makes hydration slower was not found. The figures to take for the library on this site
are C's, which the rerun with one build under both labels repeats.

## What the library says it spent

Its own accounting from `stats()`, median over the runs of configuration B. C's time per commit is
within 0.02 ms of B's everywhere, and its totals within 0.4 ms, except at 4x on shadcn (1.4 ms
lower) and Excalidraw (2.4 ms lower, over 14 fewer commits).

| app | pass | commits walked | `walkTotalMs` | per commit | `installMs` |
| --- | --- | ---: | ---: | ---: | ---: |
| tt-fuzzy | unthrottled | 15 | 0.8 | 0.05 | 0.5 |
| tt-fuzzy | 4x | 15 | 3.9 | 0.26 | 2.3 |
| tt-virtual | unthrottled | 5 | 1.7 | 0.34 | 0.5 |
| tt-virtual | 4x | 5 | 8.9 | 1.78 | 2.4 |
| excalidraw | unthrottled | 510 | 12.2 | 0.02 | 0.5 |
| excalidraw | 4x | 549 | 56.2 | 0.10 | 2.4 |
| shadcn-v4 | unthrottled | 58 | 4.5 | 0.08 | 0.5 |
| shadcn-v4 | 4x | 57 | 23.7 | 0.42 | 2.2 |

The walk is the part that runs inside React's commit. tt-virtual's commits are the big ones (200,000
rows behind a virtualised list), and its walk stays under 2 ms a commit at 4x.

## Bundle size

JavaScript on disk, A against B: +66 KB on each TanStack app, +97 KB on excalidraw. The overlay is a
chunk of its own in both B and C, loaded only when it is on, so C is within about a hundred bytes of
B.

On the shadcn site the figure is +5.75 MB across every chunk behind the 741 pages Next generates
at build time, which is not what one page downloads. The page the harness loads references 14.9 MB
of JavaScript in B and C against 13.7 MB in A. Most of the difference is one script, the site's
registry of component examples, which grows from 6.9 to 7.8 MB, or about 0.12 MB gzipped. That
growth is the Next plugin's loader stamping a `displayName` on each component: 8,682 stamps across
943 component names, about 108 bytes each, every one a guarded assignment that runs when the script
loads. That is the likeliest source of the load and blocking cost above, though nothing here
separates it from the rest. A page this heavy in components is the plugin's worst case, and
`enabled` at its default, `'development'`, keeps the stamps out of production builds.

## Hold these against the numbers

- **One machine, one browser.** Windows 11, AMD Ryzen 9 7900X, 32 GB, Chromium 147.0.7727.15
  headless through Playwright 1.59.1, Node 24.19.0. The machine was not otherwise in use: Steam idle
  in the tray, Windows Defender, a keep-awake shell, and an editor session that ran a unit test suite
  (a few seconds of CPU) a handful of times over the 81 minutes. Interleaving A, B and C run by run is
  what makes the deltas hold on a machine like that; the absolute medians are this machine's.
- **The TanStack examples ship React's development build.** Their Vite configs pin `NODE_ENV` to
  `development`, so those two apps run development React under `StrictMode`. Development renders
  are slower, so the library's fixed cost per commit is a smaller share there than it would be on a
  production React. Excalidraw and the shadcn site run production React.
- **Long frame blocking and load to ready cover page load too.** A cost at load is not a cost per
  interaction, and INP, the per-interaction figure, did not move.
- **15 paired runs per cell.** Enough for the intervals above; a delta of a few milliseconds on a
  figure of thousands is at the edge of what that resolves.

The harness (Playwright, the patches to each app, the report with its bootstrap) is not in this
repository yet.
