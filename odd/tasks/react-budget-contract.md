# Match the budget browser check to the attribution contract

The budget fixture must verify safe attribution after a truncated walk. Development timings may identify Budget, Orders, or Metrics; the fixture's fixed burn durations do not guarantee that Metrics carries 60% of the whole render. Production must remain at Budget because incomplete counts cannot choose a subtree.

## Scope and decisions

- Base: remote main `9ec0c7ec3e677418a79c01a242a4d3b759cc5179`.
- Branch: `test/budget-attribution-contract-20261012` in an isolated worktree.
- Allowed source changes: `apps/demo/e2e/budget.spec.ts`, `packages/core/test/fiber.test.ts`, and this record.
- Route: delegated direct; reading prepares the bounded test edit.
- Preserve runtime behavior, truncation, render kind, only-root provenance, partial-count wording, and first-row exclusion.
- One work unit, forecast below 100 authored changed lines; delivery strategy `feature-branch-chain` if needed.
- RDD is globally off. Independent review and the parent's spot check passed; the parent authorized committing, pushing this new branch, and opening a draft PR for fresh CI. Merge remains outside this worker's scope.
- Engram mirror: saved under `odd/react-budget-contract/tasks`; first context and lifecycle reads found no existing target-project memory.

## Task and acceptance

- [ ] T1: Correct the browser winner assertion, attach the measured report, and cover deterministic timed fallback without removing the dominant-Metrics case.
  - Development accepts only Budget, Orders, or Metrics; production requires Budget.
  - A timed truncated tree with parent 90 ms, Orders 40 ms, Metrics 50 ms names Dashboard; the existing 30/60 tree names Metrics.
  - Check: focused fiber unit suite; development and production budget browser specs; repository typecheck; diff and rules baseline.
  - Observed RED: main CI run 38275439318, job 114899638976, development budget.spec.ts:24 expected Metrics and received Budget, with approximately 131 ms rendering (parent-provided verified evidence). No local RED or source defect is claimed.
  - The new fallback regression may already pass because runtime behavior is correct; this test-contract correction does not require a fabricated RED.

## Verification and next step

| Check | Observed result |
| --- | --- |
| Baseline and changed `node --import ./packages/core/test/ts-imports.ts --test packages/core/test/fiber.test.ts` | 48 passed, 0 failed on Node v24.20.0 in each run. |
| `npm run typecheck` | Passed using the existing dependency set. |
| `npm run test -w apps/demo -- budget.spec.ts --project=chromium-dev` | Blocked before test execution: Playwright requires Chromium headless shell revision 1243; only revision 1234 is installed. |
| `npm run test:prod -w apps/demo -- budget.spec.ts --project=chromium-prod` | Production server built and started; blocked at the same missing browser before test execution. |
| `git diff --check` | Passed. |
| Independent review and parent spot check | Candidate hashes matched; independent reviewer and parent each observed 48 passing fiber tests and found no blocker. |

Dependencies are reused read-only through an ignored root junction to the existing react-inp66-probe worktree. React and React DOM 19.3.0, Vite 8.3.0, Playwright 1.63.0, and TypeScript 5.9.3 match this worktree's lock. The borrowed Vite plugin and display-name loader match the candidate files by SHA-256. A separate local ignored `apps/demo/node_modules` directory keeps Vite caches out of the borrowed dependency directory. No packages or browsers were installed, and no browser check is claimed as passing or CI-equivalent.

Implementation passed independent review; T1 remains open because pinned browser checks are pending. Next: commit this work unit, push only the new branch, and open a draft PR for actual CI browser verification. No merge is authorized for this worker.

Work-unit commit: `722035aeb2f344715a28d4a57884cc4e91aefaa8` (`test: align budget assertions with attribution contract`), 50 additions and 2 deletions including this recovery record. The test-only diff remains the independently reviewed 10 additions and 2 deletions. Pinned browser proof is still pending.

Rollback boundary: remove this test-contract work unit without changing runtime code or unrelated tests.
