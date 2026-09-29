# With OpenTelemetry

`react-inp-blame/otel` puts the blame for a slow interaction on the INP event your telemetry already sends:
the log record OpenTelemetry's web vitals instrumentation emits, and the ones Embrace and Elastic build on it,
Honeycomb's INP span, and Grafana Faro's web vitals measurement. The component or handler that made the
interaction slow lands there as `react_inp_blame.*` attributes, so it can be grouped and filtered beside the
INP value in the backend you already use. The entry imports nothing from OpenTelemetry or any vendor SDK, and
it never throws inside your telemetry pipeline.

It is experimental. Its export names and the attribute names can change in any minor release, 1.x included,
until OpenTelemetry names fields for an interaction's target or a component, and the CHANGELOG says so when
they do.

## It needs the library in production

This entry sends what the library measured on the page, so it only has something to send where the library
runs. It is a development tool first: the Next.js wrapper and the Vite plugin leave it out of production
builds unless `enabled` says otherwise. So with the defaults every record from production says
`react_inp_blame.status: not-installed` and nothing else. To send the blame, turn it on for production and
sample it:

```ts
import { withInpBlame } from 'react-inp-blame/next';

export default withInpBlame({ /* your config */ }, {
  enabled: true,                   // production builds too
  runtime: { sampleRate: 0.1 },    // on one page load in ten
});
```

With Vite, the same two options go to `inpBlame()` in `vite.config.ts`. A page the sample leaves out says
`sampled-out`.

