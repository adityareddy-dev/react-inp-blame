# Adapter contract

Each app's integration is `bench/adapters/<id>.mjs`, one default-exported object. `apps.mjs` loads it
and sets `dir`, `dists`, `ports` and `cohort` itself; an adapter may not change them. Each app also
freezes its cases in `bench/adapters/<id>.cases.json` before any attribution output is read.

## Fields

- `status`: `'ready'` only after the cases file is committed, the production builds verify and a smoke
  run passes its assertions. Otherwise omit it (the registry then reads `integration-pending`).
- `install(run)`: optional. Installs dependencies with the upstream's own package manager and
  lockfile. `run(cmd, args, opts)` throws on a non-zero exit. Without it, `npm install` runs.
- `prepare(run)`: optional. Code generation or other one-off setup, run once per `run.mjs` call.
- `build(run, env)`: builds one configuration. `env.BENCH_CONFIG` is `''` for A, `'b'` for B, `'c'`
  for C. `env.BENCH_OUTDIR` is `dist-a`, `dist-b` or `dist-c`. Without it, `npx vite build` runs.
  Configuration A must not import `react-inp-blame` in any form, including its build plugin.
- `assetsDir`: optional, default `'assets'`. The directory under the dist that holds the JavaScript
  measured for bundle size.
- `path`: optional, default `'/'`. The page every run opens.
- `startServer(config, port)`: for server-rendered apps. Resolves to a handle with `close(cb)`. It
  binds `127.0.0.1:port`, waits until the server answers, and kills its whole process tree on close.
  Static apps omit it: the harness serves `<dir>/<dist>` itself.
- `beforeRun(config)`: optional, called before every run's fresh browser context. It must return the
  app's data to its seed (database reset, seeded local user present). Runs never share data.
- `contextOptions(config)`: optional. Extra Playwright context options, such as a `storageState` for
  the local seeded user. Sign-in only happens against `127.0.0.1`.
- `ready(page)`: required. Waits until the initial screen is interactive and shows the seeded data.
  It throws if the expected initial state is missing.
- `steps`: required, at least 20. Each is `{ name, before?(page), run(page), assert(page, before) }`.
  `name` begins with the case ID, for example `C07 add expense`. `assert` throws unless the intended
  state change is visible in the DOM or stored data. A step that did nothing must fail, never pass.

## Cases file

`bench/adapters/<id>.cases.json` is an array of `{ "id", "action", "reset", "expectedStateChange" }`,
with IDs `C01`, `C02`, ... It is committed before any capture or read of a library report. The steps'
names must start with the same IDs, in the same order. `cases.test.mjs` checks this.

## Environment

- Node: the default is Node 22. Apps that declare Node 24 use `/opt/node24/bin` on `PATH`.
- Browser: `BENCH_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
- Ports: apps `5310`–`5330` (`ports` in `apps.mjs`). Database ports are chosen by the adapter from
  `5440`–`5459`, one per app, and recorded in the cases file.
- Local state (databases, credentials, sessions) goes under `bench/state/<id>/`, which is ignored.
- Dates and times in seeded data are pinned, so an assertion never depends on the day it runs.
- No file in an upstream repository that is an AI policy or agent instruction file may be opened.

## Runs

`node bench.mjs --app <id> --blocks 5` takes the protocol's overhead design: five blocks of all six
configuration permutations, one warmup per configuration, at 1x and 4x CPU. `node run.mjs` installs,
prepares and builds, then calls `bench.mjs`. `verify-lib.mjs` checks the installed library against
the npm tarball named by `BENCH_NPM_LIB` (default `react-inp-blame@1.0.0`).
