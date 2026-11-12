# Real-app benchmarks

The current cohort contains exactly five everyday open-source apps. The machine-readable
registry is [bench/apps.mjs](../../bench/apps.mjs). Actual has an
[overhead measurement](actual-overhead-2026-11-10.md).
Results are added here as each app's runs finish.

| ID | App | Purpose | Integration work to verify |
| --- | --- | --- | --- |
| `actual` | [Actual](https://github.com/actualbudget/actual) | Budgeting | Functional pilot verified at `6fa81d2f49b7562ec813dca72f2ebdb5ed3dc91e`, production A/B/C, fresh demo reset and 20 asserted cases |
| `myfin` | [myfin](https://github.com/afaneca/myfin) | Budget tracking | React/Vite; configure myfin-api and MariaDB, seed a local user |
| `kresus` | [Kresus](https://github.com/kresusapp/kresus) | Personal finance | React/Vite; verify Express/PostgreSQL setup and fixture import |
| `manage-my-damn-life-nextjs` | [Manage My Damn Life](https://github.com/intri-in/manage-my-damn-life-nextjs) | Productivity and finance | Next.js; verify database setup through Sequelize and deterministic reset |
| `reactive-resume` | [Reactive Resume](https://github.com/amruthpillai/reactive-resume) | Resume building | Verify current React/framework versions, production build and PostgreSQL requirements from upstream source |

Actual has a verified author-run functional integration and an overhead measurement. The table lists the setup work for each app.

Selection came from a category shortlist, not a random sample. The departure from the original
seeded selection is recorded in the [selection amendment](amendment-2026-10-15.md).

## Before Collection

For each app, pin the upstream commit, license and lockfile, verify its production build, and
implement deterministic local data, authentication and reset. Add isolated A/B/C builds,
server startup/cleanup, readiness assertions and meaningful interaction steps with before/after
state assertions. Freeze the cases before reading attribution output. Only then mark the
registry entry `ready` and collect results under the [protocol](protocol-2026-10-14.md).

Both runner dry runs list the selected cohort. Collection runs require an integration marked `ready`
before installation or browser startup. See the [harness guide](../../bench/README.md).

## Accuracy Boundary

Grade reports against independent traces using the [measurement protocol](protocol-2026-10-14.md).
