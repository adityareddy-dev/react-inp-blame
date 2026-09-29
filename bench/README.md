# The benchmark harness

This is the harness behind [docs/benchmarks](../docs/benchmarks/README.md): what react-inp-blame costs on
real open-source React apps, and what it blames there. It isn't a workspace, it isn't in the npm package, and
CI doesn't run it. It needs the app clones described below, which aren't in the repository.

It has only ever run on one machine, Windows 11 with Node 24. The absolute medians it prints are that
machine's. The paired deltas are the part that carries over to yours.

## What it measures

Each app is built from one source up to three times, with `vite build` or `next build`:

| | |
| --- | --- |
| **A** | the library absent: the app's Vite or Next config never constructs the plugin or calls the wrapper |
| **B** | `enabled: true` and `runtime: { debugGlobal: true }`, so the harness can read `stats()` and `reports()` |
| **C** | as B, with `overlay: true` |

The two TanStack examples pin `NODE_ENV` to `development` in their Vite configs, and the patches leave that
alone, so those two apps ship React's development build, as the [benchmark docs](../docs/benchmarks/README.md)
say.

`bench.mjs` serves each build on a port of its own and drives headless Chromium through Playwright 1.59.1
along a scripted sequence of real interactions. Every step asserts that the page changed, so a step that did
nothing fails the run rather than counting as a fast interaction. Each run gets a fresh browser context. The
builds are interleaved run by run (A, B, C, A, B, C) after a thrown-away warm-up of each, first unthrottled
and then at 4x CPU throttling through the DevTools protocol, so drift on the machine lands on every build alike.

INP comes from the harness's own `PerformanceObserver`, injected before any app script and the same bytes in
every build, never from the library under test. `report.mjs` pairs each run of B and C with the same run of A
and bootstraps the median of the differences (10,000 resamples, a fixed seed, 95% percentile interval).

## What it needs

- Node 24. The published runs used 24.19.0.
- In `bench/`, `npm ci` and then `npx playwright install chromium`.
- corepack, for the apps that install with pnpm or yarn.
- For twenty and cal.diy, Docker with two containers named `bench-pg` (Postgres 16, user and password
  `postgres`, on port 5432) and `bench-redis` (Redis 7, on port 6379). The harness never starts them, so
  run `docker start bench-pg bench-redis` before a run. One way to make them the first time, published on
  127.0.0.1 only:

  ```sh
  docker run -d --name bench-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:16
  docker run -d --name bench-redis -p 127.0.0.1:6379:6379 redis:7
  ```

  cal.diy reaches Postgres at 127.0.0.1:5432. twenty's server runs in a container of its own and
  reaches both through `host.docker.internal`, which Docker Desktop provides.

## The apps

Each app lives in a folder under `bench/` at the commit the published runs measured. Make them by hand.
The harness only reads them, apart from its builds and what the steps below say.

