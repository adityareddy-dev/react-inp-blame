# EF-360 status

Living status for the five-app benchmark. Updated at each milestone. Protocol: [protocol-2026-10-14.md](protocol-2026-10-14.md), revised by [protocol-2026-10-15.md](protocol-2026-10-15.md), with its addendum on capture setup. The revision is published before any grade is recorded.

Last updated: 2026-10-15, about 14:45 CDT. Commits are local. Nothing is pushed. Pushes wait for 17:00 CDT on a weekday, or any time outside 09:00 to 17:00. Nothing is merged. The branch is 7 commits ahead and 5 behind origin. Authorship of the unpushed commits is an open question for the owner (see the stop-hook notes below).

## Milestones

| Step | State |
| --- | --- |
| Harness and registry of the five apps | Done |
| Protocol revision 2026-10-15, with every changed case and reason | Done |
| Addendum: capture setup for manage-my-damn-life-nextjs C12 and reactive-resume C09, C11 to C14 | Done, written before any grade for those apps |
| Real databases | Postgres 5442 (kresus), 5443 (manage-my-damn-life), 5444 (reactive-resume), all running. MariaDB 5451 (myfin), started by its adapter |
| First capture pass, all five apps, configuration B, one case per fresh run | Done |
| Setup failures from the first pass | Fixed and re-captured. Zero setup failures remain in the accuracy directory. First-pass files kept in bench/results/accuracy-firstpass |
| Blinded single-reader grading, actual | Done: 24 cases |
| Blinded single-reader grading, myfin, kresus | Running |
| Blinded single-reader grading, manage-my-damn-life-nextjs, reactive-resume | Running |
| Overhead runs | Not started. Needs the kresus workload exclusion and the pin written into each adapter |
| Second reader (Severin Neumann) | Requested, no answer yet |

## Per-app capture state (configuration B, zero setup failures)

| App | Cases | Matched | Partial | No observable latency | Cases hash after revision and addendum |
| --- | --- | --- | --- | --- | --- |
| actual | 24 | 2 | 4 | 18 | 56359e8dc1a569f3 |
| myfin | 24 | 20 | 0 | 4 | 47f1fd193a7fb653 |
| kresus | 23 | 4 | 17 | 2 | 7ab4337c66995a58 |
| manage-my-damn-life-nextjs | 24 | 4 | 5 | 15 | 6f45a31bc381e754 |
| reactive-resume | 23 | 14 | 2 | 7 | 99bb10f2d6208628 |

The matched, partial and no-observation counts are not stable between runs. Two full captures of the same manage-my-damn-life code changed the class of six cases. Those counts are first-pass captures, not final results.

## Grading state

Single reader, provisional. Each case has one blinded reader, and every grade is recorded with its raw labels.

- **actual, 24 graded.** 20 cannot tell, 2 wrong (C05, C07), 1 misleading (C08), 1 blank (C11). Ledger: bench/results/grades/actual.json.
- Nine actual cases with no observable latency carry blank sub-fields. The rule says cannot tell. The ledger keeps the raw labels and a normalised set.
- My hand reads of C05 and C07 said cannot tell, against the reader's wrong. The two readings differ, and both are kept.
- Myfin, kresus, manage-my-damn-life-nextjs and reactive-resume: grading running.

## Grading timing for Severin

- Readers that are agents: 24 actual cases took 618 seconds at two in parallel, about 50 seconds of agent time per case.
- My own hand reads (two cases): tool time only, a few seconds per case. My reasoning between calls was not timed. Estimated at about 2 minutes per case; this is a guess.
- Cases to grade: 118 across the five apps (actual 24, myfin 24, kresus 23, manage-my-damn-life-nextjs 24, reactive-resume 23).

## Failures, fixes and disclosed issues

- **Manage-my-damn-life connections.** The first pass ran out of Postgres connections from C17 on. The app creates a new Sequelize pool for each call, and the pools close only after 10 to 12 seconds idle. The adapter now waits for the role's connections to drain before each run (up to 40 s), and restarts the server only if they remain. The upstream one-line fix in src/helpers/api/db.ts is not applied, because that code is upstream.
- **Manage-my-damn-life C12.** The first pass read the date format before it loaded and so lost the edit. The before-step now waits for the saved format.
- **Reactive-resume C09 to C14.** These depend on earlier cases in the same session, and captures run each case alone. The before-steps now create the state the cases need. C18 to C21 failed in the first re-capture from a browser that had closed. Re-run alone, all four captured as matched.
- **Stray server.** A diagnostic next-server on port 5320 served the nine-case re-capture of manage-my-damn-life. The first attempt at the re-capture was therefore not run on its own server. It was killed, and the full capture was re-run on a clean server. The results files are from that clean run.
- **Myfin.** The MariaDB start is run by the adapter as the bench user. It worked in this pass.
- **Kresus C12.** The Plus button turns the budget sign to Minus, so the claim is -300.00 (protocol owner to review).
- **Actual C22.** "Heading" is read as the visible page title (protocol owner to confirm).
- **Myfin clock.** The default year and month come from the machine clock. Captures after October 2026 need a check.
- **Rule slips, disclosed.** The rule against listing or opening AGENTS.md and CLAUDE.md was broken by name. Reactive-resume's `ls` at the clone root listed both files, and its source reads made the harness load CLAUDE.md into its context. Myfin's clone listing printed AGENTS.md. Manage-my-damn-life's investigation listed the clone root once. No file was opened, grepped or quoted.
- **Upstream pin not written.** The adapters do not write react-inp-blame@1.0.0 into their manifests and lockfiles. A fresh clone would build A and fail B and C. Fix before any fresh-clone run.
- **Stop-hook commits.** Seven unpushed commits are unsigned, and their committer email is Aditya Reddy's noreply address. GitHub will show them as Unverified. Options are open with the owner: keep as is, change only the committer, or sign.

## Second reader

Adi asked Severin Neumann to be the second reader. No answer yet. Until he answers, every grade is single-reader provisional, as the protocol permits. If he declines, the protocol changes.

## Overhead

Not started. The machine has 4 CPUs and 15 GB of RAM. Overhead numbers taken here are shared-CPU measurements, and the report says so. Overhead runs start after grading and the workload changes, as long-running scripts. Myfin alone is about 9.7 hours of overhead runs, and kresus's workload excludes C07, C17 and C21.

## Next steps

1. Finish grading for the four remaining apps and record the ledger for each.
2. Write the kresus overhead workload exclusion and the upstream pin into each adapter.
3. Start overhead runs as long-running scripts.
4. Push after 17:00 CDT, after the owner has chosen how to handle the commit identity.
