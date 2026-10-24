# Using the badge and reading reports

What the badge and panel show, the `overlay` option, development numbers and reading reports in code. The setup itself is in the [README](../README.md) and [install](install.md).

## Next.js 14.2 without next.config.ts

Next.js 14.2 reads no `next.config.ts`, since that came in 15, so there the same setup goes in
`next.config.mjs`, as plain JavaScript:

```js
// next.config.mjs
import { withInpBlame } from "react-inp-blame/next";

/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
};

// Your config first, this library's options second. They are not Next.js config keys.
export default withInpBlame(nextConfig, { runtime: { overlay: true } });
```

## What you will see

**What you will see.** Reload the page. A small dark badge sits in the corner, bottom-right by default,
and reads `INP —` until you interact. Click something slow and it shows the page's INP so far in
milliseconds: green at 200 or under, amber up to 500, red above. Click the badge for a panel of the recent
slow interactions, newest first, and click a row for the whole explanation. A click, tap or key press of
40 ms or more gets a row (the `threshold` option), so a 150 ms click has one, though the badge stays green
and the panel says Good: INP counts anything up to 200 ms as good. The demo above sets
`position: 'bottom-left'`, which is why its badge sits on the left: its own explanation column has the
right-hand side. From the demo's sign-in page, in development, this is `report.verdict`, which the row
spreads over its header and body:

    400 ms click on button "Log in" in SignInPage. The click handler handleLogin ran for
    about 399 ms; React's own render took under 1 ms. A second React render landed 295 ms
    after the screen updated: 81 ms rendering 260 components from SignInDemo down, 241 of them
    inside ProfilePage, mostly PhotoTile (240 of the 260, 72 ms). INP doesn't count it, and
    what started it can't be told.

`overlay` takes `true` (always shown), `'query'` (shown only when the URL has `?inp-blame` or
`#inp-blame`, or `localStorage` has `react-inp-blame` set to `overlay`, which is how to open it on a
production page) or `{ position, open, max }`. In a shared repo each developer can press Hide for me in
the panel, which keeps the badge off in that browser until the page is opened with `?inp-blame`, or the
repo can use `'query'` and each developer opts in with the `localStorage` line. Both snippets above are
development-only: `enabled` defaults to `'development'`, so a production build carries nothing from
either plugin until you say `enabled: true` or `enabled: 'production'`. So `vite preview` and
`next start`, which serve a production build, show no badge by default, and the build prints a line
saying it left the library out. The line on Next.js 15.3 to 16.2 stays in every build, but compiles to
nothing in the ones `enabled` leaves out.

## Numbers in development

It is a development tool first, so most numbers you see come from React's
development build, which is slower than production, and under `<StrictMode>` React renders every component
twice there. The badge rates what it measured on the same scale, marks the build `dev`, and the panel says to
check anything amber or red in a production build: add `enabled: true` and `runtime: { overlay: 'query' }`,
run `next build` and `next start` or `vite build` and `vite preview`, and open the page with `?inp-blame`
([Numbers in development](install.md#numbers-in-development)).

## Reading reports in code

If you would rather read reports than look at a badge, drop `overlay` and subscribe:

```ts
// Next.js: instrumentation-client.ts or any client module. Vite: the entry module.
import { onInteraction } from "react-inp-blame";

// A report can come again as a later revision when more data joins it: keep the latest per interactionId.
onInteraction((report) =>
  console.log(report.verdict, report.explanation.blame),
);
```

To read the whole report of the last interaction in the console, add `debugGlobal: true` to `runtime` and
run `__REACT_INP_BLAME__.last()`.
