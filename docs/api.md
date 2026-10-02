# API

```ts
import { onInteraction } from 'react-inp-blame';
// explanation.blame.kind and explanation.rating are data, verdict is display text.
const stop = onInteraction((report) => console.log(report.explanation.blame, report.verdict));
```

`onInteraction(fn)` is the one way to hear reports: `fn` gets each report, and every later revision of it,
in a task after the one that published it, and the call returns the unsubscribe. What is still waiting when
the page is hidden is heard inside that `visibilitychange` instead, so a page that sends what it heard on
`visibilitychange` sends it all; one that sends on `pagehide`, which comes first, can miss the last. A
panel that renders what it hears is safe, because the update a listener makes while it runs is never read
as part of an interaction. An update it schedules for later, with setTimeout or an await, is an ordinary
render. A listener that throws does not stop the others hearing the report, and its error goes to
`reportError`, where the page's error handlers and error monitoring see it. The package's types document
every field.

## install(options)

It has to run before react-dom loads, which the plugins and `/auto` see to, and it installs once per page. A
later call, from any copy of the package, returns the same API and applies `overlay`; other options keep
their first value, with a warning, until `dispose()`.

| Option | Default | |
| --- | --- | --- |
| `overlay` | `false` | `true`, `'query'` or `{ position, open, max }` |
| `threshold` | `40` | Report interactions from this many ms; shorter ones only when a heavy later render INP leaves out joins them |
| `labels` | `'auto'` | Where `target.label` comes from: see [Labels and personal data](#labels-and-personal-data) |
| `hook` | `'auto'` | `'chain'` wraps an existing `__REACT_DEVTOOLS_GLOBAL_HOOK__` and never creates one; `'shim'` creates one unless one exists; `'auto'` chains or creates |
| `sampleRate` | `1` | Share of page loads that install anything; in a production build, also of the pages that [warn about a browser without Event Timing](troubleshooting.md#unsupported-browser) |
| `walkBudget` | `5000` | Component fibers React rendered or passed through, per commit; one it only cloned and skipped does not count. A commit past it is reported as partial: its counts say "at least", and its blame's detail says the rest was not walked, unless the commit's useEffect callbacks lead it. Its sentence says so too in a production build and wherever the walk could not tell where the render started (a development or profiling build that could tell has the note that the count is partial). In a production build, which has only counts to go on, the blame names the component the render started at where one rendered at the top, holds everything the walk reached and nothing it did not reach rendered beside it, and otherwise the app, with the sentence saying it could not tell where the render started, rather than the subtree the walk reached first or a component the subtrees only sit under. A development or profiling build names the app the same way where the part the walk did not reach took longer than the heaviest part it did, by React's own total for the render, which is the commit's `total` for any walk cut at the budget on a root React timed. Each commit's `pathStart` says which |
| `inputWindow` | `1500` | A commit outside any input's dispatch is walked only within this many ms of the end of the last commit inside the newest input's dispatch, or of the input where there was none; commits inside an input's own dispatch are always walked. It also bounds `followUps`, whose window runs from the paint as a rule |
| `devtoolsTrack` | `'auto'` | Draw each report in Chrome's Performance panel, in an "Interaction blame" track. `'auto'` draws it only under a development build of React, since any script on the page can read each entry, verdict and label included, through a `PerformanceObserver`; `true` draws it under production and profiling builds too. The entries' names, tooltips and properties are display text |
| `debugGlobal` | `false` | `true` puts the API on `window.__REACT_INP_BLAME__`; a string names the property |

The API has `reports()` (up to 50 published, oldest first, at their latest revision; past 50 the oldest
goes, but never one of the ten slowest or one INP can still point at), `last()`, `inp()`
(`{ value, rating, interactionId, interactionCount, report }` for this navigation, or null, with clicks,
taps and key presses on [the badge and panel](#the-badge-and-panel) left out of it and of its count,
though Chrome's own INP and web-vitals count them), `onInteraction(fn)`, `clear()` (drops reports and
commits, and starts the INP estimate over, though in WebKit a key press on the panel's Clear stays in the new
count, since WebKit counts it at the keyup, after the clear), `dispose()` and `stats()`: `mode` (`'shim'`,
`'chained'`, `'none'`, `'unsupported'` or `'sampled-out'`), `unsupportedReason`, `react` (`'reading'`,
`'waiting'` while React has not rendered on the page, `'installed-late'` when it has and no react-dom
registered because install() ran after react-dom loaded, or `'unreadable'`), `walks`, and the library's own
time in `walkTotalMs`, `reportTotalMs` and `installMs`. `debug.commits()` and `debug.hook()` are for debugging
and may change in any version. Also exported: [`mountOverlay`](#the-badge-and-panel) and
[`announceNavigation`](#announcenavigationurl). Under the `react-server` condition every export does nothing,
here and on [`react-inp-blame/web-vitals`](web-vitals.md): `generateTarget` returns `undefined` and
`attributeINP` returns `{ react: null }`.

## announceNavigation(url)

Tells the library that your router changed the route in the page, to `url`. Reports of the interactions that
begin after it carry that URL's origin and path in `navigationURL`, with `navigationType: 'soft-navigation'`,
and `inp()` and the badge start over. Called while a click or key press is being dispatched, it is named on
that interaction's report in `startedNavigation`, always with `type: 'push'`. Since reports keep a URL's origin
and path only, a navigation that changes only the query or the hash still counts as one: `inp()` starts over,
and `startedNavigation.url` is the same as the report's `navigationURL`. The URL may be relative to the page,
and should include any base path. From a React effect, call it in `useLayoutEffect`: a `useEffect` can
run later, inside the next click, and name that click as the one that started the navigation. It does nothing
before `install()`, on a page the sample left out, in a production build the plugin left the library out of,
on the server and under `react-server`, and it never throws. Under the Next.js App Router `withInpBlame`
already announces each navigation, so do not call it there.
[Install with React Router](install.md#install-with-react-router) and
[Install with TanStack Start](install.md#install-with-tanstack-start) show where to call it.

## InteractionReport

```ts
interface InteractionReport {
  schemaVersion: 4; interactionId: number; revision: number; type: string; // 'click', 'keydown', ...
  pointerType: string | null;                            // 'mouse', 'pen' or 'touch' for a pointer's event
  reactStatus: 'reading' | 'waiting' | 'installed-late' | 'unreadable'; // stats().react as it was built
  reactBuild: 'development' | 'production' | 'profiling' | null; // development numbers run high: drop or label them
  strictMode: boolean | null;                            // whether StrictMode rendered it, null outside a development build
  start: number; end: number; duration: number; holdMs: number;             // ms, performance.now() clock
  inputDelay: number; processing: number; walkMs: number; presentation: number; // add up to duration
  nextInput: { type: string; pointerType: string | null; start: number; endedAt: number | null } | null; // next press before the paint
  target: TargetInfo | null; entries: EventEntrySummary[]; // target: selector, label, component, owners, handler
  hydration: { kind: 'waited' | 'not-hydrated'; scope: 'root' | 'boundary';   // server-rendered HTML the click
               owner: string | null; ms: number | null } | null;            // landed on before React hydrated it
  navigationURL: string; navigationType: NavigationType; // web-vitals' names, the URL's origin and path only
  startedNavigation: { url: string; type: 'push' | 'replace' | 'traverse' } | null;
  commits: CommitSummary[]; followUps: CommitSummary[];   // before the paint; after it, or after a key press's paint, within inputWindow
  unjoinedCommits: number;                               // commits in its handlers that could not be tied to it
  frames: FrameSummary[] | null; laterFrames: FrameSummary[] | null; // null without Long Animation Frames
  overheadMs: number;                                    // this library's own time on the interaction
  explanation: {
    blame: { kind: 'render' | 'handler' | 'hydration' | 'layout' | 'waiting' | 'painting' | 'script' | 'none';
             name: string | null; detail: string | null; ms: number | null;
             confidence: 'measured' | 'inferred' };
    rating: 'good' | 'needs-improvement' | 'poor';
    phases: { label: string; ms: number; hint: string; parts?: Phase[] }[]; // parts: named pieces of a phase
    headline: string; where: string | null; cause: string; notes: string[];
  };
  verdict: string;
}
```

Each commit in `commits` and `followUps` says where its `hotPath` starts, as the walk found it, in `pathStart`.
`'only-root'`: the walk found one component where this render started, and the path starts at it.
`'heaviest-root'`: the walk found several components where renders started, and the path starts at the
heaviest one it reached. `roots` has up to five of their names. `'unknown-root'`: the walk reached components
that rendered but stopped before it could tell which one held the render (in production at walkBudget, in a
development or profiling build when React's own total shows more of the render went unreached than the
heaviest start it reached), so the path starts at the nearest component they all sit under, or is empty when
they share none. `'no-root'`: the walk reached no component that rendered, either because the commit rendered
none or because it stopped first (then `truncated` is true). hotPath is empty and `rendered` is 0. It is
absent only on a report from before 0.21.0 (0.20.0 and 0.21.0 share schemaVersion 4). These four are all
there are in 1.x. A render blame built on a commit whose `pathStart` is `'unknown-root'` or `'no-root'` is
named `'the app'`.

`target.handler` is the name of the function on the element's event prop, or the prop's own name when that
function has no name worth printing. An inline `onClick={() => ...}` therefore reads as `onClick`, and so
does a handler the minifier renamed. Naming the function helps on the dev server only: a production build's
minifier renames `handleLogin` like any other function, so there it reads as `onClick` whatever you called
it, unless the build keeps function names (terser's `keep_fnames`, esbuild's `keepNames`), which costs bundle
size. The names loader stamps components, not handlers. In production, `target.component` and the prop are
what say where to look. Under React
Compiler, a handler declared as `const handleLogin = () => ...` becomes an alias of a temporary named `t0`
and is named by its prop, while a `function handleLogin()` keeps its name; a handler Radix composed is named
by its prop too, since every one it wraps is called `handleEvent`. When a click's events ran handlers of
their own, the handler named is the one whose event took longest, so a menu that opens on pointerdown is
put on its `onPointerDown`, not on an `onClick` that did nothing.

`target.component` is the nearest component enclosing the element whose name a reader could search their own
code for: one React would accept as a component name (capitalised), that a minifier has not cut down to a
letter or two, and whose every dotted part is the same, so a design system's `Primitive.button` gives way to
the `TabsTrigger` above it. Through `react-inp-blame/next`, next/link's `LinkComponent` gives way to the
component above it where that is not Next.js's own, so a link a client component or a Pages Router page wrote
names that component; one a server component wrote directly still says `LinkComponent`. When the click landed on
an icon, an `<svg>` or something in one, an `<img>` or a
`<picture>`, the chain starts from what the icon belongs to in the tree React rendered: above every component
that renders nothing but the icon (an icon library's `Trash2` and the `Icon` under it), at the control around
it, at an element with a click handler of its own (a thumbnail's `<img onClick>`), or at the first element or
component that renders something beside it. A handler the icon was handed by the components that render
nothing but it is their caller's: `<Trash2 onClick>` names the component that wrote it. So a click on an
icon library's
`<svg>` inside a button names the component that renders the button, not the icon, an icon beside a name in
an option names the option's component, and a card's photo inside a link names the card. Anywhere else the
chain starts from the element itself. `target.owners` keeps the chain's eight innermost components, nearest
first, whatever the names are, and `component` is picked from those eight: where nothing in them passes, it is
the innermost owner as it always was.

`explanation.blame.kind` says where the time mostly went, and these eight are all there are in 1.x. `'render'`
is React rendering and committing for this input, charged to a subtree. `'handler'` is the input's own event
handlers, named after the handler. `'hydration'` is React hydrating the server-rendered HTML the input landed
on. `'layout'` is style and layout the browser recalculated inside the handlers. `'waiting'` is the input
waiting for the main thread, before its first handler or between handlers. `'painting'` is the screen update
after the handlers. `'script'` is a script Long Animation Frames recorded while the interaction ran, named
after what ran it. `'none'` is nothing that stood out, or nothing that could be seen. A slow event listener is
both a handler and a script, and which of the two a report says can change in a minor. `blame.name` is what
the time is charged to: a subtree that re-rendered, a handler that ran, what ran a script as the browser names
it, or the boundary that was hydrated, and null when unknown. Which of them a report names can change in a
minor as the reading gets better. `blame.detail` is display text, like the headline.

`duration` is the longest single Event Timing entry, as web-vitals measures it; `holdMs` is how much longer
the span from press to release ran. Reports are frozen: a late entry, frame or render that joins one reaches
listeners as a new object with `revision` one higher, and `schemaVersion` changes when a field is removed or
changes meaning. **`verdict`, `cause`, `notes`, `headline`, `where`, `blame.detail` and the phases' `label`
and `hint` are display text that may change between versions**: show them, never parse them. The blame's
`kind`, `name`, `ms` and `confidence`, the rating, the phases' `ms` and the report's numbers are the data.
`confidence` is `'measured'` when the blame follows from this interaction's own timings, and `'inferred'` when
it rests on render counts, a clock too coarse to time one component, a commit that only overlapped, a walk cut
short, or no Long Animation Frames to rule other scripts out. A screen update blamed with
"the frame waited on the next key press" is still the screen update's own time, measured. That clause rests on
the next press's timings instead (`nextInput`), so it is only said where the page worked on that press before
the paint for half the screen update or more, and it says "most likely" unless a long animation frame over
this interaction recorded a script that shows it, from that press's own listener on (`onkeydown`,
`onpointerdown`, or one for an event the press dispatches), the way a wait's is named. With none of that
press's listeners recorded, a script that started after both that press and this interaction's handlers counts
where the screen update was over 100 ms, and under that only the press's render says it, hedged.

## Fixed sets of strings

These fields take one of a fixed set of strings, and each set stays as it is through 1.x. A new value comes
only in 2.0.0, so code that switches on one of them, or a dashboard that groups by it, never meets a value
missing from this list.

- `explanation.blame.kind`: `'render'`, `'handler'`, `'hydration'`, `'layout'`, `'waiting'`, `'painting'`,
  `'script'`, `'none'`
- `explanation.blame.confidence`: `'measured'`, `'inferred'`
- `explanation.rating` (`Rating`): `'good'`, `'needs-improvement'`, `'poor'`
- `reactStatus` and `stats().react` (`ReactStatus`): `'reading'`, `'waiting'`, `'installed-late'`,
  `'unreadable'`
- `reactBuild`: `'development'`, `'production'`, `'profiling'`, or null
- `navigationType` (`NavigationType`): `'navigate'`, `'reload'`, `'back-forward'`, `'back-forward-cache'`,
  `'prerender'`, `'restore'`, `'soft-navigation'`
- `startedNavigation.type`: `'push'`, `'replace'`, `'traverse'`
- `hydration.kind`: `'waited'`, `'not-hydrated'`
- `hydration.scope`, and `hydratedTarget.scope` on each of `commits` and `followUps`: `'root'`, `'boundary'`
- `joinedBy` on each of `commits` and `followUps` (`CommitSummary`): `'exact'`, `'overlap'`
- `pathStart` on each of `commits` and `followUps` (`CommitSummary`): `'only-root'`, `'heaviest-root'`,
  `'unknown-root'`, `'no-root'`
- `stats().mode`: `'shim'`, `'chained'`, `'none'`, `'unsupported'`, `'sampled-out'`
- `stats().unsupportedReason.kind` (`UnsupportedReason`): `'browser'`, `'another-copy'`, `'hook-disabled'`,
  `'react-version'`, `'fiber-shape'`, `'walk-threw'`

The same sets hold on the `react` object that [`react-inp-blame/web-vitals`](web-vitals.md)' `attributeINP`
adds, in its `blame.kind`, `blame.confidence` and `reactBuild`.

`navigationType` has the values of web-vitals' own `navigationType`, so the two line up, but the set is this
library's. The document's own load takes it from the browser's navigation entry, or `'prerender'` and
`'restore'` for a page that was prerendered or discarded and loaded again, a soft navigation from the router
or `announceNavigation`, and `'back-forward-cache'` from the page's `pageshow`. A navigation type a browser
adds later reads as `'navigate'` until 2.0.0.

`startedNavigation.type` is the router's word for the navigation, and `announceNavigation` always gives
`'push'`. A type the Next.js App Router passes that is none of these three reads as `'push'` too.

`pointerType` is not on the list. It is the browser's own string, passed on as the event gave it: browsers
give `'mouse'`, `'pen'` and `'touch'`, and a value a browser adds later would come through as it is. An empty
string reads as null.

`blame.name` is free text with one fixed value: `'the app'`, which a render or layout blame takes where its
commit's walk gave no component to name it after, as when the walk could not tell where the render started.
That value stays the same through 1.x, and the commit's `pathStart` says why there was none.

## Labels and personal data

`target.label` names the element by its tag and a name of at most 40 characters, and never reads a form
field's value or an element's whole text. It is read as the input is dispatched, before your handlers run, so
a click on a button reading "Count is 0" is labelled that, not with the "Count is 1" it then shows. A click
that lands inside a control is labelled by that control, tag and name included: the first of the element and
its five nearest ancestors that is a `button`, a link, `summary`, `label`, `input`, `select` or `textarea`, or
has the ARIA role `button`, `link`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `tab`, `option`,
`checkbox`, `radio` or `switch`. A click on the `path` of an icon button reads `button "Close"`, not `path`,
and `target.selector` stays the element the browser reported. Under a production build of React the label uses
only what your code wrote on the element: `aria-label`, a form field's `placeholder`, `aria-placeholder` or
`name`, an input's `type`, or `data-testid` or `data-test`. An element's text can be a person's name or email,
and reports are made to be forwarded to error trackers and analytics, so text is opt-in there: with
`install({ labels: 'text' })` a form field with no `aria-label` is named by the text of its `<label>` before
the attributes above, and any other element with no `aria-label` by its first run of text. An element inside a
`contenteditable` editor, or inside one with the role `textbox`, `searchbox`, `combobox` or `spinbutton`,
counts as a form field, and so does an element an `EditContext` is attached to, or one up to five elements
inside it. The search for that first run of text never goes into any of them, or into a `textarea` or a
`select`'s options. An editor that draws its text in ordinary elements and takes key presses in a hidden one,
as Monaco does, cannot be told from the rest of the page, so a click on that text can be named by it.
Development builds use text by default. What each `labels` value may read is fixed for 1.x, though the words a
label comes out with, and which source wins, can change in a minor. Whatever `labels` says, `target.selector`
has the tag, the `id` if there is one, and `data-test` or `data-testid` or else two classes, and
`navigationURL` and `startedNavigation.url` keep a URL's origin and path, never its query, fragment or
password. A script the browser names by its URL, or by the page's for an inline script, loses any password,
query or fragment in a blame's `name`, the sentences and `frames`. What your code wrote goes out as written,
though: an `aria-label`, `data-testid` or `id` built from user data, such as
`` aria-label={`Message ${user.name}`} ``, lands in `target.label` or `target.selector`, and the label in the
verdict. A listener the browser names by its element goes in a blame's `name` the same way, the `id` as
written (`DIV#root.onclick`), or on an element with no id the path of its `src`
(`IMG[src="/avatars/jane.png"].onload`), so an id or a path built from user data lands there too.

## The badge and panel

`overlay: true`, in `runtime` or `install()`, shows a corner badge with the page's INP so far, green, amber or
red. Click it for the recent slow interactions, newest first, each with what to blame and a bar split into
waiting, working and updating the screen; a row opens into the full explanation and the components that
rendered before and after the paint. Rows under 200 ms that blame nothing fold into one line, "12 quick
interactions, nothing to fix", that opens on a click. `overlay: 'query'` shows it only when the URL has
`?inp-blame` or `#inp-blame`, or `localStorage` has `react-inp-blame` set to `overlay`: that is how to open it
on a production page. `{ position, open, max }` sets the corner, whether the panel starts open and how many
rows it keeps (20), and as many again in the fold. Without `position` the badge starts bottom right, and moves
to the next free corner (bottom left, top right, top left) when the app's own fixed or sticky element, a chat
button say, sits there when the badge mounts or when the first report comes. Where all four are taken, as
under a dialog's backdrop, it stays where it is. `position` keeps it where you put it. It is plain DOM in a
shadow root, so it never causes a React render, and its code is a chunk loaded after `install()` returns, only
when shown. A click, tap or key press on it is not the page's: it gets no report, and `inp()` and the badge
leave it out. Hide for me, beside Clear in the panel's footer, sets `react-inp-blame` in `localStorage` to
`hidden`: from then on `overlay: true` or an options object shows no badge in that browser, and reports, the
DevTools track and the rest of the API go on as before. `?inp-blame` or `#inp-blame` in the URL clears it and
shows the badge again. A badge `mountOverlay()` shows is shown regardless, and has no Hide for me. Nor has
one `'query'` shows: there the key already holds the `overlay` that opted in, and removing it is the way out.
`mountOverlay(options)` shows it after an `/auto` import. The shadow root is an open one on
`#react-inp-blame`, but a test that wants the reports should read them through
[`debugGlobal`](#installoptions) rather than from the panel's DOM, which may change between versions.

**Content Security Policy.** The badge and panel need nothing in `style-src`: their stylesheet is a
constructed one adopted by the shadow root, which `style-src` does not govern, and their colours and bar
widths are set through classes and the style object rather than `style` attributes. Safari before 16.4 has
no constructed stylesheets and gets a `<style>` element instead, which needs `'unsafe-inline'` in
`style-src` there. They need nothing from Trusted Types either: they are built from elements and text nodes,
never from markup, so a page that enforces them (`require-trusted-types-for 'script'`) draws them under any
`trusted-types` directive, `'none'` included, and the library creates no policy. A page set up for 0.9.0 to
0.11.0 can drop `react-inp-blame` from its directive. On Vite, `html.cspNonce` puts the
nonce on the plugin's script in development and in a build, and the badge's chunk loads through that
script's import, so a nonce-based `script-src` needs nothing more.
