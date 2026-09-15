# react-inp-blame

Blames the React component behind a slow interaction. Prototype. Answers one question the browser cannot answer on its own: **which React
component made this interaction slow?**

The browser's Event Timing API knows an interaction was slow. Long Animation Frames know
which scripts ran and how much forced layout happened. React's fiber tree knows which
components rendered and (in dev and profiling builds) how long each took. Nothing joins
them. This does.

    264 ms click on button "Log in" in SignInPage. The click handler handleLogin ran for
    about 261 ms; React's own render was only 0 ms. A second React render landed 547 ms
    after the screen updated: 92 ms re-rendering 256 components inside ProfilePage, mostly
    PhotoTile (240 of them, 72 ms). INP doesn't count it, but people still wait for it.

## Where it's headed

The goal is for this to ship as part of Next.js, so any Next app gets component-level INP
attribution with nothing extra to install. Three things have to exist before that's a fair
ask: a displayName transform that survives Next's SWC minifier, a `next` entry that wires
`instrumentation-client.ts` for you, and a `useReportWebVitals` adapter so INP reports carry
component names. Nothing has been proposed to the Next.js team yet.

## Layout

- `packages/core` - the library (`react-inp-blame`). Zero dependencies.
- `apps/demo` - two demos in one app. The default page is a sign-in flow (Framely, an
  Instagram-style layout with its own name) with four realistic mistakes: the email field
  re-renders the phone preview, the password field scores strength on the main thread, the
  login click hashes the password before the request, and the profile grid measures itself
  while rendering. A "What took time" panel lists every step in order with a rating and one
  plain sentence. `#lab/...` holds six isolated anti-patterns, each with a "what's wrong /
  the fix" note. Playwright tests assert the tool blames the right thing in both.
  `scripts/react-matrix.mjs` generates `apps/demo-react18` and `apps/demo-react17`, the
  same demo pinned to older React.
- `apps/next-demo` - answers one question: does `instrumentation-client.ts` run before
  react-dom registers with the DevTools hook? (Yes in production; in dev Fast Refresh's hook
  stub is already there and the library chains onto it.)
- `docs/` - design notes.

Quick start:

    npm install
    npm run dev          # demo on http://localhost:5177
    npm test             # dev build: full attribution with durations
    npm run test:prod    # production build: attribution by render counts
    npm test -w apps/demo-react18   # same suite on React 18.3.1
    npm test -w apps/demo-react17   # same suite on React 17.0.2, legacy root
    npm test -w apps/next-demo      # Next.js load-order check, dev server
    npm run test:prod -w apps/next-demo   # same against next build + next start

Behind a package mirror that curates versions, `npm run fix-lock` rewrites lockfile URLs back to
the public registry before committing; the `overrides` entry pins one transitive package to a
version the mirror carries (a root devDependency, since npm ignores `overrides` for workspace dependencies).

Open the demo, record a Performance profile in Chrome DevTools, sign in: the interactions and
their React renders show up as a custom "react-inp-blame" track group. For a guided,
visible run: `INP_TOUR=1 npx playwright test tour --headed` from `apps/demo`.
