# dashboard/src/components/gates/

What waits on a person and the answers they give: the Needs-you cards, a gate's note and request buttons with the issue-link and repo-proposal answers, the drawer's action dock and the repo budget hold.

- These render the gate's answers; which actions a gate offers and the POSTs they send live in `src/lib/gates/`.
- Gate, request and tracker text is outside text: it renders as text, or as markdown only through `md()`.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `ActionDock.svelte` | The job drawer's action dock: this job's permission prompts, Resume and the gate's actions, pinned under the scrolling body. |
| `GatePrNote.svelte` | What a gate's buttons do to the PR: a merge gate on an open PR shows the PR chip and says the PR waits on this decision before it can merge; a held push says nothing has left the machine yet. |
| `InboxCard.svelte` | A "Needs you" card: the job, why it waits, who acted last, who owns the gate (with the foreman on) or that the Foreman left it for a human, what Approve does on a secret park (and whether the last one left it blocked), the protected paths it changes, its doc link, what its buttons do to the PR (a merge gate on an open PR, a held push), a note and the request buttons. |
| `IssueLinkActions.svelte` | The issue-link gate's answers: link one of the candidates Forge found (issue-candidates.json), another issue by ref, a new issue, or none. |
| `JobActions.svelte` | A gate's note and request buttons, shared by the Needs-you card, the Needs-you park list and the drawer's action dock. |
| `MilestoneDraftCard.svelte` | A "Needs you" card for a goal mandate's milestone draft at the milestone-approval gate: the mandate, who owns the gate, the milestone with its exit criteria, the owner's goal (collapsed) and the issues wave by wave, each a fold with its Why / What to do / Done. |
| `RepoBudgetSection.svelte` | Needs you's first section while the repo budget holds work: the CLI's reason, the jobs it parked (a title opens the job's pane) and Acknowledge, which grants one more period (the month when a month cap is reached, else the day). |
| `RepoProposalActions.svelte` | The repo-proposal gate's answers (step RP1): the proposals an agent made (repo-proposals.json), each with its status and reason, and (with `buttons`, rendered after the note) Approve repos / Reject repos, which decide the pending repos the list shows (`shown`, bound by JobActions from the list instance) through POST /api/jobs/:id/repos with the note. |
<!-- forge:map:end -->
