# Benchmark Harness

The harness is separate from the npm package and root workspace. Its only cohort is the
[five selected everyday apps](../docs/benchmarks/real-apps.md), defined in [apps.mjs](apps.mjs).
All five integrations are pending. App clones, build outputs and measured results are not
included. The retired cohort's adapters, patches, login scripts and one-off experiment have
been removed, with prior records retained in Git history.

## Check the Cohort

From `bench/`, using Node 24 or newer:

```sh
npm ci
npm test
node run.mjs --dry-run
node bench.mjs --dry-run --app actual,myfin
BENCH_ORDER=A,B node run.mjs --dry-run --app kresus
```

Dry runs require no app clones, browser download, database or server. They validate the
selection and configurations, not integration readiness. Normal runs, including `--no-build`,
stop before installation or browser startup for pending integrations.

## Integration Contract

Each registry entry reserves a clone path under `bench/clones/<id>` and three distinct ports
on `127.0.0.1`, in the range 5310-5324. The `dist-a`, `dist-b`, `dist-c` names are reserved
output locations, not verified upstream build settings.

| Configuration | Build |
| --- | --- |
| A | Library absent, including build plugins |
| B | Library enabled with `runtime: { debugGlobal: true }` |
| C | As B, with `overlay: true` |

Before setting an entry's status to `ready`, pin and verify its upstream source, add install
and build adapters, isolated output directories, deterministic local fixtures and reset, and
asserted interaction steps. Server-rendered apps provide `startServer(config, port)` returning
a closeable server handle. Static apps provide built directories. Add `ready(page)` and
`steps`, with each step asserting the intended state change rather than merely timing an
action. Keep credentials and saved sessions local and ignored.

Once integrations exist, `run.mjs` installs missing app dependencies, runs `prepare`, builds
selected configurations, invokes `bench.mjs`, then writes a report. `--no-build` skips install,
prepare and build, but does not bypass readiness. Playwright Chromium must be installed before
collection. The independent browser observer measures timing, while library stats are secondary
self-accounting. `report.mjs` pairs A/B/C runs by index and bootstraps their differences.

`node report.mjs results/<file>.json` and `node steps.mjs results/<file>.json` read captures.
The tests use synthetic results only. They are not measurements of the selected apps.

## Environment and Outputs

`BENCH_ORDER` selects configurations, default `A,B,C`. The runner sets `BENCH_CONFIG` to empty
for A and lowercase for B/C, and `BENCH_OUTDIR` to the reserved output path. `BENCH_NPM_LIB`
selects the exact npm release for byte verification, default `react-inp-blame@1.0.0`.
`BENCH_TARBALL` records a local package tarball instead, which intentionally fails npm-byte
verification when different. Match app package pins to the release under test.

Ignored outputs are `clones/`, `results/`, `state/`, `npm-lib/` and `report.md`. Inspect captures
for local paths, credentials and personal labels before sharing.

Follow the [published protocol](../docs/benchmarks/protocol-2026-10-14.md) and
[selection amendment](../docs/benchmarks/amendment-2026-10-15.md). Collection is not ready until
the missing app integrations and protocol requirements are implemented and validated.