# Reliability, reporting a wrong blame, cost and labels

Longer text moved out of the [README](../README.md).

## Benchmarks and reproduction

The [live demo](https://adityareddy-dev.github.io/react-inp-blame/) has deliberately slow scenarios.
For a local copy, use Node 22.18 or later, run `npm ci`, `npm run build` and `npm run dev` from this
repository, then open the address Vite prints. `npm test` runs the demo checks after
`npx playwright install chromium firefox webkit` ([contributor setup](../CONTRIBUTING.md#setup)).


## Reporting a wrong blame

The report itself is what makes it diagnosable. Add `debugGlobal: true` to `runtime` (or to `install()`) and
run `JSON.stringify(__REACT_INP_BLAME__.last(), null, 2)` in the console right after the slow interaction, or
print `JSON.stringify(report)` from `onInteraction`; with no report, paste `stats()` instead. What the badge
shows is a good start, but the JSON has everything its sentence was built from.

The form also asks for the versions of react-inp-blame, react and react-dom, and Next.js or Vite, the bundler,
whether it was a development or a production build, and the browser. Each changes what a report can say: a
production build of React records no render times, and only Chromium has Long Animation Frames. A report
carries the page's origin and path and the label of the element you clicked, so read it through before you
paste it.

These reports are how the blame gets better. If the console printed a warning instead, it ends with a link to
its entry under [Troubleshooting](../README.md#troubleshooting).


## OpenTelemetry processor

Event Timing supplies the interaction's duration and phases. Long Animation Frames adds script and
forced-layout evidence on Chromium 123 and later. It does not supply React component names, and
coinciding work alone does not prove what caused it. Without that API, reports leave those details out.

For an existing OpenTelemetry web-vitals pipeline, add the processor before the processor that exports:

```ts
import { InpBlameLogRecordProcessor } from "react-inp-blame/otel";

const loggerProvider = new LoggerProvider({
  processors: [
    new InpBlameLogRecordProcessor(),
    new BatchLogRecordProcessor({ exporter }),
  ],
});
```

Here `LoggerProvider`, `BatchLogRecordProcessor` and `exporter` come from your telemetry setup.
The [complete OTLP recipe](opentelemetry.md#opentelemetrys-web-sdk) includes their imports,
the exporter and instrumentation registration. Enable the library in production and sample it first,
or the processor has no reports to attach. `/otel` is experimental through 1.x, its attributes are not
standard OpenTelemetry conventions, and a component name is attribution to investigate, not proof.


## What it costs

`node scripts/size.mjs` measures these from the build on every CI run, and CI fails when this table is out
of date. The table before 0.8.0 said 39.0 and
14.4 KB for `/auto`, figures from 0.1.0 that had not been measured again as the entry grew.


## Labels and personal data

Reports are made to be forwarded to error trackers and analytics, so `target.label` never reads a form field's
value, and under a production build of React it uses only what your code wrote on the element (`aria-label`, a
form field's `placeholder`, `aria-placeholder` or `name`, an input's `type`, `data-testid` or `data-test`). An
element's text is opt-in there, with `labels: 'text'`. What your code wrote goes out as written, though: an
`aria-label`, `data-testid` or `id` built from user data, such as ``aria-label={`Message ${user.name}`}``,
lands in `target.label` or `target.selector`, and the label in the verdict. A URL in a report keeps its origin
and path, never its query, fragment or password, and a script's URL in a blame loses the same. The details are
under [labels and personal data](api.md#labels-and-personal-data) in the API page. Each report also goes out
as a User Timing measure, with its verdict and label in the entry's `detail`, under a development build of React
unless [`devtoolsTrack`](api.md#installoptions) is `false`, and under any build where it is `true`. Any
`PerformanceObserver` on the page sees it, a monitoring script that collects measures included. Everything it
reads, changes and keeps on a page is in [SECURITY.md](../SECURITY.md#what-it-touches).
