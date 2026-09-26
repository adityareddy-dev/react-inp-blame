# With web-vitals
`react-inp-blame/web-vitals` gives the [web-vitals](https://github.com/GoogleChrome/web-vitals) package
React component names, in one option. It imports nothing from web-vitals, and `generateTarget` works with
no `install()` at all: it only reads the fiber React leaves on the node. `generateTarget` needs
web-vitals 5.1 or later: 5.0 types the option as always returning a string, and puts an `undefined` in
`interactionTarget` rather than falling back to its own selector.

```ts
import { onINP } from 'web-vitals/attribution';
import { generateTarget } from 'react-inp-blame/web-vitals';

onINP(send, { generateTarget });
// attribution.interactionTarget: 'ProfilePage > PhotoTile (button.tile)'
```

```tsx
'use client'; // Next.js: useReportWebVitals reports the build without attribution, so add the React side
import { useReportWebVitals } from 'next/web-vitals';
import { attributeINP } from 'react-inp-blame/web-vitals';

export function WebVitals() {
  useReportWebVitals((metric) => {
    send(metric.name === 'INP' ? { ...metric, attribution: attributeINP(metric) } : metric);
  });
  return null;
}
```

The component path goes into `attribution.interactionTarget`, where web-vitals otherwise puts a CSS
selector, so it shows up wherever that field is already collected and charted, with nothing to change
downstream. A path names at most four components, the four nearest the element whose names a reader could
search their code for (a minifier's `Xe` or a styling library's `styled.div` gives way to the next one out,
unless the chain has nothing better), starting for a clicked icon from what the icon belongs to, as reports do. So in a
deep tree it starts below the page and the layout rather than ending short of the component that renders
what was clicked. `generateTarget` returns `undefined` when the node has no React fiber or no named component
above it, which is web-vitals' signal to fall back to its own selector, and it never throws.

`attributeINP(metric)` returns the metric's attribution (`{}` where there is none, as under
`useReportWebVitals`) with a `react` field added: `{ schemaVersion, interactionId, blame, handler,
hotPath, components, commits, followUps }`, frozen, from this library's own report for that interaction.
It is `null` when nothing is installed on the page, and when there is no report for the interaction:
one that stayed under `threshold` and set off no later render INP leaves out, or one already pushed out
of the 50 reports a page keeps, which the ten slowest and those INP can still point at never are. It never
guesses, and like `generateTarget` it never throws: a metric it cannot
read gives `react: null` rather than an exception inside your analytics callback. web-vitals keeps
everything else it owns: which interaction is
the page's INP, at what percentile, over the back/forward cache and soft navigations.

Component names in production need the `displayName` transform (the Next.js wrapper, the Vite plugin or
the loader, all above). Without it the minifier has renamed them and the path reads `a > b (button.tile)`.

## Sending it to Sentry

Sentry records INP on its own, as a span, but that span carries no interaction id, so nothing ties this
library's report to it. A metric does the job instead, from web-vitals, with the blame in attributes Sentry
can search on. web-vitals reports INP the first time the page is hidden, and again, higher, each later time
it is hidden after a slower interaction. A distribution can't take a value back, so the recipe sends the
first report for each `metric.id`: one per page view, with a restore from the back/forward cache counting as
a new one, and a slower interaction after the user comes back to the tab left out. Metrics need Sentry 10.25
or later, where they are on by default, and `@sentry/react` and `@sentry/nextjs` export the same `metrics`.

```ts
import * as Sentry from '@sentry/browser'; // or @sentry/react, @sentry/nextjs
import { onINP } from 'web-vitals/attribution';
import { attributeINP, generateTarget } from 'react-inp-blame/web-vitals';

const sent = new Set<string>();
onINP((metric) => {
  if (sent.has(metric.id)) return; // the same page view, reported again as it was hidden again
  sent.add(metric.id);
  const { interactionTarget, react } = attributeINP(metric);
  Sentry.metrics.distribution('inp', metric.value, {
    unit: 'millisecond',
    attributes: {
      rating: metric.rating,
      target: interactionTarget,                    // 'ProfilePage > PhotoTile (button.tile)'
      'blame.kind': react?.blame.kind,              // 'render', 'handler', 'layout', 'waiting', ...
      'blame.name': react?.blame.name ?? undefined, // Sentry sends a null as the string "null"
      'blame.confidence': react?.blame.confidence,  // 'measured' or 'inferred'
    },
  });
}, { generateTarget });
```

## Sending it to Google Analytics 4

This is web-vitals' own [example for Google Analytics](https://github.com/GoogleChrome/web-vitals#send-attribution-data),
`debug_target` and all, with the blame in two more parameters. `navigationURL` came in web-vitals 6, so on
5.x leave out `page_location`:

```ts
import { onINP } from 'web-vitals/attribution';
import { attributeINP, generateTarget } from 'react-inp-blame/web-vitals';

onINP((metric) => {
  const { interactionTarget, react } = attributeINP(metric);
  // gtag() is the global the Google tag defines, typed by @types/gtag.js
  gtag('event', metric.name, {
    value: metric.delta, // delta, so the values can be summed
    metric_id: metric.id,
    metric_value: metric.value,
    metric_delta: metric.delta,
    page_location: metric.navigationURL,
    debug_target: interactionTarget, // 'ProfilePage > PhotoTile (button.tile)'
    debug_blame_kind: react?.blame.kind,
    debug_blame_name: react?.blame.name ?? undefined,
  });
}, { generateTarget });
```

GA4 reports show a parameter only once it is registered as an event-scoped custom dimension, and GA4 takes at
most 100 characters of a parameter's value, where `generateTarget` allows 120, so a long path can lose its end.

On Next.js, the body of either `onINP` callback goes in the `useReportWebVitals` one above, for
`metric.name === 'INP'`, with the Sentry one's `sent` at the top of that module. That metric comes from the
build without attribution, so `interactionTarget` is undefined there, and so is `navigationURL`.

Neither recipe sends a label or a sentence. `attributeINP` holds component, handler and script names, and
`generateTarget` an element's tag, id and test id or classes, but a report's `target.label`, `verdict` and
other sentences can hold text the page shows: under `labels: 'text'`, and by default in a development build
(see [Labels and personal data](api.md#labels-and-personal-data)). If you forward those as well, install with
`labels: 'attributes'`, so a label comes only from what your code wrote on the element. `navigationURL`,
sent above as `page_location`, keeps its query string. So can `blame.name`: when a script takes the blame it
can be the script's URL, or the page's for an inline script, as the browser reports it.
