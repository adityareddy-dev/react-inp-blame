# Real-app benchmarks

The current cohort contains exactly five everyday open-source apps. The machine-readable
registry is [bench/apps.mjs](../../bench/apps.mjs). There are no accuracy or overhead results
for this cohort. The previous cohort's adapters, patches and result tables have been removed
from the current tree, and remain available in Git history.

| ID | App | Purpose | Integration work to verify |
| --- | --- | --- | --- |
| `actual` | [Actual](https://github.com/actualbudget/actual) | Budgeting | React/Vite client in `packages/desktop-client`; verify local-only setup and deterministic budget data |
| `myfin` | [myfin](https://github.com/afaneca/myfin) | Budget tracking | React/Vite; configure myfin-api and MariaDB, seed a local user |
| `kresus` | [Kresus](https://github.com/kresusapp/kresus) | Personal finance | React/Vite; verify Express/PostgreSQL setup and fixture import |
| `manage-my-damn-life-nextjs` | [Manage My Damn Life](https://github.com/intri-in/manage-my-damn-life-nextjs) | Productivity and finance | Next.js; verify database setup through Sequelize and deterministic reset |
| `reactive-resume` | [Reactive Resume](https://github.com/amruthpillai/reactive-resume) | Resume building | Verify current React/framework versions, production build and PostgreSQL requirements from upstream source |

These are selected apps, not working benchmark integrations. No upstream commit is pinned yet,
and none has been cloned, installed, built or driven by this harness. Stack and backend notes
are selection-time leads, not validated setup instructions. Reactive Resume's React 19 and
TanStack Start versions were reported by a third-party summary and remain unverified.

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