**TanStack Table** ([TanStack/table](https://github.com/TanStack/table) at
`21d713fc4947d2a08cc2136bb055889a61412ded`, in `clones/tt`). `examples/react/filters-fuzzy` is copied to
`a/fz` (the `tt-fuzzy` app) and `examples/react/virtualized-rows` to `a/vr` (`tt-virtual`). The copies keep
`node_modules` inside Windows' 260-character path limit. `patches/tt-fuzzy.patch` and `patches/tt-virtual.patch`
go on in those folders. Each one drops the react-scan script tag from `index.html`, seeds faker so every load
gets the same rows, pins react-inp-blame, and has `vite.config.js` add `inpBlame` by `BENCH_CONFIG` and take
its `outDir` from `BENCH_OUTDIR`.

```sh
git clone https://github.com/TanStack/table.git clones/tt
git -C clones/tt checkout 21d713fc4947d2a08cc2136bb055889a61412ded
mkdir a
cp -r clones/tt/examples/react/filters-fuzzy a/fz
cp -r clones/tt/examples/react/virtualized-rows a/vr
(cd a/fz && git init -q && git apply ../../patches/tt-fuzzy.patch)
(cd a/vr && git init -q && git apply ../../patches/tt-virtual.patch)
```

The `git init -q` matters. Without a repository of its own, `git apply` in `a/fz` finds the react-inp-blame
repository above it, reads the patch's paths from that repository's root, and skips every file without a word.

**excalidraw** ([excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) at
`97c68dd371e13c017a8dcca49f8b3995ba7890a8`, in `clones/ex`). `patches/excalidraw.patch` goes on at the clone's
root. It turns the PWA plugin off in every build, since its service worker would precache 5 MB inside every
run's fresh context, and turns off the type check that runs during the build. Then run `yarn install` at the
root (yarn 1 through corepack) before the first run.

**The shadcn/ui docs site** ([shadcn-ui/ui](https://github.com/shadcn-ui/ui) at
`a87a63b2ca25143d26c8bd0903e4e9bc77b3f824`, in `clones/ui`). `patches/shadcn-v4.patch` goes on at the
clone's root. In `apps/v4/next.config.mjs` it wraps the config in `withInpBlame` outermost, by
`BENCH_CONFIG`, and takes `distDir` from `BENCH_OUTDIR`. It pins react-inp-blame in `apps/v4/package.json`
and adds `apps/v4/tsconfig.registry-node.json`, which lets the registry build run under tsx rather than bun.
It adds `/.next-*/` to `apps/v4/.gitignore` for the side-by-side builds, since Tailwind scans every file git
doesn't ignore and would otherwise read one build while it makes another. And it adds react-inp-blame to
`minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, or pnpm refuses a pinned release under 48 hours old.
`shadcn-v4`, `shadcn-sheet` and `shadcn-sheet-phone` all use this clone and the builds `shadcn-v4` makes, so
the two Sheet apps build nothing of their own.

**twenty** ([twentyhq/twenty](https://github.com/twentyhq/twenty) at
`2feb94c3128e12a6cab9fb2dfec091c1b2d2f37e`, in `clones/twenty`, or wherever `TWENTY_ROOT` points). On
Windows, point `TWENTY_ROOT` at a short path such as `C:\tw`, since under `bench\clones` the deepest paths in
the repository pass the 260-character limit. There is no patch file for twenty. Make these changes by hand in
`packages/twenty-front`:

- In `package.json`, add `"react-inp-blame": "0.12.0"` to `devDependencies`.
- In `vite.config.ts`, import `inpBlame` from `react-inp-blame/vite`, and read `process.env.BENCH_CONFIG`:
  empty constructs nothing, `b` is `inpBlame({ enabled: true, runtime: { debugGlobal: true } })`, and `c` is
  the same with `overlay: true` added to `runtime`. Spread the result into `plugins` right after the React
  plugin, and make `build.outDir` `process.env.BENCH_OUTDIR || 'build'`.

The server image is built from the commit itself (`git archive HEAD`), so these changes never reach it.

**cal.diy** ([calcom/cal.diy](https://github.com/calcom/cal.diy) at
`54343aa685ae8f33159d2f485ec4a57bad5c574a`, in `clones/caldiy`). There is no patch file for it either, and its
install stops until these changes are made:

- In `apps/web/package.json`, add `"react-inp-blame": "0.12.0"` to `dependencies`. The first install adds
  it to `yarn.lock`.
- In `apps/web/next.config.ts`, set `distDir` to `process.env.BENCH_OUTDIR || ".next"`, and replace
  `turbopack: {}` with `turbopack: { root: path.join(__dirname, "../..") }` (importing `path` from
  `node:path`). Without that root, Next.js takes the `package-lock.json` in `bench/` for the workspace root.
- In the same file, import `withInpBlame` from `react-inp-blame/next` and wrap the default export, the
  function of `phase`, in one more step: when `process.env.BENCH_CONFIG` is `b`, return
  `withInpBlame(config, { enabled: true, runtime: { debugGlobal: true } })`, and otherwise the function
  as it is.
- In `apps/web/modules/notifications/components/WebPushContext.tsx`, return early from the effect that
  registers `/service-worker.js`, in both builds. Every run is a fresh context, so the worker would
  install inside every run's measurement.
- In `apps/web/.gitignore`, add `/.next-*/`. That covers the side-by-side builds, so Tailwind doesn't scan
  one build while it makes another.

B also needs a line in `apps/web/instrumentation-client.ts`. `apps-caldiy.mjs` writes that for B's build and
puts the file back afterwards, so leave it alone. cal.diy builds A and B only, so run it with
`BENCH_ORDER=A,B`.

### Signing in

twenty and cal.diy measure the signed-in app, so each needs a user on your own local copy. twenty's dev seed
and cal.diy's seed each make one, and `prepare` runs those seeds. They are the upstream projects' own seed
accounts, `tim@apple.dev` and `pro@example.com`, published in their repositories. The sign-in scripts use the
seed's own user unless `TWENTY_EMAIL` and `TWENTY_PASSWORD` (or `CALDIY_EMAIL` and `CALDIY_PASSWORD`) name
another. They sign in only to the harness's own servers on 127.0.0.1 and throw for any other host. The session
each one saves goes under `state/`, which git ignores. `bench.mjs` signs in again by itself when a saved session
is missing or no longer valid, and `node twenty-login.mjs` or `node caldiy-login.mjs` does it up front.

### Licenses

No code from twenty or cal.diy is in this repository, only the description of the changes above. As checked on
2026-09-29, from the `LICENSE` at each repository's root, the same at the commits above as on their default
branches: twenty is under the AGPLv3 with an added permission for applications built on its APIs, apart from
files marked `@license Enterprise`, which are under its commercial license, and a few packages under MIT
(`packages/twenty-front` isn't one of them). cal.diy is under the MIT license.

## Running it

`run.mjs` installs an app when its `node_modules` is missing, runs its `prepare` step, builds each
configuration, then runs `bench.mjs` and `report.mjs`. `--no-build` skips everything before `bench.mjs`.

```sh
node run.mjs --runs 3 --app tt-fuzzy                 # a smoke run of one app
node bench.mjs --dry-run --app tt-fuzzy,twenty       # what a run would cover, no browser, then exit
```

Name the apps with `--app`. cal-diy has only A and B, and tt-virtual-fix only B and F, so both scripts refuse
a run over every app in the default `A,B,C` order before anything builds or starts, and the dry run refuses it
the same way. `run.mjs --dry-run` makes the same check and stops before installing anything. `npm test` runs
both dry runs over those cases and both report scripts over a made-up results file, and needs nothing but
`npm ci`.

The published five-app run in [real-apps.md](../docs/benchmarks/real-apps.md) used builds made beforehand:

```sh
BENCH_ORDER=A,B node run.mjs --no-build --runs 15 --app tt-fuzzy,tt-virtual,excalidraw,shadcn-v4,shadcn-sheet,shadcn-sheet-phone,twenty,cal-diy
BENCH_ORDER=B,F node run.mjs --no-build --runs 15 --app tt-virtual-fix
```

The second line is the virtualized table's sort before and after a plain comparator. Its F build is B with
`patches/tt-virtual-sort.patch` on top. Build it by hand in `a/vr`, then take the patch off again:

```sh
cd a/vr
git apply ../../patches/tt-virtual-sort.patch
BENCH_CONFIG=b BENCH_OUTDIR=dist-f npx vite build
git apply -R ../../patches/tt-virtual-sort.patch
```

Always run `tt-virtual-fix` with `--no-build`. Without it, `run.mjs` builds F again in `a/vr` with the sort
patch off, so F comes out the same as B.

Two scripts read a results file and nothing else. `node steps.mjs results/<file>.json [app,app] [--verdicts]`
prints each scripted step's slowest interaction and what configuration B blamed for it (F too, labelled apart,
for `tt-virtual-fix`), then the library's own accounting with one line per configuration it was in.
`node before-after.mjs results/<file>.json` compares F with B for `tt-virtual-fix`, bootstrapped as
`report.mjs` does. That app has no A, so its part of the report has no A/B/C table and points there.

### Which release

Every patch pins react-inp-blame to exactly 0.12.0, the release real-apps.md measured, and `verify-lib.mjs`
(which `bench.mjs` runs) checks each app's installed copy byte for byte against `BENCH_NPM_LIB`, by default
`react-inp-blame@0.12.0`. To measure a later release, change the pins and `BENCH_NPM_LIB` together.

To measure a local build, run `npm pack` in `packages/core`, point each app's pin at the tarball with a
`file:` path, and set `BENCH_TARBALL` to its path relative to `bench/`, so the results record its hash. The
check against npm then fails, as it should, and the report says so at the top. The overhead run in
[docs/benchmarks](../docs/benchmarks/README.md) used a 0.3.0 candidate tarball that was never published, so
that run can't be repeated exactly.

## Environment variables

| | |
| --- | --- |
| `BENCH_ORDER` | the configurations to build and run, in their interleaved order, `A,B,C` by default |
| `BENCH_CONFIG` | set by `run.mjs` for each build and read by the patched configs: empty for A, `b`, `c` |
| `BENCH_OUTDIR` | set by `run.mjs` for each build: the folder that build goes to |
| `BENCH_NPM_LIB` | the release `verify-lib.mjs` checks against, `react-inp-blame@0.12.0` by default |
| `BENCH_TARBALL` | a local tarball to record in the results, relative to `bench/` |
| `TWENTY_ROOT` | where the twenty clone is, `clones/twenty` by default |
| `GIT_BASH` | the bash twenty's setup runs in, Git for Windows' on Windows and `bash` elsewhere by default |
| `TWENTY_EMAIL`, `TWENTY_PASSWORD` | the twenty user to sign in as |
| `CALDIY_EMAIL`, `CALDIY_PASSWORD` | the cal.diy user to sign in as |

## Ports

The builds use 5310 to 5334 on 127.0.0.1, three ports per app (two for cal.diy and `tt-virtual-fix`).
twenty's server listens on 3100, and the two containers on 5432 and 6379.

## What it writes

`results/` gets a JSON file and its markdown report each time `run.mjs` runs, `report.md` a copy of the
latest report, `state/` the saved sign-ins and twenty's setup logs, and `npm-lib/` the release
`verify-lib.mjs` packs from npm. git ignores all four. A results file records paths on your machine, such
as Chromium's and a tarball's, so look through it before sharing one.
