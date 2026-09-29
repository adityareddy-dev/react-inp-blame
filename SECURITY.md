# Security

## Reporting a vulnerability

Please do not report a security problem in a public issue. Email adityareddy.dev@gmail.com, the
address in the `author` field of `packages/core/package.json`, with:

- what the problem is and what an attacker could do with it,
- the version or commit it affects,
- the steps, or a page, that reproduce it.

You will get a reply within 7 days saying whether the problem is confirmed and what happens next. A
confirmed problem is fixed in a release before it is described in public, and the report is credited
in that release's notes unless you ask for it not to be.

## Versions

Security fixes go into the latest minor release, and into the minor before it for 90 days after the
latest came out. Once 2.0.0 is out, the last 1.x minor counts as the one before it. Other fixes go
into the latest release only.

## What it touches

What the library reads, changes and keeps on a page, and what can leave it. This covers `install()`,
`react-inp-blame/auto` and the runtime the Next.js, Vite and Astro setups add. A production build
those setups leave it out of, which is their default, gets none of it.

### What it reads

- **React, through its DevTools hook.** It wraps `inject`, `onCommitFiberRoot` and
  `onPostCommitFiberRoot` on `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`, or defines a small hook there
  when none exists and `hook` allows it. From each react-dom that registers it reads the version,
  the build type and the package name. After each commit it walks the fibers React committed:
  component types and names, render times, the links between fibers, hydration state, and a few
  props, to find the handler that ran and name what was clicked. From those props it keeps names
  only, a component's or a handler function's, never a value.
- **React's marks on the page.** It reads the `__reactFiber$`, `__reactProps$` and
  `__reactContainer$` properties React puts on DOM elements, to go from an element to its component,
  and the comments React leaves around Suspense boundaries in server-rendered HTML. While no
  react-dom has registered, it looks through up to 10,000 of the page's elements for those
  properties, at most seven times in all, to tell an install that ran too late from a page without
  React.
- **The browser's timings.** Event Timing entries of 16 ms and longer, and `first-input`. Where the
  browser has Long Animation Frames (Chromium), each frame's timings and each script's invoker,
  function name, file and forced layout. A URL there loses any password, query and fragment, and a
  script's file keeps only the last two parts of its path. The document's navigation entry, for its
  type and URL.
- **Input events.** Listeners on `window`, in the capture phase, for `pointerdown`, `pointerup`,
  `click`, `keydown`, `keyup`, `keypress`, `input`, `change`, `submit` and `resize`, all passive,
  and for `pageshow` and `visibilitychange`. From an event it reads the type, the time, whether it
  was trusted, the target, `pointerType` and `pointerId`, and for a key the `code`, which names the
  physical key, and `keyCode`, only to tell a key an input method is composing with. It never keeps
  the character typed. During a React commit it reads `window.event`, to tell which input the commit
  belongs to. It never reads a form field's value.
- **Elements, for a report's label and selector.** The tag, `id`, `data-test` or `data-testid`, up
  to two classes, the ARIA `role` that finds the control around the element, `aria-label`, and for a
  form field its `placeholder`, `aria-placeholder`, `name` and an input's `type`. An element's first
  run of text, and a form field's `<label>`, only where `labels` is `'text'`, which `'auto'` means
  only under a development build of React. A name is cut to 40 characters.
- **URLs.** The document's, and each one a router announces (`announceNavigation`, or the App Router
  through `react-inp-blame/next`). A report keeps their origin and path, never a query, fragment or
  password.
- **Other.** `navigator.userAgent`, to find Chrome 134 and later, which draws Performance panel
  tracks through `console.timeStamp`. `localStorage`, for the badge's two keys below.

### What it changes

- **The DevTools hook, and nothing else of the page's.** On a hook that exists it wraps the three
  methods, and `dispose()` puts them back. Where none exists it defines
  `__REACT_DEVTOOLS_GLOBAL_HOOK__` on `window` with a getter and a setter, not enumerable, so a tool
  that assigns its own hook later is noticed. React DevTools loading after that hook will not
  install over it, which `hook: 'chain'` avoids. A hook it defined stays after `dispose()`, since
  React keeps calling it, and stops reading.
- It patches no prototype, and not `fetch`, `XMLHttpRequest`, `history` or `console`.
- **The badge and panel**, only when `overlay` or `mountOverlay()` asks for them: one element with
  the id `react-inp-blame` at the end of `<body>`, holding an open shadow root, and a `keydown`
  listener on `document` that closes the panel on Escape.
