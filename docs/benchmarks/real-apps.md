# Real-app benchmarks

The current cohort contains exactly five everyday open-source apps. The machine-readable
registry is [bench/apps.mjs](../../bench/apps.mjs). There are no accuracy or overhead results
for this cohort. The previous cohort's adapters, patches and result tables have been removed
from the current tree. This does not purge Git history; a rewrite requires separately confirmed refs.

| ID | App | Purpose | Integration work to verify |
| --- | --- | --- | --- |
| `actual` | [Actual](https://github.com/actualbudget/actual) | Budgeting | Browser client in `packages/desktop-client`; isolate IndexedDB and deterministic budget data |
| `myfin` | [myfin](https://github.com/afaneca/myfin) | Budget tracking | React/Vite client; configure the separate API and MySQL, seed a local user |
| `kresus` | [Kresus](https://github.com/kresusapp/kresus) | Personal finance | Build client and server; isolate configuration and SQLite or PostgreSQL |
| `manage-my-damn-life-nextjs` | [Manage My Damn Life](https://github.com/intri-in/manage-my-damn-life-nextjs) | Productivity and finance | Next.js; verify database migrations, local CalDAV and deterministic reset |
| `reactive-resume` | [Reactive Resume](https://github.com/amruthpillai/reactive-resume) | Resume building | Verify client/server build, authentication, PostgreSQL and persistent file storage |

These are selected apps, not working benchmark integrations. No integration commit is pinned yet,
and none has been cloned, installed, built or driven by this harness.

## Source inspection, not execution

The following upstream snapshots were inspected on 2026-10-15. Commands are source-declared,
not verified build/server adapters or benchmark setup instructions. Each linked manifest pins
the exact inspected commit; it is not a successful integration pin.

| App | Inspected manifest | Declared build / start | Reset and setup blockers |
| --- | --- | --- | --- |
| Actual | [`d5d6035`](https://github.com/actualbudget/actual/blob/d5d6035a8f5867717a80635d270fbe64e370ea08/package.json), MIT | `yarn build:browser`; production serving remains unverified | Packaging fetches a separate translations repo unless skipped; budgets persist in IndexedDB |
| myfin | [`18377ad`](https://github.com/afaneca/myfin/blob/18377ad3f78057e519cf880a35f13831514821e6/package.json), GPLv3 | `npm run build`; `preview` rebuilds before serving | Separate API, configured API URL, MySQL volume and seeded authentication; frontend preview alone is insufficient |
| Kresus | [`41d388f`](https://github.com/kresusapp/kresus/blob/41d388f0293762a7d510392917b373f45fd29ee7/package.json), AGPL-3.0-or-later | `yarn build:prod` / `yarn start` | Node 24+, `config.ini`, database fixture and reset; production builds client and server |
| Manage My Damn Life | [`49dd7d5`](https://github.com/intri-in/manage-my-damn-life-nextjs/blob/49dd7d5718552fb5a1659cc90ea66ff7962ce981/package.json), GPLv3 | `npm run build` / `npm run start` | Environment, database selection/migrations, account setup and a local CalDAV fixture; reset must cover both stores |
| Reactive Resume | [`19e0518`](https://github.com/amruthpillai/reactive-resume/blob/19e0518eb5ea1b2c84d785bc5ea2b6d6c9d7b043/package.json), MIT | `pnpm build` / `pnpm start` | Requested repo redirects upstream; inspected v6 uses web/server workspaces, not the selection-time TanStack Start assumption; isolate PostgreSQL, Redis and file storage |

No authenticated readiness, deterministic reset or asserted interaction has been execution-verified
for these snapshots. All registry entries remain `integration-pending`; neither a dry run nor
these source notes authorize collection.

Selection came from a category shortlist, not a random sample. The departure from the original
seeded selection is recorded in the [selection amendment](amendment-2026-10-15.md).

## Before Collection

For each app, pin the upstream commit, license and lockfile, verify its production build, and
implement deterministic local data, authentication and reset. Add isolated A/B/C builds,
server startup/cleanup, readiness assertions and meaningful interaction steps with before/after
state assertions. Freeze the cases before reading attribution output. Only then mark the
registry entry `ready` and collect results under the [protocol](protocol-2026-10-14.md).

Both runner dry runs list the selected cohort. Actual runs stop before installation or browser
startup while an integration is pending. See the [harness guide](../../bench/README.md).

## Accuracy Boundary

No fresh 1.0.0 accuracy result exists. The separate 0.25.0 baseline on hyperdx and kaneo was
8 right, 35 wrong and 19 misleading out of 62 whole verdicts. That is not a result for these
five apps. An API stability release does not establish attribution accuracy or zero overhead.