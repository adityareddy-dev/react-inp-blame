# EF-360 status

Living status for the five-app benchmark. Updated at each milestone. Protocol: [protocol-2026-10-14.md](protocol-2026-10-14.md), revised by [protocol-2026-10-15.md](protocol-2026-10-15.md), with its addendum on capture setup. The revision is published before any grade is recorded.

Last updated: 2026-10-15, about 15:20 CDT. Commits are local and nothing is pushed. The branch is 10 commits ahead of origin's last push and has been rewritten once. Authorship stays as Aditya Reddy, as set by the owner; the commits show as Unverified on GitHub, and that is accepted. Pushes wait for 17:00 CDT on a weekday, or any time outside 09:00 to 17:00. Nothing is merged.

## Milestones

| Step | State |
| --- | --- |
| Harness and registry of the five apps | Done |
| Protocol revision 2026-10-15 with every changed case and reason | Done |
| Addendum: capture setup for manage-my-damn-life-nextjs C12 and reactive-resume C09, C11 to C14 | Done, before any grade for those apps |
| Real databases | Postgres 5442 (kresus), 5443 (manage-my-damn-life), 5444 (reactive-resume), running. MariaDB 5451 (myfin), started by its adapter |
| First capture pass, all five apps, configuration B, one case per fresh run | Done |
| Setup failures from the first pass | Fixed and re-captured. Zero setup failures remain. First-pass files kept in bench/results/accuracy-firstpass |
| Blinded single-reader grading | Done for all five apps (see Grading state) |
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

The matched, partial and no-observation counts are not stable between runs. Two full captures of the same manage-my-damn-life code changed the class of six cases, so these counts are first-pass captures, not final results.

## Grading state

Single reader, provisional. Each case has one blinded reader. Every grade is kept with its raw labels, and a normalised set is kept alongside for no-observation cases.

Final verdicts (pass 2, with each source path corrected):

| App | Cases | Right | Misleading | Wrong | Cannot tell | Blank |
| --- | --- | --- | --- | --- | --- | --- |
| actual (pass 1, correct path) | 24 | 0 | 1 | 2 | 20 | 1 |
| myfin | 24 | 0 | 17 | 2 | 5 | 0 |
| kresus | 23 | 1 | 10 | 2 | 5 | 5 |
| manage-my-damn-life-nextjs | 24 | 0 | 3 | 0 | 16 | 5 |
| reactive-resume | 23 | 0 | 12 | 1 | 9 | 1 |

Ledgers: bench/results/grades/<app>.json.

What the grades show, and what they do not:

- **A grading error, now fixed.** The first grading pass for myfin and kresus gave the reader the wrong source path (bench/bench/clones). Twenty-seven of 47 readers reported the source missing. The corrected pass read the source. The first-pass grades are kept in bench/results/grades/pass1-source-path-error.json, labelled.
- **Lost first-pass records.** The first-pass grades for manage-my-damn-life and reactive-resume (38 records) came from a run that was stopped before its output was written. Their app cannot be recovered from the journal, so they are not kept in any ledger.
- **Reader variance.** For myfin, the first pass and the corrected pass gave different verdicts for the same captures: misleading 15 against 17, wrong 4 against 2. Single-reader grades are not stable, and the report will say so.
- **Misleading is the main category, and its rule needs review before Severin.** Most myfin and reactive-resume "misleading" verdicts rest on render-count or render-scope claims in the library's report. Those claims rest on React data that the production capture does not record, so they cannot be checked. The protocol's rule is: misleading when a true part directs investigation toward an unsupported scope; cannot tell when the evidence cannot settle the claim. Unverifiable render scope falls between the two. Those verdicts stand as graded, and the rule needs a decision before the next pass.
- **Blank in kresus and manage-my-damn-life.** Five blanks each, for interactions that were observed but produced no report. Silence below the 40 ms threshold is expected behaviour, so the blank category needs the same review.
- **Sub-field labels.** Several no-observation cases carry blank sub-fields in the raw grades. The normalised set corrects them to cannot tell, as the rule says.

## Grading timing for Severin

- Readers that are agents: the actual pass took 618 seconds for 24 cases at two in parallel, about 50 seconds of agent time per case. The corrected four-app pass took 3,732 seconds for 94 cases at two in parallel, about 80 seconds of agent time per case, because the readers read the source.
- My own hand reads (two cases): tool time only, a few seconds each. My reasoning between calls was not timed. Estimated at about 2 minutes per case; this is a guess.
- Cases to grade: 118 across the five apps (actual 24, myfin 24, kresus 23, manage-my-damn-life-nextjs 24, reactive-resume 23).

## Failures, fixes and disclosed issues

- **Manage-my-damn-life connections.** The first pass ran out of Postgres connections from C17 on. The app creates a new Sequelize pool per call, and the pools close only after 10 to 12 seconds idle. The adapter now waits for the role's connections to drain before each run (up to 40 s), and restarts the server only if they remain. The upstream one-line fix in src/helpers/api/db.ts is not applied, because that code is upstream.
- **Manage-my-damn-life C12.** The first pass read the date format before it loaded and so lost the edit. The before-step now waits for the saved format.
- **Reactive-resume C09 to C14.** These depend on earlier cases in the same session, and captures run each case alone. The before-steps now create the state the cases need. C18 to C21 failed in the first re-capture from a browser that had closed; re-run alone, all four captured as matched.
- **Stray server.** A diagnostic next-server on port 5320 served the nine-case re-capture of manage-my-damn-life, so that re-capture was not run on its own server. It was killed, and the full capture was re-run on a clean server. The results files are from that clean run.
- **Grading source path.** Described above.
- **Myfin.** The MariaDB start is run by the adapter as the bench user. It worked in this pass.
- **Kresus C12.** The Plus button turns the budget sign to Minus, so the claim is -300.00 (protocol owner to review).
- **Actual C22.** "Heading" is read as the visible page title (protocol owner to confirm).
- **Myfin clock.** The default year and month come from the machine clock. Captures after October 2026 need a check.
- **Rule slips, disclosed.** The rule against listing or opening AGENTS.md and CLAUDE.md was broken by name. Reactive-resume's `ls` at the clone root listed both files, and its source reads made the harness load CLAUDE.md into its context. Myfin's clone listing printed AGENTS.md. Manage-my-damn-life's investigation listed the clone root once. No file was opened, grepped or quoted.
- **Upstream pin not written.** The adapters do not write react-inp-blame@1.0.0 into their manifests and lockfiles. A fresh clone would build A and fail B and C. Fix before any fresh-clone run.
- **Commits.** The owner chose to keep the commits as they are, authored and committed as Aditya Reddy. GitHub will show them as Unverified. The stop hook will keep reporting this.

## Second reader

Adi asked Severin Neumann to be the second reader. No answer yet. Until he answers, every grade is single-reader provisional, as the protocol permits. If he declines, the protocol changes.

## Overhead

Not started. The machine has 4 CPUs and 15 GB of RAM. Overhead numbers taken here are shared-CPU measurements, and the report says so. Overhead runs start after the grading rules are settled, as long-running scripts. Myfin alone is about 9.7 hours of overhead runs, and kresus's workload excludes C07, C17 and C21.

## Next steps

1. Decide the misleading and blank rules for render scope and silence, before the next grading pass.
2. Write the kresus overhead workload exclusion and the upstream pin into each adapter.
3. Start overhead runs as long-running scripts.
4. Push after 17:00 CDT.
