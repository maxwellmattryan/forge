# lib/engine/pipeline/moves/

How a job moves between stages and states: the one move with its effects, the Foreman's gate policy, and dependency waits.

- A stage, state or `waitingOn` change that needs effects (environment, the Foreman's gate request, the tracker mirror) goes through `moveJob` (`apply.ts`); `mirrorJob` runs the mirror alone. Notifications follow every transition through setJob's hook list (`lib/core/job/transitions.ts`), whoever writes.
- Only tests call `useMoveEffects`; production always runs `realMoveEffects`.
- `deps.ts` imports nothing from this folder: `lib/engine/workspace/worktree.ts` imports it, and anything more would risk a cycle.
- Import order: `foreman-gates.ts` ← `effects.ts` ← `apply.ts`.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `apply.ts` | The one move: a locked write of a job's stage, state or waitingOn, then its effects in a fixed order (environment, the Foreman's gate request, the tracker mirror), so every caller gets the same follow-up whoever moves the job. |
| `deps.ts` | Dependencies between jobs (`job.dependsOn`): validation, parking, claim refusal, stacked branches and retargeting. |
| `effects.ts` | A move's effects behind one seam: the environment a finished job leaves, the Foreman's gate request and the tracker mirror. |
| `foreman-gates.ts` | The Foreman's gate policy: which gate class a job waits on, which classes the Foreman decides, what foreman.reserved and the security, total-round and retro holds keep with a human, and the `gate` requests a park queues. |
<!-- forge:map:end -->
