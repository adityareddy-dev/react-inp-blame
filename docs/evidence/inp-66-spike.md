# INP-66 day-one measurement: stop on cleanup-time attribution

**NO-GO for continuing this spike as a generic per-component cleanup-time collector.** Actual unmount callbacks retain component identity and surviving-owner ancestry, but the available callback observations do not measure which deleted component spends passive cleanup time. This meets the predefined day-one stop condition. It does not prove that every different instrumentation approach is impossible.

## Scope and provenance

- Authoritative base: `0ffef21c087f62c8cd0f4f6dffc61ed1c8ec73e5`, isolated branch `feat/inp66-day-one-probe-20261012`.
- Actual runtime: React/react-dom 19.3.0, installed Chrome 155.0.8059.40, Node 24.20.0, npm 11.19.0. One React version only, development and normal production builds.
- Measured on 2026-10-12, final development run 11:20:24.518 UTC and production run 11:21:00.357 UTC.
- Root package-lock SHA256: `883ac40bb3b4d36bb9233efda66c9841c31a108b39e866f2fb41a44c920dff78`, unchanged by scripts-disabled anonymous registry installation. Only five lock-declared generated workspace manifests were reconstructed, no undeclared React 19.0 workspace.

## Actual fixture and observer boundaries

The optional `?inp66` developer-test fixture creates `DeletionOwner`, a deleted `DeletedSubtree` containing `NamedCleanup`, 24 `CheapLeaf` components and `SecondCleanup`, and a surviving `SurvivingSibling`. Real React callbacks are chained without mutating fibers or wrapping application cleanup functions. There are no fabricated deletion arrays.

The observer records ordered `onCommitFiberUnmount`, `onCommitFiberRoot` and `onPostCommitFiberRoot` snapshots, component names, return-owner chains, and available duration fields. These **hook-only observations** are stored separately from **fixture ground truth**. The latter marks entry/exit of known synchronous 40 ms cleanup or render work through `performance.now()`. A deployed generic observer does not have these fixture markers.

## Production observations

Times below are fixture-measured milliseconds, not duration attributed by the product. Zero means below this run's timer resolution, not proof of absolutely zero work.

| Case | Unmount callbacks | Named layout | Named passive | Second passive | Surviving render | Commit-to-post gap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| layout | 53 | 40.0 | 0.0 | 0.0 | 0.0 | 0.5 |
| passive | 53 | 0.0 | 40.0 | 0.0 | 0.0 | 40.5 |
| control | 53 | 0.0 | 0.0 | 0.0 | 0.0 | 0.6 |
| survivor | 53 | 0.0 | 0.0 | 0.0 | 40.0 | 0.5 |
| passive-first | 53 | 0.0 | 40.0 | 0.0 | 0.0 | 40.6 |
| passive-second | 53 | 0.0 | 0.0 | 40.0 | 0.0 | 40.4 |

All six cases delete the same topology and produce 53 unmount callbacks. Counting deletions cannot distinguish expensive cleanup from cheap deletion plus an expensive surviving render.

`NamedCleanup` and `SecondCleanup` retain their component names and ancestry including `DeletionOwner` at the real unmount callback in both builds. At the later commit callback the deletion root still has a readable name, but its return ancestry is already detached. Production `_debugOwner`, function-fiber render/effect duration fields and root effect duration fields are unavailable (recorded as null).

Layout cleanup occurs after the named unmount callback and before the commit callback. A long gap to a subsequent unmount can suggest where synchronous work happened, but includes traversal, observer overhead and other commit work, and is not a measured per-component cleanup boundary.

Passive cleanup occurs **after all unmount callbacks and after the commit callback**, before the post-commit callback. Swapping the 40 ms passive work from `NamedCleanup` to `SecondCleanup` preserves the exact ordered hook identity projection. Production commit-to-post gaps are about 40.6 ms and 40.4 ms respectively. Neither projection identifies the spending component. Development exposes about 40 ms of root-level passive duration for both, an aggregate rather than per-component attribution.

## Checks and limits

- Meaningful RED: on the untouched fixture, the real developer browser runner received false for the missing probe. A preliminary Playwright channel-option error was corrected before this RED.
- Final GREEN: complete development hook spec **13/13 passed** (seven existing compatibility checks and six probe cases); production probe **6/6 passed**. Zero failures, skips, retries, overflow or page errors in those final runs.
- Root build, typecheck and diff checks passed. Before building the core's generated dist, a typecheck attempt reported unavailable package declarations; the documented build prerequisite resolved those errors without source changes.
- Every final case has ordered sequence IDs and genuine cleanup/owner evidence. Browser testing used the existing Playwright developer runner and an isolated temporary Chrome profile, not personal-account browser automation.
- One trial per case and one React/browser combination establish this feasibility boundary, not statistical performance coverage or an accuracy gain. The probe has logging overhead; delegate durations exclude snapshot/logging overhead and do not calibrate the full observer. No complete Long Animation Frame attribution or original application replay was performed.
- Fixture names are intentionally preserved. This does not establish that arbitrary minified applications retain names without their normal naming setup.
- The probe changes no core attribution behavior, public API or lockfile, and makes no accuracy-gain or release claim.

## Reproduction and retained proof

From the isolated worktree in PowerShell, use child-session variables only:

```powershell
$env:CI='1'
$env:INP66_CHROME='1'
$env:INP_PORT='5436'
npm test -w apps/demo -- devtools-hook.spec.ts --project chromium-dev
$env:INP_MODE='prod'
$env:INP_PORT='5437'
npm test -w apps/demo -- devtools-hook.spec.ts --grep 'INP-66 real unmount spike' --project chromium-prod
npm run typecheck
```

The developer test attaches one JSON trace per case and build mode, containing full ordered hook-only and ground-truth streams. To retain them in a JSON test report, add `--reporter=list,json` to the commands above. The measured production rows are preserved in this document. Local validation records bind source/input hashes to the twelve captured traces.

Stop this measurement spike here. Identity retention may later support an explicitly uncertain deletion/owner explanation, but must not become measured cleanup time, reverse blame from counts, or imply that the unchanged accuracy bar has been met. Any different measurement strategy requires a separately defined scope.
