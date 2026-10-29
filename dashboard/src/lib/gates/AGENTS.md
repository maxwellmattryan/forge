# dashboard/src/lib/gates/

What waits on a person and what they can do about it: the Needs-you inbox and its Shelved list, a decision in flight, the drawer's action dock, and the action cards' POSTs.

- A decision in flight says only what is true (sending, queued, being applied), never a guess at the next state.
- The action POSTs go through `post` in `project/focus.ts`; `merge-now.ts` re-exports `confirmMatches` from `delete-job.ts`.
- Every job string here is the job's own and renders as text.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `decision.ts` | A gate's decision in flight: what a job's request buttons show between the click and the job moving on. |
| `delete-job.ts` | The drawer's Delete job card: when it offers the delete, and the POST that does it. |
| `dock.ts` | The job drawer's action dock: whether it shows and what it holds. |
| `inbox.ts` | The Needs-you inbox: its groups and each gate card's kind, doc, note, buttons and badges. |
| `merge-now.ts` | The drawer's Merge now card: when it offers a person's merge-now, and the POST that does it. |
| `pr-actions.ts` | The Needs you PR row's actions: which ones a pr-review job's PR offers, and the POST that re-runs or fixes its CI. |
| `repo-proposals.ts` | A job's repo proposals as the dashboard shows them: the RP1 park (lib/engine/pipeline/step/gates.ts) that tells this `human` wait apart, the rows of repo-proposals.json (agent-written job state, so parsed defensively and rendered as text), and the POST that decides them (lib/server/routes/jobs.ts). |
| `shelf.ts` | The Needs-you popover's Shelved list: its rows, the batch body each action POSTs, and the toast that reports what happened to each job. |
<!-- forge:map:end -->
