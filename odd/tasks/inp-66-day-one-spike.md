# INP-66 day-one unmount measurement

Objective: determine whether real React unmount callbacks preserve deleted-component identity and expose measured per-component cleanup time. Stop after day one if the spending component cannot be identified using generic observer evidence. A wider accuracy campaign is outside this work unit.

Base: `0ffef21c087f62c8cd0f4f6dffc61ed1c8ec73e5`. Branch: `feat/inp66-day-one-probe-20261012`. One isolated worktree, one React version, no core attribution changes.

- [x] T0: Verify base and package-lock SHA before setup.
- [x] T1: Observe behavioral RED for the absent callback probe.
- [x] T2: Add bounded real callback, owner and cleanup/control traces.
- [x] T3: Run the complete development hook spec and production probe.
- [x] T4: Record the measured stop result and freeze the candidate for independent review.

Scope: `apps/demo/src/devtools-hook.tsx`, `apps/demo/e2e/devtools-hook.spec.ts`, `docs/evidence/inp-66-spike.md` and this task. Generated workspaces, dependencies, build outputs and raw local receipts stay untracked/ignored. The five lock-declared workspace manifests were reconstructed for a scripts-disabled install without generating the undeclared React 19.0 variant. Package-lock SHA256 remained `883ac40bb3b4d36bb9233efda66c9841c31a108b39e866f2fb41a44c920dff78`.

Observed result: **NO-GO for per-component cleanup-time attribution using the measured generic hooks.** Real production unmount callbacks preserve named owners. The two passive controls switch the component spending 40 ms while preserving the ordered hook identity sequence. Every case has 53 unmount callbacks, including cheap cleanup with a slow surviving render. Root effect duration fields are absent in the production build. Fixture timing markers establish ground truth but are not available to a generic observer.

Validation: React 19.3.0, Chrome 155.0.8059.40, Node 24.20.0 and npm 11.19.0. Development hook spec 13/13 and production probe 6/6 passed, with no skips, retries or page errors. Build/typecheck/diff checks passed. A preliminary runner-option error preceded the behavioral RED. Building the existing core package resolved the initially missing generated declarations. Independent review found no blocking defect, matched the frozen source hashes, and reran the paired production controls 2/2 successfully. The parent independently reran typecheck successfully.

The published evidence remains one trial per case and one runtime combination, not a statistical performance study, release accuracy result or proof that every alternative instrumentation approach is impossible. See `docs/evidence/inp-66-spike.md` for methodology, times, stopping result and reproduction commands.

Delivery: scoped probe/evidence work unit authorized after independent review. Record the resulting commit, branch, PR and current-head CI in local delivery receipts. No merge, canonical-main change or version bump is part of this work unit.
