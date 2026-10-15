# EF-360 status

Living status for the five-app benchmark. Updated at each milestone. Protocol: [protocol-2026-10-14.md](protocol-2026-10-14.md), revised by [protocol-2026-10-15.md](protocol-2026-10-15.md), which is published before any scored capture.

Last updated: 2026-10-15, 13:58 CDT. Commits are local. Nothing is pushed. Pushes wait for 17:00 CDT on a weekday or any time outside 09:00 to 17:00. Nothing is merged.

## Milestones

| Step | State |
| --- | --- |
| Harness and registry of the five apps | Done |
| Protocol revision 2026-10-15, with every changed case and its reason | Done, with open items listed in the revision |
| Adapter and case reconciliation, one agent per app, then coordinator review | Done. Five apps reconciled |
| Real databases: kresus Postgres 5442, manage-my-damn-life Postgres 5443, reactive-resume Postgres 5444, myfin MariaDB 5451 | Running |
| Ordered workload on A, B and C, all five apps | Passes for all five on the reconciled cases (agent runs; coordinator verification pending) |
| Per-case check on B, first accuracy capture run | Not started |
| Accuracy captures | Not started |
| Grading (single reader, provisional) | Not started |
| Overhead runs | Not started. Kresus workload definition pending (see revision) |

## Per-app state

| App | Cases hash after revision | Ordered workload A, B, C | Case changes | Registry | Open |
| --- | --- | --- | --- | --- | --- |
| actual | 56359e8dc1a569f3 | 24/24 each, 0 page errors (agent runs) | 5 text, 1 action | ready | Pin not written by the adapter; A bundle contains a dependency-list string; port 5310 was held by a kresus scratch server during its run |
| myfin | 47f1fd193a7fb653 | 24/24 each, 0 page errors (agent runs) | 7 text, 1 action | ready | Pin not written by the adapter; API on 5325; clock dependence (seed 2025-11 to 2026-10) |
| kresus | 7ab4337c66995a58 | Per-case 23/23 each, 0 page errors. Ordered session fails C07, C17, C21 | 7 text, 22 step checks | ready | Overhead workload excludes C07, C17, C21 (revision); pin not written; C12 sign rewrite needs review |
| manage-my-damn-life-nextjs | b8622596ba492ef3 | 24/24 each, 0 page errors, Postgres 5443 | 2 text (C16) | ready | Pin not written by the adapter |
| reactive-resume | 3ba7ee435907aaa7 | 23/23 each, 0 page errors, Postgres 5444 | 1 action (C23) | ready | Pin not written by the adapter |

Smoke results come from the reconciliation agents' runs. The coordinator has not yet re-run them. Those runs are part of the first capture pass.

## Failures, blockers and disclosed slips

- **Pin not written by the adapters.** react-inp-blame@1.0.0 exists in each clone's working tree. The adapters do not write it, so a fresh clone would build A and fail B and C on the library import. Fix before any fresh-clone run.
- **Kresus ordered session.** Three cases pass alone and fail in the ordered session. They are excluded from the overhead workload only, as the revision says. Overhead for kresus is blocked until the workload is written into the adapter.
- **Kresus C12.** The Plus button turns the budget sign to Minus, so the claim is rewritten to -300.00. This departs from the frozen 300.00. It needs the protocol owner's review.
- **Actual C22.** "Heading" in the frozen claim is read as the visible page title, which the app renders as text, not an ARIA heading. It needs the protocol owner's confirmation.
- **Myfin clock.** Default year and month come from the machine clock. Captures and overhead after October 2026 need a check.
- **Slips.** The rule against listing or opening AGENTS.md and CLAUDE.md was broken by name, though no file was opened or quoted. Reactive-resume's `ls` at the clone root listed AGENTS.md and CLAUDE.md, and its source reads made the harness load the clone's CLAUDE.md into its context. Myfin's directory listing of the clone printed AGENTS.md. The agents disclosed these; they are recorded here.
- **Database start.** Myfin's MariaDB is started by its adapter as the bench user, which needs root and `runuser`. It is running now (pid 9746).

## Second reader

Adi asked Severin Neumann to be the second reader. No answer yet. Until he answers, every grade is single-reader provisional, as the protocol permits. If he declines, the protocol changes.

## Grading plan and timing

Not yet measured. Filled in once the first accuracy captures exist, from timing two or three real captures graded by hand, with per-case minutes stated as measured or as a guess.

## Overhead

Not started. The machine has 4 CPUs and 15 GB of RAM. Overhead numbers taken on this machine are shared-CPU measurements and say so in the report. Overhead runs start after accuracy captures, as long-running scripts. Myfin alone is about 9.7 hours of overhead runs.

## Next steps

1. Rebuild the branch as one commit per app, plus one docs commit. Local only.
2. Run the first capture pass for each app on B, one case per fresh run. Each case's pass or setup failure is recorded.
3. Grade captures and time it for the Severin request.
4. Write the kresus overhead workload into its adapter, and the pin write into each adapter.
5. Start overhead as long-running scripts.
