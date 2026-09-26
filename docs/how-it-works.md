# How it works

What the library reads, when, and what that costs a page. The [terms](README.md#terms) are on the docs index.

## Clicks that land before hydration

Every App Router page is server-rendered, so a click can land on HTML React has not hydrated yet. The
browser reports a slow click, React DevTools shows nothing, and the element has no fiber to be named
after. When the library can see which piece of server-rendered HTML the click landed on,
`report.hydration` says so and which of the two things happened:

```ts
hydration: { kind: 'waited' | 'not-hydrated'; scope: 'root' | 'boundary';
             owner: string | null; ms: number | null } | null
```

**React hydrated it inside the click** (`kind: 'waited'`). On React 18 and 19 a discrete event that lands
on a boundary waiting to hydrate makes React hydrate that boundary synchronously, inside the event's own
dispatch, before the event reaches any handler. That wait is working time, and the report names it:

> 264 ms click on button "Add to cart". The click landed on server-rendered HTML that had not been
> hydrated yet, so React hydrated the Suspense boundary in ProductPage first: 208 ms of the 236 ms of
> working time.

`blame.kind` is then `'hydration'` and `blame.name` is the boundary. The hydrating time is a named part of
the `Working` phase (`phases[1].parts`), not a fourth phase beside it, so the three phases go on adding up
to the interaction. A hydration too small to be the story keeps `report.hydration` and its place in the
phase bar but leaves the blame where it belongs, with a note beside it: 8 ms of hydrating in front of a
400 ms handler is not why the click was slow. Under 5 ms, where React's own render is too small for this
library to call it the story at all, only `report.hydration` and the note say it happened.

**It was still waiting** (`kind: 'not-hydrated'`). React 18 and 19 stop the propagation of a discrete event
they could not unblock instead of dispatching it, so no React handler runs. Almost no working time goes by,
so the blame stays on where the time actually went, and the hydration leads the sentence:

> This click landed on server-rendered HTML that React had not hydrated yet, so React did not dispatch it
> and no React handler ran for it. The click waited 380 ms before its handler could start: the main thread
> was busy with something else.

A Suspense boundary has no name of its own, so `owner` is the nearest component holding it; write that
boundary inside a client component if you want a name you recognise. `scope: 'root'` is a whole root that
had not hydrated, which has no component above it and reads as "the page".

**What it does not say.** A click that lands before `hydrateRoot` has run at all: nothing on the page
carries a mark of React yet, so there is nothing to read and `report.hydration` is `null`. A boundary React gave up on and rendered on the client instead, where the
server HTML the click landed on was thrown away: that is not a hydration and is not reported as one.
Whether the element had a handler at all, which is why the sentence says no React handler ran rather than
that a click was lost.

In a production build React records no render durations, so `ms` is `null`: which boundary hydrated, and
how many components it took, are measured; how long it took is not. `next build --profile` gives the
durations back. React 17 is left out altogether: it has no dehydrated Suspense state, and the one hydration
flag it keeps is cleared before it calls the hook, so nothing there is ever reported as a hydration.

## The INP estimate

`inp()` and the badge estimate INP the way web-vitals' `onINP` does, without depending on web-vitals: each
interaction's latency is its longest Event Timing entry, and INP is the one at index
`min(floor(count / 50), n - 1)` among the `n` longest it kept, `n` at most 10, chosen as entries arrive
and again when the page is hidden, the two moments web-vitals chooses at. It starts over at each soft
navigation and back/forward cache restore, and after one of those, interactions the browser counted but no
entry was sent for read as the same 8 ms web-vitals reports for them. `apps/demo/e2e/inp.spec.ts` runs
web-vitals 6.2.2's `onINP` in the same page (`reportAllChanges`, `durationThreshold: 16`) through more
than 50 interactions and asserts after
each that both name the same value and the same interaction. That is one session, not a promise: this is the
same algorithm written again from the same entries, and it is not web-vitals. The two part at the default 40 ms
threshold, which `useReportWebVitals` keeps, when INP is under 40 ms or too few interactions reach it; at a
soft navigation; after `clear()`; for a moment after each interaction, while web-vitals waits for an idle
page; and against the older web-vitals that Next.js 16.3 vendors, which keeps counting every interaction
since the page loaded after a back/forward cache restore.

## What it reads from React

These are React internals with no promise of stability, so the library checks them and fails closed: a
react-dom outside 17 to 19, a first `root.current` of another shape, or a walk that throws stops that
react-dom being read, for good, with one warning and `stats().unsupportedReason`. The page is only
`stats().mode === 'unsupported'` when no react-dom on it can be read, so an embedded widget that brought
its own React does not switch off the app's own. Reports carry on without components.

- `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`: created with `inject`, `onCommitFiberRoot`,
  `onPostCommitFiberRoot`, `renderers`, `supportsFiber` and a `reactInpBlame` marker, or, when one exists,
  those three methods wrapped and its `renderers`, `isDisabled` and `supportsFiber` read.
- What react-dom hands `inject()`: `version`, `bundleType`, `rendererPackageName`. What React passes
  `onCommitFiberRoot`: the renderer id, the root, the priority and `didError`.
- On the root: `current`, and `pendingLanes`, the bits of the updates React has not committed yet. They say
  which commits the page's own report listeners caused while they ran, so a panel that shows reports is not
  read as part of one. An update a listener defers to a later task is an ordinary render and is read like
  any other. Also `containerInfo`, the node the root was created on, for its `localName`: a root on a
  `<nextjs-portal>` element is Next.js's dev overlay under `next dev`, and its commits are not read.
- On fibers: `tag` (components are 0, 1, 11, 14 and 15; the root is 3, a Suspense boundary 13, an Activity
  boundary 31 on React 19, and 18 is the DehydratedFragment React deletes when it gives up hydrating a boundary),
  `flags` (the `PerformedWork` bit, 1; on the root `ForceClientRender`, 256, which says React threw its server
  HTML away; and `Hydrating`, 4096, on the child of a boundary whose hydration has rendered but not
  committed), `mode` (the `ProfileMode` bit: 8 on React 17, 2 on 18 and 19), `child`, `sibling`, `return`,
  `alternate` (the same `child` there means the fiber bailed out), `deletions` (only on a Suspense or Activity
  boundary, to tell one React hydrated from one it rendered on the client), `actualDuration`, `elementType`
  and `type` (for names: `displayName` or `name`, through `render` for forwardRef and `type` for memo; on a
  DOM element's fiber, its tag name), `memoizedProps` (the event's handler prop, such as `onClick`, and a
  form control's `type`), `memoizedState` (whether a root or a boundary was still server-rendered HTML:
  `isDehydrated` and `dehydrated`), and the root fiber's `stateNode`, the FiberRoot, to reach its `current`.
- On DOM nodes: React's `__reactFiber$` key, and `__reactContainer$` on the element `createRoot` or
  `hydrateRoot` was given. In server-rendered HTML: the comments React puts around a boundary, `$`, `$?`,
  `$!`, `$~` and `&` opening it and `/$` and `/&` closing it.

Supported: react-dom 17, 18 and 19; only react-dom commits are walked. CI runs the demo's suites on React 19.3
in development and production builds, its attribution, input-delay and ambient specs on React 19.2.8, 19.1.9,
19.0.0, 18.3.1, 18.2.0 and 17.0.2 (legacy root), and the Next.js check on 16.3.5 under `next dev` and both production bundlers,
on 16.2.12, 15.5.26 and 15.3.9 through the `instrumentation-client` line, and on `next@canary`, whose App Router
brings a React canary, on every push and once a day, in a job that fails the daily run when it breaks but
never a push or a pull request. It also installs the package as
packed for npm into apps with no peers, with Next.js 15, with Next.js 16.3.5 and with Vite 5, on Node 20.19, the
oldest its `engines` allows, and imports and requires every subpath there; the canary job installs it beside
`next@canary` as well. No job runs `react@canary` alone. One more
job puts the packed package into an app made the way `npm create vite` makes one, on Vite 8.3 with
@vitejs/plugin-react 6.1 and the Vite setup above, and checks that a click there is blamed on the component
that rendered slowly, on the dev server with a Fast Refresh edit included and in a production build. Three
more check the same click, with no Fast Refresh edit, in the apps `npx create-react-router`, TanStack
Start's CLI and `npm create astro` make, each with its setup above, and a fifth in React Router 7's app
moved to React 18. The create-vite app, and a Next.js 14.2 app with both routers, are installed with pnpm
as well, into the isolated `node_modules` pnpm makes by default, and checked the same way.

For component libraries, CI builds the Vite app with styled-components, @emotion/styled, lucide-react and
Radix's DropdownMenu, on the dev server and in production. That covers the Radix primitives shadcn/ui's Radix
styles wrap, used directly rather than through shadcn's generated files. shadcn/ui now starts a project on
Base UI, and no job builds Base UI or a shadcn project of either style.

## Time per interaction

Measured 2026-09-15 on 7917366 in the demo's context storm (a click re-rendering 801 components) and big list
(a keystroke re-rendering 1441), in Chromium 147 headless on an otherwise idle Windows PC: 30 fresh page loads
per scenario, one interaction each, `walkBudget: 100000`, taken
[as the design notes describe](interaction-attribution-design.md#what-it-costs). p50 / p95 in ms:

| | Context storm, production | Big list, production | Context storm, development | Big list, development |
| --- | --- | --- | --- | --- |
| `install()`, both calls the demo makes | 0.5 / 0.6 | 0.5 / 0.7 | 0.6 / 0.7 | 0.6 / 0.8 |
| Walk of the commits joined to the report | 0.8 / 0.9 | 1.2 / 1.4 | 0.9 / 1.3 | 2.9 / 3.2 |
| Event Timing callback, the page's listeners included | 1.0 / 1.2 | 1.0 / 1.2 | 1.1 / 1.4 | 1.1 / 1.4 |
| Library time outside the walks (`stats().reportTotalMs`) | 0.9 / 1.2 | 1.0 / 1.3 | 0.8 / 1.1 | 0.9 / 1.2 |
| `overheadMs` of the report | 1.3 / 1.5 | 1.7 / 1.9 | 1.5 / 1.9 | 3.4 / 3.8 |

On the same machine with other processes at 15 to 49% CPU, the same commit read 1.1 to 1.6 times these p50s.
The walk runs inside React's commit and its time is taken back out of `processing`; outside an interaction a
commit costs a renderer lookup and one subtraction, and at the default `walkBudget` of 5000 neither scenario is
cut short.