- **Globals.** Its state is on `globalThis` under `Symbol.for('react-inp-blame')`, shared by every
  copy of the library on the page. With `debugGlobal` the API is on `window` too, as
  `__REACT_INP_BLAME__` or the name given.

### What it keeps

In memory, until `dispose()`, `clear()` or the page unloads, and every list capped:

- the last 300 commits walked,
- the last 8 inputs, with their target elements,
- 50 published reports, plus the ten slowest and any the INP estimate can still point at,
- 20 quick interactions a later render could still make worth reporting,
- the raw Event Timing entries of the last 100 interactions,
- 60 Long Animation Frames entries and 20 navigations.

A report holds plain data, never an element.

In `localStorage`, two keys, set only when someone uses the badge. `react-inp-blame` is `hidden`
after Hide for me, until `?inp-blame` or `#inp-blame` in the URL removes it. The library also reads
it as `overlay`, which a person sets by hand to open the badge on a production page.
`react-inp-blame:overlay` is `open` or `closed`, how the panel was left. No cookie, `sessionStorage`
or IndexedDB.

### What can leave the page

The library sends nothing. It makes no network request, apart from loading its own badge and panel
code by dynamic import when the badge is shown, from wherever the app's build put it. It sets no
cookie.

A report leaves only through code the app runs: an `onInteraction` listener, `reports()` and
`last()`, the `react` object `attributeINP` adds, `generateTarget`'s string (component names and the
element's selector), and the `react-inp-blame/otel` attributes. What your code wrote goes out as
written. An `aria-label`, a `data-testid`, an `id` or a component name built from user data lands in
`target.label`, `target.selector` or a blame's name, and so does an element id in a script's invoker
(`DIV#root.onclick`). Any script on the page can reach the reports, through `debugGlobal` or the
shared state, as it can reach the page itself.

Two things reach other code on the page without the app asking:

- **User Timing measures.** Under a development build of React, or under any build with
  `devtoolsTrack: true`, each report becomes a `performance.measure()`. Its name holds the headline
  and a component, and its `detail` holds the verdict, where it happened and the heaviest component
  path. It leaves the buffer at once, but every `PerformanceObserver` on the page gets it first, a
  monitoring script's included. `devtoolsTrack: false` turns it off.
- **The console.** A warning at most once per page for each problem, and an error of the library's
  own with its stack.

### What a production build turns on

- The Next.js wrapper, the Vite plugin and the Astro integration leave the library out of a
  production build unless `enabled` is `'production'` or `true`. `react-inp-blame/auto` and
  `install()` run in whatever build imports them.
- Under a production build of React the defaults hold back: labels read attributes only, nothing is
  drawn in the Performance panel, and there is no badge unless `overlay` asks for one. `sampleRate`,
  in any build, decides which page loads install at all.
- The plugins' `displayName` transform writes each of your components' names into the shipped code,
  so they survive minification. Anyone who reads the bundle can read them. `runtime: false` keeps
  the transform without the runtime.

### Content Security Policy

- No `eval`, no `new Function`, no inline event handlers and no HTML strings. The badge is built
  from elements and text nodes, and the library creates no Trusted Types policy, so
  `require-trusted-types-for 'script'` needs nothing.
- The badge's styles are a constructed stylesheet adopted by its shadow root, which `style-src` does
  not govern. Safari before 16.4 gets a `<style>` element instead, which needs `'unsafe-inline'` in
  `style-src` there.
- The badge's code loads by dynamic import from the app's own build output, so `script-src` needs
  what the app's own chunks need.
- On Vite the install is a module script the plugin adds to each page, inline in development and a
  `src` script in a build, and `html.cspNonce` puts the nonce on it. With `entry` set it is an
  import in the app's own module instead. Next.js and Astro bundle the install into the app's own
  code, so it needs nothing more.

## What counts

The library runs inside every page it is installed on, before the app, and its plugins change how
that app is built. Problems in scope include, for example:

- page content that gets the badge and panel, or anything else in the library, to run script;
- a report carrying something the documentation says it never reads, such as a form field's value,
  or an element's text under `labels: 'attributes'`;
- `react-inp-blame/next` or `react-inp-blame/vite` changing a build in a way their documentation does
  not describe.

A slow interaction the library misattributes is a bug, not a vulnerability: open an issue for it.
