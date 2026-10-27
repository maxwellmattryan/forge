# lib/office/foreman/

The Foreman's gate decisions: the policy checks on every foreman decision, forge dash's gate runner that decides each `gate` request in code, its one-shot forge:assistant, and the verdict parser and gate table.

- Only the gate runner (`run.ts`) records a foreman decision, release approval, milestone-draft decision or hand-off: it holds a `ForemanAuthority` (`issueForemanAuthority` in `lib/core/job/requests.ts`), and every check here refuses anyone without it. Never issue one anywhere else, and never let a CLI path pass one: no argv, env or file may produce it.
- The policy checks (`policy.ts`, and `checkReleaseDecision` in `lib/engine/release/approval.ts`) refuse in a fixed order; add a check, never reorder or skip one for the runner.
- The assistant's reply is model output steered by job text: `verdict.ts` takes only the exact last line, and a malformed reply never becomes an approve. The brief reaches stdin only through `stream.ts` `briefLine`.
- A gate run never leaves a request claimed: a failure requeues it through `requeueOrphanedRequests` (counted), a usage limit or a stop gives it back with `releaseClaim` (not counted).
- Design: [Foreman](../../../docs/architecture/foreman.md), [Daemon security](../../../docs/architecture/daemon-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `attempt.ts` | One gate run's model call: a headless `claude -p --agent forge:assistant` child that gets the assist brief as its first stdin line and answers with one verdict line, asked once more on the same child when that line is malformed. |
| `decide.ts` | The Foreman's decisions at a job's gate, in-process: the read-only assist (what `forge job assist` returns), recording a foreman decision through the policy checks (./policy.ts), a Foreman hand-off, and the title-only override. |
| `policy.ts` | The Foreman's policy side: who owns a gate for the dashboard, the checks on a foreman decision and on the office session's `forge job set`, and hand-offs; the gate policy is lib/engine/pipeline/moves/foreman-gates.ts. |
| `run.ts` | forge dash's gate runner: decides each pending `gate` request in code, as the Foreman, with one fresh forge:assistant process (./attempt.ts) as its only model call. |
| `verdict.ts` | A gate run's verdict: the strict parser over the forge:assistant's last line, the reason it carries, cleaned, and the gate table that turns a verdict into the decision the gate runner (./run.ts) records. |
<!-- forge:map:end -->
