# API
```ts
import { onInteraction } from 'react-inp-blame';
// explanation.blame and explanation.rating are data; verdict is display text.
const stop = onInteraction((report) => console.log(report.explanation.blame, report.verdict));
```

`onInteraction(fn)` is the one way to hear reports: `fn` gets each report, and every later revision of it,
in a task after the one that published it, and the call returns the unsubscribe. A panel that renders what
it hears is safe, because the update a listener makes while it runs is never read as part of an
interaction. An update it schedules for later, with setTimeout or an await, is an ordinary render. The
package's types document every field.

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
| `sampleRate` | `1` | Share of page loads that install anything |
| `walkBudget` | `5000` | Component fibers visited per commit. A commit past it is reported as partial: its counts say "at least", and in a production build, which has only counts to go on, the blame names the one subtree the walk was in where nothing it did not reach rendered beside it, and otherwise the component the subtrees all sit under, or the app where they sit under none, rather than the subtree the walk reached first |
| `inputWindow` | `1500` | A commit outside any input's dispatch is walked only within this many ms of the end of the last commit inside the newest input's dispatch, or of the input where there was none; commits inside an input's own dispatch are always walked. It also bounds `followUps`, whose window runs from the paint as a rule |
| `devtoolsTrack` | `true` | Draw each report in Chrome's Performance panel, in an "Interaction blame" track |
| `debugGlobal` | `false` | `true` puts the API on `window.__REACT_INP_BLAME__`; a string names the property |

The API has `reports()` (up to 50 published, oldest first, at their latest revision; past 50 the oldest
goes, but never one of the ten slowest or one INP can still point at), `last()`, `inp()`
(`{ value, rating, interactionId, interactionCount, report }` for this navigation, or null), `onInteraction(fn)`,
`clear()` (drops reports and commits, and starts the INP estimate over), `dispose()` and `stats()`: `mode`
(`'shim'`, `'chained'`, `'none'`, `'unsupported'` or `'sampled-out'`), `unsupportedReason`, `react` (`'reading'`,
`'waiting'` while React has not rendered on the page, `'installed-late'` when it has and no react-dom registered
because install() ran after react-dom loaded, or `'unreadable'`), `walks`, and the
library's own time in `walkTotalMs`, `reportTotalMs` and `installMs`. `debug.commits()` and `debug.hook()` are
for debugging and may change in any version. Also exported: [`mountOverlay`](#the-badge-and-panel). Under
the `react-server` condition every export does nothing, here and on
[`react-inp-blame/web-vitals`](web-vitals.md): `generateTarget` returns `undefined` and
`attributeINP` returns `{ react: null }`.

## InteractionReport

```ts
interface InteractionReport {
  schemaVersion: 3; interactionId: number; revision: number; type: string; // 'click', 'keydown', ...
  pointerType: string | null;                            // 'mouse', 'pen' or 'touch' for a pointer's event
  reactStatus: 'reading' | 'waiting' | 'installed-late' | 'unreadable'; // stats().react as it was built
  start: number; end: number; duration: number; holdMs: number;             // ms, performance.now() clock
  inputDelay: number; processing: number; walkMs: number; presentation: number; // add up to duration
  nextInput: { type: string; pointerType: string | null; start: number; endedAt: number | null } | null; // next press before the paint
  target: TargetInfo | null; entries: EventEntrySummary[]; // target: selector, label, component, owners, handler
  hydration: { kind: 'waited' | 'not-hydrated'; scope: 'root' | 'boundary';   // server-rendered HTML the click
               owner: string | null; ms: number | null } | null;            // landed on before React hydrated it
  navigationURL: string; navigationType: NavigationType; // web-vitals' names and values
  startedNavigation: { url: string; type: 'push' | 'replace' | 'traverse' } | null;
  commits: CommitSummary[]; followUps: CommitSummary[];   // before the paint; after it, within inputWindow
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

`duration` is the longest single Event Timing entry, as web-vitals measures it; `holdMs` is how much longer
the span from press to release ran. Reports are frozen: a late entry, frame or render that joins one reaches
listeners as a new object with `revision` one higher, and `schemaVersion` changes when a field is removed or
changes meaning. **`verdict`, `cause`, `notes`, `headline`, `where` and the phases' `label` and `hint` are
display text that may change between versions**; the blame, the rating, the phases' `ms` and the report's
numbers are the data. `confidence` is `'measured'` when the blame follows from this interaction's own timings,
and `'inferred'` when it rests on render counts, a clock too coarse to time one component, a commit that only
overlapped, a walk cut short, or no Long Animation Frames to rule other scripts out. A screen update blamed
with "the frame waited on the next key press" is still the screen update's own time, measured. That clause
rests on the next press's timings instead (`nextInput`), so it is only said where the page worked on that
press before the paint for half the screen update or more, and it says "most likely" unless a long animation
frame over this interaction recorded a script from the press on that shows it, the way a wait's is named.

## Labels and personal data

`target.label` names the element by its tag and a name of at most 40 characters, and never reads a form
field's value or an element's whole text. It is read as the input is dispatched, before your handlers run,
so a click on a button reading "Count is 0" is labelled that, not with the "Count is 1" it then shows. A click that lands inside a control is labelled by that control,
tag and name included: the first of the element and its five nearest ancestors that is a `button`, a link,
`summary`, `label`, `input`, `select` or `textarea`, or has the ARIA role `button`, `link`, `menuitem`,
`menuitemcheckbox`, `menuitemradio`, `tab`, `option`, `checkbox`, `radio` or `switch`. A click on the `path`
of an icon button reads `button "Close"`, not `path`, and `target.selector` stays the element the browser
reported. Under a production build of React the label uses only what your code wrote on the element:
`aria-label`, a form field's `placeholder`, `name` or `type`, or `data-testid` or `data-test`. An element's
text can be a person's name or email, and reports are made to be forwarded to error trackers and analytics, so
text is opt-in there: with `install({ labels: 'text' })` an element with no `aria-label` that is not a form
field is named by its first run of text. Development builds use text by default. Whatever `labels` says,
`target.selector` has the tag, the `id` if there is one, and `data-test` or `data-testid` or else two classes,
and `navigationURL` and `startedNavigation.url` are full URLs, query string included. So is a script the
browser names by its URL, or by the page's for an inline script, in a blame's `name` and the sentences.

## The badge and panel

`overlay: true`, in `runtime` or `install()`, shows a corner badge with the page's INP so far, green, amber or
red. Click it for the recent slow interactions, newest first, each with what to blame and a bar split into
waiting, working and updating the screen; a row opens into the full explanation and the components that
rendered before and after the paint. `overlay: 'query'` shows it only when the URL has `?inp-blame` or
`#inp-blame`, or `localStorage` has `react-inp-blame` set to `overlay`: that is how to open it on a production
page. `{ position, open, max }` sets the corner, whether the panel starts open and how many rows it keeps
(20). It is plain DOM in a shadow root, so it never causes a React render, and its code is a chunk loaded
after `install()` returns, only when shown. `mountOverlay(options)` shows it after an `/auto` import. The shadow
root is an open one on `#react-inp-blame`, but a test that wants the reports should read them through
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