Running it in production costs something. In 0.12.0 that was about 209 ms of page load on the shadcn/ui docs
site, and about 5 ms inside each interaction on the twenty CRM, with INP flat on every app measured
([What it costs](../README.md#what-it-costs), [the runs](benchmarks/real-apps.md)). What loads with the page
is `react-inp-blame/auto`, 34.1 KB gzip by `scripts/size.mjs` in 0.20.0, and this entry adds 1.5 KB on
top. So a telemetry path held to about 10 KB is not met at 1.0.

There is a cheaper step short of that. `runtime: false` keeps only the `displayName` transform, so
`generateTarget` from [react-inp-blame/web-vitals](web-vitals.md) can name components in production with no
runtime on the page. Every record this entry sees there says `not-installed`, since there is no report to read.

## OpenTelemetry's web SDK

The processor goes first in `processors`. A `SimpleLogRecordProcessor` exports the record the moment it is
emitted, so behind one the attributes would miss the export. Checked with
`@opentelemetry/browser-instrumentation` 0.8.1, `@opentelemetry/sdk-logs` 0.222.0 and web-vitals 6.2.2.

```ts
// src/telemetry.ts
import { logs } from '@opentelemetry/api-logs';
import { WebVitalsInstrumentation } from '@opentelemetry/browser-instrumentation/experimental/web-vitals';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { InpBlameLogRecordProcessor } from 'react-inp-blame/otel';

const loggerProvider = new LoggerProvider({
  processors: [
    new InpBlameLogRecordProcessor(), // first, so every processor after it sends the attributes
    new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: 'https://collector.example.com/v1/logs' }) }),
  ],
});
logs.setGlobalLoggerProvider(loggerProvider);
registerInstrumentations({ instrumentations: [new WebVitalsInstrumentation()], loggerProvider });
```

The processor adds nothing to any other record, other web vitals included. Where you would rather not touch
the processors, the instrumentation's own hook does the same for its records, as in the Elastic setup below.

## Embrace

Embrace takes log processors of your own and runs them ahead of its own, so the processor goes in
`logProcessors`. Checked with `@embrace-io/web-sdk` 2.29.1, whose web vitals are log records stamped with the
interaction's time.

```ts
// src/embrace.ts
import { initSDK } from '@embrace-io/web-sdk';
import { InpBlameLogRecordProcessor } from 'react-inp-blame/otel';

initSDK({
  appID: 'your-app-id',
  appVersion: '1.0.0',
  logProcessors: [new InpBlameLogRecordProcessor()],
});
```

## Elastic

Elastic's browser SDK has no slot for a log processor, only each instrumentation's config, so the web vitals
instrumentation's `applyCustomLogRecordData` hook is the way in. Take it as a stopgap: that hook may go
([opentelemetry-browser #440](https://github.com/open-telemetry/opentelemetry-browser/issues/440)), and a
processor slot would be the better route. Checked with `@elastic/opentelemetry-browser` 0.3.0 and the
`@opentelemetry/browser-instrumentation` 0.5.2 and web-vitals 5.3.0 it brings.

```ts
// src/elastic.ts
import { startBrowserSdk } from '@elastic/opentelemetry-browser';
import { inpBlameAttributes } from 'react-inp-blame/otel';

startBrowserSdk({
  serviceName: 'shop',
  otlpEndpoint: 'https://collector.example.com',
  instrumentations: {
    '@opentelemetry/instrumentation-web-vitals': {
      applyCustomLogRecordData: (record) => {
        record.attributes = { ...record.attributes, ...inpBlameAttributes(record) };
      },
    },
  },
});
```

## Honeycomb

Honeycomb sends INP as a span and hands its `applyCustomAttributes` the whole web-vitals metric, which the
entry matches on the interaction's id. Checked with `@honeycombio/opentelemetry-web` 1.5.1.

```ts
// src/honeycomb.ts
import { HoneycombWebSDK } from '@honeycombio/opentelemetry-web';
import { inpBlameAttributes } from 'react-inp-blame/otel';

const sdk = new HoneycombWebSDK({
  apiKey: 'your-ingest-key',
  serviceName: 'shop',
  webVitalsInstrumentationConfig: {
    inp: { applyCustomAttributes: (vital, span) => span.setAttributes(inpBlameAttributes(vital)) },
  },
});
sdk.start();
```

## Grafana Faro

Faro sends web vitals as measurements, with the interaction's time in `interaction_time`, and a
measurement's `context` takes strings, so the values go through `String()` in `beforeSend`. The 8 ms INP
web-vitals stands in after a back/forward restore or a soft navigation with no slow interaction comes without
`interaction_time`, and the `NaN` gets it `no-report`, as every other setup here does. Checked with
`@grafana/faro-web-sdk` 2.12.1.

```ts
// src/faro.ts
import { getWebInstrumentations, initializeFaro, type MeasurementEvent } from '@grafana/faro-web-sdk';
import { inpBlameAttributes } from 'react-inp-blame/otel';

initializeFaro({
  url: 'https://faro-collector.example.com/collect/your-app-key',
  app: { name: 'shop', version: '1.0.0' },
  instrumentations: getWebInstrumentations(),
  beforeSend: (item) => {
    const m = item.payload as MeasurementEvent;
    if (item.type === 'measurement' && m.type === 'web-vitals' && m.values['inp'] !== undefined) {
      const blame = inpBlameAttributes(m.values['interaction_time'] ?? NaN);
      m.context = { ...m.context, ...Object.fromEntries(Object.entries(blame).map(([name, value]) => [name, String(value)])) };
    }
    return item;
  },
});
```

## Where the setup goes

The library does its work as the interaction happens, and the entry reads its report when the INP event is
sent, which without `reportAllChanges` is when the page is hidden. The library has to install before the
telemetry is set up. At the hide its own listener, added first, hands the library the entries the browser
still holds, and only then does web-vitals take them and report, so the report is there when the record is
sent. With the telemetry set up first, an interaction the page hides on before the browser hands its entries
over says `no-report`. The demo's check sets web-vitals up before the library and still matches, but only
because it waits for the entries before it hides.

- **Next.js 16.3 and later:** `withInpBlame` injects the install ahead of `instrumentation-client.ts`, so the
  telemetry setup goes in that file.
- **Next.js 15.3 to 16.2:** the install is the library's line in `instrumentation-client.ts`
  ([Next.js](install.md#install-with-nextjs-142-or-later)), and the telemetry setup is imported after it.
- **Vite:** the plugin's script runs ahead of the app, so import the setup from your entry module as usual.
- **Your own `install()` call:** call it before the telemetry setup is imported, in a module that loads ahead
  of it.

## What lands on the record

The web SDK, Embrace and Elastic put these on the `browser.web_vital` record for INP, Honeycomb on the INP
span, and Faro in the measurement's `context`, as strings. A value that is null or empty is left out rather
than sent. The examples are from the demo's check, a click that re-rendered 801 components on a development
build.

| Attribute | What it holds | Example | Group by it |
| --- | --- | --- | --- |
| `react_inp_blame.status` | Whether a report was found, below | `matched` | yes |
| `react_inp_blame.blame.kind` | Where the time mostly went: `render`, `handler`, `hydration`, `layout`, `waiting`, `painting`, `script` or `none` | `render` | yes |
| `react_inp_blame.blame.name` | The component, handler or script it went to | `OrderSummary` | yes |
| `react_inp_blame.blame.detail` | What that was mostly made of | `LineItem ×800` | no, it is display text, whose wording can change in any minor |
| `react_inp_blame.blame.ms` | How much of the interaction it accounts for, in ms. Left out for `none`, and for a `render`, `hydration` or `handler` blame where the build records no durations and React committed inside the interaction | `167.5999999998603` | no |
| `react_inp_blame.blame.confidence` | `measured` or `inferred` | `measured` | yes |
| `react_inp_blame.handler` | The React handler that ran | `add` | yes |
| `react_inp_blame.target.components` | Up to four components around the element, outermost first | `App > Lab > ContextStorm` | yes |
| `react_inp_blame.hot_path` | The path down to where the render spent its time. Without the `displayName` transform in production, the minifier's names, which change with each build (below) | `ContextStorm > OrderSummary` | yes |
| `react_inp_blame.react_status` | Whether the library could see React: `reading`, `waiting`, `installed-late` or `unreadable` | `reading` | yes |
| `react_inp_blame.react_build` | The build of react-dom that measured it. A `development` one reads high | `development` | yes, and filter it out |
| `react_inp_blame.commits.count` | React commits inside the interaction | `1` | no |
| `react_inp_blame.commits.rendered` | Components they rendered | `801` | no |
| `react_inp_blame.commits.ms` | What React spent rendering them, in ms, where the build records it | `163.0999999998603` | no |
| `react_inp_blame.follow_ups.count` | Commits after the paint that belong to it | `0` | no |
| `react_inp_blame.follow_ups.ms` | What React spent rendering those, in ms. Left out with none | | no |

On a production build of React the same click gave `inferred` and `production`, and no `blame.ms` or
`commits.ms`, since that build times no renders.

`commits.ms` is React's render time alone. A render blame's `blame.ms` also counts committing that render and
its effects, so it can be more than `commits.ms`, as it is in the example.

Component names in production need the `displayName` transform, which the Next.js wrapper, the Vite plugin
and the loader add wherever they run, `runtime: false` included
([Next.js](install.md#install-with-nextjs-142-or-later), [Vite](install.md#install-with-vite),
[the loader](install.md#webpack-or-rspack)). Without it every component name here is the minifier's, in
`hot_path`, `target.components` and a render blame's `blame.name` alike, and the next build renames them, so
a dashboard grouped on them starts over with each deploy. Everything but the names still groups cleanly
there, `blame.kind` and the statuses first.

`blame.name` follows what a report's blame names ([Blame](api.md#interactionreport)). Which name it gives can
change in a minor as the reading gets better, and each release's notes list those changes under a heading of
their own. Two kinds changed what they name in 0.19.0: a `painting` blame on React's own task names the
component that render is named after, and a `layout` blame can name the component the render started from. A
dashboard that groups by `blame.name` across that release sees those under their new names.

### Status

- `matched`: the report for this interaction was found, and the rest of the attributes come from it.
- `not-installed`: the library installed nothing on the page, as in a production build with `enabled` left at
  its default.
- `sampled-out`: the page lost the `sampleRate` roll.
- `no-report`: nothing matched. The interaction stayed under `threshold`, its report was already pushed out, it
  was a click on the library's own badge or panel, or the event was sent before the library had a report.
- `library-error`: the library could not explain the report, or could not read what it was handed.

A metric is matched on its entries' `interactionId`. A record or a number is matched on time: a report that
started less than 1 ms from the record's timestamp and, where the record carries `browser.web_vital.value`,
lasted within 1 ms of that. It never takes the nearest report instead, so a record either has the blame for
its own interaction or none.

The share of INP events that got a blame is the first thing to check after deploying. Count INP events
grouped by `react_inp_blame.status`, in whatever query language your backend speaks. In SQL over exported logs:

```sql
SELECT attributes['react_inp_blame.status'] AS status, count(*)
FROM logs
WHERE attributes['browser.web_vital.name'] = 'inp'
GROUP BY status
```

A backend where `not-installed` is most of it is running the default. A lot of `no-report` beside `matched`
is worth a look under the limits below.

## Personal data

The entry sends component, handler and script names and numbers, nothing else. Never an element's text or
classes, never `target.selector` or `target.label`, never a verdict or a sentence, never a URL with its query.
One thing goes out as the page wrote it though. For a `script`, `waiting`, `painting` or `layout` blame, and a
handler React has no name for, `blame.name` can be the browser's name for the listener, the element's tag and
id included (`DIV#root.onclick`), or on an element with no id its `src` (`IMG[src="/avatars/jane.png"].onload`).
So an id or a `src` path built from user data lands there. A URL in `blame.name` has lost its password, query
and fragment, but its path stays as written.

The rest of what the library does with labels is under
[Labels and personal data](../README.md#labels-and-personal-data). One part of it matters here: each report also
goes out as a User Timing measure, verdict and label in its `detail`, under a development build of React
unless `devtoolsTrack` is `false`, and under any build where it is `true`. A telemetry setup that collects
User Timing measures picks those up, whatever this entry sends.

## Limits

- **The verdict can be wrong.** On apps it had not been tuned on, 0.12.0 was right on 11 of 43 verdicts
  ([the runs](benchmarks/real-apps.md)). For anything that alerts, filter on `blame.confidence` `measured`.
- **`reportAllChanges`, or any SDK that reports INP before the page is hidden,** can send a record before the
  library has its report, which then says `no-report`. Honeycomb passes its `inp` options straight to
  web-vitals, so a `reportAllChanges` there does this.
- **The telemetry set up before the library.** An interaction the page hides on before the browser hands its
  entries over says `no-report`, since web-vitals reports before the library has built the report. A flush at
  the hide for this order is planned for after 1.0. Until then, install first
  ([Where the setup goes](#where-the-setup-goes)).
- **A click or tap on the badge or panel** counts toward INP in web-vitals, which every setup here goes
  through, but the library makes no report for it, so its record says `no-report`.
- **Processor order.** Behind a processor that exports as the record is emitted, the attributes miss the
  export. First in the list is always safe.
- **Upstream is 0.x.** The web vitals instrumentation lives under an `experimental/` path of a 0.x package,
  and `browser.web_vital` is a development-stage name in OpenTelemetry's conventions. CI runs every setup on
  this page except Embrace's, which it only compiles, against the versions above, and again every day against
  the newest, so a release that moves a hook or the INP timestamp shows up there first. For Embrace it would
  not.
